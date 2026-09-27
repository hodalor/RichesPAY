import type { FastifyBaseLogger } from "fastify";
import { sql } from "kysely";

import { runWithSystemScope, type AppDatabase } from "../db";

export async function refreshMerchantDailyStats(database: AppDatabase) {
  await runWithSystemScope(
    database,
    "refresh merchant daily stats",
    async (trx) => {
      await sql`
        delete from public.merchant_daily_stats
        where stat_date >= current_date - interval '61 days'
      `.execute(trx);

      await sql`
        insert into public.merchant_daily_stats (
          merchant_id,
          mode,
          stat_date,
          collections_count,
          collections_successful_count,
          collections_pending_count,
          collections_amount_minor,
          payouts_count,
          payouts_successful_count,
          payouts_failed_count,
          payouts_pending_approval_count,
          payouts_amount_minor,
          sms_count,
          sms_delivered_count,
          sms_failed_count,
          sms_pending_count,
          sms_spend_minor
        )
        with merchant_modes as (
          select id as merchant_id, mode
          from public.merchants
        ),
        dates as (
          select generate_series(
            current_date - interval '61 days',
            current_date,
            interval '1 day'
          )::date as stat_date
        ),
        collections as (
          select
            merchant_id,
            mode,
            created_at::date as stat_date,
            count(*)::integer as collections_count,
            count(*) filter (where status = 'successful')::integer as collections_successful_count,
            count(*) filter (where status in ('pending', 'processing'))::integer as collections_pending_count,
            coalesce(sum(amount) filter (where status = 'successful'), 0)::bigint as collections_amount_minor
          from public.collections
          where created_at::date >= current_date - interval '61 days'
          group by merchant_id, mode, created_at::date
        ),
        payouts as (
          select
            merchant_id,
            mode,
            created_at::date as stat_date,
            count(*)::integer as payouts_count,
            count(*) filter (where status = 'successful')::integer as payouts_successful_count,
            count(*) filter (where status in ('failed', 'reversed', 'cancelled'))::integer as payouts_failed_count,
            count(*) filter (where status = 'pending_approval')::integer as payouts_pending_approval_count,
            coalesce(sum(amount) filter (where status = 'successful'), 0)::bigint as payouts_amount_minor
          from public.payouts
          where created_at::date >= current_date - interval '61 days'
          group by merchant_id, mode, created_at::date
        ),
        sms as (
          select
            merchant_id,
            mode,
            created_at::date as stat_date,
            count(*)::integer as sms_count,
            count(*) filter (where status = 'delivered')::integer as sms_delivered_count,
            count(*) filter (where status in ('failed', 'undelivered', 'rejected'))::integer as sms_failed_count,
            count(*) filter (where status in ('queued', 'sent'))::integer as sms_pending_count,
            coalesce(sum(price_minor), 0)::bigint as sms_spend_minor
          from public.sms_messages
          where created_at::date >= current_date - interval '61 days'
          group by merchant_id, mode, created_at::date
        )
        select
          merchant_modes.merchant_id,
          merchant_modes.mode,
          dates.stat_date,
          coalesce(collections.collections_count, 0),
          coalesce(collections.collections_successful_count, 0),
          coalesce(collections.collections_pending_count, 0),
          coalesce(collections.collections_amount_minor, 0),
          coalesce(payouts.payouts_count, 0),
          coalesce(payouts.payouts_successful_count, 0),
          coalesce(payouts.payouts_failed_count, 0),
          coalesce(payouts.payouts_pending_approval_count, 0),
          coalesce(payouts.payouts_amount_minor, 0),
          coalesce(sms.sms_count, 0),
          coalesce(sms.sms_delivered_count, 0),
          coalesce(sms.sms_failed_count, 0),
          coalesce(sms.sms_pending_count, 0),
          coalesce(sms.sms_spend_minor, 0)
        from merchant_modes
        cross join dates
        left join collections
          on collections.merchant_id = merchant_modes.merchant_id
         and collections.mode = merchant_modes.mode
         and collections.stat_date = dates.stat_date
        left join payouts
          on payouts.merchant_id = merchant_modes.merchant_id
         and payouts.mode = merchant_modes.mode
         and payouts.stat_date = dates.stat_date
        left join sms
          on sms.merchant_id = merchant_modes.merchant_id
         and sms.mode = merchant_modes.mode
         and sms.stat_date = dates.stat_date
      `.execute(trx);
    },
    { audit: false }
  );
}

export function startMerchantDailyStatsLoop(input: {
  database: AppDatabase;
  logger?: FastifyBaseLogger;
}) {
  let running = false;

  const tick = () => {
    if (running) {
      return;
    }

    running = true;
    void refreshMerchantDailyStats(input.database)
      .catch((error) => {
        input.logger?.error({ err: error }, "Merchant daily stats refresh failed");
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, 15 * 60_000);
  tick();

  return {
    stop() {
      clearInterval(timer);
    }
  };
}
