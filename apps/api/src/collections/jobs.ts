import type { FastifyBaseLogger } from "fastify";

import type { AppDatabase } from "../db";
import { ProviderCatalog } from "../providers/catalog";
import { CollectionService } from "./service";

export class CollectionStatusPollingService {
  #collectionService: CollectionService;
  #logger: FastifyBaseLogger | undefined;
  #providerCatalog: ProviderCatalog;

  constructor(input: {
    database: AppDatabase;
    logger?: FastifyBaseLogger;
    providerCatalog: ProviderCatalog;
  }) {
    this.#collectionService = new CollectionService({
      database: input.database
    });
    this.#logger = input.logger;
    this.#providerCatalog = input.providerCatalog;
  }

  async pollDueCollections(limit = 25): Promise<number> {
    const dueCollections = await this.#collectionService.listDueStatusChecks(limit);

    for (const item of dueCollections) {
      try {
        const provider = this.#providerCatalog.resolveMobileMoneyProvider({
          capabilities: item.capabilities,
          config: item.config,
          countryCode: item.countryCode,
          credentialsEncrypted: item.credentialsEncrypted,
          health: item.health,
          id: item.channelId,
          kind: item.kind,
          mode: item.channelMode,
          network: item.channelNetwork,
          priority: item.priority,
          providerCode: item.providerCode,
          status: item.channelStatus
        });

        const result = item.providerRef
          ? await provider.getStatus(item.providerRef)
          : {
              outcome: "unknown" as const,
              providerRef: null,
              providerStatus: "unknown"
            };

        await this.#collectionService.reconcileProviderResult({
          channelId: item.channelId,
          collectionId: item.collectionId,
          failureCode: result.outcome === "failed" ? result.failureCode ?? null : null,
          merchantId: item.merchantId,
          mode: item.mode,
          now: new Date(),
          outcome: result.outcome,
          providerRef: result.providerRef ?? item.providerRef,
          providerStatus: result.providerStatus ?? null,
          recordStatusCheck: true
        });
      } catch (error) {
        this.#logger?.error(
          {
            collection_id: item.collectionId,
            err: error
          },
          "Collection status polling failed"
        );
      }
    }

    return dueCollections.length;
  }
}

export function startCollectionStatusPollingLoop(input: {
  database: AppDatabase;
  logger?: FastifyBaseLogger;
  providerCatalog: ProviderCatalog;
}) {
  const service = new CollectionStatusPollingService(input);
  const timer = setInterval(() => {
    void service.pollDueCollections().catch((error) => {
      input.logger?.error({ err: error }, "Collection polling loop failed");
    });
  }, 15_000);

  return {
    stop() {
      clearInterval(timer);
    }
  };
}
