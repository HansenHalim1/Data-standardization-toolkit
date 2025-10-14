import { randomUUID } from "crypto";

export function newId(): string {
  return randomUUID();
}

export function monthKey(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}
