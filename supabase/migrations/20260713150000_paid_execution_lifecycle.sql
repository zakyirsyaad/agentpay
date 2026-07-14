-- I-004-A: bind a paid MCP request to one intent/argument/payment tuple.
-- This ledger is intentionally separate from payment_intents: the ASP fee
-- settlement and the AgentPay invoice execution have independent states.

begin;

create table if not exists public.paid_execution_lifecycles (
  id uuid primary key,
  tenant_id uuid not null,
  idempotency_key text not null,
  payment_identifier text,
  payment_payload_hash text not null check (payment_payload_hash ~ '^[a-fA-F0-9]{64}$'),
  payment_requirements_hash text not null check (payment_requirements_hash ~ '^[a-fA-F0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-fA-F0-9]{64}$'),
  tool_name text not null check (tool_name = 'execute_payment'),
  payment_intent_id text not null,
  arguments_hash text not null check (arguments_hash ~ '^[a-fA-F0-9]{64}$'),
  authorization_hash text check (authorization_hash is null or authorization_hash ~ '^0x[0-9a-fA-F]{64}$'),
  challenge_id uuid,
  environment text check (environment is null or environment in ('staging', 'production')),
  payer text check (payer is null or payer ~ '^0x[0-9a-fA-F]{40}$'),
  status text not null default 'CLAIMED'
    check (status in ('CLAIMED', 'SETTLING', 'SETTLED', 'EXECUTING', 'COMPLETED', 'FAILED')),
  fee_status text not null default 'ACCEPTED'
    check (fee_status in ('ACCEPTED', 'SETTLING', 'SETTLED', 'SETTLEMENT_UNKNOWN', 'SETTLEMENT_REJECTED', 'MANUAL_REVIEW')),
  execution_status text not null default 'NOT_QUEUED'
    check (execution_status in ('NOT_QUEUED', 'QUEUED', 'TX_PREPARED', 'BROADCAST_UNKNOWN', 'BROADCASTED', 'CONFIRMED', 'REVERTED', 'EXPIRED_UNBROADCAST', 'MANUAL_REVIEW')),
  refund_status text not null default 'NOT_REQUIRED'
    check (refund_status in ('NOT_REQUIRED', 'REQUIRED', 'PROCESSING', 'UNKNOWN', 'REFUNDED', 'MANUAL_REVIEW')),
  settlement_tx_hash text check (settlement_tx_hash is null or settlement_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  settlement_headers jsonb,
  response_status integer check (response_status is null or response_status between 200 and 599),
  response_headers jsonb,
  response_body_base64 text,
  execution_tx_hash text check (execution_tx_hash is null or execution_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz,
  completed_at timestamptz,
  unique (tenant_id, idempotency_key),
  unique (tenant_id, payment_intent_id),
  foreign key (tenant_id, payment_intent_id)
    references public.payment_intents (tenant_id, id)
    on delete restrict,
  check (payment_identifier is null or payment_identifier ~ '^[A-Za-z0-9_-]{16,128}$'),
  check ((fee_status = 'SETTLED' and settlement_tx_hash is not null) or fee_status <> 'SETTLED'),
  check ((status = 'COMPLETED' and response_status is not null and response_body_base64 is not null) or status <> 'COMPLETED')
);

create unique index if not exists paid_execution_lifecycles_authorization_idx
  on public.paid_execution_lifecycles (tenant_id, authorization_hash)
  where authorization_hash is not null;

create unique index if not exists paid_execution_lifecycles_payment_identifier_idx
  on public.paid_execution_lifecycles (tenant_id, payment_identifier)
  where payment_identifier is not null;

create unique index if not exists paid_execution_lifecycles_payment_payload_idx
  on public.paid_execution_lifecycles (tenant_id, payment_payload_hash)
  where payment_identifier is null;

create index if not exists paid_execution_lifecycles_tenant_status_idx
  on public.paid_execution_lifecycles (tenant_id, status, updated_at desc);
create index if not exists paid_execution_lifecycles_intent_idx
  on public.paid_execution_lifecycles (tenant_id, payment_intent_id, created_at desc);
create index if not exists paid_execution_lifecycles_identifier_idx
  on public.paid_execution_lifecycles (tenant_id, payment_identifier)
  where payment_identifier is not null;

drop trigger if exists set_paid_execution_lifecycles_updated_at on public.paid_execution_lifecycles;
create trigger set_paid_execution_lifecycles_updated_at
before update on public.paid_execution_lifecycles
for each row
execute function public.set_current_timestamp_updated_at();

alter table public.paid_execution_lifecycles enable row level security;
revoke all on table public.paid_execution_lifecycles from public, anon, authenticated;
grant select, insert, update on table public.paid_execution_lifecycles to service_role;

notify pgrst, 'reload schema';

commit;
