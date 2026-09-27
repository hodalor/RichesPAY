begin;

create table public.webhook_endpoints (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  url text not null,
  description text not null,
  events text[] not null,
  secret text not null,
  enabled boolean not null default true,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint webhook_endpoints_id_prefix check (id like 'whe_%'),
  constraint webhook_endpoints_url_https check (url ~ '^https://'),
  constraint webhook_endpoints_events_nonempty check (cardinality(events) > 0),
  constraint webhook_endpoints_consecutive_failures_nonnegative
    check (consecutive_failures >= 0),
  constraint webhook_endpoints_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create index webhook_endpoints_merchant_id_idx on public.webhook_endpoints (merchant_id);
create index webhook_endpoints_created_at_idx on public.webhook_endpoints (created_at desc);
create index webhook_endpoints_enabled_idx
  on public.webhook_endpoints (enabled, created_at desc);

create trigger webhook_endpoints_sync_updated_at
before update on public.webhook_endpoints
for each row
execute function public.rp_sync_updated_at();

create table public.webhook_deliveries (
  merchant_id text not null,
  mode public.rp_mode not null,
  event_id text not null references public.events_outbox(id) on delete cascade,
  endpoint_id text not null references public.webhook_endpoints(id) on delete cascade,
  attempt integer not null,
  status_code integer,
  response_snippet text,
  duration_ms integer,
  next_retry_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (endpoint_id, event_id, attempt),
  constraint webhook_deliveries_attempt_positive check (attempt > 0),
  constraint webhook_deliveries_duration_nonnegative
    check (duration_ms is null or duration_ms >= 0),
  constraint webhook_deliveries_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create index webhook_deliveries_merchant_id_idx on public.webhook_deliveries (merchant_id);
create index webhook_deliveries_created_at_idx on public.webhook_deliveries (created_at desc);
create index webhook_deliveries_event_endpoint_idx
  on public.webhook_deliveries (event_id, endpoint_id, attempt desc);
create index webhook_deliveries_due_idx
  on public.webhook_deliveries (next_retry_at asc, created_at asc)
  where delivered_at is null and next_retry_at is not null;

grant select, insert, update, delete on public.webhook_endpoints to richespay_app, richespay_system;
grant select on public.webhook_deliveries to richespay_app;
grant select, insert, update on public.webhook_deliveries to richespay_system;

alter table public.webhook_endpoints enable row level security;
alter table public.webhook_endpoints force row level security;

alter table public.webhook_deliveries enable row level security;
alter table public.webhook_deliveries force row level security;

create policy webhook_endpoints_app_scope_all
  on public.webhook_endpoints
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy webhook_deliveries_app_scope_select
  on public.webhook_deliveries
  for select
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy webhook_endpoints_system_scope_all
  on public.webhook_endpoints
  for all
  to richespay_system
  using (true)
  with check (true);

create policy webhook_deliveries_system_scope_all
  on public.webhook_deliveries
  for all
  to richespay_system
  using (true)
  with check (true);

commit;
