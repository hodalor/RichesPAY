import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import type { DB } from "./types";

export type AppDatabase = Kysely<DB>;

export function createDatabasePool(connectionString: string): Pool {
  return new Pool({
    connectionString
  });
}

export function createDatabase(pool: Pool): AppDatabase {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool
    })
  });
}
