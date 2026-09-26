import { exec } from "node:child_process";
import { promisify } from "node:util";

import { createDatabasePool } from "../client";
import { startDevPostgres } from "../dev-postgres";
import { applySqlMigrations } from "../migrations";

const execAsync = promisify(exec);

async function main() {
  const devPostgres = await startDevPostgres();
  const pool = createDatabasePool(devPostgres.connectionString);

  try {
    await applySqlMigrations(pool);

    await execAsync(
      "pnpm exec kysely-codegen --out-file src/db/types.ts",
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: devPostgres.connectionString
        }
      }
    );
  } finally {
    await pool.end();
    await devPostgres.stop();
  }
}

void main();
