import type { Json, RpMode } from "../db/types";

export const senderIdPurposes = ["transactional", "otp", "marketing"] as const;
export const senderIdApprovalStatuses = [
  "pending",
  "submitted",
  "approved",
  "rejected"
] as const;
export const senderIdOverallStatuses = ["approved", "pending", "rejected"] as const;

export type SenderIdPurpose = (typeof senderIdPurposes)[number];
export type SenderIdApprovalStatus = (typeof senderIdApprovalStatuses)[number];
export type SenderIdOverallStatus = (typeof senderIdOverallStatuses)[number];

export interface SenderIdApprovalRecord {
  countryCode: string;
  createdAt: Date;
  id: string;
  merchantId: string;
  mode: RpMode;
  network: string;
  rejectionReason: string | null;
  senderIdId: string;
  status: SenderIdApprovalStatus;
  updatedAt: Date;
  updatedBy: string;
}

export interface SenderIdRecord {
  approvals: SenderIdApprovalRecord[];
  authorizationLetter: string;
  createdAt: Date;
  createdBy: string;
  id: string;
  merchantId: string;
  mode: RpMode;
  overallStatus: SenderIdOverallStatus;
  purpose: SenderIdPurpose;
  sampleMessage: string;
  senderId: string;
}

export interface SenderIdSummary {
  approved: number;
  pending: number;
  rejected: number;
}

export interface MerchantNotificationRecord {
  body: string;
  createdAt: Date;
  data: Json;
  id: string;
  merchantId: string;
  mode: RpMode;
  readAt: Date | null;
  title: string;
  type: string;
}

export interface SenderIdListView {
  items: SenderIdRecord[];
  notifications: MerchantNotificationRecord[];
  summary: SenderIdSummary;
}

export interface SenderIdQueueRecord {
  approvalId: string;
  authorizationLetter: string;
  countryCode: string;
  createdAt: Date;
  merchantId: string;
  merchantName: string;
  mode: RpMode;
  network: string;
  overallStatus: SenderIdOverallStatus;
  purpose: SenderIdPurpose;
  rejectionReason: string | null;
  sampleMessage: string;
  senderId: string;
  senderIdId: string;
  status: SenderIdApprovalStatus;
  updatedAt: Date;
  updatedBy: string;
}

export interface PlatformSmsSettingsRecord {
  createdAt: Date;
  defaultOtpSenderId: string | null;
  mode: RpMode;
  updatedAt: Date;
  updatedBy: string;
}
