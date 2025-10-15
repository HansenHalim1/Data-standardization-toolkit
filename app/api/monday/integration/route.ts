import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logging";
import { getServiceSupabase } from "@/lib/db";
import { verifyMondayJwt } from "@/lib/mondayJwt";

export const runtime = "nodejs";

type TokenRecord = {
  access_token: string;
  scopes: string[];
};

export async function POST(request: Request) {
  const logger = createLogger({ component: "monday.integration" });
  const authorization = request.headers.get("authorization") ?? "";

  let context: ReturnType<typeof verifyMondayJwt>;
  try {
    context = verifyMondayJwt(authorization);
  } catch (error) {
    logger.warn("Integration request failed verification", { message: (error as Error).message });
    return new NextResponse("Unauthorized", { status: 401 });
  }

  logger.debug("Integration request verified", {
    accountId: context.accountId,
    userId: context.userId,
    hasShortLivedToken: Boolean(context.shortLivedToken)
  });

  const supabase = getServiceSupabase();
  const { data: tokenData } = await supabase
    .from("monday_oauth_tokens")
    .select("access_token, scopes")
    .eq("account_id", Number(context.accountId))
    .eq("user_id", Number(context.userId))
    .maybeSingle();

  const storedToken = tokenData as TokenRecord | null;
  const effectiveToken = context.shortLivedToken ?? storedToken?.access_token;
  if (!effectiveToken) {
    logger.warn("No monday token available for integration", { accountId: context.accountId });
    return new NextResponse("No authorized monday token found for this account. Reconnect the integration.", {
      status: 403
    });
  }

  const payload = await request.json().catch(() => ({} as Record<string, unknown>));

  // Placeholder integration behavior: echo context to confirm verification.
  // Replace this block with actual monday API calls using `client` and `payload`.
  if (payload?.__ping === true) {
    return NextResponse.json({ ok: true });
  }

  const responseBody = {
    accountId: context.accountId,
    userId: context.userId,
    usedShortLivedToken: Boolean(context.shortLivedToken),
    tokenSource: context.shortLivedToken ? "short-lived" : "oauth",
    storedScopes: storedToken?.scopes ?? [],
    payload
  };

  logger.info("Integration request handled", {
    accountId: context.accountId,
    userId: context.userId,
    payloadKeys: Object.keys(payload ?? {})
  });

  return NextResponse.json(responseBody);
}
