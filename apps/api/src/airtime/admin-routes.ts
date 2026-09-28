import { newId } from "@richespay/shared";
import { z } from "zod";

import { runAdminSystemWrite } from "../auth/admin-access";
import { runWithSystemScope } from "../db";
import type { Json } from "../db/types";
import { ApiRouteError } from "../lib/api-error";
import { pricingCurrencies } from "../pricing/types";
import type { FastifyTypedInstance } from "../types";

import { airtimeFloatStatuses, airtimeOrderStatuses, defaultAirtimeLimits } from "./types";

const modeSchema = z.enum(["test", "live"]);
const reasonSchema = z.string().trim().min(1).max(500);

const networkResponseSchema = z.object({
  active: z.boolean(),
  country_code: z.string(),
  currency: z.string(),
  fixed_denominations: z.array(z.number().int()).nullable(),
  max_amount: z.number().int(),
  min_amount: z.number().int(),
  network: z.string(),
  updated_at: z.string().datetime()
});

const discountPlanResponseSchema = z.object({
  active: z.boolean(),
  country_code: z.string(),
  discount_bps: z.number().int(),
  id: z.string(),
  merchant_id: z.string().nullable(),
  mode: modeSchema.nullable(),
  network: z.string(),
  updated_at: z.string().datetime()
});

const floatResponseSchema = z.object({
  balance_minor: z.number().int().nullable(),
  channel_id: z.string(),
  checked_at: z.string().datetime().nullable(),
  country_code: z.string(),
  currency: z.string().nullable(),
  network: z.string().nullable(),
  provider_code: z.string(),
  status: z.enum(airtimeFloatStatuses),
  threshold_minor: z.number().int().nullable()
});

const limitsResponseSchema = z.object({
  merchant_daily_cap_minor: z.number().int(),
  merchant_id: z.string(),
  mode: modeSchema,
  number_daily_cap_minor: z.number().int(),
  uses_defaults: z.boolean(),
  velocity_per_number: z.number().int()
});

const orderResponseSchema = z.object({
  amount: z.number().int(),
  charge_amount: z.number().int(),
  charge_currency: z.string(),
  country_code: z.string(),
  created_at: z.string().datetime(),
  currency: z.string(),
  id: z.string(),
  merchant_id: z.string(),
  mode: modeSchema,
  network: z.string(),
  phone: z.string(),
  provider_ref: z.string().nullable(),
  reference: z.string().nullable(),
  status: z.enum(airtimeOrderStatuses)
});

const floatHistoryResponseSchema = z.object({
  balance_minor: z.number().int().nullable(),
  channel_id: z.string(),
  checked_at: z.string().datetime(),
  currency: z.string().nullable(),
  id: z.string(),
  status: z.enum(airtimeFloatStatuses),
  threshold_minor: z.number().int()
});

const spendResponseSchema = z.object({
  month_charge_minor: z.number().int(),
  month_count: z.number().int(),
  today_charge_minor: z.number().int(),
  today_count: z.number().int(),
  today_successful_count: z.number().int()
});

