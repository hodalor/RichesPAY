import { getErrorDefinition, newId, type CurrencyCode } from "@richespay/shared";

import { mapProviderStatusTextToOutcome } from "../collections/state-machine";
import { ComplianceService } from "../compliance";
import {
  runWithMerchantScope,
  runWithSystemScope,
  type AppDatabase,
  type ScopedTransaction
} from "../db";
import type { Json, JsonObject } from "../db/types";
import { LedgerService } from "../ledger";
import { ApiRouteError } from "../lib/api-error";
import { FeeService } from "../pricing/fee-service";
import { DatabasePricingRepository } from "../pricing/repository";
import { parseCurrencyCode } from "../pricing/types";
import { ProviderCatalog } from "../providers/catalog";
import { detectNetworkFromMsisdn } from "../providers/msisdn";
import {
  InvalidMobileMoneyPhoneError,
  normalizeMobileMoneyPhoneNumber
} from "../providers/mobile-money/phone";
import { ChannelRouter, DatabaseChannelRegistry } from "../providers/router";
import type { ChannelRecord, ProviderOutcome } from "../providers/types";

import {
  assertPayoutTransition,
  isPayoutTerminalStatus,
  mapProviderOutcomeToPayoutStatus,
  payoutBatchEventTypeForStatus,
  payoutEventTypeForStatus
} from "./state-machine";
import type {
  CreatePayoutBatchItemInput,
  CreatePayoutInput,
  PayoutBatchRecord,
  PayoutMethod,
  PayoutRecord
} from "./types";

interface MerchantPayoutContext {
  countryCode: string;
  id: string;
  mode: "live" | "test";
  payoutApprovalThresholdMinor: bigint | null;
  payoutsFrozen: boolean;
  payoutsRequireApproval: boolean;
  settlementCurrency: CurrencyCode;
  status: string;
}

interface PreparedPayoutInput {
  accountName: string | null;
  accountNumber: string | null;
  amountMinor: bigint;
  bankCode: string | null;
  channelId: string;
  currency: CurrencyCode;
  feeMinor: bigint;
  metadata: Json;
  method: PayoutMethod;
  narration: string | null;
  network: string | null;
  phone: string | null;
  reference: string | null;
  totalHoldMinor: bigint;
}

interface DispatchCandidate {
  channel: ChannelRecord;
  channelId: string;
  config: Json;
  id: string;
  merchantId: string;
  mode: "live" | "test";
}

interface PollCandidate {
  channel: ChannelRecord;
  id: string;
  merchantId: string;
  method: PayoutMethod;
  mode: "live" | "test";
  providerRef: string | null;
}

interface PayoutListFilters {
  batchId?: string;
  createdGte?: Date;
  createdLte?: Date;
  reference?: string;
  startingAfter?: string;
  status?: PayoutRecord["status"];
}

interface PayoutBatchListFilters {
  createdGte?: Date;
  createdLte?: Date;
  reference?: string;
  startingAfter?: string;
  status?: PayoutBatchRecord["status"];
}

export class PayoutService {
  #complianceService: ComplianceService;
  #database: AppDatabase;
  #feeService: FeeService;
  #providerCatalog: ProviderCatalog | null;
  #router: ChannelRouter;

