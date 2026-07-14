-- I-004-E: durable mainnet canary admission ledger.
--
-- The reservation and cap checks live in one SECURITY DEFINER transaction so
-- two ASP workers cannot both consume the single-lifecycle canary slot. This
-- migration only provisions the ledger; it does not enable production
-- execution or seed a tenant/allowlist.

begin;

alter table if exists public.paid_execution_canary_reservations
  drop constraint if exists paid_execution_canary_reservations_reservation_key_check;

create table if not exists public.paid_execution_canary_reservations (
  id uuid primary key default extensions.gen_random_uuid(),
  environment text not null check (environment in ('staging', 'production')),
  reservation_key text not null check (
    length(reservation_key) between 1 and 256
    and reservation_key ~ '^[A-Za-z0-9:_-]+$'
  ),
  lifecycle_id uuid not null,
  tenant_id uuid not null,
  payment_intent_id text not null,
  day_key date not null,
  amount_atomic numeric(78, 0) not null check (amount_atomic > 0),
  status text not null default 'RESERVED'
    check (status in ('RESERVED', 'COMPLETED', 'MANUAL_REVIEW')),
  reserved_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (environment, reservation_key),
  unique (environment, lifecycle_id),
  foreign key (tenant_id, lifecycle_id)
    references public.paid_execution_lifecycles (tenant_id, id)
    on delete restrict,
  foreign key (tenant_id, payment_intent_id)
    references public.payment_intents (tenant_id, id)
    on delete restrict,
  check ((status = 'COMPLETED' and completed_at is not null) or (status <> 'COMPLETED' and completed_at is null))
);

create index if not exists paid_execution_canary_reservations_day_idx
  on public.paid_execution_canary_reservations (environment, day_key, status, tenant_id);
create index if not exists paid_execution_canary_reservations_tenant_idx
  on public.paid_execution_canary_reservations (tenant_id, day_key, status, updated_at desc);

alter table public.paid_execution_canary_reservations enable row level security;
revoke all on table public.paid_execution_canary_reservations from public, anon, authenticated;
grant select, insert, update on table public.paid_execution_canary_reservations to service_role;

create or replace function public.paid_execution_canary_usage(
  p_environment text,
  p_tenant_id uuid,
  p_day_key date
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    -- The lifecycle cap is campaign-wide and must not reset at UTC midnight.
    'accepted_lifecycles', (
      select count(*)::bigint
      from public.paid_execution_canary_reservations
      where environment = p_environment
    ),
    'tenant_daily_atomic', (
      select coalesce(sum(amount_atomic), 0)::numeric
      from public.paid_execution_canary_reservations
      where environment = p_environment and day_key = p_day_key and tenant_id = p_tenant_id
    ),
    'global_daily_atomic', (
      select coalesce(sum(amount_atomic), 0)::numeric
      from public.paid_execution_canary_reservations
      where environment = p_environment and day_key = p_day_key
    ),
    -- An unresolved reservation remains an in-flight safety fence across
    -- midnight; operators must complete or manually reconcile it explicitly.
    'tenant_in_flight', (
      select count(*)::bigint
      from public.paid_execution_canary_reservations
      where environment = p_environment and tenant_id = p_tenant_id and status in ('RESERVED', 'MANUAL_REVIEW')
    )
  );
$$;

