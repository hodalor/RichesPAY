import { newId } from "@richespay/shared";
import type { FastifyBaseLogger } from "fastify";

import { runWithSystemScope, type AppDatabase } from "../db";
import type { JsonObject } from "../db/types";
import { setGauge } from "../observability/metrics";
import type { ProviderCatalog } from "../providers/catalog";
import type { ChannelRecord } from "../providers/types";

import { AirtimeService } from "./service";
import type { AirtimeFloatStatus } from "./types";

const processingIntervalMs = 5_000;
export const airtimeFloatCheckIntervalMs = 5 * 60_000;

export class AirtimeFloatMonitor {
  #catalog: Pick<ProviderCatalog, "resolveAirtimeProvider">;
  #database: AppDatabase;
  #floatLowMinor: bigint;
  #logger: FastifyBaseLogger | undefined;

  constructor(input: {
    database: AppDatabase;
    floatLowMinor: bigint;
    logger?: FastifyBaseLogger;
    providerCatalog: Pick<ProviderCatalog, "resolveAirtimeProvider">;
  }) {
    this.#catalog = input.providerCatalog;
    this.#database = input.database;
    this.#floatLowMinor = input.floatLowMinor;
    this.#logger = input.logger;
  }

  async checkAll(): Promise<Array<{ channelId: string; status: AirtimeFloatStatus }>> {
    const channels = await runWithSystemScope(
      this.#database,
      "list airtime channels for float check",
      async (trx) => {
        const rows = await trx
          .selectFrom("channels as channel")
          .leftJoin("airtime_channel_floats as float", "float.channel_id", "channel.id")
          .select([
            "channel.capabilities",
            "channel.config",
            "channel.country_code",
            "channel.credentials_encrypted",
            "channel.health",
            "channel.id",
            "channel.kind",
            "channel.mode",
            "channel.network",
            "channel.priority",
            "channel.provider_code",
            "channel.status",
            "float.status as previousStatus"
          ])
          .where("channel.kind", "=", "airtime")
          .where("channel.status", "=", "active")
          .execute();

        return rows.map((row) => ({
          channel: {
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
          } satisfies ChannelRecord,
          previousStatus: row.previousStatus
        }));
      },
      { audit: false }
    );

    const results: Array<{ channelId: string; status: AirtimeFloatStatus }> = [];

    for (const { channel, previousStatus } of channels) {
      const threshold = floatThresholdFor(channel, this.#floatLowMinor);
      let balanceMinor: number | null = null;
      let currency: string | null = null;

      try {
        const balance = await this.#catalog.resolveAirtimeProvider(channel).getFloatBalance();
        balanceMinor = balance.balanceMinor;
        currency = balance.currency;
      } catch (error) {
        this.#logger?.warn({ channel_id: channel.id, err: error }, "Airtime float check failed");
      }

      const status = classifyFloat(balanceMinor, threshold);
      const checkedAt = new Date();
      await runWithSystemScope(
        this.#database,
        "store airtime float snapshot",
        async (trx) => {
          await trx
            .insertInto("airtime_channel_floats")
            .values({
              balance_minor: balanceMinor,
              channel_id: channel.id,
              checked_at: checkedAt,
              currency,
              status,
              threshold_minor: threshold
            })
            .onConflict((conflict) =>
              conflict.column("channel_id").doUpdateSet({
                balance_minor: balanceMinor,
                checked_at: checkedAt,
                currency,
                status,
                threshold_minor: threshold
              })
            )
            .execute();

          await trx
            .insertInto("airtime_channel_float_history")
            .values({
              balance_minor: balanceMinor,
              channel_id: channel.id,
              checked_at: checkedAt,
              currency,
              id: newId("afh_"),
              status,
              threshold_minor: threshold
            })
            .execute();
        },
        { audit: false }
      );

      setGauge("airtime_float_low", status === "low" || status === "empty" ? 1 : 0, {
        channel: channel.id,
        country: channel.countryCode,
        network: channel.network ?? "all"
      });

      if ((status === "low" || status === "empty") && previousStatus !== status) {
        this.#logger?.warn(
          {
            balance_minor: balanceMinor,
            channel_id: channel.id,
            country_code: channel.countryCode,
            network: channel.network,
            status,
            threshold_minor: Number(threshold)
          },
          status === "empty"
            ? "Airtime float is empty; routing moves to backup channels"
            : "Airtime float is below the alert threshold"
        );
      }

      results.push({ channelId: channel.id, status });
    }

    return results;
  }
}

export function classifyFloat(balanceMinor: number | null, thresholdMinor: bigint): AirtimeFloatStatus {
  if (balanceMinor === null) {
    return "unknown";
  }

  if (balanceMinor <= 0) {
    return "empty";
  }

  return BigInt(balanceMinor) < thresholdMinor ? "low" : "ok";
}

function floatThresholdFor(channel: ChannelRecord, fallback: bigint): bigint {
  const config = channel.config;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const raw = (config as JsonObject).float_low_minor;
    if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
      return BigInt(raw);
    }
  }

  return fallback;
}

export function startAirtimeProcessingLoop(input: {
  database: AppDatabase;
  floatLowMinor: bigint;
  logger?: FastifyBaseLogger;
  providerCatalog: ProviderCatalog;
}) {
  const service = new AirtimeService({
    database: input.database,
    providerCatalog: input.providerCatalog
  });
  const floatMonitor = new AirtimeFloatMonitor({
    database: input.database,
    floatLowMinor: input.floatLowMinor,
    ...(input.logger ? { logger: input.logger } : {}),
    providerCatalog: input.providerCatalog
  });
  let processing = false;
  let checkingFloats = false;

  const processTick = () => {
    if (processing) return;
    processing = true;
    void (async () => {
      await service.processPendingOrders();
      await service.pollDueStatusChecks();
    })()
      .catch((error) => input.logger?.error({ err: error }, "Airtime processing loop failed"))
      .finally(() => {
        processing = false;
      });
  };

  const floatTick = () => {
    if (checkingFloats) return;
    checkingFloats = true;
    void floatMonitor
      .checkAll()
      .catch((error) => input.logger?.error({ err: error }, "Airtime float check failed"))
      .finally(() => {
        checkingFloats = false;
      });
  };

  const processTimer = setInterval(processTick, processingIntervalMs);
  const floatTimer = setInterval(floatTick, airtimeFloatCheckIntervalMs);
  processTimer.unref();
  floatTimer.unref();
  processTick();
  floatTick();

  return {
    stop() {
      clearInterval(processTimer);
      clearInterval(floatTimer);
    }
  };
}
