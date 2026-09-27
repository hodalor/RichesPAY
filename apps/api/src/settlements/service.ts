import { getErrorDefinition, newId, type CurrencyCode } from "@richespay/shared";

import {
  runWithMerchantScope,
  runWithSystemScope,
  type AppDatabase
} from "../db";
import type { Json, JsonObject, RpMode, SettlementAccountType } from "../db/types";
import { ApiRouteError } from "../lib/api-error";
import { PayoutService } from "../payouts";

import type {
  SettlementAccountRecord,
  SettlementSettingsRecord,
  WithdrawalRecord
} from "./types";

const SETTLEMENT_ACCOUNT_COOL_OFF_MS = 24 * 60 * 60_000;

export class SettlementService {
  #database: AppDatabase;
  #payoutService: PayoutService;

  constructor(input: {
    database: AppDatabase;
    payoutService?: PayoutService;
  }) {
    this.#database = input.database;
    this.#payoutService =
      input.payoutService ??
      new PayoutService({
        database: input.database
      });
  }

  async listAccounts(
    merchantId: string,
    mode: RpMode
  ): Promise<SettlementAccountRecord[]> {
    const rows = await runWithMerchantScope(this.#database, merchantId, mode, async (trx) =>
      trx
        .selectFrom("settlement_accounts")
        .selectAll()
        .orderBy("is_default", "desc")
        .orderBy("created_at", "desc")
        .execute()
    );

    return rows.map(mapSettlementAccount);
  }

  async createAccount(input: {
    createdBy: string;
    details: Json;
    isDefault: boolean;
    merchantId: string;
    mode: RpMode;
    type: SettlementAccountType;
  }): Promise<SettlementAccountRecord> {
    assertSettlementDetails(input.type, input.details);

    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      if (input.isDefault) {
        await trx
          .updateTable("settlement_accounts")
          .set({ is_default: false, updated_by: input.createdBy })
          .where("is_default", "=", true)
          .execute();
      }

      const inserted = await trx
        .insertInto("settlement_accounts")
        .values({
          cool_off_until: new Date(Date.now() + SETTLEMENT_ACCOUNT_COOL_OFF_MS),
          created_by: input.createdBy,
          details: input.details,
          id: newId("sea_"),
          is_default: input.isDefault,
          merchant_id: input.merchantId,
          mode: input.mode,
          type: input.type,
          updated_by: input.createdBy,
          verified_at: null,
          verified_by: null
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      if (input.isDefault) {
        await trx
          .updateTable("merchant_settlement_settings")
          .set({
            settlement_account_id: inserted.id
          })
          .where("merchant_id", "=", input.merchantId)
          .where("mode", "=", input.mode)
          .execute();
      }

      return mapSettlementAccount(inserted);
    });
  }

