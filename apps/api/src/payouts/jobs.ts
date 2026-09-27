import type { FastifyBaseLogger } from "fastify";

import type { AppDatabase } from "../db";
import { ProviderCatalog } from "../providers/catalog";

import { PayoutService } from "./service";

export class PayoutProcessingService {
  #payoutService: PayoutService;

  constructor(input: {
    database: AppDatabase;
    logger?: FastifyBaseLogger;
    providerCatalog: ProviderCatalog;
  }) {
    this.#payoutService = new PayoutService({
      database: input.database,
      providerCatalog: input.providerCatalog
    });
  }

  async process(limit = 50) {
    const queued = await this.#payoutService.processQueuedPayouts(limit);
    const polled = await this.#payoutService.pollDueStatusChecks(limit);

    return {
      polled,
      queued
    };
  }
}

export function startPayoutProcessingLoop(input: {
  database: AppDatabase;
  logger?: FastifyBaseLogger;
  providerCatalog: ProviderCatalog;
}) {
  const service = new PayoutProcessingService(input);
  let running = false;

  const tick = () => {
    if (running) {
      return;
    }

    running = true;
    void service
      .process()
      .catch((error) => {
        input.logger?.error({ err: error }, "Payout processing loop failed");
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
