import { NextResponse } from "next/server";
import { z } from "zod";
import { getServiceSupabase } from "@/lib/db";
import { flagsForPlan } from "@/lib/entitlements";
import { executeRecipe, type RecipeDefinition } from "@/lib/recipe-engine";
import { chunkArray } from "@/lib/utils";
import { createLogger } from "@/lib/logging";
import { monthKey } from "@/lib/ids";
import type { Database } from "@/types/supabase";

type TenantRecord = Pick<Database["public"]["Tables"]["tenants"]["Row"], "plan" | "seats">;
type RunUpdate = Database["public"]["Tables"]["runs"]["Update"];
type IncrementUsageArgs = Database["public"]["Functions"]["increment_usage"]["Args"];

export const runtime = "nodejs";
export const maxDuration = 60;

const executeSchema = z.object({
  tenantId: z.string().uuid(),
  runId: z.string().optional(),
  recipe: z.object({
    id: z.string(),
    name: z.string(),
    version: z.number(),
    steps: z.array(z.object({ type: z.string(), config: z.any() }))
  }),
  plan: z.string(),
  previewRows: z.array(z.record(z.any()))
});

const CHUNK_SIZE = 500;

export async function POST(request: Request) {
  const logger = createLogger({ component: "recipes.execute" });
  const body = await request.json().catch(() => null);
  const parsed = executeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(parsed.error.flatten(), { status: 400 });
  }

  const { tenantId, recipe, plan, previewRows, runId } = parsed.data;
  if (previewRows.length === 0) {
    return new NextResponse("No rows to process", { status: 400 });
  }

  const supabase = getServiceSupabase();
  const { data: tenantData } = await supabase
    .from("tenants")
    .select("plan, seats")
    .eq("id", tenantId)
    .maybeSingle();

  const tenant = tenantData as TenantRecord | null;
  if (!tenant) {
    return new NextResponse("Tenant not found", { status: 404 });
  }

  const flags = flagsForPlan(tenant.plan, tenant.seats);
  if (previewRows.length > flags.rowCap) {
    return new NextResponse("Plan row cap exceeded", { status: 402 });
  }
  if (plan.toLowerCase() !== tenant.plan.toLowerCase()) {
    return new NextResponse("Plan mismatch", { status: 409 });
  }

  if (runId) {
    const runningUpdate: RunUpdate = {
      status: "running",
      started_at: new Date().toISOString()
    };

    await supabase
      .from("runs")
      .update(runningUpdate)
      .eq("id", runId);
  }

  const writeBack = async (
    rows: Record<string, unknown>[],
    config: RecipeDefinition["steps"][number]["config"]
  ) => {
    const strategy = (config as { strategy?: string })?.strategy;
    for (const chunk of chunkArray(rows, CHUNK_SIZE)) {
      logger.info("Write-back chunk", { tenantId, size: chunk.length });
      if (strategy === "csv") {
        // CSV exports handled separately. This stub could enqueue file generation.
      } else {
        // TODO: integrate monday GraphQL upsert once access token is persisted.
      }
    }
  };

  const result = await executeRecipe(recipe as RecipeDefinition, previewRows, {
    allowFuzzy: flags.fuzzyMatching,
    writeBack
  });

  if (runId) {
    const completeUpdate: RunUpdate = {
      status: result.errors.length ? "failed" : "success",
      rows_in: previewRows.length,
      rows_out: result.rowsWritten,
      errors: result.errors,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await supabase
      .from("runs")
      .update(completeUpdate)
      .eq("id", runId);
  }

  const usageArgs: IncrementUsageArgs = {
    tenant: tenantId,
    month: monthKey(),
    rows: result.rowsWritten
  };

  const { error } = await supabase.rpc("increment_usage", usageArgs);
  if (error) {
    logger.error("Failed to increment usage after execute", { tenantId, error: error.message });
  }

  logger.info("Recipe executed", { tenantId, rows: result.rowsWritten });
  return NextResponse.json({
    rowsWritten: result.rowsWritten,
    errors: result.errors,
    usageUpdated: !error
  });
}
