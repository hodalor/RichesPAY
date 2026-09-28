import { sql } from "kysely";
import {
  ParseError,
  parsePhoneNumberWithError,
  type CountryCode
} from "libphonenumber-js";

import {
  CURRENCIES,
  getErrorDefinition,
  newId,
  type CurrencyCode,
  type ErrorCode
} from "@richespay/shared";

import { mapProviderStatusTextToOutcome } from "../collections/state-machine";
import { ComplianceService } from "../compliance";
import {
  runWithMerchantScope,
  runWithSystemScope,
  type AppDatabase,
  type ScopedTransaction
} from "../db";
import type { Json, RpMode } from "../db/types";
import { LedgerService } from "../ledger";
import { ApiRouteError } from "../lib/api-error";
import { merchantCanTransact } from "../lib/merchant-access";
import { requireProduct } from "../products/require-product";
import { FxService } from "../pricing/fx-service";
import { DatabasePricingRepository } from "../pricing/repository";
import { parseCurrencyCode } from "../pricing/types";
import type { ProviderCatalog } from "../providers/catalog";
import { DatabaseChannelRegistry, type ChannelRegistry } from "../providers/router";
import {
  airtimeNotSentStatus,
  type ChannelRecord,
  type ProviderResult
} from "../providers/types";

import {
  airtimeBatchCompletedEvent,
  airtimeEventTypeForStatus,
  assertAirtimeTransition,
  isAirtimeTerminalStatus,
  mapProviderOutcomeToAirtimeStatus,
  nextStatusCheckDelayMs
} from "./state-machine";
import {
  defaultAirtimeLimits,
  type AirtimeBatchRecord,
  type AirtimeBulkItemInput,
  type AirtimeEventRecord,
  type AirtimeListFilters,
  type AirtimeMerchantLimits,
  type AirtimeNetworkRecord,
  type AirtimeOrderRecord,
  type AirtimeOrderStatus,
  type AirtimeQuote,
  type AirtimeRejectedRow,
  type CreateAirtimeInput
} from "./types";

type AirtimeProviderSource = Pick<ProviderCatalog, "resolveAirtimeProvider">;
type CurrencyConverter = Pick<FxService, "convert">;

interface AirtimeMerchantContext {
  countryCode: string;
  id: string;
  mode: RpMode;
  settlementCurrency: CurrencyCode;
  status: string;
}

interface AirtimeReferenceData {
  discounts: Map<string, number>;
  networks: Map<string, AirtimeNetworkRecord>;
  prefixes: Array<{ countryCode: string; network: string; prefix: string }>;
}

interface AirtimeUsage {
  merchantTotal: bigint;
  perPhone: Map<string, { amount: bigint; count: number }>;
}

interface PreparedBulkRow {
  index: number;
  metadata: Json;
  quote: AirtimeQuote;
  reference: string | null;
}

const orderColumns = [
  "amount",
  "batch_id",
  "channel_id",
  "charge_amount",
  "charge_currency",
  "completed_at",
  "country_code",
  "created_at",
  "created_by",
  "currency",
  "discount_minor",
  "failure_code",
  "fx_rate_id",
  "id",
  "merchant_id",
  "metadata",
  "mode",
  "network",
  "phone",
  "provider_ref",
  "reference",
  "send_attempts",
  "status",
  "status_check_attempts"
] as const;

const bulkInsertChunkSize = 500;

export class AirtimeService {
  #complianceService: ComplianceService;
  #database: AppDatabase;
  #fx: CurrencyConverter;
  #providers: AirtimeProviderSource | null;
  #registry: ChannelRegistry;

  constructor(input: {
    database: AppDatabase;
    fxService?: CurrencyConverter;
    providerCatalog?: AirtimeProviderSource;
    registry?: ChannelRegistry;
  }) {
    this.#database = input.database;
    this.#complianceService = new ComplianceService({ database: input.database });
    this.#fx =
      input.fxService ?? new FxService(new DatabasePricingRepository(input.database));
    this.#providers = input.providerCatalog ?? null;
    this.#registry = input.registry ?? new DatabaseChannelRegistry(input.database);
  }

  async listNetworks(input: {
    countryCode?: string;
    merchantId: string;
    mode: RpMode;
  }): Promise<AirtimeNetworkRecord[]> {
    const merchant = await this.#loadActiveMerchantWithProduct(input.merchantId, input.mode);
    const reference = await this.#loadReferenceData(merchant);
    const country = input.countryCode?.toUpperCase();

    return [...reference.networks.values()]
      .filter((network) => !country || network.countryCode === country)
      .sort((left, right) =>
        left.countryCode === right.countryCode
          ? left.network.localeCompare(right.network)
          : left.countryCode.localeCompare(right.countryCode)
      );
  }

  async quote(input: {
    amount: bigint;
    currency: CurrencyCode;
    merchantId: string;
    mode: RpMode;
    phone: string;
  }): Promise<AirtimeQuote> {
    const merchant = await this.#loadActiveMerchantWithProduct(input.merchantId, input.mode);
    const reference = await this.#loadReferenceData(merchant);
    return this.#prepareQuote(merchant, reference, input.phone, input.amount, input.currency);
  }

  async create(input: CreateAirtimeInput): Promise<AirtimeOrderRecord> {
    const merchant = await this.#loadActiveMerchantWithProduct(input.merchantId, input.mode);
    const reference = await this.#loadReferenceData(merchant);
    const quote = await this.#prepareQuote(
      merchant,
      reference,
      input.phone,
      input.amount,
      input.currency,
      undefined,
      input.network
    );

    return runWithMerchantScope(this.#database, merchant.id, merchant.mode, async (trx) => {
      await this.#assertReferenceAvailable(trx, merchant, input.reference ?? null);

      const available = await this.#availableBalance(trx, merchant, quote.chargeCurrency);
      if (available < quote.chargeAmount) {
        throw apiError("insufficient_funds");
      }

      const limits = await this.#loadLimits(trx, merchant);
      const usage = await this.#loadUsageToday(trx, merchant, quote.chargeCurrency, [quote.phone]);
      const limitError = checkLimits(limits, usage, quote.phone, quote.chargeAmount);
      if (limitError) {
        throw limitError;
      }

      const channelAvailable =
        (await this.#routableChannels(quote.countryCode, quote.network, merchant.mode)).length > 0;
      if (!channelAvailable) {
        throw apiError("airtime_unavailable");
      }

      const orderId = newId("air_");
      const row = await trx
        .insertInto("airtime_orders")
        .values({
          ...orderValues(merchant, quote, {
            createdBy: input.createdBy,
            metadata: input.metadata ?? {},
            reference: input.reference ?? null
          }),
          batch_id: null,
          id: orderId
        })
        .returning(orderColumns)
        .executeTakeFirstOrThrow();

      await ledgerFor(trx, input.createdBy).holdForAirtime({
        airtimeReference: orderId,
        amount: quote.chargeAmount,
        currency: quote.chargeCurrency,
        merchantId: merchant.id,
        mode: merchant.mode
      });

      await this.#writeTransactionEvents(trx, merchant, [
        { orderId, toStatus: "pending" }
      ]);

