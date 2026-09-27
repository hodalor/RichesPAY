import { getErrorDefinition, newId, type CurrencyCode } from "@richespay/shared";

import { CollectionService } from "../collections";
import { mapProviderStatusTextToOutcome } from "../collections/state-machine";
import { runWithSystemScope, type AppDatabase, type ScopedTransaction } from "../db";
import type {
  LedgerAccountType,
  ProviderStatementEntryType,
  ProviderStatementSource,
  ReconExceptionStatus,
  ReconExceptionType,
  RpMode
} from "../db/types";
import { LedgerService } from "../ledger";
import { ApiRouteError } from "../lib/api-error";
import { PayoutService } from "../payouts";
import { ProviderCatalog } from "../providers/catalog";
import type {
  ChannelRecord,
  ProviderStatementResult
} from "../providers/types";

import type {
  ProviderStatementImportLine,
  ProviderStatementImportResult,
  ReconDailySummaryRecord,
  ReconExceptionRecord
} from "./types";

export class ReconciliationService {
  #collectionService: CollectionService;
  #database: AppDatabase;
  #payoutService: PayoutService;
  #providerCatalog: ProviderCatalog | null;

  constructor(input: {
    collectionService?: CollectionService;
    database: AppDatabase;
    payoutService?: PayoutService;
    providerCatalog?: ProviderCatalog;
  }) {
    this.#database = input.database;
    this.#collectionService =
      input.collectionService ?? new CollectionService({ database: input.database });
    this.#payoutService =
      input.payoutService ?? new PayoutService({ database: input.database });
    this.#providerCatalog = input.providerCatalog ?? null;
  }

