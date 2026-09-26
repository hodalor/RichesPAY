import type { ErrorCode } from "@richespay/shared";

import type { ProviderStatusMapping } from "../mobile-money/mapping";

export const atMoneyStatusMap: Record<string, ProviderStatusMapping> = {
  ERROR: {
    failureCode: "provider_error",
    outcome: "failed"
  },
  OK: {
    outcome: "succeeded"
  },
  PROCESSING: {
    outcome: "accepted"
  }
};

export const atMoneyErrorMap: Record<string, ErrorCode> = {
  CUSTOMER_DECLINED: "provider_error",
  INSUFFICIENT_FUNDS: "insufficient_funds",
  INVALID_MSISDN: "invalid_phone_number"
};
