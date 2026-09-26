import { z } from "zod";

import { newId } from "@richespay/shared";

import { runAdminSystemWrite } from "../auth/admin-access";
import type { FastifyTypedInstance } from "../types";
import { DatabasePricingRepository } from "./repository";
import { feeBearers, feeMethods, feePlanKinds, fxRateSources } from "./types";

const feePlanResponseSchema = z.object({
  active: z.boolean(),
  country_code: z.string(),
  currency: z.string(),
  fee_bearer: z.enum(feeBearers),
  fixed_minor: z.number().int(),
  id: z.string(),
  kind: z.enum(feePlanKinds),
  max_minor: z.number().int().nullable(),
  method: z.enum(feeMethods),
  min_minor: z.number().int(),
  name: z.string(),
  network: z.string().nullable(),
  percent_bps: z.number().int()
});

const fxRateResponseSchema = z.object({
  active: z.boolean(),
  base: z.string(),
  captured_at: z.string(),
  id: z.string(),
  markup_bps: z.number().int(),
  quote: z.string(),
  rate: z.string(),
  source: z.enum(fxRateSources)
});

const smsPriceResponseSchema = z.object({
  country_code: z.string(),
  currency: z.string(),
  network: z.string().nullable(),
  price_per_segment_minor: z.number().int()
});

const createFxRateBodySchema = z.object({
  active: z.boolean().default(true),
  base: z.enum(["GHS", "ZMW", "USD"]),
  captured_at: z.string().datetime(),
  markup_bps: z.number().int().min(0).default(0),
  quote: z.enum(["GHS", "ZMW", "USD"]),
  rate: z.string().regex(/^\d+(\.\d+)?$/),
  reason: z.string().min(1)
}).refine((value) => value.base !== value.quote, {
  message: "Base and quote currencies must be different.",
  path: ["quote"]
});

export async function registerPricingAdminRoutes(app: FastifyTypedInstance) {
  const repository = new DatabasePricingRepository(app.db);

  app.get(
    "/pricing/fee-plans",
    {
      schema: {
        response: {
          200: z.object({
            data: z.array(feePlanResponseSchema)
          })
        }
      }
    },
    async () => {
      const plans = await repository.listFeePlans();

      return {
        data: plans.map((plan) => ({
          active: plan.active,
          country_code: plan.countryCode,
          currency: plan.currency,
          fee_bearer: plan.feeBearer,
          fixed_minor: Number(plan.fixedMinor),
          id: plan.id,
          kind: plan.kind,
          max_minor: plan.maxMinor === null ? null : Number(plan.maxMinor),
          method: plan.method,
          min_minor: Number(plan.minMinor),
          name: plan.name,
          network: plan.network,
          percent_bps: plan.percentBps
        }))
      };
    }
  );

  app.get(
    "/pricing/sms-prices",
    {
      schema: {
        response: {
          200: z.object({
            data: z.array(smsPriceResponseSchema)
          })
        }
      }
    },
    async () => {
      const prices = await repository.listSmsPrices();

      return {
        data: prices.map((price) => ({
          country_code: price.countryCode,
          currency: price.currency,
          network: price.network,
          price_per_segment_minor: Number(price.pricePerSegmentMinor)
        }))
      };
    }
  );

  app.get(
    "/pricing/fx-rates",
    {
      schema: {
        response: {
          200: z.object({
            data: z.array(fxRateResponseSchema)
          })
        }
      }
    },
    async () => {
      const rates = await repository.listFxRates();

      return {
        data: rates.map((rate) => ({
          active: rate.active,
          base: rate.base,
          captured_at: rate.capturedAt.toISOString(),
          id: rate.id,
          markup_bps: rate.markupBps,
          quote: rate.quote,
          rate: rate.rate,
          source: rate.source
        }))
      };
    }
  );

  app.post(
    "/pricing/fx-rates",
    {
      schema: {
        body: createFxRateBodySchema,
        response: {
          201: z.object({
            data: fxRateResponseSchema
          })
        }
      }
    },
    async (request, reply) => {
      const body = createFxRateBodySchema.parse(request.body);

      const inserted = await runAdminSystemWrite(
        app.db,
        {
          action: "fx_rate.create",
          actorId: request.platformAdmin!.userId,
          after: {
            base: body.base,
            quote: body.quote,
            rate: body.rate
          },
          reason: body.reason,
          targetType: "fx_rate"
        },
        async (trx) => {
          if (body.active) {
            await trx
              .updateTable("fx_rates")
              .set({
                active: false
              })
              .where("base", "=", body.base)
              .where("quote", "=", body.quote)
              .where("active", "=", true)
              .execute();
          }

          return trx
            .insertInto("fx_rates")
            .values({
              active: body.active,
              base: body.base,
              captured_at: new Date(body.captured_at),
              id: newId("fxr_"),
              markup_bps: body.markup_bps,
              quote: body.quote,
              rate: body.rate,
              source: "manual"
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        }
      );

      return reply.status(201).send({
        data: {
          active: inserted.active,
          base: inserted.base,
          captured_at: inserted.captured_at.toISOString(),
          id: inserted.id,
          markup_bps: inserted.markup_bps,
          quote: inserted.quote,
          rate: inserted.rate,
          source: inserted.source
        }
      });
    }
  );
}
