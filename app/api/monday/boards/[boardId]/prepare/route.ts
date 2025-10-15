import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServiceSupabase } from "@/lib/db";
import { verifyMondaySessionToken } from "@/lib/security";
import { fetchBoardData, resolveOAuthToken } from "@/lib/mondayApi";
import { prepareRecipeForBoard } from "@/lib/mondayRecipes";
import type { RecipeDefinition } from "@/lib/recipe-engine";

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
    const boardData = await fetchBoardData(accessToken, params.boardId);
    const preparedRecipe = prepareRecipeForBoard(recipe, boardData);

    return NextResponse.json({
      preparedRecipe,
      board: {
        boardId: boardData.boardId,
        boardName: boardData.boardName
      }
    });
  } catch (error) {
    return new NextResponse((error as Error).message ?? "Unauthorized", { status: 401 });
  }
}
