import type { ErrorCode } from "./errors";

export const merchantRoles = [
  "owner",
  "admin",
  "finance",
  "developer",
  "support",
  "viewer"
] as const;

export const platformAdminRoles = [
  "super_admin",
  "compliance",
  "operations",
  "finance",
  "support"
] as const;

export const apiKeyKinds = ["secret", "public"] as const;
export const apiKeyScopes = ["collections", "payouts", "sms", "read"] as const;

export type MerchantRole = (typeof merchantRoles)[number];
export type PlatformAdminRole = (typeof platformAdminRoles)[number];
export type ApiKeyKind = (typeof apiKeyKinds)[number];
export type ApiKeyScope = (typeof apiKeyScopes)[number];

export const merchantPermissions = [
  "members.read",
  "merchant.switch",
  "payouts.create",
  "topups.manage",
  "api_keys.manage",
  "payment_links.manage",
  "team.manage"
] as const;

export type MerchantPermission = (typeof merchantPermissions)[number];

export const merchantPermissionMatrix: Record<
  MerchantPermission,
  readonly MerchantRole[]
> = {
  "api_keys.manage": ["owner", "admin", "developer"],
  "members.read": merchantRoles,
  "merchant.switch": merchantRoles,
  "payment_links.manage": ["owner", "admin", "developer"],
  "payouts.create": ["owner", "admin", "finance"],
  "topups.manage": ["owner", "admin", "finance"],
  "team.manage": ["owner", "admin"]
};

const merchantRolesRequiringMfa = new Set<MerchantRole>([
  "owner",
  "admin",
  "finance"
]);

export function requiresMerchantMfa(role: MerchantRole): boolean {
  return merchantRolesRequiringMfa.has(role);
}

export function requiresPlatformAdminMfa(_role: PlatformAdminRole): boolean {
  return true;
}

export function hasPermission(
  role: MerchantRole,
  permission: MerchantPermission
): boolean {
  return merchantPermissionMatrix[permission].includes(role);
}

export function requirePermission(
  permission: MerchantPermission,
  role: MerchantRole
): void {
  if (!hasPermission(role, permission)) {
    const error = new Error(`Permission denied: ${permission}`);
    (
      error as Error & {
        code?: ErrorCode;
        statusCode?: number;
      }
    ).code = "forbidden";
    (
      error as Error & {
        code?: ErrorCode;
        statusCode?: number;
      }
    ).statusCode = 403;

    throw error;
  }
}

export function settlementCurrencyForCountry(countryCode: string):
  | "GHS"
  | "USD"
  | "ZMW" {
  switch (countryCode.toUpperCase()) {
    case "GH":
      return "GHS";
    case "ZM":
      return "ZMW";
    default:
      return "USD";
  }
}
