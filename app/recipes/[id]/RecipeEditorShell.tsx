'use client';

import { useState, useTransition } from "react";
import { RecipeEditor } from "@/components/RecipeEditor";
import { Toast } from "@/components/Toast";

type RecipeRecord = {
  id: string;
  tenant_id: string;
  version: number;
  json: unknown;
};

type RecipeEditorShellProps = {
  recipe: RecipeRecord;
};

export default function RecipeEditorShell({ recipe }: RecipeEditorShellProps) {
  const [toast, setToast] = useState<{ message: string; variant?: "default" | "success" | "error" } | null>(
    null
  );
  const [isPending, startTransition] = useTransition();

  return (
    <>
      <RecipeEditor
        initialValue={recipe.json}
        onChange={(value) => {
          startTransition(async () => {
            try {
              const response = await fetch("/api/recipes/update", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  id: recipe.id,
                  tenantId: recipe.tenant_id,
                  payload: value
                })
              });
              if (!response.ok) {
                throw new Error(await response.text());
              }
              setToast({ message: "Recipe saved", variant: "success" });
            } catch (error) {
              setToast({ message: (error as Error).message, variant: "error" });
            }
          });
        }}
      />
      {isPending && <p className="mt-2 text-xs text-muted-foreground">Saving recipe...</p>}
      <Toast message={toast?.message ?? null} variant={toast?.variant} />
    </>
  );
}
