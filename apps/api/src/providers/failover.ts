import { getErrorDefinition } from "@richespay/shared";

import { ApiRouteError } from "../lib/api-error";
import { classifyNetworkFailure } from "./circuit-breaker";
import type { ProviderResult } from "./types";

export interface FailoverExecutor<T> {
  execute(channelId: string): Promise<T>;
}

export async function executeWithFailover<T>(
  input: {
    allowFailoverOnAnySubmitFailure: boolean;
    channelIds: string[];
    executor: FailoverExecutor<T>;
  }
): Promise<T> {
  let lastError: unknown;

  for (let index = 0; index < input.channelIds.length; index += 1) {
    const channelId = input.channelIds[index]!;

    try {
      return await input.executor.execute(channelId);
    } catch (error) {
      lastError = error;
      const failureClass = classifyNetworkFailure(error);
      const canTryNext =
        input.allowFailoverOnAnySubmitFailure ||
        failureClass === "before_send";

      if (!canTryNext || index === input.channelIds.length - 1) {
        throw normalizeProviderSubmitError(error, failureClass);
      }
    }
  }

  throw normalizeProviderSubmitError(lastError, "hard");
}

export function normalizeProviderSubmitError(
  error: unknown,
  failureClass: "before_send" | "hard" | "unknown"
) {
  if (failureClass === "unknown") {
    return new ApiRouteError({
      code: "provider_error",
      message: "Provider outcome is unknown and must be resolved via a status check.",
      statusCode: 502
    });
  }

  if (error instanceof ApiRouteError) {
    return error;
  }

  const definition = getErrorDefinition("channel_unavailable");
  return new ApiRouteError({
    code: "channel_unavailable",
    message: definition.message,
    statusCode: definition.status
  });
}

export function providerResultFailed(result: ProviderResult): boolean {
  return result.outcome === "failed";
}
