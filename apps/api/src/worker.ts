import "dotenv/config";

import { buildApp } from "./app";
import { loadEnv } from "./env";
import { startOperationalMonitor } from "./observability/monitor";
import { startProviderBackgroundServices } from "./providers/background-services";

async function main() {
  const env = loadEnv({
    ...process.env,
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME ?? "richespay-worker"
  });
  const { app, db, redis } = await buildApp(env);
  const services = startProviderBackgroundServices({
    database: db,
    encryptionKey: env.ENCRYPTION_KEY,
    floatLowMinor: BigInt(env.PROVIDER_FLOAT_LOW_MINOR ?? 1_000_000),
    logger: app.log,
    redisUrl: env.REDIS_URL
  });
  const monitor = startOperationalMonitor({
    database: db,
    floatLowMinor: BigInt(env.PROVIDER_FLOAT_LOW_MINOR ?? 1_000_000),
    redis
  });

  const shutdown = async () => {
    await Promise.allSettled([services.stop(), monitor.stop(), redis.quit(), db.destroy(), app.close()]);
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

void main();