  constructor(input: {
    database: AppDatabase;
    feeService?: FeeService;
    providerCatalog?: ProviderCatalog;
    router?: ChannelRouter;
  }) {
    this.#database = input.database;
    this.#complianceService = new ComplianceService({
      database: input.database
    });
    const pricingRepository = new DatabasePricingRepository(input.database);
    this.#feeService = input.feeService ?? new FeeService(pricingRepository);
    this.#providerCatalog = input.providerCatalog ?? null;
    this.#router =
      input.router ?? new ChannelRouter(new DatabaseChannelRegistry(input.database));
  }

  async lookupAccountName(input: {
    merchantId: string;
    mode: "live" | "test";
    network: string | null;
    phone: string;
  }) {
    const merchant = await this.#loadMerchantContext(input.merchantId, input.mode);
    this.#assertMerchantCanPayout(merchant);

    const normalizedPhone = this.#normalizePhone(input.phone, merchant.countryCode);
    const network =
      input.network ??
      (await detectNetworkFromMsisdn(this.#database, {
        countryCode: merchant.countryCode,
        msisdn: normalizedPhone
      }));

    const channel = await this.#router.pick(
      "mobile_money",
      "payout",
      merchant.countryCode,
      network,
      merchant.mode
    );

    if (!channel) {
      throw unavailableChannelError();
    }

    const provider = this.#requireProviderCatalog().resolveMobileMoneyProvider(channel);
    if (!provider.lookupAccountName) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "network",
        message: "Account lookup is not supported for this network.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    const result = await provider.lookupAccountName(normalizedPhone);
    const raw =
      result.rawRedacted && typeof result.rawRedacted === "object" && !Array.isArray(result.rawRedacted)
        ? (result.rawRedacted as JsonObject)
        : {};

    return {
      accountName:
        typeof raw.account_name === "string" ? raw.account_name : "Unknown account",
      normalizedPhone
    };
  }

  async create(input: CreatePayoutInput): Promise<PayoutRecord> {
    const merchant = await this.#loadMerchantContext(input.merchantId, input.mode);
    this.#assertMerchantCanPayout(merchant);
    this.#assertPayoutCurrency(merchant, input.currency);

    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) =>
      this.#createInScope(trx, merchant, input)
    );
  }

  async createWithdrawal(input: {
    amountMinor: bigint;
    autoGenerated: boolean;
    createdBy: string;
    currency: CurrencyCode;
    merchantId: string;
    mode: "live" | "test";
    requestId: string;
    settlementAccountId: string;
    withdrawalId: string;
  }): Promise<PayoutRecord> {
    const merchant = await this.#loadMerchantContext(input.merchantId, input.mode);
    this.#assertMerchantCanPayout(merchant);
    this.#assertPayoutCurrency(merchant, input.currency);

    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      const account = await trx
        .selectFrom("settlement_accounts")
        .selectAll()
        .where("id", "=", input.settlementAccountId)
        .forUpdate()
        .executeTakeFirst();

      if (!account) {
        throw notFoundError();
      }

      if (!account.verified_at || !account.verified_by) {
        throw new ApiRouteError({
          code: "settlement_account_unverified",
          message: getErrorDefinition("settlement_account_unverified").message,
          statusCode: getErrorDefinition("settlement_account_unverified").status
        });
      }

      if (account.cool_off_until && account.cool_off_until > new Date()) {
        throw new ApiRouteError({
          code: "settlement_account_cool_off",
          message: getErrorDefinition("settlement_account_cool_off").message,
          statusCode: getErrorDefinition("settlement_account_cool_off").status
        });
      }

      const payout = await this.#createInScope(trx, merchant, {
        accountName: extractSettlementAccountName(account.details),
        accountNumber: account.type === "bank" ? extractBankAccountNumber(account.details) : null,
        amountMinor: input.amountMinor,
        bankCode: account.type === "bank" ? extractBankCode(account.details) : null,
        createdBy: input.createdBy,
        currency: input.currency,
        idempotencyKey: null,
        merchantId: input.merchantId,
        metadata: {
          auto_generated: input.autoGenerated,
          settlement_account_id: input.settlementAccountId,
          withdrawal_id: input.withdrawalId
        },
        method: account.type === "bank" ? "bank" : "mobile_money",
        mode: input.mode,
        narration: input.autoGenerated ? "Automatic daily settlement" : "Merchant withdrawal",
        network: account.type === "mobile_money" ? extractSettlementNetwork(account.details) : null,
        phone: account.type === "mobile_money" ? extractSettlementPhone(account.details) : null,
        reference: input.withdrawalId,
        requestId: input.requestId
      });

      await trx
        .insertInto("withdrawals")
        .values({
          amount: input.amountMinor,
          auto_generated: input.autoGenerated,
          created_at: new Date(),
          created_by: input.createdBy,
          currency: input.currency,
          id: input.withdrawalId,
          merchant_id: input.merchantId,
          mode: input.mode,
          payout_id: payout.id,
          settlement_account_id: input.settlementAccountId
        })
        .execute();

      return payout;
    });
  }

  async quotePayoutHold(input: CreatePayoutInput): Promise<{
    amountMinor: bigint;
    feeMinor: bigint;
    totalHoldMinor: bigint;
  }> {
    const merchant = await this.#loadMerchantContext(input.merchantId, input.mode);
    this.#assertMerchantCanPayout(merchant);
    this.#assertPayoutCurrency(merchant, input.currency);

    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      const prepared = await this.#preparePayout(trx, merchant, {
        accountName: input.accountName,
        accountNumber: input.accountNumber,
        amountMinor: input.amountMinor,
        bankCode: input.bankCode,
        metadata: input.metadata ?? {},
        method: input.method,
        narration: input.narration,
        network: input.network,
        phone: input.phone,
        reference: input.reference
      });

      return {
        amountMinor: prepared.amountMinor,
        feeMinor: prepared.feeMinor,
        totalHoldMinor: prepared.totalHoldMinor
      };
    });
  }

  async createBatch(input: {
    createdBy: string;
    currency: CurrencyCode;
    items: CreatePayoutBatchItemInput[];
    merchantId: string;
    metadata: Json | null;
    mode: "live" | "test";
    reference: string | null;
  }): Promise<
    | {
        accepted: false;
        validationReport: {
          invalid_count: number;
          valid_count: number;
          rows: Array<{ errors: string[]; index: number }>;
        };
      }
    | {
        accepted: true;
        batch: PayoutBatchRecord;
      }
  > {
    const merchant = await this.#loadMerchantContext(input.merchantId, input.mode);
    this.#assertMerchantCanPayout(merchant);
    this.#assertPayoutCurrency(merchant, input.currency);

    if (input.items.length === 0 || input.items.length > 5000) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "items",
        message: "Payout batches must contain between 1 and 5000 items.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      await this.#assertBatchReferenceAvailable(trx, input.reference);

      const prepared: PreparedPayoutInput[] = [];
      const seenReferences = new Set<string>();
      const rows: Array<{ errors: string[]; index: number }> = [];

      for (let index = 0; index < input.items.length; index += 1) {
        const item = input.items[index]!;
        const errors: string[] = [];

        if (item.reference) {
          if (seenReferences.has(item.reference)) {
            errors.push("Duplicate reference inside batch.");
          } else {
            seenReferences.add(item.reference);
          }
        }

        try {
          await this.#complianceService.enforceOperationLimits(trx, {
            amountMinor: BigInt(item.amount),
            kind: "payout",
            merchantId: input.merchantId,
            mode: input.mode
          });

          if (item.reference) {
            await this.#assertPayoutReferenceAvailable(trx, item.reference);
          }

          const preparedItem = await this.#preparePayout(trx, merchant, {
            accountName: item.accountName ?? null,
            accountNumber: item.accountNumber ?? null,
            amountMinor: BigInt(item.amount),
            bankCode: item.bankCode ?? null,
            metadata: item.metadata ?? {},
            method: item.method,
            narration: item.narration ?? null,
            network: item.network ?? null,
            phone: item.phone ?? null,
            reference: item.reference ?? null
          });

          await this.#complianceService.screenPayoutIfRequired(trx, {
            amountMinor: preparedItem.amountMinor,
            merchantId: input.merchantId,
            mode: input.mode,
            payoutReference: item.reference ?? `batch_item_${index + 1}`,
            subject: {
              account_name: preparedItem.accountName,
              account_number_masked: maskAccountNumber(preparedItem.accountNumber),
              bank_code: preparedItem.bankCode,
              method: preparedItem.method,
              network: preparedItem.network,
              phone_masked: maskPhone(preparedItem.phone)
            }
          });

          prepared.push(preparedItem);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "Invalid row.");
        }

        if (errors.length > 0) {
          rows.push({ errors, index });
        }
      }

      if (rows.length > 0) {
        return {
          accepted: false,
          validationReport: {
            invalid_count: rows.length,
            valid_count: input.items.length - rows.length,
            rows
          }
        } as const;
      }

      const batchId = newId("bat_");
      const totalAmount = prepared.reduce((sum, item) => sum + item.amountMinor, 0n);
      const totalFeeMinor = prepared.reduce((sum, item) => sum + item.feeMinor, 0n);
      const totalHoldMinor = prepared.reduce((sum, item) => sum + item.totalHoldMinor, 0n);
      const approvalRequired = this.#requiresApproval(merchant, totalAmount);

      const batch = await trx
        .insertInto("payout_batches")
        .values({
          approved_by: null,
          completed_at: null,
          created_at: new Date(),
          created_by: input.createdBy,
          currency: input.currency,
          id: batchId,
          item_count: prepared.length,
          merchant_id: input.merchantId,
          metadata: input.metadata ?? {},
          mode: input.mode,
          reference: input.reference,
          status: approvalRequired ? "pending_approval" : "queued",
          total_amount: totalAmount,
          total_fee_minor: totalFeeMinor,
          total_hold_minor: totalHoldMinor,
          validation_report: {
            invalid_count: 0,
            valid_count: prepared.length,
            rows: []
          }
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto("payouts")
        .values(
          prepared.map((item) => ({
            account_name: item.accountName,
            account_number: item.accountNumber,
            amount: item.amountMinor,
            approved_by: null,
            bank_code: item.bankCode,
            batch_id: batchId,
            channel_id: item.channelId,
            completed_at: null,
            created_at: new Date(),
            created_by: input.createdBy,
            currency: item.currency,
            failure_code: null,
            failure_message: null,
            fee_minor: item.feeMinor,
            id: newId("pay_"),
            last_status_check_at: null,
            merchant_id: input.merchantId,
            metadata: item.metadata,
            method: item.method,
            mode: input.mode,
            narration: item.narration,
            network: item.network,
            next_status_check_at: null,
            phone: item.phone,
            provider_ref: null,
            reference: item.reference,
            send_attempts: 0,
            status: approvalRequired ? "pending_approval" : "queued",
            status_check_attempts: 0,
            total_hold_minor: item.totalHoldMinor
          }))
        )
        .execute();

      await this.#holdPayoutAmount(trx, {
        actorId: input.createdBy,
        currency: input.currency,
        merchantId: input.merchantId,
        mode: input.mode,
        payoutId: batchId,
        totalHoldMinor
      });

      return {
        accepted: true,
        batch: await this.#loadBatch(trx, batch.id)
      } as const;
    });
  }

  async getById(merchantId: string, mode: "live" | "test", payoutId: string) {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const row = await trx
        .selectFrom("payouts")
        .selectAll()
        .where("id", "=", payoutId)
        .executeTakeFirst();

      if (!row) {
        throw notFoundError();
      }

      return mapPayout(row);
    });
  }

  async list(
    merchantId: string,
    mode: "live" | "test",
    filters: PayoutListFilters,
    limit: number
  ) {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      let query = trx
        .selectFrom("payouts")
        .selectAll()
        .$if(Boolean(filters.status), (builder) =>
          builder.where("status", "=", filters.status!)
        )
        .$if(Boolean(filters.reference), (builder) =>
          builder.where("reference", "=", filters.reference!)
        )
        .$if(Boolean(filters.batchId), (builder) =>
          builder.where("batch_id", "=", filters.batchId!)
        )
        .$if(Boolean(filters.createdGte), (builder) =>
          builder.where("created_at", ">=", filters.createdGte!)
        )
        .$if(Boolean(filters.createdLte), (builder) =>
          builder.where("created_at", "<=", filters.createdLte!)
        )
        .orderBy("created_at desc")
        .orderBy("id desc")
        .limit(limit + 1);

      if (filters.startingAfter) {
        const anchor = await trx
          .selectFrom("payouts")
          .select(["created_at", "id"])
          .where("id", "=", filters.startingAfter)
          .executeTakeFirst();

        if (!anchor) {
          throw cursorNotFoundError();
        }

        query = query.where((eb) =>
          eb.or([
            eb("created_at", "<", anchor.created_at),
            eb.and([eb("created_at", "=", anchor.created_at), eb("id", "<", anchor.id)])
          ])
        );
      }

      const rows = await query.execute();
      const page = rows.slice(0, limit).map((row) => mapPayout(row));
      return {
        data: page,
        hasMore: rows.length > limit,
        nextStartingAfter: rows.length > limit ? page.at(-1)?.id ?? null : null
      };
    });
  }

  async getBatchById(merchantId: string, mode: "live" | "test", batchId: string) {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) =>
      this.#loadBatch(trx, batchId)
    );
  }

  async listBatches(
    merchantId: string,
    mode: "live" | "test",
    filters: PayoutBatchListFilters,
    limit: number
  ) {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      let query = trx
        .selectFrom("payout_batches")
        .selectAll()
        .$if(Boolean(filters.status), (builder) =>
          builder.where("status", "=", filters.status!)
        )
        .$if(Boolean(filters.reference), (builder) =>
          builder.where("reference", "=", filters.reference!)
        )
        .$if(Boolean(filters.createdGte), (builder) =>
          builder.where("created_at", ">=", filters.createdGte!)
        )
        .$if(Boolean(filters.createdLte), (builder) =>
          builder.where("created_at", "<=", filters.createdLte!)
        )
        .orderBy("created_at desc")
        .orderBy("id desc")
        .limit(limit + 1);

      if (filters.startingAfter) {
        const anchor = await trx
          .selectFrom("payout_batches")
          .select(["created_at", "id"])
          .where("id", "=", filters.startingAfter)
          .executeTakeFirst();

        if (!anchor) {
          throw cursorNotFoundError();
        }

        query = query.where((eb) =>
          eb.or([
            eb("created_at", "<", anchor.created_at),
            eb.and([eb("created_at", "=", anchor.created_at), eb("id", "<", anchor.id)])
          ])
        );
      }

      const rows = await query.execute();
      const page = await Promise.all(rows.slice(0, limit).map((row) => this.#loadBatch(trx, row.id)));
      return {
        data: page,
        hasMore: rows.length > limit,
        nextStartingAfter: rows.length > limit ? page.at(-1)?.id ?? null : null
      };
    });
  }

  async cancel(
    merchantId: string,
    mode: "live" | "test",
    payoutId: string,
    actorId: string
  ) {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const payout = await this.#loadPayoutForUpdate(trx, payoutId);
      if (!["pending_approval", "queued"].includes(payout.status)) {
        throw new ApiRouteError({
          code: "validation_error",
          field: "status",
          message: "Only queued or pending-approval payouts can be cancelled.",
          statusCode: getErrorDefinition("validation_error").status
        });
      }

      await this.#releaseHold(trx, {
        actorId,
        currency: payout.currency,
        merchantId,
        mode,
        payoutId,
        totalHoldMinor: payout.totalHoldMinor
      });

      const updated = await trx
        .updateTable("payouts")
        .set({
          completed_at: new Date(),
          status: "cancelled"
        })
        .where("id", "=", payoutId)
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.#writeTransactionEvent(trx, {
        fromStatus: payout.status,
        merchantId,
        mode,
        payoutId,
        reason: "cancelled_by_merchant",
        toStatus: "cancelled"
      });
      await this.#refreshBatchStatus(trx, updated.batch_id);
      return mapPayout(updated);
    });
  }

  async approvePayout(input: {
    approverId: string;
    merchantId: string;
    mode: "live" | "test";
    payoutId: string;
  }) {
    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      const payout = await this.#loadPayoutForUpdate(trx, input.payoutId);
      if (payout.status !== "pending_approval") {
        throw new ApiRouteError({
          code: "validation_error",
          field: "status",
          message: "This payout does not require approval.",
          statusCode: getErrorDefinition("validation_error").status
        });
      }

      if (payout.createdBy === input.approverId) {
        throw new ApiRouteError({
          code: "forbidden",
          message: "A second user must approve this payout.",
          statusCode: 403
        });
      }

      const updated = await trx
        .updateTable("payouts")
        .set({
          approved_by: input.approverId,
          status: "queued"
        })
        .where("id", "=", payout.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.#writeTransactionEvent(trx, {
        fromStatus: "pending_approval",
        merchantId: input.merchantId,
        mode: input.mode,
        payoutId: payout.id,
        toStatus: "queued"
      });
      await this.#refreshBatchStatus(trx, updated.batch_id);
      return mapPayout(updated);
    });
  }

  async reconcileProviderConfirmation(input: {
    failureCode?: string | null;
    failureMessage?: string | null;
    merchantId: string;
    mode: "live" | "test";
    now?: Date;
    outcome: ProviderOutcome;
    payoutId: string;
    providerRef?: string | null;
    providerStatus?: string | null;
  }): Promise<PayoutRecord> {
    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      const payout = await this.#loadPayoutForUpdate(trx, input.payoutId);
      await this.#reconcileProviderResult(trx, {
        failureCode: input.failureCode ?? null,
        failureMessage: input.failureMessage ?? null,
        now: input.now ?? new Date(),
        outcome: input.outcome,
        payout,
        providerRef: input.providerRef ?? payout.providerRef,
        providerStatus: input.providerStatus ?? null
      });

      return this.#loadPayoutForUpdate(trx, input.payoutId);
    });
  }

  async approveBatch(input: {
    approverId: string;
    batchId: string;
    merchantId: string;
    mode: "live" | "test";
  }) {
    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      const batch = await trx
        .selectFrom("payout_batches")
        .selectAll()
        .where("id", "=", input.batchId)
        .forUpdate()
        .executeTakeFirst();

      if (!batch) {
        throw notFoundError();
      }

      if (batch.status !== "pending_approval") {
        throw new ApiRouteError({
          code: "validation_error",
          field: "status",
          message: "This batch does not require approval.",
          statusCode: getErrorDefinition("validation_error").status
        });
      }

      if (batch.created_by === input.approverId) {
        throw new ApiRouteError({
          code: "forbidden",
          message: "A second user must approve this batch.",
          statusCode: 403
        });
      }

      await trx
        .updateTable("payout_batches")
        .set({
          approved_by: input.approverId,
          status: "queued"
        })
        .where("id", "=", batch.id)
        .execute();

      await trx
        .updateTable("payouts")
        .set({
          approved_by: input.approverId,
          status: "queued"
        })
        .where("batch_id", "=", batch.id)
        .where("status", "=", "pending_approval")
        .execute();

      return this.#loadBatch(trx, batch.id);
    });
  }

  async processQueuedPayouts(limit = 100) {
    const rows = await this.#listQueuedForDispatch(limit);
    const grouped = new Map<string, DispatchCandidate[]>();

    for (const row of rows) {
      const current = grouped.get(row.channelId) ?? [];
      current.push(row);
      grouped.set(row.channelId, current);
    }

    let processed = 0;
    for (const entries of grouped.values()) {
      const concurrencyLimit = getPayoutConcurrencyLimit(entries[0]!.config);
      for (const row of entries.slice(0, concurrencyLimit)) {
        await this.#dispatchQueuedPayout(row);
        processed += 1;
      }
    }

    return processed;
  }

  async pollDueStatusChecks(limit = 50) {
    const due = await this.#loadDuePollingRows(limit);
    let processed = 0;

    for (const row of due) {
      await this.#pollPayout(row);
      processed += 1;
    }

    return processed;
  }

  async applyProviderCallback(input: {
    payoutId: string;
    providerRef?: string;
    providerStatus: string;
    reason?: string;
  }) {
    const context = await this.#lookupPayoutContext(input.payoutId);
    return runWithMerchantScope(this.#database, context.merchantId, context.mode, async (trx) => {
      const payout = await this.#loadPayoutForUpdate(trx, input.payoutId);
      const outcome = mapProviderStatusTextToOutcome(input.providerStatus);

      await this.#reconcileProviderResult(trx, {
        failureCode: outcome === "failed" ? "provider_error" : null,
        failureMessage: input.reason ?? null,
        now: new Date(),
        outcome,
        payout,
        providerRef: input.providerRef ?? payout.providerRef,
        providerStatus: input.providerStatus
      });

      return this.#loadPayoutForUpdate(trx, input.payoutId);
    });
  }

  async #preparePayout(
    trx: ScopedTransaction,
    merchant: MerchantPayoutContext,
    input: {
      accountName: string | null;
      accountNumber: string | null;
      amountMinor: bigint;
      bankCode: string | null;
      metadata: Json;
      method: PayoutMethod;
      narration: string | null;
      network: string | null;
      phone: string | null;
      reference: string | null;
    }
  ): Promise<PreparedPayoutInput> {
    assertAmountWithinApiLimits(input.amountMinor);

    if (input.method === "mobile_money") {
      const normalizedPhone = this.#normalizePhone(input.phone, merchant.countryCode);
      const detectedNetwork =
        input.network ??
        (await detectNetworkFromMsisdn(this.#database, {
          countryCode: merchant.countryCode,
          msisdn: normalizedPhone
        }));

      const channel = await this.#router.pick(
        "mobile_money",
        "payout",
        merchant.countryCode,
        detectedNetwork,
        merchant.mode
      );

      if (!channel) {
        throw unavailableChannelError();
      }

      const feeQuote = await this.#feeService.quote(
        {
          countryCode: merchant.countryCode,
          id: merchant.id,
          mode: merchant.mode,
          settlementCurrency: merchant.settlementCurrency
        },
        "payout",
        "mobile_money",
        detectedNetwork,
        input.amountMinor,
        merchant.settlementCurrency,
        trx
      );

      return {
        accountName: null,
        accountNumber: null,
        amountMinor: input.amountMinor,
        bankCode: null,
        channelId: channel.id,
        currency: merchant.settlementCurrency,
        feeMinor: feeQuote.feeMinor,
        metadata: input.metadata,
        method: "mobile_money",
        narration: input.narration,
        network: detectedNetwork,
        phone: normalizedPhone,
        reference: input.reference,
        totalHoldMinor: input.amountMinor + feeQuote.feeMinor
      };
    }

    if (!input.accountNumber || !input.bankCode) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "bank_code",
        message: "Bank payouts require bank_code and account_number.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    const bank = await trx
      .selectFrom("banks")
      .select(["code"])
      .where("country_code", "=", merchant.countryCode)
      .where("code", "=", input.bankCode)
      .where("active", "=", true)
      .executeTakeFirst();

    if (!bank) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "bank_code",
        message: "The selected bank is not active for this country.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    const channel = await this.#router.pick(
      "bank",
      "payout",
      merchant.countryCode,
      null,
      merchant.mode
    );

    if (!channel) {
      throw unavailableChannelError();
    }

    const feeQuote = await this.#feeService.quote(
      {
        countryCode: merchant.countryCode,
        id: merchant.id,
        mode: merchant.mode,
        settlementCurrency: merchant.settlementCurrency
      },
      "payout",
      "bank",
      null,
      input.amountMinor,
      merchant.settlementCurrency,
      trx
    );

    return {
      accountName: input.accountName,
      accountNumber: input.accountNumber,
      amountMinor: input.amountMinor,
      bankCode: input.bankCode,
      channelId: channel.id,
      currency: merchant.settlementCurrency,
      feeMinor: feeQuote.feeMinor,
      metadata: input.metadata,
      method: "bank",
      narration: input.narration,
      network: null,
      phone: null,
      reference: input.reference,
      totalHoldMinor: input.amountMinor + feeQuote.feeMinor
    };
  }

  async #createInScope(
    trx: ScopedTransaction,
    merchant: MerchantPayoutContext,
    input: CreatePayoutInput
  ): Promise<PayoutRecord> {
    await this.#complianceService.enforceOperationLimits(trx, {
      amountMinor: input.amountMinor,
      kind: "payout",
      merchantId: input.merchantId,
      mode: input.mode
    });
    await this.#assertPayoutReferenceAvailable(trx, input.reference);
    const prepared = await this.#preparePayout(trx, merchant, {
      accountName: input.accountName,
      accountNumber: input.accountNumber,
      amountMinor: input.amountMinor,
      bankCode: input.bankCode,
      metadata: input.metadata ?? {},
      method: input.method,
      narration: input.narration,
      network: input.network,
      phone: input.phone,
      reference: input.reference
    });

    const payoutId = newId("pay_");
    await this.#complianceService.screenPayoutIfRequired(trx, {
      amountMinor: prepared.amountMinor,
      merchantId: input.merchantId,
      mode: input.mode,
      payoutReference: payoutId,
      subject: {
        account_name: prepared.accountName,
        account_number_masked: maskAccountNumber(prepared.accountNumber),
        bank_code: prepared.bankCode,
        method: prepared.method,
        network: prepared.network,
        phone_masked: maskPhone(prepared.phone)
      }
    });
    const approvalRequired = this.#requiresApproval(merchant, prepared.amountMinor);
    const row = await trx
      .insertInto("payouts")
      .values({
        account_name: prepared.accountName,
        account_number: prepared.accountNumber,
        amount: prepared.amountMinor,
        approved_by: null,
        bank_code: prepared.bankCode,
        batch_id: null,
        channel_id: prepared.channelId,
        completed_at: null,
        created_at: new Date(),
        created_by: input.createdBy,
        currency: prepared.currency,
        failure_code: null,
        failure_message: null,
        fee_minor: prepared.feeMinor,
        id: payoutId,
        last_status_check_at: null,
        merchant_id: input.merchantId,
        metadata: prepared.metadata,
        method: prepared.method,
        mode: input.mode,
        narration: prepared.narration,
        network: prepared.network,
        next_status_check_at: null,
        phone: prepared.phone,
        provider_ref: null,
        reference: prepared.reference,
        send_attempts: 0,
        status: approvalRequired ? "pending_approval" : "queued",
        status_check_attempts: 0,
        total_hold_minor: prepared.totalHoldMinor
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.#holdPayoutAmount(trx, {
      actorId: input.createdBy,
      currency: prepared.currency,
      merchantId: input.merchantId,
      mode: input.mode,
      payoutId,
      totalHoldMinor: prepared.totalHoldMinor
    });

    if (!approvalRequired) {
      await this.#writeTransactionEvent(trx, {
        merchantId: input.merchantId,
        mode: input.mode,
        payoutId,
        toStatus: "queued"
      });
    }

    return mapPayout(row);
  }

  async #dispatchQueuedPayout(candidate: DispatchCandidate) {
    const catalog = this.#requireProviderCatalog();

    await runWithMerchantScope(this.#database, candidate.merchantId, candidate.mode, async (trx) => {
      const payout = await this.#loadPayoutForUpdate(trx, candidate.id);
      if (payout.status !== "queued" || payout.sendAttempts > 0) {
        return;
      }

      const result =
        payout.method === "bank"
          ? await catalog.resolveBankPayoutProvider(candidate.channel).payout({
              ...(payout.accountName ? { accountName: payout.accountName } : {}),
              accountNumber: payout.accountNumber ?? "",
              amount: Number(payout.amount),
              bankCode: payout.bankCode ?? "",
              currency: payout.currency,
              ...(payout.metadata ? { metadata: payout.metadata } : {}),
              ...(payout.narration ? { narration: payout.narration } : {}),
              reference: payout.id,
              context: {
                merchantId: payout.merchantId,
                mode: payout.mode,
                requestId: payout.id
              }
            })
          : await catalog.resolveMobileMoneyProvider(candidate.channel).payout({
              amount: Number(payout.amount),
              currency: payout.currency,
              ...(payout.metadata ? { metadata: payout.metadata } : {}),
              msisdn: payout.phone ?? "",
              ...(payout.network ? { network: payout.network } : {}),
              reference: payout.id,
              context: {
                merchantId: payout.merchantId,
                mode: payout.mode,
                requestId: payout.id
              }
            });

      const nextStatus = mapProviderOutcomeToPayoutStatus(result.outcome);
      if (!nextStatus) {
        await trx
          .updateTable("payouts")
          .set({
            next_status_check_at: new Date(Date.now() + 60_000),
            provider_ref: result.providerRef ?? null,
            send_attempts: payout.sendAttempts + 1,
            status: "processing"
          })
          .where("id", "=", payout.id)
          .execute();

        await this.#writeTransactionEvent(trx, {
          fromStatus: payout.status,
          merchantId: payout.merchantId,
          mode: payout.mode,
          payoutId: payout.id,
          providerRef: result.providerRef ?? null,
          toStatus: "processing"
        });
        await this.#refreshBatchStatus(trx, payout.batchId);
        return;
      }

      await this.#reconcileProviderResult(trx, {
        failureCode: result.outcome === "failed" ? result.failureCode ?? "provider_error" : null,
        failureMessage: result.outcome === "failed" ? result.providerStatus ?? null : null,
        now: new Date(),
        outcome: result.outcome,
        payout,
        providerRef: result.providerRef ?? payout.providerRef,
        providerStatus: result.providerStatus ?? null
      });
    });
  }

  async #pollPayout(candidate: PollCandidate) {
    const catalog = this.#requireProviderCatalog();
    const result =
      candidate.providerRef === null
        ? {
            outcome: "unknown" as const,
            providerRef: null,
            providerStatus: "unknown"
          }
        : candidate.method === "bank"
          ? await catalog.resolveBankPayoutProvider(candidate.channel).getStatus(candidate.providerRef)
          : await catalog.resolveMobileMoneyProvider(candidate.channel).getStatus(candidate.providerRef);

    await runWithMerchantScope(this.#database, candidate.merchantId, candidate.mode, async (trx) => {
      const payout = await this.#loadPayoutForUpdate(trx, candidate.id);
      await this.#reconcileProviderResult(trx, {
        failureCode: result.outcome === "failed" ? result.failureCode ?? "provider_error" : null,
        failureMessage: result.outcome === "failed" ? result.providerStatus ?? null : null,
        now: new Date(),
        outcome: result.outcome,
        payout,
        providerRef: result.providerRef ?? payout.providerRef,
        providerStatus: result.providerStatus ?? null,
        recordStatusCheck: true
      });
    });
  }

  async #reconcileProviderResult(
    trx: ScopedTransaction,
    input: {
      failureCode: string | null;
      failureMessage: string | null;
      now: Date;
      outcome: ProviderOutcome;
      payout: PayoutRecord;
      providerRef: string | null;
      providerStatus: string | null;
      recordStatusCheck?: boolean;
    }
  ) {
    const targetStatus = mapProviderOutcomeToPayoutStatus(input.outcome);

    if (!targetStatus) {
      await trx
        .updateTable("payouts")
        .set({
          ...(input.recordStatusCheck
            ? {
                last_status_check_at: input.now,
                next_status_check_at: new Date(input.now.getTime() + 60_000),
                status_check_attempts: input.payout.statusCheckAttempts + 1
              }
            : {}),
          provider_ref: input.providerRef,
          status: "processing"
        })
        .where("id", "=", input.payout.id)
        .execute();
      await this.#refreshBatchStatus(trx, input.payout.batchId);
      return;
    }

    if (targetStatus === "successful") {
      await this.#finalizeSuccessfulPayout(trx, input.payout, input.providerRef, input.now);
      return;
    }

    await this.#finalizeFailedPayout(
      trx,
      input.payout,
      input.failureCode,
      input.failureMessage,
      input.providerRef,
      input.now
    );
  }

  async #finalizeSuccessfulPayout(
    trx: ScopedTransaction,
    payout: PayoutRecord,
    providerRef: string | null,
    now: Date
  ) {
    if (!["processing", "queued"].includes(payout.status)) {
      return;
    }

    assertPayoutTransition(payout.status, "successful");

    const ledger = new LedgerService(trx, {
      actorId: payout.createdBy,
      actorType: "system"
    });

    await ledger.completePayout({
      amount: payout.amount,
      channelId: payout.channelId ?? "",
      currency: payout.currency,
      description: `Complete payout ${payout.id}`,
      merchantId: payout.merchantId,
      mode: payout.mode,
      payoutId: payout.id
    });

    if (payout.feeMinor > 0n) {
      await ledger.releasePayoutHold({
        amount: payout.feeMinor,
        currency: payout.currency,
        description: `Release payout fee hold ${payout.id}`,
        merchantId: payout.merchantId,
        mode: payout.mode,
        payoutId: payout.id
      });

      await ledger.chargeFee({
        amount: payout.feeMinor,
        currency: payout.currency,
        description: `Charge payout fee ${payout.id}`,
        feeId: payout.id,
        merchantId: payout.merchantId,
        mode: payout.mode
      });
    }

    await trx
      .updateTable("payouts")
      .set({
        completed_at: now,
        next_status_check_at: null,
        provider_ref: providerRef,
        status: "successful"
      })
      .where("id", "=", payout.id)
      .execute();

    await this.#writeTransactionEvent(trx, {
      fromStatus: payout.status,
      merchantId: payout.merchantId,
      mode: payout.mode,
      payoutId: payout.id,
      providerRef,
      toStatus: "successful"
    });
    await this.#writeOutboxEvent(trx, payout, "successful", providerRef);
    await this.#refreshBatchStatus(trx, payout.batchId);
  }

  async #finalizeFailedPayout(
    trx: ScopedTransaction,
    payout: PayoutRecord,
    failureCode: string | null,
    failureMessage: string | null,
    providerRef: string | null,
    now: Date
  ) {
    if (isPayoutTerminalStatus(payout.status)) {
      return;
    }

    assertPayoutTransition(payout.status, "failed");
    await this.#releaseHold(trx, {
      actorId: payout.createdBy,
      currency: payout.currency,
      merchantId: payout.merchantId,
      mode: payout.mode,
      payoutId: payout.id,
      totalHoldMinor: payout.totalHoldMinor
    });

    await trx
      .updateTable("payouts")
      .set({
        completed_at: now,
        failure_code: failureCode,
        failure_message: failureMessage,
        next_status_check_at: null,
        provider_ref: providerRef,
        status: "failed"
      })
      .where("id", "=", payout.id)
      .execute();

    await this.#writeTransactionEvent(trx, {
      fromStatus: payout.status,
      merchantId: payout.merchantId,
      mode: payout.mode,
      payoutId: payout.id,
      providerRef,
      reason: failureMessage,
      toStatus: "failed"
    });
    await this.#writeOutboxEvent(trx, payout, "failed", providerRef);
    await this.#refreshBatchStatus(trx, payout.batchId);
  }

  async #refreshBatchStatus(trx: ScopedTransaction, batchId: string | null) {
    if (!batchId) {
      return;
    }

    const batch = await trx
      .selectFrom("payout_batches")
      .selectAll()
      .where("id", "=", batchId)
      .forUpdate()
      .executeTakeFirst();

    if (!batch) {
      return;
    }

    const payouts = await trx
      .selectFrom("payouts")
      .select(["status"])
      .where("batch_id", "=", batchId)
      .execute();

    if (payouts.length === 0) {
      return;
    }

    const nextStatus =
      payouts.every((item) => isPayoutTerminalStatus(item.status))
        ? "completed"
        : payouts.some((item) => item.status === "processing")
          ? "processing"
          : payouts.some((item) => item.status === "queued")
            ? "queued"
        : payouts.some((item) => item.status === "on_hold")
          ? "on_hold"
            : "pending_approval";

    if (batch.status === nextStatus) {
      return;
    }

    await trx
      .updateTable("payout_batches")
      .set({
        completed_at: nextStatus === "completed" ? new Date() : null,
        status: nextStatus
      })
      .where("id", "=", batchId)
      .execute();

    const eventType = payoutBatchEventTypeForStatus(nextStatus);
    if (eventType) {
      await trx
        .insertInto("events_outbox")
        .values({
          id: newId("evt_"),
          merchant_id: batch.merchant_id,
          mode: batch.mode,
          payload: {
            batch_id: batch.id,
            item_count: batch.item_count,
            status: nextStatus,
            total_amount: Number(batch.total_amount)
          },
          type: eventType
        })
        .execute();
    }
  }

  async #holdPayoutAmount(
    trx: ScopedTransaction,
    input: {
      actorId: string;
      currency: CurrencyCode;
      merchantId: string;
      mode: "live" | "test";
      payoutId: string;
      totalHoldMinor: bigint;
    }
  ) {
    const ledger = new LedgerService(trx, {
      actorId: input.actorId,
      actorType: "api_key"
    });

    await ledger.holdForPayout({
      amount: input.totalHoldMinor,
      currency: input.currency,
      description: `Hold payout ${input.payoutId}`,
      merchantId: input.merchantId,
      mode: input.mode,
      payoutId: input.payoutId
    });
  }

  async #releaseHold(
    trx: ScopedTransaction,
    input: {
      actorId: string;
      currency: CurrencyCode;
      merchantId: string;
      mode: "live" | "test";
      payoutId: string;
      totalHoldMinor: bigint;
    }
  ) {
    const ledger = new LedgerService(trx, {
      actorId: input.actorId,
      actorType: "api_key"
    });

    await ledger.releasePayoutHold({
      amount: input.totalHoldMinor,
      currency: input.currency,
      description: `Release payout hold ${input.payoutId}`,
      merchantId: input.merchantId,
      mode: input.mode,
      payoutId: input.payoutId
    });
  }

  async #loadMerchantContext(
    merchantId: string,
    mode: "live" | "test"
  ): Promise<MerchantPayoutContext> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const merchant = await trx
        .selectFrom("merchants")
        .select([
          "country_code as countryCode",
          "id",
          "mode",
          "payout_approval_threshold_minor as payoutApprovalThresholdMinor",
          "payouts_frozen as payoutsFrozen",
          "payouts_require_approval as payoutsRequireApproval",
          "settlement_currency as settlementCurrency",
          "status"
        ])
        .where("id", "=", merchantId)
        .executeTakeFirst();

      if (!merchant) {
        throw notFoundError();
      }

      return {
        ...merchant,
        payoutApprovalThresholdMinor: merchant.payoutApprovalThresholdMinor
          ? BigInt(merchant.payoutApprovalThresholdMinor)
          : null,
        settlementCurrency: parseCurrencyCode(merchant.settlementCurrency)
      };
    });
  }

  #assertMerchantCanPayout(merchant: MerchantPayoutContext) {
    if (merchant.status !== "active") {
      throw new ApiRouteError({
        code: "merchant_suspended",
        message: getErrorDefinition("merchant_suspended").message,
        statusCode: getErrorDefinition("merchant_suspended").status
      });
    }

    if (merchant.payoutsFrozen) {
      throw new ApiRouteError({
        code: "payouts_frozen",
        message: getErrorDefinition("payouts_frozen").message,
        statusCode: getErrorDefinition("payouts_frozen").status
      });
    }
  }

  #assertPayoutCurrency(merchant: MerchantPayoutContext, currency: CurrencyCode) {
    if (currency !== merchant.settlementCurrency) {
      throw new ApiRouteError({
        code: "unsupported_currency",
        field: "currency",
        message: `Payout currency must match the merchant settlement currency (${merchant.settlementCurrency}).`,
        statusCode: getErrorDefinition("unsupported_currency").status
      });
    }
  }

  #requiresApproval(merchant: MerchantPayoutContext, amountMinor: bigint) {
    return (
      merchant.payoutsRequireApproval &&
      merchant.payoutApprovalThresholdMinor !== null &&
      amountMinor > merchant.payoutApprovalThresholdMinor
    );
  }

  #normalizePhone(phone: string | null, countryCode: string) {
    if (!phone) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "phone",
        message: "Phone is required for mobile money payouts.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    try {
      return normalizeMobileMoneyPhoneNumber(phone, countryCode);
    } catch (error) {
      if (error instanceof InvalidMobileMoneyPhoneError) {
        throw new ApiRouteError({
          code: "invalid_phone_number",
          field: "phone",
          message: error.message,
          statusCode: getErrorDefinition("invalid_phone_number").status
        });
      }

      throw error;
    }
  }

  async #assertPayoutReferenceAvailable(trx: ScopedTransaction, reference: string | null) {
    if (!reference) {
      return;
    }

    const existing = await trx
      .selectFrom("payouts")
      .select("id")
      .where("reference", "=", reference)
      .executeTakeFirst();

    if (existing) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "reference",
        message: "This reference is already in use for the merchant.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }
  }

  async #assertBatchReferenceAvailable(trx: ScopedTransaction, reference: string | null) {
    if (!reference) {
      return;
    }

    const existing = await trx
      .selectFrom("payout_batches")
      .select("id")
      .where("reference", "=", reference)
      .executeTakeFirst();

    if (existing) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "reference",
        message: "This batch reference is already in use for the merchant.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }
  }

  async #loadPayoutForUpdate(trx: ScopedTransaction, payoutId: string) {
    const row = await trx
      .selectFrom("payouts")
      .selectAll()
      .where("id", "=", payoutId)
      .forUpdate()
      .executeTakeFirst();

    if (!row) {
      throw notFoundError();
    }

    return mapPayout(row);
  }

  async #loadBatch(trx: ScopedTransaction, batchId: string) {
    const batch = await trx
      .selectFrom("payout_batches")
      .selectAll()
      .where("id", "=", batchId)
      .executeTakeFirst();

    if (!batch) {
      throw notFoundError();
    }

    const payouts = await trx
      .selectFrom("payouts")
      .selectAll()
      .where("batch_id", "=", batchId)
      .orderBy("created_at")
      .execute();

    return mapPayoutBatch(batch, payouts.map((row) => mapPayout(row)));
  }

  async #listQueuedForDispatch(limit: number): Promise<DispatchCandidate[]> {
    return runWithSystemScope(
      this.#database,
      "load queued payouts for dispatch",
      async (trx) => {
        const rows = await trx
          .selectFrom("payouts as payout")
          .innerJoin("channels as channel", "channel.id", "payout.channel_id")
          .innerJoin("merchants as merchant", (join) =>
            join
              .onRef("merchant.id", "=", "payout.merchant_id")
              .onRef("merchant.mode", "=", "payout.mode")
          )
          .select([
            "payout.id as id",
            "payout.merchant_id as merchantId",
            "payout.mode as mode",
            "channel.capabilities as capabilities",
            "channel.config as config",
            "channel.country_code as countryCode",
            "channel.credentials_encrypted as credentialsEncrypted",
            "channel.health as health",
            "channel.id as channelId",
            "channel.kind as kind",
            "channel.mode as channelMode",
            "channel.network as channelNetwork",
            "channel.priority as priority",
            "channel.provider_code as providerCode",
            "channel.status as channelStatus"
          ])
          .where("payout.status", "=", "queued")
          .where("merchant.status", "=", "active")
          .where("merchant.payouts_frozen", "=", false)
          .orderBy("payout.created_at")
          .limit(limit)
          .execute();

        return rows.map((row) => ({
          channel: {
            capabilities: row.capabilities,
            config: row.config,
            countryCode: row.countryCode,
            credentialsEncrypted: row.credentialsEncrypted,
            health: row.health,
            id: row.channelId,
            kind: row.kind,
            mode: row.channelMode,
            network: row.channelNetwork,
            priority: row.priority,
            providerCode: row.providerCode,
            status: row.channelStatus
          },
          channelId: row.channelId,
          config: row.config,
          id: row.id,
          merchantId: row.merchantId,
          mode: row.mode
        }));
      },
      { audit: false }
    );
  }

  async #loadDuePollingRows(limit: number): Promise<PollCandidate[]> {
    const now = new Date();
    return runWithSystemScope(
      this.#database,
      "load due payout status checks",
      async (trx) => {
        const rows = await trx
          .selectFrom("payouts as payout")
          .innerJoin("channels as channel", "channel.id", "payout.channel_id")
          .select([
            "payout.id as id",
            "payout.merchant_id as merchantId",
            "payout.method as method",
            "payout.mode as mode",
            "payout.provider_ref as providerRef",
            "channel.capabilities as capabilities",
            "channel.config as config",
            "channel.country_code as countryCode",
            "channel.credentials_encrypted as credentialsEncrypted",
            "channel.health as health",
            "channel.id as channelId",
            "channel.kind as kind",
            "channel.mode as channelMode",
            "channel.network as channelNetwork",
            "channel.priority as priority",
            "channel.provider_code as providerCode",
            "channel.status as channelStatus"
          ])
          .where("payout.status", "=", "processing")
          .where("payout.next_status_check_at", "<=", now)
          .orderBy("payout.next_status_check_at")
          .limit(limit)
          .execute();

        return rows.map((row) => ({
          channel: {
            capabilities: row.capabilities,
            config: row.config,
            countryCode: row.countryCode,
            credentialsEncrypted: row.credentialsEncrypted,
            health: row.health,
            id: row.channelId,
            kind: row.kind,
            mode: row.channelMode,
            network: row.channelNetwork,
            priority: row.priority,
            providerCode: row.providerCode,
            status: row.channelStatus
          },
          id: row.id,
          merchantId: row.merchantId,
          method: parsePayoutMethod(row.method),
          mode: row.mode,
          providerRef: row.providerRef
        }));
      },
      { audit: false }
    );
  }

  async #lookupPayoutContext(payoutId: string) {
    return runWithSystemScope(
      this.#database,
      "lookup payout context",
      async (trx) => {
        const row = await trx
          .selectFrom("payouts")
          .select(["merchant_id as merchantId", "mode"])
          .where("id", "=", payoutId)
          .executeTakeFirst();

        if (!row) {
          throw notFoundError();
        }

        return row;
      },
      { audit: false }
    );
  }

  async #writeTransactionEvent(
    trx: ScopedTransaction,
    input: {
      fromStatus?: string;
      merchantId: string;
      mode: "live" | "test";
      payoutId: string;
      providerRef?: string | null;
      reason?: string | null;
      toStatus: string;
    }
  ) {
    await trx
      .insertInto("transaction_events")
      .values({
        created_at: new Date(),
        from_status: input.fromStatus ?? null,
        id: newId("evt_"),
        merchant_id: input.merchantId,
        mode: input.mode,
        provider_payload: null,
        provider_reference: input.providerRef ?? null,
        reason: input.reason ?? null,
        resource_id: input.payoutId,
        resource_type: "payout",
        to_status: input.toStatus
      })
      .execute();
  }

  async #writeOutboxEvent(
    trx: ScopedTransaction,
    payout: PayoutRecord,
    status: "failed" | "successful" | "reversed",
    providerRef: string | null
  ) {
    const eventType = payoutEventTypeForStatus(status);
    if (!eventType) {
      return;
    }

    await trx
      .insertInto("events_outbox")
      .values({
        id: newId("evt_"),
        merchant_id: payout.merchantId,
        mode: payout.mode,
        payload: {
          amount: Number(payout.amount),
          batch_id: payout.batchId,
          payout_id: payout.id,
          provider_ref: providerRef,
          status
        },
        type: eventType
      })
      .execute();
  }

  #requireProviderCatalog() {
    if (!this.#providerCatalog) {
      throw new Error("Provider catalog is required for payout processing");
    }

    return this.#providerCatalog;
  }
}

