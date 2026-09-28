import ipaddr from "ipaddr.js";

import { getErrorDefinition, type ApiKeyScope, apiKeyScopes } from "@richespay/shared";

import { runWithMerchantScope, runWithSystemScope, type AppDatabase, type ScopedTransaction } from "../db";
import type { ApiKeyKind, MerchantStatus, RpMode } from "../db/types";
import { ApiRouteError } from "../lib/api-error";
import { parsePgTextArray } from "../lib/pg-array";
import { constantTimeHashesMatch, getApiKeyPrefix, hashApiKey, parseApiKey } from "./api-keys";

export interface PublicApiKeyContext {
  apiKeyId: string;
  apiKeyName: string;
  createdBy: string;
  expiresAt: Date | null;
  ipAllowlist: string[] | null;
  kind: ApiKeyKind;
  last4: string;
  merchantId: string;
  merchantStatus: MerchantStatus;
  mode: RpMode;
  rateLimitRps: number;
  revokedAt: Date | null;
  scopes: ApiKeyScope[];
}

export async function authenticateApiKey(
  database: AppDatabase,
  input: {
    allowedKinds?: readonly ApiKeyKind[];
    authorizationHeader: string | undefined;
    apiKeyPepper: string;
    clientIp: string;
  }
): Promise<PublicApiKeyContext> {
  const parsed = parseApiKey(input.authorizationHeader);
  const allowedKinds = input.allowedKinds ?? ["secret"];
  if (!parsed || !allowedKinds.includes(parsed.kind)) {
    throw authenticationFailed();
  }

  const hashedKey = hashApiKey(parsed.value, input.apiKeyPepper);
  const candidates = await runWithSystemScope(
    database,
    "load public api key candidates",
    async (trx) =>
      trx
        .selectFrom("api_keys as api_key")
        .innerJoin("merchants as merchant", (join) =>
          join
            .onRef("merchant.id", "=", "api_key.merchant_id")
            .onRef("merchant.mode", "=", "api_key.mode")
        )
        .select([
          "api_key.id as apiKeyId",
          "api_key.name as apiKeyName",
          "api_key.created_by as createdBy",
          "api_key.expires_at as expiresAt",
          "api_key.ip_allowlist as ipAllowlist",
          "api_key.kind as kind",
          "api_key.key_hash as keyHash",
          "api_key.last4 as last4",
          "api_key.merchant_id as merchantId",
          "api_key.mode as mode",
          "api_key.revoked_at as revokedAt",
          "api_key.scopes as scopes",
          "merchant.api_rate_limit_rps as rateLimitRps",
          "merchant.status as merchantStatus"
        ])
        .where("api_key.prefix", "=", getApiKeyPrefix(parsed.value))
        .where("api_key.mode", "=", parsed.mode)
        .where("api_key.kind", "=", parsed.kind)
        .execute(),
    { audit: false }
  );

  const match = candidates.find((candidate) =>
    constantTimeHashesMatch(candidate.keyHash, hashedKey)
  );

  if (!match) {
    throw authenticationFailed();
  }

  if (match.revokedAt) {
    throw authenticationFailed();
  }

  if (match.expiresAt && match.expiresAt <= new Date()) {
    await runWithMerchantScope(database, match.merchantId, match.mode, async (trx) => {
      await trx
        .updateTable("api_keys")
        .set({ revoked_at: new Date() })
        .where("id", "=", match.apiKeyId)
        .where("revoked_at", "is", null)
        .execute();
    });

    throw authenticationFailed();
  }

  if (match.ipAllowlist && match.ipAllowlist.length > 0) {
    assertIpAllowed(input.clientIp, match.ipAllowlist);
  }

  if (match.merchantStatus === "suspended") {
    throw new ApiRouteError({
      code: "merchant_suspended",
      message: getErrorDefinition("merchant_suspended").message,
      statusCode: getErrorDefinition("merchant_suspended").status
    });
  }

  return {
    apiKeyId: match.apiKeyId,
    apiKeyName: match.apiKeyName,
    createdBy: match.createdBy,
    expiresAt: match.expiresAt,
    ipAllowlist: match.ipAllowlist,
    kind: match.kind,
    last4: match.last4,
    merchantId: match.merchantId,
    merchantStatus: match.merchantStatus,
    mode: match.mode,
    rateLimitRps: match.rateLimitRps,
    revokedAt: match.revokedAt,
    scopes: parsePgTextArray(match.scopes).filter((scope): scope is ApiKeyScope =>
      (apiKeyScopes as readonly string[]).includes(scope)
    )
  };
}

export function assertApiKeyScope(context: PublicApiKeyContext, scope: ApiKeyScope) {
  if (!context.scopes.includes(scope)) {
    throw new ApiRouteError({
      code: "permission_denied",
      message: getErrorDefinition("permission_denied").message,
      statusCode: getErrorDefinition("permission_denied").status
    });
  }
}

export async function runInPublicApiScope<T>(
  database: AppDatabase,
  context: PublicApiKeyContext,
  fn: (trx: ScopedTransaction) => Promise<T>
): Promise<T> {
  return runWithMerchantScope(database, context.merchantId, context.mode, fn);
}

export async function markApiKeyUsed(
  database: AppDatabase,
  context: PublicApiKeyContext
): Promise<void> {
  await runWithMerchantScope(database, context.merchantId, context.mode, async (trx) => {
    await trx
      .updateTable("api_keys")
      .set({ last_used_at: new Date() })
      .where("id", "=", context.apiKeyId)
      .execute();
  });
}

export async function revokeExpiredApiKey(
  database: AppDatabase,
  context: PublicApiKeyContext
): Promise<void> {
  if (!context.expiresAt || context.expiresAt > new Date()) {
    return;
  }

  await runWithMerchantScope(database, context.merchantId, context.mode, async (trx) => {
    await trx
      .updateTable("api_keys")
      .set({ revoked_at: new Date() })
      .where("id", "=", context.apiKeyId)
      .where("revoked_at", "is", null)
      .execute();
  });
}

function authenticationFailed(): ApiRouteError {
  const definition = getErrorDefinition("authentication_failed");
  return new ApiRouteError({
    code: "authentication_failed",
    message: definition.message,
    statusCode: definition.status
  });
}

function assertIpAllowed(rawIp: string, allowlist: readonly string[]) {
  const clientAddress = ipaddr.parse(rawIp);
  const allowed = allowlist.some((entry) => {
    if (entry.includes("/")) {
      const [range, prefixLength] = ipaddr.parseCIDR(entry);
      return clientAddress.kind() === range.kind() && clientAddress.match([range, prefixLength]);
    }

    const allowedAddress = ipaddr.parse(entry);
    return clientAddress.kind() === allowedAddress.kind()
      && clientAddress.toNormalizedString() === allowedAddress.toNormalizedString();
  });

  if (!allowed) {
    throw authenticationFailed();
  }
}
