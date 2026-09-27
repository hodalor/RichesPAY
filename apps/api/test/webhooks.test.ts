import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";

import { buildApp } from "../src/app";
import { createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";
import { runWithSystemScope } from "../src/db/scope";
import { resolveWebhookTargetAddress, signWebhookPayload, WebhookService } from "../src/webhooks";

import type { DevPostgresHandle } from "../src/db/dev-postgres";
import type { AppEnv } from "../src/env";

describe("webhooks", () => {
  let devPostgres: DevPostgresHandle;
  let env: AppEnv;
  let builtApp: Awaited<ReturnType<typeof buildApp>>;
  let dashboardToken = "";

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

    await builtApp.dbPool.query(`
      insert into auth.users (id, email)
      values ('10000000-0000-0000-0000-000000000001', 'developer@richespay.test')
      on conflict (id) do nothing
    `);

    await runWithSystemScope(
      builtApp.db,
      "seed webhook tests",
      async (trx) => {
        await trx
          .insertInto("merchants")
          .values({
            collections_frozen: false,
            country_code: "GH",
            id: "mer_webhooks",
            legal_name: "Webhook Merchant",
            mode: "live",
            payouts_frozen: false,
            settlement_currency: "GHS",
            status: "active",
            support_email: "support@merchant.test",
            timezone: "Africa/Accra",
            trading_name: "Webhook Merchant"
          })
          .execute();

        await trx
          .insertInto("memberships")
          .values({
            merchant_id: "mer_webhooks",
            mode: "live",
            role: "developer",
            user_id: "10000000-0000-0000-0000-000000000001"
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

  it("creates dashboard webhook endpoints and delivers signed test events", async () => {
    const createResponse = await builtApp.app.inject({
      headers: dashboardHeaders(dashboardToken),
      method: "POST",
      payload: {
        description: "Primary webhook",
        events: ["collection.successful"],
        url: "https://merchant.example/webhooks"
      },
      url: "/dashboard/v1/webhooks"
    });

    expect(createResponse.statusCode).toBe(201);
    const createdBody = createResponse.json() as {
      data: {
        endpoint: {
          id: string;
        };
        signing_secret: string;
      };
    };
    expect(createdBody.data.signing_secret.startsWith("whsec_")).toBe(true);

    const capturedRequests: Array<{
      body: string;
      headers: Record<string, string>;
      url: string;
    }> = [];

    const webhookService = new WebhookService({
      database: builtApp.db,
      deliveryClient: {
        async postJson(input) {
          capturedRequests.push(input);
          return {
            body: JSON.stringify({ ok: true }),
            durationMs: 42,
            statusCode: 200
          };
        }
      },
      encryptionKey: env.ENCRYPTION_KEY
    });

    const delivery = await webhookService.sendTestEvent({
      endpointId: createdBody.data.endpoint.id,
      merchantId: "mer_webhooks",
      mode: "live"
    });

    expect(delivery.statusCode).toBe(200);
    expect(delivery.deliveredAt).not.toBeNull();
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]!.url).toBe("https://merchant.example/webhooks");

    const signatureHeader = capturedRequests[0]!.headers["richespay-signature"];
    expect(signatureHeader).toBeDefined();
    const [timestampPart, signaturePart] = signatureHeader!.split(",");
    const timestamp = Number(timestampPart!.slice(2));
    const signature = signaturePart!.slice(3);

    expect(signature).toBe(
      signWebhookPayload(
        createdBody.data.signing_secret,
        capturedRequests[0]!.body,
        timestamp
      )
    );

    expect(JSON.parse(capturedRequests[0]!.body)).toMatchObject({
      data: {
        message: "This is a test webhook from RichesPay."
      },
      id: delivery.eventId,
      mode: "live",
      type: "webhook.test"
    });
    expect(JSON.parse(capturedRequests[0]!.body).data.target_endpoint_id).toBeUndefined();

    const rollResponse = await builtApp.app.inject({
      headers: dashboardHeaders(dashboardToken),
      method: "POST",
      url: `/dashboard/v1/webhooks/${createdBody.data.endpoint.id}/roll-secret`
    });

    expect(rollResponse.statusCode).toBe(200);
    expect(rollResponse.json()).toMatchObject({
      data: {
        signing_secret: expect.stringMatching(/^whsec_/)
      }
    });

    const deliveryListResponse = await builtApp.app.inject({
      headers: dashboardHeaders(dashboardToken),
      method: "GET",
      url: `/dashboard/v1/webhooks/deliveries?endpoint_id=${createdBody.data.endpoint.id}`
    });

    expect(deliveryListResponse.statusCode).toBe(200);
    expect(deliveryListResponse.json()).toMatchObject({
      data: [
        expect.objectContaining({
          endpoint_id: createdBody.data.endpoint.id,
          event_id: delivery.eventId,
          status_code: 200
        })
      ]
    });
  });

  it("disables an endpoint after twenty consecutive failures and queues an email alert", async () => {
    const failingService = new WebhookService({
      database: builtApp.db,
      deliveryClient: {
        async postJson() {
          return {
            body: JSON.stringify({ error: "downstream_unavailable" }),
            durationMs: 17,
            statusCode: 500
          };
        }
      },
      encryptionKey: env.ENCRYPTION_KEY
    });

    const created = await failingService.createEndpoint({
      description: "Failing endpoint",
      events: ["*"],
      merchantId: "mer_webhooks",
      mode: "live",
      url: "https://merchant.example/failing"
    });

    let latest = await failingService.sendTestEvent({
      endpointId: created.endpoint.id,
      merchantId: "mer_webhooks",
      mode: "live"
    });

    for (let attempt = 1; attempt < 20; attempt += 1) {
      latest = await failingService.replayDelivery({
        endpointId: created.endpoint.id,
        eventId: latest.eventId,
        merchantId: "mer_webhooks",
        mode: "live"
      });
    }

    expect(latest.disabledEndpoint).toBe(true);
    expect(latest.endpointConsecutiveFailures).toBe(20);
    expect(latest.nextRetryAt).toBeNull();

    const endpoints = await failingService.listEndpoints("mer_webhooks", "live");
    const failedEndpoint = endpoints.find((item) => item.id === created.endpoint.id);
    expect(failedEndpoint?.enabled).toBe(false);
    expect(failedEndpoint?.consecutiveFailures).toBe(20);

    const queuedEmails = await runWithSystemScope(
      builtApp.db,
      "list webhook failure emails",
      async (trx) =>
        trx
          .selectFrom("email_outbox")
          .select(["recipient_email", "subject"])
          .where("merchant_id", "=", "mer_webhooks")
          .where("subject", "=", "Webhook endpoint disabled for Webhook Merchant")
          .execute(),
      { audit: false }
    );

    expect(queuedEmails.length).toBeGreaterThan(0);
  });

  it("blocks loopback destinations during SSRF checks", async () => {
    await expect(
      resolveWebhookTargetAddress(
        new URL("https://merchant.example/webhooks"),
        async () => ["127.0.0.1"]
      )
    ).rejects.toThrow(/blocked IP address/i);
  });
});

function dashboardHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "x-merchant-id": "mer_webhooks"
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
