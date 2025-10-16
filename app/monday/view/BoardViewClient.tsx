'use client';

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mondaySdk from "monday-sdk-js";
import type {
  FormatStep,
  MapColumnsStep,
  RecipeDefinition,
  RecipePreviewResult,
  WriteBackStep
} from "@/lib/recipe-engine";
import type { PlanFlags } from "@/lib/entitlements";
import { UploadDropzone } from "@/components/UploadDropzone";
import { DataGridPreview } from "@/components/DataGridPreview";
import { DiffViewer } from "@/components/DiffViewer";
import { PlanGate } from "@/components/PlanGate";
import { UsageBadge } from "@/components/UsageBadge";
import { Toast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

type MondayContext = {
  tenantId: string;
  plan: string;
  seats: number;
  flags: PlanFlags;
  usage: {
    rowsProcessed: number;
  };
};

const DEFAULT_BOARD_KIND = "share";

const BLANK_RECIPE: RecipeDefinition = {
  id: "custom",
  name: "Custom Recipe",
  version: 1,
  steps: [
    {
      type: "map_columns",
      config: {
        mapping: {},
        dropUnknown: false
      }
    },
    {
      type: "write_back",
      config: {
        strategy: "monday_upsert"
      }
    }
  ]
};


type FormatOperation = FormatStep["config"]["operations"][number];
type OperationConfig = FormatOperation["op"];

type StandardizationRule = {
  id: string;
  label: string;
  description: string;
  build: (field: string) => FormatOperation;
  matches: (field: string, op: OperationConfig) => boolean;
};

type StandardizationTarget = {
  field: string;
  label: string;
};

function normalizeKey(value: string | null | undefined): string {
  return value ? value.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

function deriveSplitNameFields(field: string): { first: string; last: string } {
  const defaults = { first: "first_name", last: "last_name" };
  if (!field) {
    return defaults;
  }
  const withoutName = field.replace(/name$/i, "").replace(/[_\s]+$/g, "");
  const withoutFull = withoutName.replace(/full$/i, "").replace(/[_\s]+$/g, "");
  const base = withoutFull.length > 0 ? withoutFull : withoutName;
  if (!base) {
    return defaults;
  }
  const sanitized = base.endsWith("_") ? base.slice(0, -1) : base;
  const normalizedBase = sanitized.toLowerCase() === "full" ? "" : sanitized;
  const prefix = normalizedBase ? `${normalizedBase}_` : "";
  return {
    first: `${prefix}first_name`,
    last: `${prefix}last_name`
  };
}

const STANDARDIZATION_RULES: StandardizationRule[] = [
  {
    id: "trim_collapse_whitespace",
    label: "Trim & collapse whitespace",
    description: "Removes leading/trailing spaces and collapses internal whitespace.",
    build: (field) => ({
      field,
      op: { kind: "trim_collapse_whitespace" }
    }),
    matches: (_field, op) => op.kind === "trim_collapse_whitespace"
  },
  {
    id: "standardize_boolean",
    label: "Standardize booleans",
    description: "Converts common yes/no values into true/false.",
    build: (field) => ({
      field,
      op: { kind: "boolean_standardize" }
    }),
    matches: (_field, op) => op.kind === "boolean_standardize"
  },
  {
    id: "timezone_to_utc",
    label: "Normalize timezone",
    description: "Converts datetimes to UTC ISO strings.",
    build: (field) => ({
      field,
      op: { kind: "timezone_to_utc" }
    }),
    matches: (_field, op) => op.kind === "timezone_to_utc"
  },
  {
    id: "slugify",
    label: "Slugify text",
    description: "Generates URL-safe slugs (lowercase with dashes).",
    build: (field) => ({
      field,
      op: { kind: "slugify", separator: "-" }
    }),
    matches: (_field, op) => op.kind === "slugify" && (op.separator ?? "-") === "-"
  },
  {
    id: "round_numeric",
    label: "Round to currency",
    description: "Rounds numbers to two decimal places.",
    build: (field) => ({
      field,
      op: { kind: "round_numeric", precision: 2 }
    }),
    matches: (_field, op) => op.kind === "round_numeric" && (op.precision ?? 2) === 2
  },
  {
    id: "normalize_percentage",
    label: "Normalize percentages",
    description: "Converts % values into decimal form (e.g., 45% → 0.45).",
    build: (field) => ({
      field,
      op: { kind: "normalize_percentage" }
    }),
    matches: (_field, op) => op.kind === "normalize_percentage"
  },
  {
    id: "remove_special_characters",
    label: "Remove special characters",
    description: "Strips zero-width and non-printable characters.",
    build: (field) => ({
      field,
      op: { kind: "remove_special_characters" }
    }),
    matches: (_field, op) => op.kind === "remove_special_characters"
  },
  {
    id: "split_full_name",
    label: "Split full name",
    description: "Splits a full name into first/last name fields.",
    build: (field) => {
      const { first, last } = deriveSplitNameFields(field);
      return {
        field,
        op: { kind: "split_name", firstNameField: first, lastNameField: last }
      };
    },
    matches: (field, op) => {
      if (op.kind !== "split_name") {
        return false;
      }
      const { first, last } = deriveSplitNameFields(field);
      const opFirst = op.firstNameField ?? first;
      const opLast = op.lastNameField ?? last;
      return opFirst === first && opLast === last;
    }
  },
  {
    id: "normalize_address",
    label: "Normalize address",
    description: "Title-cases address parts and uppercases state codes.",
    build: (field) => ({
      field,
      op: { kind: "normalize_address" }
    }),
    matches: (_field, op) => op.kind === "normalize_address"
  },
  {
    id: "sanitize_html",
    label: "Sanitize HTML",
    description: "Removes unsupported HTML/markdown tags.",
    build: (field) => ({
      field,
      op: { kind: "sanitize_html" }
    }),
    matches: (_field, op) => op.kind === "sanitize_html"
  },
  {
    id: "title_case",
    label: "Title case",
    description: "Capitalize names (e.g., \"john\" -> \"John\").",
    build: (field) => ({
      field,
      op: { kind: "title_case" }
    }),
    matches: (_field, op) => op.kind === "title_case"
  },
  {
    id: "email_normalize",
    label: "Normalize email",
    description: "Lowercase and trim email addresses.",
    build: (field) => ({
      field,
      op: { kind: "email_normalize" }
    }),
    matches: (_field, op) => op.kind === "email_normalize"
  },
  {
    id: "phone_e164",
    label: "Format phone",
    description: "Convert phone numbers to E.164 (US default).",
    build: (field) => ({
      field,
      op: { kind: "phone_e164", defaultCountry: "US" }
    }),
    matches: (_field, op) => op.kind === "phone_e164"
  },
  {
    id: "date_parse",
    label: "Date to ISO",
    description: "Normalize dates to YYYY-MM-DD.",
    build: (field) => ({
      field,
      op: { kind: "date_parse", outputFormat: "yyyy-MM-dd" }
    }),
    matches: (_field, op) => op.kind === "date_parse"
  },
  {
    id: "iso_country",
    label: "Country to ISO",
    description: "Map country names to ISO codes.",
    build: (field) => ({
      field,
      op: { kind: "iso_country" }
    }),
    matches: (_field, op) => op.kind === "iso_country"
  },
  {
    id: "currency_code",
    label: "Currency code",
    description: "Standardize currency strings (e.g., usd -> USD).",
    build: (field) => ({
      field,
      op: { kind: "currency_code" }
    }),
    matches: (_field, op) => op.kind === "currency_code"
  },
  {
    id: "number_parse",
    label: "Parse number",
    description: "Parse numbers using the en-US locale.",
    build: (field) => ({
      field,
      op: { kind: "number_parse", locale: "en-US" }
    }),
    matches: (_field, op) => op.kind === "number_parse"
  }
];

const STANDARDIZATION_RULES_MAP = new Map(STANDARDIZATION_RULES.map((rule) => [rule.id, rule]));
const STANDARDIZATION_RULE_INDEX = new Map(
  STANDARDIZATION_RULES.map((rule, index) => [rule.id, index])
);

function sortRuleIds(ids: Iterable<string>): string[] {
  const unique = Array.from(new Set(ids));
  return unique.sort((a, b) => {
    const indexA = STANDARDIZATION_RULE_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER;
    const indexB = STANDARDIZATION_RULE_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER;
    return indexA - indexB;
  });
}

function formatFieldLabel(field: string): string {
  const spaced = field
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!spaced) {
    return "Field";
  }
  return spaced
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getRecipeTargetFields(recipe: RecipeDefinition | null): string[] {
  if (!recipe) {
    return [];
  }
  const fields = new Set<string>();
  const mapStep = recipe.steps.find(
    (step): step is MapColumnsStep => step.type === "map_columns"
  );
  if (mapStep) {
    const mapping = mapStep.config.mapping ?? {};
    for (const target of Object.values(mapping)) {
      if (target) {
        fields.add(target);
      }
    }
  }
  const writeStep = recipe.steps.find(
    (step): step is WriteBackStep => step.type === "write_back"
  );
  if (writeStep) {
    if (writeStep.config.columnMapping) {
      for (const target of Object.keys(writeStep.config.columnMapping)) {
        if (target) {
          fields.add(target);
        }
      }
    }
    if (writeStep.config.keyColumn) {
      fields.add(writeStep.config.keyColumn);
    }
    if (writeStep.config.itemNameField) {
      fields.add(writeStep.config.itemNameField);
    }
  }
  return Array.from(fields);
}

function deriveStandardizationSelectionsFromRecipe(
  recipe: RecipeDefinition | null
): Record<string, string[]> {
  if (!recipe) {
    return {};
  }
  const formatStep = recipe.steps.find(
    (step): step is FormatStep => step.type === "format"
  );
  if (!formatStep) {
    return {};
  }
  const selections: Record<string, string[]> = {};
  for (const operation of formatStep.config.operations ?? []) {
    const rule = STANDARDIZATION_RULES.find((candidate) =>
      candidate.matches(operation.field, operation.op)
    );
    if (!rule) {
      continue;
    }
    const existing = selections[operation.field] ?? [];
    selections[operation.field] = [...existing, rule.id];
  }
  for (const field of Object.keys(selections)) {
    selections[field] = sortRuleIds(selections[field]);
  }
  return selections;
}

function selectionMapsEqual(
  a: Record<string, string[]>,
  b: Record<string, string[]>
): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (let i = 0; i < keysA.length; i += 1) {
    if (keysA[i] !== keysB[i]) {
      return false;
    }
    const arrA = a[keysA[i]];
    const arrB = b[keysA[i]];
    if (arrA.length !== arrB.length) {
      return false;
    }
    for (let j = 0; j < arrA.length; j += 1) {
      if (arrA[j] !== arrB[j]) {
        return false;
      }
    }
  }
  return true;
}

function computeStandardizationTargets({
  recipe,
  boardColumns,
  fileColumns,
  dataSource
}: {
  recipe: RecipeDefinition | null;
  boardColumns: Record<string, string>;
  fileColumns: string[];
  dataSource: DataSource;
}): StandardizationTarget[] {
  const targets: StandardizationTarget[] = [];
  const seen = new Set<string>();

  const addTarget = (field: string, label: string) => {
    if (!field || seen.has(field)) {
      return;
    }
    targets.push({ field, label });
    seen.add(field);
  };

  const mapStep = recipe?.steps.find(
    (step): step is MapColumnsStep => step.type === "map_columns"
  );

  if (dataSource === "board") {
    if (recipe) {
      const writeStep = recipe.steps.find(
        (step): step is WriteBackStep => step.type === "write_back"
      );
      const columnMapping = writeStep?.config?.columnMapping ?? {};
      for (const [field, columnId] of Object.entries(columnMapping)) {
        if (!field) {
          continue;
        }
        const friendlyField = formatFieldLabel(field);
        const columnName =
          (columnId ? boardColumns[columnId] : undefined) ?? friendlyField;
        const label =
          columnName && columnName !== friendlyField
            ? `${columnName} (${friendlyField})`
            : columnName ?? friendlyField;
        addTarget(field, label);
      }
    }

    for (const columnName of Object.values(boardColumns)) {
      if (!columnName) {
        continue;
      }
      const trimmedName = columnName.trim();
      if (!trimmedName) {
        continue;
      }
      let mappedField = trimmedName;
      if (mapStep?.config?.mapping) {
        const direct = mapStep.config.mapping[columnName] ?? mapStep.config.mapping[trimmedName];
        if (direct && direct.trim().length > 0) {
          mappedField = direct.trim();
        }
      }
      const label = trimmedName.length > 0 ? trimmedName : formatFieldLabel(mappedField);
      addTarget(mappedField, label);
    }
  }

  if (dataSource === "file" && fileColumns.length > 0) {
    for (const column of fileColumns) {
      addTarget(column, column);
    }
  }

  const fallbackFields = getRecipeTargetFields(recipe);
  for (const field of fallbackFields) {
    addTarget(field, formatFieldLabel(field));
  }

  return targets;
}

function autoMapBoardColumns(
  recipe: RecipeDefinition,
  boardColumns: Record<string, string>
): { recipe: RecipeDefinition; missingFields: string[] } {
  const writeStep = recipe.steps.find(
    (step): step is WriteBackStep => step.type === "write_back"
  );
  if (!writeStep) {
    return { recipe, missingFields: [] };
  }

  const existingMapping = { ...(writeStep.config.columnMapping ?? {}) };
  const existingTargets = new Set(Object.keys(existingMapping));
  const normalizedColumns = new Map<string, string>();
  const missingFields: string[] = [];

  for (const [columnId, title] of Object.entries(boardColumns)) {
    if (!columnId) {
      continue;
    }
    const normalizedTitle = normalizeKey(title);
    if (normalizedTitle) {
      normalizedColumns.set(normalizedTitle, columnId);
    }
    const normalizedLabel = normalizeKey(formatFieldLabel(title ?? columnId));
    if (normalizedLabel) {
      normalizedColumns.set(normalizedLabel, columnId);
    }
    normalizedColumns.set(normalizeKey(columnId), columnId);
  }

  if (normalizedColumns.size === 0) {
    return { recipe, missingFields: [] };
  }

  const mapStep = recipe.steps.find(
    (step): step is MapColumnsStep => step.type === "map_columns"
  );
  const candidates = new Set(getRecipeTargetFields(recipe));
  if (mapStep?.config?.mapping) {
    for (const target of Object.values(mapStep.config.mapping)) {
      if (target) {
        candidates.add(target);
      }
    }
  }

  const nextMapping = { ...existingMapping };
  for (const field of candidates) {
    if (!field || existingTargets.has(field)) {
      continue;
    }
    const normalizedField = normalizeKey(field);
    const normalizedLabel = normalizeKey(formatFieldLabel(field));
    const normalizedSpaced = normalizeKey(field.replace(/[_]+/g, " "));

    const match =
      normalizedColumns.get(normalizedField) ??
      normalizedColumns.get(normalizedLabel) ??
      normalizedColumns.get(normalizedSpaced);

    if (match) {
      nextMapping[field] = match;
      existingTargets.add(field);
    } else {
      missingFields.push(field);
    }
  }

  if (Object.keys(nextMapping).length > Object.keys(existingMapping).length) {
    writeStep.config.columnMapping = nextMapping;
  }

  if (writeStep.config.keyColumn && !writeStep.config.keyColumnId && writeStep.config.columnMapping) {
    const keyId = writeStep.config.columnMapping[writeStep.config.keyColumn];
    if (keyId) {
      writeStep.config.keyColumnId = keyId;
    }
  }

  return { recipe, missingFields: Array.from(new Set(missingFields)) };
}

async function extractColumnsFromFile(file: File): Promise<string[] | null> {
  const lowerName = file.name.toLowerCase();
  const isCsv = lowerName.endsWith(".csv");
  const isText = file.type.startsWith("text/") || isCsv;
  if (!isText) {
    return null;
  }
  try {
    const text = await file.text();
    const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!firstLine) {
      return null;
    }
    const columns = firstLine
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (columns.length === 0) {
      return null;
    }
    return Array.from(new Set(columns));
  } catch {
    return null;
  }
}

