import type { ErrorCode } from "@richespay/shared";

import type { Json } from "../../db/types";
import type { ProviderOutcome, ProviderResult } from "../types";

export interface ProviderStatusMapping {
  failureCode?: ErrorCode;
  outcome: ProviderOutcome;
}

export interface ProviderResultMappingInput {
  errorCode?: string | null;
  errorMap: Record<string, ErrorCode>;
  providerRef?: string | null;
  rawRedacted: Json | null;
  status: string;
  statusMap: Record<string, ProviderStatusMapping>;
}

export function mapProviderResult(
  input: ProviderResultMappingInput
): ProviderResult {
  const normalizedStatus = input.status.trim().toUpperCase();
  const statusMapping = input.statusMap[normalizedStatus] ?? {
    outcome: "unknown"
  };
  const normalizedErrorCode = input.errorCode?.trim().toUpperCase();

  const failureCode = normalizedErrorCode
    ? input.errorMap[normalizedErrorCode] ?? statusMapping.failureCode
    : statusMapping.failureCode;

  return {
    ...(failureCode ? { failureCode } : {}),
    outcome: statusMapping.outcome,
    ...(input.providerRef ? { providerRef: input.providerRef } : {}),
    providerStatus: input.status,
    rawRedacted: input.rawRedacted
  };
}
