import { parsePhoneNumberFromString } from "libphonenumber-js";
import { sql } from "kysely";
import { z } from "zod";

import { newId } from "@richespay/shared";

import { CollectionService } from "../collections";
import type { Json } from "../db/types";
import { ApiRouteError } from "../lib/api-error";
import { SmsMessagingService } from "../sms/public-service";
import { countSmsSegments } from "../sms/text";
import type { FastifyTypedInstance } from "../types";

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const metadataSchema = z.record(z.string(), z.unknown()).default({});
const summaryPageSchema = z.enum([
  "overview",
  "collections",
  "payouts",
  "payment_links",
  "messages",
  "balance"
]);

const collectionStatusSchema = z.enum([
  "pending",
  "processing",
  "successful",
  "failed",
  "expired",
  "reversed"
]);

const smsMessageStatusSchema = z.enum([
  "queued",
  "sent",
  "delivered",
  "undelivered",
  "failed",
  "rejected"
]);

const smsMessageTypeSchema = z.enum(["transactional", "otp", "marketing"]);

function dateRangeFromQuery(input: {
  endDate?: string | undefined;
  startDate?: string | undefined;
}) {
  const endDate = input.endDate ? new Date(`${input.endDate}T23:59:59.999Z`) : new Date();
  const startDate = input.startDate
    ? new Date(`${input.startDate}T00:00:00.000Z`)
    : new Date(endDate.getTime() - 29 * 24 * 60 * 60 * 1000);

  return { endDate, startDate };
}

function percentage(numerator: number, denominator: number) {
  if (denominator <= 0) {
    return 0;
  }

  return Number(((numerator / denominator) * 100).toFixed(1));
}

function bigintSum(values: Array<bigint>) {
  return values.reduce((total, value) => total + value, 0n);
}

function bigintFromUnknown(value: unknown) {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return BigInt(value);
  }

  if (typeof value === "string") {
    return BigInt(value);
  }

  return 0n;
}

function normalizePhone(input: string) {
  const parsed = parsePhoneNumberFromString(input);
  if (!parsed || !parsed.isValid()) {
    throw new ApiRouteError({
      code: "invalid_phone_number",
      field: "phone",
      message: "A valid E.164 phone number is required.",
      statusCode: 400
    });
  }

  return parsed.number;
}

function maskPhone(phone: string | null) {
  if (!phone) {
    return null;
  }

  if (phone.length <= 6) {
    return phone;
  }

  return `${phone.slice(0, 4)}****${phone.slice(-3)}`;
}

