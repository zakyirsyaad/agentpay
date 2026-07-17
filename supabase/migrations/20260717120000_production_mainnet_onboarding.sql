-- Production-only, RPC-scoped wallet onboarding for X Layer mainnet.
-- This migration provisions the durable lifecycle but does not seed runtime
-- state, enable setup, deploy a factory, or create funded credentials.

begin;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'agentpay_setup_web') then
    create role agentpay_setup_web nologin noinherit;
  else
    alter role agentpay_setup_web nologin noinherit;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'agentpay_setup_worker') then
    create role agentpay_setup_worker nologin noinherit;
  else
    alter role agentpay_setup_worker nologin noinherit;
  end if;
end $$;

-- PostgREST authenticates as this role and SET ROLEs to the JWT role claim.
-- Membership permits that switch without granting either scope implicitly.
grant agentpay_setup_web, agentpay_setup_worker to authenticator;

alter table public.setup_intents
  add column if not exists setup_environment text not null default 'legacy',
  add column if not exists capability_digest text,
  add column if not exists deployment_nonce text,
  add column if not exists manifest_sha256 text,
  add column if not exists factory_address text,
  add column if not exists factory_runtime_code_hash text,
  add column if not exists deployment_salt text,
  add column if not exists predicted_account text,
  add column if not exists account_creation_code_hash text,
  add column if not exists account_runtime_code_hash text,
  add column if not exists authorization_hash text,
  add column if not exists owner_setup_signature text,
  add column if not exists public_error_code text,
  add column if not exists admitted_at timestamptz,
  add column if not exists signed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.setup_intents drop constraint if exists setup_intents_status_check;
alter table public.setup_intents add constraint setup_intents_status_check check (status in (
  'PENDING', 'ADMITTED', 'SIGNING', 'SIGNED', 'BROADCAST', 'BROADCAST_UNKNOWN',
  'CONFIRMING', 'COMPLETED', 'EXPIRED', 'FAILED', 'MANUAL_REVIEW'
));

alter table public.setup_intents drop constraint if exists setup_intents_setup_environment_check;
alter table public.setup_intents add constraint setup_intents_setup_environment_check
  check (setup_environment in ('legacy', 'production'));
