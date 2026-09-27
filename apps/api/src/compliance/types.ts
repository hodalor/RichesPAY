import type { CurrencyCode } from "@richespay/shared";

import type { Json, RpMode } from "../db/types";

export const complianceReasonCategories = [
  "regulatory",
  "chargeback_risk",
  "kyb_review",
  "sanctions_screening",
  "fraud_review",
  "operations",
  "other"
] as const;

export const kybTiers = ["tier_0", "tier_1", "tier_2", "tier_3"] as const;
export const complianceReviewStatuses = ["open", "resolved", "dismissed"] as const;

export type ComplianceReasonCategory = (typeof complianceReasonCategories)[number];
export type KybTier = (typeof kybTiers)[number];
export type ComplianceReviewStatus = (typeof complianceReviewStatuses)[number];
export type ComplianceOperationKind = "collection" | "payout";

export interface MerchantLimitConfig {
  dailyVolumeMinor: bigint | null;
  maxMinor: bigint;
  minMinor: bigint;
  monthlyVolumeMinor: bigint | null;
}

export interface MerchantComplianceSummary {
  collectionsFreezeCategory: ComplianceReasonCategory | null;
  collectionsFreezeReason: string | null;
  collectionsFrozen: boolean;
  contactLink: string;
  kybTier: KybTier;
  limits: {
    collection: MerchantLimitConfig;
    payout: MerchantLimitConfig;
  };
  merchantId: string;
  mode: RpMode;
  payoutsFreezeCategory: ComplianceReasonCategory | null;
  payoutsFreezeReason: string | null;
  payoutsFrozen: boolean;
  rollingReserveBps: number;
  rollingReserveDays: number;
  screeningPayoutThresholdMinor: bigint | null;
  settlementCurrency: CurrencyCode;
  status: string;
  suspensionCategory: ComplianceReasonCategory | null;
  suspensionReason: string | null;
  velocityCollectionsPerPhone: number;
  velocityWindowMinutes: number;
}

export interface ComplianceReviewFlagRecord {
  createdAt: Date;
  id: string;
  merchantId: string;
  mode: RpMode;
  payload: Json;
  resourceId: string;
  resourceType: string;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  ruleCode: string;
  status: ComplianceReviewStatus;
  summary: string;
}
