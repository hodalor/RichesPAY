begin;

alter type public.journal_reference_type add value if not exists 'topup';

commit;

begin;

create type public.topup_status as enum (
  'pending',
  'successful',
  'failed',
  'expired'
);

create type public.email_delivery_status as enum (
  'pending',
  'sent',
  'failed'
);

alter table public.merchants
  add column if not exists topup_transfer_reference text,
  add constraint merchants_topup_transfer_reference_format
    check (
      topup_transfer_reference is null
      or topup_transfer_reference ~ '^RPTOP-[A-Z0-9]{10,32}$'
    );

update public.merchants
set topup_transfer_reference = concat(
  'RPTOP-',
  upper(left(regexp_replace(replace(id, 'mer_', ''), '[^A-Za-z0-9]', '', 'g'), 20))
)
where topup_transfer_reference is null;

create unique index merchants_topup_transfer_reference_idx
  on public.merchants (topup_transfer_reference)
  where topup_transfer_reference is not null;

create or replace function public.rp_assign_topup_transfer_reference()
returns trigger
language plpgsql
as $$
begin
  if new.topup_transfer_reference is null then
    new.topup_transfer_reference := concat(
      'RPTOP-',
      upper(left(regexp_replace(replace(new.id, 'mer_', ''), '[^A-Za-z0-9]', '', 'g'), 20))
    );
  end if;

  return new;
end
$$;

create trigger merchants_assign_topup_transfer_reference
before insert on public.merchants
for each row
execute function public.rp_assign_topup_transfer_reference();

alter table public.collections
  add column if not exists reference_type text not null default 'collection',
  add constraint collections_reference_type_supported
    check (reference_type in ('collection', 'topup'));

create index collections_reference_type_created_at_idx
  on public.collections (reference_type, created_at desc);

