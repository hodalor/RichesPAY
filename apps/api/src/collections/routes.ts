import type { FastifyRequest } from "fastify";
import { z } from "zod";

import type { Json } from "../db/types";
import type { FastifyTypedInstance } from "../types";
import { ProviderCatalog } from "../providers/catalog";
import { requireIdempotency } from "../public-api/idempotency";
import { inferCollectionMethod } from "../public-api/request-shape";
import { pricingCurrencies } from "../pricing/types";
import { CollectionService } from "./service";
import { collectionStatuses, refundStatuses, type CollectionRecord, type RefundRecord } from "./types";

const metadataSchema = z.record(z.string(), z.unknown()).default({});

const collectionCustomerSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().min(1).optional()
}).optional();

const collectionResponseSchema = z.object({
  amount: z.number().int(),
  card: z
    .object({
      brand: z.string().nullable(),
      expiry_month: z.number().int().nullable(),
      expiry_year: z.number().int().nullable(),
      last4: z.string().nullable()
    })
    .nullable(),
  channel_id: z.string().nullable(),
  completed_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  currency: z.enum(pricingCurrencies),
  customer: z.object({
    email: z.string().email().nullable(),
    name: z.string().nullable()
  }),
  description: z.string().nullable(),
  expires_at: z.string().datetime().nullable(),
  failure_code: z.string().nullable(),
  failure_message: z.string().nullable(),
  fee_bearer: z.enum(["merchant", "customer"]),
  fee_minor: z.number().int(),
  fx_rate_id: z.string().nullable(),
  id: z.string(),
  method: z.enum(["mobile_money", "card"]),
  net_minor: z.number().int(),
  network: z.string().nullable(),
  next_action: z
    .object({
      iframe_url: z.string().url().optional(),
      type: z.enum(["hosted_fields", "redirect_url"]),
      url: z.string().url().optional()
    })
    .nullable(),
  phone: z.string().nullable(),
  presentment_amount: z.number().int().nullable(),
  presentment_currency: z.enum(pricingCurrencies).nullable(),
  provider_ref: z.string().nullable(),
  reference: z.string().nullable(),
  refunded_minor: z.number().int(),
  status: z.enum(collectionStatuses)
});

const refundResponseSchema = z.object({
  amount: z.number().int(),
  channel_id: z.string().nullable(),
  collection_id: z.string(),
  completed_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  currency: z.enum(pricingCurrencies),
  failure_code: z.string().nullable(),
  failure_message: z.string().nullable(),
  id: z.string(),
  method: z.enum(["mobile_money", "card"]),
  phone: z.string().nullable(),
  provider_ref: z.string().nullable(),
  status: z.enum(refundStatuses)
});

