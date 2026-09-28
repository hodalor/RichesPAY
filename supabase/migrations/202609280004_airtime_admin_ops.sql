begin;

create table public.airtime_channel_float_history (
  id text primary key,
  channel_id text not null references public.channels(id) on delete cascade,
  balance_minor bigint,
  currency text,
  threshold_minor bigint not null,
  status public.airtime_float_status not null,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint airtime_channel_float_history_id_prefix check (id like 'afh_%')
);

create index airtime_channel_float_history_channel_id_idx
  on public.airtime_channel_float_history (channel_id, created_at desc);

create index airtime_channel_float_history_created_at_idx
  on public.airtime_channel_float_history (created_at desc);

grant select, insert, update, delete on public.airtime_channel_float_history to richespay_system;

alter table public.airtime_channel_float_history enable row level security;
alter table public.airtime_channel_float_history force row level security;

commit;
