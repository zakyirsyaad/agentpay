-- I-001: tenant isolation, SIWE challenges, and opaque consumer sessions.
-- This migration is intended for the fresh staging/mainnet databases. Existing
-- rows are assigned to an archived legacy tenant and remain inaccessible to
-- consumer sessions until an owner-driven migration explicitly rebinds them.

begin;

create table if not exists public.tenants (
  id uuid primary key default extensions.gen_random_uuid(),
  environment text not null check (environment in ('staging', 'production', 'legacy')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  auth_epoch bigint not null default 0 check (auth_epoch >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.verified_owner_identities (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  owner_address text not null check (owner_address ~ '^0x[0-9a-fA-F]{40}$'),
  status text not null default 'VERIFIED' check (status in ('VERIFIED', 'REVOKED', 'QUARANTINED')),
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (tenant_id, owner_address),
  unique (owner_address)
);

create table if not exists public.auth_challenges (
  id text primary key,
  tenant_id uuid references public.tenants(id) on delete restrict,
  request_id text not null unique,
  domain text not null,
  uri text not null,
  owner_address text not null check (owner_address ~ '^0x[0-9a-fA-F]{40}$'),
  account_address text not null check (account_address ~ '^0x[0-9a-fA-F]{40}$'),
  chain_id integer not null check (chain_id in (196, 1952)),
  nonce text not null unique,
  scopes text[] not null check (cardinality(scopes) > 0),
  message text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > issued_at),
  check (consumed_at is null or consumed_at >= issued_at)
);

create table if not exists public.service_sessions (
  id text primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  owner_address text not null check (owner_address ~ '^0x[0-9a-fA-F]{40}$'),
  account_address text not null check (account_address ~ '^0x[0-9a-fA-F]{40}$'),
  home_chain_id integer not null check (home_chain_id in (196, 1952)),
  audience text not null,
  environment text not null check (environment in ('staging', 'production')),
  scopes text[] not null check (cardinality(scopes) > 0),
  authentication_epoch bigint not null check (authentication_epoch >= 0),
  credential_digest text not null unique check (credential_digest ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  last_used_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > issued_at),
  foreign key (tenant_id, owner_address)
    references public.verified_owner_identities (tenant_id, owner_address)
    on delete restrict
);

create table if not exists public.legacy_migration_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  source_table text not null,
  source_id text not null,
  classification text not null check (classification in ('MIGRATED', 'ARCHIVED', 'CANCELLED', 'QUARANTINED')),
  reason text not null,
  tenant_id uuid references public.tenants(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (source_table, source_id)
);

insert into public.tenants (id, environment, status, auth_epoch)
values ('00000000-0000-0000-0000-000000000001', 'legacy', 'ARCHIVED', 0)
on conflict (id) do nothing;

alter table public.setup_intents add column if not exists tenant_id uuid;
alter table public.agent_wallets add column if not exists tenant_id uuid;
alter table public.payment_intents add column if not exists tenant_id uuid;
alter table public.payment_events add column if not exists tenant_id uuid;

-- Release the legacy single-column identity constraints before changing the
-- referenced address values. They are replaced by tenant-scoped constraints
-- later in this same transaction.
alter table public.payment_intents
  drop constraint if exists payment_intents_account_address_fkey;
alter table public.agent_wallets
  drop constraint if exists agent_wallets_account_address_fkey;
alter table public.agent_wallets
  drop constraint if exists agent_wallets_account_address_key;
alter table public.payment_intents
  drop constraint if exists payment_intents_account_address_nonce_key;

-- EVM addresses are compared case-insensitively at the application boundary;
-- normalize persisted owner/account identities before unique constraints are added.
update public.setup_intents
set owner_address = lower(owner_address),
    account_address = lower(account_address)
where owner_address is not null or account_address is not null;

update public.agent_wallets
set owner_address = lower(owner_address),
    account_address = lower(account_address),
    executor_address = lower(executor_address);

update public.payment_intents
set owner_address = lower(owner_address),
    account_address = lower(account_address);

update public.setup_intents
set tenant_id = '00000000-0000-0000-0000-000000000001'
where tenant_id is null;

update public.agent_wallets
set tenant_id = '00000000-0000-0000-0000-000000000001'
where tenant_id is null;

update public.payment_intents
set tenant_id = '00000000-0000-0000-0000-000000000001'
where tenant_id is null;

update public.payment_events events
set tenant_id = intents.tenant_id
from public.payment_intents intents
where events.payment_intent_id = intents.id
  and events.tenant_id is null;

update public.payment_events
set tenant_id = '00000000-0000-0000-0000-000000000001'
where tenant_id is null;

-- Legacy capabilities are retained for audit but made non-executable before
-- any consumer or public runtime can observe the migrated rows.
update public.setup_intents
set status = 'EXPIRED',
    error_code = 'LEGACY_MIGRATION',
    error_message = 'Legacy setup intent requires a fresh owner-driven setup.'
where tenant_id = '00000000-0000-0000-0000-000000000001'
  and status in ('PENDING', 'SIGNED', 'DEPLOYING');

update public.agent_wallets
set status = 'CLOSED',
    updated_at = now()
where tenant_id = '00000000-0000-0000-0000-000000000001'
  and status = 'ACTIVE';

update public.payment_intents
set status = 'CANCELLED',
    error_code = 'LEGACY_MIGRATION',
    error_message = 'Legacy phrase-based intent cannot execute in the tenant-aware runtime.'
where tenant_id = '00000000-0000-0000-0000-000000000001'
  and status in ('AWAITING_APPROVAL', 'APPROVED');

insert into public.legacy_migration_audit (source_table, source_id, classification, reason, tenant_id)
select 'setup_intents', id, 'QUARANTINED', 'Legacy setup intent requires fresh owner verification.', tenant_id
from public.setup_intents
where tenant_id = '00000000-0000-0000-0000-000000000001'
on conflict (source_table, source_id) do nothing;

insert into public.legacy_migration_audit (source_table, source_id, classification, reason, tenant_id)
select 'agent_wallets', id::text, 'QUARANTINED', 'Legacy wallet requires owner-driven account migration.', tenant_id
from public.agent_wallets
where tenant_id = '00000000-0000-0000-0000-000000000001'
on conflict (source_table, source_id) do nothing;

insert into public.legacy_migration_audit (source_table, source_id, classification, reason, tenant_id)
select 'payment_intents', id,
  case
    when status in ('AWAITING_APPROVAL', 'APPROVED')
      or (status = 'CANCELLED' and error_code = 'LEGACY_MIGRATION')
      then 'CANCELLED'
    else 'QUARANTINED'
  end,
  'Legacy phrase-based intent cannot execute in the tenant-aware runtime.', tenant_id
from public.payment_intents
where tenant_id = '00000000-0000-0000-0000-000000000001'
on conflict (source_table, source_id) do nothing;

insert into public.legacy_migration_audit (source_table, source_id, classification, reason, tenant_id)
select 'payment_events', id::text, 'QUARANTINED', 'Legacy event is retained for audit only.', tenant_id
from public.payment_events
where tenant_id = '00000000-0000-0000-0000-000000000001'
on conflict (source_table, source_id) do nothing;

insert into public.verified_owner_identities (tenant_id, owner_address, status, verified_at)
select distinct tenant_id, owner_address, 'QUARANTINED', now()
from public.agent_wallets
where tenant_id is not null
on conflict (tenant_id, owner_address) do nothing;

alter table public.setup_intents
  add constraint setup_intents_tenant_id_fkey
  foreign key (tenant_id) references public.tenants(id) on delete restrict;

alter table public.agent_wallets
  alter column tenant_id set not null;
alter table public.agent_wallets
  add constraint agent_wallets_tenant_id_fkey
  foreign key (tenant_id) references public.tenants(id) on delete restrict;

alter table public.agent_wallets
  add constraint agent_wallets_tenant_account_unique unique (tenant_id, account_address);
alter table public.agent_wallets
  add constraint agent_wallets_tenant_chain_unique unique (tenant_id, home_chain_id, account_address);
alter table public.agent_wallets
  add constraint agent_wallets_tenant_owner_chain_unique unique (tenant_id, owner_address, home_chain_id);
alter table public.agent_wallets
  add constraint agent_wallets_tenant_owner_account_unique unique (tenant_id, owner_address, account_address);
alter table public.agent_wallets
  add constraint agent_wallets_owner_identity_fkey
  foreign key (tenant_id, owner_address)
  references public.verified_owner_identities (tenant_id, owner_address)
  on delete restrict;

alter table public.payment_intents
  alter column tenant_id set not null;
alter table public.payment_intents
  add constraint payment_intents_tenant_id_fkey
  foreign key (tenant_id) references public.tenants(id) on delete restrict;
alter table public.payment_intents
  add constraint payment_intents_tenant_id_id_unique unique (tenant_id, id);
alter table public.payment_intents
  add constraint payment_intents_tenant_account_nonce_unique unique (tenant_id, account_address, nonce);
alter table public.payment_intents
  add constraint payment_intents_tenant_account_fkey
  foreign key (tenant_id, account_address)
  references public.agent_wallets (tenant_id, account_address)
  on delete restrict;
alter table public.payment_intents
  add constraint payment_intents_tenant_owner_account_fkey
  foreign key (tenant_id, owner_address, account_address)
  references public.agent_wallets (tenant_id, owner_address, account_address)
  on delete restrict;

alter table public.payment_events
  alter column tenant_id set not null;
alter table public.payment_events
  add constraint payment_events_tenant_id_fkey
  foreign key (tenant_id) references public.tenants(id) on delete restrict;
alter table public.payment_events
  add constraint payment_events_tenant_intent_fkey
  foreign key (tenant_id, payment_intent_id)
  references public.payment_intents (tenant_id, id)
  on delete cascade;

alter table public.service_sessions
  add constraint service_sessions_tenant_account_fkey
  foreign key (tenant_id, account_address)
  references public.agent_wallets (tenant_id, account_address)
  on delete restrict;
alter table public.service_sessions
  add constraint service_sessions_tenant_owner_account_fkey
  foreign key (tenant_id, owner_address, account_address)
  references public.agent_wallets (tenant_id, owner_address, account_address)
  on delete restrict;

create index if not exists verified_owner_identities_owner_status_idx
  on public.verified_owner_identities (owner_address, status);
create index if not exists auth_challenges_expiry_idx
  on public.auth_challenges (expires_at, consumed_at);
create index if not exists auth_challenges_tenant_idx
  on public.auth_challenges (tenant_id, created_at desc);
create index if not exists service_sessions_tenant_active_idx
  on public.service_sessions (tenant_id, expires_at, revoked_at);
create index if not exists service_sessions_digest_idx
  on public.service_sessions (credential_digest);
create index if not exists agent_wallets_tenant_status_chain_idx
  on public.agent_wallets (tenant_id, status, home_chain_id, created_at desc);
create index if not exists payment_intents_tenant_status_created_idx
  on public.payment_intents (tenant_id, status, created_at desc);
create index if not exists payment_events_tenant_intent_created_idx
  on public.payment_events (tenant_id, payment_intent_id, created_at desc);

alter table public.tenants enable row level security;
alter table public.verified_owner_identities enable row level security;
alter table public.auth_challenges enable row level security;
alter table public.service_sessions enable row level security;
alter table public.legacy_migration_audit enable row level security;

revoke all on table public.tenants from anon, authenticated;
revoke all on table public.verified_owner_identities from anon, authenticated;
revoke all on table public.auth_challenges from anon, authenticated;
revoke all on table public.service_sessions from anon, authenticated;
revoke all on table public.legacy_migration_audit from anon, authenticated;

grant select, insert, update, delete on table public.tenants to service_role;
grant select, insert, update, delete on table public.verified_owner_identities to service_role;
grant select, insert, update, delete on table public.auth_challenges to service_role;
grant select, insert, update, delete on table public.service_sessions to service_role;
grant select, insert, update, delete on table public.legacy_migration_audit to service_role;

notify pgrst, 'reload schema';

commit;
