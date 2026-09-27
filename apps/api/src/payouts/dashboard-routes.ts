import { z } from "zod";

import { ApiRouteError } from "../lib/api-error";
import { pricingCurrencies } from "../pricing/types";
import type { FastifyTypedInstance } from "../types";

import { PayoutService } from "./service";
import type { PayoutBatchRecord, PayoutRecord } from "./types";

const payoutStatuses = [
  "pending_approval",
  "queued",
  "on_hold",
  "processing",
  "successful",
  "failed",
  "reversed",
  "cancelled"
] as const;
const payoutBatchStatuses = [
  "pending_approval",
  "queued",
  "on_hold",
  "processing",
  "completed",
  "failed",
  "cancelled"
] as const;

const metadataSchema = z.record(z.string(), z.unknown()).default({});

const payoutResponseSchema = z.object({
  account_name: z.string().nullable(),
  account_number: z.string().nullable(),
  amount: z.number().int(),
  approved_by: z.string().nullable(),
  bank_code: z.string().nullable(),
  batch_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  completed_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  created_by: z.string(),
  currency: z.enum(pricingCurrencies),
  failure_code: z.string().nullable(),
  failure_message: z.string().nullable(),
  fee_minor: z.number().int(),
  id: z.string(),
  metadata: metadataSchema,
  method: z.enum(["mobile_money", "bank"]),
  narration: z.string().nullable(),
  network: z.string().nullable(),
  phone: z.string().nullable(),
  provider_ref: z.string().nullable(),
  reference: z.string().nullable(),
  send_attempts: z.number().int(),
  status: z.enum(payoutStatuses),
  status_check_attempts: z.number().int(),
  total_hold_minor: z.number().int()
});

const payoutBatchResponseSchema = z.object({
  approved_by: z.string().nullable(),
  completed_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  created_by: z.string(),
  currency: z.enum(pricingCurrencies),
  id: z.string(),
  item_count: z.number().int(),
  metadata: metadataSchema,
  payouts: z.array(payoutResponseSchema),
  reference: z.string().nullable(),
  status: z.enum(payoutBatchStatuses),
  total_amount: z.number().int(),
  total_fee_minor: z.number().int(),
  total_hold_minor: z.number().int(),
  validation_report: z.object({
    invalid_count: z.number().int(),
    rows: z.array(
      z.object({
        errors: z.array(z.string()),
        index: z.number().int()
      })
    ),
    valid_count: z.number().int()
  })
});

