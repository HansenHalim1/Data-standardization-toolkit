'use client';

import type { DiffEntry, RecipeError, RecipeRow } from "@/lib/recipe-engine";
import { Badge } from "./ui/badge";

type DataGridPreviewProps = {
  rows: RecipeRow[];
  diff?: DiffEntry[];
  errors?: RecipeError[];
  limit?: number;
};

export function DataGridPreview({
  rows,
  diff = [],
  errors = [],
  limit = 50
}: DataGridPreviewProps) {
  const limitedRows = rows.slice(0, limit);
  const headers = Array.from(
    limitedRows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set<string>())
  );

  const errorMap = new Map<string, RecipeError[]>();
  errors.forEach((error) => {
    const key = `${error.rowIndex}:${error.field ?? "*"}`;
    const existing = errorMap.get(key) ?? [];
    existing.push(error);
    errorMap.set(key, existing);
  });

  const diffMap = new Map<string, DiffEntry>();
  diff.forEach((entry) => {
    diffMap.set(`${entry.rowIndex}:${entry.field}`, entry);
  });

  return (
    <div className="w-full overflow-auto rounded-lg border">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <thead className="bg-muted">
          <tr>
            <th className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">#</th>
            {headers.map((header) => (
              <th key={header} className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {limitedRows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t">
              <td className="px-3 py-2 text-xs text-muted-foreground">{rowIndex + 1}</td>
              {headers.map((header) => {
                const cellKey = `${rowIndex}:${header}`;
                const cellErrors = errorMap.get(cellKey) ?? errorMap.get(`${rowIndex}:*`) ?? [];
                const cellDiff = diffMap.get(cellKey);
                const hasError = cellErrors.length > 0;
                const hasDiff = Boolean(cellDiff);
                return (
                  <td
                    key={header}
                    className={`px-3 py-2 ${hasError ? "bg-destructive/10 text-destructive" : ""} ${hasDiff ? "bg-secondary/40" : ""}`}
                  >
                    <div className="flex flex-col gap-1">
                      <span className="break-words text-xs">{String(row[header] ?? "")}</span>
                      {hasDiff && (
                        <span className="text-[10px] text-muted-foreground">
                          → {String(cellDiff?.after ?? "")}
                        </span>
                      )}
                      {cellErrors.map((error, index) => (
                        <Badge key={index} variant="destructive" className="w-max">
                          {error.code}
                        </Badge>
                      ))}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
