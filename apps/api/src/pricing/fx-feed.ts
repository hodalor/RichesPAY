import type { CurrencyCode } from "@richespay/shared";

export interface FxFeedRate {
  base: CurrencyCode;
  capturedAt: Date;
  markupBps: number;
  quote: CurrencyCode;
  rate: string;
}

export interface FxRateFeed {
  fetchRates(): Promise<FxFeedRate[]>;
}

export class ManualOnlyFxRateFeed implements FxRateFeed {
  async fetchRates(): Promise<FxFeedRate[]> {
    return [];
  }
}
