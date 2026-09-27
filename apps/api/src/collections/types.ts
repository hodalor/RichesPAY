import type { CurrencyCode } from "@richespay/shared";

import type { Json, RpMode } from "../db/types";
import type { FeeBearer } from "../pricing/types";

export const collectionStatuses = [
  "pending",
  "processing",
  "successful",
  "failed",
  "expired",
  "reversed"
] as const;
export const refundStatuses = ["pending", "processing", "successful", "failed"] as const;

export type CollectionStatus = (typeof collectionStatuses)[number];
export type RefundStatus = (typeof refundStatuses)[number];
export type CollectionMethod = "mobile_money" | "card";
export type CollectionReferenceType = "collection" | "topup";

export interface CardDetails {
  brand: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  last4: string | null;
}

export interface CollectionNextAction {
  iframeUrl?: string;
  type: "hosted_fields" | "redirect_url";
  url?: string;
}

export interface CollectionRecord {
  amount: bigint;
  card: CardDetails | null;
  channelId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  currency: CurrencyCode;
  customerEmail: string | null;
  customerName: string | null;
  description: string | null;
  expiresAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
  feeBearer: FeeBearer;
  feeMinor: bigint;
  fxRateId: string | null;
  id: string;
  lastStatusCheckAt: Date | null;
  merchantId: string;
  metadata: Json;
  method: CollectionMethod;
  mode: RpMode;
  netMinor: bigint;
  network: string | null;
  nextAction: CollectionNextAction | null;
  nextStatusCheckAt: Date | null;
  phone: string | null;
  presentmentAmount: bigint | null;
  presentmentCurrency: CurrencyCode | null;
  providerRef: string | null;
  reference: string | null;
  referenceType: CollectionReferenceType;
  refundedMinor: bigint;
  status: CollectionStatus;
  statusCheckAttempts: number;
}

export interface CollectionListFilters {
  createdGte?: Date;
  createdLte?: Date;
  reference?: string;
  startingAfter?: string;
  status?: CollectionStatus;
}

export interface CreateCollectionInput {
  amountMinor: bigint;
  baseUrl?: string | null;
  cancelUrl?: string | null;
  currency: CurrencyCode;
  customerEmail: string | null;
  customerName: string | null;
  description: string | null;
  idempotencyKey: string | null;
  merchantId: string;
  metadata: Json;
  method: CollectionMethod;
  mode: RpMode;
  network: string | null;
  phone: string | null;
  returnUrl?: string | null;
  reference: string | null;
  referenceType?: CollectionReferenceType;
  requestId: string;
}

export interface CollectionPage {
  items: CollectionRecord[];
  nextStartingAfter: string | null;
}

export interface RefundRecord {
  amount: bigint;
  channelId: string | null;
  collectionId: string;
  completedAt: Date | null;
  createdAt: Date;
  currency: CurrencyCode;
  failureCode: string | null;
  failureMessage: string | null;
  id: string;
  merchantId: string;
  method: CollectionMethod;
  mode: RpMode;
  phone: string | null;
  providerRef: string | null;
  status: RefundStatus;
}
