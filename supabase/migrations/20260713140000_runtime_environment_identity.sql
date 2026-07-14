-- I-003-B: one operator-seeded identity for the database/runtime boundary.
-- This migration deliberately does not insert a row. Each database must be
-- seeded out-of-band with its own exact environment identity before readiness
-- can become true. Runtime service_role access is read-only.

begin;

create table if not exists public.runtime_environment_identity (
  id smallint primary key default 1 check (id = 1),
  environment text not null check (environment in ('staging', 'production')),
  chain_id integer not null check (chain_id in (196, 1952)),
  caip2 text not null check (caip2 in ('eip155:196', 'eip155:1952')),
  supabase_project_ref text not null check (supabase_project_ref ~ '^[a-z0-9]{20}$'),
  migration_head text not null,
  release_commit text check (release_commit is null or release_commit ~ '^[a-fA-F0-9]{40}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-fA-F0-9]{64}$'),
  account_version text not null check (account_version = 'v2'),
  account_address text check (account_address is null or account_address ~ '^0x[0-9a-fA-F]{40}$'),
  deployment_tx_hash text check (deployment_tx_hash is null or deployment_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  creation_bytecode_hash text not null check (creation_bytecode_hash ~ '^0x[0-9a-fA-F]{64}$'),
  runtime_bytecode_hash text check (runtime_bytecode_hash is null or runtime_bytecode_hash ~ '^0x[0-9a-fA-F]{64}$'),
  abi_sha256 text check (abi_sha256 is null or abi_sha256 ~ '^[a-fA-F0-9]{64}$'),
  owner_address text check (owner_address is null or owner_address ~ '^0x[0-9a-fA-F]{40}$'),
  executor_address text check (executor_address is null or executor_address ~ '^0x[0-9a-fA-F]{40}$'),
  deployer_address text check (deployer_address is null or deployer_address ~ '^0x[0-9a-fA-F]{40}$'),
  eip712_name text not null default 'AgentPay',
  eip712_version text not null default '1',
  eip712_chain_id integer not null check (eip712_chain_id in (196, 1952)),
  eip712_verifying_contract text check (eip712_verifying_contract is null or eip712_verifying_contract ~ '^0x[0-9a-fA-F]{40}$'),
  token_address text not null check (token_address ~ '^0x[0-9a-fA-F]{40}$'),
  token_code_hash text not null check (token_code_hash ~ '^0x[0-9a-fA-F]{64}$'),
  token_decimals integer not null check (token_decimals = 6),
  x402_network text not null check (x402_network in ('eip155:196', 'eip155:1952')),
  x402_asset text not null check (x402_asset ~ '^0x[0-9a-fA-F]{40}$'),
  x402_price text not null,
  x402_price_atomic text not null,
  x402_sync_settle boolean not null,
  x402_enabled boolean not null default false,
  pay_to_address text check (pay_to_address is null or pay_to_address ~ '^0x[0-9a-fA-F]{40}$'),
  facilitator_ref text,
  public_origin text,
  execution_mode text not null check (execution_mode in ('OFF', 'CANARY', 'PUBLIC', 'DRAIN')),
  status text not null check (status in ('SHADOW_ONLY', 'DEPLOYED', 'READY', 'DRAINING')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (owner_address is null or executor_address is null or lower(owner_address) <> lower(executor_address)),
  check (executor_address is null or deployer_address is null or lower(executor_address) <> lower(deployer_address)),
  check ((chain_id = 196 and caip2 = 'eip155:196') or (chain_id = 1952 and caip2 = 'eip155:1952')),
  check (eip712_chain_id = chain_id),
  check (x402_network = caip2)
);

alter table public.runtime_environment_identity enable row level security;
revoke all on table public.runtime_environment_identity from public, anon, authenticated, service_role;
grant select on table public.runtime_environment_identity to service_role;
revoke insert, update, delete, truncate, references, trigger on table public.runtime_environment_identity from service_role;

notify pgrst, 'reload schema';

commit;
