import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/db";
import { verifyMondaySessionToken } from "@/lib/security";
import { fetchBoards, resolveOAuthToken } from "@/lib/mondayApi";
import { createLogger } from "@/lib/logging";

export const runtime = "nodejs";

const logger = createLogger({ component: "monday.boards" });

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!sessionToken) {
    return new NextResponse("Missing monday token", { status: 401 });
  }

  try {
    const { accountId, userId } = verifyMondaySessionToken(sessionToken);
    const accountKey = String(accountId);
    const supabase = getServiceSupabase();

    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.min(Number(limitParam) || 50, 200) : 50;

    const accessToken = await resolveOAuthToken(supabase, accountKey, String(userId));
    const boards = await fetchBoards(accessToken, limit);

    return NextResponse.json({ boards });
  } catch (error) {
    const message = (error as Error).message;
    const status = message.includes("not connected") ? 403 : 401;
    logger.warn("Failed to list monday boards", { error: message });
    return new NextResponse(message || "Unauthorized", { status });
  }
}
