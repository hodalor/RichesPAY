import type { ProviderOutcome } from "../providers/types";
import type { CollectionStatus } from "./types";

const transitions: Record<CollectionStatus, readonly CollectionStatus[]> = {
  expired: [],
  failed: [],
  pending: ["processing"],
  processing: ["successful", "failed", "expired"],
  reversed: [],
  successful: ["reversed"]
};

export function assertCollectionTransition(
  fromStatus: CollectionStatus,
  toStatus: CollectionStatus
) {
  if (!transitions[fromStatus].includes(toStatus)) {
    throw new Error(
      `Invalid collection transition: ${fromStatus} -> ${toStatus}`
    );
  }
}

export function isCollectionTerminalStatus(status: CollectionStatus) {
  return (
    status === "successful" ||
    status === "failed" ||
    status === "expired" ||
    status === "reversed"
  );
}

export function isCollectionFinalEventStatus(status: CollectionStatus) {
  return status === "successful" || status === "failed" || status === "expired";
}

export function mapProviderOutcomeToCollectionStatus(
  outcome: ProviderOutcome
): CollectionStatus | null {
  switch (outcome) {
    case "succeeded":
      return "successful";
    case "failed":
      return "failed";
    case "accepted":
    case "unknown":
      return null;
  }
}

export function mapProviderStatusTextToOutcome(
  providerStatus: string
): ProviderOutcome {
  const normalized = providerStatus.trim().toLowerCase();

  if (["accepted", "pending", "processing"].includes(normalized)) {
    return "accepted";
  }

  if (["expired"].includes(normalized)) {
    return "unknown";
  }

  if (["failed", "declined", "customer_declined", "insufficient_funds"].includes(normalized)) {
    return "failed";
  }

  if (["success", "successful", "succeeded", "completed"].includes(normalized)) {
    return "succeeded";
  }

  return "unknown";
}

export function collectionEventTypeForStatus(status: CollectionStatus): string | null {
  switch (status) {
    case "successful":
      return "collection.successful";
    case "failed":
      return "collection.failed";
    case "expired":
      return "collection.expired";
    default:
      return null;
  }
}

export function refundEventTypeForStatus(
  status: "failed" | "pending" | "processing" | "successful"
): string | null {
  switch (status) {
    case "successful":
      return "refund.successful";
    case "failed":
      return "refund.failed";
    default:
      return null;
  }
}
