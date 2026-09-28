import { createHash } from "node:crypto";

import { getErrorDefinition } from "@richespay/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";

import { runInDashboardScope } from "../auth/dashboard-access";
import type { Json } from "../db/types";
import { ApiRouteError } from "../lib/api-error";
import { redactJsonValue } from "../lib/redaction";
import { pricingCurrencies } from "../pricing/types";
import { ProviderCatalog } from "../providers/catalog";
import type { FastifyTypedInstance } from "../types";

import {
  airtimeBatchResponseSchema,
  airtimeNetworkResponseSchema,
  airtimeOrderResponseSchema,
  airtimeQuoteResponseSchema,
  airtimeSingleBodySchema,
  serializeAirtimeBatch,
  serializeAirtimeNetwork,
  serializeAirtimeOrder,
  serializeAirtimeQuote
} from "./serialize";
import { AirtimeService, maskPhone } from "./service";
import {
  airtimeOrderStatuses,
  maxAirtimeBulkRecipients,
  type AirtimeBulkItemInput
} from "./types";

const dashboardBulkBodySchema = z
  .object({
    amount: z.coerce.number().int().positive().optional(),
    csv: z.string().min(1).max(500_000).optional(),
    currency: z.enum(pricingCurrencies).optional(),
    phones_text: z.string().min(1).max(200_000).optional(),
    reference: z.string().min(1).max(128).optional()
  })
  .refine((body) => Boolean(body.csv) !== Boolean(body.phones_text), {
    message: "Send either csv or phones_text.",
    path: ["csv"]
  })
  .refine((body) => !body.phones_text || body.amount !== undefined, {
    message: "amount is required for pasted numbers.",
    path: ["amount"]
  });

