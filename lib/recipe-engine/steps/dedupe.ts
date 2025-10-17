import type { RecipeRow, RecipeError, DiffEntry } from "../index";

type DedupeConfig = {
  keys: string[];
  fuzzy?: {
    enabled: boolean;
    threshold: number;
  };
};

type DedupeResult = {
  rows: RecipeRow[];
  errors: RecipeError[];
  diff: DiffEntry[];
};

export function dedupeRows(rows: RecipeRow[], config: DedupeConfig, allowFuzzy: boolean): DedupeResult {
  const { keys, fuzzy } = config;
  const errors: RecipeError[] = [];
  const diff: DiffEntry[] = [];

  const exactSeen = new Map<string, number>();
  const exactRows: RecipeRow[] = [];

  // Log signatures for debug
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "dedupe: computing exact signatures", keys }));
  } catch {}
  rows.forEach((row, rowIndex) => {
    const signature = keys.map((key) => String(row[key] ?? "").toLowerCase()).join("|");
    try {
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "debug", msg: "dedupe: row signature", rowIndex, signature }));
    } catch {}
    if (signature.trim() && exactSeen.has(signature)) {
      errors.push({
        rowIndex,
        code: "dedupe_exact",
        message: `Duplicate detected on keys ${keys.join(", ")}`
      });
    } else {
      exactSeen.set(signature, rowIndex);
      exactRows.push(row);
    }
  });

  if (!fuzzy?.enabled) {
    return { rows: exactRows, errors, diff };
  }

  if (fuzzy.enabled && !allowFuzzy) {
    errors.push({
      rowIndex: -1,
      code: "dedupe_fuzzy_blocked",
      message: "Fuzzy matching not enabled for this plan"
    });
    return { rows: exactRows, errors, diff };
  }

  const threshold = fuzzy.threshold ?? 0.9;
  const keep: RecipeRow[] = [];

  exactRows.forEach((row, index) => {
    const composite = keys.map((key) => normalizeValue(row[key])).join(" ").trim();
    if (!composite) {
      keep.push(row);
      return;
    }
    const existingIndex = keep.findIndex((candidate) => {
      const otherComposite = keys.map((key) => normalizeValue(candidate[key])).join(" ").trim();
      if (!otherComposite) return false;
      return similarity(composite, otherComposite) >= threshold;
    });
    if (existingIndex >= 0) {
      errors.push({
        rowIndex: index,
        code: "dedupe_fuzzy",
        message: `Fuzzy duplicate of row ${existingIndex}`
      });
      diff.push({
        rowIndex: index,
        field: "__dedupe__",
        before: row,
        after: keep[existingIndex]
      });
    } else {
      keep.push(row);
    }
  });

  return { rows: keep, errors, diff };
}

function normalizeValue(input: unknown): string {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const len1 = a.length;
  const len2 = b.length;
  if (len1 === 0 || len2 === 0) return 0;
  const matchDistance = Math.floor(Math.max(len1, len2) / 2) - 1;

  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j]) continue;
      if (a[i] !== b[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  const s1 = [];
  const s2 = [];
  for (let i = 0; i < len1; i++) {
    if (s1Matches[i]) {
      s1.push(a[i]);
    }
  }
  for (let i = 0; i < len2; i++) {
    if (s2Matches[i]) {
      s2.push(b[i]);
    }
  }

  let transpositions = 0;
  for (let i = 0; i < s1.length; i++) {
    if (s1[i] !== s2[i]) {
      transpositions++;
    }
  }
  transpositions /= 2;

  return (matches / len1 + matches / len2 + (matches - transpositions) / matches) / 3;
}

function similarity(a: string, b: string): number {
  const base = jaro(a, b);
  let prefix = 0;
  const maxPrefix = 4;
  while (prefix < maxPrefix && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  const scaling = 0.1;
  return base + prefix * scaling * (1 - base);
}
