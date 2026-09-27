begin;

create type public.refund_status as enum (
  'pending',
  'processing',
  'successful',
  'failed'
);

alter table public.collections
  alter column phone drop not null;

alter table public.collections
  add column provider_session jsonb not null default '{}'::jsonb,
  add column card_brand text,
  add column card_last4 text,
  add column card_exp_month integer,
  add column card_exp_year integer,
  add column refunded_minor bigint not null default 0,
  add constraint collections_card_last4_length check (
    card_last4 is null or char_length(card_last4) = 4
  ),
  add constraint collections_card_exp_month_range check (
    card_exp_month is null or card_exp_month between 1 and 12
  ),
  add constraint collections_card_exp_year_positive check (
    card_exp_year is null or card_exp_year >= 2000
  ),
  add constraint collections_card_exp_pair check (
    (card_exp_month is null and card_exp_year is null)
    or (card_exp_month is not null and card_exp_year is not null)
  ),
  add constraint collections_refunded_minor_nonnegative check (refunded_minor >= 0),
  add constraint collections_refunded_minor_not_above_amount check (refunded_minor <= amount);

create table public.refunds (
  id text primary key,
  collection_id text not null references public.collections(id) on delete restrict,
  merchant_id text not null,
  mode public.rp_mode not null,
  amount bigint not null,
  currency text not null,
  method public.fee_method not null,
  channel_id text references public.channels(id) on delete restrict,
  provider_ref text,
  phone text,
  status public.refund_status not null,
  failure_code text,
  failure_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint refunds_id_prefix check (id like 'rfd_%'),
  constraint refunds_amount_positive check (amount > 0),
  constraint refunds_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create index refunds_merchant_id_idx on public.refunds (merchant_id);
create index refunds_created_at_idx on public.refunds (created_at desc);
create index refunds_collection_id_idx on public.refunds (collection_id, created_at desc);
create index refunds_provider_ref_idx
  on public.refunds (provider_ref)
  where provider_ref is not null;

grant select, insert, update on public.refunds to richespay_app, richespay_system;

alter table public.refunds enable row level security;
alter table public.refunds force row level security;

create policy refunds_app_scope_all
  on public.refunds
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
    'chn_simulator_card_test',
    'card',
    'simulator',
    'GH',
    null,
    array['collect']::public.channel_capability[],
    'test',
    '{}',
    '{"checkout_origin": "http://127.0.0.1:5175"}'::jsonb,
    'active',
    'healthy',
    0
  )
on conflict (id) do nothing;

commit;
