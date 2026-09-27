import { z } from "zod";

import { getClientIp, runAdminSystemWrite } from "../auth/admin-access";
import { ComplianceService } from "./service";
import { complianceReasonCategories, kybTiers } from "./types";
import { ApiRouteError } from "../lib/api-error";

import type { MerchantComplianceSummary } from "./types";
import type { FastifyTypedInstance } from "../types";

const merchantParamsSchema = z.object({
  merchantId: z.string().min(1)
});

const modeSchema = z.enum(["test", "live"]);

const mutationBodySchema = z.object({
  mode: modeSchema,
  reason: z.string().min(1),
  category: z.enum(complianceReasonCategories).optional()
});

const complianceProfileBodySchema = z.object({
  collections_daily_volume_minor: z.coerce.number().int().nonnegative().nullable().optional(),
  collections_max_minor: z.coerce.number().int().nonnegative().optional(),
  collections_min_minor: z.coerce.number().int().nonnegative().optional(),
  collections_monthly_volume_minor: z.coerce.number().int().nonnegative().nullable().optional(),
  contact_link: z.string().min(1).optional(),
  kyb_tier: z.enum(kybTiers).optional(),
  mode: modeSchema,
  payouts_daily_volume_minor: z.coerce.number().int().nonnegative().nullable().optional(),
  payouts_max_minor: z.coerce.number().int().nonnegative().optional(),
  payouts_min_minor: z.coerce.number().int().nonnegative().optional(),
  payouts_monthly_volume_minor: z.coerce.number().int().nonnegative().nullable().optional(),
  reason: z.string().min(1),
  rolling_reserve_bps: z.coerce.number().int().min(0).max(10_000).optional(),
  rolling_reserve_days: z.coerce.number().int().min(0).optional(),
  screening_payout_threshold_minor: z.coerce.number().int().nonnegative().nullable().optional(),
  velocity_collections_per_phone: z.coerce.number().int().positive().optional(),
  velocity_window_minutes: z.coerce.number().int().positive().optional()
});

const reviewFlagsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  merchant_id: z.string().min(1).optional(),
  mode: modeSchema.optional(),
  status: z.enum(["open", "resolved", "dismissed"]).optional()
});

const summaryResponseSchema = z.object({
  data: z.object({
    collections_freeze_category: z.enum(complianceReasonCategories).nullable(),
    collections_freeze_reason: z.string().nullable(),
    collections_frozen: z.boolean(),
    contact_link: z.string(),
    kyb_tier: z.enum(kybTiers),
    limits: z.object({
      collection: z.object({
        daily_volume_minor: z.number().int().nullable(),
        max_minor: z.number().int(),
        min_minor: z.number().int(),
        monthly_volume_minor: z.number().int().nullable()
      }),
      payout: z.object({
        daily_volume_minor: z.number().int().nullable(),
        max_minor: z.number().int(),
        min_minor: z.number().int(),
        monthly_volume_minor: z.number().int().nullable()
      })
    }),
    merchant_id: z.string(),
    mode: modeSchema,
    payouts_freeze_category: z.enum(complianceReasonCategories).nullable(),
    payouts_freeze_reason: z.string().nullable(),
    payouts_frozen: z.boolean(),
    rolling_reserve_bps: z.number().int(),
    rolling_reserve_days: z.number().int(),
    screening_payout_threshold_minor: z.number().int().nullable(),
    settlement_currency: z.enum(["GHS", "USD", "ZMW"]),
    status: z.string(),
    suspension_category: z.enum(complianceReasonCategories).nullable(),
    suspension_reason: z.string().nullable(),
    velocity_collections_per_phone: z.number().int(),
    velocity_window_minutes: z.number().int()
  })
});

const reviewFlagResponseSchema = z.object({
  data: z.array(
    z.object({
      created_at: z.string().datetime(),
      id: z.string(),
      merchant_id: z.string(),
      mode: modeSchema,
      payload: z.record(z.string(), z.unknown()).or(z.array(z.unknown())).or(z.string()).or(z.number()).or(z.boolean()).nullable(),
      resource_id: z.string(),
      resource_type: z.string(),
      reviewed_at: z.string().datetime().nullable(),
      reviewed_by: z.string().nullable(),
      rule_code: z.string(),
      status: z.enum(["open", "resolved", "dismissed"]),
      summary: z.string()
    })
  )
});

