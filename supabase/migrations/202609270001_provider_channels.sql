begin;

create type public.channel_kind as enum ('mobile_money', 'card', 'sms');
create type public.channel_capability as enum ('collect', 'payout', 'sms');
create type public.channel_status as enum ('active', 'disabled', 'maintenance');
create type public.channel_health as enum ('healthy', 'degraded', 'down');

create table public.channels (
  id text primary key,
  kind public.channel_kind not null,
  provider_code text not null,
  country_code text not null references public.countries(code) on delete restrict,
  network text,
  capabilities public.channel_capability[] not null,
  mode public.rp_mode not null,
  credentials_encrypted text not null,
  config jsonb not null default '{}'::jsonb,
  status public.channel_status not null default 'active',
  health public.channel_health not null default 'healthy',
  priority integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channels_id_prefix check (id like 'chn_%'),
  constraint channels_capabilities_nonempty check (cardinality(capabilities) > 0),
  constraint channels_priority_nonnegative check (priority >= 0)
);

create table public.routing_rules (
  id text primary key,
  country_code text not null references public.countries(code) on delete restrict,
  kind public.channel_kind not null,
  network text,
  capability public.channel_capability not null,
  channel_ids text[] not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint routing_rules_id_prefix check (id like 'rtr_%'),
  constraint routing_rules_channel_ids_nonempty check (cardinality(channel_ids) > 0)
);

create table public.msisdn_prefixes (
  country_code text not null references public.countries(code) on delete restrict,
  prefix text not null,
  network text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (country_code, prefix)
);

create table public.channel_health_events (
  id text primary key,
  channel_id text not null references public.channels(id) on delete cascade,
  from_health public.channel_health,
  to_health public.channel_health not null,
  reason text not null,
  detail jsonb,
  created_at timestamptz not null default now(),
  constraint channel_health_events_id_prefix check (id like 'evt_%')
);

create table public.provider_api_logs (
  id text primary key,
  channel_id text not null references public.channels(id) on delete cascade,
  method text not null,
  path text not null,
  status_code integer,
  duration_ms integer not null,
  request_body jsonb,
  response_body jsonb,
  status text not null,
  created_at timestamptz not null default now(),
  constraint provider_api_logs_id_prefix check (id like 'log_%'),
  constraint provider_api_logs_duration_nonnegative check (duration_ms >= 0)
);

create table public.provider_callbacks (
  id text primary key,
  channel_id text not null references public.channels(id) on delete cascade,
  callback_hash text not null,
  headers jsonb not null,
  raw_body text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text,
  constraint provider_callbacks_id_prefix check (id like 'pcb_%'),
  constraint provider_callbacks_hash_length check (char_length(callback_hash) = 64),
  constraint provider_callbacks_unique_hash unique (channel_id, callback_hash)
);

create index channels_country_kind_mode_idx
  on public.channels (country_code, kind, mode, priority asc, created_at desc);
create index channels_created_at_idx on public.channels (created_at desc);
create index channels_provider_code_idx on public.channels (provider_code, mode, created_at desc);

create index routing_rules_created_at_idx on public.routing_rules (created_at desc);
create unique index routing_rules_lookup_idx
  on public.routing_rules (
    country_code,
    kind,
    coalesce(network, ''),
    capability
  );
create index msisdn_prefixes_network_idx on public.msisdn_prefixes (country_code, network, prefix);
create index msisdn_prefixes_created_at_idx on public.msisdn_prefixes (created_at desc);
create index channel_health_events_channel_idx
  on public.channel_health_events (channel_id, created_at desc);
create index channel_health_events_created_at_idx on public.channel_health_events (created_at desc);
create index provider_api_logs_channel_idx
  on public.provider_api_logs (channel_id, created_at desc);
create index provider_api_logs_created_at_idx on public.provider_api_logs (created_at desc);
create index provider_callbacks_channel_idx
  on public.provider_callbacks (channel_id, received_at desc);
create index provider_callbacks_pending_idx
  on public.provider_callbacks (processed_at, received_at asc);

create trigger channels_touch_updated_at
before update on public.channels
for each row
execute function public.rp_touch_updated_at();

create trigger routing_rules_touch_updated_at
before update on public.routing_rules
for each row
execute function public.rp_touch_updated_at();

create trigger msisdn_prefixes_touch_updated_at
before update on public.msisdn_prefixes
for each row
execute function public.rp_touch_updated_at();

grant select, insert, update, delete on public.channels to richespay_system;
grant select, insert, update, delete on public.routing_rules to richespay_system;
grant select, insert, update, delete on public.msisdn_prefixes to richespay_system;
grant select, insert on public.channel_health_events to richespay_system;
grant select, insert on public.provider_api_logs to richespay_system;
grant select, insert, update on public.provider_callbacks to richespay_system;

alter table public.channels enable row level security;
alter table public.channels force row level security;

alter table public.routing_rules enable row level security;
alter table public.routing_rules force row level security;

alter table public.msisdn_prefixes enable row level security;
alter table public.msisdn_prefixes force row level security;

alter table public.channel_health_events enable row level security;
alter table public.channel_health_events force row level security;

alter table public.provider_api_logs enable row level security;
alter table public.provider_api_logs force row level security;

alter table public.provider_callbacks enable row level security;
alter table public.provider_callbacks force row level security;

commit;
