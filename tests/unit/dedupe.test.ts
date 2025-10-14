import { describe, expect, it } from "vitest";
import { dedupeRows } from "@/lib/recipe-engine/steps/dedupe";

describe("dedupeRows", () => {
  it("removes exact duplicates", () => {
    const rows = [
      { email: "a@example.com" },
      { email: "a@example.com" }
    ];
    const result = dedupeRows(rows, { keys: ["email"] }, true);
    expect(result.rows).toHaveLength(1);
    expect(result.errors.some((error) => error.code === "dedupe_exact")).toBe(true);
  });

  it("applies fuzzy dedupe when allowed", () => {
    const rows = [
      { name: "Acme Inc." },
      { name: "Acme Incorporated" }
    ];
    const result = dedupeRows(
      rows,
      { keys: ["name"], fuzzy: { enabled: true, threshold: 0.85 } },
      true
    );
    expect(result.rows).toHaveLength(1);
    expect(result.errors.some((error) => error.code === "dedupe_fuzzy")).toBe(true);
  });

  it("respects plan gating for fuzzy matching", () => {
    const rows = [
      { name: "Acme Inc." },
      { name: "Acme Incorporated" }
    ];
    const result = dedupeRows(
      rows,
      { keys: ["name"], fuzzy: { enabled: true, threshold: 0.85 } },
      false
    );
    expect(result.rows).toHaveLength(2);
    expect(result.errors.some((error) => error.code === "dedupe_fuzzy_blocked")).toBe(true);
  });
});
