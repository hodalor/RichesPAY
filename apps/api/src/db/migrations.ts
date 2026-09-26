import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface SqlExecutor {
  query: (queryText: string) => Promise<unknown>;
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export const defaultMigrationDirectory = path.resolve(
  currentDirectory,
  "..",
  "..",
  "..",
  "..",
  "supabase",
  "migrations"
);

export async function getMigrationFiles(
  migrationDirectory = defaultMigrationDirectory
): Promise<string[]> {
  const entries = await readdir(migrationDirectory, {
    withFileTypes: true
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => path.join(migrationDirectory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export async function applySqlMigrations(
  executor: SqlExecutor,
  migrationDirectory = defaultMigrationDirectory
) {
  const migrationFiles = await getMigrationFiles(migrationDirectory);

  for (const migrationFile of migrationFiles) {
    const sqlText = await readFile(migrationFile, "utf8");
    if (sqlText.trim() === "") {
      continue;
    }

    await executor.query(sqlText);
  }
}
