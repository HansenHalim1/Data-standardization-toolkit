import { NextResponse } from "next/server";
import { z } from "zod";
import { getServiceSupabase } from "@/lib/db";
import { newId } from "@/lib/ids";
import { createLogger } from "@/lib/logging";
import type { Database } from "@/types/supabase";

type RecipeInsert = Database["public"]["Tables"]["recipes"]["Insert"];

const createRecipeSchema = z.object({
  tenantId: z.string().uuid(),
  name: z.string().min(1),
  json: z.any(),
  version: z.number().int().positive().default(1)
});

export async function POST(request: Request) {
  const logger = createLogger({ component: "recipes.create" });
  const body = await request.json().catch(() => null);

  const parseResult = createRecipeSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(parseResult.error.flatten(), { status: 400 });
  }

  const supabase = getServiceSupabase();
  const id = newId();
  const { tenantId, name, json, version } = parseResult.data;

  const recipePayload: RecipeInsert = {
    id,
    tenant_id: tenantId,
    name,
    version,
    json,
    created_at: new Date().toISOString()
  };

  const { error } = await supabase.from("recipes").insert(recipePayload);

  if (error) {
    logger.error("Failed to create recipe", { tenantId, error: error.message });
    return new NextResponse("Unable to create recipe", { status: 500 });
  }

  logger.info("Recipe created", { tenantId, recipeId: id });
  return NextResponse.json({ id });
}
