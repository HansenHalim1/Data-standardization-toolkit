import type { RecipeRow } from "../index";
import type { WriteBackStep } from "../index";

export async function writeBackRows(
  rows: RecipeRow[],
  config: WriteBackStep["config"],
  handler?: (rows: RecipeRow[], config: WriteBackStep["config"]) => Promise<void>
): Promise<void> {
  if (config.strategy === "monday_upsert") {
    if (!handler) {
      throw new Error("Write-back handler is required for monday_upsert strategy");
    }
    await handler(rows, config);
    return;
  }

  if (config.strategy === "csv") {
    // CSV exports are handled via dedicated API endpoints.
    return;
  }

  throw new Error(`Unsupported write-back strategy: ${config.strategy}`);
}
