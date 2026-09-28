export const successRateDropPoints = 0.1;
export const queueBacklogThreshold = 1000;

export function successRate(successes: number, total: number) {
  if (total <= 0) {
    return null;
  }

  return successes / total;
}

export function successRateDropped(input: {
  currentSuccesses: number;
  currentTotal: number;
  minimumSamples?: number;
  previousSuccesses: number;
  previousTotal: number;
}) {
  const minimumSamples = input.minimumSamples ?? 20;
  if (input.previousTotal < minimumSamples || input.currentTotal < minimumSamples) {
    return false;
  }

  const previous = successRate(input.previousSuccesses, input.previousTotal);
  const current = successRate(input.currentSuccesses, input.currentTotal);
  if (previous === null || current === null) {
    return false;
  }

  return previous - current >= successRateDropPoints;
}

export function floatBalanceIsLow(balanceMinor: bigint | null, thresholdMinor: bigint) {
  return balanceMinor !== null && balanceMinor < thresholdMinor;
}
