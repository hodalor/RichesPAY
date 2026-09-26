begin;

create type public.fee_plan_kind as enum ('collection', 'payout', 'sms');
create type public.fee_method as enum ('mobile_money', 'card', 'bank');
create type public.fee_bearer as enum ('merchant', 'customer');
create type public.fx_rate_source as enum ('manual', 'feed');

create table public.fee_plans (
  id text primary key,
  name text not null,
  country_code text not null references public.countries(code) on delete restrict,
  kind public.fee_plan_kind not null,
  method public.fee_method not null,
  network text,
  percent_bps integer not null default 0,
  fixed_minor bigint not null default 0,
  min_minor bigint not null default 0,
  max_minor bigint,
  currency text not null,
  fee_bearer public.fee_bearer not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fee_plans_id_prefix check (id like 'fpl_%'),
  constraint fee_plans_percent_bps_nonnegative check (percent_bps >= 0),
  constraint fee_plans_fixed_minor_nonnegative check (fixed_minor >= 0),
  constraint fee_plans_min_minor_nonnegative check (min_minor >= 0),
  constraint fee_plans_max_minor_nonnegative check (max_minor is null or max_minor >= 0),
  constraint fee_plans_max_not_below_min check (max_minor is null or max_minor >= min_minor)
);

create table public.merchant_fee_overrides (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  name text not null,
  kind public.fee_plan_kind not null,
  method public.fee_method not null,
  network text,
  percent_bps integer not null default 0,
  fixed_minor bigint not null default 0,
  min_minor bigint not null default 0,
  max_minor bigint,
  currency text not null,
  fee_bearer public.fee_bearer not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_fee_overrides_id_prefix check (id like 'mfo_%'),
  constraint merchant_fee_overrides_percent_bps_nonnegative check (percent_bps >= 0),
  constraint merchant_fee_overrides_fixed_minor_nonnegative check (fixed_minor >= 0),
  constraint merchant_fee_overrides_min_minor_nonnegative check (min_minor >= 0),
  constraint merchant_fee_overrides_max_minor_nonnegative check (max_minor is null or max_minor >= 0),
  constraint merchant_fee_overrides_max_not_below_min check (max_minor is null or max_minor >= min_minor),
  constraint merchant_fee_overrides_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.sms_prices (
  country_code text not null references public.countries(code) on delete restrict,
  network text,
  price_per_segment_minor bigint not null,
  currency text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sms_prices_nonnegative check (price_per_segment_minor >= 0)
);

create table public.fx_rates (
  id text primary key,
  base text not null,
  quote text not null,
  rate numeric(20,10) not null,
  markup_bps integer not null default 0,
  source public.fx_rate_source not null,
  captured_at timestamptz not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fx_rates_id_prefix check (id like 'fxr_%'),
  constraint fx_rates_base_quote_distinct check (base <> quote),
  constraint fx_rates_markup_nonnegative check (markup_bps >= 0),
  constraint fx_rates_rate_positive check (rate > 0)
);

create index fee_plans_lookup_idx
  on public.fee_plans (country_code, kind, method, currency, active, created_at desc);
create index fee_plans_network_idx
  on public.fee_plans (country_code, network, created_at desc);
create index merchant_fee_overrides_lookup_idx
  on public.merchant_fee_overrides (merchant_id, mode, kind, method, currency, active, created_at desc);
create index merchant_fee_overrides_network_idx
  on public.merchant_fee_overrides (merchant_id, network, created_at desc);
create index merchant_fee_overrides_created_at_idx
  on public.merchant_fee_overrides (created_at desc);
create unique index sms_prices_lookup_idx
  on public.sms_prices (country_code, coalesce(network, ''));
create index sms_prices_created_at_idx
  on public.sms_prices (created_at desc);
create unique index fx_rates_active_lookup_idx
  on public.fx_rates (base, quote)
  where active = true;
create index fx_rates_captured_at_idx
  on public.fx_rates (captured_at desc);

create trigger fee_plans_touch_updated_at
before update on public.fee_plans
for each row
execute function public.rp_touch_updated_at();

create trigger merchant_fee_overrides_touch_updated_at
before update on public.merchant_fee_overrides
for each row
execute function public.rp_touch_updated_at();

create trigger sms_prices_touch_updated_at
before update on public.sms_prices
for each row
execute function public.rp_touch_updated_at();

create trigger fx_rates_touch_updated_at
before update on public.fx_rates
for each row
execute function public.rp_touch_updated_at();

grant select on public.fee_plans to richespay_app;
grant select on public.sms_prices to richespay_app;
grant select on public.fx_rates to richespay_app;
grant select, insert, update, delete on public.merchant_fee_overrides to richespay_app;

grant select, insert, update, delete on public.fee_plans to richespay_system;
grant select, insert, update, delete on public.sms_prices to richespay_system;
grant select, insert, update, delete on public.fx_rates to richespay_system;
grant select, insert, update, delete on public.merchant_fee_overrides to richespay_system;

alter table public.merchant_fee_overrides enable row level security;
alter table public.merchant_fee_overrides force row level security;

create policy merchant_fee_overrides_policy
  on public.merchant_fee_overrides
  for all
  using (
    merchant_id = public.rp_current_merchant_id()
    and mode = public.rp_current_mode()
  )
  with check (
    merchant_id = public.rp_current_merchant_id()
    and mode = public.rp_current_mode()
  );

insert into public.fee_plans (
  id,
  name,
  country_code,
  kind,
  method,
  network,
  percent_bps,
  fixed_minor,
  min_minor,
  max_minor,
  currency,
  fee_bearer
)
values
  ('fpl_gh_collection_mobile_money_default', 'GH Collections Mobile Money Default', 'GH', 'collection', 'mobile_money', null, 150, 100, 100, 5000, 'GHS', 'merchant'),
  ('fpl_gh_collection_card_default', 'GH Collections Card Default', 'GH', 'collection', 'card', null, 275, 0, 0, 7500, 'GHS', 'merchant'),
  ('fpl_gh_payout_mobile_money_default', 'GH Payouts Mobile Money Default', 'GH', 'payout', 'mobile_money', null, 100, 100, 100, 5000, 'GHS', 'merchant'),
  ('fpl_gh_payout_bank_default', 'GH Payouts Bank Default', 'GH', 'payout', 'bank', null, 50, 200, 200, 10000, 'GHS', 'merchant'),
  ('fpl_gh_sms_default', 'GH SMS Default', 'GH', 'sms', 'mobile_money', null, 0, 0, 0, null, 'GHS', 'merchant'),
  ('fpl_zm_collection_mobile_money_default', 'ZM Collections Mobile Money Default', 'ZM', 'collection', 'mobile_money', null, 150, 100, 100, 5000, 'ZMW', 'merchant'),
  ('fpl_zm_collection_card_default', 'ZM Collections Card Default', 'ZM', 'collection', 'card', null, 275, 0, 0, 7500, 'ZMW', 'merchant'),
  ('fpl_zm_payout_mobile_money_default', 'ZM Payouts Mobile Money Default', 'ZM', 'payout', 'mobile_money', null, 100, 100, 100, 5000, 'ZMW', 'merchant'),
  ('fpl_zm_payout_bank_default', 'ZM Payouts Bank Default', 'ZM', 'payout', 'bank', null, 50, 200, 200, 10000, 'ZMW', 'merchant'),
  ('fpl_zm_sms_default', 'ZM SMS Default', 'ZM', 'sms', 'mobile_money', null, 0, 0, 0, null, 'ZMW', 'merchant');

insert into public.sms_prices (
  country_code,
  network,
  price_per_segment_minor,
  currency
)
values
  ('GH', null, 8, 'GHS'),
  ('ZM', null, 8, 'ZMW');

commit;
