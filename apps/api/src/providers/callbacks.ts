import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { newId } from "@richespay/shared";
import type { FastifyBaseLogger } from "fastify";
import ipaddr from "ipaddr.js";

import { CollectionService } from "../collections";
import { runWithSystemScope } from "../db";
import type { AppDatabase } from "../db";
import { getClientIp } from "../auth/admin-access";
import { ApiRouteError } from "../lib/api-error";
import { PayoutService } from "../payouts/service";
import { redactJsonValue } from "../lib/redaction";
import { SmsMessagingService } from "../sms/public-service";
import { ProviderCatalog } from "./catalog";
import { createProviderCallbacksQueue } from "./queue";
import type { ChannelRecord } from "./types";

export class ProviderCallbackService {
  #catalog: ProviderCatalog;
  #collectionService: CollectionService;
  #database: AppDatabase;
  #logger: FastifyBaseLogger | undefined;
  #payoutService: PayoutService;
  #queue: ReturnType<typeof createProviderCallbacksQueue> | undefined;
  #smsService: SmsMessagingService;

  constructor(input: {
    catalog: ProviderCatalog;
    database: AppDatabase;
    logger?: FastifyBaseLogger;
    redisUrl?: string;
  }) {
    this.#catalog = input.catalog;
    this.#collectionService = new CollectionService({
      database: input.database
    });
    this.#database = input.database;
    this.#logger = input.logger;
    this.#payoutService = new PayoutService({
      database: input.database
    });
    this.#smsService = new SmsMessagingService({
      database: input.database
    });
    this.#queue = input.redisUrl
      ? createProviderCallbacksQueue(input.redisUrl)
      : undefined;
  }

  async close() {
    await Promise.allSettled([this.#queue?.close(), this.#smsService.close()]);
  }

  async handleInboundCallback(input: {
    channelId: string;
    headers: Record<string, string | string[] | undefined>;
    ip: string;
    rawBody: string;
  }): Promise<void> {
    const channel = await this.#loadChannel(input.channelId);
    if (!channel) {
      throw new ApiRouteError({
        code: "not_found",
        message: "Callback channel was not found",
        statusCode: 404
      });
    }

    const verified = await this.#verifyCallback(channel, {
      headers: input.headers,
      ip: input.ip,
      rawBody: input.rawBody
    });

    if (!verified) {
      throw new ApiRouteError({
        code: "authentication_failed",
        message: "Callback verification failed",
        statusCode: 401
      });
    }

    const callbackHash = hashCallback(input.headers, input.rawBody);
    const callbackId = await runWithSystemScope(
      this.#database,
      "store provider callback",
      async (trx) => {
        const existing = await trx
          .selectFrom("provider_callbacks")
          .select(["id", "processed_at"])
          .where("channel_id", "=", input.channelId)
          .where("callback_hash", "=", callbackHash)
          .executeTakeFirst();

        if (existing) {
          return existing.id;
        }

        const callbackId = newId("pcb_");
        await trx
          .insertInto("provider_callbacks")
          .values({
            callback_hash: callbackHash,
            channel_id: input.channelId,
            headers: redactJsonValue(input.headers) ?? {},
            id: callbackId,
            raw_body: input.rawBody,
            received_at: new Date()
          })
          .execute();

        return callbackId;
      },
      { audit: false }
    );

    if (this.#queue) {
      await this.#queue.add(
        "process",
        {
          callbackId
        },
        {
          jobId: callbackId,
          removeOnComplete: 100,
          removeOnFail: 100
        }
      );
    }
  }

  async processCallback(callbackId: string): Promise<void> {
    await runWithSystemScope(
      this.#database,
      "process provider callback",
      async (trx) => {
        const callback = await trx
          .selectFrom("provider_callbacks as callback")
          .innerJoin("channels as channel", "channel.id", "callback.channel_id")
          .select([
            "callback.channel_id as channelId",
            "callback.id as id",
            "callback.processed_at as processedAt",
            "callback.raw_body as rawBody",
            "channel.capabilities as capabilities",
            "channel.config as config",
            "channel.country_code as countryCode",
            "channel.credentials_encrypted as credentialsEncrypted",
            "channel.health as health",
            "channel.id as id2",
            "channel.kind as kind",
            "channel.mode as mode",
            "channel.network as network",
            "channel.priority as priority",
            "channel.provider_code as providerCode",
            "channel.status as status"
          ])
          .where("callback.id", "=", callbackId)
          .executeTakeFirst();

        if (!callback || callback.processedAt) {
          return;
        }

        const channel: ChannelRecord = {
          capabilities: callback.capabilities,
          config: callback.config,
          countryCode: callback.countryCode,
          credentialsEncrypted: callback.credentialsEncrypted,
          health: callback.health,
          id: callback.id2,
          kind: callback.kind,
          mode: callback.mode,
          network: callback.network,
          priority: callback.priority,
          providerCode: callback.providerCode,
          status: callback.status
        };

        const parsed = await this.#parseCallback(channel, callback.rawBody);

        if (
          parsed.resourceType === "collection" &&
          parsed.resourceId &&
          parsed.toStatus
        ) {
          await this.#collectionService.applyProviderCallback({
            collectionId: parsed.resourceId,
            ...(parsed.providerRef ? { providerRef: parsed.providerRef } : {}),
            providerStatus: parsed.toStatus,
            rawPayload: parsed.rawRedacted,
            ...(parsed.reason ? { reason: parsed.reason } : {})
          });
        } else if (
          parsed.resourceType === "payout" &&
          parsed.resourceId &&
          parsed.toStatus
        ) {
          await this.#payoutService.applyProviderCallback({
            payoutId: parsed.resourceId,
            ...(parsed.providerRef ? { providerRef: parsed.providerRef } : {}),
            providerStatus: parsed.toStatus,
            ...(parsed.reason ? { reason: parsed.reason } : {})
          });
        } else if (parsed.resourceType === "sms" && parsed.toStatus) {
          await this.#smsService.applyDeliveryReport({
            ...(parsed.merchantId ? { merchantId: parsed.merchantId } : {}),
            ...(parsed.mode ? { mode: parsed.mode } : {}),
            ...(parsed.providerRef ? { providerRef: parsed.providerRef } : {}),
            rawPayload: parsed.rawRedacted,
            ...(parsed.resourceId ? { resourceId: parsed.resourceId } : {}),
            toStatus: parsed.toStatus
          });
        } else if (
          parsed.merchantId &&
          parsed.mode &&
          parsed.resourceId &&
          parsed.resourceType &&
          parsed.toStatus
        ) {
          await trx
            .insertInto("transaction_events")
            .values({
              created_at: new Date(),
              from_status: parsed.fromStatus ?? null,
              id: newId("evt_"),
              merchant_id: parsed.merchantId,
              mode: parsed.mode,
              provider_payload: parsed.rawRedacted,
              provider_reference: parsed.providerRef ?? null,
              reason: parsed.reason ?? null,
              resource_id: parsed.resourceId,
              resource_type: parsed.resourceType,
              to_status: parsed.toStatus
            })
            .execute();
        }

        await trx
          .updateTable("provider_callbacks")
          .set({
            processed_at: new Date(),
            processing_error: null
          })
          .where("id", "=", callbackId)
          .execute();
      },
      { audit: false }
    ).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Callback processing failed";
      this.#logger?.error({ callback_id: callbackId, err: error }, "Provider callback processing failed");

      await runWithSystemScope(
        this.#database,
        "store callback processing failure",
        async (trx) => {
          await trx
            .updateTable("provider_callbacks")
            .set({
              processing_error: message
            })
            .where("id", "=", callbackId)
            .execute();
        },
        { audit: false }
      );
    });
  }

  async #loadChannel(channelId: string): Promise<ChannelRecord | null> {
    return runWithSystemScope(
      this.#database,
      "load callback channel",
      async (trx) => {
        const row = await trx
          .selectFrom("channels")
          .selectAll()
          .where("id", "=", channelId)
          .executeTakeFirst();

        return row
          ? {
              capabilities: row.capabilities,
              config: row.config,
              countryCode: row.country_code,
              credentialsEncrypted: row.credentials_encrypted,
              health: row.health,
              id: row.id,
              kind: row.kind,
              mode: row.mode,
              network: row.network,
              priority: row.priority,
              providerCode: row.provider_code,
              status: row.status
            }
          : null;
      },
      { audit: false }
    );
  }

  async #parseCallback(channel: ChannelRecord, rawBody: string) {
    switch (channel.kind) {
      case "bank":
        return this.#catalog.resolveBankPayoutProvider(channel).parseCallback(rawBody);
      case "card":
        return this.#catalog.resolveCardAcquirer(channel).parseCallback(rawBody);
      case "mobile_money":
        return this.#catalog.resolveMobileMoneyProvider(channel).parseCallback(rawBody);
      case "sms":
        return this.#catalog.resolveSmsProvider(channel).parseDeliveryReport(rawBody);
      default:
        throw new Error(`Unsupported callback channel kind: ${channel.kind satisfies never}`);
    }
  }

  async #verifyCallback(
    channel: ChannelRecord,
    input: {
      headers: Record<string, string | string[] | undefined>;
      ip: string;
      rawBody: string;
    }
  ) {
    switch (channel.kind) {
      case "bank":
        return this.#catalog.resolveBankPayoutProvider(channel).verifyCallback(input);
      case "card":
        return this.#catalog.resolveCardAcquirer(channel).verifyCallback(input);
      case "mobile_money":
        return this.#catalog.resolveMobileMoneyProvider(channel).verifyCallback(input);
      case "sms":
        return verifyGenericCallback(channel.config, input);
      default:
        throw new Error(`Unsupported callback channel kind: ${channel.kind satisfies never}`);
    }
  }
}

