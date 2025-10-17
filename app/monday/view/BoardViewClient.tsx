'use client';

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import mondaySdk from "monday-sdk-js";
import { motion } from "framer-motion"; // ✅ NEW

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

/** ---------------------------
 * Utilities (unchanged logic)
 * -------------------------- */

function exportRowsToCSV(rows: Record<string, unknown>[], filename = "standardized-data.csv") {
  if (!rows || rows.length === 0) {
    alert("No data to export.");
    return;
  }

  const columns = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set<string>())
  );

  const csvContent = [
    columns.join(","),
    ...rows.map((row) =>
      columns
        .map((col) => {
          const value = row[col];
          if (value == null) return "";
          const str = String(value).replace(/"/g, '""');
          return `"${str}"`;
        })
        .join(",")
    ),
  ].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

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
    { type: "map_columns", config: { mapping: {}, dropUnknown: false } },
    { type: "write_back", config: { strategy: "monday_upsert" } }
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

type StandardizationTarget = { field: string; label: string; };

function normalizeKey(value: string | null | undefined): string {
  return value ? value.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

function deriveSplitNameFields(field: string): { first: string; last: string } {
  const defaults = { first: "first_name", last: "last_name" };
  if (!field) return defaults;
  const withoutName = field.replace(/name$/i, "").replace(/[_\s]+$/g, "");
  const withoutFull = withoutName.replace(/full$/i, "").replace(/[_\s]+$/g, "");
  const base = withoutFull.length > 0 ? withoutFull : withoutName;
  if (!base) return defaults;
  const sanitized = base.endsWith("_") ? base.slice(0, -1) : base;
  const normalizedBase = sanitized.toLowerCase() === "full" ? "" : sanitized;
  const prefix = normalizedBase ? `${normalizedBase}_` : "";
  return { first: `${prefix}first_name`, last: `${prefix}last_name` };
}

/** Standardization rules (unchanged) */
const STANDARDIZATION_RULES: StandardizationRule[] = [
  { id: "trim_collapse_whitespace", label: "Trim & collapse whitespace", description: "Removes leading/trailing spaces and collapses internal whitespace.", build: (field) => ({ field, op: { kind: "trim_collapse_whitespace" } }), matches: (_f, op) => op.kind === "trim_collapse_whitespace" },
  { id: "standardize_boolean", label: "Standardize booleans", description: "Converts common yes/no values into true/false.", build: (field) => ({ field, op: { kind: "boolean_standardize" } }), matches: (_f, op) => op.kind === "boolean_standardize" },
  { id: "timezone_to_utc", label: "Normalize timezone", description: "Converts datetimes to UTC ISO strings.", build: (field) => ({ field, op: { kind: "timezone_to_utc" } }), matches: (_f, op) => op.kind === "timezone_to_utc" },
  { id: "slugify", label: "Slugify text", description: "Generates URL-safe slugs (lowercase with dashes).", build: (field) => ({ field, op: { kind: "slugify", separator: "-" } }), matches: (_f, op) => op.kind === "slugify" && (op.separator ?? "-") === "-" },
  { id: "round_numeric", label: "Round to currency", description: "Rounds numbers to two decimal places.", build: (field) => ({ field, op: { kind: "round_numeric", precision: 2 } }), matches: (_f, op) => op.kind === "round_numeric" && (op.precision ?? 2) === 2 },
  { id: "normalize_percentage", label: "Normalize percentages", description: "Converts % values into decimal form (e.g., 45% → 0.45).", build: (field) => ({ field, op: { kind: "normalize_percentage" } }), matches: (_f, op) => op.kind === "normalize_percentage" },
  { id: "remove_special_characters", label: "Remove special characters", description: "Strips zero-width and non-printable characters.", build: (field) => ({ field, op: { kind: "remove_special_characters" } }), matches: (_f, op) => op.kind === "remove_special_characters" },
  { id: "split_full_name", label: "Split full name", description: "Splits a full name into first/last name fields.", build: (field) => { const { first, last } = deriveSplitNameFields(field); return { field, op: { kind: "split_name", firstNameField: first, lastNameField: last } }; }, matches: (field, op) => { if (op.kind !== "split_name") return false; const { first, last } = deriveSplitNameFields(field); const opFirst = op.firstNameField ?? first; const opLast = op.lastNameField ?? last; return opFirst === first && opLast === last; } },
  { id: "normalize_address", label: "Normalize address", description: "Title-cases address parts and uppercases state codes.", build: (field) => ({ field, op: { kind: "normalize_address" } }), matches: (_f, op) => op.kind === "normalize_address" },
  { id: "sanitize_html", label: "Sanitize HTML", description: "Removes unsupported HTML/markdown tags.", build: (field) => ({ field, op: { kind: "sanitize_html" } }), matches: (_f, op) => op.kind === "sanitize_html" },
  { id: "title_case", label: "Title case", description: "Capitalize names.", build: (field) => ({ field, op: { kind: "title_case" } }), matches: (_f, op) => op.kind === "title_case" },
  { id: "email_normalize", label: "Normalize email", description: "Lowercase and trim email addresses.", build: (field) => ({ field, op: { kind: "email_normalize" } }), matches: (_f, op) => op.kind === "email_normalize" },
  { id: "phone_e164", label: "Format phone", description: "Convert phone numbers to E.164 (US default).", build: (field) => ({ field, op: { kind: "phone_e164", defaultCountry: "US" } }), matches: (_f, op) => op.kind === "phone_e164" },
  { id: "date_parse", label: "Date to ISO", description: "Normalize dates to YYYY-MM-DD.", build: (field) => ({ field, op: { kind: "date_parse", outputFormat: "yyyy-MM-dd" } }), matches: (_f, op) => op.kind === "date_parse" },
  { id: "iso_country", label: "Country to ISO", description: "Map country names to ISO codes.", build: (field) => ({ field, op: { kind: "iso_country" } }), matches: (_f, op) => op.kind === "iso_country" },
  { id: "currency_code", label: "Currency code", description: "Standardize currency strings (e.g., usd -> USD).", build: (field) => ({ field, op: { kind: "currency_code" } }), matches: (_f, op) => op.kind === "currency_code" },
  { id: "number_parse", label: "Parse number", description: "Parse numbers using the en-US locale.", build: (field) => ({ field, op: { kind: "number_parse", locale: "en-US" } }), matches: (_f, op) => op.kind === "number_parse" }
];

const STANDARDIZATION_RULES_MAP = new Map(STANDARDIZATION_RULES.map((r) => [r.id, r]));
const STANDARDIZATION_RULE_INDEX = new Map(STANDARDIZATION_RULES.map((r, i) => [r.id, i]));
function sortRuleIds(ids: Iterable<string>): string[] {
  const unique = Array.from(new Set(ids));
  return unique.sort((a, b) => (STANDARDIZATION_RULE_INDEX.get(a) ?? 1e9) - (STANDARDIZATION_RULE_INDEX.get(b) ?? 1e9));
}
function formatFieldLabel(field: string): string {
  const spaced = field.replace(/[_\-]+/g, " ").replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  if (!spaced) return "Field";
  return spaced.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function getRecipeTargetFields(recipe: RecipeDefinition | null): string[] {
  if (!recipe) return [];
  const fields = new Set<string>();
  const mapStep = recipe.steps.find((s): s is MapColumnsStep => s.type === "map_columns");
  if (mapStep) {
    const mapping = mapStep.config.mapping ?? {};
    for (const target of Object.values(mapping)) if (target) fields.add(target);
  }
  const write = recipe.steps.find((s): s is WriteBackStep => s.type === "write_back");
  if (write) {
    if (write.config.columnMapping) for (const target of Object.keys(write.config.columnMapping)) if (target) fields.add(target);
    if (write.config.keyColumn) fields.add(write.config.keyColumn);
    if (write.config.itemNameField) fields.add(write.config.itemNameField);
  }
  return Array.from(fields);
}
function deriveStandardizationSelectionsFromRecipe(recipe: RecipeDefinition | null): Record<string, string[]> {
  if (!recipe) return {};
  const formatStep = recipe.steps.find((s): s is FormatStep => s.type === "format");
  if (!formatStep) return {};
  const selections: Record<string, string[]> = {};
  for (const operation of formatStep.config.operations ?? []) {
    const rule = STANDARDIZATION_RULES.find((candidate) => candidate.matches(operation.field, operation.op));
    if (!rule) continue;
    const existing = selections[operation.field] ?? [];
    selections[operation.field] = [...existing, rule.id];
  }
  for (const field of Object.keys(selections)) selections[field] = sortRuleIds(selections[field]);
  return selections;
}
function selectionMapsEqual(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    const arrA = a[keysA[i]], arrB = b[keysA[i]];
    if (arrA.length !== arrB.length) return false;
    for (let j = 0; j < arrA.length; j++) if (arrA[j] !== arrB[j]) return false;
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
  dataSource: "file" | "board";
}): StandardizationTarget[] {
  const targets: StandardizationTarget[] = [];
  const seen = new Set<string>();
  const addTarget = (field: string, label: string) => { if (!field || seen.has(field)) return; targets.push({ field, label }); seen.add(field); };

  const mapStep = recipe?.steps.find((s): s is MapColumnsStep => s.type === "map_columns");

  if (dataSource === "board") {
    if (recipe) {
      const write = recipe.steps.find((s): s is WriteBackStep => s.type === "write_back");
      const columnMapping = write?.config?.columnMapping ?? {};
      for (const [field, columnId] of Object.entries(columnMapping)) {
        if (!field) continue;
        const friendlyField = formatFieldLabel(field);
        const columnName = (columnId ? boardColumns[columnId] : undefined) ?? friendlyField;
        const label = columnName && columnName !== friendlyField ? `${columnName} (${friendlyField})` : columnName ?? friendlyField;
        addTarget(field, label);
      }
    }
    for (const columnName of Object.values(boardColumns)) {
      if (!columnName) continue;
      const trimmedName = columnName.trim();
      if (!trimmedName) continue;
      let mappedField = trimmedName;
      if (mapStep?.config?.mapping) {
        const direct = mapStep.config.mapping[columnName] ?? mapStep.config.mapping[trimmedName];
        if (direct && direct.trim().length > 0) mappedField = direct.trim();
      }
      const label = trimmedName.length > 0 ? trimmedName : formatFieldLabel(mappedField);
      addTarget(mappedField, label);
    }
  }

  if (dataSource === "file" && fileColumns.length > 0) {
    for (const column of fileColumns) addTarget(column, column);
  }

  const fallbackFields = getRecipeTargetFields(recipe);
  for (const field of fallbackFields) addTarget(field, formatFieldLabel(field));
  return targets;
}
function autoMapBoardColumns(
  recipe: RecipeDefinition,
  boardColumns: Record<string, string>
): { recipe: RecipeDefinition; missingFields: string[] } {
  const write = recipe.steps.find((s): s is WriteBackStep => s.type === "write_back");
  if (!write) return { recipe, missingFields: [] };

  const existingMapping = { ...(write.config.columnMapping ?? {}) };
  const existingTargets = new Set(Object.keys(existingMapping));
  const normalizedColumns = new Map<string, string>();
  const missingFields: string[] = [];

  for (const [columnId, title] of Object.entries(boardColumns)) {
    if (!columnId) continue;
    const normalizedTitle = normalizeKey(title);
    if (normalizedTitle) normalizedColumns.set(normalizedTitle, columnId);
    const normalizedLabel = normalizeKey(formatFieldLabel(title ?? columnId));
    if (normalizedLabel) normalizedColumns.set(normalizedLabel, columnId);
    normalizedColumns.set(normalizeKey(columnId), columnId);
  }
  if (normalizedColumns.size === 0) return { recipe, missingFields: [] };

  const mapStep = recipe.steps.find((s): s is MapColumnsStep => s.type === "map_columns");
  const candidates = new Set(getRecipeTargetFields(recipe));
  if (mapStep?.config?.mapping) for (const target of Object.values(mapStep.config.mapping)) if (target) candidates.add(target);

  const nextMapping = { ...existingMapping };
  for (const field of candidates) {
    if (!field || existingTargets.has(field)) continue;
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
    write.config.columnMapping = nextMapping;
  }
  if (write.config.keyColumn && !write.config.keyColumnId && write.config.columnMapping) {
    const keyId = write.config.columnMapping[write.config.keyColumn];
    if (keyId) write.config.keyColumnId = keyId;
  }
  return { recipe, missingFields: Array.from(new Set(missingFields)) };
}
async function extractColumnsFromFile(file: File): Promise<string[] | null> {
  const lowerName = file.name.toLowerCase();
  const isCsv = lowerName.endsWith(".csv");
  const isText = file.type.startsWith("text/") || isCsv;
  if (!isText) return null;
  try {
    const text = await file.text();
    const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!firstLine) return null;
    const columns = firstLine.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
    if (columns.length === 0) return null;
    return Array.from(new Set(columns));
  } catch {
    return null;
  }
}
type DataSource = "file" | "board";
type MondayBoardOption = { id: string; name: string; workspaceName?: string | null; kind?: string | null; };
type PreviewResponse = RecipePreviewResult & {
  runId?: string;
  preparedRecipe?: RecipeDefinition;
  sourceBoard?: { boardId: string; boardName: string; };
  columns?: Array<{ id: string | null; title: string }>;
};

/** ---------------------------
 * Component
 * -------------------------- */

export default function BoardViewClient() {
  /** --- State (unchanged) --- */
  const [context, setContext] = useState<MondayContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [preparedRecipe, setPreparedRecipe] = useState<RecipeDefinition | null>(null);
  const [toast, setToast] = useState<{ message: string; variant?: "default" | "success" | "error" } | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [dataSource, setDataSource] = useState<DataSource>("file");
  const [boards, setBoards] = useState<MondayBoardOption[]>([]);
  const [isLoadingBoards, setLoadingBoards] = useState(false);
  const [boardsError, setBoardsError] = useState<string | null>(null);
  const [selectedBoardId, setSelectedBoardId] = useState<string>("");
  const [sourceBoard, setSourceBoard] = useState<PreviewResponse["sourceBoard"] | null>(null);
  const [existingBoardKeys, setExistingBoardKeys] = useState<string[] | null>(null);
  const [writeBoardId, setWriteBoardId] = useState<string>("");
  const [writeBoardName, setWriteBoardName] = useState<string>("");
  const [writeBoardError, setWriteBoardError] = useState<string | null>(null);
  const [isPreparingWriteBoard, setPreparingWriteBoard] = useState(false);
  const [newBoardName, setNewBoardName] = useState<string>("");
  const [isCreatingBoard, setIsCreatingBoard] = useState(false);
  const [isSeedingBoard, setIsSeedingBoard] = useState(false);
  const [seedSourceMode, setSeedSourceMode] = useState<"preview" | "original">("preview");

  async function parseCsvFileToRows(file: File): Promise<Record<string, unknown>[]> {
    const text = await file.text();
    const rows: string[][] = [];
    let cur: string[] = [];
    let curField = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < text.length && text[i + 1] === '"') {
            curField += '"'; i += 1;
          } else inQuotes = false;
        } else curField += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { cur.push(curField); curField = ""; }
        else if (ch === '\r') { /* ignore */ }
        else if (ch === '\n') { cur.push(curField); rows.push(cur); cur = []; curField = ""; }
        else curField += ch;
      }
    }
    if (inQuotes) { cur.push(curField); rows.push(cur); }
    else if (curField !== "" || cur.length > 0) { cur.push(curField); rows.push(cur); }

    if (rows.length === 0) return [];
    const header = rows[0].map((h) => (h ?? "").toString().trim());
    const out: Record<string, unknown>[] = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]; if (!row) continue;
      const obj: Record<string, unknown> = {};
      for (let c = 0; c < header.length; c++) obj[header[c]] = c < row.length ? row[c] : null;
      out.push(obj);
    }
    return out;
  }

  const [standardizationSelections, setStandardizationSelections] = useState<Record<string, string[]>>({});
  const [boardColumnNames, setBoardColumnNames] = useState<Record<string, string>>({});
  const [fileColumns, setFileColumns] = useState<string[]>([]);
  const [exportMode, setExportMode] = useState<"all" | "changed">("all");
  const [unmappedBoardFields, setUnmappedBoardFields] = useState<string[]>([]);
  const unmappedFieldsRef = useRef<string[]>([]);

  const mondayClient = useMemo(() => (typeof window === "undefined" ? null : mondaySdk()), []);
  const selectedRecipe = BLANK_RECIPE;

  const standardizationTargets = useMemo(
    () =>
      computeStandardizationTargets({
        recipe: preparedRecipe ?? BLANK_RECIPE,
        boardColumns: boardColumnNames,
        fileColumns,
        dataSource
      }),
    [preparedRecipe, boardColumnNames, fileColumns, dataSource]
  );

  // Stronger fuzzy compare: token Jaccard + normalized Levenshtein
  const columnComparison = useMemo(() => {
    if (!writeBoardId) return null;
    if (!fileColumns || fileColumns.length === 0) return null;
    if (!boardColumnNames || Object.keys(boardColumnNames).length === 0) return null;

    const normalize = (s: string | null | undefined) => (s ?? "").toString().trim().toLowerCase().replace(/["'`\(\)\[\]\{\}]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const tokenize = (s: string) => Array.from(new Set(s.split(/\s+/).filter(Boolean)));

    // normalized Levenshtein distance (simple implementation)
    const levenshtein = (a: string, b: string) => {
      if (a === b) return 0;
      const m = a.length, n = b.length;
      if (m === 0) return n;
      if (n === 0) return m;
      const dp: number[] = Array(n + 1).fill(0).map((_, j) => j);
      for (let i = 1; i <= m; i++) {
        let prev = dp[0]; dp[0] = i;
        for (let j = 1; j <= n; j++) {
          const cur = dp[j];
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
          prev = cur;
        }
      }
      return dp[n];
    };

    const normalizedLevenshteinScore = (a: string, b: string) => {
      const maxLen = Math.max(a.length, b.length);
      if (maxLen === 0) return 1;
      const dist = levenshtein(a, b);
      return 1 - dist / maxLen; // 1 = identical, 0 = totally different
    };

    const jaccard = (aTokens: string[], bTokens: string[]) => {
      const setA = new Set(aTokens), setB = new Set(bTokens);
      const inter = Array.from(setA).filter((x) => setB.has(x)).length;
      const uni = new Set([...setA, ...setB]).size;
      return uni === 0 ? 0 : inter / uni;
    };

    const boardEntries = Object.entries(boardColumnNames).map(([id, name]) => ({ id, name, norm: normalize(name), tokens: tokenize(normalize(name)) }));
    const boardNameToId = boardEntries.reduce<Record<string, string>>((acc, e) => { acc[e.name] = e.id; return acc; }, {});

    const matches: Array<{ file: string; board: string; score: number }> = [];
    const unmatchedFile: string[] = [];

    for (const f of fileColumns) {
      const fnorm = normalize(f);
      if (!fnorm) continue;
      const ftokens = tokenize(fnorm);

      let best: { entry: { id: string; name: string; norm: string; tokens: string[] } | null; score: number } = { entry: null, score: 0 };
      for (const entry of boardEntries) {
        // combine token Jaccard and normalized levenshtein on the full string
        const tokenScore = jaccard(ftokens, entry.tokens);
        const levScore = normalizedLevenshteinScore(fnorm, entry.norm);
        // weighted average (tokens are stronger signal)
        const combined = 0.65 * tokenScore + 0.35 * levScore;
        if (combined > best.score) best = { entry, score: combined };
      }

      // thresholds: accept combined >= 0.6, or exact token overlap >= 0.8
      if (best.entry && (best.score >= 0.6 || jaccard(ftokens, best.entry.tokens) >= 0.8)) {
        matches.push({ file: f, board: best.entry.name, score: Math.round(best.score * 100) / 100 });
      } else {
        unmatchedFile.push(f);
      }
    }

    const matchedBoardNames = new Set(matches.map((m) => m.board));
    const unmatchedBoard: string[] = boardEntries.filter((b) => !matchedBoardNames.has(b.name)).map((b) => b.name);

    return { matches, unmatchedFile, unmatchedBoard, boardNameToId };
  }, [writeBoardId, boardColumnNames, fileColumns]);

  useEffect(() => { unmappedFieldsRef.current = unmappedBoardFields; }, [unmappedBoardFields]);

  useEffect(() => {
    setStandardizationSelections((prev) => {
      const validFields = new Set(standardizationTargets.map((t) => t.field));
      let changed = false; const next: Record<string, string[]> = {};
      for (const [field, rules] of Object.entries(prev)) {
        if (!validFields.has(field)) { changed = true; continue; }
        const filtered = rules.filter((id) => STANDARDIZATION_RULES_MAP.has(id));
        if (filtered.length !== rules.length) changed = true;
        if (filtered.length > 0) next[field] = filtered; else changed = true;
      }
      return changed ? next : prev;
    });
  }, [standardizationTargets]);

  const buildRecipeWithStandardization = useCallback(
    (baseRecipe: RecipeDefinition | null) => {
      const source = baseRecipe ?? selectedRecipe;
      if (!source) throw new Error("No recipe available for standardization.");
      const cloned = JSON.parse(JSON.stringify(source)) as RecipeDefinition;
      let formatIndex = cloned.steps.findIndex((s) => s.type === "format");
      let formatStep: FormatStep;
      if (formatIndex === -1) {
        formatStep = { type: "format", config: { operations: [] } };
        const mapIndex = cloned.steps.findIndex((s) => s.type === "map_columns");
        if (mapIndex === -1) cloned.steps.push(formatStep);
        else cloned.steps.splice(mapIndex + 1, 0, formatStep);
      } else {
        formatStep = cloned.steps[formatIndex] as FormatStep;
      }

      const existingOperations = [...(formatStep.config.operations ?? [])];
      const preserved = existingOperations.filter(
        (op) => !STANDARDIZATION_RULES.some((rule) => rule.matches(op.field, op.op))
      );

      const newOps: FormatOperation[] = [];
      for (const target of standardizationTargets) {
        const field = target.field;
        const ids = standardizationSelections[field];
        if (!ids || ids.length === 0) continue;
        for (const id of ids) {
          const rule = STANDARDIZATION_RULES_MAP.get(id);
          if (rule) newOps.push(rule.build(field));
        }
      }
      formatStep.config.operations = [...preserved, ...newOps];

      if (dataSource !== "board" || Object.keys(boardColumnNames).length === 0) {
        setUnmappedBoardFields([]); return cloned;
      }
      const { recipe: mapped, missingFields } = autoMapBoardColumns(cloned, boardColumnNames);
      setUnmappedBoardFields(missingFields);
      return mapped;
    },
    [selectedRecipe, standardizationSelections, standardizationTargets, boardColumnNames, dataSource]
  );

  const toggleStandardization = useCallback((field: string, ruleId: string) => {
    const validFields = new Set(standardizationTargets.map((t) => t.field));
    if (!validFields.has(field) || !STANDARDIZATION_RULES_MAP.has(ruleId)) return;
    setStandardizationSelections((prev) => {
      const current = new Set(prev[field] ?? []);
      const had = current.has(ruleId);
      if (had) current.delete(ruleId); else current.add(ruleId);
      const nextValue = current.size === 0 ? [] : sortRuleIds(current);
      const next = { ...prev };
      if (nextValue.length === 0) { if (!had) return prev; delete next[field]; }
      else next[field] = nextValue;
      if (selectionMapsEqual(prev, next)) return prev;
      return next;
    });
  }, [standardizationTargets]);

  const applyPreparedRecipe = useCallback(
    (recipe: RecipeDefinition | null, boardColumnsOverride?: Record<string, string>) => {
      let nextRecipe: RecipeDefinition | null = null;
      let missingFields: string[] = [];
      const effectiveBoardColumns = dataSource === "board" ? (boardColumnsOverride ?? boardColumnNames) : {};
      if (boardColumnsOverride) setBoardColumnNames(boardColumnsOverride);

      if (recipe) {
        const cloned = JSON.parse(JSON.stringify(recipe)) as RecipeDefinition;
        if (dataSource === "board" && Object.keys(effectiveBoardColumns).length > 0) {
          const result = autoMapBoardColumns(cloned, effectiveBoardColumns);
          nextRecipe = result.recipe; missingFields = result.missingFields;
        } else nextRecipe = cloned;
      }
      setPreparedRecipe(nextRecipe);
      setUnmappedBoardFields(missingFields);

      const baseRecipe = nextRecipe ?? selectedRecipe;
      if (baseRecipe) {
        const derivedSelections = deriveStandardizationSelectionsFromRecipe(baseRecipe);
        const fields = new Set(getRecipeTargetFields(baseRecipe));
        const mapStep = baseRecipe.steps.find((s): s is MapColumnsStep => s.type === "map_columns");
        if (dataSource === "board") {
          for (const columnName of Object.values(boardColumnNames)) {
            if (!columnName) continue;
            const trimmed = columnName.trim();
            if (!trimmed) continue;
            let fieldName = trimmed;
            if (mapStep?.config?.mapping) {
              const mapped = mapStep.config.mapping[columnName] ?? mapStep.config.mapping[trimmed];
              if (mapped && mapped.trim().length > 0) fieldName = mapped.trim();
            }
            fields.add(fieldName);
          }
        } else if (dataSource === "file") {
          for (const column of fileColumns) if (column) fields.add(column);
        }
        setStandardizationSelections((prev) => {
          const next: Record<string, string[]> = {};
          fields.forEach((field) => {
            if (!field) return;
            const derived = derivedSelections[field];
            const fallback = prev[field] ?? [];
            const chosen = derived && derived.length > 0 ? derived : fallback;
            if (chosen.length > 0) next[field] = sortRuleIds(chosen);
          });
          if (selectionMapsEqual(prev, next)) return prev;
          return next;
        });
      } else {
        setStandardizationSelections((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      }

      if (!nextRecipe) { setWriteBoardError(null); return; }
      setWriteBoardError(null);
    },
    [selectedRecipe, dataSource, boardColumnNames, fileColumns]
  );

  const getSessionToken = useCallback(async () => {
    if (!mondayClient) throw new Error("Missing monday context token. Launch this app from a monday board.");
    const result: { data?: string } = await mondayClient.get("sessionToken");
    const token = result?.data;
    if (!token) throw new Error("Unable to retrieve monday session token.");
    return token;
  }, [mondayClient]);

  const seedBoardWithPreview = useCallback(async (boardId: string, boardName: string, prepared: RecipeDefinition | null) => {
    if (!preview || preview.rows.length === 0 || !context) return "skipped" as const;
    const baseRecipe = prepared ?? preparedRecipe ?? BLANK_RECIPE;
    if (!baseRecipe) return "skipped" as const;

    const recipeForExecution = buildRecipeWithStandardization(baseRecipe);
    const writeStep = recipeForExecution.steps.find((s): s is WriteBackStep => s.type === "write_back");
    if (!writeStep) return "skipped" as const;

    writeStep.config.boardId = boardId;
    if (!writeStep.config.columnMapping || Object.keys(writeStep.config.columnMapping).length === 0) return "skipped" as const;

    try {
      setIsSeedingBoard(true);
      setToast({ message: `Seeding ${preview.rows.length} rows into "${boardName}"...` });
      const sessionToken = await getSessionToken();
      const response = await fetch("/api/recipes/run/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ tenantId: context.tenantId, recipe: recipeForExecution, runId: preview.runId, previewRows: preview.rows, plan: context.plan })
      });
      if (!response.ok) throw new Error(await response.text());
      const result = (await response.json()) as { rowsWritten: number };
      setToast({ message: `Board "${boardName}" seeded with ${result.rowsWritten} rows.`, variant: "success" });
      return "seeded" as const;
    } catch (error) {
      setToast({ message: `Board created but seeding failed: ${(error as Error).message}`, variant: "error" });
      return "failed" as const;
    } finally {
      setIsSeedingBoard(false);
    }
  }, [buildRecipeWithStandardization, context, getSessionToken, preparedRecipe, preview]);

  const seedBoardWithRows = useCallback(async (boardId: string, boardName: string, prepared: RecipeDefinition | null, rows: Record<string, unknown>[]) => {
    if (!rows || rows.length === 0 || !context) return "skipped" as const;
    const baseRecipe = prepared ?? preparedRecipe ?? BLANK_RECIPE;
    if (!baseRecipe) return "skipped" as const;

    const recipeForExecution = buildRecipeWithStandardization(baseRecipe);
    const writeStep = recipeForExecution.steps.find((s): s is WriteBackStep => s.type === "write_back");
    if (!writeStep) return "skipped" as const;

    writeStep.config.boardId = boardId;
    if (!writeStep.config.columnMapping || Object.keys(writeStep.config.columnMapping).length === 0) return "skipped" as const;

    try {
      setIsSeedingBoard(true);
      setToast({ message: `Seeding ${rows.length} rows into "${boardName}"...` });
      const sessionToken = await getSessionToken();
      const response = await fetch("/api/recipes/run/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ tenantId: context.tenantId, recipe: recipeForExecution, previewRows: rows, plan: context.plan })
      });
      if (!response.ok) throw new Error(await response.text());
      const result = (await response.json()) as { rowsWritten: number };
      setToast({ message: `Board "${boardName}" seeded with ${result.rowsWritten} rows.`, variant: "success" });
      return "seeded" as const;
    } catch (error) {
      setToast({ message: `Board created but seeding failed: ${(error as Error).message}`, variant: "error" });
      return "failed" as const;
    } finally {
      setIsSeedingBoard(false);
    }
  }, [buildRecipeWithStandardization, context, getSessionToken, preparedRecipe]);

  const loadBoards = useCallback(async () => {
    const sessionToken = await getSessionToken();
    const response = await fetch("/api/monday/boards", { method: "GET", headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!response.ok) throw new Error(await response.text());
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
        const matching = boardsList.find((b) => b.id === writeBoardId);
        if (matching) setWriteBoardName(matching.name);
      }
    } catch (error) {
      setBoards([]);
      setBoardsError((error as Error).message ?? "Failed to load boards.");
    } finally {
      setLoadingBoards(false);
    }
  }, [loadBoards, writeBoardId]);

  const handleWriteBoardSelect = useCallback(async (boardId: string, options?: {
    prepared?: RecipeDefinition | null; boardName?: string; boardColumns?: Array<{ id: string; title: string }>;
  }) => {
    setWriteBoardError(null);
    setWriteBoardId(boardId);
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
          if (column.id) acc[column.id] = column.title ?? column.id;
          return acc;
        }, {});
        setBoardColumnNames(mapped);
      }
      // If the prepare endpoint included existingKeys (attached in preview flow), set it
      const anyOpts = options as any;
      if (anyOpts.board?.existingKeys && Array.isArray(anyOpts.board.existingKeys)) {
        setExistingBoardKeys(anyOpts.board.existingKeys as string[]);
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
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ recipe: buildRecipeWithStandardization(preparedRecipe ?? BLANK_RECIPE) })
      });
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as {
        preparedRecipe: RecipeDefinition;
        board?: { boardId: string; boardName: string; columns?: Array<{ id: string; title: string }>; existingKeys?: string[] };
      };
      if (data.board?.columns) {
        const mapped = data.board.columns.reduce<Record<string, string>>((acc, column) => {
          if (column.id) acc[column.id] = column.title ?? column.id; return acc;
        }, {});
        setBoardColumnNames(mapped);
        if (data.board.existingKeys) setExistingBoardKeys(data.board.existingKeys as string[]);
      }
      applyPreparedRecipe(data.preparedRecipe);
      setWriteBoardName(data.board?.boardName ?? resolvedName);
    } catch (error) {
      setWriteBoardError((error as Error).message ?? "Failed to prepare board for write-back.");
    } finally {
      setPreparingWriteBoard(false);
    }
  }, [applyPreparedRecipe, boards, buildRecipeWithStandardization, getSessionToken, preparedRecipe, sourceBoard?.boardId]);

  // Helper: compute unique preview rows that don't match existing board keys
  const uniquePreviewRows = useMemo(() => {
    if (!preview || !preview.rows || preview.rows.length === 0) return [] as Record<string, unknown>[];
    const writeStep = preparedRecipe?.steps.find((s): s is WriteBackStep => s.type === "write_back");
    const keyField = writeStep?.config?.keyColumn ?? writeStep?.config?.itemNameField ?? null;
    if (!keyField) return preview.rows;

    const normalizeVal = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim().toLowerCase());

    // Build set from existing board keys if available
    const existingSet = (existingBoardKeys && existingBoardKeys.length > 0)
      ? new Set(existingBoardKeys.map((k) => k.toString().trim().toLowerCase()))
      : null;

    // Helper: find the value for the configured key field in a preview row.
    // We try exact key, then case-insensitive key match.
    const findKeyValue = (row: Record<string, unknown>) => {
      if (row.hasOwnProperty(keyField)) return normalizeVal(row[keyField]);
      // case-insensitive lookup
      const lowerKey = keyField.toString().trim().toLowerCase();
      for (const k of Object.keys(row)) {
        if (k.toString().trim().toLowerCase() === lowerKey) return normalizeVal(row[k]);
      }
      return "";
    };

    // If we have existing board keys, filter against them. Otherwise, dedupe within preview rows.
    if (existingSet) {
      return preview.rows.filter((r) => {
        const v = findKeyValue(r);
        if (!v) return true; // keep rows with empty key so user can inspect
        return !existingSet.has(v);
      });
    }

    // Dedupe within the preview rows by the key value (preserve first occurrence)
    const seen = new Set<string>();
    const out: Record<string, unknown>[] = [];
    for (const r of preview.rows) {
      const v = findKeyValue(r);
      if (!v) {
        out.push(r); // keep rows without a key
        continue;
      }
      if (!seen.has(v)) {
        seen.add(v);
        out.push(r);
      }
    }
    return out;
  }, [preview, preparedRecipe, existingBoardKeys]);

  const runWriteBackUnique = useCallback(async () => {
    if (!preview || !context || !writeBoardId || !preparedRecipe) return;
    const rows = uniquePreviewRows;
    if (!rows || rows.length === 0) { setToast({ message: "No unique rows to write.", variant: "error" }); return; }
    setIsExecuting(true);
    try {
      const sessionToken = await getSessionToken();
      const baseRecipe = preparedRecipe ?? BLANK_RECIPE;
      const recipeForExecution = buildRecipeWithStandardization(baseRecipe);
      const writeStep = recipeForExecution.steps.find((s): s is WriteBackStep => s.type === "write_back");
      if (!writeStep) throw new Error("Recipe missing write-back step.");
      writeStep.config.boardId = writeBoardId;
      if (!writeStep.config.columnMapping || Object.keys(writeStep.config.columnMapping).length === 0) {
        setToast({ message: "Map at least one column before running the write-back.", variant: "error" });
        return;
      }
      const response = await fetch("/api/recipes/run/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ tenantId: context.tenantId, recipe: recipeForExecution, previewRows: rows, plan: context.plan })
      });
      if (!response.ok) throw new Error(await response.text());
      const result = (await response.json()) as { rowsWritten: number };
      setToast({ message: `Run complete. ${result.rowsWritten} rows processed.`, variant: "success" });
    } catch (err) {
      setToast({ message: (err as Error).message, variant: "error" });
    } finally {
      setIsExecuting(false);
    }
  }, [preview, context, writeBoardId, preparedRecipe, uniquePreviewRows, getSessionToken, buildRecipeWithStandardization, context?.tenantId, context?.plan]);

  const runCleanDedupe = useCallback(async () => {
    if (!preview || !context || !preparedRecipe) return;
    setIsExecuting(true);
    try {
      const sessionToken = await getSessionToken();
      const baseRecipe = preparedRecipe ?? BLANK_RECIPE;
      const recipeForExecution = buildRecipeWithStandardization(baseRecipe);
      // Keep only map_columns, format, dedupe steps — remove write_back
      const filteredSteps = recipeForExecution.steps.filter((s) => s.type === "map_columns" || s.type === "format" || s.type === "dedupe");
      const dedupeRecipe = { ...recipeForExecution, steps: filteredSteps } as RecipeDefinition;

      const response = await fetch("/api/recipes/run/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ tenantId: context.tenantId, recipe: dedupeRecipe, previewRows: preview.rows, plan: context.plan })
      });
      if (!response.ok) throw new Error(await response.text());
      const result = (await response.json()) as { rowsWritten: number; errors?: any[] };
      // rowsWritten is the number of rows after dedupe (engine returns rowsWritten = currentRows.length when no write_back)
      setToast({ message: `Dedupe complete: ${result.rowsWritten} unique of ${preview.rows.length} preview rows.`, variant: "success" });
    } catch (err) {
      setToast({ message: (err as Error).message, variant: "error" });
    } finally {
      setIsExecuting(false);
    }
  }, [preview, context, preparedRecipe, getSessionToken, buildRecipeWithStandardization]);

  const ensureBoardColumns = useCallback(async () => {
    if (!writeBoardId) { setToast({ message: "Select a board to update columns.", variant: "error" }); return; }
    setToast({ message: "Syncing missing columns with monday..." });
    await handleWriteBoardSelect(writeBoardId);
    await new Promise((r) => setTimeout(r, 0));
    const remaining = unmappedFieldsRef.current;
    if (remaining.length === 0) setToast({ message: "Board columns updated from monday.", variant: "success" });
    else setToast({ message: `Still missing: ${remaining.map((f) => formatFieldLabel(f)).join(", ")}`, variant: "error" });
  }, [handleWriteBoardSelect, writeBoardId]);

  const handleCreateBoard = useCallback(async () => {
    const trimmedName = newBoardName.trim();
    if (!trimmedName) { setWriteBoardError("Enter a name for the new board."); return; }
    try {
      setIsCreatingBoard(true);
      setBoardsError(null);
      setWriteBoardError(null);
      const sessionToken = await getSessionToken();
      const recipeForBoard = buildRecipeWithStandardization(preparedRecipe ?? BLANK_RECIPE);

      const payload: any = { name: trimmedName, boardKind: DEFAULT_BOARD_KIND, recipe: recipeForBoard };
      if (seedSourceMode === "original" && uploadedFile) {
        try {
          const extracted = await extractColumnsFromFile(uploadedFile);
          if (extracted && extracted.length > 0) payload.columns = extracted;
        } catch { /* ignore */ }
      }

      const response = await fetch("/api/monday/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(await response.text());
      const result = (await response.json()) as {
        board: { boardId: string; boardName: string; workspaceName?: string | null; kind?: string | null; columns?: Array<{ id: string; title: string }> };
        preparedRecipe: RecipeDefinition;
      };
      setBoards((current) => {
        const filtered = current.filter((e) => e.id !== result.board.boardId);
        const next = [...filtered, { id: result.board.boardId, name: result.board.boardName, workspaceName: result.board.workspaceName ?? null, kind: result.board.kind ?? null }];
        return next.sort((a, b) => a.name.localeCompare(b.name));
      });
      await handleWriteBoardSelect(result.board.boardId, { prepared: result.preparedRecipe, boardName: result.board.boardName, boardColumns: result.board.columns ?? [] });
      setNewBoardName("");

      let seedResult: "skipped" | "seeded" | "failed" = "skipped";
      if (seedSourceMode === "preview") {
        seedResult = await seedBoardWithPreview(result.board.boardId, result.board.boardName, result.preparedRecipe);
      } else {
        if (!uploadedFile) setToast({ message: "No uploaded CSV available to seed from.", variant: "error" });
        else {
          try {
            const parsed = await parseCsvFileToRows(uploadedFile);
            if (!parsed || parsed.length === 0) setToast({ message: "Uploaded CSV contains no rows to seed.", variant: "error" });
            else {
              const headerKeys = Object.keys(parsed[0]);
              const boardCols = result.board.columns ?? [];
              const mapping: Record<string, string> = {};
              const normalize = (s: string | undefined) => (s ?? "").toString().trim().toLowerCase().replace(/[^a-z0-9]/g, "");
              const normalizedBoard = boardCols.map((c) => ({ id: c.id!, title: c.title ?? "", norm: normalize(c.title) }));
              for (const header of headerKeys) {
                const targetNorm = normalize(header);
                const match = normalizedBoard.find((b) => b.norm === targetNorm) || normalizedBoard.find((b) => b.norm.includes(targetNorm) || targetNorm.includes(b.norm));
                if (match) mapping[header] = match.id;
              }
              const preparedClone = structuredClone(result.preparedRecipe ?? BLANK_RECIPE) as RecipeDefinition;
              const write = preparedClone.steps.find((s): s is WriteBackStep => s.type === "write_back");
              if (write) write.config.columnMapping = { ...(write.config.columnMapping ?? {}), ...mapping };
              seedResult = await seedBoardWithRows(result.board.boardId, result.board.boardName, preparedClone, parsed);
            }
          } catch (err) { setToast({ message: `Failed to parse uploaded CSV: ${(err as Error).message}`, variant: "error" }); }
        }
      }
      if (seedResult === "skipped") setToast({ message: `Created board "${result.board.boardName}".`, variant: "success" });
    } catch (error) {
      setWriteBoardError((error as Error).message ?? "Failed to create board.");
    } finally {
      setIsCreatingBoard(false);
    }
  }, [getSessionToken, handleWriteBoardSelect, newBoardName, preparedRecipe, buildRecipeWithStandardization, seedSourceMode, uploadedFile, seedBoardWithPreview, seedBoardWithRows]);

  useEffect(() => {
    if (!context || !mondayClient) return;
    if (boards.length > 0 || isLoadingBoards) return;
    refreshBoards();
  }, [boards.length, context, isLoadingBoards, mondayClient, refreshBoards]);

  useEffect(() => {
    if (!mondayClient) { setContextError("Missing monday context token. Launch this app from a monday board."); setContext(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const sessionToken = await getSessionToken(); if (cancelled) return;
        const response = await fetch("/api/monday/context/verify", { method: "POST", headers: { Authorization: `Bearer ${sessionToken}` } });
        if (!response.ok) throw new Error(await response.text());
        const result = (await response.json()) as MondayContext;
        if (!cancelled) { setContext(result); setContextError(null); }
      } catch (error) {
        if (!cancelled) { setContextError((error as Error).message ?? "Failed to verify monday context token."); setContext(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [mondayClient, getSessionToken]);

  useEffect(() => { if (dataSource !== "board") setUnmappedBoardFields([]); }, [dataSource]);
  useEffect(() => { if (!writeBoardId) setUnmappedBoardFields([]); }, [writeBoardId]);

  const canPreview =
    Boolean(context) && !isPreviewing &&
    ((dataSource === "file" && Boolean(uploadedFile)) || (dataSource === "board" && Boolean(selectedBoardId)));

  useEffect(() => {
    if (dataSource !== "board" || !mondayClient) return;
    setFileColumns([]);
    let cancelled = false;
    (async () => {
      try {
        setLoadingBoards(true); setBoardsError(null);
        const boardsList = await loadBoards();
        if (!cancelled) setBoards(boardsList);
      } catch (error) {
        if (!cancelled) { setBoards([]); setBoardsError((error as Error).message ?? "Failed to load boards."); }
      } finally {
        if (!cancelled) setLoadingBoards(false);
      }
    })();
    return () => { cancelled = true; };
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
    if (!writeBoardId) return;
    const matching = boards.find((b) => b.id === writeBoardId);
    if (matching && matching.name !== writeBoardName) setWriteBoardName(matching.name);
  }, [boards, writeBoardId, writeBoardName]);

  // Auto-map as columns appear
  useEffect(() => {
    if (!preparedRecipe) return;
    if (Object.keys(boardColumnNames).length === 0 && fileColumns.length === 0) return;
    setPreparedRecipe((prev) => {
      if (!prev) return prev;
      const clone = structuredClone(prev);
      const write = clone.steps.find((s): s is WriteBackStep => s.type === "write_back");
      if (!write) return clone;
      const normalize = (s: string) =>
        s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
      const allTargets = dataSource === "board" ? Object.values(boardColumnNames) : fileColumns;
      for (const sourceField of allTargets) {
        const alreadyMapped = write.config.columnMapping?.[sourceField];
        if (alreadyMapped) continue;
        const normalizedSource = normalize(sourceField);
        const autoMatch = Object.entries(boardColumnNames).find(([, name]) => {
          const n = normalize(name);
          return n === normalizedSource || n.startsWith(normalizedSource) || normalizedSource.startsWith(n) || n.includes(normalizedSource) || normalizedSource.includes(n);
        });
        if (autoMatch) {
          const [autoId, name] = autoMatch;
          write.config.columnMapping = { ...(write.config.columnMapping ?? {}), [sourceField]: autoId };
        }
      }
      return clone;
    });
  }, [boardColumnNames, fileColumns, dataSource, preparedRecipe]);

  /** ---------------------------
   * NEW: Stepper state + progress
   * -------------------------- */
  const [step, setStep] = useState(1);
  const next = () => setStep((s) => Math.min(4, s + 1));
  const back = () => setStep((s) => Math.max(1, s - 1));
  const progress = (step / 4) * 100;

  /** ---------------------------
   * UI
   * -------------------------- */
  return (
    <div className="mx-auto w-full max-w-6xl flex flex-col gap-8 px-6 py-10 bg-[#F6F8FB]">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-[#1A1C1E]">Data Standardization Toolkit</h1>
        <p className="text-sm text-[#6B7280]">
          Guided flow to clean, preview, and sync your data with monday.com.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {context && (<UsageBadge used={context.usage.rowsProcessed} cap={context.flags.rowCap} />)}
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/monday" target="_blank" rel="noopener noreferrer">Auth</Link>
          </Button>
        </div>
        {contextError && <p className="text-sm text-destructive">{contextError}</p>}
      </header>

      {/* Progress */}
      <div className="flex items-center gap-4">
        <div className="h-2 bg-[#E6E9EF] rounded-full overflow-hidden w-full">
          <div className="h-full bg-[#1F76F0] transition-all" style={{ width: `${progress}%` }} />
        </div>
        <span className="text-xs text-[#6B7280] font-medium uppercase">Step {step} of 4</span>
      </div>

      <PlanGate allowed plan={context?.plan ?? "free"} feature="fuzzy deduplication" onUpgrade={() => setToast({ message: "Upgrade to unlock fuzzy dedupe.", variant: "default" })}>
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22 }}
          className="space-y-8"
        >
          {/* STEP 1: Source */}
          {step === 1 && (
            <Card className="border border-[#E5E7EB] shadow-sm rounded-2xl">
              <CardHeader>
                <CardTitle className="text-xl text-[#1A1C1E]">Step 1: Choose Data Source</CardTitle>
                <CardDescription className="text-[#6B7280]">Upload a file or connect to a monday board.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-3">
                  <Button
                    variant={dataSource === "file" ? "default" : "outline"}
                    className={dataSource === "file" ? "bg-[#1F76F0] hover:bg-[#175CD3]" : ""}
                    onClick={() => setDataSource("file")}
                  >
                    Upload CSV/XLSX
                  </Button>
                  <Button
                    variant={dataSource === "board" ? "default" : "outline"}
                    className={dataSource === "board" ? "bg-[#1F76F0] hover:bg-[#175CD3]" : ""}
                    onClick={() => setDataSource("board")}
                  >
                    monday.com Board
                  </Button>
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
                        void extractColumnsFromFile(file).then((columns) => { setFileColumns(columns ?? []); });
                        setToast({ message: `Loaded ${file.name}`, variant: "success" });
                      }}
                    />
                    {uploadedFile && (
                      <p className="text-xs text-muted-foreground truncate">Ready: {uploadedFile.name}</p>
                    )}
                  </>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="board-select">Board</Label>
                    <div className="flex gap-2">
                      <Select
                        id="board-select"
                        value={selectedBoardId}
                        onChange={(e) => {
                          const value = e.target.value;
                          setSelectedBoardId(value);
                          void handleWriteBoardSelect(value);
                        }}
                        disabled={isPreparingWriteBoard}
                      >
                        <option value="">Select a board</option>
                        {boards.map((board) => (
                          <option key={board.id} value={board.id}>
                            {board.name}{board.workspaceName ? ` - ${board.workspaceName}` : ""}
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
                    {boardsError && <p className="text-xs text-destructive">{boardsError}</p>}
                    {sourceBoard && (
                      <p className="text-xs text-muted-foreground">
                        Previewing data from <strong>{sourceBoard.boardName}</strong>
                      </p>
                    )}
                  </div>
                )}

                <div className="flex justify-end">
                  <Button
                    disabled={
                      (dataSource === "file" && !uploadedFile) ||
                      (dataSource === "board" && !selectedBoardId)
                    }
                    onClick={next}
                    className="bg-[#1F76F0] text-white hover:bg-[#175CD3]"
                  >
                    Next → Preview
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* STEP 2: Preview */}
          {step === 2 && (
            <Card className="border border-[#E5E7EB] shadow-sm rounded-2xl">
              <CardHeader>
                <CardTitle className="text-xl text-[#1A1C1E]">Step 2: Preview Data</CardTitle>
                <CardDescription className="text-[#6B7280]">Review sample rows before applying transformations.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-2">
                  <Button
                    disabled={!canPreview}
                    onClick={() => {
                      if (!context || isPreviewing) return;
                      if (dataSource === "board") {
                        if (!selectedBoardId) { setToast({ message: "Select a board to preview.", variant: "error" }); return; }
                        void (async () => {
                          setIsPreviewing(true);
                          try {
                            const sessionToken = await getSessionToken();
                            const response = await fetch("/api/recipes/run/preview", {
                              method: "POST",
                              headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
                              body: JSON.stringify({
                                source: { type: "board", boardId: selectedBoardId },
                                recipe: buildRecipeWithStandardization(preparedRecipe ?? BLANK_RECIPE),
                                plan: context.plan
                              })
                            });
                            if (!response.ok) throw new Error(await response.text());
                            const result = (await response.json()) as PreviewResponse;
                            const previewBoardColumns = (result.columns ?? []).filter(
                              (c): c is { id: string; title: string } => Boolean(c.id)
                            );
                            if (previewBoardColumns.length > 0) {
                              const mapped = previewBoardColumns.reduce<Record<string, string>>((acc, c) => {
                                acc[c.id] = c.title ?? c.id; return acc;
                              }, {});
                              setBoardColumnNames(mapped);
                            }
                            setPreview(result);
                            setSourceBoard(result.sourceBoard ?? null);
                            const prepared =
                              result.preparedRecipe ??
                              (result.sourceBoard ? null : buildRecipeWithStandardization(BLANK_RECIPE));
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
                            setToast({ message: `Preview ready${result.sourceBoard ? ` for ${result.sourceBoard.boardName}` : ""}`, variant: "success" });
                          } catch (error) {
                            setToast({ message: (error as Error).message, variant: "error" });
                          } finally {
                            setIsPreviewing(false);
                          }
                        })();
                        return;
                      }

                      if (!uploadedFile) { setToast({ message: "Upload a file to preview.", variant: "error" }); return; }
                      void (async () => {
                        setIsPreviewing(true);
                        try {
                          const sessionToken = await getSessionToken();
                          const formData = new FormData();
                          formData.set("file", uploadedFile);
                          formData.set("tenantId", context.tenantId);
                          formData.set("recipe", JSON.stringify(buildRecipeWithStandardization(preparedRecipe ?? BLANK_RECIPE)));
                          formData.set("plan", context.plan);
                          const response = await fetch("/api/recipes/run/preview", {
                            method: "POST",
                            headers: { Authorization: `Bearer ${sessionToken}` },
                            body: formData
                          });
                          if (!response.ok) throw new Error(await response.text());
                          const result = (await response.json()) as PreviewResponse;
                          setPreview(result);
                          applyPreparedRecipe(result.preparedRecipe ?? buildRecipeWithStandardization(BLANK_RECIPE));
                          setSourceBoard(null);
                          if (result.columns && result.columns.length > 0) {
                            const columns = result.columns.map((c) => c.title).filter((t): t is string => Boolean(t));
                            if (columns.length > 0) setFileColumns(Array.from(new Set(columns)));
                          } else if (result.rows.length > 0) {
                            const rowColumns = Object.keys(result.rows[0]).filter(Boolean);
                            if (rowColumns.length > 0) setFileColumns(Array.from(new Set(rowColumns)));
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
                    {isPreviewing ? "Processing..." : "Run preview"}
                  </Button>

                  {dataSource === "board" && writeBoardId && (
                    <Button variant="outline" size="sm" onClick={ensureBoardColumns}>
                      Sync board columns
                    </Button>
                  )}
                </div>

                {preview ? (
                  <DataGridPreview rows={preview.rows} diff={preview.diff} errors={preview.errors} />
                ) : (
                  <div className="p-8 border border-dashed rounded-xl text-center text-gray-500 bg-gray-50">
                    Run preview to load your data
                  </div>
                )}

                <div className="flex justify-between">
                  <Button variant="ghost" onClick={back}>← Back</Button>
                  <Button onClick={next} className="bg-[#1F76F0] text-white hover:bg-[#175CD3]">Next → Configure Rules</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* STEP 3: Standardize */}
          {step === 3 && (
            <Card className="border border-[#E5E7EB] shadow-sm rounded-2xl">
              <CardHeader>
                <CardTitle className="text-xl text-[#1A1C1E]">Step 3: Configure Standardization</CardTitle>
                <CardDescription className="text-[#6B7280]">Choose which cleaning or formatting rules to apply to each field.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {standardizationTargets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Load a data source to enable standardization options.</p>
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
                              <label key={`${target.field}-${rule.id}`} className="flex items-start gap-2 text-xs leading-tight">
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

                <div className="flex justify-between">
                  <Button variant="ghost" onClick={back}>← Back</Button>
                  <Button onClick={next} className="bg-[#1F76F0] text-white hover:bg-[#175CD3]">Next → Write / Export</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* STEP 4: Write / Export */}
          {step === 4 && (
            <Card className="border border-[#E5E7EB] shadow-sm rounded-2xl">
              <CardHeader>
                <CardTitle className="text-xl text-[#1A1C1E]">Step 4: Write & Export</CardTitle>
                <CardDescription className="text-[#6B7280]">Select destination, map columns, run write-back or export CSV.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Destination board selector */}
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
                          {board.name}{board.workspaceName ? ` - ${board.workspaceName}` : ""}
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
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <Input
                      value={newBoardName}
                      onChange={(e) => setNewBoardName(e.target.value)}
                      placeholder="New board name"
                      className="sm:flex-1"
                      disabled={isCreatingBoard || isPreparingWriteBoard || isSeedingBoard}
                    />
                    <div className="flex items-center gap-2">
                      <Select
                        value={seedSourceMode}
                        onChange={(e) => setSeedSourceMode(e.target.value as "preview" | "original")}
                        className="w-40"
                        disabled={!uploadedFile && seedSourceMode === "original"}
                      >
                        <option value="preview">Seed from preview</option>
                        <option value="original">Seed from original CSV</option>
                      </Select>
                      <Button
                        type="button"
                        size="sm"
                        onClick={handleCreateBoard}
                        disabled={isCreatingBoard || isPreparingWriteBoard || isSeedingBoard || !newBoardName.trim()}
                      >
                        {isCreatingBoard ? "Creating..." : isSeedingBoard ? "Seeding..." : "Create board"}
                      </Button>
                    </div>
                  </div>

                  {isPreparingWriteBoard && (<p className="text-xs text-muted-foreground">Preparing board mapping…</p>)}
                  {writeBoardError && (<p className="text-xs text-destructive">{writeBoardError}</p>)}
                  {writeBoardId && writeBoardName && !writeBoardError && !isPreparingWriteBoard && (
                    <p className="text-xs text-muted-foreground">Writing to <strong>{writeBoardName}</strong></p>
                  )}
                </div>

                {/* Column Mapping (unchanged logic, improved container) */}
                {(() => {
                  const sourceFields =
                    dataSource === "board" && Object.keys(boardColumnNames).length > 0
                      ? Object.values(boardColumnNames)
                      : fileColumns;

                  return (
                    <div className="space-y-3">
                      <Label>Column Mapping</Label>
                      {/* Column comparison summary and auto-apply */}
                      {columnComparison && (
                        <div className="p-3 border rounded-md bg-white">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-sm font-medium">Column comparison with write board</p>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                className="px-2 py-1 text-xs bg-blue-600 text-white rounded"
                                onClick={() => {
                                  // Auto-apply matched mappings into preparedRecipe
                                  const mapping: Record<string, string> = {};
                                  for (const m of columnComparison.matches) {
                                    const boardId = columnComparison.boardNameToId[m.board];
                                    if (boardId) mapping[m.file] = boardId;
                                  }
                                  if (Object.keys(mapping).length === 0) {
                                    setToast({ message: "No matched columns to apply.", variant: "default" });
                                    return;
                                  }
                                  setPreparedRecipe((prev) => {
                                    if (!prev) return prev;
                                    const clone = structuredClone(prev);
                                    const write = clone.steps.find((s): s is WriteBackStep => s.type === "write_back");
                                    if (!write) return clone;
                                    write.config.columnMapping = { ...(write.config.columnMapping ?? {}), ...mapping };
                                    return clone;
                                  });
                                  setToast({ message: `Applied ${Object.keys(mapping).length} matched mappings.`, variant: "success" });
                                }}
                              >
                                Auto-apply matched mappings
                              </button>
                            </div>
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-sm">
                            <div>
                              <p className="text-xs font-semibold">Matched</p>
                              {columnComparison.matches.length === 0 ? <p className="text-xs text-muted-foreground">—</p> : columnComparison.matches.map((m) => (
                                <div key={m.file} className="flex justify-between">
                                  <span className="truncate">{m.file}</span>
                                  <span className="text-muted-foreground">{m.board}</span>
                                </div>
                              ))}
                            </div>
                            <div>
                              <p className="text-xs font-semibold">Unmatched file columns</p>
                              {columnComparison.unmatchedFile.length === 0 ? <p className="text-xs text-muted-foreground">—</p> : columnComparison.unmatchedFile.map((f) => (
                                <div key={f} className="truncate">{f}</div>
                              ))}
                            </div>
                            <div>
                              <p className="text-xs font-semibold">Unmatched board columns</p>
                              {columnComparison.unmatchedBoard.length === 0 ? <p className="text-xs text-muted-foreground">—</p> : columnComparison.unmatchedBoard.map((b) => (
                                <div key={b} className="truncate">{b}</div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                      {/* Unique rows panel */}
                      {existingBoardKeys && preview && preview.rows && preview.rows.length > 0 && (
                        <div className="p-3 border rounded-md bg-white mt-3">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-sm font-medium">Unique rows vs board</p>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                className="px-2 py-1 text-xs bg-green-600 text-white rounded"
                                onClick={() => runWriteBackUnique()}
                                disabled={isExecuting}
                              >
                                {isExecuting ? "Running..." : `Run write-back (${uniquePreviewRows.length} unique)`}
                              </button>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">{uniquePreviewRows.length} of {preview.rows.length} preview rows appear unique (not yet present on the selected board).</p>
                          <details className="mt-2">
                            <summary className="text-xs">Show sample unique rows</summary>
                            <div className="mt-2 text-xs max-h-40 overflow-auto">
                              {uniquePreviewRows.slice(0, 20).map((r, i) => (
                                <pre key={i} className="whitespace-pre-wrap text-[11px]">{JSON.stringify(r, null, 2)}</pre>
                              ))}
                            </div>
                          </details>
                        </div>
                      )}
                      <div className="grid gap-2">
                        {sourceFields.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No source fields found — upload a file or preview data first.</p>
                        ) : (
                          sourceFields.map((sourceField) => {
                            const writeStep = preparedRecipe?.steps.find((s): s is WriteBackStep => s.type === "write_back");
                            const selected = writeStep?.config?.columnMapping?.[sourceField] ?? "";
                            return (
                              <div key={sourceField} className="flex items-center justify-between gap-2 border rounded-md px-2 py-1 bg-white">
                                <span className="text-sm">{sourceField}</span>
                                <Select
                                  value={selected}
                                  onChange={(e) => {
                                    const newId = e.target.value;
                                    setPreparedRecipe((prev) => {
                                      if (!prev) return prev;
                                      const clone = structuredClone(prev);
                                      const write = clone.steps.find((s): s is WriteBackStep => s.type === "write_back");
                                      if (!write) return clone;
                                      write.config.columnMapping = { ...(write.config.columnMapping ?? {}), [sourceField]: newId };
                                      return clone;
                                    });
                                  }}
                                >
                                  <option value="">— select monday column —</option>
                                  {Object.entries(boardColumnNames).map(([id, name]) => (
                                    <option key={id} value={id}>{name}</option>
                                  ))}
                                </Select>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Diff */}
                {preview && <DiffViewer diff={preview.diff} />}

                {/* Actions */}
                <div className="flex flex-col md:flex-row gap-3">
                  <Button
                    variant="secondary"
                    disabled={!preview || !context || isExecuting || !writeBoardId || isPreparingWriteBoard}
                    onClick={() => {
                      if (!preview || !context || isExecuting) return;
                      if (!writeBoardId) {
                        setToast({ message: "Select a board to write to before running.", variant: "error" });
                        return;
                      }
                      void (async () => {
                        setIsExecuting(true);
                        try {
                          const sessionToken = await getSessionToken();
                          const baseRecipe = preparedRecipe ?? BLANK_RECIPE;
                          const recipeForExecution = buildRecipeWithStandardization(baseRecipe);
                          const writeStep = recipeForExecution.steps.find((s): s is WriteBackStep => s.type === "write_back");
                          if (!writeStep) throw new Error("Recipe missing write-back step.");
                          writeStep.config.boardId = writeBoardId;
                          if (!writeStep.config.columnMapping || Object.keys(writeStep.config.columnMapping).length === 0) {
                            setToast({ message: "Map at least one column before running the write-back.", variant: "error" });
                            return;
                          }
                          const response = await fetch("/api/recipes/run/execute", {
                            method: "POST",
                            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
                            body: JSON.stringify({ tenantId: context.tenantId, recipe: recipeForExecution, runId: preview.runId, previewRows: preview.rows, plan: context.plan })
                          });
                          if (!response.ok) throw new Error(await response.text());
                          const result = (await response.json()) as { rowsWritten: number };
                          setToast({ message: `Run complete. ${result.rowsWritten} rows processed.`, variant: "success" });
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

                  <Button
                    variant="outline"
                    disabled={!preview || isExecuting}
                    onClick={() => {
                      if (!preview || isExecuting) return;
                      void runCleanDedupe();
                    }}
                  >
                    {isExecuting ? "Working..." : "Clean duplicates"}
                  </Button>

                  <div className="flex items-center gap-2">
                    <Label>Export</Label>
                    <Select
                      value={exportMode}
                      onChange={(e) => setExportMode(e.target.value as "all" | "changed")}
                      className="w-48"
                    >
                      <option value="all">All rows</option>
                      <option value="changed">Changed rows only</option>
                    </Select>

                    <Button
                      onClick={() => {
                        if (!preview || !preview.rows || preview.rows.length === 0) {
                          setToast({ message: "No data to export.", variant: "error" });
                          return;
                        }
                        const rowsToExport =
                          exportMode === "all"
                            ? preview.rows
                            : (() => {
                                const changed = new Set<number>(preview.diff.map((d) => d.rowIndex));
                                return preview.rows.filter((_, idx) => changed.has(idx));
                              })();
                        if (!rowsToExport || rowsToExport.length === 0) {
                          setToast({ message: "No rows match the selection.", variant: "error" });
                          return;
                        }
                        exportRowsToCSV(rowsToExport, `standardized-${exportMode}.csv`);
                        setToast({ message: `Exported ${rowsToExport.length} rows.`, variant: "success" });
                      }}
                      disabled={!preview || isPreviewing || preview.rows.length === 0}
                      className="bg-[#1F76F0] text-white hover:bg-[#175CD3]"
                    >
                      Export to CSV
                    </Button>
                  </div>

                  <div className="ml-auto flex gap-2">
                    <Button variant="ghost" onClick={back}>← Back</Button>
                    <Button variant="link" onClick={() => setStep(1)}>Start Over</Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </motion.div>
      </PlanGate>

      <Toast message={toast?.message ?? null} variant={toast?.variant} />
    </div>
  );
}
