import type { CurrencyCode } from "@richespay/shared";

import type {
  Json,
  ProviderStatementEntryType,
  ReconExceptionStatus,
  ReconExceptionType,
  ReconResolutionAction,
  RpMode
} from "../db/types";

export interface ProviderStatementImportLine {
  amountMinor: bigint;
  currency: CurrencyCode;
  entryType: ProviderStatementEntryType;
  feeMinor?: bigint;
  providerRef?: string | null;
  providerStatus?: string | null;
  raw: Json;
}

export interface ReconExceptionRecord {
  channelId: string;
  createdAt: Date;
  currency: CurrencyCode | null;
  exceptionType: ReconExceptionType;
  expectedAmount: bigint | null;
  expectedStatus: string | null;
  id: string;
  merchantId: string | null;
  mode: RpMode | null;
  providerAmount: bigint | null;
  providerRef: string | null;
  providerStatus: string | null;
  resolutionAction: ReconResolutionAction | null;
  resolutionReason: string | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resourceId: string | null;
  resourceType: string | null;
  status: ReconExceptionStatus;
  statementId: string | null;
  statementLineId: string | null;
}

export interface ReconDailySummaryRecord {
  balancesMatch: boolean;
  channelId: string;
  collectionCount: number;
  collectionVolume: bigint;
  createdAt: Date;
  currency: CurrencyCode;
  exceptionCount: number;
  feeVolume: bigint;
  id: string;
  payoutCount: number;
  payoutVolume: bigint;
  providerClearingBalance: bigint;
  providerFloatBalance: bigint | null;
  statementDate: string;
  statementId: string;
}

export interface ProviderStatementImportResult {
  exceptionCount: number;
  statementId: string;
  summary: ReconDailySummaryRecord;
}