export function getCallbackClientIp(
  headers: Record<string, string | string[] | undefined>,
  fallbackIp: string
) {
  return getClientIp(headers as Record<string, unknown>, fallbackIp);
}

function hashCallback(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string
): string {
  const normalizedHeaders = Object.keys(headers)
    .sort()
    .reduce<Record<string, string | string[] | undefined>>((accumulator, key) => {
      accumulator[key] = headers[key];
      return accumulator;
    }, {});

  return createHash("sha256")
    .update(JSON.stringify(normalizedHeaders))
    .update(rawBody)
    .digest("hex");
}

function verifyGenericCallback(
  config: unknown,
  input: {
    headers: Record<string, string | string[] | undefined>;
    ip: string;
    rawBody: string;
  }
) {
  const callbackConfig = config as {
    callback_ip_allowlist?: string[];
    callback_secret?: string;
  } | null;

  if (callbackConfig?.callback_ip_allowlist?.length) {
    const clientIp = ipaddr.parse(input.ip);
    const allowed = callbackConfig.callback_ip_allowlist.some((entry) => {
      const [range, prefixLength] = ipaddr.parseCIDR(entry);
      return clientIp.kind() === range.kind() && clientIp.match([range, prefixLength]);
    });

    if (!allowed) {
      return false;
    }
  }

  if (callbackConfig?.callback_secret) {
    const provided = input.headers["x-provider-signature"];
    const signature = Array.isArray(provided) ? provided[0] : provided;
    if (!signature) {
      return false;
    }

    const expected = createHmac("sha256", callbackConfig.callback_secret)
      .update(input.rawBody)
      .digest("hex");
    const left = Buffer.from(expected, "utf8");
    const right = Buffer.from(signature, "utf8");

    return left.length === right.length && timingSafeEqual(left, right);
  }

  return true;
}
