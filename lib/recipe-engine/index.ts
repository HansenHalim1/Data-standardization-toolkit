import { mapColumns } from "./steps/map_columns";
import { formatRows } from "./steps/format";
import { validateRows } from "./steps/validate";
import { writeBackRows } from "./steps/write_back";
import { createLogger } from "@/lib/logging";

export type RecipeRow = Record<string, unknown>;

export type RecipeError = {
  rowIndex: number;
  field?: string;
  code: string;
  message: string;
};

export type DiffEntry = {
  rowIndex: number;
  field: string;
  before: unknown;
  after: unknown;
};

export type MapColumnsStep = {
  type: "map_columns";
  config: {
    mapping: Record<string, string>;
    dropUnknown?: boolean;
  };
};

export type FormatStep = {
  type: "format";
  config: {
    operations: Array<{
      field: string;
      op:
        | { kind: "title_case" }
        | { kind: "email_normalize" }
        | { kind: "phone_e164"; defaultCountry?: string }
        | { kind: "date_parse"; inputFormat?: string; outputFormat?: string }
        | { kind: "iso_country" }
        | { kind: "iso_state"; countryField?: string }
        | { kind: "currency_code" }
        | { kind: "number_parse"; locale?: string }
        | { kind: "trim_collapse_whitespace" }
        | { kind: "boolean_standardize" }
        | { kind: "timezone_to_utc" }
        | { kind: "slugify"; separator?: string }
        | { kind: "round_numeric"; precision?: number }
  | { kind: "round_to_currency" }
        | { kind: "normalize_percentage" }
        | { kind: "remove_special_characters" }
        | {
            kind: "split_name";
            firstNameField?: string;
            lastNameField?: string;
          }
        | { kind: "normalize_address" }
        | { kind: "sanitize_html" };
    }>;
  };
};

export type ValidateStep = {
  type: "validate";
  config: {
    rules: Array<
      | {
          kind: "required";
          field: string;
        }
      | {
          kind: "regex";
          field: string;
          pattern: string;
          message?: string;
        }
      | {
          kind: "in_set";
          field: string;
          values: string[];
        }
      | {
          kind: "unique";
          composite: string[];
        }
    >;
  };
};

// dedupe step removed

export type WriteBackStep = {
  type: "write_back";
  config: {
    strategy: "monday_upsert" | "csv";
    boardId?: string;
    keyColumn?: string;
    keyColumnId?: string;
    columnMapping?: Record<string, string>;
    itemNameField?: string;
  };
};

export type RecipeStep = MapColumnsStep | FormatStep | ValidateStep | WriteBackStep;

export type RecipeDefinition = {
  id: string;
  name: string;
  version: number;
  steps: RecipeStep[];
};

export type RecipePreviewResult = {
  rows: RecipeRow[];
  errors: RecipeError[];
  diff: DiffEntry[];
};

export type RecipeExecuteResult = {
  rowsProcessed: number;
  rowsWritten: number;
  errors: RecipeError[];
};

export type EngineOptions = {
  allowFuzzy: boolean;
  writeBack?: (rows: RecipeRow[], config: WriteBackStep["config"]) => Promise<void>;
};

export function previewRecipe(
  recipe: RecipeDefinition,
  rows: RecipeRow[],
  options: EngineOptions
): RecipePreviewResult {
  const logger = createLogger({ component: "recipe-engine" });
  let currentRows = [...rows];
  const errors: RecipeError[] = [];
  const diff: DiffEntry[] = [];

  for (const step of recipe.steps) {
    logger.debug("preview step start", { step: step.type, rowsBefore: currentRows.length });
    switch (step.type) {
      case "map_columns":
        currentRows = mapColumns(currentRows, step.config);
        logger.debug("preview step done", { step: step.type, rowsAfter: currentRows.length });
        break;
      case "format": {
        const { rows: formatted, diff: stepDiff } = formatRows(currentRows, step.config);
        currentRows = formatted;
        diff.push(...stepDiff);
        logger.debug("preview step done", { step: step.type, rowsAfter: currentRows.length });
        break;
      }
      case "validate": {
        const validation = validateRows(currentRows, step.config);
        errors.push(...validation.errors);
        break;
      }
      
      case "write_back":
        // Skip real write-back in preview mode.
        logger.debug("preview step skip write_back", { rows: currentRows.length });
        break;
      default:
        throw new Error(`Unsupported recipe step: ${(step as { type: string }).type}`);
    }
  }

  return {
    rows: currentRows,
    errors,
    diff
  };
}

export async function executeRecipe(
  recipe: RecipeDefinition,
  rows: RecipeRow[],
  options: EngineOptions
): Promise<RecipeExecuteResult> {
  const logger = createLogger({ component: "recipe-engine" });
  let currentRows = [...rows];
  const errors: RecipeError[] = [];

  for (const step of recipe.steps) {
    logger.debug("execute step start", { step: step.type, rowsBefore: currentRows.length });
    switch (step.type) {
      case "map_columns":
        currentRows = mapColumns(currentRows, step.config);
        logger.debug("execute step done", { step: step.type, rowsAfter: currentRows.length });
        break;
      case "format": {
        const { rows: formatted } = formatRows(currentRows, step.config);
        currentRows = formatted;
        logger.debug("execute step done", { step: step.type, rowsAfter: currentRows.length });
        break;
      }
      case "validate": {
        const validation = validateRows(currentRows, step.config);
        errors.push(...validation.errors);
        break;
      }
      
      case "write_back":
        logger.info("about to write_back", { rows: currentRows.length, stepConfig: step.config });
        await writeBackRows(currentRows, step.config, options.writeBack);
        logger.info("write_back completed", { rowsAfterWrite: currentRows.length });
        break;
      default:
        throw new Error(`Unsupported recipe step: ${(step as { type: string }).type}`);
    }
  }

  return {
    rowsProcessed: rows.length,
    rowsWritten: currentRows.length,
    errors
  };
}
