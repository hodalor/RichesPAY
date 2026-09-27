import type { FastifyBaseLogger } from "fastify";

import type { AppDatabase } from "../db";

import { SettlementService } from "./service";

export function startAutomaticSettlementLoop(input: {
  database: AppDatabase;
  logger?: FastifyBaseLogger;
}) {
  const service = new SettlementService({
    database: input.database
  });
  let running = false;

  const tick = () => {
    if (running) {
      return;
    }

    running = true;
    void service
      .runAutomaticDailySettlements()
      .catch((error) => {
        input.logger?.error({ err: error }, "Automatic settlement loop failed");
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, 60 * 60_000);
  tick();

  return {
    stop() {
      clearInterval(timer);
    }
  };
}
