import type { ProviderOutcome } from "../providers/types";
import type { PayoutBatchRecordStatus, PayoutRecordStatus } from "./types";

const payoutTransitions: Record<PayoutRecordStatus, readonly PayoutRecordStatus[]> = {
  cancelled: [],
  failed: ["reversed"],
  on_hold: ["cancelled", "queued"],
  pending_approval: ["cancelled", "queued"],
  processing: ["failed", "reversed", "successful"],
  queued: ["cancelled", "on_hold", "processing"],
  reversed: [],
  successful: ["reversed"]
};

export function assertPayoutTransition(
  fromStatus: PayoutRecordStatus,
  toStatus: PayoutRecordStatus
) {
  if (!payoutTransitions[fromStatus].includes(toStatus)) {
    throw new Error(`Invalid payout transition: ${fromStatus} -> ${toStatus}`);
  }
}

export function isPayoutTerminalStatus(status: PayoutRecordStatus) {
  return ["cancelled", "failed", "reversed", "successful"].includes(status);
}

export function mapProviderOutcomeToPayoutStatus(
  outcome: ProviderOutcome
): PayoutRecordStatus | null {
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

export function payoutEventTypeForStatus(status: PayoutRecordStatus): string | null {
  switch (status) {
    case "failed":
      return "payout.failed";
    case "reversed":
      return "payout.reversed";
    case "successful":
      return "payout.successful";
    default:
      return null;
  }
}

export function payoutBatchEventTypeForStatus(
  status: PayoutBatchRecordStatus
): string | null {
  return status === "completed" ? "payout_batch.completed" : null;
}
