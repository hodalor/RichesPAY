import { z } from "zod";

import type { FastifyTypedInstance } from "../types";
import { pricingCurrencies } from "../pricing/types";

import { TopupService } from "./service";
import type { MerchantBalanceAlertThresholdRecord, TopupRecord } from "./types";

const topupMethods = ["mobile_money", "card", "bank_transfer"] as const;
const topupStatuses = ["pending", "successful", "failed", "expired"] as const;

const nextActionSchema = z
  .object({
    iframe_url: z.string().url().optional(),
    type: z.enum(["hosted_fields", "redirect_url"]),
    url: z.string().url().optional()
  })
  .nullable();

const topupResponseSchema = z.object({
  amount: z.number().int(),
  bank_reference: z.string().nullable(),
  collection_id: z.string().nullable(),
  completed_at: z.string().datetime().nullable(),
  confirmed_by: z.string().nullable(),
  created_at: z.string().datetime(),
  currency: z.enum(pricingCurrencies),
  fee_minor: z.number().int(),
  id: z.string(),
  method: z.enum(topupMethods),
  next_action: nextActionSchema,
  provider_ref: z.string().nullable(),
  status: z.enum(topupStatuses)
});

const thresholdResponseSchema = z.object({
  created_at: z.string().datetime(),
  currency: z.enum(pricingCurrencies),
  is_below_threshold: z.boolean(),
  threshold_minor: z.number().int(),
  updated_at: z.string().datetime()
});

export async function registerTopupDashboardRoutes(app: FastifyTypedInstance) {
  const topupService = new TopupService({
    database: app.db,
    encryptionKey: app.appEnv.ENCRYPTION_KEY
  });

  app.get(
    "/topups/settings",
    {
      schema: {
        response: {
          200: z.object({
            data: z.object({
              thresholds: z.array(thresholdResponseSchema),
              transfer_reference: z.string()
            })
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("topups.manage");

      const settings = await topupService.getSettings(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode
      );

      return {
        data: {
          thresholds: settings.thresholds.map(serializeThreshold),
          transfer_reference: settings.transferReference
        }
      };
    }
  );

  app.put(
    "/topups/alerts/:currency",
    {
      schema: {
        body: z.object({
          threshold_minor: z.coerce.number().int().min(0)
        }),
        params: z.object({
          currency: z.enum(pricingCurrencies)
        }),
        response: {
          200: z.object({
            data: thresholdResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("topups.manage");

      const threshold = await topupService.upsertThreshold({
        currency: request.params.currency,
        merchantId: request.dashboardMembership!.merchantId,
        mode: request.dashboardMembership!.mode,
        thresholdMinor: BigInt(request.body.threshold_minor)
      });

      return {
        data: serializeThreshold(threshold)
      };
    }
  );

  app.post(
    "/topups",
    {
      schema: {
        body: z.object({
          amount: z.coerce.number().int().positive(),
          currency: z.enum(pricingCurrencies),
          method: z.enum(topupMethods),
          network: z.string().min(1).optional(),
          phone: z.string().min(4).optional()
        }),
        response: {
          201: z.object({
            data: topupResponseSchema
          })
        }
      }
    },
    async (request, reply) => {
      request.assertDashboardPermission("topups.manage");
      const body = request.body;

      const topup =
        body.method === "bank_transfer"
          ? await topupService.createBankTransferTopup({
              amountMinor: BigInt(body.amount),
              currency: body.currency,
              merchantId: request.dashboardMembership!.merchantId,
              mode: request.dashboardMembership!.mode
            })
          : await topupService.createPaymentTopup({
              amountMinor: BigInt(body.amount),
              currency: body.currency,
              merchantId: request.dashboardMembership!.merchantId,
              method: body.method,
              mode: request.dashboardMembership!.mode,
              ...(body.network ? { network: body.network } : {}),
              ...(body.phone ? { phone: body.phone } : {}),
              requestId: request.id
            });

      return reply.status(201).send({
        data: serializeTopup(topup)
      });
    }
  );

  app.post(
    "/topups/test-funds",
    {
      schema: {
        body: z.object({
          amount: z.coerce.number().int().positive(),
          currency: z.enum(pricingCurrencies)
        }),
        response: {
          201: z.object({
            data: topupResponseSchema
          })
        }
      }
    },
    async (request, reply) => {
      request.assertDashboardPermission("topups.manage");

      const topup = await topupService.addTestFunds({
        actorId: request.dashboardMembership!.userId,
        amountMinor: BigInt(request.body.amount),
        currency: request.body.currency,
        merchantId: request.dashboardMembership!.merchantId,
        mode: request.dashboardMembership!.mode
      });

      return reply.status(201).send({
        data: serializeTopup(topup)
      });
    }
  );

  app.get(
    "/topups",
    {
      schema: {
        querystring: z.object({
          created_gte: z.string().datetime().optional(),
          created_lte: z.string().datetime().optional(),
          limit: z.coerce.number().int().positive().max(100).default(20),
          method: z.enum(topupMethods).optional(),
          starting_after: z.string().min(1).optional(),
          status: z.enum(topupStatuses).optional()
        }),
        response: {
          200: z.object({
            data: z.array(topupResponseSchema),
            meta: z.object({
              next_starting_after: z.string().nullable()
            })
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("topups.manage");

      const page = await topupService.list(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode,
        {
          ...(request.query.created_gte
            ? { createdGte: new Date(request.query.created_gte) }
            : {}),
          ...(request.query.created_lte
            ? { createdLte: new Date(request.query.created_lte) }
            : {}),
          ...(request.query.method ? { method: request.query.method } : {}),
          ...(request.query.starting_after
            ? { startingAfter: request.query.starting_after }
            : {}),
          ...(request.query.status ? { status: request.query.status } : {})
        },
        request.query.limit
      );

      return {
        data: page.items.map(serializeTopup),
        meta: {
          next_starting_after: page.nextStartingAfter
        }
      };
    }
  );

  app.get(
    "/topups/:topupId",
    {
      schema: {
        params: z.object({
          topupId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: topupResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("topups.manage");

      const topup = await topupService.getById(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode,
        request.params.topupId
      );

      return {
        data: serializeTopup(topup)
      };
    }
  );
}

function serializeTopup(topup: TopupRecord) {
  return {
    amount: Number(topup.amount),
    bank_reference: topup.bankReference,
    collection_id: topup.collectionId,
    completed_at: topup.completedAt?.toISOString() ?? null,
    confirmed_by: topup.confirmedBy,
    created_at: topup.createdAt.toISOString(),
    currency: topup.currency,
    fee_minor: Number(topup.feeMinor),
    id: topup.id,
    method: topup.method,
    next_action:
      topup.nextAction === null
        ? null
        : topup.nextAction.type === "hosted_fields"
          ? {
              iframe_url: topup.nextAction.iframeUrl,
              type: topup.nextAction.type
            }
          : {
              type: topup.nextAction.type,
              url: topup.nextAction.url
            },
    provider_ref: topup.providerRef,
    status: topup.status
  };
}

function serializeThreshold(threshold: MerchantBalanceAlertThresholdRecord) {
  return {
    created_at: threshold.createdAt.toISOString(),
    currency: threshold.currency,
    is_below_threshold: threshold.isBelowThreshold,
    threshold_minor: Number(threshold.thresholdMinor),
    updated_at: threshold.updatedAt.toISOString()
  };
}