function previewText(text: string, maxLength = 72) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}...`;
}

function serializeCollectionRow(row: {
  amount: bigint | number | string;
  completed_at: Date | null;
  created_at: Date;
  currency: string;
  customer_name: string | null;
  description: string | null;
  failure_code: string | null;
  failure_message: string | null;
  fee_minor: bigint | number | string;
  id: string;
  metadata: Json;
  method: string;
  network: string | null;
  phone: string | null;
  reference: string | null;
  status: string;
}) {
  return {
    amount: Number(bigintFromUnknown(row.amount)),
    completed_at: row.completed_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    currency: row.currency,
    customer: {
      name: row.customer_name,
      phone: row.phone,
      phone_masked: maskPhone(row.phone)
    },
    description: row.description,
    failure_code: row.failure_code,
    failure_message: row.failure_message,
    fee_minor: Number(bigintFromUnknown(row.fee_minor)),
    id: row.id,
    metadata: row.metadata,
    method: row.method,
    network: row.network,
    reference: row.reference,
    status: row.status
  };
}

export async function registerMerchantDashboardRoutes(app: FastifyTypedInstance) {
  const collectionService = new CollectionService({
    database: app.db
  });
  const smsService = new SmsMessagingService({
    database: app.db,
    enableQueue: app.appEnv.APP_ENV !== "test",
    encryptionKey: app.appEnv.ENCRYPTION_KEY,
    redisUrl: app.appEnv.REDIS_URL
  });

  app.get(
    "/summary",
    {
      schema: {
        querystring: z.object({
          end_date: dateOnlySchema.optional(),
          page: summaryPageSchema.default("overview"),
          start_date: dateOnlySchema.optional()
        }),
        response: {
          200: z.object({
            data: z.unknown()
          })
        }
      }
    },
    async (request) => {
      const membership = request.dashboardMembership!;
      const { endDate, startDate } = dateRangeFromQuery(
        request.query.end_date || request.query.start_date
          ? {
              ...(request.query.end_date ? { endDate: request.query.end_date } : {}),
              ...(request.query.start_date ? { startDate: request.query.start_date } : {})
            }
          : {}
      );

      const summary = await request.withDashboardScope(async (trx) => {
        const dailyStats = await trx
          .selectFrom("merchant_daily_stats")
          .selectAll()
          .where("stat_date", ">=", startDate)
          .where("stat_date", "<=", endDate)
          .orderBy("stat_date", "asc")
          .execute();

        const balances = await trx
          .selectFrom("ledger_accounts as account")
          .leftJoin("account_balances as balance", "balance.account_id", "account.id")
          .select([
            "account.currency as currency",
            "account.type as type",
            sql<string>`coalesce(balance.balance, 0)::text`.as("balance")
          ])
          .where("account.mode", "=", membership.mode)
          .where("account.merchant_id", "=", membership.merchantId)
          .where("account.type", "in", [
            "merchant_available",
            "merchant_pending",
            "merchant_reserve",
            "merchant_payout_hold"
          ])
          .execute();

        const todayStats = dailyStats.at(-1);
        const collectionAmountMinor = bigintSum(
          dailyStats.map((row) => bigintFromUnknown(row.collections_amount_minor))
        );
        const payoutAmountMinor = bigintSum(
          dailyStats.map((row) => bigintFromUnknown(row.payouts_amount_minor))
        );
        const smsSpendMinor = bigintSum(
          dailyStats.map((row) => bigintFromUnknown(row.sms_spend_minor))
        );
        const collectionsTotal = dailyStats.reduce(
          (total, row) => total + row.collections_count,
          0
        );
        const collectionsSuccessful = dailyStats.reduce(
          (total, row) => total + row.collections_successful_count,
          0
        );
        const payoutsTotal = dailyStats.reduce(
          (total, row) => total + row.payouts_count,
          0
        );
        const payoutsSuccessful = dailyStats.reduce(
          (total, row) => total + row.payouts_successful_count,
          0
        );
        const payoutsFailed = dailyStats.reduce(
          (total, row) => total + row.payouts_failed_count,
          0
        );
        const payoutsPendingApproval = dailyStats.reduce(
          (total, row) => total + row.payouts_pending_approval_count,
          0
        );
        const smsTotal = dailyStats.reduce((total, row) => total + row.sms_count, 0);
        const smsDelivered = dailyStats.reduce(
          (total, row) => total + row.sms_delivered_count,
          0
        );
        const smsFailed = dailyStats.reduce(
          (total, row) => total + row.sms_failed_count,
          0
        );
        const smsPending = dailyStats.reduce(
          (total, row) => total + row.sms_pending_count,
          0
        );

        const paymentLinks = await trx
          .selectFrom("payment_links")
          .select([
            sql<number>`count(*)`.as("total"),
            sql<number>`count(*) filter (where active = true)`.as("active")
          ])
          .where("merchant_id", "=", membership.merchantId)
          .where("mode", "=", membership.mode)
          .executeTakeFirstOrThrow();

        const paymentLinkCollections = await trx
          .selectFrom("checkout_sessions as session")
          .innerJoin("collections as collection", "collection.id", "session.collection_id")
          .select([
            sql<number>`count(*)`.as("payments"),
            sql<string>`coalesce(sum(collection.amount), 0)::text`.as("amount_minor")
          ])
          .where("session.payment_link_id", "is not", null)
          .where("session.merchant_id", "=", membership.merchantId)
          .where("session.mode", "=", membership.mode)
          .where("collection.status", "=", "successful")
          .executeTakeFirstOrThrow();

        const checklistCounts = await Promise.all([
          trx
            .selectFrom("kyb_profiles")
            .select(sql<number>`count(*)`.as("count"))
            .executeTakeFirstOrThrow(),
          trx
            .selectFrom("settlement_accounts")
            .select(sql<number>`count(*)`.as("count"))
            .executeTakeFirstOrThrow(),
          trx
            .selectFrom("api_keys")
            .select(sql<number>`count(*)`.as("count"))
            .where("mode", "=", membership.mode)
            .executeTakeFirstOrThrow(),
          trx
            .selectFrom("collections")
            .select(sql<number>`count(*)`.as("count"))
            .where("status", "=", "successful")
            .executeTakeFirstOrThrow()
        ]);

        const recentCollections = await trx
          .selectFrom("collections")
          .select([
            "id",
            "created_at",
            "reference",
            "amount",
            "currency",
            "status"
          ])
          .orderBy("created_at", "desc")
          .limit(4)
          .execute();

        const recentPayouts = await trx
          .selectFrom("payouts")
          .select([
            "id",
            "created_at",
            "reference",
            "amount",
            "currency",
            "status"
          ])
          .orderBy("created_at", "desc")
          .limit(4)
          .execute();

        const recentSms = await trx
          .selectFrom("sms_messages")
          .select([
            "id",
            "created_at",
            "reference",
            "price_minor",
            "currency",
            "status"
          ])
          .orderBy("created_at", "desc")
          .limit(4)
          .execute();

        const recentTransactions = [
          ...recentCollections.map((row) => ({
            amount_minor: Number(bigintFromUnknown(row.amount)),
            created_at: row.created_at.toISOString(),
            currency: row.currency,
            id: row.id,
            kind: "collection",
            reference: row.reference,
            status: row.status
          })),
          ...recentPayouts.map((row) => ({
            amount_minor: Number(bigintFromUnknown(row.amount)),
            created_at: row.created_at.toISOString(),
            currency: row.currency,
            id: row.id,
            kind: "payout",
            reference: row.reference,
            status: row.status
          })),
          ...recentSms.map((row) => ({
            amount_minor: Number(bigintFromUnknown(row.price_minor)),
            created_at: row.created_at.toISOString(),
            currency: row.currency,
            id: row.id,
            kind: "sms",
            reference: row.reference,
            status: row.status
          }))
        ]
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
          .slice(0, 8);

        const balanceByType = new Map(
          balances.map((row) => [row.type, bigintFromUnknown(row.balance)])
        );

        return {
          active_products: membership.activeProducts,
          balance: {
            available_minor: Number(balanceByType.get("merchant_available") ?? 0n),
            currency: membership.settlementCurrency,
            on_hold_minor: Number(balanceByType.get("merchant_payout_hold") ?? 0n),
            pending_minor: Number(balanceByType.get("merchant_pending") ?? 0n),
            reserve_minor: Number(balanceByType.get("merchant_reserve") ?? 0n)
          },
          collections: {
            pending: dailyStats.reduce((total, row) => total + row.collections_pending_count, 0),
            success_rate: percentage(collectionsSuccessful, collectionsTotal),
            successful: collectionsSuccessful,
            total_collected_minor: Number(collectionAmountMinor)
          },
          messages: {
            delivery_rate: percentage(smsDelivered, smsTotal),
            failed: smsFailed,
            pending: smsPending,
            sent: smsTotal,
            spend_minor: Number(smsSpendMinor)
          },
          overview: {
            cards: {
              available_balance_minor: Number(balanceByType.get("merchant_available") ?? 0n),
              collected_today_minor: Number(
                bigintFromUnknown(todayStats?.collections_amount_minor ?? 0)
              ),
              paid_out_today_minor: Number(
                bigintFromUnknown(todayStats?.payouts_amount_minor ?? 0)
              ),
              sms_sent_today: todayStats?.sms_count ?? 0
            },
            chart: dailyStats.map((row) => ({
              collections_amount_minor: Number(bigintFromUnknown(row.collections_amount_minor)),
              date: row.stat_date.toISOString().slice(0, 10)
            })),
            checklist: [
              {
                complete: checklistCounts[0].count > 0,
                key: "kyb",
                label: "Complete KYB"
              },
              {
                complete: checklistCounts[1].count > 0,
                key: "settlement_account",
                label: "Add settlement account"
              },
              {
                complete: checklistCounts[2].count > 0,
                key: "api_key",
                label: "Create API key"
              },
              {
                complete: checklistCounts[3].count > 0,
                key: "first_payment",
                label: "First test payment"
              }
            ],
            recent_transactions: recentTransactions
          },
          page: request.query.page,
          payment_links: {
            active_links: paymentLinks.active,
            amount_collected_minor: Number(
              bigintFromUnknown(paymentLinkCollections.amount_minor)
            ),
            payments_via_links: paymentLinkCollections.payments
          },
          payouts: {
            awaiting_approval: payoutsPendingApproval,
            failed: payoutsFailed,
            paid_out_minor: Number(payoutAmountMinor),
            successful: payoutsSuccessful,
            total: payoutsTotal
          }
        };
      });

      return { data: summary };
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
          method: z.enum(["mobile_money", "card"]).optional(),
          network: z.string().min(1).optional(),
          search: z.string().min(1).optional(),
          starting_after: z.string().min(1).optional(),
          status: collectionStatusSchema.optional()
        }),
        response: {
          200: z.object({
            data: z.array(z.unknown()),
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
      const page = await request.withDashboardScope(async (trx) => {
        let query = trx
          .selectFrom("collections")
          .selectAll()
          .where("merchant_id", "=", membership.merchantId)
          .where("mode", "=", membership.mode)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(request.query.limit + 1);

        if (request.query.created_gte) {
          query = query.where("created_at", ">=", new Date(request.query.created_gte));
        }

        if (request.query.created_lte) {
          query = query.where("created_at", "<=", new Date(request.query.created_lte));
        }

        if (request.query.method) {
          query = query.where("method", "=", request.query.method);
        }

        if (request.query.network) {
          query = query.where("network", "=", request.query.network);
        }

        if (request.query.status) {
          query = query.where("status", "=", request.query.status);
        }

        if (request.query.search) {
          query = query.where((eb) =>
            eb.or([
              eb("reference", "ilike", `%${request.query.search}%`),
              eb("phone", "ilike", `%${request.query.search}%`),
              eb("customer_name", "ilike", `%${request.query.search}%`)
            ])
          );
        }

        if (request.query.starting_after) {
          const cursor = await trx
            .selectFrom("collections")
            .select(["created_at", "id"])
            .where("id", "=", request.query.starting_after)
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
        const items = rows.slice(0, request.query.limit);

        return {
          items,
          nextStartingAfter:
            rows.length > request.query.limit ? items.at(-1)?.id ?? null : null
        };
      });

      return {
        data: page.items.map(serializeCollectionRow),
        meta: {
          has_more: page.nextStartingAfter !== null,
          next_starting_after: page.nextStartingAfter
        }
      };
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
            data: z.unknown()
          })
        }
      }
    },
    async (request) => {
      const membership = request.dashboardMembership!;
      const collection = await collectionService.getById(
        membership.merchantId,
        membership.mode,
        request.params.id
      );

      const detail = await request.withDashboardScope(async (trx) => {
        const events = await trx
          .selectFrom("transaction_events")
          .selectAll()
          .where("resource_type", "=", "collection")
          .where("resource_id", "=", request.params.id)
          .orderBy("created_at", "asc")
          .execute();

        return {
          event_timeline: events.map((event) => ({
            created_at: event.created_at.toISOString(),
            from_status: event.from_status,
            provider_reference: event.provider_reference,
            reason: event.reason,
            to_status: event.to_status
          }))
        };
      });

      return {
        data: {
          ...serializeCollectionRow({
            amount: collection.amount,
            completed_at: collection.completedAt,
            created_at: collection.createdAt,
            currency: collection.currency,
            customer_name: collection.customerName,
            description: collection.description,
            failure_code: collection.failureCode,
            failure_message: collection.failureMessage,
            fee_minor: collection.feeMinor,
            id: collection.id,
            metadata: collection.metadata,
            method: collection.method,
            network: collection.network,
            phone: collection.phone,
            reference: collection.reference,
            status: collection.status
          }),
          amount_breakdown: {
            fee_minor: Number(collection.feeMinor),
            gross_minor: Number(collection.amount),
            net_minor: Number(collection.netMinor)
          },
          customer: {
            email: collection.customerEmail,
            name: collection.customerName,
            phone: collection.phone,
            phone_masked: maskPhone(collection.phone)
          },
          event_timeline: detail.event_timeline
        }
      };
    }
  );

  app.get(
    "/messages",
    {
      schema: {
        querystring: z.object({
          created_gte: z.string().datetime().optional(),
          created_lte: z.string().datetime().optional(),
          limit: z.coerce.number().int().positive().max(100).default(20),
          sender_id: z.string().min(3).max(11).optional(),
          starting_after: z.string().min(1).optional(),
          status: smsMessageStatusSchema.optional()
        }),
        response: {
          200: z.object({
            data: z.array(z.unknown()),
            meta: z.object({
              has_more: z.boolean(),
              next_starting_after: z.string().nullable()
            })
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("sms.manage");
      const membership = request.dashboardMembership!;
      const page = await smsService.list(
        membership.merchantId,
        membership.mode,
        {
          ...(request.query.created_gte
            ? { createdGte: new Date(request.query.created_gte) }
            : {}),
          ...(request.query.created_lte
            ? { createdLte: new Date(request.query.created_lte) }
            : {}),
          ...(request.query.starting_after
            ? { startingAfter: request.query.starting_after }
            : {}),
          ...(request.query.status ? { status: request.query.status } : {})
        },
        request.query.limit
      );

      const filteredItems = request.query.sender_id
        ? page.items.filter((item) => item.senderId === request.query.sender_id)
        : page.items;

      return {
        data: filteredItems.map((item) => ({
          cost_minor: Number(item.priceMinor),
          created_at: item.createdAt.toISOString(),
          id: item.id,
          preview: previewText(item.body),
          recipient: item.to,
          recipient_masked: maskPhone(item.to),
          segments: item.segments,
          sender_id: item.senderId,
          status: item.status,
          type: item.type
        })),
        meta: {
          has_more: page.nextStartingAfter !== null,
          next_starting_after: page.nextStartingAfter
        }
      };
    }
  );

  app.get(
    "/messages/batches",
    {
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(100).default(20)
        }),
        response: {
          200: z.object({
            data: z.array(z.unknown())
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("sms.manage");
      const membership = request.dashboardMembership!;

      const rows = await request.withDashboardScope(async (trx) =>
        trx
          .selectFrom("sms_batches")
          .selectAll()
          .where("merchant_id", "=", membership.merchantId)
          .where("mode", "=", membership.mode)
          .orderBy("created_at", "desc")
          .limit(request.query.limit)
          .execute()
      );

      return {
        data: rows.map((row) => ({
          accepted_count: row.accepted_count,
          body_preview: previewText(row.body),
          created_at: row.created_at.toISOString(),
          delivered_count: 0,
          failed_count: 0,
          id: row.id,
          pending_count: Math.max(row.accepted_count - row.rejected_count, 0),
          rejected_count: row.rejected_count,
          scheduled_at: row.scheduled_at?.toISOString() ?? null,
          sender_id: row.sender_id,
          status: row.status,
          total_count: row.total_count,
          type: row.type
        }))
      };
    }
  );

  app.post(
    "/messages/broadcast",
    {
      schema: {
        body: z.object({
          contact_group_id: z.string().min(1).optional(),
          message: z.string().min(1).max(1600),
          metadata: metadataSchema.optional(),
          recipients: z.array(
            z.object({
              name: z.string().min(1).optional(),
              phone: z.string().min(4)
            })
          ).max(10_000).optional(),
          schedule_at: z.string().datetime().optional(),
          sender_id: z.string().min(3).max(11).optional(),
          type: smsMessageTypeSchema,
          upload_name: z.string().optional()
        }),
        response: {
          201: z.object({
            data: z.unknown()
          })
        }
      }
    },
    async (request, reply) => {
      request.assertDashboardPermission("sms.manage");
      const membership = request.dashboardMembership!;
      const body = request.body;

      const dedupedRecipients = new Map<string, { name?: string; phone: string }>();
      for (const recipient of body.recipients ?? []) {
        const normalized = normalizePhone(recipient.phone);
        if (!dedupedRecipients.has(normalized)) {
          dedupedRecipients.set(normalized, {
            ...(recipient.name ? { name: recipient.name } : {}),
            phone: normalized
          });
        }
      }

      const segments = countSmsSegments(body.message);
      const result = await smsService.createBulk({
        contactGroupId: body.contact_group_id ?? null,
        createdBy: membership.userId,
        merchantId: membership.merchantId,
        metadata: {
          ...(body.metadata ?? {}),
          ...(body.upload_name ? { upload_name: body.upload_name } : {})
        } as Json,
        mode: membership.mode,
        reference: null,
        scheduleAt: body.schedule_at ? new Date(body.schedule_at) : null,
        senderId: body.sender_id ?? null,
        to: dedupedRecipients.size > 0 ? Array.from(dedupedRecipients.values()) : null,
        type: body.type,
        userMessage: body.message
      });

      return reply.status(201).send({
        data: {
          accepted_count: result.acceptedCount,
          balance_after_minor: null,
          batch_id: result.batch.id,
          estimated_segments: segments.segments,
          rejected_count: result.rejectedCount,
          total_count: result.batch.totalCount
        }
      });
    }
  );

  app.get(
    "/contacts",
    {
      schema: {
        querystring: z.object({
          group_id: z.string().min(1).optional(),
          search: z.string().min(1).optional()
        }),
        response: {
          200: z.object({
            data: z.object({
              contacts: z.array(z.unknown()),
              groups: z.array(z.unknown()),
              opt_out_count: z.number().int()
            })
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("sms.manage");
      const membership = request.dashboardMembership!;

      const data = await request.withDashboardScope(async (trx) => {
        let contactsQuery = trx
          .selectFrom("contacts as contact")
          .leftJoin("contact_group_members as membership", "membership.contact_id", "contact.id")
          .leftJoin("sms_opt_outs as opt_out", "opt_out.phone", "contact.phone")
          .select([
            "contact.created_at",
            "contact.id",
            "contact.name",
            "contact.phone",
            "contact.tags",
            sql<number>`count(membership.group_id)`.as("group_count"),
            sql<boolean>`bool_or(opt_out.id is not null)`.as("opted_out")
          ])
          .where("contact.merchant_id", "=", membership.merchantId)
          .where("contact.mode", "=", membership.mode)
          .groupBy([
            "contact.created_at",
            "contact.id",
            "contact.name",
            "contact.phone",
            "contact.tags"
          ])
          .orderBy("contact.name")
          .orderBy("contact.created_at", "desc");

        if (request.query.search) {
          contactsQuery = contactsQuery.where((eb) =>
            eb.or([
              eb("contact.name", "ilike", `%${request.query.search}%`),
              eb("contact.phone", "ilike", `%${request.query.search}%`)
            ])
          );
        }

        if (request.query.group_id) {
          contactsQuery = contactsQuery.where("membership.group_id", "=", request.query.group_id);
        }

        const contacts = await contactsQuery.execute();
        const groups = await trx
          .selectFrom("contact_groups as group")
          .leftJoin("contact_group_members as membership", "membership.group_id", "group.id")
          .select([
            "group.created_at",
            "group.id",
            "group.name",
            sql<number>`count(membership.contact_id)`.as("contact_count")
          ])
          .where("group.merchant_id", "=", membership.merchantId)
          .where("group.mode", "=", membership.mode)
          .groupBy(["group.created_at", "group.id", "group.name"])
          .orderBy("group.name")
          .execute();
        const optOutCount = await trx
          .selectFrom("sms_opt_outs")
          .select(sql<number>`count(*)`.as("count"))
          .where("merchant_id", "=", membership.merchantId)
          .where("mode", "=", membership.mode)
          .executeTakeFirstOrThrow();

        return {
          contacts,
          groups,
          optOutCount: optOutCount.count
        };
      });

      return {
        data: {
          contacts: data.contacts.map((contact) => ({
            created_at: contact.created_at.toISOString(),
            group_count: contact.group_count,
            id: contact.id,
            name: contact.name,
            opted_out: Boolean(contact.opted_out),
            phone: contact.phone,
            phone_masked: maskPhone(contact.phone),
            tags: contact.tags ?? []
          })),
          groups: data.groups.map((group) => ({
            contact_count: group.contact_count,
            created_at: group.created_at.toISOString(),
            id: group.id,
            name: group.name
          })),
          opt_out_count: data.optOutCount
        }
      };
    }
  );

  app.post(
    "/contacts/import",
    {
      schema: {
        body: z.object({
          contacts: z.array(
            z.object({
              name: z.string().optional(),
              phone: z.string().min(4),
              tags: z.array(z.string()).optional()
            })
          ).min(1).max(10_000),
          group_name: z.string().min(1).optional()
        }),
        response: {
          201: z.object({
            data: z.unknown()
          })
        }
      }
    },
    async (request, reply) => {
      request.assertDashboardPermission("sms.manage");
      const membership = request.dashboardMembership!;

      const result = await request.withDashboardScope(async (trx) => {
        const importedIds: string[] = [];
        let groupId: string | null = null;

        if (request.body.group_name) {
          const group = await trx
            .insertInto("contact_groups")
            .values({
              created_by: membership.userId,
              id: newId("cgr_"),
              merchant_id: membership.merchantId,
              mode: membership.mode,
              name: request.body.group_name
            })
            .onConflict((conflict) =>
              conflict.columns(["merchant_id", "mode", "name"]).doUpdateSet({
                updated_at: new Date()
              })
            )
            .returning("id")
            .executeTakeFirst();

          if (group) {
            groupId = group.id;
          } else {
            const existing = await trx
              .selectFrom("contact_groups")
              .select("id")
              .where("merchant_id", "=", membership.merchantId)
              .where("mode", "=", membership.mode)
              .where("name", "=", request.body.group_name)
              .executeTakeFirst();
            groupId = existing?.id ?? null;
          }
        }

        let imported = 0;
        let duplicates = 0;
        const invalid: Array<{ phone: string; reason: string }> = [];

        for (const item of request.body.contacts) {
          try {
            const phone = normalizePhone(item.phone);
            const existing = await trx
              .selectFrom("contacts")
              .select("id")
              .where("merchant_id", "=", membership.merchantId)
              .where("mode", "=", membership.mode)
              .where("phone", "=", phone)
              .executeTakeFirst();

            const contactId = existing?.id ?? newId("ctc_");
            if (existing) {
              duplicates += 1;
            } else {
              imported += 1;
            }

            await trx
              .insertInto("contacts")
              .values({
                id: contactId,
                merchant_id: membership.merchantId,
                mode: membership.mode,
                name: item.name ?? null,
                phone,
                tags: item.tags ?? []
              })
              .onConflict((conflict) =>
                conflict.columns(["merchant_id", "mode", "phone"]).doUpdateSet({
                  name: item.name ?? null,
                  tags: item.tags ?? [],
                  updated_at: new Date()
                })
              )
              .execute();

            if (groupId) {
              await trx
                .insertInto("contact_group_members")
                .values({
                  contact_id: contactId,
                  created_at: new Date(),
                  group_id: groupId,
                  merchant_id: membership.merchantId,
                  mode: membership.mode
                })
                .onConflict((conflict) => conflict.doNothing())
                .execute();
            }

            importedIds.push(contactId);
          } catch (error) {
            invalid.push({
              phone: item.phone,
              reason:
                error instanceof ApiRouteError ? error.message : "Invalid contact record"
            });
          }
        }

        return {
          duplicates,
          groupId,
          imported,
          invalid
        };
      });

      return reply.status(201).send({
        data: result
      });
    }
  );

  app.get(
    "/balance",
    {
      schema: {
        response: {
          200: z.object({
            data: z.unknown()
          })
        }
      }
    },
    async (request) => {
      const membership = request.dashboardMembership!;
      const balances = await request.withDashboardScope(async (trx) =>
        trx
          .selectFrom("ledger_accounts as account")
          .leftJoin("account_balances as balance", "balance.account_id", "account.id")
          .select([
            "account.currency",
            "account.type",
            sql<string>`coalesce(balance.balance, 0)::text`.as("balance")
          ])
          .where("account.merchant_id", "=", membership.merchantId)
          .where("account.mode", "=", membership.mode)
          .where("account.type", "in", [
            "merchant_available",
            "merchant_pending",
            "merchant_reserve",
            "merchant_payout_hold"
          ])
          .orderBy("account.currency")
          .execute()
      );

      return {
        data: balances.map((row) => ({
          amount_minor: Number(bigintFromUnknown(row.balance)),
          currency: row.currency,
          type: row.type
        }))
      };
    }
  );

  app.get(
    "/balance/statement",
    {
      schema: {
        querystring: z.object({
          entry_type: z.enum([
            "adjustment",
            "collection",
            "fee",
            "payout",
            "reversal",
            "settlement",
            "sms",
            "topup"
          ]).optional(),
          limit: z.coerce.number().int().positive().max(100).default(20)
        }),
        response: {
          200: z.object({
            data: z.array(z.unknown())
          })
        }
      }
    },
    async (request) => {
      const membership = request.dashboardMembership!;
      const rows = await request.withDashboardScope(async (trx) => {
        let query = trx
          .selectFrom("postings as posting")
          .innerJoin("journal_entries as journal", "journal.id", "posting.journal_entry_id")
          .innerJoin("ledger_accounts as account", "account.id", "posting.account_id")
          .select([
            "account.currency",
            "account.type as account_type",
            "journal.created_at",
            "journal.description",
            "journal.id",
            "journal.reference_id",
            "journal.reference_type",
            "posting.amount",
            "posting.direction"
          ])
          .where("account.merchant_id", "=", membership.merchantId)
          .where("account.mode", "=", membership.mode)
          .orderBy("journal.created_at", "desc")
          .limit(request.query.limit);

        if (request.query.entry_type) {
          query = query.where("journal.reference_type", "=", request.query.entry_type);
        }

        return query.execute();
      });

      return {
        data: rows.map((row) => ({
          account_type: row.account_type,
          amount_minor: Number(bigintFromUnknown(row.amount)),
          created_at: row.created_at.toISOString(),
          currency: row.currency,
          description: row.description,
          direction: row.direction,
          id: row.id,
          reference_id: row.reference_id,
          reference_type: row.reference_type
        }))
      };
    }
  );
}
