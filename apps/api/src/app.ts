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
import { Pool } from "pg";

import { createApiErrorEnvelope } from "@richespay/shared";

import type { AppEnv } from "./env";
import { requestIdPlugin } from "./plugins/request-id";
import { registerHealthRoutes } from "./routes/health";
import { registerV1Routes } from "./routes/v1";

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

export async function buildApp(env: AppEnv) {
  const redis = new IORedis(env.REDIS_URL, {
    enableReadyCheck: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1
  });

  const db = new Pool({
    connectionString: env.DATABASE_URL
  });

  const app = Fastify({
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
          "body.cvv",
          "body.pin",
          "body.otp",
          "body.secret"
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
  app.decorate("redis", redis);

  app.setErrorHandler(async (error, request, reply) => {
    const requestId = request.id;
    const field = getValidationField(error);
    const errorMessage =
      error instanceof Error ? error.message : "Unexpected error";

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

    if (statusCode >= 500) {
      request.log.error({ err: error }, "Unhandled request error");
    }

    const code =
      statusCode === 401
        ? "unauthorized"
        : statusCode === 404
          ? "not_found"
          : "internal_error";

    return reply.status(statusCode).send(
      createApiErrorEnvelope({
        code,
        message: statusCode >= 500 ? "Internal server error" : errorMessage,
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
  await app.register(helmet);
  await app.register(cors, {
    origin: [env.DASHBOARD_ORIGIN, env.ADMIN_ORIGIN, env.CHECKOUT_ORIGIN]
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
  await app.register(registerV1Routes, { prefix: "/v1" });

  return { app, db, redis };
}
