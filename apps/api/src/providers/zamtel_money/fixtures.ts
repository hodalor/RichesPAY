import { createPlaceholderMobileMoneyFixtures } from "../mobile-money/fixtures";

export const zamtelMoneyFixtures = createPlaceholderMobileMoneyFixtures({
  callbackSignatureHeader: "x-zamtel-signature",
  countryCode: "ZM",
  providerCode: "zamtel_money",
  providerStatuses: {
    failure: "FAILED",
    pending: "PENDING",
    success: "SUCCESS"
  }
});
