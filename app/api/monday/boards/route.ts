import { NextResponse } from "next/server";
import { z } from "zod";
import { getServiceSupabase } from "@/lib/db";
import { verifyMondaySessionToken } from "@/lib/security";
import { createBoardForRecipe, fetchBoards, resolveOAuthToken } from "@/lib/mondayApi";
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

  const { name, boardKind, workspaceId, recipe, columns } = parsed.data;
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
      preparedRecipe
    });
  } catch (error) {
    const message = (error as Error).message || "Unauthorized";
    const status = message.includes("not connected") ? 403 : 401;
    logger.warn("Failed to create monday board", { error: message });
    return new NextResponse(message, { status });
  }
}
