import type { CurrencyCode } from "@richespay/shared";

import type { Json, RpMode } from "../db/types";
import type { CollectionNextAction } from "../collections/types";

export const topupMethods = ["mobile_money", "card", "bank_transfer"] as const;
export const topupStatuses = ["pending", "successful", "failed", "expired"] as const;

export type TopupMethod = (typeof topupMethods)[number];
export type TopupStatus = (typeof topupStatuses)[number];

export interface TopupRecord {
  amount: bigint;
  bankReference: string | null;
  collectionId: string | null;
  completedAt: Date | null;
  confirmedBy: string | null;
  createdAt: Date;
  currency: CurrencyCode;
  feeMinor: bigint;
  id: string;
  merchantId: string;
  method: TopupMethod;
  mode: RpMode;
  nextAction: CollectionNextAction | null;
  providerRef: string | null;
  status: TopupStatus;
}

export interface MerchantBalanceAlertThresholdRecord {
  createdAt: Date;
  currency: CurrencyCode;
  isBelowThreshold: boolean;
  merchantId: string;
  mode: RpMode;
  thresholdMinor: bigint;
  updatedAt: Date;
}

export interface CreateTopupInput {
  amountMinor: bigint;
  currency: CurrencyCode;
  merchantId: string;
  method: Extract<TopupMethod, "card" | "mobile_money">;
  mode: RpMode;
  network?: string | null;
  phone?: string | null;
  requestId: string;
}

export interface CreateBankTransferTopupInput {
  amountMinor: bigint;
  currency: CurrencyCode;
  merchantId: string;
  mode: RpMode;
}

export interface ConfirmBankTransferTopupInput {
  adminUserId: string;
  amountMinor?: bigint;
  bankStatementReference?: string | null;
  reason: string;
  topupId: string;
}

export interface ImportBankTransferRowInput {
  amountMinor: bigint;
  bankStatementReference: string;
  currency: CurrencyCode;
  merchantTransferReference: string;
}

export interface TopupPage {
  items: TopupRecord[];
  nextStartingAfter: string | null;
}

export interface TopupListFilters {
  createdGte?: Date;
  createdLte?: Date;
  method?: TopupMethod;
  startingAfter?: string;
  status?: TopupStatus;
}

export interface TopupSettingsView {
  thresholds: MerchantBalanceAlertThresholdRecord[];
  transferReference: string;
}

export interface CreateTopupResult {
  topup: TopupRecord;
}

export interface ImportBankTransferResult {
  matched: Array<{
    amountMinor: bigint;
    currency: CurrencyCode;
    merchantTransferReference: string;
    topupId: string;
  }>;
  unmatched: ImportBankTransferRowInput[];
}

export function parseTopupRecord(row: {
  amount: string;
  bank_reference: string | null;
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
  status: TopupStatus;
}, nextAction: CollectionNextAction | null = null): TopupRecord {
  if (!topupMethods.includes(row.method as TopupMethod)) {
    throw new Error(`Unsupported top-up method: ${row.method}`);
  }

  return {
    amount: BigInt(row.amount),
    bankReference: row.bank_reference,
    collectionId: row.source_collection_id,
    completedAt: row.completed_at,
    confirmedBy: row.confirmed_by,
    createdAt: row.created_at,
    currency: row.currency as CurrencyCode,
    feeMinor: BigInt(row.fee_minor),
    id: row.id,
    merchantId: row.merchant_id,
    method: row.method as TopupMethod,
    mode: row.mode,
    nextAction,
    providerRef: row.provider_ref,
    status: row.status
  };
}

export function parseThresholdRecord(row: {
  created_at: Date;
  currency: string;
  is_below_threshold: boolean;
  merchant_id: string;
  mode: RpMode;
  threshold_minor: string;
  updated_at: Date;
}): MerchantBalanceAlertThresholdRecord {
  return {
    createdAt: row.created_at,
    currency: row.currency as CurrencyCode,
    isBelowThreshold: row.is_below_threshold,
    merchantId: row.merchant_id,
    mode: row.mode,
    thresholdMinor: BigInt(row.threshold_minor),
    updatedAt: row.updated_at
  };
}

export function normalizeTopupMetadata(input: {
  bankReference?: string;
  topupId: string;
}): Json {
  return {
    topup_id: input.topupId,
    ...(input.bankReference ? { merchant_transfer_reference: input.bankReference } : {})
  };
}
