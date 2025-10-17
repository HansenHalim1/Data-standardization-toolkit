import { NextResponse } from "next/server";
import { z } from "zod";
import { getServiceSupabase } from "@/lib/db";
import { flagsForPlan } from "@/lib/entitlements";
import { executeRecipe, type RecipeDefinition, type WriteBackStep } from "@/lib/recipe-engine";
import { createLogger } from "@/lib/logging";
import { monthKey } from "@/lib/ids";
import type { Database } from "@/types/supabase";
import { verifyMondaySessionToken } from "@/lib/security";
import { resolveOAuthToken, upsertRowsToBoard } from "@/lib/mondayApi";

type TenantRecord = Pick<Database["public"]["Tables"]["tenants"]["Row"], "id" | "plan" | "seats">;
type RunUpdate = Database["public"]["Tables"]["runs"]["Update"];
type IncrementUsageArgs = Database["public"]["Functions"]["increment_usage"]["Args"];

export const runtime = "nodejs";
export const maxDuration = 60;

const executeSchema = z.object({
  tenantId: z.string().uuid().optional(),
  runId: z.string().optional(),
  recipe: z.object({
    id: z.string(),
    name: z.string(),
    version: z.number(),
    steps: z.array(z.object({ type: z.string(), config: z.any() }))
  }),
  plan: z.string().optional(),
  previewRows: z.array(z.record(z.any()))
});

export async function POST(request: Request) {
  const logger = createLogger({ component: "recipes.execute" });
  const authHeader = request.headers.get("authorization") ?? "";
  const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!sessionToken) {
    return new NextResponse("Missing monday token", { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = executeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(parsed.error.flatten(), { status: 400 });
  }

  try {
    const { accountId, userId } = verifyMondaySessionToken(sessionToken);
    const accountKey = String(accountId);

  const { tenantId: requestedTenantId, recipe, plan, previewRows, runId } = parsed.data;
  logger.info("Execute called", { tenantId: requestedTenantId ?? null, incomingPreviewRows: previewRows.length, recipeSteps: recipe.steps.map((s: any) => s.type) });
  try {
    const dedupeConfigs = recipe.steps.filter((s: any) => s.type === "dedupe").map((s: any) => s.config);
    if (dedupeConfigs.length > 0) {
      logger.info("Dedupe step configs", { dedupeConfigs });
    }
  } catch (e) {
    // non-fatal
  }
    if (previewRows.length === 0) {
      return new NextResponse("No rows to process", { status: 400 });
    }

    const supabase = getServiceSupabase();
    const { data: tenantData } = await supabase
      .from("tenants")
      .select("id, plan, seats")
      .eq("monday_account_id", accountKey)
      .maybeSingle();

    const tenant = tenantData as TenantRecord | null;
    if (!tenant || !tenant.id) {
      return new NextResponse("Tenant not found", { status: 404 });
    }

    if (requestedTenantId && requestedTenantId !== tenant.id) {
      return new NextResponse("Tenant mismatch", { status: 409 });
    }

    const flags = flagsForPlan(tenant.plan, tenant.seats);
    if (previewRows.length > flags.rowCap) {
      return new NextResponse("Plan row cap exceeded", { status: 402 });
    }
    if (plan && plan.toLowerCase() !== tenant.plan.toLowerCase()) {
      return new NextResponse("Plan mismatch", { status: 409 });
    }

    let accessToken: string;
    try {
      accessToken = await resolveOAuthToken(supabase, accountKey, String(userId));
    } catch (tokenError) {
      logger.warn("Missing monday OAuth token for write-back", { accountId: accountKey, error: (tokenError as Error).message });
      return new NextResponse("monday.com account is not connected. Please reconnect via settings.", {
        status: 403
      });
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
      const writeConfig = config as WriteBackStep["config"];
      if (writeConfig.strategy !== "monday_upsert") {
        return;
      }
      if (!writeConfig.boardId || !writeConfig.columnMapping) {
        throw new Error("Missing monday board configuration for write-back");
      }
      logger.info("Run write-back triggered", {
        tenantId: tenant.id,
        boardId: writeConfig.boardId,
        rows: rows.length,
        columnMappingKeys: Object.keys(writeConfig.columnMapping),
        keyColumn: writeConfig.keyColumn ?? null
      });
      try {
        await upsertRowsToBoard({
          accessToken,
          boardId: writeConfig.boardId,
          columnMapping: writeConfig.columnMapping,
          rows,
          keyColumn: writeConfig.keyColumn,
          keyColumnId: writeConfig.keyColumnId,
          itemNameField: writeConfig.itemNameField
        });
      } catch (error) {
        logger.error("monday write-back failed", {
          tenantId: tenant.id,
          boardId: writeConfig.boardId,
          error: (error as Error).message
        });
        throw error;
      }
    };

    const result = await executeRecipe(recipe as RecipeDefinition, previewRows, {
      allowFuzzy: flags.fuzzyMatching,
      writeBack
    });

    logger.info("Execute result", { tenantId: tenant.id, rowsProcessed: result.rowsProcessed, rowsWritten: result.rowsWritten, errors: result.errors.length });

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
      tenant: tenant.id,
      month: monthKey(),
      rows: result.rowsWritten
    };

    const { error } = await supabase.rpc("increment_usage", usageArgs);
    if (error) {
      logger.error("Failed to increment usage after execute", { tenantId: tenant.id, error: error.message });
    }

    logger.info("Recipe executed", { tenantId: tenant.id, rows: result.rowsWritten });
    return NextResponse.json({
      rowsWritten: result.rowsWritten,
      errors: result.errors,
      usageUpdated: !error
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
    logger.warn("Execute failed", { error: message });
    // Return the error message in the response body to aid debugging client-side.
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
