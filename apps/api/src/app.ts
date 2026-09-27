import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import {
  type ZodTypeProvider,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler
} from "fastify-type-provider-zod";
import Fastify from "fastify";
import IORedis from "ioredis";

import { createApiErrorEnvelope, getErrorDefinition, isErrorCode } from "@richespay/shared";

import {
  createDatabase,
  createDatabasePool,
  registerDatabase
} from "./db";
import type { AppEnv } from "./env";
import { extractErrorCode, isApiRouteError } from "./lib/api-error";
import { requestIdPlugin } from "./plugins/request-id";
import { registerHealthRoutes } from "./routes/health";
import { registerAdminRoutes } from "./routes/admin";
import { registerCallbackRoutes } from "./routes/callbacks";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerV1Routes } from "./routes/v1";
import { auditRouteAccess } from "./security/route-access";

function getValidationField(error: unknown): string | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("validation" in error) ||
    !Array.isArray(error.validation)
  ) {
    return undefined;
  }

  const [firstIssue] = error.validation as Array<{
    instancePath?: string;
    params?: { missingProperty?: string };
  }>;

  const path = firstIssue?.instancePath
    ?.replace(/^\//, "")
    .replace(/\//g, ".");

  return path || firstIssue?.params?.missingProperty;
}

/** Browsers treat localhost and 127.0.0.1 as different origins. */
function corsOrigins(configured: string[]): string[] {
  const origins = new Set<string>();

  for (const value of configured) {
    origins.add(value);

    try {
      const url = new URL(value);
      if (url.hostname === "127.0.0.1") {
        url.hostname = "localhost";
        origins.add(url.origin);
      } else if (url.hostname === "localhost") {
        url.hostname = "127.0.0.1";
        origins.add(url.origin);
      }
    } catch {
      // Keep the configured value when it is not a parseable URL.
    }
  }

  return [...origins];
}

function isPrivateDevHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return true;
  }

  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  return (
    parts[0] === 10 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31)
  );
}

function isAllowedCorsOrigin(
  origin: string | undefined,
  configured: string[],
  appEnv: AppEnv["APP_ENV"]
): boolean {
  if (!origin) {
    return true;
  }

  if (corsOrigins(configured).includes(origin)) {
    return true;
  }

  if (appEnv !== "development") {
    return false;
  }

  let requestUrl: URL;
  try {
    requestUrl = new URL(origin);
  } catch {
    return false;
  }

  const allowedPorts = new Set(
    configured.flatMap((value) => {
      try {
        return [new URL(value).port];
      } catch {
        return [];
      }
    })
  );

  return allowedPorts.has(requestUrl.port) && isPrivateDevHostname(requestUrl.hostname);
}

