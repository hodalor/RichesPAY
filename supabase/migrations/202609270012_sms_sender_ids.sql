begin;

create type public.sender_id_purpose as enum ('transactional', 'otp', 'marketing');
create type public.sender_id_approval_status as enum ('pending', 'submitted', 'approved', 'rejected');

create table public.sender_ids (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  sender_id text not null,
  purpose public.sender_id_purpose not null,
  sample_message text not null,
  authorization_letter text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint sender_ids_id_prefix check (id like 'sid_%'),
  constraint sender_ids_sender_id_format check (sender_id ~ '^[A-Z0-9]{3,11}$'),
  constraint sender_ids_authorization_letter_private_path check (authorization_letter like 'private/%'),
  constraint sender_ids_sample_message_nonempty check (char_length(trim(sample_message)) > 0),
  constraint sender_ids_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade,
  constraint sender_ids_merchant_sender_unique unique (merchant_id, mode, sender_id)
);

create index sender_ids_merchant_id_idx on public.sender_ids (merchant_id);
create index sender_ids_created_at_idx on public.sender_ids (created_at desc);

create table public.sender_id_approvals (
  id text primary key,
  sender_id_id text not null references public.sender_ids(id) on delete cascade,
  merchant_id text not null,
  mode public.rp_mode not null,
  country_code text not null references public.countries(code) on delete restrict,
  network text not null,
  status public.sender_id_approval_status not null default 'pending',
  rejection_reason text,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint sender_id_approvals_id_prefix check (id like 'sia_%'),
  constraint sender_id_approvals_network_nonempty check (char_length(trim(network)) > 0),
  constraint sender_id_approvals_reason_required_for_rejection check (
    status <> 'rejected' or rejection_reason is not null
  ),
  constraint sender_id_approvals_unique_target unique (sender_id_id, country_code, network),
  constraint sender_id_approvals_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create index sender_id_approvals_merchant_id_idx on public.sender_id_approvals (merchant_id);
create index sender_id_approvals_status_idx on public.sender_id_approvals (status, updated_at desc);
create index sender_id_approvals_sender_id_idx on public.sender_id_approvals (sender_id_id);
create index sender_id_approvals_created_at_idx on public.sender_id_approvals (created_at desc);

create trigger sender_id_approvals_sync_updated_at
before update on public.sender_id_approvals
for each row
execute function public.rp_sync_updated_at();

create table public.merchant_notifications (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  type text not null,
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint merchant_notifications_id_prefix check (id like 'ntf_%'),
  constraint merchant_notifications_data_object check (jsonb_typeof(data) = 'object'),
  constraint merchant_notifications_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create index merchant_notifications_merchant_id_idx on public.merchant_notifications (merchant_id);
create index merchant_notifications_created_at_idx on public.merchant_notifications (created_at desc);
create index merchant_notifications_unread_idx
  on public.merchant_notifications (merchant_id, mode, created_at desc)
  where read_at is null;

create table public.platform_sms_settings (
  mode public.rp_mode primary key,
  default_otp_sender_id text,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_sms_settings_sender_id_format check (
    default_otp_sender_id is null or default_otp_sender_id ~ '^[A-Z0-9]{3,11}$'
  )
);

create trigger platform_sms_settings_sync_updated_at
before update on public.platform_sms_settings
for each row
execute function public.rp_sync_updated_at();

insert into public.platform_sms_settings (
  mode,
  default_otp_sender_id,
  updated_by
)
values
  ('test', null, 'system'),
  ('live', null, 'system')
on conflict (mode) do nothing;

grant select, insert on public.sender_ids to richespay_app;
grant select, insert on public.sender_id_approvals to richespay_app;
grant select, update on public.merchant_notifications to richespay_app;

grant select, insert, update, delete on public.sender_ids to richespay_system;
grant select, insert, update, delete on public.sender_id_approvals to richespay_system;
grant select, insert, update, delete on public.merchant_notifications to richespay_system;
grant select, update on public.platform_sms_settings to richespay_system;

alter table public.sender_ids enable row level security;
alter table public.sender_ids force row level security;
alter table public.sender_id_approvals enable row level security;
alter table public.sender_id_approvals force row level security;
alter table public.merchant_notifications enable row level security;
alter table public.merchant_notifications force row level security;
alter table public.platform_sms_settings enable row level security;
alter table public.platform_sms_settings force row level security;

create policy sender_ids_app_scope_select
  on public.sender_ids
  for select
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy sender_ids_app_scope_insert
  on public.sender_ids
  for insert
  to richespay_app
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy sender_id_approvals_app_scope_select
  on public.sender_id_approvals
  for select
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy sender_id_approvals_app_scope_insert
  on public.sender_id_approvals
  for insert
  to richespay_app
  with check (
    merchant_id = public.rp_current_merchant_id()
    and mode = public.rp_current_mode()
    and exists (
      select 1
      from public.sender_ids sender
      where sender.id = sender_id_id
        and sender.merchant_id = public.rp_current_merchant_id()
        and sender.mode = public.rp_current_mode()
    )
  );

create policy merchant_notifications_app_scope_select
  on public.merchant_notifications
  for select
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy merchant_notifications_app_scope_update
  on public.merchant_notifications
  for update
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy sender_ids_system_scope_all
  on public.sender_ids
  for all
  to richespay_system
  using (true)
  with check (true);

create policy sender_id_approvals_system_scope_all
  on public.sender_id_approvals
  for all
  to richespay_system
  using (true)
  with check (true);

create policy merchant_notifications_system_scope_all
  on public.merchant_notifications
  for all
  to richespay_system
  using (true)
  with check (true);

create policy platform_sms_settings_system_scope_all
  on public.platform_sms_settings
  for all
  to richespay_system
  using (true)
  with check (true);

commit;
