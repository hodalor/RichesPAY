import type { CurrencyCode } from "@richespay/shared";

import {
  runWithMerchantScope,
  runWithSystemScope,
  type AppDatabase,
  type ScopedTransaction
} from "../db";
import {
  parseCurrencyCode,
  type FeeMethod,
  type FeePlanKind,
  type FeePlanRecord,
  type FxRateRecord,
  type MerchantFeeOverrideRecord,
  type PricingMerchantContext,
  type SmsPriceRecord
} from "./types";

export interface PricingRepository {
  findActiveFeePlan(input: {
    countryCode: string;
    currency: CurrencyCode;
    kind: FeePlanKind;
    method: FeeMethod;
    network: string | null;
  }, trx?: ScopedTransaction): Promise<FeePlanRecord | null>;
  findActiveFxRate(input: {
    base: CurrencyCode;
    quote: CurrencyCode;
  }, trx?: ScopedTransaction): Promise<FxRateRecord | null>;
  findActiveMerchantFeeOverride(input: {
    currency: CurrencyCode;
    kind: FeePlanKind;
    merchantId: string;
    method: FeeMethod;
    mode: PricingMerchantContext["mode"];
    network: string | null;
  }, trx?: ScopedTransaction): Promise<MerchantFeeOverrideRecord | null>;
  listFeePlans(): Promise<FeePlanRecord[]>;
  listFxRates(): Promise<FxRateRecord[]>;
  listSmsPrices(): Promise<SmsPriceRecord[]>;
}

export class DatabasePricingRepository implements PricingRepository {
  #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  async findActiveFeePlan(
    input: {
      countryCode: string;
      currency: CurrencyCode;
      kind: FeePlanKind;
      method: FeeMethod;
      network: string | null;
    },
    trx?: ScopedTransaction
  ): Promise<FeePlanRecord | null> {
    const executor = async (queryTrx: ScopedTransaction) => {
      const exact = await this.#buildFeePlanQuery(queryTrx, input)
        .where("network", input.network ? "=" : "is", input.network ?? null)
        .executeTakeFirst();

      if (exact) {
        return mapFeePlan(exact);
      }

      if (input.network) {
        const fallback = await this.#buildFeePlanQuery(queryTrx, input)
          .where("network", "is", null)
          .executeTakeFirst();

        return fallback ? mapFeePlan(fallback) : null;
      }

      return null;
    };

    return trx
      ? executor(trx)
      : runWithSystemScope(
          this.#database,
          "load active fee plan",
          executor,
          { audit: false }
        );
  }

  async findActiveFxRate(
    input: {
      base: CurrencyCode;
      quote: CurrencyCode;
    },
    trx?: ScopedTransaction
  ): Promise<FxRateRecord | null> {
    const executor = async (queryTrx: ScopedTransaction) => {
      const row = await queryTrx
        .selectFrom("fx_rates")
        .selectAll()
        .where("base", "=", input.base)
        .where("quote", "=", input.quote)
        .where("active", "=", true)
        .orderBy("captured_at", "desc")
        .executeTakeFirst();

      return row ? mapFxRate(row) : null;
    };

    return trx
      ? executor(trx)
      : runWithSystemScope(
          this.#database,
          "load active fx rate",
          executor,
          { audit: false }
        );
  }

  async findActiveMerchantFeeOverride(
    input: {
      currency: CurrencyCode;
      kind: FeePlanKind;
      merchantId: string;
      method: FeeMethod;
      mode: PricingMerchantContext["mode"];
      network: string | null;
    },
    trx?: ScopedTransaction
  ): Promise<MerchantFeeOverrideRecord | null> {
    const executor = async (queryTrx: ScopedTransaction) => {
      let exactQuery = this.#buildMerchantOverrideQuery(queryTrx, input);
      exactQuery = input.network
        ? exactQuery.where("network", "=", input.network)
        : exactQuery.where("network", "is", null);

      const exact = await exactQuery.executeTakeFirst();
      if (exact) {
        return mapMerchantFeeOverride(exact);
      }

      if (input.network) {
        const fallback = await this.#buildMerchantOverrideQuery(queryTrx, input)
          .where("network", "is", null)
          .executeTakeFirst();

        return fallback ? mapMerchantFeeOverride(fallback) : null;
      }

      return null;
    };

    return trx
      ? executor(trx)
      : runWithMerchantScope(
          this.#database,
          input.merchantId,
          input.mode,
          executor
        );
  }

  async listFeePlans(): Promise<FeePlanRecord[]> {
    return runWithSystemScope(
      this.#database,
      "list fee plans",
      async (trx) =>
        (await trx.selectFrom("fee_plans").selectAll().orderBy("country_code").orderBy("name").execute()).map(mapFeePlan),
      { audit: false }
    );
  }

  async listFxRates(): Promise<FxRateRecord[]> {
    return runWithSystemScope(
      this.#database,
      "list fx rates",
      async (trx) =>
        (await trx
          .selectFrom("fx_rates")
          .selectAll()
          .orderBy("captured_at", "desc")
          .execute()).map(mapFxRate),
      { audit: false }
    );
  }

  async listSmsPrices(): Promise<SmsPriceRecord[]> {
    return runWithSystemScope(
      this.#database,
      "list sms prices",
      async (trx) =>
        (await trx.selectFrom("sms_prices").selectAll().orderBy("country_code").execute()).map(mapSmsPrice),
      { audit: false }
    );
  }

  #buildFeePlanQuery(
    trx: ScopedTransaction,
    input: {
      countryCode: string;
      currency: CurrencyCode;
      kind: FeePlanKind;
      method: FeeMethod;
      network: string | null;
    }
  ) {
    return trx
      .selectFrom("fee_plans")
      .selectAll()
      .where("country_code", "=", input.countryCode)
      .where("currency", "=", input.currency)
      .where("kind", "=", input.kind)
      .where("method", "=", input.method)
      .where("active", "=", true)
      .orderBy("created_at", "desc");
  }

  #buildMerchantOverrideQuery(
    trx: ScopedTransaction,
    input: {
      currency: CurrencyCode;
      kind: FeePlanKind;
      merchantId: string;
      method: FeeMethod;
      mode: PricingMerchantContext["mode"];
      network: string | null;
    }
  ) {
    return trx
      .selectFrom("merchant_fee_overrides")
      .selectAll()
      .where("merchant_id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .where("currency", "=", input.currency)
      .where("kind", "=", input.kind)
      .where("method", "=", input.method)
      .where("active", "=", true)
      .orderBy("created_at", "desc");
  }
}

