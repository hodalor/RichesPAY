const sensitiveKey = /authorization|card|cvv|email|otp|pan|password|phone|pin|secret|token/i;

export function scrubPii(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]")
      .replace(/\+[1-9]\d{7,14}\b/g, "[redacted-phone]")
      .replace(/\b\d{13,19}\b/g, "[redacted-pan]");
  }

  if (Array.isArray(value)) {
    return value.map((entry) => scrubPii(entry));
  }

  if (value && typeof value === "object") {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      scrubbed[key] = sensitiveKey.test(key) ? "[redacted]" : scrubPii(entry);
    }
    return scrubbed;
  }

  return value;
}