function assertAmountWithinApiLimits(amountMinor: bigint) {
  if (amountMinor < 1n) {
    throw new ApiRouteError({
      code: "amount_too_small",
      message: getErrorDefinition("amount_too_small").message,
      statusCode: getErrorDefinition("amount_too_small").status
    });
  }

  if (amountMinor > 9_999_999_999_999n) {
    throw new ApiRouteError({
      code: "amount_too_large",
      message: getErrorDefinition("amount_too_large").message,
      statusCode: getErrorDefinition("amount_too_large").status
    });
  }
}

function unavailableChannelError() {
  return new ApiRouteError({
    code: "channel_unavailable",
    message: getErrorDefinition("channel_unavailable").message,
    statusCode: getErrorDefinition("channel_unavailable").status
  });
}

function notFoundError() {
  return new ApiRouteError({
    code: "not_found",
    message: getErrorDefinition("not_found").message,
    statusCode: getErrorDefinition("not_found").status
  });
}

function cursorNotFoundError() {
  return new ApiRouteError({
    code: "not_found",
    message: "The pagination cursor was not found.",
    statusCode: getErrorDefinition("not_found").status
  });
}

function getPayoutConcurrencyLimit(config: Json) {
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const raw = (config as JsonObject).payout_concurrency_limit;
    if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
      return raw;
    }
  }

  return 5;
}

