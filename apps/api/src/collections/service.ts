import { parsePhoneNumberFromString } from "libphonenumber-js";

import {
  getErrorDefinition,
  newId,
  type CurrencyCode
} from "@richespay/shared";
import type { Json } from "../db/types";
import {
  runWithMerchantScope,
  runWithSystemScope,
  type AppDatabase,
  type ScopedTransaction
} from "../db";
import { ComplianceService } from "../compliance";
import { LedgerService } from "../ledger";
import { ApiRouteError } from "../lib/api-error";
import { FeeService } from "../pricing/fee-service";
import { FxService } from "../pricing/fx-service";
import { DatabasePricingRepository } from "../pricing/repository";
import { parseCurrencyCode, type FeeBearer } from "../pricing/types";
import { detectNetworkFromMsisdn } from "../providers/msisdn";
import {
  InvalidMobileMoneyPhoneError,
  normalizeMobileMoneyPhoneNumber
} from "../providers/mobile-money/phone";
import { ProviderCatalog } from "../providers/catalog";
import { DatabaseChannelRegistry, ChannelRouter } from "../providers/router";
import type { ProviderOutcome } from "../providers/types";
import {
  assertCollectionTransition,
  collectionEventTypeForStatus,
  isCollectionFinalEventStatus,
  isCollectionTerminalStatus,
  mapProviderOutcomeToCollectionStatus,
  mapProviderStatusTextToOutcome,
  refundEventTypeForStatus
} from "./state-machine";
import type {
  CollectionMethod,
  CollectionListFilters,
  CollectionNextAction,
  CollectionPage,
  CollectionRecord,
  CollectionReferenceType,
  CollectionStatus,
  CreateCollectionInput,
  RefundRecord
} from "./types";

const INITIAL_STATUS_CHECK_DELAY_MS = 60_000;
const DEFAULT_APPROVAL_WINDOW_MS = 10 * 60_000;
const MAX_STATUS_CHECK_DELAY_MS = 10 * 60_000;

const COUNTRY_CURRENCY: Record<string, CurrencyCode> = {
  GH: "GHS",
  ZM: "ZMW"
};

interface MerchantCollectionContext {
  collectionsFrozen: boolean;
  countryCode: string;
  id: string;
  mode: "live" | "test";
  settlementCurrency: CurrencyCode;
  status: string;
}

interface ReconcileProviderInput {
  callbackPayload?: Json | null;
  channelId?: string | null;
  collectionId: string;
  failureCode?: string | null;
  failureMessage?: string | null;
  merchantId: string;
  mode: "live" | "test";
  network?: string | null;
  now?: Date;
  outcome: ProviderOutcome;
  providerRef?: string | null;
  providerSession?: Json | null;
  providerStatus?: string | null;
  reason?: string | null;
  recordStatusCheck?: boolean;
}

