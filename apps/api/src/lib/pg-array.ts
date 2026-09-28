export function parsePgTextArray(value: unknown): string[] {
  if (value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "{}") {
    return [];
  }

  const inner =
    trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed.slice(1, -1) : trimmed;
  const items: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const char of inner) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      if (current !== "") {
        items.push(current);
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current !== "") {
    items.push(current);
  }

  return items;
}
