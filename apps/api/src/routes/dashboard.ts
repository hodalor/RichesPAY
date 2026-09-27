import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import {
  apiKeyKinds,
  apiKeyScopes,
  newId,
  settlementCurrencyForCountry,
  type ApiKeyKind,
  type ApiKeyScope,
  type MerchantRole
} from "@richespay/shared";

import { authenticateSupabaseSession } from "../auth/session";
import { registerCheckoutDashboardRoutes } from "../checkout";
import { ComplianceService } from "../compliance";
import { registerMerchantDashboardRoutes } from "../dashboard/merchant-routes";
import { registerPayoutDashboardRoutes } from "../payouts";
import { registerSmsDashboardRoutes } from "../sms";
import { registerSettlementDashboardRoutes } from "../settlements";
import { registerTopupDashboardRoutes } from "../topups";
import { registerWebhookDashboardRoutes } from "../webhooks";
import { createSupabaseServiceClient } from "../auth/supabase-client";
import { runWithSystemScope, type ScopedTransaction } from "../db";
import { dashboardAuthPlugin } from "../plugins/dashboard-auth";
import { ApiRouteError } from "../lib/api-error";
import {
  createPlainApiKey,
  getApiKeyLast4,
  getApiKeyPrefix,
  hashApiKey
} from "../public-api/api-keys";

import type { FastifyTypedInstance } from "../types";

const signUpBodySchema = z.object({
  business_name: z.string().min(1),
  country_code: z.string().length(2),
  email: z.string().email(),
  full_name: z.string().min(1),
  password: z.string().min(8)
});

const switchMerchantBodySchema = z.object({
  merchant_id: z.string().min(1)
});

const acceptInviteBodySchema = z.object({
  token: z.string().min(1)
});

const inviteBodySchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "admin", "finance", "developer", "support", "viewer"])
});

const updateRoleBodySchema = z.object({
  role: z.enum(["owner", "admin", "finance", "developer", "support", "viewer"])
});

const createApiKeyBodySchema = z.object({
  expires_at: z.string().datetime().optional(),
  ip_allowlist: z.array(z.string().min(1)).optional(),
  kind: z.enum(apiKeyKinds),
  mode: z.enum(["test", "live"]).optional(),
  name: z.string().min(1),
  scopes: z.array(z.enum(apiKeyScopes)).min(1)
});

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const apiRequestLogQuerySchema = z.object({
  end_date: dateOnlySchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  start_date: dateOnlySchema.optional(),
  status_class: z.enum(["2xx", "4xx", "5xx"]).optional()
});

const eventsOutboxQuerySchema = z.object({
  end_date: dateOnlySchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  start_date: dateOnlySchema.optional(),
  type: z.string().min(1).optional()
});

async function requireSession(
  app: FastifyTypedInstance,
  authorizationHeader: string | undefined
) {
  return authenticateSupabaseSession(
    app.db,
    {
      anonKey: app.appEnv.SUPABASE_ANON_KEY,
      jwtSecret: app.appEnv.SUPABASE_JWT_SECRET,
      supabaseUrl: app.appEnv.SUPABASE_URL
    },
    authorizationHeader
  );
}

function makeDateRange(input: {
  endDate?: string | undefined;
  startDate?: string | undefined;
}) {
  const next: {
    endDate?: Date;
    startDate?: Date;
  } = {};

  if (input.startDate) {
    next.startDate = new Date(`${input.startDate}T00:00:00.000Z`);
  }

  if (input.endDate) {
    next.endDate = new Date(`${input.endDate}T23:59:59.999Z`);
  }

  return next;
}