export class CollectionService {
  #complianceService: ComplianceService;
  #database: AppDatabase;
  #feeService: FeeService;
  #fxService: FxService;
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
    this.#feeService =
      input.feeService ??
      new FeeService(pricingRepository);
    this.#fxService = new FxService(pricingRepository);
    this.#providerCatalog = input.providerCatalog ?? null;
    this.#router =
      input.router ?? new ChannelRouter(new DatabaseChannelRegistry(input.database));
  }

  async create(input: CreateCollectionInput): Promise<CollectionRecord> {
    const merchant = await this.#loadMerchantContext(input.merchantId, input.mode);
    const referenceType = input.referenceType ?? "collection";
    this.#assertMerchantCanCreate(merchant, referenceType);

    return input.method === "card"
      ? this.#createCardCollection(merchant, {
          ...input,
          referenceType
        })
      : this.#createMobileMoneyCollection(merchant, {
          ...input,
          referenceType
        });
  }

  async getById(
    merchantId: string,
    mode: "live" | "test",
    collectionId: string
  ): Promise<CollectionRecord> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const row = await trx
        .selectFrom("collections")
        .selectAll()
        .where("id", "=", collectionId)
        .where("reference_type", "=", "collection")
        .executeTakeFirst();

      if (!row) {
        throw new ApiRouteError({
          code: "not_found",
          message: getErrorDefinition("not_found").message,
          statusCode: getErrorDefinition("not_found").status
        });
      }

      return mapCollection(row);
    });
  }

  async list(
    merchantId: string,
    mode: "live" | "test",
    filters: CollectionListFilters,
    limit: number
  ): Promise<CollectionPage> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      let anchor:
        | {
            created_at: Date;
            id: string;
          }
        | undefined;

      if (filters.startingAfter) {
        anchor = await trx
          .selectFrom("collections")
          .select(["created_at", "id"])
          .where("id", "=", filters.startingAfter)
          .executeTakeFirst();

        if (!anchor) {
          throw new ApiRouteError({
            code: "not_found",
            message: "The pagination cursor was not found.",
            statusCode: getErrorDefinition("not_found").status
          });
        }
      }

      let query = trx
        .selectFrom("collections")
        .selectAll()
        .where("reference_type", "=", "collection")
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
        );

      if (anchor) {
        query = query.where((eb) =>
          eb.or([
            eb("created_at", "<", anchor.created_at),
            eb.and([
              eb("created_at", "=", anchor.created_at),
              eb("id", "<", anchor.id)
            ])
          ])
        );
      }

      const rows = await query
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1)
        .execute();

      const items = rows.slice(0, limit).map(mapCollection);
      const nextStartingAfter =
        rows.length > limit ? rows[limit - 1]?.id ?? null : null;

      return {
        items,
        nextStartingAfter
      };
    });
  }

  async reconcileProviderResult(input: ReconcileProviderInput): Promise<CollectionRecord> {
    const now = input.now ?? new Date();

    return runWithMerchantScope(
      this.#database,
      input.merchantId,
      input.mode,
      async (trx) => {
        let collection = await this.#loadCollectionForUpdate(trx, input.collectionId);

        if (isCollectionTerminalStatus(collection.status)) {
          return collection;
        }

        if (collection.status === "pending") {
          collection = await this.#transitionCollection(trx, collection, "processing", {
            cardDetails: extractCardDetails(input.callbackPayload),
            channelId: input.channelId ?? collection.channelId,
            network: input.network ?? collection.network,
            nextStatusCheckAt:
              collection.nextStatusCheckAt ??
              new Date(now.getTime() + INITIAL_STATUS_CHECK_DELAY_MS),
            providerRef: input.providerRef ?? collection.providerRef,
            providerSession: input.providerSession ?? collection.nextAction,
            providerStatus: input.providerStatus ?? null
          });
        }

        const targetStatus = mapProviderOutcomeToCollectionStatus(input.outcome);
        if (!targetStatus) {
          if (collection.expiresAt && collection.expiresAt <= now) {
            return this.#transitionCollection(trx, collection, "expired", {
              completedAt: now,
              failureCode: null,
              failureMessage: null,
              lastStatusCheckAt: input.recordStatusCheck ? now : collection.lastStatusCheckAt,
              nextStatusCheckAt: null,
              providerRef: input.providerRef ?? collection.providerRef,
              providerSession: input.providerSession ?? collection.nextAction,
              providerStatus: input.providerStatus ?? null,
              reason: input.reason ?? "approval_window_elapsed",
              statusCheckAttempts:
                input.recordStatusCheck
                  ? collection.statusCheckAttempts + 1
                  : collection.statusCheckAttempts
            });
          }

          return this.#refreshPendingCollection(trx, collection, {
            lastStatusCheckAt: input.recordStatusCheck ? now : collection.lastStatusCheckAt,
            nextStatusCheckAt: input.recordStatusCheck
              ? new Date(
                  now.getTime() +
                    getStatusCheckDelayMs(collection.statusCheckAttempts + 1)
                )
              : collection.nextStatusCheckAt,
            providerRef: input.providerRef ?? collection.providerRef,
            providerSession: input.providerSession ?? collection.nextAction,
            providerStatus: input.providerStatus ?? null,
            statusCheckAttempts: input.recordStatusCheck
              ? collection.statusCheckAttempts + 1
              : collection.statusCheckAttempts
          });
        }

        return this.#transitionCollection(trx, collection, targetStatus, {
          cardDetails: extractCardDetails(input.callbackPayload),
          completedAt: now,
          failureCode:
            targetStatus === "failed"
              ? deriveFailureCode(input.failureCode ?? null, input.providerStatus ?? null)
              : null,
          failureMessage:
            targetStatus === "failed"
              ? buildFailureMessage(
                  input.failureCode ?? null,
                  input.providerStatus ?? null,
                  input.failureMessage ?? input.reason ?? null
                )
              : null,
          lastStatusCheckAt: input.recordStatusCheck ? now : collection.lastStatusCheckAt,
          nextStatusCheckAt: null,
          providerRef: input.providerRef ?? collection.providerRef,
          providerSession:
            targetStatus === "successful" || targetStatus === "failed"
              ? null
              : input.providerSession ?? collection.nextAction,
          providerStatus: input.providerStatus ?? null,
          reason: input.reason ?? null,
          statusCheckAttempts: input.recordStatusCheck
            ? collection.statusCheckAttempts + 1
            : collection.statusCheckAttempts
        });
      }
    );
  }

  async applyProviderCallback(input: {
    collectionId: string;
    providerRef?: string | null;
    providerStatus: string;
    rawPayload?: Json | null;
    reason?: string | null;
  }): Promise<CollectionRecord> {
    const base = await runWithSystemScope(
      this.#database,
      "load callback collection",
      async (trx) => {
        const row = await trx
          .selectFrom("collections")
          .select(["merchant_id as merchantId", "mode"])
          .where("id", "=", input.collectionId)
          .executeTakeFirst();

        if (!row) {
          throw new ApiRouteError({
            code: "not_found",
            message: "The collection callback target was not found.",
            statusCode: getErrorDefinition("not_found").status
          });
        }

        return row;
      },
      { audit: false }
    );

    return this.reconcileProviderResult({
      collectionId: input.collectionId,
      merchantId: base.merchantId,
      mode: base.mode,
      outcome: mapProviderStatusTextToOutcome(input.providerStatus),
      providerRef: input.providerRef ?? null,
      callbackPayload: input.rawPayload ?? null,
      providerStatus: input.providerStatus,
      reason: input.reason ?? null,
      recordStatusCheck: false
    });
  }

  async listDueStatusChecks(limit: number, now = new Date()) {
    return runWithSystemScope(
      this.#database,
      "list due collection status checks",
      async (trx) =>
        trx
          .selectFrom("collections as collection")
          .innerJoin("channels as channel", "channel.id", "collection.channel_id")
          .select([
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
            "channel.status as channelStatus",
            "collection.expires_at as expiresAt",
            "collection.id as collectionId",
            "collection.merchant_id as merchantId",
            "collection.mode as mode",
            "collection.provider_ref as providerRef",
            "collection.status as status",
            "collection.status_check_attempts as statusCheckAttempts"
          ])
          .where("collection.status", "in", ["pending", "processing"])
          .where("collection.next_status_check_at", "<=", now)
          .orderBy("collection.next_status_check_at", "asc")
          .limit(limit)
          .execute(),
      { audit: false }
    );
  }

  async createRefund(input: {
    amountMinor: bigint | null;
    collectionId: string;
    idempotencyKey: string | null;
    merchantId: string;
    mode: "live" | "test";
    requestId: string;
  }): Promise<RefundRecord> {
    const collection = await this.getById(input.merchantId, input.mode, input.collectionId);

    if (collection.status !== "successful" && collection.status !== "reversed") {
      throw new ApiRouteError({
        code: "validation_error",
        field: "collection_id",
        message: "Only successful collections can be refunded.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    const remainingAmount = collection.amount - collection.refundedMinor;
    const refundAmount = input.amountMinor ?? remainingAmount;
    assertAmountWithinApiLimits(refundAmount);

    if (refundAmount > remainingAmount) {
      throw new ApiRouteError({
        code: "amount_too_large",
        field: "amount",
        message: getErrorDefinition("amount_too_large").message,
        statusCode: getErrorDefinition("amount_too_large").status
      });
    }

    if (!collection.channelId) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "collection_id",
        message: "A refund channel could not be resolved for this collection.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    const providerCatalog = this.#requireProviderCatalog();
    const refundId = newId("rfd_");

    return runWithMerchantScope(
      this.#database,
      input.merchantId,
      input.mode,
      async (trx) => {
        const channel = await runWithSystemScope(
          this.#database,
          "load refund channel",
          async (systemTrx) =>
            systemTrx.selectFrom("channels").selectAll().where("id", "=", collection.channelId!).executeTakeFirstOrThrow(),
          { audit: false }
        );

        const mappedChannel = {
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
        } as const;

        await trx
          .insertInto("refunds")
          .values({
            amount: refundAmount,
            channel_id: collection.channelId,
            collection_id: collection.id,
            completed_at: null,
            currency: collection.currency,
            failure_code: null,
            failure_message: null,
            id: refundId,
            merchant_id: input.merchantId,
            metadata: {
              original_collection_id: collection.id
            },
            method: collection.method,
            mode: input.mode,
            phone: collection.phone,
            provider_ref: null,
            status: "pending"
          })
          .execute();

        if (collection.method === "card") {
          const provider = providerCatalog.resolveCardAcquirer(mappedChannel);
          const refundResult = await provider.refund(
            collection.providerRef ?? collection.id,
            Number(refundAmount)
          );

          return this.#finalizeRefund(trx, {
            collection,
            refundAmount,
            refundId,
            result: refundResult
          });
        }

        if (!collection.phone) {
          throw new ApiRouteError({
            code: "validation_error",
            field: "collection_id",
            message: "The original mobile money number is missing.",
            statusCode: getErrorDefinition("validation_error").status
          });
        }

        const provider = providerCatalog.resolveMobileMoneyProvider(mappedChannel);
        const payoutResult = await provider.payout({
          amount: Number(refundAmount),
          currency: collection.currency,
          msisdn: collection.phone,
          ...(collection.network ? { network: collection.network } : {}),
          reference: refundId,
          context: {
            ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
            merchantId: input.merchantId,
            mode: input.mode,
            requestId: input.requestId
          }
        });

        return this.#finalizeRefund(trx, {
          collection,
          refundAmount,
          refundId,
          result: payoutResult
        });
      }
    );
  }

  async #createMobileMoneyCollection(
    merchant: MerchantCollectionContext,
    input: CreateCollectionInput & {
      referenceType: CollectionReferenceType;
    }
  ): Promise<CollectionRecord> {
    if (!input.phone) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "phone",
        message: "A phone number is required for mobile money collections.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    const phone = resolvePhoneCountryAndNumber(input.phone, input.currency);
    const network =
      input.network ??
      (await detectNetworkFromMsisdn(this.#database, {
        countryCode: phone.countryCode,
        msisdn: phone.normalizedPhone
      }));

    assertAmountWithinApiLimits(input.amountMinor);

    const feeQuote = await this.#feeService.quote(
      {
        countryCode: merchant.countryCode,
        id: merchant.id,
        mode: merchant.mode,
        settlementCurrency: merchant.settlementCurrency
      },
      "collection",
      "mobile_money",
      network,
      input.amountMinor,
      input.currency
    );

    assertAmountWithinApiLimits(feeQuote.customerPaysMinor);

    const channel = await this.#router.pick(
      "mobile_money",
      "collect",
      phone.countryCode,
      network,
      input.mode
    );

    if (!channel) {
      throw new ApiRouteError({
        code: "channel_unavailable",
        message: getErrorDefinition("channel_unavailable").message,
        statusCode: getErrorDefinition("channel_unavailable").status
      });
    }

    const provider = this.#requireProviderCatalog().resolveMobileMoneyProvider(channel);
    const createdAt = new Date();
    const collectionId = newId("col_");
    const expiresAt = new Date(createdAt.getTime() + getApprovalWindowMs(channel.config));

    await runWithMerchantScope(
      this.#database,
      input.merchantId,
      input.mode,
      async (trx) => {
        await this.#complianceService.enforceOperationLimits(trx, {
          amountMinor: input.amountMinor,
          kind: "collection",
          merchantId: input.merchantId,
          mode: input.mode
        });

        await this.#assertReferenceAvailable(trx, input.reference ?? null);

        await trx
          .insertInto("collections")
          .values({
            amount: input.amountMinor,
            channel_id: channel.id,
            completed_at: null,
            created_at: createdAt,
            currency: input.currency,
            customer_email: input.customerEmail,
            customer_name: input.customerName,
            description: input.description,
            expires_at: expiresAt,
            failure_code: null,
            failure_message: null,
            fee_bearer: determineFeeBearer(input.amountMinor, feeQuote),
            fee_minor: feeQuote.feeMinor,
            fx_rate_id: null,
            id: collectionId,
            last_status_check_at: null,
            merchant_id: input.merchantId,
            metadata: input.metadata,
            method: "mobile_money",
            mode: input.mode,
            net_minor: feeQuote.merchantReceivesMinor,
            network,
            next_status_check_at: new Date(createdAt.getTime() + INITIAL_STATUS_CHECK_DELAY_MS),
            phone: phone.normalizedPhone,
            presentment_amount: feeQuote.customerPaysMinor,
            presentment_currency: input.currency,
            provider_ref: null,
            provider_session: {},
            reference: input.reference,
            reference_type: input.referenceType,
            status: "pending",
            status_check_attempts: 0
          })
          .execute();

        await this.#complianceService.maybeFlagCollectionVelocity(trx, {
          collectionId,
          merchantId: input.merchantId,
          mode: input.mode,
          phone: phone.normalizedPhone
        });
      }
    );

    try {
      const providerResult = await provider.collect({
        amount: Number(feeQuote.customerPaysMinor),
        currency: input.currency,
        ...(input.metadata === null ? {} : { metadata: input.metadata }),
        msisdn: phone.normalizedPhone,
        ...(network ? { network } : {}),
        reference: collectionId,
        context: {
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          merchantId: input.merchantId,
          mode: input.mode,
          requestId: input.requestId
        }
      });

      return this.reconcileProviderResult({
        channelId: channel.id,
        collectionId,
        failureCode: providerResult.failureCode ?? null,
        failureMessage: buildFailureMessage(
          providerResult.failureCode ?? null,
          providerResult.providerStatus ?? null,
          null
        ),
        merchantId: input.merchantId,
        mode: input.mode,
        network,
        outcome: providerResult.outcome,
        providerRef: providerResult.providerRef ?? null,
        providerStatus: providerResult.providerStatus ?? null,
        providerSession: providerResult.nextAction ?? null,
        recordStatusCheck: false
      });
    } catch (error) {
      const routeError = error instanceof ApiRouteError ? error : null;
      const outcome = routeError?.code === "provider_error" ? "unknown" : "failed";
      const failureCode =
        outcome === "failed"
          ? routeError?.code === "channel_unavailable"
            ? "channel_unavailable"
            : "provider_error"
          : null;

      return this.reconcileProviderResult({
        channelId: channel.id,
        collectionId,
        failureCode,
        failureMessage: buildFailureMessage(
          failureCode,
          null,
          error instanceof Error ? error.message : null
        ),
        merchantId: input.merchantId,
        mode: input.mode,
        network,
        outcome,
        providerRef: null,
        providerStatus: null,
        providerSession: null,
        recordStatusCheck: false
      });
    }
  }

  async #createCardCollection(
    merchant: MerchantCollectionContext,
    input: CreateCollectionInput & {
      referenceType: CollectionReferenceType;
    }
  ): Promise<CollectionRecord> {
    assertAmountWithinApiLimits(input.amountMinor);

    const settlementAmount =
      input.currency === merchant.settlementCurrency
        ? { amountMinor: input.amountMinor, fxRateId: null }
        : await this.#fxService.convert(
            input.amountMinor,
            input.currency,
            merchant.settlementCurrency
          );

    const feeQuote = await this.#feeService.quote(
      {
        countryCode: merchant.countryCode,
        id: merchant.id,
        mode: merchant.mode,
        settlementCurrency: merchant.settlementCurrency
      },
      "collection",
      "card",
      null,
      settlementAmount.amountMinor,
      merchant.settlementCurrency
    );

    const channel = await this.#router.pick(
      "card",
      "collect",
      merchant.countryCode,
      null,
      input.mode
    );

    if (!channel) {
      throw new ApiRouteError({
        code: "channel_unavailable",
        message: getErrorDefinition("channel_unavailable").message,
        statusCode: getErrorDefinition("channel_unavailable").status
      });
    }

    const provider = this.#requireProviderCatalog().resolveCardAcquirer(channel);
    const createdAt = new Date();
    const collectionId = newId("col_");
    const expiresAt = new Date(createdAt.getTime() + getApprovalWindowMs(channel.config));

    await runWithMerchantScope(
      this.#database,
      input.merchantId,
      input.mode,
      async (trx) => {
        await this.#complianceService.enforceOperationLimits(trx, {
          amountMinor: settlementAmount.amountMinor,
          kind: "collection",
          merchantId: input.merchantId,
          mode: input.mode
        });

        await this.#assertReferenceAvailable(trx, input.reference ?? null);

        await trx
          .insertInto("collections")
          .values({
            amount: settlementAmount.amountMinor,
            channel_id: channel.id,
            completed_at: null,
            created_at: createdAt,
            currency: merchant.settlementCurrency,
            customer_email: input.customerEmail,
            customer_name: input.customerName,
            description: input.description,
            expires_at: expiresAt,
            failure_code: null,
            failure_message: null,
            fee_bearer: determineFeeBearer(settlementAmount.amountMinor, feeQuote),
            fee_minor: feeQuote.feeMinor,
            fx_rate_id: settlementAmount.fxRateId,
            id: collectionId,
            last_status_check_at: null,
            merchant_id: input.merchantId,
            metadata: input.metadata,
            method: "card",
            mode: input.mode,
            net_minor: feeQuote.merchantReceivesMinor,
            network: null,
            next_status_check_at: new Date(createdAt.getTime() + INITIAL_STATUS_CHECK_DELAY_MS),
            phone: null,
            presentment_amount: input.amountMinor,
            presentment_currency: input.currency,
            provider_ref: null,
            provider_session: {},
            reference: input.reference,
            reference_type: input.referenceType,
            status: "pending",
            status_check_attempts: 0
          })
          .execute();
      }
    );

    try {
      const providerResult = await provider.createPaymentSession({
        amount: Number(input.amountMinor),
        currency: input.currency,
        ...(input.baseUrl === null || input.baseUrl === undefined
          ? {}
          : { callbackUrl: `${input.baseUrl}/callbacks/${channel.id}` }),
        ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
        ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
        ...(input.metadata === null ? {} : { metadata: input.metadata }),
        reference: collectionId,
        ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
        context: {
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          merchantId: input.merchantId,
          mode: input.mode,
          requestId: input.requestId
        }
      });

      return this.reconcileProviderResult({
        channelId: channel.id,
        collectionId,
        failureCode: providerResult.failureCode ?? null,
        failureMessage: buildFailureMessage(
          providerResult.failureCode ?? null,
          providerResult.providerStatus ?? null,
          null
        ),
        merchantId: input.merchantId,
        mode: input.mode,
        outcome: providerResult.outcome,
        providerRef: providerResult.providerRef ?? null,
        providerStatus: providerResult.providerStatus ?? null,
        providerSession: providerResult.nextAction ?? null,
        recordStatusCheck: false
      });
    } catch (error) {
      return this.reconcileProviderResult({
        channelId: channel.id,
        collectionId,
        failureCode: "provider_error",
        failureMessage: buildFailureMessage(
          "provider_error",
          null,
          error instanceof Error ? error.message : null
        ),
        merchantId: input.merchantId,
        mode: input.mode,
        outcome: "failed",
        providerRef: null,
        providerStatus: null,
        providerSession: null,
        recordStatusCheck: false
      });
    }
  }

  async #finalizeRefund(
    trx: ScopedTransaction,
    input: {
      collection: CollectionRecord;
      refundAmount: bigint;
      refundId: string;
      result: {
        failureCode?: string;
        outcome: ProviderOutcome;
        providerRef?: string;
        providerStatus?: string;
      };
    }
  ): Promise<RefundRecord> {
    const status =
      input.result.outcome === "succeeded"
        ? "successful"
        : input.result.outcome === "failed"
          ? "failed"
          : "processing";
    const completedAt = status === "processing" ? null : new Date();

    const updatedRefund = await trx
      .updateTable("refunds")
      .set({
        completed_at: completedAt,
        failure_code: status === "failed" ? input.result.failureCode ?? "provider_error" : null,
        failure_message:
          status === "failed"
            ? buildFailureMessage(
                input.result.failureCode ?? null,
                input.result.providerStatus ?? null,
                null
              )
            : null,
        provider_ref: input.result.providerRef ?? null,
        status
      })
      .where("id", "=", input.refundId)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (status === "successful") {
      await trx
        .updateTable("collections")
        .set({
          refunded_minor: input.collection.refundedMinor + input.refundAmount,
          ...(input.collection.refundedMinor + input.refundAmount === input.collection.amount
            ? { status: "reversed" as const }
            : {})
        })
        .where("id", "=", input.collection.id)
        .execute();

      const ledger = new LedgerService(trx, {
        actorId: "richespay_system",
        actorType: "system"
      });

      await ledger.holdForPayout({
        amount: input.refundAmount,
        currency: input.collection.currency,
        description: `Hold refund ${input.refundId}`,
        merchantId: input.collection.merchantId,
        mode: input.collection.mode,
        payoutId: input.refundId
      });

      await ledger.completePayout({
        amount: input.refundAmount,
        channelId: input.collection.channelId ?? "unknown_channel",
        currency: input.collection.currency,
        description: `Complete refund ${input.refundId}`,
        merchantId: input.collection.merchantId,
        mode: input.collection.mode,
        payoutId: input.refundId
      });

      await this.#writeRefundOutboxEvent(trx, mapRefund(updatedRefund), status);
    }

    if (status === "failed") {
      await this.#writeRefundOutboxEvent(trx, mapRefund(updatedRefund), status);
    }

    return mapRefund(updatedRefund);
  }

  #requireProviderCatalog() {
    if (!this.#providerCatalog) {
      throw new Error("Provider catalog is required for collection submission");
    }

    return this.#providerCatalog;
  }

  async #loadMerchantContext(
    merchantId: string,
    mode: "live" | "test"
  ): Promise<MerchantCollectionContext> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const merchant = await trx
        .selectFrom("merchants")
        .select([
          "collections_frozen as collectionsFrozen",
          "country_code as countryCode",
          "id",
          "mode",
          "settlement_currency as settlementCurrency",
          "status"
        ])
        .where("id", "=", merchantId)
        .executeTakeFirst();

      if (!merchant) {
        throw new ApiRouteError({
          code: "not_found",
          message: getErrorDefinition("not_found").message,
          statusCode: getErrorDefinition("not_found").status
        });
      }

      return {
        ...merchant,
        settlementCurrency: parseCurrencyCode(merchant.settlementCurrency)
      };
    });
  }

  #assertMerchantCanCreate(
    merchant: MerchantCollectionContext,
    referenceType: CollectionReferenceType
  ) {
    if (merchant.status !== "active") {
      throw new ApiRouteError({
        code: "merchant_suspended",
        message: getErrorDefinition("merchant_suspended").message,
        statusCode: getErrorDefinition("merchant_suspended").status
      });
    }

    if (referenceType === "collection" && merchant.collectionsFrozen) {
      throw new ApiRouteError({
        code: "collections_frozen",
        message: getErrorDefinition("collections_frozen").message,
        statusCode: getErrorDefinition("collections_frozen").status
      });
    }
  }

  async #assertReferenceAvailable(
    trx: ScopedTransaction,
    reference: string | null
  ) {
    if (!reference) {
      return;
    }

    const existing = await trx
      .selectFrom("collections")
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

  async #loadCollectionForUpdate(
    trx: ScopedTransaction,
    collectionId: string
  ): Promise<CollectionRecord> {
    const row = await trx
      .selectFrom("collections")
      .selectAll()
      .where("id", "=", collectionId)
      .forUpdate()
      .executeTakeFirst();

    if (!row) {
      throw new ApiRouteError({
        code: "not_found",
        message: getErrorDefinition("not_found").message,
        statusCode: getErrorDefinition("not_found").status
      });
    }

    return mapCollection(row);
  }

  async #refreshPendingCollection(
    trx: ScopedTransaction,
    collection: CollectionRecord,
    input: {
      lastStatusCheckAt: Date | null;
      nextStatusCheckAt: Date | null;
      providerRef: string | null;
      providerSession: CollectionNextAction | Json | null;
      providerStatus: string | null;
      statusCheckAttempts: number;
    }
  ): Promise<CollectionRecord> {
    const updated = await trx
      .updateTable("collections")
      .set({
        last_status_check_at: input.lastStatusCheckAt,
        next_status_check_at: input.nextStatusCheckAt,
        provider_ref: input.providerRef,
        provider_session:
          input.providerSession === null ? {} : normalizeProviderSession(input.providerSession),
        status_check_attempts: input.statusCheckAttempts
      })
      .where("id", "=", collection.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    const mapped = mapCollection(updated);
    await this.#syncLinkedTopup(trx, mapped);
    return mapped;
  }

  async #transitionCollection(
    trx: ScopedTransaction,
    collection: CollectionRecord,
    toStatus: CollectionStatus,
    input: {
      cardDetails?: {
        brand: string | null;
        expiryMonth: number | null;
        expiryYear: number | null;
        last4: string | null;
      } | null;
      channelId?: string | null;
      completedAt?: Date | null;
      failureCode?: string | null;
      failureMessage?: string | null;
      lastStatusCheckAt?: Date | null;
      network?: string | null;
      nextStatusCheckAt?: Date | null;
      providerRef?: string | null;
      providerSession?: CollectionNextAction | Json | null;
      providerStatus?: string | null;
      reason?: string | null;
      statusCheckAttempts?: number;
    }
  ): Promise<CollectionRecord> {
    assertCollectionTransition(collection.status, toStatus);

    const updated = await trx
      .updateTable("collections")
      .set({
        ...(input.channelId !== undefined ? { channel_id: input.channelId } : {}),
        ...(input.completedAt !== undefined ? { completed_at: input.completedAt } : {}),
        ...(input.failureCode !== undefined ? { failure_code: input.failureCode } : {}),
        ...(input.failureMessage !== undefined ? { failure_message: input.failureMessage } : {}),
        ...(input.lastStatusCheckAt !== undefined
          ? { last_status_check_at: input.lastStatusCheckAt }
          : {}),
        ...(input.network !== undefined ? { network: input.network } : {}),
        ...(input.nextStatusCheckAt !== undefined
          ? { next_status_check_at: input.nextStatusCheckAt }
          : {}),
        ...(input.providerRef !== undefined ? { provider_ref: input.providerRef } : {}),
        ...(input.providerSession !== undefined
          ? {
              provider_session:
                input.providerSession === null
                  ? {}
                  : normalizeProviderSession(input.providerSession)
            }
          : {}),
        ...(input.cardDetails !== undefined
          ? {
              card_brand: input.cardDetails?.brand ?? null,
              card_exp_month: input.cardDetails?.expiryMonth ?? null,
              card_exp_year: input.cardDetails?.expiryYear ?? null,
              card_last4: input.cardDetails?.last4 ?? null
            }
          : {}),
        status: toStatus,
        ...(input.statusCheckAttempts !== undefined
          ? { status_check_attempts: input.statusCheckAttempts }
          : {})
      })
      .where("id", "=", collection.id)
      .where("status", "=", collection.status)
      .returningAll()
      .executeTakeFirstOrThrow();

    const mapped = mapCollection(updated);

    await trx
      .insertInto("transaction_events")
      .values({
        created_at: input.completedAt ?? new Date(),
        from_status: collection.status,
        id: newId("evt_"),
        merchant_id: mapped.merchantId,
        mode: mapped.mode,
        provider_payload:
          input.providerStatus === null || input.providerStatus === undefined
            ? null
            : {
                provider_status: input.providerStatus
              },
        provider_reference: input.providerRef ?? null,
        reason: input.reason ?? null,
        resource_id: mapped.id,
        resource_type: "collection",
        to_status: toStatus
      })
      .execute();

    if (toStatus === "successful") {
      if (mapped.referenceType === "topup") {
        await this.#settleSuccessfulTopup(trx, mapped);
      } else {
        await this.#settleSuccessfulCollection(trx, mapped);
      }
    }

    if (mapped.referenceType === "collection" && isCollectionFinalEventStatus(toStatus)) {
      await this.#writeOutboxEvent(trx, mapped, toStatus, input.reason ?? null);
    }

    await this.#syncLinkedTopup(trx, mapped);

    return mapped;
  }

  async #settleSuccessfulCollection(
    trx: ScopedTransaction,
    collection: CollectionRecord
  ) {
    if (!collection.channelId) {
      throw new Error("A successful collection must have a channel.");
    }

    const merchant = await this.#complianceService.getMerchantSummaryInScope(
      trx,
      collection.merchantId,
      collection.mode
    );
    const netAmount = collection.amount - collection.feeMinor;
    const reserveAmount = merchant.collectionsFrozen
      ? netAmount
      : this.#complianceService.calculateRollingReserve(merchant, netAmount);

    const ledger = new LedgerService(trx, {
      actorId: "richespay_system",
      actorType: "system"
    });

    await ledger.creditCollection({
      amount: collection.amount,
      channelId: collection.channelId,
      collectionId: collection.id,
      currency: collection.currency,
      feeAmount: collection.feeMinor,
      merchantId: collection.merchantId,
      mode: collection.mode,
      reserveAmount
    });

    if (!merchant.collectionsFrozen && reserveAmount > 0n) {
      await this.#complianceService.recordRollingReserveHold(trx, {
        amountMinor: reserveAmount,
        collectionId: collection.id,
        currency: collection.currency,
        merchantId: collection.merchantId,
        mode: collection.mode,
        reserveDays: merchant.rollingReserveDays
      });
    }
  }

  async #settleSuccessfulTopup(
    trx: ScopedTransaction,
    collection: CollectionRecord
  ) {
    const topupId = this.#extractLinkedTopupId(collection);
    if (!topupId) {
      throw new Error("A successful top-up collection must have a linked top-up id.");
    }

    if (!collection.channelId) {
      throw new Error("A successful top-up collection must have a channel.");
    }

    const ledger = new LedgerService(trx, {
      actorId: "richespay_system",
      actorType: "system"
    });

    await ledger.creditTopup({
      amount: collection.amount,
      channelId: collection.channelId,
      currency: collection.currency,
      feeAmount: collection.feeMinor,
      merchantId: collection.merchantId,
      mode: collection.mode,
      topupId
    });
  }

  async #syncLinkedTopup(trx: ScopedTransaction, collection: CollectionRecord) {
    if (collection.referenceType !== "topup") {
      return;
    }

    const topupId = this.#extractLinkedTopupId(collection);
    if (!topupId) {
      return;
    }

    const topupStatus =
      collection.status === "successful"
        ? "successful"
        : collection.status === "failed"
          ? "failed"
          : collection.status === "expired"
            ? "expired"
            : "pending";

    await trx
      .updateTable("topups")
      .set({
        bank_reference: null,
        completed_at:
          topupStatus === "successful" || topupStatus === "failed" || topupStatus === "expired"
            ? (collection.completedAt ?? new Date())
            : null,
        fee_minor: collection.feeMinor,
        provider_ref: collection.providerRef,
        source_collection_id: collection.id,
        status: topupStatus
      })
      .where("id", "=", topupId)
      .execute();
  }

  #extractLinkedTopupId(collection: CollectionRecord) {
    if (collection.metadata && typeof collection.metadata === "object" && !Array.isArray(collection.metadata)) {
      const topupId = (collection.metadata as Record<string, unknown>).topup_id;
      if (typeof topupId === "string" && topupId.length > 0) {
        return topupId;
      }
    }

    return null;
  }

  async #writeOutboxEvent(
    trx: ScopedTransaction,
    collection: CollectionRecord,
    status: CollectionStatus,
    reason: string | null
  ) {
    const eventType = collectionEventTypeForStatus(status);
    if (!eventType) {
      return;
    }

    await trx
      .insertInto("events_outbox")
      .values({
        created_at: new Date(),
        id: newId("evt_"),
        merchant_id: collection.merchantId,
        mode: collection.mode,
        payload: {
          amount: Number(collection.amount),
          collection_id: collection.id,
          completed_at: collection.completedAt?.toISOString() ?? null,
          currency: collection.currency,
          failure_code: collection.failureCode,
          failure_message: collection.failureMessage,
          fee_bearer: collection.feeBearer,
          fee_minor: Number(collection.feeMinor),
          net_minor: Number(collection.netMinor),
          next_action: collection.nextAction ? normalizeProviderSession(collection.nextAction) : null,
          presentment_amount:
            collection.presentmentAmount === null
              ? null
              : Number(collection.presentmentAmount),
          presentment_currency: collection.presentmentCurrency,
          provider_ref: collection.providerRef,
          refunded_minor: Number(collection.refundedMinor),
          reason,
          reference: collection.reference,
          status,
          ...(collection.card
            ? {
                card: {
                  brand: collection.card.brand,
                  expiry_month: collection.card.expiryMonth,
                  expiry_year: collection.card.expiryYear,
                  last4: collection.card.last4
                }
              }
            : {})
        },
        type: eventType
      })
      .execute();
  }

  async #writeRefundOutboxEvent(
    trx: ScopedTransaction,
    refund: RefundRecord,
    status: "failed" | "successful"
  ) {
    const eventType = refundEventTypeForStatus(status);
    if (!eventType) {
      return;
    }

    await trx
      .insertInto("events_outbox")
      .values({
        created_at: new Date(),
        id: newId("evt_"),
        merchant_id: refund.merchantId,
        mode: refund.mode,
        payload: {
          amount: Number(refund.amount),
          collection_id: refund.collectionId,
          currency: refund.currency,
          failure_code: refund.failureCode,
          failure_message: refund.failureMessage,
          method: refund.method,
          phone: refund.phone,
          provider_ref: refund.providerRef,
          refund_id: refund.id,
          status
        },
        type: eventType
      })
      .execute();
  }
}

