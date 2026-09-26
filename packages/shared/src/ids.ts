import { ulid } from "ulid";

export function newId(prefix: string): string {
  const normalizedPrefix = prefix.endsWith("_") ? prefix : `${prefix}_`;
  return `${normalizedPrefix}${ulid()}`;
}
