import type { RecipeDefinition, MapColumnsStep, WriteBackStep } from "./recipe-engine";
import type { MondayBoardData } from "./mondayApi";

export function prepareRecipeForBoard(recipe: RecipeDefinition, board: MondayBoardData): RecipeDefinition {
  const cloned = JSON.parse(JSON.stringify(recipe)) as RecipeDefinition;
  const mapStep = cloned.steps.find((step): step is MapColumnsStep => step.type === "map_columns");
  const writeStep = cloned.steps.find((step): step is WriteBackStep => step.type === "write_back");
  if (!writeStep) {
    return cloned;
  }

  const columnsByTitle = new Map(
    board.columns.map((column) => [column.title.trim().toLowerCase(), column.id])
  );

  const columnMapping: Record<string, string> = {};
  if (mapStep) {
    for (const [source, target] of Object.entries(mapStep.config.mapping)) {
      const columnId = columnsByTitle.get(source.trim().toLowerCase());
      if (columnId) {
        columnMapping[target] = columnId;
      }
    }
  }

  writeStep.config.boardId = board.boardId;
  if (Object.keys(columnMapping).length > 0) {
    writeStep.config.columnMapping = columnMapping;
  }

  if (writeStep.config.keyColumn) {
    const keyColumnId = columnMapping[writeStep.config.keyColumn];
    if (keyColumnId) {
      writeStep.config.keyColumnId = keyColumnId;
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