function resolvePhoneCountryAndNumber(
  phone: string,
  currency: CurrencyCode
): {
  countryCode: string;
  normalizedPhone: string;
} {
  const parsed = parsePhoneNumberFromString(phone);
  const parsedCountry = parsed?.country;

  if (parsedCountry && parsedCountry in COUNTRY_CURRENCY) {
    const countryCode = parsedCountry;
    const localCurrency = COUNTRY_CURRENCY[countryCode];
    if (localCurrency !== currency) {
      throw new ApiRouteError({
        code: "unsupported_currency",
        message: getErrorDefinition("unsupported_currency").message,
        statusCode: getErrorDefinition("unsupported_currency").status
      });
    }

    try {
      return {
        countryCode,
        normalizedPhone: normalizeMobileMoneyPhoneNumber(phone, countryCode)
      };
    } catch (error) {
      throw normalizePhoneError(error);
    }
  }

  const expectedCountry = Object.entries(COUNTRY_CURRENCY).find(
    ([, localCurrency]) => localCurrency === currency
  )?.[0];

  if (!expectedCountry) {
    throw new ApiRouteError({
      code: "unsupported_currency",
      message: getErrorDefinition("unsupported_currency").message,
      statusCode: getErrorDefinition("unsupported_currency").status
    });
  }

  try {
    return {
      countryCode: expectedCountry,
      normalizedPhone: normalizeMobileMoneyPhoneNumber(phone, expectedCountry)
    };
  } catch (error) {
    throw normalizePhoneError(error);
  }
}

