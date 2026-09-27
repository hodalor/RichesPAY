import { z } from "zod";

import type { Json } from "../db/types";
import type { FastifyTypedInstance } from "../types";
import { requireIdempotency } from "../public-api/idempotency";

import { SmsMessagingService } from "./public-service";
import { smsBatchStatuses, smsMessageEncodings, smsMessageStatuses, smsMessageTypes, smsOtpStatuses } from "./public-types";

const metadataSchema = z.record(z.string(), z.unknown()).default({});
const templateVariablesSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .default({});

const recipientSchema = z.union([
  z.string().min(4),
  z.object({
    name: z.string().min(1).optional(),
    phone: z.string().min(4)
  })
]);

const smsMessageResponseSchema = z.object({
  batch_id: z.string().nullable(),
  body: z.string(),
  channel_id: z.string().nullable(),
  created_at: z.string().datetime(),
  currency: z.string(),
  delivered_at: z.string().datetime().nullable(),
  encoding: z.enum(smsMessageEncodings),
  failure_code: z.string().nullable(),
  id: z.string(),
  metadata: metadataSchema,
  price_minor: z.number().int(),
  provider_ref: z.string().nullable(),
  reference: z.string().nullable(),
  scheduled_at: z.string().datetime().nullable(),
  segments: z.number().int(),
  sender_id: z.string(),
  sent_at: z.string().datetime().nullable(),
  status: z.enum(smsMessageStatuses),
  to: z.string(),
  type: z.enum(smsMessageTypes)
});

const smsBatchResponseSchema = z.object({
  accepted_count: z.number().int(),
  body: z.string(),
  created_at: z.string().datetime(),
  created_by: z.string(),
  id: z.string(),
  messages: z.array(smsMessageResponseSchema),
  metadata: metadataSchema,
  reference: z.string().nullable(),
  rejected_count: z.number().int(),
  scheduled_at: z.string().datetime().nullable(),
  sender_id: z.string().nullable(),
  status: z.enum(smsBatchStatuses),
  total_count: z.number().int(),
  type: z.enum(smsMessageTypes),
  updated_at: z.string().datetime()
});

const singleSendBodySchema = z.object({
  message: z.string().min(1).max(1600).optional(),
  metadata: metadataSchema.optional(),
  reference: z.string().min(1).max(128).optional(),
  schedule_at: z.string().datetime().optional(),
  sender_id: z.string().min(3).max(11).optional(),
  template_id: z.string().min(1).optional(),
  type: z.enum(smsMessageTypes),
  to: z.string().min(4),
  variables: templateVariablesSchema.optional()
});

const bulkSendBodySchema = z.object({
  contact_group_id: z.string().min(1).optional(),
  message: z.string().min(1).max(1600),
  metadata: metadataSchema.optional(),
  reference: z.string().min(1).max(128).optional(),
  schedule_at: z.string().datetime().optional(),
  sender_id: z.string().min(3).max(11).optional(),
  to: z.array(recipientSchema).min(1).max(10_000).optional(),
  type: z.enum(smsMessageTypes)
});

