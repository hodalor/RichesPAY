import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";
import { createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";

import type { DevPostgresHandle } from "../src/db/dev-postgres";
import type { AppEnv } from "../src/env";

describe("route access audit", () => {
  let builtApp: Awaited<ReturnType<typeof buildApp>>;
  let devPostgres: DevPostgresHandle;

  beforeAll(async () => {
    devPostgres = await startDevPostgres();
    const pool = createDatabasePool(devPostgres.connectionString);
    await applySqlMigrations(pool);
    await pool.end();

    const env: AppEnv = {
      ADMIN_IP_ALLOWLIST: ["10.0.0.0/8"],
      ADMIN_ORIGIN: "http://127.0.0.1:5174",
      API_KEY_PEPPER: "public-api-pepper",
      APP_ENV: "test",
      CHECKOUT_ORIGIN: "http://127.0.0.1:5175",
      DASHBOARD_ORIGIN: "http://127.0.0.1:5173",
      DATABASE_URL: devPostgres.connectionString,
      ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      PORT: 3000,
      REDIS_URL: "redis://127.0.0.1:6379",
      SUPABASE_ANON_KEY: "anon_test_key",
      SUPABASE_JWT_SECRET: "super-secret-test-jwt",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
      SUPABASE_URL: "http://127.0.0.1:54321"
    };

    builtApp = await buildApp(env);
    await builtApp.redis.disconnect();
  }, 120000);

  afterAll(async () => {
    if (builtApp) {
      await Promise.allSettled([
        builtApp.app.close(),
        builtApp.db.destroy(),
        builtApp.dbPool.end()
      ]);
    }

    if (devPostgres) {
      await devPostgres.stop();
    }
  });

  it("declares auth and a requirement or explicit public flag for every live route", () => {
    const deduped = Array.from(
      new Map(
        builtApp.app.routeAccessAudit.map((entry) => [
          `${entry.method}:${entry.url}`,
          entry
        ])
      ).values()
    );

    const missing = deduped.filter((entry) => entry.access === null);
    expect(missing).toEqual([]);

    for (const route of deduped) {
      expect(route.access).not.toBeNull();

      if (!route.access) {
        continue;
      }

      if (route.access.explicit_public) {
        expect(route.access.requirement === null || route.access.requirement.length > 0).toBe(true);
      } else {
        expect(route.access.requirement).toBeTruthy();
      }
    }
  });
});