export async function registerAirtimeAdminRoutes(app: FastifyTypedInstance) {
  app.get(
    "/airtime/networks",
    {
      schema: {
        querystring: z.object({ country_code: z.string().length(2).optional() }),
        response: { 200: z.object({ data: z.array(networkResponseSchema) }) }
      }
    },
    async (request) => {
      const rows = await runWithSystemScope(
        app.db,
        "admin list airtime networks",
        async (trx) => {
          let query = trx
            .selectFrom("airtime_networks")
            .selectAll()
            .orderBy("country_code")
            .orderBy("network");
          if (request.query.country_code) {
            query = query.where("country_code", "=", request.query.country_code.toUpperCase());
          }
          return query.execute();
        },
        { audit: false }
      );

      return { data: rows.map(serializeNetwork) };
    }
  );

  app.put(
    "/airtime/networks/:countryCode/:network",
    {
      schema: {
        body: z
          .object({
            active: z.boolean(),
            currency: z.enum(pricingCurrencies),
            fixed_denominations: z.array(z.number().int().positive()).max(50).nullable().default(null),
            max_amount: z.number().int().positive(),
            min_amount: z.number().int().positive(),
            reason: reasonSchema
          })
          .refine((body) => body.min_amount <= body.max_amount, {
            message: "min_amount must not exceed max_amount.",
            path: ["min_amount"]
          }),
        params: z.object({
          countryCode: z.string().length(2),
          network: z.string().trim().min(1).max(32)
        }),
        response: { 200: z.object({ data: networkResponseSchema }) }
      }
    },
    async (request) => {
      const countryCode = request.params.countryCode.toUpperCase();
      const network = request.params.network.toUpperCase();
      const body = request.body;
      const values = {
        active: body.active,
        currency: body.currency,
        fixed_denominations: body.fixed_denominations,
        max_minor: String(body.max_amount),
        min_minor: String(body.min_amount)
      };

      const row = await runAdminSystemWrite(
        app.db,
        {
          action: "airtime.network_updated",
          actorId: request.platformAdmin!.userId,
          after: { ...values, country_code: countryCode, network },
          ip: request.ip,
          reason: body.reason,
          targetId: `${countryCode}:${network}`,
          targetType: "airtime_network",
          userAgent: request.headers["user-agent"]?.toString() ?? null
        },
        async (trx) =>
          trx
            .insertInto("airtime_networks")
            .values({ ...values, country_code: countryCode, network })
            .onConflict((conflict) => conflict.columns(["country_code", "network"]).doUpdateSet(values))
            .returningAll()
            .executeTakeFirstOrThrow()
      );

      return { data: serializeNetwork(row) };
    }
  );

  app.get(
    "/airtime/discount-plans",
    {
      schema: {
        querystring: z.object({
          merchant_id: z.string().min(1).optional(),
          scope: z.enum(["defaults", "overrides", "all"]).default("defaults")
        }),
        response: { 200: z.object({ data: z.array(discountPlanResponseSchema) }) }
      }
    },
    async (request) => {
      const rows = await runWithSystemScope(
        app.db,
        "admin list airtime discount plans",
        async (trx) => {
          let query = trx
            .selectFrom("airtime_discount_plans")
            .selectAll()
            .orderBy("country_code")
            .orderBy("network");
          if (request.query.merchant_id) {
            query = query.where("merchant_id", "=", request.query.merchant_id);
          } else if (request.query.scope === "overrides") {
            query = query.where("merchant_id", "is not", null);
          } else if (request.query.scope === "defaults") {
            query = query.where("merchant_id", "is", null);
          }
          return query.execute();
        },
        { audit: false }
      );

      return { data: rows.map(serializeDiscountPlan) };
    }
  );

  app.put(
    "/airtime/discount-plans",
    {
      schema: {
        body: z
          .object({
            active: z.boolean().default(true),
            country_code: z.string().length(2),
            discount_bps: z.number().int().min(0).max(5000),
            merchant_id: z.string().min(1).nullable().default(null),
            mode: modeSchema.nullable().default(null),
            network: z.string().trim().min(1).max(32),
            reason: reasonSchema
          })
          .refine((body) => (body.merchant_id === null) === (body.mode === null), {
            message: "merchant_id and mode must be set together.",
            path: ["mode"]
          }),
        response: { 200: z.object({ data: discountPlanResponseSchema }) }
      }
    },
    async (request) => {
      const body = request.body;
      const countryCode = body.country_code.toUpperCase();
      const network = body.network.toUpperCase();

      const row = await runAdminSystemWrite(
        app.db,
        {
          action: "airtime.discount_plan_updated",
          actorId: request.platformAdmin!.userId,
          after: {
            active: body.active,
            country_code: countryCode,
            discount_bps: body.discount_bps,
            merchant_id: body.merchant_id,
            mode: body.mode,
            network
          },
          ip: request.ip,
          merchantId: body.merchant_id,
          ...(body.mode ? { mode: body.mode } : {}),
          reason: body.reason,
          targetId: `${body.merchant_id ?? "default"}:${countryCode}:${network}`,
          targetType: "airtime_discount_plan",
          userAgent: request.headers["user-agent"]?.toString() ?? null
        },
        async (trx) => {
          let existingQuery = trx
            .selectFrom("airtime_discount_plans")
            .select("id")
            .where("country_code", "=", countryCode)
            .where("network", "=", network);
          existingQuery =
            body.merchant_id && body.mode
              ? existingQuery.where("merchant_id", "=", body.merchant_id).where("mode", "=", body.mode)
              : existingQuery.where("merchant_id", "is", null).where("mode", "is", null);
          const existing = await existingQuery.executeTakeFirst();

          if (existing) {
            return trx
              .updateTable("airtime_discount_plans")
              .set({ active: body.active, discount_bps: body.discount_bps })
              .where("id", "=", existing.id)
              .returningAll()
              .executeTakeFirstOrThrow();
          }

          return trx
            .insertInto("airtime_discount_plans")
            .values({
              active: body.active,
              country_code: countryCode,
              discount_bps: body.discount_bps,
              id: newId("adp_"),
              merchant_id: body.merchant_id,
              mode: body.mode,
              network
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        }
      );

      return { data: serializeDiscountPlan(row) };
    }
  );

  app.get(
    "/airtime/floats",
    {
      schema: {
        response: { 200: z.object({ data: z.array(floatResponseSchema) }) }
      }
    },
    async () => {
      const rows = await runWithSystemScope(
        app.db,
        "admin list airtime floats",
        async (trx) =>
          trx
            .selectFrom("channels as channel")
            .leftJoin("airtime_channel_floats as float", "float.channel_id", "channel.id")
            .select([
              "channel.country_code",
              "channel.id",
              "channel.network",
              "channel.provider_code",
              "float.balance_minor",
              "float.checked_at",
              "float.currency",
              "float.status",
              "float.threshold_minor"
            ])
            .where("channel.kind", "=", "airtime")
            .orderBy("channel.country_code")
            .orderBy("channel.priority")
            .execute(),
        { audit: false }
      );

      return {
        data: rows.map((row) => ({
          balance_minor: row.balance_minor === null ? null : Number(row.balance_minor),
          channel_id: row.id,
          checked_at: row.checked_at ? new Date(row.checked_at).toISOString() : null,
          country_code: row.country_code,
          currency: row.currency,
          network: row.network,
          provider_code: row.provider_code,
          status: row.status ?? "unknown",
          threshold_minor: row.threshold_minor === null ? null : Number(row.threshold_minor)
        }))
      };
    }
  );

  app.get(
    "/airtime/floats/:channelId/history",
    {
      schema: {
        params: z.object({ channelId: z.string().min(1) }),
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(200).default(48)
        }),
        response: { 200: z.object({ data: z.array(floatHistoryResponseSchema) }) }
      }
    },
    async (request) => {
      const rows = await runWithSystemScope(
        app.db,
        "admin list airtime float history",
        async (trx) =>
          trx
            .selectFrom("airtime_channel_float_history")
            .selectAll()
            .where("channel_id", "=", request.params.channelId)
            .orderBy("checked_at desc")
            .limit(request.query.limit)
            .execute(),
        { audit: false }
      );

      return {
        data: rows
          .map((row) => ({
            balance_minor: row.balance_minor === null ? null : Number(row.balance_minor),
            channel_id: row.channel_id,
            checked_at: new Date(row.checked_at).toISOString(),
            currency: row.currency,
            id: row.id,
            status: row.status,
            threshold_minor: Number(row.threshold_minor)
          }))
          .reverse()
      };
    }
  );

  app.put(
    "/airtime/floats/:channelId",
    {
      schema: {
        body: z.object({
          reason: reasonSchema,
          threshold_minor: z.number().int().positive()
        }),
        params: z.object({ channelId: z.string().min(1) }),
        response: { 200: z.object({ data: floatResponseSchema }) }
      }
    },
    async (request) => {
      const channelId = request.params.channelId;
      const thresholdMinor = request.body.threshold_minor;

      const row = await runAdminSystemWrite(
        app.db,
        {
          action: "airtime.float_threshold_updated",
          actorId: request.platformAdmin!.userId,
          after: { channel_id: channelId, threshold_minor: thresholdMinor },
          ip: request.ip,
          reason: request.body.reason,
          targetId: channelId,
          targetType: "channel",
          userAgent: request.headers["user-agent"]?.toString() ?? null
        },
        async (trx) => {
          const channel = await trx
            .selectFrom("channels")
            .select(["config", "id"])
            .where("id", "=", channelId)
            .where("kind", "=", "airtime")
            .executeTakeFirst();

          if (!channel) {
            throw new ApiRouteError({
              code: "not_found",
              message: "Airtime channel not found.",
              statusCode: 404
            });
          }

          const nextConfig = {
            ...(isJsonObject(channel.config) ? channel.config : {}),
            float_low_minor: thresholdMinor
          } as Json;

          await trx.updateTable("channels").set({ config: nextConfig }).where("id", "=", channelId).execute();

          const current = await trx
            .selectFrom("airtime_channel_floats")
            .select(["balance_minor", "currency", "status"])
            .where("channel_id", "=", channelId)
            .executeTakeFirst();

          const status =
            current?.balance_minor === null || current?.balance_minor === undefined
              ? current?.status ?? "unknown"
              : classifyStoredFloat(Number(current.balance_minor), thresholdMinor);

          await trx
            .insertInto("airtime_channel_floats")
            .values({
              balance_minor: current?.balance_minor ?? null,
              channel_id: channelId,
              checked_at: new Date(),
              currency: current?.currency ?? null,
              status,
              threshold_minor: String(thresholdMinor)
            })
            .onConflict((conflict) =>
              conflict.column("channel_id").doUpdateSet({
                status,
                threshold_minor: String(thresholdMinor)
              })
            )
            .execute();

          return trx
            .selectFrom("channels as channel")
            .leftJoin("airtime_channel_floats as float", "float.channel_id", "channel.id")
            .select([
              "channel.country_code",
              "channel.id",
              "channel.network",
              "channel.provider_code",
              "float.balance_minor",
              "float.checked_at",
              "float.currency",
              "float.status",
              "float.threshold_minor"
            ])
            .where("channel.id", "=", channelId)
            .executeTakeFirstOrThrow();
        }
      );

      return {
        data: {
          balance_minor: row.balance_minor === null ? null : Number(row.balance_minor),
          channel_id: row.id,
          checked_at: row.checked_at ? new Date(row.checked_at).toISOString() : null,
          country_code: row.country_code,
          currency: row.currency,
          network: row.network,
          provider_code: row.provider_code,
          status: row.status ?? "unknown",
          threshold_minor: row.threshold_minor === null ? null : Number(row.threshold_minor)
        }
      };
    }
  );

  app.get(
    "/airtime/orders",
    {
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(100).default(50),
          merchant_id: z.string().min(1).optional(),
          mode: modeSchema.optional(),
          q: z.string().min(1).optional()
        }),
        response: { 200: z.object({ data: z.array(orderResponseSchema) }) }
      }
    },
    async (request) => {
      const query = request.query;
      const rows = await runWithSystemScope(
        app.db,
        "admin search airtime orders",
        async (trx) => {
          let list = trx
            .selectFrom("airtime_orders")
            .select([
              "amount",
              "charge_amount",
              "charge_currency",
              "country_code",
              "created_at",
              "currency",
              "id",
              "merchant_id",
              "mode",
              "network",
              "phone",
              "provider_ref",
              "reference",
              "status"
            ])
            .orderBy("created_at desc")
            .limit(query.limit);

          if (query.merchant_id) {
            list = list.where("merchant_id", "=", query.merchant_id);
          }
          if (query.mode) {
            list = list.where("mode", "=", query.mode);
          }
          if (query.q) {
            const likeValue = `%${query.q}%`;
            list = list.where((eb) =>
              eb.or([
                eb("id", "like", likeValue),
                eb("phone", "like", likeValue),
                eb("reference", "like", likeValue),
                eb("provider_ref", "like", likeValue)
              ])
            );
          }

          return list.execute();
        },
        { audit: false }
      );

      return { data: rows.map(serializeOrder) };
    }
  );

  app.get(
    "/merchants/:merchantId/airtime",
    {
      schema: {
        params: z.object({ merchantId: z.string().min(1) }),
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(100).default(20),
          mode: modeSchema.default("live")
        }),
        response: {
          200: z.object({
            data: z.object({
              orders: z.array(orderResponseSchema),
              spend: spendResponseSchema
            })
          })
        }
      }
    },
    async (request) => {
      const merchantId = request.params.merchantId;
      const mode = request.query.mode;
      const todayStart = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      const monthStart = new Date(Date.UTC(todayStart.getUTCFullYear(), todayStart.getUTCMonth(), 1));

      const result = await runWithSystemScope(
        app.db,
        "admin load merchant airtime",
        async (trx) => {
          const [orders, todayRows, monthRows] = await Promise.all([
            trx
              .selectFrom("airtime_orders")
              .select([
                "amount",
                "charge_amount",
                "charge_currency",
                "country_code",
                "created_at",
                "currency",
                "id",
                "merchant_id",
                "mode",
                "network",
                "phone",
                "provider_ref",
                "reference",
                "status"
              ])
              .where("merchant_id", "=", merchantId)
              .where("mode", "=", mode)
              .orderBy("created_at desc")
              .limit(request.query.limit)
              .execute(),
            trx
              .selectFrom("airtime_orders")
              .select(["charge_amount", "status"])
              .where("merchant_id", "=", merchantId)
              .where("mode", "=", mode)
              .where("created_at", ">=", todayStart)
              .execute(),
            trx
              .selectFrom("airtime_orders")
              .select(["charge_amount", "status"])
              .where("merchant_id", "=", merchantId)
              .where("mode", "=", mode)
              .where("created_at", ">=", monthStart)
              .execute()
          ]);

          return { monthRows, orders, todayRows };
        },
        { audit: false }
      );

      return {
        data: {
          orders: result.orders.map(serializeOrder),
          spend: serializeSpend(result.todayRows, result.monthRows)
        }
      };
    }
  );

  app.get(
    "/merchants/:merchantId/airtime-limits",
    {
      schema: {
        params: z.object({ merchantId: z.string().min(1) }),
        querystring: z.object({ mode: modeSchema.default("live") }),
        response: { 200: z.object({ data: limitsResponseSchema }) }
      }
    },
    async (request) => {
      const row = await runWithSystemScope(
        app.db,
        "admin read airtime limits",
        async (trx) =>
          trx
            .selectFrom("merchant_compliance_profiles")
            .select([
              "airtime_merchant_daily_cap_minor",
              "airtime_number_daily_cap_minor",
              "airtime_velocity_per_number"
            ])
            .where("merchant_id", "=", request.params.merchantId)
            .where("mode", "=", request.query.mode)
            .executeTakeFirst(),
        { audit: false }
      );

      return { data: serializeLimits(request.params.merchantId, request.query.mode, row) };
    }
  );

  app.put(
    "/merchants/:merchantId/airtime-limits",
    {
      schema: {
        body: z.object({
          merchant_daily_cap_minor: z.number().int().positive().nullable(),
          mode: modeSchema,
          number_daily_cap_minor: z.number().int().positive().nullable(),
          reason: reasonSchema,
          velocity_per_number: z.number().int().min(1).max(1000)
        }),
        params: z.object({ merchantId: z.string().min(1) }),
        response: { 200: z.object({ data: limitsResponseSchema }) }
      }
    },
    async (request) => {
      const body = request.body;
      const merchantId = request.params.merchantId;
      const values = {
        airtime_merchant_daily_cap_minor:
          body.merchant_daily_cap_minor === null ? null : String(body.merchant_daily_cap_minor),
        airtime_number_daily_cap_minor:
          body.number_daily_cap_minor === null ? null : String(body.number_daily_cap_minor),
        airtime_velocity_per_number: body.velocity_per_number
      };

      const row = await runAdminSystemWrite(
        app.db,
        {
          action: "airtime.limits_updated",
          actorId: request.platformAdmin!.userId,
          after: values,
          ip: request.ip,
          merchantId,
          mode: body.mode,
          reason: body.reason,
          targetId: merchantId,
          targetType: "merchant",
          userAgent: request.headers["user-agent"]?.toString() ?? null
        },
        async (trx) =>
          trx
            .insertInto("merchant_compliance_profiles")
            .values({ ...values, merchant_id: merchantId, mode: body.mode })
            .onConflict((conflict) => conflict.columns(["merchant_id", "mode"]).doUpdateSet(values))
            .returning([
              "airtime_merchant_daily_cap_minor",
              "airtime_number_daily_cap_minor",
              "airtime_velocity_per_number"
            ])
            .executeTakeFirstOrThrow()
      );

      return { data: serializeLimits(merchantId, body.mode, row) };
    }
  );
}

