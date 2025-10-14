'use client';

import { useState } from "react";
import { z } from "zod";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";

const recipeSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().nonnegative(),
  steps: z.array(
    z.object({
      type: z.string(),
      config: z.record(z.any())
    })
  )
});

type RecipeEditorProps = {
  initialValue: unknown;
  onChange: (value: unknown) => void;
  readOnly?: boolean;
};

export function RecipeEditor({ initialValue, onChange, readOnly = false }: RecipeEditorProps) {
  const [draft, setDraft] = useState(() => JSON.stringify(initialValue, null, 2));
  const [status, setStatus] = useState<"idle" | "valid" | "error">("idle");
  const [message, setMessage] = useState("");

  return (
    <div className="flex flex-col gap-3">
      <Textarea
        className="font-mono text-xs"
        rows={12}
        value={draft}
        readOnly={readOnly}
        onChange={(event) => {
          setDraft(event.target.value);
          setStatus("idle");
        }}
      />
      <div className="flex items-center justify-between">
        <div>
          {status === "valid" && <Badge variant="secondary">Recipe valid</Badge>}
          {status === "error" && (
            <Badge variant="destructive" className="text-xs">
              {message}
            </Badge>
          )}
        </div>
        {!readOnly && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setDraft(JSON.stringify(initialValue, null, 2));
                setStatus("idle");
              }}
            >
              Reset
            </Button>
            <Button
              onClick={() => {
                try {
                  const parsed = JSON.parse(draft);
                  recipeSchema.parse(parsed);
                  onChange(parsed);
                  setStatus("valid");
                  setMessage("Recipe saved");
                } catch (error) {
                  setStatus("error");
                  setMessage((error as Error).message);
                }
              }}
            >
              Validate & Save
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
