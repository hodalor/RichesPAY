import { newId } from "@richespay/shared";
import ipaddr from "ipaddr.js";

import {
  requiresPlatformAdminMfa,
  type PlatformAdminRole
} from "@richespay/shared";

import { runWithSystemScope, type AppDatabase, type ScopedTransaction } from "../db";
import type { Json } from "../db/types";
import { ApiRouteError } from "../lib/api-error";
import type { AuthenticatedSession } from "./session";

export interface PlatformAdminContext {
  active: boolean;
  role: PlatformAdminRole;
  userId: string;
}

export async function resolvePlatformAdmin(
  database: AppDatabase,
  userId: string
): Promise<PlatformAdminContext | null> {
  const admin = await runWithSystemScope(
    database,
    "load platform admin session",
    async (trx) =>
      trx
        .selectFrom("platform_admins")
        .select(["active", "role", "user_id as userId"])
        .where("user_id", "=", userId)
        .executeTakeFirst(),
    { audit: false }
  );

  return admin ? (admin as PlatformAdminContext) : null;
}

export function enforceAdminMfa(session: AuthenticatedSession, admin: PlatformAdminContext) {
  if (requiresPlatformAdminMfa(admin.role) && session.aal !== "aal2") {
    throw new ApiRouteError({
      code: "mfa_required",
      message: "An AAL2 session is required for the admin app",
      statusCode: 403
    });
  }
}

export function assertAdminIpAllowed(
  rawIp: string,
  allowlist: readonly string[]
) {
  const clientAddress = ipaddr.parse(rawIp);
  const allowed = allowlist.some((entry) => {
    if (entry.includes("/")) {
      const [range, prefixLength] = ipaddr.parseCIDR(entry);
      return clientAddress.kind() === range.kind() && clientAddress.match([range, prefixLength]);
    }

    const allowedAddress = ipaddr.parse(entry);
    return clientAddress.kind() === allowedAddress.kind() && clientAddress.toNormalizedString() === allowedAddress.toNormalizedString();
  });

  if (!allowed) {
    throw new ApiRouteError({
      code: "ip_not_allowed",
      message: "The admin app is only available from approved IP addresses",
      statusCode: 403
    });
  }
}

export function getClientIp(requestHeaders: Record<string, unknown>, fallbackIp: string): string {
  const forwardedFor = requestHeaders["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim() !== "") {
    const [first] = forwardedFor.split(",");
    return first?.trim() || fallbackIp;
  }

  return fallbackIp;
}

export async function runAdminSystemWrite<T>(
  database: AppDatabase,
  input: {
    action: string;
    actorId: string;
    after?: Json;
    before?: Json | null;
    reason: string;
    targetId?: string | null;
    targetType: string;
  },
  fn: (trx: ScopedTransaction) => Promise<T>
): Promise<T> {
  return runWithSystemScope(
    database,
    input.reason,
    async (trx) => {
      const result = await fn(trx);

      await trx
        .insertInto("audit_logs")
        .values({
          action: input.action,
          actor_id: input.actorId,
          actor_type: "admin",
          after: input.after ?? null,
          before: input.before ?? null,
          id: newId("aud_"),
          ip: null,
          merchant_id: null,
          mode: "live",
          reason: input.reason,
          target_id: input.targetId ?? null,
          target_type: input.targetType,
          user_agent: null
        })
        .execute();

      return result;
    },
    { audit: false }
  );
}
