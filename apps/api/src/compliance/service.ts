import { getErrorDefinition, newId, type CurrencyCode } from "@richespay/shared";

import { runWithMerchantScope, runWithSystemScope, type AppDatabase, type ScopedTransaction } from "../db";
import type { Json, JsonObject, RpMode } from "../db/types";
import { LedgerService } from "../ledger";
import { ApiRouteError } from "../lib/api-error";
import { parseCurrencyCode } from "../pricing/types";
import { ProviderCatalog } from "../providers/catalog";
import type { ScreeningProvider } from "../providers/types";

import type {
  ComplianceOperationKind,
  ComplianceReasonCategory,
  ComplianceReviewFlagRecord,
  KybTier,
  MerchantComplianceSummary
} from "./types";

interface MerchantComplianceRow {
  collections_freeze_reason: string | null;
  collections_frozen: boolean;
  contact_link: string | null;
  id: string;
  kyb_tier: KybTier | null;
  mode: RpMode;
  payouts_freeze_reason: string | null;
  payouts_frozen: boolean;
  settlement_currency: string;
  status: string;
  collections_freeze_category: ComplianceReasonCategory | null;
  payouts_freeze_category: ComplianceReasonCategory | null;
  suspension_category: ComplianceReasonCategory | null;
  suspension_reason: string | null;
  collections_min_minor: string | number | bigint | null;
  collections_max_minor: string | number | bigint | null;
  collections_daily_volume_minor: string | number | bigint | null;
  collections_monthly_volume_minor: string | number | bigint | null;
  payouts_min_minor: string | number | bigint | null;
  payouts_max_minor: string | number | bigint | null;
  payouts_daily_volume_minor: string | number | bigint | null;
  payouts_monthly_volume_minor: string | number | bigint | null;
  rolling_reserve_bps: number | null;
  rolling_reserve_days: number | null;
  screening_payout_threshold_minor: string | number | bigint | null;
  velocity_collections_per_phone: number | null;
  velocity_window_minutes: number | null;
}

export class ComplianceService {
  #database: AppDatabase;
  #screeningProvider: ScreeningProvider;

  constructor(input: {
    database: AppDatabase;
    screeningProvider?: ScreeningProvider;
  }) {
    this.#database = input.database;
    this.#screeningProvider =
      input.screeningProvider ??
      new ProviderCatalog().resolveScreeningProvider();
  }

