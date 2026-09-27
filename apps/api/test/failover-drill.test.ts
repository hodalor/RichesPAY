import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CollectionService,
  CollectionStatusPollingService
} from "../src/collections";
import { createDatabase, createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";
import { runWithSystemScope } from "../src/db";
import { ProviderCatalog } from "../src/providers";

import type { AppDatabase } from "../src/db";
import type { DevPostgresHandle } from "../src/db/dev-postgres";

describe("channel failover drill", () => {
  let collectionService: CollectionService;
  let database: AppDatabase;
  let devPostgres: DevPostgresHandle;
  let pool: ReturnType<typeof createDatabasePool>;
  let pollingService: CollectionStatusPollingService;

  beforeAll(async () => {
    devPostgres = await startDevPostgres();
    pool = createDatabasePool(devPostgres.connectionString);
    database = createDatabase(pool);

    await applySqlMigrations(pool);

    const providerCatalog = new ProviderCatalog({
      database,
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    });

    collectionService = new CollectionService({
      database,
      providerCatalog
    });
    pollingService = new CollectionStatusPollingService({
      database,
      providerCatalog
    });

    await runWithSystemScope(database, "seed failover drill fixtures", async (trx) => {
      await trx
        .insertInto("merchants")
        .values({
          collections_frozen: false,
          country_code: "GH",
          id: "mer_failover_live",
          legal_name: "Failover Drill Merchant",
          mode: "live",
          payouts_frozen: false,
          settlement_currency: "GHS",
          status: "active",
          timezone: "Africa/Accra",
          trading_name: "Failover Drill Merchant"
        })
        .execute();

      await trx
        .insertInto("msisdn_prefixes")
        .values({
          country_code: "GH",
          network: "mtn",
          prefix: "23324"
        })
        .onConflict((conflict) => conflict.columns(["country_code", "prefix"]).doNothing())
        .execute();

      await trx
        .insertInto("channels")
        .values([
          {
            capabilities: ["collect"],
            config: {},
            country_code: "GH",
            credentials_encrypted: "enc",
            health: "healthy",
            id: "chn_live_mtn_primary",
            kind: "mobile_money",
            mode: "live",
            network: "mtn",
            priority: 1,
            provider_code: "stub_primary",
            status: "active"
          },
          {
            capabilities: ["collect"],
            config: {},
            country_code: "GH",
            credentials_encrypted: "enc",
            health: "healthy",
            id: "chn_live_mtn_backup",
            kind: "mobile_money",
            mode: "live",
            network: "mtn",
            priority: 2,
            provider_code: "stub_backup",
            status: "active"
          }
        ])
        .execute();

      await trx
        .insertInto("routing_rules")
        .values({
          capability: "collect",
          channel_ids: ["chn_live_mtn_primary", "chn_live_mtn_backup"],
          country_code: "GH",
          id: "rrl_live_mtn_collect",
          kind: "mobile_money",
          network: "mtn"
        })
        .execute();
    }, { audit: false });
  }, 120000);

  afterAll(async () => {
    if (database || pool) {
      await Promise.allSettled([database?.destroy(), pool?.end()]);
    }

    if (devPostgres) {
      await devPostgres.stop();
    }
  });

  it("routes new MTN live traffic to backup after the primary goes down while in-flight collections still resolve via polling", async () => {
    const inFlight = await collectionService.create({
      amountMinor: 5000n,
      currency: "GHS",
      customerEmail: null,
      customerName: null,
      description: "Primary before failover",
      idempotencyKey: null,
      merchantId: "mer_failover_live",
      metadata: {},
      method: "mobile_money",
      mode: "live",
      network: null,
      phone: "+233241230005",
      reference: "failover-primary",
      requestId: "req_failover_primary"
    });

    expect(inFlight.channelId).toBe("chn_live_mtn_primary");
    expect(inFlight.status).toBe("processing");

    await runWithSystemScope(database, "mark primary MTN channel down", async (trx) => {
      await trx
        .updateTable("channels")
        .set({
          health: "down"
        })
        .where("id", "=", "chn_live_mtn_primary")
        .execute();
    }, { audit: false });

    const rerouted = await collectionService.create({
      amountMinor: 5000n,
      currency: "GHS",
      customerEmail: null,
      customerName: null,
      description: "Backup after failover",
      idempotencyKey: null,
      merchantId: "mer_failover_live",
      metadata: {},
      method: "mobile_money",
      mode: "live",
      network: null,
      phone: "+233241230003",
      reference: "failover-backup",
      requestId: "req_failover_backup"
    });

    expect(rerouted.channelId).toBe("chn_live_mtn_backup");
    expect(rerouted.status).toBe("processing");

    await runWithSystemScope(database, "backdate in-flight failover collection polling", async (trx) => {
      await trx
        .updateTable("collections")
        .set({
          next_status_check_at: new Date(Date.now() - 1000)
        })
        .where("id", "=", inFlight.id)
        .execute();
    }, { audit: false });

    await pollingService.pollDueCollections();

    const settled = await collectionService.getById(
      "mer_failover_live",
      "live",
      inFlight.id
    );

    expect(settled.status).toBe("successful");
    expect(settled.channelId).toBe("chn_live_mtn_primary");
  });
});
