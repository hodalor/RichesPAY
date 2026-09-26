import { createHash } from "node:crypto";

import { getErrorDefinition } from "@richespay/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

import { redactJsonValue } from "../lib/redaction";
import { ApiRouteError } from "../lib/api-error";

import type { Json, RpMode } from "../db/types";

export interface IdempotencyState {
  key: string;
  merchantId: string;
  mode: RpMode;
  replayed: boolean;
  requestHash: string;
  shouldPersist: boolean;
}

export function requireIdempotency() {
  return async function publicApiIdempotencyGuard(
    request: FastifyRequest,
    reply: FastifyReply
  ) {
    const context = request.publicApiKey;
    if (!context) {
      throw new Error("Public API authentication must run before idempotency checks");
    }

    const headerValue = request.headers["idempotency-key"];
    if (typeof headerValue !== "string" || headerValue.trim() === "") {
      throw new ApiRouteError({
        code: "validation_error",
        field: "idempotency-key",
        message: "Idempotency-Key is required",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    const key = headerValue.trim();
    const requestHash = hashRequestFingerprint({
      body: request.body,
      method: request.method,
      path: request.routeOptions.url ?? request.url,
      query: request.query
    });

    const existing = await request.withPublicApiScope(async (trx) =>
      trx
        .selectFrom("idempotency_keys")
        .selectAll()
        .where("merchant_id", "=", context.merchantId)
        .where("mode", "=", context.mode)
        .where("key", "=", key)
        .executeTakeFirst()
    );

    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw conflictError("idempotency_conflict");
      }

      if (existing.status === "in_progress") {
        throw conflictError("request_in_progress");
      }

      request.idempotencyState = {
        key,
        merchantId: context.merchantId,
        mode: context.mode,
        replayed: true,
        requestHash,
        shouldPersist: false
      };
      return reply.status(existing.response_status ?? 200).send(existing.response_body ?? {});
    }

    await request.withPublicApiScope(async (trx) => {
      await trx
        .insertInto("idempotency_keys")
        .values({
          key,
          merchant_id: context.merchantId,
          mode: context.mode,
          request_hash: requestHash,
          response_body: null,
          response_status: null,
          status: "in_progress"
        })
        .execute();
    });

    request.idempotencyState = {
      key,
      merchantId: context.merchantId,
      mode: context.mode,
      replayed: false,
      requestHash,
      shouldPersist: true
    };
  };
}

export async function finalizeIdempotencyRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
): Promise<void> {
  const state = request.idempotencyState;
  if (!state || state.replayed || !state.shouldPersist) {
    return;
  }

  const responseBody = normalizePayload(payload);
  await request.withPublicApiScope(async (trx) => {
    await trx
      .updateTable("idempotency_keys")
      .set({
        response_body: responseBody,
        response_status: reply.statusCode,
        status: "completed"
      })
      .where("merchant_id", "=", state.merchantId)
      .where("mode", "=", state.mode)
      .where("key", "=", state.key)
      .execute();
  });
}

function conflictError(code: "idempotency_conflict" | "request_in_progress") {
  const definition = getErrorDefinition(code);
  return new ApiRouteError({
    code,
    message: definition.message,
    statusCode: definition.status
  });
}

function hashRequestFingerprint(input: {
  body: unknown;
  method: string;
  path: string;
  query: unknown;
}): string {
  return createHash("sha256")
    .update(stableStringify({
      body: input.body ?? null,
      method: input.method,
      path: input.path,
      query: input.query ?? null
    }))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForHash(value));
}

function normalizeForHash(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value ?? null;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForHash(entry));
  }

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((accumulator, key) => {
      accumulator[key] = normalizeForHash((value as Record<string, unknown>)[key]);
      return accumulator;
    }, {});
}

function normalizePayload(payload: unknown): Json | null {
  if (typeof payload === "string") {
    try {
      return redactJsonValue(JSON.parse(payload));
    } catch {
      return redactJsonValue(payload);
    }
  }

  return redactJsonValue(payload);
}
