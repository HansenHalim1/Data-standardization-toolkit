'use client';

import type { DiffEntry } from "@/lib/recipe-engine";

type DiffViewerProps = {
  diff: DiffEntry[];
};

export function DiffViewer({ diff }: DiffViewerProps) {
  if (diff.length === 0) {
    return <p className="text-sm text-muted-foreground">No transformations detected.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {diff.map((entry, index) => (
        <div key={`${entry.rowIndex}-${entry.field}-${index}`} className="rounded-md border p-3 text-sm">
          <div className="font-medium">
            Row {entry.rowIndex + 1}: {entry.field}
          </div>
          <div className="mt-1 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <div>
              <span className="font-semibold">Before:</span> {formatValue(entry.before)}
            </div>
            <div>
              <span className="font-semibold">After:</span> {formatValue(entry.after)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function formatValue(value: unknown) {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