      const priorCount = usage.perPhone.get(quote.phone)?.count ?? 0;
      await this.#maybeFlagVelocity(trx, merchant, limits, [
        { count: priorCount + 1, orderId, phone: quote.phone }
      ]);

      return mapOrder(row);
    });
  }

  async createBulk(input: {
    createdBy: string;
    items: AirtimeBulkItemInput[];
    merchantId: string;
    mode: RpMode;
    reference?: string | null;
  }): Promise<{ batch: AirtimeBatchRecord; orderIds: string[] }> {
    const merchant = await this.#loadActiveMerchantWithProduct(input.merchantId, input.mode);
    const referenceData = await this.#loadReferenceData(merchant);
    const rejected: AirtimeRejectedRow[] = [];
    const prepared: PreparedBulkRow[] = [];
    const conversionCache = new Map<string, Promise<{ amountMinor: bigint; fxRateId: string }>>();

    for (const [index, item] of input.items.entries()) {
      try {
        if (!Number.isSafeInteger(item.amount) || item.amount <= 0) {
          throw new ApiRouteError({
            code: "amount_not_allowed",
            field: "amount",
            message: "Amount must be a positive whole number of minor units.",
            statusCode: getErrorDefinition("amount_not_allowed").status
          });
        }

        const quote = await this.#prepareQuote(
          merchant,
          referenceData,
          item.phone,
          BigInt(item.amount),
          item.currency ?? null,
          conversionCache,
          item.network
        );
        prepared.push({
          index,
          metadata: item.metadata ?? {},
          quote,
          reference: item.reference ?? null
        });
      } catch (error) {
        rejected.push(rejectionFromError(index, item.phone, error));
      }
    }

    const channelAvailability = new Map<string, boolean>();
    for (const row of prepared) {
      const key = networkKey(row.quote.countryCode, row.quote.network);
      if (!channelAvailability.has(key)) {
        channelAvailability.set(
          key,
          (await this.#routableChannels(row.quote.countryCode, row.quote.network, merchant.mode))
            .length > 0
        );
      }
    }

    const chargeCurrency = merchant.settlementCurrency;

    return runWithMerchantScope(this.#database, merchant.id, merchant.mode, async (trx) => {
      let remaining = await this.#availableBalance(trx, merchant, chargeCurrency);
      const limits = await this.#loadLimits(trx, merchant);
      const usage = await this.#loadUsageToday(
        trx,
        merchant,
        chargeCurrency,
        [...new Set(prepared.map((row) => row.quote.phone))]
      );
      const accepted: PreparedBulkRow[] = [];

      for (const row of prepared) {
        if (remaining < row.quote.chargeAmount) {
          rejected.push(rejectionFromError(row.index, row.quote.phone, apiError("insufficient_funds")));
          continue;
        }

        const limitError = checkLimits(limits, usage, row.quote.phone, row.quote.chargeAmount);
        if (limitError) {
          rejected.push(rejectionFromError(row.index, row.quote.phone, limitError));
          continue;
        }

        if (!channelAvailability.get(networkKey(row.quote.countryCode, row.quote.network))) {
          rejected.push(
            rejectionFromError(row.index, row.quote.phone, apiError("airtime_unavailable"))
          );
          continue;
        }

        remaining -= row.quote.chargeAmount;
        usage.merchantTotal += row.quote.chargeAmount;
        const phoneUsage = usage.perPhone.get(row.quote.phone) ?? { amount: 0n, count: 0 };
        phoneUsage.amount += row.quote.chargeAmount;
        phoneUsage.count += 1;
        usage.perPhone.set(row.quote.phone, phoneUsage);
        accepted.push(row);
      }

      rejected.sort((left, right) => left.index - right.index);
      const batchId = newId("aib_");
      const totalCharge = accepted.reduce((sum, row) => sum + row.quote.chargeAmount, 0n);
      const now = new Date();
      const completedImmediately = accepted.length === 0;

      const batchRow = await trx
        .insertInto("airtime_batches")
        .values({
          accepted: accepted.length,
          charge_currency: chargeCurrency,
          completed_at: completedImmediately ? now : null,
          created_at: now,
          created_by: input.createdBy,
          id: batchId,
          merchant_id: merchant.id,
          mode: merchant.mode,
          reference: input.reference ?? null,
          rejected: rejected.length,
          rejected_rows: JSON.stringify(rejected) as unknown as Json,
          status: completedImmediately ? "completed" : "processing",
          total_charge: totalCharge,
          total_items: input.items.length
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const orderIds: string[] = [];
      for (let start = 0; start < accepted.length; start += bulkInsertChunkSize) {
        const chunk = accepted.slice(start, start + bulkInsertChunkSize);
        const values = chunk.map((row) => {
          const id = newId("air_");
          orderIds.push(id);
          return {
            ...orderValues(merchant, row.quote, {
              createdBy: input.createdBy,
              metadata: row.metadata,
              reference: row.reference
            }),
            batch_id: batchId,
            id
          };
        });
        await trx.insertInto("airtime_orders").values(values).execute();
      }

      if (totalCharge > 0n) {
        await ledgerFor(trx, input.createdBy).holdForAirtime({
          airtimeReference: batchId,
          amount: totalCharge,
          currency: chargeCurrency,
          description: `Hold airtime batch ${batchId}`,
          merchantId: merchant.id,
          mode: merchant.mode
        });
      }

      await this.#writeTransactionEvents(
        trx,
        merchant,
        orderIds.map((orderId) => ({ orderId, toStatus: "pending" as const }))
      );

      const crossings = new Map<string, { count: number; orderId: string; phone: string }>();
      accepted.forEach((row, position) => {
        crossings.set(row.quote.phone, {
          count: usage.perPhone.get(row.quote.phone)?.count ?? 0,
          orderId: orderIds[position]!,
          phone: row.quote.phone
        });
      });
      await this.#maybeFlagVelocity(trx, merchant, limits, [...crossings.values()]);

      if (completedImmediately) {
        await this.#writeBatchCompletedEvent(trx, mapBatch(batchRow));
      }

      return { batch: mapBatch(batchRow), orderIds };
    });
  }

  async getById(merchantId: string, mode: RpMode, orderId: string): Promise<AirtimeOrderRecord> {
    await this.#loadActiveMerchantWithProduct(merchantId, mode, { allowInactive: true });

    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const row = await trx
        .selectFrom("airtime_orders")
        .select(orderColumns)
        .where("merchant_id", "=", merchantId)
        .where("mode", "=", mode)
        .where("id", "=", orderId)
        .executeTakeFirst();

      if (!row) {
        throw apiError("not_found");
      }

      return mapOrder(row);
    });
  }

  async list(
    merchantId: string,
    mode: RpMode,
    filters: AirtimeListFilters,
    limit: number
  ): Promise<{ data: AirtimeOrderRecord[]; hasMore: boolean; nextStartingAfter: string | null }> {
    await this.#loadActiveMerchantWithProduct(merchantId, mode, { allowInactive: true });

    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      let query = trx
        .selectFrom("airtime_orders")
        .select(orderColumns)
        .where("merchant_id", "=", merchantId)
        .where("mode", "=", mode);

      if (filters.status) query = query.where("status", "=", filters.status);
      if (filters.phone) query = query.where("phone", "=", filters.phone);
      if (filters.network) query = query.where("network", "=", filters.network.toUpperCase());
      if (filters.batchId) query = query.where("batch_id", "=", filters.batchId);
      if (filters.createdGte) query = query.where("created_at", ">=", filters.createdGte);
      if (filters.createdLte) query = query.where("created_at", "<=", filters.createdLte);
      if (filters.startingAfter) query = query.where("id", "<", filters.startingAfter);

      const rows = await query.orderBy("id", "desc").limit(limit + 1).execute();
      const page = rows.slice(0, limit).map(mapOrder);

      return {
        data: page,
        hasMore: rows.length > limit,
        nextStartingAfter: rows.length > limit ? page.at(-1)?.id ?? null : null
      };
    });
  }

  async getBatch(merchantId: string, mode: RpMode, batchId: string): Promise<AirtimeBatchRecord> {
    await this.#loadActiveMerchantWithProduct(merchantId, mode, { allowInactive: true });

    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const row = await trx
        .selectFrom("airtime_batches")
        .selectAll()
        .where("merchant_id", "=", merchantId)
        .where("mode", "=", mode)
        .where("id", "=", batchId)
        .executeTakeFirst();

      if (!row) {
        throw apiError("not_found");
      }

      return mapBatch(row);
    });
  }

  async listBatches(
    merchantId: string,
    mode: RpMode,
    filters: { startingAfter?: string },
    limit: number
  ): Promise<{ data: AirtimeBatchRecord[]; hasMore: boolean; nextStartingAfter: string | null }> {
    await this.#loadActiveMerchantWithProduct(merchantId, mode, { allowInactive: true });

    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      let query = trx
        .selectFrom("airtime_batches")
        .selectAll()
        .where("merchant_id", "=", merchantId)
        .where("mode", "=", mode);

      if (filters.startingAfter) {
        query = query.where("id", "<", filters.startingAfter);
      }

      const rows = await query.orderBy("id", "desc").limit(limit + 1).execute();
      const page = rows.slice(0, limit).map(mapBatch);

      return {
        data: page,
        hasMore: rows.length > limit,
        nextStartingAfter: rows.length > limit ? page.at(-1)?.id ?? null : null
      };
    });
  }

  async listEvents(
    merchantId: string,
    mode: RpMode,
    orderId: string
  ): Promise<AirtimeEventRecord[]> {
    await this.getById(merchantId, mode, orderId);

    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const rows = await trx
        .selectFrom("transaction_events")
        .select(["created_at", "from_status", "provider_reference", "reason", "to_status"])
        .where("merchant_id", "=", merchantId)
        .where("mode", "=", mode)
        .where("resource_id", "=", orderId)
        .where("resource_type", "=", "airtime")
        .orderBy("created_at", "asc")
        .execute();

      return rows.map((row) => ({
        createdAt: row.created_at,
        fromStatus: row.from_status,
        providerReference: row.provider_reference,
        reason: row.reason,
        toStatus: row.to_status
      }));
    });
  }

  async getFxRate(rateId: string | null): Promise<number | null> {
    if (!rateId) {
      return null;
    }

    const row = await runWithSystemScope(
      this.#database,
      "load airtime fx rate",
      async (trx) =>
        trx.selectFrom("fx_rates").select("rate").where("id", "=", rateId).executeTakeFirst(),
      { audit: false }
    );

    return row ? Number(row.rate) : null;
  }

  async detectNetwork(input: {
    merchantId: string;
    mode: RpMode;
    phone: string;
  }): Promise<AirtimeNetworkRecord> {
    const merchant = await this.#loadActiveMerchantWithProduct(input.merchantId, input.mode);
    const reference = await this.#loadReferenceData(merchant);
    const { countryCode, phone } = parseRecipientPhone(input.phone, merchant.countryCode);
    const prefixNetwork = reference.prefixes.find(
      (entry) => entry.countryCode === countryCode && phone.slice(1).startsWith(entry.prefix)
    )?.network;
    const network = prefixNetwork
      ? reference.networks.get(networkKey(countryCode, prefixNetwork))
      : undefined;

    if (!network || !network.active) {
      throw apiError("network_not_supported");
    }

    return network;
  }

  async summary(
    merchantId: string,
    mode: RpMode,
    range?: { createdGte?: Date; createdLte?: Date }
  ) {
    await this.#loadActiveMerchantWithProduct(merchantId, mode, { allowInactive: true });
    const startOfDay = startOfUtcDay();
    const startOfMonth = startOfUtcMonth();
    const rangeStart = range?.createdGte ?? startOfDay;
    const rangeEnd = range?.createdLte;

    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const earliest = startOfMonth < rangeStart ? startOfMonth : rangeStart;
      let query = trx
        .selectFrom("airtime_orders")
        .select(["status", "created_at as createdAt", "charge_amount as chargeAmount"])
        .where("merchant_id", "=", merchantId)
        .where("mode", "=", mode)
        .where("created_at", ">=", earliest);

      if (rangeEnd) {
        query = query.where("created_at", "<=", rangeEnd);
      }

      const rows = await query.execute();
      const tally = (start: Date, end?: Date) => {
        const matched = rows.filter(
          (row) => row.createdAt >= start && (!end || row.createdAt <= end)
        );
        const count = (status: AirtimeOrderStatus) =>
          matched.filter((row) => row.status === status).length;
        const successfulCharge = matched
          .filter((row) => row.status === "successful")
          .reduce((sum, row) => sum + BigInt(row.chargeAmount), 0n);
        const total = matched.length;

        return {
          failed: count("failed"),
          pending: count("pending") + count("processing"),
          sent: total,
          spendMinor: successfulCharge,
          successRate: total === 0 ? null : count("successful") / total,
          successful: count("successful")
        };
      };

      const today = tally(startOfDay);
      const month = tally(startOfMonth);
      const filtered = tally(rangeStart, rangeEnd);

      return {
        failed: filtered.failed,
        failedToday: today.failed,
        pending: filtered.pending,
        sent: filtered.sent,
        sentToday: today.sent,
        spendMinor: filtered.spendMinor,
        spentThisMonthMinor: month.spendMinor,
        spentTodayMinor: today.spendMinor,
        successRate: filtered.successRate,
        successful: filtered.successful,
        successfulToday: today.successful
      };
    });
  }

  async processPendingOrders(limit = 100): Promise<number> {
    const rows = await runWithSystemScope(
      this.#database,
      "load pending airtime orders",
      async (trx) =>
        trx
          .selectFrom("airtime_orders as orders")
          .innerJoin("merchants as merchant", (join) =>
            join
              .onRef("merchant.id", "=", "orders.merchant_id")
              .onRef("merchant.mode", "=", "orders.mode")
          )
          .select(["orders.id as id", "orders.merchant_id as merchantId", "orders.mode as mode"])
          .where("orders.status", "=", "pending")
          .where("orders.send_attempts", "=", 0)
          .where("merchant.status", "not in", ["suspended", "closed"])
          .orderBy("orders.created_at")
          .limit(limit)
          .execute(),
      { audit: false }
    );

    for (const row of rows) {
      await this.dispatchOrder(row.merchantId, row.mode, row.id);
    }

    return rows.length;
  }

  async dispatchOrder(merchantId: string, mode: RpMode, orderId: string): Promise<void> {
    const providers = this.#requireProviders();
    const snapshot = await this.#readOrder(merchantId, mode, orderId);
    if (snapshot.status !== "pending" || snapshot.sendAttempts > 0) {
      return;
    }

    const channels = await this.#routableChannels(snapshot.countryCode, snapshot.network, mode);
    if (channels.length === 0) {
      await runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
        const order = await this.#lockOrder(trx, merchantId, mode, orderId);
        if (order.status === "pending" && order.sendAttempts === 0) {
          await this.#finalizeFailed(trx, order, "airtime_unavailable", null, new Date());
        }
      });
      return;
    }

    // Commit the claim before calling the provider: if the process dies mid-call
    // the order is already "processing" and is resolved by polling, not resent.
    const claimed = await runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const order = await this.#lockOrder(trx, merchantId, mode, orderId);
      if (order.status !== "pending" || order.sendAttempts > 0) {
        return null;
      }

      assertAirtimeTransition(order.status, "processing");
      await trx
        .updateTable("airtime_orders")
        .set({
          channel_id: channels[0]!.id,
          next_status_check_at: new Date(Date.now() + 60_000),
          send_attempts: 1,
          status: "processing"
        })
        .where("id", "=", order.id)
        .where("merchant_id", "=", merchantId)
        .where("mode", "=", mode)
        .execute();
      await this.#writeTransactionEvents(trx, { id: merchantId, mode }, [
        { fromStatus: "pending", orderId: order.id, toStatus: "processing" }
      ]);

      return order;
    });

    if (!claimed) {
      return;
    }

    let result: ProviderResult = {
      outcome: "unknown",
      providerStatus: "unknown",
      rawRedacted: null
    };

    for (const [attempt, channel] of channels.entries()) {
      if (attempt > 0) {
        await runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
          await trx
            .updateTable("airtime_orders")
            .set({ channel_id: channel.id, send_attempts: attempt + 1 })
            .where("id", "=", orderId)
            .where("merchant_id", "=", merchantId)
            .where("mode", "=", mode)
            .execute();
        });
      }

      try {
        result = await providers.resolveAirtimeProvider(channel).sendAirtime({
          amount: Number(claimed.amount),
          context: { merchantId, mode, requestId: orderId },
          currency: claimed.currency,
          metadata: claimed.metadata,
          msisdn: claimed.phone,
          network: claimed.network,
          reference: orderId
        });
      } catch {
        result = { outcome: "unknown", providerStatus: "adapter_error", rawRedacted: null };
      }

      if (result.providerStatus !== airtimeNotSentStatus) {
        break;
      }
    }

    await runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const order = await this.#lockOrder(trx, merchantId, mode, orderId);
      await this.#applyResult(trx, order, result, { recordStatusCheck: false });
    });
  }

  async pollDueStatusChecks(limit = 50): Promise<number> {
    const providers = this.#requireProviders();
    const now = new Date();
    const rows = await runWithSystemScope(
      this.#database,
      "load due airtime status checks",
      async (trx) =>
        trx
          .selectFrom("airtime_orders as orders")
          .innerJoin("channels as channel", "channel.id", "orders.channel_id")
          .select([
            "orders.id as id",
            "orders.merchant_id as merchantId",
            "orders.mode as mode",
            "orders.provider_ref as providerRef",
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
          .where("orders.status", "=", "processing")
          .where("orders.next_status_check_at", "<=", now)
          .orderBy("orders.next_status_check_at")
          .limit(limit)
          .execute(),
      { audit: false }
    );

    for (const row of rows) {
      const channel: ChannelRecord = {
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
      };

      let result: ProviderResult;
      try {
        result = await providers
          .resolveAirtimeProvider(channel)
          .getStatus(row.providerRef ?? row.id);
      } catch {
        result = { outcome: "unknown", providerStatus: "adapter_error", rawRedacted: null };
      }

      await runWithMerchantScope(this.#database, row.merchantId, row.mode, async (trx) => {
        const order = await this.#lockOrder(trx, row.merchantId, row.mode, row.id);
        await this.#applyResult(trx, order, result, { recordStatusCheck: true });
      });
    }

    return rows.length;
  }

  async applyProviderCallback(input: {
    orderId: string;
    providerRef?: string;
    providerStatus: string;
    reason?: string;
  }) {
    const context = await runWithSystemScope(
      this.#database,
      "lookup airtime order context",
      async (trx) =>
        trx
          .selectFrom("airtime_orders")
          .select(["merchant_id as merchantId", "mode"])
          .where("id", "=", input.orderId)
          .executeTakeFirst(),
      { audit: false }
    );

    if (!context) {
      throw apiError("not_found");
    }

    await runWithMerchantScope(this.#database, context.merchantId, context.mode, async (trx) => {
      const order = await this.#lockOrder(trx, context.merchantId, context.mode, input.orderId);
      const outcome = mapProviderStatusTextToOutcome(input.providerStatus);
      await this.#applyResult(
        trx,
        order,
        {
          ...(outcome === "failed" ? { failureCode: "provider_error" } : {}),
          outcome,
          ...(input.providerRef ? { providerRef: input.providerRef } : {}),
          providerStatus: input.providerStatus,
          rawRedacted: null
        },
        { recordStatusCheck: false }
      );
    });
  }

  async #applyResult(
    trx: ScopedTransaction,
    order: AirtimeOrderRecord,
    result: ProviderResult,
    options: { recordStatusCheck: boolean }
  ) {
    if (isAirtimeTerminalStatus(order.status)) {
      return;
    }

    const now = new Date();
    const providerRef = result.providerRef ?? order.providerRef;
    const target = mapProviderOutcomeToAirtimeStatus(result.outcome);

    if (target === "successful") {
      await this.#finalizeSuccessful(trx, order, providerRef, now);
      return;
    }

    if (target === "failed") {
      await this.#finalizeFailed(trx, order, result.failureCode ?? "provider_error", providerRef, now);
      return;
    }

    const attempts = order.statusCheckAttempts + (options.recordStatusCheck ? 1 : 0);
    await trx
      .updateTable("airtime_orders")
      .set({
        ...(options.recordStatusCheck
          ? { last_status_check_at: now, status_check_attempts: attempts }
          : {}),
        next_status_check_at: new Date(now.getTime() + nextStatusCheckDelayMs(attempts)),
        provider_ref: providerRef
      })
      .where("id", "=", order.id)
      .where("merchant_id", "=", order.merchantId)
      .where("mode", "=", order.mode)
      .execute();
  }

  async #finalizeSuccessful(
    trx: ScopedTransaction,
    order: AirtimeOrderRecord,
    providerRef: string | null,
    now: Date
  ) {
    if (order.status !== "processing" || !order.channelId) {
      return;
    }

    assertAirtimeTransition(order.status, "successful");
    await ledgerFor(trx, order.createdBy, "system").completeAirtime({
      airtimeReference: order.id,
      amount: order.chargeAmount,
      channelId: order.channelId,
      currency: order.chargeCurrency,
      merchantId: order.merchantId,
      mode: order.mode,
      providerCostAmount: order.amount - order.discountMinor,
      providerCostCurrency: order.currency
    });

    await trx
      .updateTable("airtime_orders")
      .set({
        completed_at: now,
        next_status_check_at: null,
        provider_ref: providerRef,
        status: "successful"
      })
      .where("id", "=", order.id)
      .where("merchant_id", "=", order.merchantId)
      .where("mode", "=", order.mode)
      .execute();

    const updated = { ...order, completedAt: now, providerRef, status: "successful" as const };
    await this.#writeTransactionEvents(trx, { id: order.merchantId, mode: order.mode }, [
      { fromStatus: order.status, orderId: order.id, providerRef, toStatus: "successful" }
    ]);
    await this.#writeOrderEvent(trx, updated);
    await this.#refreshBatch(trx, order);
  }

  async #finalizeFailed(
    trx: ScopedTransaction,
    order: AirtimeOrderRecord,
    failureCode: string,
    providerRef: string | null,
    now: Date
  ) {
    if (isAirtimeTerminalStatus(order.status)) {
      return;
    }

    assertAirtimeTransition(order.status, "failed");
    await ledgerFor(trx, order.createdBy, "system").releaseAirtimeHold({
      airtimeReference: order.id,
      amount: order.chargeAmount,
      currency: order.chargeCurrency,
      merchantId: order.merchantId,
      mode: order.mode
    });

    await trx
      .updateTable("airtime_orders")
      .set({
        completed_at: now,
        failure_code: failureCode,
        next_status_check_at: null,
        provider_ref: providerRef,
        status: "failed"
      })
      .where("id", "=", order.id)
      .where("merchant_id", "=", order.merchantId)
      .where("mode", "=", order.mode)
      .execute();

    const updated = {
      ...order,
      completedAt: now,
      failureCode,
      providerRef,
      status: "failed" as const
    };
    await this.#writeTransactionEvents(trx, { id: order.merchantId, mode: order.mode }, [
      {
        fromStatus: order.status,
        orderId: order.id,
        providerRef,
        reason: failureCode,
        toStatus: "failed"
      }
    ]);
    await this.#writeOrderEvent(trx, updated);
    await this.#refreshBatch(trx, order);
  }

  async #refreshBatch(trx: ScopedTransaction, order: AirtimeOrderRecord) {
    if (!order.batchId) {
      return;
    }

    const batch = await trx
      .selectFrom("airtime_batches")
      .selectAll()
      .where("id", "=", order.batchId)
      .where("merchant_id", "=", order.merchantId)
      .where("mode", "=", order.mode)
      .forUpdate()
      .executeTakeFirst();

    if (!batch) {
      return;
    }

    const counts = await trx
      .selectFrom("airtime_orders")
      .select((eb) => ["status", eb.fn.count<string>("id").as("count")])
      .where("batch_id", "=", order.batchId)
      .where("merchant_id", "=", order.merchantId)
      .where("mode", "=", order.mode)
      .groupBy("status")
      .execute();

    const countFor = (status: AirtimeOrderStatus) =>
      Number(counts.find((row) => row.status === status)?.count ?? "0");
    const successful = countFor("successful");
    const failed = countFor("failed");
    const done = successful + failed >= batch.accepted;
    const becameComplete = done && batch.status !== "completed";

    const updated = await trx
      .updateTable("airtime_batches")
      .set({
        failed,
        successful,
        ...(becameComplete ? { completed_at: new Date(), status: "completed" as const } : {})
      })
      .where("id", "=", batch.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (becameComplete) {
      await this.#writeBatchCompletedEvent(trx, mapBatch(updated));
    }
  }

  async #writeOrderEvent(trx: ScopedTransaction, order: AirtimeOrderRecord) {
    const type = airtimeEventTypeForStatus(order.status);
    if (!type) {
      return;
    }

    await trx
      .insertInto("events_outbox")
      .values({
        id: newId("evt_"),
        merchant_id: order.merchantId,
        mode: order.mode,
        payload: {
          airtime_id: order.id,
          amount: Number(order.amount),
          batch_id: order.batchId,
          charge_amount: Number(order.chargeAmount),
          charge_currency: order.chargeCurrency,
          currency: order.currency,
          failure_code: order.failureCode,
          network: order.network,
          phone: order.phone,
          provider_ref: order.providerRef,
          reference: order.reference,
          status: order.status
        },
        type
      })
      .execute();
  }

  async #writeBatchCompletedEvent(trx: ScopedTransaction, batch: AirtimeBatchRecord) {
    await trx
      .insertInto("events_outbox")
      .values({
        id: newId("evt_"),
        merchant_id: batch.merchantId,
        mode: batch.mode,
        payload: {
          accepted: batch.accepted,
          batch_id: batch.id,
          charge_currency: batch.chargeCurrency,
          failed: batch.failed,
          reference: batch.reference,
          rejected: batch.rejected,
          status: batch.status,
          successful: batch.successful,
          total_charge: Number(batch.totalCharge),
          total_items: batch.totalItems
        },
        type: airtimeBatchCompletedEvent
      })
      .execute();
  }

  async #writeTransactionEvents(
    trx: ScopedTransaction,
    merchant: { id: string; mode: RpMode },
    events: Array<{
      fromStatus?: AirtimeOrderStatus;
      orderId: string;
      providerRef?: string | null;
      reason?: string | null;
      toStatus: AirtimeOrderStatus;
    }>
  ) {
    for (let start = 0; start < events.length; start += bulkInsertChunkSize) {
      const chunk = events.slice(start, start + bulkInsertChunkSize);
      await trx
        .insertInto("transaction_events")
        .values(
          chunk.map((event) => ({
            created_at: new Date(),
            from_status: event.fromStatus ?? null,
            id: newId("evt_"),
            merchant_id: merchant.id,
            mode: merchant.mode,
            provider_payload: null,
            provider_reference: event.providerRef ?? null,
            reason: event.reason ?? null,
            resource_id: event.orderId,
            resource_type: "airtime",
            to_status: event.toStatus
          }))
        )
        .execute();
    }
  }

  async #maybeFlagVelocity(
    trx: ScopedTransaction,
    merchant: AirtimeMerchantContext,
    limits: AirtimeMerchantLimits,
    entries: Array<{ count: number; orderId: string; phone: string }>
  ) {
    for (const entry of entries) {
      if (entry.count <= limits.velocityPerNumber) {
        continue;
      }

      const alreadyFlagged = await trx
        .selectFrom("compliance_review_flags")
        .select("id")
        .where("merchant_id", "=", merchant.id)
        .where("mode", "=", merchant.mode)
        .where("rule_code", "=", "airtime.number_velocity")
        .where("status", "=", "open")
        .where("created_at", ">=", startOfUtcDay())
        .where(sql<string>`payload->>'phone_masked'`, "=", maskPhone(entry.phone))
        .executeTakeFirst();

      if (alreadyFlagged) {
        continue;
      }

      await this.#complianceService.recordReviewFlag(trx, {
        merchantId: merchant.id,
        mode: merchant.mode,
        payload: {
          count_today: entry.count,
          phone_masked: maskPhone(entry.phone),
          threshold: limits.velocityPerNumber
        },
        resourceId: entry.orderId,
        resourceType: "airtime",
        ruleCode: "airtime.number_velocity",
        summary: `Airtime velocity threshold exceeded for ${maskPhone(entry.phone)}`
      });
    }
  }

  async #prepareQuote(
    merchant: AirtimeMerchantContext,
    reference: AirtimeReferenceData,
    rawPhone: string,
    amount: bigint,
    currency: CurrencyCode | null,
    conversionCache?: Map<string, Promise<{ amountMinor: bigint; fxRateId: string }>>,
    requestedNetwork?: string | null
  ): Promise<AirtimeQuote> {
    const { countryCode, phone } = parseRecipientPhone(rawPhone, merchant.countryCode);

    const prefixNetwork = reference.prefixes.find(
      (entry) => entry.countryCode === countryCode && phone.slice(1).startsWith(entry.prefix)
    )?.network;
    const resolvedNetwork = requestedNetwork?.trim()
      ? requestedNetwork.trim().toUpperCase()
      : prefixNetwork?.toUpperCase();
    const network = resolvedNetwork
      ? reference.networks.get(networkKey(countryCode, resolvedNetwork))
      : undefined;

    if (!network || !network.active) {
      throw new ApiRouteError({
        code: "network_not_supported",
        field: "phone",
        message: resolvedNetwork
          ? `Airtime is not available for ${resolvedNetwork} in ${countryCode}.`
          : "The mobile network for this number is not supported.",
        statusCode: getErrorDefinition("network_not_supported").status
      });
    }

    if (currency && currency !== network.currency) {
      throw new ApiRouteError({
        code: "amount_not_allowed",
        field: "currency",
        message: `Airtime for ${network.network} ${countryCode} is sold in ${network.currency}.`,
        statusCode: getErrorDefinition("amount_not_allowed").status
      });
    }

    const denominationAllowed =
      !network.fixedDenominations || network.fixedDenominations.includes(Number(amount));
    if (amount < network.minMinor || amount > network.maxMinor || !denominationAllowed) {
      throw new ApiRouteError({
        code: "amount_not_allowed",
        field: "amount",
        message: network.fixedDenominations
          ? `Allowed amounts for ${network.network} ${countryCode}: ${network.fixedDenominations.join(", ")}.`
          : `Amount must be between ${network.minMinor} and ${network.maxMinor} ${network.currency} minor units.`,
        statusCode: getErrorDefinition("amount_not_allowed").status
      });
    }

    const discountBps =
      reference.discounts.get(networkKey(countryCode, network.network)) ?? 0;
    const discountMinor = (amount * BigInt(discountBps)) / 10_000n;
    const netFaceValue = amount - discountMinor;
    const cacheKey = `${network.currency}:${merchant.settlementCurrency}:${netFaceValue}`;
    let conversion = conversionCache?.get(cacheKey);
    if (!conversion) {
      conversion = this.#fx.convert(netFaceValue, network.currency, merchant.settlementCurrency);
      conversionCache?.set(cacheKey, conversion);
    }
    const converted = await conversion;

    return {
      amount,
      chargeAmount: converted.amountMinor,
      chargeCurrency: merchant.settlementCurrency,
      countryCode,
      currency: network.currency,
      discountBps,
      discountMinor,
      fxRateId: network.currency === merchant.settlementCurrency ? null : converted.fxRateId,
      network: network.network,
      phone
    };
  }

  async #loadActiveMerchantWithProduct(
    merchantId: string,
    mode: RpMode,
    options: { allowInactive?: boolean } = {}
  ): Promise<AirtimeMerchantContext> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const row = await trx
        .selectFrom("merchants")
        .select([
          "country_code as countryCode",
          "id",
          "mode",
          "settlement_currency as settlementCurrency",
          "status"
        ])
        .where("id", "=", merchantId)
        .where("mode", "=", mode)
        .executeTakeFirst();

      if (!row) {
        throw apiError("not_found");
      }

      const merchant: AirtimeMerchantContext = {
        ...row,
        settlementCurrency: parseCurrencyCode(row.settlementCurrency)
      };

      if (!options.allowInactive && !merchantCanSend(merchant)) {
        throw apiError("merchant_suspended");
      }

      await requireProduct(trx, { merchantId, mode }, "airtime");
      return merchant;
    });
  }

  async #loadReferenceData(merchant: AirtimeMerchantContext): Promise<AirtimeReferenceData> {
    return runWithSystemScope(
      this.#database,
      "load airtime reference data",
      async (trx) => {
        const [networks, prefixes, plans] = await Promise.all([
          trx.selectFrom("airtime_networks").selectAll().execute(),
          trx
            .selectFrom("msisdn_prefixes")
            .select(["country_code as countryCode", "network", "prefix"])
            .execute(),
          trx
            .selectFrom("airtime_discount_plans")
            .selectAll()
            .where("active", "=", true)
            .where((eb) =>
              eb.or([
                eb("merchant_id", "is", null),
                eb.and([eb("merchant_id", "=", merchant.id), eb("mode", "=", merchant.mode)])
              ])
            )
            .execute()
        ]);

        const discounts = new Map<string, number>();
        for (const plan of plans.filter((entry) => entry.merchant_id === null)) {
          discounts.set(networkKey(plan.country_code, plan.network), plan.discount_bps);
        }
        for (const plan of plans.filter((entry) => entry.merchant_id !== null)) {
          discounts.set(networkKey(plan.country_code, plan.network), plan.discount_bps);
        }

        const networkMap = new Map<string, AirtimeNetworkRecord>();
        for (const row of networks) {
          if (!(row.currency in CURRENCIES)) {
            continue;
          }
          const key = networkKey(row.country_code, row.network);
          networkMap.set(key, {
            active: row.active,
            countryCode: row.country_code,
            currency: parseCurrencyCode(row.currency),
            discountBps: discounts.get(key) ?? 0,
            fixedDenominations: row.fixed_denominations,
            maxMinor: BigInt(row.max_minor),
            minMinor: BigInt(row.min_minor),
            network: row.network
          });
        }

        return {
          discounts,
          networks: networkMap,
          prefixes: prefixes.sort((left, right) => right.prefix.length - left.prefix.length)
        };
      },
      { audit: false }
    );
  }

  async #routableChannels(
    countryCode: string,
    network: string,
    mode: RpMode
  ): Promise<ChannelRecord[]> {
    if (mode === "test") {
      const simulator = await this.#registry.getSimulatorChannel({
        capability: "airtime",
        kind: "airtime"
      });
      return simulator ? [simulator] : [];
    }

    const candidates = (
      await this.#registry.listChannels({ countryCode, kind: "airtime", mode, network })
    ).filter(
      (channel) =>
        channel.status === "active" &&
        channel.health !== "down" &&
        channel.capabilities.includes("airtime")
    );

    if (candidates.length === 0) {
      return [];
    }

    const emptyFloats = await runWithSystemScope(
      this.#database,
      "load empty airtime floats",
      async (trx) =>
        trx
          .selectFrom("airtime_channel_floats")
          .select("channel_id")
          .where("status", "=", "empty")
          .where(
            "channel_id",
            "in",
            candidates.map((channel) => channel.id)
          )
          .execute(),
      { audit: false }
    );
    const empty = new Set(emptyFloats.map((row) => row.channel_id));
    const usable = candidates.filter((channel) => !empty.has(channel.id));

    const rule = await this.#registry.loadRoutingRule({
      capability: "airtime",
      countryCode,
      kind: "airtime",
      network
    });
    const ruleOrder = new Map((rule?.channelIds ?? []).map((id, index) => [id, index]));

    return usable.sort((left, right) => {
      const leftRule = ruleOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRule = ruleOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftRule !== rightRule) return leftRule - rightRule;
      if (left.health !== right.health) return left.health === "healthy" ? -1 : 1;
      return left.priority - right.priority;
    });
  }

  async #assertReferenceAvailable(
    trx: ScopedTransaction,
    merchant: AirtimeMerchantContext,
    reference: string | null
  ) {
    if (!reference) {
      return;
    }

    const existing = await trx
      .selectFrom("airtime_orders")
      .select("id")
      .where("merchant_id", "=", merchant.id)
      .where("mode", "=", merchant.mode)
      .where("reference", "=", reference)
      .where("batch_id", "is", null)
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

  async #availableBalance(
    trx: ScopedTransaction,
    merchant: AirtimeMerchantContext,
    currency: CurrencyCode
  ): Promise<bigint> {
    const row = await trx
      .selectFrom("ledger_accounts as account")
      .innerJoin("account_balances as balance", "balance.account_id", "account.id")
      .select("balance.balance")
      .where("account.merchant_id", "=", merchant.id)
      .where("account.mode", "=", merchant.mode)
      .where("account.type", "=", "merchant_available")
      .where("account.currency", "=", currency)
      .executeTakeFirst();

    return BigInt(row?.balance ?? "0");
  }

  async #loadLimits(
    trx: ScopedTransaction,
    merchant: AirtimeMerchantContext
  ): Promise<AirtimeMerchantLimits> {
    const row = await trx
      .selectFrom("merchant_compliance_profiles")
      .select([
        "airtime_merchant_daily_cap_minor",
        "airtime_number_daily_cap_minor",
        "airtime_velocity_per_number"
      ])
      .where("merchant_id", "=", merchant.id)
      .where("mode", "=", merchant.mode)
      .executeTakeFirst();

    return {
      merchantDailyCapMinor: row?.airtime_merchant_daily_cap_minor
        ? BigInt(row.airtime_merchant_daily_cap_minor)
        : defaultAirtimeLimits.merchantDailyCapMinor,
      numberDailyCapMinor: row?.airtime_number_daily_cap_minor
        ? BigInt(row.airtime_number_daily_cap_minor)
        : defaultAirtimeLimits.numberDailyCapMinor,
      velocityPerNumber: row?.airtime_velocity_per_number ?? defaultAirtimeLimits.velocityPerNumber
    };
  }

  async #loadUsageToday(
    trx: ScopedTransaction,
    merchant: AirtimeMerchantContext,
    currency: CurrencyCode,
    phones: string[]
  ): Promise<AirtimeUsage> {
    const startOfDay = startOfUtcDay();
    const base = trx
      .selectFrom("airtime_orders")
      .where("merchant_id", "=", merchant.id)
      .where("mode", "=", merchant.mode)
      .where("charge_currency", "=", currency)
      .where("status", "!=", "failed")
      .where("created_at", ">=", startOfDay);

    const total = await base
      .select((eb) => eb.fn.sum<string>("charge_amount").as("total"))
      .executeTakeFirst();

    const perPhone = new Map<string, { amount: bigint; count: number }>();
    for (let start = 0; start < phones.length; start += bulkInsertChunkSize) {
      const chunk = phones.slice(start, start + bulkInsertChunkSize);
      const rows = await base
        .select((eb) => [
          "phone",
          eb.fn.sum<string>("charge_amount").as("amount"),
          eb.fn.count<string>("id").as("count")
        ])
        .where("phone", "in", chunk)
        .groupBy("phone")
        .execute();

      for (const row of rows) {
        perPhone.set(row.phone, { amount: BigInt(row.amount ?? "0"), count: Number(row.count) });
      }
    }

    return { merchantTotal: BigInt(total?.total ?? "0"), perPhone };
  }

  async #readOrder(merchantId: string, mode: RpMode, orderId: string) {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const row = await trx
        .selectFrom("airtime_orders")
        .select(orderColumns)
        .where("id", "=", orderId)
        .where("merchant_id", "=", merchantId)
        .where("mode", "=", mode)
        .executeTakeFirst();

      if (!row) {
        throw apiError("not_found");
      }

      return mapOrder(row);
    });
  }

  async #lockOrder(
    trx: ScopedTransaction,
    merchantId: string,
    mode: RpMode,
    orderId: string
  ): Promise<AirtimeOrderRecord> {
    const row = await trx
      .selectFrom("airtime_orders")
      .select(orderColumns)
      .where("id", "=", orderId)
      .where("merchant_id", "=", merchantId)
      .where("mode", "=", mode)
      .forUpdate()
      .executeTakeFirst();

    if (!row) {
      throw apiError("not_found");
    }

    return mapOrder(row);
  }

  #requireProviders(): AirtimeProviderSource {
    if (!this.#providers) {
      throw new Error("Provider catalog is required for airtime processing");
    }

    return this.#providers;
  }
}

