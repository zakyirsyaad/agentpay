-- I-002.3: persist the provider-verified destination minimum used by V2 route authorization.
-- Existing intents remain valid for legacy/read-only history; only V2 route signing
-- requires this value to be present.

alter table public.payment_intents
  add column if not exists min_amount_out text;

alter table public.payment_intents
  add column if not exists native_value text;

alter table public.payment_intents
  drop constraint if exists payment_intents_min_amount_out_check;

alter table public.payment_intents
  add constraint payment_intents_min_amount_out_check
  check (
    min_amount_out is null
    or (min_amount_out ~ '^[0-9]+(\.[0-9]+)?$' and min_amount_out::numeric > 0)
  );

alter table public.payment_intents
  drop constraint if exists payment_intents_native_value_check;

alter table public.payment_intents
  add constraint payment_intents_native_value_check
  check (
    native_value is null
    or native_value ~ '^[0-9]+$'
  );

notify pgrst, 'reload schema';
