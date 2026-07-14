-- I-004-B: durable x402 challenge ledger and invoice execution outbox.
-- This migration is intentionally separate from the first lifecycle migration
-- so an already-applied staging database can be upgraded without rewriting
-- history. It does not seed production identity or enable execution.

begin;

alter table public.paid_execution_lifecycles
  add column if not exists authorization_hash text,
  add column if not exists challenge_id uuid,
  add column if not exists environment text,
  add column if not exists fee_status text default 'ACCEPTED',
  add column if not exists execution_status text default 'NOT_QUEUED',
  add column if not exists refund_status text default 'NOT_REQUIRED';

update public.paid_execution_lifecycles
set
  fee_status = coalesce(fee_status, case
    when status in ('SETTLED', 'EXECUTING', 'COMPLETED') then 'SETTLED'
    when status = 'SETTLING' then 'SETTLING'
    else 'ACCEPTED'
  end),
  execution_status = coalesce(execution_status, case
    when status = 'EXECUTING' then 'QUEUED'
    when status = 'COMPLETED' then 'BROADCASTED'
    else 'NOT_QUEUED'
  end),
  refund_status = coalesce(refund_status, 'NOT_REQUIRED');

alter table public.paid_execution_lifecycles
  alter column fee_status set default 'ACCEPTED',
  alter column fee_status set not null,
  alter column execution_status set default 'NOT_QUEUED',
  alter column execution_status set not null,
  alter column refund_status set default 'NOT_REQUIRED',
  alter column refund_status set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'paid_execution_lifecycles_authorization_hash_check') then
    alter table public.paid_execution_lifecycles add constraint paid_execution_lifecycles_authorization_hash_check
      check (authorization_hash is null or authorization_hash ~ '^0x[0-9a-fA-F]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'paid_execution_lifecycles_environment_check') then
    alter table public.paid_execution_lifecycles add constraint paid_execution_lifecycles_environment_check
      check (environment is null or environment in ('staging', 'production'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'paid_execution_lifecycles_fee_status_check') then
    alter table public.paid_execution_lifecycles add constraint paid_execution_lifecycles_fee_status_check
      check (fee_status in ('ACCEPTED', 'SETTLING', 'SETTLED', 'SETTLEMENT_UNKNOWN', 'SETTLEMENT_REJECTED', 'MANUAL_REVIEW'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'paid_execution_lifecycles_execution_status_check') then
    alter table public.paid_execution_lifecycles add constraint paid_execution_lifecycles_execution_status_check
      check (execution_status in ('NOT_QUEUED', 'QUEUED', 'TX_PREPARED', 'BROADCAST_UNKNOWN', 'BROADCASTED', 'CONFIRMED', 'REVERTED', 'EXPIRED_UNBROADCAST', 'MANUAL_REVIEW'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'paid_execution_lifecycles_refund_status_check') then
    alter table public.paid_execution_lifecycles add constraint paid_execution_lifecycles_refund_status_check
      check (refund_status in ('NOT_REQUIRED', 'REQUIRED', 'PROCESSING', 'UNKNOWN', 'REFUNDED', 'MANUAL_REVIEW'));
  end if;
end $$;

create unique index if not exists paid_execution_lifecycles_payment_intent_idx
  on public.paid_execution_lifecycles (tenant_id, payment_intent_id);
create unique index if not exists paid_execution_lifecycles_authorization_idx
  on public.paid_execution_lifecycles (tenant_id, authorization_hash)
  where authorization_hash is not null;
create unique index if not exists paid_execution_lifecycles_payment_identifier_idx
  on public.paid_execution_lifecycles (tenant_id, payment_identifier)
  where payment_identifier is not null;
create unique index if not exists paid_execution_lifecycles_payment_payload_idx
  on public.paid_execution_lifecycles (tenant_id, payment_payload_hash)
  where payment_identifier is null;
create unique index if not exists paid_execution_lifecycles_tenant_id_idx
  on public.paid_execution_lifecycles (tenant_id, id);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'paid_execution_lifecycles_tenant_id_unique') then
    alter table public.paid_execution_lifecycles add constraint paid_execution_lifecycles_tenant_id_unique unique (tenant_id, id);
  end if;
end $$;

create table if not exists public.asp_payment_challenges (
  id uuid primary key,
  tenant_id uuid not null,
  environment text not null check (environment in ('staging', 'production')),
  payment_intent_id text not null,
  owner_address text not null check (owner_address ~ '^0x[0-9a-fA-F]{40}$'),
  account_address text not null check (account_address ~ '^0x[0-9a-fA-F]{40}$'),
  request_hash text not null check (request_hash ~ '^[a-fA-F0-9]{64}$'),
  arguments_hash text not null check (arguments_hash ~ '^[a-fA-F0-9]{64}$'),
  authorization_hash text not null check (authorization_hash ~ '^0x[0-9a-fA-F]{64}$'),
  fee_terms_hash text not null check (fee_terms_hash ~ '^[a-fA-F0-9]{64}$'),
  payment_requirements_hash text not null check (payment_requirements_hash ~ '^[a-fA-F0-9]{64}$'),
  status text not null default 'OFFERED' check (status in ('OFFERED', 'CONSUMED', 'EXPIRED')),
  offered_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > offered_at),
  check ((status = 'OFFERED' and consumed_at is null) or (status = 'CONSUMED' and consumed_at is not null) or status = 'EXPIRED'),
  foreign key (tenant_id, payment_intent_id)
    references public.payment_intents (tenant_id, id)
    on delete restrict,
  foreign key (tenant_id, owner_address, account_address)
    references public.agent_wallets (tenant_id, owner_address, account_address)
    on delete restrict
);

create unique index if not exists asp_payment_challenges_binding_idx
  on public.asp_payment_challenges (tenant_id, request_hash, authorization_hash, fee_terms_hash);
create index if not exists asp_payment_challenges_expiry_idx
  on public.asp_payment_challenges (tenant_id, status, expires_at);
create index if not exists asp_payment_challenges_intent_idx
  on public.asp_payment_challenges (tenant_id, payment_intent_id, offered_at desc);

create table if not exists public.invoice_execution_outbox (
  id uuid primary key,
  tenant_id uuid not null,
  lifecycle_id uuid not null,
  payment_intent_id text not null,
  status text not null default 'NOT_QUEUED'
    check (status in ('NOT_QUEUED', 'QUEUED', 'TX_PREPARED', 'BROADCAST_UNKNOWN', 'BROADCASTED', 'CONFIRMED', 'REVERTED', 'EXPIRED_UNBROADCAST', 'MANUAL_REVIEW')),
  chain_id integer not null check (chain_id in (196, 1952)),
  executor_address text not null check (executor_address ~ '^0x[0-9a-fA-F]{40}$'),
  executor_nonce bigint,
  transaction_hash text check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  calldata_hash text check (calldata_hash is null or calldata_hash ~ '^0x[0-9a-fA-F]{64}$'),
  owner_authorization_nonce text,
  raw_tx_ciphertext text,
  raw_tx_iv text,
  raw_tx_tag text,
  raw_tx_hash text check (raw_tx_hash is null or raw_tx_hash ~ '^[a-fA-F0-9]{64}$'),
  lease_until timestamptz,
  fencing_token uuid,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  broadcast_at timestamptz,
  confirmed_at timestamptz,
  receipt_status integer check (receipt_status is null or receipt_status in (0, 1)),
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, lifecycle_id),
  unique (transaction_hash),
  unique (chain_id, executor_address, executor_nonce),
  foreign key (tenant_id, lifecycle_id)
    references public.paid_execution_lifecycles (tenant_id, id)
    on delete restrict,
  foreign key (tenant_id, payment_intent_id)
    references public.payment_intents (tenant_id, id)
    on delete restrict,
  check ((status in ('TX_PREPARED', 'BROADCAST_UNKNOWN', 'BROADCASTED', 'CONFIRMED', 'REVERTED') and transaction_hash is not null) or status in ('NOT_QUEUED', 'QUEUED', 'EXPIRED_UNBROADCAST', 'MANUAL_REVIEW')),
  check ((status in ('TX_PREPARED', 'BROADCAST_UNKNOWN', 'BROADCASTED') and raw_tx_ciphertext is not null and raw_tx_iv is not null and raw_tx_tag is not null) or status not in ('TX_PREPARED', 'BROADCAST_UNKNOWN', 'BROADCASTED'))
);

create index if not exists invoice_execution_outbox_work_idx
  on public.invoice_execution_outbox (chain_id, executor_address, status, lease_until, updated_at);
create index if not exists invoice_execution_outbox_intent_idx
  on public.invoice_execution_outbox (tenant_id, payment_intent_id, updated_at desc);

drop trigger if exists set_invoice_execution_outbox_updated_at on public.invoice_execution_outbox;
create trigger set_invoice_execution_outbox_updated_at
before update on public.invoice_execution_outbox
for each row
execute function public.set_current_timestamp_updated_at();

alter table public.asp_payment_challenges enable row level security;
alter table public.invoice_execution_outbox enable row level security;
revoke all on table public.asp_payment_challenges, public.invoice_execution_outbox from public, anon, authenticated;
grant select, insert, update on table public.asp_payment_challenges, public.invoice_execution_outbox to service_role;

notify pgrst, 'reload schema';

commit;