alter table public.setup_intents drop constraint if exists setup_intents_production_fields_check;
alter table public.setup_intents add constraint setup_intents_production_fields_check check (
  setup_environment <> 'production' or (
    owner_address is not null
    and home_chain_id = 196
    and capability_digest ~ '^[0-9a-f]{64}$'
    and deployment_nonce ~ '^0x[0-9a-f]{64}$'
    and manifest_sha256 ~ '^0x[0-9a-f]{64}$'
    and factory_address ~ '^0x[0-9a-f]{40}$'
    and factory_runtime_code_hash ~ '^0x[0-9a-f]{64}$'
    and deployment_salt ~ '^0x[0-9a-f]{64}$'
    and predicted_account ~ '^0x[0-9a-f]{40}$'
    and account_creation_code_hash ~ '^0x[0-9a-f]{64}$'
    and account_runtime_code_hash ~ '^0x[0-9a-f]{64}$'
    and authorization_hash ~ '^0x[0-9a-f]{64}$'
    and (owner_setup_signature is null or owner_setup_signature ~ '^0x[0-9a-fA-F]{130}$')
    and (public_error_code is null or public_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
  )
);

create unique index if not exists setup_intents_capability_digest_idx
  on public.setup_intents (capability_digest)
  where capability_digest is not null;
create unique index if not exists setup_intents_deployment_nonce_idx
  on public.setup_intents (deployment_nonce)
  where deployment_nonce is not null;
create unique index if not exists setup_intents_active_owner_chain_idx
  on public.setup_intents (lower(owner_address), home_chain_id)
  where setup_environment = 'production'
    and status in ('PENDING', 'ADMITTED', 'SIGNING', 'SIGNED', 'BROADCAST', 'BROADCAST_UNKNOWN', 'CONFIRMING');

create table if not exists public.setup_runtime_state (
  id smallint primary key check (id = 1),
  environment text not null check (environment = 'production'),
  chain_id integer not null check (chain_id = 196),
  setup_mode text not null check (setup_mode in ('OFF', 'CANARY', 'PUBLIC', 'DRAIN')),
  manifest_sha256 text not null check (manifest_sha256 ~ '^0x[0-9a-f]{64}$'),
  factory_address text not null check (factory_address ~ '^0x[0-9a-f]{40}$'),
  factory_runtime_code_hash text not null check (factory_runtime_code_hash ~ '^0x[0-9a-f]{64}$'),
  executor_address text not null check (executor_address ~ '^0x[0-9a-f]{40}$'),
  sponsor_deployer_address text not null check (sponsor_deployer_address ~ '^0x[0-9a-f]{40}$'),
  max_deployments_per_day integer not null check (max_deployments_per_day > 0),
  max_gas_per_deployment numeric(78, 0) not null check (max_gas_per_deployment > 0),
  max_native_cost_per_day_wei numeric(78, 0) not null check (max_native_cost_per_day_wei > 0),
  max_pending integer not null check (max_pending > 0),
  updated_at timestamptz not null default now(),
  check (factory_address <> executor_address),
  check (factory_address <> sponsor_deployer_address),
  check (executor_address <> sponsor_deployer_address)
);

create table if not exists public.setup_canary_owners (
  owner_address text primary key check (owner_address ~ '^0x[0-9a-f]{40}$'),
  enabled_at timestamptz not null default now(),
  expires_at timestamptz,
  check (expires_at is null or expires_at > enabled_at)
);

create table if not exists public.setup_deployment_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  setup_intent_id text not null references public.setup_intents(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  status text not null default 'QUEUED' check (status in (
    'QUEUED', 'SIGNING', 'SIGNED', 'BROADCAST', 'BROADCAST_UNKNOWN',
    'CONFIRMING', 'COMPLETED', 'FAILED', 'MANUAL_REVIEW'
  )),
  chain_id integer not null check (chain_id = 196),
  deployer_address text check (deployer_address is null or deployer_address ~ '^0x[0-9a-f]{40}$'),
  deployer_nonce numeric(78, 0) check (deployer_nonce is null or deployer_nonce >= 0),
  transaction_hash text check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-f]{64}$'),
  raw_tx_ciphertext text,
  raw_tx_iv text,
  raw_tx_tag text,
  raw_tx_hash text check (raw_tx_hash is null or raw_tx_hash ~ '^[0-9a-f]{64}$'),
  worker_id text,
  fencing_token uuid,
  lease_until timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  receipt_status smallint check (receipt_status is null or receipt_status in (0, 1)),
  receipt_block_number numeric(78, 0) check (receipt_block_number is null or receipt_block_number >= 0),
  broadcast_at timestamptz,
  confirmed_at timestamptz,
  completed_at timestamptz,
  public_error_code text check (public_error_code is null or public_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (setup_intent_id),
  unique (chain_id, deployer_address, deployer_nonce),
  unique (transaction_hash),
  unique (tenant_id, id),
  check ((status in ('SIGNED', 'BROADCAST', 'BROADCAST_UNKNOWN', 'CONFIRMING', 'COMPLETED')
    and transaction_hash is not null and raw_tx_ciphertext is not null and raw_tx_iv is not null
    and raw_tx_tag is not null and raw_tx_hash is not null) or status in ('QUEUED', 'SIGNING', 'FAILED', 'MANUAL_REVIEW'))
);

create table if not exists public.setup_deployment_events (
  id uuid primary key default extensions.gen_random_uuid(),
  setup_intent_id text not null references public.setup_intents(id) on delete restrict,
  job_id uuid references public.setup_deployment_jobs(id) on delete restrict,
  tenant_id uuid references public.tenants(id) on delete restrict,
  event_type text not null check (event_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  public_code text check (public_code is null or public_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (not (metadata ?| array['ownerSetupSignature', 'owner_setup_signature', 'rawTransaction', 'raw_tx']))
);

create table if not exists public.setup_sponsor_budgets (
  id uuid primary key default extensions.gen_random_uuid(),
  job_id uuid not null references public.setup_deployment_jobs(id) on delete restrict,
  day_key date not null,
  chain_id integer not null check (chain_id = 196),
  deployer_address text not null check (deployer_address ~ '^0x[0-9a-f]{40}$'),
  deployer_nonce numeric(78, 0) not null check (deployer_nonce >= 0),
  gas_limit numeric(78, 0) not null check (gas_limit > 0),
  native_cost_wei numeric(78, 0) not null check (native_cost_wei > 0),
  status text not null default 'CHARGED' check (status = 'CHARGED'),
  reserved_at timestamptz not null,
  unique (job_id),
  unique (chain_id, deployer_address, deployer_nonce)
);

create table if not exists public.setup_rate_limit_buckets (
  key_digest text not null check (key_digest ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  expires_at timestamptz not null,
  primary key (key_digest, window_started_at),
  check (expires_at > window_started_at)
);

create index if not exists setup_deployment_jobs_work_idx
  on public.setup_deployment_jobs (status, lease_until, created_at)
  where status in ('QUEUED', 'SIGNING');
create index if not exists setup_deployment_jobs_tenant_idx
  on public.setup_deployment_jobs (tenant_id, status, updated_at desc);
create index if not exists setup_deployment_events_intent_idx
  on public.setup_deployment_events (setup_intent_id, created_at desc);
create index if not exists setup_deployment_events_job_idx
  on public.setup_deployment_events (job_id, created_at desc)
  where job_id is not null;
create index if not exists setup_sponsor_budgets_daily_idx
  on public.setup_sponsor_budgets (chain_id, deployer_address, day_key, status);
create index if not exists setup_rate_limit_buckets_expiry_idx
  on public.setup_rate_limit_buckets (expires_at);

-- Existing agent_wallets_tenant_owner_chain_unique remains the final wallet
-- uniqueness fence after the setup-specific active owner/chain fence above.

create or replace function public.reject_setup_event_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  raise exception using message = 'SETUP_AUDIT_IMMUTABLE: Setup audit rows cannot be modified.';
end;
$$;

create or replace function public.protect_production_setup_binding()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if old.setup_environment = 'production' and (
    new.capability_digest is distinct from old.capability_digest
    or new.owner_address is distinct from old.owner_address
    or new.executor_address is distinct from old.executor_address
    or new.home_chain_id is distinct from old.home_chain_id
    or new.deployment_nonce is distinct from old.deployment_nonce
    or new.manifest_sha256 is distinct from old.manifest_sha256
    or new.factory_address is distinct from old.factory_address
    or new.factory_runtime_code_hash is distinct from old.factory_runtime_code_hash
    or new.deployment_salt is distinct from old.deployment_salt
    or new.predicted_account is distinct from old.predicted_account
    or new.account_creation_code_hash is distinct from old.account_creation_code_hash
    or new.account_runtime_code_hash is distinct from old.account_runtime_code_hash
    or new.authorization_hash is distinct from old.authorization_hash
    or (old.owner_setup_signature is not null and new.owner_setup_signature is distinct from old.owner_setup_signature)
  ) then
    raise exception using message = 'SETUP_BINDING_IMMUTABLE: Signed setup policy fields cannot change.';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists protect_production_setup_binding on public.setup_intents;
create trigger protect_production_setup_binding
before update on public.setup_intents
for each row execute function public.protect_production_setup_binding();

drop trigger if exists reject_setup_deployment_event_update on public.setup_deployment_events;
create trigger reject_setup_deployment_event_update
before update or delete on public.setup_deployment_events
for each row execute function public.reject_setup_event_mutation();

drop trigger if exists reject_setup_sponsor_budget_update on public.setup_sponsor_budgets;
create trigger reject_setup_sponsor_budget_update
before update or delete on public.setup_sponsor_budgets
for each row execute function public.reject_setup_event_mutation();

create or replace function public.create_production_setup_challenge(
  p_setup_intent_id text,
  p_capability_digest text,
  p_owner_address text,
  p_executor_address text,
  p_message_to_sign text,
  p_deployment_nonce text,
  p_manifest_sha256 text,
  p_factory_address text,
  p_factory_runtime_code_hash text,
  p_deployment_salt text,
  p_predicted_account text,
  p_account_creation_code_hash text,
  p_account_runtime_code_hash text,
  p_authorization_hash text,
  p_expires_at timestamptz,
  p_at timestamptz,
  p_rate_limit_key_digest text,
  p_rate_limit_window_seconds integer,
  p_rate_limit_max_requests integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_runtime public.setup_runtime_state%rowtype;
  v_existing public.setup_intents%rowtype;
  v_window timestamptz;
  v_count integer;
  v_created boolean := false;
begin
  if p_setup_intent_id is null or length(p_setup_intent_id) not between 16 and 128
    or p_capability_digest is null or lower(p_capability_digest) !~ '^[0-9a-f]{64}$'
    or p_owner_address is null or lower(p_owner_address) !~ '^0x[0-9a-f]{40}$'
    or p_executor_address is null or lower(p_executor_address) !~ '^0x[0-9a-f]{40}$'
    or lower(p_owner_address) = lower(p_executor_address)
    or p_message_to_sign is null or length(p_message_to_sign) not between 1 and 65536
    or p_deployment_nonce is null or lower(p_deployment_nonce) !~ '^0x[0-9a-f]{64}$'
    or p_manifest_sha256 is null or lower(p_manifest_sha256) !~ '^0x[0-9a-f]{64}$'
    or p_factory_address is null or lower(p_factory_address) !~ '^0x[0-9a-f]{40}$'
    or p_factory_runtime_code_hash is null or lower(p_factory_runtime_code_hash) !~ '^0x[0-9a-f]{64}$'
    or p_deployment_salt is null or lower(p_deployment_salt) !~ '^0x[0-9a-f]{64}$'
    or p_predicted_account is null or lower(p_predicted_account) !~ '^0x[0-9a-f]{40}$'
    or p_account_creation_code_hash is null or lower(p_account_creation_code_hash) !~ '^0x[0-9a-f]{64}$'
    or p_account_runtime_code_hash is null or lower(p_account_runtime_code_hash) !~ '^0x[0-9a-f]{64}$'
    or p_authorization_hash is null or lower(p_authorization_hash) !~ '^0x[0-9a-f]{64}$'
    or p_expires_at is null or p_at is null or p_expires_at <= p_at
    or p_rate_limit_key_digest is null or lower(p_rate_limit_key_digest) !~ '^[0-9a-f]{64}$'
    or p_rate_limit_window_seconds is null or p_rate_limit_window_seconds not between 1 and 3600
    or p_rate_limit_max_requests is null or p_rate_limit_max_requests not between 1 and 10000 then
    raise exception using message = 'SETUP_INPUT_INVALID: Production setup challenge input is invalid.';
  end if;

  select * into v_runtime from public.setup_runtime_state where id = 1 for share;
  if not found or v_runtime.environment <> 'production' or v_runtime.chain_id <> 196 then
    raise exception using message = 'SETUP_RUNTIME_UNAVAILABLE: Production setup runtime is not pinned.';
  end if;
  if v_runtime.setup_mode in ('OFF', 'DRAIN') then
    raise exception using message = 'SETUP_ADMISSION_CLOSED: Production setup is not accepting new challenges.';
  end if;
  if v_runtime.manifest_sha256 <> lower(p_manifest_sha256)
    or v_runtime.factory_address <> lower(p_factory_address)
    or v_runtime.factory_runtime_code_hash <> lower(p_factory_runtime_code_hash)
    or v_runtime.executor_address <> lower(p_executor_address) then
    raise exception using message = 'SETUP_POLICY_MISMATCH: Challenge does not match pinned runtime policy.';
  end if;
  if lower(p_owner_address) in (
    v_runtime.executor_address, v_runtime.factory_address, v_runtime.sponsor_deployer_address
  ) then
    raise exception using message = 'SETUP_ACTOR_COLLISION: Owner, executor, factory, and sponsor deployer must be distinct.';
  end if;
  if v_runtime.setup_mode = 'CANARY' and not exists (
    select 1 from public.setup_canary_owners
    where owner_address = lower(p_owner_address) and (expires_at is null or expires_at > p_at)
  ) then
    raise exception using message = 'SETUP_CANARY_DENIED: Owner is not admitted to the setup canary.';
  end if;

  v_window := to_timestamp(
    floor(extract(epoch from p_at) / p_rate_limit_window_seconds) * p_rate_limit_window_seconds
  );
  perform pg_advisory_xact_lock(hashtextextended('agentpay:setup-rate:' || lower(p_rate_limit_key_digest) || ':' || v_window::text, 0));
  insert into public.setup_rate_limit_buckets (key_digest, window_started_at, request_count, expires_at)
  values (lower(p_rate_limit_key_digest), v_window, 1, v_window + make_interval(secs => p_rate_limit_window_seconds))
  on conflict (key_digest, window_started_at) do update
    set request_count = public.setup_rate_limit_buckets.request_count + 1
  returning request_count into v_count;
  if v_count > p_rate_limit_max_requests then
    raise exception using message = 'SETUP_RATE_LIMITED: Setup challenge rate limit exceeded.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('agentpay:setup-capability:' || lower(p_capability_digest), 0));
  perform pg_advisory_xact_lock(hashtextextended('agentpay:setup-owner:' || lower(p_owner_address), 0));
  if exists (
    select 1 from public.setup_intents
    where setup_environment = 'production' and lower(owner_address) = lower(p_owner_address)
      and home_chain_id = 196
      and status in ('PENDING', 'ADMITTED', 'SIGNING', 'SIGNED', 'BROADCAST', 'BROADCAST_UNKNOWN', 'CONFIRMING')
      and capability_digest <> lower(p_capability_digest)
  ) then
    raise exception using message = 'SETUP_OWNER_BUSY: Owner already has an active production setup.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('agentpay:setup-deployment-nonce:' || lower(p_deployment_nonce), 0));
  if exists (
    select 1 from public.setup_intents
    where deployment_nonce = lower(p_deployment_nonce)
      and capability_digest <> lower(p_capability_digest)
  ) then
    raise exception using message = 'SETUP_DEPLOYMENT_NONCE_CONFLICT: Deployment nonce is already bound.';
  end if;
  insert into public.setup_intents (
    id, owner_address, executor_address, message_to_sign, status, home_chain_id, expires_at,
    setup_environment, capability_digest, deployment_nonce, manifest_sha256, factory_address,
    factory_runtime_code_hash, deployment_salt, predicted_account, account_creation_code_hash,
    account_runtime_code_hash, authorization_hash, created_at, updated_at
  ) values (
    p_setup_intent_id, lower(p_owner_address), lower(p_executor_address), p_message_to_sign, 'PENDING', 196,
    p_expires_at, 'production', lower(p_capability_digest), lower(p_deployment_nonce), lower(p_manifest_sha256),
    lower(p_factory_address), lower(p_factory_runtime_code_hash), lower(p_deployment_salt),
    lower(p_predicted_account), lower(p_account_creation_code_hash), lower(p_account_runtime_code_hash),
    lower(p_authorization_hash), p_at, p_at
  ) on conflict do nothing;
  v_created := found;

  select * into v_existing from public.setup_intents
  where capability_digest = lower(p_capability_digest) for update;
  if not found
    or v_existing.id <> p_setup_intent_id
    or v_existing.owner_address <> lower(p_owner_address)
    or v_existing.executor_address <> lower(p_executor_address)
    or v_existing.deployment_nonce <> lower(p_deployment_nonce)
    or v_existing.manifest_sha256 <> lower(p_manifest_sha256)
    or v_existing.factory_address <> lower(p_factory_address)
    or v_existing.factory_runtime_code_hash <> lower(p_factory_runtime_code_hash)
    or v_existing.deployment_salt <> lower(p_deployment_salt)
    or v_existing.predicted_account <> lower(p_predicted_account)
    or v_existing.account_creation_code_hash <> lower(p_account_creation_code_hash)
    or v_existing.account_runtime_code_hash <> lower(p_account_runtime_code_hash)
    or v_existing.authorization_hash <> lower(p_authorization_hash)
    or v_existing.expires_at <> p_expires_at then
    raise exception using message = 'SETUP_REPLAY_CONFLICT: Capability is bound to different setup terms.';
  end if;

  if v_created then
    insert into public.setup_deployment_events (setup_intent_id, event_type, created_at)
    values (v_existing.id, 'SETUP_CHALLENGE_CREATED', p_at);
  end if;
  return jsonb_build_object(
    'disposition', case when v_created then 'CREATED' else 'REPLAY' end,
    'setupIntentId', v_existing.id,
    'expiresAt', v_existing.expires_at
  );
end;
$$;

create or replace function public.read_production_setup_status(
  p_capability_digest text,
  p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_intent public.setup_intents%rowtype;
  v_job public.setup_deployment_jobs%rowtype;
  v_public_status text;
begin
  if p_capability_digest is null or lower(p_capability_digest) !~ '^[0-9a-f]{64}$' or p_at is null then
    raise exception using message = 'SETUP_INPUT_INVALID: Capability and timestamp are required.';
  end if;
  select * into v_intent from public.setup_intents
  where capability_digest = lower(p_capability_digest) and setup_environment = 'production';
  if not found then
    raise exception using message = 'SETUP_NOT_FOUND: Setup capability was not found.';
  end if;
  select * into v_job from public.setup_deployment_jobs where setup_intent_id = v_intent.id;
  v_public_status := case
    when v_intent.status in ('PENDING', 'ADMITTED') then 'SETUP_PENDING'
    when v_intent.status in ('SIGNING', 'SIGNED', 'BROADCAST', 'BROADCAST_UNKNOWN', 'CONFIRMING') then 'SETUP_DEPLOYING'
    when v_intent.status = 'COMPLETED' then 'SETUP_COMPLETED'
    when v_intent.status = 'EXPIRED' or (v_intent.status = 'PENDING' and v_intent.expires_at <= p_at) then 'SETUP_EXPIRED'
    when v_intent.status = 'MANUAL_REVIEW' then 'SETUP_MANUAL_REVIEW'
    else 'SETUP_FAILED'
  end;
  return jsonb_strip_nulls(jsonb_build_object(
    'setupIntentId', v_intent.id,
    'status', v_public_status,
    'predictedAccount', v_intent.predicted_account,
    'transactionHash', v_job.transaction_hash,
    'publicCode', coalesce(v_job.public_error_code, v_intent.public_error_code),
    'createdAt', v_intent.created_at,
    'updatedAt', v_intent.updated_at,
    'completedAt', v_intent.completed_at
  ));
end;
$$;

create or replace function public.consume_production_setup_admission(
  p_capability_digest text,
  p_owner_setup_signature text,
  p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_intent public.setup_intents%rowtype;
  v_job public.setup_deployment_jobs%rowtype;
  v_tenant_id uuid;
  v_bound_tenant uuid;
begin
  if p_capability_digest is null or lower(p_capability_digest) !~ '^[0-9a-f]{64}$'
    or p_owner_setup_signature is null or lower(p_owner_setup_signature) !~ '^0x[0-9a-f]{130}$'
    or p_at is null then
    raise exception using message = 'SETUP_INPUT_INVALID: Admission input is invalid.';
  end if;

  select * into v_intent from public.setup_intents
  where capability_digest = lower(p_capability_digest) and setup_environment = 'production'
  for update;
  if not found then
    raise exception using message = 'SETUP_NOT_FOUND: Setup capability was not found.';
  end if;
  if v_intent.status <> 'PENDING' then
    if v_intent.owner_setup_signature = lower(p_owner_setup_signature) and v_intent.status in (
      'ADMITTED', 'SIGNING', 'SIGNED', 'BROADCAST', 'BROADCAST_UNKNOWN', 'CONFIRMING', 'COMPLETED'
    ) then
      select * into v_job from public.setup_deployment_jobs where setup_intent_id = v_intent.id;
      return jsonb_build_object('disposition', 'REPLAY', 'setupIntentId', v_intent.id, 'jobId', v_job.id);
    end if;
    raise exception using message = 'SETUP_STATE_CONFLICT: Setup cannot be admitted from its current state.';
  end if;
  if v_intent.expires_at <= p_at then
    update public.setup_intents set status = 'EXPIRED', public_error_code = 'SETUP_EXPIRED' where id = v_intent.id;
    raise exception using message = 'SETUP_EXPIRED: Setup authorization deadline has expired.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('agentpay:setup-owner:' || v_intent.owner_address, 0));
  select tenant_id into v_bound_tenant from public.verified_owner_identities
  where lower(owner_address) = v_intent.owner_address and status = 'VERIFIED'
  order by verified_at desc limit 1 for update;
  if found then
    raise exception using message = 'SETUP_OWNER_ALREADY_BOUND: Owner already has a verified production tenant.';
  end if;

  v_tenant_id := extensions.gen_random_uuid();
  insert into public.tenants (id, environment, status, auth_epoch, created_at, updated_at)
  values (v_tenant_id, 'production', 'ACTIVE', 0, p_at, p_at);
  insert into public.verified_owner_identities (tenant_id, owner_address, status, verified_at, created_at)
  values (v_tenant_id, v_intent.owner_address, 'VERIFIED', p_at, p_at);

  update public.setup_intents
  set tenant_id = v_tenant_id, owner_setup_signature = lower(p_owner_setup_signature), status = 'ADMITTED', admitted_at = p_at
  where id = v_intent.id and status = 'PENDING';
  if not found then
    raise exception using message = 'SETUP_STATE_CONFLICT: Setup admission lost its compare-and-set fence.';
  end if;

  insert into public.setup_deployment_jobs (setup_intent_id, tenant_id, status, chain_id, created_at, updated_at)
  values (v_intent.id, v_tenant_id, 'QUEUED', 196, p_at, p_at)
  returning * into v_job;
  insert into public.setup_deployment_events (setup_intent_id, job_id, tenant_id, event_type, created_at)
  values (v_intent.id, v_job.id, v_tenant_id, 'SETUP_ADMITTED', p_at);

  return jsonb_build_object('disposition', 'ADMITTED', 'setupIntentId', v_intent.id, 'jobId', v_job.id);
end;
$$;

create or replace function public.claim_setup_deployment_job(
  p_worker_id text,
  p_at timestamptz,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_job public.setup_deployment_jobs%rowtype;
  v_intent public.setup_intents%rowtype;
begin
  if p_worker_id is null or length(p_worker_id) not between 1 and 128
    or p_worker_id !~ '^[A-Za-z0-9:_-]+$'
    or p_at is null or p_lease_seconds is null or p_lease_seconds not between 15 and 900 then
    raise exception using message = 'SETUP_INPUT_INVALID: Worker claim input is invalid.';
  end if;

  select * into v_job from public.setup_deployment_jobs
  where status = 'QUEUED'
     or (status = 'SIGNING' and lease_until <= p_at)
  order by created_at, id
  limit 1
  for update skip locked;
  if not found then
    return null;
  end if;

  select * into v_intent from public.setup_intents where id = v_job.setup_intent_id for update;
  if v_intent.expires_at <= p_at then
    update public.setup_deployment_jobs
    set status = 'FAILED', public_error_code = 'SETUP_EXPIRED', updated_at = p_at
    where id = v_job.id;
    update public.setup_intents
    set status = 'EXPIRED', public_error_code = 'SETUP_EXPIRED'
    where id = v_intent.id;
    insert into public.setup_deployment_events (
      setup_intent_id, job_id, tenant_id, event_type, public_code, created_at
    ) values (v_intent.id, v_job.id, v_job.tenant_id, 'SETUP_EXPIRED', 'SETUP_EXPIRED', p_at);
    return null;
  end if;

  update public.setup_deployment_jobs
  set status = 'SIGNING', worker_id = p_worker_id, fencing_token = extensions.gen_random_uuid(),
      lease_until = p_at + make_interval(secs => p_lease_seconds),
      attempt_count = attempt_count + 1, updated_at = p_at
  where id = v_job.id and (status = 'QUEUED' or (status = 'SIGNING' and lease_until <= p_at))
  returning * into v_job;
  if not found then
    return null;
  end if;
  update public.setup_intents set status = 'SIGNING' where id = v_intent.id and status in ('ADMITTED', 'SIGNING');
  if not found then
    raise exception using message = 'SETUP_STATE_CONFLICT: Setup intent cannot enter signing.';
  end if;
  insert into public.setup_deployment_events (setup_intent_id, job_id, tenant_id, event_type, created_at)
  values (v_intent.id, v_job.id, v_job.tenant_id, 'SETUP_JOB_CLAIMED', p_at);

  return jsonb_build_object(
    'disposition', 'CLAIMED',
    'jobId', v_job.id,
    'setupIntentId', v_intent.id,
    'tenantId', v_job.tenant_id,
    'fencingToken', v_job.fencing_token,
    'leaseUntil', v_job.lease_until,
    'ownerSetupSignature', v_intent.owner_setup_signature,
    'ownerAddress', v_intent.owner_address,
    'executorAddress', v_intent.executor_address,
    'homeChainId', v_intent.home_chain_id,
    'deploymentNonce', v_intent.deployment_nonce,
    'manifestSha256', v_intent.manifest_sha256,
    'factoryAddress', v_intent.factory_address,
    'factoryRuntimeCodeHash', v_intent.factory_runtime_code_hash,
    'deploymentSalt', v_intent.deployment_salt,
    'predictedAccount', v_intent.predicted_account,
    'accountCreationCodeHash', v_intent.account_creation_code_hash,
    'accountRuntimeCodeHash', v_intent.account_runtime_code_hash,
    'authorizationHash', v_intent.authorization_hash,
    'expiresAt', v_intent.expires_at
  );
end;
$$;

create or replace function public.reserve_setup_sponsor_budget(
  p_job_id uuid,
  p_fencing_token uuid,
  p_deployer_address text,
  p_deployer_nonce numeric,
  p_gas_limit numeric,
  p_native_cost_wei numeric,
  p_at timestamptz,
  p_max_deployments_per_day integer,
  p_max_gas_per_deployment numeric,
  p_max_native_cost_per_day_wei numeric,
  p_max_pending integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_job public.setup_deployment_jobs%rowtype;
  v_existing public.setup_sponsor_budgets%rowtype;
  v_runtime public.setup_runtime_state%rowtype;
  v_day date;
  v_deployments bigint;
  v_daily_cost numeric;
  v_pending bigint;
begin
  if p_job_id is null or p_fencing_token is null
    or p_deployer_address is null or lower(p_deployer_address) !~ '^0x[0-9a-f]{40}$'
    or p_deployer_nonce is null or p_deployer_nonce < 0 or p_deployer_nonce <> trunc(p_deployer_nonce)
    or p_gas_limit is null or p_gas_limit <= 0 or p_gas_limit <> trunc(p_gas_limit)
    or p_native_cost_wei is null or p_native_cost_wei <= 0 or p_native_cost_wei <> trunc(p_native_cost_wei)
    or p_at is null
    or p_max_deployments_per_day is null or p_max_deployments_per_day <= 0
    or p_max_gas_per_deployment is null or p_max_gas_per_deployment <= 0
    or p_max_native_cost_per_day_wei is null or p_max_native_cost_per_day_wei <= 0
    or p_max_pending is null or p_max_pending <= 0 then
    raise exception using message = 'SETUP_INPUT_INVALID: Sponsor reservation input is invalid.';
  end if;
  v_day := (p_at at time zone 'utc')::date;

  select * into v_job from public.setup_deployment_jobs where id = p_job_id for update;
  if not found then
    raise exception using message = 'SETUP_JOB_NOT_FOUND: Deployment job was not found.';
  end if;
  if v_job.fencing_token <> p_fencing_token then
    raise exception using message = 'SETUP_FENCE_STALE: Deployment job fencing token is stale.';
  end if;
  select * into v_existing from public.setup_sponsor_budgets where job_id = p_job_id;
  if found then
    if v_existing.deployer_address = lower(p_deployer_address)
      and v_existing.deployer_nonce = p_deployer_nonce
      and v_existing.gas_limit = p_gas_limit
      and v_existing.native_cost_wei = p_native_cost_wei then
      return jsonb_build_object('disposition', 'REPLAY', 'jobId', p_job_id, 'dayKey', v_existing.day_key);
    end if;
    raise exception using message = 'SETUP_BUDGET_CONFLICT: Job is already bound to different sponsor terms.';
  end if;
  if v_job.status <> 'SIGNING' then
    raise exception using message = 'SETUP_STATE_CONFLICT: Sponsor budget requires a signing job.';
  end if;

  select * into v_runtime from public.setup_runtime_state where id = 1 for share;
  if not found or v_runtime.setup_mode not in ('CANARY', 'PUBLIC', 'DRAIN')
    or v_runtime.sponsor_deployer_address <> lower(p_deployer_address)
    or v_runtime.max_deployments_per_day <> p_max_deployments_per_day
    or v_runtime.max_gas_per_deployment <> p_max_gas_per_deployment
    or v_runtime.max_native_cost_per_day_wei <> p_max_native_cost_per_day_wei
    or v_runtime.max_pending <> p_max_pending then
    raise exception using message = 'SETUP_SPONSOR_POLICY_MISMATCH: Sponsor limits do not match runtime policy.';
  end if;
  if p_gas_limit > p_max_gas_per_deployment then
    raise exception using message = 'SETUP_SPONSOR_CAP: Deployment gas limit exceeds policy.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'agentpay:setup-sponsor:' || lower(p_deployer_address) || ':' || v_day::text, 0
  ));
  if exists (
    select 1 from public.setup_deployment_jobs
    where chain_id = 196 and deployer_address = lower(p_deployer_address)
      and deployer_nonce = p_deployer_nonce and id <> p_job_id
  ) then
    raise exception using message = 'SETUP_DEPLOYER_NONCE_CONFLICT: Sponsor nonce is already reserved.';
  end if;
  select count(*), coalesce(sum(native_cost_wei), 0)
    into v_deployments, v_daily_cost
  from public.setup_sponsor_budgets
  where chain_id = 196 and deployer_address = lower(p_deployer_address) and day_key = v_day;
  select count(*) into v_pending
  from public.setup_deployment_jobs
  where chain_id = 196 and deployer_address = lower(p_deployer_address)
    and status in ('SIGNING', 'SIGNED', 'BROADCAST', 'BROADCAST_UNKNOWN', 'CONFIRMING');

  if v_deployments >= p_max_deployments_per_day
    or v_daily_cost + p_native_cost_wei > p_max_native_cost_per_day_wei
    or v_pending >= p_max_pending then
    raise exception using message = 'SETUP_SPONSOR_CAP: Sponsor deployment budget is exhausted.';
  end if;

  insert into public.setup_sponsor_budgets (
    job_id, day_key, chain_id, deployer_address, deployer_nonce, gas_limit,
    native_cost_wei, status, reserved_at
  ) values (
    p_job_id, v_day, 196, lower(p_deployer_address), p_deployer_nonce, p_gas_limit,
    p_native_cost_wei, 'CHARGED', p_at
  ) returning * into v_existing;
  update public.setup_deployment_jobs
  set deployer_address = lower(p_deployer_address), deployer_nonce = p_deployer_nonce, updated_at = p_at
  where id = p_job_id and status = 'SIGNING' and fencing_token = p_fencing_token;
  if not found then
    raise exception using message = 'SETUP_STATE_CONFLICT: Sponsor reservation lost its compare-and-set fence.';
  end if;
  insert into public.setup_deployment_events (setup_intent_id, job_id, tenant_id, event_type, created_at)
  values (v_job.setup_intent_id, v_job.id, v_job.tenant_id, 'SETUP_SPONSOR_RESERVED', p_at);

  return jsonb_build_object('disposition', 'RESERVED', 'jobId', p_job_id, 'dayKey', v_day);
end;
$$;

create or replace function public.persist_setup_signed_transaction(
  p_job_id uuid,
  p_fencing_token uuid,
  p_raw_tx_ciphertext text,
  p_raw_tx_iv text,
  p_raw_tx_tag text,
  p_raw_tx_hash text,
  p_transaction_hash text,
  p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_job public.setup_deployment_jobs%rowtype;
begin
  if p_job_id is null or p_fencing_token is null
    or p_raw_tx_ciphertext is null or length(p_raw_tx_ciphertext) not between 1 and 262144
    or p_raw_tx_iv is null or length(p_raw_tx_iv) not between 1 and 1024
    or p_raw_tx_tag is null or length(p_raw_tx_tag) not between 1 and 1024
    or p_raw_tx_hash is null or lower(p_raw_tx_hash) !~ '^[0-9a-f]{64}$'
    or p_transaction_hash is null or lower(p_transaction_hash) !~ '^0x[0-9a-f]{64}$'
    or p_at is null then
    raise exception using message = 'SETUP_INPUT_INVALID: Signed transaction input is invalid.';
  end if;
  select * into v_job from public.setup_deployment_jobs where id = p_job_id for update;
  if not found then
    raise exception using message = 'SETUP_JOB_NOT_FOUND: Deployment job was not found.';
  end if;
  if v_job.fencing_token <> p_fencing_token then
    raise exception using message = 'SETUP_FENCE_STALE: Deployment job fencing token is stale.';
  end if;
  if v_job.status = 'SIGNED' then
    if v_job.raw_tx_ciphertext = p_raw_tx_ciphertext and v_job.raw_tx_iv = p_raw_tx_iv
      and v_job.raw_tx_tag = p_raw_tx_tag and v_job.raw_tx_hash = lower(p_raw_tx_hash)
      and v_job.transaction_hash = lower(p_transaction_hash) then
      return jsonb_build_object('disposition', 'REPLAY', 'jobId', p_job_id, 'transactionHash', v_job.transaction_hash);
    end if;
    raise exception using message = 'SETUP_OUTBOX_CONFLICT: Job is signed with different transaction bytes.';
  end if;
  if v_job.status <> 'SIGNING' or not exists (
    select 1 from public.setup_sponsor_budgets where job_id = p_job_id
  ) then
    raise exception using message = 'SETUP_STATE_CONFLICT: Signed transaction requires a charged sponsor reservation.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('agentpay:setup-tx:' || lower(p_transaction_hash), 0));
  if exists (
    select 1 from public.setup_deployment_jobs
    where transaction_hash = lower(p_transaction_hash) and id <> p_job_id
  ) then
    raise exception using message = 'SETUP_TRANSACTION_HASH_CONFLICT: Transaction hash is already bound to another job.';
  end if;

  update public.setup_deployment_jobs
  set status = 'SIGNED', raw_tx_ciphertext = p_raw_tx_ciphertext, raw_tx_iv = p_raw_tx_iv,
      raw_tx_tag = p_raw_tx_tag, raw_tx_hash = lower(p_raw_tx_hash),
      transaction_hash = lower(p_transaction_hash), updated_at = p_at
  where id = p_job_id and status = 'SIGNING' and fencing_token = p_fencing_token;
  if not found then
    raise exception using message = 'SETUP_STATE_CONFLICT: Signed transaction lost its compare-and-set fence.';
  end if;
  update public.setup_intents set status = 'SIGNED', signed_at = p_at
  where id = v_job.setup_intent_id and status = 'SIGNING';
  if not found then
    raise exception using message = 'SETUP_STATE_CONFLICT: Setup intent cannot enter signed state.';
  end if;
  insert into public.setup_deployment_events (setup_intent_id, job_id, tenant_id, event_type, created_at)
  values (v_job.setup_intent_id, v_job.id, v_job.tenant_id, 'SETUP_TRANSACTION_SIGNED', p_at);

  return jsonb_build_object('disposition', 'SIGNED', 'jobId', p_job_id, 'transactionHash', lower(p_transaction_hash));
end;
$$;

create or replace function public.mark_setup_broadcast_result(
  p_job_id uuid,
  p_fencing_token uuid,
  p_result text,
  p_at timestamptz,
  p_public_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_job public.setup_deployment_jobs%rowtype;
begin
  if p_job_id is null or p_fencing_token is null
    or p_result is null or p_result not in ('BROADCAST', 'BROADCAST_UNKNOWN')
    or p_at is null
    or (p_public_error_code is not null and p_public_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$') then
    raise exception using message = 'SETUP_INPUT_INVALID: Broadcast result input is invalid.';
  end if;
  select * into v_job from public.setup_deployment_jobs where id = p_job_id for update;
  if not found then
    raise exception using message = 'SETUP_JOB_NOT_FOUND: Deployment job was not found.';
  end if;
  if v_job.fencing_token <> p_fencing_token then
    raise exception using message = 'SETUP_FENCE_STALE: Deployment job fencing token is stale.';
  end if;
  if v_job.status = p_result then
    return jsonb_build_object('disposition', 'REPLAY', 'jobId', p_job_id, 'status', v_job.status);
  end if;
  if v_job.status <> 'SIGNED' then
    raise exception using message = 'SETUP_STATE_CONFLICT: Broadcast result requires a signed transaction.';
  end if;

  update public.setup_deployment_jobs
  set status = p_result, broadcast_at = case when p_result = 'BROADCAST' then p_at else broadcast_at end,
      public_error_code = p_public_error_code, updated_at = p_at
  where id = p_job_id and status = 'SIGNED' and fencing_token = p_fencing_token;
  if not found then
    raise exception using message = 'SETUP_STATE_CONFLICT: Broadcast result lost its compare-and-set fence.';
  end if;
  update public.setup_intents
  set status = p_result, public_error_code = p_public_error_code
  where id = v_job.setup_intent_id and status = 'SIGNED';
  if not found then
    raise exception using message = 'SETUP_STATE_CONFLICT: Setup intent cannot enter broadcast state.';
  end if;
  insert into public.setup_deployment_events (
    setup_intent_id, job_id, tenant_id, event_type, public_code, metadata, created_at
  ) values (
    v_job.setup_intent_id, v_job.id, v_job.tenant_id, 'SETUP_BROADCAST_RECORDED', p_public_error_code,
    jsonb_build_object('result', p_result), p_at
  );
  return jsonb_build_object('disposition', p_result, 'jobId', p_job_id, 'status', p_result);
end;
$$;

create or replace function public.record_setup_receipt(
  p_job_id uuid,
  p_fencing_token uuid,
  p_transaction_hash text,
  p_receipt_status integer,
  p_receipt_block_number numeric,
  p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_job public.setup_deployment_jobs%rowtype;
  v_next_status text;
begin
  if p_job_id is null or p_fencing_token is null
    or p_transaction_hash is null or lower(p_transaction_hash) !~ '^0x[0-9a-f]{64}$'
    or p_receipt_status is null or p_receipt_status not in (0, 1)
    or p_receipt_block_number is null or p_receipt_block_number < 0
    or p_receipt_block_number <> trunc(p_receipt_block_number)
    or p_at is null then
    raise exception using message = 'SETUP_INPUT_INVALID: Receipt input is invalid.';
  end if;
  select * into v_job from public.setup_deployment_jobs where id = p_job_id for update;
  if not found then
    raise exception using message = 'SETUP_JOB_NOT_FOUND: Deployment job was not found.';
  end if;
  if v_job.fencing_token <> p_fencing_token then
    raise exception using message = 'SETUP_FENCE_STALE: Deployment job fencing token is stale.';
  end if;
  if v_job.transaction_hash <> lower(p_transaction_hash) then
    raise exception using message = 'SETUP_TRANSACTION_MISMATCH: Receipt hash does not match signed outbox.';
  end if;
  if v_job.status in ('CONFIRMING', 'FAILED') and v_job.receipt_status = p_receipt_status
    and v_job.receipt_block_number = p_receipt_block_number then
    return jsonb_build_object('disposition', 'REPLAY', 'jobId', p_job_id, 'status', v_job.status);
  end if;
  if v_job.status not in ('BROADCAST', 'BROADCAST_UNKNOWN') then
    raise exception using message = 'SETUP_STATE_CONFLICT: Receipt requires a broadcast transaction.';
  end if;
  v_next_status := case when p_receipt_status = 1 then 'CONFIRMING' else 'FAILED' end;

  update public.setup_deployment_jobs
  set status = v_next_status, receipt_status = p_receipt_status,
      receipt_block_number = p_receipt_block_number,
      confirmed_at = case when p_receipt_status = 1 then p_at else null end,
      public_error_code = case when p_receipt_status = 0 then 'SETUP_TRANSACTION_REVERTED' else public_error_code end,
      updated_at = p_at
  where id = p_job_id and status in ('BROADCAST', 'BROADCAST_UNKNOWN') and fencing_token = p_fencing_token;
  if not found then
    raise exception using message = 'SETUP_STATE_CONFLICT: Receipt lost its compare-and-set fence.';
  end if;
  update public.setup_intents
  set status = v_next_status,
      public_error_code = case when p_receipt_status = 0 then 'SETUP_TRANSACTION_REVERTED' else public_error_code end
  where id = v_job.setup_intent_id and status in ('BROADCAST', 'BROADCAST_UNKNOWN');
  if not found then
    raise exception using message = 'SETUP_STATE_CONFLICT: Setup intent cannot record receipt.';
  end if;
  insert into public.setup_deployment_events (
    setup_intent_id, job_id, tenant_id, event_type, public_code, metadata, created_at
  ) values (
    v_job.setup_intent_id, v_job.id, v_job.tenant_id, 'SETUP_RECEIPT_RECORDED',
    case when p_receipt_status = 0 then 'SETUP_TRANSACTION_REVERTED' else null end,
    jsonb_build_object('receiptStatus', p_receipt_status, 'blockNumber', p_receipt_block_number), p_at
  );
  return jsonb_build_object('disposition', 'RECORDED', 'jobId', p_job_id, 'status', v_next_status);
end;
$$;

create or replace function public.finalize_verified_setup_wallet(
  p_job_id uuid,
  p_fencing_token uuid,
  p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_job public.setup_deployment_jobs%rowtype;
  v_intent public.setup_intents%rowtype;
  v_wallet public.agent_wallets%rowtype;
begin
  if p_job_id is null or p_fencing_token is null or p_at is null then
    raise exception using message = 'SETUP_INPUT_INVALID: Finalization input is invalid.';
  end if;
  select * into v_job from public.setup_deployment_jobs where id = p_job_id for update;
  if not found then
    raise exception using message = 'SETUP_JOB_NOT_FOUND: Deployment job was not found.';
  end if;
  if v_job.fencing_token <> p_fencing_token then
    raise exception using message = 'SETUP_FENCE_STALE: Deployment job fencing token is stale.';
  end if;
  select * into v_intent from public.setup_intents where id = v_job.setup_intent_id for update;
  if v_job.status = 'COMPLETED' and v_intent.status = 'COMPLETED' then
    select * into v_wallet from public.agent_wallets
    where tenant_id = v_job.tenant_id and account_address = v_intent.predicted_account;
    return jsonb_build_object(
      'disposition', 'REPLAY', 'jobId', p_job_id, 'tenantId', v_job.tenant_id,
      'accountAddress', v_wallet.account_address
    );
  end if;
  if v_job.status <> 'CONFIRMING' or v_job.receipt_status <> 1
    or v_intent.status <> 'CONFIRMING' then
    raise exception using message = 'SETUP_STATE_CONFLICT: Finalization requires a successful confirmed receipt.';
  end if;
  if not exists (
    select 1 from public.verified_owner_identities
    where tenant_id = v_job.tenant_id and owner_address = v_intent.owner_address and status = 'VERIFIED'
  ) then
    raise exception using message = 'SETUP_IDENTITY_MISSING: Verified owner identity is missing.';
  end if;

  insert into public.agent_wallets (
    tenant_id, owner_address, account_address, home_chain_id, executor_address,
    status, created_at, updated_at
  ) values (
    v_job.tenant_id, v_intent.owner_address, v_intent.predicted_account, 196,
    v_intent.executor_address, 'ACTIVE', p_at, p_at
  ) returning * into v_wallet;

  update public.setup_deployment_jobs
  set status = 'COMPLETED', completed_at = p_at, updated_at = p_at
  where id = p_job_id and status = 'CONFIRMING' and fencing_token = p_fencing_token;
  if not found then
    raise exception using message = 'SETUP_STATE_CONFLICT: Wallet finalization lost its job compare-and-set fence.';
  end if;
  update public.setup_intents
  set status = 'COMPLETED', account_address = predicted_account, completed_at = p_at
  where id = v_intent.id and status = 'CONFIRMING';
  if not found then
    raise exception using message = 'SETUP_STATE_CONFLICT: Wallet finalization lost its intent compare-and-set fence.';
  end if;
  insert into public.setup_deployment_events (
    setup_intent_id, job_id, tenant_id, event_type, metadata, created_at
  ) values (
    v_intent.id, v_job.id, v_job.tenant_id, 'SETUP_COMPLETED',
    jsonb_build_object('accountAddress', v_wallet.account_address), p_at
  );
  return jsonb_build_object(
    'disposition', 'COMPLETED', 'jobId', p_job_id, 'tenantId', v_job.tenant_id,
    'accountAddress', v_wallet.account_address
  );
end;
$$;

create or replace function public.mark_setup_manual_review(
  p_job_id uuid,
  p_fencing_token uuid,
  p_public_error_code text,
  p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_job public.setup_deployment_jobs%rowtype;
begin
  if p_job_id is null or p_fencing_token is null
    or p_public_error_code is null or p_public_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
    or p_at is null then
    raise exception using message = 'SETUP_INPUT_INVALID: Manual review input is invalid.';
  end if;
  select * into v_job from public.setup_deployment_jobs where id = p_job_id for update;
  if not found then
    raise exception using message = 'SETUP_JOB_NOT_FOUND: Deployment job was not found.';
  end if;
  if v_job.fencing_token <> p_fencing_token then
    raise exception using message = 'SETUP_FENCE_STALE: Deployment job fencing token is stale.';
  end if;
  if v_job.status = 'MANUAL_REVIEW' and v_job.public_error_code = p_public_error_code then
    return jsonb_build_object('disposition', 'REPLAY', 'jobId', p_job_id);
  end if;
  if v_job.status in ('COMPLETED', 'FAILED') then
    raise exception using message = 'SETUP_STATE_CONFLICT: Terminal setup job cannot enter manual review.';
  end if;
  update public.setup_deployment_jobs
  set status = 'MANUAL_REVIEW', public_error_code = p_public_error_code, updated_at = p_at
  where id = p_job_id and fencing_token = p_fencing_token and status not in ('COMPLETED', 'FAILED');
  update public.setup_intents
  set status = 'MANUAL_REVIEW', public_error_code = p_public_error_code
  where id = v_job.setup_intent_id and status not in ('COMPLETED', 'FAILED', 'EXPIRED');
  insert into public.setup_deployment_events (
    setup_intent_id, job_id, tenant_id, event_type, public_code, created_at
  ) values (v_job.setup_intent_id, v_job.id, v_job.tenant_id, 'SETUP_MANUAL_REVIEW', p_public_error_code, p_at);
  return jsonb_build_object('disposition', 'MANUAL_REVIEW', 'jobId', p_job_id);
end;
$$;

create or replace function public.prune_expired_production_setups(
  p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_expired bigint;
  v_rate_buckets bigint;
begin
  if p_at is null then
    raise exception using message = 'SETUP_INPUT_INVALID: Prune timestamp is required.';
  end if;
  with expired as (
    update public.setup_intents
    set status = 'EXPIRED', public_error_code = 'SETUP_EXPIRED'
    where setup_environment = 'production' and status = 'PENDING' and expires_at <= p_at
    returning id
  ) select count(*) into v_expired from expired;
  delete from public.setup_rate_limit_buckets where expires_at <= p_at;
  get diagnostics v_rate_buckets = row_count;
  return jsonb_build_object('expiredSetups', v_expired, 'deletedRateBuckets', v_rate_buckets);
end;
$$;

create or replace function public.read_production_setup_runtime_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_runtime public.setup_runtime_state%rowtype;
begin
  select * into v_runtime from public.setup_runtime_state where id = 1;
  if not found then
    raise exception using message = 'SETUP_RUNTIME_UNAVAILABLE: Production setup runtime is not pinned.';
  end if;
  return jsonb_build_object(
    'environment', v_runtime.environment,
    'chainId', v_runtime.chain_id,
    'setupMode', v_runtime.setup_mode,
    'manifestSha256', v_runtime.manifest_sha256,
    'factoryAddress', v_runtime.factory_address,
    'factoryRuntimeCodeHash', v_runtime.factory_runtime_code_hash,
    'executorAddress', v_runtime.executor_address,
    'sponsorDeployerAddress', v_runtime.sponsor_deployer_address,
    'maxDeploymentsPerDay', v_runtime.max_deployments_per_day,
    'maxGasPerDeployment', v_runtime.max_gas_per_deployment::text,
    'maxNativeCostPerDayWei', v_runtime.max_native_cost_per_day_wei::text,
    'maxPending', v_runtime.max_pending
  );
end;
$$;

alter table public.setup_runtime_state enable row level security;
alter table public.setup_canary_owners enable row level security;
alter table public.setup_deployment_jobs enable row level security;
alter table public.setup_deployment_events enable row level security;
alter table public.setup_sponsor_budgets enable row level security;
alter table public.setup_rate_limit_buckets enable row level security;

revoke all on schema public from public, anon, authenticated;
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on table public.setup_intents, public.setup_runtime_state, public.setup_canary_owners,
  public.setup_deployment_jobs, public.setup_deployment_events, public.setup_sponsor_budgets,
  public.setup_rate_limit_buckets from agentpay_setup_web, agentpay_setup_worker;

grant usage on schema public to agentpay_setup_web, agentpay_setup_worker;

grant execute on function public.create_production_setup_challenge(
  text, text, text, text, text, text, text, text, text, text, text, text, text,
  text, timestamptz, timestamptz, text, integer, integer
) to agentpay_setup_web;
grant execute on function public.read_production_setup_status(text, timestamptz) to agentpay_setup_web;
grant execute on function public.consume_production_setup_admission(text, text, timestamptz) to agentpay_setup_web;
grant execute on function public.prune_expired_production_setups(timestamptz) to agentpay_setup_web;
grant execute on function public.read_production_setup_runtime_state() to agentpay_setup_web;

grant execute on function public.claim_setup_deployment_job(text, timestamptz, integer) to agentpay_setup_worker;
grant execute on function public.reserve_setup_sponsor_budget(
  uuid, uuid, text, numeric, numeric, numeric, timestamptz, integer, numeric, numeric, integer
) to agentpay_setup_worker;
grant execute on function public.persist_setup_signed_transaction(
  uuid, uuid, text, text, text, text, text, timestamptz
) to agentpay_setup_worker;
grant execute on function public.mark_setup_broadcast_result(
  uuid, uuid, text, timestamptz, text
) to agentpay_setup_worker;
grant execute on function public.record_setup_receipt(
  uuid, uuid, text, integer, numeric, timestamptz
) to agentpay_setup_worker;
grant execute on function public.finalize_verified_setup_wallet(uuid, uuid, timestamptz) to agentpay_setup_worker;
grant execute on function public.mark_setup_manual_review(uuid, uuid, text, timestamptz) to agentpay_setup_worker;

notify pgrst, 'reload schema';

commit;
