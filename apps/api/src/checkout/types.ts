import type { CurrencyCode } from "@richespay/shared";

import type { Json, RpMode } from "../db/types";

export const checkoutMethods = ["mobile_money", "card"] as const;
export const checkoutSessionStatuses = ["open", "completed", "expired"] as const;
export const paymentLinkAmountModes = ["fixed", "customer_entered"] as const;

export type CheckoutMethod = (typeof checkoutMethods)[number];
export type CheckoutSessionStatus = (typeof checkoutSessionStatuses)[number];
export type PaymentLinkAmountMode = (typeof paymentLinkAmountModes)[number];

export interface CheckoutSessionCustomer {
  email?: string | null;
  name?: string | null;
}

export interface CheckoutSessionRecord {
  allowedMethods: CheckoutMethod[];
  amount: bigint;
  cancelUrl: string | null;
  collectionId: string | null;
  createdAt: Date;
  currency: CurrencyCode;
  customer: CheckoutSessionCustomer;
  description: string | null;
  expiresAt: Date;
  id: string;
  merchantId: string;
  mode: RpMode;
  paymentLinkId: string | null;
  reference: string | null;
  status: CheckoutSessionStatus;
  successUrl: string | null;
}

export interface PaymentLinkRecord {
  active: boolean;
  amount: bigint | null;
  amountMode: PaymentLinkAmountMode;
  createdAt: Date;
  currency: CurrencyCode;
  description: string | null;
  id: string;
  merchantId: string;
  minAmount: bigint | null;
  mode: RpMode;
  reusable: boolean;
  slug: string;
  title: string;
  updatedAt: Date;
}

export interface CheckoutSessionView {
  amount: bigint;
  allowedMethods: CheckoutMethod[];
  cancelUrl: string | null;
  collection: {
    card: {
      brand: string | null;
      expiryMonth: number | null;
      expiryYear: number | null;
      last4: string | null;
    } | null;
    failureCode: string | null;
    failureMessage: string | null;
    id: string;
    method: "mobile_money" | "card";
    network: string | null;
    nextAction: {
      iframeUrl?: string;
      type: "hosted_fields" | "redirect_url";
      url?: string;
    } | null;
    phone: string | null;
    providerRef: string | null;
    status: string;
  } | null;
  currency: CurrencyCode;
  customer: CheckoutSessionCustomer;
  description: string | null;
  expiresAt: Date;
  id: string;
  merchant: {
    displayName: string;
    id: string;
  };
  mode: RpMode;
  reference: string | null;
  status: CheckoutSessionStatus;
  successUrl: string | null;
}

export interface CreateCheckoutSessionInput {
  allowedMethods: CheckoutMethod[];
  amount: bigint;
  cancelUrl: string | null;
  currency: CurrencyCode;
  customer: CheckoutSessionCustomer;
  description: string | null;
  merchantId: string;
  mode: RpMode;
  paymentLinkId?: string | null;
  reference: string | null;
  successUrl: string | null;
}

export interface CreatePaymentLinkInput {
  active?: boolean;
  amount: bigint | null;
  amountMode: PaymentLinkAmountMode;
  currency: CurrencyCode;
  description: string | null;
  minAmount: bigint | null;
  mode: RpMode;
  reusable: boolean;
  slug: string;
  title: string;
}

export interface UpdatePaymentLinkInput {
  active?: boolean;
  amount?: bigint | null;
  amountMode?: PaymentLinkAmountMode;
  currency?: CurrencyCode;
  description?: string | null;
  minAmount?: bigint | null;
  reusable?: boolean;
  slug?: string;
  title?: string;
}

export interface PaymentLinkPublicView {
  active: boolean;
  amount: bigint | null;
  amountMode: PaymentLinkAmountMode;
  currency: CurrencyCode;
  description: string | null;
  merchant: {
    displayName: string;
  };
  reusable: boolean;
  slug: string;
  title: string;
}

export function parseCheckoutCustomer(value: Json): CheckoutSessionCustomer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const input = value as Record<string, unknown>;
  return {
    ...(typeof input.email === "string" ? { email: input.email } : {}),
    ...(typeof input.name === "string" ? { name: input.name } : {})
  };
}
