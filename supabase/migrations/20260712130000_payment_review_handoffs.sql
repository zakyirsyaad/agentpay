-- I-002.4: durable Review & Sign capability and owner-signature handoff.
-- Raw review tokens never enter this table; only their keyed digest is stored.

begin;

create table if not exists public.payment_review_handoffs (
  id text primary key,
  tenant_id uuid not null,
  payment_intent_id text not null,
  owner_address text not null check (owner_address ~ '^0x[0-9a-fA-F]{40}$'),
  account_address text not null check (account_address ~ '^0x[0-9a-fA-F]{40}$'),
  source_chain_id integer not null check (source_chain_id in (196, 1952)),
  authorization_hash text not null check (authorization_hash ~ '^0x[0-9a-fA-F]{64}$'),
  token_digest text not null unique check (token_digest ~ '^0x[0-9a-fA-F]{64}$'),
  status text not null default 'PENDING' check (status in ('PENDING', 'SIGNED')),
  signature text check (signature is null or signature ~ '^0x[0-9a-fA-F]{130}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  signed_at timestamptz,
  unique (tenant_id, payment_intent_id),
  check (expires_at > created_at),
  check (
    (status = 'PENDING' and signature is null and signed_at is null)
    or (status = 'SIGNED' and signature is not null and signed_at is not null)
  ),
  foreign key (tenant_id, payment_intent_id)
    references public.payment_intents (tenant_id, id)
    on delete cascade,
  foreign key (tenant_id, owner_address, account_address)
    references public.agent_wallets (tenant_id, owner_address, account_address)
    on delete restrict
);

create or replace function public.record_payment_review_event()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.payment_events (
      tenant_id,
      payment_intent_id,
      event_type,
      message,
      metadata
    ) values (
      new.tenant_id,
      new.payment_intent_id,
      'PAYMENT_REVIEW_OPENED',
      'Review handoff created.',
      jsonb_build_object(
        'authorizationHash', new.authorization_hash,
        'expiresAt', new.expires_at
      )
    );
  elsif tg_op = 'UPDATE' and old.status = 'PENDING' and new.status = 'SIGNED' then
    insert into public.payment_events (
      tenant_id,
      payment_intent_id,
      event_type,
      message,
      metadata
    ) values (
      new.tenant_id,
      new.payment_intent_id,
      'PAYMENT_SIGNATURE_ACCEPTED',
      'Owner payment signature accepted.',
      jsonb_build_object(
        'authorizationHash', new.authorization_hash,
        'signedAt', new.signed_at
      )
    );
  end if;

  return new;
end;
$$;

revoke all on function public.record_payment_review_event() from public, anon, authenticated;
grant execute on function public.record_payment_review_event() to service_role;

drop trigger if exists payment_review_opened_event on public.payment_review_handoffs;
create trigger payment_review_opened_event
  after insert on public.payment_review_handoffs
  for each row execute function public.record_payment_review_event();

drop trigger if exists payment_signature_accepted_event on public.payment_review_handoffs;
create trigger payment_signature_accepted_event
  after update of status on public.payment_review_handoffs
  for each row execute function public.record_payment_review_event();

create index if not exists payment_review_handoffs_token_idx
  on public.payment_review_handoffs (token_digest);

create index if not exists payment_review_handoffs_tenant_status_idx
  on public.payment_review_handoffs (tenant_id, status, expires_at);

alter table public.payment_review_handoffs enable row level security;

revoke all on table public.payment_review_handoffs from anon, authenticated;
grant select, insert, update, delete on table public.payment_review_handoffs to service_role;

notify pgrst, 'reload schema';

commit;
