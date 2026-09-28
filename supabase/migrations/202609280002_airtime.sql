begin;

alter type public.channel_kind add value if not exists 'airtime';
alter type public.channel_capability add value if not exists 'airtime';
alter type public.api_key_scope add value if not exists 'airtime';
alter type public.journal_reference_type add value if not exists 'airtime';
alter type public.ledger_account_type add value if not exists 'merchant_airtime_hold';

commit;

begin;

create type public.airtime_order_status as enum ('pending', 'processing', 'successful', 'failed');
create type public.airtime_batch_status as enum ('processing', 'completed');
create type public.airtime_float_status as enum ('ok', 'low', 'empty', 'unknown');

create or replace function public.rp_apply_posting_to_balance()
returns trigger
language plpgsql
as $$
declare
  updated_balance bigint;
  account_type public.ledger_account_type;
begin
  select type
    into account_type
  from public.ledger_accounts
  where id = new.account_id;

  insert into public.account_balances (account_id, balance, version, updated_at)
  values (
    new.account_id,
    public.rp_posting_delta(new.direction, new.amount),
    1,
    now()
  )
  on conflict (account_id) do update
    set balance = public.account_balances.balance + excluded.balance,
        version = public.account_balances.version + 1,
        updated_at = now()
  returning balance into updated_balance;

  if account_type in ('merchant_available', 'merchant_payout_hold', 'merchant_airtime_hold')
    and updated_balance < 0 then
    raise exception using message = 'insufficient_funds';
  end if;

  return new;
end
$$;

alter table public.merchant_products
  add column if not exists airtime_enabled boolean not null default false;

alter table public.merchant_compliance_profiles
  add column if not exists airtime_merchant_daily_cap_minor bigint,
  add column if not exists airtime_number_daily_cap_minor bigint,
  add column if not exists airtime_velocity_per_number integer not null default 5,
  add constraint merchant_compliance_airtime_caps_positive check (
    (airtime_merchant_daily_cap_minor is null or airtime_merchant_daily_cap_minor > 0)
    and (airtime_number_daily_cap_minor is null or airtime_number_daily_cap_minor > 0)
    and airtime_velocity_per_number > 0
  );

create table public.airtime_networks (
  country_code text not null references public.countries(code) on delete restrict,
  network text not null,
  currency text not null,
  min_minor bigint not null,
  max_minor bigint not null,
  fixed_denominations integer[],
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (country_code, network),
  constraint airtime_networks_network_uppercase check (network = upper(network)),
  constraint airtime_networks_currency_uppercase check (currency = upper(currency)),
  constraint airtime_networks_range check (min_minor > 0 and max_minor >= min_minor),
  constraint airtime_networks_denominations_nonempty check (
    fixed_denominations is null or cardinality(fixed_denominations) > 0
  )
);

create table public.airtime_discount_plans (
  id text primary key,
  country_code text not null references public.countries(code) on delete restrict,
  network text not null,
  merchant_id text,
  mode public.rp_mode,
  discount_bps integer not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint airtime_discount_plans_id_prefix check (id like 'adp_%'),
  constraint airtime_discount_plans_bps_range check (discount_bps between 0 and 10000),
  constraint airtime_discount_plans_network_uppercase check (network = upper(network)),
  constraint airtime_discount_plans_scope check (
    (merchant_id is null and mode is null) or (merchant_id is not null and mode is not null)
  ),
  constraint airtime_discount_plans_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade,
  constraint airtime_discount_plans_unique_scope
    unique nulls not distinct (country_code, network, merchant_id, mode)
);