function normalizePhoneError(error: unknown) {
  if (error instanceof InvalidMobileMoneyPhoneError) {
    throw new ApiRouteError({
      code: "invalid_phone_number",
      message: getErrorDefinition("invalid_phone_number").message,
      statusCode: getErrorDefinition("invalid_phone_number").status
    });
  }

  throw error;
}

function determineFeeBearer(
  amountMinor: bigint,
  quote: {
    customerPaysMinor: bigint;
  }
): FeeBearer {
  return quote.customerPaysMinor > amountMinor ? "customer" : "merchant";
}

function assertAmountWithinApiLimits(amountMinor: bigint) {
  if (amountMinor <= 0n) {
    throw new ApiRouteError({
      code: "amount_too_small",
      message: getErrorDefinition("amount_too_small").message,
      statusCode: getErrorDefinition("amount_too_small").status
    });
  }

  if (amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ApiRouteError({
      code: "amount_too_large",
      message: getErrorDefinition("amount_too_large").message,
      statusCode: getErrorDefinition("amount_too_large").status
    });
  }
}

function getApprovalWindowMs(config: Json) {
  if (
    config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    "approval_window_seconds" in config
  ) {
    const raw = (config as Record<string, unknown>).approval_window_seconds;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return raw * 1000;
    }
  }

  return DEFAULT_APPROVAL_WINDOW_MS;
}