function parsePayoutMethod(value: string): PayoutMethod {
  return value === "bank" ? "bank" : "mobile_money";
}

function maskPhone(phone: string | null) {
  if (!phone) {
    return null;
  }

  if (phone.length <= 4) {
    return phone;
  }

  return `${phone.slice(0, 4)}****${phone.slice(-2)}`;
}

function maskAccountNumber(accountNumber: string | null) {
  if (!accountNumber) {
    return null;
  }

  if (accountNumber.length <= 4) {
    return accountNumber;
  }

  return `${"*".repeat(Math.max(accountNumber.length - 4, 2))}${accountNumber.slice(-4)}`;
}

function normalizeJson(value: Json): Json {
  return value ?? {};
}

function extractBankCode(value: Json) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as JsonObject).bank_code;
    if (typeof raw === "string" && raw.trim() !== "") {
      return raw;
    }
  }

  throw new ApiRouteError({
    code: "validation_error",
    field: "settlement_account.details.bank_code",
    message: "The bank settlement account is missing a bank code.",
    statusCode: getErrorDefinition("validation_error").status
  });
}

function extractBankAccountNumber(value: Json) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as JsonObject).account_number;
    if (typeof raw === "string" && raw.trim() !== "") {
      return raw;
    }
  }

  throw new ApiRouteError({
    code: "validation_error",
    field: "settlement_account.details.account_number",
    message: "The bank settlement account is missing an account number.",
    statusCode: getErrorDefinition("validation_error").status
  });
}

