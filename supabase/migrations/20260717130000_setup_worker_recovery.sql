-- Recover durable setup outbox jobs after worker loss and admit an already
-- deployed, exactly verified account without charging sponsor budget.

begin;

alter table public.setup_deployment_jobs
  add column if not exists existing_account_verified boolean not null default false;

alter table public.setup_deployment_jobs
  drop constraint if exists setup_deployment_jobs_check;
alter table public.setup_deployment_jobs
  drop constraint if exists setup_deployment_jobs_outbox_check;
alter table public.setup_deployment_jobs
  add constraint setup_deployment_jobs_outbox_check check (
    (
      status in ('SIGNED', 'BROADCAST', 'BROADCAST_UNKNOWN')
      and not existing_account_verified
      and transaction_hash is not null
      and raw_tx_ciphertext is not null
      and raw_tx_iv is not null
      and raw_tx_tag is not null
      and raw_tx_hash is not null
    )
    or (
      status in ('CONFIRMING', 'COMPLETED')
      and receipt_status = 1
      and receipt_block_number is not null
      and (
        (
          not existing_account_verified
          and transaction_hash is not null
          and raw_tx_ciphertext is not null
          and raw_tx_iv is not null
          and raw_tx_tag is not null
          and raw_tx_hash is not null
        )
        or (
          existing_account_verified
          and transaction_hash is null
          and raw_tx_ciphertext is null
          and raw_tx_iv is null
          and raw_tx_tag is null
          and raw_tx_hash is null
          and deployer_address is null
          and deployer_nonce is null
        )
      )
    )
    or (
      status in ('QUEUED', 'SIGNING', 'FAILED', 'MANUAL_REVIEW')
      and not existing_account_verified
    )
  );

drop index if exists public.setup_deployment_jobs_work_idx;
create index setup_deployment_jobs_work_idx
  on public.setup_deployment_jobs (status, lease_until, created_at)
  where status in ('QUEUED', 'SIGNING', 'SIGNED', 'BROADCAST', 'BROADCAST_UNKNOWN', 'CONFIRMING');

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
     or (
       status in ('SIGNING', 'SIGNED', 'BROADCAST', 'BROADCAST_UNKNOWN', 'CONFIRMING')
       and lease_until <= p_at
     )
  order by created_at, id
  limit 1
  for update skip locked;
  if not found then
    return null;
  end if;

  select * into v_intent from public.setup_intents where id = v_job.setup_intent_id for update;
  if v_job.status in ('QUEUED', 'SIGNING') and v_intent.expires_at <= p_at then
    update public.setup_deployment_jobs
    set status = 'FAILED', public_error_code = 'SETUP_EXPIRED', updated_at = p_at
    where id = v_job.id;
    update public.setup_intents
    set status = 'EXPIRED', public_error_code = 'SETUP_EXPIRED', updated_at = p_at
    where id = v_intent.id;
    insert into public.setup_deployment_events (
      setup_intent_id, job_id, tenant_id, event_type, public_code, created_at
    ) values (v_intent.id, v_job.id, v_job.tenant_id, 'SETUP_EXPIRED', 'SETUP_EXPIRED', p_at);
    return null;
  end if;

  update public.setup_deployment_jobs
  set status = case when status = 'QUEUED' then 'SIGNING' else status end,
      worker_id = p_worker_id,
      fencing_token = extensions.gen_random_uuid(),
      lease_until = p_at + make_interval(secs => p_lease_seconds),
      attempt_count = attempt_count + 1,
      updated_at = p_at
  where id = v_job.id
    and (
      status = 'QUEUED'
      or (
        status in ('SIGNING', 'SIGNED', 'BROADCAST', 'BROADCAST_UNKNOWN', 'CONFIRMING')
        and lease_until <= p_at
      )
    )
  returning * into v_job;
  if not found then
    return null;
  end if;

  if v_intent.status = 'ADMITTED' then
    update public.setup_intents set status = 'SIGNING', updated_at = p_at where id = v_intent.id;
    v_intent.status := 'SIGNING';
  elsif v_intent.status <> v_job.status then
    raise exception using message = 'SETUP_STATE_CONFLICT: Setup intent and deployment job status diverged.';
  end if;

  insert into public.setup_deployment_events (
    setup_intent_id, job_id, tenant_id, event_type, metadata, created_at
  ) values (
    v_intent.id, v_job.id, v_job.tenant_id, 'SETUP_JOB_CLAIMED',
    jsonb_build_object('jobStatus', v_job.status), p_at
  );

  return jsonb_strip_nulls(jsonb_build_object(
    'disposition', 'CLAIMED',
    'jobStatus', v_job.status,
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
    'expiresAt', v_intent.expires_at,
    'deployerAddress', v_job.deployer_address,
    'deployerNonce', v_job.deployer_nonce::text,
    'transactionHash', v_job.transaction_hash,
    'rawTransaction', case when v_job.raw_tx_ciphertext is null then null else jsonb_build_object(
      'ciphertext', v_job.raw_tx_ciphertext,
      'iv', v_job.raw_tx_iv,
      'tag', v_job.raw_tx_tag,
      'hash', v_job.raw_tx_hash
    ) end,
    'receiptStatus', v_job.receipt_status,
    'receiptBlockNumber', v_job.receipt_block_number::text,
    'existingAccountVerified', v_job.existing_account_verified,
    'broadcastAt', v_job.broadcast_at
  ));
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
  set status = p_result, broadcast_at = coalesce(broadcast_at, p_at),
      public_error_code = p_public_error_code, updated_at = p_at
  where id = p_job_id and status = 'SIGNED' and fencing_token = p_fencing_token;
  if not found then
    raise exception using message = 'SETUP_STATE_CONFLICT: Broadcast result lost its compare-and-set fence.';
  end if;
  update public.setup_intents
  set status = p_result, public_error_code = p_public_error_code, updated_at = p_at
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