function getStatusCheckDelayMs(attempt: number) {
  return Math.min(
    INITIAL_STATUS_CHECK_DELAY_MS * 2 ** Math.max(attempt - 1, 0),
    MAX_STATUS_CHECK_DELAY_MS
  );
}

function deriveFailureCode(
  preferredFailureCode: string | null,
  providerStatus: string | null
) {
  if (preferredFailureCode) {
    return preferredFailureCode;
  }

  if (providerStatus?.toLowerCase() === "insufficient_funds") {
    return "insufficient_funds";
  }

  return "provider_error";
}

function buildFailureMessage(
  failureCode: string | null,
  providerStatus: string | null,
  fallback: string | null
) {
  if (failureCode === "insufficient_funds") {
    return getErrorDefinition("insufficient_funds").message;
  }

  if (failureCode === "channel_unavailable") {
    return getErrorDefinition("channel_unavailable").message;
  }

  if (failureCode === "provider_error") {
    return fallback ?? providerStatus ?? getErrorDefinition("provider_error").message;
  }

  return fallback ?? providerStatus;
}

function mapCollection(row: {
  amount: string;
  card_brand: string | null;
  card_exp_month: number | null;
  card_exp_year: number | null;
  card_last4: string | null;
  channel_id: string | null;
  completed_at: Date | null;
  created_at: Date;
  currency: string;
  customer_email: string | null;
  customer_name: string | null;
  description: string | null;
  expires_at: Date | null;
  failure_code: string | null;
  failure_message: string | null;
  fee_bearer: FeeBearer;
  fee_minor: string;
  fx_rate_id: string | null;
  id: string;
  last_status_check_at: Date | null;
  merchant_id: string;
  metadata: Json;
  method: string;
  mode: "live" | "test";
  net_minor: string;
  network: string | null;
  next_status_check_at: Date | null;
  phone: string | null;
  presentment_amount: string | null;
  presentment_currency: string | null;
  provider_ref: string | null;
  provider_session: Json;
  reference: string | null;
  reference_type: string;
  refunded_minor: string;
  status: CollectionStatus;
  status_check_attempts: number;
}): CollectionRecord {
  if (row.method !== "mobile_money" && row.method !== "card") {
    throw new Error(`Unsupported collection method: ${row.method}`);
  }

  return {
    amount: BigInt(row.amount),
    card:
      row.card_brand || row.card_last4 || row.card_exp_month || row.card_exp_year
        ? {
            brand: row.card_brand,
            expiryMonth: row.card_exp_month,
            expiryYear: row.card_exp_year,
            last4: row.card_last4
          }
        : null,
    channelId: row.channel_id,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    currency: parseCurrencyCode(row.currency),
    customerEmail: row.customer_email,
    customerName: row.customer_name,
    description: row.description,
    expiresAt: row.expires_at,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    feeBearer: row.fee_bearer,
    feeMinor: BigInt(row.fee_minor),
    fxRateId: row.fx_rate_id,
    id: row.id,
    lastStatusCheckAt: row.last_status_check_at,
    merchantId: row.merchant_id,
    metadata: row.metadata,
    method: row.method,
    mode: row.mode,
    netMinor: BigInt(row.net_minor),
    network: row.network,
    nextAction: parseCollectionNextAction(row.provider_session),
    nextStatusCheckAt: row.next_status_check_at,
    phone: row.phone,
    presentmentAmount:
      row.presentment_amount === null ? null : BigInt(row.presentment_amount),
    presentmentCurrency:
      row.presentment_currency === null
        ? null
        : parseCurrencyCode(row.presentment_currency),
    providerRef: row.provider_ref,
    reference: row.reference,
    referenceType: parseCollectionReferenceType(row.reference_type),
    refundedMinor: BigInt(row.refunded_minor),
    status: row.status,
    statusCheckAttempts: row.status_check_attempts
  };
}

