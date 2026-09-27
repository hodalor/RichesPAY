import type { Json, RpMode } from "../db/types";
import type { ScreeningProvider, ScreeningResult } from "./types";

export class NoopScreeningProvider implements ScreeningProvider {
  async screen(input: {
    merchantId: string;
    mode: RpMode;
    referenceId: string;
    subject: Json;
    subjectType: "merchant_onboarding" | "payout_beneficiary";
  }): Promise<ScreeningResult> {
    return {
      outcome: "clear",
      providerCode: "noop_screening",
      rawRedacted: {
        merchant_id: input.merchantId,
        reference_id: input.referenceId,
        subject_type: input.subjectType
      }
    };
  }
}
