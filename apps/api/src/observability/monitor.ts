import { sql } from "kysely";

import type { AppDatabase } from "../db";
import { runWithSystemScope } from "../db";
import { providerCallbacksQueueName } from "../providers/queue";
import { smsMessagesQueueName } from "../sms/queue";
import {
  floatBalanceIsLow,
  queueBacklogThreshold,
  successRate,
  successRateDropped
} from "./alerts";
import { setGauge } from "./metrics";

interface MonitorInput {
  database: AppDatabase;
  floatLowMinor: bigint;
  intervalMs?: number;
  redis?: {
    llen: (key: string) => Promise<number>;
    status: string;
  } | null;
}

export function startOperationalMonitor(input: MonitorInput) {
  const intervalMs = input.intervalMs ?? 60_000;
  const timer = setInterval(() => {
    void collectOperationalSignals(input).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  void collectOperationalSignals(input).catch(() => undefined);

  return {
    stop() {
      clearInterval(timer);
    }
  };
}

export async function collectOperationalSignals(input: MonitorInput) {
  await runWithSystemScope(
    input.database,
    "collect operational alert signals",
    async (trx) => {
      const channels = await trx
        .selectFrom("channels")
        .select(["country_code", "health", "id", "network", "provider_code", "status"])
        .execute();

      for (const channel of channels) {
        const labels = {
          channel: channel.provider_code,
          country: channel.country_code,
          network: channel.network ?? "none"
        };
        setGauge("channel_up", channel.health === "down" || channel.status === "disabled" ? 0 : 1, labels);
      }

      const windows = await sql<{
        channel: string;
        country: string;
        current_successes: string;
        current_total: string;
        network: string;
        previous_successes: string;
        previous_total: string;
      }>`
        with recent as (
          select
            c.channel_id,
            ch.country_code,
            coalesce(c.network, 'none') as network,
            count(*) filter (where c.created_at >= now() - interval '15 minutes' and c.status = 'successful') as current_successes,
            count(*) filter (where c.created_at >= now() - interval '15 minutes') as current_total,
            count(*) filter (
              where c.created_at >= now() - interval '30 minutes'
                and c.created_at < now() - interval '15 minutes'
                and c.status = 'successful'
            ) as previous_successes,
            count(*) filter (
              where c.created_at >= now() - interval '30 minutes'
                and c.created_at < now() - interval '15 minutes'
            ) as previous_total
          from public.collections c
          join public.channels ch on ch.id = c.channel_id
          where c.created_at >= now() - interval '30 minutes'
          group by c.channel_id, ch.country_code, coalesce(c.network, 'none')
        )
        select
          channel_id as channel,
          country_code as country,
          network,
          current_successes::text,
          current_total::text,
          previous_successes::text,
          previous_total::text
        from recent
      `.execute(trx);

      for (const row of windows.rows) {
        const dropped = successRateDropped({
          currentSuccesses: Number(row.current_successes),
          currentTotal: Number(row.current_total),
          previousSuccesses: Number(row.previous_successes),
          previousTotal: Number(row.previous_total)
        });
        const rate = successRate(Number(row.current_successes), Number(row.current_total)) ?? 0;
        const labels = { channel: row.channel, country: row.country, network: row.network };
        setGauge("channel_success_rate", rate, labels);
        setGauge("channel_success_rate_drop", dropped ? 1 : 0, labels);
      }

      const mismatches = await sql<{ count: string }>`
        with computed as (
          select
            p.account_id,
            coalesce(sum(case p.direction when 'credit' then p.amount else -p.amount end), 0)::bigint as computed_balance
          from public.postings p
          group by p.account_id
        )
        select count(*)::text as count
        from public.account_balances ab
        left join computed c on c.account_id = ab.account_id
        where ab.balance <> coalesce(c.computed_balance, 0)::bigint
      `.execute(trx);
      setGauge("ledger_mismatches", Number(mismatches.rows[0]?.count ?? 0));

      const exceptions = await trx
        .selectFrom("recon_exceptions")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("status", "=", "open")
        .executeTakeFirst();
      setGauge("reconciliation_exceptions_open", Number(exceptions?.count ?? 0));

      const disabledWebhooks = await trx
        .selectFrom("webhook_endpoints")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("enabled", "=", false)
        .executeTakeFirst();
      setGauge("webhook_endpoints_disabled", Number(disabledWebhooks?.count ?? 0));

      const webhookFailures = await sql<{ count: string }>`
        select count(*)::text as count
        from public.webhook_deliveries
        where created_at >= now() - interval '15 minutes'
          and (status_code is null or status_code >= 400)
          and delivered_at is null
      `.execute(trx);
      setGauge("webhook_failures", Number(webhookFailures.rows[0]?.count ?? 0));

      const sms = await sql<{ delivered: string; terminal: string }>`
        select
          count(*) filter (where status = 'delivered')::text as delivered,
          count(*) filter (where status in ('delivered', 'failed', 'undelivered', 'rejected'))::text as terminal
        from public.sms_messages
        where created_at >= now() - interval '1 hour'
      `.execute(trx);
      const delivered = Number(sms.rows[0]?.delivered ?? 0);
      const terminal = Number(sms.rows[0]?.terminal ?? 0);
      setGauge("sms_delivery_rate", successRate(delivered, terminal) ?? 1);

      const floats = await sql<{
        balance: string | null;
        channel: string;
        country: string;
      }>`
        select distinct on (statement.channel_id)
          statement.float_balance_minor::text as balance,
          channel.provider_code as channel,
          channel.country_code as country
        from public.provider_statements statement
        join public.channels channel on channel.id = statement.channel_id
        order by statement.channel_id, statement.statement_date desc
      `.execute(trx);

      for (const row of floats.rows) {
        const balance = row.balance === null ? null : BigInt(row.balance);
        setGauge(
          "provider_float_low",
          floatBalanceIsLow(balance, input.floatLowMinor) ? 1 : 0,
          { channel: row.channel, country: row.country }
        );
      }
    },
    { audit: false }
  );

  if (input.redis && input.redis.status === "ready") {
    for (const queue of [smsMessagesQueueName, providerCallbacksQueueName]) {
      const waiting = await input.redis.llen(`bull:${queue}:wait`).catch(() => 0);
      const active = await input.redis.llen(`bull:${queue}:active`).catch(() => 0);
      const depth = waiting + active;
      setGauge("queue_depth", depth, { queue });
      setGauge("queue_backlog", depth > queueBacklogThreshold ? 1 : 0, { queue });
    }
  }
}
