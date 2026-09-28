import { getErrorDefinition, newId } from "@richespay/shared";

import { CollectionService } from "../collections";
import {
  runWithMerchantScope,
  runWithSystemScope,
  type AppDatabase,
  type ScopedTransaction
} from "../db";
import type { Json, RpMode } from "../db/types";
import { ApiRouteError } from "../lib/api-error";
import { merchantCanTransact } from "../lib/merchant-access";
import { parseCurrencyCode } from "../pricing/types";
import { ProviderCatalog } from "../providers/catalog";
import type {
  CheckoutMethod,
  CheckoutSessionCustomer,
  CheckoutSessionRecord,
  CheckoutSessionStatus,
  CheckoutSessionView,
  CreateCheckoutSessionInput,
  CreatePaymentLinkInput,
  PaymentLinkPublicView,
  PaymentLinkRecord,
  UpdatePaymentLinkInput
} from "./types";
import { parseCheckoutCustomer } from "./types";

const CHECKOUT_SESSION_TTL_MS = 30 * 60 * 1000;

export class CheckoutService {
  #collectionService: CollectionService;
  #database: AppDatabase;

  constructor(input: { database: AppDatabase; encryptionKey: string }) {
    this.#database = input.database;
    this.#collectionService = new CollectionService({
      database: input.database,
      providerCatalog: new ProviderCatalog({
        database: input.database,
        encryptionKey: input.encryptionKey
      })
    });
  }

  async createSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionRecord> {
    return runWithMerchantScope(
      this.#database,
      input.merchantId,
      input.mode,
      async (trx) => {
        await this.#ensureMerchantCanCreateCheckout(trx, input.merchantId, input.mode);

        const created = await trx
          .insertInto("checkout_sessions")
          .values({
            allowed_methods: input.allowedMethods,
            amount: input.amount,
            cancel_url: input.cancelUrl,
            collection_id: null,
            currency: input.currency,
            customer: normalizeCheckoutCustomer(input.customer),
            description: input.description,
            expires_at: new Date(Date.now() + CHECKOUT_SESSION_TTL_MS),
            id: newId("cs_"),
            merchant_id: input.merchantId,
            mode: input.mode,
            ...(input.paymentLinkId ? { payment_link_id: input.paymentLinkId } : {}),
            reference: input.reference,
            status: "open",
            success_url: input.successUrl
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        return mapCheckoutSession(created);
      }
    );
  }

  async getSessionForMerchant(
    merchantId: string,
    mode: RpMode,
    sessionId: string
  ): Promise<CheckoutSessionView> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const session = await this.#loadSessionForUpdate(trx, sessionId);
      const synced = await this.#syncSessionState(trx, session);
      return this.#buildSessionView(trx, synced);
    });
  }

  async submitSessionPaymentForMerchant(input: {
    baseUrl: string | null;
    idempotencyKey: string | null;
    method: CheckoutMethod;
    merchantId: string;
    mode: RpMode;
    network: string | null;
    phone: string | null;
    requestId: string;
    sessionUrl: string | null;
    sessionId: string;
  }): Promise<CheckoutSessionView> {
    return runWithMerchantScope(
      this.#database,
      input.merchantId,
      input.mode,
      async (trx) => {
        const session = await this.#loadSessionForUpdate(trx, input.sessionId);
        const synced = await this.#syncSessionState(trx, session);
        this.#assertSessionOpen(synced);
        this.#assertMethodAllowed(synced, input.method);

        const existingCollection = await this.#loadLinkedCollection(trx, synced.collectionId);
        if (
          existingCollection &&
          ["pending", "processing"].includes(existingCollection.status)
        ) {
          return this.#buildSessionView(trx, synced);
        }

        const collection = await this.#collectionService.create({
          amountMinor: synced.amount,
          baseUrl: input.baseUrl,
          cancelUrl: synced.cancelUrl,
          currency: synced.currency,
          customerEmail: synced.customer.email ?? null,
          customerName: synced.customer.name ?? null,
          description: synced.description,
          idempotencyKey: input.idempotencyKey,
          merchantId: input.merchantId,
          metadata: {
            checkout_session_id: synced.id
          },
          method: input.method,
          mode: input.mode,
          network: input.method === "mobile_money" ? input.network : null,
          phone: input.method === "mobile_money" ? input.phone : null,
          returnUrl: input.sessionUrl,
          reference: null,
          requestId: input.requestId
        });

        const updated = await trx
          .updateTable("checkout_sessions")
          .set({
            collection_id: collection.id,
            status: collection.status === "successful" ? "completed" : synced.status
          })
          .where("id", "=", synced.id)
          .returningAll()
          .executeTakeFirstOrThrow();

        return this.#buildSessionView(trx, mapCheckoutSession(updated));
      }
    );
  }

  async listPaymentLinks(merchantId: string, mode: RpMode): Promise<PaymentLinkRecord[]> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) =>
      (
        await trx
          .selectFrom("payment_links")
          .selectAll()
          .where("merchant_id", "=", merchantId)
          .where("mode", "=", mode)
          .orderBy("created_at", "desc")
          .execute()
      ).map(mapPaymentLink)
    );
  }

  async createPaymentLink(
    merchantId: string,
    input: CreatePaymentLinkInput
  ): Promise<PaymentLinkRecord> {
    return runWithMerchantScope(this.#database, merchantId, input.mode, async (trx) => {
      await this.#assertPaymentLinkSlugAvailable(trx, input.slug);

      const created = await trx
        .insertInto("payment_links")
        .values({
          active: input.active ?? true,
          amount: input.amount,
          amount_mode: input.amountMode,
          currency: input.currency,
          description: input.description,
          id: newId("lnk_"),
          merchant_id: merchantId,
          min_amount: input.minAmount,
          mode: input.mode,
          reusable: input.reusable,
          slug: input.slug,
          title: input.title
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return mapPaymentLink(created);
    });
  }

  async updatePaymentLink(
    merchantId: string,
    mode: RpMode,
    linkId: string,
    input: UpdatePaymentLinkInput
  ): Promise<PaymentLinkRecord> {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const existing = await trx
        .selectFrom("payment_links")
        .selectAll()
        .where("id", "=", linkId)
        .where("merchant_id", "=", merchantId)
        .where("mode", "=", mode)
        .executeTakeFirst();

      if (!existing) {
        throw notFoundError("Payment link not found");
      }

      if (input.slug && input.slug !== existing.slug) {
        await this.#assertPaymentLinkSlugAvailable(trx, input.slug);
      }

      const amountMode = input.amountMode ?? existing.amount_mode;
      const amount =
        input.amount !== undefined ? input.amount : bigintOrNull(existing.amount);
      const minAmount =
        input.minAmount !== undefined ? input.minAmount : bigintOrNull(existing.min_amount);

      assertPaymentLinkAmountShape(amountMode, amount, minAmount);

      const updated = await trx
        .updateTable("payment_links")
        .set({
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.amountMode !== undefined ? { amount_mode: input.amountMode } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.minAmount !== undefined ? { min_amount: input.minAmount } : {}),
          ...(input.reusable !== undefined ? { reusable: input.reusable } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.title !== undefined ? { title: input.title } : {})
        })
        .where("id", "=", linkId)
        .where("merchant_id", "=", merchantId)
        .where("mode", "=", mode)
        .returningAll()
        .executeTakeFirstOrThrow();

      return mapPaymentLink(updated);
    });
  }

  async deletePaymentLink(merchantId: string, mode: RpMode, linkId: string) {
    return runWithMerchantScope(this.#database, merchantId, mode, async (trx) => {
      const result = await trx
        .deleteFrom("payment_links")
        .where("id", "=", linkId)
        .where("merchant_id", "=", merchantId)
        .where("mode", "=", mode)
        .executeTakeFirst();

      if (!result || Number(result.numDeletedRows) === 0) {
        throw notFoundError("Payment link not found");
      }
    });
  }

  async getPaymentLinkPublic(slug: string): Promise<PaymentLinkPublicView> {
    const row = await runWithSystemScope(
      this.#database,
      "load public payment link",
      async (trx) =>
        trx
          .selectFrom("payment_links as payment_link")
          .innerJoin("merchants as merchant", (join) =>
            join
              .onRef("merchant.id", "=", "payment_link.merchant_id")
              .onRef("merchant.mode", "=", "payment_link.mode")
          )
          .select([
            "payment_link.active as active",
            "payment_link.amount as amount",
            "payment_link.amount_mode as amount_mode",
            "payment_link.created_at as created_at",
            "payment_link.currency as currency",
            "payment_link.description as description",
            "payment_link.id as id",
            "payment_link.merchant_id as merchant_id",
            "payment_link.min_amount as min_amount",
            "payment_link.mode as mode",
            "payment_link.reusable as reusable",
            "payment_link.slug as slug",
            "payment_link.title as title",
            "payment_link.updated_at as updated_at",
            "merchant.legal_name as merchant_display_name"
          ])
          .where("payment_link.slug", "=", slug)
          .where("payment_link.active", "=", true)
          .executeTakeFirst(),
      { audit: false }
    );

    if (!row) {
      throw notFoundError("Payment link not found");
    }

    const link = mapPaymentLink(row);
    return {
      active: link.active,
      amount: link.amount,
      amountMode: link.amountMode,
      currency: link.currency,
      description: link.description,
      merchant: {
        displayName: row.merchant_display_name
      },
      reusable: link.reusable,
      slug: link.slug,
      title: link.title,
      mode: link.mode
    };
  }

  async createSessionFromPaymentLink(input: {
    amount: bigint | null;
    cancelUrl: string | null;
    customer: CheckoutSessionCustomer;
    slug: string;
    successUrl: string | null;
  }): Promise<CheckoutSessionRecord> {
    const link = await runWithSystemScope(
      this.#database,
      "load payment link for session creation",
      async (trx) =>
        trx
          .selectFrom("payment_links")
          .selectAll()
          .where("slug", "=", input.slug)
          .where("active", "=", true)
          .executeTakeFirst(),
      { audit: false }
    );

    if (!link) {
      throw notFoundError("Payment link not found");
    }

    const paymentLink = mapPaymentLink(link);

    if (!paymentLink.reusable) {
      const existingSession = await runWithSystemScope(
        this.#database,
        "check payment link reuse",
        async (trx) =>
          trx
            .selectFrom("checkout_sessions")
            .select("id")
            .where("payment_link_id", "=", paymentLink.id)
            .limit(1)
            .executeTakeFirst(),
        { audit: false }
      );

      if (existingSession) {
        throw new ApiRouteError({
          code: "validation_error",
          field: "slug",
          message: "This payment link has already been used.",
          statusCode: getErrorDefinition("validation_error").status
        });
      }
    }

    const amount =
      paymentLink.amountMode === "fixed"
        ? paymentLink.amount
        : input.amount;

    if (amount === null) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "amount",
        message: "An amount is required for this payment link.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    if (
      paymentLink.amountMode === "customer_entered" &&
      paymentLink.minAmount !== null &&
      amount < paymentLink.minAmount
    ) {
      throw new ApiRouteError({
        code: "amount_too_small",
        field: "amount",
        message: getErrorDefinition("amount_too_small").message,
        statusCode: getErrorDefinition("amount_too_small").status
      });
    }

    return this.createSession({
      allowedMethods: ["mobile_money", "card"],
      amount,
      cancelUrl: input.cancelUrl,
      currency: paymentLink.currency,
      customer: input.customer,
      description: paymentLink.description,
      merchantId: paymentLink.merchantId,
      mode: paymentLink.mode,
      paymentLinkId: paymentLink.id,
      reference: null,
      successUrl: input.successUrl
    });
  }

  async getSessionForPaymentLink(slug: string, sessionId: string): Promise<CheckoutSessionView> {
    return runWithSystemScope(
      this.#database,
      "load checkout session for payment link",
      async (trx) => {
        const session = await this.#loadLinkedSessionForUpdate(trx, slug, sessionId);
        const synced = await this.#syncSessionState(trx, session);
        return this.#buildSessionView(trx, synced);
      },
      { audit: false }
    );
  }

  async submitSessionPaymentForPaymentLink(input: {
    baseUrl: string | null;
    idempotencyKey: string | null;
    method: CheckoutMethod;
    network: string | null;
    phone: string | null;
    requestId: string;
    sessionUrl: string | null;
    sessionId: string;
    slug: string;
  }): Promise<CheckoutSessionView> {
    return runWithSystemScope(
      this.#database,
      "submit checkout payment from payment link",
      async (trx) => {
        const session = await this.#loadLinkedSessionForUpdate(
          trx,
          input.slug,
          input.sessionId
        );
        const synced = await this.#syncSessionState(trx, session);
        this.#assertSessionOpen(synced);
        this.#assertMethodAllowed(synced, input.method);

        const existingCollection = await this.#loadLinkedCollection(trx, synced.collectionId);
        if (
          existingCollection &&
          ["pending", "processing"].includes(existingCollection.status)
        ) {
          return this.#buildSessionView(trx, synced);
        }

        const collection = await this.#collectionService.create({
          amountMinor: synced.amount,
          baseUrl: input.baseUrl,
          cancelUrl: synced.cancelUrl,
          currency: synced.currency,
          customerEmail: synced.customer.email ?? null,
          customerName: synced.customer.name ?? null,
          description: synced.description,
          idempotencyKey: input.idempotencyKey,
          merchantId: synced.merchantId,
          metadata: {
            checkout_session_id: synced.id,
            payment_link_slug: input.slug
          },
          method: input.method,
          mode: synced.mode,
          network: input.method === "mobile_money" ? input.network : null,
          phone: input.method === "mobile_money" ? input.phone : null,
          returnUrl: input.sessionUrl,
          reference: null,
          requestId: input.requestId
        });

        const updated = await trx
          .updateTable("checkout_sessions")
          .set({
            collection_id: collection.id,
            status: collection.status === "successful" ? "completed" : synced.status
          })
          .where("id", "=", synced.id)
          .returningAll()
          .executeTakeFirstOrThrow();

        return this.#buildSessionView(trx, mapCheckoutSession(updated));
      },
      { audit: false }
    );
  }

  async #buildSessionView(
    trx: ScopedTransaction,
    session: CheckoutSessionRecord
  ): Promise<CheckoutSessionView> {
    const merchant = await trx
      .selectFrom("merchants")
      .select(["id", "legal_name"])
      .where("id", "=", session.merchantId)
      .executeTakeFirstOrThrow();

    const collection = await this.#loadLinkedCollection(trx, session.collectionId);

    return {
      amount: session.amount,
      allowedMethods: session.allowedMethods,
      cancelUrl: session.cancelUrl,
      collection: collection
        ? {
            card:
              collection.card_brand || collection.card_last4 || collection.card_exp_month || collection.card_exp_year
                ? {
                    brand: collection.card_brand,
                    expiryMonth: collection.card_exp_month,
                    expiryYear: collection.card_exp_year,
                    last4: collection.card_last4
                  }
                : null,
            failureCode: collection.failure_code,
            failureMessage: collection.failure_message,
            id: collection.id,
            method: parseCollectionMethod(collection.method),
            network: collection.network,
            nextAction: parseCollectionNextAction(collection.provider_session),
            phone: collection.phone,
            providerRef: collection.provider_ref,
            status: collection.status
          }
        : null,
      currency: session.currency,
      customer: session.customer,
      description: session.description,
      expiresAt: session.expiresAt,
      id: session.id,
      merchant: {
        displayName: merchant.legal_name,
        id: merchant.id
      },
      mode: session.mode,
      reference: session.reference,
      status: session.status,
      successUrl: session.successUrl
    };
  }

  async #syncSessionState(
    trx: ScopedTransaction,
    session: CheckoutSessionRecord
  ): Promise<CheckoutSessionRecord> {
    let nextStatus: CheckoutSessionStatus = session.status;

    const collection = await this.#loadLinkedCollection(trx, session.collectionId);

    if (collection?.status === "successful") {
      nextStatus = "completed";
    } else if (session.expiresAt <= new Date()) {
      nextStatus = "expired";
    }

    if (nextStatus === session.status) {
      return session;
    }

    const updated = await trx
      .updateTable("checkout_sessions")
      .set({ status: nextStatus })
      .where("id", "=", session.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapCheckoutSession(updated);
  }

  async #loadSessionForUpdate(
    trx: ScopedTransaction,
    sessionId: string
  ): Promise<CheckoutSessionRecord> {
    const row = await trx
      .selectFrom("checkout_sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .forUpdate()
      .executeTakeFirst();

    if (!row) {
      throw notFoundError("Checkout session not found");
    }

    return mapCheckoutSession(row);
  }

  async #loadLinkedSessionForUpdate(
    trx: ScopedTransaction,
    slug: string,
    sessionId: string
  ): Promise<CheckoutSessionRecord> {
    const row = await trx
      .selectFrom("checkout_sessions as session")
      .innerJoin("payment_links as link", "link.id", "session.payment_link_id")
      .select([
        "session.allowed_methods",
        "session.amount",
        "session.cancel_url",
        "session.collection_id",
        "session.created_at",
        "session.currency",
        "session.customer",
        "session.description",
        "session.expires_at",
        "session.id",
        "session.merchant_id",
        "session.mode",
        "session.payment_link_id",
        "session.reference",
        "session.status",
        "session.success_url"
      ])
      .where("session.id", "=", sessionId)
      .where("link.slug", "=", slug)
      .forUpdate()
      .executeTakeFirst();

    if (!row) {
      throw notFoundError("Checkout session not found");
    }

    return mapCheckoutSession(row);
  }

  async #loadLinkedCollection(trx: ScopedTransaction, collectionId: string | null) {
    if (!collectionId) {
      return null;
    }

    return trx
      .selectFrom("collections")
      .select([
        "card_brand",
        "card_exp_month",
        "card_exp_year",
        "card_last4",
        "failure_code",
        "failure_message",
        "id",
        "method",
        "network",
        "phone",
        "provider_session",
        "provider_ref",
        "status"
      ])
      .where("id", "=", collectionId)
      .executeTakeFirst();
  }

  #assertMethodAllowed(session: CheckoutSessionRecord, method: CheckoutMethod) {
    if (!session.allowedMethods.includes(method)) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "method",
        message: "This payment method is not allowed for the checkout session.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }
  }

  #assertSessionOpen(session: CheckoutSessionRecord) {
    if (session.status === "expired") {
      throw new ApiRouteError({
        code: "validation_error",
        field: "session_id",
        message: "This checkout session has expired.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    if (session.status === "completed") {
      throw new ApiRouteError({
        code: "validation_error",
        field: "session_id",
        message: "This checkout session has already been completed.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }
  }

  async #assertPaymentLinkSlugAvailable(trx: ScopedTransaction, slug: string) {
    const existing = await trx
      .selectFrom("payment_links")
      .select("id")
      .where("slug", "=", slug)
      .executeTakeFirst();

    if (existing) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "slug",
        message: "That payment-link slug is already in use.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }
  }

  async #ensureMerchantCanCreateCheckout(
    trx: ScopedTransaction,
    merchantId: string,
    mode: RpMode
  ) {
    const merchant = await trx
      .selectFrom("merchants")
      .select(["collections_frozen", "id", "status"])
      .where("id", "=", merchantId)
      .executeTakeFirst();

    if (!merchant) {
      throw notFoundError("Merchant not found");
    }

    if (!merchantCanTransact({ mode, status: merchant.status })) {
      throw new ApiRouteError({
        code: "merchant_suspended",
        message: getErrorDefinition("merchant_suspended").message,
        statusCode: getErrorDefinition("merchant_suspended").status
      });
    }

    if (merchant.collections_frozen) {
      throw new ApiRouteError({
        code: "collections_frozen",
        message: getErrorDefinition("collections_frozen").message,
        statusCode: getErrorDefinition("collections_frozen").status
      });
    }
  }
}

function normalizeCheckoutCustomer(input: CheckoutSessionCustomer): Json {
  return {
    ...(input.email ? { email: input.email } : {}),
    ...(input.name ? { name: input.name } : {})
  };
}

function assertPaymentLinkAmountShape(
  amountMode: PaymentLinkRecord["amountMode"],
  amount: bigint | null,
  minAmount: bigint | null
) {
  if (amountMode === "fixed") {
    if (amount === null || amount <= 0n || minAmount !== null) {
      throw new ApiRouteError({
        code: "validation_error",
        field: "amount",
        message: "Fixed payment links require a positive fixed amount and no minimum amount.",
        statusCode: getErrorDefinition("validation_error").status
      });
    }

    return;
  }

  if (amount !== null || minAmount === null || minAmount <= 0n) {
    throw new ApiRouteError({
      code: "validation_error",
      field: "min_amount",
      message: "Customer-entered payment links require a positive minimum amount.",
      statusCode: getErrorDefinition("validation_error").status
    });
  }
}

function mapCheckoutSession(row: {
  allowed_methods: CheckoutMethod[] | string;
  amount: string;
  cancel_url: string | null;
  collection_id: string | null;
  created_at: Date;
  currency: string;
  customer: Json;
  description: string | null;
  expires_at: Date;
  id: string;
  merchant_id: string;
  mode: RpMode;
  payment_link_id: string | null;
  reference: string | null;
  status: CheckoutSessionStatus;
  success_url: string | null;
}): CheckoutSessionRecord {
  return {
    allowedMethods: parseCheckoutMethods(row.allowed_methods),
    amount: BigInt(row.amount),
    cancelUrl: row.cancel_url,
    collectionId: row.collection_id,
    createdAt: row.created_at,
    currency: parseCurrencyCode(row.currency),
    customer: parseCheckoutCustomer(row.customer),
    description: row.description,
    expiresAt: row.expires_at,
    id: row.id,
    merchantId: row.merchant_id,
    mode: row.mode,
    paymentLinkId: row.payment_link_id,
    reference: row.reference,
    status: row.status,
    successUrl: row.success_url
  };
}

function mapPaymentLink(row: {
  active: boolean;
  amount: string | null;
  amount_mode: PaymentLinkRecord["amountMode"];
  created_at: Date;
  currency: string;
  description: string | null;
  id: string;
  merchant_id: string;
  min_amount: string | null;
  mode: RpMode;
  reusable: boolean;
  slug: string;
  title: string;
  updated_at: Date;
}): PaymentLinkRecord {
  return {
    active: row.active,
    amount: bigintOrNull(row.amount),
    amountMode: row.amount_mode,
    createdAt: row.created_at,
    currency: parseCurrencyCode(row.currency),
    description: row.description,
    id: row.id,
    merchantId: row.merchant_id,
    minAmount: bigintOrNull(row.min_amount),
    mode: row.mode,
    reusable: row.reusable,
    slug: row.slug,
    title: row.title,
    updatedAt: row.updated_at
  };
}

function bigintOrNull(value: string | null) {
  return value === null ? null : BigInt(value);
}

function parseCollectionNextAction(value: Json) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (raw.type === "hosted_fields" && typeof raw.iframe_url === "string") {
    return {
      iframeUrl: raw.iframe_url,
      type: "hosted_fields" as const
    };
  }

  if (raw.type === "redirect_url" && typeof raw.url === "string") {
    return {
      type: "redirect_url" as const,
      url: raw.url
    };
  }

  return null;
}

function parseCollectionMethod(value: string): "card" | "mobile_money" {
  if (value === "card" || value === "mobile_money") {
    return value;
  }

  throw new Error(`Unsupported checkout collection method: ${value}`);
}

function parseCheckoutMethods(value: CheckoutMethod[] | string): CheckoutMethod[] {
  if (Array.isArray(value)) {
    return value;
  }

  return value
    .replace(/^\{/, "")
    .replace(/\}$/, "")
    .split(",")
    .map((entry) => entry.replace(/^"/, "").replace(/"$/, "").trim())
    .filter((entry): entry is CheckoutMethod => entry === "mobile_money" || entry === "card");
}

function notFoundError(message: string) {
  return new ApiRouteError({
    code: "not_found",
    message,
    statusCode: getErrorDefinition("not_found").status
  });
}