  async updateAccount(input: {
    accountId: string;
    details: Json;
    isDefault: boolean;
    merchantId: string;
    mode: RpMode;
    type: SettlementAccountType;
    updatedBy: string;
  }): Promise<SettlementAccountRecord> {
    assertSettlementDetails(input.type, input.details);

    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      const existing = await trx
        .selectFrom("settlement_accounts")
        .selectAll()
        .where("id", "=", input.accountId)
        .forUpdate()
        .executeTakeFirst();

      if (!existing) {
        throw notFoundError("Settlement account not found");
      }

      if (input.isDefault) {
        await trx
          .updateTable("settlement_accounts")
          .set({ is_default: false, updated_by: input.updatedBy })
          .where("is_default", "=", true)
          .where("id", "!=", input.accountId)
          .execute();
      }

      const updated = await trx
        .updateTable("settlement_accounts")
        .set({
          cool_off_until: new Date(Date.now() + SETTLEMENT_ACCOUNT_COOL_OFF_MS),
          details: input.details,
          is_default: input.isDefault,
          type: input.type,
          updated_by: input.updatedBy,
          verified_at: null,
          verified_by: null
        })
        .where("id", "=", input.accountId)
        .returningAll()
        .executeTakeFirstOrThrow();

      if (input.isDefault) {
        await trx
          .updateTable("merchant_settlement_settings")
          .set({
            settlement_account_id: updated.id
          })
          .where("merchant_id", "=", input.merchantId)
          .where("mode", "=", input.mode)
          .execute();
      }

      return mapSettlementAccount(updated);
    });
  }

  async getSettings(
    merchantId: string,
    mode: RpMode
  ): Promise<SettlementSettingsRecord> {
    const row = await runWithMerchantScope(this.#database, merchantId, mode, async (trx) =>
      trx
        .selectFrom("merchant_settlement_settings")
        .selectAll()
        .where("merchant_id", "=", merchantId)
        .where("mode", "=", mode)
        .executeTakeFirst()
    );

    if (!row) {
      throw notFoundError("Settlement settings not found");
    }

    return mapSettlementSettings(row);
  }

  async updateSettings(input: {
    automaticDailySettlementEnabled: boolean;
    merchantId: string;
    mode: RpMode;
    settlementAccountId: string | null;
  }): Promise<SettlementSettingsRecord> {
    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      if (input.settlementAccountId) {
        const account = await trx
          .selectFrom("settlement_accounts")
          .select(["cool_off_until", "id", "verified_at", "verified_by"])
          .where("id", "=", input.settlementAccountId)
          .executeTakeFirst();

        if (!account) {
          throw notFoundError("Settlement account not found");
        }

        if (
          input.automaticDailySettlementEnabled &&
          (!account.verified_at ||
            !account.verified_by ||
            (account.cool_off_until !== null && account.cool_off_until > new Date()))
        ) {
          throw new ApiRouteError({
            code: "settlement_account_unverified",
            message:
              "Automatic daily settlement requires a verified settlement account outside the cool-off period.",
            statusCode: getErrorDefinition("settlement_account_unverified").status
          });
        }
      }

      const updated = await trx
        .updateTable("merchant_settlement_settings")
        .set({
          automatic_daily_settlement_enabled: input.automaticDailySettlementEnabled,
          settlement_account_id: input.settlementAccountId
        })
        .where("merchant_id", "=", input.merchantId)
        .where("mode", "=", input.mode)
        .returningAll()
        .executeTakeFirst();

      if (!updated) {
        throw notFoundError("Settlement settings not found");
      }

      return mapSettlementSettings(updated);
    });
  }

  async listWithdrawals(
    merchantId: string,
    mode: RpMode,
    limit: number
  ): Promise<WithdrawalRecord[]> {
    const rows = await runWithMerchantScope(this.#database, merchantId, mode, async (trx) =>
      trx
        .selectFrom("withdrawals as withdrawal")
        .innerJoin("payouts as payout", "payout.id", "withdrawal.payout_id")
        .select([
          "withdrawal.amount as amount",
          "withdrawal.auto_generated as auto_generated",
          "withdrawal.created_at as created_at",
          "withdrawal.created_by as created_by",
          "withdrawal.currency as currency",
          "withdrawal.id as id",
          "withdrawal.merchant_id as merchant_id",
          "withdrawal.mode as mode",
          "withdrawal.payout_id as payout_id",
          "withdrawal.settlement_account_id as settlement_account_id",
          "payout.status as status"
        ])
        .orderBy("withdrawal.created_at", "desc")
        .limit(limit)
        .execute()
    );

    return rows.map(mapWithdrawal);
  }

  async getWithdrawal(
    merchantId: string,
    mode: RpMode,
    withdrawalId: string
  ): Promise<WithdrawalRecord> {
    const row = await runWithMerchantScope(this.#database, merchantId, mode, async (trx) =>
      trx
        .selectFrom("withdrawals as withdrawal")
        .innerJoin("payouts as payout", "payout.id", "withdrawal.payout_id")
        .select([
          "withdrawal.amount as amount",
          "withdrawal.auto_generated as auto_generated",
          "withdrawal.created_at as created_at",
          "withdrawal.created_by as created_by",
          "withdrawal.currency as currency",
          "withdrawal.id as id",
          "withdrawal.merchant_id as merchant_id",
          "withdrawal.mode as mode",
          "withdrawal.payout_id as payout_id",
          "withdrawal.settlement_account_id as settlement_account_id",
          "payout.status as status"
        ])
        .where("withdrawal.id", "=", withdrawalId)
        .executeTakeFirst()
    );

    if (!row) {
      throw notFoundError("Withdrawal not found");
    }

    return mapWithdrawal(row);
  }

  async createWithdrawal(input: {
    amountMinor: bigint;
    createdBy: string;
    currency: CurrencyCode;
    merchantId: string;
    mode: RpMode;
    requestId: string;
    settlementAccountId: string;
  }): Promise<WithdrawalRecord> {
    const withdrawalId = newId("wdr_");
    await this.#payoutService.createWithdrawal({
      amountMinor: input.amountMinor,
      autoGenerated: false,
      createdBy: input.createdBy,
      currency: input.currency,
      merchantId: input.merchantId,
      mode: input.mode,
      requestId: input.requestId,
      settlementAccountId: input.settlementAccountId,
      withdrawalId
    });

    return this.getWithdrawal(input.merchantId, input.mode, withdrawalId);
  }

  async verifyAccount(input: {
    accountId: string;
    adminUserId: string;
  }): Promise<SettlementAccountRecord> {
    return runWithSystemScope(
      this.#database,
      "verify settlement account",
      async (trx) => {
        const updated = await trx
          .updateTable("settlement_accounts")
          .set({
            verified_at: new Date(),
            verified_by: input.adminUserId
          })
          .where("id", "=", input.accountId)
          .returningAll()
          .executeTakeFirst();

        if (!updated) {
          throw notFoundError("Settlement account not found");
        }

        return mapSettlementAccount(updated);
      },
      { audit: false }
    );
  }

  async runAutomaticDailySettlements(now = new Date(), limit = 25): Promise<number> {
    const candidates = await runWithSystemScope(
      this.#database,
      "load automatic daily settlement candidates",
      async (trx) =>
        trx
          .selectFrom("merchant_settlement_settings as settings")
          .innerJoin("merchants as merchant", (join) =>
            join
              .onRef("merchant.id", "=", "settings.merchant_id")
              .onRef("merchant.mode", "=", "settings.mode")
          )
          .select([
            "settings.last_auto_settlement_for_date as last_auto_settlement_for_date",
            "settings.merchant_id as merchant_id",
            "settings.mode as mode",
            "settings.settlement_account_id as settlement_account_id",
            "merchant.settlement_currency as settlement_currency",
            "merchant.timezone as timezone"
          ])
          .where("settings.automatic_daily_settlement_enabled", "=", true)
          .where("merchant.status", "=", "active")
          .where("merchant.payouts_frozen", "=", false)
          .limit(limit)
          .execute(),
      { audit: false }
    );

    let processed = 0;

    for (const candidate of candidates) {
      if (!candidate.settlement_account_id) {
        continue;
      }

      const targetLocalDate = previousLocalDate(candidate.timezone, now);
      if (
        candidate.last_auto_settlement_for_date &&
        candidate.last_auto_settlement_for_date.toISOString().slice(0, 10) >= targetLocalDate
      ) {
        continue;
      }

      const availableBalance = await runWithSystemScope(
        this.#database,
        "load merchant available balance for auto settlement",
        async (trx) => {
          const row = await trx
            .selectFrom("ledger_accounts as account")
            .leftJoin("account_balances as balance", "balance.account_id", "account.id")
            .select(["balance.balance as balance"])
            .where("account.merchant_id", "=", candidate.merchant_id)
            .where("account.mode", "=", candidate.mode)
            .where("account.currency", "=", candidate.settlement_currency)
            .where("account.type", "=", "merchant_available")
            .executeTakeFirst();

          return BigInt(String(row?.balance ?? "0"));
        },
        { audit: false }
      );

      if (availableBalance <= 0n) {
        continue;
      }

      const settlementAccount = await runWithSystemScope(
        this.#database,
        "load auto settlement account",
        async (trx) =>
          trx
            .selectFrom("settlement_accounts")
            .select(["details", "type"])
            .where("id", "=", candidate.settlement_account_id)
            .executeTakeFirst(),
        { audit: false }
      );

      if (!settlementAccount) {
        continue;
      }

      const withdrawalAmount = await this.#determineAutomaticSettlementAmount({
        accountDetails: settlementAccount.details,
        accountType: settlementAccount.type,
        availableBalance,
        currency: candidate.settlement_currency as CurrencyCode,
        merchantId: candidate.merchant_id,
        mode: candidate.mode
      });

      if (withdrawalAmount <= 0n) {
        continue;
      }

      await this.#payoutService.createWithdrawal({
        amountMinor: withdrawalAmount,
        autoGenerated: true,
        createdBy: "system_auto_settlement",
        currency: candidate.settlement_currency as CurrencyCode,
        merchantId: candidate.merchant_id,
        mode: candidate.mode,
        requestId: `auto-settlement-${candidate.merchant_id}-${targetLocalDate}`,
        settlementAccountId: candidate.settlement_account_id,
        withdrawalId: newId("wdr_")
      });

      await runWithSystemScope(
        this.#database,
        "mark automatic daily settlement processed",
        async (trx) => {
          await trx
            .updateTable("merchant_settlement_settings")
            .set({
              last_auto_settlement_for_date: new Date(`${targetLocalDate}T00:00:00.000Z`)
            })
            .where("merchant_id", "=", candidate.merchant_id)
            .where("mode", "=", candidate.mode)
            .execute();
        },
        { audit: false }
      );

      processed += 1;
    }

    return processed;
  }

  async #determineAutomaticSettlementAmount(input: {
    accountDetails: Json;
    accountType: SettlementAccountType;
    availableBalance: bigint;
    currency: CurrencyCode;
    merchantId: string;
    mode: RpMode;
  }) {
    let candidateAmount = input.availableBalance;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const quote = await this.#payoutService.quotePayoutHold({
        accountName: extractSettlementAccountName(input.accountDetails),
        accountNumber:
          input.accountType === "bank"
            ? extractBankAccountNumber(input.accountDetails)
            : null,
        amountMinor: candidateAmount,
        bankCode:
          input.accountType === "bank"
            ? extractBankCode(input.accountDetails)
            : null,
        createdBy: "system_auto_settlement",
        currency: input.currency,
        idempotencyKey: null,
        merchantId: input.merchantId,
        metadata: {},
        method: input.accountType === "bank" ? "bank" : "mobile_money",
        mode: input.mode,
        narration: "Automatic daily settlement",
        network:
          input.accountType === "mobile_money"
            ? extractSettlementNetwork(input.accountDetails)
            : null,
        phone:
          input.accountType === "mobile_money"
            ? extractSettlementPhone(input.accountDetails)
            : null,
        reference: null,
        requestId: `auto-settlement-quote-${input.merchantId}`
      });

      if (quote.totalHoldMinor <= input.availableBalance) {
        return candidateAmount;
      }

      candidateAmount = input.availableBalance - quote.feeMinor;
      if (candidateAmount <= 0n) {
        return 0n;
      }
    }

    return 0n;
  }
}

