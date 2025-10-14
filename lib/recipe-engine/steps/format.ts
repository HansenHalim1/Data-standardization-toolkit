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
  | { kind: "number_parse"; locale?: string };

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
