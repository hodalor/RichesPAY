import "dotenv/config";
import { randomBytes } from "node:crypto";

import pg from "pg";

const { Client } = pg;

const required = [
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY"
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env: ${key}`);
  }
}

const baseEmail = process.env.SEED_ADMIN_EMAIL ?? "superadmin1@richespay.local";
const fullName = process.env.SEED_ADMIN_FULL_NAME ?? "Seeded Super Admin";
const password = process.env.SEED_ADMIN_PASSWORD ?? randomBytes(12).toString("base64url");

const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

await db.connect();

const ping = await db.query(
  "select current_database() as database_name, current_user as database_user"
);

let email = baseEmail;
let existing = await db.query(
  "select id::text as id from auth.users where email = $1 limit 1",
  [email]
);

if (existing.rowCount && existing.rowCount > 0 && !process.env.SEED_ADMIN_EMAIL) {
  email = `superadmin1+${Date.now()}@richespay.local`;
  existing = await db.query(
    "select id::text as id from auth.users where email = $1 limit 1",
    [email]
  );
}

let userId;

if (existing.rowCount && existing.rowCount > 0) {
  userId = existing.rows[0].id;
} else {
  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase Auth admin create user failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  userId = data.user?.id ?? data.id;
  if (!userId) {
    throw new Error("Supabase created no user id");
  }
}

await db.query("begin");

try {
  await db.query(
    `insert into public.profiles (user_id, full_name)
     values ($1::uuid, $2)
     on conflict (user_id)
     do update set full_name = excluded.full_name, updated_at = now()`,
    [userId, fullName]
  );

  await db.query(
    `insert into public.platform_admins (user_id, role, active)
     values ($1::uuid, 'super_admin', true)
     on conflict (user_id)
     do update set role = excluded.role, active = true, updated_at = now()`,
    [userId]
  );

  await db.query("commit");
} catch (error) {
  await db.query("rollback");
  throw error;
} finally {
  await db.end();
}

console.log(
  JSON.stringify(
    {
      connected: true,
      database: ping.rows[0]?.database_name ?? null,
      database_user: ping.rows[0]?.database_user ?? null,
      seeded_admin: {
        email,
        full_name: fullName,
        password,
        role: "super_admin",
        user_id: userId
      }
    },
    null,
    2
  )
);
