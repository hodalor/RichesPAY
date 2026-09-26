import { createPlaceholderMobileMoneyFixtures } from "../mobile-money/fixtures";

export const mtnMomoFixtures = createPlaceholderMobileMoneyFixtures({
  callbackSignatureHeader: "x-mtn-signature",
  countryCode: "GH",
  providerCode: "mtn_momo",
  providerStatuses: {
    failure: "FAILED",
    pending: "PENDING",
    success: "SUCCESSFUL"
  }
});
