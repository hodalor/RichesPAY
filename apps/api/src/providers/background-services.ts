import type { FastifyBaseLogger } from "fastify";

import { startCollectionStatusPollingLoop } from "../collections";
import type { AppDatabase } from "../db";
import { ProviderCallbackService } from "./callbacks";
import { ProviderCatalog } from "./catalog";
import { startProviderHealthCheckLoop } from "./health";
import { createProviderCallbacksWorker } from "./queue";

export function startProviderBackgroundServices(input: {
  database: AppDatabase;
  encryptionKey: string;
  logger?: FastifyBaseLogger;
  redisUrl: string;
}) {
  const catalog = new ProviderCatalog({
    database: input.database,
    encryptionKey: input.encryptionKey
  });
  const callbackService = new ProviderCallbackService({
    catalog,
    database: input.database,
    ...(input.logger ? { logger: input.logger } : {}),
    redisUrl: input.redisUrl
  });

  const worker = createProviderCallbacksWorker(
    input.redisUrl,
    async ({ callbackId }) => callbackService.processCallback(callbackId),
    input.logger
  );

  const healthLoop = startProviderHealthCheckLoop({
    catalog,
    database: input.database,
    ...(input.logger ? { logger: input.logger } : {})
  });
  const collectionLoop = startCollectionStatusPollingLoop({
    database: input.database,
    ...(input.logger ? { logger: input.logger } : {}),
    providerCatalog: catalog
  });

  return {
    async stop() {
      collectionLoop.stop();
      healthLoop.stop();
      await callbackService.close();
      await worker.close();
    }
  };
}
