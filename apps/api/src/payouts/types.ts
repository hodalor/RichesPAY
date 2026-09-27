import type { CurrencyCode } from "@richespay/shared";

import type { Json, PayoutBatchStatus, PayoutStatus, RpMode } from "../db/types";

export type PayoutMethod = "mobile_money" | "bank";
export type PayoutRecordStatus = PayoutStatus;
export type PayoutBatchRecordStatus = PayoutBatchStatus;

export interface PayoutRecord {
  accountName: string | null;
  accountNumber: string | null;
  amount: bigint;
  approvedBy: string | null;
  bankCode: string | null;
  batchId: string | null;
  channelId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  createdBy: string;
  currency: CurrencyCode;
  failureCode: string | null;
  failureMessage: string | null;
  feeMinor: bigint;
  id: string;
  merchantId: string;
  metadata: Json;
  method: PayoutMethod;
  mode: RpMode;
  narration: string | null;
  network: string | null;
  phone: string | null;
  providerRef: string | null;
  reference: string | null;
  sendAttempts: number;
  status: PayoutRecordStatus;
  statusCheckAttempts: number;
  totalHoldMinor: bigint;
}

export interface PayoutBatchRecord {
  approvedBy: string | null;
  completedAt: Date | null;
  createdAt: Date;
  createdBy: string;
  currency: CurrencyCode;
  id: string;
  itemCount: number;
  merchantId: string;
  metadata: Json;
  mode: RpMode;
  payouts: PayoutRecord[];
  reference: string | null;
  status: PayoutBatchRecordStatus;
  totalAmount: bigint;
  totalFeeMinor: bigint;
  totalHoldMinor: bigint;
  validationReport: Json;
}

export interface CreatePayoutInput {
  accountName: string | null;
  accountNumber: string | null;
  amountMinor: bigint;
  bankCode: string | null;
  createdBy: string;
  currency: CurrencyCode;
  idempotencyKey: string | null;
  merchantId: string;
  metadata: Json | null;
  method: PayoutMethod;
  mode: RpMode;
  narration: string | null;
  network: string | null;
  phone: string | null;
  reference: string | null;
  requestId: string;
}

export interface CreatePayoutBatchItemInput {
  accountName?: string;
  accountNumber?: string;
  amount: number;
  bankCode?: string;
  metadata?: Json;
  method: PayoutMethod;
  narration?: string;
  network?: string;
  phone?: string;
  reference?: string;
}