  async importStatement(input: {
    channelId: string;
    currency: CurrencyCode;
    floatBalanceMinor?: bigint | null;
    rawFilePath: string;
    rows: ProviderStatementImportLine[];
    source: ProviderStatementSource;
    statementDate: string;
  }): Promise<ProviderStatementImportResult> {
    return runWithSystemScope(
      this.#database,
      "import provider statement",
      async (trx) => {
        const existing = await trx
          .selectFrom("provider_statements")
          .select("id")
          .where("channel_id", "=", input.channelId)
          .where("statement_date", "=", new Date(`${input.statementDate}T00:00:00.000Z`))
          .executeTakeFirst();

        if (existing) {
          throw validationError(
            "statement_date",
            "A provider statement already exists for this channel and statement date."
          );
        }

        const statementId = newId("pst_");
        await trx
          .insertInto("provider_statements")
          .values({
            channel_id: input.channelId,
            created_at: new Date(),
            currency: input.currency,
            float_balance_minor: input.floatBalanceMinor ?? null,
            id: statementId,
            raw_file_path: input.rawFilePath,
            source: input.source,
            statement_date: new Date(`${input.statementDate}T00:00:00.000Z`)
          })
          .execute();

        const statementLineIds: string[] = [];
        const lineRefs = new Set<string>();
        let exceptionCount = 0;

        for (const row of input.rows) {
          const statementLineId = newId("psl_");
          statementLineIds.push(statementLineId);

          await trx
            .insertInto("provider_statement_lines")
            .values({
              amount: row.amountMinor,
              channel_id: input.channelId,
              created_at: new Date(),
              currency: row.currency,
              entry_type: row.entryType,
              fee_minor: row.feeMinor ?? 0n,
              id: statementLineId,
              provider_ref: row.providerRef ?? null,
              provider_status: row.providerStatus ?? null,
              raw: row.raw,
              statement_date: new Date(`${input.statementDate}T00:00:00.000Z`),
              statement_id: statementId
            })
            .execute();

          if (row.providerRef) {
            lineRefs.add(`${row.entryType}:${row.providerRef}`);
          }

          const created = await this.#createLineExceptionIfNeeded(trx, {
            amountMinor: row.amountMinor,
            channelId: input.channelId,
            currency: row.currency,
            entryType: row.entryType,
            providerRef: row.providerRef ?? null,
            providerStatus: row.providerStatus ?? null,
            statementDate: input.statementDate,
            statementId,
            statementLineId
          });

          if (created) {
            exceptionCount += 1;
          }
        }

        exceptionCount += await this.#createMissingAtProviderExceptions(trx, {
          channelId: input.channelId,
          lineRefs,
          statementDate: input.statementDate,
          statementId
        });

        const summary = await this.#storeDailySummary(trx, {
          channelId: input.channelId,
          currency: input.currency,
          exceptionCount,
          floatBalanceMinor: input.floatBalanceMinor ?? null,
          statementDate: input.statementDate,
          statementId
        });

        return {
          exceptionCount,
          statementId,
          summary
        };
      },
      { audit: false }
    );
  }

  async fetchDailyStatements(input: {
    channelId?: string;
    statementDate: string;
  }): Promise<ProviderStatementImportResult[]> {
    if (!this.#providerCatalog) {
      return [];
    }

    const channels = await runWithSystemScope(
      this.#database,
      "list statement fetch channels",
      async (trx) => {
        let query = trx
          .selectFrom("channels")
          .selectAll()
          .where("kind", "in", ["mobile_money", "bank", "card"]);

        if (input.channelId) {
          query = query.where("id", "=", input.channelId);
        }

        return query.execute();
      },
      { audit: false }
    );

    const results: ProviderStatementImportResult[] = [];
    for (const channel of channels) {
      const fetched = await this.#fetchStatementFromChannel(
        {
          capabilities: channel.capabilities,
          config: channel.config,
          countryCode: channel.country_code,
          credentialsEncrypted: channel.credentials_encrypted,
          health: channel.health,
          id: channel.id,
          kind: channel.kind,
          mode: channel.mode,
          network: channel.network,
          priority: channel.priority,
          providerCode: channel.provider_code,
          status: channel.status
        },
        input.statementDate
      );
      if (!fetched) {
        continue;
      }

      results.push(
        await this.importStatement({
          channelId: channel.id,
          currency: fetched.currency as CurrencyCode,
          floatBalanceMinor:
            fetched.floatBalanceMinor === null || fetched.floatBalanceMinor === undefined
              ? null
              : BigInt(fetched.floatBalanceMinor),
          rawFilePath: fetched.rawFilePath,
          rows: fetched.rows.map((row) => ({
            amountMinor: BigInt(row.amount),
            currency: row.currency as CurrencyCode,
            entryType: row.entryType,
            ...(row.feeMinor !== undefined ? { feeMinor: BigInt(row.feeMinor) } : {}),
            ...(row.providerRef !== undefined ? { providerRef: row.providerRef } : {}),
            ...(row.providerStatus !== undefined ? { providerStatus: row.providerStatus } : {}),
            raw: row.raw
          })),
          source: "api",
          statementDate: input.statementDate
        })
      );
    }

    return results;
  }

  async listExceptions(input: {
    channelId?: string;
    limit: number;
    status?: ReconExceptionStatus;
  }): Promise<ReconExceptionRecord[]> {
    const rows = await runWithSystemScope(
      this.#database,
      "list reconciliation exceptions",
      async (trx) => {
        let query = trx
          .selectFrom("recon_exceptions")
          .selectAll()
          .orderBy("created_at", "desc")
          .limit(input.limit);

        if (input.channelId) {
          query = query.where("channel_id", "=", input.channelId);
        }

        if (input.status) {
          query = query.where("status", "=", input.status);
        }

        return query.execute();
      },
      { audit: false }
    );

    return rows.map(mapReconException);
  }

  async listSummaries(input: {
    channelId?: string;
    limit: number;
  }): Promise<ReconDailySummaryRecord[]> {
    const rows = await runWithSystemScope(
      this.#database,
      "list reconciliation summaries",
      async (trx) => {
        let query = trx
          .selectFrom("recon_daily_summaries")
          .selectAll()
          .orderBy("statement_date", "desc")
          .limit(input.limit);

        if (input.channelId) {
          query = query.where("channel_id", "=", input.channelId);
        }

        return query.execute();
      },
      { audit: false }
    );

    return rows.map(mapReconDailySummary);
  }

  async resolveByForceStatus(input: {
    adminUserId: string;
    exceptionId: string;
    providerStatus: string;
    reason: string;
  }): Promise<ReconExceptionRecord> {
    return runWithSystemScope(
      this.#database,
      "resolve reconciliation exception by force status",
      async (trx) => {
        const exception = await trx
          .selectFrom("recon_exceptions")
          .selectAll()
          .where("id", "=", input.exceptionId)
          .forUpdate()
          .executeTakeFirst();

        if (!exception) {
          throw notFoundError("Reconciliation exception not found");
        }

        if (!exception.resource_id || !exception.resource_type || !exception.merchant_id || !exception.mode) {
          throw validationError(
            "exception_id",
            "This reconciliation exception is not linked to a RichesPay transaction."
          );
        }

        const outcome = mapProviderStatusTextToOutcome(input.providerStatus);
        if (outcome === "unknown" || outcome === "accepted") {
          throw validationError(
            "provider_status",
            "Only final provider statuses can be forced from reconciliation."
          );
        }

        if (exception.resource_type === "collection") {
          await this.#collectionService.reconcileProviderResult({
            collectionId: exception.resource_id,
            merchantId: exception.merchant_id,
            mode: exception.mode,
            outcome,
            providerRef: exception.provider_ref,
            providerStatus: input.providerStatus,
            reason: input.reason
          });
        } else if (exception.resource_type === "payout") {
          await this.#payoutService.reconcileProviderConfirmation({
            merchantId: exception.merchant_id,
            mode: exception.mode,
            outcome,
            payoutId: exception.resource_id,
            providerRef: exception.provider_ref,
            providerStatus: input.providerStatus,
            failureCode: outcome === "failed" ? "provider_error" : null,
            failureMessage: outcome === "failed" ? input.reason : null
          });
        } else {
          throw validationError(
            "exception_id",
            "Only collection and payout reconciliation exceptions can be force-resolved."
          );
        }

        const updated = await trx
          .updateTable("recon_exceptions")
          .set({
            resolution_action: "force_status",
            resolution_reason: input.reason,
            resolved_at: new Date(),
            resolved_by: input.adminUserId,
            status: "resolved"
          })
          .where("id", "=", input.exceptionId)
          .returningAll()
          .executeTakeFirstOrThrow();

        return mapReconException(updated);
      },
      { audit: false }
    );
  }

  async resolveByManualAdjustment(input: {
    adminUserId: string;
    amountMinor: bigint;
    creditAccount: {
      channelId?: string;
      merchantId: string | null;
      type: LedgerAccountType;
    };
    currency: CurrencyCode;
    debitAccount: {
      channelId?: string;
      merchantId: string | null;
      type: LedgerAccountType;
    };
    exceptionId: string;
    reason: string;
  }): Promise<ReconExceptionRecord> {
    return runWithSystemScope(
      this.#database,
      "resolve reconciliation exception by manual adjustment",
      async (trx) => {
        const exception = await trx
          .selectFrom("recon_exceptions")
          .selectAll()
          .where("id", "=", input.exceptionId)
          .forUpdate()
          .executeTakeFirst();

        if (!exception) {
          throw notFoundError("Reconciliation exception not found");
        }

        const ledger = new LedgerService(trx, {
          actorId: input.adminUserId,
          actorType: "admin"
        });

        await ledger.manualAdjustment({
          amount: input.amountMinor,
          creditAccount: input.creditAccount,
          currency: input.currency,
          debitAccount: input.debitAccount,
          description: `Reconciliation adjustment ${input.exceptionId}`,
          mode: exception.mode ?? "live",
          reason: input.reason,
          referenceId: input.exceptionId
        });

        const updated = await trx
          .updateTable("recon_exceptions")
          .set({
            resolution_action: "manual_adjustment",
            resolution_reason: input.reason,
            resolved_at: new Date(),
            resolved_by: input.adminUserId,
            status: "resolved"
          })
          .where("id", "=", input.exceptionId)
          .returningAll()
          .executeTakeFirstOrThrow();

        return mapReconException(updated);
      },
      { audit: false }
    );
  }

  async dismissException(input: {
    adminUserId: string;
    exceptionId: string;
    reason: string;
  }): Promise<ReconExceptionRecord> {
    return runWithSystemScope(
      this.#database,
      "dismiss reconciliation exception",
      async (trx) => {
        const updated = await trx
          .updateTable("recon_exceptions")
          .set({
            resolution_action: "dismiss",
            resolution_reason: input.reason,
            resolved_at: new Date(),
            resolved_by: input.adminUserId,
            status: "dismissed"
          })
          .where("id", "=", input.exceptionId)
          .returningAll()
          .executeTakeFirst();

        if (!updated) {
          throw notFoundError("Reconciliation exception not found");
        }

        return mapReconException(updated);
      },
      { audit: false }
    );
  }

  async #createLineExceptionIfNeeded(
    trx: ScopedTransaction,
    input: {
      amountMinor: bigint;
      channelId: string;
      currency: CurrencyCode;
      entryType: ProviderStatementEntryType;
      providerRef: string | null;
      providerStatus: string | null;
      statementDate: string;
      statementId: string;
      statementLineId: string;
    }
  ) {
    const matched = await this.#lookupResource(trx, input);

    if (!matched) {
      await this.#insertException(trx, {
        channelId: input.channelId,
        currency: input.currency,
        exceptionType: "missing_in_richespay",
        expectedAmount: null,
        expectedStatus: null,
        merchantId: null,
        mode: null,
        providerAmount: input.amountMinor,
        providerRef: input.providerRef,
        providerStatus: input.providerStatus,
        resourceId: null,
        resourceType: null,
        statementId: input.statementId,
        statementLineId: input.statementLineId
      });
      return true;
    }

    if (matched.amountMinor !== input.amountMinor) {
      await this.#insertException(trx, {
        channelId: input.channelId,
        currency: input.currency,
        exceptionType: "amount_mismatch",
        expectedAmount: matched.amountMinor,
        expectedStatus: matched.status,
        merchantId: matched.merchantId,
        mode: matched.mode,
        providerAmount: input.amountMinor,
        providerRef: input.providerRef,
        providerStatus: input.providerStatus,
        resourceId: matched.resourceId,
        resourceType: matched.resourceType,
        statementId: input.statementId,
        statementLineId: input.statementLineId
      });
      return true;
    }

    const normalizedProviderStatus = normalizeReconciliationStatus(input.providerStatus);
    if (
      normalizedProviderStatus !== null &&
      matched.status !== normalizedProviderStatus
    ) {
      await this.#insertException(trx, {
        channelId: input.channelId,
        currency: input.currency,
        exceptionType: "status_mismatch",
        expectedAmount: matched.amountMinor,
        expectedStatus: matched.status,
        merchantId: matched.merchantId,
        mode: matched.mode,
        providerAmount: input.amountMinor,
        providerRef: input.providerRef,
        providerStatus: normalizedProviderStatus,
        resourceId: matched.resourceId,
        resourceType: matched.resourceType,
        statementId: input.statementId,
        statementLineId: input.statementLineId
      });
      return true;
    }

    return false;
  }

  async #createMissingAtProviderExceptions(
    trx: ScopedTransaction,
    input: {
      channelId: string;
      lineRefs: Set<string>;
      statementDate: string;
      statementId: string;
    }
  ) {
    let count = 0;

    const collections = await trx
      .selectFrom("collections")
      .select(["amount", "merchant_id", "mode", "provider_ref", "status", "id"])
      .where("channel_id", "=", input.channelId)
      .where("provider_ref", "is not", null)
      .where("completed_at", ">=", new Date(`${input.statementDate}T00:00:00.000Z`))
      .where("completed_at", "<", nextUtcDay(input.statementDate))
      .execute();

    for (const collection of collections) {
      const key = `collection:${collection.provider_ref!}`;
      if (input.lineRefs.has(key)) {
        continue;
      }

      await this.#insertException(trx, {
        channelId: input.channelId,
        currency: null,
        exceptionType: "missing_at_provider",
        expectedAmount: BigInt(collection.amount),
        expectedStatus: collection.status,
        merchantId: collection.merchant_id,
        mode: collection.mode,
        providerAmount: null,
        providerRef: collection.provider_ref,
        providerStatus: null,
        resourceId: collection.id,
        resourceType: "collection",
        statementId: input.statementId,
        statementLineId: null
      });
      count += 1;
    }

    const payouts = await trx
      .selectFrom("payouts")
      .select(["amount", "merchant_id", "mode", "provider_ref", "status", "id"])
      .where("channel_id", "=", input.channelId)
      .where("provider_ref", "is not", null)
      .where("completed_at", ">=", new Date(`${input.statementDate}T00:00:00.000Z`))
      .where("completed_at", "<", nextUtcDay(input.statementDate))
      .execute();

    for (const payout of payouts) {
      const key = `payout:${payout.provider_ref!}`;
      if (input.lineRefs.has(key)) {
        continue;
      }

      await this.#insertException(trx, {
        channelId: input.channelId,
        currency: null,
        exceptionType: "missing_at_provider",
        expectedAmount: BigInt(payout.amount),
        expectedStatus: payout.status,
        merchantId: payout.merchant_id,
        mode: payout.mode,
        providerAmount: null,
        providerRef: payout.provider_ref,
        providerStatus: null,
        resourceId: payout.id,
        resourceType: "payout",
        statementId: input.statementId,
        statementLineId: null
      });
      count += 1;
    }

    return count;
  }

  async #lookupResource(
    trx: ScopedTransaction,
    input: {
      amountMinor: bigint;
      channelId: string;
      entryType: ProviderStatementEntryType;
      providerRef: string | null;
    }
  ) {
    if (!input.providerRef) {
      return null;
    }

    if (input.entryType === "collection") {
      const collection = await trx
        .selectFrom("collections")
        .select(["amount", "merchant_id", "mode", "id", "status"])
        .where("channel_id", "=", input.channelId)
        .where("provider_ref", "=", input.providerRef)
        .executeTakeFirst();

      if (!collection) {
        return null;
      }

      return {
        amountMinor: BigInt(collection.amount),
        merchantId: collection.merchant_id,
        mode: collection.mode,
        resourceId: collection.id,
        resourceType: "collection",
        status: collection.status
      };
    }

    if (input.entryType === "payout") {
      const payout = await trx
        .selectFrom("payouts")
        .select(["amount", "merchant_id", "mode", "id", "status"])
        .where("channel_id", "=", input.channelId)
        .where("provider_ref", "=", input.providerRef)
        .executeTakeFirst();

      if (!payout) {
        return null;
      }

      return {
        amountMinor: BigInt(payout.amount),
        merchantId: payout.merchant_id,
        mode: payout.mode,
        resourceId: payout.id,
        resourceType: "payout",
        status: payout.status
      };
    }

    return null;
  }

  async #insertException(
    trx: ScopedTransaction,
    input: {
      channelId: string;
      currency: CurrencyCode | null;
      exceptionType: ReconExceptionType;
      expectedAmount: bigint | null;
      expectedStatus: string | null;
      merchantId: string | null;
      mode: RpMode | null;
      providerAmount: bigint | null;
      providerRef: string | null;
      providerStatus: string | null;
      resourceId: string | null;
      resourceType: string | null;
      statementId: string;
      statementLineId: string | null;
    }
  ) {
    await trx
      .insertInto("recon_exceptions")
      .values({
        channel_id: input.channelId,
        created_at: new Date(),
        currency: input.currency,
        exception_type: input.exceptionType,
        expected_amount: input.expectedAmount,
        expected_status: input.expectedStatus,
        id: newId("rex_"),
        merchant_id: input.merchantId,
        mode: input.mode,
        provider_amount: input.providerAmount,
        provider_ref: input.providerRef,
        provider_status: input.providerStatus,
        resource_id: input.resourceId,
        resource_type: input.resourceType,
        statement_id: input.statementId,
        statement_line_id: input.statementLineId,
        status: "open"
      })
      .execute();
  }

  async #storeDailySummary(
    trx: ScopedTransaction,
    input: {
      channelId: string;
      currency: CurrencyCode;
      exceptionCount: number;
      floatBalanceMinor: bigint | null;
      statementDate: string;
      statementId: string;
    }
  ): Promise<ReconDailySummaryRecord> {
    const lines = await trx
      .selectFrom("provider_statement_lines")
      .select(["entry_type", "amount", "fee_minor"])
      .where("statement_id", "=", input.statementId)
      .execute();

    let collectionCount = 0;
    let collectionVolume = 0n;
    let payoutCount = 0;
    let payoutVolume = 0n;
    let feeVolume = 0n;

    for (const line of lines) {
      const amount = BigInt(line.amount);
      const fee = BigInt(line.fee_minor);
      if (line.entry_type === "collection") {
        collectionCount += 1;
        collectionVolume += amount;
      } else if (line.entry_type === "payout") {
        payoutCount += 1;
        payoutVolume += amount;
      }
      feeVolume += fee;
    }

    const balanceRow = await trx
      .selectFrom("ledger_accounts as account")
      .leftJoin("account_balances as balance", "balance.account_id", "account.id")
      .select(["balance.balance as balance"])
      .where("account.channel_id", "=", input.channelId)
      .where("account.type", "=", "provider_clearing")
      .where("account.currency", "=", input.currency)
      .executeTakeFirst();
    const providerClearingBalance = BigInt(String(balanceRow?.balance ?? "0"));
    const balancesMatch =
      input.floatBalanceMinor !== null
        ? providerClearingBalance === input.floatBalanceMinor
        : false;

    const summary = await trx
      .insertInto("recon_daily_summaries")
      .values({
        balances_match: balancesMatch,
        channel_id: input.channelId,
        collection_count: collectionCount,
        collection_volume: collectionVolume,
        created_at: new Date(),
        currency: input.currency,
        exception_count: input.exceptionCount,
        fee_volume: feeVolume,
        id: newId("rds_"),
        payout_count: payoutCount,
        payout_volume: payoutVolume,
        provider_clearing_balance: providerClearingBalance,
        provider_float_balance: input.floatBalanceMinor,
        statement_date: input.statementDate,
        statement_id: input.statementId
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapReconDailySummary(summary);
  }

  async #fetchStatementFromChannel(
    channel: ChannelRecord,
    statementDate: string
  ): Promise<ProviderStatementResult | null> {
    if (!this.#providerCatalog) {
      return null;
    }

    const provider =
      channel.kind === "bank"
        ? this.#providerCatalog.resolveBankPayoutProvider(channel)
        : channel.kind === "card"
          ? this.#providerCatalog.resolveCardAcquirer(channel)
          : this.#providerCatalog.resolveMobileMoneyProvider(channel);

    return provider.fetchStatement ? provider.fetchStatement(statementDate) : null;
  }
}

