import type { FastifyBaseLogger } from "fastify";

import { startCollectionStatusPollingLoop } from "../collections";
import { startMerchantDailyStatsLoop } from "../dashboard/stats";
import type { AppDatabase } from "../db";
import { startPayoutProcessingLoop } from "../payouts";
import { startReconciliationFetchLoop } from "../reconciliation";
import { startAutomaticSettlementLoop } from "../settlements";
import { startSmsProcessingWorker } from "../sms/jobs";
import { startWebhookDeliveryLoop } from "../webhooks";
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
  const merchantStatsLoop = startMerchantDailyStatsLoop({
    database: input.database,
    ...(input.logger ? { logger: input.logger } : {})
  });
  const payoutLoop = startPayoutProcessingLoop({
    database: input.database,
    ...(input.logger ? { logger: input.logger } : {}),
    providerCatalog: catalog
  });
  const smsWorker = startSmsProcessingWorker({
    database: input.database,
    encryptionKey: input.encryptionKey,
    ...(input.logger ? { logger: input.logger } : {}),
    redisUrl: input.redisUrl
  });
  const webhookLoop = startWebhookDeliveryLoop({
    database: input.database,
    encryptionKey: input.encryptionKey,
    ...(input.logger ? { logger: input.logger } : {})
  });
  const settlementLoop = startAutomaticSettlementLoop({
    database: input.database,
    ...(input.logger ? { logger: input.logger } : {})
  });
  const reconciliationLoop = startReconciliationFetchLoop({
    database: input.database,
    encryptionKey: input.encryptionKey,
    ...(input.logger ? { logger: input.logger } : {})
  });

  return {
    async stop() {
      collectionLoop.stop();
      healthLoop.stop();
      merchantStatsLoop.stop();
      payoutLoop.stop();
      reconciliationLoop.stop();
      settlementLoop.stop();
      await smsWorker.stop();
      webhookLoop.stop();
      await callbackService.close();
      await worker.close();
    }
  };
}
