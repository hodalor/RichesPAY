begin;

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000101', 'demo-gh-owner@richespay.local'),
  ('00000000-0000-0000-0000-000000000102', 'demo-zm-owner@richespay.local')
on conflict (id) do nothing;

insert into public.countries (code, name, currency, timezone, dial_code, enabled)
values
  ('GH', 'Ghana', 'GHS', 'Africa/Accra', '+233', true),
  ('ZM', 'Zambia', 'ZMW', 'Africa/Lusaka', '+260', true)
on conflict (code) do update
set
  name = excluded.name,
  currency = excluded.currency,
  timezone = excluded.timezone,
  dial_code = excluded.dial_code,
  enabled = excluded.enabled;

insert into public.merchants (
  id,
  legal_name,
  trading_name,
  country_code,
  settlement_currency,
  timezone,
  status,
  collections_frozen,
  payouts_frozen,
  website,
  support_email,
  support_phone,
  mode
)
values
  (
    'mer_demo_gh_test',
    'RichesPay Demo Ghana Test Ltd',
    'Demo Ghana Test',
    'GH',
    'GHS',
    'Africa/Accra',
    'active',
    false,
    false,
    'https://demo-gh-test.richespay.local',
    'support+gh-test@richespay.local',
    '+233240000001',
    'test'
  ),
  (
    'mer_demo_gh_live',
    'RichesPay Demo Ghana Live Ltd',
    'Demo Ghana Live',
    'GH',
    'GHS',
    'Africa/Accra',
    'active',
    false,
    false,
    'https://demo-gh-live.richespay.local',
    'support+gh-live@richespay.local',
    '+233240000002',
    'live'
  ),
  (
    'mer_demo_zm_test',
    'RichesPay Demo Zambia Test Ltd',
    'Demo Zambia Test',
    'ZM',
    'ZMW',
    'Africa/Lusaka',
    'active',
    false,
    false,
    'https://demo-zm-test.richespay.local',
    'support+zm-test@richespay.local',
    '+260970000001',
    'test'
  ),
  (
    'mer_demo_zm_live',
    'RichesPay Demo Zambia Live Ltd',
    'Demo Zambia Live',
    'ZM',
    'ZMW',
    'Africa/Lusaka',
    'active',
    false,
    false,
    'https://demo-zm-live.richespay.local',
    'support+zm-live@richespay.local',
    '+260970000002',
    'live'
  )
on conflict (id) do update
set
  legal_name = excluded.legal_name,
  trading_name = excluded.trading_name,
  country_code = excluded.country_code,
  timezone = excluded.timezone,
  status = excluded.status,
  collections_frozen = excluded.collections_frozen,
  payouts_frozen = excluded.payouts_frozen,
  website = excluded.website,
  support_email = excluded.support_email,
  support_phone = excluded.support_phone,
  mode = excluded.mode;

insert into public.profiles (user_id, full_name, phone)
values
  ('00000000-0000-0000-0000-000000000101', 'Demo Ghana Owner', '+233240000010'),
  ('00000000-0000-0000-0000-000000000102', 'Demo Zambia Owner', '+260970000010')
on conflict (user_id) do update
set
  full_name = excluded.full_name,
  phone = excluded.phone;

insert into public.memberships (merchant_id, mode, user_id, role)
values
  ('mer_demo_gh_test', 'test', '00000000-0000-0000-0000-000000000101', 'owner'),
  ('mer_demo_zm_test', 'test', '00000000-0000-0000-0000-000000000102', 'owner')
on conflict (merchant_id, user_id) do update
set
  mode = excluded.mode,
  role = excluded.role;

commit;
