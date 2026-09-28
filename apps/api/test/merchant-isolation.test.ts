import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CheckoutService } from "../src/checkout/service";
import { createDatabase, createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";
import {
  registerDatabase,
  runWithMerchantScope,
  runWithSystemScope,
  setRoleSwitchingEnabledForTests
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
    registerDatabase(database);

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

  it("does not leak payment links across merchants when RLS is bypassed", async () => {
    await runWithSystemScope(database, "seed payment links for isolation", async (trx) => {
      await trx
        .insertInto("payment_links")
        .values([
          {
            active: true,
            amount: 10000,
            amount_mode: "fixed",
            currency: "GHS",
            description: null,
            id: "lnk_scope_a",
            merchant_id: "mer_scope_a",
            min_amount: null,
            mode: "test",
            reusable: true,
            slug: "link-merchant-a",
            title: "Merchant A link"
          },
          {
            active: true,
            amount: 2500,
            amount_mode: "fixed",
            currency: "GHS",
            description: null,
            id: "lnk_scope_b",
            merchant_id: "mer_scope_b",
            min_amount: null,
            mode: "test",
            reusable: true,
            slug: "link-merchant-b",
            title: "Merchant B link"
          }
        ])
        .execute();
    });

    setRoleSwitchingEnabledForTests(false);
    try {
      const visibleLinks = await runWithMerchantScope(
        database,
        "mer_scope_a",
        "test",
        async (trx) => trx.selectFrom("payment_links").selectAll().execute()
      );

      expect(visibleLinks).toHaveLength(1);
      expect(visibleLinks[0]?.id).toBe("lnk_scope_a");
      expect(visibleLinks[0]?.merchant_id).toBe("mer_scope_a");

      const checkoutService = new CheckoutService({
        database,
        encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
      });
      const merchantALinks = await checkoutService.listPaymentLinks("mer_scope_a", "test");
      const merchantBLinks = await checkoutService.listPaymentLinks("mer_scope_b", "test");

      expect(merchantALinks.map((link) => link.id)).toEqual(["lnk_scope_a"]);
      expect(merchantBLinks.map((link) => link.id)).toEqual(["lnk_scope_b"]);
    } finally {
      setRoleSwitchingEnabledForTests(null);
    }
  });
});