function extractSettlementPhone(value: Json) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as JsonObject).phone;
    if (typeof raw === "string" && raw.trim() !== "") {
      return raw;
    }
  }

  throw new ApiRouteError({
    code: "validation_error",
    field: "settlement_account.details.phone",
    message: "The mobile money settlement account is missing a phone number.",
    statusCode: getErrorDefinition("validation_error").status
  });
}

function extractSettlementNetwork(value: Json) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as JsonObject).network;
    if (typeof raw === "string" && raw.trim() !== "") {
      return raw;
    }
  }

  throw new ApiRouteError({
    code: "validation_error",
    field: "settlement_account.details.network",
    message: "The mobile money settlement account is missing a network.",
    statusCode: getErrorDefinition("validation_error").status
  });
}

function extractSettlementAccountName(value: Json) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as JsonObject).account_name;
    return typeof raw === "string" && raw.trim() !== "" ? raw : null;
  }

  return null;
}

function mapPayout(row: {
  account_name: string | null;
  account_number: string | null;
  amount: string;
  approved_by: string | null;
  bank_code: string | null;
  batch_id: string | null;
  channel_id: string | null;
  completed_at: Date | null;
  created_at: Date;
  created_by: string;
  currency: string;
  failure_code: string | null;
  failure_message: string | null;
  fee_minor: string;
  id: string;
  merchant_id: string;
  metadata: Json;
  method: string;
  mode: "live" | "test";
  narration: string | null;
  network: string | null;
  phone: string | null;
  provider_ref: string | null;
  reference: string | null;
  send_attempts: number;
  status: PayoutRecord["status"];
  status_check_attempts: number;
  total_hold_minor: string;
}): PayoutRecord {
  return {
    accountName: row.account_name,
    accountNumber: row.account_number,
    amount: BigInt(row.amount),
    approvedBy: row.approved_by,
    bankCode: row.bank_code,
    batchId: row.batch_id,
    channelId: row.channel_id,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    currency: parseCurrencyCode(row.currency),
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    feeMinor: BigInt(row.fee_minor),
    id: row.id,
    merchantId: row.merchant_id,
    metadata: normalizeJson(row.metadata),
    method: parsePayoutMethod(row.method),
    mode: row.mode,
    narration: row.narration,
    network: row.network,
    phone: row.phone,
    providerRef: row.provider_ref,
    reference: row.reference,
    sendAttempts: row.send_attempts,
    status: row.status,
    statusCheckAttempts: row.status_check_attempts,
    totalHoldMinor: BigInt(row.total_hold_minor)
  };
}

function mapPayoutBatch(
  row: {
    approved_by: string | null;
    completed_at: Date | null;
    created_at: Date;
    created_by: string;
    currency: string;
    id: string;
    item_count: number;
    merchant_id: string;
    metadata: Json;
    mode: "live" | "test";
    reference: string | null;
    status: PayoutBatchRecord["status"];
    total_amount: string;
    total_fee_minor: string;
    total_hold_minor: string;
    validation_report: Json;
  },
  payouts: PayoutRecord[]
): PayoutBatchRecord {
  return {
    approvedBy: row.approved_by,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    currency: parseCurrencyCode(row.currency),
    id: row.id,
    itemCount: row.item_count,
    merchantId: row.merchant_id,
    metadata: normalizeJson(row.metadata),
    mode: row.mode,
    payouts,
    reference: row.reference,
    status: row.status,
    totalAmount: BigInt(row.total_amount),
    totalFeeMinor: BigInt(row.total_fee_minor),
    totalHoldMinor: BigInt(row.total_hold_minor),
    validationReport: normalizeJson(row.validation_report)
  };
}
