import type { ErrorCode } from "@richespay/shared";

import type { ProviderStatusMapping } from "../mobile-money/mapping";

export const telecelCashStatusMap: Record<string, ProviderStatusMapping> = {
  FAILED: {
    failureCode: "provider_error",
    outcome: "failed"
  },
  PENDING: {
    outcome: "accepted"
  },
  SUCCESS: {
    outcome: "succeeded"
  }
};

export const telecelCashErrorMap: Record<string, ErrorCode> = {
  CUSTOMER_DECLINED: "provider_error",
  INSUFFICIENT_FUNDS: "insufficient_funds",
  INVALID_MSISDN: "invalid_phone_number"
};
