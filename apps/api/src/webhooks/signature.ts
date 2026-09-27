import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function createPlainWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

export function signWebhookPayload(
  secret: string,
  rawBody: string,
  timestamp: number
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
}

export function buildWebhookSignatureHeader(
  secret: string,
  rawBody: string,
  timestamp = Math.floor(Date.now() / 1000)
): string {
  return `t=${timestamp},v1=${signWebhookPayload(secret, rawBody, timestamp)}`;
}

export function constantTimeWebhookSignatureMatch(
  expectedHex: string,
  actualHex: string
): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
