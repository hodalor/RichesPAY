import {
  getErrorDefinition,
  newId,
  type CurrencyCode
} from "@richespay/shared";

import { CollectionService } from "../collections";
import type { CollectionNextAction } from "../collections/types";
import {
  runWithMerchantScope,
  runWithSystemScope,
  type AppDatabase,
  type ScopedTransaction
} from "../db";
import { LedgerService } from "../ledger";
import { ApiRouteError } from "../lib/api-error";
import { parseCurrencyCode } from "../pricing/types";
import { ProviderCatalog } from "../providers/catalog";
import type { RpMode } from "../db/types";

import type {
  ConfirmBankTransferTopupInput,
  CreateBankTransferTopupInput,
  CreateTopupInput,
  ImportBankTransferResult,
  ImportBankTransferRowInput,
  MerchantBalanceAlertThresholdRecord,
  TopupListFilters,
  TopupPage,
  TopupRecord,
  TopupSettingsView
} from "./types";
import {
  normalizeTopupMetadata,
  parseThresholdRecord,
  parseTopupRecord
} from "./types";

interface MerchantTopupContext {
  id: string;
  mode: RpMode;
  settlementCurrency: CurrencyCode;
  status: string;
  topupTransferReference: string;
}

export class TopupService {
  #collectionService: CollectionService | null;
  #database: AppDatabase;

  constructor(input: {
    database: AppDatabase;
    encryptionKey?: string;
  }) {
    this.#database = input.database;
    this.#collectionService =
      input.encryptionKey
        ? new CollectionService({
            database: input.database,
            providerCatalog: new ProviderCatalog({
              database: input.database,
              encryptionKey: input.encryptionKey
            })
          })
        : null;
  }

