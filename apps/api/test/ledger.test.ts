import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@richespay/shared";

import { createDatabase, createDatabasePool } from "../src/db/client";
import { startDevPostgres } from "../src/db/dev-postgres";
import { applySqlMigrations } from "../src/db/migrations";
import {
  runWithMerchantScope,
  runWithSystemScope
} from "../src/db/scope";
import { LedgerService, verifyBalances } from "../src/ledger";

import type { AppDatabase } from "../src/db/client";
import type { DevPostgresHandle } from "../src/db/dev-postgres";
import type { ScopedTransaction } from "../src/db";
import type { LedgerAccountType, RpMode } from "../src/db/types";

let database: AppDatabase;
let pool: ReturnType<typeof createDatabasePool>;
let devPostgres: DevPostgresHandle;

describe("ledger", () => {
  const merchantId = "mer_ledger_a";
  const mode: RpMode = "test";
  const currency = "GHS" as const;

  beforeAll(async () => {
    devPostgres = await startDevPostgres();
    pool = createDatabasePool(devPostgres.connectionString);
    database = createDatabase(pool);

    await applySqlMigrations(pool);

    await runWithSystemScope(database, "seed ledger test merchant", async (trx) => {
      await trx
        .insertInto("merchants")
        .values({
          collections_frozen: false,
          country_code: "GH",
          id: merchantId,
          legal_name: "Ledger Test Merchant Ltd",
          mode,
          payouts_frozen: false,
          settlement_currency: currency,
          status: "active",
          timezone: "Africa/Accra",
          trading_name: "Ledger Test Merchant"
        })
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

  it("creates a balanced collection journal and keeps cached balances in sync", async () => {
    const journalEntry = await runWithMerchantScope(
      database,
      merchantId,
      mode,
      async (trx) => {
        const ledger = new LedgerService(trx, {
          actorId: "usr_ledger_tester",
          actorType: "user"
        });

        return ledger.creditCollection({
          amount: 100n,
          channelId: "mtn_momo_gh",
          collectionId: "col_balanced_001",
          currency,
          merchantId,
          mode
        });
      }
    );

    expect(journalEntry.reference_id).toBe("col_balanced_001");
    expect(journalEntry.reference_type).toBe("collection");

    const merchantAvailableBalance = await getBalance({
      accountType: "merchant_available",
      currency,
      merchantId,
      mode
    });
    const providerClearingBalance = await getBalance({
      accountType: "provider_clearing",
      channelId: "mtn_momo_gh",
      currency,
      merchantId: null,
      mode
    });

    expect(merchantAvailableBalance).toBe(100n);
    expect(providerClearingBalance).toBe(-100n);
    await expect(verifyBalances(database)).resolves.toEqual([]);
  });

  it("rejects unbalanced journal entries at commit time", async () => {
    await expect(
      runWithSystemScope(database, "insert unbalanced journal", async (trx) => {
        const availableAccountId = await ensureAccount(
          trx,
          merchantId,
          mode,
          currency,
          "merchant_available"
        );
        const suspenseAccountId = await ensureAccount(
          trx,
          null,
          mode,
          currency,
          "suspense"
        );

        const journalId = newId("jrn_");

        await trx
          .insertInto("journal_entries")
          .values({
            created_by: "system_test",
            currency,
            description: "Unbalanced journal",
            id: journalId,
            mode,
            reference_id: "adj_unbalanced_001",
            reference_type: "adjustment"
          })
          .execute();

        await trx
          .insertInto("postings")
          .values([
            {
              account_id: suspenseAccountId,
              amount: 100n,
              direction: "debit",
              id: newId("pst_"),
              journal_entry_id: journalId
            },
            {
              account_id: availableAccountId,
              amount: 90n,
              direction: "credit",
              id: newId("pst_"),
              journal_entry_id: journalId
            }
          ])
          .execute();
      })
    ).rejects.toThrow(/journal entry is not balanced/i);
  });

  it("rejects journal entries that mix currencies", async () => {
    await expect(
      runWithSystemScope(database, "insert mixed currency journal", async (trx) => {
        const ghsAvailableAccountId = await ensureAccount(
          trx,
          merchantId,
          mode,
          "GHS",
          "merchant_available"
        );
        const usdSuspenseAccountId = await ensureAccount(
          trx,
          null,
          mode,
          "USD",
          "suspense"
        );

        const journalId = newId("jrn_");

        await trx
          .insertInto("journal_entries")
          .values({
            created_by: "system_test",
            currency: "GHS",
            description: "Mixed currency journal",
            id: journalId,
            mode,
            reference_id: "adj_currency_001",
            reference_type: "adjustment"
          })
          .execute();

        await trx
          .insertInto("postings")
          .values([
            {
              account_id: usdSuspenseAccountId,
              amount: 50n,
              direction: "debit",
              id: newId("pst_"),
              journal_entry_id: journalId
            },
            {
              account_id: ghsAvailableAccountId,
              amount: 50n,
              direction: "credit",
              id: newId("pst_"),
              journal_entry_id: journalId
            }
          ])
          .execute();
      })
    ).rejects.toThrow(/mix currencies/i);
  });

  it("rejects payout holds that would overdraw merchant available funds", async () => {
    await expect(
      runWithMerchantScope(database, merchantId, mode, async (trx) => {
        const ledger = new LedgerService(trx, {
          actorId: "usr_ledger_tester",
          actorType: "user"
        });

        return ledger.holdForPayout({
          amount: 110n,
          currency,
          merchantId,
          mode,
          payoutId: "pay_overdraw_001"
        });
      })
    ).rejects.toThrow(/insufficient_funds/i);
  });

  it("prevents 20 parallel payout holds from overdrawing a balance of 100", async () => {
    const parallelMerchantId = "mer_ledger_parallel";

    await runWithSystemScope(database, "seed parallel ledger test merchant", async (trx) => {
      await trx
        .insertInto("merchants")
        .values({
          collections_frozen: false,
          country_code: "GH",
          id: parallelMerchantId,
          legal_name: "Ledger Parallel Merchant Ltd",
          mode,
          payouts_frozen: false,
          settlement_currency: currency,
          status: "active",
          timezone: "Africa/Accra",
          trading_name: "Ledger Parallel Merchant"
        })
        .onConflict((conflict) => conflict.column("id").doNothing())
        .execute();
    });

    await runWithSystemScope(database, "seed concurrency suspense account", async (trx) => {
      await ensureAccount(trx, null, mode, currency, "suspense");
    });

    await runWithSystemScope(database, "seed concurrency available balance", async (trx) => {
      const ledger = new LedgerService(trx, {
        actorId: "adm_ledger_tester",
        actorType: "admin"
      });

      await ledger.manualAdjustment({
        amount: 100n,
        creditAccount: {
          merchantId: parallelMerchantId,
          type: "merchant_available"
        },
        currency,
        debitAccount: {
          merchantId: null,
          type: "suspense"
        },
        description: "Seed payout race balance",
        mode,
        reason: "test setup",
        referenceId: "adj_seed_parallel_001"
      });
    });

    const payoutResults = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        runWithMerchantScope(database, parallelMerchantId, mode, async (trx) => {
          const ledger = new LedgerService(trx, {
            actorId: `usr_parallel_${index}`,
            actorType: "user"
          });

          return ledger.holdForPayout({
            amount: 10n,
            currency,
            merchantId: parallelMerchantId,
            mode,
            payoutId: `pay_parallel_${index.toString().padStart(2, "0")}`
          });
        })
      )
    );

    const succeeded = payoutResults.filter((result) => result.status === "fulfilled");
    const failed = payoutResults.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );

    expect(succeeded).toHaveLength(10);
    expect(failed).toHaveLength(10);
    expect(failed.every((result) => /insufficient_funds/i.test(String(result.reason)))).toBe(true);

    const merchantAvailableBalance = await getBalance({
      accountType: "merchant_available",
      currency,
      merchantId: parallelMerchantId,
      mode
    });
    const payoutHoldBalance = await getBalance({
      accountType: "merchant_payout_hold",
      currency,
      merchantId: parallelMerchantId,
      mode
    });

    expect(merchantAvailableBalance).toBe(0n);
    expect(payoutHoldBalance).toBe(100n);
    await expect(verifyBalances(database)).resolves.toEqual([]);
  }, 120000);
});

async function ensureAccount(
  trx: ScopedTransaction,
  merchantId: string | null,
  mode: RpMode,
  currency: "GHS" | "USD" | "ZMW",
  accountType: LedgerAccountType,
  channelId?: string
): Promise<string> {
  const inserted = await trx
    .insertInto("ledger_accounts")
    .values({
      channel_id: channelId ?? null,
      currency,
      id: newId("lac_"),
      merchant_id: merchantId,
      mode,
      type: accountType
    })
    .onConflict((conflict) =>
      conflict
        .columns(["merchant_id", "mode", "currency", "type", "channel_id"])
        .doNothing()
    )
    .returning("id")
    .executeTakeFirst();

  if (inserted?.id) {
    return inserted.id;
  }

  const existing = await trx
    .selectFrom("ledger_accounts")
    .select("id")
    .$if(merchantId === null, (query) => query.where("merchant_id", "is", null))
    .$if(merchantId !== null, (query) => query.where("merchant_id", "=", merchantId as string))
    .where("mode", "=", mode)
    .where("currency", "=", currency)
    .where("type", "=", accountType)
    .$if(channelId === undefined, (query) => query.where("channel_id", "is", null))
    .$if(channelId !== undefined, (query) => query.where("channel_id", "=", channelId as string))
    .executeTakeFirstOrThrow();

  return existing.id;
}

async function getBalance(input: {
  accountType: LedgerAccountType;
  channelId?: string;
  currency: "GHS" | "USD" | "ZMW";
  merchantId: string | null;
  mode: RpMode;
}): Promise<bigint> {
  const balance = await database
    .selectFrom("account_balances as ab")
    .innerJoin("ledger_accounts as la", "la.id", "ab.account_id")
    .select("ab.balance")
    .$if(input.merchantId === null, (query) => query.where("la.merchant_id", "is", null))
    .$if(input.merchantId !== null, (query) =>
      query.where("la.merchant_id", "=", input.merchantId as string)
    )
    .where("la.mode", "=", input.mode)
    .where("la.currency", "=", input.currency)
    .where("la.type", "=", input.accountType)
    .$if(input.channelId === undefined, (query) => query.where("la.channel_id", "is", null))
    .$if(input.channelId !== undefined, (query) =>
      query.where("la.channel_id", "=", input.channelId as string)
    )
    .executeTakeFirst();

  return balance?.balance ? BigInt(balance.balance) : 0n;
}
