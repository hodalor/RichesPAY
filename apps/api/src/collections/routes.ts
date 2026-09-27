import { z } from "zod";

import type { Json } from "../db/types";
import type { FastifyTypedInstance } from "../types";
import { ProviderCatalog } from "../providers/catalog";
import { requireIdempotency } from "../public-api/idempotency";
import { pricingCurrencies } from "../pricing/types";
import { CollectionService } from "./service";
import { collectionStatuses, type CollectionRecord } from "./types";

const metadataSchema = z.record(z.string(), z.unknown()).default({});

const collectionCustomerSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().min(1).optional()
}).optional();

const collectionResponseSchema = z.object({
  amount: z.number().int(),
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
  method: z.literal("mobile_money"),
  net_minor: z.number().int(),
  network: z.string().nullable(),
  phone: z.string(),
  presentment_amount: z.number().int().nullable(),
  presentment_currency: z.enum(pricingCurrencies).nullable(),
  provider_ref: z.string().nullable(),
  reference: z.string().nullable(),
  status: z.enum(collectionStatuses)
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
          currency: z.enum(pricingCurrencies),
          customer: collectionCustomerSchema,
          description: z.string().min(1).max(500).optional(),
          metadata: metadataSchema.optional(),
          method: z.literal("mobile_money"),
          network: z.string().min(1).optional(),
          phone: z.string().min(4),
          reference: z.string().min(1).max(128).optional()
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
      const collection = await collectionService.create({
        amountMinor: BigInt(body.amount),
        currency: body.currency,
        customerEmail: body.customer?.email ?? null,
        customerName: body.customer?.name ?? null,
        description: body.description ?? null,
        idempotencyKey: request.idempotencyState?.key ?? null,
        merchantId: request.publicApiKey!.merchantId,
        metadata: (body.metadata ?? {}) as Json,
        mode: request.publicApiKey!.mode,
        network: body.network ?? null,
        phone: body.phone,
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
}

function serializeCollection(collection: CollectionRecord) {
  return {
    amount: Number(collection.amount),
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
    phone: collection.phone,
    presentment_amount:
      collection.presentmentAmount === null
        ? null
        : Number(collection.presentmentAmount),
    presentment_currency: collection.presentmentCurrency,
    provider_ref: collection.providerRef,
    reference: collection.reference,
    status: collection.status
  };
}
