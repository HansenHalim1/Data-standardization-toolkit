import { NextResponse } from "next/server";
import { z } from "zod";
import { getServiceSupabase } from "@/lib/db";
import { createLogger } from "@/lib/logging";
import type { Database } from "@/types/supabase";

type RecipeUpdate = Database["public"]["Tables"]["recipes"]["Update"];

const updateRecipeSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  payload: z.any()
});

export async function POST(request: Request) {
  const logger = createLogger({ component: "recipes.update" });
  const body = await request.json().catch(() => null);
  const parsed = updateRecipeSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(parsed.error.flatten(), { status: 400 });
  }

  const supabase = getServiceSupabase();
  const { id, tenantId, payload } = parsed.data;
  const updatePayload: RecipeUpdate = {
    json: payload,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("recipes")
    .update(updatePayload)
    .eq("id", id)
    .eq("tenant_id", tenantId);

  if (error) {
    logger.error("Failed to update recipe", { tenantId, recipeId: id, error: error.message });
    return new NextResponse("Unable to update recipe", { status: 500 });
  }

  logger.info("Recipe updated", { tenantId, recipeId: id });
  return NextResponse.json({ ok: true });
}