function mapFeePlan(row: {
  active: boolean;
  country_code: string;
  currency: string;
  fee_bearer: FeePlanRecord["feeBearer"];
  fixed_minor: string;
  id: string;
  kind: FeePlanRecord["kind"];
  max_minor: string | null;
  method: FeePlanRecord["method"];
  min_minor: string;
  name: string;
  network: string | null;
  percent_bps: number;
}): FeePlanRecord {
  return {
    active: row.active,
    countryCode: row.country_code,
    currency: parseCurrencyCode(row.currency),
    feeBearer: row.fee_bearer,
    fixedMinor: BigInt(row.fixed_minor),
    id: row.id,
    kind: row.kind,
    maxMinor: row.max_minor === null ? null : BigInt(row.max_minor),
    method: row.method,
    minMinor: BigInt(row.min_minor),
    name: row.name,
    network: row.network,
    percentBps: row.percent_bps
  };
}

function mapMerchantFeeOverride(row: {
  active: boolean;
  currency: string;
  fee_bearer: MerchantFeeOverrideRecord["feeBearer"];
  fixed_minor: string;
  id: string;
  kind: MerchantFeeOverrideRecord["kind"];
  max_minor: string | null;
  merchant_id: string;
  method: MerchantFeeOverrideRecord["method"];
  min_minor: string;
  mode: MerchantFeeOverrideRecord["mode"];
  name: string;
  network: string | null;
  percent_bps: number;
}): MerchantFeeOverrideRecord {
  return {
    active: row.active,
    currency: parseCurrencyCode(row.currency),
    feeBearer: row.fee_bearer,
    fixedMinor: BigInt(row.fixed_minor),
    id: row.id,
    kind: row.kind,
    maxMinor: row.max_minor === null ? null : BigInt(row.max_minor),
    merchantId: row.merchant_id,
    method: row.method,
    minMinor: BigInt(row.min_minor),
    mode: row.mode,
    name: row.name,
    network: row.network,
    percentBps: row.percent_bps
  };
}

function mapSmsPrice(row: {
  country_code: string;
  currency: string;
  network: string | null;
  price_per_segment_minor: string;
}): SmsPriceRecord {
  return {
    countryCode: row.country_code,
    currency: parseCurrencyCode(row.currency),
    network: row.network,
    pricePerSegmentMinor: BigInt(row.price_per_segment_minor)
  };
}

function mapFxRate(row: {
  active: boolean;
  base: string;
  captured_at: Date;
  id: string;
  markup_bps: number;
  quote: string;
  rate: string;
  source: FxRateRecord["source"];
}): FxRateRecord {
  return {
    active: row.active,
    base: parseCurrencyCode(row.base),
    capturedAt: row.captured_at,
    id: row.id,
    markupBps: row.markup_bps,
    quote: parseCurrencyCode(row.quote),
    rate: row.rate,
    source: row.source
  };
}