function assertSettlementDetails(type: SettlementAccountType, details: Json) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    throw validationError("details", "Settlement account details must be an object.");
  }

  const raw = details as JsonObject;

  if (type === "bank") {
    requireStringField(raw, "bank_code");
    requireStringField(raw, "account_number");
    requireOptionalStringField(raw, "account_name");
    return;
  }

  requireStringField(raw, "phone");
  requireStringField(raw, "network");
  requireOptionalStringField(raw, "account_name");
}

function requireStringField(value: JsonObject, field: string) {
  const raw = value[field];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw validationError(`details.${field}`, `Settlement account ${field} is required.`);
  }
}

function requireOptionalStringField(value: JsonObject, field: string) {
  const raw = value[field];
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    throw validationError(`details.${field}`, `Settlement account ${field} must be a string.`);
  }
}

function extractBankCode(value: Json) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as JsonObject).bank_code;
    if (typeof raw === "string" && raw.trim() !== "") {
      return raw;
    }
  }

  throw validationError(
    "details.bank_code",
    "Settlement account bank_code is required."
  );
}

function extractBankAccountNumber(value: Json) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as JsonObject).account_number;
    if (typeof raw === "string" && raw.trim() !== "") {
      return raw;
    }
  }

  throw validationError(
    "details.account_number",
    "Settlement account account_number is required."
  );
}

