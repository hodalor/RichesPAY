import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { buildApp } from "../src/app";
import { CollectionStatusPollingService } from "../src/collections";
import { createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";
import { runWithSystemScope } from "../src/db/scope";
import { LedgerService } from "../src/ledger";
import { PayoutProcessingService } from "../src/payouts";
import { publicApiPlugin } from "../src/plugins/public-api";
import { ProviderCallbackService } from "../src/providers";
import { ProviderCatalog } from "../src/providers/catalog";
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
  let checkoutPublicKey = "";
  let liveKey = "";
  let noPayoutKey = "";
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

    checkoutPublicKey = createPlainApiKey("test", "public");
    liveKey = createPlainApiKey("live", "secret");
    noPayoutKey = createPlainApiKey("test", "secret");
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
              id: "key_test_checkout_public",
              ip_allowlist: null,
              key_hash: hashApiKey(checkoutPublicKey, env.API_KEY_PEPPER),
              kind: "public",
              last4: getApiKeyLast4(checkoutPublicKey),
              merchant_id: "mer_public_test",
              mode: "test",
              name: "Checkout public key",
              prefix: getApiKeyPrefix(checkoutPublicKey),
              revoked_at: null,
              scopes: ["read", "collections", "payouts"]
            },
            {
              created_by: "10000000-0000-0000-0000-000000000001",
              id: "key_test_no_payouts",
              ip_allowlist: null,
              key_hash: hashApiKey(noPayoutKey, env.API_KEY_PEPPER),
              kind: "secret",
              last4: getApiKeyLast4(noPayoutKey),
              merchant_id: "mer_public_test",
              mode: "test",
              name: "Test key without payouts",
              prefix: getApiKeyPrefix(noPayoutKey),
              revoked_at: null,
              scopes: ["read", "collections"]
            },
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
              scopes: ["read", "collections", "payouts"]
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
              scopes: ["read", "collections", "payouts"]
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

  it("creates a failed collection immediately for the simulator insufficient funds number", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${testKey}`,
        "idempotency-key": "idem-collection-failed"
      },
      method: "POST",
      payload: {
        amount: 5000,
        currency: "GHS",
        method: "mobile_money",
        phone: "+233241230002",
        reference: "merchant-ref-failed"
      },
      url: "/v1/collections"
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: {
        amount: 5000,
        currency: "GHS",
        failure_code: "insufficient_funds",
        fee_bearer: "merchant",
        fee_minor: 175,
        net_minor: 4825,
        reference: "merchant-ref-failed",
        status: "failed"
      }
    });

    const outboxEvent = await builtApp.db
      .selectFrom("events_outbox")
      .select(["type"])
      .where("merchant_id", "=", "mer_public_test")
      .where("type", "=", "collection.failed")
      .executeTakeFirst();

    expect(outboxEvent?.type).toBe("collection.failed");
  });

  it("creates a processing collection and settles it through the polling job", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${testKey}`,
        "idempotency-key": "idem-collection-processing"
      },
      method: "POST",
      payload: {
        amount: 5000,
        currency: "GHS",
        customer: {
          email: "customer@example.com",
          name: "Customer One"
        },
        metadata: {
          cart_id: "cart_123"
        },
        method: "mobile_money",
        phone: "+233241230003",
        reference: "merchant-ref-processing"
      },
      url: "/v1/collections"
    });

    expect(response.statusCode).toBe(201);
    const created = response.json().data as {
      id: string;
      status: string;
    };
    expect(created.status).toBe("processing");

    await runWithSystemScope(
      builtApp.db,
      "backdate collection polling schedule",
      async (trx) => {
        await trx
          .updateTable("collections")
          .set({
            next_status_check_at: new Date(Date.now() - 1000)
          })
          .where("id", "=", created.id)
          .execute();
      },
      { audit: false }
    );

    const pollingService = new CollectionStatusPollingService({
      database: builtApp.db,
      providerCatalog: new ProviderCatalog({
        database: builtApp.db,
        encryptionKey: env.ENCRYPTION_KEY
      })
    });

    await pollingService.pollDueCollections();

    const getResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${testKey}`
      },
      method: "GET",
      url: `/v1/collections/${created.id}`
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      data: {
        id: created.id,
        status: "successful"
      }
    });

    const listResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${testKey}`
      },
      method: "GET",
      url: "/v1/collections?status=successful&reference=merchant-ref-processing"
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({
      data: [
        {
          id: created.id,
          reference: "merchant-ref-processing",
          status: "successful"
        }
      ],
      meta: {
        has_more: false,
        next_starting_after: null
      }
    });

    const balances = await builtApp.db
      .selectFrom("account_balances as ab")
      .innerJoin("ledger_accounts as la", "la.id", "ab.account_id")
      .select([
        "la.type as type",
        "ab.balance as balance"
      ])
      .where("la.merchant_id", "=", "mer_public_test")
      .where("la.currency", "=", "GHS")
      .where("la.type", "=", "merchant_available")
      .executeTakeFirst();

    expect(BigInt(String(balances?.balance ?? "0"))).toBe(5525n);
  });

  it("rejects a currency that does not match the phone country", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${testKey}`,
        "idempotency-key": "idem-collection-currency"
      },
      method: "POST",
      payload: {
        amount: 5000,
        currency: "GHS",
        method: "mobile_money",
        phone: "+260971230003"
      },
      url: "/v1/collections"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "unsupported_currency"
      }
    });
  });

  it("requires payouts scope for mobile money refunds", async () => {
    const createResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${testKey}`,
        "idempotency-key": "idem-mobile-refund-permission-collection"
      },
      method: "POST",
      payload: {
        amount: 5000,
        currency: "GHS",
        method: "mobile_money",
        phone: "+233241230003",
        reference: "merchant-ref-mobile-refund-permission"
      },
      url: "/v1/collections"
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().data as {
      id: string;
    };

    await runWithSystemScope(
      builtApp.db,
      "backdate mobile refund permission polling schedule",
      async (trx) => {
        await trx
          .updateTable("collections")
          .set({
            next_status_check_at: new Date(Date.now() - 1000)
          })
          .where("id", "=", created.id)
          .execute();
      },
      { audit: false }
    );

    const pollingService = new CollectionStatusPollingService({
      database: builtApp.db,
      providerCatalog: new ProviderCatalog({
        database: builtApp.db,
        encryptionKey: env.ENCRYPTION_KEY
      })
    });

    await pollingService.pollDueCollections();

    const refundResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${noPayoutKey}`,
        "idempotency-key": "idem-mobile-refund-permission"
      },
      method: "POST",
      payload: {},
      url: `/v1/collections/${created.id}/refunds`
    });

    expect(refundResponse.statusCode).toBe(403);
    expect(refundResponse.json()).toMatchObject({
      error: {
        code: "permission_denied"
      }
    });
  });

  it("rejects payouts when the merchant balance is insufficient", async () => {
    const response = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${testKey}`,
        "idempotency-key": "idem-payout-insufficient-balance"
      },
      method: "POST",
      payload: {
        amount: 100000,
        currency: "GHS",
        method: "mobile_money",
        phone: "+233241230001",
        reference: "merchant-payout-insufficient"
      },
      url: "/v1/payouts"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "insufficient_funds"
      }
    });
  });

  it("rejects payouts for merchants with frozen payouts", async () => {
    await runWithSystemScope(
      builtApp.db,
      "freeze payouts for test merchant",
      async (trx) => {
        await trx
          .updateTable("merchants")
          .set({
            payouts_frozen: true,
            payouts_freeze_reason: "compliance review"
          })
          .where("id", "=", "mer_public_test")
          .where("mode", "=", "test")
          .execute();
      },
      { audit: false }
    );

    try {
      const response = await builtApp.app.inject({
        headers: {
          authorization: `Bearer ${testKey}`,
          "idempotency-key": "idem-payouts-frozen"
        },
        method: "POST",
        payload: {
          amount: 200,
          currency: "GHS",
          method: "mobile_money",
          phone: "+233241230001",
          reference: "merchant-payout-frozen"
        },
        url: "/v1/payouts"
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: {
          code: "payouts_frozen"
        }
      });
    } finally {
      await runWithSystemScope(
        builtApp.db,
        "unfreeze payouts for test merchant",
        async (trx) => {
          await trx
            .updateTable("merchants")
            .set({
              payouts_frozen: false,
              payouts_freeze_reason: null
            })
            .where("id", "=", "mer_public_test")
            .where("mode", "=", "test")
            .execute();
        },
        { audit: false }
      );
    }
  });

  it("releases the payout hold when a queued payout is cancelled", async () => {
    const holdBefore = await getMerchantPayoutHold("mer_public_test", "test");

    const createResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${testKey}`,
        "idempotency-key": "idem-payout-cancel-create"
      },
      method: "POST",
      payload: {
        amount: 200,
        currency: "GHS",
        method: "mobile_money",
        phone: "+233241230001",
        reference: "merchant-payout-cancel"
      },
      url: "/v1/payouts"
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().data as {
      id: string;
      total_hold_minor: number;
    };

    const holdAfterCreate = await getMerchantPayoutHold("mer_public_test", "test");
    expect(holdAfterCreate - holdBefore).toBe(BigInt(created.total_hold_minor));

    const cancelResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${testKey}`,
        "idempotency-key": "idem-payout-cancel-confirm"
      },
      method: "POST",
      url: `/v1/payouts/${created.id}/cancel`
    });

    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json()).toMatchObject({
      data: {
        id: created.id,
        status: "cancelled"
      }
    });

    const holdAfterCancel = await getMerchantPayoutHold("mer_public_test", "test");
    expect(holdAfterCancel).toBe(holdBefore);
  });

  it("does not double-send payouts after a timeout before status polling resolves them", async () => {
    const createResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${testKey}`,
        "idempotency-key": "idem-payout-timeout"
      },
      method: "POST",
      payload: {
        amount: 200,
        currency: "GHS",
        method: "mobile_money",
        phone: "+233241230005",
        reference: "merchant-payout-timeout"
      },
      url: "/v1/payouts"
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().data as { id: string };

    const processingService = new PayoutProcessingService({
      database: builtApp.db,
      providerCatalog: new ProviderCatalog({
        database: builtApp.db,
        encryptionKey: env.ENCRYPTION_KEY
      })
    });

    await processingService.process();

    let payoutRow = await builtApp.db
      .selectFrom("payouts")
      .select(["id", "send_attempts", "status"])
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();

    expect(payoutRow.status).toBe("processing");
    expect(payoutRow.send_attempts).toBe(1);

    await processingService.process();

    payoutRow = await builtApp.db
      .selectFrom("payouts")
      .select(["id", "send_attempts", "status"])
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();

    expect(payoutRow.status).toBe("processing");
    expect(payoutRow.send_attempts).toBe(1);

    await runWithSystemScope(
      builtApp.db,
      "backdate payout polling schedule",
      async (trx) => {
        await trx
          .updateTable("payouts")
          .set({
            next_status_check_at: new Date(Date.now() - 1000)
          })
          .where("id", "=", created.id)
          .execute();
      },
      { audit: false }
    );

    await processingService.process();

    const settledPayoutRow = await builtApp.db
      .selectFrom("payouts")
      .select(["id", "provider_ref", "send_attempts", "status"])
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();

    expect(settledPayoutRow.status).toBe("successful");
    expect(settledPayoutRow.send_attempts).toBe(1);
    expect(settledPayoutRow.provider_ref).toContain("timeout_then_status_success");
  });

  it("expires checkout sessions after their 30 minute window", async () => {
    const createResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${checkoutPublicKey}`
      },
      method: "POST",
      payload: {
        allowed_methods: ["mobile_money"],
        amount: 5000,
        currency: "GHS",
        description: "Hosted test payment",
        success_url: "http://127.0.0.1:5173/success"
      },
      url: "/v1/checkout/sessions"
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().data as {
      id: string;
      url: string;
    };
    expect(created.id.startsWith("cs_")).toBe(true);
    expect(created.url).toContain(`/session/${created.id}?key=`);

    await runWithSystemScope(
      builtApp.db,
      "force checkout session expiry",
      async (trx) => {
        await trx
          .updateTable("checkout_sessions")
          .set({
            expires_at: new Date(Date.now() - 1000)
          })
          .where("id", "=", created.id)
          .execute();
      },
      { audit: false }
    );

    const getResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${checkoutPublicKey}`
      },
      method: "GET",
      url: `/v1/checkout/sessions/${created.id}`
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      data: {
        id: created.id,
        status: "expired"
      }
    });
  });

  it("rejects reuse of a non-reusable payment link", async () => {
    await runWithSystemScope(
      builtApp.db,
      "seed non reusable payment link",
      async (trx) => {
        await trx
          .insertInto("payment_links")
          .values({
            active: true,
            amount: 6500n,
            amount_mode: "fixed",
            currency: "GHS",
            description: "One-off payment link",
            id: "lnk_checkout_single_use",
            merchant_id: "mer_public_test",
            min_amount: null,
            mode: "test",
            reusable: false,
            slug: "single-use-link",
            title: "Single use link"
          })
          .execute();
      },
      { audit: false }
    );

    const firstResponse = await builtApp.app.inject({
      method: "POST",
      payload: {},
      url: "/v1/checkout/payment-links/single-use-link/sessions"
    });

    const secondResponse = await builtApp.app.inject({
      method: "POST",
      payload: {},
      url: "/v1/checkout/payment-links/single-use-link/sessions"
    });

    expect(firstResponse.statusCode).toBe(201);
    expect(secondResponse.statusCode).toBe(400);
    expect(secondResponse.json()).toMatchObject({
      error: {
        code: "validation_error",
        field: "slug"
      }
    });
  });

  it("runs the hosted checkout simulator flow from session creation to completion", async () => {
    const createResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${checkoutPublicKey}`
      },
      method: "POST",
      payload: {
        allowed_methods: ["mobile_money", "card"],
        amount: 5000,
        currency: "GHS",
        customer: {
          email: "checkout-customer@example.com",
          name: "Checkout Customer"
        },
        description: "Simulator checkout"
      },
      url: "/v1/checkout/sessions"
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().data as {
      id: string;
    };

    const payResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${checkoutPublicKey}`,
        "idempotency-key": "idem-checkout-simulator"
      },
      method: "POST",
      payload: {
        method: "mobile_money",
        network: "mtn",
        phone: "+233241230003"
      },
      url: `/v1/checkout/sessions/${created.id}/pay`
    });

    expect(payResponse.statusCode).toBe(200);
    expect(payResponse.json()).toMatchObject({
      data: {
        id: created.id,
        collection: {
          status: "processing"
        },
        status: "open"
      }
    });

    const collectionId = payResponse.json().data.collection.id as string;

    await runWithSystemScope(
      builtApp.db,
      "backdate checkout collection polling schedule",
      async (trx) => {
        await trx
          .updateTable("collections")
          .set({
            next_status_check_at: new Date(Date.now() - 1000)
          })
          .where("id", "=", collectionId)
          .execute();
      },
      { audit: false }
    );

    const pollingService = new CollectionStatusPollingService({
      database: builtApp.db,
      providerCatalog: new ProviderCatalog({
        database: builtApp.db,
        encryptionKey: env.ENCRYPTION_KEY
      })
    });

    await pollingService.pollDueCollections();

    const getResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${checkoutPublicKey}`
      },
      method: "GET",
      url: `/v1/checkout/sessions/${created.id}`
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      data: {
        id: created.id,
        collection: {
          id: collectionId,
          status: "successful"
        },
        status: "completed"
      }
    });
  });

  it("runs the hosted checkout card simulator flow and stores masked card details", async () => {
    const createResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${checkoutPublicKey}`
      },
      method: "POST",
      payload: {
        allowed_methods: ["card"],
        amount: 5000,
        currency: "GHS",
        customer: {
          email: "card-checkout@example.com",
          name: "Card Checkout"
        },
        description: "Hosted card payment"
      },
      url: "/v1/checkout/sessions"
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().data as {
      id: string;
    };

    const payResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${checkoutPublicKey}`,
        "idempotency-key": "idem-checkout-card-simulator"
      },
      method: "POST",
      payload: {
        method: "card"
      },
      url: `/v1/checkout/sessions/${created.id}/pay`
    });

    expect(payResponse.statusCode).toBe(200);
    expect(payResponse.json()).toMatchObject({
      data: {
        collection: {
          method: "card",
          next_action: {
            iframe_url: expect.stringContaining("/simulator/card-fields?"),
            type: "hosted_fields"
          },
          status: "processing"
        },
        id: created.id,
        status: "open"
      }
    });

    const collection = payResponse.json().data.collection as {
      id: string;
      provider_ref: string;
    };

    await processSimulatorCardCallback({
      collectionId: collection.id,
      expiryMonth: 3,
      expiryYear: 2028,
      last4: "0003",
      providerRef: collection.provider_ref
    });

    const getResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${checkoutPublicKey}`
      },
      method: "GET",
      url: `/v1/checkout/sessions/${created.id}`
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      data: {
        collection: {
          card: {
            brand: "visa",
            expiry_month: 3,
            expiry_year: 2028,
            last4: "0003"
          },
          id: collection.id,
          method: "card",
          next_action: null,
          status: "successful"
        },
        id: created.id,
        status: "completed"
      }
    });
  });

  it("creates a card refund and writes the refund success event", async () => {
    const createResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${testKey}`,
        "idempotency-key": "idem-card-refund-collection"
      },
      method: "POST",
      payload: {
        amount: 5000,
        currency: "GHS",
        customer: {
          email: "refund-card@example.com",
          name: "Refund Card"
        },
        method: "card",
        reference: "merchant-ref-card-refund"
      },
      url: "/v1/collections"
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json().data as {
      id: string;
      provider_ref: string;
      status: string;
    };
    expect(created.status).toBe("processing");

    await processSimulatorCardCallback({
      collectionId: created.id,
      expiryMonth: 8,
      expiryYear: 2029,
      last4: "0001",
      providerRef: created.provider_ref
    });

    const refundResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${testKey}`,
        "idempotency-key": "idem-card-refund-success"
      },
      method: "POST",
      payload: {
        amount: 2500
      },
      url: `/v1/collections/${created.id}/refunds`
    });

    expect(refundResponse.statusCode).toBe(201);
    expect(refundResponse.json()).toMatchObject({
      data: {
        amount: 2500,
        collection_id: created.id,
        method: "card",
        status: "successful"
      }
    });

    const getResponse = await builtApp.app.inject({
      headers: {
        authorization: `Bearer ${testKey}`
      },
      method: "GET",
      url: `/v1/collections/${created.id}`
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      data: {
        id: created.id,
        refunded_minor: 2500,
        status: "successful"
      }
    });

    const refundEvent = await builtApp.db
      .selectFrom("events_outbox")
      .select(["type"])
      .where("merchant_id", "=", "mer_public_test")
      .where("type", "=", "refund.successful")
      .orderBy("created_at", "desc")
      .executeTakeFirst();

    expect(refundEvent?.type).toBe("refund.successful");
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

  async function getMerchantPayoutHold(merchantId: string, mode: "live" | "test") {
    const balance = await builtApp.db
      .selectFrom("ledger_accounts as la")
      .leftJoin("account_balances as ab", "ab.account_id", "la.id")
      .select(["ab.balance as balance"])
      .where("la.merchant_id", "=", merchantId)
      .where("la.mode", "=", mode)
      .where("la.type", "=", "merchant_payout_hold")
      .where("la.currency", "=", "GHS")
      .executeTakeFirst();

    return BigInt(String(balance?.balance ?? "0"));
  }

  async function processSimulatorCardCallback(input: {
    collectionId: string;
    expiryMonth: number;
    expiryYear: number;
    last4: string;
    providerRef: string;
  }) {
    const callbackService = new ProviderCallbackService({
      catalog: new ProviderCatalog({
        database: builtApp.db,
        encryptionKey: env.ENCRYPTION_KEY
      }),
      database: builtApp.db
    });

    try {
      const rawBody = JSON.stringify({
        event_type: "collection.updated",
        payment_instrument: {
          brand: "visa",
          expiry_month: input.expiryMonth,
          expiry_year: input.expiryYear,
          last4: input.last4
        },
        provider_ref: input.providerRef,
        resource_id: input.collectionId,
        resource_type: "collection",
        to_status: "succeeded"
      });

      await callbackService.handleInboundCallback({
        channelId: "chn_simulator_card_test",
        headers: {
          "content-type": "application/json",
          "x-richespay-simulator-signature": "ok"
        },
        ip: "127.0.0.1",
        rawBody
      });

      const callback = await builtApp.db
        .selectFrom("provider_callbacks")
        .select(["id"])
        .where("channel_id", "=", "chn_simulator_card_test")
        .orderBy("received_at", "desc")
        .executeTakeFirstOrThrow();

      await callbackService.processCallback(callback.id);
    } finally {
      await callbackService.close();
    }
  }
});
