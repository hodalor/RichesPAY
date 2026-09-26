import { getErrorDefinition } from "@richespay/shared";

import type { ScopedTransaction } from "../db";
import { ApiRouteError } from "../lib/api-error";
import { roundDivisionToMinorUnit } from "./rounding";
import type { PricingRepository } from "./repository";
import type {
  FeeMethod,
  FeePlanKind,
  FeeQuote,
  PricingMerchantContext
} from "./types";

export class FeeService {
  #repository: PricingRepository;

  constructor(repository: PricingRepository) {
    this.#repository = repository;
  }

  async quote(
    merchant: PricingMerchantContext,
    kind: FeePlanKind,
    method: FeeMethod,
    network: string | null,
    amountMinor: bigint,
    currency = merchant.settlementCurrency,
    trx?: ScopedTransaction
  ): Promise<FeeQuote> {
    const override = await this.#repository.findActiveMerchantFeeOverride({
      currency,
      kind,
      merchantId: merchant.id,
      method,
      mode: merchant.mode,
      network
    }, trx);

    const plan =
      override ??
      (await this.#repository.findActiveFeePlan({
        countryCode: merchant.countryCode,
        currency,
        kind,
        method,
        network
      }, trx));

    if (!plan) {
      throw new ApiRouteError({
        code: "not_found",
        message: "No active pricing plan matched the quote request.",
        statusCode: getErrorDefinition("not_found").status
      });
    }

    const percentMinor = roundDivisionToMinorUnit(
      amountMinor * BigInt(plan.percentBps),
      10_000n,
      plan.feeBearer
    );

    let feeMinor = percentMinor + plan.fixedMinor;
    if (feeMinor < plan.minMinor) {
      feeMinor = plan.minMinor;
    }

    if (plan.maxMinor !== null && feeMinor > plan.maxMinor) {
      feeMinor = plan.maxMinor;
    }

    if (plan.feeBearer === "customer") {
      return {
        customerPaysMinor: amountMinor + feeMinor,
        feeMinor,
        merchantReceivesMinor: amountMinor
      };
    }

    const merchantReceivesMinor =
      feeMinor >= amountMinor ? 0n : amountMinor - feeMinor;

    return {
      customerPaysMinor: amountMinor,
      feeMinor,
      merchantReceivesMinor
    };
  }
}