export async function registerAirtimeDashboardRoutes(app: FastifyTypedInstance) {
  const airtimeService = new AirtimeService({
    database: app.db,
    providerCatalog: new ProviderCatalog({
      database: app.db,
      encryptionKey: app.appEnv.ENCRYPTION_KEY
    })
  });
  const dispatchInline = app.appEnv.APP_ENV !== "test";

  app.get(
    "/airtime/summary",
    {
      schema: {
        querystring: z.object({
          created_gte: z.string().datetime().optional(),
          created_lte: z.string().datetime().optional()
        }),
        response: {
          200: z.object({
            data: z.object({
              failed: z.number().int(),
              failed_today: z.number().int(),
              pending: z.number().int(),
              sent: z.number().int(),
              sent_today: z.number().int(),
              spend_minor: z.number().int(),
              spent_this_month_minor: z.number().int(),
              spent_today_minor: z.number().int(),
              success_rate: z.number().nullable(),
              successful: z.number().int(),
              successful_today: z.number().int()
            })
          })
        }
      }
    },
    async (request) => {
      const membership = request.dashboardMembership!;
      const summary = await airtimeService.summary(membership.merchantId, membership.mode, {
        ...(request.query.created_gte ? { createdGte: new Date(request.query.created_gte) } : {}),
        ...(request.query.created_lte ? { createdLte: new Date(request.query.created_lte) } : {})
      });

      return {
        data: {
          failed: summary.failed,
          failed_today: summary.failedToday,
          pending: summary.pending,
          sent: summary.sent,
          sent_today: summary.sentToday,
          spend_minor: Number(summary.spendMinor),
          spent_this_month_minor: Number(summary.spentThisMonthMinor),
          spent_today_minor: Number(summary.spentTodayMinor),
          success_rate: summary.successRate,
          successful: summary.successful,
          successful_today: summary.successfulToday
        }
      };
    }
  );

  app.get(
    "/airtime/networks",
    {
      schema: {
        querystring: z.object({ country: z.string().length(2).optional() }),
        response: { 200: z.object({ data: z.array(airtimeNetworkResponseSchema) }) }
      }
    },
    async (request) => {
      const membership = request.dashboardMembership!;
      const networks = await airtimeService.listNetworks({
        ...(request.query.country ? { countryCode: request.query.country } : {}),
        merchantId: membership.merchantId,
        mode: membership.mode
      });

      return { data: networks.map(serializeAirtimeNetwork) };
    }
  );

  app.get(
    "/airtime/quote",
    {
      schema: {
        querystring: z.object({
          amount: z.coerce.number().int().positive().optional(),
          currency: z.enum(pricingCurrencies).optional(),
          phone: z.string().min(4).max(32)
        }),
        response: {
          200: z.object({
            data: airtimeQuoteResponseSchema.extend({
              fixed_denominations: z.array(z.number().int()).nullable(),
              max_amount: z.number().int(),
              min_amount: z.number().int()
            })
          })
        }
      }
    },
    async (request) => {
      const membership = request.dashboardMembership!;
      const network = await airtimeService.detectNetwork({
        merchantId: membership.merchantId,
        mode: membership.mode,
        phone: request.query.phone
      });

      if (!request.query.amount) {
        return {
          data: {
            amount: 0,
            charge_amount: 0,
            charge_currency: membership.settlementCurrency as (typeof pricingCurrencies)[number],
            country_code: network.countryCode,
            currency: network.currency,
            discount_bps: network.discountBps,
            discount_minor: 0,
            fixed_denominations: network.fixedDenominations,
            fx_rate_id: null,
            max_amount: Number(network.maxMinor),
            min_amount: Number(network.minMinor),
            network: network.network,
            phone: request.query.phone
          }
        };
      }

      const quote = await airtimeService.quote({
        amount: BigInt(request.query.amount),
        currency: request.query.currency ?? network.currency,
        merchantId: membership.merchantId,
        mode: membership.mode,
        phone: request.query.phone
      });

      return {
        data: {
          ...serializeAirtimeQuote(quote),
          fixed_denominations: network.fixedDenominations,
          max_amount: Number(network.maxMinor),
          min_amount: Number(network.minMinor)
        }
      };
    }
  );

  app.get(
    "/airtime",
    {
      schema: {
        querystring: z.object({
          batch_id: z.string().min(1).optional(),
          created_gte: z.string().datetime().optional(),
          created_lte: z.string().datetime().optional(),
          limit: z.coerce.number().int().positive().max(100).default(20),
          network: z.string().min(1).optional(),
          phone: z.string().min(4).max(32).optional(),
          starting_after: z.string().min(1).optional(),
          status: z.enum(airtimeOrderStatuses).optional()
        }),
        response: {
          200: z.object({
            data: z.array(airtimeOrderResponseSchema.extend({ phone_masked: z.string() })),
            meta: z.object({
              has_more: z.boolean(),
              next_starting_after: z.string().nullable()
            })
          })
        }
      }
    },
    async (request) => {
      const membership = request.dashboardMembership!;
      const query = request.query;
      const page = await airtimeService.list(
        membership.merchantId,
        membership.mode,
        {
          ...(query.batch_id ? { batchId: query.batch_id } : {}),
          ...(query.created_gte ? { createdGte: new Date(query.created_gte) } : {}),
          ...(query.created_lte ? { createdLte: new Date(query.created_lte) } : {}),
          ...(query.network ? { network: query.network } : {}),
          ...(query.phone ? { phone: query.phone } : {}),
          ...(query.starting_after ? { startingAfter: query.starting_after } : {}),
          ...(query.status ? { status: query.status } : {})
        },
        query.limit
      );

      return {
        data: page.data.map((order) => ({
          ...serializeAirtimeOrder(order),
          phone_masked: maskPhone(order.phone)
        })),
        meta: { has_more: page.hasMore, next_starting_after: page.nextStartingAfter }
      };
    }
  );

  app.get(
    "/airtime/batches",
    {
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(100).default(20),
          starting_after: z.string().min(1).optional()
        }),
        response: {
          200: z.object({
            data: z.array(airtimeBatchResponseSchema),
            meta: z.object({
              has_more: z.boolean(),
              next_starting_after: z.string().nullable()
            })
          })
        }
      }
    },
    async (request) => {
      const membership = request.dashboardMembership!;
      const page = await airtimeService.listBatches(
        membership.merchantId,
        membership.mode,
        {
          ...(request.query.starting_after
            ? { startingAfter: request.query.starting_after }
            : {})
        },
        request.query.limit
      );

      return {
        data: page.data.map(serializeAirtimeBatch),
        meta: { has_more: page.hasMore, next_starting_after: page.nextStartingAfter }
      };
    }
  );

  app.get(
    "/airtime/batches/:id",
    {
      schema: {
        params: z.object({ id: z.string().min(1) }),
        response: { 200: z.object({ data: airtimeBatchResponseSchema }) }
      }
    },
    async (request) => {
      const membership = request.dashboardMembership!;
      const batch = await airtimeService.getBatch(
        membership.merchantId,
        membership.mode,
        request.params.id
      );

      return { data: serializeAirtimeBatch(batch) };
    }
  );

  app.get(
    "/airtime/contact-groups",
    {
      schema: {
        response: {
          200: z.object({
            data: z.array(
              z.object({
                contact_count: z.number().int(),
                id: z.string(),
                name: z.string(),
                phones: z.array(z.string())
              })
            )
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("airtime.send");
      const membership = request.dashboardMembership!;

      const groups = await runInDashboardScope(app.db, membership, async (trx) => {
        const rows = await trx
          .selectFrom("contact_groups as group")
          .leftJoin("contact_group_members as member", "member.group_id", "group.id")
          .leftJoin("contacts as contact", "contact.id", "member.contact_id")
          .select([
            "group.id",
            "group.name",
            sql<string[]>`coalesce(array_agg(contact.phone) filter (where contact.phone is not null), '{}')`.as(
              "phones"
            )
          ])
          .where("group.merchant_id", "=", membership.merchantId)
          .where("group.mode", "=", membership.mode)
          .groupBy(["group.id", "group.name"])
          .orderBy("group.name")
          .execute();

        return rows.map((row) => ({
          contact_count: row.phones.length,
          id: row.id,
          name: row.name,
          phones: row.phones
        }));
      });

      return { data: groups };
    }
  );

  app.get(
    "/airtime/:id",
    {
      schema: {
        params: z.object({ id: z.string().min(1) }),
        response: {
          200: z.object({
            data: airtimeOrderResponseSchema.extend({
              event_timeline: z.array(
                z.object({
                  created_at: z.string().datetime(),
                  from_status: z.string().nullable(),
                  provider_reference: z.string().nullable(),
                  reason: z.string().nullable(),
                  to_status: z.string()
                })
              ),
              fx_rate: z.number().nullable(),
              phone_masked: z.string()
            })
          })
        }
      }
    },
    async (request) => {
      const membership = request.dashboardMembership!;
      const order = await airtimeService.getById(
        membership.merchantId,
        membership.mode,
        request.params.id
      );
      const [events, fxRate] = await Promise.all([
        airtimeService.listEvents(membership.merchantId, membership.mode, order.id),
        airtimeService.getFxRate(order.fxRateId)
      ]);

      return {
        data: {
          ...serializeAirtimeOrder(order),
          event_timeline: events.map((event) => ({
            created_at: event.createdAt.toISOString(),
            from_status: event.fromStatus,
            provider_reference: event.providerReference,
            reason: event.reason,
            to_status: event.toStatus
          })),
          fx_rate: fxRate,
          phone_masked: maskPhone(order.phone)
        }
      };
    }
  );

  app.post(
    "/airtime",
    {
      schema: {
        body: airtimeSingleBodySchema,
        response: { 201: z.object({ data: airtimeOrderResponseSchema }) }
      }
    },
    async (request, reply) => {
      request.assertDashboardPermission("airtime.send");
      const membership = request.dashboardMembership!;

      return withDashboardIdempotency(app, request, reply, 201, async () => {
        const order = await airtimeService.create({
          amount: BigInt(request.body.amount),
          createdBy: membership.userId,
          currency: request.body.currency,
          merchantId: membership.merchantId,
          metadata: (request.body.metadata ?? {}) as Json,
          mode: membership.mode,
          network: request.body.network ?? null,
          phone: request.body.phone,
          reference: request.body.reference ?? null
        });

        if (dispatchInline) {
          setImmediate(() => {
            void airtimeService
              .dispatchOrder(membership.merchantId, membership.mode, order.id)
              .catch((error) => app.log.error({ err: error }, "Inline airtime dispatch failed"));
          });
        }

        return { data: serializeAirtimeOrder(order) };
      });
    }
  );

  app.post(
    "/airtime/bulk",
    {
      schema: {
        body: dashboardBulkBodySchema,
        response: { 201: z.object({ data: airtimeBatchResponseSchema }) }
      }
    },
    async (request, reply) => {
      request.assertDashboardPermission("airtime.send");
      const membership = request.dashboardMembership!;
      const body = request.body;
      const items = body.csv
        ? parseCsvRecipients(body.csv, body.amount, body.currency)
        : parsePastedPhones(body.phones_text ?? "", body.amount!, body.currency);

      if (items.length === 0) {
        throw new ApiRouteError({
          code: "validation_error",
          field: body.csv ? "csv" : "phones_text",
          message: "No recipients were found.",
          statusCode: getErrorDefinition("validation_error").status
        });
      }

      if (items.length > maxAirtimeBulkRecipients) {
        throw new ApiRouteError({
          code: "validation_error",
          field: body.csv ? "csv" : "phones_text",
          message: `A bulk send accepts at most ${maxAirtimeBulkRecipients} recipients.`,
          statusCode: getErrorDefinition("validation_error").status
        });
      }

      return withDashboardIdempotency(app, request, reply, 201, async () => {
        const { batch, orderIds } = await airtimeService.createBulk({
          createdBy: membership.userId,
          items,
          merchantId: membership.merchantId,
          mode: membership.mode,
          reference: body.reference ?? null
        });

        if (dispatchInline) {
          setImmediate(() => {
            void (async () => {
              for (const orderId of orderIds) {
                await airtimeService.dispatchOrder(membership.merchantId, membership.mode, orderId);
              }
            })().catch((error) => app.log.error({ err: error }, "Inline airtime dispatch failed"));
          });
        }

        return { data: serializeAirtimeBatch(batch) };
      });
    }
  );
}

export function parsePastedPhones(
  text: string,
  amount: number,
  currency: AirtimeBulkItemInput["currency"]
): AirtimeBulkItemInput[] {
  return text
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map((phone) => ({ amount, ...(currency ? { currency } : {}), phone }));
}

/**
 * Columns: phone, amount (minor units), optional reference. A header row is
 * skipped when its first cell is not a phone number. A missing amount falls
 * back to the request-level amount.
 */
export function parseCsvRecipients(
  csv: string,
  defaultAmount: number | undefined,
  currency: AirtimeBulkItemInput["currency"]
): AirtimeBulkItemInput[] {
  const rows = csv
    .split(/\r?\n/)
    .map((line) => line.split(/[,;\t]/).map((cell) => cell.trim().replace(/^"|"$/g, "")))
    .filter((cells) => cells.some((cell) => cell !== ""));

  if (rows.length > 0 && !/\d{4,}/.test(rows[0]![0] ?? "")) {
    rows.shift();
  }

  return rows.map((cells) => {
    const amountCell = cells[1];
    const amount =
      amountCell && amountCell !== "" ? Number(amountCell) : (defaultAmount ?? Number.NaN);

    return {
      amount,
      ...(currency ? { currency } : {}),
      phone: cells[0] ?? "",
      ...(cells[2] ? { reference: cells[2] } : {})
    };
  });
}

async function withDashboardIdempotency<T extends Record<string, unknown>>(
  app: FastifyTypedInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  run: () => Promise<T>
) {
  const membership = request.dashboardMembership!;
  const header = request.headers["idempotency-key"];
  if (typeof header !== "string" || header.trim() === "") {
    throw new ApiRouteError({
      code: "validation_error",
      field: "idempotency-key",
      message: "Idempotency-Key is required",
      statusCode: getErrorDefinition("validation_error").status
    });
  }

  const key = `dashboard:${header.trim()}`;
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ body: request.body ?? null, path: request.routeOptions.url }))
    .digest("hex");

  const existing = await runInDashboardScope(app.db, membership, async (trx) =>
    trx
      .selectFrom("idempotency_keys")
      .selectAll()
      .where("merchant_id", "=", membership.merchantId)
      .where("mode", "=", membership.mode)
      .where("key", "=", key)
      .executeTakeFirst()
  );

  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw conflict("idempotency_conflict");
    }

    if (existing.status === "in_progress") {
      throw conflict("request_in_progress");
    }

    return reply.status(existing.response_status ?? statusCode).send(existing.response_body ?? {});
  }

  await runInDashboardScope(app.db, membership, async (trx) => {
    await trx
      .insertInto("idempotency_keys")
      .values({
        key,
        merchant_id: membership.merchantId,
        mode: membership.mode,
        request_hash: requestHash,
        response_body: null,
        response_status: null,
        status: "in_progress"
      })
      .execute();
  });

  try {
    const body = await run();
    await runInDashboardScope(app.db, membership, async (trx) => {
      await trx
        .updateTable("idempotency_keys")
        .set({
          response_body: redactJsonValue(body),
          response_status: statusCode,
          status: "completed"
        })
        .where("merchant_id", "=", membership.merchantId)
        .where("mode", "=", membership.mode)
        .where("key", "=", key)
        .execute();
    });

    return reply.status(statusCode).send(body);
  } catch (error) {
    // Failed validations leave no side effects, so the same key may be retried.
    await runInDashboardScope(app.db, membership, async (trx) => {
      await trx
        .deleteFrom("idempotency_keys")
        .where("merchant_id", "=", membership.merchantId)
        .where("mode", "=", membership.mode)
        .where("key", "=", key)
        .execute();
    });
    throw error;
  }
}

function conflict(code: "idempotency_conflict" | "request_in_progress") {
  const definition = getErrorDefinition(code);
  return new ApiRouteError({ code, message: definition.message, statusCode: definition.status });
}
