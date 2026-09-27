import fp from "fastify-plugin";

import { type ApiKeyScope } from "@richespay/shared";

import { getClientIp } from "../auth/admin-access";
import { ApiRouteError } from "../lib/api-error";
import { redactJsonValue } from "../lib/redaction";
import {
  assertApiKeyScope,
  authenticateApiKey,
  markApiKeyUsed,
  revokeExpiredApiKey,
  runInPublicApiScope
} from "../public-api/auth";
import { finalizeIdempotencyRequest } from "../public-api/idempotency";
import { enforceApiKeyRateLimit } from "../public-api/rate-limit";

export const publicCheckoutPlugin = fp(async (app) => {
  app.decorateRequest("idempotencyState", null);
  app.decorateRequest("publicApiKey", null);
  app.decorateRequest("publicApiResponseBody", null);
  app.decorateRequest("assertApiKeyScope", (_scope: ApiKeyScope) => {
    throw new Error("Checkout API request scope assertion is unavailable");
  });
  app.decorateRequest("withPublicApiScope", async () => {
    throw new Error("Checkout API request scope is unavailable");
  });

  app.addHook("preHandler", async (request, reply) => {
    const clientIp = getClientIp(
      request.headers as Record<string, unknown>,
      request.ip
    );

    const context = await authenticateApiKey(app.db, {
      allowedKinds: ["public"],
      apiKeyPepper: app.appEnv.API_KEY_PEPPER,
      authorizationHeader: request.headers.authorization,
      clientIp
    });

    try {
      await enforceApiKeyRateLimit(app.redis, {
        apiKeyId: context.apiKeyId,
        limit: context.rateLimitRps
      });
    } catch (error) {
      if (error instanceof ApiRouteError && error.code === "rate_limited") {
        reply.header("Retry-After", "1");
      }

      throw error;
    }

    request.publicApiKey = context;
    request.assertApiKeyScope = (scope: ApiKeyScope) => {
      assertApiKeyScope(context, scope);
    };
    request.withPublicApiScope = <T,>(fn: Parameters<typeof runInPublicApiScope<T>>[2]) =>
      runInPublicApiScope(app.db, context, fn);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    request.publicApiResponseBody = normalizePayloadForLogs(payload);
    await finalizeIdempotencyRequest(request, reply, payload);
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const context = request.publicApiKey;
    if (!context) {
      return;
    }

    void (async () => {
      await Promise.allSettled([
        markApiKeyUsed(app.db, context),
        revokeExpiredApiKey(app.db, context),
        runInPublicApiScope(app.db, context, async (trx) => {
          await trx
            .insertInto("api_request_logs")
            .values({
              api_key_id: context.apiKeyId,
              created_at: new Date(),
              duration_ms: Math.max(0, Math.round(reply.elapsedTime)),
              ip: getClientIp(request.headers as Record<string, unknown>, request.ip),
              merchant_id: context.merchantId,
              method: request.method,
              mode: context.mode,
              path: request.routeOptions.url ?? request.url,
              request_body: redactJsonValue(request.body),
              request_id: request.id,
              response_body: request.publicApiResponseBody,
              status_code: reply.statusCode
            })
            .execute();
        })
      ]);
    })().catch((error) => {
      request.log.error({ err: error }, "Failed to persist checkout API usage metadata");
    });
  });
});

function normalizePayloadForLogs(payload: unknown) {
  if (typeof payload === "string") {
    try {
      return redactJsonValue(JSON.parse(payload));
    } catch {
      return redactJsonValue(payload);
    }
  }

  return redactJsonValue(payload);
}
