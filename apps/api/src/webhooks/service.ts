import type { FastifyBaseLogger } from "fastify";
import { sql } from "kysely";

import { newId } from "@richespay/shared";

import {
  runWithMerchantScope,
  runWithSystemScope,
  type AppDatabase,
  type ScopedTransaction
} from "../db";
import type { Json, JsonObject, RpMode } from "../db/types";
import { ApiRouteError } from "../lib/api-error";
import { redactJsonValue } from "../lib/redaction";
import { CredentialEncryptionService } from "../providers/crypto";

import { WebhookHttpClient, type WebhookHttpResponse } from "./http-client";
import { buildWebhookSignatureHeader, createPlainWebhookSecret } from "./signature";
import {
  WEBHOOK_MAX_CONSECUTIVE_FAILURES,
  WEBHOOK_RESPONSE_SNIPPET_LIMIT,
  WEBHOOK_TEST_EVENT_TYPE,
  webhookRetryDelaysMs,
  type WebhookDeliveryRecord,
  type WebhookDispatchResult,
  type WebhookEndpointRecord,
  type WebhookEventEnvelope
} from "./types";

interface WebhookEndpointRow {
  consecutive_failures: number;
  created_at: Date;
  description: string;
  enabled: boolean;
  events: string[];
  id: string;
  merchant_id: string;
  mode: RpMode;
  updated_at: Date;
  url: string;
}

interface WebhookDeliveryRow {
  attempt: number;
  created_at: Date;
  delivered_at: Date | null;
  duration_ms: number | null;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  merchant_id: string;
  mode: RpMode;
  next_retry_at: Date | null;
  response_snippet: string | null;
  status_code: number | null;
}

interface DeliveryCandidate {
  endpointConsecutiveFailures: number;
  endpointCreatedAt: Date;
  endpointId: string;
  endpointSecret: string;
  eventCreatedAt: Date;
  eventId: string;
  eventPayload: Json;
  eventType: string;
  merchantId: string;
  mode: RpMode;
  url: string;
}

interface PendingAttempt extends DeliveryCandidate {
  attempt: number;
}

interface DeliveryHttpClientLike {
  postJson(input: {
    body: string;
    headers: Record<string, string>;
    url: string;
  }): Promise<WebhookHttpResponse>;
}

export class WebhookService {
  #database: AppDatabase;
  #deliveryClient: DeliveryHttpClientLike;
  #encryption: CredentialEncryptionService;
  #logger: FastifyBaseLogger | undefined;

  constructor(input: {
    database: AppDatabase;
    deliveryClient?: DeliveryHttpClientLike;
    encryptionKey: string;
    logger?: FastifyBaseLogger;
  }) {
    this.#database = input.database;
    this.#deliveryClient = input.deliveryClient ?? new WebhookHttpClient();
    this.#encryption = new CredentialEncryptionService(input.encryptionKey);
    this.#logger = input.logger;
  }

  async listEndpoints(
    merchantId: string,
    mode: RpMode
  ): Promise<WebhookEndpointRecord[]> {
    const rows = await runWithMerchantScope(
      this.#database,
      merchantId,
      mode,
      async (trx) =>
        trx
          .selectFrom("webhook_endpoints")
          .selectAll()
          .orderBy("created_at", "desc")
          .execute()
    );

    return rows.map(mapWebhookEndpoint);
  }

  async createEndpoint(input: {
    description: string;
    enabled?: boolean;
    events: string[];
    merchantId: string;
    mode: RpMode;
    url: string;
  }): Promise<{
    endpoint: WebhookEndpointRecord;
    signingSecret: string;
  }> {
    const signingSecret = createPlainWebhookSecret();
    const endpoint = await runWithMerchantScope(
      this.#database,
      input.merchantId,
      input.mode,
      async (trx) =>
        trx
          .insertInto("webhook_endpoints")
          .values({
            consecutive_failures: 0,
            description: input.description.trim(),
            enabled: input.enabled ?? true,
            events: normalizeWebhookEvents(input.events),
            id: newId("whe_"),
            merchant_id: input.merchantId,
            mode: input.mode,
            secret: this.#encryption.encrypt(signingSecret),
            url: input.url
          })
          .returningAll()
          .executeTakeFirstOrThrow()
    );

    return {
      endpoint: mapWebhookEndpoint(endpoint),
      signingSecret
    };
  }

