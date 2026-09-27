import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CollectionService } from "../src/collections";
import { createDatabase, createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";
import { runWithMerchantScope, runWithSystemScope } from "../src/db/scope";
import { LedgerService } from "../src/ledger";
import { PayoutService } from "../src/payouts";
import { ProviderCatalog } from "../src/providers/catalog";
import { TopupService } from "../src/topups";

import type { DevPostgresHandle } from "../src/db/dev-postgres";
import type { AppDatabase } from "../src/db";

describe("topups", () => {
  let database: AppDatabase;
  let devPostgres: DevPostgresHandle;
  let pool: ReturnType<typeof createDatabasePool>;
  let topupService: TopupService;
  let collectionService: CollectionService;
  let payoutService: PayoutService;

  beforeAll(async () => {
    devPostgres = await startDevPostgres();
    pool = createDatabasePool(devPostgres.connectionString);
    database = createDatabase(pool);

    await applySqlMigrations(pool);

    const providerCatalog = new ProviderCatalog({
      database,
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    });

    topupService = new TopupService({
      database,
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    });
    collectionService = new CollectionService({
      database,
      providerCatalog
    });
    payoutService = new PayoutService({
      database,
      providerCatalog
    });

    await runWithSystemScope(
      database,
      "seed topup tests",
      async (trx) => {
        await trx
          .insertInto("merchants")
          .values([
            {
              collections_frozen: false,
              country_code: "GH",
              id: "mer_topup_sms",
              legal_name: "Topup SMS Merchant",
              mode: "test",
              payouts_frozen: false,
              settlement_currency: "GHS",
              status: "active",
              timezone: "Africa/Accra",
              trading_name: "Topup SMS Merchant"
            },
            {
              collections_frozen: false,
              country_code: "GH",
              id: "mer_topup_payout",
              legal_name: "Topup Payout Merchant",
              mode: "test",
              payouts_frozen: false,
              settlement_currency: "GHS",
              status: "active",
              timezone: "Africa/Accra",
              trading_name: "Topup Payout Merchant"
            }
          ])
          .execute();
      },
      { audit: false }
    );
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

  it("credits a mobile-money topup, keeps it out of collections list, and funds SMS balance usage", async () => {
    const created = await topupService.createPaymentTopup({
      amountMinor: 1500n,
      currency: "GHS",
      merchantId: "mer_topup_sms",
      method: "mobile_money",
      mode: "test",
      phone: "+233241230001",
      requestId: "req_topup_sms_1"
    });

    expect(created.status).toBe("pending");
    expect(created.collectionId).not.toBeNull();

    await collectionService.applyProviderCallback({
      collectionId: created.collectionId!,
      providerStatus: "successful"
    });

    const settled = await topupService.getById("mer_topup_sms", "test", created.id);
    expect(settled.status).toBe("successful");

    const collectionsPage = await collectionService.list(
      "mer_topup_sms",
      "test",
      {},
      20
    );
    expect(collectionsPage.items).toHaveLength(0);

    const availableBeforeSms = await getMerchantAvailableBalance(
      database,
      "mer_topup_sms",
      "test",
      "GHS"
    );
    expect(availableBeforeSms).toBe(1500n - settled.feeMinor);

    await runWithMerchantScope(database, "mer_topup_sms", "test", async (trx) => {
      const ledger = new LedgerService(trx, {
        actorId: "sms_test_runner",
        actorType: "system"
      });

      await ledger.chargeSms({
        amount: 200n,
        currency: "GHS",
        description: "Charge SMS after top-up",
        merchantId: "mer_topup_sms",
        mode: "test",
        smsId: "sms_after_topup"
      });
    });

    const availableAfterSms = await getMerchantAvailableBalance(
      database,
      "mer_topup_sms",
      "test",
      "GHS"
    );
    expect(availableAfterSms).toBe(availableBeforeSms - 200n);
  });

  it("lets a payouts-focused merchant top up by bank transfer and complete a payout", async () => {
    const bankTransferTopup = await topupService.createBankTransferTopup({
      amountMinor: 3000n,
      currency: "GHS",
      merchantId: "mer_topup_payout",
      mode: "test"
    });

    expect(bankTransferTopup.status).toBe("pending");
    expect(bankTransferTopup.bankReference).toMatch(/^RPTOP-/);

    const confirmedTopup = await topupService.confirmBankTransferTopup({
      adminUserId: "admin_topup_test",
      bankStatementReference: "stmt_0001",
      reason: "Test bank transfer confirmation",
      topupId: bankTransferTopup.id
    });

    expect(confirmedTopup.status).toBe("successful");

    const payout = await payoutService.create({
      accountName: null,
      accountNumber: null,
      amountMinor: 1000n,
      bankCode: null,
      createdBy: "payout_test_runner",
      currency: "GHS",
      idempotencyKey: null,
      merchantId: "mer_topup_payout",
      metadata: {},
      method: "mobile_money",
      mode: "test",
      narration: "Funded payout",
      network: null,
      phone: "+233241230001",
      reference: "pay_after_topup",
      requestId: "req_payout_after_topup"
    });

    expect(payout.status).toBe("queued");

    await payoutService.processQueuedPayouts();

    const processingPayout = await payoutService.getById(
      "mer_topup_payout",
      "test",
      payout.id
    );
    expect(processingPayout.status).toBe("processing");

    await payoutService.applyProviderCallback({
      payoutId: payout.id,
      providerStatus: "successful"
    });

    const settledPayout = await payoutService.getById(
      "mer_topup_payout",
      "test",
      payout.id
    );
    expect(settledPayout.status).toBe("successful");

    const availableAfterPayout = await getMerchantAvailableBalance(
      database,
      "mer_topup_payout",
      "test",
      "GHS"
    );
    expect(availableAfterPayout).toBe(3000n - payout.amount - payout.feeMinor);
  });
});

async function getMerchantAvailableBalance(
  database: AppDatabase,
  merchantId: string,
  mode: "live" | "test",
  currency: "GHS" | "USD" | "ZMW"
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
      .where("ledger_account.currency", "=", currency)
      .where("ledger_account.type", "=", "merchant_available")
      .executeTakeFirst();

    return BigInt(String(row?.balance ?? "0"));
  });
}
