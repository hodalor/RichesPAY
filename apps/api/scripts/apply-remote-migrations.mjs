import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("Missing required env: DATABASE_URL");
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationDirectory = path.resolve(
  currentDirectory,
  "..",
  "..",
  "..",
  "supabase",
  "migrations"
);

const entries = await readdir(migrationDirectory, { withFileTypes: true });
const migrationFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => path.join(migrationDirectory, entry.name))
  .sort((left, right) => left.localeCompare(right));

const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

await db.connect();

for (const migrationFile of migrationFiles) {
  let sqlText = await readFile(migrationFile, "utf8");
  if (sqlText.trim() === "") {
    continue;
  }

  if (path.basename(migrationFile) === "202609260001_core_schema.sql") {
    sqlText = sqlText
      .replace('create schema if not exists auth;\n\n', "")
      .replace(
        /create table if not exists auth\.users \([\s\S]*?\);\n\n/,
        ""
      );
  }

  if (path.basename(migrationFile) === "202609260002_seed_local_data.sql") {
    sqlText = `begin;

insert into public.countries (code, name, currency, timezone, dial_code, enabled)
values
  ('GH', 'Ghana', 'GHS', 'Africa/Accra', '+233', true),
  ('ZM', 'Zambia', 'ZMW', 'Africa/Lusaka', '+260', true)
on conflict (code) do update
set
  name = excluded.name,
  currency = excluded.currency,
  timezone = excluded.timezone,
  dial_code = excluded.dial_code,
  enabled = excluded.enabled;

commit;
`;
  }

  await db.query(sqlText);
}

console.log(
  JSON.stringify(
    {
      applied_migrations: migrationFiles.map((file) => path.basename(file))
    },
    null,
    2
  )
);

await db.end();
