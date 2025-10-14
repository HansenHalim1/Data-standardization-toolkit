import { describe, expect, it } from "vitest";
import { validateRows } from "@/lib/recipe-engine/steps/validate";

describe("validateRows", () => {
  it("flags missing required fields", () => {
    const result = validateRows(
      [{ email: "" }],
      { rules: [{ kind: "required", field: "email" }] }
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("required");
  });

  it("enforces composite uniqueness", () => {
    const rows = [
      { first: "Ada", last: "Lovelace" },
      { first: "ada", last: "lovelace" }
    ];
    const result = validateRows(rows, {
      rules: [{ kind: "unique", composite: ["first", "last"] }]
    });
    expect(result.errors.find((error) => error.code === "unique")).toBeTruthy();
  });
});
