import { ParseError, parsePhoneNumberWithError } from "libphonenumber-js";
import { newId, type CurrencyCode } from "@richespay/shared";

import { runWithMerchantScope, runWithSystemScope, type AppDatabase, type ScopedTransaction } from "../db";
import type { Json, RpMode } from "../db/types";
import { LedgerService } from "../ledger";
import { ApiRouteError } from "../lib/api-error";
import { requireProduct } from "../products/require-product";
import { detectNetworkFromMsisdn } from "../providers/msisdn";
import { ProviderCatalog } from "../providers/catalog";
import { DatabaseChannelRegistry } from "../providers/router";

import { createSmsMessagesQueue } from "./queue";
import { SenderIdService } from "./service";
import { countSmsSegments, generateOtpCode, hashOtpCode, renderTemplate } from "./text";
import type {
  SmsBatchRecord,
  SmsBatchView,
  SmsMessageRecord,
  SmsMessageStatus,
  SmsMessageType,
  SmsOtpRecord
} from "./public-types";

interface ExpandedRecipient {
  name: string | null;
  phone: string;
}

interface PreparedRecipient {
  body: string;
  countryCode: string;
  currency: CurrencyCode;
  network: string | null;
  normalizedPhone: string;
  priceMinor: bigint;
  scheduledAt: Date | null;
  segments: number;
  senderId: string;
}

export class SmsMessagingService {
  #catalog: ProviderCatalog | null;
  #database: AppDatabase;
  #queue: ReturnType<typeof createSmsMessagesQueue> | null;
  #registry: DatabaseChannelRegistry;
  #senderIdService: SenderIdService;
  #nextAllowedByChannel = new Map<string, number>();

