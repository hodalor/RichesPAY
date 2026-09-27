import {
  hasPermission,
  merchantPermissions,
  requirePermission,
  requiresMerchantMfa,
  type MerchantPermission,
  type MerchantRole
} from "@richespay/shared";

import { runWithMerchantScope, type AppDatabase, type ScopedTransaction } from "../db";
import type { RpMode } from "../db/types";
import { ApiRouteError } from "../lib/api-error";
import type { AuthenticatedSession } from "./session";

export interface DashboardMembershipContext {
  merchantId: string;
  merchantName: string;
  merchantStatus: string;
  mode: RpMode;
  role: MerchantRole;
  settlementCurrency: string;
  timezone: string;
  userId: string;
}

export async function resolveDashboardMembership(
  database: AppDatabase,
  userId: string,
  merchantId: string
): Promise<DashboardMembershipContext | null> {
  for (const mode of ["live", "test"] as const) {
    const membership = await runWithMerchantScope(
      database,
      merchantId,
      mode,
      async (trx) =>
        trx
          .selectFrom("memberships as membership")
          .innerJoin("merchants as merchant", "merchant.id", "membership.merchant_id")
          .select([
            "membership.merchant_id as merchantId",
            "membership.mode as mode",
            "membership.role as role",
            "membership.user_id as userId",
            "merchant.legal_name as merchantName",
            "merchant.settlement_currency as settlementCurrency",
            "merchant.status as merchantStatus",
            "merchant.timezone as timezone"
          ])
          .where("membership.user_id", "=", userId)
          .where("merchant.id", "=", merchantId)
          .executeTakeFirst()
    );

    if (membership) {
      return membership as DashboardMembershipContext;
    }
  }

  return null;
}

export function enforceDashboardMfa(
  session: AuthenticatedSession,
  membership: DashboardMembershipContext
) {
  if (requiresMerchantMfa(membership.role) && session.aal !== "aal2") {
    throw new ApiRouteError({
      code: "mfa_required",
      message: "A TOTP second factor is required for this role",
      statusCode: 403
    });
  }
}

export function getDashboardPermissions(role: MerchantRole): MerchantPermission[] {
  return merchantPermissions.filter((permission) => hasPermission(role, permission));
}

export function assertDashboardPermission(
  membership: DashboardMembershipContext,
  permission: MerchantPermission
) {
  requirePermission(permission, membership.role);
}

export async function runInDashboardScope<T>(
  database: AppDatabase,
  membership: DashboardMembershipContext,
  fn: (trx: ScopedTransaction) => Promise<T>
): Promise<T> {
  return runWithMerchantScope(
    database,
    membership.merchantId,
    membership.mode,
    fn
  );
}