  async getMerchantSummary(
    merchantId: string,
    mode: RpMode
  ): Promise<MerchantComplianceSummary> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) =>
      this.#loadMerchantSummaryInScope(trx, merchantId, mode)
    );
  }

  async getMerchantSummaryInScope(
    trx: ScopedTransaction,
    merchantId: string,
    mode: RpMode
  ): Promise<MerchantComplianceSummary> {
    return this.#loadMerchantSummaryInScope(trx, merchantId, mode);
  }

  async listReviewFlags(input: {
    limit: number;
    merchantId?: string;
    mode?: RpMode;
    status?: "dismissed" | "open" | "resolved";
  }): Promise<ComplianceReviewFlagRecord[]> {
    return runWithSystemScope(
      this.#database,
      "list compliance review flags",
      async (trx) => {
        const rows = await trx
          .selectFrom("compliance_review_flags")
          .selectAll()
          .$if(Boolean(input.merchantId), (query) =>
            query.where("merchant_id", "=", input.merchantId!)
          )
          .$if(Boolean(input.mode), (query) =>
            query.where("mode", "=", input.mode!)
          )
          .$if(Boolean(input.status), (query) =>
            query.where("status", "=", input.status!)
          )
          .orderBy("created_at", "desc")
          .limit(input.limit)
          .execute();

        return rows.map(mapReviewFlag);
      },
      { audit: false }
    );
  }

  async updateComplianceProfile(
    trx: ScopedTransaction,
    input: {
      collectionsDailyVolumeMinor?: bigint | null;
      collectionsMaxMinor?: bigint;
      collectionsMinMinor?: bigint;
      collectionsMonthlyVolumeMinor?: bigint | null;
      contactLink?: string;
      kybTier?: KybTier;
      merchantId: string;
      mode: RpMode;
      payoutsDailyVolumeMinor?: bigint | null;
      payoutsMaxMinor?: bigint;
      payoutsMinMinor?: bigint;
      payoutsMonthlyVolumeMinor?: bigint | null;
      rollingReserveBps?: number;
      rollingReserveDays?: number;
      screeningPayoutThresholdMinor?: bigint | null;
      velocityCollectionsPerPhone?: number;
      velocityWindowMinutes?: number;
    }
  ): Promise<MerchantComplianceSummary> {
    await this.#ensureProfileRow(trx, input.merchantId, input.mode);

    await trx
      .updateTable("merchant_compliance_profiles")
      .set({
        ...(input.collectionsDailyVolumeMinor !== undefined
          ? { collections_daily_volume_minor: bigintOrNull(input.collectionsDailyVolumeMinor) }
          : {}),
        ...(input.collectionsMaxMinor !== undefined
          ? { collections_max_minor: input.collectionsMaxMinor.toString() }
          : {}),
        ...(input.collectionsMinMinor !== undefined
          ? { collections_min_minor: input.collectionsMinMinor.toString() }
          : {}),
        ...(input.collectionsMonthlyVolumeMinor !== undefined
          ? { collections_monthly_volume_minor: bigintOrNull(input.collectionsMonthlyVolumeMinor) }
          : {}),
        ...(input.contactLink !== undefined
          ? { contact_link: input.contactLink.trim() }
          : {}),
        ...(input.kybTier !== undefined ? { kyb_tier: input.kybTier } : {}),
        ...(input.payoutsDailyVolumeMinor !== undefined
          ? { payouts_daily_volume_minor: bigintOrNull(input.payoutsDailyVolumeMinor) }
          : {}),
        ...(input.payoutsMaxMinor !== undefined
          ? { payouts_max_minor: input.payoutsMaxMinor.toString() }
          : {}),
        ...(input.payoutsMinMinor !== undefined
          ? { payouts_min_minor: input.payoutsMinMinor.toString() }
          : {}),
        ...(input.payoutsMonthlyVolumeMinor !== undefined
          ? { payouts_monthly_volume_minor: bigintOrNull(input.payoutsMonthlyVolumeMinor) }
          : {}),
        ...(input.rollingReserveBps !== undefined
          ? { rolling_reserve_bps: input.rollingReserveBps }
          : {}),
        ...(input.rollingReserveDays !== undefined
          ? { rolling_reserve_days: input.rollingReserveDays }
          : {}),
        ...(input.screeningPayoutThresholdMinor !== undefined
          ? {
              screening_payout_threshold_minor: bigintOrNull(
                input.screeningPayoutThresholdMinor
              )
            }
          : {}),
        ...(input.velocityCollectionsPerPhone !== undefined
          ? { velocity_collections_per_phone: input.velocityCollectionsPerPhone }
          : {}),
        ...(input.velocityWindowMinutes !== undefined
          ? { velocity_window_minutes: input.velocityWindowMinutes }
          : {})
      })
      .where("merchant_id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .execute();

    return this.#loadMerchantSummaryInScope(trx, input.merchantId, input.mode);
  }

  async freezeCollections(
    trx: ScopedTransaction,
    input: {
      actorId: string;
      category: ComplianceReasonCategory;
      merchantId: string;
      mode: RpMode;
      reason: string;
    }
  ): Promise<MerchantComplianceSummary> {
    await this.#ensureProfileRow(trx, input.merchantId, input.mode);

    await trx
      .updateTable("merchants")
      .set({
        collections_freeze_reason: input.reason,
        collections_frozen: true
      })
      .where("id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("merchant_compliance_profiles")
      .set({
        collections_freeze_category: input.category
      })
      .where("merchant_id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .execute();

    await this.#writeFreezeHistory(trx, {
      action: "freeze",
      actorId: input.actorId,
      freezeType: "collections",
      merchantId: input.merchantId,
      mode: input.mode,
      reason: input.reason
    });

    await this.#writeMerchantEvent(trx, {
      merchantId: input.merchantId,
      mode: input.mode,
      payload: {
        category: input.category,
        merchant_id: input.merchantId,
        reason: input.reason
      },
      type: "merchant.collections_frozen"
    });

    return this.#loadMerchantSummaryInScope(trx, input.merchantId, input.mode);
  }

  async unfreezeCollections(
    trx: ScopedTransaction,
    input: {
      actorId: string;
      merchantId: string;
      mode: RpMode;
      reason: string;
    }
  ): Promise<MerchantComplianceSummary> {
    await this.#ensureProfileRow(trx, input.merchantId, input.mode);

    await trx
      .updateTable("merchants")
      .set({
        collections_freeze_reason: null,
        collections_frozen: false
      })
      .where("id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("merchant_compliance_profiles")
      .set({
        collections_freeze_category: null
      })
      .where("merchant_id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .execute();

    await this.#writeFreezeHistory(trx, {
      action: "unfreeze",
      actorId: input.actorId,
      freezeType: "collections",
      merchantId: input.merchantId,
      mode: input.mode,
      reason: input.reason
    });

    await this.#writeMerchantEvent(trx, {
      merchantId: input.merchantId,
      mode: input.mode,
      payload: {
        merchant_id: input.merchantId,
        reason: input.reason
      },
      type: "merchant.collections_unfrozen"
    });

    return this.#loadMerchantSummaryInScope(trx, input.merchantId, input.mode);
  }

  async freezePayouts(
    trx: ScopedTransaction,
    input: {
      actorId: string;
      category: ComplianceReasonCategory;
      merchantId: string;
      mode: RpMode;
      reason: string;
    }
  ): Promise<MerchantComplianceSummary> {
    await this.#ensureProfileRow(trx, input.merchantId, input.mode);

    await trx
      .updateTable("merchants")
      .set({
        payouts_freeze_reason: input.reason,
        payouts_frozen: true
      })
      .where("id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("merchant_compliance_profiles")
      .set({
        payouts_freeze_category: input.category
      })
      .where("merchant_id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .execute();

    await this.#moveQueuedPayoutsToOnHold(trx, input.merchantId, input.mode, input.reason);
    await this.#writeFreezeHistory(trx, {
      action: "freeze",
      actorId: input.actorId,
      freezeType: "payouts",
      merchantId: input.merchantId,
      mode: input.mode,
      reason: input.reason
    });
    await this.#writeMerchantEvent(trx, {
      merchantId: input.merchantId,
      mode: input.mode,
      payload: {
        category: input.category,
        merchant_id: input.merchantId,
        reason: input.reason
      },
      type: "merchant.payouts_frozen"
    });

    return this.#loadMerchantSummaryInScope(trx, input.merchantId, input.mode);
  }

  async unfreezePayouts(
    trx: ScopedTransaction,
    input: {
      actorId: string;
      merchantId: string;
      mode: RpMode;
      reason: string;
    }
  ): Promise<MerchantComplianceSummary> {
    await this.#ensureProfileRow(trx, input.merchantId, input.mode);

    await trx
      .updateTable("merchants")
      .set({
        payouts_freeze_reason: null,
        payouts_frozen: false
      })
      .where("id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("merchant_compliance_profiles")
      .set({
        payouts_freeze_category: null
      })
      .where("merchant_id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .execute();

    await this.#resumeHeldPayoutsIfAllowed(trx, input.merchantId, input.mode, input.reason);
    await this.#writeFreezeHistory(trx, {
      action: "unfreeze",
      actorId: input.actorId,
      freezeType: "payouts",
      merchantId: input.merchantId,
      mode: input.mode,
      reason: input.reason
    });
    await this.#writeMerchantEvent(trx, {
      merchantId: input.merchantId,
      mode: input.mode,
      payload: {
        merchant_id: input.merchantId,
        reason: input.reason
      },
      type: "merchant.payouts_unfrozen"
    });

    return this.#loadMerchantSummaryInScope(trx, input.merchantId, input.mode);
  }

  async suspendMerchant(
    trx: ScopedTransaction,
    input: {
      actorId: string;
      category: ComplianceReasonCategory;
      merchantId: string;
      mode: RpMode;
      reason: string;
    }
  ): Promise<MerchantComplianceSummary> {
    await this.#ensureProfileRow(trx, input.merchantId, input.mode);

    await trx
      .updateTable("merchants")
      .set({
        status: "suspended"
      })
      .where("id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("merchant_compliance_profiles")
      .set({
        suspension_category: input.category,
        suspension_reason: input.reason
      })
      .where("merchant_id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .execute();

    await this.#moveQueuedPayoutsToOnHold(trx, input.merchantId, input.mode, "merchant_suspended");
    await this.#writeMerchantEvent(trx, {
      merchantId: input.merchantId,
      mode: input.mode,
      payload: {
        category: input.category,
        merchant_id: input.merchantId,
        reason: input.reason
      },
      type: "merchant.suspended"
    });

    return this.#loadMerchantSummaryInScope(trx, input.merchantId, input.mode);
  }

  async reactivateMerchant(
    trx: ScopedTransaction,
    input: {
      merchantId: string;
      mode: RpMode;
      reason: string;
    }
  ): Promise<MerchantComplianceSummary> {
    await this.#ensureProfileRow(trx, input.merchantId, input.mode);

    await trx
      .updateTable("merchants")
      .set({
        status: "active"
      })
      .where("id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("merchant_compliance_profiles")
      .set({
        suspension_category: null,
        suspension_reason: null
      })
      .where("merchant_id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .execute();

    await this.#resumeHeldPayoutsIfAllowed(trx, input.merchantId, input.mode, input.reason);
    await this.#writeMerchantEvent(trx, {
      merchantId: input.merchantId,
      mode: input.mode,
      payload: {
        merchant_id: input.merchantId,
        reason: input.reason
      },
      type: "merchant.reactivated"
    });

    return this.#loadMerchantSummaryInScope(trx, input.merchantId, input.mode);
  }

  async enforceOperationLimits(
    trx: ScopedTransaction,
    input: {
      amountMinor: bigint;
      kind: ComplianceOperationKind;
      merchantId: string;
      mode: RpMode;
    }
  ) {
    const summary = await this.#loadMerchantSummaryInScope(trx, input.merchantId, input.mode);
    const limits = input.kind === "collection" ? summary.limits.collection : summary.limits.payout;

    if (input.amountMinor < limits.minMinor) {
      throw new ApiRouteError({
        code: "amount_too_small",
        field: "amount",
        message: `The amount is below the allowed ${input.kind} minimum for this merchant.`,
        statusCode: getErrorDefinition("amount_too_small").status
      });
    }

    if (input.amountMinor > limits.maxMinor) {
      throw new ApiRouteError({
        code: "amount_too_large",
        field: "amount",
        message: `The amount is above the allowed ${input.kind} maximum for this merchant.`,
        statusCode: getErrorDefinition("amount_too_large").status
      });
    }

    await this.#enforceVolumeLimit(trx, input, limits.dailyVolumeMinor, "daily");
    await this.#enforceVolumeLimit(trx, input, limits.monthlyVolumeMinor, "monthly");
  }

  async maybeFlagCollectionVelocity(
    trx: ScopedTransaction,
    input: {
      collectionId: string;
      merchantId: string;
      mode: RpMode;
      phone: string | null;
    }
  ) {
    if (!input.phone) {
      return;
    }

    const summary = await this.#loadMerchantSummaryInScope(trx, input.merchantId, input.mode);
    const windowStart = new Date(Date.now() - summary.velocityWindowMinutes * 60_000);

    const aggregate = await trx
      .selectFrom("collections")
      .select((eb) => eb.fn.count<string>("id").as("count"))
      .where("reference_type", "=", "collection")
      .where("phone", "=", input.phone)
      .where("created_at", ">=", windowStart)
      .executeTakeFirst();

    const count = Number(aggregate?.count ?? "0");
    if (count <= summary.velocityCollectionsPerPhone) {
      return;
    }

    await this.#insertReviewFlag(trx, {
      merchantId: input.merchantId,
      mode: input.mode,
      payload: {
        count,
        phone_masked: maskPhone(input.phone),
        window_minutes: summary.velocityWindowMinutes
      },
      resourceId: input.collectionId,
      resourceType: "collection",
      ruleCode: "collections.phone_velocity",
      summary: `Collection velocity threshold exceeded for ${maskPhone(input.phone)}`
    });
  }

  async screenMerchantOnboarding(input: {
    countryCode: string;
    merchantId: string;
    merchantName: string;
    mode: RpMode;
  }) {
    const result = await this.#screeningProvider.screen({
      merchantId: input.merchantId,
      mode: input.mode,
      referenceId: input.merchantId,
      subject: {
        country_code: input.countryCode,
        merchant_name: input.merchantName
      },
      subjectType: "merchant_onboarding"
    });

    if (result.outcome === "clear") {
      return;
    }

    await runWithSystemScope(
      this.#database,
      "flag onboarding screening review",
      async (trx) => {
        await this.#insertReviewFlag(trx, {
          merchantId: input.merchantId,
          mode: input.mode,
          payload: {
            provider: result.providerCode,
            screening: result.rawRedacted
          },
          resourceId: input.merchantId,
          resourceType: "merchant",
          ruleCode: "screening.onboarding",
          summary:
            result.matchReason ??
            "Merchant onboarding requires compliance review."
        });
      },
      { audit: false }
    );
  }

  async screenPayoutIfRequired(
    trx: ScopedTransaction,
    input: {
      amountMinor: bigint;
      merchantId: string;
      mode: RpMode;
      payoutReference: string;
      subject: Json;
    }
  ) {
    const summary = await this.#loadMerchantSummaryInScope(trx, input.merchantId, input.mode);
    const threshold = summary.screeningPayoutThresholdMinor;
    if (threshold === null || input.amountMinor < threshold) {
      return;
    }

    const result = await this.#screeningProvider.screen({
      merchantId: input.merchantId,
      mode: input.mode,
      referenceId: input.payoutReference,
      subject: input.subject,
      subjectType: "payout_beneficiary"
    });

    if (result.outcome === "clear") {
      return;
    }

    await this.#insertReviewFlag(trx, {
      merchantId: input.merchantId,
      mode: input.mode,
      payload: {
        provider: result.providerCode,
        screening: result.rawRedacted
      },
      resourceId: input.payoutReference,
      resourceType: "payout",
      ruleCode: "screening.payout_threshold",
      summary:
        result.matchReason ??
        "Payout screening returned a review-required result."
    });

    if (result.outcome === "blocked") {
      throw new ApiRouteError({
        code: "forbidden",
        message: "This payout was blocked by screening controls.",
        statusCode: 403
      });
    }
  }

  calculateRollingReserve(summary: MerchantComplianceSummary, netAmount: bigint) {
    if (netAmount <= 0n || summary.rollingReserveBps <= 0 || summary.rollingReserveDays <= 0) {
      return 0n;
    }

    return (netAmount * BigInt(summary.rollingReserveBps)) / 10_000n;
  }

  async recordRollingReserveHold(
    trx: ScopedTransaction,
    input: {
      amountMinor: bigint;
      collectionId: string;
      currency: CurrencyCode;
      merchantId: string;
      mode: RpMode;
      reserveDays: number;
    }
  ) {
    if (input.amountMinor <= 0n || input.reserveDays <= 0) {
      return;
    }

    await trx
      .insertInto("merchant_rolling_reserve_holds")
      .values({
        amount: input.amountMinor.toString(),
        collection_id: input.collectionId,
        created_at: new Date(),
        currency: input.currency,
        id: newId("rrh_"),
        merchant_id: input.merchantId,
        mode: input.mode,
        release_at: new Date(Date.now() + input.reserveDays * 24 * 60 * 60 * 1000),
        released_at: null
      })
      .execute();
  }

  async releaseDueRollingReserveHolds(limit = 50) {
    const due = await runWithSystemScope(
      this.#database,
      "list due rolling reserve holds",
      async (trx) =>
        trx
          .selectFrom("merchant_rolling_reserve_holds")
          .selectAll()
          .where("released_at", "is", null)
          .where("release_at", "<=", new Date())
          .orderBy("release_at", "asc")
          .limit(limit)
          .execute(),
      { audit: false }
    );

    for (const hold of due) {
      await runWithSystemScope(
        this.#database,
        "release rolling reserve hold",
        async (trx) => {
          const latest = await trx
            .selectFrom("merchant_rolling_reserve_holds")
            .selectAll()
            .where("id", "=", hold.id)
            .forUpdate()
            .executeTakeFirstOrThrow();

          if (latest.released_at) {
            return;
          }

          const ledger = new LedgerService(trx, {
            actorId: "richespay_system",
            actorType: "system"
          });

          await ledger.manualAdjustment({
            amount: BigInt(latest.amount),
            creditAccount: {
              merchantId: latest.merchant_id,
              type: "merchant_available"
            },
            currency: parseCurrencyCode(latest.currency),
            debitAccount: {
              merchantId: latest.merchant_id,
              type: "merchant_reserve"
            },
            description: `Release rolling reserve ${latest.id}`,
            mode: latest.mode,
            reason: "rolling reserve matured",
            referenceId: latest.id
          });

          await trx
            .updateTable("merchant_rolling_reserve_holds")
            .set({
              released_at: new Date()
            })
            .where("id", "=", latest.id)
            .execute();
        },
        { audit: false }
      );
    }
  }

  async #enforceVolumeLimit(
    trx: ScopedTransaction,
    input: {
      amountMinor: bigint;
      kind: ComplianceOperationKind;
      merchantId: string;
      mode: RpMode;
    },
    threshold: bigint | null,
    window: "daily" | "monthly"
  ) {
    if (threshold === null) {
      return;
    }

    const periodStart =
      window === "daily" ? startOfUtcDay(new Date()) : startOfUtcMonth(new Date());
    const consumed = await this.#loadConsumedVolume(
      trx,
      input.kind,
      periodStart
    );

    if (consumed + input.amountMinor > threshold) {
      throw new ApiRouteError({
        code: "amount_too_large",
        field: "amount",
        message: `This ${input.kind} would exceed the merchant ${window} volume limit.`,
        statusCode: getErrorDefinition("amount_too_large").status
      });
    }
  }

  async #loadConsumedVolume(
    trx: ScopedTransaction,
    kind: ComplianceOperationKind,
    periodStart: Date
  ) {
    if (kind === "collection") {
      const row = await trx
        .selectFrom("collections")
        .select((eb) => eb.fn.sum<string>("amount").as("total"))
        .where("reference_type", "=", "collection")
        .where("created_at", ">=", periodStart)
        .where("status", "in", ["pending", "processing", "successful", "reversed"])
        .executeTakeFirst();

      return BigInt(String(row?.total ?? "0"));
    }

    const row = await trx
      .selectFrom("payouts")
      .select((eb) => eb.fn.sum<string>("amount").as("total"))
      .where("created_at", ">=", periodStart)
      .where("status", "in", [
        "pending_approval",
        "queued",
        "on_hold",
        "processing",
        "successful",
        "reversed"
      ])
      .executeTakeFirst();

    return BigInt(String(row?.total ?? "0"));
  }

  async #ensureProfileRow(trx: ScopedTransaction, merchantId: string, mode: RpMode) {
    await trx
      .insertInto("merchant_compliance_profiles")
      .values({
        contact_link: "mailto:compliance@richespay.local",
        merchant_id: merchantId,
        mode
      })
      .onConflict((conflict) => conflict.columns(["merchant_id", "mode"]).doNothing())
      .execute();
  }

  async #loadMerchantSummaryInScope(
    trx: ScopedTransaction,
    merchantId: string,
    mode: RpMode
  ): Promise<MerchantComplianceSummary> {
    const row = await trx
      .selectFrom("merchants as merchant")
      .leftJoin("merchant_compliance_profiles as profile", (join) =>
        join
          .onRef("profile.merchant_id", "=", "merchant.id")
          .onRef("profile.mode", "=", "merchant.mode")
      )
      .select([
        "merchant.collections_freeze_reason",
        "merchant.collections_frozen",
        "merchant.id",
        "merchant.mode",
        "merchant.payouts_freeze_reason",
        "merchant.payouts_frozen",
        "merchant.settlement_currency",
        "merchant.status",
        "profile.collections_daily_volume_minor",
        "profile.collections_freeze_category",
        "profile.collections_max_minor",
        "profile.collections_min_minor",
        "profile.collections_monthly_volume_minor",
        "profile.contact_link",
        "profile.kyb_tier",
        "profile.payouts_daily_volume_minor",
        "profile.payouts_freeze_category",
        "profile.payouts_max_minor",
        "profile.payouts_min_minor",
        "profile.payouts_monthly_volume_minor",
        "profile.rolling_reserve_bps",
        "profile.rolling_reserve_days",
        "profile.screening_payout_threshold_minor",
        "profile.suspension_category",
        "profile.suspension_reason",
        "profile.velocity_collections_per_phone",
        "profile.velocity_window_minutes"
      ])
      .where("merchant.id", "=", merchantId)
      .where("merchant.mode", "=", mode)
      .executeTakeFirst();

    if (!row) {
      throw new ApiRouteError({
        code: "not_found",
        message: getErrorDefinition("not_found").message,
        statusCode: getErrorDefinition("not_found").status
      });
    }

    return mapMerchantSummary(row as MerchantComplianceRow);
  }

  async #writeFreezeHistory(
    trx: ScopedTransaction,
    input: {
      action: "freeze" | "unfreeze";
      actorId: string;
      freezeType: "collections" | "payouts";
      merchantId: string;
      mode: RpMode;
      reason: string;
    }
  ) {
    await trx
      .insertInto("merchant_freeze_history")
      .values({
        action: input.action,
        actor_id: input.actorId,
        created_at: new Date(),
        freeze_type: input.freezeType,
        id: newId("mfh_"),
        merchant_id: input.merchantId,
        mode: input.mode,
        reason: input.reason
      })
      .execute();
  }

  async #writeMerchantEvent(
    trx: ScopedTransaction,
    input: {
      merchantId: string;
      mode: RpMode;
      payload: JsonObject;
      type: string;
    }
  ) {
    await trx
      .insertInto("events_outbox")
      .values({
        created_at: new Date(),
        id: newId("evt_"),
        merchant_id: input.merchantId,
        mode: input.mode,
        payload: input.payload,
        type: input.type
      })
      .execute();
  }

  async #insertReviewFlag(
    trx: ScopedTransaction,
    input: {
      merchantId: string;
      mode: RpMode;
      payload: Json;
      resourceId: string;
      resourceType: string;
      ruleCode: string;
      summary: string;
    }
  ) {
    await trx
      .insertInto("compliance_review_flags")
      .values({
        created_at: new Date(),
        id: newId("crf_"),
        merchant_id: input.merchantId,
        mode: input.mode,
        payload: input.payload,
        resource_id: input.resourceId,
        resource_type: input.resourceType,
        rule_code: input.ruleCode,
        status: "open",
        summary: input.summary
      })
      .execute();
  }

  async #moveQueuedPayoutsToOnHold(
    trx: ScopedTransaction,
    merchantId: string,
    mode: RpMode,
    reason: string
  ) {
    const payouts = await trx
      .selectFrom("payouts")
      .select(["batch_id", "id", "status"])
      .where("merchant_id", "=", merchantId)
      .where("mode", "=", mode)
      .where("status", "=", "queued")
      .execute();

    if (payouts.length === 0) {
      return;
    }

    const now = new Date();

    await trx
      .updateTable("payouts")
      .set({
        status: "on_hold"
      })
      .where("merchant_id", "=", merchantId)
      .where("mode", "=", mode)
      .where("status", "=", "queued")
      .execute();

    await trx
      .insertInto("transaction_events")
      .values(
        payouts.map((payout) => ({
          created_at: now,
          from_status: payout.status,
          id: newId("evt_"),
          merchant_id: merchantId,
          mode,
          provider_payload: null,
          provider_reference: null,
          reason,
          resource_id: payout.id,
          resource_type: "payout",
          to_status: "on_hold"
        }))
      )
      .execute();

    await this.#refreshBatchStatuses(
      trx,
      uniqueBatchIds(payouts.map((payout) => payout.batch_id))
    );
  }

  async #resumeHeldPayoutsIfAllowed(
    trx: ScopedTransaction,
    merchantId: string,
    mode: RpMode,
    reason: string
  ) {
    const merchant = await trx
      .selectFrom("merchants")
      .select(["payouts_frozen", "status"])
      .where("id", "=", merchantId)
      .where("mode", "=", mode)
      .executeTakeFirstOrThrow();

    if (merchant.payouts_frozen || merchant.status !== "active") {
      return;
    }

    const payouts = await trx
      .selectFrom("payouts")
      .select(["batch_id", "id", "status"])
      .where("merchant_id", "=", merchantId)
      .where("mode", "=", mode)
      .where("status", "=", "on_hold")
      .execute();

    if (payouts.length === 0) {
      return;
    }

    const now = new Date();
    await trx
      .updateTable("payouts")
      .set({
        status: "queued"
      })
      .where("merchant_id", "=", merchantId)
      .where("mode", "=", mode)
      .where("status", "=", "on_hold")
      .execute();

    await trx
      .insertInto("transaction_events")
      .values(
        payouts.map((payout) => ({
          created_at: now,
          from_status: payout.status,
          id: newId("evt_"),
          merchant_id: merchantId,
          mode,
          provider_payload: null,
          provider_reference: null,
          reason,
          resource_id: payout.id,
          resource_type: "payout",
          to_status: "queued"
        }))
      )
      .execute();

    await this.#refreshBatchStatuses(
      trx,
      uniqueBatchIds(payouts.map((payout) => payout.batch_id))
    );
  }

  async #refreshBatchStatuses(trx: ScopedTransaction, batchIds: string[]) {
    for (const batchId of batchIds) {
      const payouts = await trx
        .selectFrom("payouts")
        .select("status")
        .where("batch_id", "=", batchId)
        .execute();

      if (payouts.length === 0) {
        continue;
      }

      const nextStatus =
        payouts.every((payout) =>
          ["cancelled", "failed", "reversed", "successful"].includes(payout.status)
        )
          ? "completed"
          : payouts.some((payout) => payout.status === "processing")
            ? "processing"
            : payouts.some((payout) => payout.status === "queued")
              ? "queued"
              : payouts.some((payout) => payout.status === "on_hold")
                ? "on_hold"
                : "pending_approval";

      await trx
        .updateTable("payout_batches")
        .set({
          completed_at: nextStatus === "completed" ? new Date() : null,
          status: nextStatus
        })
        .where("id", "=", batchId)
        .execute();
    }
  }
}

