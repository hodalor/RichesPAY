import type { Json } from "../db/types";
import type { RpMode } from "../db/types";

export const channelKinds = ["mobile_money", "card", "sms"] as const;
export const channelCapabilities = ["collect", "payout", "sms"] as const;
export const channelStatuses = ["active", "disabled", "maintenance"] as const;
export const channelHealthStates = ["healthy", "degraded", "down"] as const;
export const providerOutcomes = ["accepted", "succeeded", "failed", "unknown"] as const;

export type ChannelKind = (typeof channelKinds)[number];
export type ChannelCapability = (typeof channelCapabilities)[number];
export type ChannelStatus = (typeof channelStatuses)[number];
export type ChannelHealthState = (typeof channelHealthStates)[number];
export type ProviderOutcome = (typeof providerOutcomes)[number];

export interface ProviderOperationContext {
  merchantId?: string;
  mode: RpMode;
  requestId: string;
  idempotencyKey?: string;
}

export interface ProviderResult {
  failureCode?: string;
  outcome: ProviderOutcome;
  providerRef?: string;
  providerStatus?: string;
  rawRedacted: Json | null;
}

export interface NormalizedEvent {
  eventId?: string;
  eventType: string;
  fromStatus?: string;
  merchantId?: string;
  mode?: RpMode;
  providerRef?: string;
  rawRedacted: Json | null;
  reason?: string;
  resourceId?: string;
  resourceType?: string;
  toStatus?: string;
}

export interface MobileMoneyCollectRequest {
  amount: number;
  callbackUrl?: string;
  currency: string;
  metadata?: Json | null;
  msisdn: string;
  network?: string;
  reference: string;
  context: ProviderOperationContext;
}

export interface MobileMoneyPayoutRequest {
  amount: number;
  callbackUrl?: string;
  currency: string;
  metadata?: Json | null;
  msisdn: string;
  network?: string;
  reference: string;
  context: ProviderOperationContext;
}

export interface CardPaymentSessionRequest {
  amount: number;
  callbackUrl?: string;
  cancelUrl?: string;
  currency: string;
  customerEmail?: string;
  metadata?: Json | null;
  reference: string;
  returnUrl?: string;
  context: ProviderOperationContext;
}

export interface SmsMessageRequest {
  body: string;
  metadata?: Json | null;
  reference: string;
  senderId: string;
  to: string;
  context: ProviderOperationContext;
}

export interface ProviderCallbackVerificationInput {
  headers: Record<string, string | string[] | undefined>;
  ip: string;
  rawBody: string;
}

export interface ProviderHttpRequest {
  body?: Record<string, unknown> | string;
  channelId: string;
  headers?: Record<string, string>;
  method: "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT";
  retrySafeReads?: boolean;
  timeoutMs?: number;
  url: string;
}

export interface ProviderHttpResponse {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  statusCode: number;
}

export interface ProviderHttpTransport {
  request(input: ProviderHttpRequest): Promise<ProviderHttpResponse>;
}

export interface MobileMoneyProvider {
  collect(req: MobileMoneyCollectRequest): Promise<ProviderResult>;
  payout(req: MobileMoneyPayoutRequest): Promise<ProviderResult>;
  getStatus(providerRef: string): Promise<ProviderResult>;
  lookupAccountName?(msisdn: string): Promise<ProviderResult>;
  verifyCallback(input: ProviderCallbackVerificationInput): Promise<boolean> | boolean;
  parseCallback(rawBody: string): Promise<NormalizedEvent> | NormalizedEvent;
  healthCheck(): Promise<ProviderResult>;
}

export interface CardAcquirer {
  createPaymentSession(req: CardPaymentSessionRequest): Promise<ProviderResult>;
  getStatus(ref: string): Promise<ProviderResult>;
  verifyCallback(input: ProviderCallbackVerificationInput): Promise<boolean> | boolean;
  parseCallback(rawBody: string): Promise<NormalizedEvent> | NormalizedEvent;
  refund(ref: string, amount: number): Promise<ProviderResult>;
  healthCheck(): Promise<ProviderResult>;
}

export interface SmsProvider {
  send(msg: SmsMessageRequest): Promise<ProviderResult>;
  parseDeliveryReport(rawBody: string): Promise<NormalizedEvent> | NormalizedEvent;
  getBalance?(): Promise<ProviderResult>;
  healthCheck(): Promise<ProviderResult>;
}

export interface ChannelRecord {
  capabilities: ChannelCapability[];
  config: Json;
  countryCode: string;
  credentialsEncrypted: string;
  health: ChannelHealthState;
  id: string;
  kind: ChannelKind;
  mode: RpMode;
  network: string | null;
  priority: number;
  providerCode: string;
  status: ChannelStatus;
}

export interface RoutingRuleRecord {
  capability: ChannelCapability;
  channelIds: string[];
  countryCode: string;
  kind: ChannelKind;
  network: string | null;
}

export interface ChannelRoutingTarget {
  channel: ChannelRecord;
  provider:
    | CardAcquirer
    | MobileMoneyProvider
    | SmsProvider;
}

export interface RoutedChannelSelection {
  channel: ChannelRecord;
  providerCode: string;
}