function merchantCanSend(merchant: AirtimeMerchantContext) {
  return merchantCanTransact({ mode: merchant.mode, status: merchant.status });
}

function parseRecipientPhone(rawPhone: string, merchantCountry: string) {
  const trimmed = rawPhone.trim();
  const defaultCountry = /^[A-Z]{2}$/.test(merchantCountry)
    ? (merchantCountry as CountryCode)
    : undefined;

  try {
    const parsed = parsePhoneNumberWithError(trimmed, defaultCountry);
    if (!parsed.isValid() || !parsed.country) {
      throw invalidPhoneError();
    }

    return { countryCode: parsed.country, phone: parsed.number };
  } catch (error) {
    if (error instanceof ParseError) {
      throw invalidPhoneError();
    }

    throw error;
  }
}

function invalidPhoneError() {
  return new ApiRouteError({
    code: "invalid_phone_number",
    field: "phone",
    message: "Phone must be a valid mobile number in international format, e.g. +260970000001.",
    statusCode: getErrorDefinition("invalid_phone_number").status
  });
}

function checkLimits(
  limits: AirtimeMerchantLimits,
  usage: AirtimeUsage,
  phone: string,
  chargeAmount: bigint
): ApiRouteError | null {
  const phoneTotal = usage.perPhone.get(phone)?.amount ?? 0n;
  if (phoneTotal + chargeAmount > limits.numberDailyCapMinor) {
    return new ApiRouteError({
      code: "amount_too_large",
      field: "phone",
      message: "This number has reached its daily airtime limit.",
      statusCode: getErrorDefinition("amount_too_large").status
    });
  }

  if (usage.merchantTotal + chargeAmount > limits.merchantDailyCapMinor) {
    return new ApiRouteError({
      code: "amount_too_large",
      field: "amount",
      message: "The merchant daily airtime limit has been reached.",
      statusCode: getErrorDefinition("amount_too_large").status
    });
  }

  return null;
}

