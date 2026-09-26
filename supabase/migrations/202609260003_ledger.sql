begin;

create type public.ledger_account_type as enum (
  'merchant_available',
  'merchant_pending',
  'merchant_reserve',
  'merchant_payout_hold',
  'platform_fees',
  'platform_sms_revenue',
  'provider_clearing',
  'fx_clearing',
  'suspense'
);

create type public.journal_reference_type as enum (
  'collection',
  'payout',
  'sms',
  'fee',
  'adjustment',
  'settlement',
  'reversal'
);

create type public.posting_direction as enum ('debit', 'credit');

create table public.ledger_accounts (
  id text primary key,
  merchant_id text,
  mode public.rp_mode not null,
  currency text not null,
  type public.ledger_account_type not null,
  channel_id text,
  created_at timestamptz not null default now(),
  constraint ledger_accounts_id_prefix check (id like 'lac_%'),
  constraint ledger_accounts_currency_uppercase check (currency = upper(currency)),
  constraint ledger_accounts_channel_id_rule check (
    (type = 'provider_clearing' and channel_id is not null)
    or (type <> 'provider_clearing' and channel_id is null)
  ),
  constraint ledger_accounts_merchant_fk
    foreign key (merchant_id, mode) references public.merchants(id, mode) on delete cascade,
  constraint ledger_accounts_identity_unique
    unique nulls not distinct (merchant_id, mode, currency, type, channel_id)
);

create table public.journal_entries (
  id text primary key,
  mode public.rp_mode not null,
  currency text not null,
  reference_type public.journal_reference_type not null,
  reference_id text not null,
  description text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint journal_entries_id_prefix check (id like 'jrn_%'),
  constraint journal_entries_currency_uppercase check (currency = upper(currency))
);

create table public.postings (
  id text primary key,
  journal_entry_id text not null references public.journal_entries(id) on delete restrict,
  account_id text not null references public.ledger_accounts(id) on delete restrict,
  direction public.posting_direction not null,
  amount bigint not null,
  created_at timestamptz not null default now(),
  constraint postings_id_prefix check (id like 'pst_%'),
  constraint postings_amount_positive check (amount > 0)
);

create table public.account_balances (
  account_id text primary key references public.ledger_accounts(id) on delete cascade,
  balance bigint not null default 0,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);

create index ledger_accounts_merchant_id_idx on public.ledger_accounts (merchant_id);
create index ledger_accounts_created_at_idx on public.ledger_accounts (created_at desc);
create index journal_entries_created_at_idx on public.journal_entries (created_at desc);
create index journal_entries_reference_idx on public.journal_entries (reference_type, reference_id);
create index postings_journal_entry_id_idx on public.postings (journal_entry_id);
create index postings_account_id_idx on public.postings (account_id);
create index postings_created_at_idx on public.postings (created_at desc);
create index account_balances_updated_at_idx on public.account_balances (updated_at desc);

create or replace function public.rp_posting_delta(
  input_direction public.posting_direction,
  input_amount bigint
)
returns bigint
language sql
immutable
as $$
  select case input_direction
    when 'credit' then input_amount
    else -input_amount
  end
$$;

create or replace function public.rp_init_account_balance()
returns trigger
language plpgsql
as $$
begin
  insert into public.account_balances (account_id, balance, version, updated_at)
  values (new.id, 0, 0, now())
  on conflict (account_id) do nothing;

  return new;
end
$$;

create or replace function public.rp_guard_account_balances()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() = 0 then
    raise exception 'account_balances is managed by ledger triggers';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end
$$;

create or replace function public.rp_apply_posting_to_balance()
returns trigger
language plpgsql
as $$
declare
  updated_balance bigint;
  account_type public.ledger_account_type;
begin
  select type
    into account_type
  from public.ledger_accounts
  where id = new.account_id;

  insert into public.account_balances (account_id, balance, version, updated_at)
  values (
    new.account_id,
    public.rp_posting_delta(new.direction, new.amount),
    1,
    now()
  )
  on conflict (account_id) do update
    set balance = public.account_balances.balance + excluded.balance,
        version = public.account_balances.version + 1,
        updated_at = now()
  returning balance into updated_balance;

  if account_type in ('merchant_available', 'merchant_payout_hold')
    and updated_balance < 0 then
    raise exception using message = 'insufficient_funds';
  end if;

  return new;
end
$$;

create or replace function public.rp_validate_journal_entry()
returns trigger
language plpgsql
as $$
declare
  target_journal_id text;
  journal_currency text;
  journal_mode public.rp_mode;
  posting_count integer;
  debit_total bigint;
  credit_total bigint;
  invalid_currency_count integer;
  invalid_mode_count integer;
