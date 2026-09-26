import { sql } from "kysely";
import { z } from "zod";

import type { FastifyTypedInstance } from "../types";
import { publicApiPlugin } from "../plugins/public-api";
import { FeeService } from "../pricing/fee-service";
import { DatabasePricingRepository } from "../pricing/repository";
import { feeMethods, feePlanKinds } from "../pricing/types";

export async function registerV1Routes(app: FastifyTypedInstance) {
  const pricingRepository = new DatabasePricingRepository(app.db);
  const feeService = new FeeService(pricingRepository);

  app.get(
    "/openapi.json",
    {
      schema: {
        hide: true,
        response: {
          200: z.unknown()
        }
      }
    },
    async () => app.swagger()
  );

  await app.register(async (protectedApp) => {
    await protectedApp.register(publicApiPlugin);

    protectedApp.get(
      "/fees/quote",
      {
        schema: {
          querystring: z.object({
            amount: z.coerce.number().int().positive(),
            currency: z.enum(["GHS", "ZMW", "USD"]),
            kind: z.enum(feePlanKinds),
            method: z.enum(feeMethods),
            network: z.string().min(1).optional()
          }),
          response: {
            200: z.object({
              data: z.object({
                currency: z.enum(["GHS", "ZMW", "USD"]),
                customer_pays_minor: z.number().int(),
                fee_minor: z.number().int(),
                merchant_receives_minor: z.number().int()
              })
            })
          }
        }
      },
      async (request) => {
        request.assertApiKeyScope("read");

        const query = z.object({
          amount: z.coerce.number().int().positive(),
          currency: z.enum(["GHS", "ZMW", "USD"]),
          kind: z.enum(feePlanKinds),
          method: z.enum(feeMethods),
          network: z.string().min(1).optional()
        }).parse(request.query);

        const quote = await request.withPublicApiScope(async (trx) => {
          const merchant = await trx
            .selectFrom("merchants")
            .select([
              "country_code as countryCode",
              "id",
              "mode",
              "settlement_currency as settlementCurrency"
            ])
            .where("id", "=", request.publicApiKey!.merchantId)
            .executeTakeFirstOrThrow();

          return feeService.quote(
            merchant,
            query.kind,
            query.method,
            query.network ?? null,
            BigInt(query.amount),
            query.currency,
            trx
          );
        });

        return {
          data: {
            currency: query.currency,
            customer_pays_minor: Number(quote.customerPaysMinor),
            fee_minor: Number(quote.feeMinor),
            merchant_receives_minor: Number(quote.merchantReceivesMinor)
          }
        };
      }
    );

    protectedApp.get(
      "/balance",
      {
        schema: {
          response: {
            200: z.object({
              data: z.array(
                z.object({
                  available: z.number().int(),
                  currency: z.string(),
                  on_hold: z.number().int(),
                  pending: z.number().int()
                })
              )
            })
          }
        }
      },
      async (request) => {
        request.assertApiKeyScope("read");

        const balances = await request.withPublicApiScope(async (trx) =>
          trx
            .selectFrom("ledger_accounts as la")
            .leftJoin("account_balances as ab", "ab.account_id", "la.id")
            .select([
              "la.currency as currency",
              sql<string>`coalesce(sum(case when la.type = 'merchant_available' then ab.balance else 0 end), 0)::text`.as("available"),
              sql<string>`coalesce(sum(case when la.type = 'merchant_pending' then ab.balance else 0 end), 0)::text`.as("pending"),
              sql<string>`coalesce(sum(case when la.type = 'merchant_payout_hold' then ab.balance else 0 end), 0)::text`.as("onHold")
            ])
            .where("la.type", "in", [
              "merchant_available",
              "merchant_pending",
              "merchant_payout_hold"
            ])
            .groupBy("la.currency")
            .orderBy("la.currency")
            .execute()
        );

        return {
          data: balances.map((balance) => ({
            available: Number(balance.available),
            currency: balance.currency,
            on_hold: Number(balance.onHold),
            pending: Number(balance.pending)
          }))
        };
      }
    );
  });
}
