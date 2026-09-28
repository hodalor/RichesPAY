import { z } from "zod";

import { newId } from "@richespay/shared";

import { createSupabaseServiceClient } from "../auth/supabase-client";
import { runAdminSystemWrite } from "../auth/admin-access";
import { runWithSystemScope, type ScopedTransaction } from "../db";
import type { Json, KybProfileStatus } from "../db/types";
import { ApiRouteError } from "../lib/api-error";
import type { FastifyTypedInstance } from "../types";

const modeSchema = z.enum(["test", "live"]);
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const merchantsQuerySchema = z.object({
  country_code: z.string().min(2).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  mode: modeSchema.optional(),
  search: z.string().min(1).optional(),
  status: z.enum(["active", "closed", "pending_kyb", "suspended"]).optional()
});

const merchantParamsSchema = z.object({
  merchantId: z.string().min(1)
});

const modeQuerySchema = z.object({
  mode: modeSchema.default("live")
});

const kybQueueQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  mode: modeSchema.optional(),
  status: z.enum(["approved", "pending", "rejected"]).optional()
});

const kybReviewBodySchema = z.object({
  mode: modeSchema,
  reason: z.string().min(1),
  review_note: z.string().min(1),
  status: z.enum(["approved", "pending", "rejected"])
});

const transactionSearchQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(30),
  mode: modeSchema.optional(),
  q: z.string().min(1)
});

const auditLogQuerySchema = z.object({
  action: z.string().min(1).optional(),
  actor_id: z.string().min(1).optional(),
  end_date: dateOnlySchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  merchant_id: z.string().min(1).optional(),
  start_date: dateOnlySchema.optional()
});

function toDateRange(input: {
  endDate?: string | undefined;
  startDate?: string | undefined;
}) {
  const next: {
    endDate?: Date;
    startDate?: Date;
  } = {};

  if (input.startDate) {
    next.startDate = new Date(`${input.startDate}T00:00:00.000Z`);
  }

  if (input.endDate) {
    next.endDate = new Date(`${input.endDate}T23:59:59.999Z`);
  }

  return next;
}

function numberFromInt8(value: string | number | bigint | null) {
  if (value === null) {
    return null;
  }

  return Number(value);
}

function serializeKybStatus(
  status: KybProfileStatus
): "approved" | "pending" | "rejected" {
  switch (status) {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    default:
      return "pending";
  }
}

async function provisionLiveMerchant(trx: ScopedTransaction, testMerchantId: string) {
  const source = await trx
    .selectFrom("merchants")
    .selectAll()
    .where("id", "=", testMerchantId)
    .where("mode", "=", "test")
    .executeTakeFirst();

  if (!source) {
    return;
  }

  const existingLive = await trx
    .selectFrom("merchants")
    .select("id")
    .where("legal_name", "=", source.legal_name)
    .where("country_code", "=", source.country_code)
    .where("mode", "=", "live")
    .executeTakeFirst();

  if (existingLive) {
    return;
  }

  const liveId = newId("mer_");
  const now = new Date();

  await trx
    .insertInto("merchants")
    .values({
      collections_freeze_reason: source.collections_freeze_reason,
      collections_frozen: source.collections_frozen,
      country_code: source.country_code,
      created_at: now,
      id: liveId,
      legal_name: source.legal_name,
      mode: "live",
      payouts_freeze_reason: source.payouts_freeze_reason,
      payouts_frozen: source.payouts_frozen,
      settlement_currency: source.settlement_currency,
      status: "active",
      support_email: source.support_email,
      support_phone: source.support_phone,
      timezone: source.timezone,
      trading_name: source.trading_name,
      updated_at: now,
      website: source.website
    })
    .execute();

  const memberships = await trx
    .selectFrom("memberships")
    .select(["role", "user_id"])
    .where("merchant_id", "=", testMerchantId)
    .execute();

  if (memberships.length > 0) {
    await trx
      .insertInto("memberships")
      .values(
        memberships.map((membership) => ({
          merchant_id: liveId,
          mode: "live" as const,
          role: membership.role,
          user_id: membership.user_id
        }))
      )
      .execute();
  }

  const products = await trx
    .selectFrom("merchant_products")
    .selectAll()
    .where("merchant_id", "=", testMerchantId)
    .where("mode", "=", "test")
    .executeTakeFirst();

  await trx
    .insertInto("merchant_products")
    .values({
      airtime_enabled: products?.airtime_enabled ?? false,
      collections_enabled: products?.collections_enabled ?? false,
      merchant_id: liveId,
      mode: "live",
      payouts_enabled: products?.payouts_enabled ?? false,
      sms_api_enabled: products?.sms_api_enabled ?? false,
      sms_broadcast_enabled: products?.sms_broadcast_enabled ?? false,
      sms_enabled: products?.sms_enabled ?? false
    })
    .onConflict((conflict) =>
      conflict.columns(["merchant_id", "mode"]).doUpdateSet({
        airtime_enabled: products?.airtime_enabled ?? false,
        collections_enabled: products?.collections_enabled ?? false,
        payouts_enabled: products?.payouts_enabled ?? false,
        sms_api_enabled: products?.sms_api_enabled ?? false,
        sms_broadcast_enabled: products?.sms_broadcast_enabled ?? false,
        sms_enabled: products?.sms_enabled ?? false,
        updated_at: new Date()
      })
    )
    .execute();
}