export async function registerSmsPublicRoutes(app: FastifyTypedInstance) {
  const smsService = new SmsMessagingService({
    database: app.db,
    enableQueue: app.appEnv.APP_ENV !== "test",
    encryptionKey: app.appEnv.ENCRYPTION_KEY,
    redisUrl: app.appEnv.REDIS_URL
  });

  app.post(
    "/sms",
    {
      preHandler: [requireIdempotency()],
      schema: {
        body: singleSendBodySchema,
        response: {
          201: z.object({
            data: smsMessageResponseSchema
          })
        }
      }
    },
    async (request, reply) => {
      request.assertApiKeyScope("sms");
      const body = request.body;

      const message = await smsService.create({
        createdBy: request.publicApiKey!.apiKeyId,
        merchantId: request.publicApiKey!.merchantId,
        metadata: (body.metadata ?? {}) as Json,
        mode: request.publicApiKey!.mode,
        reference: body.reference ?? null,
        scheduleAt: body.schedule_at ? new Date(body.schedule_at) : null,
        senderId: body.sender_id ?? null,
        templateId: body.template_id ?? null,
        templateVariables: body.variables ?? {},
        to: body.to,
        type: body.type,
        userMessage: body.message ?? null
      });

      return reply.status(201).send({
        data: serializeSmsMessage(message)
      });
    }
  );

  app.post(
    "/sms/bulk",
    {
      preHandler: [requireIdempotency()],
      schema: {
        body: bulkSendBodySchema,
        response: {
          201: z.object({
            data: z.object({
              accepted_count: z.number().int(),
              batch_id: z.string(),
              rejected_count: z.number().int(),
              total_count: z.number().int()
            })
          })
        }
      }
    },
    async (request, reply) => {
      request.assertApiKeyScope("sms");
      const body = request.body;

      const result = await smsService.createBulk({
        contactGroupId: body.contact_group_id ?? null,
        createdBy: request.publicApiKey!.apiKeyId,
        merchantId: request.publicApiKey!.merchantId,
        metadata: (body.metadata ?? {}) as Json,
        mode: request.publicApiKey!.mode,
        reference: body.reference ?? null,
        scheduleAt: body.schedule_at ? new Date(body.schedule_at) : null,
        senderId: body.sender_id ?? null,
        to: body.to
          ? body.to.map((recipient) =>
              typeof recipient === "string"
                ? recipient
                : recipient.name
                  ? { name: recipient.name, phone: recipient.phone }
                  : { phone: recipient.phone }
            )
          : null,
        type: body.type,
        userMessage: body.message
      });

      return reply.status(201).send({
        data: {
          accepted_count: result.acceptedCount,
          batch_id: result.batch.id,
          rejected_count: result.rejectedCount,
          total_count: result.batch.totalCount
        }
      });
    }
  );

  app.get(
    "/sms/:id",
    {
      schema: {
        params: z.object({
          id: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: smsMessageResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertApiKeyScope("read");
      const message = await smsService.getById(
        request.publicApiKey!.merchantId,
        request.publicApiKey!.mode,
        request.params.id
      );

      return {
        data: serializeSmsMessage(message)
      };
    }
  );

  app.get(
    "/sms",
    {
      schema: {
        querystring: z.object({
          batch_id: z.string().min(1).optional(),
          created_gte: z.string().datetime().optional(),
          created_lte: z.string().datetime().optional(),
          limit: z.coerce.number().int().positive().max(100).default(20),
          reference: z.string().min(1).optional(),
          starting_after: z.string().min(1).optional(),
          status: z.enum(smsMessageStatuses).optional(),
          to: z.string().min(4).optional(),
          type: z.enum(smsMessageTypes).optional()
        }),
        response: {
          200: z.object({
            data: z.array(smsMessageResponseSchema),
            meta: z.object({
              has_more: z.boolean(),
              next_starting_after: z.string().nullable()
            })
          })
        }
      }
    },
    async (request) => {
      request.assertApiKeyScope("read");
      const page = await smsService.list(
        request.publicApiKey!.merchantId,
        request.publicApiKey!.mode,
        {
          ...(request.query.batch_id ? { batchId: request.query.batch_id } : {}),
          ...(request.query.created_gte
            ? { createdGte: new Date(request.query.created_gte) }
            : {}),
          ...(request.query.created_lte
            ? { createdLte: new Date(request.query.created_lte) }
            : {}),
          ...(request.query.reference ? { reference: request.query.reference } : {}),
          ...(request.query.starting_after
            ? { startingAfter: request.query.starting_after }
            : {}),
          ...(request.query.status ? { status: request.query.status } : {}),
          ...(request.query.to ? { to: request.query.to } : {}),
          ...(request.query.type ? { type: request.query.type } : {})
        },
        request.query.limit
      );

      return {
        data: page.items.map(serializeSmsMessage),
        meta: {
          has_more: page.nextStartingAfter !== null,
          next_starting_after: page.nextStartingAfter
        }
      };
    }
  );

  app.get(
    "/sms/batches/:id",
    {
      schema: {
        params: z.object({
          id: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: smsBatchResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertApiKeyScope("read");
      const batch = await smsService.getBatchById(
        request.publicApiKey!.merchantId,
        request.publicApiKey!.mode,
        request.params.id
      );

      return {
        data: serializeSmsBatch(batch)
      };
    }
  );

  app.post(
    "/otp/send",
    {
      preHandler: [requireIdempotency()],
      schema: {
        body: z.object({
          expires_in_seconds: z.coerce.number().int().min(30).max(3600),
          length: z.coerce.number().int().min(4).max(8),
          sender_id: z.string().min(3).max(11).optional(),
          template: z.string().min(1).max(500).optional(),
          to: z.string().min(4)
        }),
        response: {
          201: z.object({
            data: z.object({
              expires_at: z.string().datetime(),
              otp_id: z.string(),
              sms_id: z.string()
            })
          })
        }
      }
    },
    async (request, reply) => {
      request.assertApiKeyScope("sms");
      const result = await smsService.sendOtp({
        createdBy: request.publicApiKey!.apiKeyId,
        expiresInSeconds: request.body.expires_in_seconds,
        length: request.body.length,
        merchantId: request.publicApiKey!.merchantId,
        mode: request.publicApiKey!.mode,
        senderId: request.body.sender_id ?? null,
        template: request.body.template ?? null,
        to: request.body.to
      });

      return reply.status(201).send({
        data: {
          expires_at: result.expiresAt.toISOString(),
          otp_id: result.otpId,
          sms_id: result.smsMessage.id
        }
      });
    }
  );

  app.post(
    "/otp/verify",
    {
      schema: {
        body: z.object({
          code: z.string().min(1).max(8),
          otp_id: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: z.object({
              attempts: z.number().int(),
              expires_at: z.string().datetime(),
              otp_id: z.string(),
              status: z.enum(smsOtpStatuses),
              verified: z.boolean(),
              verified_at: z.string().datetime().nullable()
            })
          })
        }
      }
    },
    async (request) => {
      request.assertApiKeyScope("sms");
      const result = await smsService.verifyOtp({
        code: request.body.code,
        merchantId: request.publicApiKey!.merchantId,
        mode: request.publicApiKey!.mode,
        otpId: request.body.otp_id
      });

      return {
        data: {
          attempts: result.otp.attempts,
          expires_at: result.otp.expiresAt.toISOString(),
          otp_id: result.otp.id,
          status: result.otp.status,
          verified: result.verified,
          verified_at: result.otp.verifiedAt?.toISOString() ?? null
        }
      };
    }
  );
}

function serializeSmsMessage(message: {
  batchId: string | null;
  body: string;
  channelId: string | null;
  createdAt: Date;
  currency: string;
  deliveredAt: Date | null;
  encoding: typeof smsMessageEncodings[number];
  failureCode: string | null;
  id: string;
  metadata: Json;
  priceMinor: bigint;
  providerRef: string | null;
  reference: string | null;
  scheduledAt: Date | null;
  segments: number;
  senderId: string;
  sentAt: Date | null;
  status: typeof smsMessageStatuses[number];
  to: string;
  type: typeof smsMessageTypes[number];
}) {
  return {
    batch_id: message.batchId,
    body: message.body,
    channel_id: message.channelId,
    created_at: message.createdAt.toISOString(),
    currency: message.currency,
    delivered_at: message.deliveredAt?.toISOString() ?? null,
    encoding: message.encoding,
    failure_code: message.failureCode,
    id: message.id,
    metadata: message.metadata as Record<string, unknown>,
    price_minor: Number(message.priceMinor),
    provider_ref: message.providerRef,
    reference: message.reference,
    scheduled_at: message.scheduledAt?.toISOString() ?? null,
    segments: message.segments,
    sender_id: message.senderId,
    sent_at: message.sentAt?.toISOString() ?? null,
    status: message.status,
    to: message.to,
    type: message.type
  };
}

function serializeSmsBatch(batch: {
  acceptedCount: number;
  body: string;
  createdAt: Date;
  createdBy: string;
  id: string;
  messages: Array<Parameters<typeof serializeSmsMessage>[0]>;
  metadata: Json;
  reference: string | null;
  rejectedCount: number;
  scheduledAt: Date | null;
  senderId: string | null;
  status: typeof smsBatchStatuses[number];
  totalCount: number;
  type: typeof smsMessageTypes[number];
  updatedAt: Date;
}) {
  return {
    accepted_count: batch.acceptedCount,
    body: batch.body,
    created_at: batch.createdAt.toISOString(),
    created_by: batch.createdBy,
    id: batch.id,
    messages: batch.messages.map(serializeSmsMessage),
    metadata: batch.metadata as Record<string, unknown>,
    reference: batch.reference,
    rejected_count: batch.rejectedCount,
    scheduled_at: batch.scheduledAt?.toISOString() ?? null,
    sender_id: batch.senderId,
    status: batch.status,
    total_count: batch.totalCount,
    type: batch.type,
    updated_at: batch.updatedAt.toISOString()
  };
}
