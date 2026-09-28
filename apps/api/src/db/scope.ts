import { sql, type Transaction } from "kysely";

import { newId } from "@richespay/shared";

import { applyTenantPredicates } from "./tenant-guard";
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
 * Hosted Supabase often blocks SET ROLE for the non-superuser postgres
 * pooler role. Merchant queries still attach merchant_id and mode predicates
 * so tenant data cannot leak when the login role bypasses RLS.
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
    // Hosted logins may be table owners and bypass RLS. Tenant predicates
    // on merchant-scoped queries are then the only isolation layer.
  }

  return roleSwitchingEnabled;
}

export function setRoleSwitchingEnabledForTests(value: boolean | null) {
  roleSwitchingEnabled = value;
}

async function applyLocalRole(
  trx: ScopedTransaction,
  role: "richespay_app" | "richespay_system",
  database: AppDatabase
) {
  const enabled = await ensureRoleSwitchingDetected(database);
  if (!enabled) {
    return;
  }

  await sql.raw(`set local role ${role}`).execute(trx);
}

function guardMerchantTransaction(
  trx: ScopedTransaction,
  merchantId: string,
  mode: RpMode
): ScopedTransaction {
  const selectFrom = trx.selectFrom.bind(trx);
  const updateTable = trx.updateTable.bind(trx);
  const deleteFrom = trx.deleteFrom.bind(trx);

  trx.selectFrom = ((table: Parameters<ScopedTransaction["selectFrom"]>[0]) =>
    applyTenantPredicates(selectFrom(table), table, merchantId, mode)) as ScopedTransaction["selectFrom"];
  trx.updateTable = ((table: Parameters<ScopedTransaction["updateTable"]>[0]) =>
    applyTenantPredicates(updateTable(table), table, merchantId, mode)) as ScopedTransaction["updateTable"];
  trx.deleteFrom = ((table: Parameters<ScopedTransaction["deleteFrom"]>[0]) =>
    applyTenantPredicates(deleteFrom(table), table, merchantId, mode)) as ScopedTransaction["deleteFrom"];

  return trx;
}

export async function runWithMerchantScope<T>(
  database: AppDatabase,
  merchantId: string,
  mode: RpMode,
  fn: (trx: ScopedTransaction) => Promise<T>
): Promise<T> {
  return database.transaction().execute(async (trx) => {
    await applyLocalRole(trx, "richespay_app", database);
    await sql`select set_config('app.merchant_id', ${merchantId}, true)`.execute(trx);
    await sql`select set_config('app.mode', ${mode}, true)`.execute(trx);

    return fn(guardMerchantTransaction(trx, merchantId, mode));
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
    await applyLocalRole(trx, "richespay_system", database);

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
