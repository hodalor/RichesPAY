begin;

insert into public.msisdn_prefixes (
  country_code,
  prefix,
  network
)
values
  ('GH', '23320', 'telecel'),
  ('GH', '23323', 'telecel'),
  ('GH', '23324', 'mtn'),
  ('GH', '23326', 'at'),
  ('GH', '23327', 'at'),
  ('GH', '23350', 'telecel'),
  ('GH', '23353', 'telecel'),
  ('GH', '23354', 'mtn'),
  ('GH', '23355', 'mtn'),
  ('GH', '23356', 'at'),
  ('GH', '23357', 'at'),
  ('GH', '23359', 'mtn'),
  ('ZM', '26095', 'zamtel'),
  ('ZM', '26096', 'airtel'),
  ('ZM', '26097', 'mtn')
on conflict (country_code, prefix) do update
set network = excluded.network;

commit;
