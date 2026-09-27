import type { FastifyBaseLogger } from "fastify";

import type { AppDatabase } from "../db";

import { SmsMessagingService } from "./public-service";
import { createSmsMessagesWorker } from "./queue";

export function startSmsProcessingWorker(input: {
  database: AppDatabase;
  encryptionKey: string;
  logger?: FastifyBaseLogger;
  redisUrl: string;
}) {
  const service = new SmsMessagingService({
    database: input.database,
    enableQueue: false,
    encryptionKey: input.encryptionKey
  });

  const worker = createSmsMessagesWorker(
    input.redisUrl,
    async ({ smsMessageId }) => service.processQueuedMessage(smsMessageId),
    input.logger
  );

  return {
    async stop() {
      await Promise.allSettled([service.close(), worker.close()]);
    }
  };
}
