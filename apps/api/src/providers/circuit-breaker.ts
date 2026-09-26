import { newId } from "@richespay/shared";
import type Redis from "ioredis";

import { runWithSystemScope } from "../db";
import type { AppDatabase } from "../db";

const hardFailureWindowMs = 60_000;
const openDurationMs = 120_000;
const hardFailureThreshold = 5;

interface CircuitState {
  failures: number[];
  openUntil: number | null;
  state: "closed" | "half_open" | "open";
}

export class ChannelCircuitBreaker {
  #database: AppDatabase | undefined;
  #memory = new Map<string, CircuitState>();
  #now: () => number;
  #redis: Redis;

  constructor(input: {
    database?: AppDatabase;
    now?: () => number;
    redis: Redis;
  }) {
    this.#database = input.database;
    this.#now = input.now ?? Date.now;
    this.#redis = input.redis;
  }

  async canRequest(channelId: string): Promise<boolean> {
    const state = await this.#loadState(channelId);
    const now = this.#now();

    if (state.openUntil && state.openUntil > now) {
      return false;
    }

    if (state.openUntil && state.openUntil <= now) {
      state.openUntil = null;
      state.state = "half_open";
      await this.#saveState(channelId, state);
    }

    return true;
  }

  async recordHardFailure(channelId: string, reason: string): Promise<void> {
    const state = await this.#loadState(channelId);
    const now = this.#now();

    state.failures = state.failures
      .filter((timestamp) => timestamp >= now - hardFailureWindowMs)
      .concat(now);

    if (state.state === "half_open" || state.failures.length >= hardFailureThreshold) {
      const previousState = state.state;
      state.openUntil = now + openDurationMs;
      state.state = "open";
      await this.#saveState(channelId, state);
      await this.#markChannelHealth(channelId, "down", previousState, reason);
      return;
    }

    await this.#saveState(channelId, state);
  }

  async recordSuccess(channelId: string): Promise<void> {
    const state = await this.#loadState(channelId);
    const previousState = state.state;
    state.failures = [];
    state.openUntil = null;
    state.state = "closed";
    await this.#saveState(channelId, state);

    if (previousState !== "closed") {
      await this.#markChannelHealth(channelId, "healthy", previousState, "circuit recovered");
    }
  }

  async #loadState(channelId: string): Promise<CircuitState> {
    const redisKey = `provider:circuit:${channelId}`;

    if (this.#redis.status === "ready") {
      const stored = await this.#redis.get(redisKey);
      if (stored) {
        return JSON.parse(stored) as CircuitState;
      }
    }

    return this.#memory.get(channelId) ?? {
      failures: [],
      openUntil: null,
      state: "closed"
    };
  }

  async #markChannelHealth(
    channelId: string,
    nextHealth: "down" | "healthy",
    previousState: CircuitState["state"],
    reason: string
  ) {
    if (!this.#database) {
      return;
    }

    await runWithSystemScope(
      this.#database,
      "update channel health from circuit breaker",
      async (trx) => {
        const before = await trx
          .selectFrom("channels")
          .select(["health"])
          .where("id", "=", channelId)
          .executeTakeFirst();

        if (!before || before.health === nextHealth) {
          return;
        }

        await trx
          .updateTable("channels")
          .set({
            health: nextHealth
          })
          .where("id", "=", channelId)
          .execute();

        await trx
          .insertInto("channel_health_events")
          .values({
            channel_id: channelId,
            created_at: new Date(this.#now()),
            detail: {
              circuit_state: previousState
            },
            from_health: before.health,
            id: newId("evt_"),
            reason,
            to_health: nextHealth
          })
          .execute();
      },
      { audit: false }
    );
  }

  async #saveState(channelId: string, state: CircuitState): Promise<void> {
    const redisKey = `provider:circuit:${channelId}`;

    if (this.#redis.status === "ready") {
      await this.#redis.set(redisKey, JSON.stringify(state), "PX", openDurationMs + hardFailureWindowMs);
    }

    this.#memory.set(channelId, state);
  }
}

export function classifyNetworkFailure(error: unknown): "before_send" | "unknown" | "hard" {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : null;

  if (
    code &&
    [
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ERR_SSL_PROTOCOL_ERROR",
      "ERR_TLS_CERT_ALTNAME_INVALID"
    ].includes(code)
  ) {
    return "before_send";
  }

  if (code && ["ETIMEDOUT", "ECONNABORTED"].includes(code)) {
    return "unknown";
  }

  return "hard";
}
