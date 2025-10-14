import type { RecipeRow } from "../index";

type MapColumnsConfig = {
  mapping: Record<string, string>;
  dropUnknown?: boolean;
};

export function mapColumns(rows: RecipeRow[], config: MapColumnsConfig): RecipeRow[] {
  const { mapping, dropUnknown = false } = config;
  return rows.map((row) => {
    const mapped: RecipeRow = {};
    for (const [key, value] of Object.entries(row)) {
      const target = mapping[key] ?? (dropUnknown ? null : key);
      if (!target) {
        continue;
      }
      mapped[target] = value;
    }
    for (const [source, target] of Object.entries(mapping)) {
      if (!(source in row)) {
        mapped[target] ??= null;
      }
    }
    return mapped;
  });
}
