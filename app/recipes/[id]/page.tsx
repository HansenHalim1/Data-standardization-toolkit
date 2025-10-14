import { notFound } from "next/navigation";
import { getServiceSupabase } from "@/lib/db";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import RecipeEditorShell from "./RecipeEditorShell";
import type { Database } from "@/types/supabase";

type RecipeRecord = Pick<Database["public"]["Tables"]["recipes"]["Row"], "id" | "name" | "version" | "json" | "tenant_id">;

type RecipePageProps = {
  params: {
    id: string;
  };
};

export default async function RecipePage({ params }: RecipePageProps) {
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("recipes")
    .select("id, name, version, json, tenant_id")
    .eq("id", params.id)
    .maybeSingle();

  const recipe = data as RecipeRecord | null;
  if (!recipe) {
    notFound();
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-12">
      <Card>
        <CardHeader>
          <CardTitle>{recipe.name}</CardTitle>
          <CardDescription>Version {recipe.version}</CardDescription>
        </CardHeader>
        <CardContent>
          <RecipeEditorShell recipe={recipe} />
        </CardContent>
      </Card>
    </main>
  );
}
