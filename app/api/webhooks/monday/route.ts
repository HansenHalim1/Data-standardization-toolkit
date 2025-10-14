import { NextResponse } from "next/server";
import { assertWebhookSignature } from "@/lib/security";
import { getServiceSupabase } from "@/lib/db";
import { createLogger } from "@/lib/logging";
import { flagsForPlan } from "@/lib/entitlements";
import type { Database, Json } from "@/types/supabase";

type TenantIdRecord = Pick<Database["public"]["Tables"]["tenants"]["Row"], "id">;
type TenantUpdate = Database["public"]["Tables"]["tenants"]["Update"];
type EntitlementInsert = Database["public"]["Tables"]["entitlements"]["Insert"];

export const runtime = "nodejs";

export async function POST(request: Request) {
  const logger = createLogger({ component: "webhooks.monday" });
  const signature = request.headers.get("x-monday-signature");
  const secret = process.env.MONDAY_APP_SIGNING_SECRET;
  if (!secret) {
    return new NextResponse("Signing secret not configured", { status: 500 });
  }

  const rawBody = await request.text();
  try {
    assertWebhookSignature({ signature, rawBody, secret });
  } catch (error) {
    logger.warn("Invalid webhook signature", { error: (error as Error).message });
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const payload = JSON.parse(rawBody) as {
    accountId: string;
    plan: string;
    seats?: number;
    event?: string;
    data?: unknown;
  };

  if (!payload.accountId || !payload.plan) {
    return new NextResponse("Invalid webhook payload", { status: 400 });
  }

  const supabase = getServiceSupabase();
  const { data: tenantData } = await supabase
    .from("tenants")
    .select("id")
    .eq("monday_account_id", payload.accountId)
    .maybeSingle();

  const tenant = tenantData as TenantIdRecord | null;
  if (!tenant) {
    logger.warn("Webhook received for unknown tenant", { accountId: payload.accountId });
    return new NextResponse("Tenant not found", { status: 202 });
  }

  const seats = payload.seats ?? 1;
  const plan = payload.plan.toLowerCase();

  const tenantUpdate: TenantUpdate = {
    plan,
    seats,
    updated_at: new Date().toISOString()
  };

  await supabase
    .from("tenants")
    .update(tenantUpdate)
    .eq("id", tenant.id);

  const rawPayload: Record<string, Json> = {
    accountId: payload.accountId,
    plan,
    seats,
    event: payload.event ?? null,
    data: (payload.data ?? null) as Json
  };

  const entitlementPayload: EntitlementInsert = {
    tenant_id: tenant.id,
    plan,
    seats,
    raw: rawPayload,
    updated_at: new Date().toISOString()
  };

  await supabase.from("entitlements").upsert(entitlementPayload, { onConflict: "tenant_id" });

  logger.info("Tenant updated from webhook", {
    tenantId: tenant.id,
    plan,
    seats,
    event: payload.event
  });

  return NextResponse.json({
    tenantId: tenant.id,
    plan,
    seats,
    flags: flagsForPlan(plan, seats)
  });
}