create table public.topups (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  method text not null,
  amount bigint not null,
  currency text not null,
  fee_minor bigint not null default 0,
  status public.topup_status not null,
  provider_ref text,
  bank_reference text,
  confirmed_by text,
  source_collection_id text references public.collections(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint topups_id_prefix check (id like 'top_%'),
  constraint topups_method_supported
    check (method in ('mobile_money', 'card', 'bank_transfer')),
  constraint topups_amount_positive check (amount > 0),
  constraint topups_fee_minor_nonnegative check (fee_minor >= 0),
  constraint topups_currency_uppercase check (currency = upper(currency)),
  constraint topups_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create unique index topups_source_collection_id_idx
  on public.topups (source_collection_id)
  where source_collection_id is not null;
create index topups_merchant_id_idx on public.topups (merchant_id);
create index topups_created_at_idx on public.topups (created_at desc);
create index topups_status_created_at_idx
  on public.topups (status, created_at desc);
create index topups_bank_reference_idx
  on public.topups (bank_reference)
  where bank_reference is not null;
create index topups_provider_ref_idx
  on public.topups (provider_ref)
  where provider_ref is not null;

create table public.merchant_balance_alert_thresholds (
  merchant_id text not null,
  mode public.rp_mode not null,
  currency text not null,
  threshold_minor bigint not null,
  is_below_threshold boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (merchant_id, mode, currency),
  constraint merchant_balance_alert_thresholds_threshold_nonnegative
    check (threshold_minor >= 0),
  constraint merchant_balance_alert_thresholds_currency_uppercase
    check (currency = upper(currency)),
  constraint merchant_balance_alert_thresholds_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create index merchant_balance_alert_thresholds_merchant_id_idx
  on public.merchant_balance_alert_thresholds (merchant_id);
create index merchant_balance_alert_thresholds_created_at_idx
  on public.merchant_balance_alert_thresholds (created_at desc);

create table public.email_outbox (
  id text primary key,
  merchant_id text not null,
  mode public.rp_mode not null,
  recipient_email text not null,
  subject text not null,
  body text not null,
  status public.email_delivery_status not null default 'pending',
  failure_message text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint email_outbox_id_prefix check (id like 'eml_%'),
  constraint email_outbox_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade
);

create index email_outbox_merchant_id_idx on public.email_outbox (merchant_id);
create index email_outbox_created_at_idx on public.email_outbox (created_at desc);
create index email_outbox_pending_idx
  on public.email_outbox (status, created_at asc)
  where status = 'pending';

create trigger email_outbox_append_only_delete
before delete on public.email_outbox
for each row
execute function public.rp_append_only_guard();

create or replace function public.rp_sync_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger merchant_balance_alert_thresholds_sync_updated_at
before update on public.merchant_balance_alert_thresholds
for each row
execute function public.rp_sync_updated_at();

create or replace function public.rp_handle_balance_threshold_change()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  account_record record;
  threshold_record record;
  previous_balance bigint;
begin
  select la.merchant_id, la.mode, la.currency, la.type
    into account_record
  from public.ledger_accounts la
  where la.id = new.account_id;

  if account_record.merchant_id is null or account_record.type <> 'merchant_available' then
    return new;
  end if;

  select *
    into threshold_record
  from public.merchant_balance_alert_thresholds
  where merchant_id = account_record.merchant_id
    and mode = account_record.mode
    and currency = account_record.currency;

  if threshold_record is null then
    return new;
  end if;

  previous_balance := coalesce(old.balance, 0);

  if new.balance < threshold_record.threshold_minor and not threshold_record.is_below_threshold then
    update public.merchant_balance_alert_thresholds
      set is_below_threshold = true
    where merchant_id = threshold_record.merchant_id
      and mode = threshold_record.mode
      and currency = threshold_record.currency;

    insert into public.events_outbox (
      id,
      type,
      merchant_id,
      mode,
      payload,
      created_at
    )
    values (
      concat('evt_', replace(gen_random_uuid()::text, '-', '')),
      'balance.low',
      threshold_record.merchant_id,
      threshold_record.mode,
      jsonb_build_object(
        'balance_minor', new.balance,
        'currency', threshold_record.currency,
        'previous_balance_minor', previous_balance,
        'threshold_minor', threshold_record.threshold_minor
      ),
      now()
    );

    insert into public.email_outbox (
      id,
      merchant_id,
      mode,
      recipient_email,
      subject,
      body,
      status,
      created_at
    )
    select
      concat('eml_', replace(gen_random_uuid()::text, '-', '')),
      threshold_record.merchant_id,
      threshold_record.mode,
      recipient_email,
      concat('Low balance alert for ', merchant.legal_name),
      concat(
        'RichesPay low balance alert', E'\n\n',
        'Merchant: ', merchant.legal_name, E'\n',
        'Mode: ', threshold_record.mode, E'\n',
        'Currency: ', threshold_record.currency, E'\n',
        'Current balance: ', new.balance::text, E'\n',
        'Threshold: ', threshold_record.threshold_minor::text, E'\n'
      ),
      'pending',
      now()
    from public.merchants merchant
    cross join lateral (
      select distinct recipient_email
      from (
        select merchant.support_email as recipient_email
        union all
        select user_account.email as recipient_email
        from public.memberships membership
        inner join auth.users user_account on user_account.id = membership.user_id
        where membership.merchant_id = threshold_record.merchant_id
          and membership.role in ('owner', 'admin', 'finance')
      ) recipients
      where recipient_email is not null
    ) recipient_rows
    where merchant.id = threshold_record.merchant_id
      and merchant.mode = threshold_record.mode;
  elsif new.balance >= threshold_record.threshold_minor and threshold_record.is_below_threshold then
    update public.merchant_balance_alert_thresholds
      set is_below_threshold = false
    where merchant_id = threshold_record.merchant_id
      and mode = threshold_record.mode
      and currency = threshold_record.currency;
  end if;

  return new;
end
$$;

create trigger account_balances_low_balance_alert
after update on public.account_balances
for each row
execute function public.rp_handle_balance_threshold_change();

grant select, insert, update on public.topups to richespay_app, richespay_system;
grant select, insert, update, delete on public.merchant_balance_alert_thresholds to richespay_app, richespay_system;
grant select, insert, update on public.email_outbox to richespay_system;

alter table public.topups enable row level security;
alter table public.topups force row level security;

alter table public.merchant_balance_alert_thresholds enable row level security;
alter table public.merchant_balance_alert_thresholds force row level security;

alter table public.email_outbox enable row level security;
alter table public.email_outbox force row level security;

create policy topups_app_scope_all
  on public.topups
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy merchant_balance_alert_thresholds_app_scope_all
  on public.merchant_balance_alert_thresholds
  for all
  to richespay_app
  using (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode())
  with check (merchant_id = public.rp_current_merchant_id() and mode = public.rp_current_mode());

create policy email_outbox_system_scope_all
  on public.email_outbox
  for all
  to richespay_system
  using (true)
  with check (true);

commit;
