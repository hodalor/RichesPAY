import { z } from "zod";

import type { Json } from "../db/types";
import { pricingCurrencies } from "../pricing/types";
import {
  airtimeBatchStatuses,
  airtimeOrderStatuses,
  maxAirtimeBulkRecipients,
  type AirtimeBatchRecord,
  type AirtimeNetworkRecord,
  type AirtimeOrderRecord,
  type AirtimeQuote
} from "./types";

const metadataSchema = z.record(z.string(), z.unknown());

export const airtimeOrderResponseSchema = z.object({
  amount: z.number().int().describe("Face value in minor units. 1000 is ZMW 10.00."),
  batch_id: z.string().nullable().describe("Parent batch id when this order was created in bulk."),
  charge_amount: z.number().int().describe("Amount charged to the merchant after discount and FX."),
  charge_currency: z.enum(pricingCurrencies).describe("Merchant settlement currency for the charge."),
  completed_at: z.string().datetime().nullable(),
  country_code: z.string().describe("ISO country of the recipient network."),
  created_at: z.string().datetime(),
  currency: z.enum(pricingCurrencies).describe("Local currency of the recipient phone."),
  discount_minor: z.number().int().describe("Network discount applied to the face value, in minor units."),
  failure_code: z.string().nullable(),
  fx_rate_id: z.string().nullable().describe("FX rate used when charge currency differs from face-value currency."),
  id: z.string().describe("Airtime order id. Prefixed air_."),
  metadata: metadataSchema,
  network: z.string().describe("Detected or requested mobile network, for example MTN."),
  phone: z.string().describe("Recipient MSISDN in E.164."),
  reference: z.string().nullable(),
  status: z.enum(airtimeOrderStatuses)
});

export const airtimeBatchResponseSchema = z.object({
  accepted: z.number().int().describe("Rows accepted into the batch."),
  charge_currency: z.enum(pricingCurrencies),
  completed_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  failed: z.number().int(),
  id: z.string().describe("Airtime batch id. Prefixed aib_."),
  reference: z.string().nullable(),
  rejected: z.number().int(),
  rejected_rows: z.array(
    z.object({
      code: z.string(),
      index: z.number().int(),
      message: z.string(),
      phone: z.string().nullable()
    })
  ).describe("Rows that failed validation before dispatch."),
  status: z.enum(airtimeBatchStatuses),
  successful: z.number().int(),
  total_charge: z.number().int().describe("Sum of accepted merchant charges in charge_currency."),
  total_items: z.number().int()
});

export const airtimeQuoteResponseSchema = z.object({
  amount: z.number().int().describe("Requested face value in minor units."),
  charge_amount: z.number().int().describe("What the merchant pays after discount and FX."),
  charge_currency: z.enum(pricingCurrencies),
  country_code: z.string(),
  currency: z.enum(pricingCurrencies),
  discount_bps: z.number().int().describe("Merchant discount in basis points. 300 is 3%."),
  discount_minor: z.number().int(),
  fx_rate_id: z.string().nullable(),
  network: z.string(),
  phone: z.string()
});

export const airtimeNetworkResponseSchema = z.object({
  country_code: z.string(),
  currency: z.enum(pricingCurrencies),
  discount_bps: z.number().int().describe("Merchant discount in basis points for this network."),
  fixed_denominations: z
    .array(z.number().int())
    .nullable()
    .describe("Allowed face values when the network sells fixed packs. Null means any amount between min and max."),
  max_amount: z.number().int().describe("Maximum face value in minor units."),
  min_amount: z.number().int().describe("Minimum face value in minor units."),
  network: z.string()
});

export const airtimeSingleBodySchema = z.object({
  amount: z.coerce.number().int().positive().describe("Face value in minor units. 1000 is ZMW 10.00."),
  currency: z.enum(pricingCurrencies).describe("Local currency of the recipient phone."),
  metadata: metadataSchema.optional(),
  network: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .optional()
    .describe("Optional network code. Omit to detect from the phone number."),
  phone: z.string().min(4).max(32).describe("Recipient MSISDN in E.164, for example +260970000001."),
  reference: z.string().min(1).max(128).optional().describe("Your idempotent merchant reference.")
});

