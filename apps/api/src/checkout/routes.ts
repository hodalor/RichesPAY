import { createHash } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { formatMoney, getErrorDefinition } from "@richespay/shared";

import { runWithMerchantScope } from "../db";
import type { Json, RpMode } from "../db/types";
import { ApiRouteError } from "../lib/api-error";
import { requireIdempotency } from "../public-api/idempotency";
import { parseApiKey } from "../public-api/api-keys";
import { inferCheckoutMethod } from "../public-api/request-shape";
import { publicCheckoutPlugin } from "../plugins/public-checkout";
import { pricingCurrencies } from "../pricing/types";
import type { FastifyTypedInstance } from "../types";
import { CheckoutService } from "./service";
import {
  checkoutMethods,
  paymentLinkAmountModes,
  type CheckoutSessionView,
  type PaymentLinkRecord
} from "./types";

const customerSchema = z
  .object({
    email: z.string().email().optional(),
    name: z.string().min(1).optional()
  })
  .optional();

const paymentLinkParamsSchema = z.object({
  slug: z.string().min(1)
});

const checkoutSessionParamsSchema = z.object({
  id: z.string().min(1)
});

const paymentLinkSessionParamsSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1)
});

const paymentLinkSessionCreateBodySchema = z.object({
  amount: z.coerce.number().int().positive().optional(),
  cancel_url: z.string().url().optional(),
  customer: customerSchema,
  success_url: z.string().url().optional()
});

const hostedCheckoutSessionCreateBodySchema = z.object({
  allowed_methods: z
    .array(z.enum(checkoutMethods))
    .min(1)
    .describe("Methods the customer may use, for example [\"mobile_money\"] or [\"mobile_money\",\"card\"]."),
  amount: z.coerce
    .number()
    .int()
    .positive()
    .describe("Integer minor units. 5000 with currency GHS is GHS 50.00."),
  cancel_url: z.string().url().optional(),
  currency: z.enum(pricingCurrencies).describe("GHS or ZMW."),
  customer: customerSchema,
  description: z.string().max(500).optional(),
  reference: z.string().min(1).max(128).optional().describe("Your order id."),
  success_url: z.string().url().optional()
});

const checkoutPayBodySchema = z.object({
  method: z.enum(checkoutMethods).optional(),
  network: z.string().min(1).optional(),
  phone: z.string().min(4).optional()
});

const checkoutSessionResponseSchema = z.object({
  allowed_methods: z.array(z.enum(checkoutMethods)),
  amount: z.number().int(),
  amount_formatted: z.string(),
  cancel_url: z.string().nullable(),
  collection: z
    .object({
      card: z
        .object({
          brand: z.string().nullable(),
          expiry_month: z.number().int().nullable(),
          expiry_year: z.number().int().nullable(),
          last4: z.string().nullable()
        })
        .nullable(),
      failure_code: z.string().nullable(),
      failure_message: z.string().nullable(),
      id: z.string(),
      method: z.enum(checkoutMethods),
      network: z.string().nullable(),
      next_action: z
        .object({
          iframe_url: z.string().url().optional(),
          type: z.enum(["hosted_fields", "redirect_url"]),
          url: z.string().url().optional()
        })
        .nullable(),
      phone: z.string().nullable(),
      provider_ref: z.string().nullable(),
      status: z.string()
    })
    .nullable(),
  currency: z.enum(pricingCurrencies),
  customer: z.object({
    email: z.string().email().nullable(),
    name: z.string().nullable()
  }),
  description: z.string().nullable(),
  expires_at: z.string().datetime(),
  id: z.string(),
  merchant: z.object({
    display_name: z.string(),
    id: z.string()
  }),
  mode: z.enum(["test", "live"]),
  reference: z.string().nullable(),
  status: z.enum(["open", "completed", "expired"]),
  success_url: z.string().nullable()
});