  async createPaymentTopup(input: CreateTopupInput): Promise<TopupRecord> {
    const merchant = await this.#loadMerchantContext(input.merchantId, input.mode);
    this.#assertMerchantCanTopUp(merchant);
    this.#assertSettlementCurrency(merchant, input.currency);

    const topupId = newId("top_");
    await runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      await trx
        .insertInto("topups")
        .values({
          amount: input.amountMinor,
          bank_reference: null,
          completed_at: null,
          confirmed_by: null,
          currency: input.currency,
          fee_minor: 0,
          id: topupId,
          merchant_id: input.merchantId,
          method: input.method,
          mode: input.mode,
          provider_ref: null,
          source_collection_id: null,
          status: "pending"
        })
        .execute();
    });

    const collectionService = this.#requireCollectionService();
    const collection = await collectionService.create({
      amountMinor: input.amountMinor,
      currency: input.currency,
      customerEmail: null,
      customerName: null,
      description: `Merchant balance top-up ${topupId}`,
      idempotencyKey: null,
      merchantId: input.merchantId,
      metadata: normalizeTopupMetadata({
        topupId
      }),
      method: input.method,
      mode: input.mode,
      network: input.method === "mobile_money" ? input.network ?? null : null,
      phone: input.method === "mobile_money" ? input.phone ?? null : null,
      reference: null,
      referenceType: "topup",
      requestId: input.requestId
    });

    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      const updated = await trx
        .updateTable("topups")
        .set({
          completed_at: collection.completedAt,
          fee_minor: collection.feeMinor,
          provider_ref: collection.providerRef,
          source_collection_id: collection.id,
          status: mapCollectionStatusToTopupStatus(collection.status)
        })
        .where("id", "=", topupId)
        .returningAll()
        .executeTakeFirstOrThrow();

      return parseTopupRecord(updated, collection.nextAction);
    });
  }

  async createBankTransferTopup(input: CreateBankTransferTopupInput): Promise<TopupRecord> {
    const merchant = await this.#loadMerchantContext(input.merchantId, input.mode);
    this.#assertMerchantCanTopUp(merchant);
    this.#assertSettlementCurrency(merchant, input.currency);

    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      const created = await trx
        .insertInto("topups")
        .values({
          amount: input.amountMinor,
          bank_reference: merchant.topupTransferReference,
          completed_at: null,
          confirmed_by: null,
          currency: input.currency,
          fee_minor: 0,
          id: newId("top_"),
          merchant_id: input.merchantId,
          method: "bank_transfer",
          mode: input.mode,
          provider_ref: null,
          source_collection_id: null,
          status: "pending"
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return parseTopupRecord(created);
    });
  }

  async addTestFunds(input: {
    actorId: string;
    amountMinor: bigint;
    currency: CurrencyCode;
    merchantId: string;
    mode: RpMode;
  }): Promise<TopupRecord> {
    if (input.mode !== "test") {
      throw new ApiRouteError({
        code: "validation_error",
        field: "mode",
        message: "Test funds can only be added in test mode.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    const merchant = await this.#loadMerchantContext(input.merchantId, input.mode);
    this.#assertMerchantCanTopUp(merchant);
    this.#assertSettlementCurrency(merchant, input.currency);

    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      const topupId = newId("top_");
      const now = new Date();
      const ledger = new LedgerService(trx, {
        actorId: input.actorId,
        actorType: "user"
      });

      await ledger.creditTopup({
        amount: input.amountMinor,
        currency: input.currency,
        description: `Add test funds ${topupId}`,
        merchantId: input.merchantId,
        mode: input.mode,
        sourceAccountType: "suspense",
        topupId
      });

      const created = await trx
        .insertInto("topups")
        .values({
          amount: input.amountMinor,
          bank_reference: merchant.topupTransferReference,
          completed_at: now,
          confirmed_by: input.actorId,
          currency: input.currency,
          fee_minor: 0,
          id: topupId,
          merchant_id: input.merchantId,
          method: "bank_transfer",
          mode: input.mode,
          provider_ref: "test_funds",
          source_collection_id: null,
          status: "successful"
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return parseTopupRecord(created);
    });
  }

  async getById(merchantId: string, mode: RpMode, topupId: string): Promise<TopupRecord> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const row = await this.#loadTopupWithCollection(trx, topupId);
      if (!row) {
        throw notFoundError("Top-up not found");
      }

      return mapTopupWithCollection(row);
    });
  }

  async list(
    merchantId: string,
    mode: RpMode,
    filters: TopupListFilters,
    limit: number
  ): Promise<TopupPage> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      let anchor:
        | {
            created_at: Date;
            id: string;
          }
        | undefined;

      if (filters.startingAfter) {
        anchor = await trx
          .selectFrom("topups")
          .select(["created_at", "id"])
          .where("id", "=", filters.startingAfter)
          .executeTakeFirst();

        if (!anchor) {
          throw notFoundError("The pagination cursor was not found.");
        }
      }

      let query = trx
        .selectFrom("topups as topup")
        .leftJoin("collections as collection", "collection.id", "topup.source_collection_id")
        .select([
          "topup.amount",
          "topup.bank_reference",
          "topup.completed_at",
          "topup.confirmed_by",
          "topup.created_at",
          "topup.currency",
          "topup.fee_minor",
          "topup.id",
          "topup.merchant_id",
          "topup.method",
          "topup.mode",
          "topup.provider_ref",
          "topup.source_collection_id",
          "topup.status",
          "collection.provider_session as collection_provider_session"
        ])
        .$if(Boolean(filters.method), (builder) =>
          builder.where("topup.method", "=", filters.method!)
        )
        .$if(Boolean(filters.status), (builder) =>
          builder.where("topup.status", "=", filters.status!)
        )
        .$if(Boolean(filters.createdGte), (builder) =>
          builder.where("topup.created_at", ">=", filters.createdGte!)
        )
        .$if(Boolean(filters.createdLte), (builder) =>
          builder.where("topup.created_at", "<=", filters.createdLte!)
        );

      if (anchor) {
        query = query.where((eb) =>
          eb.or([
            eb("topup.created_at", "<", anchor.created_at),
            eb.and([
              eb("topup.created_at", "=", anchor.created_at),
              eb("topup.id", "<", anchor.id)
            ])
          ])
        );
      }

      const rows = await query
        .orderBy("topup.created_at", "desc")
        .orderBy("topup.id", "desc")
        .limit(limit + 1)
        .execute();

      return {
        items: rows.slice(0, limit).map(mapTopupWithCollection),
        nextStartingAfter: rows.length > limit ? rows[limit - 1]?.id ?? null : null
      };
    });
  }

  async getSettings(merchantId: string, mode: RpMode): Promise<TopupSettingsView> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const merchant = await trx
        .selectFrom("merchants")
        .select("topup_transfer_reference")
        .where("id", "=", merchantId)
        .executeTakeFirstOrThrow();

      const thresholds = await trx
        .selectFrom("merchant_balance_alert_thresholds")
        .selectAll()
        .orderBy("currency")
        .execute();

      return {
        thresholds: thresholds.map(parseThresholdRecord),
        transferReference: ensureTopupTransferReference(merchant.topup_transfer_reference)
      };
    });
  }

  async upsertThreshold(input: {
    currency: CurrencyCode;
    merchantId: string;
    mode: RpMode;
    thresholdMinor: bigint;
  }): Promise<MerchantBalanceAlertThresholdRecord> {
    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      const currentBalance = await getMerchantAvailableBalance(
        trx,
        input.merchantId,
        input.mode,
        input.currency
      );

      const saved = await trx
        .insertInto("merchant_balance_alert_thresholds")
        .values({
          currency: input.currency,
          is_below_threshold: currentBalance < input.thresholdMinor,
          merchant_id: input.merchantId,
          mode: input.mode,
          threshold_minor: input.thresholdMinor
        })
        .onConflict((conflict) =>
          conflict.columns(["merchant_id", "mode", "currency"]).doUpdateSet({
            is_below_threshold: currentBalance < input.thresholdMinor,
            threshold_minor: input.thresholdMinor
          })
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      return parseThresholdRecord(saved);
    });
  }

  async confirmBankTransferTopup(input: ConfirmBankTransferTopupInput): Promise<TopupRecord> {
    if (input.reason.trim() === "") {
      throw new ApiRouteError({
        code: "validation_error",
        field: "reason",
        message: "A reason is required to confirm a bank-transfer top-up.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    return runWithSystemScope(
      this.#database,
      input.reason,
      async (trx) => this.#confirmBankTransferTopupInTransaction(trx, input),
      { audit: false }
    );
  }

  async importBankTransferStatement(input: {
    adminUserId: string;
    reason: string;
    rows: ImportBankTransferRowInput[];
  }): Promise<ImportBankTransferResult> {
    if (input.reason.trim() === "") {
      throw new ApiRouteError({
        code: "validation_error",
        field: "reason",
        message: "A reason is required for bank statement imports.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    return runWithSystemScope(
      this.#database,
      input.reason,
      async (trx) => {
        const matched: ImportBankTransferResult["matched"] = [];
        const unmatched: ImportBankTransferRowInput[] = [];

        for (const row of input.rows) {
          const topup = await trx
            .selectFrom("topups")
            .selectAll()
            .where("method", "=", "bank_transfer")
            .where("status", "=", "pending")
            .where("bank_reference", "=", row.merchantTransferReference)
            .where("currency", "=", row.currency)
            .where("amount", "=", row.amountMinor.toString())
            .executeTakeFirst();

          if (!topup) {
            unmatched.push(row);
            continue;
          }

          const confirmed = await this.#confirmBankTransferTopupInTransaction(trx, {
            adminUserId: input.adminUserId,
            amountMinor: row.amountMinor,
            bankStatementReference: row.bankStatementReference,
            reason: input.reason,
            topupId: topup.id
          });

          matched.push({
            amountMinor: confirmed.amount,
            currency: confirmed.currency,
            merchantTransferReference: row.merchantTransferReference,
            topupId: confirmed.id
          });
        }

        return {
          matched,
          unmatched
        };
      },
      { audit: false }
    );
  }

  async #confirmBankTransferTopupInTransaction(
    trx: ScopedTransaction,
    input: ConfirmBankTransferTopupInput
  ): Promise<TopupRecord> {
    const row = await trx
      .selectFrom("topups")
      .selectAll()
      .where("id", "=", input.topupId)
      .forUpdate()
      .executeTakeFirst();

    if (!row) {
      throw notFoundError("Top-up not found");
    }

    const topup = parseTopupRecord(row);
    if (topup.method !== "bank_transfer") {
      throw new ApiRouteError({
        code: "validation_error",
        field: "topup_id",
        message: "Only bank-transfer top-ups can be confirmed manually.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    if (topup.status === "successful") {
      return topup;
    }

    if (topup.status !== "pending") {
      throw new ApiRouteError({
        code: "validation_error",
        field: "topup_id",
        message: "Only pending bank-transfer top-ups can be confirmed.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    if (input.amountMinor !== undefined && input.amountMinor !== topup.amount) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "amount",
        message: "The imported amount does not match the pending top-up.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    const ledger = new LedgerService(trx, {
      actorId: input.adminUserId,
      actorType: "admin"
    });

    await ledger.creditTopup({
      amount: topup.amount,
      currency: topup.currency,
      description: `Confirm bank transfer top-up ${topup.id}`,
      merchantId: topup.merchantId,
      mode: topup.mode,
      sourceAccountType: "suspense",
      topupId: topup.id
    });

    const updated = await trx
      .updateTable("topups")
      .set({
        completed_at: new Date(),
        confirmed_by: input.adminUserId,
        provider_ref: input.bankStatementReference ?? row.provider_ref,
        status: "successful"
      })
      .where("id", "=", topup.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return parseTopupRecord(updated);
  }

  async #loadMerchantContext(
    merchantId: string,
    mode: RpMode
  ): Promise<MerchantTopupContext> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const merchant = await trx
        .selectFrom("merchants")
        .select([
          "id",
          "mode",
          "settlement_currency",
          "status",
          "topup_transfer_reference"
        ])
        .where("id", "=", merchantId)
        .executeTakeFirst();

      if (!merchant) {
        throw notFoundError("Merchant not found");
      }

      return {
        id: merchant.id,
        mode: merchant.mode,
        settlementCurrency: parseCurrencyCode(merchant.settlement_currency),
        status: merchant.status,
        topupTransferReference: ensureTopupTransferReference(merchant.topup_transfer_reference)
      };
    });
  }

  #assertMerchantCanTopUp(merchant: MerchantTopupContext) {
    if (merchant.status !== "active") {
      throw new ApiRouteError({
        code: "merchant_suspended",
        message: getErrorDefinition("merchant_suspended").message,
        statusCode: getErrorDefinition("merchant_suspended").status
      });
    }
  }

  #assertSettlementCurrency(merchant: MerchantTopupContext, currency: CurrencyCode) {
    if (currency !== merchant.settlementCurrency) {
      throw new ApiRouteError({
        code: "unsupported_currency",
        field: "currency",
        message: `Top-ups must use the merchant settlement currency (${merchant.settlementCurrency}).`,
        statusCode: getErrorDefinition("unsupported_currency").status
      });
    }
  }

  async #loadTopupWithCollection(trx: ScopedTransaction, topupId: string) {
    return trx
      .selectFrom("topups as topup")
      .leftJoin("collections as collection", "collection.id", "topup.source_collection_id")
      .select([
        "topup.amount",
        "topup.bank_reference",
        "topup.completed_at",
        "topup.confirmed_by",
        "topup.created_at",
        "topup.currency",
        "topup.fee_minor",
        "topup.id",
        "topup.merchant_id",
        "topup.method",
        "topup.mode",
        "topup.provider_ref",
        "topup.source_collection_id",
        "topup.status",
        "collection.provider_session as collection_provider_session"
      ])
      .where("topup.id", "=", topupId)
      .executeTakeFirst();
  }

  #requireCollectionService() {
    if (!this.#collectionService) {
      throw new Error("Collection-backed top-ups require an encryption key.");
    }

    return this.#collectionService;
  }
}