  constructor(input: {
    database: AppDatabase;
    enableQueue?: boolean;
    encryptionKey?: string;
    redisUrl?: string;
  }) {
    this.#database = input.database;
    this.#catalog = input.encryptionKey
      ? new ProviderCatalog({
          database: input.database,
          encryptionKey: input.encryptionKey
        })
      : null;
    this.#queue =
      input.enableQueue && input.redisUrl
        ? createSmsMessagesQueue(input.redisUrl)
        : null;
    this.#registry = new DatabaseChannelRegistry(input.database);
    this.#senderIdService = new SenderIdService(
      input.encryptionKey
        ? {
            database: input.database,
            encryptionKey: input.encryptionKey
          }
        : {
            database: input.database
          }
    );
  }

  async close() {
    await this.#queue?.close();
  }

  async create(input: {
    createdBy: string;
    merchantId: string;
    metadata: Json;
    mode: RpMode;
    reference: string | null;
    scheduleAt: Date | null;
    senderId: string | null;
    templateId: string | null;
    templateVariables: Record<string, string | number | boolean | null | undefined>;
    to: string;
    type: SmsMessageType;
    userMessage: string | null;
  }): Promise<SmsMessageRecord> {
    const messageText = await this.#resolveMessageBody({
      merchantId: input.merchantId,
      mode: input.mode,
      templateId: input.templateId,
      templateVariables: input.templateVariables,
      userMessage: input.userMessage
    });

    const prepared = await this.#prepareRecipient({
      merchantId: input.merchantId,
      mode: input.mode,
      preferredSenderId: input.senderId,
      scheduleAt: input.scheduleAt,
      to: input.to,
      type: input.type,
      userMessage: messageText
    });

    if (input.type === "marketing") {
      const optedOut = await this.#isOptedOut(input.merchantId, input.mode, prepared.normalizedPhone);
      if (optedOut) {
        return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
          await this.#assertSmsProductEnabled(trx, input.merchantId, input.mode);
          const rejected = await trx
            .insertInto("sms_messages")
            .values({
              batch_id: null,
              body: prepared.body,
              channel_id: null,
              created_at: new Date(),
              currency: prepared.currency,
              delivered_at: null,
              encoding: countSmsSegments(prepared.body).encoding,
              failure_code: "opted_out",
              id: newId("sms_"),
              merchant_id: input.merchantId,
              metadata: input.metadata,
              mode: input.mode,
              price_minor: 0,
              provider_ref: null,
              reference: input.reference,
              scheduled_at: prepared.scheduledAt,
              segments: prepared.segments,
              sender_id: prepared.senderId,
              sent_at: null,
              status: "rejected",
              to: prepared.normalizedPhone,
              type: input.type
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          await this.#recordSmsStatusEvent(trx, {
            merchantId: input.merchantId,
            mode: input.mode,
            reason: "Recipient opted out of marketing messages.",
            resourceId: rejected.id,
            toStatus: "rejected"
          });

          return mapSmsMessage(rejected);
        });
      }
    }

    let messageId = "";
    const created = await runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      await this.#assertSmsProductEnabled(trx, input.merchantId, input.mode);

      const inserted = await trx
        .insertInto("sms_messages")
        .values({
          batch_id: null,
          body: prepared.body,
          channel_id: null,
          created_at: new Date(),
          currency: prepared.currency,
          delivered_at: null,
          encoding: countSmsSegments(prepared.body).encoding,
          failure_code: null,
          id: newId("sms_"),
          merchant_id: input.merchantId,
          metadata: input.metadata,
          mode: input.mode,
          price_minor: prepared.priceMinor,
          provider_ref: null,
          reference: input.reference,
          scheduled_at: prepared.scheduledAt,
          segments: prepared.segments,
          sender_id: prepared.senderId,
          sent_at: null,
          status: "queued",
          to: prepared.normalizedPhone,
          type: input.type
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      messageId = inserted.id;

      if (prepared.priceMinor > 0n) {
        const ledger = new LedgerService(trx, {
          actorId: input.createdBy,
          actorType: "api_key"
        });
        await ledger.chargeSms({
          amount: prepared.priceMinor,
          currency: prepared.currency,
          merchantId: input.merchantId,
          mode: input.mode,
          smsId: inserted.id
        });
      }

      await this.#recordSmsStatusEvent(trx, {
        merchantId: input.merchantId,
        mode: input.mode,
        resourceId: inserted.id,
        toStatus: "queued"
      });

      return mapSmsMessage(inserted);
    });

    await this.#enqueueMessages([
      {
        id: messageId,
        scheduledAt: created.scheduledAt
      }
    ]);

    return created;
  }

  async createBulk(input: {
    contactGroupId: string | null;
    createdBy: string;
    merchantId: string;
    metadata: Json;
    mode: RpMode;
    reference: string | null;
    scheduleAt: Date | null;
    senderId: string | null;
    to: Array<string | { name?: string; phone: string }> | null;
    type: SmsMessageType;
    userMessage: string;
  }): Promise<{
    acceptedCount: number;
    batch: SmsBatchView;
    rejectedCount: number;
  }> {
    const recipients = await this.#expandRecipients({
      contactGroupId: input.contactGroupId,
      merchantId: input.merchantId,
      mode: input.mode,
      to: input.to
    });

    const batchId = newId("smb_");
    const acceptedRows: Array<{
      body: string;
      currency: CurrencyCode;
      metadata: Json;
      priceMinor: bigint;
      record: PreparedRecipient;
      reference: string | null;
      type: SmsMessageType;
    }> = [];
    const queuedIds: Array<{ id: string; scheduledAt: Date | null }> = [];
    let rejectedCount = 0;

    for (const recipient of recipients) {
      try {
        const body = renderTemplate(input.userMessage, {
          name: recipient.name ?? ""
        });
        const prepared = await this.#prepareRecipient({
          merchantId: input.merchantId,
          mode: input.mode,
          preferredSenderId: input.senderId,
          scheduleAt: input.scheduleAt,
          to: recipient.phone,
          type: input.type,
          userMessage: body
        });

        if (
          input.type === "marketing" &&
          await this.#isOptedOut(input.merchantId, input.mode, prepared.normalizedPhone)
        ) {
          rejectedCount += 1;
          continue;
        }

        acceptedRows.push({
          body,
          currency: prepared.currency,
          metadata: input.metadata,
          priceMinor: prepared.priceMinor,
          record: prepared,
          reference: input.reference,
          type: input.type
        });
      } catch {
        rejectedCount += 1;
      }
    }

    const batch = await runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      await this.#assertSmsProductEnabled(trx, input.merchantId, input.mode);

      const insertedBatch = await trx
        .insertInto("sms_batches")
        .values({
          accepted_count: acceptedRows.length,
          body: input.userMessage,
          created_by: input.createdBy,
          id: batchId,
          merchant_id: input.merchantId,
          metadata: input.metadata,
          mode: input.mode,
          reference: input.reference,
          rejected_count: rejectedCount,
          scheduled_at: input.scheduleAt,
          sender_id: input.senderId,
          status:
            acceptedRows.length === 0
              ? "partial"
              : rejectedCount > 0
                ? "partial"
                : "queued",
          total_count: recipients.length,
          type: input.type
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const messages = [];
      for (const item of acceptedRows) {
        const inserted = await trx
          .insertInto("sms_messages")
          .values({
            batch_id: batchId,
            body: item.body,
            channel_id: null,
            created_at: new Date(),
            currency: item.currency,
            delivered_at: null,
            encoding: countSmsSegments(item.body).encoding,
            failure_code: null,
            id: newId("sms_"),
            merchant_id: input.merchantId,
            metadata: item.metadata,
            mode: input.mode,
            price_minor: item.priceMinor,
            provider_ref: null,
            reference: item.reference,
            scheduled_at: item.record.scheduledAt,
            segments: item.record.segments,
            sender_id: item.record.senderId,
            sent_at: null,
            status: "queued",
            to: item.record.normalizedPhone,
            type: item.type
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        if (item.priceMinor > 0n) {
          const ledger = new LedgerService(trx, {
            actorId: input.createdBy,
            actorType: "api_key"
          });
          await ledger.chargeSms({
            amount: item.priceMinor,
            currency: item.currency,
            merchantId: input.merchantId,
            mode: input.mode,
            smsId: inserted.id
          });
        }

        await this.#recordSmsStatusEvent(trx, {
          merchantId: input.merchantId,
          mode: input.mode,
          resourceId: inserted.id,
          toStatus: "queued"
        });

        queuedIds.push({
          id: inserted.id,
          scheduledAt: inserted.scheduled_at
        });
        messages.push(mapSmsMessage(inserted));
      }

      return {
        ...mapSmsBatch(insertedBatch),
        messages
      } satisfies SmsBatchView;
    });

    await this.#enqueueMessages(queuedIds);

    return {
      acceptedCount: acceptedRows.length,
      batch,
      rejectedCount
    };
  }

  async sendOtp(input: {
    createdBy: string;
    expiresInSeconds: number;
    length: number;
    merchantId: string;
    mode: RpMode;
    senderId: string | null;
    template: string | null;
    to: string;
  }): Promise<{
    expiresAt: Date;
    otpId: string;
    smsMessage: SmsMessageRecord;
  }> {
    const otpId = newId("otp_");
    const code = generateOtpCode(input.length);
    const template = input.template ?? "Your RichesPay verification code is {{code}}.";
    const message = renderTemplate(template, { code });
    const smsMessage = await this.create({
      createdBy: input.createdBy,
      merchantId: input.merchantId,
      metadata: {
        otp_id: otpId
      },
      mode: input.mode,
      reference: otpId,
      scheduleAt: null,
      senderId: input.senderId,
      templateId: null,
      templateVariables: {},
      to: input.to,
      type: "otp",
      userMessage: message
    });

    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);

    await runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      await this.#assertSmsProductEnabled(trx, input.merchantId, input.mode);
      await trx
        .insertInto("sms_otps")
        .values({
          attempts: 0,
          code_hash: hashOtpCode(otpId, code),
          created_at: new Date(),
          expires_at: expiresAt,
          id: otpId,
          max_attempts: 5,
          merchant_id: input.merchantId,
          mode: input.mode,
          sender_id: smsMessage.senderId,
          sms_message_id: smsMessage.id,
          status: "pending",
          to: smsMessage.to,
          verified_at: null
        })
        .execute();
    });

    return {
      expiresAt,
      otpId,
      smsMessage
    };
  }

  async verifyOtp(input: {
    code: string;
    merchantId: string;
    mode: RpMode;
    otpId: string;
  }): Promise<{
    otp: SmsOtpRecord;
    verified: boolean;
  }> {
    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      await this.#assertSmsProductEnabled(trx, input.merchantId, input.mode);
      const otp = await trx
        .selectFrom("sms_otps")
        .selectAll()
        .where("id", "=", input.otpId)
        .executeTakeFirst();

      if (!otp) {
        throw new ApiRouteError({
          code: "not_found",
          message: "OTP was not found.",
          statusCode: 404
        });
      }

      if (otp.status === "verified") {
        return {
          otp: mapSmsOtp(otp),
          verified: true
        };
      }

      const now = new Date();
      if (otp.expires_at <= now) {
        const expired = await trx
          .updateTable("sms_otps")
          .set({
            status: "expired"
          })
          .where("id", "=", input.otpId)
          .returningAll()
          .executeTakeFirstOrThrow();

        return {
          otp: mapSmsOtp(expired),
          verified: false
        };
      }

      if (otp.attempts >= otp.max_attempts) {
        const failed = await trx
          .updateTable("sms_otps")
          .set({
            status: "failed"
          })
          .where("id", "=", input.otpId)
          .returningAll()
          .executeTakeFirstOrThrow();

        return {
          otp: mapSmsOtp(failed),
          verified: false
        };
      }

      const matches = otp.code_hash === hashOtpCode(input.otpId, input.code.trim());
      if (matches) {
        const verified = await trx
          .updateTable("sms_otps")
          .set({
            status: "verified",
            verified_at: now
          })
          .where("id", "=", input.otpId)
          .returningAll()
          .executeTakeFirstOrThrow();

        return {
          otp: mapSmsOtp(verified),
          verified: true
        };
      }

      const attempts = otp.attempts + 1;
      const failed = await trx
        .updateTable("sms_otps")
        .set({
          attempts,
          status: attempts >= otp.max_attempts ? "failed" : otp.status
        })
        .where("id", "=", input.otpId)
        .returningAll()
        .executeTakeFirstOrThrow();

      return {
        otp: mapSmsOtp(failed),
        verified: false
      };
    });
  }

  async getById(merchantId: string, mode: RpMode, id: string): Promise<SmsMessageRecord> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      await this.#assertSmsProductEnabled(trx, merchantId, mode);
      const row = await trx
        .selectFrom("sms_messages")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

      if (!row) {
        throw new ApiRouteError({
          code: "not_found",
          message: "SMS message was not found.",
          statusCode: 404
        });
      }

      return mapSmsMessage(row);
    });
  }

  async list(
    merchantId: string,
    mode: RpMode,
    filters: {
      batchId?: string;
      createdGte?: Date;
      createdLte?: Date;
      reference?: string;
      startingAfter?: string;
      status?: SmsMessageStatus;
      to?: string;
      type?: SmsMessageType;
    },
    limit: number
  ): Promise<{
    items: SmsMessageRecord[];
    nextStartingAfter: string | null;
  }> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      await this.#assertSmsProductEnabled(trx, merchantId, mode);

      let query = trx
        .selectFrom("sms_messages")
        .selectAll()
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1);

      if (filters.batchId) {
        query = query.where("batch_id", "=", filters.batchId);
      }

      if (filters.createdGte) {
        query = query.where("created_at", ">=", filters.createdGte);
      }

      if (filters.createdLte) {
        query = query.where("created_at", "<=", filters.createdLte);
      }

      if (filters.reference) {
        query = query.where("reference", "=", filters.reference);
      }

      if (filters.status) {
        query = query.where("status", "=", filters.status);
      }

      if (filters.to) {
        query = query.where("to", "=", filters.to);
      }

      if (filters.type) {
        query = query.where("type", "=", filters.type);
      }

      if (filters.startingAfter) {
        const cursor = await trx
          .selectFrom("sms_messages")
          .select(["created_at", "id"])
          .where("id", "=", filters.startingAfter)
          .executeTakeFirst();

        if (cursor) {
          query = query.where((eb) =>
            eb.or([
              eb("created_at", "<", cursor.created_at),
              eb.and([
                eb("created_at", "=", cursor.created_at),
                eb("id", "<", cursor.id)
              ])
            ])
          );
        }
      }

      const rows = await query.execute();
      const items = rows.slice(0, limit).map(mapSmsMessage);
      const nextStartingAfter = rows.length > limit ? items.at(-1)?.id ?? null : null;

      return {
        items,
        nextStartingAfter
      };
    });
  }

  async getBatchById(
    merchantId: string,
    mode: RpMode,
    id: string
  ): Promise<SmsBatchView> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      await this.#assertSmsProductEnabled(trx, merchantId, mode);
      const batch = await trx
        .selectFrom("sms_batches")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

      if (!batch) {
        throw new ApiRouteError({
          code: "not_found",
          message: "SMS batch was not found.",
          statusCode: 404
        });
      }

      const messages = await trx
        .selectFrom("sms_messages")
        .selectAll()
        .where("batch_id", "=", id)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();

      return {
        ...mapSmsBatch(batch),
        messages: messages.map(mapSmsMessage)
      };
    });
  }

  async processQueuedMessages(limit = 50): Promise<number> {
    const rows = await runWithSystemScope(
      this.#database,
      "list queued sms messages",
      async (trx) =>
        trx
          .selectFrom("sms_messages")
          .select(["id"])
          .where("status", "=", "queued")
          .where((eb) =>
            eb.or([
              eb("scheduled_at", "is", null),
              eb("scheduled_at", "<=", new Date())
            ])
          )
          .orderBy("scheduled_at", "asc")
          .orderBy("created_at", "asc")
          .limit(limit)
          .execute(),
      { audit: false }
    );

    for (const row of rows) {
      await this.processQueuedMessage(row.id);
    }

    return rows.length;
  }

  async processQueuedMessage(messageId: string): Promise<void> {
    const catalog = this.#requireCatalog();

    const message = await runWithSystemScope(
      this.#database,
      "load queued sms message",
      async (trx) =>
        trx
          .selectFrom("sms_messages")
          .selectAll()
          .where("id", "=", messageId)
          .executeTakeFirst(),
      { audit: false }
    );

    if (
      !message ||
      message.status !== "queued" ||
      (message.scheduled_at !== null && message.scheduled_at > new Date())
    ) {
      return;
    }

    const phone = normalizeSmsPhoneNumber(message.to);
    const countryCode = phone.countryCode;
    const network = await detectNetworkFromMsisdn(this.#database, {
      countryCode,
      msisdn: message.to
    });
    const channels = await this.#loadOrderedSmsChannels({
      countryCode,
      mode: message.mode,
      network
    });

    let finalState:
      | {
          channelId: string;
          providerRef: string | null;
          status: "sent";
        }
      | {
          failureCode: string | null;
          status: "failed" | "rejected";
        }
      | null = null;

    for (const channel of channels) {
      try {
        await this.#waitForChannelSlot(channel.id, getChannelTps(channel.config));
        const result = await catalog.resolveSmsProvider(channel).send({
          body: message.body,
          context: {
            merchantId: message.merchant_id,
            mode: message.mode,
            requestId: `sms:${message.id}`
          },
          metadata: message.metadata,
          reference: message.id,
          senderId: message.sender_id,
          to: message.to
        });

        if (result.outcome === "accepted" || result.outcome === "succeeded") {
          finalState = {
            channelId: channel.id,
            providerRef: result.providerRef ?? null,
            status: "sent"
          };

          await runWithSystemScope(
            this.#database,
            "mark sms message sent",
            async (trx) => {
              const updated = await trx
                .updateTable("sms_messages")
                .set({
                  channel_id: channel.id,
                  provider_ref: result.providerRef ?? null,
                  sent_at: new Date(),
                  status: "sent"
                })
                .where("id", "=", message.id)
                .where("status", "=", "queued")
                .returningAll()
                .executeTakeFirst();

              if (!updated) {
                return;
              }

              await this.#recordSmsStatusEvent(trx, {
                fromStatus: "queued",
                merchantId: updated.merchant_id,
                mode: updated.mode,
                providerRef: updated.provider_ref,
                rawPayload: result.rawRedacted,
                resourceId: updated.id,
                toStatus: "sent"
              });
            },
            { audit: false }
          );

          const deliveryReport = extractSyntheticDeliveryReport(result.rawRedacted);
          if (deliveryReport) {
            await this.applyDeliveryReport({
              merchantId: message.merchant_id,
              mode: message.mode,
              providerRef: result.providerRef ?? null,
              rawPayload: result.rawRedacted,
              resourceId: message.id,
              toStatus: deliveryReport
            });
          }

          return;
        }

        finalState = {
          failureCode: result.failureCode ?? null,
          status: "rejected"
        };
      } catch {
        finalState = {
          failureCode: null,
          status: "failed"
        };
      }
    }

    if (!finalState) {
      return;
    }

    await runWithSystemScope(
      this.#database,
      "mark sms message failed",
      async (trx) => {
        const updated = await trx
          .updateTable("sms_messages")
          .set({
            failure_code: finalState.status === "rejected"
              ? finalState.failureCode ?? "provider_rejected"
              : finalState.failureCode ?? "channel_unavailable",
            status: finalState.status
          })
          .where("id", "=", message.id)
          .where("status", "=", "queued")
          .returningAll()
          .executeTakeFirst();

        if (!updated) {
          return;
        }

        await this.#recordSmsStatusEvent(trx, {
          fromStatus: "queued",
          merchantId: updated.merchant_id,
          mode: updated.mode,
          ...(updated.failure_code ? { reason: updated.failure_code } : {}),
          resourceId: updated.id,
          toStatus: updated.status
        });

        if (updated.status === "rejected" && BigInt(updated.price_minor) > 0n) {
          await this.#refundRejectedSms(trx, updated.id);
        }

        if (updated.batch_id) {
          await this.#refreshBatchStatus(trx, updated.batch_id);
        }
      },
      { audit: false }
    );
  }

  async applyDeliveryReport(input: {
    merchantId?: string | null;
    mode?: RpMode | null;
    providerRef?: string | null;
    rawPayload?: Json | null;
    resourceId?: string | null;
    toStatus: string;
  }): Promise<void> {
    const mappedStatus = mapDeliveryStatus(input.toStatus);
    if (!mappedStatus) {
      return;
    }

    await runWithSystemScope(
      this.#database,
      "apply sms delivery report",
      async (trx) => {
        let query = trx
          .selectFrom("sms_messages")
          .selectAll()
          .orderBy("created_at", "desc");

        if (input.resourceId) {
          query = query.where("id", "=", input.resourceId);
        } else if (input.providerRef) {
          query = query.where("provider_ref", "=", input.providerRef);
        } else {
          return;
        }

        const current = await query.executeTakeFirst();
        if (!current) {
          return;
        }

        const fromStatus = current.status;
        if (fromStatus === mappedStatus) {
          return;
        }

        const updated = await trx
          .updateTable("sms_messages")
          .set({
            delivered_at: mappedStatus === "delivered" ? new Date() : current.delivered_at,
            failure_code:
              mappedStatus === "delivered"
                ? null
                : current.failure_code ?? normalizedFailureCode(mappedStatus),
            status: mappedStatus
          })
          .where("id", "=", current.id)
          .returningAll()
          .executeTakeFirstOrThrow();

        await this.#recordSmsStatusEvent(trx, {
          fromStatus,
          merchantId: updated.merchant_id,
          mode: updated.mode,
          ...(updated.provider_ref ? { providerRef: updated.provider_ref } : {}),
          ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload ?? null } : {}),
          ...(updated.failure_code ? { reason: updated.failure_code } : {}),
          resourceId: updated.id,
          toStatus: mappedStatus
        });

        if (mappedStatus === "delivered" || mappedStatus === "failed" || mappedStatus === "undelivered") {
          await trx
            .insertInto("events_outbox")
            .values({
              created_at: new Date(),
              id: newId("evt_"),
              merchant_id: updated.merchant_id,
              mode: updated.mode,
              payload: {
                id: updated.id,
                provider_ref: updated.provider_ref,
                status: mappedStatus,
                to: updated.to,
                type: updated.type
              },
              type: mappedStatus === "delivered" ? "sms.delivered" : "sms.failed"
            })
            .execute();
        }

        if (updated.batch_id) {
          await this.#refreshBatchStatus(trx, updated.batch_id);
        }
      },
      { audit: false }
    );
  }

  async #enqueueMessages(messages: Array<{ id: string; scheduledAt: Date | null }>) {
    if (!this.#queue || messages.length === 0) {
      return;
    }

    for (const message of messages) {
      const delay = message.scheduledAt
        ? Math.max(0, message.scheduledAt.getTime() - Date.now())
        : 0;

      await this.#queue.add(
        "dispatch",
        {
          smsMessageId: message.id
        },
        {
          delay,
          jobId: message.id,
          removeOnComplete: 100,
          removeOnFail: 100
        }
      );
    }
  }

  async #expandRecipients(input: {
    contactGroupId: string | null;
    merchantId: string;
    mode: RpMode;
    to: Array<string | { name?: string; phone: string }> | null;
  }): Promise<ExpandedRecipient[]> {
    if ((input.to === null) === (input.contactGroupId === null)) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "to",
        message: "Provide either to or contact_group_id.",
        statusCode: 400
      });
    }

    if (input.to) {
      return input.to.map((recipient) =>
        typeof recipient === "string"
          ? {
              name: null,
              phone: recipient
            }
          : {
              name: recipient.name?.trim() || null,
              phone: recipient.phone
            }
      );
    }

    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      const rows = await trx
        .selectFrom("contact_group_members as membership")
        .innerJoin("contacts as contact", "contact.id", "membership.contact_id")
        .select(["contact.name as name", "contact.phone as phone"])
        .where("membership.group_id", "=", input.contactGroupId!)
        .orderBy("contact.created_at", "asc")
        .execute();

      return rows.map((row) => ({
        name: row.name,
        phone: row.phone
      }));
    });
  }

  async #prepareRecipient(input: {
    merchantId: string;
    mode: RpMode;
    preferredSenderId: string | null;
    scheduleAt: Date | null;
    to: string;
    type: SmsMessageType;
    userMessage: string;
  }): Promise<PreparedRecipient> {
    const phone = normalizeSmsPhoneNumber(input.to);
    const countryCode = phone.countryCode;
    const network = await detectNetworkFromMsisdn(this.#database, {
      countryCode,
      msisdn: phone.number
    });
    const price = await this.#loadSmsPrice(countryCode, network);
    const sender = await this.#senderIdService.resolveSenderId({
      countryCode,
      merchantId: input.merchantId,
      mode: input.mode,
      network,
      preferredSenderId: input.preferredSenderId,
      purpose: input.type
    });
    const segmentInfo = countSmsSegments(input.userMessage);
    const effectiveSchedule = await this.#applyMarketingQuietHours({
      countryCode,
      requestedScheduleAt: input.scheduleAt,
      type: input.type
    });

    return {
      body: input.userMessage,
      countryCode,
      currency: price.currency,
      network,
      normalizedPhone: phone.number,
      priceMinor: price.pricePerSegmentMinor * BigInt(segmentInfo.segments),
      scheduledAt: effectiveSchedule,
      segments: segmentInfo.segments,
      senderId: sender.senderId
    };
  }

  async #resolveMessageBody(input: {
    merchantId: string;
    mode: RpMode;
    templateId: string | null;
    templateVariables: Record<string, string | number | boolean | null | undefined>;
    userMessage: string | null;
  }) {
    if ((input.userMessage === null) === (input.templateId === null)) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "message",
        message: "Provide either message or template_id with variables.",
        statusCode: 400
      });
    }

    if (input.userMessage) {
      return input.userMessage.trim();
    }

    return runWithMerchantScope(this.#database, input.merchantId, input.mode, async (trx) => {
      const template = await trx
        .selectFrom("sms_templates")
        .select(["body"])
        .where("id", "=", input.templateId!)
        .executeTakeFirst();

      if (!template) {
        throw new ApiRouteError({
          code: "not_found",
          message: "SMS template was not found.",
          statusCode: 404
        });
      }

      return renderTemplate(template.body, input.templateVariables);
    });
  }

  async #assertSmsProductEnabled(trx: ScopedTransaction, merchantId: string, mode: RpMode) {
    await requireProduct(trx, { merchantId, mode }, "sms");
  }

  async #isOptedOut(merchantId: string, mode: RpMode, phone: string) {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const row = await trx
        .selectFrom("sms_opt_outs")
        .select(["id"])
        .where("phone", "=", phone)
        .executeTakeFirst();

      return row !== undefined;
    });
  }

  async #loadSmsPrice(countryCode: string, network: string | null) {
    return runWithSystemScope(
      this.#database,
      "load sms price",
      async (trx) => {
        const exact = await trx
          .selectFrom("sms_prices")
          .selectAll()
          .where("country_code", "=", countryCode)
          .where("network", network ? "=" : "is", network ?? null)
          .executeTakeFirst();

        const fallback = network
          ? await trx
              .selectFrom("sms_prices")
              .selectAll()
              .where("country_code", "=", countryCode)
              .where("network", "is", null)
              .executeTakeFirst()
          : null;

        const price = exact ?? fallback;
        if (!price) {
          throw new ApiRouteError({
            code: "channel_unavailable",
            message: "No SMS price is configured for this route.",
            statusCode: 503
          });
        }

        return {
          currency: price.currency as CurrencyCode,
          pricePerSegmentMinor: BigInt(price.price_per_segment_minor)
        };
      },
      { audit: false }
    );
  }

  async #loadOrderedSmsChannels(input: {
    countryCode: string;
    mode: RpMode;
    network: string | null;
  }) {
    if (input.mode === "test") {
      const simulator = await this.#registry.getSimulatorChannel({
        capability: "sms",
        kind: "sms"
      });
      return simulator ? [simulator] : [];
    }

    const candidates = await this.#registry.listChannels({
      countryCode: input.countryCode,
      kind: "sms",
      mode: input.mode,
      network: input.network
    });
    const eligible = candidates.filter(
      (channel) =>
        channel.status === "active" &&
        channel.health === "healthy" &&
        channel.capabilities.includes("sms")
    );
    const rule = await this.#registry.loadRoutingRule({
      capability: "sms",
      countryCode: input.countryCode,
      kind: "sms",
      network: input.network
    });

    if (!rule) {
      return [...eligible].sort((left, right) => left.priority - right.priority);
    }

    const byId = new Map(eligible.map((channel) => [channel.id, channel]));
    const ordered = [];

    for (const channelId of rule.channelIds) {
      const channel = byId.get(channelId);
      if (channel) {
        ordered.push(channel);
        byId.delete(channelId);
      }
    }

    return [...ordered, ...[...byId.values()].sort((left, right) => left.priority - right.priority)];
  }

  async #waitForChannelSlot(channelId: string, tps: number | null) {
    if (!tps || tps <= 0) {
      return;
    }

    const spacingMs = Math.ceil(1000 / tps);
    const now = Date.now();
    const nextAllowed = this.#nextAllowedByChannel.get(channelId) ?? now;
    if (nextAllowed > now) {
      await new Promise((resolve) => setTimeout(resolve, nextAllowed - now));
    }

    this.#nextAllowedByChannel.set(channelId, Math.max(nextAllowed, now) + spacingMs);
  }

  async #refundRejectedSms(trx: ScopedTransaction, smsId: string) {
    const journal = await trx
      .selectFrom("journal_entries")
      .select(["id"])
      .where("reference_type", "=", "sms")
      .where("reference_id", "=", smsId)
      .orderBy("created_at", "desc")
      .executeTakeFirst();

    if (!journal) {
      return;
    }

    const ledger = new LedgerService(trx, {
      actorId: "sms_dispatch_worker",
      actorType: "system"
    });
    await ledger.reverse(journal.id, "Rejected before reaching the SMS network");
  }

  async #recordSmsStatusEvent(trx: ScopedTransaction, input: {
    fromStatus?: string;
    merchantId: string;
    mode: RpMode;
    providerRef?: string | null;
    rawPayload?: Json | null;
    reason?: string;
    resourceId: string;
    toStatus: string;
  }) {
    await trx
      .insertInto("transaction_events")
      .values({
        created_at: new Date(),
        from_status: input.fromStatus ?? null,
        id: newId("evt_"),
        merchant_id: input.merchantId,
        mode: input.mode,
        provider_payload: input.rawPayload ?? null,
        provider_reference: input.providerRef ?? null,
        reason: input.reason ?? null,
        resource_id: input.resourceId,
        resource_type: "sms",
        to_status: input.toStatus
      })
      .execute();
  }

  async #refreshBatchStatus(trx: ScopedTransaction, batchId: string) {
    const statuses = await trx
      .selectFrom("sms_messages")
      .select(["status"])
      .where("batch_id", "=", batchId)
      .execute();

    if (statuses.length === 0) {
      await trx
        .updateTable("sms_batches")
        .set({
          status: "partial"
        })
        .where("id", "=", batchId)
        .execute();
      return;
    }

    const values = statuses.map((row) => row.status);
    const hasPending = values.some((status) => status === "queued" || status === "sent");
    const hasFailures = values.some(
      (status) => status === "failed" || status === "rejected" || status === "undelivered"
    );

    await trx
      .updateTable("sms_batches")
      .set({
        status: hasPending ? "processing" : hasFailures ? "partial" : "completed"
      })
      .where("id", "=", batchId)
      .execute();
  }

  async #applyMarketingQuietHours(input: {
    countryCode: string;
    requestedScheduleAt: Date | null;
    type: SmsMessageType;
  }) {
    const baseSchedule = input.requestedScheduleAt;
    if (input.type !== "marketing") {
      return baseSchedule;
    }

    const country = await runWithSystemScope(
      this.#database,
      "load sms country timezone",
      async (trx) =>
        trx
          .selectFrom("countries")
          .select(["timezone"])
          .where("code", "=", input.countryCode)
          .executeTakeFirstOrThrow(),
      { audit: false }
    );

    const candidate = baseSchedule ?? new Date();
    const localParts = getLocalTimeParts(candidate, country.timezone);
    const quietHours = localParts.hour >= 20 || localParts.hour < 8;
    if (!quietHours) {
      return baseSchedule;
    }

    const nextDay =
      localParts.hour >= 20
        ? {
            day: localParts.day + 1,
            month: localParts.month,
            year: localParts.year
          }
        : {
            day: localParts.day,
            month: localParts.month,
            year: localParts.year
          };

    return zonedTimeToUtc(
      {
        ...normalizeCalendarDate(nextDay),
        hour: 8,
        minute: 0,
        second: 0
      },
      country.timezone
    );
  }

  #requireCatalog() {
    if (!this.#catalog) {
      throw new Error("SMS provider catalog requires an encryption key");
    }

    return this.#catalog;
  }
}

