begin;

alter type public.payout_status add value if not exists 'on_hold';
alter type public.payout_batch_status add value if not exists 'on_hold';

create type public.compliance_reason_category as enum (
  'regulatory',
  'chargeback_risk',
  'kyb_review',
  'sanctions_screening',
  'fraud_review',
  'operations',
  'other'
);

create type public.kyb_tier as enum (
  'tier_0',
  'tier_1',
  'tier_2',
  'tier_3'
);

create type public.compliance_review_status as enum (
  'open',
  'resolved',
  'dismissed'
);

create table public.merchant_compliance_profiles (
  merchant_id text not null,
  mode public.rp_mode not null,
  contact_link text not null default 'mailto:compliance@richespay.local',
  collections_daily_volume_minor bigint,
  collections_freeze_category public.compliance_reason_category,
  collections_max_minor bigint not null default 9999999999999,
  collections_min_minor bigint not null default 1,
  collections_monthly_volume_minor bigint,
  created_at timestamptz not null default now(),
  kyb_tier public.kyb_tier not null default 'tier_0',
  payouts_daily_volume_minor bigint,
  payouts_freeze_category public.compliance_reason_category,
  payouts_max_minor bigint not null default 9999999999999,
  payouts_min_minor bigint not null default 1,
  payouts_monthly_volume_minor bigint,
  rolling_reserve_bps integer not null default 0,
  rolling_reserve_days integer not null default 0,
  screening_payout_threshold_minor bigint,
  suspension_category public.compliance_reason_category,
  suspension_reason text,
  updated_at timestamptz not null default now(),
  velocity_collections_per_phone integer not null default 5,
  velocity_window_minutes integer not null default 10,
  primary key (merchant_id, mode),
  constraint merchant_compliance_profiles_contact_link_not_blank
    check (length(trim(contact_link)) > 0),
  constraint merchant_compliance_profiles_collection_limits_nonnegative
    check (
      collections_min_minor >= 0
      and collections_max_minor >= collections_min_minor
      and (collections_daily_volume_minor is null or collections_daily_volume_minor >= 0)
      and (collections_monthly_volume_minor is null or collections_monthly_volume_minor >= 0)
    ),
  constraint merchant_compliance_profiles_payout_limits_nonnegative
    check (
      payouts_min_minor >= 0
      and payouts_max_minor >= payouts_min_minor
      and (payouts_daily_volume_minor is null or payouts_daily_volume_minor >= 0)
      and (payouts_monthly_volume_minor is null or payouts_monthly_volume_minor >= 0)
    ),
  constraint merchant_compliance_profiles_screening_threshold_nonnegative
    check (
      screening_payout_threshold_minor is null
      or screening_payout_threshold_minor >= 0
    ),
  constraint merchant_compliance_profiles_rolling_reserve_valid
    check (
      rolling_reserve_bps >= 0
      and rolling_reserve_bps <= 10000
      and rolling_reserve_days >= 0
    ),
  constraint merchant_compliance_profiles_velocity_valid
    check (
      velocity_collections_per_phone >= 1
      and velocity_window_minutes >= 1
    ),
  constraint merchant_compliance_profiles_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create index merchant_compliance_profiles_merchant_id_idx
  on public.merchant_compliance_profiles (merchant_id);
create index merchant_compliance_profiles_created_at_idx
  on public.merchant_compliance_profiles (created_at desc);

insert into public.merchant_compliance_profiles (
  merchant_id,
  mode,
  contact_link
)
select merchant.id, merchant.mode, 'mailto:compliance@richespay.local'
from public.merchants merchant
on conflict (merchant_id, mode) do nothing;

create or replace function public.rp_seed_merchant_compliance_profile()
returns trigger
language plpgsql
as $$
begin
  insert into public.merchant_compliance_profiles (
    merchant_id,
    mode,
    contact_link
  )
  values (
    new.id,
    new.mode,
    'mailto:compliance@richespay.local'
  )
  on conflict (merchant_id, mode) do nothing;

  return new;
end
$$;

create trigger merchants_seed_compliance_profile
after insert on public.merchants
for each row
execute function public.rp_seed_merchant_compliance_profile();

create table public.compliance_review_flags (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  resource_type text not null,
  resource_id text not null,
  status public.compliance_review_status not null default 'open',
  rule_code text not null,
  summary text not null,
  payload jsonb not null default '{}'::jsonb,
  reviewed_at timestamptz,
  reviewed_by text,
  created_at timestamptz not null default now(),
  constraint compliance_review_flags_id_prefix check (id like 'crf_%'),
  constraint compliance_review_flags_summary_not_blank check (length(trim(summary)) > 0),
  constraint compliance_review_flags_rule_code_not_blank check (length(trim(rule_code)) > 0),
  constraint compliance_review_flags_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create index compliance_review_flags_merchant_id_idx
  on public.compliance_review_flags (merchant_id);
create index compliance_review_flags_created_at_idx
  on public.compliance_review_flags (created_at desc);
create index compliance_review_flags_status_created_at_idx
  on public.compliance_review_flags (status, created_at desc);

create table public.merchant_rolling_reserve_holds (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  collection_id text not null references public.collections(id) on delete cascade,
  currency text not null,
  amount bigint not null,
  release_at timestamptz not null,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  constraint merchant_rolling_reserve_holds_id_prefix check (id like 'rrh_%'),
  constraint merchant_rolling_reserve_holds_amount_positive check (amount > 0),
  constraint merchant_rolling_reserve_holds_currency_uppercase check (currency = upper(currency)),
  constraint merchant_rolling_reserve_holds_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create unique index merchant_rolling_reserve_holds_collection_id_idx
  on public.merchant_rolling_reserve_holds (collection_id);
create index merchant_rolling_reserve_holds_merchant_id_idx
  on public.merchant_rolling_reserve_holds (merchant_id);
create index merchant_rolling_reserve_holds_release_at_idx
  on public.merchant_rolling_reserve_holds (release_at asc)
  where released_at is null;
create index merchant_rolling_reserve_holds_created_at_idx
  on public.merchant_rolling_reserve_holds (created_at desc);

create trigger merchant_compliance_profiles_touch_updated_at
before update on public.merchant_compliance_profiles
for each row
execute function public.rp_sync_updated_at();

grant select on public.merchant_compliance_profiles to richespay_app;
grant select, insert, update, delete on public.merchant_compliance_profiles to richespay_system;
grant select on public.compliance_review_flags to richespay_app;
grant select, insert, update, delete on public.compliance_review_flags to richespay_system;
grant select on public.merchant_rolling_reserve_holds to richespay_app;
grant select, insert, update, delete on public.merchant_rolling_reserve_holds to richespay_system;

alter table public.merchant_compliance_profiles enable row level security;
alter table public.merchant_compliance_profiles force row level security;
alter table public.compliance_review_flags enable row level security;
alter table public.compliance_review_flags force row level security;
alter table public.merchant_rolling_reserve_holds enable row level security;
alter table public.merchant_rolling_reserve_holds force row level security;

create policy merchant_compliance_profiles_app_scope_select
  on public.merchant_compliance_profiles
  for select
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy merchant_compliance_profiles_system_scope_all
  on public.merchant_compliance_profiles
  for all
  to richespay_system
  using (true)
  with check (true);

create policy compliance_review_flags_app_scope_select
  on public.compliance_review_flags
  for select
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy compliance_review_flags_system_scope_all
  on public.compliance_review_flags
  for all
  to richespay_system
  using (true)
  with check (true);

create policy merchant_rolling_reserve_holds_app_scope_select
  on public.merchant_rolling_reserve_holds
  for select
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy merchant_rolling_reserve_holds_system_scope_all
  on public.merchant_rolling_reserve_holds
  for all
  to richespay_system
  using (true)
  with check (true);

commit;
