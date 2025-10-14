import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/db";
import { flagsForPlan } from "@/lib/entitlements";
import type { Database } from "@/types/supabase";

type TenantRecord = Pick<Database["public"]["Tables"]["tenants"]["Row"], "id" | "plan" | "seats">;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get("accountId");
  if (!accountId) {
    return new NextResponse("accountId required", { status: 400 });
  }

  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from("tenants")
    .select("id, plan, seats")
    .eq("monday_account_id", accountId)
    .maybeSingle();

  if (error) {
    return new NextResponse("Failed to load tenant", { status: 500 });
  }

  const tenant = data as TenantRecord | null;
  if (!tenant) {
    return new NextResponse("Not found", { status: 404 });
  }

  return NextResponse.json({
    tenantId: tenant.id,
    plan: tenant.plan,
    flags: flagsForPlan(tenant.plan, tenant.seats)
  });
}
