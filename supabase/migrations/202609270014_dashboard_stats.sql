begin;

create table public.merchant_daily_stats (
  merchant_id text not null,
  mode public.rp_mode not null,
  stat_date date not null,
  collections_count integer not null default 0,
  collections_successful_count integer not null default 0,
  collections_pending_count integer not null default 0,
  collections_amount_minor bigint not null default 0,
  payouts_count integer not null default 0,
  payouts_successful_count integer not null default 0,
  payouts_failed_count integer not null default 0,
  payouts_pending_approval_count integer not null default 0,
  payouts_amount_minor bigint not null default 0,
  sms_count integer not null default 0,
  sms_delivered_count integer not null default 0,
  sms_failed_count integer not null default 0,
  sms_pending_count integer not null default 0,
  sms_spend_minor bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (merchant_id, mode, stat_date),
  constraint merchant_daily_stats_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create index merchant_daily_stats_merchant_id_idx
  on public.merchant_daily_stats (merchant_id, mode, stat_date desc);

create index merchant_daily_stats_created_at_idx
  on public.merchant_daily_stats (created_at desc);

create trigger merchant_daily_stats_touch_updated_at
before update on public.merchant_daily_stats
for each row
execute function public.rp_touch_updated_at();

grant select, insert, update, delete on public.merchant_daily_stats to richespay_app, richespay_system;

alter table public.merchant_daily_stats enable row level security;
alter table public.merchant_daily_stats force row level security;

create policy merchant_daily_stats_app_scope_all
  on public.merchant_daily_stats
  for all
  to richespay_app
  using (
    merchant_id = current_setting('app.merchant_id', true)
    and mode = current_setting('app.mode', true)::public.rp_mode
  )
  with check (
    merchant_id = current_setting('app.merchant_id', true)
    and mode = current_setting('app.mode', true)::public.rp_mode
  );

commit;