function mapReconException(row: {
  channel_id: string;
  created_at: Date;
  currency: string | null;
  exception_type: ReconExceptionType;
  expected_amount: string | null;
  expected_status: string | null;
  id: string;
  merchant_id: string | null;
  mode: RpMode | null;
  provider_amount: string | null;
  provider_ref: string | null;
  provider_status: string | null;
  resolution_action: ReconExceptionRecord["resolutionAction"];
  resolution_reason: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resource_id: string | null;
  resource_type: string | null;
  statement_id: string | null;
  statement_line_id: string | null;
  status: ReconExceptionStatus;
}): ReconExceptionRecord {
  return {
    channelId: row.channel_id,
    createdAt: row.created_at,
    currency: row.currency as CurrencyCode | null,
    exceptionType: row.exception_type,
    expectedAmount: row.expected_amount === null ? null : BigInt(row.expected_amount),
    expectedStatus: row.expected_status,
    id: row.id,
    merchantId: row.merchant_id,
    mode: row.mode,
    providerAmount: row.provider_amount === null ? null : BigInt(row.provider_amount),
    providerRef: row.provider_ref,
    providerStatus: row.provider_status,
    resolutionAction: row.resolution_action,
    resolutionReason: row.resolution_reason,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resourceId: row.resource_id,
    resourceType: row.resource_type,
    status: row.status,
    statementId: row.statement_id,
    statementLineId: row.statement_line_id
  };
}

