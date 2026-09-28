import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readFile } from "node:fs/promises";

import { buildApp } from "../src/app";
import { createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";
import { redactJsonValue } from "../src/lib/redaction";
import { publicApiPlugin } from "../src/plugins/public-api";
import {
  createPlainApiKey,
  getApiKeyLast4,
  getApiKeyPrefix,
  hashApiKey
} from "../src/public-api/api-keys";
import { runWithSystemScope } from "../src/db";

import type { DevPostgresHandle } from "../src/db/dev-postgres";
import type { AppEnv } from "../src/env";

describe("security hardening", () => {
  let builtApp: Awaited<ReturnType<typeof buildApp>>;
  let devPostgres: DevPostgresHandle;
  let secretKey = "";

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

    secretKey = createPlainApiKey("test", "secret");

    await builtApp.dbPool.query(`
      insert into auth.users (id, email)
      values ('10000000-0000-0000-0000-000000000001', 'security@richespay.test')
      on conflict (id) do nothing
    `);

    await runWithSystemScope(builtApp.db, "seed security hardening tests", async (trx) => {
      await trx
        .insertInto("merchants")
        .values({
          collections_frozen: false,
          country_code: "GH",
          id: "mer_security_test",
          legal_name: "Security Test Merchant",
          mode: "test",
          payouts_frozen: false,
          settlement_currency: "GHS",
          status: "active",
          timezone: "Africa/Accra",
          trading_name: "Security Test Merchant"
        })
        .execute();

      await trx
        .insertInto("api_keys")
        .values({
          created_by: "10000000-0000-0000-0000-000000000001",
          id: "key_security_test",
          ip_allowlist: null,
          key_hash: hashApiKey(secretKey, env.API_KEY_PEPPER),
          kind: "secret",
          last4: getApiKeyLast4(secretKey),
          merchant_id: "mer_security_test",
          mode: "test",
          name: "Security key",
          prefix: getApiKeyPrefix(secretKey),
          revoked_at: null,
          scopes: ["read", "collections", "payouts", "sms"]
        })
        .execute();
    }, { audit: false });

    await builtApp.app.register(async (testApp) => {
      await testApp.register(publicApiPlugin, { prefix: "/_security" });

      testApp.post(
        "/_security/redact-probe",
        {
          schema: {
            body: z.unknown(),
            response: {
              200: z.object({
                data: z.object({
                  ok: z.literal(true)
                })
              })
            }
          }
        },
        async (request) => {
          request.assertApiKeyScope("read");
          return { data: { ok: true } };
        }
      );
    });
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

  it("returns HSTS and deny-by-default CSP headers on API responses", async () => {
    const response = await builtApp.app.inject({
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["strict-transport-security"]).toContain("max-age=63072000");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("rejects non-JSON request bodies", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "text/plain"
      },
      method: "POST",
      payload: "hello",
      url: "/_security/redact-probe"
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({
      error: {
        code: "unsupported_media_type"
      }
    });
  });

  it("rejects oversized request bodies", async () => {
    const oversized = JSON.stringify({
      note: "x".repeat(2 * 1024 * 1024 + 1024)
    });

    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/json"
      },
      method: "POST",
      payload: oversized,
      url: "/_security/redact-probe"
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: {
        code: "payload_too_large"
      }
    });
  });

  it("redacts card numbers, OTPs, secrets, and full phone numbers in persisted API logs", async () => {
    const payload = {
      access_token: "access-token-secret",
      card_number: "4111111111111111",
      code: "123456",
      cvv: "123",
      phone: "+233241230001",
      secret: "whsec_secret_value",
      to: "+233241230002"
    };

    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/json"
      },
      method: "POST",
      payload,
      url: "/_security/redact-probe"
    });

    expect(response.statusCode).toBe(200);

    const logged = await waitForRequestLog("mer_security_test");
    expect(JSON.stringify(logged?.request_body ?? null)).not.toContain("4111111111111111");
    expect(JSON.stringify(logged?.request_body ?? null)).not.toContain("123456");
    expect(JSON.stringify(logged?.request_body ?? null)).not.toContain("whsec_secret_value");
    expect(JSON.stringify(logged?.request_body ?? null)).not.toContain("+233241230001");
    expect(JSON.stringify(logged?.request_body ?? null)).not.toContain("+233241230002");
    expect(logged?.request_body).toMatchObject({
      access_token: "[REDACTED]",
      card_number: "[REDACTED]",
      code: "[REDACTED]",
      cvv: "[REDACTED]",
      secret: "[REDACTED]"
    });
  });

  it("masks sensitive fields in structured log redaction helpers", () => {
    expect(
      redactJsonValue({
        card_number: "4111111111111111",
        customer: {
          email: "customer@example.com",
          phone: "+233241230001"
        },
        otp: "123456",
        token: "secret-token",
        to: "+233241230002"
      })
    ).toEqual({
      card_number: "[REDACTED]",
      customer: {
        email: "cu***@example.com",
        phone: "*********0001"
      },
      otp: "[REDACTED]",
      token: "[REDACTED]",
      to: "*********0002"
    });
  });

  it("stores money columns as integers and keeps fx rates as the only numeric exception", async () => {
    const columns = await builtApp.dbPool.query<{
      column_name: string;
      data_type: string;
      table_name: string;
    }>(`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position
    `);

    const offenders = columns.rows.filter((column) => {
      const isMoneyLike =
        column.column_name === "amount" ||
        column.column_name.endsWith("_amount") ||
        column.column_name === "balance" ||
        column.column_name.endsWith("_balance") ||
        column.column_name === "fee" ||
        column.column_name.endsWith("_fee") ||
        column.column_name.includes("_minor") ||
        column.column_name === "threshold_minor";

      if (!isMoneyLike) {
        return false;
      }

      if (column.table_name === "fx_rates" && column.column_name === "rate") {
        return false;
      }

      return column.data_type !== "bigint";
    });

    expect(offenders).toEqual([]);
  });

  it("ships strict static security headers for dashboard, admin, and checkout apps", async () => {
    const files = await Promise.all([
      readFile(
        "c:\\Users\\Lenovo\\Documents\\projects\\reactjs\\RichesPAY\\richespay\\apps\\dashboard\\public\\_headers",
        "utf8"
      ),
      readFile(
        "c:\\Users\\Lenovo\\Documents\\projects\\reactjs\\RichesPAY\\richespay\\apps\\admin\\public\\_headers",
        "utf8"
      ),
      readFile(
        "c:\\Users\\Lenovo\\Documents\\projects\\reactjs\\RichesPAY\\richespay\\apps\\checkout\\public\\_headers",
        "utf8"
      )
    ]);

    expect(files[0]).toContain("frame-ancestors 'none'");
    expect(files[1]).toContain("frame-ancestors 'none'");
    expect(files[2]).toContain("frame-ancestors 'self' https://*.richespay.com");
    expect(files.every((file) => file.includes("Strict-Transport-Security"))).toBe(true);
    expect(files.every((file) => file.includes("Content-Security-Policy"))).toBe(true);
  });

  it("allows PUT preflight from the admin origin", async () => {
    const response = await builtApp.app.inject({
      headers: {
        "access-control-request-headers": "authorization,content-type",
        "access-control-request-method": "PUT",
        origin: "http://127.0.0.1:5174"
      },
      method: "OPTIONS",
      url: "/admin/v1/merchants/mer_security_test/products"
    });

    expect(response.statusCode).toBe(204);
    expect(String(response.headers["access-control-allow-methods"])).toContain("PUT");
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5174");
  });

  async function waitForRequestLog(merchantId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const row = await builtApp.db
        .selectFrom("api_request_logs")
        .select(["merchant_id", "request_body"])
        .where("merchant_id", "=", merchantId)
        .orderBy("created_at", "desc")
        .executeTakeFirst();

      if (row) {
        return row;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return null;
  }
});
