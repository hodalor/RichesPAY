import type { FastifyBaseLogger } from "fastify";

import type { AppDatabase } from "../db";

import { WebhookService } from "./service";

export class WebhookDeliveryService {
  #webhookService: WebhookService;

  constructor(input: {
    database: AppDatabase;
    encryptionKey: string;
    logger?: FastifyBaseLogger;
  }) {
    this.#webhookService = new WebhookService({
      database: input.database,
      encryptionKey: input.encryptionKey,
      ...(input.logger ? { logger: input.logger } : {})
    });
  }

  async process(limit = 25): Promise<number> {
    return this.#webhookService.processDueDeliveries(limit);
  }
}

export function startWebhookDeliveryLoop(input: {
  database: AppDatabase;
  encryptionKey: string;
  logger?: FastifyBaseLogger;
}) {
  const service = new WebhookDeliveryService(input);
  let running = false;

  const tick = () => {
    if (running) {
      return;
    }

    running = true;
    void service
      .process()
      .catch((error) => {
        input.logger?.error({ err: error }, "Webhook delivery loop failed");
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, 15_000);
  tick();

  return {
    stop() {
      clearInterval(timer);
    }
  };
}