function mapReconDailySummary(row: {
  balances_match: boolean;
  channel_id: string;
  collection_count: number;
  collection_volume: string;
  created_at: Date;
  currency: string;
  exception_count: number;
  fee_volume: string;
  id: string;
  payout_count: number;
  payout_volume: string;
  provider_clearing_balance: string;
  provider_float_balance: string | null;
  statement_date: Date;
  statement_id: string;
}): ReconDailySummaryRecord {
  return {
    balancesMatch: row.balances_match,
    channelId: row.channel_id,
    collectionCount: row.collection_count,
    collectionVolume: BigInt(row.collection_volume),
    createdAt: row.created_at,
    currency: row.currency as CurrencyCode,
    exceptionCount: row.exception_count,
    feeVolume: BigInt(row.fee_volume),
    id: row.id,
    payoutCount: row.payout_count,
    payoutVolume: BigInt(row.payout_volume),
    providerClearingBalance: BigInt(row.provider_clearing_balance),
    providerFloatBalance:
      row.provider_float_balance === null ? null : BigInt(row.provider_float_balance),
    statementDate: row.statement_date.toISOString().slice(0, 10),
    statementId: row.statement_id
  };
}

function normalizeReconciliationStatus(providerStatus: string | null) {
  if (!providerStatus) {
    return null;
  }

  const outcome = mapProviderStatusTextToOutcome(providerStatus);
  if (outcome === "succeeded") {
    return "successful";
  }
  if (outcome === "failed") {
    return "failed";
  }
  if (outcome === "accepted") {
    return "processing";
  }
  return null;
}

function nextUtcDay(statementDate: string) {
  const next = new Date(`${statementDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function validationError(field: string, message: string) {
  return new ApiRouteError({
    code: "validation_error",
    field,
    message,
    statusCode: getErrorDefinition("validation_error").status
  });
}

function notFoundError(message: string) {
  return new ApiRouteError({
    code: "not_found",
    message,
    statusCode: getErrorDefinition("not_found").status
  });
}
