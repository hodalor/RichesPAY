import "dotenv/config";

import { buildApp } from "./app";
import { loadEnv } from "./env";
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
  const providerServices =
    env.APP_ENV === "test"
      ? null
      : startProviderBackgroundServices({
          database: db,
          encryptionKey: env.ENCRYPTION_KEY,
          logger: app.log,
          redisUrl: env.REDIS_URL
        });

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
}

void main();
