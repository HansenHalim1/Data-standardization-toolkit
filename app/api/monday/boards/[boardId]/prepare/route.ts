import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServiceSupabase } from "@/lib/db";
import { verifyMondaySessionToken } from "@/lib/security";
import { ensureBoardColumnsForRecipe, resolveOAuthToken } from "@/lib/mondayApi";
import { prepareRecipeForBoard } from "@/lib/mondayRecipes";
import type { RecipeDefinition, WriteBackStep } from "@/lib/recipe-engine";

const recipeSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number(),
  steps: z.array(z.object({ type: z.string(), config: z.any() }))
});

const requestSchema = z.object({
  recipe: recipeSchema
});

type RouteContext = {
  params: {
    boardId: string;
  };
};

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authHeader = request.headers.get("authorization") ?? "";
  const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!sessionToken) {
    return new NextResponse("Missing monday token", { status: 401 });
  }

  try {
    const { accountId, userId } = verifyMondaySessionToken(sessionToken);
    const supabase = getServiceSupabase();
    const accountKey = String(accountId);

    const body = (await request.json().catch(() => null)) as unknown;
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(parsed.error.flatten(), { status: 400 });
    }

    let accessToken: string;
    try {
      accessToken = await resolveOAuthToken(supabase, accountKey, String(userId));
    } catch (error) {
      return new NextResponse((error as Error).message, { status: 403 });
    }

    const recipe = parsed.data.recipe as RecipeDefinition;
    const boardData = await ensureBoardColumnsForRecipe({
      accessToken,
      boardId: params.boardId,
      recipe
    });
    const preparedRecipe = prepareRecipeForBoard(recipe, boardData);

    // If the prepared recipe includes a key column (and a resolved key column id),
    // collect the existing values on the board for uniqueness checks.
    let existingKeys: string[] = [];
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
    } catch (err) {
      // non-fatal: don't block prepare if extracting existing keys fails
    }

    return NextResponse.json({
      preparedRecipe,
      board: {
        boardId: boardData.boardId,
        boardName: boardData.boardName,
        columns: boardData.columns.map((column) => ({
          id: column.id,
          title: column.title ?? column.id
        })),
        existingKeys
      }
    });
  } catch (error) {
    return new NextResponse((error as Error).message ?? "Unauthorized", { status: 401 });
  }
}