export async function registerComplianceAdminRoutes(app: FastifyTypedInstance) {
  const complianceService = new ComplianceService({
    database: app.db
  });

  app.get(
    "/merchants/:merchantId/compliance",
    {
      schema: {
        params: merchantParamsSchema,
        querystring: z.object({
          mode: modeSchema
        }),
        response: {
          200: summaryResponseSchema
        }
      }
    },
    async (request) => {
      assertComplianceRole(request.platformAdmin!.role);
      const params = merchantParamsSchema.parse(request.params);
      const query = z.object({ mode: modeSchema }).parse(request.query);

      const summary = await complianceService.getMerchantSummary(params.merchantId, query.mode);
      return {
        data: serializeSummary(summary)
      };
    }
  );

  app.put(
    "/merchants/:merchantId/compliance",
    {
      schema: {
        body: complianceProfileBodySchema,
        params: merchantParamsSchema,
        response: {
          200: summaryResponseSchema
        }
      }
    },
    async (request) => {
      assertComplianceRole(request.platformAdmin!.role);
      const params = merchantParamsSchema.parse(request.params);
      const body = complianceProfileBodySchema.parse(request.body);
      const before = await complianceService.getMerchantSummary(params.merchantId, body.mode);

      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "merchant.compliance_profile.update",
          actorId: request.platformAdmin!.userId,
          auditFromResult: (result: MerchantComplianceSummary) => ({
            after: serializeSummary(result),
            before: serializeSummary(before),
            merchantId: result.merchantId,
            mode: result.mode,
            targetId: result.merchantId
          }),
          ip: getClientIp(request.headers as Record<string, unknown>, request.ip),
          merchantId: params.merchantId,
          mode: body.mode,
          reason: body.reason,
          targetId: params.merchantId,
          targetType: "merchant",
          userAgent: request.headers["user-agent"] ?? null
        },
        async (trx) =>
          complianceService.updateComplianceProfile(trx, {
            ...(body.collections_daily_volume_minor !== undefined
              ? { collectionsDailyVolumeMinor: body.collections_daily_volume_minor === null ? null : BigInt(body.collections_daily_volume_minor) }
              : {}),
            ...(body.collections_max_minor !== undefined
              ? { collectionsMaxMinor: BigInt(body.collections_max_minor) }
              : {}),
            ...(body.collections_min_minor !== undefined
              ? { collectionsMinMinor: BigInt(body.collections_min_minor) }
              : {}),
            ...(body.collections_monthly_volume_minor !== undefined
              ? { collectionsMonthlyVolumeMinor: body.collections_monthly_volume_minor === null ? null : BigInt(body.collections_monthly_volume_minor) }
              : {}),
            ...(body.contact_link !== undefined ? { contactLink: body.contact_link } : {}),
            ...(body.kyb_tier !== undefined ? { kybTier: body.kyb_tier } : {}),
            merchantId: params.merchantId,
            mode: body.mode,
            ...(body.payouts_daily_volume_minor !== undefined
              ? { payoutsDailyVolumeMinor: body.payouts_daily_volume_minor === null ? null : BigInt(body.payouts_daily_volume_minor) }
              : {}),
            ...(body.payouts_max_minor !== undefined
              ? { payoutsMaxMinor: BigInt(body.payouts_max_minor) }
              : {}),
            ...(body.payouts_min_minor !== undefined
              ? { payoutsMinMinor: BigInt(body.payouts_min_minor) }
              : {}),
            ...(body.payouts_monthly_volume_minor !== undefined
              ? { payoutsMonthlyVolumeMinor: body.payouts_monthly_volume_minor === null ? null : BigInt(body.payouts_monthly_volume_minor) }
              : {}),
            ...(body.rolling_reserve_bps !== undefined
              ? { rollingReserveBps: body.rolling_reserve_bps }
              : {}),
            ...(body.rolling_reserve_days !== undefined
              ? { rollingReserveDays: body.rolling_reserve_days }
              : {}),
            ...(body.screening_payout_threshold_minor !== undefined
              ? {
                  screeningPayoutThresholdMinor:
                    body.screening_payout_threshold_minor === null
                      ? null
                      : BigInt(body.screening_payout_threshold_minor)
                }
              : {}),
            ...(body.velocity_collections_per_phone !== undefined
              ? {
                  velocityCollectionsPerPhone: body.velocity_collections_per_phone
                }
              : {}),
            ...(body.velocity_window_minutes !== undefined
              ? { velocityWindowMinutes: body.velocity_window_minutes }
              : {})
          })
      );

      return {
        data: serializeSummary(updated)
      };
    }
  );

  app.post(
    "/merchants/:merchantId/collections/freeze",
    {
      schema: {
        body: mutationBodySchema.extend({
          category: z.enum(complianceReasonCategories)
        }),
        params: merchantParamsSchema,
        response: {
          200: summaryResponseSchema
        }
      }
    },
    async (request) => {
      assertComplianceRole(request.platformAdmin!.role);
      const params = merchantParamsSchema.parse(request.params);
      const body = mutationBodySchema.extend({
        category: z.enum(complianceReasonCategories)
      }).parse(request.body);
      const before = await complianceService.getMerchantSummary(params.merchantId, body.mode);

      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "merchant.collections.freeze",
          actorId: request.platformAdmin!.userId,
          auditFromResult: (result: MerchantComplianceSummary) => ({
            after: serializeSummary(result),
            before: serializeSummary(before),
            merchantId: result.merchantId,
            mode: result.mode,
            targetId: result.merchantId
          }),
          ip: getClientIp(request.headers as Record<string, unknown>, request.ip),
          merchantId: params.merchantId,
          mode: body.mode,
          reason: body.reason,
          targetId: params.merchantId,
          targetType: "merchant",
          userAgent: request.headers["user-agent"] ?? null
        },
        async (trx) =>
          complianceService.freezeCollections(trx, {
            actorId: request.platformAdmin!.userId,
            category: body.category,
            merchantId: params.merchantId,
            mode: body.mode,
            reason: body.reason
          })
      );

      return { data: serializeSummary(updated) };
    }
  );

  app.post(
    "/merchants/:merchantId/collections/unfreeze",
    {
      schema: {
        body: mutationBodySchema,
        params: merchantParamsSchema,
        response: {
          200: summaryResponseSchema
        }
      }
    },
    async (request) => {
      assertComplianceRole(request.platformAdmin!.role);
      const params = merchantParamsSchema.parse(request.params);
      const body = mutationBodySchema.parse(request.body);
      const before = await complianceService.getMerchantSummary(params.merchantId, body.mode);

      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "merchant.collections.unfreeze",
          actorId: request.platformAdmin!.userId,
          auditFromResult: (result: MerchantComplianceSummary) => ({
            after: serializeSummary(result),
            before: serializeSummary(before),
            merchantId: result.merchantId,
            mode: result.mode,
            targetId: result.merchantId
          }),
          ip: getClientIp(request.headers as Record<string, unknown>, request.ip),
          merchantId: params.merchantId,
          mode: body.mode,
          reason: body.reason,
          targetId: params.merchantId,
          targetType: "merchant",
          userAgent: request.headers["user-agent"] ?? null
        },
        async (trx) =>
          complianceService.unfreezeCollections(trx, {
            actorId: request.platformAdmin!.userId,
            merchantId: params.merchantId,
            mode: body.mode,
            reason: body.reason
          })
      );

      return { data: serializeSummary(updated) };
    }
  );

  app.post(
    "/merchants/:merchantId/payouts/freeze",
    {
      schema: {
        body: mutationBodySchema.extend({
          category: z.enum(complianceReasonCategories)
        }),
        params: merchantParamsSchema,
        response: {
          200: summaryResponseSchema
        }
      }
    },
    async (request) => {
      assertComplianceRole(request.platformAdmin!.role);
      const params = merchantParamsSchema.parse(request.params);
      const body = mutationBodySchema.extend({
        category: z.enum(complianceReasonCategories)
      }).parse(request.body);
      const before = await complianceService.getMerchantSummary(params.merchantId, body.mode);

      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "merchant.payouts.freeze",
          actorId: request.platformAdmin!.userId,
          auditFromResult: (result: MerchantComplianceSummary) => ({
            after: serializeSummary(result),
            before: serializeSummary(before),
            merchantId: result.merchantId,
            mode: result.mode,
            targetId: result.merchantId
          }),
          ip: getClientIp(request.headers as Record<string, unknown>, request.ip),
          merchantId: params.merchantId,
          mode: body.mode,
          reason: body.reason,
          targetId: params.merchantId,
          targetType: "merchant",
          userAgent: request.headers["user-agent"] ?? null
        },
        async (trx) =>
          complianceService.freezePayouts(trx, {
            actorId: request.platformAdmin!.userId,
            category: body.category,
            merchantId: params.merchantId,
            mode: body.mode,
            reason: body.reason
          })
      );

      return { data: serializeSummary(updated) };
    }
  );

  app.post(
    "/merchants/:merchantId/payouts/unfreeze",
    {
      schema: {
        body: mutationBodySchema,
        params: merchantParamsSchema,
        response: {
          200: summaryResponseSchema
        }
      }
    },
    async (request) => {
      assertComplianceRole(request.platformAdmin!.role);
      const params = merchantParamsSchema.parse(request.params);
      const body = mutationBodySchema.parse(request.body);
      const before = await complianceService.getMerchantSummary(params.merchantId, body.mode);

      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "merchant.payouts.unfreeze",
          actorId: request.platformAdmin!.userId,
          auditFromResult: (result: MerchantComplianceSummary) => ({
            after: serializeSummary(result),
            before: serializeSummary(before),
            merchantId: result.merchantId,
            mode: result.mode,
            targetId: result.merchantId
          }),
          ip: getClientIp(request.headers as Record<string, unknown>, request.ip),
          merchantId: params.merchantId,
          mode: body.mode,
          reason: body.reason,
          targetId: params.merchantId,
          targetType: "merchant",
          userAgent: request.headers["user-agent"] ?? null
        },
        async (trx) =>
          complianceService.unfreezePayouts(trx, {
            actorId: request.platformAdmin!.userId,
            merchantId: params.merchantId,
            mode: body.mode,
            reason: body.reason
          })
      );

      return { data: serializeSummary(updated) };
    }
  );

  app.post(
    "/merchants/:merchantId/suspend",
    {
      schema: {
        body: mutationBodySchema.extend({
          category: z.enum(complianceReasonCategories)
        }),
        params: merchantParamsSchema,
        response: {
          200: summaryResponseSchema
        }
      }
    },
    async (request) => {
      assertComplianceRole(request.platformAdmin!.role);
      const params = merchantParamsSchema.parse(request.params);
      const body = mutationBodySchema.extend({
        category: z.enum(complianceReasonCategories)
      }).parse(request.body);
      const before = await complianceService.getMerchantSummary(params.merchantId, body.mode);

      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "merchant.suspend",
          actorId: request.platformAdmin!.userId,
          auditFromResult: (result: MerchantComplianceSummary) => ({
            after: serializeSummary(result),
            before: serializeSummary(before),
            merchantId: result.merchantId,
            mode: result.mode,
            targetId: result.merchantId
          }),
          ip: getClientIp(request.headers as Record<string, unknown>, request.ip),
          merchantId: params.merchantId,
          mode: body.mode,
          reason: body.reason,
          targetId: params.merchantId,
          targetType: "merchant",
          userAgent: request.headers["user-agent"] ?? null
        },
        async (trx) =>
          complianceService.suspendMerchant(trx, {
            actorId: request.platformAdmin!.userId,
            category: body.category,
            merchantId: params.merchantId,
            mode: body.mode,
            reason: body.reason
          })
      );

      return { data: serializeSummary(updated) };
    }
  );

  app.post(
    "/merchants/:merchantId/reactivate",
    {
      schema: {
        body: mutationBodySchema,
        params: merchantParamsSchema,
        response: {
          200: summaryResponseSchema
        }
      }
    },
    async (request) => {
      assertComplianceRole(request.platformAdmin!.role);
      const params = merchantParamsSchema.parse(request.params);
      const body = mutationBodySchema.parse(request.body);
      const before = await complianceService.getMerchantSummary(params.merchantId, body.mode);

      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "merchant.reactivate",
          actorId: request.platformAdmin!.userId,
          auditFromResult: (result: MerchantComplianceSummary) => ({
            after: serializeSummary(result),
            before: serializeSummary(before),
            merchantId: result.merchantId,
            mode: result.mode,
            targetId: result.merchantId
          }),
          ip: getClientIp(request.headers as Record<string, unknown>, request.ip),
          merchantId: params.merchantId,
          mode: body.mode,
          reason: body.reason,
          targetId: params.merchantId,
          targetType: "merchant",
          userAgent: request.headers["user-agent"] ?? null
        },
        async (trx) =>
          complianceService.reactivateMerchant(trx, {
            merchantId: params.merchantId,
            mode: body.mode,
            reason: body.reason
          })
      );

      return { data: serializeSummary(updated) };
    }
  );

  app.get(
    "/compliance/review-flags",
    {
      schema: {
        querystring: reviewFlagsQuerySchema,
        response: {
          200: reviewFlagResponseSchema
        }
      }
    },
    async (request) => {
      assertComplianceRole(request.platformAdmin!.role);
      const query = reviewFlagsQuerySchema.parse(request.query);
      const flags = await complianceService.listReviewFlags({
        limit: query.limit,
        ...(query.merchant_id ? { merchantId: query.merchant_id } : {}),
        ...(query.mode ? { mode: query.mode } : {}),
        ...(query.status ? { status: query.status } : {})
      });

      return {
        data: flags.map((flag) => ({
          created_at: flag.createdAt.toISOString(),
          id: flag.id,
          merchant_id: flag.merchantId,
          mode: flag.mode,
          payload: flag.payload,
          resource_id: flag.resourceId,
          resource_type: flag.resourceType,
          reviewed_at: flag.reviewedAt?.toISOString() ?? null,
          reviewed_by: flag.reviewedBy,
          rule_code: flag.ruleCode,
          status: flag.status,
          summary: flag.summary
        }))
      };
    }
  );
}

