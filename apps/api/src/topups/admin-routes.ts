import { z } from "zod";

import { runAdminSystemWrite } from "../auth/admin-access";
import { pricingCurrencies } from "../pricing/types";
import type { FastifyTypedInstance } from "../types";

import { TopupService } from "./service";

export async function registerTopupAdminRoutes(app: FastifyTypedInstance) {
  const topupService = new TopupService({
    database: app.db
  });

  app.post(
    "/topups/:topupId/confirm-bank-transfer",
    {
      schema: {
        body: z.object({
          bank_statement_reference: z.string().min(1).optional(),
          reason: z.string().min(1)
        }),
        params: z.object({
          topupId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: z.object({
              completed_at: z.string().datetime().nullable(),
              confirmed_by: z.string().nullable(),
              id: z.string(),
              provider_ref: z.string().nullable(),
              status: z.enum(["pending", "successful", "failed", "expired"])
            })
          })
        }
      }
    },
    async (request) => {
      const topup = await runAdminSystemWrite(
        app.db,
        {
          action: "topup.bank_transfer.confirm",
          actorId: request.platformAdmin!.userId,
          reason: request.body.reason,
          targetId: request.params.topupId,
          targetType: "topup"
        },
        async () =>
          topupService.confirmBankTransferTopup({
            adminUserId: request.platformAdmin!.userId,
            bankStatementReference: request.body.bank_statement_reference ?? null,
            reason: request.body.reason,
            topupId: request.params.topupId
          })
      );

      return {
        data: {
          completed_at: topup.completedAt?.toISOString() ?? null,
          confirmed_by: topup.confirmedBy,
          id: topup.id,
          provider_ref: topup.providerRef,
          status: topup.status
        }
      };
    }
  );

  app.post(
    "/topups/bank-transfer-import",
    {
      schema: {
        body: z.object({
          reason: z.string().min(1),
          rows: z.array(
            z.object({
              amount: z.coerce.number().int().positive(),
              bank_statement_reference: z.string().min(1),
              currency: z.enum(pricingCurrencies),
              merchant_transfer_reference: z.string().min(1)
            })
          )
        }),
        response: {
          200: z.object({
            data: z.object({
              matched: z.array(
                z.object({
                  amount: z.number().int(),
                  currency: z.enum(pricingCurrencies),
                  merchant_transfer_reference: z.string(),
                  topup_id: z.string()
                })
              ),
              unmatched: z.array(
                z.object({
                  amount: z.number().int(),
                  bank_statement_reference: z.string(),
                  currency: z.enum(pricingCurrencies),
                  merchant_transfer_reference: z.string()
                })
              )
            })
          })
        }
      }
    },
    async (request) => {
      const result = await runAdminSystemWrite(
        app.db,
        {
          action: "topup.bank_transfer.import",
          actorId: request.platformAdmin!.userId,
          after: {
            imported_rows: request.body.rows.length
          },
          reason: request.body.reason,
          targetType: "topup_import"
        },
        async () =>
          topupService.importBankTransferStatement({
            adminUserId: request.platformAdmin!.userId,
            reason: request.body.reason,
            rows: request.body.rows.map((row) => ({
              amountMinor: BigInt(row.amount),
              bankStatementReference: row.bank_statement_reference,
              currency: row.currency,
              merchantTransferReference: row.merchant_transfer_reference
            }))
          })
      );

      return {
        data: {
          matched: result.matched.map((item) => ({
            amount: Number(item.amountMinor),
            currency: item.currency,
            merchant_transfer_reference: item.merchantTransferReference,
            topup_id: item.topupId
          })),
          unmatched: request.body.rows.filter(
            (row) =>
              !result.matched.some(
                (item) =>
                  item.merchantTransferReference === row.merchant_transfer_reference &&
                  item.currency === row.currency &&
                  item.amountMinor === BigInt(row.amount)
              )
          )
        }
      };
    }
  );
}