function mapMerchantSummary(row: MerchantComplianceRow): MerchantComplianceSummary {
  return {
    collectionsFreezeCategory: row.collections_freeze_category ?? null,
    collectionsFreezeReason: row.collections_freeze_reason,
    collectionsFrozen: row.collections_frozen,
    contactLink: row.contact_link ?? "mailto:compliance@richespay.local",
    kybTier: row.kyb_tier ?? "tier_0",
    limits: {
      collection: {
        dailyVolumeMinor: bigintFromUnknown(row.collections_daily_volume_minor),
        maxMinor: bigintFromUnknown(row.collections_max_minor) ?? 9_999_999_999_999n,
        minMinor: bigintFromUnknown(row.collections_min_minor) ?? 1n,
        monthlyVolumeMinor: bigintFromUnknown(row.collections_monthly_volume_minor)
      },
      payout: {
        dailyVolumeMinor: bigintFromUnknown(row.payouts_daily_volume_minor),
        maxMinor: bigintFromUnknown(row.payouts_max_minor) ?? 9_999_999_999_999n,
        minMinor: bigintFromUnknown(row.payouts_min_minor) ?? 1n,
        monthlyVolumeMinor: bigintFromUnknown(row.payouts_monthly_volume_minor)
      }
    },
    merchantId: row.id,
    mode: row.mode,
    payoutsFreezeCategory: row.payouts_freeze_category ?? null,
    payoutsFreezeReason: row.payouts_freeze_reason,
    payoutsFrozen: row.payouts_frozen,
    rollingReserveBps: row.rolling_reserve_bps ?? 0,
    rollingReserveDays: row.rolling_reserve_days ?? 0,
    screeningPayoutThresholdMinor: bigintFromUnknown(row.screening_payout_threshold_minor),
    settlementCurrency: parseCurrencyCode(row.settlement_currency),
    status: row.status,
    suspensionCategory: row.suspension_category ?? null,
    suspensionReason: row.suspension_reason,
    velocityCollectionsPerPhone: row.velocity_collections_per_phone ?? 5,
    velocityWindowMinutes: row.velocity_window_minutes ?? 10
  };
}

function mapReviewFlag(row: {
  created_at: Date;
  id: string;
  merchant_id: string;
  mode: RpMode;
  payload: Json;
  resource_id: string;
  resource_type: string;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  rule_code: string;
  status: "dismissed" | "open" | "resolved";
  summary: string;
}): ComplianceReviewFlagRecord {
  return {
    createdAt: row.created_at,
    id: row.id,
    merchantId: row.merchant_id,
    mode: row.mode,
    payload: row.payload ?? {},
    resourceId: row.resource_id,
    resourceType: row.resource_type,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    ruleCode: row.rule_code,
    status: row.status,
    summary: row.summary
  };
}

function bigintFromUnknown(value: bigint | number | string | null) {
  if (value === null) {
    return null;
  }

  return BigInt(String(value));
}

function bigintOrNull(value: bigint | null) {
  return value === null ? null : value.toString();
}

function startOfUtcDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function uniqueBatchIds(batchIds: Array<string | null>) {
  return [...new Set(batchIds.filter((batchId): batchId is string => Boolean(batchId)))];
}

function maskPhone(phone: string) {
  if (phone.length <= 4) {
    return phone;
  }

  return `${phone.slice(0, 4)}****${phone.slice(-2)}`;
}
