alter table public.merchant_products
  add column if not exists sms_broadcast_enabled boolean not null default false,
  add column if not exists sms_api_enabled boolean not null default false;

update public.merchant_products
set
  sms_broadcast_enabled = sms_enabled,
  sms_api_enabled = sms_enabled
where sms_enabled = true
  and sms_broadcast_enabled = false
  and sms_api_enabled = false;
