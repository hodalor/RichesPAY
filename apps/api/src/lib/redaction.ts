import type { Json, JsonArray, JsonObject, JsonValue } from "../db/types";

const REDACTED = "[REDACTED]";
const emailLikeKeys = new Set(["email", "support_email"]);
const phoneLikeKeys = new Set([
  "msisdn",
  "phone",
  "phone_number",
  "recipient",
  "support_phone",
  "to"
]);
const secretLikeKeys = new Set([
  "access_token",
  "api_key",
  "authorization",
  "card",
  "card_number",
  "client_secret",
  "code",
  "cvv",
  "encryption_key",
  "key_hash",
  "otp",
  "password",
  "pin",
  "refresh_token",
  "secret",
  "token",
  "webhook_secret"
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
  if (normalizedKey && isSecretLikeKey(normalizedKey)) {
    return REDACTED;
  }

  if (normalizedKey && isEmailLikeKey(normalizedKey)) {
    return maskEmail(value);
  }

  if (normalizedKey && isPhoneLikeKey(normalizedKey)) {
    return maskPhone(value);
  }

  return value;
}

function isEmailLikeKey(key: string) {
  return emailLikeKeys.has(key) || key.endsWith("_email");
}

function isPhoneLikeKey(key: string) {
  return (
    phoneLikeKeys.has(key) ||
    key.endsWith("_phone") ||
    key.endsWith("_msisdn")
  );
}

function isSecretLikeKey(key: string) {
  return (
    secretLikeKeys.has(key) ||
    key.endsWith("_secret") ||
    key.endsWith("_token") ||
    key.endsWith("_password")
  );
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
