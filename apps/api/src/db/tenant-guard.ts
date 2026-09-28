import type { RpMode } from "./types";

const TENANT_ID_TABLES = new Set(["merchants"]);

const TENANT_TABLES = new Set([
  "airtime_batches",
  "airtime_orders",
  "api_keys",
  "api_request_logs",
  "checkout_sessions",
  "collections",
  "compliance_review_flags",
  "contact_group_members",
  "contact_groups",
  "contacts",
  "email_outbox",
  "events_outbox",
  "idempotency_keys",
  "invitations",
  "journal_entries",
  "kyb_documents",
  "kyb_profiles",
  "ledger_accounts",
  "memberships",
  "merchant_balance_alert_thresholds",
  "merchant_compliance_profiles",
  "merchant_daily_stats",
  "merchant_fee_overrides",
  "merchant_freeze_history",
  "merchant_notifications",
  "merchant_products",
  "merchant_rolling_reserve_holds",
  "merchant_settlement_settings",
  "payment_links",
  "payout_batches",
  "payouts",
  "postings",
  "provider_statements",
  "provider_statement_lines",
  "recon_daily_summaries",
  "recon_exceptions",
  "refunds",
  "sender_id_approvals",
  "sender_ids",
  "settlement_accounts",
  "sms_batches",
  "sms_messages",
  "sms_opt_outs",
  "sms_otps",
  "sms_templates",
  "topups",
  "transaction_events",
  "webhook_deliveries",
  "webhook_endpoints",
  "withdrawals"
]);

interface QueryWithWhere {
  where: (column: string, op: "=", value: string) => QueryWithWhere;
}

export function applyTenantPredicates<T>(
  query: T,
  table: unknown,
  merchantId: string,
  mode: RpMode
): T {
  const parsed = parseTableRef(table);
  if (!parsed) {
    return query;
  }

  const scoped = query as QueryWithWhere;

  if (TENANT_ID_TABLES.has(parsed.name)) {
    return scoped
      .where(`${parsed.alias}.id`, "=", merchantId)
      .where(`${parsed.alias}.mode`, "=", mode) as T;
  }

  if (!TENANT_TABLES.has(parsed.name)) {
    return query;
  }

  return scoped
    .where(`${parsed.alias}.merchant_id`, "=", merchantId)
    .where(`${parsed.alias}.mode`, "=", mode) as T;
}

function parseTableRef(table: unknown): { alias: string; name: string } | null {
  if (typeof table !== "string") {
    return null;
  }

  const [name, alias] = table.split(/\s+as\s+/i).map((part) => part.trim());
  if (!name) {
    return null;
  }

  return {
    alias: alias || name,
    name
  };
}
