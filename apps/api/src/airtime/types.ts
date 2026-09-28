import type { CurrencyCode, ErrorCode } from "@richespay/shared";

import type { Json, RpMode } from "../db/types";

export const airtimeOrderStatuses = ["pending", "processing", "successful", "failed"] as const;
export const airtimeBatchStatuses = ["processing", "completed"] as const;
export const airtimeFloatStatuses = ["ok", "low", "empty", "unknown"] as const;

export type AirtimeOrderStatus = (typeof airtimeOrderStatuses)[number];
export type AirtimeBatchStatus = (typeof airtimeBatchStatuses)[number];
export type AirtimeFloatStatus = (typeof airtimeFloatStatuses)[number];

export const maxAirtimeBulkRecipients = 5000;

export interface AirtimeOrderRecord {
  amount: bigint;
  batchId: string | null;
  channelId: string | null;
  chargeAmount: bigint;
  chargeCurrency: CurrencyCode;
  completedAt: Date | null;
  countryCode: string;
  createdAt: Date;
  createdBy: string;
  currency: CurrencyCode;
  discountMinor: bigint;
  failureCode: string | null;
  fxRateId: string | null;
  id: string;
  merchantId: string;
  metadata: Json;
  mode: RpMode;
  network: string;
  phone: string;
  providerRef: string | null;
  reference: string | null;
  sendAttempts: number;
  status: AirtimeOrderStatus;
  statusCheckAttempts: number;
}

export interface AirtimeRejectedRow {
  code: ErrorCode;
  index: number;
  message: string;
  phone: string | null;
}

export interface AirtimeBatchRecord {
  accepted: number;
  chargeCurrency: CurrencyCode;
  completedAt: Date | null;
  createdAt: Date;
  createdBy: string;
  failed: number;
  id: string;
  merchantId: string;
  mode: RpMode;
  reference: string | null;
  rejected: number;
  rejectedRows: AirtimeRejectedRow[];
  status: AirtimeBatchStatus;
  successful: number;
  totalCharge: bigint;
  totalItems: number;
}

export interface AirtimeQuote {
  amount: bigint;
  chargeAmount: bigint;
  chargeCurrency: CurrencyCode;
  countryCode: string;
  currency: CurrencyCode;
  discountBps: number;
  discountMinor: bigint;
  fxRateId: string | null;
  network: string;
  phone: string;
}

export interface AirtimeNetworkRecord {
  active: boolean;
  countryCode: string;
  currency: CurrencyCode;
  discountBps: number;
  fixedDenominations: number[] | null;
  maxMinor: bigint;
  minMinor: bigint;
  network: string;
}

export interface CreateAirtimeInput {
  amount: bigint;
  createdBy: string;
  currency: CurrencyCode;
  merchantId: string;
  metadata?: Json;
  mode: RpMode;
  network?: string | null;
  phone: string;
  reference?: string | null;
}

export interface AirtimeBulkItemInput {
  amount: number;
  currency?: CurrencyCode;
  metadata?: Json;
  network?: string;
  phone: string;
  reference?: string;
}

export interface AirtimeListFilters {
  batchId?: string;
  createdGte?: Date;
  createdLte?: Date;
  network?: string;
  phone?: string;
  startingAfter?: string;
  status?: AirtimeOrderStatus;
}

export interface AirtimeEventRecord {
  createdAt: Date;
  fromStatus: string | null;
  providerReference: string | null;
  reason: string | null;
  toStatus: string;
}

export interface AirtimeMerchantLimits {
  merchantDailyCapMinor: bigint;
  numberDailyCapMinor: bigint;
  velocityPerNumber: number;
}

export const defaultAirtimeLimits: AirtimeMerchantLimits = {
  merchantDailyCapMinor: 10_000_000n,
  numberDailyCapMinor: 100_000n,
  velocityPerNumber: 5
};
