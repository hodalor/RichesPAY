import { createPlaceholderMobileMoneyFixtures } from "../mobile-money/fixtures";

export const telecelCashFixtures = createPlaceholderMobileMoneyFixtures({
  callbackSignatureHeader: "x-telecel-signature",
  countryCode: "GH",
  providerCode: "telecel_cash",
  providerStatuses: {
    failure: "FAILED",
    pending: "PENDING",
    success: "SUCCESS"
  }
});
