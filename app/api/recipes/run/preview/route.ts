import { NextResponse } from "next/server";
import { z } from "zod";
import { getServiceSupabase } from "@/lib/db";
import { flagsForPlan } from "@/lib/entitlements";
import { previewRecipe, type RecipeDefinition } from "@/lib/recipe-engine";
import { parseTableFile } from "@/lib/csv";
import { newId } from "@/lib/ids";
import { createLogger } from "@/lib/logging";
import type { Database } from "@/types/supabase";
import { verifyMondaySessionToken } from "@/lib/security";

type TenantRecord = Pick<Database["public"]["Tables"]["tenants"]["Row"], "id" | "plan" | "seats">;
type RunInsert = Database["public"]["Tables"]["runs"]["Insert"];
type RunUpdate = Database["public"]["Tables"]["runs"]["Update"];

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_PREVIEW_ROWS = 200;

export async function POST(request: Request) {
  const logger = createLogger({ component: "recipes.preview" });
  const authHeader = request.headers.get("authorization") ?? "";
  const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!sessionToken) {
    return new NextResponse("Missing monday token", { status: 401 });
  }

  try {
    const { accountId, userId } = verifyMondaySessionToken(sessionToken);
    const accountKey = String(accountId);

    const formData = await request.formData();
    const file = formData.get("file");
    const recipePayload = formData.get("recipe");

    if (!(file instanceof File)) {
      return new NextResponse("file is required", { status: 400 });
    }
    if (typeof recipePayload !== "string") {
      return new NextResponse("recipe missing", { status: 400 });
    }

    const recipeSchema = z.object({
      id: z.string(),
      name: z.string(),
      version: z.number(),
      steps: z.array(z.object({ type: z.string(), config: z.any() }))
    });

    const parseRecipe = recipeSchema.safeParse(JSON.parse(recipePayload));
    if (!parseRecipe.success) {
      return NextResponse.json(parseRecipe.error.flatten(), { status: 400 });
    }

    const recipe = parseRecipe.data as RecipeDefinition;
    const supabase = getServiceSupabase();

    const { data: tenantRecord } = await supabase
      .from("tenants")
      .select("id, plan, seats")
      .eq("monday_account_id", accountKey)
      .maybeSingle();

    const tenant = tenantRecord as (TenantRecord & { id: string }) | null;
    if (!tenant || !tenant.id) {
      return new NextResponse("Tenant not found", { status: 404 });
    }

    const flags = flagsForPlan(tenant.plan, tenant.seats);

    const buffer = Buffer.from(await file.arrayBuffer());
    const table = parseTableFile(buffer, file.name);
    const limitedRows = table.rows.slice(0, MAX_PREVIEW_ROWS);

    if (limitedRows.length > flags.rowCap) {
      return new NextResponse("Plan row cap exceeded", { status: 402 });
    }

    const runId = newId();

    const runInsertPayload: RunInsert = {
      id: runId,
      tenant_id: tenant.id,
      recipe_id: recipe.id,
      recipe_version: recipe.version,
      status: "previewing",
      rows_in: limitedRows.length,
      preview: null,
      started_at: new Date().toISOString(),
      created_by: String(userId)
    };

    await supabase.from("runs").insert(runInsertPayload);

    const preview = previewRecipe(recipe, limitedRows, {
      allowFuzzy: flags.fuzzyMatching
    });

    const dbPreview = preview as unknown as RunUpdate["preview"];

    const runUpdatePayload: RunUpdate = {
      status: "queued",
      preview: dbPreview,
      updated_at: new Date().toISOString()
    };

    await supabase
      .from("runs")
      .update(runUpdatePayload)
      .eq("id", runId);

    logger.info("Preview generated", { tenantId: tenant.id, runId, rows: limitedRows.length });

    return NextResponse.json({
      ...preview,
      runId
    });
  } catch (error) {
    logger.warn("Preview failed", { error: (error as Error).message });
    return new NextResponse("Unauthorized", { status: 401 });
  }
}


