import type { ErrorCode } from "@richespay/shared";

import type { ProviderStatusMapping } from "../mobile-money/mapping";

export const airtelMoneyStatusMap: Record<string, ProviderStatusMapping> = {
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

export const airtelMoneyErrorMap: Record<string, ErrorCode> = {
  CUSTOMER_DECLINED: "provider_error",
  INSUFFICIENT_FUNDS: "insufficient_funds",
  INVALID_MSISDN: "invalid_phone_number"
};
