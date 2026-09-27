begin;

create type public.sms_message_encoding as enum ('gsm7', 'ucs2');
create type public.sms_message_type as enum ('transactional', 'otp', 'marketing');
create type public.sms_message_status as enum (
  'queued',
  'sent',
  'delivered',
  'undelivered',
  'failed',
  'rejected'
);
create type public.sms_batch_status as enum ('queued', 'processing', 'completed', 'partial');
create type public.sms_otp_status as enum ('pending', 'verified', 'expired', 'failed');

create table public.merchant_products (
  merchant_id text not null,
  mode public.rp_mode not null,
  collections_enabled boolean not null default true,
  payouts_enabled boolean not null default true,
  sms_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (merchant_id, mode),
  constraint merchant_products_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.sms_batches (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  sender_id text,
  body text not null,
  type public.sms_message_type not null,
  reference text,
  metadata jsonb not null default '{}'::jsonb,
  total_count integer not null default 0,
  accepted_count integer not null default 0,
  rejected_count integer not null default 0,
  scheduled_at timestamptz,
  status public.sms_batch_status not null default 'queued',
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sms_batches_id_prefix check (id like 'smb_%'),
  constraint sms_batches_counts_nonnegative check (
    total_count >= 0
    and accepted_count >= 0
    and rejected_count >= 0
  ),
  constraint sms_batches_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.sms_templates (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  name text not null,
  body text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sms_templates_id_prefix check (id like 'smt_%'),
  constraint sms_templates_name_nonempty check (char_length(trim(name)) > 0),
  constraint sms_templates_body_nonempty check (char_length(trim(body)) > 0),
  constraint sms_templates_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade,
  constraint sms_templates_unique_name unique (merchant_id, mode, name)
);

create table public.contacts (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  name text,
  phone text not null,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contacts_id_prefix check (id like 'ctc_%'),
  constraint contacts_phone_nonempty check (char_length(trim(phone)) > 0),
  constraint contacts_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.contact_groups (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  name text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contact_groups_id_prefix check (id like 'cgr_%'),
  constraint contact_groups_name_nonempty check (char_length(trim(name)) > 0),
  constraint contact_groups_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade,
  constraint contact_groups_unique_name unique (merchant_id, mode, name)
);

create table public.contact_group_members (
  group_id text not null references public.contact_groups(id) on delete cascade,
  contact_id text not null references public.contacts(id) on delete cascade,
  merchant_id text not null,
  mode public.rp_mode not null,
  created_at timestamptz not null default now(),
  primary key (group_id, contact_id),
  constraint contact_group_members_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.sms_opt_outs (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  phone text not null,
  created_at timestamptz not null default now(),
  constraint sms_opt_outs_id_prefix check (id like 'soo_%'),
  constraint sms_opt_outs_phone_nonempty check (char_length(trim(phone)) > 0),
  constraint sms_opt_outs_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade,
  constraint sms_opt_outs_unique_phone unique (merchant_id, mode, phone)
);

create table public.sms_messages (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  batch_id text references public.sms_batches(id) on delete set null,
  sender_id text not null,
  "to" text not null,
  body text not null,
  encoding public.sms_message_encoding not null,
  segments integer not null,
  price_minor bigint not null,
  currency text not null,
  type public.sms_message_type not null,
  channel_id text references public.channels(id) on delete set null,
  provider_ref text,
  status public.sms_message_status not null default 'queued',
  failure_code text,
  reference text,
  metadata jsonb not null default '{}'::jsonb,
  scheduled_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  constraint sms_messages_id_prefix check (id like 'sms_%'),
  constraint sms_messages_segments_positive check (segments > 0),
  constraint sms_messages_price_nonnegative check (price_minor >= 0),
  constraint sms_messages_sender_id_format check (sender_id ~ '^[A-Z0-9]{3,11}$'),
  constraint sms_messages_to_nonempty check (char_length(trim("to")) > 0),
  constraint sms_messages_body_nonempty check (char_length(trim(body)) > 0),
  constraint sms_messages_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.sms_otps (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  sms_message_id text references public.sms_messages(id) on delete set null,
  "to" text not null,
  sender_id text,
  code_hash text not null,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  status public.sms_otp_status not null default 'pending',
  expires_at timestamptz not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sms_otps_id_prefix check (id like 'otp_%'),
  constraint sms_otps_hash_length check (char_length(code_hash) = 64),
  constraint sms_otps_attempts_nonnegative check (attempts >= 0 and max_attempts > 0),
  constraint sms_otps_to_nonempty check (char_length(trim("to")) > 0),
  constraint sms_otps_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create index merchant_products_created_at_idx
  on public.merchant_products (created_at desc);

create index sms_batches_merchant_id_idx
  on public.sms_batches (merchant_id);
create index sms_batches_created_at_idx
  on public.sms_batches (created_at desc);
create index sms_batches_status_idx
  on public.sms_batches (merchant_id, mode, status, created_at desc);

create index sms_templates_merchant_id_idx
  on public.sms_templates (merchant_id);
create index sms_templates_created_at_idx
  on public.sms_templates (created_at desc);

create index contacts_merchant_id_idx
  on public.contacts (merchant_id);
create index contacts_created_at_idx
  on public.contacts (created_at desc);
create unique index contacts_unique_phone_idx
  on public.contacts (merchant_id, mode, phone);

create index contact_groups_merchant_id_idx
  on public.contact_groups (merchant_id);
create index contact_groups_created_at_idx
  on public.contact_groups (created_at desc);

create index contact_group_members_merchant_id_idx
  on public.contact_group_members (merchant_id, created_at desc);
create index contact_group_members_contact_idx
  on public.contact_group_members (contact_id, created_at desc);

create index sms_opt_outs_merchant_id_idx
  on public.sms_opt_outs (merchant_id);
create index sms_opt_outs_created_at_idx
  on public.sms_opt_outs (created_at desc);

create index sms_messages_merchant_id_idx
  on public.sms_messages (merchant_id);
create index sms_messages_created_at_idx
  on public.sms_messages (created_at desc);
create index sms_messages_batch_idx
  on public.sms_messages (batch_id, created_at desc);
create index sms_messages_status_idx
  on public.sms_messages (merchant_id, mode, status, created_at desc);
create index sms_messages_reference_idx
  on public.sms_messages (merchant_id, mode, reference, created_at desc);
create index sms_messages_due_queue_idx
  on public.sms_messages (status, scheduled_at asc, created_at asc);
create index sms_messages_provider_ref_idx
  on public.sms_messages (provider_ref, created_at desc);

create index sms_otps_merchant_id_idx
  on public.sms_otps (merchant_id);
create index sms_otps_created_at_idx
  on public.sms_otps (created_at desc);
create index sms_otps_expires_at_idx
  on public.sms_otps (status, expires_at asc);

create trigger merchant_products_touch_updated_at
before update on public.merchant_products
for each row
execute function public.rp_touch_updated_at();

create trigger sms_batches_touch_updated_at
before update on public.sms_batches
for each row
execute function public.rp_touch_updated_at();

create trigger sms_templates_touch_updated_at
before update on public.sms_templates
for each row
execute function public.rp_touch_updated_at();

create trigger contacts_touch_updated_at
before update on public.contacts
for each row
execute function public.rp_touch_updated_at();

create trigger contact_groups_touch_updated_at
before update on public.contact_groups
for each row
execute function public.rp_touch_updated_at();

create trigger sms_otps_touch_updated_at
before update on public.sms_otps
for each row
execute function public.rp_touch_updated_at();

create or replace function public.rp_seed_merchant_products()
returns trigger
language plpgsql
as $$
begin
  insert into public.merchant_products (
    merchant_id,
    mode,
    collections_enabled,
    payouts_enabled,
    sms_enabled
  )
  values (
    new.id,
    new.mode,
    true,
    true,
    true
  )
  on conflict (merchant_id, mode) do nothing;

  return new;
end
$$;

create trigger merchants_seed_products_after_insert
after insert on public.merchants
for each row
execute function public.rp_seed_merchant_products();

insert into public.merchant_products (
  merchant_id,
  mode,
  collections_enabled,
  payouts_enabled,
  sms_enabled
)
select
  merchant.id,
  merchant.mode,
  true,
  true,
  true
from public.merchants as merchant
on conflict (merchant_id, mode) do nothing;

grant select, insert, update, delete on public.merchant_products to richespay_app, richespay_system;
grant select, insert, update, delete on public.sms_batches to richespay_app, richespay_system;
grant select, insert, update, delete on public.sms_templates to richespay_app, richespay_system;
grant select, insert, update, delete on public.contacts to richespay_app, richespay_system;
grant select, insert, update, delete on public.contact_groups to richespay_app, richespay_system;
grant select, insert, update, delete on public.contact_group_members to richespay_app, richespay_system;
grant select, insert, update, delete on public.sms_opt_outs to richespay_app, richespay_system;
grant select, insert, update, delete on public.sms_messages to richespay_app, richespay_system;
grant select, insert, update, delete on public.sms_otps to richespay_app, richespay_system;

alter table public.merchant_products enable row level security;
alter table public.merchant_products force row level security;

alter table public.sms_batches enable row level security;
alter table public.sms_batches force row level security;

alter table public.sms_templates enable row level security;
alter table public.sms_templates force row level security;

alter table public.contacts enable row level security;
alter table public.contacts force row level security;

alter table public.contact_groups enable row level security;
alter table public.contact_groups force row level security;

alter table public.contact_group_members enable row level security;
alter table public.contact_group_members force row level security;

alter table public.sms_opt_outs enable row level security;
alter table public.sms_opt_outs force row level security;

alter table public.sms_messages enable row level security;
alter table public.sms_messages force row level security;

alter table public.sms_otps enable row level security;
alter table public.sms_otps force row level security;

create policy merchant_products_app_scope_all
  on public.merchant_products
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy sms_batches_app_scope_all
  on public.sms_batches
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy sms_templates_app_scope_all
  on public.sms_templates
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy contacts_app_scope_all
  on public.contacts
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy contact_groups_app_scope_all
  on public.contact_groups
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy contact_group_members_app_scope_all
  on public.contact_group_members
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy sms_opt_outs_app_scope_all
  on public.sms_opt_outs
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy sms_messages_app_scope_all
  on public.sms_messages
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy sms_otps_app_scope_all
  on public.sms_otps
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

commit;
