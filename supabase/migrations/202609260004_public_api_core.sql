begin;

create type public.api_key_kind as enum ('secret', 'public');
create type public.api_key_scope as enum ('collections', 'payouts', 'sms', 'read');
create type public.idempotency_status as enum ('in_progress', 'completed');

alter table public.merchants
  add column api_rate_limit_rps integer not null default 50,
  add constraint merchants_api_rate_limit_rps_positive check (api_rate_limit_rps > 0);

create table public.api_keys (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  kind public.api_key_kind not null,
  name text not null,
  prefix text not null,
  key_hash text not null,
  last4 text not null,
  scopes public.api_key_scope[] not null,
  ip_allowlist text[],
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint api_keys_id_prefix check (id like 'key_%'),
  constraint api_keys_prefix_length check (char_length(prefix) = 12),
  constraint api_keys_last4_length check (char_length(last4) = 4),
  constraint api_keys_hash_length check (char_length(key_hash) = 64),
  constraint api_keys_scopes_nonempty check (cardinality(scopes) > 0),
  constraint api_keys_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.idempotency_keys (
  merchant_id text not null,
  mode public.rp_mode not null,
  key text not null,
  request_hash text not null,
  status public.idempotency_status not null,
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  primary key (merchant_id, mode, key),
  constraint idempotency_keys_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.transaction_events (
  id text primary key,
  resource_type text not null,
  resource_id text not null,
  merchant_id text not null,
  mode public.rp_mode not null,
  from_status text,
  to_status text not null,
  reason text,
  provider_reference text,
  provider_payload jsonb,
  created_at timestamptz not null default now(),
  constraint transaction_events_id_prefix check (id like 'evt_%'),
  constraint transaction_events_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.api_request_logs (
  request_id text primary key,
  api_key_id text references public.api_keys(id) on delete set null,
  merchant_id text not null,
  mode public.rp_mode not null,
  method text not null,
  path text not null,
  status_code integer not null,
  duration_ms integer not null,
  request_body jsonb,
  response_body jsonb,
  ip inet,
  created_at timestamptz not null default now(),
  constraint api_request_logs_duration_nonnegative check (duration_ms >= 0),
  constraint api_request_logs_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create index api_keys_merchant_id_idx on public.api_keys (merchant_id);
create index api_keys_created_at_idx on public.api_keys (created_at desc);
create index api_keys_prefix_lookup_idx on public.api_keys (prefix, mode, kind);

create index idempotency_keys_merchant_id_idx on public.idempotency_keys (merchant_id);
create index idempotency_keys_created_at_idx on public.idempotency_keys (created_at desc);

create index transaction_events_merchant_id_idx on public.transaction_events (merchant_id);
create index transaction_events_created_at_idx on public.transaction_events (created_at desc);
create index transaction_events_resource_idx on public.transaction_events (resource_type, resource_id, created_at desc);

create index api_request_logs_merchant_id_idx on public.api_request_logs (merchant_id);
create index api_request_logs_created_at_idx on public.api_request_logs (created_at desc);
create index api_request_logs_api_key_id_idx on public.api_request_logs (api_key_id, created_at desc);

create or replace function public.rp_purge_stale_idempotency_keys()
returns trigger
language plpgsql
as $$
begin
  delete from public.idempotency_keys
  where merchant_id = new.merchant_id
    and mode = new.mode
    and created_at < now() - interval '24 hours';

  return new;
end
$$;

create or replace function public.rp_purge_old_api_request_logs()
returns trigger
language plpgsql
as $$
begin
  delete from public.api_request_logs
  where merchant_id = new.merchant_id
    and mode = new.mode
    and created_at < now() - interval '30 days';

  return new;
end
$$;

create trigger idempotency_keys_purge_before_insert
before insert on public.idempotency_keys
for each row
execute function public.rp_purge_stale_idempotency_keys();

create trigger api_request_logs_purge_before_insert
before insert on public.api_request_logs
for each row
execute function public.rp_purge_old_api_request_logs();

create trigger transaction_events_append_only_update
before update on public.transaction_events
for each row
execute function public.rp_append_only_guard();

create trigger transaction_events_append_only_delete
before delete on public.transaction_events
for each row
execute function public.rp_append_only_guard();

grant select, insert, update, delete on public.api_keys to richespay_app, richespay_system;
grant select, insert, update, delete on public.idempotency_keys to richespay_app, richespay_system;
grant select, insert on public.transaction_events to richespay_app, richespay_system;
grant select, insert, delete on public.api_request_logs to richespay_app, richespay_system;

alter table public.api_keys enable row level security;
alter table public.api_keys force row level security;

alter table public.idempotency_keys enable row level security;
alter table public.idempotency_keys force row level security;

alter table public.transaction_events enable row level security;
alter table public.transaction_events force row level security;

alter table public.api_request_logs enable row level security;
alter table public.api_request_logs force row level security;

create policy api_keys_app_scope_all
  on public.api_keys
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy idempotency_keys_app_scope_all
  on public.idempotency_keys
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy transaction_events_app_scope_all
  on public.transaction_events
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy api_request_logs_app_scope_all
  on public.api_request_logs
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

commit;
