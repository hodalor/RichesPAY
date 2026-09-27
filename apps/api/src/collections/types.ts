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

export type CollectionStatus = (typeof collectionStatuses)[number];

export interface CollectionRecord {
  amount: bigint;
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
  method: "mobile_money";
  mode: RpMode;
  netMinor: bigint;
  network: string | null;
  nextStatusCheckAt: Date | null;
  phone: string;
  presentmentAmount: bigint | null;
  presentmentCurrency: CurrencyCode | null;
  providerRef: string | null;
  reference: string | null;
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
  currency: CurrencyCode;
  customerEmail: string | null;
  customerName: string | null;
  description: string | null;
  idempotencyKey: string | null;
  merchantId: string;
  metadata: Json;
  mode: RpMode;
  network: string | null;
  phone: string;
  reference: string | null;
  requestId: string;
}

export interface CollectionPage {
  items: CollectionRecord[];
  nextStartingAfter: string | null;
}