  async updateEndpoint(input: {
    description: string;
    enabled: boolean;
    endpointId: string;
    events: string[];
    merchantId: string;
    mode: RpMode;
    url: string;
  }): Promise<WebhookEndpointRecord> {
    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      const existing = await trx
        .selectFrom("webhook_endpoints")
        .select(["enabled"])
        .where("id", "=", input.endpointId)
        .executeTakeFirst();

      if (!existing) {
        throw new ApiRouteError({
          code: "not_found",
          message: "Webhook endpoint not found",
          statusCode: 404
        });
      }

      const updated = await trx
        .updateTable("webhook_endpoints")
        .set({
          consecutive_failures:
            input.enabled && !existing.enabled ? 0 : undefined,
          description: input.description.trim(),
          enabled: input.enabled,
          events: normalizeWebhookEvents(input.events),
          url: input.url
        })
        .where("id", "=", input.endpointId)
        .returningAll()
        .executeTakeFirstOrThrow();

      return mapWebhookEndpoint(updated);
    });
  }

  async rollSecret(input: {
    endpointId: string;
    merchantId: string;
    mode: RpMode;
  }): Promise<{
    endpoint: WebhookEndpointRecord;
    signingSecret: string;
  }> {
    const signingSecret = createPlainWebhookSecret();
    const endpoint = await runWithMerchantScope(
      this.#database,
      input.merchantId,
      input.mode,
      async (trx) => {
        const updated = await trx
          .updateTable("webhook_endpoints")
          .set({
            secret: this.#encryption.encrypt(signingSecret)
          })
          .where("id", "=", input.endpointId)
          .returningAll()
          .executeTakeFirst();

        if (!updated) {
          throw new ApiRouteError({
            code: "not_found",
            message: "Webhook endpoint not found",
            statusCode: 404
          });
        }

        return updated;
      }
    );

    return {
      endpoint: mapWebhookEndpoint(endpoint),
      signingSecret
    };
  }

  async listDeliveries(
    merchantId: string,
    mode: RpMode,
    input: {
      endpointId?: string;
      limit: number;
    }
  ): Promise<WebhookDeliveryRecord[]> {
    const rows = await runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      let query = trx
        .selectFrom("webhook_deliveries as delivery")
        .innerJoin("events_outbox as event", "event.id", "delivery.event_id")
        .select([
          "delivery.attempt as attempt",
          "delivery.created_at as created_at",
          "delivery.delivered_at as delivered_at",
          "delivery.duration_ms as duration_ms",
          "delivery.endpoint_id as endpoint_id",
          "delivery.event_id as event_id",
          "delivery.merchant_id as merchant_id",
          "delivery.mode as mode",
          "delivery.next_retry_at as next_retry_at",
          "delivery.response_snippet as response_snippet",
          "delivery.status_code as status_code",
          "event.type as event_type"
        ])
        .orderBy("delivery.created_at", "desc")
        .orderBy("delivery.attempt", "desc")
        .limit(input.limit);

      if (input.endpointId) {
        query = query.where("delivery.endpoint_id", "=", input.endpointId);
      }

      return query.execute();
    });

    return rows.map(mapWebhookDelivery);
  }

  async sendTestEvent(input: {
    endpointId: string;
    merchantId: string;
    mode: RpMode;
  }): Promise<WebhookDispatchResult> {
    await this.#requireEndpoint(input.merchantId, input.mode, input.endpointId);

    const eventId = await runWithMerchantScope(
      this.#database,
      input.merchantId,
      input.mode,
      async (trx) => {
        const eventId = newId("evt_");
        await trx
          .insertInto("events_outbox")
          .values({
            id: eventId,
            merchant_id: input.merchantId,
            mode: input.mode,
            payload: {
              message: "This is a test webhook from RichesPay.",
              target_endpoint_id: input.endpointId
            },
            type: WEBHOOK_TEST_EVENT_TYPE
          })
          .execute();

        return eventId;
      }
    );

    return this.deliverEventToEndpointNow({
      endpointId: input.endpointId,
      eventId
    });
  }

  async replayDelivery(input: {
    endpointId: string;
    eventId: string;
    merchantId: string;
    mode: RpMode;
  }): Promise<WebhookDispatchResult> {
    const existing = await runWithMerchantScope(
      this.#database,
      input.merchantId,
      input.mode,
      async (trx) =>
        trx
          .selectFrom("webhook_deliveries")
          .select(["event_id"])
          .where("endpoint_id", "=", input.endpointId)
          .where("event_id", "=", input.eventId)
          .executeTakeFirst()
    );

    if (!existing) {
      throw new ApiRouteError({
        code: "not_found",
        message: "Webhook delivery not found",
        statusCode: 404
      });
    }

    return this.deliverEventToEndpointNow({
      endpointId: input.endpointId,
      eventId: input.eventId
    });
  }

  async deliverEventToEndpointNow(input: {
    endpointId: string;
    eventId: string;
  }): Promise<WebhookDispatchResult> {
    const pendingAttempt = await this.#prepareAttempt({
      endpointId: input.endpointId,
      eventId: input.eventId,
      force: true
    });

    if (!pendingAttempt) {
      throw new ApiRouteError({
        code: "not_found",
        message: "Webhook event is not eligible for delivery to this endpoint",
        statusCode: 404
      });
    }

    return this.#dispatchAttempt(pendingAttempt);
  }

  async processDueDeliveries(limit = 25): Promise<number> {
    const candidates = await this.#listDueCandidates(limit);
    let processed = 0;

    for (const candidate of candidates) {
      const pendingAttempt = await this.#prepareAttempt({
        endpointId: candidate.endpointId,
        eventId: candidate.eventId,
        force: false
      });

      if (!pendingAttempt) {
        continue;
      }

      processed += 1;

      try {
        await this.#dispatchAttempt(pendingAttempt);
      } catch (error) {
        this.#logger?.error(
          {
            endpoint_id: candidate.endpointId,
            err: error,
            event_id: candidate.eventId
          },
          "Webhook delivery attempt failed unexpectedly"
        );
      }
    }

    return processed;
  }

  async #requireEndpoint(
    merchantId: string,
    mode: RpMode,
    endpointId: string
  ): Promise<void> {
    const endpoint = await runWithMerchantScope(
      this.#database,
      merchantId,
      mode,
      async (trx) =>
        trx
          .selectFrom("webhook_endpoints")
          .select(["id"])
          .where("id", "=", endpointId)
          .executeTakeFirst()
    );

    if (!endpoint) {
      throw new ApiRouteError({
        code: "not_found",
        message: "Webhook endpoint not found",
        statusCode: 404
      });
    }
  }

  async #prepareAttempt(input: {
    endpointId: string;
    eventId: string;
    force: boolean;
  }): Promise<PendingAttempt | null> {
    return runWithSystemScope(
      this.#database,
      "prepare webhook delivery attempt",
      async (trx) => {
        const candidate = await this.#loadCandidate(trx, input);

        if (!candidate) {
          return null;
        }

        const attempt = await this.#insertAttemptRow(trx, candidate);
        return attempt ? { ...candidate, attempt } : null;
      },
      { audit: false }
    );
  }

  async #loadCandidate(
    trx: ScopedTransaction,
    input: {
      endpointId: string;
      eventId: string;
      force: boolean;
    }
  ): Promise<DeliveryCandidate | null> {
    const result = await sql<{
      endpointConsecutiveFailures: number;
      endpointCreatedAt: Date;
      endpointId: string;
      endpointSecret: string;
      eventCreatedAt: Date;
      eventId: string;
      eventPayload: Json;
      eventType: string;
      lastAttempt: number | null;
      lastDeliveredAt: Date | null;
      lastNextRetryAt: Date | null;
      merchantId: string;
      mode: RpMode;
      url: string;
    }>`
      select
        endpoint.consecutive_failures as "endpointConsecutiveFailures",
        endpoint.created_at as "endpointCreatedAt",
        endpoint.id as "endpointId",
        endpoint.secret as "endpointSecret",
        event.created_at as "eventCreatedAt",
        event.id as "eventId",
        event.payload as "eventPayload",
        event.type as "eventType",
        latest.attempt as "lastAttempt",
        latest.delivered_at as "lastDeliveredAt",
        latest.next_retry_at as "lastNextRetryAt",
        endpoint.merchant_id as "merchantId",
        endpoint.mode as "mode",
        endpoint.url as "url"
      from public.webhook_endpoints endpoint
      inner join public.events_outbox event
        on event.id = ${input.eventId}
       and event.merchant_id = endpoint.merchant_id
       and event.mode = endpoint.mode
       and event.created_at >= endpoint.created_at
      left join lateral (
        select
          delivery.attempt,
          delivery.delivered_at,
          delivery.next_retry_at
        from public.webhook_deliveries delivery
        where delivery.endpoint_id = endpoint.id
          and delivery.event_id = event.id
        order by delivery.attempt desc
        limit 1
      ) latest on true
      where endpoint.id = ${input.endpointId}
        and endpoint.enabled = true
        and (
          event.type = ${WEBHOOK_TEST_EVENT_TYPE}
          or '*' = any(endpoint.events)
          or event.type = any(endpoint.events)
        )
        and (
          event.type <> ${WEBHOOK_TEST_EVENT_TYPE}
          or coalesce(event.payload->>'target_endpoint_id', '') = endpoint.id
        )
        and (
          ${input.force}
          or latest.attempt is null
          or (
            latest.delivered_at is null
            and latest.next_retry_at is not null
            and latest.next_retry_at <= now()
          )
        )
      limit 1
    `.execute(trx);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      endpointConsecutiveFailures: row.endpointConsecutiveFailures,
      endpointCreatedAt: row.endpointCreatedAt,
      endpointId: row.endpointId,
      endpointSecret: row.endpointSecret,
      eventCreatedAt: row.eventCreatedAt,
      eventId: row.eventId,
      eventPayload: row.eventPayload,
      eventType: row.eventType,
      merchantId: row.merchantId,
      mode: row.mode,
      url: row.url
    };
  }

  async #insertAttemptRow(
    trx: ScopedTransaction,
    candidate: DeliveryCandidate
  ): Promise<number | null> {
    const nextAttemptResult = await sql<{ nextAttempt: number }>`
      select coalesce(max(delivery.attempt), 0) + 1 as "nextAttempt"
      from public.webhook_deliveries delivery
      where delivery.endpoint_id = ${candidate.endpointId}
        and delivery.event_id = ${candidate.eventId}
    `.execute(trx);
    const nextAttempt = nextAttemptResult.rows[0]?.nextAttempt ?? 1;

    try {
      await trx
        .insertInto("webhook_deliveries")
        .values({
          attempt: nextAttempt,
          created_at: new Date(),
          delivered_at: null,
          duration_ms: null,
          endpoint_id: candidate.endpointId,
          event_id: candidate.eventId,
          merchant_id: candidate.merchantId,
          mode: candidate.mode,
          next_retry_at: new Date(),
          response_snippet: null,
          status_code: null
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null;
      }

      throw error;
    }

    return nextAttempt;
  }

  async #listDueCandidates(limit: number): Promise<DeliveryCandidate[]> {
    const result = await runWithSystemScope(
      this.#database,
      "list due webhook deliveries",
      async (trx) =>
        sql<{
          endpointConsecutiveFailures: number;
          endpointCreatedAt: Date;
          endpointId: string;
          endpointSecret: string;
          eventCreatedAt: Date;
          eventId: string;
          eventPayload: Json;
          eventType: string;
          merchantId: string;
          mode: RpMode;
          url: string;
        }>`
          select
            endpoint.consecutive_failures as "endpointConsecutiveFailures",
            endpoint.created_at as "endpointCreatedAt",
            endpoint.id as "endpointId",
            endpoint.secret as "endpointSecret",
            event.created_at as "eventCreatedAt",
            event.id as "eventId",
            event.payload as "eventPayload",
            event.type as "eventType",
            endpoint.merchant_id as "merchantId",
            endpoint.mode as "mode",
            endpoint.url as "url"
          from public.webhook_endpoints endpoint
          inner join public.events_outbox event
            on event.merchant_id = endpoint.merchant_id
           and event.mode = endpoint.mode
           and event.created_at >= endpoint.created_at
          left join lateral (
            select
              delivery.attempt,
              delivery.delivered_at,
              delivery.next_retry_at
            from public.webhook_deliveries delivery
            where delivery.endpoint_id = endpoint.id
              and delivery.event_id = event.id
            order by delivery.attempt desc
            limit 1
          ) latest on true
          where endpoint.enabled = true
            and (
              event.type = ${WEBHOOK_TEST_EVENT_TYPE}
              or '*' = any(endpoint.events)
              or event.type = any(endpoint.events)
            )
            and (
              event.type <> ${WEBHOOK_TEST_EVENT_TYPE}
              or coalesce(event.payload->>'target_endpoint_id', '') = endpoint.id
            )
            and (
              latest.attempt is null
              or (
                latest.delivered_at is null
                and latest.next_retry_at is not null
                and latest.next_retry_at <= now()
              )
            )
          order by event.created_at asc, endpoint.created_at asc
          limit ${limit}
        `.execute(trx),
      { audit: false }
    );

    return result.rows.map((row) => ({
      endpointConsecutiveFailures: row.endpointConsecutiveFailures,
      endpointCreatedAt: row.endpointCreatedAt,
      endpointId: row.endpointId,
      endpointSecret: row.endpointSecret,
      eventCreatedAt: row.eventCreatedAt,
      eventId: row.eventId,
      eventPayload: row.eventPayload,
      eventType: row.eventType,
      merchantId: row.merchantId,
      mode: row.mode,
      url: row.url
    }));
  }

  async #dispatchAttempt(candidate: PendingAttempt): Promise<WebhookDispatchResult> {
    const signingSecret = this.#encryption.decrypt<string>(candidate.endpointSecret);
    const rawBody = JSON.stringify(buildEventEnvelope(candidate));
    const signature = buildWebhookSignatureHeader(signingSecret, rawBody);

    try {
      const response = await this.#deliveryClient.postJson({
        body: rawBody,
        headers: {
          "richespay-signature": signature,
          "user-agent": "RichesPay-Webhook/1.0"
        },
        url: candidate.url
      });

      return this.#finalizeAttempt(candidate, response);
    } catch (error) {
      this.#logger?.warn(
        {
          endpoint_id: candidate.endpointId,
          err: error,
          event_id: candidate.eventId
        },
        "Webhook delivery transport failed"
      );

      return this.#finalizeAttempt(candidate, {
        body: error instanceof Error ? error.message : "Webhook delivery failed",
        durationMs: 0,
        statusCode: 0
      });
    }
  }

  async #finalizeAttempt(
    candidate: PendingAttempt,
    response: WebhookHttpResponse
  ): Promise<WebhookDispatchResult> {
    const succeeded = response.statusCode >= 200 && response.statusCode < 300;
    const deliveredAt = succeeded ? new Date() : null;
    const nextRetryAt = succeeded ? null : computeNextRetryAt(candidate.attempt);
    const responseSnippet = buildResponseSnippet(response.body);
    const endpointUpdate = await runWithSystemScope(
      this.#database,
      "finalize webhook delivery attempt",
      async (trx) => {
        await trx
          .updateTable("webhook_deliveries")
          .set({
            delivered_at: deliveredAt,
            duration_ms: response.durationMs,
            next_retry_at: nextRetryAt,
            response_snippet: responseSnippet,
            status_code: response.statusCode > 0 ? response.statusCode : null
          })
          .where("endpoint_id", "=", candidate.endpointId)
          .where("event_id", "=", candidate.eventId)
          .where("attempt", "=", candidate.attempt)
          .executeTakeFirst();

        const updatedEndpoint = await trx
          .updateTable("webhook_endpoints")
          .set(
            succeeded
              ? {
                  consecutive_failures: 0,
                  enabled: true
                }
              : {
                  consecutive_failures: sql<number>`consecutive_failures + 1`,
                  enabled: sql<boolean>`
                    case
                      when consecutive_failures + 1 >= ${WEBHOOK_MAX_CONSECUTIVE_FAILURES}
                        then false
                      else enabled
                    end
                  `
                }
          )
          .where("id", "=", candidate.endpointId)
          .returning(["consecutive_failures", "enabled"])
          .executeTakeFirstOrThrow();

        const disabledEndpoint =
          !succeeded &&
          candidate.endpointConsecutiveFailures < WEBHOOK_MAX_CONSECUTIVE_FAILURES &&
          updatedEndpoint.consecutive_failures >= WEBHOOK_MAX_CONSECUTIVE_FAILURES &&
          !updatedEndpoint.enabled;

        if (disabledEndpoint) {
          await this.#enqueueEndpointDisabledEmails(trx, {
            consecutiveFailures: updatedEndpoint.consecutive_failures,
            endpointId: candidate.endpointId,
            merchantId: candidate.merchantId,
            mode: candidate.mode,
            url: candidate.url
          });
        }

        return {
          consecutiveFailures: updatedEndpoint.consecutive_failures,
          disabledEndpoint,
          enabled: updatedEndpoint.enabled
        };
      },
      { audit: false }
    );

    return {
      attempt: candidate.attempt,
      createdAt: new Date(),
      deliveredAt,
      disabledEndpoint: endpointUpdate.disabledEndpoint,
      durationMs: response.durationMs,
      endpointConsecutiveFailures: endpointUpdate.consecutiveFailures,
      endpointId: candidate.endpointId,
      eventId: candidate.eventId,
      eventType: candidate.eventType,
      merchantId: candidate.merchantId,
      mode: candidate.mode,
      nextRetryAt,
      responseSnippet,
      statusCode: response.statusCode > 0 ? response.statusCode : null
    };
  }

  async #enqueueEndpointDisabledEmails(
    trx: ScopedTransaction,
    input: {
      consecutiveFailures: number;
      endpointId: string;
      merchantId: string;
      mode: RpMode;
      url: string;
    }
  ) {
    const merchant = await trx
      .selectFrom("merchants")
      .select(["legal_name", "support_email"])
      .where("id", "=", input.merchantId)
      .where("mode", "=", input.mode)
      .executeTakeFirst();

    if (!merchant) {
      return;
    }

    if (!merchant.support_email) {
      return;
    }

    await trx
      .insertInto("email_outbox")
      .values({
        body: [
          "RichesPay disabled one of your webhook endpoints after repeated delivery failures.",
          "",
          `Merchant: ${merchant.legal_name}`,
          `Mode: ${input.mode}`,
          `Endpoint ID: ${input.endpointId}`,
          `URL: ${input.url}`,
          `Consecutive failures: ${input.consecutiveFailures}`,
          "",
          "Update the endpoint or roll its secret before re-enabling delivery."
        ].join("\n"),
        id: newId("eml_"),
        merchant_id: input.merchantId,
        mode: input.mode,
        recipient_email: merchant.support_email,
        subject: `Webhook endpoint disabled for ${merchant.legal_name}`
      })
      .execute();
  }
}

