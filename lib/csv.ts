import Papa from "papaparse";
import * as XLSX from "xlsx";

export type ParsedTable = {
  headers: string[];
  rows: Record<string, unknown>[];
};

export function parseTableFile(buffer: Buffer, fileName: string): ParsedTable {
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "xlsx" || extension === "xls") {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new Error("The uploaded workbook does not contain any sheets.");
    }
    const sheet = workbook.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
    const headerRows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });
    const headers = Array.isArray(headerRows[0]) ? (headerRows[0] as string[]) : Object.keys(json[0] ?? {});
    return {
      headers,
      rows: json
    };
  }

  const result = Papa.parse<Record<string, unknown>>(buffer.toString("utf8"), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false
  });

  if (result.errors.length > 0) {
    throw new Error(`Failed to parse CSV: ${result.errors[0].message}`);
  }

  const headers = result.meta.fields ?? [];
  return {
    headers,
    rows: result.data
  };
}

export function toCsv(rows: Record<string, unknown>[]): string {
  return Papa.unparse(rows);
}