export async function registerCollectionRoutes(app: FastifyTypedInstance) {
  const collectionService = new CollectionService({
    database: app.db,
    providerCatalog: new ProviderCatalog({
      database: app.db,
      encryptionKey: app.appEnv.ENCRYPTION_KEY
    })
  });

  app.post(
    "/collections",
    {
      preHandler: [requireIdempotency()],
      schema: {
        body: z.object({
          amount: z.coerce.number().int().positive(),
          cancel_url: z.string().url().optional(),
          currency: z.enum(pricingCurrencies),
          customer: collectionCustomerSchema,
          description: z.string().min(1).max(500).optional(),
          metadata: metadataSchema.optional(),
          method: z.enum(["mobile_money", "card"]).optional(),
          network: z.string().min(1).optional(),
          phone: z.string().min(4).optional(),
          reference: z.string().min(1).max(128).optional(),
          return_url: z.string().url().optional()
        }),
        response: {
          201: z.object({
            data: collectionResponseSchema
          })
        }
      }
    },
    async (request, reply) => {
      request.assertApiKeyScope("collections");

      const body = request.body;
      const method = inferCollectionMethod({
        method: body.method,
        phone: body.phone
      });
      const collection = await collectionService.create({
        amountMinor: BigInt(body.amount),
        currency: body.currency,
        customerEmail: body.customer?.email ?? null,
        customerName: body.customer?.name ?? null,
        description: body.description ?? null,
        idempotencyKey: request.idempotencyState?.key ?? null,
        merchantId: request.publicApiKey!.merchantId,
        metadata: (body.metadata ?? {}) as Json,
        method,
        mode: request.publicApiKey!.mode,
        network: body.network ?? null,
        phone: body.phone ?? null,
        ...(body.cancel_url ? { cancelUrl: body.cancel_url } : {}),
        baseUrl: getRequestBaseUrl(request),
        ...(body.return_url ? { returnUrl: body.return_url } : {}),
        reference: body.reference ?? null,
        requestId: request.id
      });

      return reply.status(201).send({
        data: serializeCollection(collection)
      });
    }
  );

  app.get(
    "/collections/:id",
    {
      schema: {
        params: z.object({
          id: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: collectionResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertApiKeyScope("read");

      const collection = await collectionService.getById(
        request.publicApiKey!.merchantId,
        request.publicApiKey!.mode,
        request.params.id
      );

      return {
        data: serializeCollection(collection)
      };
    }
  );

  app.get(
    "/collections",
    {
      schema: {
        querystring: z.object({
          created_gte: z.string().datetime().optional(),
          created_lte: z.string().datetime().optional(),
          limit: z.coerce.number().int().positive().max(100).default(20),
          reference: z.string().min(1).optional(),
          starting_after: z.string().min(1).optional(),
          status: z.enum(collectionStatuses).optional()
        }),
        response: {
          200: z.object({
            data: z.array(collectionResponseSchema),
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

      const page = await collectionService.list(
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
        data: page.items.map(serializeCollection),
        meta: {
          has_more: page.nextStartingAfter !== null,
          next_starting_after: page.nextStartingAfter
        }
      };
    }
  );

  app.post(
    "/collections/:id/refunds",
    {
      preHandler: [requireIdempotency()],
      schema: {
        body: z.object({
          amount: z.coerce.number().int().positive().optional()
        }),
        params: z.object({
          id: z.string().min(1)
        }),
        response: {
          201: z.object({
            data: refundResponseSchema
          })
        }
      }
    },
    async (request, reply) => {
      const collection = await collectionService.getById(
        request.publicApiKey!.merchantId,
        request.publicApiKey!.mode,
        request.params.id
      );

      request.assertApiKeyScope(collection.method === "mobile_money" ? "payouts" : "collections");

      const refund = await collectionService.createRefund({
        amountMinor: request.body.amount === undefined ? null : BigInt(request.body.amount),
        collectionId: request.params.id,
        idempotencyKey: request.idempotencyState?.key ?? null,
        merchantId: request.publicApiKey!.merchantId,
        mode: request.publicApiKey!.mode,
        requestId: request.id
      });

      return reply.status(201).send({
        data: serializeRefund(refund)
      });
    }
  );
}

function serializeCollection(collection: CollectionRecord) {
  return {
    amount: Number(collection.amount),
    card: collection.card
      ? {
          brand: collection.card.brand,
          expiry_month: collection.card.expiryMonth,
          expiry_year: collection.card.expiryYear,
          last4: collection.card.last4
        }
      : null,
    channel_id: collection.channelId,
    completed_at: collection.completedAt?.toISOString() ?? null,
    created_at: collection.createdAt.toISOString(),
    currency: collection.currency,
    customer: {
      email: collection.customerEmail,
      name: collection.customerName
    },
    description: collection.description,
    expires_at: collection.expiresAt?.toISOString() ?? null,
    failure_code: collection.failureCode,
    failure_message: collection.failureMessage,
    fee_bearer: collection.feeBearer,
    fee_minor: Number(collection.feeMinor),
    fx_rate_id: collection.fxRateId,
    id: collection.id,
    method: collection.method,
    net_minor: Number(collection.netMinor),
    network: collection.network,
    next_action: collection.nextAction
      ? {
          ...(collection.nextAction.iframeUrl
            ? { iframe_url: collection.nextAction.iframeUrl }
            : {}),
          type: collection.nextAction.type,
          ...(collection.nextAction.url ? { url: collection.nextAction.url } : {})
        }
      : null,
    phone: collection.phone,
    presentment_amount:
      collection.presentmentAmount === null
        ? null
        : Number(collection.presentmentAmount),
    presentment_currency: collection.presentmentCurrency,
    provider_ref: collection.providerRef,
    reference: collection.reference,
    refunded_minor: Number(collection.refundedMinor),
    status: collection.status
  };
}

function serializeRefund(refund: RefundRecord) {
  return {
    amount: Number(refund.amount),
    channel_id: refund.channelId,
    collection_id: refund.collectionId,
    completed_at: refund.completedAt?.toISOString() ?? null,
    created_at: refund.createdAt.toISOString(),
    currency: refund.currency,
    failure_code: refund.failureCode,
    failure_message: refund.failureMessage,
    id: refund.id,
    method: refund.method,
    phone: refund.phone,
    provider_ref: refund.providerRef,
    status: refund.status
  };
}

function getRequestBaseUrl(request: FastifyRequest) {
  const protocol = request.protocol ?? "http";
  const host = request.headers.host;
  if (!host) {
    return null;
  }

  return `${protocol}://${host}`;
}