function normalizeWebhookEvents(events: string[]): string[] {
  const normalized = [...new Set(events.map((item) => item.trim()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new ApiRouteError({
      code: "validation_error",
      field: "events",
      message: "At least one webhook event must be selected",
      statusCode: 400
    });
  }

  if (normalized.includes("*")) {
    return ["*"];
  }

  return normalized.sort((left, right) => left.localeCompare(right));
}

function mapWebhookEndpoint(row: WebhookEndpointRow): WebhookEndpointRecord {
  return {
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    description: row.description,
    enabled: row.enabled,
    events: row.events,
    id: row.id,
    merchantId: row.merchant_id,
    mode: row.mode,
    updatedAt: row.updated_at,
    url: row.url
  };
}

function mapWebhookDelivery(row: WebhookDeliveryRow): WebhookDeliveryRecord {
  return {
    attempt: row.attempt,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    durationMs: row.duration_ms,
    endpointId: row.endpoint_id,
    eventId: row.event_id,
    eventType: row.event_type,
    merchantId: row.merchant_id,
    mode: row.mode,
    nextRetryAt: row.next_retry_at,
    responseSnippet: row.response_snippet,
    statusCode: row.status_code
  };
}

function buildEventEnvelope(candidate: PendingAttempt): WebhookEventEnvelope {
  return {
    created_at: candidate.eventCreatedAt.toISOString(),
    data: sanitizeWebhookPayload(candidate.eventPayload),
    id: candidate.eventId,
    mode: candidate.mode,
    type: candidate.eventType
  };
}

function sanitizeWebhookPayload(payload: Json): Json {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "target_endpoint_id" in payload
  ) {
    const { target_endpoint_id: _targetEndpointId, ...rest } = payload as JsonObject & {
      target_endpoint_id?: Json;
    };
    return rest;
  }

  return payload;
}

function buildResponseSnippet(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return JSON.stringify(redactJsonValue(parsed)).slice(0, WEBHOOK_RESPONSE_SNIPPET_LIMIT);
  } catch {
    return trimmed.slice(0, WEBHOOK_RESPONSE_SNIPPET_LIMIT);
  }
}

function computeNextRetryAt(attempt: number): Date | null {
  if (attempt >= WEBHOOK_MAX_CONSECUTIVE_FAILURES) {
    return null;
  }

  const delayMs =
    webhookRetryDelaysMs[Math.min(attempt - 1, webhookRetryDelaysMs.length - 1)]!;
  return new Date(Date.now() + delayMs);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
