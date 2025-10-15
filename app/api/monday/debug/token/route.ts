import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logging";
import { env } from "@/lib/env";
import { getServiceSupabase } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const configuration = env();
  if (configuration.nodeEnv === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const logger = createLogger({ component: "monday.debug.token" });
  const url = new URL(request.url);
  const accountIdParam = url.searchParams.get("accountId");
  const userIdParam = url.searchParams.get("userId");

  if (!accountIdParam || !userIdParam) {
    return new NextResponse("accountId and userId are required", { status: 400 });
  }

  const accountId = Number(accountIdParam);
  const userId = Number(userIdParam);
  if (!Number.isFinite(accountId) || !Number.isFinite(userId)) {
    return new NextResponse("accountId and userId must be numeric", { status: 400 });
  }

  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("monday_oauth_tokens")
    .select("id")
    .eq("account_id", accountId)
    .eq("user_id", userId)
    .maybeSingle();

  const hasToken = Boolean(data);
  logger.debug("Token lookup complete", { accountId, userId, hasToken });

  return NextResponse.json({ accountId, userId, hasToken });
}
