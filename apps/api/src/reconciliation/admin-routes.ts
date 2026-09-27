import { z } from "zod";

import { runAdminSystemWrite } from "../auth/admin-access";
import type { Json } from "../db/types";
import { pricingCurrencies } from "../pricing/types";
import { ProviderCatalog } from "../providers/catalog";
import type { FastifyTypedInstance } from "../types";
import { SettlementService } from "../settlements";

import { ReconciliationService } from "./service";
import type {
  ProviderStatementImportResult,
  ReconDailySummaryRecord,
  ReconExceptionRecord
} from "./types";

const providerStatementLineSchema = z.object({
  amount: z.coerce.number().int(),
  currency: z.enum(pricingCurrencies),
  entry_type: z.enum(["collection", "payout", "fee", "adjustment"]),
  fee_minor: z.coerce.number().int().optional(),
  provider_ref: z.string().min(1).nullable().optional(),
  provider_status: z.string().min(1).nullable().optional(),
  raw: z.record(z.string(), z.unknown()).default({})
});

const reconExceptionResponseSchema = z.object({
  channel_id: z.string(),
  created_at: z.string().datetime(),
  currency: z.enum(pricingCurrencies).nullable(),
  exception_type: z.enum([
    "missing_in_richespay",
    "missing_at_provider",
    "amount_mismatch",
    "status_mismatch"
  ]),
  expected_amount: z.number().int().nullable(),
  expected_status: z.string().nullable(),
  id: z.string(),
  merchant_id: z.string().nullable(),
  mode: z.enum(["test", "live"]).nullable(),
  provider_amount: z.number().int().nullable(),
  provider_ref: z.string().nullable(),
  provider_status: z.string().nullable(),
  resolution_action: z.enum(["force_status", "manual_adjustment", "dismiss"]).nullable(),
  resolution_reason: z.string().nullable(),
  resolved_at: z.string().datetime().nullable(),
  resolved_by: z.string().nullable(),
  resource_id: z.string().nullable(),
  resource_type: z.string().nullable(),
  statement_id: z.string().nullable(),
  statement_line_id: z.string().nullable(),
  status: z.enum(["open", "resolved", "dismissed"])
});

const summaryResponseSchema = z.object({
  balances_match: z.boolean(),
  channel_id: z.string(),
  collection_count: z.number().int(),
  collection_volume: z.number().int(),
  created_at: z.string().datetime(),
  currency: z.enum(pricingCurrencies),
  exception_count: z.number().int(),
  fee_volume: z.number().int(),
  id: z.string(),
  payout_count: z.number().int(),
  payout_volume: z.number().int(),
  provider_clearing_balance: z.number().int(),
  provider_float_balance: z.number().int().nullable(),
  statement_date: z.string(),
  statement_id: z.string()
});

const importResultSchema = z.object({
  exception_count: z.number().int(),
  statement_id: z.string(),
  summary: summaryResponseSchema
});