function serializeNetwork(row: {
  active: boolean;
  country_code: string;
  currency: string;
  fixed_denominations: number[] | null;
  max_minor: string | number | bigint;
  min_minor: string | number | bigint;
  network: string;
  updated_at: Date | string;
}) {
  return {
    active: row.active,
    country_code: row.country_code,
    currency: row.currency,
    fixed_denominations: row.fixed_denominations,
    max_amount: Number(row.max_minor),
    min_amount: Number(row.min_minor),
    network: row.network,
    updated_at: new Date(row.updated_at).toISOString()
  };
}

function serializeDiscountPlan(row: {
  active: boolean;
  country_code: string;
  discount_bps: number;
  id: string;
  merchant_id: string | null;
  mode: "live" | "test" | null;
  network: string;
  updated_at: Date | string;
}) {
  return {
    active: row.active,
    country_code: row.country_code,
    discount_bps: row.discount_bps,
    id: row.id,
    merchant_id: row.merchant_id,
    mode: row.mode,
    network: row.network,
    updated_at: new Date(row.updated_at).toISOString()
  };
}

function serializeLimits(
  merchantId: string,
  mode: "live" | "test",
  row:
    | {
        airtime_merchant_daily_cap_minor: string | number | bigint | null;
        airtime_number_daily_cap_minor: string | number | bigint | null;
        airtime_velocity_per_number: number;
      }
    | undefined
) {
  return {
    merchant_daily_cap_minor: Number(
      row?.airtime_merchant_daily_cap_minor ?? defaultAirtimeLimits.merchantDailyCapMinor
    ),
    merchant_id: merchantId,
    mode,
    number_daily_cap_minor: Number(
      row?.airtime_number_daily_cap_minor ?? defaultAirtimeLimits.numberDailyCapMinor
    ),
    uses_defaults:
      !row ||
      (row.airtime_merchant_daily_cap_minor === null && row.airtime_number_daily_cap_minor === null),
    velocity_per_number: row?.airtime_velocity_per_number ?? defaultAirtimeLimits.velocityPerNumber
  };
}

