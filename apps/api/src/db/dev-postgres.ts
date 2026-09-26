import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import EmbeddedPostgres from "embedded-postgres";

export interface DevPostgresHandle {
  connectionString: string;
  stop: () => Promise<void>;
}

function isRetryableCleanupError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EBUSY" || error.code === "ENOTEMPTY" || error.code === "EPERM")
  );
}

async function removeDirectoryWithRetry(directory: string): Promise<void> {
  const maxAttempts = 8;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rm(directory, {
        force: true,
        recursive: true
      });
      return;
    } catch (error) {
      if (!isRetryableCleanupError(error) || attempt === maxAttempts) {
        throw error;
      }

      await delay(attempt * 150);
    }
  }
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a TCP port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

export async function startDevPostgres(
  databaseDir = path.join(os.tmpdir(), `richespay-pg-${randomUUID()}`)
): Promise<DevPostgresHandle> {
  const port = await getAvailablePort();
  const postgres = new EmbeddedPostgres({
    authMethod: "password",
    databaseDir,
    password: "postgres",
    persistent: false,
    port,
    user: "postgres"
  });

  await postgres.initialise();
  await postgres.start();

  const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  let stopped = false;

  return {
    connectionString,
    stop: async () => {
      if (stopped) {
        return;
      }

      stopped = true;
      await postgres.stop();
      await removeDirectoryWithRetry(databaseDir);
    }
  };
}
