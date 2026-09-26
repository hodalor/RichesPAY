import type Redis from "ioredis";

import { getErrorDefinition } from "@richespay/shared";

import { ApiRouteError } from "../lib/api-error";

const inMemoryRateLimitState = new Map<string, { count: number; expiresAt: number }>();

export async function enforceApiKeyRateLimit(
  redis: Redis,
  input: {
    apiKeyId: string;
    limit: number;
    retryAfterSeconds?: number;
  }
): Promise<number> {
  const retryAfterSeconds = input.retryAfterSeconds ?? 1;
  const key = `public_api_rate:${input.apiKeyId}:${Math.floor(Date.now() / 1000)}`;

  let currentCount: number;
  if (redis.status === "ready") {
    currentCount = await redis.incr(key);
    if (currentCount === 1) {
      await redis.expire(key, retryAfterSeconds + 1);
    }
  } else {
    currentCount = incrementInMemoryCounter(key, retryAfterSeconds + 1);
  }

  if (currentCount > input.limit) {
    const definition = getErrorDefinition("rate_limited");
    throw new ApiRouteError({
      code: "rate_limited",
      message: definition.message,
      statusCode: definition.status
    });
  }

  return retryAfterSeconds;
}

function incrementInMemoryCounter(key: string, ttlSeconds: number): number {
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  const current = inMemoryRateLimitState.get(key);

  if (!current || current.expiresAt <= now) {
    inMemoryRateLimitState.set(key, { count: 1, expiresAt });
    return 1;
  }

  current.count += 1;
  inMemoryRateLimitState.set(key, current);
  return current.count;
}
