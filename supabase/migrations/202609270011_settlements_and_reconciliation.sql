begin;

create type public.settlement_account_type as enum ('bank', 'mobile_money');
create type public.provider_statement_source as enum ('api', 'csv_upload');
create type public.provider_statement_entry_type as enum ('collection', 'payout', 'fee', 'adjustment');
create type public.recon_exception_type as enum (
  'missing_in_richespay',
  'missing_at_provider',
  'amount_mismatch',
  'status_mismatch'
);
create type public.recon_exception_status as enum ('open', 'resolved', 'dismissed');
create type public.recon_resolution_action as enum ('force_status', 'manual_adjustment', 'dismiss');

create table public.settlement_accounts (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  type public.settlement_account_type not null,
  details jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  verified_by text,
  verified_at timestamptz,
  cool_off_until timestamptz,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint settlement_accounts_id_prefix check (id like 'sea_%'),
  constraint settlement_accounts_details_object check (jsonb_typeof(details) = 'object'),
  constraint settlement_accounts_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create unique index settlement_accounts_default_idx
  on public.settlement_accounts (merchant_id, mode)
  where is_default = true;
create index settlement_accounts_merchant_id_idx on public.settlement_accounts (merchant_id);
create index settlement_accounts_created_at_idx on public.settlement_accounts (created_at desc);

create trigger settlement_accounts_sync_updated_at
before update on public.settlement_accounts
for each row
execute function public.rp_sync_updated_at();

create table public.merchant_settlement_settings (
  merchant_id text not null,
  mode public.rp_mode not null,
  settlement_account_id text,
  automatic_daily_settlement_enabled boolean not null default false,
  last_auto_settlement_for_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (merchant_id, mode),
  constraint merchant_settlement_settings_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade,
  constraint merchant_settlement_settings_account_fk
    foreign key (settlement_account_id) references public.settlement_accounts(id) on delete set null
);

create index merchant_settlement_settings_merchant_id_idx
  on public.merchant_settlement_settings (merchant_id);
create index merchant_settlement_settings_created_at_idx
  on public.merchant_settlement_settings (created_at desc);

create trigger merchant_settlement_settings_sync_updated_at
before update on public.merchant_settlement_settings
for each row
execute function public.rp_sync_updated_at();

create table public.withdrawals (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  settlement_account_id text not null references public.settlement_accounts(id),
  payout_id text not null unique references public.payouts(id) on delete cascade,
  amount bigint not null,
  currency text not null,
  auto_generated boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint withdrawals_id_prefix check (id like 'wdr_%'),
  constraint withdrawals_amount_positive check (amount > 0),
  constraint withdrawals_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create index withdrawals_merchant_id_idx on public.withdrawals (merchant_id);
create index withdrawals_created_at_idx on public.withdrawals (created_at desc);

create table public.provider_statements (
  id text primary key,
  channel_id text not null references public.channels(id) on delete cascade,
  statement_date date not null,
  source public.provider_statement_source not null,
  raw_file_path text not null,
  currency text not null,
  float_balance_minor bigint,
  created_at timestamptz not null default now(),
  constraint provider_statements_id_prefix check (id like 'pst_%')
);

create unique index provider_statements_channel_date_idx
  on public.provider_statements (channel_id, statement_date);
create index provider_statements_created_at_idx on public.provider_statements (created_at desc);

create table public.provider_statement_lines (
  id text primary key,
  statement_id text not null references public.provider_statements(id) on delete cascade,
  channel_id text not null references public.channels(id) on delete cascade,
  statement_date date not null,
  entry_type public.provider_statement_entry_type not null,
  provider_ref text,
  amount bigint not null,
  currency text not null,
  provider_status text,
  fee_minor bigint not null default 0,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint provider_statement_lines_id_prefix check (id like 'psl_%'),
  constraint provider_statement_lines_amount_nonzero check (amount <> 0),
  constraint provider_statement_lines_raw_object check (jsonb_typeof(raw) = 'object')
);

create index provider_statement_lines_statement_id_idx
  on public.provider_statement_lines (statement_id);
create index provider_statement_lines_channel_ref_idx
  on public.provider_statement_lines (channel_id, provider_ref);
create index provider_statement_lines_created_at_idx
  on public.provider_statement_lines (created_at desc);

create table public.recon_exceptions (
  id text primary key,
  channel_id text not null references public.channels(id) on delete cascade,
  statement_id text references public.provider_statements(id) on delete set null,
  statement_line_id text references public.provider_statement_lines(id) on delete set null,
  merchant_id text,
  mode public.rp_mode,
  resource_type text,
  resource_id text,
  exception_type public.recon_exception_type not null,
  status public.recon_exception_status not null default 'open',
  provider_ref text,
  expected_amount bigint,
  provider_amount bigint,
  currency text,
  expected_status text,
  provider_status text,
  resolution_action public.recon_resolution_action,
  resolution_reason text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint recon_exceptions_id_prefix check (id like 'rex_%')
);

create index recon_exceptions_channel_id_idx on public.recon_exceptions (channel_id);
create index recon_exceptions_created_at_idx on public.recon_exceptions (created_at desc);
create index recon_exceptions_status_idx on public.recon_exceptions (status, created_at desc);

create table public.recon_daily_summaries (
  id text primary key,
  channel_id text not null references public.channels(id) on delete cascade,
  statement_id text not null unique references public.provider_statements(id) on delete cascade,
  statement_date date not null,
  currency text not null,
  collection_count integer not null default 0,
  collection_volume bigint not null default 0,
  payout_count integer not null default 0,
  payout_volume bigint not null default 0,
  fee_volume bigint not null default 0,
  exception_count integer not null default 0,
  provider_clearing_balance bigint not null default 0,
  provider_float_balance bigint,
  balances_match boolean not null default false,
  created_at timestamptz not null default now(),
  constraint recon_daily_summaries_id_prefix check (id like 'rds_%')
);

create unique index recon_daily_summaries_channel_date_idx
  on public.recon_daily_summaries (channel_id, statement_date);
create index recon_daily_summaries_created_at_idx
  on public.recon_daily_summaries (created_at desc);

create or replace function public.rp_seed_merchant_settlement_settings()
returns trigger
language plpgsql
as $$
begin
  insert into public.merchant_settlement_settings (
    merchant_id,
    mode
  )
  values (
    new.id,
    new.mode
  )
  on conflict (merchant_id, mode) do nothing;

  return new;
end
$$;

create trigger merchants_seed_settlement_settings
after insert on public.merchants
for each row
execute function public.rp_seed_merchant_settlement_settings();

grant select, insert, update, delete on public.settlement_accounts
  to richespay_app, richespay_system;
grant select, insert, update, delete on public.merchant_settlement_settings
  to richespay_app, richespay_system;
grant select, insert on public.withdrawals to richespay_app;
grant select, insert, update, delete on public.withdrawals to richespay_system;
grant select, insert, update, delete on public.provider_statements
  to richespay_system;
grant select, insert, update, delete on public.provider_statement_lines
  to richespay_system;
grant select, insert, update, delete on public.recon_exceptions
  to richespay_system;
grant select, insert, update, delete on public.recon_daily_summaries
  to richespay_system;

alter table public.settlement_accounts enable row level security;
alter table public.settlement_accounts force row level security;
alter table public.merchant_settlement_settings enable row level security;
alter table public.merchant_settlement_settings force row level security;
alter table public.withdrawals enable row level security;
alter table public.withdrawals force row level security;
alter table public.provider_statements enable row level security;
alter table public.provider_statements force row level security;
alter table public.provider_statement_lines enable row level security;
alter table public.provider_statement_lines force row level security;
alter table public.recon_exceptions enable row level security;
alter table public.recon_exceptions force row level security;
alter table public.recon_daily_summaries enable row level security;
alter table public.recon_daily_summaries force row level security;

create policy settlement_accounts_app_scope_all
  on public.settlement_accounts
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy merchant_settlement_settings_app_scope_all
  on public.merchant_settlement_settings
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy withdrawals_app_scope_select_insert
  on public.withdrawals
  for select
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy withdrawals_app_scope_insert
  on public.withdrawals
  for insert
  to richespay_app
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy settlement_accounts_system_scope_all
  on public.settlement_accounts
  for all
  to richespay_system
  using (true)
  with check (true);

create policy merchant_settlement_settings_system_scope_all
  on public.merchant_settlement_settings
  for all
  to richespay_system
  using (true)
  with check (true);

create policy withdrawals_system_scope_all
  on public.withdrawals
  for all
  to richespay_system
  using (true)
  with check (true);

create policy provider_statements_system_scope_all
  on public.provider_statements
  for all
  to richespay_system
  using (true)
  with check (true);

create policy provider_statement_lines_system_scope_all
  on public.provider_statement_lines
  for all
  to richespay_system
  using (true)
  with check (true);

create policy recon_exceptions_system_scope_all
  on public.recon_exceptions
  for all
  to richespay_system
  using (true)
  with check (true);

create policy recon_daily_summaries_system_scope_all
  on public.recon_daily_summaries
  for all
  to richespay_system
  using (true)
  with check (true);

commit;
