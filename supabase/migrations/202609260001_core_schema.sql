begin;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text unique
);

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'richespay_app') then
    create role richespay_app nologin noinherit;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'richespay_system') then
    create role richespay_system nologin noinherit bypassrls;
  end if;
end
$$;

create type public.rp_mode as enum ('test', 'live');
create type public.merchant_status as enum ('pending_kyb', 'active', 'suspended', 'closed');
create type public.freeze_type as enum ('collections', 'payouts');
create type public.freeze_action as enum ('freeze', 'unfreeze');
create type public.kyb_profile_status as enum ('pending', 'approved', 'rejected');
create type public.kyb_document_type as enum (
  'certificate_of_incorporation',
  'proof_of_address',
  'director_id',
  'tax_certificate',
  'other'
);
create type public.kyb_document_status as enum ('pending', 'approved', 'rejected');
create type public.membership_role as enum ('owner', 'admin', 'finance', 'developer', 'support', 'viewer');
create type public.platform_admin_role as enum ('super_admin', 'compliance', 'operations', 'finance', 'support');
create type public.actor_type as enum ('user', 'admin', 'system', 'api_key');

create or replace function public.rp_current_merchant_id()
returns text
language sql
stable
as $$
  select nullif(current_setting('app.merchant_id', true), '')
$$;

create or replace function public.rp_current_mode()
returns public.rp_mode
language sql
stable
as $$
  select nullif(current_setting('app.mode', true), '')::public.rp_mode
$$;

create or replace function public.rp_settlement_currency_for_country(input_country_code text)
returns text
language sql
immutable
as $$
  select case upper(input_country_code)
    when 'GH' then 'GHS'
    when 'ZM' then 'ZMW'
    else 'USD'
  end
$$;

create or replace function public.rp_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

create or replace function public.rp_prepare_merchant()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.settlement_currency = public.rp_settlement_currency_for_country(new.country_code);
  else
    if new.settlement_currency is distinct from old.settlement_currency then
      raise exception 'settlement_currency is immutable after insert';
    end if;

    if new.country_code is distinct from old.country_code then
      raise exception 'country_code is immutable after insert';
    end if;

    new.updated_at = now();
  end if;

  if new.collections_frozen = false then
    new.collections_freeze_reason = null;
  end if;

  if new.payouts_frozen = false then
    new.payouts_freeze_reason = null;
  end if;

  return new;
end
$$;

create or replace function public.rp_append_only_guard()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append only', tg_table_name;
end
$$;

create table public.countries (
  code text primary key,
  name text not null,
  currency text not null,
  timezone text not null,
  dial_code text not null,
  enabled boolean not null default true,
  constraint countries_code_uppercase check (code = upper(code))
);

create table public.merchants (
  id text primary key,
  legal_name text not null,
  trading_name text,
  country_code text not null references public.countries(code),
  settlement_currency text not null,
  timezone text not null,
  status public.merchant_status not null default 'pending_kyb',
  collections_frozen boolean not null default false,
  collections_freeze_reason text,
  payouts_frozen boolean not null default false,
  payouts_freeze_reason text,
  website text,
  support_email text,
  support_phone text,
  mode public.rp_mode not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchants_id_prefix check (id like 'mer_%'),
  constraint merchants_mode_unique unique (id, mode)
);

