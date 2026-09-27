begin;

create or replace function public.rp_generate_topup_transfer_reference(merchant_record_id text)
returns text
language sql
immutable
as $$
  select concat(
    'RPTOP-',
    upper(left(regexp_replace(replace(coalesce(merchant_record_id, ''), 'mer_', ''), '[^A-Za-z0-9]', '', 'g'), 12)),
    upper(right(md5(coalesce(merchant_record_id, '')), 10))
  )
$$;

update public.merchants
set topup_transfer_reference = public.rp_generate_topup_transfer_reference(id)
where topup_transfer_reference is null
   or topup_transfer_reference !~ '^RPTOP-[A-Z0-9]{10,32}$';

create or replace function public.rp_assign_topup_transfer_reference()
returns trigger
language plpgsql
as $$
begin
  if new.topup_transfer_reference is null then
    new.topup_transfer_reference := public.rp_generate_topup_transfer_reference(new.id);
  end if;

  return new;
end
$$;

commit;
