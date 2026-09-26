import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import {
  newId,
  settlementCurrencyForCountry,
  type MerchantRole
} from "@richespay/shared";

import { authenticateSupabaseSession } from "../auth/session";
import { createSupabaseAnonClient } from "../auth/supabase-client";
import { runWithSystemScope, type ScopedTransaction } from "../db";
import { dashboardAuthPlugin } from "../plugins/dashboard-auth";
import { ApiRouteError } from "../lib/api-error";

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

async function requireSession(
  app: FastifyTypedInstance,
  authorizationHeader: string | undefined
) {
  return authenticateSupabaseSession(
    app.db,
    app.appEnv.SUPABASE_JWT_SECRET,
    authorizationHeader
  );
}

export async function registerDashboardRoutes(app: FastifyTypedInstance) {
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
              verification_required: z.literal(true)
            })
          })
        }
      }
    },
    async (request, reply) => {
      const body = signUpBodySchema.parse(request.body);
      const supabase = createSupabaseAnonClient(app.appEnv);

      const { data, error } = await supabase.auth.signUp({
        email: body.email,
        password: body.password,
        options: {
          data: {
            full_name: body.full_name
          },
          emailRedirectTo: `${app.appEnv.DASHBOARD_ORIGIN}/verify-email`
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
            .insertInto("auth.users")
            .values({
              email: body.email,
              id: userId
            })
            .onConflict((conflict) => conflict.column("id").doNothing())
            .execute();

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

      return reply.status(201).send({
        data: {
          merchant_id: merchant.id,
          settlement_currency: merchant.settlement_currency as "GHS" | "USD" | "ZMW",
          user_id: userId,
          verification_required: true
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

    protectedApp.get(
      "/session",
      {
        schema: {
          response: {
            200: z.object({
              data: z.object({
                email: z.string().nullable(),
                merchant_id: z.string(),
                merchant_name: z.string(),
                mode: z.enum(["test", "live"]),
                permissions: z.array(z.string()),
                role: z.enum(["owner", "admin", "finance", "developer", "support", "viewer"]),
                settlement_currency: z.string(),
                user_id: z.string()
              })
            })
          }
        }
      },
      async (request) => ({
        data: {
          email: request.authenticatedSession?.email ?? null,
          merchant_id: request.dashboardMembership!.merchantId,
          merchant_name: request.dashboardMembership!.merchantName,
          mode: request.dashboardMembership!.mode,
          permissions: request.dashboardPermissions ?? [],
          role: request.dashboardMembership!.role,
          settlement_currency: request.dashboardMembership!.settlementCurrency,
          user_id: request.dashboardMembership!.userId
        }
      })
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
