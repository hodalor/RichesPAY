import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";
import {
  runWithMerchantScope,
  runWithSystemScope
} from "../src/db/scope";

import type { AppDatabase } from "../src/db/client";
import type { DevPostgresHandle } from "../src/db/dev-postgres";

describe("merchant scope isolation", () => {
  let database: AppDatabase;
  let pool: ReturnType<typeof createDatabasePool>;
  let devPostgres: DevPostgresHandle;

  beforeAll(async () => {
    devPostgres = await startDevPostgres();
    pool = createDatabasePool(devPostgres.connectionString);
    database = createDatabase(pool);

    await applySqlMigrations(pool);

    await pool.query(`
      insert into auth.users (id, email)
      values
        ('10000000-0000-0000-0000-000000000001', 'merchant-a@local.test'),
        ('20000000-0000-0000-0000-000000000002', 'merchant-b@local.test')
      on conflict (id) do nothing
    `);

    await runWithSystemScope(database, "seed merchant isolation test data", async (trx) => {
      await trx
        .insertInto("merchants")
        .values([
          {
            collections_frozen: false,
            country_code: "GH",
            id: "mer_scope_a",
            legal_name: "Merchant A Ltd",
            mode: "test",
            payouts_frozen: false,
            settlement_currency: "GHS",
            status: "active",
            timezone: "Africa/Accra",
            trading_name: "Merchant A"
          },
          {
            collections_frozen: false,
            country_code: "GH",
            id: "mer_scope_b",
            legal_name: "Merchant B Ltd",
            mode: "test",
            payouts_frozen: false,
            settlement_currency: "GHS",
            status: "active",
            timezone: "Africa/Accra",
            trading_name: "Merchant B"
          }
        ])
        .execute();

      await trx
        .insertInto("memberships")
        .values([
          {
            merchant_id: "mer_scope_a",
            mode: "test",
            role: "owner",
            user_id: "10000000-0000-0000-0000-000000000001"
          },
          {
            merchant_id: "mer_scope_b",
            mode: "test",
            role: "owner",
            user_id: "20000000-0000-0000-0000-000000000002"
          }
        ])
        .execute();
    });
  }, 120000);

  afterAll(async () => {
    if (database || pool) {
      await Promise.allSettled([
        database?.destroy(),
        pool?.end()
      ]);
    }

    if (devPostgres) {
      await devPostgres.stop();
    }
  });

  it("filters reads to the active merchant even without a WHERE clause", async () => {
    const visibleMerchants = await runWithMerchantScope(
      database,
      "mer_scope_a",
      "test",
      async (trx) => trx.selectFrom("merchants").selectAll().execute()
    );

    const visibleMemberships = await runWithMerchantScope(
      database,
      "mer_scope_a",
      "test",
      async (trx) => trx.selectFrom("memberships").selectAll().execute()
    );

    expect(visibleMerchants).toHaveLength(1);
    expect(visibleMerchants[0]?.id).toBe("mer_scope_a");
    expect(visibleMemberships).toHaveLength(1);
    expect(visibleMemberships[0]?.merchant_id).toBe("mer_scope_a");
  });

  it("blocks cross-merchant updates even when code forgets the tenant predicate", async () => {
    await runWithMerchantScope(database, "mer_scope_a", "test", async (trx) => {
      await trx.updateTable("memberships").set({ role: "viewer" }).execute();
      await trx
        .updateTable("merchants")
        .set({ support_phone: "+233240000999" })
        .execute();
    });

    const memberships = await database
      .selectFrom("memberships")
      .select(["merchant_id", "role"])
      .where("merchant_id", "in", ["mer_scope_a", "mer_scope_b"])
      .orderBy("merchant_id")
      .execute();

    const merchants = await database
      .selectFrom("merchants")
      .select(["id", "support_phone"])
      .where("id", "in", ["mer_scope_a", "mer_scope_b"])
      .orderBy("id")
      .execute();

    expect(memberships).toEqual([
      { merchant_id: "mer_scope_a", role: "viewer" },
      { merchant_id: "mer_scope_b", role: "owner" }
    ]);
    expect(merchants).toEqual([
      { id: "mer_scope_a", support_phone: "+233240000999" },
      { id: "mer_scope_b", support_phone: null }
    ]);
  });
});
