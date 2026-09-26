import { describe, expect, it } from "vitest";

import { FeeService } from "../src/pricing/fee-service";
import { FxService } from "../src/pricing/fx-service";
import type { PricingRepository } from "../src/pricing/repository";

import type {
  FeePlanRecord,
  FxRateRecord,
  MerchantFeeOverrideRecord,
  PricingMerchantContext,
  SmsPriceRecord
} from "../src/pricing/types";

class InMemoryPricingRepository implements PricingRepository {
  feePlans: FeePlanRecord[] = [];
  fxRates: FxRateRecord[] = [];
  merchantOverrides: MerchantFeeOverrideRecord[] = [];

  async findActiveFeePlan(input: {
    countryCode: string;
    currency: "GHS" | "USD" | "ZMW";
    kind: FeePlanRecord["kind"];
    method: FeePlanRecord["method"];
    network: string | null;
  }): Promise<FeePlanRecord | null> {
    return (
      this.feePlans.find((plan) =>
        plan.active &&
        plan.countryCode === input.countryCode &&
        plan.currency === input.currency &&
        plan.kind === input.kind &&
        plan.method === input.method &&
        plan.network === input.network
      ) ??
      this.feePlans.find((plan) =>
        plan.active &&
        plan.countryCode === input.countryCode &&
        plan.currency === input.currency &&
        plan.kind === input.kind &&
        plan.method === input.method &&
        plan.network === null
      ) ??
      null
    );
  }

  async findActiveFxRate(input: {
    base: "GHS" | "USD" | "ZMW";
    quote: "GHS" | "USD" | "ZMW";
  }): Promise<FxRateRecord | null> {
    return (
      this.fxRates.find((rate) =>
        rate.active &&
        rate.base === input.base &&
        rate.quote === input.quote
      ) ?? null
    );
  }

  async findActiveMerchantFeeOverride(input: {
    currency: "GHS" | "USD" | "ZMW";
    kind: MerchantFeeOverrideRecord["kind"];
    merchantId: string;
    method: MerchantFeeOverrideRecord["method"];
    mode: MerchantFeeOverrideRecord["mode"];
    network: string | null;
  }): Promise<MerchantFeeOverrideRecord | null> {
    return (
      this.merchantOverrides.find((override) =>
        override.active &&
        override.currency === input.currency &&
        override.kind === input.kind &&
        override.merchantId === input.merchantId &&
        override.method === input.method &&
        override.mode === input.mode &&
        override.network === input.network
      ) ??
      this.merchantOverrides.find((override) =>
        override.active &&
        override.currency === input.currency &&
        override.kind === input.kind &&
        override.merchantId === input.merchantId &&
        override.method === input.method &&
        override.mode === input.mode &&
        override.network === null
      ) ??
      null
    );
  }

  async listFeePlans(): Promise<FeePlanRecord[]> {
    return this.feePlans;
  }

  async listFxRates(): Promise<FxRateRecord[]> {
    return this.fxRates;
  }

  async listSmsPrices(): Promise<SmsPriceRecord[]> {
    return [];
  }
}

describe("pricing services", () => {
  const merchant: PricingMerchantContext = {
    countryCode: "GH",
    id: "mer_test",
    mode: "live",
    settlementCurrency: "GHS"
  };

  it("quotes percent plus fixed fees with integer math", async () => {
    const repository = new InMemoryPricingRepository();
    repository.feePlans = [
      buildFeePlan({
        feeBearer: "merchant",
        fixedMinor: 30n,
        percentBps: 250
      })
    ];

    const service = new FeeService(repository);
    await expect(
      service.quote(merchant, "collection", "mobile_money", null, 1000n, "GHS")
    ).resolves.toEqual({
      customerPaysMinor: 1000n,
      feeMinor: 55n,
      merchantReceivesMinor: 945n
    });
  });

  it("applies minimum and maximum fee caps", async () => {
    const repository = new InMemoryPricingRepository();
    repository.feePlans = [
      buildFeePlan({
        fixedMinor: 0n,
        id: "fpl_min",
        minMinor: 20n,
        percentBps: 10
      }),
      buildFeePlan({
        fixedMinor: 0n,
        id: "fpl_max",
        kind: "payout",
        maxMinor: 300n,
        method: "bank",
        percentBps: 1000
      })
    ];

    const service = new FeeService(repository);

    await expect(
      service.quote(merchant, "collection", "mobile_money", null, 1000n, "GHS")
    ).resolves.toMatchObject({
      feeMinor: 20n
    });

    await expect(
      service.quote(merchant, "payout", "bank", null, 5000n, "GHS")
    ).resolves.toMatchObject({
      feeMinor: 300n
    });
  });

  it("handles fee bearer both ways and breaks half-unit ties in the merchant's favour", async () => {
    const repository = new InMemoryPricingRepository();
    repository.feePlans = [
      buildFeePlan({
        feeBearer: "merchant",
        fixedMinor: 0n,
        id: "fpl_merchant_bearer",
        percentBps: 50
      }),
      buildFeePlan({
        feeBearer: "customer",
        fixedMinor: 0n,
        id: "fpl_customer_bearer",
        method: "card",
        percentBps: 50
      })
    ];

    const service = new FeeService(repository);

    await expect(
      service.quote(merchant, "collection", "mobile_money", null, 100n, "GHS")
    ).resolves.toEqual({
      customerPaysMinor: 100n,
      feeMinor: 0n,
      merchantReceivesMinor: 100n
    });

    await expect(
      service.quote(merchant, "collection", "card", null, 100n, "GHS")
    ).resolves.toEqual({
      customerPaysMinor: 101n,
      feeMinor: 1n,
      merchantReceivesMinor: 100n
    });
  });

  it("converts FX amounts with decimal math and half-up rounding", async () => {
    const repository = new InMemoryPricingRepository();
    repository.fxRates = [
      {
        active: true,
        base: "USD",
        capturedAt: new Date("2026-09-27T00:00:00.000Z"),
        id: "fxr_usd_ghs",
        markupBps: 0,
        quote: "GHS",
        rate: "1.5000000000",
        source: "manual"
      }
    ];

    const service = new FxService(repository);

    await expect(service.convert(1n, "USD", "GHS")).resolves.toEqual({
      amountMinor: 2n,
      fxRateId: "fxr_usd_ghs"
    });
  });
});

function buildFeePlan(
  input?: Partial<FeePlanRecord>
): FeePlanRecord {
  return {
    active: true,
    countryCode: "GH",
    currency: "GHS",
    feeBearer: "merchant",
    fixedMinor: 100n,
    id: "fpl_default",
    kind: "collection",
    maxMinor: null,
    method: "mobile_money",
    minMinor: 0n,
    name: "Default plan",
    network: null,
    percentBps: 100,
    ...input
  };
}