function mapSmsMessage(row: {
  batch_id: string | null;
  body: string;
  channel_id: string | null;
  created_at: Date;
  currency: string;
  delivered_at: Date | null;
  encoding: SmsMessageRecord["encoding"];
  failure_code: string | null;
  id: string;
  merchant_id: string;
  metadata: Json;
  mode: RpMode;
  price_minor: string;
  provider_ref: string | null;
  reference: string | null;
  scheduled_at: Date | null;
  segments: number;
  sender_id: string;
  sent_at: Date | null;
  status: SmsMessageRecord["status"];
  to: string;
  type: SmsMessageRecord["type"];
}): SmsMessageRecord {
  return {
    batchId: row.batch_id,
    body: row.body,
    channelId: row.channel_id,
    createdAt: row.created_at,
    currency: row.currency as CurrencyCode,
    deliveredAt: row.delivered_at,
    encoding: row.encoding,
    failureCode: row.failure_code,
    id: row.id,
    merchantId: row.merchant_id,
    metadata: row.metadata,
    mode: row.mode,
    priceMinor: BigInt(row.price_minor),
    providerRef: row.provider_ref,
    reference: row.reference,
    scheduledAt: row.scheduled_at,
    segments: row.segments,
    senderId: row.sender_id,
    sentAt: row.sent_at,
    status: row.status,
    to: row.to,
    type: row.type
  };
}

