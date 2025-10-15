import { beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

const baseEnv = {
  NODE_ENV: "test",
  APP_BASE_URL: "https://example.com",
  MONDAY_CLIENT_ID: "client-id",
  MONDAY_CLIENT_SECRET: "client-secret",
  MONDAY_SIGNING_SECRET: "signing-secret",
  MONDAY_DEFAULT_SCOPES: "boards:read boards:write users:read me:read",
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
});

describe("parseScopesToArray", () => {
  it("splits by spaces and commas", async () => {
    const { parseScopesToArray } = await import("@/lib/mondayOAuth");
    expect(parseScopesToArray("boards:read,users:read me:read")).toEqual([
      "boards:read",
      "users:read",
      "me:read"
    ]);
  });
});

describe("getAuthorizeUrl", () => {
  it("builds authorize URL with defaults", async () => {
    const { getAuthorizeUrl } = await import("@/lib/mondayOAuth");
    const url = new URL(
      getAuthorizeUrl({
        state: "state-value"
      })
    );
    expect(url.origin + url.pathname).toBe("https://auth.monday.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.com/api/monday/oauth/callback"
    );
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("scope")).toBe(
      "boards:read boards:write users:read me:read"
    );
    expect(url.searchParams.has("subdomain")).toBe(false);
  });

  it("includes subdomain query parameter when provided", async () => {
    const { getAuthorizeUrl } = await import("@/lib/mondayOAuth");
    const url = new URL(
      getAuthorizeUrl({
        state: "state-value",
        subdomain: "example"
      })
    );
    expect(url.searchParams.get("subdomain")).toBe("example");
  });
});

describe("verifyMondayJwt", () => {
  const expectedAudience = `${baseEnv.APP_BASE_URL}/api/monday/integration`;

  it("returns normalized identifiers for a valid token", async () => {
    const { verifyMondayJwt } = await import("@/lib/mondayJwt");
    const token = jwt.sign(
      {
        accountId: 123,
        userId: 456,
        aud: expectedAudience
      },
      baseEnv.MONDAY_SIGNING_SECRET,
      { expiresIn: "5m" }
    );

    const result = verifyMondayJwt(`Bearer ${token}`);
    expect(result).toEqual({
      accountId: "123",
      userId: "456",
      shortLivedToken: undefined
    });
  });

  it("throws when the audience does not match", async () => {
    const { verifyMondayJwt } = await import("@/lib/mondayJwt");
    const token = jwt.sign(
      {
        accountId: 123,
        userId: 456,
        aud: "https://invalid.example.com"
      },
      baseEnv.MONDAY_SIGNING_SECRET,
      { expiresIn: "5m" }
    );

    expect(() => verifyMondayJwt(`Bearer ${token}`)).toThrow(/Invalid monday integration token/);
  });

  it("throws when the token is expired", async () => {
    const { verifyMondayJwt } = await import("@/lib/mondayJwt");
    const token = jwt.sign(
      {
        accountId: 123,
        userId: 456,
        aud: expectedAudience
      },
      baseEnv.MONDAY_SIGNING_SECRET,
      { expiresIn: "1s" }
    );

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2000);
    expect(() => verifyMondayJwt(`Bearer ${token}`)).toThrow(/jwt expired/);
    vi.useRealTimers();
  });
});
