import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STATE_COOKIE_NAME = "monday_oauth_state";

const cookieStore = {
  value: undefined as string | undefined,
  get(name: string) {
    if (name === STATE_COOKIE_NAME && this.value) {
      return { name, value: this.value };
    }
    return undefined;
  }
};

vi.mock("next/headers", () => ({
  cookies: () => cookieStore
}));

const baseEnv = {
  NODE_ENV: "test",
  APP_BASE_URL: "https://example.com",
  MONDAY_CLIENT_ID: "client-id",
  MONDAY_CLIENT_SECRET: "client-secret",
  MONDAY_SIGNING_SECRET: "signing-secret",
  MONDAY_DEFAULT_SCOPES: "boards:read",
  MONDAY_FORCE_INSTALL_IF_NEEDED: "false",
  NEXT_PUBLIC_MONDAY_REDIRECT_URI: "https://example.com/api/monday/oauth/callback",
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  ENABLE_SUPABASE_STUB: "1"
};

function seedEnv(overrides: Record<string, string> = {}) {
  Object.entries({ ...baseEnv, ...overrides }).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

beforeEach(() => {
  vi.resetModules();
  seedEnv();
  cookieStore.value = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("monday OAuth callback route", () => {
  it("upserts the token and redirects to the target route", async () => {
    const statePayload = {
      state: "state-123",
      returnTo: "/settings/monday",
      issuedAt: Date.now()
    };
    cookieStore.value = Buffer.from(JSON.stringify(statePayload), "utf8").toString("base64url");

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://auth.monday.com/oauth2/token") {
        return new Response(
          JSON.stringify({
            access_token: "token-xyz",
            token_type: "Bearer",
            scope: "boards:read",
            account_id: 111,
            user_id: 222
          }),
          { status: 200 }
        );
      }
      if (url === "https://api.monday.com/v2") {
        return new Response(
          JSON.stringify({
            data: {
              me: {
                id: 222,
                account: {
                  id: 111,
                  slug: "demo-account"
                }
              }
            }
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch call to ${url} ${init?.method ?? ""}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/monday/oauth/callback/route");
    const response = await GET(
      new Request("https://example.com/api/monday/oauth/callback?code=auth-code&state=state-123")
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("/settings/monday");
    expect(location).toContain("mondayAccountId=111");
    expect(location).toContain("mondayUserId=222");

    const { getServiceSupabase } = await import("@/lib/db");
    const supabase = getServiceSupabase();
    const { data } = await supabase
      .from("monday_oauth_tokens")
      .select("access_token, scopes")
      .eq("account_id", 111)
      .eq("user_id", 222)
      .maybeSingle();

    expect(data).toBeTruthy();
    expect((data as { access_token: string; scopes: string[] }).access_token).toBe("token-xyz");
    expect((data as { access_token: string; scopes: string[] }).scopes).toEqual(["boards:read"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns 400 when state does not match", async () => {
    const statePayload = {
      state: "expected-state",
      returnTo: "/settings/monday",
      issuedAt: Date.now()
    };
    cookieStore.value = Buffer.from(JSON.stringify(statePayload), "utf8").toString("base64url");

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/monday/oauth/callback/route");
    const response = await GET(
      new Request("https://example.com/api/monday/oauth/callback?code=auth-code&state=wrong-state")
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