function mapSmsBatch(row: {
  accepted_count: number;
  body: string;
  created_at: Date;
  created_by: string;
  id: string;
  merchant_id: string;
  metadata: Json;
  mode: RpMode;
  reference: string | null;
  rejected_count: number;
  scheduled_at: Date | null;
  sender_id: string | null;
  status: SmsBatchRecord["status"];
  total_count: number;
  type: SmsBatchRecord["type"];
  updated_at: Date;
}): SmsBatchRecord {
  return {
    acceptedCount: row.accepted_count,
    body: row.body,
    createdAt: row.created_at,
    createdBy: row.created_by,
    id: row.id,
    merchantId: row.merchant_id,
    metadata: row.metadata,
    mode: row.mode,
    reference: row.reference,
    rejectedCount: row.rejected_count,
    scheduledAt: row.scheduled_at,
    senderId: row.sender_id,
    status: row.status,
    totalCount: row.total_count,
    type: row.type,
    updatedAt: row.updated_at
  };
}

function mapSmsOtp(row: {
  attempts: number;
  created_at: Date;
  expires_at: Date;
  id: string;
  max_attempts: number;
  merchant_id: string;
  mode: RpMode;
  sender_id: string | null;
  sms_message_id: string | null;
  status: SmsOtpRecord["status"];
  to: string;
  verified_at: Date | null;
}): SmsOtpRecord {
  return {
    attempts: row.attempts,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    id: row.id,
    maxAttempts: row.max_attempts,
    merchantId: row.merchant_id,
    mode: row.mode,
    senderId: row.sender_id,
    smsMessageId: row.sms_message_id,
    status: row.status,
    to: row.to,
    verifiedAt: row.verified_at
  };
}

