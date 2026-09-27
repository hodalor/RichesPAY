import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";
import { createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";
import { runWithSystemScope } from "../src/db/scope";
import { LedgerService } from "../src/ledger";
import {
  createPlainApiKey,
  getApiKeyLast4,
  getApiKeyPrefix,
  hashApiKey
} from "../src/public-api/api-keys";
import { countSmsSegments } from "../src/sms/text";

import type { DevPostgresHandle } from "../src/db/dev-postgres";
import type { AppEnv } from "../src/env";

describe("public sms api", () => {
  let builtApp: Awaited<ReturnType<typeof buildApp>>;
  let devPostgres: DevPostgresHandle;
  let env: AppEnv;
  let lowBalanceKey = "";
  let smsKey = "";

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

    smsKey = createPlainApiKey("test", "secret");
    lowBalanceKey = createPlainApiKey("test", "secret");

    await builtApp.dbPool.query(`
      insert into auth.users (id, email)
      values ('10000000-0000-0000-0000-000000000001', 'merchant-owner@richespay.test')
      on conflict (id) do nothing
    `);

    await runWithSystemScope(
      builtApp.db,
      "seed sms public api tests",
      async (trx) => {
        await trx
          .insertInto("merchants")
          .values([
            {
              collections_frozen: false,
              country_code: "GH",
              id: "mer_sms_public_test",
              legal_name: "SMS Public Merchant",
              mode: "test",
              payouts_frozen: false,
              settlement_currency: "GHS",
              status: "active",
              timezone: "Africa/Accra",
              trading_name: "SMS Public Merchant"
            },
            {
              collections_frozen: false,
              country_code: "GH",
              id: "mer_sms_low_balance",
              legal_name: "Low Balance SMS Merchant",
              mode: "test",
              payouts_frozen: false,
              settlement_currency: "GHS",
              status: "active",
              timezone: "Africa/Accra",
              trading_name: "Low Balance SMS Merchant"
            }
          ])
          .execute();

        await trx
          .insertInto("api_keys")
          .values([
            {
              created_by: "10000000-0000-0000-0000-000000000001",
              id: "key_sms_public_test",
              ip_allowlist: null,
              key_hash: hashApiKey(smsKey, env.API_KEY_PEPPER),
              kind: "secret",
              last4: getApiKeyLast4(smsKey),
              merchant_id: "mer_sms_public_test",
              mode: "test",
              name: "SMS key",
              prefix: getApiKeyPrefix(smsKey),
              revoked_at: null,
              scopes: ["read", "sms"]
            },
            {
              created_by: "10000000-0000-0000-0000-000000000001",
              id: "key_sms_low_balance",
              ip_allowlist: null,
              key_hash: hashApiKey(lowBalanceKey, env.API_KEY_PEPPER),
              kind: "secret",
              last4: getApiKeyLast4(lowBalanceKey),
              merchant_id: "mer_sms_low_balance",
              mode: "test",
              name: "Low balance SMS key",
              prefix: getApiKeyPrefix(lowBalanceKey),
              revoked_at: null,
              scopes: ["read", "sms"]
            }
          ])
          .execute();

        await trx
          .updateTable("platform_sms_settings")
          .set({
            default_otp_sender_id: "RICHESPAY",
            updated_by: "10000000-0000-0000-0000-000000000001"
          })
          .where("mode", "=", "test")
          .execute();

        await trx
          .updateTable("sms_prices")
          .set({
            currency: "GHS",
            price_per_segment_minor: 5
          })
          .where("country_code", "=", "GH")
          .where("network", "is", null)
          .execute();

        await trx
          .insertInto("msisdn_prefixes")
          .values({
            country_code: "GH",
            network: "mtn",
            prefix: "23324"
          })
          .execute();

        await trx
          .insertInto("sender_ids")
          .values([
            {
              authorization_letter: "private/sender-ids/alerts.pdf",
              created_by: "10000000-0000-0000-0000-000000000001",
              id: "sid_alerts_sms_test",
              merchant_id: "mer_sms_public_test",
              mode: "test",
              purpose: "transactional",
              sample_message: "Payment received.",
              sender_id: "ALERTS"
            },
            {
              authorization_letter: "private/sender-ids/market.pdf",
              created_by: "10000000-0000-0000-0000-000000000001",
              id: "sid_market_sms_test",
              merchant_id: "mer_sms_public_test",
              mode: "test",
              purpose: "marketing",
              sample_message: "Promo alert.",
              sender_id: "MARKET"
            },
            {
              authorization_letter: "private/sender-ids/lowbal.pdf",
              created_by: "10000000-0000-0000-0000-000000000001",
              id: "sid_lowbal_sms_test",
              merchant_id: "mer_sms_low_balance",
              mode: "test",
              purpose: "transactional",
              sample_message: "Low balance alert.",
              sender_id: "LOWBAL"
            }
          ])
          .execute();

        await trx
          .insertInto("sender_id_approvals")
          .values([
            {
              country_code: "GH",
              id: "sia_alerts_sms_test",
              merchant_id: "mer_sms_public_test",
              mode: "test",
              network: "mtn",
              rejection_reason: null,
              sender_id_id: "sid_alerts_sms_test",
              status: "approved",
              updated_by: "10000000-0000-0000-0000-000000000001"
            },
            {
              country_code: "GH",
              id: "sia_market_sms_test",
              merchant_id: "mer_sms_public_test",
              mode: "test",
              network: "mtn",
              rejection_reason: null,
              sender_id_id: "sid_market_sms_test",
              status: "approved",
              updated_by: "10000000-0000-0000-0000-000000000001"
            },
            {
              country_code: "GH",
              id: "sia_lowbal_sms_test",
              merchant_id: "mer_sms_low_balance",
              mode: "test",
              network: "mtn",
              rejection_reason: null,
              sender_id_id: "sid_lowbal_sms_test",
              status: "approved",
              updated_by: "10000000-0000-0000-0000-000000000001"
            }
          ])
          .execute();

        await trx
          .insertInto("sms_opt_outs")
          .values({
            id: "soo_sms_opt_out_test",
            merchant_id: "mer_sms_public_test",
            mode: "test",
            phone: "+233241230002"
          })
          .execute();
      },
      { audit: false }
    );

    await seedBalance("mer_sms_public_test", 500n);
    await seedBalance("mer_sms_low_balance", 5n);
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

  it("counts UCS-2 segments for emoji messages", async () => {
    expect(countSmsSegments("😊".repeat(71))).toEqual({
      encoding: "ucs2",
      segments: 2
    });
  });

  it("rejects sends when the merchant balance is insufficient", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${lowBalanceKey}`,
        "idempotency-key": "sms-low-balance-1"
      },
      method: "POST",
      payload: {
        message: "A".repeat(500),
        sender_id: "LOWBAL",
        to: "+233241230001",
        type: "transactional"
      },
      url: "/v1/sms"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "insufficient_funds"
      }
    });
  });

  it("rejects unapproved sender IDs", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${smsKey}`,
        "idempotency-key": "sms-unapproved-sender-1"
      },
      method: "POST",
      payload: {
        message: "Hello from RichesPay",
        sender_id: "LOWBAL",
        to: "+233241230001",
        type: "transactional"
      },
      url: "/v1/sms"
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: "sender_id_unavailable"
      }
    });
  });

  it("skips opted-out numbers in marketing bulk sends", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${smsKey}`,
        "idempotency-key": "sms-bulk-opt-out-1"
      },
      method: "POST",
      payload: {
        message: "Hello {{name}}, new promo available.",
        sender_id: "MARKET",
        to: [
          { name: "Alice", phone: "+233241230001" },
          { name: "Bob", phone: "+233241230002" }
        ],
        type: "marketing"
      },
      url: "/v1/sms/bulk"
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: {
        accepted_count: 1,
        rejected_count: 1,
        total_count: 2
      }
    });

    const batchId = (response.json() as { data: { batch_id: string } }).data.batch_id;
    const batchResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${smsKey}`
      },
      method: "GET",
      url: `/v1/sms/batches/${batchId}`
    });

    expect(batchResponse.statusCode).toBe(200);
    expect(batchResponse.json()).toMatchObject({
      data: {
        accepted_count: 1,
        rejected_count: 1,
        messages: [
          {
            sender_id: "MARKET",
            status: "queued",
            to: "+233241230001",
            type: "marketing"
          }
        ]
      }
    });
  });

  it("expires OTPs and enforces the attempt limit", async () => {
    const expiredOtpResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${smsKey}`,
        "idempotency-key": "otp-expired-1"
      },
      method: "POST",
      payload: {
        expires_in_seconds: 30,
        length: 6,
        to: "+233241230001"
      },
      url: "/v1/otp/send"
    });

    expect(expiredOtpResponse.statusCode).toBe(201);
    const expiredOtpId = (
      expiredOtpResponse.json() as { data: { otp_id: string } }
    ).data.otp_id;

    await builtApp.db
      .updateTable("sms_otps")
      .set({
        expires_at: new Date(Date.now() - 1000)
      })
      .where("id", "=", expiredOtpId)
      .execute();

    const expiredVerifyResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${smsKey}`
      },
      method: "POST",
      payload: {
        code: "000000",
        otp_id: expiredOtpId
      },
      url: "/v1/otp/verify"
    });

    expect(expiredVerifyResponse.statusCode).toBe(200);
    expect(expiredVerifyResponse.json()).toMatchObject({
      data: {
        status: "expired",
        verified: false
      }
    });

    const attemptOtpResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${smsKey}`,
        "idempotency-key": "otp-attempts-1"
      },
      method: "POST",
      payload: {
        expires_in_seconds: 30,
        length: 6,
        to: "+233241230001"
      },
      url: "/v1/otp/send"
    });

    expect(attemptOtpResponse.statusCode).toBe(201);
    const attemptOtpId = (
      attemptOtpResponse.json() as { data: { otp_id: string } }
    ).data.otp_id;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const verifyResponse = await builtApp.app.inject({
        headers: {
          authorization: `Bearer ${smsKey}`
        },
        method: "POST",
        payload: {
          code: "111111",
          otp_id: attemptOtpId
        },
        url: "/v1/otp/verify"
      });

      expect(verifyResponse.statusCode).toBe(200);
      const body = verifyResponse.json() as {
        data: {
          attempts: number;
          status: string;
          verified: boolean;
        };
      };

      expect(body.data.attempts).toBe(attempt);
      expect(body.data.verified).toBe(false);
      expect(body.data.status).toBe(attempt === 5 ? "failed" : "pending");
    }
  });

  async function seedBalance(merchantId: string, amount: bigint) {
    await runWithSystemScope(
      builtApp.db,
      `seed sms balance for ${merchantId}`,
      async (trx) => {
        const ledger = new LedgerService(trx, {
          actorId: "adm_sms_public_tester",
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
          mode: "test",
          reason: "test setup",
          referenceId: `adj_${merchantId}`
        });
      },
      { audit: false }
    );
  }
});
