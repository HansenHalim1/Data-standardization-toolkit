import { describe, expect, it } from "vitest";
import { formatRows } from "@/lib/recipe-engine/steps/format";

describe("formatRows", () => {
  it("normalizes email addresses", () => {
    const result = formatRows(
      [{ email: "Test.User+demo@example.com" }],
      {
        operations: [{ field: "email", op: { kind: "email_normalize" } }]
      }
    );
    expect(result.rows[0].email).toBe("testuser@example.com");
  });

  it("formats phone numbers to E.164", () => {
    const result = formatRows(
      [{ phone: "(415) 555-1234" }],
      {
        operations: [{ field: "phone", op: { kind: "phone_e164", defaultCountry: "US" } }]
      }
    );
    expect(result.rows[0].phone).toBe("+14155551234");
  });

  it("parses localized numbers", () => {
    const result = formatRows(
      [{ amount: "1.234,56" }],
      {
        operations: [{ field: "amount", op: { kind: "number_parse", locale: "de-DE" } }]
      }
    );
    expect(result.rows[0].amount).toBeCloseTo(1234.56);
  });
});
