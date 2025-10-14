import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/db";
import { monthKey } from "@/lib/ids";
import { createLogger } from "@/lib/logging";
import type { Database } from "@/types/supabase";

type IncrementUsageArgs = Database["public"]["Functions"]["increment_usage"]["Args"];

export async function POST(request: Request) {
  const logger = createLogger({ component: "usage.consume" });
  const body = await request.json().catch(() => null);
  const tenantId = body?.tenantId as string | undefined;
  const rows = Number(body?.rows ?? 0);
  const api = Number(body?.api ?? 0);
  const schedules = Number(body?.schedules ?? 0);

  if (!tenantId || rows <= 0) {
    return new NextResponse("Invalid usage payload", { status: 400 });
  }

  const supabase = getServiceSupabase();
  const args: IncrementUsageArgs = {
    tenant: tenantId,
    month: monthKey(),
    rows,
    api,
    schedules
  };
  const { data, error } = await supabase.rpc("increment_usage", args);

  if (error) {
    logger.error("Failed to increment usage", { tenantId, error: error.message });
    return new NextResponse("Usage update failed", { status: 500 });
  }

  logger.info("Usage incremented", { tenantId, rows });
  return NextResponse.json(data);
}
