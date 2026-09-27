begin;

alter type public.channel_kind add value if not exists 'bank';

commit;

begin;

alter table public.merchants
  add column if not exists payouts_require_approval boolean not null default false,
  add column if not exists payout_approval_threshold_minor bigint,
  add constraint merchants_payout_approval_threshold_nonnegative
    check (
      payout_approval_threshold_minor is null
      or payout_approval_threshold_minor >= 0
    );

create table public.banks (
  country_code text not null references public.countries(code) on delete restrict,
  code text not null,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (country_code, code),
  unique (code)
);

create type public.payout_status as enum (
  'pending_approval',
  'queued',
  'processing',
  'successful',
  'failed',
  'reversed',
  'cancelled'
);

create type public.payout_batch_status as enum (
  'pending_approval',
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled'
);

create table public.payout_batches (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  reference text,
  currency text not null,
  total_amount bigint not null,
  total_fee_minor bigint not null default 0,
  total_hold_minor bigint not null,
  item_count integer not null,
  status public.payout_batch_status not null,
  validation_report jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_by text not null,
  approved_by text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint payout_batches_id_prefix check (id like 'bat_%'),
  constraint payout_batches_total_amount_positive check (total_amount > 0),
  constraint payout_batches_total_fee_nonnegative check (total_fee_minor >= 0),
  constraint payout_batches_total_hold_positive check (total_hold_minor > 0),
  constraint payout_batches_item_count_positive check (item_count > 0),
  constraint payout_batches_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.payouts (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  batch_id text references public.payout_batches(id) on delete set null,
  reference text,
  amount bigint not null,
  currency text not null,
  fee_minor bigint not null default 0,
  total_hold_minor bigint not null,
  method public.fee_method not null,
  phone text,
  network text,
  bank_code text,
  account_number text,
  account_name text,
  narration text,
  channel_id text references public.channels(id) on delete restrict,
  provider_ref text,
  status public.payout_status not null,
  failure_code text,
  failure_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_by text not null,
  approved_by text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  last_status_check_at timestamptz,
  next_status_check_at timestamptz,
  status_check_attempts integer not null default 0,
  send_attempts integer not null default 0,
  constraint payouts_id_prefix check (id like 'pay_%'),
  constraint payouts_amount_positive check (amount > 0),
  constraint payouts_fee_nonnegative check (fee_minor >= 0),
  constraint payouts_total_hold_positive check (total_hold_minor > 0),
  constraint payouts_status_check_attempts_nonnegative check (status_check_attempts >= 0),
  constraint payouts_send_attempts_nonnegative check (send_attempts >= 0),
  constraint payouts_method_supported check (method in ('mobile_money', 'bank')),
  constraint payouts_method_shape check (
    (
      method = 'mobile_money'
      and phone is not null
      and bank_code is null
      and account_number is null
    )
    or (
      method = 'bank'
      and phone is null
      and bank_code is not null
      and account_number is not null
    )
  ),
  constraint payouts_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade,
  constraint payouts_bank_fk
    foreign key (bank_code) references public.banks(code) on delete restrict
);

create unique index payout_batches_reference_unique_idx
  on public.payout_batches (merchant_id, mode, reference)
  where reference is not null;
create index payout_batches_merchant_id_idx on public.payout_batches (merchant_id);
create index payout_batches_created_at_idx on public.payout_batches (created_at desc);
create index payout_batches_status_created_at_idx
  on public.payout_batches (status, created_at desc);

create unique index payouts_reference_unique_idx
  on public.payouts (merchant_id, mode, reference)
  where reference is not null;
create index payouts_merchant_id_idx on public.payouts (merchant_id);
create index payouts_created_at_idx on public.payouts (created_at desc);
create index payouts_status_created_at_idx
  on public.payouts (status, created_at desc);
create index payouts_batch_id_idx on public.payouts (batch_id, created_at desc);
create index payouts_provider_ref_idx
  on public.payouts (provider_ref)
  where provider_ref is not null;
create index payouts_polling_idx
  on public.payouts (next_status_check_at asc, created_at asc)
  where status = 'processing';
create index payouts_queue_idx
  on public.payouts (channel_id, created_at asc)
  where status = 'queued';

create index banks_active_idx on public.banks (country_code, active, name);
create index banks_created_at_idx on public.banks (created_at desc);

create trigger banks_touch_updated_at
before update on public.banks
for each row
execute function public.rp_touch_updated_at();

create trigger payout_batches_touch_updated_at
before update on public.payout_batches
for each row
execute function public.rp_touch_updated_at();

grant select on public.banks to richespay_app, richespay_system;
grant select, insert, update on public.payout_batches to richespay_app, richespay_system;
grant select, insert, update on public.payouts to richespay_app, richespay_system;

alter table public.payout_batches enable row level security;
alter table public.payout_batches force row level security;

alter table public.payouts enable row level security;
alter table public.payouts force row level security;

create policy payout_batches_app_scope_all
  on public.payout_batches
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy payouts_app_scope_all
  on public.payouts
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

insert into public.banks (country_code, code, name, active)
values
  ('GH', 'GCB', 'GCB Bank', true),
  ('GH', 'ADB', 'Agricultural Development Bank', true),
  ('GH', 'ECO', 'Ecobank Ghana', true),
  ('ZM', 'ZAN', 'Zanaco', true),
  ('ZM', 'ABA', 'Absa Zambia', true),
  ('ZM', 'STB', 'Stanbic Bank Zambia', true)
on conflict (country_code, code) do update
set
  active = excluded.active,
  name = excluded.name;

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
    'chn_simulator_bank_test',
    'bank',
    'simulator',
    'GH',
    null,
    array['payout']::public.channel_capability[],
    'test',
    '{}',
    '{"payout_concurrency_limit": 2}'::jsonb,
    'active',
    'healthy',
    0
  )
on conflict (id) do nothing;

commit;
