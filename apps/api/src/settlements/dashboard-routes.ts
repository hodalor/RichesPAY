import { z } from "zod";

import { pricingCurrencies } from "../pricing/types";
import type { FastifyTypedInstance } from "../types";

import { SettlementService } from "./service";
import type {
  SettlementAccountRecord,
  SettlementSettingsRecord,
  WithdrawalRecord
} from "./types";

const settlementAccountTypeSchema = z.enum(["bank", "mobile_money"]);
const bankAccountDetailsSchema = z.object({
  account_name: z.string().min(1).max(120).optional(),
  account_number: z.string().min(4).max(64),
  bank_code: z.string().min(1).max(32)
});
const mobileMoneyAccountDetailsSchema = z.object({
  account_name: z.string().min(1).max(120).optional(),
  network: z.string().min(1).max(64),
  phone: z.string().min(4).max(32)
});

const settlementAccountResponseSchema = z.object({
  cool_off_until: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  created_by: z.string(),
  details: z.unknown(),
  id: z.string(),
  is_default: z.boolean(),
  mode: z.enum(["live", "test"]),
  type: settlementAccountTypeSchema,
  updated_at: z.string().datetime(),
  updated_by: z.string(),
  verified_at: z.string().datetime().nullable(),
  verified_by: z.string().nullable()
});

const settlementSettingsResponseSchema = z.object({
  automatic_daily_settlement_enabled: z.boolean(),
  created_at: z.string().datetime(),
  last_auto_settlement_for_date: z.string().nullable(),
  mode: z.enum(["live", "test"]),
  settlement_account_id: z.string().nullable(),
  updated_at: z.string().datetime()
});

const withdrawalResponseSchema = z.object({
  amount: z.number().int(),
  auto_generated: z.boolean(),
  created_at: z.string().datetime(),
  created_by: z.string(),
  currency: z.enum(pricingCurrencies),
  id: z.string(),
  mode: z.enum(["live", "test"]),
  payout_id: z.string(),
  settlement_account_id: z.string(),
  status: z.enum([
    "pending_approval",
    "queued",
    "on_hold",
    "processing",
    "successful",
    "failed",
    "reversed",
    "cancelled"
  ])
});