function mapRefund(row: {
  amount: string;
  channel_id: string | null;
  collection_id: string;
  completed_at: Date | null;
  created_at: Date;
  currency: string;
  failure_code: string | null;
  failure_message: string | null;
  id: string;
  merchant_id: string;
  method: string;
  mode: "live" | "test";
  phone: string | null;
  provider_ref: string | null;
  status: "failed" | "pending" | "processing" | "successful";
}): RefundRecord {
  return {
    amount: BigInt(row.amount),
    channelId: row.channel_id,
    collectionId: row.collection_id,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    currency: parseCurrencyCode(row.currency),
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    id: row.id,
    merchantId: row.merchant_id,
    method: parseCollectionMethod(row.method),
    mode: row.mode,
    phone: row.phone,
    providerRef: row.provider_ref,
    status: row.status
  };
}

function extractCardDetails(value: Json | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const instrument = (value as Record<string, unknown>).payment_instrument;
  if (!instrument || typeof instrument !== "object" || Array.isArray(instrument)) {
    return null;
  }

  const raw = instrument as Record<string, unknown>;
  return {
    brand: typeof raw.brand === "string" ? raw.brand : null,
    expiryMonth: typeof raw.expiry_month === "number" ? raw.expiry_month : null,
    expiryYear: typeof raw.expiry_year === "number" ? raw.expiry_year : null,
    last4: typeof raw.last4 === "string" ? raw.last4 : null
  };
}

function normalizeProviderSession(value: CollectionNextAction | Json): Json {
  if ("type" in (value as Record<string, unknown>)) {
    const raw = value as CollectionNextAction & Record<string, unknown>;
    return raw.type === "hosted_fields"
      ? {
          iframe_url:
            typeof raw.iframeUrl === "string"
              ? raw.iframeUrl
              : typeof raw.iframe_url === "string"
                ? raw.iframe_url
                : null,
          type: raw.type
        }
      : {
          type: raw.type,
          url: typeof raw.url === "string" ? raw.url : null
        };
  }

  return value as Json;
}

function parseCollectionNextAction(value: Json): CollectionNextAction | null {
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

function parseCollectionMethod(value: string): CollectionMethod {
  if (value === "mobile_money" || value === "card") {
    return value;
  }

  throw new Error(`Unsupported collection method: ${value}`);
}

function parseCollectionReferenceType(value: string): CollectionReferenceType {
  if (value === "collection" || value === "topup") {
    return value;
  }

  throw new Error(`Unsupported collection reference type: ${value}`);
}
