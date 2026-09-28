import type { ProviderOutcome } from "../providers/types";
import type { AirtimeOrderStatus } from "./types";

const airtimeTransitions: Record<AirtimeOrderStatus, readonly AirtimeOrderStatus[]> = {
  failed: [],
  pending: ["processing", "failed"],
  processing: ["successful", "failed"],
  successful: []
};

export function assertAirtimeTransition(from: AirtimeOrderStatus, to: AirtimeOrderStatus) {
  if (!airtimeTransitions[from].includes(to)) {
    throw new Error(`Invalid airtime transition: ${from} -> ${to}`);
  }
}

export function isAirtimeTerminalStatus(status: AirtimeOrderStatus) {
  return status === "successful" || status === "failed";
}

export function mapProviderOutcomeToAirtimeStatus(
  outcome: ProviderOutcome
): "failed" | "successful" | null {
  switch (outcome) {
    case "failed":
      return "failed";
    case "succeeded":
      return "successful";
    case "accepted":
    case "unknown":
      return null;
  }
}

export function airtimeEventTypeForStatus(status: AirtimeOrderStatus): string | null {
  switch (status) {
    case "failed":
      return "airtime.failed";
    case "successful":
      return "airtime.successful";
    default:
      return null;
  }
}

export const airtimeBatchCompletedEvent = "airtime_batch.completed";

export function nextStatusCheckDelayMs(statusCheckAttempts: number) {
  return Math.min(30_000 * 2 ** statusCheckAttempts, 15 * 60_000);
}