export async function registerAdminPortalRoutes(app: FastifyTypedInstance) {
  app.get(
    "/overview",
    {
      schema: {
        response: {
          200: z.object({
            data: z.object({
              active_merchants: z.number().int(),
              channel_health: z.array(
                z.object({
                  channel_id: z.string(),
                  country_code: z.string(),
                  health: z.enum(["healthy", "degraded", "down"]),
                  kind: z.enum(["mobile_money", "card", "sms", "bank", "airtime"]),
                  mode: modeSchema,
                  network: z.string().nullable(),
                  provider_code: z.string(),
                  status: z.enum(["active", "disabled", "maintenance"])
                })
              ),
              airtime_volume_today_minor: z.number().int(),
              low_float_channels: z.array(
                z.object({
                  balance_minor: z.number().int().nullable(),
                  channel_id: z.string(),
                  country_code: z.string(),
                  currency: z.string().nullable(),
                  network: z.string().nullable(),
                  provider_code: z.string(),
                  status: z.enum(["ok", "low", "empty", "unknown"]),
                  threshold_minor: z.number().int().nullable()
                })
              ),
              open_exceptions: z.number().int(),
              platform_volume_today_minor: z.number().int(),
              success_rate_by_channel: z.array(
                z.object({
                  channel_id: z.string(),
                  provider_code: z.string(),
                  successful_count: z.number().int(),
                  total_count: z.number().int(),
                  success_rate: z.number()
                })
              )
            })
          })
        }
      }
    },
    async () => {
      const today = new Date().toISOString().slice(0, 10);

      const result = await runWithSystemScope(
        app.db,
        "load admin overview",
        async (trx) => {
          const [statsRows, activeMerchantsRow, openExceptionsRow, channels, collections, payouts, sms, airtimeToday, lowFloats] =
            await Promise.all([
              trx
                .selectFrom("merchant_daily_stats")
                .select([
                  "collections_amount_minor",
                  "payouts_amount_minor",
                  "sms_spend_minor"
                ])
                .where("stat_date", "=", new Date(`${today}T00:00:00.000Z`))
                .execute(),
              trx
                .selectFrom("merchants")
                .select((eb) => eb.fn.countAll<number>().as("count"))
                .where("status", "=", "active")
                .executeTakeFirstOrThrow(),
              trx
                .selectFrom("recon_exceptions")
                .select((eb) => eb.fn.countAll<number>().as("count"))
                .where("status", "=", "open")
                .executeTakeFirstOrThrow(),
              trx
                .selectFrom("channels")
                .select([
                  "id",
                  "country_code",
                  "health",
                  "kind",
                  "mode",
                  "network",
                  "provider_code",
                  "status"
                ])
                .orderBy("country_code")
                .orderBy("priority")
                .execute(),
              trx
                .selectFrom("collections")
                .select(["channel_id", "status"])
                .where("created_at", ">=", new Date(`${today}T00:00:00.000Z`))
                .where("channel_id", "is not", null)
                .execute(),
              trx
                .selectFrom("payouts")
                .select(["channel_id", "status"])
                .where("created_at", ">=", new Date(`${today}T00:00:00.000Z`))
                .where("channel_id", "is not", null)
                .execute(),
              trx
                .selectFrom("sms_messages")
                .select(["channel_id", "status"])
                .where("created_at", ">=", new Date(`${today}T00:00:00.000Z`))
                .where("channel_id", "is not", null)
                .execute(),
              trx
                .selectFrom("airtime_orders")
                .select(["channel_id", "charge_amount", "status"])
                .where("created_at", ">=", new Date(`${today}T00:00:00.000Z`))
                .execute(),
              trx
                .selectFrom("channels as channel")
                .innerJoin("airtime_channel_floats as float", "float.channel_id", "channel.id")
                .select([
                  "channel.country_code",
                  "channel.id",
                  "channel.network",
                  "channel.provider_code",
                  "float.balance_minor",
                  "float.currency",
                  "float.status",
                  "float.threshold_minor"
                ])
                .where("channel.kind", "=", "airtime")
                .where("float.status", "in", ["low", "empty"])
                .orderBy("channel.country_code")
                .execute()
            ]);

          return {
            activeMerchants: activeMerchantsRow.count,
            airtimeToday,
            channels,
            collections,
            lowFloats,
            openExceptions: openExceptionsRow.count,
            payouts,
            sms,
            statsRows
          };
        },
        { audit: false }
      );

      const platformVolumeTodayMinor = result.statsRows.reduce(
        (sum, row) =>
          sum +
          Number(row.collections_amount_minor) +
          Number(row.payouts_amount_minor) +
          Number(row.sms_spend_minor),
        0
      );

      const channelStats = new Map<
        string,
        {
          successful: number;
          total: number;
        }
      >();

      const record = (channelId: string | null, successful: boolean) => {
        if (!channelId) {
          return;
        }

        const current = channelStats.get(channelId) ?? { successful: 0, total: 0 };
        current.total += 1;
        if (successful) {
          current.successful += 1;
        }
        channelStats.set(channelId, current);
      };

      result.collections.forEach((row) => {
        record(row.channel_id, row.status === "successful");
      });
      result.payouts.forEach((row) => {
        record(row.channel_id, row.status === "successful");
      });
      result.sms.forEach((row) => {
        record(row.channel_id, row.status === "delivered");
      });
      result.airtimeToday.forEach((row) => {
        record(row.channel_id, row.status === "successful");
      });

      const airtimeVolumeTodayMinor = result.airtimeToday
        .filter((row) => row.status === "successful")
        .reduce((sum, row) => sum + Number(row.charge_amount), 0);

      return {
        data: {
          active_merchants: result.activeMerchants,
          airtime_volume_today_minor: airtimeVolumeTodayMinor,
          channel_health: result.channels.map((channel) => ({
            channel_id: channel.id,
            country_code: channel.country_code,
            health: channel.health,
            kind: channel.kind,
            mode: channel.mode,
            network: channel.network,
            provider_code: channel.provider_code,
            status: channel.status
          })),
          low_float_channels: result.lowFloats.map((row) => ({
            balance_minor: row.balance_minor === null ? null : Number(row.balance_minor),
            channel_id: row.id,
            country_code: row.country_code,
            currency: row.currency,
            network: row.network,
            provider_code: row.provider_code,
            status: row.status,
            threshold_minor: row.threshold_minor === null ? null : Number(row.threshold_minor)
          })),
          open_exceptions: result.openExceptions,
          platform_volume_today_minor: platformVolumeTodayMinor,
          success_rate_by_channel: result.channels.map((channel) => {
            const stat = channelStats.get(channel.id) ?? { successful: 0, total: 0 };
            return {
              channel_id: channel.id,
              provider_code: channel.provider_code,
              success_rate: stat.total === 0 ? 0 : stat.successful / stat.total,
              successful_count: stat.successful,
              total_count: stat.total
            };
          })
        }
      };
    }
  );

  app.get(
    "/merchants",
    {
      schema: {
        querystring: merchantsQuerySchema,
        response: {
          200: z.object({
            data: z.array(
              z.object({
                collections_frozen: z.boolean(),
                country_code: z.string(),
                created_at: z.string().datetime(),
                id: z.string(),
                mode: modeSchema,
                name: z.string(),
                payouts_frozen: z.boolean(),
                settlement_currency: z.string(),
                status: z.enum(["active", "closed", "pending_kyb", "suspended"]),
                today_volume_minor: z.number().int(),
                trading_name: z.string().nullable()
              })
            )
          })
        }
      }
    },
    async (request) => {
      const query = merchantsQuerySchema.parse(request.query);

      const result = await runWithSystemScope(
        app.db,
        "list admin merchants",
        async (trx) => {
          let merchantsQuery = trx
            .selectFrom("merchants")
            .select([
              "collections_frozen",
              "country_code",
              "created_at",
              "id",
              "legal_name",
              "mode",
              "payouts_frozen",
              "settlement_currency",
              "status",
              "trading_name"
            ]);

          if (query.country_code) {
            merchantsQuery = merchantsQuery.where(
              "country_code",
              "=",
              query.country_code.toUpperCase()
            );
          }

          if (query.mode) {
            merchantsQuery = merchantsQuery.where("mode", "=", query.mode);
          }

          if (query.status) {
            merchantsQuery = merchantsQuery.where("status", "=", query.status);
          }

          if (query.search) {
            const searchTerm = `%${query.search}%`;
            merchantsQuery = merchantsQuery.where((eb) =>
              eb.or([
                eb("id", "like", searchTerm),
                eb("legal_name", "like", searchTerm),
                eb("trading_name", "like", searchTerm)
              ])
            );
          }

          const merchants = await merchantsQuery
            .orderBy("created_at desc")
            .limit(query.limit)
            .execute();

          const todayStats = merchants.length
            ? await trx
                .selectFrom("merchant_daily_stats")
                .select(["merchant_id", "mode", "collections_amount_minor", "payouts_amount_minor", "sms_spend_minor"])
                .where(
                  "merchant_id",
                  "in",
                  merchants.map((merchant) => merchant.id)
                )
                .where("stat_date", "=", new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`))
                .execute()
            : [];

          return { merchants, todayStats };
        },
        { audit: false }
      );

      const volumeByMerchant = new Map<string, number>();
      result.todayStats.forEach((row) => {
        volumeByMerchant.set(
          `${row.mode}:${row.merchant_id}`,
          Number(row.collections_amount_minor) +
            Number(row.payouts_amount_minor) +
            Number(row.sms_spend_minor)
        );
      });

      return {
        data: result.merchants.map((merchant) => ({
          collections_frozen: merchant.collections_frozen,
          country_code: merchant.country_code,
          created_at: merchant.created_at.toISOString(),
          id: merchant.id,
          mode: merchant.mode,
          name: merchant.trading_name ?? merchant.legal_name,
          payouts_frozen: merchant.payouts_frozen,
          settlement_currency: merchant.settlement_currency,
          status: merchant.status,
          today_volume_minor:
            volumeByMerchant.get(`${merchant.mode}:${merchant.id}`) ?? 0,
          trading_name: merchant.trading_name
        }))
      };
    }
  );

  app.get(
    "/merchants/:merchantId",
    {
      schema: {
        params: merchantParamsSchema,
        querystring: modeQuerySchema,
        response: {
          200: z.object({
            data: z.object({
              collections_frozen: z.boolean(),
              compliance: z.object({
                collections_freeze_category: z.string().nullable(),
                contact_link: z.string(),
                kyb_tier: z.string(),
                payouts_freeze_category: z.string().nullable(),
                suspension_category: z.string().nullable(),
                suspension_reason: z.string().nullable()
              }),
              country_code: z.string(),
              created_at: z.string().datetime(),
              id: z.string(),
              legal_name: z.string(),
              mode: modeSchema,
              payouts_frozen: z.boolean(),
              products: z.object({
                airtime_enabled: z.boolean(),
                airtime_requested: z.boolean(),
                collections_enabled: z.boolean(),
                collections_requested: z.boolean(),
                payouts_enabled: z.boolean(),
                payouts_requested: z.boolean(),
                sms_api_enabled: z.boolean(),
                sms_broadcast_enabled: z.boolean(),
                sms_enabled: z.boolean(),
                sms_requested: z.boolean()
              }),
              settlement_currency: z.string(),
              status: z.enum(["active", "closed", "pending_kyb", "suspended"]),
              support_email: z.string().nullable(),
              support_phone: z.string().nullable(),
              timezone: z.string(),
              trading_name: z.string().nullable(),
              website: z.string().nullable()
            })
          })
        }
      }
    },
    async (request) => {
      const params = merchantParamsSchema.parse(request.params);
      const query = modeQuerySchema.parse(request.query);

      const result = await runWithSystemScope(
        app.db,
        "load admin merchant detail",
        async (trx) => {
          const merchant = await trx
            .selectFrom("merchants")
            .selectAll()
            .where("id", "=", params.merchantId)
            .where("mode", "=", query.mode)
            .executeTakeFirstOrThrow();

          const products = await trx
            .selectFrom("merchant_products")
            .selectAll()
            .where("merchant_id", "=", params.merchantId)
            .where("mode", "=", query.mode)
            .executeTakeFirst();

          const compliance = await trx
            .selectFrom("merchant_compliance_profiles")
            .selectAll()
            .where("merchant_id", "=", params.merchantId)
            .where("mode", "=", query.mode)
            .executeTakeFirst();

          return { compliance, merchant, products };
        },
        { audit: false }
      );

      return {
        data: {
          collections_frozen: result.merchant.collections_frozen,
          compliance: {
            collections_freeze_category:
              result.compliance?.collections_freeze_category ?? null,
            contact_link: result.compliance?.contact_link ?? "",
            kyb_tier: result.compliance?.kyb_tier ?? "tier_0",
            payouts_freeze_category:
              result.compliance?.payouts_freeze_category ?? null,
            suspension_category: result.compliance?.suspension_category ?? null,
            suspension_reason: result.compliance?.suspension_reason ?? null
          },
          country_code: result.merchant.country_code,
          created_at: result.merchant.created_at.toISOString(),
          id: result.merchant.id,
          legal_name: result.merchant.legal_name,
          mode: result.merchant.mode,
          payouts_frozen: result.merchant.payouts_frozen,
          products: {
            airtime_enabled: result.products?.airtime_enabled ?? false,
            airtime_requested: result.products?.airtime_requested ?? false,
            collections_enabled: result.products?.collections_enabled ?? true,
            collections_requested: result.products?.collections_requested ?? false,
            payouts_enabled: result.products?.payouts_enabled ?? true,
            payouts_requested: result.products?.payouts_requested ?? false,
            sms_api_enabled: result.products?.sms_api_enabled ?? false,
            sms_broadcast_enabled: result.products?.sms_broadcast_enabled ?? false,
            sms_enabled: result.products?.sms_enabled ?? true,
            sms_requested: result.products?.sms_requested ?? false
          },
          settlement_currency: result.merchant.settlement_currency,
          status: result.merchant.status,
          support_email: result.merchant.support_email,
          support_phone: result.merchant.support_phone,
          timezone: result.merchant.timezone,
          trading_name: result.merchant.trading_name,
          website: result.merchant.website
        }
      };
    }
  );

  app.get(
    "/merchants/:merchantId/kyb",
    {
      schema: {
        params: merchantParamsSchema,
        querystring: modeQuerySchema,
        response: {
          200: z.object({
            data: z.object({
              documents: z.array(
                z.object({
                  created_at: z.string().datetime(),
                  document_type: z.string(),
                  file_path: z.string(),
                  id: z.string(),
                  review_note: z.string().nullable(),
                  reviewer_id: z.string().nullable(),
                  status: z.enum(["approved", "pending", "rejected"]),
                  updated_at: z.string().datetime()
                })
              ),
              profile: z.object({
                business_registration_number: z.string().nullable(),
                registered_address: z.string().nullable(),
                review_note: z.string().nullable(),
                reviewer_id: z.string().nullable(),
                status: z.enum(["approved", "pending", "rejected"]),
                tax_id: z.string().nullable()
              }).nullable()
            })
          })
        }
      }
    },
    async (request) => {
      const params = merchantParamsSchema.parse(request.params);
      const query = modeQuerySchema.parse(request.query);

      const result = await runWithSystemScope(
        app.db,
        "load merchant kyb detail",
        async (trx) => {
          const profile = await trx
            .selectFrom("kyb_profiles")
            .selectAll()
            .where("merchant_id", "=", params.merchantId)
            .where("mode", "=", query.mode)
            .executeTakeFirst();

          const documents = await trx
            .selectFrom("kyb_documents")
            .selectAll()
            .where("merchant_id", "=", params.merchantId)
            .where("mode", "=", query.mode)
            .orderBy("created_at desc")
            .execute();

          return { documents, profile };
        },
        { audit: false }
      );

      return {
        data: {
          documents: result.documents.map((document) => ({
            created_at: document.created_at.toISOString(),
            document_type: document.document_type,
            file_path: document.file_path,
            id: document.id,
            review_note: document.review_note,
            reviewer_id: document.reviewer_id,
            status: document.status,
            updated_at: document.updated_at.toISOString()
          })),
          profile: result.profile
            ? {
                business_registration_number:
                  result.profile.business_registration_number,
                registered_address: result.profile.registered_address,
                review_note: result.profile.review_note,
                reviewer_id: result.profile.reviewer_id,
                status: serializeKybStatus(result.profile.status),
                tax_id: result.profile.tax_id
              }
            : null
        }
      };
    }
  );

  app.get(
    "/merchants/:merchantId/balances",
    {
      schema: {
        params: merchantParamsSchema,
        querystring: modeQuerySchema,
        response: {
          200: z.object({
            data: z.array(
              z.object({
                account_id: z.string(),
                balance_minor: z.number().int(),
                channel_id: z.string().nullable(),
                currency: z.string(),
                type: z.string()
              })
            )
          })
        }
      }
    },
    async (request) => {
      const params = merchantParamsSchema.parse(request.params);
      const query = modeQuerySchema.parse(request.query);

      const balances = await runWithSystemScope(
        app.db,
        "load merchant balances",
        async (trx) =>
          trx
            .selectFrom("ledger_accounts as account")
            .leftJoin("account_balances as balance", "balance.account_id", "account.id")
            .select([
              "account.channel_id",
              "account.currency",
              "account.id as account_id",
              "account.type",
              "balance.balance"
            ])
            .where("account.merchant_id", "=", params.merchantId)
            .where("account.mode", "=", query.mode)
            .orderBy("account.type")
            .execute(),
        { audit: false }
      );

      return {
        data: balances.map((row) => ({
          account_id: row.account_id,
          balance_minor: numberFromInt8(row.balance) ?? 0,
          channel_id: row.channel_id,
          currency: row.currency,
          type: row.type
        }))
      };
    }
  );

  app.get(
    "/merchants/:merchantId/collections",
    {
      schema: {
        params: merchantParamsSchema,
        querystring: modeQuerySchema.extend({
          limit: z.coerce.number().int().positive().max(100).default(20)
        }),
        response: {
          200: z.object({
            data: z.array(
              z.object({
                amount: z.number().int(),
                created_at: z.string().datetime(),
                currency: z.string(),
                id: z.string(),
                method: z.string(),
                phone: z.string().nullable(),
                provider_ref: z.string().nullable(),
                reference: z.string().nullable(),
                status: z.string()
              })
            )
          })
        }
      }
    },
    async (request) => {
      const params = merchantParamsSchema.parse(request.params);
      const query = modeQuerySchema.extend({
        limit: z.coerce.number().int().positive().max(100).default(20)
      }).parse(request.query);

      const rows = await runWithSystemScope(
        app.db,
        "list merchant collections for admin",
        async (trx) =>
          trx
            .selectFrom("collections")
            .select([
              "amount",
              "created_at",
              "currency",
              "id",
              "method",
              "phone",
              "provider_ref",
              "reference",
              "status"
            ])
            .where("merchant_id", "=", params.merchantId)
            .where("mode", "=", query.mode)
            .orderBy("created_at desc")
            .limit(query.limit)
            .execute(),
        { audit: false }
      );

      return {
        data: rows.map((row) => ({
          amount: Number(row.amount),
          created_at: row.created_at.toISOString(),
          currency: row.currency,
          id: row.id,
          method: row.method,
          phone: row.phone,
          provider_ref: row.provider_ref,
          reference: row.reference,
          status: row.status
        }))
      };
    }
  );

  app.get(
    "/merchants/:merchantId/payouts",
    {
      schema: {
        params: merchantParamsSchema,
        querystring: modeQuerySchema.extend({
          limit: z.coerce.number().int().positive().max(100).default(20)
        }),
        response: {
          200: z.object({
            data: z.array(
              z.object({
                amount: z.number().int(),
                created_at: z.string().datetime(),
                currency: z.string(),
                id: z.string(),
                method: z.string(),
                phone: z.string().nullable(),
                provider_ref: z.string().nullable(),
                reference: z.string().nullable(),
                status: z.string()
              })
            )
          })
        }
      }
    },
    async (request) => {
      const params = merchantParamsSchema.parse(request.params);
      const query = modeQuerySchema.extend({
        limit: z.coerce.number().int().positive().max(100).default(20)
      }).parse(request.query);

      const rows = await runWithSystemScope(
        app.db,
        "list merchant payouts for admin",
        async (trx) =>
          trx
            .selectFrom("payouts")
            .select([
              "amount",
              "created_at",
              "currency",
              "id",
              "method",
              "phone",
              "provider_ref",
              "reference",
              "status"
            ])
            .where("merchant_id", "=", params.merchantId)
            .where("mode", "=", query.mode)
            .orderBy("created_at desc")
            .limit(query.limit)
            .execute(),
        { audit: false }
      );

      return {
        data: rows.map((row) => ({
          amount: Number(row.amount),
          created_at: row.created_at.toISOString(),
          currency: row.currency,
          id: row.id,
          method: row.method,
          phone: row.phone,
          provider_ref: row.provider_ref,
          reference: row.reference,
          status: row.status
        }))
      };
    }
  );

  app.get(
    "/merchants/:merchantId/sms",
    {
      schema: {
        params: merchantParamsSchema,
        querystring: modeQuerySchema.extend({
          limit: z.coerce.number().int().positive().max(100).default(20)
        }),
        response: {
          200: z.object({
            data: z.array(
              z.object({
                created_at: z.string().datetime(),
                id: z.string(),
                price_minor: z.number().int(),
                recipient: z.string(),
                sender_id: z.string(),
                status: z.string(),
                type: z.string()
              })
            )
          })
        }
      }
    },
    async (request) => {
      const params = merchantParamsSchema.parse(request.params);
      const query = modeQuerySchema.extend({
        limit: z.coerce.number().int().positive().max(100).default(20)
      }).parse(request.query);

      const rows = await runWithSystemScope(
        app.db,
        "list merchant sms for admin",
        async (trx) =>
          trx
            .selectFrom("sms_messages")
            .select(["created_at", "id", "price_minor", "sender_id", "status", "to", "type"])
            .where("merchant_id", "=", params.merchantId)
            .where("mode", "=", query.mode)
            .orderBy("created_at desc")
            .limit(query.limit)
            .execute(),
        { audit: false }
      );

      return {
        data: rows.map((row) => ({
          created_at: row.created_at.toISOString(),
          id: row.id,
          price_minor: Number(row.price_minor),
          recipient: row.to,
          sender_id: row.sender_id,
          status: row.status,
          type: row.type
        }))
      };
    }
  );

  app.get(
    "/merchants/:merchantId/team",
    {
      schema: {
        params: merchantParamsSchema,
        querystring: modeQuerySchema,
        response: {
          200: z.object({
            data: z.array(
              z.object({
                email: z.string().nullable(),
                full_name: z.string().nullable(),
                role: z.string(),
                user_id: z.string()
              })
            )
          })
        }
      }
    },
    async (request) => {
      const params = merchantParamsSchema.parse(request.params);
      const query = modeQuerySchema.parse(request.query);

      const rows = await runWithSystemScope(
        app.db,
        "list merchant team for admin",
        async (trx) =>
          trx
            .selectFrom("memberships as membership")
            .leftJoin("profiles as profile", "profile.user_id", "membership.user_id")
            .leftJoin("auth.users as user", "user.id", "membership.user_id")
            .select([
              "membership.role",
              "membership.user_id",
              "profile.full_name",
              "user.email"
            ])
            .where("membership.merchant_id", "=", params.merchantId)
            .where("membership.mode", "=", query.mode)
            .orderBy("membership.created_at desc")
            .execute(),
        { audit: false }
      );

      return {
        data: rows.map((row) => ({
          email: row.email,
          full_name: row.full_name,
          role: row.role,
          user_id: row.user_id
        }))
      };
    }
  );

  app.get(
    "/merchants/:merchantId/freeze-history",
    {
      schema: {
        params: merchantParamsSchema,
        querystring: modeQuerySchema,
        response: {
          200: z.object({
            data: z.array(
              z.object({
                action: z.string(),
                actor_id: z.string().nullable(),
                created_at: z.string().datetime(),
                freeze_type: z.string(),
                id: z.string(),
                reason: z.string().nullable()
              })
            )
          })
        }
      }
    },
    async (request) => {
      const params = merchantParamsSchema.parse(request.params);
      const query = modeQuerySchema.parse(request.query);

      const rows = await runWithSystemScope(
        app.db,
        "list merchant freeze history",
        async (trx) =>
          trx
            .selectFrom("merchant_freeze_history")
            .selectAll()
            .where("merchant_id", "=", params.merchantId)
            .where("mode", "=", query.mode)
            .orderBy("created_at desc")
            .execute(),
        { audit: false }
      );

      return {
        data: rows.map((row) => ({
          action: row.action,
          actor_id: row.actor_id,
          created_at: row.created_at.toISOString(),
          freeze_type: row.freeze_type,
          id: row.id,
          reason: row.reason
        }))
      };
    }
  );

  app.get(
    "/merchants/:merchantId/audit",
    {
      schema: {
        params: merchantParamsSchema,
        querystring: modeQuerySchema.extend({
          limit: z.coerce.number().int().positive().max(100).default(50)
        }),
        response: {
          200: z.object({
            data: z.array(
              z.object({
                action: z.string(),
                actor_id: z.string(),
                actor_type: z.string(),
                created_at: z.string().datetime(),
                id: z.string(),
                reason: z.string().nullable(),
                target_id: z.string().nullable(),
                target_type: z.string()
              })
            )
          })
        }
      }
    },
    async (request) => {
      const params = merchantParamsSchema.parse(request.params);
      const query = modeQuerySchema.extend({
        limit: z.coerce.number().int().positive().max(100).default(50)
      }).parse(request.query);

      const rows = await runWithSystemScope(
        app.db,
        "list merchant audit logs",
        async (trx) =>
          trx
            .selectFrom("audit_logs")
            .select([
              "action",
              "actor_id",
              "actor_type",
              "created_at",
              "id",
              "reason",
              "target_id",
              "target_type"
            ])
            .where("merchant_id", "=", params.merchantId)
            .where("mode", "=", query.mode)
            .orderBy("created_at desc")
            .limit(query.limit)
            .execute(),
        { audit: false }
      );

      return {
        data: rows.map((row) => ({
          action: row.action,
          actor_id: row.actor_id,
          actor_type: row.actor_type,
          created_at: row.created_at.toISOString(),
          id: row.id,
          reason: row.reason,
          target_id: row.target_id,
          target_type: row.target_type
        }))
      };
    }
  );

  app.get(
    "/merchants/:merchantId/pricing",
    {
      schema: {
        params: merchantParamsSchema,
        querystring: modeQuerySchema,
        response: {
          200: z.object({
            data: z.object({
              default_fee_plans: z.array(
                z.object({
                  active: z.boolean(),
                  currency: z.string(),
                  fee_bearer: z.string(),
                  fixed_minor: z.number().int(),
                  id: z.string(),
                  kind: z.string(),
                  max_minor: z.number().int().nullable(),
                  method: z.string(),
                  min_minor: z.number().int(),
                  name: z.string(),
                  network: z.string().nullable(),
                  percent_bps: z.number().int()
                })
              ),
              merchant_overrides: z.array(
                z.object({
                  active: z.boolean(),
                  currency: z.string(),
                  fee_bearer: z.string(),
                  fixed_minor: z.number().int(),
                  id: z.string(),
                  kind: z.string(),
                  max_minor: z.number().int().nullable(),
                  method: z.string(),
                  min_minor: z.number().int(),
                  name: z.string(),
                  network: z.string().nullable(),
                  percent_bps: z.number().int()
                })
              )
            })
          })
        }
      }
    },
    async (request) => {
      const params = merchantParamsSchema.parse(request.params);
      const query = modeQuerySchema.parse(request.query);

      const result = await runWithSystemScope(
        app.db,
        "load merchant pricing admin detail",
        async (trx) => {
          const merchant = await trx
            .selectFrom("merchants")
            .select(["country_code", "settlement_currency"])
            .where("id", "=", params.merchantId)
            .where("mode", "=", query.mode)
            .executeTakeFirstOrThrow();

          const [plans, overrides] = await Promise.all([
            trx
              .selectFrom("fee_plans")
              .selectAll()
              .where("country_code", "=", merchant.country_code)
              .where("currency", "=", merchant.settlement_currency)
              .orderBy("kind")
              .orderBy("method")
              .execute(),
            trx
              .selectFrom("merchant_fee_overrides")
              .selectAll()
              .where("merchant_id", "=", params.merchantId)
              .where("mode", "=", query.mode)
              .orderBy("kind")
              .orderBy("method")
              .execute()
          ]);

          return { overrides, plans };
        },
        { audit: false }
      );

      return {
        data: {
          default_fee_plans: result.plans.map((row) => ({
            active: row.active,
            currency: row.currency,
            fee_bearer: row.fee_bearer,
            fixed_minor: Number(row.fixed_minor),
            id: row.id,
            kind: row.kind,
            max_minor: numberFromInt8(row.max_minor),
            method: row.method,
            min_minor: Number(row.min_minor),
            name: row.name,
            network: row.network,
            percent_bps: row.percent_bps
          })),
          merchant_overrides: result.overrides.map((row) => ({
            active: row.active,
            currency: row.currency,
            fee_bearer: row.fee_bearer,
            fixed_minor: Number(row.fixed_minor),
            id: row.id,
            kind: row.kind,
            max_minor: numberFromInt8(row.max_minor),
            method: row.method,
            min_minor: Number(row.min_minor),
            name: row.name,
            network: row.network,
            percent_bps: row.percent_bps
          }))
        }
      };
    }
  );

  app.get(
    "/kyb/review-queue",
    {
      schema: {
        querystring: kybQueueQuerySchema,
        response: {
          200: z.object({
            data: z.array(
              z.object({
                created_at: z.string().datetime(),
                merchant_id: z.string(),
                merchant_name: z.string(),
                mode: modeSchema,
                pending_document_count: z.number().int(),
                review_note: z.string().nullable(),
                status: z.enum(["approved", "pending", "rejected"]),
                updated_at: z.string().datetime()
              })
            )
          })
        }
      }
    },
    async (request) => {
      const query = kybQueueQuerySchema.parse(request.query);

      const result = await runWithSystemScope(
        app.db,
        "list kyb review queue",
        async (trx) => {
          let merchantQuery = trx
            .selectFrom("merchants as merchant")
            .leftJoin("kyb_profiles as profile", (join) =>
              join
                .onRef("profile.merchant_id", "=", "merchant.id")
                .onRef("profile.mode", "=", "merchant.mode")
            )
            .select([
              "merchant.created_at as merchant_created_at",
              "merchant.id as merchant_id",
              "merchant.legal_name",
              "merchant.mode",
              "merchant.trading_name",
              "merchant.updated_at as merchant_updated_at",
              "profile.created_at as profile_created_at",
              "profile.review_note",
              "profile.status as profile_status",
              "profile.updated_at as profile_updated_at"
            ]);

          if (query.mode) {
            merchantQuery = merchantQuery.where("merchant.mode", "=", query.mode);
          }

          if (query.status === "approved" || query.status === "rejected") {
            merchantQuery = merchantQuery.where("profile.status", "=", query.status);
          } else {
            merchantQuery = merchantQuery.where((expression) =>
              expression.or([
                expression("merchant.status", "=", "pending_kyb"),
                expression("profile.status", "=", "pending")
              ])
            );
          }

          const profiles = await merchantQuery
            .orderBy("merchant.updated_at", "desc")
            .limit(query.limit)
            .execute();

          const docs = profiles.length
            ? await trx
                .selectFrom("kyb_documents")
                .select(["merchant_id", "mode", "status"])
                .where(
                  "merchant_id",
                  "in",
                  profiles.map((profile) => profile.merchant_id)
                )
                .execute()
            : [];

          return { docs, profiles };
        },
        { audit: false }
      );

      const pendingDocs = new Map<string, number>();
      result.docs.forEach((document) => {
        if (document.status !== "pending") {
          return;
        }

        const key = `${document.mode}:${document.merchant_id}`;
        pendingDocs.set(key, (pendingDocs.get(key) ?? 0) + 1);
      });

      return {
        data: result.profiles.map((profile) => {
          const createdAt = profile.profile_created_at ?? profile.merchant_created_at;
          const updatedAt = profile.profile_updated_at ?? profile.merchant_updated_at;

          return {
            created_at: createdAt.toISOString(),
            merchant_id: profile.merchant_id,
            merchant_name: profile.trading_name ?? profile.legal_name,
            mode: profile.mode,
            pending_document_count:
              pendingDocs.get(`${profile.mode}:${profile.merchant_id}`) ?? 0,
            review_note: profile.review_note,
            status: serializeKybStatus(profile.profile_status ?? "pending"),
            updated_at: updatedAt.toISOString()
          };
        })
      };
    }
  );

  app.post(
    "/merchants/:merchantId/kyb/review",
    {
      schema: {
        body: kybReviewBodySchema,
        params: merchantParamsSchema,
        response: {
          200: z.object({
            data: z.object({
              review_note: z.string().nullable(),
              reviewer_id: z.string().nullable(),
              status: z.enum(["approved", "pending", "rejected"]),
              updated_at: z.string().datetime()
            })
          })
        }
      }
    },
    async (request) => {
      const params = merchantParamsSchema.parse(request.params);
      const body = kybReviewBodySchema.parse(request.body);

      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "merchant.kyb.review",
          actorId: request.platformAdmin!.userId,
          after: {
            merchant_id: params.merchantId,
            status: body.status
          } as Json,
          merchantId: params.merchantId,
          mode: body.mode,
          reason: body.reason,
          targetId: params.merchantId,
          targetType: "kyb_profile"
        },
        async (trx) => {
          const now = new Date();
          const existing = await trx
            .selectFrom("kyb_profiles")
            .select("id")
            .where("merchant_id", "=", params.merchantId)
            .where("mode", "=", body.mode)
            .executeTakeFirst();

          const profile = existing
            ? await trx
                .updateTable("kyb_profiles")
                .set({
                  review_note: body.review_note,
                  reviewer_id: request.platformAdmin!.userId,
                  status: body.status,
                  updated_at: now
                })
                .where("id", "=", existing.id)
                .returning(["review_note", "reviewer_id", "status", "updated_at"])
                .executeTakeFirstOrThrow()
            : await trx
                .insertInto("kyb_profiles")
                .values({
                  business_registration_number: null,
                  created_at: now,
                  id: newId("kyp_"),
                  merchant_id: params.merchantId,
                  mode: body.mode,
                  registered_address: null,
                  review_note: body.review_note,
                  reviewer_id: request.platformAdmin!.userId,
                  status: body.status,
                  tax_id: null,
                  updated_at: now
                })
                .returning(["review_note", "reviewer_id", "status", "updated_at"])
                .executeTakeFirstOrThrow();

          if (body.status === "approved") {
            await trx
              .updateTable("merchants")
              .set({
                status: "active",
                updated_at: now
              })
              .where("id", "=", params.merchantId)
              .where("mode", "=", body.mode)
              .execute();

            if (body.mode === "test") {
              await provisionLiveMerchant(trx, params.merchantId);
            }
          }

          return profile;
        }
      );

      return {
        data: {
          review_note: updated.review_note,
          reviewer_id: updated.reviewer_id,
          status: serializeKybStatus(updated.status),
          updated_at: updated.updated_at.toISOString()
        }
      };
    }
  );

  app.get(
    "/transactions/search",
    {
      schema: {
        querystring: transactionSearchQuerySchema,
        response: {
          200: z.object({
            data: z.array(
              z.object({
                amount_minor: z.number().int().nullable(),
                created_at: z.string().datetime(),
                id: z.string(),
                merchant_id: z.string(),
                mode: modeSchema,
                provider_ref: z.string().nullable(),
                reference: z.string().nullable(),
                resource_type: z.enum(["collection", "payout", "sms", "airtime"]),
                status: z.string()
              })
            )
          })
        }
      }
    },
    async (request) => {
      const query = transactionSearchQuerySchema.parse(request.query);
      const likeValue = `%${query.q}%`;

      const result = await runWithSystemScope(
        app.db,
        "search transactions for admin",
        async (trx) => {
          let collectionsQuery = trx
            .selectFrom("collections")
            .select([
              "amount",
              "created_at",
              "id",
              "merchant_id",
              "mode",
              "provider_ref",
              "reference",
              "status"
            ])
            .where((eb) =>
              eb.or([
                eb("id", "like", likeValue),
                eb("reference", "like", likeValue),
                eb("phone", "like", likeValue),
                eb("provider_ref", "like", likeValue)
              ])
            )
            .limit(query.limit);

          let payoutsQuery = trx
            .selectFrom("payouts")
            .select([
              "amount",
              "created_at",
              "id",
              "merchant_id",
              "mode",
              "provider_ref",
              "reference",
              "status"
            ])
            .where((eb) =>
              eb.or([
                eb("id", "like", likeValue),
                eb("reference", "like", likeValue),
                eb("phone", "like", likeValue),
                eb("provider_ref", "like", likeValue)
              ])
            )
            .limit(query.limit);

          let smsQuery = trx
            .selectFrom("sms_messages")
            .select([
              "created_at",
              "id",
              "merchant_id",
              "mode",
              "price_minor",
              "provider_ref",
              "reference",
              "status"
            ])
            .where((eb) =>
              eb.or([
                eb("id", "like", likeValue),
                eb("reference", "like", likeValue),
                eb("to", "like", likeValue),
                eb("provider_ref", "like", likeValue)
              ])
            )
            .limit(query.limit);

          let airtimeQuery = trx
            .selectFrom("airtime_orders")
            .select([
              "charge_amount",
              "created_at",
              "id",
              "merchant_id",
              "mode",
              "provider_ref",
              "reference",
              "status"
            ])
            .where((eb) =>
              eb.or([
                eb("id", "like", likeValue),
                eb("reference", "like", likeValue),
                eb("phone", "like", likeValue),
                eb("provider_ref", "like", likeValue)
              ])
            )
            .limit(query.limit);

          if (query.mode) {
            collectionsQuery = collectionsQuery.where("mode", "=", query.mode);
            payoutsQuery = payoutsQuery.where("mode", "=", query.mode);
            smsQuery = smsQuery.where("mode", "=", query.mode);
            airtimeQuery = airtimeQuery.where("mode", "=", query.mode);
          }

          const [collections, payouts, sms, airtime] = await Promise.all([
            collectionsQuery.execute(),
            payoutsQuery.execute(),
            smsQuery.execute(),
            airtimeQuery.execute()
          ]);

          return { airtime, collections, payouts, sms };
        },
        { audit: false }
      );

      const rows = [
        ...result.collections.map((row) => ({
          amount_minor: Number(row.amount),
          created_at: row.created_at.toISOString(),
          id: row.id,
          merchant_id: row.merchant_id,
          mode: row.mode,
          provider_ref: row.provider_ref,
          reference: row.reference,
          resource_type: "collection" as const,
          status: row.status
        })),
        ...result.payouts.map((row) => ({
          amount_minor: Number(row.amount),
          created_at: row.created_at.toISOString(),
          id: row.id,
          merchant_id: row.merchant_id,
          mode: row.mode,
          provider_ref: row.provider_ref,
          reference: row.reference,
          resource_type: "payout" as const,
          status: row.status
        })),
        ...result.sms.map((row) => ({
          amount_minor: Number(row.price_minor),
          created_at: row.created_at.toISOString(),
          id: row.id,
          merchant_id: row.merchant_id,
          mode: row.mode,
          provider_ref: row.provider_ref,
          reference: row.reference,
          resource_type: "sms" as const,
          status: row.status
        })),
        ...result.airtime.map((row) => ({
          amount_minor: Number(row.charge_amount),
          created_at: row.created_at.toISOString(),
          id: row.id,
          merchant_id: row.merchant_id,
          mode: row.mode,
          provider_ref: row.provider_ref,
          reference: row.reference,
          resource_type: "airtime" as const,
          status: row.status
        }))
      ]
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, query.limit);

      return { data: rows };
    }
  );

  app.put(
    "/merchants/:merchantId/products",
    {
      schema: {
        body: z.object({
          airtime_enabled: z.boolean(),
          collections_enabled: z.boolean(),
          mode: modeSchema,
          payouts_enabled: z.boolean(),
          reason: z.string().min(1),
          sms_api_enabled: z.boolean(),
          sms_broadcast_enabled: z.boolean()
        }),
        params: merchantParamsSchema,
        response: {
          200: z.object({
            data: z.object({
              updated: z.literal(true)
            })
          })
        }
      }
    },
    async (request) => {
      const params = merchantParamsSchema.parse(request.params);
      const body = z.object({
        airtime_enabled: z.boolean(),
        collections_enabled: z.boolean(),
        mode: modeSchema,
        payouts_enabled: z.boolean(),
        reason: z.string().min(1),
        sms_api_enabled: z.boolean(),
        sms_broadcast_enabled: z.boolean()
      }).parse(request.body);

      await runAdminSystemWrite(
        app.db,
        {
          action: "merchant.products.update",
          actorId: request.platformAdmin!.userId,
          merchantId: params.merchantId,
          mode: body.mode,
          reason: body.reason,
          targetId: params.merchantId,
          targetType: "merchant_products"
        },
        async (trx) => {
          const wantsSms = body.sms_api_enabled || body.sms_broadcast_enabled;
          await trx
            .insertInto("merchant_products")
            .values({
              airtime_enabled: body.airtime_enabled,
              collections_enabled: body.collections_enabled,
              merchant_id: params.merchantId,
              mode: body.mode,
              payouts_enabled: body.payouts_enabled,
              sms_api_enabled: body.sms_api_enabled,
              sms_broadcast_enabled: body.sms_broadcast_enabled,
              sms_enabled: wantsSms
            })
            .onConflict((conflict) =>
              conflict.columns(["merchant_id", "mode"]).doUpdateSet({
                airtime_enabled: body.airtime_enabled,
                airtime_requested: false,
                collections_enabled: body.collections_enabled,
                collections_requested: false,
                payouts_enabled: body.payouts_enabled,
                payouts_requested: false,
                sms_api_enabled: body.sms_api_enabled,
                sms_broadcast_enabled: body.sms_broadcast_enabled,
                sms_enabled: wantsSms,
                sms_requested: false,
                updated_at: new Date()
              })
            )
            .execute();

          return { updated: true as const };
        }
      );

      return { data: { updated: true as const } };
    }
  );

  app.put(
    "/merchants/:merchantId/limits",
    {
      schema: {
        body: z.object({
          collections_max_minor: z.number().int().positive(),
          mode: modeSchema,
          payouts_max_minor: z.number().int().positive(),
          reason: z.string().min(1)
        }),
        params: merchantParamsSchema,
        response: {
          200: z.object({
            data: z.object({ updated: z.literal(true) })
          })
        }
      }
    },
    async (request) => {
      const params = merchantParamsSchema.parse(request.params);
      const body = z.object({
        collections_max_minor: z.number().int().positive(),
        mode: modeSchema,
        payouts_max_minor: z.number().int().positive(),
        reason: z.string().min(1)
      }).parse(request.body);

      await runAdminSystemWrite(
        app.db,
        {
          action: "merchant.limits.update",
          actorId: request.platformAdmin!.userId,
          merchantId: params.merchantId,
          mode: body.mode,
          reason: body.reason,
          targetId: params.merchantId,
          targetType: "merchant_compliance_profile"
        },
        async (trx) => {
          const existing = await trx
            .selectFrom("merchant_compliance_profiles")
            .select("merchant_id")
            .where("merchant_id", "=", params.merchantId)
            .where("mode", "=", body.mode)
            .executeTakeFirst();

          if (existing) {
            await trx
              .updateTable("merchant_compliance_profiles")
              .set({
                collections_max_minor: BigInt(body.collections_max_minor),
                payouts_max_minor: BigInt(body.payouts_max_minor),
                updated_at: new Date()
              })
              .where("merchant_id", "=", params.merchantId)
              .where("mode", "=", body.mode)
              .execute();
          } else {
            await trx
              .insertInto("merchant_compliance_profiles")
              .values({
                collections_max_minor: BigInt(body.collections_max_minor),
                merchant_id: params.merchantId,
                mode: body.mode,
                payouts_max_minor: BigInt(body.payouts_max_minor)
              })
              .execute();
          }

          return { updated: true as const };
        }
      );

      return { data: { updated: true as const } };
    }
  );

  app.get(
    "/admin-users",
    {
      schema: {
        response: {
          200: z.object({
            data: z.array(
              z.object({
                active: z.boolean(),
                created_at: z.string().datetime(),
                email: z.string().nullable(),
                full_name: z.string().nullable(),
                role: z.enum(["super_admin", "compliance", "operations", "finance", "support"]),
                updated_at: z.string().datetime(),
                user_id: z.string()
              })
            )
          })
        }
      }
    },
    async () => {
      const rows = await runWithSystemScope(
        app.db,
        "list platform admins",
        async (trx) =>
          trx
            .selectFrom("platform_admins as admin")
            .leftJoin("auth.users as user", "user.id", "admin.user_id")
            .leftJoin("profiles as profile", "profile.user_id", "admin.user_id")
            .select([
              "admin.active",
              "admin.created_at",
              "admin.role",
              "admin.updated_at",
              "admin.user_id",
              "profile.full_name",
              "user.email"
            ])
            .orderBy("admin.created_at", "desc")
            .execute(),
        { audit: false }
      );

      return {
        data: rows.map((row) => ({
          active: row.active,
          created_at: row.created_at.toISOString(),
          email: row.email,
          full_name: row.full_name,
          role: row.role,
          updated_at: row.updated_at.toISOString(),
          user_id: row.user_id
        }))
      };
    }
  );

  app.post(
    "/admin-users",
    {
      schema: {
        body: z.object({
          email: z.string().email(),
          full_name: z.string().min(1),
          password: z.string().min(8),
          role: z.enum(["super_admin", "compliance", "operations", "finance", "support"])
        }),
        response: {
          201: z.object({
            data: z.object({
              user_id: z.string()
            })
          })
        }
      }
    },
    async (request, reply) => {
      const body = z.object({
        email: z.string().email(),
        full_name: z.string().min(1),
        password: z.string().min(8),
        role: z.enum(["super_admin", "compliance", "operations", "finance", "support"])
      }).parse(request.body);
      const supabase = createSupabaseServiceClient(app.appEnv);
      const created = await supabase.auth.admin.createUser({
        email: body.email,
        email_confirm: true,
        password: body.password,
        user_metadata: { full_name: body.full_name }
      });

      if (created.error || !created.data.user?.id) {
        throw new ApiRouteError({
          code: "validation_error",
          field: "email",
          message: created.error?.message ?? "Unable to create the admin user",
          statusCode: 400
        });
      }

      const userId = created.data.user.id;

      await runWithSystemScope(
        app.db,
        "create platform admin",
        async (trx) => {
          await trx
            .insertInto("profiles")
            .values({
              full_name: body.full_name,
              phone: null,
              user_id: userId
            })
            .onConflict((conflict) =>
              conflict.column("user_id").doUpdateSet({
                full_name: body.full_name
              })
            )
            .execute();

          await trx
            .insertInto("platform_admins")
            .values({
              active: true,
              role: body.role,
              user_id: userId
            })
            .onConflict((conflict) =>
              conflict.column("user_id").doUpdateSet({
                active: true,
                role: body.role,
                updated_at: new Date()
              })
            )
            .execute();
        },
        { audit: false }
      );

      return reply.status(201).send({ data: { user_id: userId } });
    }
  );

  app.get(
    "/audit-logs",
    {
      schema: {
        querystring: auditLogQuerySchema,
        response: {
          200: z.object({
            data: z.array(
              z.object({
                action: z.string(),
                actor_id: z.string(),
                actor_type: z.string(),
                created_at: z.string().datetime(),
                id: z.string(),
                merchant_id: z.string().nullable(),
                mode: modeSchema,
                reason: z.string().nullable(),
                target_id: z.string().nullable(),
                target_type: z.string()
              })
            )
          })
        }
      }
    },
    async (request) => {
      const query = auditLogQuerySchema.parse(request.query);
      const dateRange = toDateRange({
        endDate: query.end_date,
        startDate: query.start_date
      });

      const rows = await runWithSystemScope(
        app.db,
        "list audit logs for admin",
        async (trx) => {
          let auditQuery = trx
            .selectFrom("audit_logs")
            .select([
              "action",
              "actor_id",
              "actor_type",
              "created_at",
              "id",
              "merchant_id",
              "mode",
              "reason",
              "target_id",
              "target_type"
            ]);

          if (query.actor_id) {
            auditQuery = auditQuery.where("actor_id", "=", query.actor_id);
          }

          if (query.action) {
            auditQuery = auditQuery.where("action", "like", `%${query.action}%`);
          }

          if (query.merchant_id) {
            auditQuery = auditQuery.where("merchant_id", "=", query.merchant_id);
          }

          if (dateRange.startDate) {
            auditQuery = auditQuery.where("created_at", ">=", dateRange.startDate);
          }

          if (dateRange.endDate) {
            auditQuery = auditQuery.where("created_at", "<=", dateRange.endDate);
          }

          return auditQuery
            .orderBy("created_at desc")
            .limit(query.limit)
            .execute();
        },
        { audit: false }
      );

      return {
        data: rows.map((row) => ({
          action: row.action,
          actor_id: row.actor_id,
          actor_type: row.actor_type,
          created_at: row.created_at.toISOString(),
          id: row.id,
          merchant_id: row.merchant_id,
          mode: row.mode,
          reason: row.reason,
          target_id: row.target_id,
          target_type: row.target_type
        }))
      };
    }
  );
}