function normalizeSmsPhoneNumber(phone: string) {
  try {
    const parsed = parsePhoneNumberWithError(phone);
    if (!parsed.isValid() || !parsed.country) {
      throw new ApiRouteError({
        code: "invalid_phone_number",
        message: "The phone number is invalid.",
        statusCode: 400
      });
    }

    return {
      countryCode: parsed.country,
      number: parsed.number
    };
  } catch (error) {
    if (error instanceof ApiRouteError) {
      throw error;
    }

    if (error instanceof ParseError) {
      throw new ApiRouteError({
        code: "invalid_phone_number",
        message: "The phone number is invalid.",
        statusCode: 400
      });
    }

    throw error;
  }
}

function mapDeliveryStatus(value: string): SmsMessageStatus | null {
  const normalized = value.trim().toLowerCase();

  if (normalized === "delivered" || normalized === "success" || normalized === "successful") {
    return "delivered";
  }

  if (normalized === "undelivered") {
    return "undelivered";
  }

  if (normalized === "rejected") {
    return "rejected";
  }

  if (normalized === "failed") {
    return "failed";
  }

  return null;
}

function normalizedFailureCode(status: SmsMessageStatus) {
  switch (status) {
    case "failed":
      return "delivery_failed";
    case "rejected":
      return "provider_rejected";
    case "undelivered":
      return "undelivered";
    default:
      return null;
  }
}

function extractSyntheticDeliveryReport(rawPayload: Json | null) {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return null;
  }

  const report = rawPayload.delivery_report;
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return null;
  }

  return typeof report.status === "string" ? report.status : null;
}

function getChannelTps(config: Json) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }

  const value = config.tps;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function getLocalTimeParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric"
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    month: Number(parts.month),
    second: Number(parts.second),
    year: Number(parts.year)
  };
}

function zonedTimeToUtc(
  input: {
    day: number;
    hour: number;
    minute: number;
    month: number;
    second: number;
    year: number;
  },
  timeZone: string
) {
  const utcGuess = new Date(
    Date.UTC(
      input.year,
      input.month - 1,
      input.day,
      input.hour,
      input.minute,
      input.second
    )
  );
  const offset = getTimeZoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offset);
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = getLocalTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - date.getTime();
}

function normalizeCalendarDate(input: {
  day: number;
  month: number;
  year: number;
}) {
  const normalized = new Date(Date.UTC(input.year, input.month - 1, input.day));
  return {
    day: normalized.getUTCDate(),
    month: normalized.getUTCMonth() + 1,
    year: normalized.getUTCFullYear()
  };
}