const bulkItemSchema = z.object({
  amount: z.coerce.number().int().positive().describe("Face value for this row in minor units."),
  currency: z.enum(pricingCurrencies).optional(),
  metadata: metadataSchema.optional(),
  network: z.string().trim().min(1).max(32).optional(),
  phone: z.string().min(1).max(32).describe("Recipient MSISDN in E.164."),
  reference: z.string().min(1).max(128).optional()
});

export const airtimeBulkBodySchema = z
  .object({
    amount: z
      .coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("Shared face value when sending the same amount to phones[]."),
    currency: z.enum(pricingCurrencies).optional(),
    items: z
      .array(bulkItemSchema)
      .min(1)
      .max(maxAirtimeBulkRecipients)
      .optional()
      .describe("Per-row amounts. Send either items or phones, not both."),
    network: z.string().trim().min(1).max(32).optional(),
    phones: z
      .array(z.string().min(1).max(32))
      .min(1)
      .max(maxAirtimeBulkRecipients)
      .optional()
      .describe("Recipients that all receive the shared amount. At most 5,000."),
    reference: z.string().min(1).max(128).optional()
  })
  .refine((body) => Boolean(body.items) !== Boolean(body.phones), {
    message: "Send either items or phones, not both.",
    path: ["items"]
  })
  .refine((body) => !body.phones || body.amount !== undefined, {
    message: "amount is required when sending to a list of phones.",
    path: ["amount"]
  });

export type AirtimeBulkBody = z.infer<typeof airtimeBulkBodySchema>;

export function bulkItemsFromBody(body: AirtimeBulkBody) {
  if (body.items) {
    return body.items.map((item) => ({
      amount: item.amount,
      ...(item.currency ? { currency: item.currency } : {}),
      ...(item.metadata ? { metadata: item.metadata as Json } : {}),
      ...(item.network ? { network: item.network } : {}),
      phone: item.phone,
      ...(item.reference ? { reference: item.reference } : {})
    }));
  }

  return (body.phones ?? []).map((phone) => ({
    amount: body.amount!,
    ...(body.currency ? { currency: body.currency } : {}),
    ...(body.network ? { network: body.network } : {}),
    phone
  }));
}

export function serializeAirtimeOrder(order: AirtimeOrderRecord) {
  return {
    amount: Number(order.amount),
    batch_id: order.batchId,
    charge_amount: Number(order.chargeAmount),
    charge_currency: order.chargeCurrency,
    completed_at: order.completedAt?.toISOString() ?? null,
    country_code: order.countryCode,
    created_at: order.createdAt.toISOString(),
    currency: order.currency,
    discount_minor: Number(order.discountMinor),
    failure_code: order.failureCode,
    fx_rate_id: order.fxRateId,
    id: order.id,
    metadata: (order.metadata ?? {}) as Record<string, unknown>,
    network: order.network,
    phone: order.phone,
    reference: order.reference,
    status: order.status
  };
}

export function serializeAirtimeBatch(batch: AirtimeBatchRecord) {
  return {
    accepted: batch.accepted,
    charge_currency: batch.chargeCurrency,
    completed_at: batch.completedAt?.toISOString() ?? null,
    created_at: batch.createdAt.toISOString(),
    failed: batch.failed,
    id: batch.id,
    reference: batch.reference,
    rejected: batch.rejected,
    rejected_rows: batch.rejectedRows,
    status: batch.status,
    successful: batch.successful,
    total_charge: Number(batch.totalCharge),
    total_items: batch.totalItems
  };
}

export function serializeAirtimeQuote(quote: AirtimeQuote) {
  return {
    amount: Number(quote.amount),
    charge_amount: Number(quote.chargeAmount),
    charge_currency: quote.chargeCurrency,
    country_code: quote.countryCode,
    currency: quote.currency,
    discount_bps: quote.discountBps,
    discount_minor: Number(quote.discountMinor),
    fx_rate_id: quote.fxRateId,
    network: quote.network,
    phone: quote.phone
  };
}

export function serializeAirtimeNetwork(network: AirtimeNetworkRecord) {
  return {
    country_code: network.countryCode,
    currency: network.currency,
    discount_bps: network.discountBps,
    fixed_denominations: network.fixedDenominations,
    max_amount: Number(network.maxMinor),
    min_amount: Number(network.minMinor),
    network: network.network
  };
}
