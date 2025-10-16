import { parse as parseDate, format as formatDate } from "date-fns";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { CountryCode } from "libphonenumber-js";
import type { RecipeRow, DiffEntry } from "../index";

type FormatOperation =
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
  | { kind: "normalize_percentage" }
  | { kind: "remove_special_characters" }
  | {
      kind: "split_name";
      firstNameField?: string;
      lastNameField?: string;
    }
  | { kind: "normalize_address" }
  | { kind: "sanitize_html" };

type FormatConfig = {
  operations: Array<{
    field: string;
    op: FormatOperation;
  }>;
};

const COUNTRY_MAP: Record<string, string> = {
  usa: "US",
  "united states": "US",
  "united states of america": "US",
  uk: "GB",
  "united kingdom": "GB",
  britain: "GB",
  canada: "CA",
  mexico: "MX",
  france: "FR",
  germany: "DE",
  australia: "AU",
  india: "IN",
  brazil: "BR"
};

const STATE_MAP: Record<string, Record<string, string>> = {
  US: {
    alabama: "AL",
    alaska: "AK",
    arizona: "AZ",
    arkansas: "AR",
    california: "CA",
    colorado: "CO",
    connecticut: "CT",
    delaware: "DE",
    florida: "FL",
    georgia: "GA",
    hawaii: "HI",
    idaho: "ID",
    illinois: "IL",
    indiana: "IN",
    iowa: "IA",
    kansas: "KS",
    kentucky: "KY",
    louisiana: "LA",
    maine: "ME",
    maryland: "MD",
    massachusetts: "MA",
    michigan: "MI",
    minnesota: "MN",
    mississippi: "MS",
    missouri: "MO",
    montana: "MT",
    nebraska: "NE",
    nevada: "NV",
    "new hampshire": "NH",
    "new jersey": "NJ",
    "new mexico": "NM",
    "new york": "NY",
    "north carolina": "NC",
    "north dakota": "ND",
    ohio: "OH",
    oklahoma: "OK",
    oregon: "OR",
    pennsylvania: "PA",
    "rhode island": "RI",
    "south carolina": "SC",
    "south dakota": "SD",
    tennessee: "TN",
    texas: "TX",
    utah: "UT",
    vermont: "VT",
    virginia: "VA",
    washington: "WA",
    "west virginia": "WV",
    wisconsin: "WI",
    wyoming: "WY"
  },
  CA: {
    ontario: "ON",
    quebec: "QC",
    "nova scotia": "NS",
    "new brunswick": "NB",
    manitoba: "MB",
    "british columbia": "BC",
    "prince edward island": "PE",
    saskatchewan: "SK",
    alberta: "AB",
    "newfoundland and labrador": "NL"
  }
};

export function formatRows(rows: RecipeRow[], config: FormatConfig): {
  rows: RecipeRow[];
  diff: DiffEntry[];
} {
  const diff: DiffEntry[] = [];
  const formatted = rows.map((row, rowIndex) => {
    const next = { ...row };

    for (const op of config.operations) {
      const current = next[op.field];
      const nextValue = applyOperation(next, rowIndex, op, diff);
      if (nextValue !== current) {
        next[op.field] = nextValue;
      }
    }

    return next;
  });

  return { rows: formatted, diff };
}