create or replace function public.record_existing_setup_account(
  p_job_id uuid,
  p_fencing_token uuid,
  p_verification_block_number numeric,
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
    or p_verification_block_number is null or p_verification_block_number < 0
    or p_verification_block_number <> trunc(p_verification_block_number)
    or p_at is null then
    raise exception using message = 'SETUP_INPUT_INVALID: Existing account verification input is invalid.';
  end if;

  select * into v_job from public.setup_deployment_jobs where id = p_job_id for update;
  if not found then
    raise exception using message = 'SETUP_JOB_NOT_FOUND: Deployment job was not found.';
  end if;
  if v_job.fencing_token <> p_fencing_token then
    raise exception using message = 'SETUP_FENCE_STALE: Deployment job fencing token is stale.';
  end if;
  if v_job.status = 'CONFIRMING' and v_job.existing_account_verified
    and v_job.receipt_block_number = p_verification_block_number then
    return jsonb_build_object('disposition', 'REPLAY', 'jobId', p_job_id, 'status', 'CONFIRMING');
  end if;
  if v_job.status <> 'SIGNING' or v_job.transaction_hash is not null
    or v_job.raw_tx_ciphertext is not null
    or exists (select 1 from public.setup_sponsor_budgets where job_id = p_job_id) then
    raise exception using message = 'SETUP_STATE_CONFLICT: Existing account path requires an unreserved signing job.';
  end if;

  update public.setup_deployment_jobs
  set status = 'CONFIRMING', receipt_status = 1,
      receipt_block_number = p_verification_block_number,
      existing_account_verified = true,
      confirmed_at = p_at,
      updated_at = p_at
  where id = p_job_id and status = 'SIGNING' and fencing_token = p_fencing_token;
  if not found then
    raise exception using message = 'SETUP_STATE_CONFLICT: Existing account verification lost its compare-and-set fence.';
  end if;

  update public.setup_intents
  set status = 'CONFIRMING', updated_at = p_at
  where id = v_job.setup_intent_id and status = 'SIGNING';
  if not found then
    raise exception using message = 'SETUP_STATE_CONFLICT: Setup intent cannot confirm an existing account.';
  end if;

  insert into public.setup_deployment_events (
    setup_intent_id, job_id, tenant_id, event_type, metadata, created_at
  ) values (
    v_job.setup_intent_id, v_job.id, v_job.tenant_id, 'SETUP_EXISTING_ACCOUNT_VERIFIED',
    jsonb_build_object('blockNumber', p_verification_block_number), p_at
  );
  return jsonb_build_object('disposition', 'RECORDED', 'jobId', p_job_id, 'status', 'CONFIRMING');
end;
$$;

create or replace function public.read_production_setup_worker_runtime_state()
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

revoke all on function public.record_existing_setup_account(uuid, uuid, numeric, timestamptz)
  from public, anon, authenticated, agentpay_setup_web;
grant execute on function public.record_existing_setup_account(uuid, uuid, numeric, timestamptz)
  to agentpay_setup_worker;
revoke all on function public.read_production_setup_worker_runtime_state()
  from public, anon, authenticated, agentpay_setup_web;
grant execute on function public.read_production_setup_worker_runtime_state()
  to agentpay_setup_worker;

notify pgrst, 'reload schema';

commit;