function rejectionFromError(index: number, phone: string | null, error: unknown): AirtimeRejectedRow {
  if (error instanceof ApiRouteError) {
    return { code: error.code as ErrorCode, index, message: error.message, phone };
  }

  throw error;
}

function orderValues(
  merchant: AirtimeMerchantContext,
  quote: AirtimeQuote,
  input: { createdBy: string; metadata: Json; reference: string | null }
) {
  return {
    amount: quote.amount,
    channel_id: null,
    charge_amount: quote.chargeAmount,
    charge_currency: quote.chargeCurrency,
    country_code: quote.countryCode,
    created_at: new Date(),
    created_by: input.createdBy,
    currency: quote.currency,
    discount_minor: quote.discountMinor,
    fx_rate_id: quote.fxRateId,
    merchant_id: merchant.id,
    metadata: input.metadata,
    mode: merchant.mode,
    network: quote.network,
    phone: quote.phone,
    reference: input.reference,
    status: "pending" as const
  };
}

function ledgerFor(
  trx: ScopedTransaction,
  actorId: string,
  actorType: "api_key" | "system" | "user" = "api_key"
) {
  return new LedgerService(trx, { actorId, actorType });
}

function networkKey(countryCode: string, network: string) {
  return `${countryCode.toUpperCase()}:${network.toUpperCase()}`;
}

