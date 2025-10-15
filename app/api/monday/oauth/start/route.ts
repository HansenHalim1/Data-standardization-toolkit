import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logging";
import { env } from "@/lib/env";
import { getAuthorizeUrl } from "@/lib/mondayOAuth";

export const runtime = "nodejs";

const STATE_COOKIE_NAME = "monday_oauth_state";
const STATE_COOKIE_MAX_AGE_SECONDS = 600;

type StateCookiePayload = {
  state: string;
  returnTo: string;
  subdomain?: string;
  issuedAt: number;
};

export async function GET(request: Request) {
  const logger = createLogger({ component: "monday.oauth.start" });
  const url = new URL(request.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get("return_to")) ?? "/dashboard";
  const subdomain = sanitizeSubdomain(url.searchParams.get("subdomain") ?? undefined);

  const state = randomBytes(24).toString("base64url");
  const payload: StateCookiePayload = {
    state,
    returnTo,
    subdomain,
    issuedAt: Date.now()
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const cookieStore = cookies();
  cookieStore.set({
    name: STATE_COOKIE_NAME,
    value: encodedPayload,
    httpOnly: true,
    path: "/api/monday/oauth",
    sameSite: "lax",
    secure: env().nodeEnv === "production",
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS
  });

  const authorizeUrl = getAuthorizeUrl({
    state,
    subdomain: payload.subdomain ?? undefined
  });

  logger.info("Redirecting to monday OAuth authorize", {
    hasReturnTo: returnTo !== "/dashboard",
    hasSubdomain: Boolean(subdomain)
  });

  return NextResponse.redirect(authorizeUrl, { status: 302 });
}

function sanitizeReturnTo(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return undefined;
  }
  if (!value.startsWith("/")) {
    return undefined;
  }
  return value;
}

function sanitizeSubdomain(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.match(/^[a-z0-9-]+$/)) {
    return undefined;
  }
  return trimmed;
}