create table public.airtime_batches (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  reference text,
  total_items integer not null default 0,
  accepted integer not null default 0,
  rejected integer not null default 0,
  successful integer not null default 0,
  failed integer not null default 0,
  total_charge bigint not null default 0,
  charge_currency text not null,
  rejected_rows jsonb not null default '[]'::jsonb,
  status public.airtime_batch_status not null default 'processing',
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint airtime_batches_id_prefix check (id like 'aib_%'),
  constraint airtime_batches_counts_nonnegative check (
    total_items >= 0 and accepted >= 0 and rejected >= 0 and successful >= 0 and failed >= 0
  ),
  constraint airtime_batches_total_charge_nonnegative check (total_charge >= 0),
  constraint airtime_batches_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.airtime_orders (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  batch_id text references public.airtime_batches(id) on delete set null,
  reference text,
  phone text not null,
  country_code text not null,
  network text not null,
  amount bigint not null,
  currency text not null,
  charge_amount bigint not null,
  charge_currency text not null,
  fx_rate_id text,
  discount_minor bigint not null default 0,
  channel_id text references public.channels(id) on delete set null,
  provider_ref text,
  status public.airtime_order_status not null default 'pending',
  failure_code text,
  metadata jsonb not null default '{}'::jsonb,
  send_attempts integer not null default 0,
  status_check_attempts integer not null default 0,
  next_status_check_at timestamptz,
  last_status_check_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint airtime_orders_id_prefix check (id like 'air_%'),
  constraint airtime_orders_phone_e164 check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  constraint airtime_orders_amount_positive check (amount > 0),
  constraint airtime_orders_charge_nonnegative check (charge_amount >= 0),
  constraint airtime_orders_discount_nonnegative check (discount_minor >= 0),
  constraint airtime_orders_attempts_nonnegative check (
    send_attempts >= 0 and status_check_attempts >= 0
  ),
  constraint airtime_orders_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.airtime_channel_floats (
  channel_id text primary key references public.channels(id) on delete cascade,
  balance_minor bigint,
  currency text,
  threshold_minor bigint not null,
  status public.airtime_float_status not null default 'unknown',
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index airtime_networks_created_at_idx
  on public.airtime_networks (created_at desc);

create index airtime_discount_plans_merchant_id_idx
  on public.airtime_discount_plans (merchant_id);
create index airtime_discount_plans_created_at_idx
  on public.airtime_discount_plans (created_at desc);

create index airtime_batches_merchant_id_idx
  on public.airtime_batches (merchant_id);
create index airtime_batches_created_at_idx
  on public.airtime_batches (created_at desc);

create index airtime_orders_merchant_id_idx
  on public.airtime_orders (merchant_id);
create index airtime_orders_created_at_idx
  on public.airtime_orders (created_at desc);
create index airtime_orders_status_idx
  on public.airtime_orders (merchant_id, mode, status, created_at desc);
create index airtime_orders_phone_idx
  on public.airtime_orders (merchant_id, mode, phone, created_at desc);
create index airtime_orders_batch_idx
  on public.airtime_orders (batch_id, created_at desc);
create index airtime_orders_due_queue_idx
  on public.airtime_orders (status, next_status_check_at asc, created_at asc);
create index airtime_orders_provider_ref_idx
  on public.airtime_orders (provider_ref, created_at desc);
create unique index airtime_orders_reference_unique_idx
  on public.airtime_orders (merchant_id, mode, reference)
  where reference is not null and batch_id is null;

create index airtime_channel_floats_created_at_idx
  on public.airtime_channel_floats (created_at desc);

create trigger airtime_networks_touch_updated_at
before update on public.airtime_networks
for each row
execute function public.rp_touch_updated_at();

create trigger airtime_discount_plans_touch_updated_at
before update on public.airtime_discount_plans
for each row
execute function public.rp_touch_updated_at();

create trigger airtime_batches_touch_updated_at
before update on public.airtime_batches
for each row
execute function public.rp_touch_updated_at();

create trigger airtime_orders_touch_updated_at
before update on public.airtime_orders
for each row
execute function public.rp_touch_updated_at();

grant select, insert, update, delete on public.airtime_networks to richespay_system;
grant select, insert, update, delete on public.airtime_discount_plans to richespay_system;
grant select, insert, update, delete on public.airtime_channel_floats to richespay_system;
grant select, insert, update, delete on public.airtime_batches to richespay_app, richespay_system;
grant select, insert, update, delete on public.airtime_orders to richespay_app, richespay_system;

alter table public.airtime_networks enable row level security;
alter table public.airtime_networks force row level security;

alter table public.airtime_discount_plans enable row level security;
alter table public.airtime_discount_plans force row level security;

alter table public.airtime_channel_floats enable row level security;
alter table public.airtime_channel_floats force row level security;

alter table public.airtime_batches enable row level security;
alter table public.airtime_batches force row level security;

alter table public.airtime_orders enable row level security;
alter table public.airtime_orders force row level security;

create policy airtime_batches_app_scope_all
  on public.airtime_batches
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy airtime_orders_app_scope_all
  on public.airtime_orders
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

insert into public.airtime_networks (country_code, network, currency, min_minor, max_minor)
values
  ('GH', 'MTN', 'GHS', 100, 50000),
  ('GH', 'TELECEL', 'GHS', 100, 50000),
  ('GH', 'AT', 'GHS', 100, 50000),
  ('ZM', 'MTN', 'ZMW', 100, 100000),
  ('ZM', 'AIRTEL', 'ZMW', 100, 100000),
  ('ZM', 'ZAMTEL', 'ZMW', 100, 100000)
on conflict (country_code, network) do nothing;

insert into public.airtime_discount_plans (id, country_code, network, discount_bps)
values
  ('adp_default_gh_mtn', 'GH', 'MTN', 300),
  ('adp_default_gh_telecel', 'GH', 'TELECEL', 300),
  ('adp_default_gh_at', 'GH', 'AT', 300),
  ('adp_default_zm_mtn', 'ZM', 'MTN', 300),
  ('adp_default_zm_airtel', 'ZM', 'AIRTEL', 300),
  ('adp_default_zm_zamtel', 'ZM', 'ZAMTEL', 300)
on conflict (id) do nothing;

insert into public.channels (
  id,
  kind,
  provider_code,
  country_code,
  network,
  capabilities,
  mode,
  credentials_encrypted,
  config,
  status,
  health,
  priority
)
values
  (
    'chn_simulator_airtime_test',
    'airtime',
    'simulator',
    'GH',
    null,
    array['airtime']::public.channel_capability[],
    'test',
    '{}',
    '{}'::jsonb,
    'active',
    'healthy',
    0
  )
on conflict (id) do nothing;

commit;