export async function buildApp(env: AppEnv) {
  const redis = new IORedis(env.REDIS_URL, {
    enableReadyCheck: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1
  });

  const dbPool = createDatabasePool(env.DATABASE_URL);
  const db = createDatabase(dbPool);
  registerDatabase(db);

  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    genReqId: (request) => {
      const requestId = request.headers["x-request-id"];
      return typeof requestId === "string" && requestId.trim() !== ""
        ? requestId
        : randomUUID();
    },
    logger: {
      level: env.APP_ENV === "development" ? "info" : "warn",
      redact: {
        censor: "[REDACTED]",
        paths: [
          "req.headers.authorization",
          "headers.authorization",
          "authorization",
          "body.password",
          "body.card",
          "body.card_number",
          "body.cvv",
          "body.pin",
          "body.phone",
          "body.to",
          "body.otp",
          "body.secret",
          "body.token",
          "body.access_token",
          "body.refresh_token",
          "body.customer.email",
          "body.customer.phone"
        ]
      }
    },
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "request_id"
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate("appEnv", env);
  app.decorate("db", db);
  app.decorate("dbPool", dbPool);
  app.decorate("routeAccessAudit", []);
  app.decorate("redis", redis);

  app.addHook("onRoute", (routeOptions) => {
    const entries = auditRouteAccess(routeOptions);

    for (const entry of entries) {
      app.routeAccessAudit.push(entry);
    }

    if (entries.length === 1 && entries[0]?.access) {
      routeOptions.config = {
        ...(routeOptions.config ?? {}),
        richespayAccess: entries[0].access
      };
    }
  });

  app.addHook("preValidation", async (request) => {
    if (!["DELETE", "PATCH", "POST", "PUT"].includes(request.method)) {
      return;
    }

    const routeUrl = request.routeOptions.url ?? request.url;
    if (routeUrl.startsWith("/callbacks/")) {
      return;
    }

    const contentType = request.headers["content-type"];
    if (
      typeof contentType !== "string" ||
      !contentType.toLowerCase().startsWith("application/json")
    ) {
      throw new ApiRouteError({
        code: "unsupported_media_type",
        field: "content-type",
        message: getErrorDefinition("unsupported_media_type").message,
        statusCode: getErrorDefinition("unsupported_media_type").status
      });
    }
  });

  app.setErrorHandler(async (error, request, reply) => {
    const requestId = request.id;
    const field = getValidationField(error);
    const errorMessage =
      error instanceof Error ? error.message : "Unexpected error";

    if (isApiRouteError(error)) {
      const errorBody: {
        code: typeof error.code;
        field?: string;
        message: string;
        request_id: string;
      } = {
        code: error.code,
        message: error.message,
        request_id: requestId
      };

      if (error.field !== undefined) {
        errorBody.field = error.field;
      }

      return reply.status(error.statusCode).send(
        createApiErrorEnvelope(errorBody)
      );
    }

    if (field) {
      return reply.status(400).send(
        createApiErrorEnvelope({
          code: "validation_error",
          field,
          message: errorMessage,
          request_id: requestId
        })
      );
    }

    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;

    const explicitCode =
      extractErrorCode(error) ||
      (isErrorCode(errorMessage) ? errorMessage : null);
    const fastifyContentTypeCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null;
    const derivedFastifyCode =
      fastifyContentTypeCode === "FST_ERR_CTP_BODY_TOO_LARGE"
        ? "payload_too_large"
        : fastifyContentTypeCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE"
          ? "unsupported_media_type"
          : null;
    const resolvedStatusCode = explicitCode
      ? getErrorDefinition(explicitCode).status
      : derivedFastifyCode
        ? getErrorDefinition(derivedFastifyCode).status
        : statusCode;

    if (resolvedStatusCode >= 500) {
      request.log.error({ err: error }, "Unhandled request error");
    }

    const code = explicitCode
      ? explicitCode
      : derivedFastifyCode
        ? derivedFastifyCode
      : resolvedStatusCode === 401
        ? "unauthorized"
        : resolvedStatusCode === 403
          ? "forbidden"
          : resolvedStatusCode === 404
            ? "not_found"
            : "internal_error";

    return reply.status(resolvedStatusCode).send(
      createApiErrorEnvelope({
        code: isErrorCode(code) ? code : "internal_error",
        message: resolvedStatusCode >= 500 ? "Internal server error" : errorMessage,
        request_id: requestId
      })
    );
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "RichesPay API",
        version: "0.0.0"
      }
    },
    transform: jsonSchemaTransform
  });

  await app.register(requestIdPlugin);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        baseUri: ["'none'"],
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"]
      }
    },
    frameguard: {
      action: "deny"
    },
    hsts: {
      includeSubDomains: true,
      maxAge: 63072000,
      preload: true
    }
  });
  const allowedAppOrigins = [
    env.DASHBOARD_ORIGIN,
    env.ADMIN_ORIGIN,
    env.CHECKOUT_ORIGIN
  ];
  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isAllowedCorsOrigin(origin, allowedAppOrigins, env.APP_ENV));
    }
  });
  await app.register(rateLimit, {
    max: 100,
    redis,
    skipOnError: true,
    timeWindow: "1 minute",
    errorResponseBuilder: (request) =>
      createApiErrorEnvelope({
        code: "rate_limited",
        message: "Too many requests",
        request_id: request.id
      })
  });

  await registerHealthRoutes(app);
  await app.register(registerCallbackRoutes, { prefix: "/callbacks" });
  await app.register(registerV1Routes, { prefix: "/v1" });
  await app.register(registerDashboardRoutes, { prefix: "/dashboard/v1" });
  await app.register(registerAdminRoutes, { prefix: "/admin/v1" });

  return { app, db, dbPool, redis };
}