function applyOperation(
  row: RecipeRow,
  rowIndex: number,
  operation: { field: string; op: FormatOperation },
  diff: DiffEntry[]
) {
  const { field, op } = operation;
  const value = row[field];

  switch (op.kind) {
    case "trim_collapse_whitespace": {
      if (typeof value !== "string") return value;
      const formatted = collapseWhitespace(value);
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "boolean_standardize": {
      const formatted = standardizeBoolean(value);
      if (formatted === undefined) {
        return value;
      }
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "timezone_to_utc": {
      if (value === null || value === undefined) {
        return value;
      }
      const formatted = toUtcString(value);
      if (formatted === null) {
        return value;
      }
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "slugify": {
      if (typeof value !== "string") {
        return value;
      }
      const formatted = slugifyValue(value, op.separator ?? "-");
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "round_numeric": {
      const formatted = roundNumericValue(value, op.precision ?? 2);
      if (formatted === undefined) {
        return value;
      }
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "normalize_percentage": {
      const formatted = normalizePercentageValue(value);
      if (formatted === undefined) {
        return value;
      }
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "remove_special_characters": {
      if (typeof value !== "string") {
        return value;
      }
      const formatted = removeSpecialCharacters(value);
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "split_name": {
      if (typeof value !== "string") {
        return value;
      }
      const normalized = collapseWhitespace(value);
      const parts = normalized.split(" ").filter((part) => part.length > 0);
      const first = parts[0] ?? "";
      const last = parts.length > 1 ? parts.slice(1).join(" ") : "";
      const firstField = resolveNameField(field, op.firstNameField, "first");
      const lastField = resolveNameField(field, op.lastNameField, "last");

      if (firstField) {
        const before = row[firstField];
        if (before !== first) {
          recordDiff(diff, rowIndex, firstField, before, first || null);
          row[firstField] = first || null;
        }
      }
      if (lastField) {
        const before = row[lastField];
        const normalizedLast = last || null;
        if (before !== normalizedLast) {
          recordDiff(diff, rowIndex, lastField, before, normalizedLast);
          row[lastField] = normalizedLast;
        }
      }

      recordDiff(diff, rowIndex, field, value, normalized);
      return normalized;
    }
    case "normalize_address": {
      if (typeof value !== "string") {
        return value;
      }
      const formatted = normalizeAddress(value);
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "sanitize_html": {
      if (typeof value !== "string") {
        return value;
      }
      const formatted = sanitizeHtmlValue(value);
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "title_case": {
      if (typeof value !== "string") return value;
      const formatted = value
        .toLowerCase()
        .split(/\s+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "email_normalize": {
      if (typeof value !== "string") return value;
      const lower = value.toLowerCase();
      const [local, domain] = lower.split("@");
      const normalizedLocal = local?.split("+")[0]?.replace(/\./g, "") ?? local;
      const formatted = domain ? `${normalizedLocal}@${domain}` : lower;
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "phone_e164": {
      if (typeof value !== "string") return value;
      const defaultCountry = (op.defaultCountry ?? "US").toUpperCase() as CountryCode;
      const phone = parsePhoneNumberFromString(value, defaultCountry);
      if (!phone) return value;
      const formatted = phone.format("E.164");
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "date_parse": {
      if (!value) return value;
      const parsed =
        typeof value === "string"
          ? op.inputFormat
            ? parseDate(value, op.inputFormat, new Date())
            : new Date(value)
          : value instanceof Date
          ? value
          : null;
      if (!parsed || Number.isNaN(parsed.getTime())) {
        return value;
      }
      const outputFormat = op.outputFormat ?? "yyyy-MM-dd";
      const formatted = formatDate(parsed, outputFormat);
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "iso_country": {
      if (typeof value !== "string") return value;
      const normalized = value.trim().toLowerCase();
      const formatted = COUNTRY_MAP[normalized] ?? value.toUpperCase();
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "iso_state": {
      if (typeof value !== "string") return value;
      const countryValue = op.countryField ? row[op.countryField] : "US";
      const country = typeof countryValue === "string" ? countryValue.toUpperCase() : "US";
      const states = STATE_MAP[country];
      const normalized = value.trim().toLowerCase();
      const formatted = states?.[normalized] ?? value.toUpperCase();
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "currency_code": {
      if (typeof value !== "string") return value;
      const formatted = value.trim().slice(0, 3).toUpperCase();
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    case "number_parse": {
      if (typeof value !== "string" && typeof value !== "number") return value;
      const formatted = parseLocalizedNumber(value, op.locale ?? "en-US");
      if (formatted === value) {
        return value;
      }
      recordDiff(diff, rowIndex, field, value, formatted);
      return formatted;
    }
    default:
      return value;
  }
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

const TRUTHY_VALUES = new Set([
  "true",
  "t",
  "yes",
  "y",
  "1",
  "on"
]);
const FALSY_VALUES = new Set([
  "false",
  "f",
  "no",
  "n",
  "0",
  "off"
]);

function standardizeBoolean(value: unknown): boolean | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 0) return false;
    if (value === 1) return true;
    return value > 0 ? true : value < 0 ? false : undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    if (TRUTHY_VALUES.has(normalized)) {
      return true;
    }
    if (FALSY_VALUES.has(normalized)) {
      return false;
    }
    const numeric = Number.parseFloat(normalized);
    if (!Number.isNaN(numeric)) {
      if (numeric === 0) return false;
      if (numeric === 1) return true;
      return numeric > 0 ? true : numeric < 0 ? false : undefined;
    }
  }
  return undefined;
}

function toUtcString(value: unknown): string | null {
  let date: Date | null = null;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "number") {
    date = new Date(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      date = parsed;
    }
  }
  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }
  const iso = date.toISOString();
  return iso.endsWith(".000Z") ? iso.replace(".000Z", "Z") : iso;
}

function slugifyValue(value: string, separator: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^${separator}+|${separator}+$`, "g"), "");
  return slug || normalized.replace(/\s+/g, separator).trim();
}

function roundNumericValue(value: unknown, precision: number): number | undefined {
  const safePrecision = Number.isInteger(precision) ? Math.max(0, precision) : 2;
  let numeric: number | null = null;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const negativeViaParens = /^\(.*\)$/.test(trimmed);
    let sanitized = trimmed.replace(/[^0-9.,\-]/g, "");
    if (negativeViaParens) {
      sanitized = sanitized.replace(/[()]/g, "");
    }
    if (!sanitized) {
      return undefined;
    }
    const hasComma = sanitized.includes(",");
    const hasDot = sanitized.includes(".");
    if (hasComma && hasDot) {
      if (sanitized.lastIndexOf(",") > sanitized.lastIndexOf(".")) {
        sanitized = sanitized.replace(/\./g, "").replace(/,/g, ".");
      } else {
        sanitized = sanitized.replace(/,/g, "");
      }
    } else if (hasComma && !hasDot) {
      sanitized = sanitized.replace(/,/g, ".");
    } else {
      sanitized = sanitized.replace(/,/g, "");
    }
    const parsed = Number.parseFloat(sanitized);
    if (!Number.isNaN(parsed)) {
      numeric = negativeViaParens ? -parsed : parsed;
    }
  }
  if (numeric === null || !Number.isFinite(numeric)) {
    return undefined;
  }
  return Number(numeric.toFixed(safePrecision));
}

function normalizePercentageValue(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    if (value > 1 && value <= 100) {
      return Number((value / 100).toFixed(6));
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const hasPercent = trimmed.endsWith("%");
    const numericPart = trimmed.replace(/%/g, "");
    const parsed = Number.parseFloat(numericPart);
    if (Number.isNaN(parsed)) {
      return undefined;
    }
    const normalized = hasPercent || (parsed > 1 && parsed <= 100) ? parsed / 100 : parsed;
    return Number(normalized.toFixed(6));
  }
  return undefined;
}

function removeSpecialCharacters(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u2060\uFEFF]/g, "");
}

function resolveNameField(
  field: string,
  override: string | undefined,
  part: "first" | "last"
): string | null {
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  const suffix = part === "first" ? "first_name" : "last_name";
  if (!field) {
    return suffix;
  }
  const withoutName = field.replace(/name$/i, "").replace(/[_\s]+$/g, "");
  const withoutFull = withoutName.replace(/full$/i, "").replace(/[_\s]+$/g, "");
  const base = withoutFull.length > 0 ? withoutFull : withoutName;
  if (!base) {
    return suffix;
  }
  const sanitizedBase = base.endsWith("_") ? base.slice(0, -1) : base;
  const normalizedBase = sanitizedBase.toLowerCase() === "full" ? "" : sanitizedBase;
  const prefix = normalizedBase ? `${normalizedBase}_` : "";
  return `${prefix}${suffix}`;
}

function normalizeAddress(value: string): string {
  const trimmed = collapseWhitespace(value);
  if (!trimmed) {
    return trimmed;
  }
  const segments = trimmed.split(",").map((segment) => segment.trim()).filter(Boolean);
  const formattedSegments = segments.map((segment, index) => {
    if (/^[A-Za-z]{2}$/.test(segment)) {
      return segment.toUpperCase();
    }
    const words = segment.split(/\s+/).map((word) => formatAddressWord(word, index === segments.length - 1));
    return words.join(" ");
  });
  return formattedSegments.join(", ");
}

const DIRECTIONAL_WORDS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw"]);

function formatAddressWord(word: string, isLastSegment: boolean): string {
  if (!word) {
    return word;
  }
  if (/^\d/.test(word)) {
    return word;
  }

  const match = word.match(/^([A-Za-z]+)(.*)$/);
  if (!match) {
    return word;
  }
  const [, letters, suffix] = match;
  const lowerLetters = letters.toLowerCase();

  if (isLastSegment && /^[A-Za-z]{2,3}$/.test(lowerLetters)) {
    return lowerLetters.toUpperCase() + suffix;
  }

  if (DIRECTIONAL_WORDS.has(lowerLetters)) {
    return lowerLetters.toUpperCase() + suffix;
  }

  if (lowerLetters.length <= 3) {
    const capitalized = lowerLetters.charAt(0).toUpperCase() + lowerLetters.slice(1);
    return capitalized + suffix;
  }

  const capitalized = lowerLetters.charAt(0).toUpperCase() + lowerLetters.slice(1);
  return capitalized + suffix;
}

function sanitizeHtmlValue(value: string): string {
  const stripped = value.replace(/<\/?[^>]+(>|$)/g, " ");
  return collapseWhitespace(stripped);
}

function parseLocalizedNumber(value: string | number, locale: string): number | string {
  if (typeof value === "number") {
    return value;
  }
  const example = new Intl.NumberFormat(locale).format(12345.6);
  const decimalSeparator = example.match(/[\d]+([^\d])[\d]+$/)?.[1] ?? ".";
  const groupSeparator = example.match(/(\D)\d{3}/)?.[1] ?? ",";

  const sanitized = value
    .replace(new RegExp(`\\${groupSeparator}`, "g"), "")
    .replace(new RegExp(`\\${decimalSeparator}`), ".");

  const numeric = Number.parseFloat(sanitized);
  return Number.isNaN(numeric) ? value : numeric;
}

function recordDiff(diff: DiffEntry[], rowIndex: number, field: string, before: unknown, after: unknown) {
  if (before === after) {
    return;
  }
  diff.push({
    rowIndex,
    field,
    before,
    after
  });
}
