import type { CurrencyCode } from "@richespay/shared";

import type { Json, RpMode } from "../db/types";

export const smsMessageEncodings = ["gsm7", "ucs2"] as const;
export const smsMessageTypes = ["transactional", "otp", "marketing"] as const;
export const smsMessageStatuses = [
  "queued",
  "sent",
  "delivered",
  "undelivered",
  "failed",
  "rejected"
] as const;
export const smsBatchStatuses = ["queued", "processing", "completed", "partial"] as const;
export const smsOtpStatuses = ["pending", "verified", "expired", "failed"] as const;

export type SmsMessageEncoding = (typeof smsMessageEncodings)[number];
export type SmsMessageType = (typeof smsMessageTypes)[number];
export type SmsMessageStatus = (typeof smsMessageStatuses)[number];
export type SmsBatchStatus = (typeof smsBatchStatuses)[number];
export type SmsOtpStatus = (typeof smsOtpStatuses)[number];

export interface SmsMessageRecord {
  batchId: string | null;
  body: string;
  channelId: string | null;
  createdAt: Date;
  currency: CurrencyCode;
  deliveredAt: Date | null;
  encoding: SmsMessageEncoding;
  failureCode: string | null;
  id: string;
  merchantId: string;
  metadata: Json;
  mode: RpMode;
  priceMinor: bigint;
  providerRef: string | null;
  reference: string | null;
  scheduledAt: Date | null;
  segments: number;
  senderId: string;
  sentAt: Date | null;
  status: SmsMessageStatus;
  to: string;
  type: SmsMessageType;
}

export interface SmsBatchRecord {
  acceptedCount: number;
  body: string;
  createdAt: Date;
  createdBy: string;
  id: string;
  merchantId: string;
  metadata: Json;
  mode: RpMode;
  reference: string | null;
  rejectedCount: number;
  scheduledAt: Date | null;
  senderId: string | null;
  status: SmsBatchStatus;
  totalCount: number;
  type: SmsMessageType;
  updatedAt: Date;
}

export interface SmsBatchView extends SmsBatchRecord {
  messages: SmsMessageRecord[];
}

export interface SmsOtpRecord {
  attempts: number;
  createdAt: Date;
  expiresAt: Date;
  id: string;
  maxAttempts: number;
  merchantId: string;
  mode: RpMode;
  senderId: string | null;
  smsMessageId: string | null;
  status: SmsOtpStatus;
  to: string;
  verifiedAt: Date | null;
}
