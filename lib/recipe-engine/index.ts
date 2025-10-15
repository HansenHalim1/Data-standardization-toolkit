import { mapColumns } from "./steps/map_columns";
import { formatRows } from "./steps/format";
import { validateRows } from "./steps/validate";
import { dedupeRows } from "./steps/dedupe";
import { writeBackRows } from "./steps/write_back";

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
        | { kind: "number_parse"; locale?: string };
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

export type DedupeStep = {
  type: "dedupe";
  config: {
    keys: string[];
    fuzzy?: {
      enabled: boolean;
      threshold: number;
    };
  };
};

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

export type RecipeStep = MapColumnsStep | FormatStep | ValidateStep | DedupeStep | WriteBackStep;

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
  let currentRows = [...rows];
  const errors: RecipeError[] = [];
  const diff: DiffEntry[] = [];

  for (const step of recipe.steps) {
    switch (step.type) {
      case "map_columns":
        currentRows = mapColumns(currentRows, step.config);
        break;
      case "format": {
        const { rows: formatted, diff: stepDiff } = formatRows(currentRows, step.config);
        currentRows = formatted;
        diff.push(...stepDiff);
        break;
      }
      case "validate": {
        const validation = validateRows(currentRows, step.config);
        errors.push(...validation.errors);
        break;
      }
      case "dedupe": {
        const deduped = dedupeRows(currentRows, step.config, options.allowFuzzy);
        currentRows = deduped.rows;
        errors.push(...deduped.errors);
        diff.push(...deduped.diff);
        break;
      }
      case "write_back":
        // Skip real write-back in preview mode.
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
  let currentRows = [...rows];
  const errors: RecipeError[] = [];

  for (const step of recipe.steps) {
    switch (step.type) {
      case "map_columns":
        currentRows = mapColumns(currentRows, step.config);
        break;
      case "format": {
        const { rows: formatted } = formatRows(currentRows, step.config);
        currentRows = formatted;
        break;
      }
      case "validate": {
        const validation = validateRows(currentRows, step.config);
        errors.push(...validation.errors);
        break;
      }
      case "dedupe": {
        const deduped = dedupeRows(currentRows, step.config, options.allowFuzzy);
        currentRows = deduped.rows;
        errors.push(...deduped.errors);
        break;
      }
      case "write_back":
        await writeBackRows(currentRows, step.config, options.writeBack);
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