function assertComplianceRole(role: string) {
  if (role !== "super_admin" && role !== "compliance") {
    throw new ApiRouteError({
      code: "forbidden",
      message: "Compliance or super admin access is required for this action.",
      statusCode: 403
    });
  }
}

function serializeSummary(summary: MerchantComplianceSummary) {
  return {
    collections_freeze_category: summary.collectionsFreezeCategory,
    collections_freeze_reason: summary.collectionsFreezeReason,
    collections_frozen: summary.collectionsFrozen,
    contact_link: summary.contactLink,
    kyb_tier: summary.kybTier,
    limits: {
      collection: {
        daily_volume_minor: summary.limits.collection.dailyVolumeMinor === null ? null : Number(summary.limits.collection.dailyVolumeMinor),
        max_minor: Number(summary.limits.collection.maxMinor),
        min_minor: Number(summary.limits.collection.minMinor),
        monthly_volume_minor: summary.limits.collection.monthlyVolumeMinor === null ? null : Number(summary.limits.collection.monthlyVolumeMinor)
      },
      payout: {
        daily_volume_minor: summary.limits.payout.dailyVolumeMinor === null ? null : Number(summary.limits.payout.dailyVolumeMinor),
        max_minor: Number(summary.limits.payout.maxMinor),
        min_minor: Number(summary.limits.payout.minMinor),
        monthly_volume_minor: summary.limits.payout.monthlyVolumeMinor === null ? null : Number(summary.limits.payout.monthlyVolumeMinor)
      }
    },
    merchant_id: summary.merchantId,
    mode: summary.mode,
    payouts_freeze_category: summary.payoutsFreezeCategory,
    payouts_freeze_reason: summary.payoutsFreezeReason,
    payouts_frozen: summary.payoutsFrozen,
    rolling_reserve_bps: summary.rollingReserveBps,
    rolling_reserve_days: summary.rollingReserveDays,
    screening_payout_threshold_minor:
      summary.screeningPayoutThresholdMinor === null
        ? null
        : Number(summary.screeningPayoutThresholdMinor),
    settlement_currency: summary.settlementCurrency,
    status: summary.status,
    suspension_category: summary.suspensionCategory,
    suspension_reason: summary.suspensionReason,
    velocity_collections_per_phone: summary.velocityCollectionsPerPhone,
    velocity_window_minutes: summary.velocityWindowMinutes
  };
}
