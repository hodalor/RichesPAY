import type { CurrencyCode } from "@richespay/shared";

import type { RpMode } from "../db";

export const feePlanKinds = ["collection", "payout", "sms"] as const;
export const feeMethods = ["mobile_money", "card", "bank"] as const;
export const feeBearers = ["merchant", "customer"] as const;
export const fxRateSources = ["manual", "feed"] as const;

export type FeePlanKind = (typeof feePlanKinds)[number];
export type FeeMethod = (typeof feeMethods)[number];
export type FeeBearer = (typeof feeBearers)[number];
export type FxRateSource = (typeof fxRateSources)[number];

export interface FeePlanRecord {
  active: boolean;
  countryCode: string;
  currency: CurrencyCode;
  feeBearer: FeeBearer;
  fixedMinor: bigint;
  id: string;
  kind: FeePlanKind;
  maxMinor: bigint | null;
  method: FeeMethod;
  minMinor: bigint;
  name: string;
  network: string | null;
  percentBps: number;
}

export interface MerchantFeeOverrideRecord {
  active: boolean;
  currency: CurrencyCode;
  feeBearer: FeeBearer;
  fixedMinor: bigint;
  id: string;
  kind: FeePlanKind;
  maxMinor: bigint | null;
  merchantId: string;
  method: FeeMethod;
  minMinor: bigint;
  mode: RpMode;
  name: string;
  network: string | null;
  percentBps: number;
}

export interface SmsPriceRecord {
  countryCode: string;
  currency: CurrencyCode;
  network: string | null;
  pricePerSegmentMinor: bigint;
}

export interface FxRateRecord {
  active: boolean;
  base: CurrencyCode;
  capturedAt: Date;
  id: string;
  markupBps: number;
  quote: CurrencyCode;
  rate: string;
  source: FxRateSource;
}

export interface PricingMerchantContext {
  countryCode: string;
  id: string;
  mode: RpMode;
  settlementCurrency: CurrencyCode;
}

export interface FeeQuote {
  customerPaysMinor: bigint;
  feeMinor: bigint;
  merchantReceivesMinor: bigint;
}

export interface FxConversionQuote {
  amountMinor: bigint;
  fxRateId: string;
}
