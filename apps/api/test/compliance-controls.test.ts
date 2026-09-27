import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CollectionService } from "../src/collections";
import { ComplianceService } from "../src/compliance";
import { CheckoutService } from "../src/checkout";
import { createDatabase, createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";
import { runWithMerchantScope, runWithSystemScope } from "../src/db/scope";
import { PayoutService } from "../src/payouts";
import { ProviderCatalog } from "../src/providers/catalog";
import { TopupService } from "../src/topups";

import type { AppDatabase } from "../src/db";
import type { DevPostgresHandle } from "../src/db/dev-postgres";

describe("compliance controls", () => {
  let collectionService: CollectionService;
  let checkoutService: CheckoutService;
  let complianceService: ComplianceService;
  let database: AppDatabase;
  let devPostgres: DevPostgresHandle;
  let payoutService: PayoutService;
  let pool: ReturnType<typeof createDatabasePool>;
  let topupService: TopupService;

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
    checkoutService = new CheckoutService({
      database,
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    });
    complianceService = new ComplianceService({
      database
    });
    payoutService = new PayoutService({
      database,
      providerCatalog
    });
    topupService = new TopupService({
      database,
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    });

    await runWithSystemScope(
      database,
      "seed compliance tests",
      async (trx) => {
        await trx
          .insertInto("merchants")
          .values([
            {
              collections_frozen: false,
              country_code: "GH",
              id: "mer_controls_collections",
              legal_name: "Collections Control Merchant",
              mode: "test",
              payouts_frozen: false,
              settlement_currency: "GHS",
              status: "active",
              timezone: "Africa/Accra",
              trading_name: "Collections Control Merchant"
            },
            {
              collections_frozen: false,
              country_code: "GH",
              id: "mer_controls_payouts",
              legal_name: "Payout Control Merchant",
              mode: "test",
              payouts_frozen: false,
              settlement_currency: "GHS",
              status: "active",
              timezone: "Africa/Accra",
              trading_name: "Payout Control Merchant"
            }
          ])
          .execute();
      },
      { audit: false }
    );
  }, 120000);

  afterAll(async () => {
    if (database || pool) {
      await Promise.allSettled([database?.destroy(), pool?.end()]);
    }

    if (devPostgres) {
      await devPostgres.stop();
    }
  });

  it("rejects new collections and checkout sessions while landing in-flight collections in reserve", async () => {
    const inFlight = await collectionService.create({
      amountMinor: 2000n,
      currency: "GHS",
      customerEmail: null,
      customerName: null,
      description: "Pre-freeze collection",
      idempotencyKey: null,
      merchantId: "mer_controls_collections",
      metadata: {},
      method: "mobile_money",
      mode: "test",
      network: null,
      phone: "+233241230001",
      reference: "pre_freeze_collection",
      requestId: "req_pre_freeze_collection"
    });

    await runWithSystemScope(
      database,
      "freeze collections for control test",
      async (trx) => {
        await complianceService.freezeCollections(trx, {
          actorId: "admin_controls",
          category: "regulatory",
          merchantId: "mer_controls_collections",
          mode: "test",
          reason: "Regulatory review"
        });
      },
      { audit: false }
    );

    await expect(
      collectionService.create({
        amountMinor: 1000n,
        currency: "GHS",
        customerEmail: null,
        customerName: null,
        description: "Blocked collection",
        idempotencyKey: null,
        merchantId: "mer_controls_collections",
        metadata: {},
        method: "mobile_money",
        mode: "test",
        network: null,
        phone: "+233241230001",
        reference: "blocked_collection",
        requestId: "req_blocked_collection"
      })
    ).rejects.toThrow(/collections are frozen/i);

    await expect(
      checkoutService.createSession({
        allowedMethods: ["mobile_money", "card"],
        amount: 1200n,
        cancelUrl: null,
        currency: "GHS",
        customer: {
          email: null,
          name: null
        },
        description: "Blocked checkout",
        merchantId: "mer_controls_collections",
        mode: "test",
        reference: "blocked_checkout",
        successUrl: null
      })
    ).rejects.toThrow(/collections are frozen/i);

    await collectionService.applyProviderCallback({
      collectionId: inFlight.id,
      providerStatus: "successful"
    });

    const available = await getBalance(
      database,
      "mer_controls_collections",
      "test",
      "merchant_available"
    );
    const reserve = await getBalance(
      database,
      "mer_controls_collections",
      "test",
      "merchant_reserve"
    );

    expect(available).toBe(0n);
    expect(reserve).toBe(inFlight.netMinor);
  });

  it("moves queued payouts to on_hold during a freeze and resumes them after unfreeze", async () => {
    const pendingTopup = await topupService.createBankTransferTopup({
      amountMinor: 5000n,
      currency: "GHS",
      merchantId: "mer_controls_payouts",
      mode: "test"
    });

    const payoutTopup = await topupService.confirmBankTransferTopup({
      adminUserId: "admin_controls",
      bankStatementReference: "stmt_controls_001",
      reason: "Seed payout controls balance",
      topupId: pendingTopup.id
    });

    expect(payoutTopup.status).toBe("successful");

    const payout = await payoutService.create({
      accountName: null,
      accountNumber: null,
      amountMinor: 1000n,
      bankCode: null,
      createdBy: "finance_controls",
      currency: "GHS",
      idempotencyKey: null,
      merchantId: "mer_controls_payouts",
      metadata: {},
      method: "mobile_money",
      mode: "test",
      narration: "Queued before freeze",
      network: null,
      phone: "+233241230001",
      reference: "queued_before_freeze",
      requestId: "req_queued_before_freeze"
    });

    expect(payout.status).toBe("queued");

    await runWithSystemScope(
      database,
      "freeze payouts for control test",
      async (trx) => {
        await complianceService.freezePayouts(trx, {
          actorId: "admin_controls",
          category: "regulatory",
          merchantId: "mer_controls_payouts",
          mode: "test",
          reason: "Payout review"
        });
      },
      { audit: false }
    );

    const held = await payoutService.getById("mer_controls_payouts", "test", payout.id);
    expect(held.status).toBe("on_hold");

    await runWithSystemScope(
      database,
      "unfreeze payouts for control test",
      async (trx) => {
        await complianceService.unfreezePayouts(trx, {
          actorId: "admin_controls",
          merchantId: "mer_controls_payouts",
          mode: "test",
          reason: "Review complete"
        });
      },
      { audit: false }
    );

    const resumed = await payoutService.getById("mer_controls_payouts", "test", payout.id);
    expect(resumed.status).toBe("queued");
  });
});

async function getBalance(
  database: AppDatabase,
  merchantId: string,
  mode: "live" | "test",
  accountType: "merchant_available" | "merchant_reserve"
) {
  return runWithMerchantScope(database, merchantId, mode, async (trx) => {
    const row = await trx
      .selectFrom("ledger_accounts as ledger_account")
      .leftJoin(
        "account_balances as account_balance",
        "account_balance.account_id",
        "ledger_account.id"
      )
      .select("account_balance.balance as balance")
      .where("ledger_account.merchant_id", "=", merchantId)
      .where("ledger_account.mode", "=", mode)
      .where("ledger_account.currency", "=", "GHS")
      .where("ledger_account.type", "=", accountType)
      .executeTakeFirst();

    return BigInt(String(row?.balance ?? "0"));
  });
}
