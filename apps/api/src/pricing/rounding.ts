import type { FeeBearer } from "./types";

/**
 * RichesPay pricing rounding rule:
 * - Fee percentages are computed in integer minor units only.
 * - We round to the nearest minor unit.
 * - Exact half values break in the merchant's favour:
 *   - merchant-borne fees round down, so we do not overcharge the merchant
 *   - customer-borne fees round up, so the merchant still receives the quoted amount
 * - FX conversions use standard half-up in FxService after Decimal math.
 */
export function roundDivisionToMinorUnit(
  numerator: bigint,
  denominator: bigint,
  feeBearer: FeeBearer
): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubledRemainder = remainder * 2n;

  if (doubledRemainder > denominator) {
    return quotient + 1n;
  }

  if (doubledRemainder < denominator) {
    return quotient;
  }

  return feeBearer === "customer" ? quotient + 1n : quotient;
}