export async function registerSettlementDashboardRoutes(app: FastifyTypedInstance) {
  const settlementService = new SettlementService({
    database: app.db
  });

  app.get(
    "/settlement-accounts",
    {
      schema: {
        response: {
          200: z.object({
            data: z.array(settlementAccountResponseSchema)
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("settlements.manage");

      const accounts = await settlementService.listAccounts(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode
      );

      return {
        data: accounts.map(serializeSettlementAccount)
      };
    }
  );

  app.post(
    "/settlement-accounts",
    {
      schema: {
        body: z.object({
          details: z.union([bankAccountDetailsSchema, mobileMoneyAccountDetailsSchema]),
          is_default: z.boolean().default(false),
          type: settlementAccountTypeSchema
        }),
        response: {
          201: z.object({
            data: settlementAccountResponseSchema
          })
        }
      }
    },
    async (request, reply) => {
      request.assertDashboardPermission("settlements.manage");

      const account = await settlementService.createAccount({
        createdBy: request.dashboardMembership!.userId,
        details: request.body.details,
        isDefault: request.body.is_default,
        merchantId: request.dashboardMembership!.merchantId,
        mode: request.dashboardMembership!.mode,
        type: request.body.type
      });

      return reply.status(201).send({
        data: serializeSettlementAccount(account)
      });
    }
  );

  app.put(
    "/settlement-accounts/:accountId",
    {
      schema: {
        body: z.object({
          details: z.union([bankAccountDetailsSchema, mobileMoneyAccountDetailsSchema]),
          is_default: z.boolean().default(false),
          type: settlementAccountTypeSchema
        }),
        params: z.object({
          accountId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: settlementAccountResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("settlements.manage");

      const account = await settlementService.updateAccount({
        accountId: request.params.accountId,
        details: request.body.details,
        isDefault: request.body.is_default,
        merchantId: request.dashboardMembership!.merchantId,
        mode: request.dashboardMembership!.mode,
        type: request.body.type,
        updatedBy: request.dashboardMembership!.userId
      });

      return {
        data: serializeSettlementAccount(account)
      };
    }
  );

  app.get(
    "/settlement-settings",
    {
      schema: {
        response: {
          200: z.object({
            data: settlementSettingsResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("settlements.manage");

      const settings = await settlementService.getSettings(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode
      );

      return {
        data: serializeSettlementSettings(settings)
      };
    }
  );

  app.put(
    "/settlement-settings",
    {
      schema: {
        body: z.object({
          automatic_daily_settlement_enabled: z.boolean(),
          settlement_account_id: z.string().min(1).nullable()
        }),
        response: {
          200: z.object({
            data: settlementSettingsResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("settlements.manage");

      const settings = await settlementService.updateSettings({
        automaticDailySettlementEnabled: request.body.automatic_daily_settlement_enabled,
        merchantId: request.dashboardMembership!.merchantId,
        mode: request.dashboardMembership!.mode,
        settlementAccountId: request.body.settlement_account_id
      });

      return {
        data: serializeSettlementSettings(settings)
      };
    }
  );

  app.get(
    "/withdrawals",
    {
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(100).default(20)
        }),
        response: {
          200: z.object({
            data: z.array(withdrawalResponseSchema)
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("settlements.manage");

      const withdrawals = await settlementService.listWithdrawals(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode,
        request.query.limit
      );

      return {
        data: withdrawals.map(serializeWithdrawal)
      };
    }
  );

  app.get(
    "/withdrawals/:withdrawalId",
    {
      schema: {
        params: z.object({
          withdrawalId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: withdrawalResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("settlements.manage");

      const withdrawal = await settlementService.getWithdrawal(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode,
        request.params.withdrawalId
      );

      return {
        data: serializeWithdrawal(withdrawal)
      };
    }
  );

  app.post(
    "/withdrawals",
    {
      schema: {
        body: z.object({
          amount: z.coerce.number().int().positive(),
          currency: z.enum(pricingCurrencies),
          settlement_account_id: z.string().min(1)
        }),
        response: {
          201: z.object({
            data: withdrawalResponseSchema
          })
        }
      }
    },
    async (request, reply) => {
      request.assertDashboardPermission("settlements.manage");

      const withdrawal = await settlementService.createWithdrawal({
        amountMinor: BigInt(request.body.amount),
        createdBy: request.dashboardMembership!.userId,
        currency: request.body.currency,
        merchantId: request.dashboardMembership!.merchantId,
        mode: request.dashboardMembership!.mode,
        requestId: request.id,
        settlementAccountId: request.body.settlement_account_id
      });

      return reply.status(201).send({
        data: serializeWithdrawal(withdrawal)
      });
    }
  );
}

function serializeSettlementAccount(account: SettlementAccountRecord) {
  return {
    cool_off_until: account.coolOffUntil?.toISOString() ?? null,
    created_at: account.createdAt.toISOString(),
    created_by: account.createdBy,
    details: account.details,
    id: account.id,
    is_default: account.isDefault,
    mode: account.mode,
    type: account.type,
    updated_at: account.updatedAt.toISOString(),
    updated_by: account.updatedBy,
    verified_at: account.verifiedAt?.toISOString() ?? null,
    verified_by: account.verifiedBy
  };
}

function serializeSettlementSettings(settings: SettlementSettingsRecord) {
  return {
    automatic_daily_settlement_enabled: settings.automaticDailySettlementEnabled,
    created_at: settings.createdAt.toISOString(),
    last_auto_settlement_for_date: settings.lastAutoSettlementForDate,
    mode: settings.mode,
    settlement_account_id: settings.settlementAccountId,
    updated_at: settings.updatedAt.toISOString()
  };
}

function serializeWithdrawal(withdrawal: WithdrawalRecord) {
  return {
    amount: Number(withdrawal.amount),
    auto_generated: withdrawal.autoGenerated,
    created_at: withdrawal.createdAt.toISOString(),
    created_by: withdrawal.createdBy,
    currency: withdrawal.currency,
    id: withdrawal.id,
    mode: withdrawal.mode,
    payout_id: withdrawal.payoutId,
    settlement_account_id: withdrawal.settlementAccountId,
    status: withdrawal.status
  };
}