function startOfUtcDay() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function maskPhone(phone: string) {
  return phone.length <= 7 ? "***" : `${phone.slice(0, 5)}***${phone.slice(-3)}`;
}

function apiError(code: ErrorCode) {
  const definition = getErrorDefinition(code);
  return new ApiRouteError({ code, message: definition.message, statusCode: definition.status });
}

function mapOrder(row: {
  amount: string;
  batch_id: string | null;
  channel_id: string | null;
  charge_amount: string;
  charge_currency: string;
  completed_at: Date | null;
  country_code: string;
  created_at: Date;
  created_by: string;
  currency: string;
  discount_minor: string;
  failure_code: string | null;
  fx_rate_id: string | null;
  id: string;
  merchant_id: string;
  metadata: Json;
  mode: RpMode;
  network: string;
  phone: string;
  provider_ref: string | null;
  reference: string | null;
  send_attempts: number;
  status: AirtimeOrderStatus;
  status_check_attempts: number;
}): AirtimeOrderRecord {
  return {
    amount: BigInt(row.amount),
    batchId: row.batch_id,
    channelId: row.channel_id,
    chargeAmount: BigInt(row.charge_amount),
    chargeCurrency: parseCurrencyCode(row.charge_currency),
    completedAt: row.completed_at,
    countryCode: row.country_code,
    createdAt: row.created_at,
    createdBy: row.created_by,
    currency: parseCurrencyCode(row.currency),
    discountMinor: BigInt(row.discount_minor),
    failureCode: row.failure_code,
    fxRateId: row.fx_rate_id,
    id: row.id,
    merchantId: row.merchant_id,
    metadata: row.metadata,
    mode: row.mode,
    network: row.network,
    phone: row.phone,
    providerRef: row.provider_ref,
    reference: row.reference,
    sendAttempts: row.send_attempts,
    status: row.status,
    statusCheckAttempts: row.status_check_attempts
  };
}

function mapBatch(row: {
  accepted: number;
  charge_currency: string;
  completed_at: Date | null;
  created_at: Date;
  created_by: string;
  failed: number;
  id: string;
  merchant_id: string;
  mode: RpMode;
  reference: string | null;
  rejected: number;
  rejected_rows: Json;
  status: "completed" | "processing";
  successful: number;
  total_charge: string;
  total_items: number;
}): AirtimeBatchRecord {
  return {
    accepted: row.accepted,
    chargeCurrency: parseCurrencyCode(row.charge_currency),
    completedAt: row.completed_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    failed: row.failed,
    id: row.id,
    merchantId: row.merchant_id,
    mode: row.mode,
    reference: row.reference,
    rejected: row.rejected,
    rejectedRows: (Array.isArray(row.rejected_rows) ? row.rejected_rows : []) as unknown as AirtimeRejectedRow[],
    status: row.status,
    successful: row.successful,
    totalCharge: BigInt(row.total_charge),
    totalItems: row.total_items
  };
}
