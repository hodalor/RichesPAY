begin;

create type public.checkout_session_status as enum (
  'open',
  'completed',
  'expired'
);

create type public.checkout_method as enum (
  'mobile_money',
  'card'
);

create type public.payment_link_amount_mode as enum (
  'fixed',
  'customer_entered'
);

create table public.payment_links (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  title text not null,
  description text,
  amount_mode public.payment_link_amount_mode not null,
  amount bigint,
  min_amount bigint,
  currency text not null,
  reusable boolean not null default false,
  active boolean not null default true,
  slug text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_links_id_prefix check (id like 'lnk_%'),
  constraint payment_links_amount_mode_shape check (
    (amount_mode = 'fixed' and amount is not null and amount > 0 and min_amount is null)
    or (amount_mode = 'customer_entered' and amount is null and min_amount is not null and min_amount > 0)
  ),
  constraint payment_links_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint payment_links_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create table public.checkout_sessions (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  payment_link_id text references public.payment_links(id) on delete set null,
  amount bigint not null,
  currency text not null,
  reference text,
  description text,
  customer jsonb not null default '{}'::jsonb,
  allowed_methods public.checkout_method[] not null,
  success_url text,
  cancel_url text,
  status public.checkout_session_status not null default 'open',
  collection_id text references public.collections(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint checkout_sessions_id_prefix check (id like 'cs_%'),
  constraint checkout_sessions_amount_positive check (amount > 0),
  constraint checkout_sessions_allowed_methods_nonempty check (cardinality(allowed_methods) > 0),
  constraint checkout_sessions_reference_unique unique (merchant_id, mode, reference),
  constraint checkout_sessions_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create unique index payment_links_slug_unique_idx on public.payment_links (slug);
create index payment_links_merchant_id_idx on public.payment_links (merchant_id);
create index payment_links_created_at_idx on public.payment_links (created_at desc);
create index payment_links_active_idx on public.payment_links (active, created_at desc);

create index checkout_sessions_merchant_id_idx on public.checkout_sessions (merchant_id);
create index checkout_sessions_created_at_idx on public.checkout_sessions (created_at desc);
create index checkout_sessions_status_idx on public.checkout_sessions (status, created_at desc);
create index checkout_sessions_payment_link_id_idx on public.checkout_sessions (payment_link_id);
create index checkout_sessions_expires_at_idx on public.checkout_sessions (expires_at);

create trigger payment_links_touch_updated_at
before update on public.payment_links
for each row
execute function public.rp_touch_updated_at();

grant select, insert, update, delete on public.payment_links to richespay_app, richespay_system;
grant select, insert, update on public.checkout_sessions to richespay_app, richespay_system;

alter table public.payment_links enable row level security;
alter table public.payment_links force row level security;

alter table public.checkout_sessions enable row level security;
alter table public.checkout_sessions force row level security;

create policy payment_links_app_scope_all
  on public.payment_links
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy checkout_sessions_app_scope_all
  on public.checkout_sessions
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

commit;
