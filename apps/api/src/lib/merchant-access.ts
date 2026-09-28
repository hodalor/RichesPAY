import type { RpMode } from "../db/types";

export function merchantCanTransact(input: { mode: RpMode; status: string }): boolean {
  if (input.status === "active") {
    return true;
  }

  // Sandbox traffic is allowed while KYB is still under review.
  return input.mode === "test" && input.status === "pending_kyb";
}