export async function registerPayoutDashboardRoutes(app: FastifyTypedInstance) {
  const payoutService = new PayoutService({
    database: app.db
  });

  app.get(
    "/payout-batches/template.csv",
    {
      schema: {
        hide: true
      }
    },
    async (request, reply) => {
      request.assertDashboardPermission("payouts.create");

      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", "attachment; filename=\"richespay-payout-batch-template.csv\"");

      return [
        "reference,amount,method,phone,network,bank_code,account_number,account_name,narration",
        "payroll-001,150000,mobile_money,+233201234001,mtn_momo,,,,September payroll",
        "vendor-001,275000,bank,,,GCB,1234567890,Acme Supplies Ltd,Invoice 1001"
      ].join("\n");
    }
  );

  app.get(
    "/payouts",
    {
      schema: {
        querystring: z.object({
          batch_id: z.string().min(1).optional(),
          created_gte: z.string().datetime().optional(),
          created_lte: z.string().datetime().optional(),
          limit: z.coerce.number().int().positive().max(100).default(20),
          reference: z.string().min(1).optional(),
          starting_after: z.string().min(1).optional(),
          status: z.enum(payoutStatuses).optional()
        }),
        response: {
          200: z.object({
            data: z.array(payoutResponseSchema),
            meta: z.object({
              has_more: z.boolean(),
              next_starting_after: z.string().nullable()
            })
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("payouts.create");

      const page = await payoutService.list(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode,
        {
          ...(request.query.batch_id ? { batchId: request.query.batch_id } : {}),
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
        data: page.data.map(serializePayout),
        meta: {
          has_more: page.hasMore,
          next_starting_after: page.nextStartingAfter
        }
      };
    }
  );

  app.get(
    "/payouts/:id",
    {
      schema: {
        params: z.object({
          id: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: payoutResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("payouts.create");

      const payout = await payoutService.getById(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode,
        request.params.id
      );

      return {
        data: serializePayout(payout)
      };
    }
  );

  app.post(
    "/payouts/:id/approve",
    {
      schema: {
        params: z.object({
          id: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: payoutResponseSchema
          })
        }
      }
    },
    async (request) => {
      assertPayoutApprovalRole(request.dashboardMembership!.role);

      const payout = await payoutService.approvePayout({
        approverId: request.dashboardMembership!.userId,
        merchantId: request.dashboardMembership!.merchantId,
        mode: request.dashboardMembership!.mode,
        payoutId: request.params.id
      });

      return {
        data: serializePayout(payout)
      };
    }
  );

  app.get(
    "/payout-batches",
    {
      schema: {
        querystring: z.object({
          created_gte: z.string().datetime().optional(),
          created_lte: z.string().datetime().optional(),
          limit: z.coerce.number().int().positive().max(100).default(20),
          reference: z.string().min(1).optional(),
          starting_after: z.string().min(1).optional(),
          status: z.enum(payoutBatchStatuses).optional()
        }),
        response: {
          200: z.object({
            data: z.array(payoutBatchResponseSchema),
            meta: z.object({
              has_more: z.boolean(),
              next_starting_after: z.string().nullable()
            })
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("payouts.create");

      const page = await payoutService.listBatches(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode,
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
        data: page.data.map(serializePayoutBatch),
        meta: {
          has_more: page.hasMore,
          next_starting_after: page.nextStartingAfter
        }
      };
    }
  );

  app.get(
    "/payout-batches/:id",
    {
      schema: {
        params: z.object({
          id: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: payoutBatchResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("payouts.create");

      const batch = await payoutService.getBatchById(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode,
        request.params.id
      );

      return {
        data: serializePayoutBatch(batch)
      };
    }
  );

  app.post(
    "/payout-batches/:id/approve",
    {
      schema: {
        params: z.object({
          id: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: payoutBatchResponseSchema
          })
        }
      }
    },
    async (request) => {
      assertPayoutApprovalRole(request.dashboardMembership!.role);

      const batch = await payoutService.approveBatch({
        approverId: request.dashboardMembership!.userId,
        batchId: request.params.id,
        merchantId: request.dashboardMembership!.merchantId,
        mode: request.dashboardMembership!.mode
      });

      return {
        data: serializePayoutBatch(batch)
      };
    }
  );
}

function assertPayoutApprovalRole(role: string) {
  if (role !== "owner" && role !== "finance") {
    throw new ApiRouteError({
      code: "forbidden",
      message: "Only owner or finance users can approve payouts.",
      statusCode: 403
    });
  }
}

function serializePayout(payout: PayoutRecord) {
  return {
    account_name: payout.accountName,
    account_number: payout.accountNumber,
    amount: Number(payout.amount),
    approved_by: payout.approvedBy,
    bank_code: payout.bankCode,
    batch_id: payout.batchId,
    channel_id: payout.channelId,
    completed_at: payout.completedAt?.toISOString() ?? null,
    created_at: payout.createdAt.toISOString(),
    created_by: payout.createdBy,
    currency: payout.currency,
    failure_code: payout.failureCode,
    failure_message: payout.failureMessage,
    fee_minor: Number(payout.feeMinor),
    id: payout.id,
    metadata: (payout.metadata ?? {}) as Record<string, unknown>,
    method: payout.method,
    narration: payout.narration,
    network: payout.network,
    phone: payout.phone,
    provider_ref: payout.providerRef,
    reference: payout.reference,
    send_attempts: payout.sendAttempts,
    status: payout.status,
    status_check_attempts: payout.statusCheckAttempts,
    total_hold_minor: Number(payout.totalHoldMinor)
  };
}

function serializePayoutBatch(batch: PayoutBatchRecord) {
  return {
    approved_by: batch.approvedBy,
    completed_at: batch.completedAt?.toISOString() ?? null,
    created_at: batch.createdAt.toISOString(),
    created_by: batch.createdBy,
    currency: batch.currency,
    id: batch.id,
    item_count: batch.itemCount,
    metadata: (batch.metadata ?? {}) as Record<string, unknown>,
    payouts: batch.payouts.map(serializePayout),
    reference: batch.reference,
    status: batch.status,
    total_amount: Number(batch.totalAmount),
    total_fee_minor: Number(batch.totalFeeMinor),
    total_hold_minor: Number(batch.totalHoldMinor),
    validation_report: batch.validationReport as {
      invalid_count: number;
      rows: Array<{ errors: string[]; index: number }>;
      valid_count: number;
    }
  };
}
