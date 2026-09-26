import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";

import { buildApp } from "../src/app";
import { createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";
import { runWithSystemScope } from "../src/db/scope";

import type { DevPostgresHandle } from "../src/db/dev-postgres";
import type { AppEnv } from "../src/env";

describe("auth plugins", () => {
  let devPostgres: DevPostgresHandle;
  let env: AppEnv;
  let builtApp: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    devPostgres = await startDevPostgres();
    const pool = createDatabasePool(devPostgres.connectionString);
    await applySqlMigrations(pool);
    await pool.end();

    env = {
      ADMIN_IP_ALLOWLIST: ["10.0.0.0/8"],
      ADMIN_ORIGIN: "http://127.0.0.1:5174",
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

    await builtApp.dbPool.query(`
      insert into auth.users (id, email)
      values
        ('10000000-0000-0000-0000-000000000001', 'owner@richespay.test'),
        ('20000000-0000-0000-0000-000000000002', 'admin@richespay.test')
      on conflict (id) do nothing
    `);

    await runWithSystemScope(
      builtApp.db,
      "seed auth plugin tests",
      async (trx) => {
        await trx
          .insertInto("merchants")
          .values({
            collections_frozen: false,
            country_code: "GH",
            id: "mer_auth_plugin",
            legal_name: "Auth Plugin Merchant",
            mode: "live",
            payouts_frozen: false,
            settlement_currency: "GHS",
            status: "active",
            timezone: "Africa/Accra",
            trading_name: "Auth Plugin Merchant"
          })
          .execute();

        await trx
          .insertInto("memberships")
          .values({
            merchant_id: "mer_auth_plugin",
            mode: "live",
            role: "owner",
            user_id: "10000000-0000-0000-0000-000000000001"
          })
          .execute();

        await trx
          .insertInto("platform_admins")
          .values({
            active: true,
            role: "super_admin",
            user_id: "20000000-0000-0000-0000-000000000002"
          })
          .execute();
      },
      { audit: false }
    );
  }, 120000);

  afterAll(async () => {
    if (builtApp) {
      await Promise.allSettled([
        builtApp.app.close(),
        builtApp.db.destroy()
      ]);
    }

    if (devPostgres) {
      await devPostgres.stop();
    }
  });

  it("rejects dashboard owner sessions without aal2 when MFA is required", async () => {
    const token = await signToken(env.SUPABASE_JWT_SECRET, {
      aal: "aal1",
      email: "owner@richespay.test",
      sub: "10000000-0000-0000-0000-000000000001"
    });

    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${token}`,
        "x-merchant-id": "mer_auth_plugin"
      },
      method: "GET",
      url: "/dashboard/v1/session"
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: "mfa_required"
      }
    });
  });

  it("rejects admin sessions from IPs outside the allowlist", async () => {
    const token = await signToken(env.SUPABASE_JWT_SECRET, {
      aal: "aal2",
      email: "admin@richespay.test",
      sub: "20000000-0000-0000-0000-000000000002"
    });

    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${token}`,
        "x-forwarded-for": "203.0.113.10"
      },
      method: "GET",
      url: "/admin/v1/session"
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: "ip_not_allowed"
      }
    });
  });
});

async function signToken(
  secret: string,
  payload: {
    aal: "aal1" | "aal2";
    email: string;
    sub: string;
  }
) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .setSubject(payload.sub)
    .sign(new TextEncoder().encode(secret));
}
