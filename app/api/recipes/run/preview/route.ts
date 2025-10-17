import { NextResponse } from "next/server";
import { z } from "zod";
import { getServiceSupabase } from "@/lib/db";
import { flagsForPlan } from "@/lib/entitlements";
import {
  previewRecipe,
  type MapColumnsStep,
  type RecipeDefinition,
  type WriteBackStep
} from "@/lib/recipe-engine";
import { parseTableFile } from "@/lib/csv";
import { newId } from "@/lib/ids";
import { createLogger } from "@/lib/logging";
import type { Database } from "@/types/supabase";
import { verifyMondaySessionToken } from "@/lib/security";
import { boardItemsToRows, ensureBoardColumnsForRecipe, resolveOAuthToken } from "@/lib/mondayApi";
import { prepareRecipeForBoard } from "@/lib/mondayRecipes";

type TenantRecord = Pick<Database["public"]["Tables"]["tenants"]["Row"], "id" | "plan" | "seats">;
type RunInsert = Database["public"]["Tables"]["runs"]["Insert"];
type RunUpdate = Database["public"]["Tables"]["runs"]["Update"];

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_PREVIEW_ROWS = 200;

const recipeSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number(),
  steps: z.array(z.object({ type: z.string(), config: z.any() }))
});

const boardPreviewSchema = z.object({
  source: z.object({
    type: z.literal("board"),
    boardId: z.string()
  }),
  recipe: recipeSchema,
  plan: z.string().optional()
});

export async function POST(request: Request) {
  const logger = createLogger({ component: "recipes.preview" });
  const authHeader = request.headers.get("authorization") ?? "";
  const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!sessionToken) {
    return new NextResponse("Missing monday token", { status: 401 });
  }

  const contentType = request.headers.get("content-type") ?? "";

  try {
    const { accountId, userId } = verifyMondaySessionToken(sessionToken);
    const accountKey = String(accountId);
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

  let recipe: RecipeDefinition;
  let preparedRecipe: RecipeDefinition;
  let planParam: string | undefined;
  let tableRows: Record<string, unknown>[] = [];
  let sourceBoard: { boardId: string; boardName: string } | null = null;
  let previewColumns: Array<{ id: string | null; title: string }> = [];
  let existingKeys: string[] | undefined = undefined;

    if (contentType.includes("application/json")) {
      const jsonBody = await request.json().catch(() => null);
      const parsed = boardPreviewSchema.safeParse(jsonBody);
      if (!parsed.success) {
        return NextResponse.json(parsed.error.flatten(), { status: 400 });
      }

      recipe = parsed.data.recipe as RecipeDefinition;
      planParam = parsed.data.plan ?? undefined;

      let accessToken: string;
      try {
        accessToken = await resolveOAuthToken(supabase, accountKey, String(userId));
      } catch (tokenError) {
        logger.warn("Missing monday OAuth token for board preview", {
          accountId: accountKey,
          error: (tokenError as Error).message
        });
        return new NextResponse("monday.com account is not connected. Please reconnect via settings.", {
          status: 403
        });
      }

      const boardData = await ensureBoardColumnsForRecipe({
        accessToken,
        boardId: parsed.data.source.boardId,
        recipe
      });
      tableRows = boardItemsToRows(boardData);
      preparedRecipe = prepareRecipeForBoard(recipe, boardData);
      sourceBoard = { boardId: boardData.boardId, boardName: boardData.boardName };
      previewColumns = boardData.columns.map((column) => ({
        id: column.id,
        title: column.title ?? column.id
      }));

      // Collect existing keys on the board for uniqueness checks when a key column is configured
      try {
        const writeStep = preparedRecipe.steps.find((s): s is WriteBackStep => s.type === "write_back");
        const keyColumnId = writeStep?.config?.keyColumnId ?? null;
        if (keyColumnId) {
          const vals: string[] = [];
          for (const item of boardData.items) {
            const col = item.column_values?.find((v) => v.id === keyColumnId);
            if (col && col.text && col.text.toString().trim().length > 0) {
              vals.push(col.text.toString().trim().toLowerCase());
            }
          }
          existingKeys = Array.from(new Set(vals));
        }
      } catch {
        // non-fatal
      }
    } else {
      const formData = await request.formData();
      const file = formData.get("file");
      const recipePayload = formData.get("recipe");
      if (!(file instanceof File)) {
        return new NextResponse("file is required", { status: 400 });
      }
      if (typeof recipePayload !== "string") {
        return new NextResponse("recipe missing", { status: 400 });
      }

      const parsedRecipe = recipeSchema.safeParse(JSON.parse(recipePayload));
      if (!parsedRecipe.success) {
        return NextResponse.json(parsedRecipe.error.flatten(), { status: 400 });
      }

      recipe = parsedRecipe.data as RecipeDefinition;
      const buffer = Buffer.from(await file.arrayBuffer());
      const table = parseTableFile(buffer, file.name);
      tableRows = table.rows;
      preparedRecipe = recipe;
    }

    const limitedRows = tableRows.slice(0, MAX_PREVIEW_ROWS);

    if (limitedRows.length > flags.rowCap) {
      return new NextResponse("Plan row cap exceeded", { status: 402 });
    }

    if (planParam && planParam.toLowerCase() !== tenant.plan.toLowerCase()) {
      return new NextResponse("Plan mismatch", { status: 409 });
    }

    const runId = newId();

    const runInsertPayload: RunInsert = {
      id: runId,
      tenant_id: tenant.id,
      recipe_id: preparedRecipe.id,
      recipe_version: preparedRecipe.version,
      status: "previewing",
      rows_in: limitedRows.length,
      preview: null,
      started_at: new Date().toISOString(),
      created_by: String(userId)
    };

    await supabase.from("runs").insert(runInsertPayload);

    const preview = previewRecipe(preparedRecipe, limitedRows, {
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

    if (!sourceBoard) {
      const columnSet = new Set<string>();
      for (const row of limitedRows) {
        for (const key of Object.keys(row)) {
          if (key) {
            columnSet.add(key);
          }
        }
      }
      previewColumns = Array.from(columnSet).map((title) => ({
        id: null,
        title
      }));
    }

    const responsePayload: Record<string, unknown> = {
      ...preview,
      runId,
      preparedRecipe
    };

    if (sourceBoard) {
      responsePayload.sourceBoard = sourceBoard;
    }

    if (previewColumns.length > 0) {
      responsePayload.columns = previewColumns;
    }

    if (existingKeys && existingKeys.length > 0) {
      responsePayload.board = {
        existingKeys
      };
    }

    return NextResponse.json(responsePayload);
  } catch (error) {
    logger.warn("Preview failed", { error: (error as Error).message });
    return new NextResponse("Unauthorized", { status: 401 });
  }
}