function serializeOrder(row: {
  amount: string | number | bigint;
  charge_amount: string | number | bigint;
  charge_currency: string;
  country_code: string;
  created_at: Date | string;
  currency: string;
  id: string;
  merchant_id: string;
  mode: "live" | "test";
  network: string;
  phone: string;
  provider_ref: string | null;
  reference: string | null;
  status: (typeof airtimeOrderStatuses)[number];
}) {
  return {
    amount: Number(row.amount),
    charge_amount: Number(row.charge_amount),
    charge_currency: row.charge_currency,
    country_code: row.country_code,
    created_at: new Date(row.created_at).toISOString(),
    currency: row.currency,
    id: row.id,
    merchant_id: row.merchant_id,
    mode: row.mode,
    network: row.network,
    phone: row.phone,
    provider_ref: row.provider_ref,
    reference: row.reference,
    status: row.status
  };
}

function serializeSpend(
  todayRows: Array<{ charge_amount: string | number | bigint; status: string }>,
  monthRows: Array<{ charge_amount: string | number | bigint; status: string }>
) {
  const successfulToday = todayRows.filter((row) => row.status === "successful");
  const successfulMonth = monthRows.filter((row) => row.status === "successful");

  return {
    month_charge_minor: successfulMonth.reduce((sum, row) => sum + Number(row.charge_amount), 0),
    month_count: monthRows.length,
    today_charge_minor: successfulToday.reduce((sum, row) => sum + Number(row.charge_amount), 0),
    today_count: todayRows.length,
    today_successful_count: successfulToday.length
  };
}

function classifyStoredFloat(balanceMinor: number, thresholdMinor: number) {
  if (balanceMinor <= 0) {
    return "empty" as const;
  }

  return balanceMinor < thresholdMinor ? ("low" as const) : ("ok" as const);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