export async function registerCheckoutRoutes(app: FastifyTypedInstance) {
  const checkoutService = new CheckoutService({
    database: app.db,
    encryptionKey: app.appEnv.ENCRYPTION_KEY
  });

  app.get(
    "/checkout/payment-links/:slug",
    {
      schema: {
        params: z.object({
          slug: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: z.object({
              active: z.boolean(),
              amount: z.number().int().nullable(),
              amount_mode: z.enum(paymentLinkAmountModes),
              amount_formatted: z.string().nullable(),
              currency: z.enum(pricingCurrencies),
              description: z.string().nullable(),
              merchant: z.object({
                display_name: z.string()
              }),
              mode: z.enum(["test", "live"]),
              reusable: z.boolean(),
              slug: z.string(),
              title: z.string()
            })
          })
        }
      }
    },
    async (request) => {
      const params = paymentLinkParamsSchema.parse(request.params);
      const link = await checkoutService.getPaymentLinkPublic(params.slug);

      return {
        data: serializePaymentLinkPublic(link)
      };
    }
  );

  app.post(
    "/checkout/payment-links/:slug/sessions",
    {
      schema: {
        body: paymentLinkSessionCreateBodySchema,
        params: paymentLinkParamsSchema,
        response: {
          201: z.object({
            data: z.object({
              id: z.string(),
              url: z.string().url()
            })
          })
        }
      }
    },
    async (request, reply) => {
      const body = paymentLinkSessionCreateBodySchema.parse(request.body);
      const params = paymentLinkParamsSchema.parse(request.params);

      const session = await checkoutService.createSessionFromPaymentLink({
        amount: body.amount === undefined ? null : BigInt(body.amount),
        cancelUrl: body.cancel_url ?? null,
        customer: {
          email: body.customer?.email ?? null,
          name: body.customer?.name ?? null
        },
        slug: params.slug,
        successUrl: body.success_url ?? null
      });

      return reply.status(201).send({
        data: {
          id: session.id,
          url: `${app.appEnv.CHECKOUT_ORIGIN}/link/${params.slug}?session_id=${encodeURIComponent(session.id)}`
        }
      });
    }
  );

  app.get(
    "/checkout/payment-links/:slug/sessions/:id",
    {
      schema: {
        params: paymentLinkSessionParamsSchema,
        response: {
          200: z.object({
            data: checkoutSessionResponseSchema
          })
        }
      }
    },
    async (request) => {
      const params = paymentLinkSessionParamsSchema.parse(request.params);
      const session = await checkoutService.getSessionForPaymentLink(params.slug, params.id);

      return {
        data: serializeCheckoutSession(session)
      };
    }
  );

  app.post(
    "/checkout/payment-links/:slug/sessions/:id/pay",
    {
      schema: {
        body: checkoutPayBodySchema,
        params: paymentLinkSessionParamsSchema,
        response: {
          200: z.object({
            data: checkoutSessionResponseSchema
          })
        }
      }
    },
    async (request, reply) => {
      const body = checkoutPayBodySchema.parse(request.body);
      const params = paymentLinkSessionParamsSchema.parse(request.params);
      const method = inferCheckoutMethod({
        method: body.method,
        phone: body.phone
      });
      const session = await checkoutService.getSessionForPaymentLink(params.slug, params.id);
      const idempotencyState = await beginPaymentLinkIdempotency(app, {
        body,
        merchantId: session.merchant.id,
        mode: session.mode,
        request,
        reply
      });

      if (!idempotencyState) {
        return;
      }

      const updatedSession = await checkoutService.submitSessionPaymentForPaymentLink({
        baseUrl: getRequestBaseUrl(request),
        idempotencyKey: idempotencyState.key,
        method,
        network: body.network ?? null,
        phone: body.phone ?? null,
        requestId: request.id,
        sessionUrl: `${app.appEnv.CHECKOUT_ORIGIN}/link/${params.slug}?session_id=${encodeURIComponent(params.id)}`,
        sessionId: params.id,
        slug: params.slug
      });

      const responseBody = {
        data: serializeCheckoutSession(updatedSession)
      } satisfies { data: ReturnType<typeof serializeCheckoutSession> };

      await finalizePaymentLinkIdempotency(app, idempotencyState, 200, responseBody);

      return responseBody;
    }
  );

  await app.register(async (checkoutApp) => {
    await checkoutApp.register(publicCheckoutPlugin);

    checkoutApp.post(
      "/checkout/sessions",
      {
        schema: {
          body: hostedCheckoutSessionCreateBodySchema,
          description:
            "Creates a hosted checkout session. Use a public key (rp_test_pk_... or rp_live_pk_...), not a secret key. Redirect the customer to data.url.\n\nExample request: { \"allowed_methods\": [\"mobile_money\"], \"amount\": 5000, \"currency\": \"GHS\", \"description\": \"Order 1001\", \"reference\": \"ORDER-1001\" }\n\nExample response: { \"data\": { \"id\": \"cs_...\", \"url\": \"https://checkout.richespay.com/session/cs_...?key=rp_test_pk_...\" } }\n\nPayment links are created in the dashboard. Customers open /link/{slug}. In test mode there is no phone prompt; use a number ending in 0001.",
          response: {
            201: z.object({
              data: z.object({
                id: z.string(),
                url: z.string().url()
              })
            })
          },
          summary: "Create a hosted checkout session",
          tags: ["Checkout"]
        }
      },
      async (request, reply) => {
        const body = hostedCheckoutSessionCreateBodySchema.parse(request.body);
        request.assertApiKeyScope("collections");
        request.assertApiKeyScope("read");

        const session = await checkoutService.createSession({
          allowedMethods: body.allowed_methods,
          amount: BigInt(body.amount),
          cancelUrl: body.cancel_url ?? null,
          currency: body.currency,
          customer: {
            email: body.customer?.email ?? null,
            name: body.customer?.name ?? null
          },
          description: body.description ?? null,
          merchantId: request.publicApiKey!.merchantId,
          mode: request.publicApiKey!.mode,
          reference: body.reference ?? null,
          successUrl: body.success_url ?? null
        });

        const rawKey = parseApiKey(request.headers.authorization)?.value;
        if (!rawKey) {
          throw new Error("Expected a public key for checkout session creation");
        }

        return reply.status(201).send({
          data: {
            id: session.id,
            url: `${app.appEnv.CHECKOUT_ORIGIN}/session/${session.id}?key=${encodeURIComponent(rawKey)}`
          }
        });
      }
    );

    checkoutApp.get(
      "/checkout/sessions/:id",
      {
        schema: {
          params: checkoutSessionParamsSchema,
          response: {
            200: z.object({
              data: checkoutSessionResponseSchema
            })
          }
        }
      },
      async (request) => {
        const params = checkoutSessionParamsSchema.parse(request.params);
        request.assertApiKeyScope("read");

        const session = await checkoutService.getSessionForMerchant(
          request.publicApiKey!.merchantId,
          request.publicApiKey!.mode,
          params.id
        );

        return {
          data: serializeCheckoutSession(session)
        };
      }
    );

    checkoutApp.post(
      "/checkout/sessions/:id/pay",
      {
        preHandler: [requireIdempotency()],
        schema: {
          body: checkoutPayBodySchema,
          params: checkoutSessionParamsSchema,
          response: {
            200: z.object({
              data: checkoutSessionResponseSchema
            })
          }
        }
      },
      async (request) => {
        const body = checkoutPayBodySchema.parse(request.body);
        const params = checkoutSessionParamsSchema.parse(request.params);
        request.assertApiKeyScope("collections");
        const method = inferCheckoutMethod({
          method: body.method,
          phone: body.phone
        });

        const session = await checkoutService.submitSessionPaymentForMerchant({
          baseUrl: getRequestBaseUrl(request),
          idempotencyKey: request.idempotencyState?.key ?? null,
          method,
          merchantId: request.publicApiKey!.merchantId,
          mode: request.publicApiKey!.mode,
          network: body.network ?? null,
          phone: body.phone ?? null,
          requestId: request.id,
          sessionUrl: `${app.appEnv.CHECKOUT_ORIGIN}/session/${params.id}?key=${encodeURIComponent(parseApiKey(request.headers.authorization)?.value ?? "")}`,
          sessionId: params.id
        });

        return {
          data: serializeCheckoutSession(session)
        };
      }
    );
  });
}

