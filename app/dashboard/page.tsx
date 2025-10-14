import { Metadata } from "next";
import Link from "next/link";
import { getServiceSupabase } from "@/lib/db";
import { flagsForPlan } from "@/lib/entitlements";
import { UsageBadge } from "@/components/UsageBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Database } from "@/types/supabase";

type TenantRecord = Pick<Database["public"]["Tables"]["tenants"]["Row"], "id" | "plan" | "seats">;
type UsageRecord = Pick<Database["public"]["Tables"]["usage_monthly"]["Row"], "rows_processed">;

export const metadata: Metadata = {
  title: "Dashboard | Data Standardization Toolkit"
};

type DashboardPageProps = {
  searchParams: {
    tenant?: string;
  };
};

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const tenantId = searchParams.tenant;
  if (!tenantId) {
    return (
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-16">
        <Card>
          <CardHeader>
            <CardTitle>Select a tenant</CardTitle>
            <CardDescription>
              Provide a tenant id via <code>?tenant=&lt;uuid&gt;</code> to load entitlements and usage.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm text-muted-foreground">
            <p>
              This dashboard is intended to be accessed from monday with a signed session context. Use the
              monday board app or set up local dev via the README to test end-to-end.
            </p>
            <Button asChild className="w-max">
              <Link href="/monday/view">Open board view</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const supabase = getServiceSupabase();
  const { data: tenantData } = await supabase
    .from("tenants")
    .select("id, plan, seats, entitlements:entitlements(plan, seats, raw)")
    .eq("id", tenantId)
    .maybeSingle();

  const tenant = tenantData as TenantRecord | null;
  const plan = tenant?.plan ?? "free";
  const seats = tenant?.seats ?? 1;
  const flags = flagsForPlan(plan, seats);

  const { data: usageData } = await supabase
    .from("usage_monthly")
    .select("rows_processed")
    .eq("tenant_id", tenantId)
    .order("month", { ascending: false })
    .limit(1)
    .maybeSingle();

  const usage = usageData as UsageRecord | null;
  const usedRows = usage?.rows_processed ?? 0;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-12">
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold">Tenant Overview</h1>
          <UsageBadge used={usedRows} cap={flags.rowCap} />
        </div>
        <p className="text-sm text-muted-foreground">
          Plan gates automatically unlock once monday monetization webhooks update the tenant record.
        </p>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Plan</CardTitle>
            <CardDescription>Governs which recipe features are available.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Current Plan</span>
              <span className="font-medium uppercase">{flags.plan}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Seats</span>
              <span className="font-medium">{flags.seats}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fuzzy Matching</span>
              <span className="font-medium">{flags.fuzzyMatching ? "Enabled" : "Locked"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Schedules</span>
              <span className="font-medium">{flags.schedules ? "Enabled" : "Locked"}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Next Actions</CardTitle>
            <CardDescription>Keep data standardization humming.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>1. Invite workspace admins to review premium feature usage.</p>
            <p>2. Monitor run history in Supabase via the `runs` table.</p>
            <p>3. Configure schedules once you upgrade to Starter or higher.</p>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
