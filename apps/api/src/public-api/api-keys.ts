import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { apiKeyKinds, apiKeyScopes, type ApiKeyKind, type ApiKeyScope } from "@richespay/shared";

import type { RpMode } from "../db/types";

export interface ParsedApiKey {
  kind: ApiKeyKind;
  mode: RpMode;
  value: string;
}

const API_KEY_PREFIX_LENGTH = 12;

export function createPlainApiKey(mode: RpMode, kind: ApiKeyKind): string {
  const suffix = randomBytes(24).toString("base64url");
  const keyKind = kind === "secret" ? "sk" : "pk";

  return `rp_${mode}_${keyKind}_${suffix}`;
}

export function parseApiKey(rawAuthorizationHeader: string | undefined): ParsedApiKey | null {
  if (!rawAuthorizationHeader?.startsWith("Bearer ")) {
    return null;
  }

  const value = rawAuthorizationHeader.slice("Bearer ".length).trim();
  const match = /^rp_(test|live)_(sk|pk)_[A-Za-z0-9_-]+$/.exec(value);
  if (!match) {
    return null;
  }

  return {
    kind: match[2] === "sk" ? "secret" : "public",
    mode: match[1] as RpMode,
    value
  };
}

export function hashApiKey(value: string, pepper: string): string {
  return createHmac("sha256", pepper).update(value).digest("hex");
}

export function getApiKeyPrefix(value: string): string {
  return value.slice(0, API_KEY_PREFIX_LENGTH);
}

export function getApiKeyLast4(value: string): string {
  return value.slice(-4);
}

export function constantTimeHashesMatch(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

export function isApiKeyKind(value: string): value is ApiKeyKind {
  return (apiKeyKinds as readonly string[]).includes(value);
}

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (apiKeyScopes as readonly string[]).includes(value);
}
