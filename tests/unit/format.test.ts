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

  it("trims and collapses whitespace", () => {
    const result = formatRows(
      [{ company: "  ACME   Corporation  " }],
      {
        operations: [{ field: "company", op: { kind: "trim_collapse_whitespace" } }]
      }
    );
    expect(result.rows[0].company).toBe("ACME Corporation");
  });

  it("standardizes boolean values", () => {
    const result = formatRows(
      [{ active: "YES", archived: "0" }],
      {
        operations: [
          { field: "active", op: { kind: "boolean_standardize" } },
          { field: "archived", op: { kind: "boolean_standardize" } }
        ]
      }
    );
    expect(result.rows[0].active).toBe(true);
    expect(result.rows[0].archived).toBe(false);
  });

  it("normalizes datetimes to UTC", () => {
    const result = formatRows(
      [{ meeting: "2025-10-16T10:00:00+07:00" }],
      {
        operations: [{ field: "meeting", op: { kind: "timezone_to_utc" } }]
      }
    );
    expect(result.rows[0].meeting).toBe("2025-10-16T03:00:00Z");
  });

  it("slugifies text", () => {
    const result = formatRows(
      [{ project: "My Cool Project" }],
      {
        operations: [{ field: "project", op: { kind: "slugify", separator: "-" } }]
      }
    );
    expect(result.rows[0].project).toBe("my-cool-project");
  });

  it("rounds monetary values", () => {
    const result = formatRows(
      [{ price: "$1,234.567" }, { price: "1.234,567" }],
      {
        operations: [{ field: "price", op: { kind: "round_numeric", precision: 2 } }]
      }
    );
    expect(result.rows[0].price).toBe(1234.57);
    expect(result.rows[1].price).toBe(1234.57);
  });

  it("normalizes percentages", () => {
    const result = formatRows(
      [{ completion: "45%", ratio: "0.45" }],
      {
        operations: [
          { field: "completion", op: { kind: "normalize_percentage" } },
          { field: "ratio", op: { kind: "normalize_percentage" } }
        ]
      }
    );
    expect(result.rows[0].completion).toBeCloseTo(0.45);
    expect(result.rows[0].ratio).toBeCloseTo(0.45);
  });

  it("removes zero-width characters", () => {
    const result = formatRows(
      [{ name: "John\u200BDoe" }],
      {
        operations: [{ field: "name", op: { kind: "remove_special_characters" } }]
      }
    );
    expect(result.rows[0].name).toBe("JohnDoe");
  });

  it("splits full names into first and last", () => {
    const result = formatRows(
      [{ full_name: "Jane   Doe" }],
      {
        operations: [{ field: "full_name", op: { kind: "split_name" } }]
      }
    );
    expect(result.rows[0].full_name).toBe("Jane Doe");
    expect(result.rows[0].first_name).toBe("Jane");
    expect(result.rows[0].last_name).toBe("Doe");
  });

  it("normalizes addresses", () => {
    const result = formatRows(
      [{ address: "123 main st, ny" }],
      {
        operations: [{ field: "address", op: { kind: "normalize_address" } }]
      }
    );
    expect(result.rows[0].address).toBe("123 Main St, NY");
  });

  it("sanitizes HTML content", () => {
    const result = formatRows(
      [{ notes: "<b>Important</b> update" }],
      {
        operations: [{ field: "notes", op: { kind: "sanitize_html" } }]
      }
    );
    expect(result.rows[0].notes).toBe("Important update");
  });
});