function serializeCheckoutSession(session: CheckoutSessionView) {
  return {
    allowed_methods: session.allowedMethods,
    amount: Number(session.amount),
    amount_formatted: formatMoney(session.amount, session.currency, "en-US"),
    cancel_url: session.cancelUrl,
    collection: session.collection
      ? {
          card: session.collection.card
            ? {
                brand: session.collection.card.brand,
                expiry_month: session.collection.card.expiryMonth,
                expiry_year: session.collection.card.expiryYear,
                last4: session.collection.card.last4
              }
            : null,
          failure_code: session.collection.failureCode,
          failure_message: session.collection.failureMessage,
          id: session.collection.id,
          method: session.collection.method,
          network: session.collection.network,
          next_action: session.collection.nextAction
            ? {
                ...(session.collection.nextAction.iframeUrl
                  ? { iframe_url: session.collection.nextAction.iframeUrl }
                  : {}),
                type: session.collection.nextAction.type,
                ...(session.collection.nextAction.url
                  ? { url: session.collection.nextAction.url }
                  : {})
              }
            : null,
          phone: session.collection.phone,
          provider_ref: session.collection.providerRef,
          status: session.collection.status
        }
      : null,
    currency: session.currency,
    customer: {
      email: session.customer.email ?? null,
      name: session.customer.name ?? null
    },
    description: session.description,
    expires_at: session.expiresAt.toISOString(),
    id: session.id,
    merchant: {
      display_name: session.merchant.displayName,
      id: session.merchant.id
    },
    mode: session.mode,
    reference: session.reference,
    status: session.status,
    success_url: session.successUrl
  };
}