export async function registerReconciliationAdminRoutes(app: FastifyTypedInstance) {
  const reconciliationService = new ReconciliationService({
    database: app.db,
    providerCatalog: new ProviderCatalog({
      database: app.db,
      encryptionKey: app.appEnv.ENCRYPTION_KEY
    })
  });
  const settlementService = new SettlementService({
    database: app.db
  });

  app.post(
    "/settlement-accounts/:accountId/verify",
    {
      schema: {
        body: z.object({
          reason: z.string().min(1)
        }),
        params: z.object({
          accountId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: z.object({
              cool_off_until: z.string().datetime().nullable(),
              created_at: z.string().datetime(),
              created_by: z.string(),
              details: z.unknown(),
              id: z.string(),
              is_default: z.boolean(),
              mode: z.enum(["live", "test"]),
              type: z.enum(["bank", "mobile_money"]),
              updated_at: z.string().datetime(),
              updated_by: z.string(),
              verified_at: z.string().datetime().nullable(),
              verified_by: z.string().nullable()
            })
          })
        }
      }
    },
    async (request) => {
      const account = await runAdminSystemWrite(
        app.db,
        {
          action: "settlement_account.verify",
          actorId: request.platformAdmin!.userId,
          reason: request.body.reason,
          targetId: request.params.accountId,
          targetType: "settlement_account"
        },
        async () =>
          settlementService.verifyAccount({
            accountId: request.params.accountId,
            adminUserId: request.platformAdmin!.userId
          })
      );

      return {
        data: serializeSettlementAccount(account)
      };
    }
  );

  app.post(
    "/reconciliation/statements/import",
    {
      schema: {
        body: z.object({
          channel_id: z.string().min(1),
          currency: z.enum(pricingCurrencies),
          float_balance_minor: z.coerce.number().int().nullable().optional(),
          raw_file_path: z.string().min(1),
          reason: z.string().min(1),
          rows: z.array(providerStatementLineSchema),
          source: z.enum(["api", "csv_upload"]).default("csv_upload"),
          statement_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
        }),
        response: {
          200: z.object({
            data: importResultSchema
          })
        }
      }
    },
    async (request) => {
      const imported = await runAdminSystemWrite(
        app.db,
        {
          action: "reconciliation.statement.import",
          actorId: request.platformAdmin!.userId,
          after: {
            channel_id: request.body.channel_id,
            row_count: request.body.rows.length,
            statement_date: request.body.statement_date
          },
          reason: request.body.reason,
          targetId: request.body.channel_id,
          targetType: "provider_statement"
        },
        async () =>
          reconciliationService.importStatement({
            channelId: request.body.channel_id,
            currency: request.body.currency,
            ...(request.body.float_balance_minor !== undefined &&
            request.body.float_balance_minor !== null
              ? { floatBalanceMinor: BigInt(request.body.float_balance_minor) }
              : {}),
            rawFilePath: request.body.raw_file_path,
            rows: request.body.rows.map((row) => ({
              amountMinor: BigInt(row.amount),
              currency: row.currency,
              entryType: row.entry_type,
              ...(row.fee_minor !== undefined ? { feeMinor: BigInt(row.fee_minor) } : {}),
              ...(row.provider_ref !== undefined ? { providerRef: row.provider_ref } : {}),
              ...(row.provider_status !== undefined
                ? { providerStatus: row.provider_status }
                : {}),
              raw: row.raw as Json
            })),
            source: request.body.source,
            statementDate: request.body.statement_date
          })
      );

      return {
        data: serializeImportResult(imported)
      };
    }
  );

  app.post(
    "/reconciliation/statements/fetch",
    {
      schema: {
        body: z.object({
          channel_id: z.string().min(1).optional(),
          reason: z.string().min(1),
          statement_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
        }),
        response: {
          200: z.object({
            data: z.array(importResultSchema)
          })
        }
      }
    },
    async (request) => {
      const fetched = await runAdminSystemWrite(
        app.db,
        {
          action: "reconciliation.statement.fetch",
          actorId: request.platformAdmin!.userId,
          after: {
            ...(request.body.channel_id ? { channel_id: request.body.channel_id } : {}),
            statement_date: request.body.statement_date
          },
          reason: request.body.reason,
          targetId: request.body.channel_id ?? null,
          targetType: "provider_statement_fetch"
        },
        async () =>
          reconciliationService.fetchDailyStatements({
            ...(request.body.channel_id ? { channelId: request.body.channel_id } : {}),
            statementDate: request.body.statement_date
          })
      );

      return {
        data: fetched.map(serializeImportResult)
      };
    }
  );

  app.get(
    "/reconciliation/exceptions",
    {
      schema: {
        querystring: z.object({
          channel_id: z.string().min(1).optional(),
          limit: z.coerce.number().int().positive().max(100).default(20),
          status: z.enum(["open", "resolved", "dismissed"]).optional()
        }),
        response: {
          200: z.object({
            data: z.array(reconExceptionResponseSchema)
          })
        }
      }
    },
    async (request) => {
      const exceptions = await reconciliationService.listExceptions({
        ...(request.query.channel_id ? { channelId: request.query.channel_id } : {}),
        limit: request.query.limit,
        ...(request.query.status ? { status: request.query.status } : {})
      });

      return {
        data: exceptions.map(serializeException)
      };
    }
  );

  app.post(
    "/reconciliation/exceptions/:exceptionId/resolve-force-status",
    {
      schema: {
        body: z.object({
          provider_status: z.string().min(1),
          reason: z.string().min(1)
        }),
        params: z.object({
          exceptionId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: reconExceptionResponseSchema
          })
        }
      }
    },
    async (request) => {
      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "reconciliation.exception.force_status",
          actorId: request.platformAdmin!.userId,
          after: {
            provider_status: request.body.provider_status
          },
          reason: request.body.reason,
          targetId: request.params.exceptionId,
          targetType: "recon_exception"
        },
        async () =>
          reconciliationService.resolveByForceStatus({
            adminUserId: request.platformAdmin!.userId,
            exceptionId: request.params.exceptionId,
            providerStatus: request.body.provider_status,
            reason: request.body.reason
          })
      );

      return {
        data: serializeException(updated)
      };
    }
  );

  app.post(
    "/reconciliation/exceptions/:exceptionId/manual-adjustment",
    {
      schema: {
        body: z.object({
          amount: z.coerce.number().int().positive(),
          credit_account: z.object({
            channel_id: z.string().min(1).optional(),
            merchant_id: z.string().nullable(),
            type: z.enum([
              "merchant_available",
              "merchant_pending",
              "merchant_reserve",
              "merchant_payout_hold",
              "platform_fees",
              "platform_sms_revenue",
              "provider_clearing",
              "fx_clearing",
              "suspense"
            ])
          }),
          currency: z.enum(pricingCurrencies),
          debit_account: z.object({
            channel_id: z.string().min(1).optional(),
            merchant_id: z.string().nullable(),
            type: z.enum([
              "merchant_available",
              "merchant_pending",
              "merchant_reserve",
              "merchant_payout_hold",
              "platform_fees",
              "platform_sms_revenue",
              "provider_clearing",
              "fx_clearing",
              "suspense"
            ])
          }),
          reason: z.string().min(1)
        }),
        params: z.object({
          exceptionId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: reconExceptionResponseSchema
          })
        }
      }
    },
    async (request) => {
      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "reconciliation.exception.manual_adjustment",
          actorId: request.platformAdmin!.userId,
          after: {
            amount: request.body.amount,
            currency: request.body.currency
          },
          reason: request.body.reason,
          targetId: request.params.exceptionId,
          targetType: "recon_exception"
        },
        async () =>
          reconciliationService.resolveByManualAdjustment({
            adminUserId: request.platformAdmin!.userId,
            amountMinor: BigInt(request.body.amount),
            creditAccount: {
              ...(request.body.credit_account.channel_id
                ? { channelId: request.body.credit_account.channel_id }
                : {}),
              merchantId: request.body.credit_account.merchant_id,
              type: request.body.credit_account.type
            },
            currency: request.body.currency,
            debitAccount: {
              ...(request.body.debit_account.channel_id
                ? { channelId: request.body.debit_account.channel_id }
                : {}),
              merchantId: request.body.debit_account.merchant_id,
              type: request.body.debit_account.type
            },
            exceptionId: request.params.exceptionId,
            reason: request.body.reason
          })
      );

      return {
        data: serializeException(updated)
      };
    }
  );

  app.post(
    "/reconciliation/exceptions/:exceptionId/dismiss",
    {
      schema: {
        body: z.object({
          reason: z.string().min(1)
        }),
        params: z.object({
          exceptionId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: reconExceptionResponseSchema
          })
        }
      }
    },
    async (request) => {
      const updated = await runAdminSystemWrite(
        app.db,
        {
          action: "reconciliation.exception.dismiss",
          actorId: request.platformAdmin!.userId,
          reason: request.body.reason,
          targetId: request.params.exceptionId,
          targetType: "recon_exception"
        },
        async () =>
          reconciliationService.dismissException({
            adminUserId: request.platformAdmin!.userId,
            exceptionId: request.params.exceptionId,
            reason: request.body.reason
          })
      );

      return {
        data: serializeException(updated)
      };
    }
  );

  app.get(
    "/reconciliation/summaries",
    {
      schema: {
        querystring: z.object({
          channel_id: z.string().min(1).optional(),
          limit: z.coerce.number().int().positive().max(100).default(20)
        }),
        response: {
          200: z.object({
            data: z.array(summaryResponseSchema)
          })
        }
      }
    },
    async (request) => {
      const summaries = await reconciliationService.listSummaries({
        ...(request.query.channel_id ? { channelId: request.query.channel_id } : {}),
        limit: request.query.limit
      });

      return {
        data: summaries.map(serializeSummary)
      };
    }
  );
}