function extractSettlementPhone(value: Json) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as JsonObject).phone;
    if (typeof raw === "string" && raw.trim() !== "") {
      return raw;
    }
  }

  throw validationError("details.phone", "Settlement account phone is required.");
}

function extractSettlementNetwork(value: Json) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as JsonObject).network;
    if (typeof raw === "string" && raw.trim() !== "") {
      return raw;
    }
  }

  throw validationError("details.network", "Settlement account network is required.");
}

function extractSettlementAccountName(value: Json) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as JsonObject).account_name;
    return typeof raw === "string" && raw.trim() !== "" ? raw : null;
  }

  return null;
}

function validationError(field: string, message: string) {
  return new ApiRouteError({
    code: "validation_error",
    field,
    message,
    statusCode: getErrorDefinition("validation_error").status
  });
}

function mapSettlementAccount(row: {
  cool_off_until: Date | null;
  created_at: Date;
  created_by: string;
  details: Json;
  id: string;
  is_default: boolean;
  merchant_id: string;
  mode: RpMode;
  type: SettlementAccountType;
  updated_at: Date;
  updated_by: string;
  verified_at: Date | null;
  verified_by: string | null;
}): SettlementAccountRecord {
  return {
    coolOffUntil: row.cool_off_until,
    createdAt: row.created_at,
    createdBy: row.created_by,
    details: row.details,
    id: row.id,
    isDefault: row.is_default,
    merchantId: row.merchant_id,
    mode: row.mode,
    type: row.type,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by
  };
}

