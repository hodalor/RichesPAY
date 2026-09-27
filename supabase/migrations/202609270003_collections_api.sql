begin;

create type public.collection_status as enum (
  'pending',
  'processing',
  'successful',
  'failed',
  'expired',
  'reversed'
);

create table public.collections (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  reference text,
  amount bigint not null,
  currency text not null,
  fee_minor bigint not null default 0,
  fee_bearer public.fee_bearer not null,
  net_minor bigint not null,
  method public.fee_method not null,
  phone text not null,
  network text,
  channel_id text references public.channels(id) on delete restrict,
  provider_ref text,
  status public.collection_status not null,
  failure_code text,
  failure_message text,
  customer_name text,
  customer_email text,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  presentment_amount bigint,
  presentment_currency text,
  fx_rate_id text references public.fx_rates(id) on delete restrict,
  expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  last_status_check_at timestamptz,
  next_status_check_at timestamptz,
  status_check_attempts integer not null default 0,
  constraint collections_id_prefix check (id like 'col_%'),
  constraint collections_amount_positive check (amount > 0),
  constraint collections_fee_minor_nonnegative check (fee_minor >= 0),
  constraint collections_net_minor_nonnegative check (net_minor >= 0),
  constraint collections_status_check_attempts_nonnegative check (status_check_attempts >= 0),
  constraint collections_presentment_amount_positive check (
    presentment_amount is null or presentment_amount > 0
  ),
  constraint collections_presentment_pair check (
    (presentment_amount is null and presentment_currency is null)
    or (presentment_amount is not null and presentment_currency is not null)
  ),
  constraint collections_fee_not_above_presentment check (
    presentment_amount is null or fee_minor <= presentment_amount
  ),
  constraint collections_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.events_outbox (
  id text primary key,
  type text not null,
  merchant_id text not null,
  mode public.rp_mode not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  constraint events_outbox_id_prefix check (id like 'evt_%'),
  constraint events_outbox_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create unique index collections_reference_unique_idx
  on public.collections (merchant_id, mode, reference)
  where reference is not null;
create index collections_merchant_id_idx on public.collections (merchant_id);
create index collections_created_at_idx on public.collections (created_at desc);
create index collections_status_created_at_idx
  on public.collections (status, created_at desc);
create index collections_provider_ref_idx
  on public.collections (provider_ref)
  where provider_ref is not null;
create index collections_polling_idx
  on public.collections (next_status_check_at asc, created_at asc)
  where status in ('pending', 'processing');
create index events_outbox_merchant_id_idx on public.events_outbox (merchant_id);
create index events_outbox_created_at_idx on public.events_outbox (created_at desc);
create index events_outbox_type_created_at_idx
  on public.events_outbox (type, created_at desc);

create trigger events_outbox_append_only_update
before update on public.events_outbox
for each row
execute function public.rp_append_only_guard();

create trigger events_outbox_append_only_delete
before delete on public.events_outbox
for each row
execute function public.rp_append_only_guard();

grant select, insert, update on public.collections to richespay_app, richespay_system;
grant select, insert on public.events_outbox to richespay_app, richespay_system;

alter table public.collections enable row level security;
alter table public.collections force row level security;

alter table public.events_outbox enable row level security;
alter table public.events_outbox force row level security;

create policy collections_app_scope_all
  on public.collections
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy events_outbox_app_scope_all
  on public.events_outbox
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

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
    'chn_simulator_mobile_money_test',
    'mobile_money',
    'simulator',
    'GH',
    null,
    array['collect', 'payout']::public.channel_capability[],
    'test',
    '{}',
    '{"approval_window_seconds": 600}'::jsonb,
    'active',
    'healthy',
    0
  )
on conflict (id) do nothing;

commit;
