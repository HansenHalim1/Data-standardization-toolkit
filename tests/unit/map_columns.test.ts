import { describe, expect, it } from "vitest";
import { mapColumns } from "@/lib/recipe-engine/steps/map_columns";

describe("mapColumns", () => {
  it("maps columns according to configuration", () => {
    const rows = [{ FirstName: "Ada", LastName: "Lovelace" }];
    const result = mapColumns(rows, {
      mapping: {
        FirstName: "first_name",
        LastName: "last_name"
      }
    });

    expect(result[0]).toEqual({
      first_name: "Ada",
      last_name: "Lovelace"
    });
  });

  it("drops unknown columns when configured", () => {
    const rows = [{ FirstName: "Ada", Extra: "noop" }];
    const result = mapColumns(rows, { mapping: { FirstName: "first_name" }, dropUnknown: true });
    expect(result[0]).toEqual({ first_name: "Ada" });
  });
});