function mapSettlementSettings(row: {
  automatic_daily_settlement_enabled: boolean;
  created_at: Date;
  last_auto_settlement_for_date: Date | null;
  merchant_id: string;
  mode: RpMode;
  settlement_account_id: string | null;
  updated_at: Date;
}): SettlementSettingsRecord {
  return {
    automaticDailySettlementEnabled: row.automatic_daily_settlement_enabled,
    createdAt: row.created_at,
    lastAutoSettlementForDate: row.last_auto_settlement_for_date?.toISOString().slice(0, 10) ?? null,
    merchantId: row.merchant_id,
    mode: row.mode,
    settlementAccountId: row.settlement_account_id,
    updatedAt: row.updated_at
  };
}

function mapWithdrawal(row: {
  amount: string;
  auto_generated: boolean;
  created_at: Date;
  created_by: string;
  currency: string;
  id: string;
  merchant_id: string;
  mode: RpMode;
  payout_id: string;
  settlement_account_id: string;
  status: WithdrawalRecord["status"];
}): WithdrawalRecord {
  return {
    amount: BigInt(row.amount),
    autoGenerated: row.auto_generated,
    createdAt: row.created_at,
    createdBy: row.created_by,
    currency: row.currency as CurrencyCode,
    id: row.id,
    merchantId: row.merchant_id,
    mode: row.mode,
    payoutId: row.payout_id,
    settlementAccountId: row.settlement_account_id,
    status: row.status
  };
}

function previousLocalDate(timezone: string, now: Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric"
  });
  const parts = formatter.formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "1970");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "01");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "01");
  const localMidnightUtc = new Date(Date.UTC(year, month - 1, day));
  localMidnightUtc.setUTCDate(localMidnightUtc.getUTCDate() - 1);
  return localMidnightUtc.toISOString().slice(0, 10);
}

function notFoundError(message: string) {
  return new ApiRouteError({
    code: "not_found",
    message,
    statusCode: getErrorDefinition("not_found").status
  });
}
