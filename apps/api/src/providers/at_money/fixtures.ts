import { createPlaceholderMobileMoneyFixtures } from "../mobile-money/fixtures";

export const atMoneyFixtures = createPlaceholderMobileMoneyFixtures({
  callbackSignatureHeader: "x-at-signature",
  countryCode: "GH",
  providerCode: "at_money",
  providerStatuses: {
    failure: "ERROR",
    pending: "PROCESSING",
    success: "OK"
  }
});
