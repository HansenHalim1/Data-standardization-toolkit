import type { RecipeDefinition, MapColumnsStep, WriteBackStep } from "./recipe-engine";
import type { MondayBoardData } from "./mondayApi";

export function prepareRecipeForBoard(recipe: RecipeDefinition, board: MondayBoardData): RecipeDefinition {
  const cloned = JSON.parse(JSON.stringify(recipe)) as RecipeDefinition;
  const mapStep = cloned.steps.find((step): step is MapColumnsStep => step.type === "map_columns");
  const writeStep = cloned.steps.find((step): step is WriteBackStep => step.type === "write_back");
  if (!writeStep) {
    return cloned;
  }

  const normalize = (value: string | null | undefined) =>
    value ? value.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, "") : "";

  const columnsByTitle = new Map(
    board.columns.map((column) => [normalize(column.title), column.id])
  );

  const columnMapping: Record<string, string> = {};
  if (mapStep) {
    for (const [source, target] of Object.entries(mapStep.config.mapping)) {
      const normalizedSource = normalize(source);
      let columnId = columnsByTitle.get(normalizedSource);
      if (!columnId) {
        const normalizedTarget = normalize(target.replace(/_/g, " "));
        columnId = columnsByTitle.get(normalizedTarget);
      }
      if (columnId) {
        columnMapping[target] = columnId;
      }
    }
  }

  writeStep.config.boardId = board.boardId;
  if (Object.keys(columnMapping).length > 0) {
    writeStep.config.columnMapping = columnMapping;
  } else {
    delete writeStep.config.columnMapping;
  }

  if (writeStep.config.keyColumn) {
    const keyColumnId = columnMapping[writeStep.config.keyColumn];
    if (keyColumnId) {
      writeStep.config.keyColumnId = keyColumnId;
    } else {
      delete writeStep.config.keyColumnId;
    }
  }

  if (!writeStep.config.itemNameField) {
    if (mapStep) {
      const nameEntry = Object.entries(mapStep.config.mapping).find(([, target]) =>
        ["name", "item_name", "title"].includes(target)
      );
      if (nameEntry) {
        writeStep.config.itemNameField = nameEntry[1];
      }
    }

    if (!writeStep.config.itemNameField && writeStep.config.keyColumn) {
      writeStep.config.itemNameField = writeStep.config.keyColumn;
    }
  }

  return cloned;
}
