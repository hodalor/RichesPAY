import { newId } from "@richespay/shared";
import type { FastifyBaseLogger } from "fastify";

import { runWithSystemScope } from "../db";
import type { AppDatabase } from "../db";
import { ProviderCatalog } from "./catalog";
import type { ChannelHealthState, ChannelRecord } from "./types";

export async function runProviderHealthCheck(
  database: AppDatabase,
  catalog: ProviderCatalog,
  logger?: FastifyBaseLogger
) {
  const channels = await runWithSystemScope(
    database,
    "load channels for provider health check",
    async (trx) => {
      const rows = await trx.selectFrom("channels").selectAll().execute();
      return rows.map<ChannelRecord>((row) => ({
        capabilities: row.capabilities,
        config: row.config,
        countryCode: row.country_code,
        credentialsEncrypted: row.credentials_encrypted,
        health: row.health,
        id: row.id,
        kind: row.kind,
        mode: row.mode,
        network: row.network,
        priority: row.priority,
        providerCode: row.provider_code,
        status: row.status
      }));
    },
    { audit: false }
  );

  for (const channel of channels) {
    try {
      const result = await resolveHealthCheck(catalog, channel);
      const nextHealth = result.outcome === "failed"
        ? "down"
        : result.outcome === "unknown"
          ? "degraded"
          : "healthy";

      await updateChannelHealth(database, channel, nextHealth, "scheduled health check");
    } catch (error) {
      logger?.error({ channel_id: channel.id, err: error }, "Provider health check failed");
      await updateChannelHealth(database, channel, "down", "scheduled health check failed");
    }
  }
}

export function startProviderHealthCheckLoop(input: {
  catalog: ProviderCatalog;
  database: AppDatabase;
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}) {
  const intervalMs = input.intervalMs ?? 60_000;
  const timer = setInterval(() => {
    void runProviderHealthCheck(input.database, input.catalog, input.logger);
  }, intervalMs);

  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    }
  };
}

async function resolveHealthCheck(catalog: ProviderCatalog, channel: ChannelRecord) {
  switch (channel.kind) {
    case "card":
      return catalog.resolveCardAcquirer(channel).healthCheck();
    case "mobile_money":
      return catalog.resolveMobileMoneyProvider(channel).healthCheck();
    case "sms":
      return catalog.resolveSmsProvider(channel).healthCheck();
  }
}

async function updateChannelHealth(
  database: AppDatabase,
  channel: ChannelRecord,
  nextHealth: ChannelHealthState,
  reason: string
) {
  if (channel.health === nextHealth) {
    return;
  }

  await runWithSystemScope(
    database,
    "write provider health event",
    async (trx) => {
      await trx
        .updateTable("channels")
        .set({
          health: nextHealth
        })
        .where("id", "=", channel.id)
        .execute();

      await trx
        .insertInto("channel_health_events")
        .values({
          channel_id: channel.id,
          created_at: new Date(),
          detail: null,
          from_health: channel.health,
          id: newId("evt_"),
          reason,
          to_health: nextHealth
        })
        .execute();
    },
    { audit: false }
  );
}
