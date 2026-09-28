import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AirtimeFloatMonitor, AirtimeService } from "../src/airtime";
import { buildApp } from "../src/app";
import { createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";
import { runWithSystemScope } from "../src/db/scope";
import { LedgerService } from "../src/ledger";
import { ProviderCatalog } from "../src/providers/catalog";
import {
  createPlainApiKey,
  getApiKeyLast4,
  getApiKeyPrefix,
  hashApiKey
} from "../src/public-api/api-keys";

import type { DevPostgresHandle } from "../src/db/dev-postgres";
import type { AppEnv } from "../src/env";

describe("public airtime api", () => {
  let builtApp: Awaited<ReturnType<typeof buildApp>>;
  let devPostgres: DevPostgresHandle;
  let env: AppEnv;
  let disabledKey = "";
  let fundedKey = "";
  let fxKey = "";
  let lowBalanceKey = "";

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

    disabledKey = createPlainApiKey("test", "secret");
    fundedKey = createPlainApiKey("test", "secret");
    fxKey = createPlainApiKey("test", "secret");
    lowBalanceKey = createPlainApiKey("test", "secret");

    await builtApp.dbPool.query(`
      insert into auth.users (id, email)
      values ('10000000-0000-0000-0000-000000000001', 'merchant-owner@richespay.test')
      on conflict (id) do nothing
    `);

    await runWithSystemScope(
      builtApp.db,
      "seed airtime public api tests",
      async (trx) => {
        await trx
          .insertInto("merchants")
          .values([
            {
              collections_frozen: false,
              country_code: "ZM",
              id: "mer_airtime_funded",
              legal_name: "Airtime Funded Merchant",
              mode: "test",
              payouts_frozen: false,
              settlement_currency: "ZMW",
              status: "active",
              timezone: "Africa/Lusaka",
              trading_name: "Airtime Funded Merchant"
            },
            {
              collections_frozen: false,
              country_code: "GH",
              id: "mer_airtime_fx",
              legal_name: "Airtime FX Merchant",
              mode: "test",
              payouts_frozen: false,
              settlement_currency: "GHS",
              status: "active",
              timezone: "Africa/Accra",
              trading_name: "Airtime FX Merchant"
            },
            {
              collections_frozen: false,
              country_code: "ZM",
              id: "mer_airtime_disabled",
              legal_name: "Airtime Disabled Merchant",
              mode: "test",
              payouts_frozen: false,
              settlement_currency: "ZMW",
              status: "active",
              timezone: "Africa/Lusaka",
              trading_name: "Airtime Disabled Merchant"
            },
            {
              collections_frozen: false,
              country_code: "ZM",
              id: "mer_airtime_broke",
              legal_name: "Airtime Broke Merchant",
              mode: "test",
              payouts_frozen: false,
              settlement_currency: "ZMW",
              status: "active",
              timezone: "Africa/Lusaka",
              trading_name: "Airtime Broke Merchant"
            }
          ])
          .execute();

        await trx
          .updateTable("merchant_products")
          .set({
            airtime_enabled: true,
            collections_enabled: false,
            payouts_enabled: false,
            sms_enabled: false
          })
          .where("merchant_id", "in", ["mer_airtime_funded", "mer_airtime_fx", "mer_airtime_broke"])
          .execute();

        await trx
          .updateTable("merchant_products")
          .set({
            airtime_enabled: false,
            collections_enabled: true,
            payouts_enabled: false,
            sms_enabled: false
          })
          .where("merchant_id", "=", "mer_airtime_disabled")
          .execute();

        await trx
          .insertInto("api_keys")
          .values([
            {
              created_by: "10000000-0000-0000-0000-000000000001",
              id: "key_airtime_funded",
              ip_allowlist: null,
              key_hash: hashApiKey(fundedKey, env.API_KEY_PEPPER),
              kind: "secret",
              last4: getApiKeyLast4(fundedKey),
              merchant_id: "mer_airtime_funded",
              mode: "test",
              name: "Airtime funded key",
              prefix: getApiKeyPrefix(fundedKey),
              revoked_at: null,
              scopes: ["read", "airtime"]
            },
            {
              created_by: "10000000-0000-0000-0000-000000000001",
              id: "key_airtime_fx",
              ip_allowlist: null,
              key_hash: hashApiKey(fxKey, env.API_KEY_PEPPER),
              kind: "secret",
              last4: getApiKeyLast4(fxKey),
              merchant_id: "mer_airtime_fx",
              mode: "test",
              name: "Airtime FX key",
              prefix: getApiKeyPrefix(fxKey),
              revoked_at: null,
              scopes: ["read", "airtime"]
            },
            {
              created_by: "10000000-0000-0000-0000-000000000001",
              id: "key_airtime_disabled",
              ip_allowlist: null,
              key_hash: hashApiKey(disabledKey, env.API_KEY_PEPPER),
              kind: "secret",
              last4: getApiKeyLast4(disabledKey),
              merchant_id: "mer_airtime_disabled",
              mode: "test",
              name: "Airtime disabled key",
              prefix: getApiKeyPrefix(disabledKey),
              revoked_at: null,
              scopes: ["read", "airtime"]
            },
            {
              created_by: "10000000-0000-0000-0000-000000000001",
              id: "key_airtime_broke",
              ip_allowlist: null,
              key_hash: hashApiKey(lowBalanceKey, env.API_KEY_PEPPER),
              kind: "secret",
              last4: getApiKeyLast4(lowBalanceKey),
              merchant_id: "mer_airtime_broke",
              mode: "test",
              name: "Airtime broke key",
              prefix: getApiKeyPrefix(lowBalanceKey),
              revoked_at: null,
              scopes: ["read", "airtime"]
            }
          ])
          .execute();

        await trx
          .insertInto("fx_rates")
          .values({
            active: true,
            base: "ZMW",
            captured_at: new Date(),
            id: "fxr_airtime_zmw_ghs",
            markup_bps: 0,
            quote: "GHS",
            rate: "0.50",
            source: "manual"
          })
          .execute();
      },
      { audit: false }
    );

    await seedBalance("mer_airtime_funded", "ZMW", 1_000_000n);
    await seedBalance("mer_airtime_fx", "GHS", 1_000_000n);
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

  it("rejects airtime when the product is not enabled", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${disabledKey}`,
        "idempotency-key": "airtime-disabled-1"
      },
      method: "POST",
      payload: {
        amount: 1000,
        currency: "ZMW",
        phone: "+260970000001",
        reference: "DISABLED-1"
      },
      url: "/v1/airtime"
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "product_not_enabled" }
    });
  });

  it("rejects amounts outside the network range", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${fundedKey}`,
        "idempotency-key": "airtime-amount-1"
      },
      method: "POST",
      payload: {
        amount: 1,
        currency: "ZMW",
        phone: "+260970000001",
        reference: "TOO-SMALL"
      },
      url: "/v1/airtime"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "amount_not_allowed" }
    });
  });

  it("rejects airtime when the available balance is insufficient", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${lowBalanceKey}`,
        "idempotency-key": "airtime-broke-1"
      },
      method: "POST",
      payload: {
        amount: 1000,
        currency: "ZMW",
        phone: "+260970000001",
        reference: "BROKE-1"
      },
      url: "/v1/airtime"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "insufficient_funds" }
    });
  });

  it("accepts valid bulk rows and returns rejected rows with reasons", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${fundedKey}`,
        "idempotency-key": "airtime-bulk-mixed-1"
      },
      method: "POST",
      payload: {
        items: [
          { amount: 1000, currency: "ZMW", phone: "+260970000001", reference: "OK-1" },
          { amount: 1000, currency: "ZMW", phone: "not-a-phone" },
          { amount: 1, currency: "ZMW", phone: "+260960000001" }
        ]
      },
      url: "/v1/airtime/bulk"
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      data: {
        accepted: number;
        id: string;
        rejected: number;
        rejected_rows: Array<{ code: string; index: number }>;
      };
    };

    expect(body.data.id).toMatch(/^aib_/);
    expect(body.data.accepted).toBe(1);
    expect(body.data.rejected).toBe(2);
    expect(body.data.rejected_rows.map((row) => row.index).sort()).toEqual([1, 2]);
    expect(body.data.rejected_rows.map((row) => row.code).sort()).toEqual([
      "amount_not_allowed",
      "invalid_phone_number"
    ]);
  });

  it("charges a Ghana merchant in GHS for Zambia face-value airtime", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${fxKey}`,
        "idempotency-key": "airtime-fx-1"
      },
      method: "POST",
      payload: {
        amount: 1000,
        currency: "ZMW",
        phone: "+260970000001",
        reference: "FX-1"
      },
      url: "/v1/airtime"
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      data: {
        amount: number;
        charge_amount: number;
        charge_currency: string;
        currency: string;
        discount_minor: number;
        fx_rate_id: string | null;
        network: string;
      };
    };

    expect(body.data.network).toBe("MTN");
    expect(body.data.amount).toBe(1000);
    expect(body.data.currency).toBe("ZMW");
    expect(body.data.discount_minor).toBe(30);
    expect(body.data.charge_currency).toBe("GHS");
    expect(body.data.charge_amount).toBe(485);
    expect(body.data.fx_rate_id).toBe("fxr_airtime_zmw_ghs");
  });

  it("does not resend an airtime order after an unknown timeout", async () => {
    const createResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${fundedKey}`,
        "idempotency-key": "airtime-timeout-1"
      },
      method: "POST",
      payload: {
        amount: 1000,
        currency: "ZMW",
        phone: "+260970000005",
        reference: "TIMEOUT-1"
      },
      url: "/v1/airtime"
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().data as { id: string };
    expect(created.id).toMatch(/^air_/);

    const service = new AirtimeService({
      database: builtApp.db,
      providerCatalog: new ProviderCatalog({
        database: builtApp.db,
        encryptionKey: env.ENCRYPTION_KEY
      })
    });

    await service.processPendingOrders();

    let order = await builtApp.db
      .selectFrom("airtime_orders")
      .select(["id", "provider_ref", "send_attempts", "status"])
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();

    expect(order.status).toBe("processing");
    expect(order.send_attempts).toBe(1);

    await service.processPendingOrders();

    order = await builtApp.db
      .selectFrom("airtime_orders")
      .select(["id", "provider_ref", "send_attempts", "status"])
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();

    expect(order.status).toBe("processing");
    expect(order.send_attempts).toBe(1);

    await runWithSystemScope(
      builtApp.db,
      "backdate airtime status check",
      async (trx) => {
        await trx
          .updateTable("airtime_orders")
          .set({ next_status_check_at: new Date(Date.now() - 1000) })
          .where("id", "=", created.id)
          .execute();
      },
      { audit: false }
    );

    await service.pollDueStatusChecks();

    const settled = await builtApp.db
      .selectFrom("airtime_orders")
      .select(["id", "provider_ref", "send_attempts", "status"])
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();

    expect(settled.status).toBe("successful");
    expect(settled.send_attempts).toBe(1);
    expect(settled.provider_ref).toContain("timeout_then_success");
  });

  it("records an airtime float snapshot and history row", async () => {
    const monitor = new AirtimeFloatMonitor({
      database: builtApp.db,
      floatLowMinor: 1_000_000n,
      providerCatalog: new ProviderCatalog({
        database: builtApp.db,
        encryptionKey: env.ENCRYPTION_KEY
      })
    });

    const results = await monitor.checkAll();
    expect(results.length).toBeGreaterThan(0);

    const history = await runWithSystemScope(
      builtApp.db,
      "read airtime float history in test",
      async (trx) =>
        trx.selectFrom("airtime_channel_float_history").select(["channel_id", "id", "status"]).execute(),
      { audit: false }
    );

    expect(history.length).toBeGreaterThan(0);
    expect(history[0]?.id).toMatch(/^afh_/);
    expect(["ok", "low", "empty", "unknown"]).toContain(history[0]?.status);
  });

  async function seedBalance(merchantId: string, currency: "GHS" | "ZMW", amount: bigint) {
    await runWithSystemScope(
      builtApp.db,
      `seed airtime balance for ${merchantId}`,
      async (trx) => {
        const ledger = new LedgerService(trx, {
          actorId: "adm_airtime_tester",
          actorType: "admin"
        });

        await ledger.manualAdjustment({
          amount,
          creditAccount: {
            merchantId,
            type: "merchant_available"
          },
          currency,
          debitAccount: {
            merchantId: null,
            type: "suspense"
          },
          description: `Seed airtime balance for ${merchantId}`,
          mode: "test",
          reason: "test setup",
          referenceId: `adj_${merchantId}`
        });
      },
      { audit: false }
    );
  }
});
