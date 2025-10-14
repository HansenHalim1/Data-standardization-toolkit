import { NextResponse } from "next/server";
import { exchangeCodeForToken, fetchAccountDetails } from "@/lib/monday";
import { getServiceSupabase } from "@/lib/db";
import { newId } from "@/lib/ids";
import { flagsForPlan } from "@/lib/entitlements";
import { createLogger } from "@/lib/logging";
import type { Database } from "@/types/supabase";

type TenantRecord = Pick<Database["public"]["Tables"]["tenants"]["Row"], "id" | "plan" | "seats">;
type TenantInsert = Database["public"]["Tables"]["tenants"]["Insert"];
type EntitlementInsert = Database["public"]["Tables"]["entitlements"]["Insert"];

export async function POST(request: Request) {
  const logger = createLogger({ component: "monday.oauth" });
  const body = await request.json().catch(() => null);
  const code = body?.code as string | undefined;
  if (!code) {
    return new NextResponse("Missing code", { status: 400 });
  }

  const redirectUri = process.env.MONDAY_REDIRECT_URI;
  const clientId = process.env.MONDAY_CLIENT_ID;
  const clientSecret = process.env.MONDAY_CLIENT_SECRET;
  if (!redirectUri || !clientId || !clientSecret) {
    return new NextResponse("Missing monday OAuth configuration", { status: 500 });
  }

  try {
    const tokens = await exchangeCodeForToken({
      code,
      redirectUri,
      clientId,
      clientSecret
    });
    const account = await fetchAccountDetails(tokens.access_token);

    const supabase = getServiceSupabase();
    const tenantId = newId();

    const { data: existingTenantData } = await supabase
      .from("tenants")
      .select("id, plan, seats")
      .eq("monday_account_id", account.id)
      .maybeSingle();

    const existingTenant = existingTenantData as TenantRecord | null;
    const upsertTenantId = existingTenant?.id ?? tenantId;
    const plan = existingTenant?.plan ?? "free";
    const seats = existingTenant?.seats ?? 1;

    const tenantPayload: TenantInsert = {
      id: upsertTenantId,
      monday_account_id: account.id,
      region: account.region ?? null,
      plan,
      seats,
      updated_at: new Date().toISOString()
    };

    await supabase.from("tenants").upsert(tenantPayload, { onConflict: "monday_account_id" });

    const entitlementPayload: EntitlementInsert = {
      tenant_id: upsertTenantId,
      plan,
      seats,
      raw: { tokens, account },
      updated_at: new Date().toISOString()
    };

    await supabase.from("entitlements").upsert(entitlementPayload, { onConflict: "tenant_id" });

    logger.info("OAuth flow completed", { accountId: account.id });

    return NextResponse.json({
      tenantId: upsertTenantId,
      accountId: account.id,
      plan,
      flags: flagsForPlan(plan, seats)
    });
  } catch (error) {
    logger.error("Failed to complete monday OAuth", { error: (error as Error).message });
    return new NextResponse("OAuth failed", { status: 500 });
  }
}
