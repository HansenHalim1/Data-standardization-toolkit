import type { RecipeRow, RecipeError } from "../index";

type ValidateConfig = {
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

export function validateRows(rows: RecipeRow[], config: ValidateConfig): { errors: RecipeError[] } {
  const errors: RecipeError[] = [];
  const uniqueTrackers = config.rules
    .filter((rule): rule is Extract<(typeof config.rules)[number], { kind: "unique" }> => rule.kind === "unique")
    .map((rule) => ({
      fields: rule.composite,
      seen: new Map<string, number>()
    }));

  rows.forEach((row, rowIndex) => {
    for (const rule of config.rules) {
      switch (rule.kind) {
        case "required": {
          const value = row[rule.field];
          if (value === null || value === undefined || value === "") {
            errors.push({
              rowIndex,
              field: rule.field,
              code: "required",
              message: `${rule.field} is required`
            });
          }
          break;
        }
        case "regex": {
          const value = row[rule.field];
          if (!value) break;
          if (typeof value !== "string") {
            errors.push({
              rowIndex,
              field: rule.field,
              code: "regex_type",
              message: `${rule.field} must be a string for regex validation`
            });
            break;
          }
          const regex = new RegExp(rule.pattern);
          if (!regex.test(value)) {
            errors.push({
              rowIndex,
              field: rule.field,
              code: "regex",
              message: rule.message ?? `${rule.field} does not match expected pattern`
            });
          }
          break;
        }
        case "in_set": {
          const value = row[rule.field];
          if (value === null || value === undefined || value === "") {
            break;
          }
          const haystack = rule.values.map((entry) => entry.toLowerCase());
          if (!haystack.includes(String(value).toLowerCase())) {
            errors.push({
              rowIndex,
              field: rule.field,
              code: "in_set",
              message: `${rule.field} must be one of ${rule.values.join(", ")}`
            });
          }
          break;
        }
        case "unique":
          break;
        default:
          break;
      }
    }

    uniqueTrackers.forEach(({ fields, seen }) => {
      const signature = fields.map((field) => String(row[field] ?? "").toLowerCase()).join("|");
      if (!signature.trim()) {
        return;
      }
      if (seen.has(signature)) {
        errors.push({
          rowIndex,
          code: "unique",
          message: `Duplicate composite key for fields ${fields.join(", ")}`
        });
      } else {
        seen.set(signature, rowIndex);
      }
    });
  });

  return { errors };
}
