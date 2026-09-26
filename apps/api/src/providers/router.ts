import { runWithSystemScope } from "../db";
import type { AppDatabase } from "../db";
import type { RpMode } from "../db/types";
import type {
  ChannelCapability,
  ChannelKind,
  ChannelRecord,
  RoutingRuleRecord
} from "./types";

export interface ChannelRegistry {
  getSimulatorChannel(input: {
    capability: ChannelCapability;
    kind: ChannelKind;
  }): Promise<ChannelRecord | null>;
  listChannels(input: {
    countryCode: string;
    kind: ChannelKind;
    mode: RpMode;
    network?: string | null;
  }): Promise<ChannelRecord[]>;
  loadRoutingRule(input: {
    capability: ChannelCapability;
    countryCode: string;
    kind: ChannelKind;
    network?: string | null;
  }): Promise<RoutingRuleRecord | null>;
}

export class ChannelRouter {
  #registry: ChannelRegistry;

  constructor(registry: ChannelRegistry) {
    this.#registry = registry;
  }

  async pick(
    kind: ChannelKind,
    capability: ChannelCapability,
    countryCode: string,
    network: string | null,
    mode: RpMode
  ): Promise<ChannelRecord | null> {
    if (mode === "test") {
      return this.#registry.getSimulatorChannel({ capability, kind });
    }

    const candidates = await this.#registry.listChannels({
      countryCode,
      kind,
      mode,
      network
    });

    const eligible = candidates.filter((channel) =>
      channel.status === "active" &&
      channel.health === "healthy" &&
      channel.capabilities.includes(capability)
    );

    const rule = await this.#registry.loadRoutingRule({
      capability,
      countryCode,
      kind,
      network
    });

    if (rule) {
      const byId = new Map(eligible.map((channel) => [channel.id, channel]));
      for (const channelId of rule.channelIds) {
        const match = byId.get(channelId);
        if (match) {
          return match;
        }
      }
    }

    return eligible
      .sort((left, right) => left.priority - right.priority)
      .at(0) ?? null;
  }
}

export class DatabaseChannelRegistry implements ChannelRegistry {
  #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  async getSimulatorChannel(input: {
    capability: ChannelCapability;
    kind: ChannelKind;
  }): Promise<ChannelRecord | null> {
    return runWithSystemScope(
      this.#database,
      "load simulator channel",
      async (trx) => {
        const row = await trx
          .selectFrom("channels")
          .selectAll()
          .where("provider_code", "=", "simulator")
          .where("kind", "=", input.kind)
          .where("mode", "=", "test")
          .where("status", "=", "active")
          .where("health", "!=", "down")
          .orderBy("priority")
          .executeTakeFirst();

        return row ? mapChannel(row) : null;
      },
      { audit: false }
    );
  }

  async listChannels(input: {
    countryCode: string;
    kind: ChannelKind;
    mode: RpMode;
    network?: string | null;
  }): Promise<ChannelRecord[]> {
    return runWithSystemScope(
      this.#database,
      "list routable channels",
      async (trx) => {
        let query = trx
          .selectFrom("channels")
          .selectAll()
          .where("country_code", "=", input.countryCode)
          .where("kind", "=", input.kind)
          .where("mode", "=", input.mode)
          .orderBy("priority");

        if (input.network) {
          const network = input.network;
          query = query.where((eb) =>
            eb.or([
              eb("network", "=", network),
              eb("network", "is", null)
            ])
          );
        }

        return (await query.execute()).map(mapChannel);
      },
      { audit: false }
    );
  }

  async loadRoutingRule(input: {
    capability: ChannelCapability;
    countryCode: string;
    kind: ChannelKind;
    network?: string | null;
  }): Promise<RoutingRuleRecord | null> {
    return runWithSystemScope(
      this.#database,
      "load channel routing rule",
      async (trx) => {
        let exactQuery = trx
          .selectFrom("routing_rules")
          .selectAll()
          .where("country_code", "=", input.countryCode)
          .where("kind", "=", input.kind)
          .where("capability", "=", input.capability);

        exactQuery = input.network
          ? exactQuery.where("network", "=", input.network)
          : exactQuery.where("network", "is", null);

        const exact = await exactQuery.executeTakeFirst();

        if (exact) {
          return mapRoutingRule(exact);
        }

        const fallback = await trx
          .selectFrom("routing_rules")
          .selectAll()
          .where("country_code", "=", input.countryCode)
          .where("kind", "=", input.kind)
          .where("capability", "=", input.capability)
          .where("network", "is", null)
          .executeTakeFirst();

        return fallback ? mapRoutingRule(fallback) : null;
      },
      { audit: false }
    );
  }
}

function mapChannel(row: {
  capabilities: ChannelRecord["capabilities"];
  config: ChannelRecord["config"];
  country_code: string;
  credentials_encrypted: string;
  health: ChannelRecord["health"];
  id: string;
  kind: ChannelRecord["kind"];
  mode: ChannelRecord["mode"];
  network: string | null;
  priority: number;
  provider_code: string;
  status: ChannelRecord["status"];
}): ChannelRecord {
  return {
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
  };
}

function mapRoutingRule(row: {
  capability: RoutingRuleRecord["capability"];
  channel_ids: string[];
  country_code: string;
  kind: RoutingRuleRecord["kind"];
  network: string | null;
}): RoutingRuleRecord {
  return {
    capability: row.capability,
    channelIds: row.channel_ids,
    countryCode: row.country_code,
    kind: row.kind,
    network: row.network
  };
}