export async function registerDashboardRoutes(app: FastifyTypedInstance) {
  const complianceService = new ComplianceService({
    database: app.db
  });

  app.post(
    "/auth/sign-up",
    {
      schema: {
        body: signUpBodySchema,
        response: {
          201: z.object({
            data: z.object({
              merchant_id: z.string(),
              settlement_currency: z.enum(["GHS", "ZMW", "USD"]),
              user_id: z.string(),
              verification_required: z.boolean()
            })
          })
        }
      }
    },
    async (request, reply) => {
      const body = signUpBodySchema.parse(request.body);
      // Server-side Admin API avoids anon signup email rate limits and keeps
      // merchant provisioning tied to Auth user creation.
      const supabase = createSupabaseServiceClient(app.appEnv);
      const autoConfirmEmail = app.appEnv.APP_ENV !== "production";

      const { data, error } = await supabase.auth.admin.createUser({
        email: body.email,
        email_confirm: autoConfirmEmail,
        password: body.password,
        user_metadata: {
          full_name: body.full_name
        }
      });

      if (error || !data.user?.id) {
        throw new ApiRouteError({
          code: "validation_error",
          field: "email",
          message: error?.message ?? "Failed to create Supabase user",
          statusCode: 400
        });
      }

      const userId = data.user.id;
      const verificationRequired = !autoConfirmEmail;

      const merchant = await runWithSystemScope(
        app.db,
        "create merchant during dashboard signup",
        async (trx) => {
          const country = await trx
            .selectFrom("countries")
            .select(["code", "timezone"])
            .where("code", "=", body.country_code.toUpperCase())
            .where("enabled", "=", true)
            .executeTakeFirst();

          if (!country) {
            throw new ApiRouteError({
              code: "validation_error",
              field: "country_code",
              message: "Country is not available for onboarding",
              statusCode: 400
            });
          }

          await trx
            .insertInto("profiles")
            .values({
              full_name: body.full_name,
              phone: null,
              user_id: userId
            })
            .onConflict((conflict) =>
              conflict.column("user_id").doUpdateSet({
                full_name: body.full_name
              })
            )
            .execute();

          const insertedMerchant = await trx
            .insertInto("merchants")
            .values({
              collections_frozen: false,
              country_code: country.code,
              id: newId("mer_"),
              legal_name: body.business_name,
              mode: "live",
              payouts_frozen: false,
              settlement_currency: settlementCurrencyForCountry(country.code),
              status: "pending_kyb",
              timezone: country.timezone,
              trading_name: body.business_name
            })
            .returning(["id", "settlement_currency"])
            .executeTakeFirstOrThrow();

          await trx
            .insertInto("memberships")
            .values({
              merchant_id: insertedMerchant.id,
              mode: "live",
              role: "owner",
              user_id: userId
            })
            .execute();

          return insertedMerchant;
        },
        { audit: false }
      );

      await complianceService.screenMerchantOnboarding({
        countryCode: body.country_code.toUpperCase(),
        merchantId: merchant.id,
        merchantName: body.business_name,
        mode: "live"
      });

      return reply.status(201).send({
        data: {
          merchant_id: merchant.id,
          settlement_currency: merchant.settlement_currency as "GHS" | "USD" | "ZMW",
          user_id: userId,
          verification_required: verificationRequired
        }
      });
    }
  );

  app.get(
    "/auth/memberships",
    {
      schema: {
        response: {
          200: z.object({
            data: z.array(
              z.object({
                merchant_id: z.string(),
                merchant_name: z.string(),
                mode: z.enum(["test", "live"]),
                role: z.enum(["owner", "admin", "finance", "developer", "support", "viewer"]),
                settlement_currency: z.string(),
                timezone: z.string()
              })
            )
          })
        }
      }
    },
    async (request) => {
      const session = await requireSession(app, request.headers.authorization);
      const memberships = await runWithSystemScope(
        app.db,
        "list dashboard memberships",
        async (trx) =>
          trx
            .selectFrom("memberships as membership")
            .innerJoin("merchants as merchant", "merchant.id", "membership.merchant_id")
            .select([
              "membership.merchant_id as merchant_id",
              "membership.mode as mode",
              "membership.role as role",
              "merchant.legal_name as merchant_name",
              "merchant.settlement_currency as settlement_currency",
              "merchant.timezone as timezone"
            ])
            .where("membership.user_id", "=", session.userId)
            .orderBy("merchant.legal_name")
            .execute(),
        { audit: false }
      );

      return { data: memberships };
    }
  );

  app.post(
    "/auth/switch-merchant",
    {
      schema: {
        body: switchMerchantBodySchema,
        response: {
          200: z.object({
            data: z.object({
              merchant_id: z.string(),
              mode: z.enum(["test", "live"]),
              role: z.enum(["owner", "admin", "finance", "developer", "support", "viewer"])
            })
          })
        }
      }
    },
    async (request) => {
      const session = await requireSession(app, request.headers.authorization);
      const body = switchMerchantBodySchema.parse(request.body);

      const membership = await runWithSystemScope(
        app.db,
        "switch dashboard merchant",
        async (trx) =>
          trx
            .selectFrom("memberships")
            .select(["merchant_id", "mode", "role"])
            .where("merchant_id", "=", body.merchant_id)
            .where("user_id", "=", session.userId)
            .executeTakeFirst(),
        { audit: false }
      );

      if (!membership) {
        throw new ApiRouteError({
          code: "forbidden",
          message: "You do not belong to that merchant",
          statusCode: 403
        });
      }

      return { data: membership };
    }
  );

  app.get(
    "/auth/invitations/:token",
    {
      schema: {
        params: z.object({
          token: z.string().min(1)
        }),
        response: {
          200: z.object({
            data: z.object({
              email: z.string().email(),
              expires_at: z.string(),
              merchant_id: z.string(),
              role: z.enum(["owner", "admin", "finance", "developer", "support", "viewer"])
            })
          })
        }
      }
    },
    async (request) => {
      const { token } = request.params as { token: string };
      const tokenHash = hashInviteToken(token);

      const invitation = await runWithSystemScope(
        app.db,
        "load invitation preview",
        async (trx) =>
          trx
            .selectFrom("invitations")
            .select(["email", "expires_at", "merchant_id", "role"])
            .where("token_hash", "=", tokenHash)
            .executeTakeFirst(),
        { audit: false }
      );

      if (!invitation) {
        throw new ApiRouteError({
          code: "not_found",
          message: "Invitation not found",
          statusCode: 404
        });
      }

      return {
        data: {
          ...invitation,
          expires_at: invitation.expires_at.toISOString()
        }
      };
    }
  );

  app.post(
    "/auth/accept-invite",
    {
      schema: {
        body: acceptInviteBodySchema,
        response: {
          200: z.object({
            data: z.object({
              merchant_id: z.string(),
              mode: z.enum(["test", "live"]),
              role: z.enum(["owner", "admin", "finance", "developer", "support", "viewer"])
            })
          })
        }
      }
    },
    async (request) => {
      const session = await requireSession(app, request.headers.authorization);
      const body = acceptInviteBodySchema.parse(request.body);
      const tokenHash = hashInviteToken(body.token);

      const acceptedMembership = await runWithSystemScope(
        app.db,
        "accept dashboard invitation",
        async (trx) => {
          const invitation = await trx
            .selectFrom("invitations")
            .selectAll()
            .where("token_hash", "=", tokenHash)
            .executeTakeFirst();

          if (!invitation) {
            throw new ApiRouteError({
              code: "not_found",
              message: "Invitation not found",
              statusCode: 404
            });
          }

          if (invitation.accepted_at) {
            throw new ApiRouteError({
              code: "forbidden",
              message: "Invitation has already been accepted",
              statusCode: 403
            });
          }

          if (invitation.expires_at < new Date()) {
            throw new ApiRouteError({
              code: "forbidden",
              message: "Invitation has expired",
              statusCode: 403
            });
          }

          await trx
            .insertInto("memberships")
            .values({
              merchant_id: invitation.merchant_id,
              mode: invitation.mode,
              role: invitation.role,
              user_id: session.userId
            })
            .onConflict((conflict) =>
              conflict.columns(["merchant_id", "user_id"]).doUpdateSet({
                mode: invitation.mode,
                role: invitation.role
              })
            )
            .execute();

          await trx
            .updateTable("invitations")
            .set({ accepted_at: new Date() })
            .where("id", "=", invitation.id)
            .execute();

          return {
            merchant_id: invitation.merchant_id,
            mode: invitation.mode,
            role: invitation.role
          };
        },
        { audit: false }
      );

      return { data: acceptedMembership };
    }
  );

  await app.register(async (protectedApp) => {
    await protectedApp.register(dashboardAuthPlugin);
    await registerCheckoutDashboardRoutes(protectedApp);
    await registerMerchantDashboardRoutes(protectedApp);
    await registerPayoutDashboardRoutes(protectedApp);
    await registerSmsDashboardRoutes(protectedApp);
    await registerSettlementDashboardRoutes(protectedApp);
    await registerTopupDashboardRoutes(protectedApp);
    await registerWebhookDashboardRoutes(protectedApp);

    protectedApp.get(
      "/session",
      {
        schema: {
          response: {
            200: z.object({
              data: z.object({
                compliance: z.object({
                  collections_freeze_category: z.enum([
                    "regulatory",
                    "chargeback_risk",
                    "kyb_review",
                    "sanctions_screening",
                    "fraud_review",
                    "operations",
                    "other"
                  ]).nullable(),
                  collections_freeze_reason: z.string().nullable(),
                  collections_frozen: z.boolean(),
                  contact_link: z.string(),
                  payouts_freeze_category: z.enum([
                    "regulatory",
                    "chargeback_risk",
                    "kyb_review",
                    "sanctions_screening",
                    "fraud_review",
                    "operations",
                    "other"
                  ]).nullable(),
                  payouts_freeze_reason: z.string().nullable(),
                  payouts_frozen: z.boolean(),
                  status: z.string(),
                  suspension_category: z.enum([
                    "regulatory",
                    "chargeback_risk",
                    "kyb_review",
                    "sanctions_screening",
                    "fraud_review",
                    "operations",
                    "other"
                  ]).nullable(),
                  suspension_reason: z.string().nullable()
                }),
                email: z.string().nullable(),
                active_products: z.object({
                  collections: z.boolean(),
                  payouts: z.boolean(),
                  sms: z.boolean()
                }),
                merchant_id: z.string(),
                merchant_name: z.string(),
                mode: z.enum(["test", "live"]),
                permissions: z.array(z.string()),
                role: z.enum(["owner", "admin", "finance", "developer", "support", "viewer"]),
                settlement_currency: z.string(),
                timezone: z.string(),
                user_id: z.string()
              })
            })
          }
        }
      },
      async (request) => {
        const summary = await complianceService.getMerchantSummary(
          request.dashboardMembership!.merchantId,
          request.dashboardMembership!.mode
        );

        return {
          data: {
            active_products: request.dashboardMembership!.activeProducts,
            compliance: {
              collections_freeze_category: summary.collectionsFreezeCategory,
              collections_freeze_reason: summary.collectionsFreezeReason,
              collections_frozen: summary.collectionsFrozen,
              contact_link: summary.contactLink,
              payouts_freeze_category: summary.payoutsFreezeCategory,
              payouts_freeze_reason: summary.payoutsFreezeReason,
              payouts_frozen: summary.payoutsFrozen,
              status: summary.status,
              suspension_category: summary.suspensionCategory,
              suspension_reason: summary.suspensionReason
            },
          email: request.authenticatedSession?.email ?? null,
          merchant_id: request.dashboardMembership!.merchantId,
          merchant_name: request.dashboardMembership!.merchantName,
          mode: request.dashboardMembership!.mode,
          permissions: request.dashboardPermissions ?? [],
          role: request.dashboardMembership!.role,
          settlement_currency: request.dashboardMembership!.settlementCurrency,
          timezone: request.dashboardMembership!.timezone,
          user_id: request.dashboardMembership!.userId
        }
        };
      }
    );

    protectedApp.get(
      "/team/members",
      {
        schema: {
          response: {
            200: z.object({
              data: z.array(
                z.object({
                  email: z.string().email().nullable(),
                  full_name: z.string().nullable(),
                  role: z.enum(["owner", "admin", "finance", "developer", "support", "viewer"]),
                  user_id: z.string()
                })
              )
            })
          }
        }
      },
      async (request) => {
        request.assertDashboardPermission("members.read");

        const rows = await runWithSystemScope(
          app.db,
          "list merchant members",
          async (trx) =>
            trx
              .selectFrom("memberships as membership")
              .leftJoin("profiles as profile", "profile.user_id", "membership.user_id")
              .leftJoin("auth.users as user", "user.id", "membership.user_id")
              .select([
                "membership.role as role",
                "membership.user_id as user_id",
                "profile.full_name as full_name",
                "user.email as email"
              ])
              .where("membership.merchant_id", "=", request.dashboardMembership!.merchantId)
              .orderBy("profile.full_name")
              .orderBy("user.email")
              .execute(),
          { audit: false }
        );

        return { data: rows };
      }
    );

    protectedApp.post(
      "/team/invite",
      {
        schema: {
          body: inviteBodySchema,
          response: {
            201: z.object({
              data: z.object({
                expires_at: z.string(),
                invite_url: z.string(),
                role: z.enum(["owner", "admin", "finance", "developer", "support", "viewer"])
              })
            })
          }
        }
      },
      async (request, reply) => {
        request.assertDashboardPermission("team.manage");
        const body = inviteBodySchema.parse(request.body);
        const rawToken = randomBytes(24).toString("hex");
        const invitation = await request.withDashboardScope(async (trx) => {
          const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

          return trx
            .insertInto("invitations")
            .values({
              accepted_at: null,
              email: body.email,
              expires_at: expiresAt,
              id: newId("inv_"),
              merchant_id: request.dashboardMembership!.merchantId,
              mode: request.dashboardMembership!.mode,
              role: body.role,
              token_hash: hashInviteToken(rawToken)
            })
            .returning(["expires_at", "role"])
            .executeTakeFirstOrThrow();
        });

        return reply.status(201).send({
          data: {
            expires_at: invitation.expires_at.toISOString(),
            invite_url: `${app.appEnv.DASHBOARD_ORIGIN}/accept-invite?token=${rawToken}`,
            role: invitation.role
          }
        });
      }
    );

    protectedApp.patch(
      "/team/members/:userId",
      {
        schema: {
          body: updateRoleBodySchema,
          params: z.object({
            userId: z.string().min(1)
          }),
          response: {
            200: z.object({
              data: z.object({
                role: z.enum(["owner", "admin", "finance", "developer", "support", "viewer"]),
                user_id: z.string()
              })
            })
          }
        }
      },
      async (request) => {
        request.assertDashboardPermission("team.manage");
        const body = updateRoleBodySchema.parse(request.body);
        const { userId } = request.params as { userId: string };

        const updated = await request.withDashboardScope(async (trx) => {
          await ensureOwnerRemains(trx, request.dashboardMembership!.merchantId, userId, body.role);

          return trx
            .updateTable("memberships")
            .set({ role: body.role })
            .where("merchant_id", "=", request.dashboardMembership!.merchantId)
            .where("user_id", "=", userId)
            .returning(["user_id", "role"])
            .executeTakeFirstOrThrow(() => new ApiRouteError({
              code: "not_found",
              message: "Member not found",
              statusCode: 404
            }));
        });

        return { data: updated };
      }
    );

    protectedApp.delete(
      "/team/members/:userId",
      {
        schema: {
          params: z.object({
            userId: z.string().min(1)
          }),
          response: {
            200: z.object({
              data: z.object({
                removed: z.literal(true)
              })
            })
          }
        }
      },
      async (request) => {
        request.assertDashboardPermission("team.manage");
        const { userId } = request.params as { userId: string };

        await request.withDashboardScope(async (trx) => {
          await ensureOwnerRemains(trx, request.dashboardMembership!.merchantId, userId);

          const deleted = await trx
            .deleteFrom("memberships")
            .where("merchant_id", "=", request.dashboardMembership!.merchantId)
            .where("user_id", "=", userId)
            .executeTakeFirst();

          if (!deleted || Number(deleted.numDeletedRows) === 0) {
            throw new ApiRouteError({
              code: "not_found",
              message: "Member not found",
              statusCode: 404
            });
          }
        });

        return { data: { removed: true } };
      }
    );

    protectedApp.get(
      "/api-keys",
      {
        schema: {
          response: {
            200: z.object({
              data: z.array(
                z.object({
                  created_at: z.string(),
                  created_by: z.string(),
                  expires_at: z.string().nullable(),
                  id: z.string(),
                  ip_allowlist: z.array(z.string()).nullable(),
                  kind: z.enum(apiKeyKinds),
                  last4: z.string(),
                  last_used_at: z.string().nullable(),
                  mode: z.enum(["test", "live"]),
                  name: z.string(),
                  prefix: z.string(),
                  revoked_at: z.string().nullable(),
                  scopes: z.array(z.enum(apiKeyScopes))
                })
              )
            })
          }
        }
      },
      async (request) => {
        request.assertDashboardPermission("api_keys.manage");

        const keys = await request.withDashboardScope(async (trx) =>
          trx
            .selectFrom("api_keys")
            .select([
              "created_at",
              "created_by",
              "expires_at",
              "id",
              "ip_allowlist",
              "kind",
              "last4",
              "last_used_at",
              "mode",
              "name",
              "prefix",
              "revoked_at",
              "scopes"
            ])
            .where("merchant_id", "=", request.dashboardMembership!.merchantId)
            .orderBy("created_at desc")
            .execute()
        );

        return {
          data: keys.map((key) => ({
            created_at: key.created_at.toISOString(),
            created_by: key.created_by,
            expires_at: key.expires_at?.toISOString() ?? null,
            id: key.id,
            ip_allowlist: key.ip_allowlist,
            kind: key.kind as ApiKeyKind,
            last4: key.last4,
            last_used_at: key.last_used_at?.toISOString() ?? null,
            mode: key.mode,
            name: key.name,
            prefix: key.prefix,
            revoked_at: key.revoked_at?.toISOString() ?? null,
            scopes: key.scopes as ApiKeyScope[]
          }))
        };
      }
    );

    protectedApp.post(
      "/api-keys",
      {
        schema: {
          body: createApiKeyBodySchema,
          response: {
            201: z.object({
              data: z.object({
                created_at: z.string(),
                expires_at: z.string().nullable(),
                id: z.string(),
                ip_allowlist: z.array(z.string()).nullable(),
                key: z.string(),
                kind: z.enum(apiKeyKinds),
                last4: z.string(),
                mode: z.enum(["test", "live"]),
                name: z.string(),
                prefix: z.string(),
                scopes: z.array(z.enum(apiKeyScopes))
              })
            })
          }
        }
      },
      async (request, reply) => {
        request.assertDashboardPermission("api_keys.manage");
        const body = createApiKeyBodySchema.parse(request.body);
        const keyMode = body.mode ?? request.dashboardMembership!.mode;
        const plainKey = createPlainApiKey(keyMode, body.kind);

        const createdKey = await request.withDashboardScope(async (trx) => {
          const createdAt = new Date();
          const expiresAt = body.expires_at ? new Date(body.expires_at) : null;

          return trx
            .insertInto("api_keys")
            .values({
              created_at: createdAt,
              created_by: request.dashboardMembership!.userId,
              expires_at: expiresAt,
              id: newId("key_"),
              ip_allowlist: body.ip_allowlist ?? null,
              key_hash: hashApiKey(plainKey, app.appEnv.API_KEY_PEPPER),
              kind: body.kind,
              last4: getApiKeyLast4(plainKey),
              merchant_id: request.dashboardMembership!.merchantId,
              mode: keyMode,
              name: body.name,
              prefix: getApiKeyPrefix(plainKey),
              revoked_at: null,
              scopes: body.scopes
            })
            .returning([
              "created_at",
              "expires_at",
              "id",
              "ip_allowlist",
              "kind",
              "last4",
              "mode",
              "name",
              "prefix",
              "scopes"
            ])
            .executeTakeFirstOrThrow();
        });

        return reply.status(201).send({
          data: {
            created_at: createdKey.created_at.toISOString(),
            expires_at: createdKey.expires_at?.toISOString() ?? null,
            id: createdKey.id,
            ip_allowlist: createdKey.ip_allowlist,
            key: plainKey,
            kind: createdKey.kind as ApiKeyKind,
            last4: createdKey.last4,
            mode: createdKey.mode,
            name: createdKey.name,
            prefix: createdKey.prefix,
            scopes: createdKey.scopes as ApiKeyScope[]
          }
        });
      }
    );

    protectedApp.post(
      "/api-keys/:apiKeyId/roll",
      {
        schema: {
          params: z.object({
            apiKeyId: z.string().min(1)
          }),
          response: {
            201: z.object({
              data: z.object({
                expires_at: z.string().nullable(),
                id: z.string(),
                key: z.string(),
                last4: z.string(),
                mode: z.enum(["test", "live"]),
                prefix: z.string(),
                previous_key_expires_at: z.string(),
                scopes: z.array(z.enum(apiKeyScopes))
              })
            })
          }
        }
      },
      async (request, reply) => {
        request.assertDashboardPermission("api_keys.manage");
        const { apiKeyId } = request.params as { apiKeyId: string };
        const rolledKey = await request.withDashboardScope(async (trx) => {
          const existing = await trx
            .selectFrom("api_keys")
            .selectAll()
            .where("id", "=", apiKeyId)
            .where("merchant_id", "=", request.dashboardMembership!.merchantId)
            .executeTakeFirst();

          if (!existing) {
            throw new ApiRouteError({
              code: "not_found",
              message: "API key not found",
              statusCode: 404
            });
          }

          if (existing.kind !== "secret") {
            throw new ApiRouteError({
              code: "validation_error",
              field: "apiKeyId",
              message: "Only secret keys can be rolled",
              statusCode: 400
            });
          }

          if (existing.revoked_at) {
            throw new ApiRouteError({
              code: "validation_error",
              field: "apiKeyId",
              message: "Revoked keys cannot be rolled",
              statusCode: 400
            });
          }

          const plainKey = createPlainApiKey(existing.mode, "secret");

          const graceExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
          const previousKeyExpiresAt = existing.expires_at && existing.expires_at < graceExpiry
            ? existing.expires_at
            : graceExpiry;

          await trx
            .updateTable("api_keys")
            .set({
              expires_at: previousKeyExpiresAt
            })
            .where("id", "=", existing.id)
            .execute();

          const created = await trx
            .insertInto("api_keys")
            .values({
              created_by: request.dashboardMembership!.userId,
              expires_at: existing.expires_at,
              id: newId("key_"),
              ip_allowlist: existing.ip_allowlist,
              key_hash: hashApiKey(plainKey, app.appEnv.API_KEY_PEPPER),
              kind: existing.kind,
              last4: getApiKeyLast4(plainKey),
              merchant_id: existing.merchant_id,
              mode: existing.mode,
              name: existing.name,
              prefix: getApiKeyPrefix(plainKey),
              revoked_at: null,
              scopes: existing.scopes
            })
            .returning(["expires_at", "id", "last4", "mode", "prefix", "scopes"])
            .executeTakeFirstOrThrow();

          return {
            ...created,
            key: plainKey,
            previousKeyExpiresAt
          };
        });

        return reply.status(201).send({
          data: {
            expires_at: rolledKey.expires_at?.toISOString() ?? null,
            id: rolledKey.id,
            key: rolledKey.key,
            last4: rolledKey.last4,
            mode: rolledKey.mode,
            prefix: rolledKey.prefix,
            previous_key_expires_at: rolledKey.previousKeyExpiresAt.toISOString(),
            scopes: rolledKey.scopes as ApiKeyScope[]
          }
        });
      }
    );

    protectedApp.post(
      "/api-keys/:apiKeyId/revoke",
      {
        schema: {
          params: z.object({
            apiKeyId: z.string().min(1)
          }),
          response: {
            200: z.object({
              data: z.object({
                revoked: z.literal(true),
                revoked_at: z.string()
              })
            })
          }
        }
      },
      async (request) => {
        request.assertDashboardPermission("api_keys.manage");
        const { apiKeyId } = request.params as { apiKeyId: string };

        const revokedAt = await request.withDashboardScope(async (trx) => {
          const updated = await trx
            .updateTable("api_keys")
            .set({
              revoked_at: new Date()
            })
            .where("id", "=", apiKeyId)
            .where("merchant_id", "=", request.dashboardMembership!.merchantId)
            .returning("revoked_at")
            .executeTakeFirst();

          if (!updated?.revoked_at) {
            throw new ApiRouteError({
              code: "not_found",
              message: "API key not found",
              statusCode: 404
            });
          }

          return updated.revoked_at;
        });

        return {
          data: {
            revoked: true,
            revoked_at: revokedAt.toISOString()
          }
        };
      }
    );

    protectedApp.get(
      "/api-request-logs",
      {
        schema: {
          querystring: apiRequestLogQuerySchema,
          response: {
            200: z.object({
              data: z.array(
                z.object({
                  created_at: z.string().datetime(),
                  duration_ms: z.number().int(),
                  method: z.string(),
                  path: z.string(),
                  request_body: z.unknown().nullable(),
                  request_id: z.string(),
                  response_body: z.unknown().nullable(),
                  status_code: z.number().int()
                })
              )
            })
          }
        }
      },
      async (request) => {
        request.assertDashboardPermission("api_keys.manage");
        const queryInput = apiRequestLogQuerySchema.parse(request.query);
        const dateRange = makeDateRange({
          endDate: queryInput.end_date,
          startDate: queryInput.start_date
        });

        const logs = await request.withDashboardScope(async (trx) => {
          let query = trx
            .selectFrom("api_request_logs")
            .select([
              "created_at",
              "duration_ms",
              "method",
              "path",
              "request_body",
              "request_id",
              "response_body",
              "status_code"
            ])
            .where("merchant_id", "=", request.dashboardMembership!.merchantId)
            .where("mode", "=", request.dashboardMembership!.mode);

          if (queryInput.method) {
            query = query.where("method", "=", queryInput.method);
          }

          if (dateRange.startDate) {
            query = query.where("created_at", ">=", dateRange.startDate);
          }

          if (dateRange.endDate) {
            query = query.where("created_at", "<=", dateRange.endDate);
          }

          switch (queryInput.status_class) {
            case "2xx":
              query = query.where("status_code", ">=", 200).where("status_code", "<", 300);
              break;
            case "4xx":
              query = query.where("status_code", ">=", 400).where("status_code", "<", 500);
              break;
            case "5xx":
              query = query.where("status_code", ">=", 500).where("status_code", "<", 600);
              break;
            default:
              break;
          }

          return query.orderBy("created_at desc").limit(queryInput.limit).execute();
        });

        return {
          data: logs.map((row) => ({
            created_at: row.created_at.toISOString(),
            duration_ms: row.duration_ms,
            method: row.method,
            path: row.path,
            request_body: row.request_body,
            request_id: row.request_id,
            response_body: row.response_body,
            status_code: row.status_code
          }))
        };
      }
    );

    protectedApp.get(
      "/events-outbox",
      {
        schema: {
          querystring: eventsOutboxQuerySchema,
          response: {
            200: z.object({
              data: z.array(
                z.object({
                  created_at: z.string().datetime(),
                  id: z.string(),
                  mode: z.enum(["test", "live"]),
                  payload: z.unknown(),
                  type: z.string()
                })
              )
            })
          }
        }
      },
      async (request) => {
        request.assertDashboardPermission("api_keys.manage");
        const queryInput = eventsOutboxQuerySchema.parse(request.query);
        const dateRange = makeDateRange({
          endDate: queryInput.end_date,
          startDate: queryInput.start_date
        });

        const events = await request.withDashboardScope(async (trx) => {
          let query = trx
            .selectFrom("events_outbox")
            .select(["created_at", "id", "mode", "payload", "type"])
            .where("merchant_id", "=", request.dashboardMembership!.merchantId)
            .where("mode", "=", request.dashboardMembership!.mode);

          if (queryInput.type) {
            query = query.where("type", "=", queryInput.type);
          }

          if (dateRange.startDate) {
            query = query.where("created_at", ">=", dateRange.startDate);
          }

          if (dateRange.endDate) {
            query = query.where("created_at", "<=", dateRange.endDate);
          }

          return query.orderBy("created_at desc").limit(queryInput.limit).execute();
        });

        return {
          data: events.map((row) => ({
            created_at: row.created_at.toISOString(),
            id: row.id,
            mode: row.mode,
            payload: row.payload,
            type: row.type
          }))
        };
      }
    );
  });
}

async function ensureOwnerRemains(
  trx: ScopedTransaction,
  merchantId: string,
  targetUserId: string,
  nextRole?: MerchantRole
) {
  const targetMembership = await trx
    .selectFrom("memberships")
    .select("role")
    .where("merchant_id", "=", merchantId)
    .where("user_id", "=", targetUserId)
    .executeTakeFirst();

  if (!targetMembership || targetMembership.role !== "owner") {
    return;
  }

  if (nextRole === "owner") {
    return;
  }

  const owners = await trx
    .selectFrom("memberships")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("merchant_id", "=", merchantId)
    .where("role", "=", "owner")
    .executeTakeFirstOrThrow();

  if (Number(owners.count) <= 1) {
    throw new ApiRouteError({
      code: "forbidden",
      message: "A merchant must keep at least one owner",
      statusCode: 403
    });
  }
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
