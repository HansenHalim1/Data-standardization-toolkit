import { NextResponse } from "next/server";
import { z } from "zod";
import { getServiceSupabase } from "@/lib/db";
import { verifyMondaySessionToken } from "@/lib/security";
import { createBoardForRecipe, fetchBoards, resolveOAuthToken, upsertRowsToBoardBatchSafe } from "@/lib/mondayApi";
import { createLogger } from "@/lib/logging";
import { prepareRecipeForBoard } from "@/lib/mondayRecipes";
import type { RecipeDefinition } from "@/lib/recipe-engine";

export const runtime = "nodejs";

const logger = createLogger({ component: "monday.boards" });

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!sessionToken) {
    return new NextResponse("Missing monday token", { status: 401 });
  }

  try {
    const { accountId, userId } = verifyMondaySessionToken(sessionToken);
    const accountKey = String(accountId);
    const supabase = getServiceSupabase();

    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.min(Number(limitParam) || 50, 200) : 50;

    const accessToken = await resolveOAuthToken(supabase, accountKey, String(userId));
    const boards = await fetchBoards(accessToken, limit);

    return NextResponse.json({ boards });
  } catch (error) {
    const message = (error as Error).message;
    const status = message.includes("not connected") ? 403 : 401;
    logger.warn("Failed to list monday boards", { error: message });
    return new NextResponse(message || "Unauthorized", { status });
  }
}

const recipeSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number(),
  steps: z.array(z.object({ type: z.string(), config: z.any() }))
});

