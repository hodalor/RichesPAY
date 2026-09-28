import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import type { DB } from "./types";

export type AppDatabase = Kysely<DB>;

export function createDatabasePool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 10_000,
    max: 8
  });
}

export function createDatabase(pool: Pool): AppDatabase {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool
    })
  });
}
