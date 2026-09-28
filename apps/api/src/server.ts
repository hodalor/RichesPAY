import "dotenv/config";

import { sql } from "kysely";

import { buildApp } from "./app";
import { loadEnv } from "./env";
import { startOperationalMonitor } from "./observability/monitor";
import { startProviderBackgroundServices } from "./providers/background-services";

async function main() {
  let env;

  try {
    env = loadEnv(process.env);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load API environment";
    console.error(message);
    process.exit(1);
  }

  const { app, db, redis } = await buildApp(env);
  const redisReady = redis.status === "ready";
  const providerServices =
    env.APP_ENV === "test" || !redisReady
      ? null
      : startProviderBackgroundServices({
          database: db,
          encryptionKey: env.ENCRYPTION_KEY,
          floatLowMinor: BigInt(env.PROVIDER_FLOAT_LOW_MINOR ?? 1_000_000),
          logger: app.log,
          redisUrl: env.REDIS_URL
        });

  const monitor =
    env.APP_ENV === "test"
      ? null
      : startOperationalMonitor({
          database: db,
          floatLowMinor: BigInt(env.PROVIDER_FLOAT_LOW_MINOR ?? 1_000_000),
          redis
        });

  if (!providerServices && env.APP_ENV !== "test") {
    app.log.warn(
      "Redis is unavailable. Background jobs are paused and rate limits stay in memory."
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    app.log.info({ signal }, "Shutting down RichesPay API");

    await Promise.allSettled([
      app.close(),
      providerServices?.stop(),
      monitor?.stop(),
      redis.quit(),
      db.destroy()
    ]);
    process.exit(0);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  await app.listen({
    host: "0.0.0.0",
    port: env.PORT
  });

  const supabaseHost = new URL(env.SUPABASE_URL).host;
  try {
    await sql`select 1`.execute(db);
    console.log(`RichesPay API running on port ${env.PORT}`);
    console.log(`Connected to Supabase at ${supabaseHost}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "database check failed";
    console.log(`RichesPay API running on port ${env.PORT}`);
    console.error(`Could not connect to Supabase at ${supabaseHost}: ${message}`);
  }
}

void main();
