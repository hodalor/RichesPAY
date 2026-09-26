import { createPlaceholderMobileMoneyFixtures } from "../mobile-money/fixtures";

export const airtelMoneyFixtures = createPlaceholderMobileMoneyFixtures({
  callbackSignatureHeader: "x-airtel-signature",
  countryCode: "ZM",
  providerCode: "airtel_money",
  providerStatuses: {
    failure: "FAILED",
    pending: "PENDING",
    success: "SUCCESSFUL"
  }
});
