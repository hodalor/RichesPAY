import { z } from "zod";

import { formatMoney } from "@richespay/shared";

import type { FastifyTypedInstance } from "../types";
import { pricingCurrencies } from "../pricing/types";
import { CheckoutService } from "./service";
import { paymentLinkAmountModes, type PaymentLinkRecord } from "./types";

const paymentLinkBodySchema = z.object({
  active: z.boolean().optional(),
  amount: z.coerce.number().int().positive().nullable().optional(),
  amount_mode: z.enum(paymentLinkAmountModes),
  currency: z.enum(pricingCurrencies),
  description: z.string().max(500).nullable().optional(),
  min_amount: z.coerce.number().int().positive().nullable().optional(),
  reusable: z.boolean(),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1).max(120)
});

const paymentLinkResponseSchema = z.object({
  active: z.boolean(),
  amount: z.number().int().nullable(),
  amount_formatted: z.string().nullable(),
  amount_mode: z.enum(paymentLinkAmountModes),
  created_at: z.string().datetime(),
  currency: z.enum(pricingCurrencies),
  description: z.string().nullable(),
  id: z.string(),
  link_url: z.string().url(),
  min_amount: z.number().int().nullable(),
  min_amount_formatted: z.string().nullable(),
  reusable: z.boolean(),
  slug: z.string(),
  title: z.string(),
  updated_at: z.string().datetime()
});

export async function registerCheckoutDashboardRoutes(app: FastifyTypedInstance) {
  const checkoutService = new CheckoutService({
    database: app.db,
    encryptionKey: app.appEnv.ENCRYPTION_KEY
  });

  app.get(
    "/payment-links",
    {
      schema: {
        response: {
          200: z.object({
            data: z.array(paymentLinkResponseSchema)
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("payment_links.manage");

      const links = await checkoutService.listPaymentLinks(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode
      );

      return {
        data: links.map((link) => serializePaymentLink(link, app.appEnv.CHECKOUT_ORIGIN))
      };
    }
  );

  app.post(
    "/payment-links",
    {
      schema: {
        body: paymentLinkBodySchema,
        response: {
          201: z.object({
            data: paymentLinkResponseSchema
          })
        }
      }
    },
    async (request, reply) => {
      request.assertDashboardPermission("payment_links.manage");
      const body = paymentLinkBodySchema.parse(request.body);

      const link = await checkoutService.createPaymentLink(
        request.dashboardMembership!.merchantId,
        {
          ...(body.active !== undefined ? { active: body.active } : {}),
          amount: body.amount === undefined ? null : body.amount === null ? null : BigInt(body.amount),
          amountMode: body.amount_mode,
          currency: body.currency,
          description: body.description ?? null,
          minAmount:
            body.min_amount === undefined
              ? null
              : body.min_amount === null
                ? null
                : BigInt(body.min_amount),
          mode: request.dashboardMembership!.mode,
          reusable: body.reusable,
          slug: body.slug,
          title: body.title
        }
      );

      return reply.status(201).send({
        data: serializePaymentLink(link, app.appEnv.CHECKOUT_ORIGIN)
      });
    }
  );

  app.patch(
    "/payment-links/:linkId",
    {
      schema: {
        body: paymentLinkBodySchema.partial(),
        params: z.object({
          linkId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: paymentLinkResponseSchema
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("payment_links.manage");
      const body = paymentLinkBodySchema.partial().parse(request.body);

      const link = await checkoutService.updatePaymentLink(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode,
        request.params.linkId,
        {
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...(body.amount !== undefined
            ? {
                amount:
                  body.amount === null ? null : BigInt(body.amount)
              }
            : {}),
          ...(body.amount_mode !== undefined ? { amountMode: body.amount_mode } : {}),
          ...(body.currency !== undefined ? { currency: body.currency } : {}),
          ...(body.description !== undefined ? { description: body.description ?? null } : {}),
          ...(body.min_amount !== undefined
            ? {
                minAmount:
                  body.min_amount === null ? null : BigInt(body.min_amount)
              }
            : {}),
          ...(body.reusable !== undefined ? { reusable: body.reusable } : {}),
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
          ...(body.title !== undefined ? { title: body.title } : {})
        }
      );

      return {
        data: serializePaymentLink(link, app.appEnv.CHECKOUT_ORIGIN)
      };
    }
  );

  app.delete(
    "/payment-links/:linkId",
    {
      schema: {
        params: z.object({
          linkId: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: z.object({
              deleted: z.literal(true)
            })
          })
        }
      }
    },
    async (request) => {
      request.assertDashboardPermission("payment_links.manage");

      await checkoutService.deletePaymentLink(
        request.dashboardMembership!.merchantId,
        request.dashboardMembership!.mode,
        request.params.linkId
      );

      return {
        data: {
          deleted: true as const
        }
      };
    }
  );
}

function serializePaymentLink(link: PaymentLinkRecord, checkoutOrigin: string) {
  return {
    active: link.active,
    amount: link.amount === null ? null : Number(link.amount),
    amount_formatted:
      link.amount === null ? null : formatMoney(link.amount, link.currency, "en-US"),
    amount_mode: link.amountMode,
    created_at: link.createdAt.toISOString(),
    currency: link.currency,
    description: link.description,
    id: link.id,
    link_url: `${checkoutOrigin}/link/${link.slug}`,
    min_amount: link.minAmount === null ? null : Number(link.minAmount),
    min_amount_formatted:
      link.minAmount === null
        ? null
        : formatMoney(link.minAmount, link.currency, "en-US"),
    reusable: link.reusable,
    slug: link.slug,
    title: link.title,
    updated_at: link.updatedAt.toISOString()
  };
}
