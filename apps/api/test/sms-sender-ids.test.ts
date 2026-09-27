import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";

import { buildApp } from "../src/app";
import { createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";
import { runWithSystemScope } from "../src/db/scope";
import { SenderIdService } from "../src/sms";

import type { DevPostgresHandle } from "../src/db/dev-postgres";
import type { AppEnv } from "../src/env";

describe("sms sender IDs", () => {
  let adminToken = "";
  let builtApp: Awaited<ReturnType<typeof buildApp>>;
  let dashboardToken = "";
  let devPostgres: DevPostgresHandle;
  let env: AppEnv;

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

    dashboardToken = await signToken(env.SUPABASE_JWT_SECRET, {
      aal: "aal2",
      email: "developer@richespay.test",
      sub: "10000000-0000-0000-0000-000000000001"
    });
    adminToken = await signToken(env.SUPABASE_JWT_SECRET, {
      aal: "aal2",
      email: "admin@richespay.test",
      sub: "20000000-0000-0000-0000-000000000002"
    });

    await builtApp.dbPool.query(`
      insert into auth.users (id, email)
      values
        ('10000000-0000-0000-0000-000000000001', 'developer@richespay.test'),
        ('20000000-0000-0000-0000-000000000002', 'admin@richespay.test')
      on conflict (id) do nothing
    `);

    await runWithSystemScope(
      builtApp.db,
      "seed sms sender id tests",
      async (trx) => {
        await trx
          .insertInto("merchants")
          .values({
            collections_frozen: false,
            country_code: "GH",
            id: "mer_sms_live",
            legal_name: "SMS Merchant",
            mode: "live",
            payouts_frozen: false,
            settlement_currency: "GHS",
            status: "active",
            support_email: "support@sms-merchant.test",
            timezone: "Africa/Accra",
            trading_name: "SMS Merchant"
          })
          .execute();

        await trx
          .insertInto("memberships")
          .values({
            merchant_id: "mer_sms_live",
            mode: "live",
            role: "developer",
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

        await trx
          .insertInto("channels")
          .values([
            {
              capabilities: ["sms"],
              config: {},
              country_code: "GH",
              credentials_encrypted: "{}",
              health: "healthy",
              id: "chn_sms_http_primary_live",
              kind: "sms",
              mode: "live",
              network: "mtn",
              priority: 1,
              provider_code: "sms_http",
              status: "active"
            },
            {
              capabilities: ["sms"],
              config: {},
              country_code: "GH",
              credentials_encrypted: "{}",
              health: "healthy",
              id: "chn_sms_simulator_secondary_live",
              kind: "sms",
              mode: "live",
              network: "mtn",
              priority: 2,
              provider_code: "simulator",
              status: "active"
            }
          ])
          .execute();

        await trx
          .insertInto("sender_ids")
          .values({
            authorization_letter: "private/sender-ids/ops-alert.pdf",
            created_by: "10000000-0000-0000-0000-000000000001",
            id: "sid_opsalert",
            merchant_id: "mer_sms_live",
            mode: "live",
            purpose: "transactional",
            sample_message: "Payment received from RichesPay.",
            sender_id: "OPSALERT"
          })
          .execute();

        await trx
          .insertInto("sender_id_approvals")
          .values({
            country_code: "GH",
            id: "sia_opsalert_mtn",
            merchant_id: "mer_sms_live",
            mode: "live",
            network: "mtn",
            rejection_reason: null,
            sender_id_id: "sid_opsalert",
            status: "approved",
            updated_by: "20000000-0000-0000-0000-000000000002"
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
        builtApp.db.destroy(),
        builtApp.dbPool.end()
      ]);
    }

    if (devPostgres) {
      await devPostgres.stop();
    }
  });

  it("creates sender ID requests in the dashboard and processes them in the admin queue", async () => {
    const createResponse = await builtApp.app.inject({
      headers: dashboardHeaders(dashboardToken),
      method: "POST",
      payload: {
        authorization_letter_path: "private/sender-ids/brandgh.pdf",
        countries: ["GH"],
        purpose: "transactional",
        sample_message: "Your payout has been processed.",
        sender_id: "BRANDGH"
      },
      url: "/dashboard/v1/sms/sender-ids"
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json()).toMatchObject({
      data: {
        approvals: [
          {
            country_code: "GH",
            network: "mtn",
            status: "pending"
          }
        ],
        overall_status: "pending",
        sender_id: "BRANDGH"
      }
    });

    const listResponse = await builtApp.app.inject({
      headers: dashboardHeaders(dashboardToken),
      method: "GET",
      url: "/dashboard/v1/sms/sender-ids"
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({
      data: {
        items: expect.arrayContaining([
          expect.objectContaining({
            sender_id: "BRANDGH"
          })
        ]),
        summary: {
          approved: 1,
          pending: 1,
          rejected: 0
        }
      }
    });

    const queueResponse = await builtApp.app.inject({
      headers: adminHeaders(adminToken),
      method: "GET",
      url: "/admin/v1/sms/sender-ids/queue?country_code=GH&network=mtn"
    });

    expect(queueResponse.statusCode).toBe(200);
    expect(queueResponse.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          merchant_id: "mer_sms_live",
          sender_id: "BRANDGH",
          status: "pending"
        })
      ])
    });

    const approval = (
      queueResponse.json() as {
        data: Array<{ approval_id: string; sender_id: string }>;
      }
    ).data.find((row) => row.sender_id === "BRANDGH");
    expect(approval).toBeDefined();

    const sheetResponse = await builtApp.app.inject({
      headers: adminHeaders(adminToken),
      method: "GET",
      url: "/admin/v1/sms/sender-ids/submission-sheet?country_code=GH&network=mtn"
    });

    expect(sheetResponse.statusCode).toBe(200);
    expect(sheetResponse.json()).toMatchObject({
      data: {
        csv: expect.stringContaining("BRANDGH"),
        file_name: "sender-ids-gh-mtn.csv"
      }
    });

    const approveResponse = await builtApp.app.inject({
      headers: adminHeaders(adminToken),
      method: "POST",
      payload: {
        reason: "Approved by MTN Ghana"
      },
      url: `/admin/v1/sms/sender-ids/${approval!.approval_id}/approve`
    });

    expect(approveResponse.statusCode).toBe(200);
    expect(approveResponse.json()).toMatchObject({
      data: {
        approval_id: approval!.approval_id,
        status: "approved"
      }
    });

    const notification = await builtApp.db
      .selectFrom("merchant_notifications")
      .select(["title", "type"])
      .where("merchant_id", "=", "mer_sms_live")
      .where("type", "=", "sender_id.approved")
      .orderBy("created_at", "desc")
      .executeTakeFirst();

    expect(notification).toMatchObject({
      title: "Sender ID approved on mtn",
      type: "sender_id.approved"
    });

    const email = await builtApp.db
      .selectFrom("email_outbox")
      .select(["recipient_email", "subject"])
      .where("merchant_id", "=", "mer_sms_live")
      .orderBy("created_at", "desc")
      .executeTakeFirst();

    expect(email).toMatchObject({
      recipient_email: "support@sms-merchant.test",
      subject: "Sender ID approved on mtn for SMS Merchant"
    });
  });

  it("updates platform OTP fallback settings through the admin API", async () => {
    const updateResponse = await builtApp.app.inject({
      headers: adminHeaders(adminToken),
      method: "PUT",
      payload: {
        default_otp_sender_id: "RICHESPAY"
      },
      url: "/admin/v1/sms/platform-settings/live"
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      data: {
        default_otp_sender_id: "RICHESPAY",
        mode: "live"
      }
    });

    const getResponse = await builtApp.app.inject({
      headers: adminHeaders(adminToken),
      method: "GET",
      url: "/admin/v1/sms/platform-settings/live"
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      data: {
        default_otp_sender_id: "RICHESPAY",
        mode: "live"
      }
    });
  });

  it("falls back to the platform default sender ID for OTP when the merchant has none approved", async () => {
    const service = new SenderIdService({
      database: builtApp.db,
      encryptionKey: env.ENCRYPTION_KEY
    });

    await expect(
      service.resolveSenderId({
        countryCode: "GH",
        merchantId: "mer_sms_live",
        mode: "live",
        network: "mtn",
        purpose: "otp"
      })
    ).resolves.toEqual({
      senderId: "RICHESPAY",
      source: "platform_default"
    });
  });

  it("fails over to the next SMS route after a submit failure", async () => {
    const service = new SenderIdService({
      database: builtApp.db,
      encryptionKey: env.ENCRYPTION_KEY
    });

    const dispatched = await service.dispatch({
      body: "Payment received.",
      countryCode: "GH",
      merchantId: "mer_sms_live",
      mode: "live",
      network: "mtn",
      purpose: "transactional",
      reference: "sms_failover_001",
      requestId: "req_sms_failover_001",
      to: "+233241230001"
    });

    expect(dispatched.channel.id).toBe("chn_sms_simulator_secondary_live");
    expect(dispatched.providerResult).toMatchObject({
      outcome: "accepted",
      providerStatus: "accepted"
    });
    expect(dispatched.senderId).toBe("OPSALERT");
    expect(dispatched.senderSource).toBe("merchant");
  });
});

function adminHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "x-forwarded-for": "10.0.0.15"
  };
}

function dashboardHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "x-merchant-id": "mer_sms_live"
  };
}

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
