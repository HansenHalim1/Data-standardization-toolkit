import { NextResponse } from "next/server";
import { verifyMondaySessionToken } from "@/lib/security";
import { getServiceSupabase } from "@/lib/db";
import { flagsForPlan } from "@/lib/entitlements";
import { createLogger } from "@/lib/logging";
import type { Database } from "@/types/supabase";

type TenantRecord = Pick<Database["public"]["Tables"]["tenants"]["Row"], "id" | "plan" | "seats">;
type UsageRecord = Pick<Database["public"]["Tables"]["usage_monthly"]["Row"], "rows_processed">;

export async function POST(request: Request) {
  const logger = createLogger({ component: "monday.context.verify" });
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    return new NextResponse("Missing monday token", { status: 401 });
  }

  try {
    const claims = verifyMondaySessionToken(token);
    const accountId =
      (claims.accountId ? String(claims.accountId) : undefined) ??
      (claims.account?.id ? String(claims.account.id) : undefined);
    if (!accountId) {
      throw new Error("Session token missing account identifier");
    }

    const supabase = getServiceSupabase();
    const { data: tenantData } = await supabase
      .from("tenants")
      .select("id, plan, seats")
      .eq("monday_account_id", accountId)
      .maybeSingle();

    const tenant = tenantData as TenantRecord | null;
    if (!tenant) {
      return new NextResponse("Tenant not found", { status: 404 });
    }

    const flags = flagsForPlan(tenant.plan, tenant.seats);

    const { data: usageData } = await supabase
      .from("usage_monthly")
      .select("rows_processed")
      .eq("tenant_id", tenant.id)
      .order("month", { ascending: false })
      .limit(1)
      .maybeSingle();

    const usage = usageData as UsageRecord | null;

    logger.debug("Context verified", { tenantId: tenant.id });

    return NextResponse.json({
      tenantId: tenant.id,
      plan: tenant.plan,
      seats: tenant.seats,
      flags,
      usage: {
        rowsProcessed: usage?.rows_processed ?? 0
      },
      claims: {
        accountId,
        userId: claims.userId,
        userEmail: claims.userEmail
      }
    });
  } catch (error) {
    logger.warn("Context verification failed", { error: (error as Error).message });
    return new NextResponse("Unauthorized", { status: 401 });
  }
}
