import Decimal from "decimal.js";

import { CURRENCIES, getErrorDefinition, type CurrencyCode } from "@richespay/shared";

import { ApiRouteError } from "../lib/api-error";
import type { PricingRepository } from "./repository";
import type { FxConversionQuote } from "./types";

export class FxService {
  #repository: PricingRepository;

  constructor(repository: PricingRepository) {
    this.#repository = repository;
  }

  async convert(
    amountMinor: bigint,
    from: CurrencyCode,
    to: CurrencyCode
  ): Promise<FxConversionQuote> {
    if (from === to) {
      return {
        amountMinor,
        fxRateId: "fx_same_currency"
      };
    }

    const rate = await this.#repository.findActiveFxRate({
      base: from,
      quote: to
    });

    if (!rate) {
      throw new ApiRouteError({
        code: "unsupported_currency",
        message: "No active FX rate is available for this currency pair.",
        statusCode: getErrorDefinition("unsupported_currency").status
      });
    }

    const fromMinorUnits = CURRENCIES[from].minorUnits;
    const toMinorUnits = CURRENCIES[to].minorUnits;
    const baseAmount = new Decimal(amountMinor.toString()).div(
      new Decimal(10).pow(fromMinorUnits)
    );
    const effectiveRate = new Decimal(rate.rate).mul(
      new Decimal(1).plus(new Decimal(rate.markupBps).div(10_000))
    );
    const quoteMinor = baseAmount
      .mul(effectiveRate)
      .mul(new Decimal(10).pow(toMinorUnits))
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

    return {
      amountMinor: BigInt(quoteMinor.toFixed(0)),
      fxRateId: rate.id
    };
  }
}