begin
  if tg_table_name = 'journal_entries' then
    target_journal_id := new.id;
  else
    target_journal_id := new.journal_entry_id;
  end if;

  select currency, mode
    into journal_currency, journal_mode
  from public.journal_entries
  where id = target_journal_id;

  if journal_currency is null then
    return null;
  end if;

  select
    count(*),
    coalesce(sum(case when p.direction = 'debit' then p.amount else 0 end), 0),
    coalesce(sum(case when p.direction = 'credit' then p.amount else 0 end), 0),
    count(*) filter (where la.currency is distinct from journal_currency),
    count(*) filter (where la.mode is distinct from journal_mode)
    into posting_count, debit_total, credit_total, invalid_currency_count, invalid_mode_count
  from public.postings p
  join public.ledger_accounts la on la.id = p.account_id
  where p.journal_entry_id = target_journal_id;

  if posting_count = 0 then
    raise exception 'journal entry must contain at least one posting';
  end if;

  if invalid_currency_count > 0 then
    raise exception 'journal entry postings mix currencies';
  end if;

  if invalid_mode_count > 0 then
    raise exception 'journal entry postings mix modes';
  end if;

  if debit_total <> credit_total then
    raise exception 'journal entry is not balanced';
  end if;

  return null;
end
$$;

create trigger ledger_accounts_init_balance
after insert on public.ledger_accounts
for each row
execute function public.rp_init_account_balance();

create trigger account_balances_guard_insert
before insert on public.account_balances
for each row
execute function public.rp_guard_account_balances();

create trigger account_balances_guard_update
before update on public.account_balances
for each row
execute function public.rp_guard_account_balances();

create trigger account_balances_guard_delete
before delete on public.account_balances
for each row
execute function public.rp_guard_account_balances();

create trigger postings_apply_balance
after insert on public.postings
for each row
execute function public.rp_apply_posting_to_balance();

create trigger journal_entries_append_only_update
before update on public.journal_entries
for each row
execute function public.rp_append_only_guard();

create trigger journal_entries_append_only_delete
before delete on public.journal_entries
for each row
execute function public.rp_append_only_guard();

create trigger postings_append_only_update
before update on public.postings
for each row
execute function public.rp_append_only_guard();

create trigger postings_append_only_delete
before delete on public.postings
for each row
execute function public.rp_append_only_guard();

create constraint trigger journal_entries_validate_balanced_postings
after insert on public.journal_entries
deferrable initially deferred
for each row
execute function public.rp_validate_journal_entry();

create constraint trigger postings_validate_parent_journal
after insert on public.postings
deferrable initially deferred
for each row
execute function public.rp_validate_journal_entry();

grant select, insert on public.ledger_accounts to richespay_app, richespay_system;
grant select, insert on public.journal_entries to richespay_app, richespay_system;
grant select, insert on public.postings to richespay_app, richespay_system;
grant select, insert, update on public.account_balances to richespay_app, richespay_system;

alter table public.ledger_accounts enable row level security;
alter table public.ledger_accounts force row level security;

alter table public.journal_entries enable row level security;
alter table public.journal_entries force row level security;

alter table public.postings enable row level security;
alter table public.postings force row level security;

alter table public.account_balances enable row level security;
alter table public.account_balances force row level security;

create policy ledger_accounts_app_scope_all
  on public.ledger_accounts
  for all
  to richespay_app
  using (
    mode = public.rp_current_mode()
    and (
      merchant_id = public.rp_current_merchant_id()
      or merchant_id is null
    )
  )
  with check (
    mode = public.rp_current_mode()
    and (
      merchant_id = public.rp_current_merchant_id()
      or merchant_id is null
    )
  );

create policy journal_entries_app_scope_select
  on public.journal_entries
  for select
  to richespay_app
  using (
    exists (
      select 1
      from public.postings p
      join public.ledger_accounts la on la.id = p.account_id
      where p.journal_entry_id = public.journal_entries.id
        and la.mode = public.rp_current_mode()
        and (
          la.merchant_id = public.rp_current_merchant_id()
          or la.merchant_id is null
        )
    )
  );

create policy journal_entries_app_scope_insert
  on public.journal_entries
  for insert
  to richespay_app
  with check (mode = public.rp_current_mode());

create policy postings_app_scope_all
  on public.postings
  for all
  to richespay_app
  using (
    exists (
      select 1
      from public.ledger_accounts la
      where la.id = public.postings.account_id
        and la.mode = public.rp_current_mode()
        and (
          la.merchant_id = public.rp_current_merchant_id()
          or la.merchant_id is null
        )
    )
  )
  with check (
    exists (
      select 1
      from public.ledger_accounts la
      where la.id = public.postings.account_id
        and la.mode = public.rp_current_mode()
        and (
          la.merchant_id = public.rp_current_merchant_id()
          or la.merchant_id is null
        )
    )
  );

create policy account_balances_app_scope_all
  on public.account_balances
  for all
  to richespay_app
  using (
    exists (
      select 1
      from public.ledger_accounts la
      where la.id = public.account_balances.account_id
        and la.mode = public.rp_current_mode()
        and (
          la.merchant_id = public.rp_current_merchant_id()
          or la.merchant_id is null
        )
    )
  )
  with check (
    exists (
      select 1
      from public.ledger_accounts la
      where la.id = public.account_balances.account_id
        and la.mode = public.rp_current_mode()
        and (
          la.merchant_id = public.rp_current_merchant_id()
          or la.merchant_id is null
        )
    )
  );

commit;
