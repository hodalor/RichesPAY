import type { Json, JsonArray, JsonObject, JsonValue } from "../db/types";

const REDACTED = "[REDACTED]";
const emailLikeKeys = new Set(["email", "support_email"]);
const phoneLikeKeys = new Set(["phone", "support_phone", "msisdn"]);
const secretLikeKeys = new Set([
  "authorization",
  "password",
  "card",
  "card_number",
  "cvv",
  "pin",
  "otp",
  "secret",
  "api_key",
  "key_hash"
]);

export function redactJsonValue(value: unknown): Json | null {
  if (value === undefined) {
    return null;
  }

  return redactUnknown(value) as Json;
}

function redactUnknown(value: unknown, parentKey?: string): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return redactPrimitive(value, parentKey);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, parentKey)) as JsonArray;
  }

  if (typeof value === "object") {
    const output: JsonObject = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      output[key] = redactUnknown(nestedValue, key);
    }

    return output;
  }

  return String(value);
}

function redactPrimitive(
  value: string | number | boolean | null,
  parentKey?: string
): JsonValue {
  if (typeof value !== "string") {
    return value;
  }

  const normalizedKey = parentKey?.toLowerCase();
  if (normalizedKey && secretLikeKeys.has(normalizedKey)) {
    return REDACTED;
  }

  if (normalizedKey && emailLikeKeys.has(normalizedKey)) {
    return maskEmail(value);
  }

  if (normalizedKey && phoneLikeKeys.has(normalizedKey)) {
    return maskPhone(value);
  }

  return value;
}

function maskEmail(email: string): string {
  const [localPart = "", domain = ""] = email.split("@");
  if (localPart.length <= 2) {
    return `${"*".repeat(Math.max(localPart.length, 1))}@${domain}`;
  }

  return `${localPart.slice(0, 2)}***@${domain}`;
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) {
    return "*".repeat(phone.length);
  }

  return `${"*".repeat(Math.max(phone.length - 4, 1))}${phone.slice(-4)}`;
}
