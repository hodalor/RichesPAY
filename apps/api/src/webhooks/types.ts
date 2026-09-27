import type { Json, RpMode } from "../db/types";

export const webhookRetryDelaysMs = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000
] as const;

export const WEBHOOK_MAX_CONSECUTIVE_FAILURES = 20;
export const WEBHOOK_RESPONSE_SNIPPET_LIMIT = 500;
export const WEBHOOK_TEST_EVENT_TYPE = "webhook.test";

export interface WebhookEndpointRecord {
  consecutiveFailures: number;
  createdAt: Date;
  description: string;
  enabled: boolean;
  events: string[];
  id: string;
  merchantId: string;
  mode: RpMode;
  updatedAt: Date;
  url: string;
}

export interface WebhookDeliveryRecord {
  attempt: number;
  createdAt: Date;
  deliveredAt: Date | null;
  durationMs: number | null;
  endpointId: string;
  eventId: string;
  eventType: string;
  merchantId: string;
  mode: RpMode;
  nextRetryAt: Date | null;
  responseSnippet: string | null;
  statusCode: number | null;
}

export interface WebhookDispatchResult extends WebhookDeliveryRecord {
  disabledEndpoint: boolean;
  endpointConsecutiveFailures: number;
}

export interface WebhookEventEnvelope {
  created_at: string;
  data: Json;
  id: string;
  mode: RpMode;
  type: string;
}
