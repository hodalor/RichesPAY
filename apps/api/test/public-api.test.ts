import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { buildApp } from "../src/app";
import { createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";
import { runWithSystemScope } from "../src/db/scope";
import { LedgerService } from "../src/ledger";
import { publicApiPlugin } from "../src/plugins/public-api";
import {
  createPlainApiKey,
  getApiKeyLast4,
  getApiKeyPrefix,
  hashApiKey
} from "../src/public-api/api-keys";
import { requireIdempotency } from "../src/public-api/idempotency";

import type { DevPostgresHandle } from "../src/db/dev-postgres";
import type { AppEnv } from "../src/env";

describe("public v1 api", () => {
  let devPostgres: DevPostgresHandle;
  let env: AppEnv;
  let builtApp: Awaited<ReturnType<typeof buildApp>>;
  let liveKey = "";
  let revokedKey = "";
  let testKey = "";
  let probeCallCount = 0;

  beforeAll(async () => {
    devPostgres = await startDevPostgres();
    const pool = createDatabasePool(devPostgres.connectionString);
    await applySqlMigrations(pool);
    await pool.end();

    env = {
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

    liveKey = createPlainApiKey("live", "secret");
    revokedKey = createPlainApiKey("live", "secret");
    testKey = createPlainApiKey("test", "secret");

    await builtApp.dbPool.query(`
      insert into auth.users (id, email)
      values ('10000000-0000-0000-0000-000000000001', 'merchant-owner@richespay.test')
      on conflict (id) do nothing
    `);

    await runWithSystemScope(
      builtApp.db,
      "seed public api tests",
      async (trx) => {
        await trx
          .insertInto("merchants")
          .values([
            {
              collections_frozen: false,
              country_code: "GH",
              id: "mer_public_live",
              legal_name: "Public API Live Merchant",
              mode: "live",
              payouts_frozen: false,
              settlement_currency: "GHS",
              status: "active",
              timezone: "Africa/Accra",
              trading_name: "Public API Live Merchant"
            },
            {
              collections_frozen: false,
              country_code: "GH",
              id: "mer_public_test",
              legal_name: "Public API Test Merchant",
              mode: "test",
              payouts_frozen: false,
              settlement_currency: "GHS",
              status: "active",
              timezone: "Africa/Accra",
              trading_name: "Public API Test Merchant"
            }
          ])
          .execute();

        await trx
          .insertInto("api_keys")
          .values([
            {
              created_by: "10000000-0000-0000-0000-000000000001",
              id: "key_live_active",
              ip_allowlist: null,
              key_hash: hashApiKey(liveKey, env.API_KEY_PEPPER),
              kind: "secret",
              last4: getApiKeyLast4(liveKey),
              merchant_id: "mer_public_live",
              mode: "live",
              name: "Live key",
              prefix: getApiKeyPrefix(liveKey),
              revoked_at: null,
              scopes: ["read", "collections"]
            },
            {
              created_by: "10000000-0000-0000-0000-000000000001",
              id: "key_live_revoked",
              ip_allowlist: null,
              key_hash: hashApiKey(revokedKey, env.API_KEY_PEPPER),
              kind: "secret",
              last4: getApiKeyLast4(revokedKey),
              merchant_id: "mer_public_live",
              mode: "live",
              name: "Revoked key",
              prefix: getApiKeyPrefix(revokedKey),
              revoked_at: new Date(),
              scopes: ["read"]
            },
            {
              created_by: "10000000-0000-0000-0000-000000000001",
              id: "key_test_active",
              ip_allowlist: null,
              key_hash: hashApiKey(testKey, env.API_KEY_PEPPER),
              kind: "secret",
              last4: getApiKeyLast4(testKey),
              merchant_id: "mer_public_test",
              mode: "test",
              name: "Test key",
              prefix: getApiKeyPrefix(testKey),
              revoked_at: null,
              scopes: ["read", "collections"]
            }
          ])
          .execute();
      },
      { audit: false }
    );

    await seedBalance("mer_public_live", "live", 1900n);
    await seedBalance("mer_public_test", "test", 700n);

    await builtApp.app.register(async (testApp) => {
      await testApp.register(publicApiPlugin, { prefix: "/_public-test" });

      testApp.post(
        "/_public-test/collections/probe",
        {
          preHandler: [requireIdempotency()],
          schema: {
            body: z.object({
              amount: z.number().int().positive()
            }),
            response: {
              200: z.object({
                data: z.object({
                  amount: z.number().int(),
                  call_count: z.number().int()
                })
              })
            }
          }
        },
        async (request) => {
          request.assertApiKeyScope("collections");
          probeCallCount += 1;

          const body = z.object({
            amount: z.number().int().positive()
          }).parse(request.body);

          return {
            data: {
              amount: body.amount,
              call_count: probeCallCount
            }
          };
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

  it("rejects invalid public API keys", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: "Bearer rp_live_sk_invalid"
      },
      method: "GET",
      url: "/v1/balance"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: "authentication_failed"
      }
    });
  });

  it("rejects revoked keys", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${revokedKey}`
      },
      method: "GET",
      url: "/v1/balance"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: "authentication_failed"
      }
    });
  });

  it("uses the test mode key scope and does not expose live balances", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${testKey}`
      },
      method: "GET",
      url: "/v1/balance"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [
        {
          available: 700,
          currency: "GHS",
          on_hold: 0,
          pending: 0
        }
      ]
    });
  });

  it("quotes fees for the merchant's country pricing plan", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${liveKey}`
      },
      method: "GET",
      url: "/v1/fees/quote?kind=collection&method=mobile_money&amount=5000&currency=GHS"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        currency: "GHS",
        customer_pays_minor: 5000,
        fee_minor: 175,
        merchant_receives_minor: 4825
      }
    });
  });

  it("replays an idempotent response for the same key and body", async () => {
    const firstResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${liveKey}`,
        "idempotency-key": "idem-public-replay"
      },
      method: "POST",
      payload: {
        amount: 1500
      },
      url: "/_public-test/collections/probe"
    });

    const secondResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${liveKey}`,
        "idempotency-key": "idem-public-replay"
      },
      method: "POST",
      payload: {
        amount: 1500
      },
      url: "/_public-test/collections/probe"
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual(firstResponse.json());
    expect(probeCallCount).toBe(1);
  });

  it("rejects idempotency key reuse with a different request body", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${liveKey}`,
        "idempotency-key": "idem-public-replay"
      },
      method: "POST",
      payload: {
        amount: 2000
      },
      url: "/_public-test/collections/probe"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "idempotency_conflict"
      }
    });
  });

  async function seedBalance(merchantId: string, mode: "live" | "test", amount: bigint) {
    await runWithSystemScope(
      builtApp.db,
      `seed balance for ${merchantId}`,
      async (trx) => {
        const ledger = new LedgerService(trx, {
          actorId: "adm_public_api_tester",
          actorType: "admin"
        });

        await ledger.manualAdjustment({
          amount,
          creditAccount: {
            merchantId,
            type: "merchant_available"
          },
          currency: "GHS",
          debitAccount: {
            merchantId: null,
            type: "suspense"
          },
          description: `Seed balance for ${merchantId}`,
          mode,
          reason: "test setup",
          referenceId: `adj_${merchantId}`
        });
      },
      { audit: false }
    );
  }
});