create table public.merchant_freeze_history (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  freeze_type public.freeze_type not null,
  action public.freeze_action not null,
  reason text,
  actor_id text,
  created_at timestamptz not null default now(),
  constraint merchant_freeze_history_id_prefix check (id like 'mfh_%'),
  constraint merchant_freeze_history_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.kyb_profiles (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  business_registration_number text,
  tax_id text,
  registered_address text,
  status public.kyb_profile_status not null default 'pending',
  reviewer_id uuid,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kyb_profiles_id_prefix check (id like 'kyp_%'),
  constraint kyb_profiles_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.kyb_documents (
  id text primary key,
  kyb_profile_id text not null references public.kyb_profiles(id) on delete cascade,
  merchant_id text not null,
  mode public.rp_mode not null,
  file_path text not null,
  document_type public.kyb_document_type not null,
  status public.kyb_document_status not null default 'pending',
  reviewer_id uuid,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kyb_documents_id_prefix check (id like 'kyd_%'),
  constraint kyb_documents_private_bucket_path check (file_path like 'private/%'),
  constraint kyb_documents_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memberships (
  merchant_id text not null,
  mode public.rp_mode not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.membership_role not null,
  created_at timestamptz not null default now(),
  primary key (merchant_id, user_id),
  constraint memberships_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.invitations (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  email text not null,
  role public.membership_role not null,
  token_hash text not null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invitations_id_prefix check (id like 'inv_%'),
  constraint invitations_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role public.platform_admin_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id text primary key,
  actor_type public.actor_type not null,
  actor_id text not null,
  merchant_id text,
  mode public.rp_mode not null default 'live',
  action text not null,
  target_type text not null,
  target_id text,
  before jsonb,
  after jsonb,
  ip inet,
  user_agent text,
  reason text,
  created_at timestamptz not null default now(),
  constraint audit_logs_id_prefix check (id like 'aud_%'),
  constraint audit_logs_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete set null
);

create index countries_enabled_idx on public.countries (enabled);
create index merchants_created_at_idx on public.merchants (created_at desc);
create index merchants_mode_idx on public.merchants (mode);

create index merchant_freeze_history_merchant_id_idx on public.merchant_freeze_history (merchant_id);
create index merchant_freeze_history_created_at_idx on public.merchant_freeze_history (created_at desc);

create index kyb_profiles_merchant_id_idx on public.kyb_profiles (merchant_id);
create index kyb_profiles_created_at_idx on public.kyb_profiles (created_at desc);

create index kyb_documents_merchant_id_idx on public.kyb_documents (merchant_id);
create index kyb_documents_created_at_idx on public.kyb_documents (created_at desc);

create index memberships_merchant_id_idx on public.memberships (merchant_id);
create index memberships_created_at_idx on public.memberships (created_at desc);

create index invitations_merchant_id_idx on public.invitations (merchant_id);
create index invitations_created_at_idx on public.invitations (created_at desc);

create index audit_logs_merchant_id_idx on public.audit_logs (merchant_id);
create index audit_logs_created_at_idx on public.audit_logs (created_at desc);

create trigger merchants_prepare_before_write
before insert or update on public.merchants
for each row
execute function public.rp_prepare_merchant();

create trigger kyb_profiles_touch_updated_at
before update on public.kyb_profiles
for each row
execute function public.rp_touch_updated_at();

create trigger kyb_documents_touch_updated_at
before update on public.kyb_documents
for each row
execute function public.rp_touch_updated_at();

create trigger profiles_touch_updated_at
before update on public.profiles
for each row
execute function public.rp_touch_updated_at();

create trigger platform_admins_touch_updated_at
before update on public.platform_admins
for each row
execute function public.rp_touch_updated_at();

create trigger audit_logs_append_only_update
before update on public.audit_logs
for each row
execute function public.rp_append_only_guard();

create trigger audit_logs_append_only_delete
before delete on public.audit_logs
for each row
execute function public.rp_append_only_guard();

grant usage on schema public to richespay_app, richespay_system;
grant usage on schema auth to richespay_system;

grant select on public.countries to richespay_app, richespay_system;
grant select, insert, update, delete on public.merchants to richespay_app, richespay_system;
grant select, insert, update, delete on public.merchant_freeze_history to richespay_app, richespay_system;
grant select, insert, update, delete on public.kyb_profiles to richespay_app, richespay_system;
grant select, insert, update, delete on public.kyb_documents to richespay_app, richespay_system;
grant select, insert, update, delete on public.memberships to richespay_app, richespay_system;
grant select, insert, update, delete on public.invitations to richespay_app, richespay_system;
grant select, insert on public.audit_logs to richespay_app, richespay_system;
grant select, insert, update, delete on public.profiles to richespay_system;
grant select, insert, update, delete on public.platform_admins to richespay_system;

revoke all on all tables in schema public from public;
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

alter table public.merchants enable row level security;
alter table public.merchants force row level security;

alter table public.merchant_freeze_history enable row level security;
alter table public.merchant_freeze_history force row level security;

alter table public.kyb_profiles enable row level security;
alter table public.kyb_profiles force row level security;

alter table public.kyb_documents enable row level security;
alter table public.kyb_documents force row level security;

alter table public.memberships enable row level security;
alter table public.memberships force row level security;

alter table public.invitations enable row level security;
alter table public.invitations force row level security;

alter table public.audit_logs enable row level security;
alter table public.audit_logs force row level security;

create policy merchants_app_scope_all
  on public.merchants
  for all
  to richespay_app
  using (id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy merchant_freeze_history_app_scope_all
  on public.merchant_freeze_history
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy kyb_profiles_app_scope_all
  on public.kyb_profiles
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy kyb_documents_app_scope_all
  on public.kyb_documents
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy memberships_app_scope_all
  on public.memberships
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy invitations_app_scope_all
  on public.invitations
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy audit_logs_app_scope_select
  on public.audit_logs
  for select
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy audit_logs_app_scope_insert
  on public.audit_logs
  for insert
  to richespay_app
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

commit;
