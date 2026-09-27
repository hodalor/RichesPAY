import { z } from "zod";

import type { Json } from "../db/types";
import { requireIdempotency } from "../public-api/idempotency";
import { inferPayoutMethod } from "../public-api/request-shape";
import { pricingCurrencies } from "../pricing/types";
import { ProviderCatalog } from "../providers/catalog";
import type { FastifyTypedInstance } from "../types";

import { PayoutService } from "./service";
import type { PayoutBatchRecord, PayoutRecord } from "./types";

const payoutMethods = ["mobile_money", "bank"] as const;
const payoutStatuses = [
  "pending_approval",
  "queued",
  "on_hold",
  "processing",
  "successful",
  "failed",
  "reversed",
  "cancelled"
] as const;
const payoutBatchStatuses = [
  "pending_approval",
  "queued",
  "on_hold",
  "processing",
  "completed",
  "failed",
  "cancelled"
] as const;

const metadataSchema = z.record(z.string(), z.unknown()).default({});

const payoutResponseSchema = z.object({
  account_name: z.string().nullable(),
  account_number: z.string().nullable(),
  amount: z.number().int(),
  approved_by: z.string().nullable(),
  bank_code: z.string().nullable(),
  batch_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  completed_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  created_by: z.string(),
  currency: z.enum(pricingCurrencies),
  failure_code: z.string().nullable(),
  failure_message: z.string().nullable(),
  fee_minor: z.number().int(),
  id: z.string(),
  metadata: metadataSchema,
  method: z.enum(payoutMethods),
  narration: z.string().nullable(),
  network: z.string().nullable(),
  phone: z.string().nullable(),
  provider_ref: z.string().nullable(),
  reference: z.string().nullable(),
  send_attempts: z.number().int(),
  status: z.enum(payoutStatuses),
  status_check_attempts: z.number().int(),
  total_hold_minor: z.number().int()
});

const payoutBatchResponseSchema = z.object({
  approved_by: z.string().nullable(),
  completed_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  created_by: z.string(),
  currency: z.enum(pricingCurrencies),
  id: z.string(),
  item_count: z.number().int(),
  metadata: metadataSchema,
  payouts: z.array(payoutResponseSchema),
  reference: z.string().nullable(),
  status: z.enum(payoutBatchStatuses),
  total_amount: z.number().int(),
  total_fee_minor: z.number().int(),
  total_hold_minor: z.number().int(),
  validation_report: z.object({
    invalid_count: z.number().int(),
    rows: z.array(
      z.object({
        errors: z.array(z.string()),
        index: z.number().int()
      })
    ),
    valid_count: z.number().int()
  })
});

const payoutItemBodySchema = z.object({
  account_name: z.string().min(1).max(120).optional(),
  account_number: z.string().min(4).max(64).optional(),
  amount: z.coerce.number().int().positive(),
  bank_code: z.string().min(1).max(32).optional(),
  metadata: metadataSchema.optional(),
  method: z.enum(payoutMethods).optional(),
  narration: z.string().min(1).max(255).optional(),
  network: z.string().min(1).max(64).optional(),
  phone: z.string().min(4).max(32).optional(),
  reference: z.string().min(1).max(128).optional()
});