function serializeSettlementAccount(account: Awaited<ReturnType<SettlementService["verifyAccount"]>>) {
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

function serializeException(record: ReconExceptionRecord) {
  return {
    channel_id: record.channelId,
    created_at: record.createdAt.toISOString(),
    currency: record.currency,
    exception_type: record.exceptionType,
    expected_amount: record.expectedAmount === null ? null : Number(record.expectedAmount),
    expected_status: record.expectedStatus,
    id: record.id,
    merchant_id: record.merchantId,
    mode: record.mode,
    provider_amount: record.providerAmount === null ? null : Number(record.providerAmount),
    provider_ref: record.providerRef,
    provider_status: record.providerStatus,
    resolution_action: record.resolutionAction,
    resolution_reason: record.resolutionReason,
    resolved_at: record.resolvedAt?.toISOString() ?? null,
    resolved_by: record.resolvedBy,
    resource_id: record.resourceId,
    resource_type: record.resourceType,
    statement_id: record.statementId,
    statement_line_id: record.statementLineId,
    status: record.status
  };
}

function serializeSummary(summary: ReconDailySummaryRecord) {
  return {
    balances_match: summary.balancesMatch,
    channel_id: summary.channelId,
    collection_count: summary.collectionCount,
    collection_volume: Number(summary.collectionVolume),
    created_at: summary.createdAt.toISOString(),
    currency: summary.currency,
    exception_count: summary.exceptionCount,
    fee_volume: Number(summary.feeVolume),
    id: summary.id,
    payout_count: summary.payoutCount,
    payout_volume: Number(summary.payoutVolume),
    provider_clearing_balance: Number(summary.providerClearingBalance),
    provider_float_balance:
      summary.providerFloatBalance === null ? null : Number(summary.providerFloatBalance),
    statement_date: summary.statementDate,
    statement_id: summary.statementId
  };
}

function serializeImportResult(result: ProviderStatementImportResult) {
  return {
    exception_count: result.exceptionCount,
    statement_id: result.statementId,
    summary: serializeSummary(result.summary)
  };
}
