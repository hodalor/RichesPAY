import { describe, expect, it } from "vitest";

import { getErrorDefinition, isErrorCode } from "../src/errors";

describe("error catalog", () => {
  it("exposes the public API authentication and idempotency errors", () => {
    expect(isErrorCode("authentication_failed")).toBe(true);
    expect(getErrorDefinition("authentication_failed")).toEqual({
      message: "API authentication failed.",
      status: 401
    });

    expect(getErrorDefinition("idempotency_conflict")).toEqual({
      message: "This idempotency key was already used with a different request body.",
      status: 409
    });
  });

  it("keeps existing dashboard/admin error codes available", () => {
    expect(isErrorCode("mfa_required")).toBe(true);
    expect(getErrorDefinition("mfa_required").status).toBe(403);
  });
});