function serializePaymentLinkPublic(link: {
  active: boolean;
  amount: bigint | null;
  amountMode: PaymentLinkRecord["amountMode"];
  currency: PaymentLinkRecord["currency"];
  description: string | null;
  merchant: {
    displayName: string;
  };
  mode: RpMode;
  reusable: boolean;
  slug: string;
  title: string;
}) {
  return {
    active: link.active,
    amount: link.amount === null ? null : Number(link.amount),
    amount_mode: link.amountMode,
    amount_formatted:
      link.amount === null ? null : formatMoney(link.amount, link.currency, "en-US"),
    currency: link.currency,
    description: link.description,
    merchant: {
      display_name: link.merchant.displayName
    },
    mode: link.mode,
    reusable: link.reusable,
    slug: link.slug,
    title: link.title
  };
}

async function beginPaymentLinkIdempotency(
  app: FastifyTypedInstance,
  input: {
    body: z.infer<typeof checkoutPayBodySchema>;
    merchantId: string;
    mode: RpMode;
    reply: FastifyReply;
    request: FastifyRequest;
  }
) {
  const headerValue = input.request.headers["idempotency-key"];
  if (typeof headerValue !== "string" || headerValue.trim() === "") {
    throw new ApiRouteError({
      code: "validation_error",
      field: "idempotency-key",
      message: "Idempotency-Key is required",
      statusCode: getErrorDefinition("validation_error").status
    });
  }

  const key = headerValue.trim();
  const requestHash = hashRequestFingerprint({
    body: input.body,
    method: input.request.method,
    path: input.request.routeOptions.url ?? input.request.url,
    query: input.request.query
  });

  const existing = await runWithMerchantScope(
    app.db,
    input.merchantId,
    input.mode,
    async (trx) =>
      trx
        .selectFrom("idempotency_keys")
        .selectAll()
        .where("merchant_id", "=", input.merchantId)
        .where("mode", "=", input.mode)
        .where("key", "=", key)
        .executeTakeFirst()
  );

  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw idempotencyConflict("idempotency_conflict");
    }

    if (existing.status === "in_progress") {
      throw idempotencyConflict("request_in_progress");
    }

    return input.reply
      .status(existing.response_status ?? 200)
      .send(existing.response_body ?? {});
  }

  await runWithMerchantScope(app.db, input.merchantId, input.mode, async (trx) => {
    await trx
      .insertInto("idempotency_keys")
      .values({
        key,
        merchant_id: input.merchantId,
        mode: input.mode,
        request_hash: requestHash,
        response_body: null,
        response_status: null,
        status: "in_progress"
      })
      .execute();
  });

  return {
    key,
    merchantId: input.merchantId,
    mode: input.mode
  };
}

async function finalizePaymentLinkIdempotency(
  app: FastifyTypedInstance,
  state: {
    key: string;
    merchantId: string;
    mode: RpMode;
  },
  statusCode: number,
  responseBody: Json
) {
  await runWithMerchantScope(app.db, state.merchantId, state.mode, async (trx) => {
    await trx
      .updateTable("idempotency_keys")
      .set({
        response_body: responseBody,
        response_status: statusCode,
        status: "completed"
      })
      .where("merchant_id", "=", state.merchantId)
      .where("mode", "=", state.mode)
      .where("key", "=", state.key)
      .execute();
  });
}

function idempotencyConflict(code: "idempotency_conflict" | "request_in_progress") {
  const definition = getErrorDefinition(code);
  return new ApiRouteError({
    code,
    message: definition.message,
    statusCode: definition.status
  });
}

function hashRequestFingerprint(input: {
  body: unknown;
  method: string;
  path: string;
  query: unknown;
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        body: input.body ?? null,
        method: input.method,
        path: input.path,
        query: input.query ?? null
      })
    )
    .digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForHash(value));
}

function normalizeForHash(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value ?? null;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForHash(entry));
  }

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((accumulator, key) => {
      accumulator[key] = normalizeForHash((value as Record<string, unknown>)[key]);
      return accumulator;
    }, {});
}

function getRequestBaseUrl(request: FastifyRequest) {
  const protocol = request.protocol ?? "http";
  const host = request.headers.host;
  if (!host) {
    return null;
  }

  return `${protocol}://${host}`;
}
