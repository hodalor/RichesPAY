import { describe, expect, it } from "vitest";

import {
  hasPermission,
  requirePermission,
  requiresMerchantMfa,
  requiresPlatformAdminMfa,
  settlementCurrencyForCountry
} from "../src/auth";

describe("permissions matrix", () => {
  it("allows only finance-capable roles to create payouts", () => {
    expect(hasPermission("owner", "payouts.create")).toBe(true);
    expect(hasPermission("admin", "payouts.create")).toBe(true);
    expect(hasPermission("finance", "payouts.create")).toBe(true);
    expect(hasPermission("developer", "payouts.create")).toBe(false);
    expect(hasPermission("viewer", "payouts.create")).toBe(false);
  });

  it("allows only technical roles to manage API keys", () => {
    expect(hasPermission("owner", "api_keys.manage")).toBe(true);
    expect(hasPermission("admin", "api_keys.manage")).toBe(true);
    expect(hasPermission("developer", "api_keys.manage")).toBe(true);
    expect(hasPermission("finance", "api_keys.manage")).toBe(false);
  });

  it("throws a forbidden error when a role lacks permission", () => {
    expect(() => requirePermission("team.manage", "viewer")).toThrow(
      /Permission denied/
    );
  });
});

describe("MFA rules", () => {
  it("requires MFA for owner, admin, and finance merchant roles", () => {
    expect(requiresMerchantMfa("owner")).toBe(true);
    expect(requiresMerchantMfa("admin")).toBe(true);
    expect(requiresMerchantMfa("finance")).toBe(true);
    expect(requiresMerchantMfa("developer")).toBe(false);
  });

  it("requires MFA for every platform admin role", () => {
    expect(requiresPlatformAdminMfa("super_admin")).toBe(true);
    expect(requiresPlatformAdminMfa("support")).toBe(true);
  });
});

describe("settlement currency helper", () => {
  it("matches the onboarding settlement currency rules", () => {
    expect(settlementCurrencyForCountry("GH")).toBe("GHS");
    expect(settlementCurrencyForCountry("ZM")).toBe("ZMW");
    expect(settlementCurrencyForCountry("KE")).toBe("USD");
  });
});
