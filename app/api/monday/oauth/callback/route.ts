import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logging";
import { getServiceSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import {
  exchangeCodeForToken,
  getApiClient,
  parseScopesToArray,
  type MondayTokenResponse
} from "@/lib/mondayOAuth";

export const runtime = "nodejs";

const STATE_COOKIE_NAME = "monday_oauth_state";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

type StateCookiePayload = {
  state: string;
  returnTo?: string;
  subdomain?: string;
  issuedAt: number;
};

type ViewerResponse = {
  me: {
    id: string;
    account: {
      id: number;
      slug?: string | null;
      name?: string | null;
    };
  };
};

const OAUTH_ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  unauthorized_client: 401,
  access_denied: 403,
  invalid_scope: 400,
  server_error: 500,
  temporary_unavailable: 503
};

export async function GET(request: Request) {
  const logger = createLogger({ component: "monday.oauth.callback" });
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorCode = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description") ?? undefined;

  const cookieStore = cookies();
  const rawStateCookie = cookieStore.get(STATE_COOKIE_NAME)?.value;
  const statePayload = rawStateCookie ? decodeStateCookie(rawStateCookie) : null;

  if (errorCode) {
    logger.warn("OAuth callback returned error", { errorCode });
    return renderOAuthError(errorCode, errorDescription);
  }

  if (!statePayload) {
    logger.warn("Missing or invalid OAuth state cookie");
    return renderRetryResponse(400, "Authentication session expired. Please restart the monday.com connection.");
  }

  if (!state || state !== statePayload.state) {
    logger.warn("OAuth state mismatch detected");
    return renderRetryResponse(400, "OAuth state mismatch. Restart the monday.com connection to continue.");
  }

  if (!code) {
    logger.warn("OAuth callback missing authorization code");
    return renderRetryResponse(400, "Authorization code missing from monday.com response.");
  }

  const ageMs = Date.now() - statePayload.issuedAt;
  if (ageMs > STATE_MAX_AGE_MS) {
    logger.warn("Authorization code expired", { ageMs });
    return renderRetryResponse(400, "Authorization code expired. Start a new monday.com connection.");
  }

  let tokenResponse: MondayTokenResponse;
  try {
    tokenResponse = await exchangeCodeForToken(code);
  } catch (error) {
    logger.error("Token exchange failed", { message: (error as Error).message });
    return renderRetryResponse(502, "Failed to exchange monday.com authorization code. Please retry.");
  }

  const scopes = parseScopesToArray(tokenResponse.scope ?? "");

  let accountId: number;
  let userId: number;
  let accountSlug: string | undefined;

  try {
    const apiClient = getApiClient({ accessToken: tokenResponse.access_token });
    const viewer = await apiClient<ViewerResponse>({
      query: `
        query ViewerAccount {
          me {
            id
            account {
              id
              slug
              name
            }
          }
        }
      `
    });

    accountId = Number(viewer.me.account.id);
    userId = Number(viewer.me.id);
    accountSlug = viewer.me.account.slug ?? undefined;
  } catch (error) {
    logger.error("Failed to fetch monday viewer context", { message: (error as Error).message });
    return renderRetryResponse(502, "Unable to fetch monday.com account context. Please retry the connection.");
  }

  const supabase = getServiceSupabase();
  const { error: upsertError } = await supabase.from("monday_oauth_tokens").upsert(
    {
      account_id: accountId,
      user_id: userId,
      access_token: tokenResponse.access_token,
      scopes,
      updated_at: new Date().toISOString()
    },
    { onConflict: "account_id, user_id" }
  );

  if (upsertError) {
    logger.error("Failed to persist monday OAuth token", { message: upsertError.message });
    return renderRetryResponse(500, "Unable to persist monday.com token. Please try again.");
  }

  logger.info("monday OAuth completed", {
    accountId,
    userId,
    scopesCount: scopes.length,
    accountSlug
  });

  const response = NextResponse.redirect(
    buildRedirectUrl(statePayload.returnTo ?? "/dashboard", accountId, userId, scopes, accountSlug),
    { status: 302 }
  );
  clearStateCookie(response);
  return response;
}

function buildRedirectUrl(
  path: string,
  accountId: number,
  userId: number,
  scopes: string[],
  accountSlug?: string
): string {
  const redirectUrl = new URL(path, env().app.baseUrl);
  redirectUrl.searchParams.set("mondayAccountId", String(accountId));
  redirectUrl.searchParams.set("mondayUserId", String(userId));
  redirectUrl.searchParams.set("mondayScopes", scopes.join(" "));
  if (accountSlug) {
    redirectUrl.searchParams.set("mondayAccountSlug", accountSlug);
  }
  return redirectUrl.toString();
}

function decodeStateCookie(value: string): StateCookiePayload | null {
  try {
    const json = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as StateCookiePayload;
    if (!parsed.state || typeof parsed.issuedAt !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function renderOAuthError(code: string, description?: string) {
  const status = OAUTH_ERROR_STATUS[code] ?? 400;
  const reason = description ?? getDefaultErrorDescription(code);
  const body = `
    <h1>monday.com authorization failed</h1>
    <p>Error code: <strong>${code}</strong></p>
    <p>${reason}</p>
    <p><a href="/api/monday/oauth/start">Try again</a></p>
  `;
  return renderHtml(status, body);
}

function renderRetryResponse(status: number, message: string) {
  const body = `
    <h1>monday.com connection problem</h1>
    <p>${message}</p>
    <p><a href="/api/monday/oauth/start">Restart authorization</a></p>
  `;
  return renderHtml(status, body);
}

function renderHtml(status: number, content: string) {
  const response = new NextResponse(
    `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <title>monday.com OAuth</title>
          <style>
            body { font-family: sans-serif; margin: 4rem auto; max-width: 42rem; line-height: 1.6; color: #1f2933; }
            h1 { font-size: 1.875rem; margin-bottom: 1rem; }
            a { color: #2563eb; text-decoration: none; font-weight: 600; }
            a:hover { text-decoration: underline; }
            p { margin-bottom: 1rem; }
            strong { font-weight: 600; }
          </style>
        </head>
        <body>
          ${content}
        </body>
      </html>
    `,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8"
      }
    }
  );
  clearStateCookie(response);
  return response;
}

function getDefaultErrorDescription(code: string): string {
  switch (code) {
    case "invalid_request":
      return "The authorization request was malformed. Verify client configuration and try again.";
    case "unauthorized_client":
      return "This monday.com app is not authorized to request the provided scope set.";
    case "access_denied":
      return "The monday.com user declined the requested permissions.";
    case "invalid_scope":
      return "The monday.com scopes requested are invalid or unknown.";
    case "server_error":
      return "monday.com experienced a server error. Please try again.";
    case "temporary_unavailable":
      return "monday.com is temporarily unavailable. Try again shortly.";
    default:
      return "An unknown error occurred during monday.com authorization.";
  }
}

function clearStateCookie(response: NextResponse) {
  const configuration = env();
  response.cookies.set({
    name: STATE_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: configuration.nodeEnv === "production",
    path: "/api/monday/oauth",
    expires: new Date(0)
  });
}
