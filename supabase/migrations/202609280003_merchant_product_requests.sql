alter table public.merchant_products
  add column if not exists collections_requested boolean not null default false,
  add column if not exists payouts_requested boolean not null default false,
  add column if not exists sms_requested boolean not null default false,
  add column if not exists airtime_requested boolean not null default false;