function notFoundError(message: string) {
  return new ApiRouteError({
    code: "not_found",
    message,
    statusCode: getErrorDefinition("not_found").status
  });
}

function mapCollectionStatusToTopupStatus(status: string) {
  switch (status) {
    case "successful":
      return "successful" as const;
    case "failed":
      return "failed" as const;
    case "expired":
      return "expired" as const;
    default:
      return "pending" as const;
  }
}

function mapTopupWithCollection(row: {
  amount: string;
  bank_reference: string | null;
  collection_provider_session: unknown;
  completed_at: Date | null;
  confirmed_by: string | null;
  created_at: Date;
  currency: string;
  fee_minor: string;
  id: string;
  merchant_id: string;
  method: string;
  mode: RpMode;
  provider_ref: string | null;
  source_collection_id: string | null;
  status: "pending" | "successful" | "failed" | "expired";
}) {
  return parseTopupRecord(row, parseCollectionNextAction(row.collection_provider_session));
}

function parseCollectionNextAction(value: unknown): CollectionNextAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (raw.type === "redirect_url" && typeof raw.url === "string") {
    return {
      type: "redirect_url",
      url: raw.url
    };
  }

  if (raw.type === "hosted_fields" && typeof raw.iframe_url === "string") {
    return {
      iframeUrl: raw.iframe_url,
      type: "hosted_fields"
    };
  }

  return null;
}

async function getMerchantAvailableBalance(
  trx: ScopedTransaction,
  merchantId: string,
  mode: RpMode,
  currency: CurrencyCode
) {
  const row = await trx
    .selectFrom("ledger_accounts as ledger_account")
    .leftJoin("account_balances as account_balance", "account_balance.account_id", "ledger_account.id")
    .select("account_balance.balance as balance")
    .where("ledger_account.merchant_id", "=", merchantId)
    .where("ledger_account.mode", "=", mode)
    .where("ledger_account.currency", "=", currency)
    .where("ledger_account.type", "=", "merchant_available")
    .executeTakeFirst();

  return BigInt(String(row?.balance ?? "0"));
}

function ensureTopupTransferReference(value: string | null) {
  if (!value) {
    throw new Error("Merchant top-up transfer reference is missing.");
  }

  return value;
}
