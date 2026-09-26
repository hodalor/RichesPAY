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

import type { DashboardMembershipContext } from "./auth/dashboard-access";
import type { PlatformAdminContext } from "./auth/admin-access";
import type { AuthenticatedSession } from "./auth/session";
import type { AppEnv } from "./env";
import type { AppDatabase, ScopedTransaction } from "./db";
import type { IdempotencyState } from "./public-api/idempotency";
import type { PublicApiKeyContext } from "./public-api/auth";
import type { Json } from "./db/types";
import type { ApiKeyScope, MerchantPermission } from "@richespay/shared";

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

  interface FastifyRequest {
    authenticatedSession: AuthenticatedSession | null;
    assertDashboardPermission: (permission: MerchantPermission) => void;
    dashboardMembership: DashboardMembershipContext | null;
    dashboardPermissions: MerchantPermission[] | null;
    idempotencyState: IdempotencyState | null;
    platformAdmin: PlatformAdminContext | null;
    publicApiKey: PublicApiKeyContext | null;
    publicApiResponseBody: Json | null;
    assertApiKeyScope: (scope: ApiKeyScope) => void;
    withDashboardScope: <T>(
      fn: (trx: ScopedTransaction) => Promise<T>
    ) => Promise<T>;
    withPublicApiScope: <T>(
      fn: (trx: ScopedTransaction) => Promise<T>
    ) => Promise<T>;
  }
}
