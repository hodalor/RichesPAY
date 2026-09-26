import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type Redis from "ioredis";
import type { Pool } from "pg";

import type { AppEnv } from "./env";
import type { AppDatabase } from "./db";

export type FastifyTypedInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  FastifyBaseLogger,
  ZodTypeProvider
>;

declare module "fastify" {
  interface FastifyInstance {
    appEnv: AppEnv;
    db: AppDatabase;
    dbPool: Pool;
    redis: Redis;
  }
}
