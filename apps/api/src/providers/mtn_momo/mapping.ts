import type { ErrorCode } from "@richespay/shared";

import type { ProviderStatusMapping } from "../mobile-money/mapping";

export const mtnMomoStatusMap: Record<string, ProviderStatusMapping> = {
  FAILED: {
    failureCode: "provider_error",
    outcome: "failed"
  },
  PENDING: {
    outcome: "accepted"
  },
  SUCCESSFUL: {
    outcome: "succeeded"
  }
};

export const mtnMomoErrorMap: Record<string, ErrorCode> = {
  CUSTOMER_DECLINED: "provider_error",
  INSUFFICIENT_FUNDS: "insufficient_funds",
  INVALID_MSISDN: "invalid_phone_number"
};