const createBoardSchema = z.object({
  name: z.string().trim().min(1, "Board name is required").max(120, "Board name is too long"),
  boardKind: z.enum(["public", "private", "share"]).optional(),
  workspaceId: z.union([z.string(), z.number()]).optional(),
  columns: z.array(z.string()).optional(),
  seedRows: z.array(z.record(z.any())).optional(),
  recipe: recipeSchema
});

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization") ?? "";
  const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!sessionToken) {
    return new NextResponse("Missing monday token", { status: 401 });
  }

  try {
    const { accountId, userId } = verifyMondaySessionToken(sessionToken);
    const supabase = getServiceSupabase();
    const accountKey = String(accountId);

    const body = await request.json().catch(() => null);
    const parsed = createBoardSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(parsed.error.flatten(), { status: 400 });
    }

  const { name, boardKind, workspaceId, recipe, columns, seedRows } = parsed.data;
    const recipeDefinition = recipe as RecipeDefinition;
    const resolvedBoardKind = boardKind ?? "share";

    const workspaceIdNumber =
      workspaceId === undefined
        ? undefined
        : typeof workspaceId === "number"
          ? workspaceId
          : Number(workspaceId);

    if (workspaceId !== undefined && !Number.isFinite(workspaceIdNumber)) {
      return new NextResponse("workspaceId must be a number", { status: 400 });
    }

    const accessToken = await resolveOAuthToken(supabase, accountKey, String(userId));
    const { boardData, summary } = await createBoardForRecipe({
      accessToken,
      recipe: recipeDefinition,
      boardName: name,
      boardKind: resolvedBoardKind,
      workspaceId: workspaceIdNumber,
      extraColumns: columns ?? undefined
    });

    // If seedRows were provided, attempt to seed them into the created board.
    let seedSummary: { totalSuccess: number; totalFailed: number; results?: unknown } | null = null;
    if (seedRows && Array.isArray(seedRows) && seedRows.length > 0) {
      try {
        logger.info("Seeding requested rows", { boardId: summary.id, requestedSeedCount: seedRows.length });
        // Build a mapping from source field (CSV header) -> monday column id using the created board columns.
  const mapping: Record<string, string> = {};
        const normalize = (v: string | null | undefined) =>
          (v ?? "").toString().trim().toLowerCase().replace(/[^a-z0-9]/g, "");

        // If client provided a `columns` array (CSV headers), prefer that list for mapping.
        const headerCandidates: string[] = Array.isArray(columns) && columns.length > 0 ? columns : [];

        for (const header of headerCandidates) {
          const normHeader = normalize(header);
          const match = boardData.columns.find((col) => {
            const normTitle = normalize(col.title ?? col.id);
            // match if normalized title equals normalized header or includes it
            return (
              normTitle === normHeader ||
              normTitle.includes(normHeader) ||
              normHeader.includes(normTitle)
            );
          });
          if (match && match.id) {
            mapping[header] = match.id;
          }
        }

        logger.info("Derived header->column mapping", { boardId: summary.id, mapping, headers: headerCandidates });

        // Fallback: if mapping is empty, try to derive mapping from recipe write_back.config.columnMapping
        if (Object.keys(mapping).length === 0) {
          const writeStep = (recipeDefinition.steps || []).find((s: any) => s.type === 'write_back') as any;
          const recipeMapping: Record<string, string> = (writeStep && writeStep.config && writeStep.config.columnMapping) || {};
          for (const [field, target] of Object.entries(recipeMapping)) {
            // try to resolve target to a column id by matching title/id
            const normTarget = normalize(String(target));
            const match = boardData.columns.find((col) => normalize(col.id) === normTarget || normalize(col.title ?? col.id) === normTarget);
            if (match && match.id) {
              mapping[field] = match.id;
            }
          }
        }

        const keyStep = (recipeDefinition.steps || []).find((s: any) => s.type === 'write_back') as any;
        const keyColumn = keyStep?.config?.keyColumn;
        const keyColumnId = keyStep?.config?.keyColumnId;
        const itemNameField = keyStep?.config?.itemNameField;

        // Normalize seedRows keys so they align with the mapping keys (handle case/spacing differences)
        const normKeyToMappingKey: Record<string, string> = {};
        for (const mk of Object.keys(mapping)) {
          normKeyToMappingKey[normalize(mk)] = mk;
        }

        const transformedRows = (seedRows as Array<Record<string, unknown>>).map((r) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) {
            const nk = normalize(k);
            const mappingKey = normKeyToMappingKey[nk];
            if (mappingKey) {
              out[mappingKey] = v;
            }
          }
          return out;
        });

        logger.info("Transformed seed rows to mapping keys", { boardId: summary.id, requested: seedRows.length, transformed: transformedRows.length });

        const result = await upsertRowsToBoardBatchSafe({
          accessToken,
          boardId: summary.id,
          columnMapping: mapping,
          rows: transformedRows,
          keyColumn,
          keyColumnId,
          itemNameField,
          batchSize: 10,
          delayMs: 300,
          maxRetries: 3
        });
        seedSummary = {
          totalSuccess: result.totalSuccess,
          totalFailed: result.totalFailed,
          results: result.results,
          mappingUsed: mapping,
          requestedSeedCount: seedRows.length
        } as any;
      } catch (err) {
        logger.warn('Seeding rows to created board failed', { error: (err as Error).message });
        // keep seedSummary null to indicate seeding failed
      }
    }

    const preparedRecipe = prepareRecipeForBoard(recipeDefinition, boardData);

    logger.info("Created monday board via API", {
      accountId: accountKey,
      boardId: summary.id
    });

    return NextResponse.json({
      board: {
        boardId: summary.id,
        boardName: summary.name,
        workspaceName: summary.workspaceName ?? null,
        workspaceId: summary.workspaceId ?? null,
        kind: summary.kind ?? null,
        columns: boardData.columns.map((column) => ({
          id: column.id,
          title: column.title ?? column.id
        }))
      },
      preparedRecipe,
      seedSummary
    });
  } catch (error) {
    const message = (error as Error).message || "Unauthorized";
    const status = message.includes("not connected") ? 403 : 401;
    logger.warn("Failed to create monday board", { error: message });
    return new NextResponse(message, { status });
  }
}