type DataSource = "file" | "board";

type MondayBoardOption = {
  id: string;
  name: string;
  workspaceName?: string | null;
  kind?: string | null;
};

type PreviewResponse = RecipePreviewResult & {
  runId?: string;
  preparedRecipe?: RecipeDefinition;
  sourceBoard?: {
    boardId: string;
    boardName: string;
  };
  columns?: Array<{ id: string | null; title: string }>;
};

export default function BoardViewClient() {
  const [context, setContext] = useState<MondayContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [preparedRecipe, setPreparedRecipe] = useState<RecipeDefinition | null>(null);
  const [toast, setToast] = useState<{ message: string; variant?: "default" | "success" | "error" } | null>(
    null
  );
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [dataSource, setDataSource] = useState<DataSource>("file");
  const [boards, setBoards] = useState<MondayBoardOption[]>([]);
  const [isLoadingBoards, setLoadingBoards] = useState(false);
  const [boardsError, setBoardsError] = useState<string | null>(null);
  const [selectedBoardId, setSelectedBoardId] = useState<string>("");
  const [sourceBoard, setSourceBoard] = useState<PreviewResponse["sourceBoard"] | null>(null);
  const [writeBoardId, setWriteBoardId] = useState<string>("");
  const [writeBoardName, setWriteBoardName] = useState<string>("");
  const [writeBoardError, setWriteBoardError] = useState<string | null>(null);
  const [isPreparingWriteBoard, setPreparingWriteBoard] = useState(false);
  const [newBoardName, setNewBoardName] = useState<string>("");
  const [isCreatingBoard, setIsCreatingBoard] = useState(false);
  const [isSeedingBoard, setIsSeedingBoard] = useState(false);
  const [standardizationSelections, setStandardizationSelections] = useState<Record<string, string[]>>({});
  const [boardColumnNames, setBoardColumnNames] = useState<Record<string, string>>({});
  const [fileColumns, setFileColumns] = useState<string[]>([]);
  const [unmappedBoardFields, setUnmappedBoardFields] = useState<string[]>([]);
  const unmappedFieldsRef = useRef<string[]>([]);

  const mondayClient = useMemo(() => {
    if (typeof window === "undefined") {
      return null;
    }
    return mondaySdk();
  }, []);

  const selectedRecipe = BLANK_RECIPE;

  const standardizationTargets = useMemo(
    () =>
      computeStandardizationTargets({
        recipe: preparedRecipe ?? BLANK_RECIPE,
        boardColumns: boardColumnNames,
        fileColumns,
        dataSource
      }),
    [preparedRecipe, selectedRecipe, boardColumnNames, fileColumns, dataSource]
  );

  useEffect(() => {
    unmappedFieldsRef.current = unmappedBoardFields;
  }, [unmappedBoardFields]);

  useEffect(() => {
    setStandardizationSelections((prev) => {
      const validFields = new Set(standardizationTargets.map((target) => target.field));
      let changed = false;
      const next: Record<string, string[]> = {};
      for (const [field, rules] of Object.entries(prev)) {
        if (!validFields.has(field)) {
          changed = true;
          continue;
        }
        const filtered = rules.filter((ruleId) => STANDARDIZATION_RULES_MAP.has(ruleId));
        if (filtered.length !== rules.length) {
          changed = true;
        }
        if (filtered.length > 0) {
          next[field] = filtered;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [standardizationTargets]);

  const buildRecipeWithStandardization = useCallback(
    (baseRecipe: RecipeDefinition | null) => {
      const source = baseRecipe ?? selectedRecipe;
      if (!source) {
        throw new Error("No recipe available for standardization.");
      }
      const cloned = JSON.parse(JSON.stringify(source)) as RecipeDefinition;
      let formatIndex = cloned.steps.findIndex((step) => step.type === "format");
      let formatStep: FormatStep;
      if (formatIndex === -1) {
        formatStep = {
          type: "format",
          config: {
            operations: []
          }
        };
        const mapIndex = cloned.steps.findIndex((step) => step.type === "map_columns");
        if (mapIndex === -1) {
          cloned.steps.push(formatStep);
        } else {
          cloned.steps.splice(mapIndex + 1, 0, formatStep);
        }
      } else {
        formatStep = cloned.steps[formatIndex] as FormatStep;
      }

      const existingOperations = [...(formatStep.config.operations ?? [])];
      const preservedOperations = existingOperations.filter(
        (operation) =>
          !STANDARDIZATION_RULES.some((rule) => rule.matches(operation.field, operation.op))
      );

      const newOperations: FormatOperation[] = [];
      for (const target of standardizationTargets) {
        const field = target.field;
        const selectedRuleIds = standardizationSelections[field];
        if (!selectedRuleIds || selectedRuleIds.length === 0) {
          continue;
        }
        for (const ruleId of selectedRuleIds) {
          const rule = STANDARDIZATION_RULES_MAP.get(ruleId);
          if (rule) {
            newOperations.push(rule.build(field));
          }
        }
      }

      formatStep.config.operations = [...preservedOperations, ...newOperations];

      if (dataSource !== "board" || Object.keys(boardColumnNames).length === 0) {
        setUnmappedBoardFields([]);
        return cloned;
      }
      const { recipe: mappedRecipe, missingFields } = autoMapBoardColumns(cloned, boardColumnNames);
      setUnmappedBoardFields(missingFields);
      return mappedRecipe;
    },
    [selectedRecipe, standardizationSelections, standardizationTargets, boardColumnNames, dataSource]
  );

  const toggleStandardization = useCallback(
    (field: string, ruleId: string) => {
      const validFields = new Set(standardizationTargets.map((target) => target.field));
      if (!validFields.has(field) || !STANDARDIZATION_RULES_MAP.has(ruleId)) {
        return;
      }
      setStandardizationSelections((prev) => {
        const current = new Set(prev[field] ?? []);
        const hadRule = current.has(ruleId);
        if (hadRule) {
          current.delete(ruleId);
        } else {
          current.add(ruleId);
        }

        const nextValue = current.size === 0 ? [] : sortRuleIds(current);
        const next = { ...prev };
        if (nextValue.length === 0) {
          if (!hadRule) {
            return prev;
          }
          delete next[field];
        } else {
          next[field] = nextValue;
        }

        if (selectionMapsEqual(prev, next)) {
          return prev;
        }
        return next;
      });
    },
    [standardizationTargets]
  );

  const applyPreparedRecipe = useCallback(
    (recipe: RecipeDefinition | null, boardColumnsOverride?: Record<string, string>) => {
      let nextRecipe: RecipeDefinition | null = null;
      let missingFields: string[] = [];
      const effectiveBoardColumns =
        dataSource === "board"
          ? boardColumnsOverride ?? boardColumnNames
          : {};

      if (boardColumnsOverride) {
        setBoardColumnNames(boardColumnsOverride);
      }

      if (recipe) {
        const cloned = JSON.parse(JSON.stringify(recipe)) as RecipeDefinition;
        if (dataSource === "board" && Object.keys(effectiveBoardColumns).length > 0) {
          const result = autoMapBoardColumns(cloned, effectiveBoardColumns);
          nextRecipe = result.recipe;
          missingFields = result.missingFields;
        } else {
          nextRecipe = cloned;
        }
      }
      setPreparedRecipe(nextRecipe);
      setUnmappedBoardFields(missingFields);
      const baseRecipe = nextRecipe ?? selectedRecipe;
      if (baseRecipe) {
        const derivedSelections = deriveStandardizationSelectionsFromRecipe(baseRecipe);
        const fields = new Set(getRecipeTargetFields(baseRecipe));
        const mapStep = baseRecipe.steps.find(
          (step): step is MapColumnsStep => step.type === "map_columns"
        );
        if (dataSource === "board") {
          for (const columnName of Object.values(boardColumnNames)) {
            if (!columnName) {
              continue;
            }
            const trimmed = columnName.trim();
            if (!trimmed) {
              continue;
            }
            let fieldName = trimmed;
            if (mapStep?.config?.mapping) {
              const mapped = mapStep.config.mapping[columnName] ?? mapStep.config.mapping[trimmed];
              if (mapped && mapped.trim().length > 0) {
                fieldName = mapped.trim();
              }
            }
            fields.add(fieldName);
          }
        } else if (dataSource === "file") {
          for (const column of fileColumns) {
            if (column) {
              fields.add(column);
            }
          }
        }
        setStandardizationSelections((prev) => {
          const next: Record<string, string[]> = {};
          fields.forEach((field) => {
            if (!field) {
              return;
            }
            const derived = derivedSelections[field];
            const fallback = prev[field] ?? [];
            const chosen = derived && derived.length > 0 ? derived : fallback;
            if (chosen.length > 0) {
              next[field] = sortRuleIds(chosen);
            }
          });
          if (selectionMapsEqual(prev, next)) {
            return prev;
          }
          return next;
        });
      } else {
        setStandardizationSelections((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      }

      if (!nextRecipe) {
        setWriteBoardError(null);
        return;
      }
      setWriteBoardError(null);
    },
    [selectedRecipe, dataSource, boardColumnNames, fileColumns]
  );

  const getSessionToken = useCallback(async () => {
    if (!mondayClient) {
      throw new Error("Missing monday context token. Launch this app from a monday board.");
    }
    const result: { data?: string } = await mondayClient.get("sessionToken");
    const token = result?.data;
    if (!token) {
      throw new Error("Unable to retrieve monday session token.");
    }
    return token;
  }, [mondayClient]);

  const seedBoardWithPreview = useCallback(
    async (boardId: string, boardName: string, prepared: RecipeDefinition | null) => {
      if (!preview || preview.rows.length === 0 || !context) {
        return "skipped" as const;
      }

      const baseRecipe = prepared ?? preparedRecipe ?? BLANK_RECIPE;
      if (!baseRecipe) {
        return "skipped" as const;
      }

      const recipeForExecution = buildRecipeWithStandardization(baseRecipe);
      const writeStep = recipeForExecution.steps.find(
        (step): step is WriteBackStep => step.type === "write_back"
      );
      if (!writeStep) {
        return "skipped" as const;
      }

      writeStep.config.boardId = boardId;
      if (!writeStep.config.columnMapping || Object.keys(writeStep.config.columnMapping).length === 0) {
        return "skipped" as const;
      }

      try {
        setIsSeedingBoard(true);
        setToast({
          message: `Seeding ${preview.rows.length} rows into "${boardName}"...`,
          variant: "default"
        });
        const sessionToken = await getSessionToken();
        const response = await fetch("/api/recipes/run/execute", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`
          },
          body: JSON.stringify({
            tenantId: context.tenantId,
            recipe: recipeForExecution,
            runId: preview.runId,
            previewRows: preview.rows,
            plan: context.plan
          })
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const result = (await response.json()) as { rowsWritten: number };
        setToast({
          message: `Board "${boardName}" seeded with ${result.rowsWritten} rows.`,
          variant: "success"
        });
        return "seeded" as const;
      } catch (error) {
        setToast({
          message: `Board created but seeding failed: ${(error as Error).message}`,
          variant: "error"
        });
        return "failed" as const;
      } finally {
        setIsSeedingBoard(false);
      }
    },
    [buildRecipeWithStandardization, context, getSessionToken, preparedRecipe, preview, selectedRecipe]
  );

  const loadBoards = useCallback(async () => {
    const sessionToken = await getSessionToken();
    const response = await fetch("/api/monday/boards", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${sessionToken}`
      }
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const data = (await response.json()) as { boards?: MondayBoardOption[] };
    return data.boards ?? [];
  }, [getSessionToken]);

  const refreshBoards = useCallback(async () => {
    try {
      setLoadingBoards(true);
      setBoardsError(null);
      const boardsList = await loadBoards();
      setBoards(boardsList);
      if (writeBoardId) {
        const matching = boardsList.find((board) => board.id === writeBoardId);
        if (matching) {
          setWriteBoardName(matching.name);
        }
      }
    } catch (error) {
      setBoards([]);
      setBoardsError((error as Error).message ?? "Failed to load boards.");
    } finally {
      setLoadingBoards(false);
    }
  }, [loadBoards, writeBoardId]);

  const handleWriteBoardSelect = useCallback(
    async (
      boardId: string,
      options?: {
        prepared?: RecipeDefinition | null;
        boardName?: string;
        boardColumns?: Array<{ id: string; title: string }>;
      }
    ) => {
      setWriteBoardError(null);
      setWriteBoardId(boardId);
      setFileColumns([]);
      const board = boards.find((entry) => entry.id === boardId);
      const resolvedName = options?.boardName ?? board?.name ?? "";
      setWriteBoardName(resolvedName);

      if (!boardId) {
        setBoardColumnNames({});
        applyPreparedRecipe(options?.prepared ?? null);
        return;
      }

      if (options?.prepared) {
        if (options.boardColumns) {
          const mapped = options.boardColumns.reduce<Record<string, string>>((acc, column) => {
            if (column.id) {
              acc[column.id] = column.title ?? column.id;
            }
            return acc;
          }, {});
          setBoardColumnNames(mapped);
        }
        applyPreparedRecipe(options.prepared);
        return;
      }

      if (sourceBoard?.boardId === boardId && preparedRecipe) {
        applyPreparedRecipe(preparedRecipe);
        return;
      }

      try {
        setPreparingWriteBoard(true);
        
        const sessionToken = await getSessionToken();
        const response = await fetch(`/api/monday/boards/${boardId}/prepare`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`
          },
          body: JSON.stringify({
            recipe: buildRecipeWithStandardization(preparedRecipe ?? BLANK_RECIPE)
          })
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const data = (await response.json()) as {
          preparedRecipe: RecipeDefinition;
          board?: {
            boardId: string;
            boardName: string;
            columns?: Array<{ id: string; title: string }>;
          };
        };
        if (data.board?.columns) {
          const mapped = data.board.columns.reduce<Record<string, string>>((acc, column) => {
            if (column.id) {
              acc[column.id] = column.title ?? column.id;
            }
            return acc;
          }, {});
          setBoardColumnNames(mapped);
        }
        applyPreparedRecipe(data.preparedRecipe);
        setWriteBoardName(data.board?.boardName ?? resolvedName);
      } catch (error) {
        setWriteBoardError((error as Error).message ?? "Failed to prepare board for write-back.");
      } finally {
        setPreparingWriteBoard(false);
      }
    },
    [
      applyPreparedRecipe,
      boards,
      buildRecipeWithStandardization,
      getSessionToken,
      preparedRecipe,
      selectedRecipe,
      sourceBoard?.boardId
    ]
  );

  const ensureBoardColumns = useCallback(async () => {
    if (!writeBoardId) {
      setToast({ message: "Select a board to update columns.", variant: "error" });
      return;
    }
    setToast({ message: "Syncing missing columns with monday...", variant: "default" });
    await handleWriteBoardSelect(writeBoardId);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const remaining = unmappedFieldsRef.current;
    if (remaining.length === 0) {
      setToast({ message: "Board columns updated from monday.", variant: "success" });
    } else {
      setToast({
        message: `Still missing: ${remaining.map((field) => formatFieldLabel(field)).join(", ")}`,
        variant: "error"
      });
    }
  }, [handleWriteBoardSelect, writeBoardId]);

  const handleCreateBoard = useCallback(async () => {
    const trimmedName = newBoardName.trim();
    if (!trimmedName) {
      setWriteBoardError("Enter a name for the new board.");
      return;
    }

    try {
      setIsCreatingBoard(true);
      setBoardsError(null);
      setWriteBoardError(null);
      const sessionToken = await getSessionToken();
      const recipeForBoard = buildRecipeWithStandardization(preparedRecipe ?? BLANK_RECIPE);
      const response = await fetch("/api/monday/boards", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          name: trimmedName,
          boardKind: DEFAULT_BOARD_KIND,
          recipe: recipeForBoard
        })
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const result = (await response.json()) as {
        board: {
          boardId: string;
          boardName: string;
          workspaceName?: string | null;
          kind?: string | null;
          columns?: Array<{ id: string; title: string }>;
        };
        preparedRecipe: RecipeDefinition;
      };
      setBoards((current) => {
        const filtered = current.filter((entry) => entry.id !== result.board.boardId);
        const next = [
          ...filtered,
          {
            id: result.board.boardId,
            name: result.board.boardName,
            workspaceName: result.board.workspaceName ?? null,
            kind: result.board.kind ?? null
          }
        ];
        return next.sort((a, b) => a.name.localeCompare(b.name));
      });
      await handleWriteBoardSelect(result.board.boardId, {
        prepared: result.preparedRecipe,
        boardName: result.board.boardName,
        boardColumns: result.board.columns ?? []
      });
      setNewBoardName("");
      const seedResult = await seedBoardWithPreview(
        result.board.boardId,
        result.board.boardName,
        result.preparedRecipe
      );
      if (seedResult === "skipped") {
        setToast({
          message: `Created board "${result.board.boardName}".`,
          variant: "success"
        });
      }
    } catch (error) {
      setWriteBoardError((error as Error).message ?? "Failed to create board.");
    } finally {
      setIsCreatingBoard(false);
    }
  }, [
    getSessionToken,
    handleWriteBoardSelect,
    newBoardName,
    preparedRecipe,
    buildRecipeWithStandardization,
    seedBoardWithPreview,
    selectedRecipe
  ]);

  useEffect(() => {
    if (!context || !mondayClient) {
      return;
    }
    if (boards.length > 0 || isLoadingBoards) {
      return;
    }
    refreshBoards();
  }, [boards.length, context, isLoadingBoards, mondayClient, refreshBoards]);

  useEffect(() => {
    if (!mondayClient) {
      setContextError("Missing monday context token. Launch this app from a monday board.");
      setContext(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const sessionToken = await getSessionToken();
        if (cancelled) {
          return;
        }
        const response = await fetch("/api/monday/context/verify", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sessionToken}`
          }
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const result = (await response.json()) as MondayContext;
        if (!cancelled) {
          setContext(result);
          setContextError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setContextError((error as Error).message ?? "Failed to verify monday context token.");
          setContext(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mondayClient, getSessionToken]);

  useEffect(() => {
    if (dataSource !== "board") {
      setUnmappedBoardFields([]);
    }
  }, [dataSource]);

  useEffect(() => {
    if (!writeBoardId) {
      setUnmappedBoardFields([]);
    }
  }, [writeBoardId]);

  const canPreview =
    Boolean(context) &&
    !isPreviewing &&
    ((dataSource === "file" && Boolean(uploadedFile)) || (dataSource === "board" && Boolean(selectedBoardId)));

  useEffect(() => {
    if (dataSource !== "board" || !mondayClient) {
      return;
    }
    setFileColumns([]);
    let cancelled = false;
    (async () => {
      try {
        setLoadingBoards(true);
        setBoardsError(null);
        const boardsList = await loadBoards();
        if (!cancelled) {
          setBoards(boardsList);
        }
      } catch (error) {
        if (!cancelled) {
          setBoards([]);
          setBoardsError((error as Error).message ?? "Failed to load boards.");
        }
      } finally {
        if (!cancelled) {
          setLoadingBoards(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataSource, loadBoards, mondayClient]);

useEffect(() => {
  setPreview(null);
  setPreparedRecipe(null);
  setStandardizationSelections((prev) => (Object.keys(prev).length === 0 ? prev : {}));
  setSourceBoard(null);
  setBoardsError(null);
  setWriteBoardId("");
  setWriteBoardName("");
  setPreparingWriteBoard(false);
  setWriteBoardError(null);
  setNewBoardName("");
  if (dataSource === "file") {
    setSelectedBoardId("");
    setBoardColumnNames({});
  } else {
    setUploadedFile(null);
    setFileColumns([]);
  }
}, [dataSource]);

  useEffect(() => {
    if (!writeBoardId) {
      return;
    }
    const matching = boards.find((board) => board.id === writeBoardId);
    if (matching && matching.name !== writeBoardName) {
      setWriteBoardName(matching.name);
    }
  }, [boards, writeBoardId, writeBoardName]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Data Standardization Toolkit</h1>
        <p className="text-sm text-muted-foreground">
          Upload a CSV/XLSX or choose a monday board source to preview transformations before writing back.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {context && (
            <UsageBadge used={context.usage.rowsProcessed} cap={context.flags.rowCap} />
          )}
          <Button
            asChild
            variant="outline"
            size="sm"
          >
            <Link href="/settings/monday" target="_blank" rel="noopener noreferrer">
              Auth
            </Link>
          </Button>
        </div>
        {contextError && <p className="text-sm text-destructive">{contextError}</p>}
      </header>

      <section className="grid gap-4 md:grid-cols-[2fr,3fr]">
        <Card>
          <CardHeader>
            <CardTitle>1. Select data source</CardTitle>
            <CardDescription>Preview via upload or directly from a monday board.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="data-source">Source</Label>
              <Select
                id="data-source"
                value={dataSource}
                onChange={(event) => setDataSource(event.target.value as DataSource)}
              >
                <option value="file">Upload CSV/XLSX</option>
                <option value="board">monday.com board</option>
              </Select>
            </div>

            {dataSource === "file" ? (
              <>
                <UploadDropzone
                  onFile={(file) => {
                    setDataSource("file");
                    setUploadedFile(file);
                    setPreview(null);
                    applyPreparedRecipe(null);
                    setSourceBoard(null);
                    setWriteBoardId("");
                    setWriteBoardName("");
                    setPreparingWriteBoard(false);
                    setBoardColumnNames({});
                    setFileColumns([]);
                    void extractColumnsFromFile(file).then((columns) => {
                      setFileColumns(columns ?? []);
                    });
                    setToast({ message: `Loaded ${file.name}`, variant: "success" });
                  }}
                />
                {uploadedFile && (
                  <p className="text-xs text-muted-foreground truncate">Ready: {uploadedFile.name}</p>
                )}
              </>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="board-select">Board</Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Select
                      id="board-select"
                      value={selectedBoardId}
                      onChange={(event) => {
                        const value = event.target.value;
                        setSelectedBoardId(value);
                        void handleWriteBoardSelect(value);
                      }}
                      className="sm:flex-1"
                      disabled={isPreparingWriteBoard}
                    >
                      <option value="">Select a board</option>
                      {boards.map((board) => (
                        <option key={board.id} value={board.id}>
                          {board.name}
                          {board.workspaceName ? ` - ${board.workspaceName}` : ""}
                        </option>
                      ))}
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (!mondayClient) {
                          setBoardsError("Missing monday context. Open this app inside monday.");
                          return;
                        }
                        refreshBoards();
                      }}
                      disabled={isLoadingBoards}
                    >
                      {isLoadingBoards ? "Refreshing..." : "Refresh"}
                    </Button>
                  </div>
                  {isLoadingBoards && (
                    <p className="text-xs text-muted-foreground">Loading boards...</p>
                  )}
                  {boardsError && <p className="text-xs text-destructive">{boardsError}</p>}
                  {sourceBoard && (
                    <p className="text-xs text-muted-foreground">
                      Previewing data from <strong>{sourceBoard.boardName}</strong>
                    </p>
                  )}
                </div>
              </div>
            )}

            <Button
              disabled={!canPreview}
              onClick={() => {
                if (!context || isPreviewing) {
                  return;
                }
                if (dataSource === "board") {
                  if (!selectedBoardId) {
                    setToast({ message: "Select a board to preview.", variant: "error" });
                    return;
                  }
                  void (async () => {
                    setIsPreviewing(true);
                    try {
                      const sessionToken = await getSessionToken();
                      const response = await fetch("/api/recipes/run/preview", {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization: `Bearer ${sessionToken}`
                        },
                        body: JSON.stringify({
                          source: { type: "board", boardId: selectedBoardId },
                          recipe: buildRecipeWithStandardization(preparedRecipe ?? BLANK_RECIPE),
                          plan: context.plan
                        })
                      });
                      if (!response.ok) {
                        throw new Error(await response.text());
                      }
                      const result = (await response.json()) as PreviewResponse;
                      const previewBoardColumns = (result.columns ?? []).filter(
                        (column): column is { id: string; title: string } => Boolean(column.id)
                      );
                      if (previewBoardColumns.length > 0) {
                        const mapped = previewBoardColumns.reduce<Record<string, string>>((acc, column) => {
                          acc[column.id] = column.title ?? column.id;
                          return acc;
                        }, {});
                        setBoardColumnNames(mapped);
                      }
                      setPreview(result);
                      setSourceBoard(result.sourceBoard ?? null);
                      const prepared =
                        result.preparedRecipe ??
                        (result.sourceBoard ? null : buildRecipeWithStandardization(selectedRecipe));
                      if (result.sourceBoard) {
                        await handleWriteBoardSelect(result.sourceBoard.boardId, {
                          prepared,
                          boardName: result.sourceBoard.boardName,
                          boardColumns: previewBoardColumns
                        });
                        setSelectedBoardId(result.sourceBoard.boardId);
                      } else {
                        applyPreparedRecipe(prepared ?? null);
                        setWriteBoardId("");
                        setWriteBoardName("");
                      }
                      setToast({
                        message: `Preview ready${
                          result.sourceBoard ? ` for ${result.sourceBoard.boardName}` : ""
                        }`,
                        variant: "success"
                      });
                    } catch (error) {
                      setToast({ message: (error as Error).message, variant: "error" });
                    } finally {
                      setIsPreviewing(false);
                    }
                  })();
                  return;
                }

                if (!uploadedFile) {
                  setToast({ message: "Upload a file to preview.", variant: "error" });
                  return;
                }

                void (async () => {
                  setIsPreviewing(true);
                  try {
                    const sessionToken = await getSessionToken();
                    const formData = new FormData();
                    formData.set("file", uploadedFile);
                    formData.set("tenantId", context.tenantId);
                    formData.set(
                      "recipe",
                      JSON.stringify(buildRecipeWithStandardization(preparedRecipe ?? BLANK_RECIPE))
                    );
                    formData.set("plan", context.plan);
                    const response = await fetch("/api/recipes/run/preview", {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${sessionToken}`
                      },
                      body: formData
                    });
                    if (!response.ok) {
                      throw new Error(await response.text());
                    }
                    const result = (await response.json()) as PreviewResponse;
                    setPreview(result);
                    applyPreparedRecipe(
                      result.preparedRecipe ?? buildRecipeWithStandardization(selectedRecipe)
                    );
                    setSourceBoard(null);
                    if (result.columns && result.columns.length > 0) {
                      const columns = result.columns
                        .map((column) => column.title)
                        .filter((title): title is string => Boolean(title));
                      if (columns.length > 0) {
                        setFileColumns(Array.from(new Set(columns)));
                      }
                    } else if (result.rows.length > 0) {
                      const rowColumns = Object.keys(result.rows[0]).filter(Boolean);
                      if (rowColumns.length > 0) {
                        setFileColumns(Array.from(new Set(rowColumns)));
                      }
                    }
                    setBoardColumnNames({});
                    setToast({ message: "Preview ready", variant: "success" });
                  } catch (error) {
                    setToast({ message: (error as Error).message, variant: "error" });
                  } finally {
                    setIsPreviewing(false);
                  }
                })();
              }}
            >
              {isPreviewing ? "Processing..." : "Preview data"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Configure standardization</CardTitle>
            <CardDescription>
              Choose how each column should be cleaned before previewing or writing back.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {standardizationTargets.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Load a data source to enable standardization options.
              </p>
            ) : (
              <div className="space-y-4">
                {standardizationTargets.map((target) => {
                  const selections = standardizationSelections[target.field] ?? [];
                  return (
                    <div key={target.field} className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{target.label}</p>
                        <span className="text-xs text-muted-foreground">{target.field}</span>
                        {selections.length > 0 && (
                          <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            {selections.length} selected
                          </span>
                        )}
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {STANDARDIZATION_RULES.map((rule) => (
                          <label
                            key={`${target.field}-${rule.id}`}
                            className="flex items-start gap-2 text-xs leading-tight"
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5 h-3.5 w-3.5"
                              checked={selections.includes(rule.id)}
                              onChange={() => toggleStandardization(target.field, rule.id)}
                            />
                            <span>
                              <span className="font-medium">{rule.label}</span>
                              <span className="block text-muted-foreground">{rule.description}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
      <PlanGate
        allowed
        plan={context?.plan ?? "free"}
        feature="fuzzy deduplication"
        onUpgrade={() => setToast({ message: "Upgrade to unlock fuzzy dedupe.", variant: "default" })}
      >
        <section className="grid gap-6 md:grid-cols-[3fr,2fr]">
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Preview</CardTitle>
              <CardDescription>Shows the first rows with error badges and changes.</CardDescription>
            </CardHeader>
            <CardContent>
              {preview ? (
                <DataGridPreview rows={preview.rows} diff={preview.diff} errors={preview.errors} />
              ) : (
                <p className="text-sm text-muted-foreground">Run a preview to inspect transformed data.</p>
              )}
            </CardContent>
          </Card>
            {/* === Diff & Actions (with Mapping UI) === */}
          <Card>
            <CardHeader>
              <CardTitle>Diff & Actions</CardTitle>
              <CardDescription>Map columns, review diffs, and run write-back.</CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              {/* Select write board */}
              <div className="space-y-2">
                <Label htmlFor="write-board-select">Write to board</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Select
                    id="write-board-select"
                    value={writeBoardId}
                    onChange={(event) => handleWriteBoardSelect(event.target.value)}
                    className="sm:flex-1"
                    disabled={isPreparingWriteBoard}
                  >
                    <option value="">Select a board</option>
                    {boards.map((board) => (
                      <option key={board.id} value={board.id}>
                        {board.name}
                        {board.workspaceName ? ` - ${board.workspaceName}` : ""}
                      </option>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (!mondayClient) {
                        setBoardsError("Missing monday context. Open this app inside monday.");
                        return;
                      }
                      refreshBoards();
                    }}
                    disabled={isLoadingBoards}
                  >
                    {isLoadingBoards ? "Refreshing..." : "Refresh"}
                  </Button>
                </div>

                {/* New board creation */}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={newBoardName}
                    onChange={(e) => setNewBoardName(e.target.value)}
                    placeholder="New board name"
                    className="sm:flex-1"
                    disabled={isCreatingBoard || isPreparingWriteBoard || isSeedingBoard}
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleCreateBoard}
                    disabled={
                      isCreatingBoard ||
                      isPreparingWriteBoard ||
                      isSeedingBoard ||
                      !newBoardName.trim()
                    }
                  >
                    {isCreatingBoard
                      ? "Creating..."
                      : isSeedingBoard
                      ? "Seeding..."
                      : "Create board"}
                  </Button>
                </div>

                {isPreparingWriteBoard && (
                  <p className="text-xs text-muted-foreground">Preparing board mapping…</p>
                )}
                {writeBoardError && (
                  <p className="text-xs text-destructive">{writeBoardError}</p>
                )}
                {writeBoardId && writeBoardName && !writeBoardError && !isPreparingWriteBoard && (
                  <p className="text-xs text-muted-foreground">
                    Writing to <strong>{writeBoardName}</strong>
                  </p>
                )}
              </div>

              {/* === Mapping UI start === */}
              {Object.keys(boardColumnNames).length > 0 && (
                <div className="space-y-3">
                  <Label>Column Mapping</Label>
                  <div className="grid gap-2">
                    {fileColumns.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No source fields found — upload a file or preview data first.
                      </p>
                    ) : (
                      fileColumns.map((sourceField) => {
                        const writeStep = preparedRecipe?.steps.find(
                          (s): s is WriteBackStep => s.type === "write_back"
                        );
                       const selected = writeStep?.config?.columnMapping?.[sourceField] ?? "";
                        return (
                          <div
                            key={sourceField}
                            className="flex items-center justify-between gap-2 border rounded-md px-2 py-1"
                          >
                            <span className="text-sm">{sourceField}</span>
                            <Select
                              value={selected}
                              onChange={(e) => {
                                setPreparedRecipe((prev) => {
                                  if (!prev) return prev;
                                  const clone = structuredClone(prev);
                                  const write = clone.steps.find(
                                    (s): s is WriteBackStep => s.type === "write_back"
                                  );
                                  if (!write) return clone;
                                  write.config.columnMapping = {
                                    ...(write.config.columnMapping ?? {}),
                                    [sourceField]: e.target.value,
                                  };

                                  return clone;
                                });
                              }}
                            >
                              <option value="">— select monday column —</option>
                              {Object.entries(boardColumnNames).map(([id, name]) => (
                                <option key={id} value={id}>
                                  {name}
                                </option>
                              ))}
                            </Select>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
              {/* === Mapping UI end === */}

              {/* Diff viewer */}
              {preview && <DiffViewer diff={preview.diff} />}

              {/* Run button */}
              <Button
                variant="secondary"
                disabled={
                  !preview ||
                  !context ||
                  isExecuting ||
                  !writeBoardId ||
                  isPreparingWriteBoard
                }
                onClick={() => {
                  if (!preview || !context || isExecuting) return;
                  if (!writeBoardId) {
                    setToast({
                      message: "Select a board to write to before running.",
                      variant: "error",
                    });
                    return;
                  }
                  void (async () => {
                    setIsExecuting(true);
                    try {
                      const sessionToken = await getSessionToken();
                      const baseRecipe = preparedRecipe ?? BLANK_RECIPE;
                      const recipeForExecution = buildRecipeWithStandardization(baseRecipe);
                      const writeStep = recipeForExecution.steps.find(
                        (s): s is WriteBackStep => s.type === "write_back"
                      );
                      if (!writeStep) {
                        throw new Error("Recipe missing write-back step.");
                      }
                      writeStep.config.boardId = writeBoardId;
                      if (
                        !writeStep.config.columnMapping ||
                        Object.keys(writeStep.config.columnMapping).length === 0
                      ) {
                        setToast({
                          message:
                            "Map at least one column before running the write-back.",
                          variant: "error",
                        });
                        return;
                      }
                      const response = await fetch("/api/recipes/run/execute", {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization: `Bearer ${sessionToken}`,
                        },
                        body: JSON.stringify({
                          tenantId: context.tenantId,
                          recipe: recipeForExecution,
                          runId: preview.runId,
                          previewRows: preview.rows,
                          plan: context.plan,
                        }),
                      });
                      if (!response.ok) throw new Error(await response.text());
                      const result = (await response.json()) as { rowsWritten: number };
                      setToast({
                        message: `Run complete. ${result.rowsWritten} rows processed.`,
                        variant: "success",
                      });
                    } catch (err) {
                      setToast({ message: (err as Error).message, variant: "error" });
                    } finally {
                      setIsExecuting(false);
                    }
                  })();
                }}
              >
                {isExecuting ? "Running..." : "Run write-back"}
              </Button>
            </CardContent>
          </Card>
          {/* === End Diff & Actions === */}

        </section>
      </PlanGate>

      <Toast message={toast?.message ?? null} variant={toast?.variant} />
    </div>
  );
}