export async function registerPayoutRoutes(app: FastifyTypedInstance) {
  const payoutService = new PayoutService({
    database: app.db,
    providerCatalog: new ProviderCatalog({
      database: app.db,
      encryptionKey: app.appEnv.ENCRYPTION_KEY
    })
  });

  app.get(
    "/accounts/lookup",
    {
      schema: {
        querystring: z.object({
          network: z.string().min(1).optional(),
          phone: z.string().min(4)
        }),
        response: {
          200: z.object({
            data: z.object({
              account_name: z.string(),
              normalized_phone: z.string()
            })
          })
        }
      }
    },
    async (request) => {
      request.assertApiKeyScope("payouts");

      const result = await payoutService.lookupAccountName({
        merchantId: request.publicApiKey!.merchantId,
        mode: request.publicApiKey!.mode,
        network: request.query.network ?? null,
        phone: request.query.phone
      });

      return {
        data: {
          account_name: result.accountName,
          normalized_phone: result.normalizedPhone
        }
      };
    }
  );

  app.post(
    "/payouts",
    {
      preHandler: [requireIdempotency()],
      schema: {
        body: payoutItemBodySchema.extend({
          currency: z.enum(pricingCurrencies)
        }),
        response: {
          201: z.object({
            data: payoutResponseSchema
          })
        }
      }
    },
    async (request, reply) => {
      request.assertApiKeyScope("payouts");
      const body = request.body;
      const method = inferPayoutMethod({
        account_number: body.account_number,
        bank_code: body.bank_code,
        method: body.method,
        phone: body.phone
      });

      const payout = await payoutService.create({
        accountName: body.account_name ?? null,
        accountNumber: body.account_number ?? null,
        amountMinor: BigInt(body.amount),
        bankCode: body.bank_code ?? null,
        createdBy: request.publicApiKey!.apiKeyId,
        currency: body.currency,
        idempotencyKey: request.idempotencyState?.key ?? null,
        merchantId: request.publicApiKey!.merchantId,
        metadata: (body.metadata ?? {}) as Json,
        method,
        mode: request.publicApiKey!.mode,
        narration: body.narration ?? null,
        network: body.network ?? null,
        phone: body.phone ?? null,
        reference: body.reference ?? null,
        requestId: request.id
      });

      return reply.status(201).send({
        data: serializePayout(payout)
      });
    }
  );

  app.get(
    "/payouts/:id",
    {
      schema: {
        params: z.object({
          id: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: payoutResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertApiKeyScope("read");
      const payout = await payoutService.getById(
        request.publicApiKey!.merchantId,
        request.publicApiKey!.mode,
        request.params.id
      );

      return {
        data: serializePayout(payout)
      };
    }
  );

  app.get(
    "/payouts",
    {
      schema: {
        querystring: z.object({
          batch_id: z.string().min(1).optional(),
          created_gte: z.string().datetime().optional(),
          created_lte: z.string().datetime().optional(),
          limit: z.coerce.number().int().positive().max(100).default(20),
          reference: z.string().min(1).optional(),
          starting_after: z.string().min(1).optional(),
          status: z.enum(payoutStatuses).optional()
        }),
        response: {
          200: z.object({
            data: z.array(payoutResponseSchema),
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

      const page = await payoutService.list(
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
          ...(request.query.status ? { status: request.query.status } : {})
        },
        request.query.limit
      );

      return {
        data: page.data.map(serializePayout),
        meta: {
          has_more: page.hasMore,
          next_starting_after: page.nextStartingAfter
        }
      };
    }
  );

  app.post(
    "/payouts/:id/cancel",
    {
      preHandler: [requireIdempotency()],
      schema: {
        params: z.object({
          id: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: payoutResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertApiKeyScope("payouts");

      const payout = await payoutService.cancel(
        request.publicApiKey!.merchantId,
        request.publicApiKey!.mode,
        request.params.id,
        request.publicApiKey!.apiKeyId
      );

      return {
        data: serializePayout(payout)
      };
    }
  );

  app.post(
    "/payout-batches",
    {
      preHandler: [requireIdempotency()],
      schema: {
        body: z.object({
          currency: z.enum(pricingCurrencies),
          items: z.array(payoutItemBodySchema).min(1).max(5000),
          metadata: metadataSchema.optional(),
          reference: z.string().min(1).max(128).optional()
        }),
        response: {
          200: z.object({
            data: z.object({
              accepted: z.literal(false),
              validation_report: payoutBatchResponseSchema.shape.validation_report
            })
          }),
          201: z.object({
            data: z.object({
              accepted: z.literal(true),
              batch: payoutBatchResponseSchema
            })
          })
        }
      }
    },
    async (request, reply) => {
      request.assertApiKeyScope("payouts");
      const body = request.body;

      const result = await payoutService.createBatch({
        createdBy: request.publicApiKey!.apiKeyId,
        currency: body.currency,
        items: body.items.map((item) => {
          const method = inferPayoutMethod({
            account_number: item.account_number,
            bank_code: item.bank_code,
            method: item.method,
            phone: item.phone
          });

          return {
            ...(item.account_name ? { accountName: item.account_name } : {}),
            ...(item.account_number ? { accountNumber: item.account_number } : {}),
            amount: item.amount,
            ...(item.bank_code ? { bankCode: item.bank_code } : {}),
            ...(item.metadata ? { metadata: item.metadata as Json } : {}),
            method,
            ...(item.narration ? { narration: item.narration } : {}),
            ...(item.network ? { network: item.network } : {}),
            ...(item.phone ? { phone: item.phone } : {}),
            ...(item.reference ? { reference: item.reference } : {})
          };
        }),
        merchantId: request.publicApiKey!.merchantId,
        metadata: (body.metadata ?? {}) as Json,
        mode: request.publicApiKey!.mode,
        reference: body.reference ?? null
      });

      if (!result.accepted) {
        return {
          data: {
            accepted: false as const,
            validation_report: result.validationReport
          }
        };
      }

      return reply.status(201).send({
        data: {
          accepted: true as const,
          batch: serializePayoutBatch(result.batch)
        }
      });
    }
  );

  app.get(
    "/payout-batches/:id",
    {
      schema: {
        params: z.object({
          id: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: payoutBatchResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertApiKeyScope("read");

      const batch = await payoutService.getBatchById(
        request.publicApiKey!.merchantId,
        request.publicApiKey!.mode,
        request.params.id
      );

      return {
        data: serializePayoutBatch(batch)
      };
    }
  );

  app.get(
    "/payout-batches",
    {
      schema: {
        querystring: z.object({
          created_gte: z.string().datetime().optional(),
          created_lte: z.string().datetime().optional(),
          limit: z.coerce.number().int().positive().max(100).default(20),
          reference: z.string().min(1).optional(),
          starting_after: z.string().min(1).optional(),
          status: z.enum(payoutBatchStatuses).optional()
        }),
        response: {
          200: z.object({
            data: z.array(payoutBatchResponseSchema),
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

      const page = await payoutService.listBatches(
        request.publicApiKey!.merchantId,
        request.publicApiKey!.mode,
        {
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
          ...(request.query.status ? { status: request.query.status } : {})
        },
        request.query.limit
      );

      return {
        data: page.data.map(serializePayoutBatch),
        meta: {
          has_more: page.hasMore,
          next_starting_after: page.nextStartingAfter
        }
      };
    }
  );
}

function serializePayout(payout: PayoutRecord) {
  return {
    account_name: payout.accountName,
    account_number: payout.accountNumber,
    amount: Number(payout.amount),
    approved_by: payout.approvedBy,
    bank_code: payout.bankCode,
    batch_id: payout.batchId,
    channel_id: payout.channelId,
    completed_at: payout.completedAt?.toISOString() ?? null,
    created_at: payout.createdAt.toISOString(),
    created_by: payout.createdBy,
    currency: payout.currency,
    failure_code: payout.failureCode,
    failure_message: payout.failureMessage,
    fee_minor: Number(payout.feeMinor),
    id: payout.id,
    metadata: (payout.metadata ?? {}) as Record<string, unknown>,
    method: payout.method,
    narration: payout.narration,
    network: payout.network,
    phone: payout.phone,
    provider_ref: payout.providerRef,
    reference: payout.reference,
    send_attempts: payout.sendAttempts,
    status: payout.status,
    status_check_attempts: payout.statusCheckAttempts,
    total_hold_minor: Number(payout.totalHoldMinor)
  };
}

function serializePayoutBatch(batch: PayoutBatchRecord) {
  return {
    approved_by: batch.approvedBy,
    completed_at: batch.completedAt?.toISOString() ?? null,
    created_at: batch.createdAt.toISOString(),
    created_by: batch.createdBy,
    currency: batch.currency,
    id: batch.id,
    item_count: batch.itemCount,
    metadata: (batch.metadata ?? {}) as Record<string, unknown>,
    payouts: batch.payouts.map(serializePayout),
    reference: batch.reference,
    status: batch.status,
    total_amount: Number(batch.totalAmount),
    total_fee_minor: Number(batch.totalFeeMinor),
    total_hold_minor: Number(batch.totalHoldMinor),
    validation_report: batch.validationReport as {
      invalid_count: number;
      rows: Array<{ errors: string[]; index: number }>;
      valid_count: number;
    }
  };
}