create or replace function public.get_paid_execution_canary_usage(
  p_environment text,
  p_tenant_id uuid,
  p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_environment is null or p_environment not in ('staging', 'production') or p_tenant_id is null or p_at is null then
    raise exception using message = 'CANARY_INPUT_INVALID: Environment, tenant, and timestamp are required.';
  end if;
  return public.paid_execution_canary_usage(p_environment, p_tenant_id, (p_at at time zone 'utc')::date);
end;
$$;

create or replace function public.reserve_paid_execution_canary(
  p_environment text,
  p_reservation_key text,
  p_lifecycle_id uuid,
  p_tenant_id uuid,
  p_payment_intent_id text,
  p_amount_atomic numeric,
  p_at timestamptz,
  p_max_accepted_lifecycles integer,
  p_max_invoice_atomic numeric,
  p_max_tenant_daily_atomic numeric,
  p_max_global_daily_atomic numeric,
  p_max_in_flight_per_tenant integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day_key date;
  v_existing public.paid_execution_canary_reservations%rowtype;
  v_usage jsonb;
begin
  if p_environment is null
    or p_environment not in ('staging', 'production')
    or p_reservation_key is null
    or length(p_reservation_key) not between 1 and 256
    or p_reservation_key !~ '^[A-Za-z0-9:_-]+$'
    or p_lifecycle_id is null
    or p_tenant_id is null
    or p_payment_intent_id is null
    or p_payment_intent_id = ''
    or p_at is null
    or p_amount_atomic is null
    or p_amount_atomic <= 0
    or p_amount_atomic <> trunc(p_amount_atomic)
    or p_max_accepted_lifecycles is null
    or p_max_accepted_lifecycles <= 0
    or p_max_invoice_atomic is null
    or p_max_invoice_atomic <= 0
    or p_max_tenant_daily_atomic is null
    or p_max_tenant_daily_atomic <= 0
    or p_max_global_daily_atomic is null
    or p_max_global_daily_atomic <= 0
    or p_max_in_flight_per_tenant is null
    or p_max_in_flight_per_tenant <= 0 then
    raise exception using message = 'CANARY_INPUT_INVALID: Canary reservation input is invalid.';
  end if;

  v_day_key := (p_at at time zone 'utc')::date;

  -- One lock per environment serializes the campaign-wide lifecycle cap and
  -- the daily amount counters across UTC day boundaries.
  perform pg_advisory_xact_lock(hashtextextended('agentpay:canary:' || p_environment, 0));

  select * into v_existing
  from public.paid_execution_canary_reservations
  where environment = p_environment
    and reservation_key = p_reservation_key
  for update;

  if found then
    if v_existing.lifecycle_id <> p_lifecycle_id
      or v_existing.tenant_id <> p_tenant_id
      or v_existing.payment_intent_id <> p_payment_intent_id
      or v_existing.amount_atomic <> p_amount_atomic then
      raise exception using message = 'CANARY_RESERVATION_CONFLICT: Reservation key is bound to different payment terms.';
    end if;
    v_usage := public.paid_execution_canary_usage(p_environment, p_tenant_id, v_existing.day_key);
    return jsonb_build_object('disposition', 'REPLAY') || v_usage;
  end if;

  v_usage := public.paid_execution_canary_usage(p_environment, p_tenant_id, v_day_key);
  if (v_usage ->> 'accepted_lifecycles')::bigint >= p_max_accepted_lifecycles then
    raise exception using message = 'CANARY_AUTO_STOP: The canary has already consumed its lifecycle cap.';
  end if;
  if p_amount_atomic > p_max_invoice_atomic then
    raise exception using message = 'CANARY_CAP: Payment exceeds the canary invoice cap.';
  end if;
  if (v_usage ->> 'tenant_daily_atomic')::numeric + p_amount_atomic > p_max_tenant_daily_atomic
    or (v_usage ->> 'global_daily_atomic')::numeric + p_amount_atomic > p_max_global_daily_atomic then
    raise exception using message = 'CANARY_CAP: Payment exceeds the canary daily cap.';
  end if;
  if (v_usage ->> 'tenant_in_flight')::bigint >= p_max_in_flight_per_tenant then
    raise exception using message = 'CANARY_IN_FLIGHT: The canary tenant already has an in-flight invoice.';
  end if;

  insert into public.paid_execution_canary_reservations (
    environment,
    reservation_key,
    lifecycle_id,
    tenant_id,
    payment_intent_id,
    day_key,
    amount_atomic,
    status,
    reserved_at,
    updated_at
  ) values (
    p_environment,
    p_reservation_key,
    p_lifecycle_id,
    p_tenant_id,
    p_payment_intent_id,
    v_day_key,
    p_amount_atomic,
    'RESERVED',
    p_at,
    p_at
  );

  return jsonb_build_object('disposition', 'RESERVED') ||
    public.paid_execution_canary_usage(p_environment, p_tenant_id, v_day_key);
end;
$$;

create or replace function public.complete_paid_execution_canary(
  p_environment text,
  p_reservation_key text,
  p_tenant_id uuid,
  p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.paid_execution_canary_reservations%rowtype;
begin
  if p_environment is null or p_environment not in ('staging', 'production') or p_reservation_key is null or p_tenant_id is null or p_at is null then
    raise exception using message = 'CANARY_INPUT_INVALID: Environment, reservation, tenant, and timestamp are required.';
  end if;

  -- Keep completion/snapshot ordering consistent with reserve so an operator
  -- read cannot observe a partially released in-flight fence.
  perform pg_advisory_xact_lock(hashtextextended('agentpay:canary:' || p_environment, 0));

  select * into v_existing
  from public.paid_execution_canary_reservations
  where environment = p_environment
    and reservation_key = p_reservation_key
  for update;
  if not found then
    raise exception using message = 'CANARY_RESERVATION_NOT_FOUND: Canary reservation was not found.';
  end if;
  if v_existing.tenant_id <> p_tenant_id then
    raise exception using message = 'CANARY_TENANT_MISMATCH: Canary reservation does not belong to this tenant.';
  end if;

  if v_existing.status <> 'COMPLETED' then
    update public.paid_execution_canary_reservations
    set status = 'COMPLETED', completed_at = p_at, updated_at = p_at
    where id = v_existing.id;
  end if;

  return public.paid_execution_canary_usage(p_environment, p_tenant_id, v_existing.day_key);
end;
$$;

revoke all on function public.paid_execution_canary_usage(text, uuid, date) from public, anon, authenticated;
revoke all on function public.get_paid_execution_canary_usage(text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.reserve_paid_execution_canary(text, text, uuid, uuid, text, numeric, timestamptz, integer, numeric, numeric, numeric, integer) from public, anon, authenticated;
revoke all on function public.complete_paid_execution_canary(text, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.get_paid_execution_canary_usage(text, uuid, timestamptz) to service_role;
grant execute on function public.reserve_paid_execution_canary(text, text, uuid, uuid, text, numeric, timestamptz, integer, numeric, numeric, numeric, integer) to service_role;
grant execute on function public.complete_paid_execution_canary(text, text, uuid, timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
