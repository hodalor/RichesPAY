import { z } from "zod";

import type { Json } from "../db/types";
import { requireIdempotency } from "../public-api/idempotency";
import { pricingCurrencies } from "../pricing/types";
import { ProviderCatalog } from "../providers/catalog";
import type { FastifyTypedInstance } from "../types";

import {
  airtimeBatchResponseSchema,
  airtimeBulkBodySchema,
  airtimeNetworkResponseSchema,
  airtimeOrderResponseSchema,
  airtimeQuoteResponseSchema,
  airtimeSingleBodySchema,
  bulkItemsFromBody,
  serializeAirtimeBatch,
  serializeAirtimeNetwork,
  serializeAirtimeOrder,
  serializeAirtimeQuote
} from "./serialize";
import { AirtimeService } from "./service";
import { airtimeOrderStatuses } from "./types";

export async function registerAirtimeRoutes(
  app: FastifyTypedInstance,
  options: { dispatchInline?: boolean } = {}
) {
  const airtimeService = new AirtimeService({
    database: app.db,
    providerCatalog: new ProviderCatalog({
      database: app.db,
      encryptionKey: app.appEnv.ENCRYPTION_KEY
    })
  });
  const dispatchInline = options.dispatchInline ?? app.appEnv.APP_ENV !== "test";

  const dispatchSoon = (merchantId: string, mode: "live" | "test", orderIds: string[]) => {
    if (!dispatchInline) {
      return;
    }

    setImmediate(() => {
      void (async () => {
        for (const orderId of orderIds) {
          await airtimeService.dispatchOrder(merchantId, mode, orderId);
        }
      })().catch((error) => app.log.error({ err: error }, "Inline airtime dispatch failed"));
    });
  };

  app.get(
    "/airtime/networks",
    {
      schema: {
        description:
          "Returns the networks this merchant can sell, with min/max face values, optional fixed denominations, and the merchant discount in basis points.\n\nExample: GET /v1/airtime/networks?country=ZM\n\nExample response: { \"data\": [{ \"country_code\": \"ZM\", \"network\": \"MTN\", \"currency\": \"ZMW\", \"min_amount\": 100, \"max_amount\": 100000, \"fixed_denominations\": null, \"discount_bps\": 300 }] }",
        querystring: z.object({
          country: z.string().length(2).optional().describe("ISO country filter, for example ZM or GH.")
        }),
        response: {
          200: z.object({ data: z.array(airtimeNetworkResponseSchema) })
        },
        summary: "List airtime networks and allowed amounts",
        tags: ["Airtime"]
      }
    },
    async (request) => {
      request.assertApiKeyScope("airtime");
      const networks = await airtimeService.listNetworks({
        ...(request.query.country ? { countryCode: request.query.country } : {}),
        merchantId: request.publicApiKey!.merchantId,
        mode: request.publicApiKey!.mode
      });

      return { data: networks.map(serializeAirtimeNetwork) };
    }
  );

  app.get(
    "/airtime/quote",
    {
      schema: {
        description:
          "Quotes the merchant charge before you send. Face value is in the recipient currency. charge_amount is face value minus the network discount, converted into the merchant settlement currency when those currencies differ.\n\nExample: GET /v1/airtime/quote?phone=%2B260970000001&amount=1000&currency=ZMW\n\nExample response: { \"data\": { \"phone\": \"+260970000001\", \"network\": \"MTN\", \"amount\": 1000, \"currency\": \"ZMW\", \"charge_amount\": 970, \"charge_currency\": \"ZMW\", \"discount_bps\": 300, \"discount_minor\": 30, \"fx_rate_id\": null } }",
        querystring: z.object({
          amount: z.coerce.number().int().positive().describe("Face value in minor units."),
          currency: z.enum(pricingCurrencies).describe("Local currency of the recipient phone."),
          phone: z.string().min(4).max(32).describe("Recipient MSISDN in E.164.")
        }),
        response: {
          200: z.object({ data: airtimeQuoteResponseSchema })
        },
        summary: "Quote the merchant charge for an airtime top-up",
        tags: ["Airtime"]
      }
    },
    async (request) => {
      request.assertApiKeyScope("airtime");
      const quote = await airtimeService.quote({
        amount: BigInt(request.query.amount),
        currency: request.query.currency,
        merchantId: request.publicApiKey!.merchantId,
        mode: request.publicApiKey!.mode,
        phone: request.query.phone
      });

      return { data: serializeAirtimeQuote(quote) };
    }
  );

  app.post(
    "/airtime",
    {
      preHandler: [requireIdempotency()],
      schema: {
        body: airtimeSingleBodySchema,
        description:
          "Sends one mobile airtime top-up. The recipient always receives face value in the phone's local currency. RichesPay charges the merchant face value minus the network discount, converted with the current FX rate when those currencies differ. Requires the airtime scope and an Idempotency-Key.\n\nExample request: { \"phone\": \"+260970000001\", \"amount\": 1000, \"currency\": \"ZMW\", \"reference\": \"REWARD-221\" }\n\nExample response: { \"data\": { \"id\": \"air_01J...\", \"status\": \"pending\", \"phone\": \"+260970000001\", \"network\": \"MTN\", \"amount\": 1000, \"currency\": \"ZMW\", \"charge_amount\": 970, \"charge_currency\": \"ZMW\", \"reference\": \"REWARD-221\" } }",
        response: {
          201: z.object({ data: airtimeOrderResponseSchema })
        },
        summary: "Send airtime to one phone number",
        tags: ["Airtime"]
      }
    },
    async (request, reply) => {
      request.assertApiKeyScope("airtime");
      const context = request.publicApiKey!;
      const order = await airtimeService.create({
        amount: BigInt(request.body.amount),
        createdBy: context.apiKeyId,
        currency: request.body.currency,
        merchantId: context.merchantId,
        metadata: (request.body.metadata ?? {}) as Json,
        mode: context.mode,
        network: request.body.network ?? null,
        phone: request.body.phone,
        reference: request.body.reference ?? null
      });

      dispatchSoon(context.merchantId, context.mode, [order.id]);
      return reply.status(201).send({ data: serializeAirtimeOrder(order) });
    }
  );

  app.post(
    "/airtime/bulk",
    {
      preHandler: [requireIdempotency()],
      schema: {
        body: airtimeBulkBodySchema,
        description:
          "Sends airtime to up to 5,000 recipients. Use phones[] plus a shared amount for the same face value, or items[] for a different amount per row. The response is a batch (aib_...) with accepted, rejected, and rejected_rows. Requires the airtime scope and an Idempotency-Key.\n\nSame amount example: { \"phones\": [\"+260970000001\", \"+260960000001\"], \"amount\": 1000, \"currency\": \"ZMW\" }\n\nDifferent amounts example: { \"items\": [{ \"phone\": \"+260970000001\", \"amount\": 1000, \"currency\": \"ZMW\" }, { \"phone\": \"+260960000001\", \"amount\": 2000, \"currency\": \"ZMW\" }] }",
        response: {
          201: z.object({ data: airtimeBatchResponseSchema })
        },
        summary: "Send airtime to up to 5,000 phone numbers",
        tags: ["Airtime"]
      }
    },
    async (request, reply) => {
      request.assertApiKeyScope("airtime");
      const context = request.publicApiKey!;
      const { batch, orderIds } = await airtimeService.createBulk({
        createdBy: context.apiKeyId,
        items: bulkItemsFromBody(request.body),
        merchantId: context.merchantId,
        mode: context.mode,
        reference: request.body.reference ?? null
      });

      dispatchSoon(context.merchantId, context.mode, orderIds);
      return reply.status(201).send({ data: serializeAirtimeBatch(batch) });
    }
  );

  app.get(
    "/airtime/batches/:id",
    {
      schema: {
        description:
          "Retrieves a bulk airtime batch by id (aib_...). Use this after POST /v1/airtime/bulk or when airtime_batch.completed arrives.\n\nExample: GET /v1/airtime/batches/aib_01J...",
        params: z.object({ id: z.string().min(1).describe("Airtime batch id, prefixed aib_.") }),
        response: {
          200: z.object({ data: airtimeBatchResponseSchema })
        },
        summary: "Retrieve an airtime batch",
        tags: ["Airtime"]
      }
    },
    async (request) => {
      request.assertApiKeyScope("airtime");
      const batch = await airtimeService.getBatch(
        request.publicApiKey!.merchantId,
        request.publicApiKey!.mode,
        request.params.id
      );

      return { data: serializeAirtimeBatch(batch) };
    }
  );

  app.get(
    "/airtime/:id",
    {
      schema: {
        description:
          "Retrieves one airtime order by id (air_...). Statuses are pending, processing, successful, and failed.\n\nExample: GET /v1/airtime/air_01J...",
        params: z.object({ id: z.string().min(1).describe("Airtime order id, prefixed air_.") }),
        response: {
          200: z.object({ data: airtimeOrderResponseSchema })
        },
        summary: "Retrieve an airtime top-up",
        tags: ["Airtime"]
      }
    },
    async (request) => {
      request.assertApiKeyScope("airtime");
      const order = await airtimeService.getById(
        request.publicApiKey!.merchantId,
        request.publicApiKey!.mode,
        request.params.id
      );

      return { data: serializeAirtimeOrder(order) };
    }
  );

  app.get(
    "/airtime",
    {
      schema: {
        description:
          "Lists airtime orders for the authenticated merchant. Filter by status, phone, batch_id, or created range. Cursor pagination uses limit and starting_after.\n\nExample: GET /v1/airtime?status=successful&limit=20",
        querystring: z.object({
          batch_id: z.string().min(1).optional().describe("Limit to orders in this aib_ batch."),
          created_gte: z.string().datetime().optional(),
          created_lte: z.string().datetime().optional(),
          limit: z.coerce.number().int().positive().max(100).default(20),
          phone: z.string().min(4).max(32).optional(),
          starting_after: z.string().min(1).optional(),
          status: z.enum(airtimeOrderStatuses).optional()
        }),
        response: {
          200: z.object({
            data: z.array(airtimeOrderResponseSchema),
            meta: z.object({
              has_more: z.boolean(),
              next_starting_after: z.string().nullable()
            })
          })
        },
        summary: "List airtime top-ups",
        tags: ["Airtime"]
      }
    },
    async (request) => {
      request.assertApiKeyScope("airtime");
      const query = request.query;
      const page = await airtimeService.list(
        request.publicApiKey!.merchantId,
        request.publicApiKey!.mode,
        {
          ...(query.batch_id ? { batchId: query.batch_id } : {}),
          ...(query.created_gte ? { createdGte: new Date(query.created_gte) } : {}),
          ...(query.created_lte ? { createdLte: new Date(query.created_lte) } : {}),
          ...(query.phone ? { phone: query.phone } : {}),
          ...(query.starting_after ? { startingAfter: query.starting_after } : {}),
          ...(query.status ? { status: query.status } : {})
        },
        query.limit
      );

      return {
        data: page.data.map(serializeAirtimeOrder),
        meta: { has_more: page.hasMore, next_starting_after: page.nextStartingAfter }
      };
    }
  );
}
