import { sql, type Transaction } from "kysely";

import { newId } from "@richespay/shared";

import type { AppDatabase } from "./client";
import type { ActorType, DB, RpMode } from "./types";

export type ScopedTransaction = Transaction<DB>;

interface SystemScopeOptions {
  audit?: boolean;
}

let defaultDatabase: AppDatabase | null = null;
let roleSwitchingEnabled: boolean | null = null;

function getDefaultDatabase(): AppDatabase {
  if (!defaultDatabase) {
    throw new Error("Database has not been registered yet");
  }

  return defaultDatabase;
}

export function registerDatabase(database: AppDatabase) {
  defaultDatabase = database;
  roleSwitchingEnabled = null;
}

/**
 * Hosted Supabase often blocks SET ROLE for the non-superuser `postgres`
 * pooler role. Local/dev Postgres (and tests) still support it. Detect once
 * and skip role switching when unavailable; table-owner / bypassrls access
 * remains sufficient for the API login role.
 */
export async function ensureRoleSwitchingDetected(
  database: AppDatabase = getDefaultDatabase()
): Promise<boolean> {
  if (roleSwitchingEnabled !== null) {
    return roleSwitchingEnabled;
  }

  try {
    await database.transaction().execute(async (trx) => {
      await sql.raw("set local role richespay_system").execute(trx);
    });
    roleSwitchingEnabled = true;
  } catch {
    roleSwitchingEnabled = false;
  }

  return roleSwitchingEnabled;
}

async function applyLocalRole(
  trx: ScopedTransaction,
  role: "richespay_app" | "richespay_system"
) {
  const enabled = await ensureRoleSwitchingDetected();
  if (!enabled) {
    return;
  }

  await sql.raw(`set local role ${role}`).execute(trx);
}

export async function runWithMerchantScope<T>(
  database: AppDatabase,
  merchantId: string,
  mode: RpMode,
  fn: (trx: ScopedTransaction) => Promise<T>
): Promise<T> {
  return database.transaction().execute(async (trx) => {
    await applyLocalRole(trx, "richespay_app");
    await sql`select set_config('app.merchant_id', ${merchantId}, true)`.execute(trx);
    await sql`select set_config('app.mode', ${mode}, true)`.execute(trx);

    return fn(trx);
  });
}

export async function withMerchantScope<T>(
  merchantId: string,
  mode: RpMode,
  fn: (trx: ScopedTransaction) => Promise<T>
): Promise<T> {
  return runWithMerchantScope(getDefaultDatabase(), merchantId, mode, fn);
}

function buildSystemAuditInsert(reason: string, actorType: ActorType = "system") {
  return {
    action: "system_scope",
    actor_id: "richespay_system",
    actor_type: actorType,
    after: {
      reason
    },
    before: null,
    id: newId("aud_"),
    ip: null,
    merchant_id: null,
    mode: sql<RpMode>`coalesce(nullif(current_setting('app.mode', true), ''), 'live')::rp_mode`,
    reason,
    target_id: "richespay_system",
    target_type: "system_scope",
    user_agent: null
  };
}

export async function runWithSystemScope<T>(
  database: AppDatabase,
  reason: string,
  fn: (trx: ScopedTransaction) => Promise<T>,
  options: SystemScopeOptions = {}
): Promise<T> {
  return database.transaction().execute(async (trx) => {
    await applyLocalRole(trx, "richespay_system");

    const result = await fn(trx);

    if (options.audit !== false) {
      await trx
        .insertInto("audit_logs")
        .values(buildSystemAuditInsert(reason))
        .execute();
    }

    return result;
  });
}

export async function withSystemScope<T>(
  reason: string,
  fn: (trx: ScopedTransaction) => Promise<T>,
  options: SystemScopeOptions = {}
): Promise<T> {
  return runWithSystemScope(getDefaultDatabase(), reason, fn, options);
}

// Repository rule: accept ScopedTransaction from withMerchantScope/withSystemScope,
// never the raw Pool or an unscoped Kysely instance.
