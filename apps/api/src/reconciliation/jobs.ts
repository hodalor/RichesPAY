import type { FastifyBaseLogger } from "fastify";

import type { AppDatabase } from "../db";
import { ProviderCatalog } from "../providers/catalog";

import { ReconciliationService } from "./service";

export function startReconciliationFetchLoop(input: {
  database: AppDatabase;
  encryptionKey: string;
  logger?: FastifyBaseLogger;
}) {
  const service = new ReconciliationService({
    database: input.database,
    providerCatalog: new ProviderCatalog({
      database: input.database,
      encryptionKey: input.encryptionKey
    })
  });
  let running = false;

  const tick = () => {
    if (running) {
      return;
    }

    running = true;
    const today = new Date().toISOString().slice(0, 10);
    void service
      .fetchDailyStatements({
        statementDate: today
      })
      .catch((error) => {
        input.logger?.error({ err: error }, "Reconciliation fetch loop failed");
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, 24 * 60 * 60_000);
  tick();

  return {
    stop() {
      clearInterval(timer);
    }
  };
}
