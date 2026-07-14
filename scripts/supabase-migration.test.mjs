import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const migrationPath = "supabase/migrations/20260702143000_agentpay_schema.sql";
const tenantMigrationPath = "supabase/migrations/20260712100000_tenant_sessions.sql";
const routeMinimumMigrationPath = "supabase/migrations/20260712113000_payment_route_minimum.sql";
const paymentReviewMigrationPath = "supabase/migrations/20260712130000_payment_review_handoffs.sql";
const runtimeIdentityMigrationPath = "supabase/migrations/20260713140000_runtime_environment_identity.sql";
const paidExecutionLifecycleMigrationPath = "supabase/migrations/20260713150000_paid_execution_lifecycle.sql";
const paidExecutionChallengeOutboxMigrationPath = "supabase/migrations/20260713160000_paid_execution_challenge_outbox.sql";
const paidExecutionCanaryLedgerMigrationPath = "supabase/migrations/20260713170000_paid_execution_canary_ledger.sql";
const canaryOwnerRebindingMigrationPath = "supabase/migrations/20260714180000_canary_owner_rebinding.sql";
const migrationsDir = "supabase/migrations";
const requiredTables = ["setup_intents", "agent_wallets", "payment_intents", "payment_events"];
const requiredSecurityStatements = [
  "alter table public.setup_intents enable row level security",
  "alter table public.agent_wallets enable row level security",
  "alter table public.payment_intents enable row level security",
  "alter table public.payment_events enable row level security",
  "revoke all on table public.setup_intents from anon, authenticated",
  "revoke all on table public.agent_wallets from anon, authenticated",
  "revoke all on table public.payment_intents from anon, authenticated",
  "revoke all on table public.payment_events from anon, authenticated",
];
const requiredIndexes = [
  "create index if not exists setup_intents_status_expires_at_idx on public.setup_intents (status, expires_at)",
  "create index if not exists agent_wallets_status_created_at_idx on public.agent_wallets (status, created_at desc)",
  "create index if not exists payment_intents_created_at_idx on public.payment_intents (created_at desc)",
  "create index if not exists payment_intents_status_deadline_idx on public.payment_intents (status, deadline)",
  "create index if not exists payment_events_payment_intent_id_created_at_idx on public.payment_events (payment_intent_id, created_at desc)",
];

function normalizeSql(sql) {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*/g, ";")
    .trim()
    .toLowerCase();
}

describe("AgentPay Supabase migration", () => {
  it("defines runtime tables with RLS and query-aligned indexes", async () => {
    const sql = normalizeSql(await readFile(migrationPath, "utf8"));

    for (const tableName of requiredTables) {
      assert.match(sql, new RegExp(`create table if not exists public\\.${tableName}\\b`), tableName);
    }

    for (const statement of requiredSecurityStatements) {
      assert.ok(sql.includes(statement), statement);
    }

    for (const index of requiredIndexes) {
      assert.ok(sql.includes(index), index);
    }

    assert.ok(sql.includes("home_chain_id integer not null default 196"), "X Layer home chain default");
    assert.ok(sql.includes("home_chain_id integer not null default 196 check (home_chain_id in (196, 1952))"), "setup intent X Layer network default");
    assert.ok(sql.includes("source_token_symbol text not null check (source_token_symbol in ('usdt0', 'usdc', 'usdt'))"));
  });

  it("includes an upgrade migration for payment intent direct tracking schema drift", async () => {
    const migrationNames = await readdir(migrationsDir);
    const upgradeMigrationName = migrationNames.find((name) => name.endsWith("_align_payment_intents_live_schema.sql"));

    assert.ok(upgradeMigrationName, "Expected a live schema alignment migration");

    const sql = normalizeSql(await readFile(`${migrationsDir}/${upgradeMigrationName}`, "utf8"));

    assert.ok(sql.includes("add column if not exists completed_at timestamptz"), "completed_at upgrade");
    assert.ok(sql.includes("drop constraint if exists payment_intents_route_provider_check"), "route provider drop");
    assert.ok(
      sql.includes("add constraint payment_intents_route_provider_check check (route_provider in ('direct', 'li.fi', 'contract_call'))"),
      "route provider direct/contract-call check",
    );
    assert.ok(sql.includes("drop constraint if exists payment_intents_payment_type_check"), "payment type drop");
    assert.ok(
      sql.includes(
        "add constraint payment_intents_payment_type_check check (payment_type in ('wallet_payment', 'invoice_payment', 'x402_payment', 'contract_call'))",
      ),
      "payment type contract-call check",
    );
    assert.ok(sql.includes("alter column home_chain_id set default 196"), "agent wallet home chain default upgrade");
    assert.ok(sql.includes("add column if not exists home_chain_id integer not null default 196"), "setup intent home chain upgrade");
    assert.ok(sql.includes("notify pgrst, 'reload schema'"), "PostgREST schema cache reload");
  });

  it("defines tenant, challenge, session, and composite isolation controls", async () => {
    const sql = normalizeSql(await readFile(tenantMigrationPath, "utf8"));

    for (const tableName of [
      "tenants",
      "verified_owner_identities",
      "auth_challenges",
      "service_sessions",
      "legacy_migration_audit",
    ]) {
      assert.match(sql, new RegExp(`create table if not exists public\\.${tableName}\\b`), tableName);
    }

    for (const column of [
      "alter table public.agent_wallets alter column tenant_id set not null",
      "alter table public.payment_intents alter column tenant_id set not null",
      "alter table public.payment_events alter column tenant_id set not null",
      "credential_digest text not null unique",
      "authentication_epoch bigint not null",
      "consumed_at timestamptz",
    ]) {
      assert.ok(sql.includes(column), column);
    }

    for (const control of [
      "foreign key (tenant_id, owner_address) references public.verified_owner_identities",
      "foreign key (tenant_id, account_address) references public.agent_wallets",
      "foreign key (tenant_id, payment_intent_id) references public.payment_intents",
      "drop constraint if exists payment_intents_account_address_fkey",
      "drop constraint if exists agent_wallets_account_address_key",
      "set status = 'cancelled'",
      "set status = 'closed'",
      "notify pgrst, 'reload schema'",
      "notify pgrst, 'reload schema'",
      "alter table public.service_sessions enable row level security",
      "revoke all on table public.service_sessions from anon, authenticated",
    ]) {
      assert.ok(sql.includes(control), control);
    }
  });

  it("drops the legacy wallet foreign key before normalizing referenced addresses", async () => {
    const sql = normalizeSql(await readFile(tenantMigrationPath, "utf8"));
    const dropLegacyWalletForeignKey = sql.indexOf(
      "alter table public.payment_intents drop constraint if exists payment_intents_account_address_fkey",
    );
    const normalizeWalletAddresses = sql.indexOf(
      "update public.agent_wallets set owner_address = lower(owner_address), account_address = lower(account_address)",
    );
    const normalizePaymentAddresses = sql.indexOf(
      "update public.payment_intents set owner_address = lower(owner_address), account_address = lower(account_address)",
    );

    assert.notEqual(dropLegacyWalletForeignKey, -1, "legacy wallet foreign key drop");
    assert.ok(dropLegacyWalletForeignKey < normalizeWalletAddresses, "drop before wallet address normalization");
    assert.ok(dropLegacyWalletForeignKey < normalizePaymentAddresses, "drop before payment address normalization");
  });

  it("persists a provider-verified minimum output for V2 route signing", async () => {
    const sql = normalizeSql(await readFile(routeMinimumMigrationPath, "utf8"));

    assert.ok(sql.includes("add column if not exists min_amount_out text"), "route minimum column");
    assert.ok(sql.includes("add column if not exists native_value text"), "route native value column");
    assert.ok(sql.includes("payment_intents_min_amount_out_check"), "route minimum constraint");
    assert.ok(sql.includes("notify pgrst, 'reload schema'"), "PostgREST schema cache reload");
  });

  it("persists a tenant-bound Review & Sign handoff without raw tokens", async () => {
    const sql = normalizeSql(await readFile(paymentReviewMigrationPath, "utf8"));

    assert.ok(sql.includes("create table if not exists public.payment_review_handoffs"));
    assert.ok(sql.includes("token_digest text not null unique"));
    assert.ok(sql.includes("authorization_hash text not null"));
    assert.ok(sql.includes("status text not null default 'pending'"));
    assert.ok(sql.includes("foreign key (tenant_id, payment_intent_id)"));
    assert.ok(sql.includes("alter table public.payment_review_handoffs enable row level security"));
    assert.ok(sql.includes("revoke all on table public.payment_review_handoffs from anon, authenticated"));
    assert.ok(sql.includes("grant select, insert, update, delete on table public.payment_review_handoffs to service_role"));
    assert.ok(sql.includes("create or replace function public.record_payment_review_event"));
    assert.ok(sql.includes("create trigger payment_review_opened_event"));
    assert.ok(sql.includes("create trigger payment_signature_accepted_event"));
    assert.ok(sql.includes("payment_review_opened"));
    assert.ok(sql.includes("payment_signature_accepted"));
  });

  it("defines a singleton runtime identity with operator-only mutation", async () => {
    const sql = normalizeSql(await readFile(runtimeIdentityMigrationPath, "utf8"));

    assert.ok(sql.includes("create table if not exists public.runtime_environment_identity"));
    assert.ok(sql.includes("id smallint primary key"));
    assert.ok(sql.includes("check (id = 1)"));
    assert.ok(sql.includes("execution_mode text not null check (execution_mode in ('off', 'canary', 'public', 'drain'))"));
    assert.ok(sql.includes("manifest_sha256 text not null"));
    assert.ok(sql.includes("migration_head text not null"));
    assert.ok(sql.includes("check ((chain_id = 196 and caip2 = 'eip155:196')"));
    assert.ok(sql.includes("check (eip712_chain_id = chain_id)"));
    assert.ok(sql.includes("check (x402_network = caip2)"));
    assert.ok(sql.includes("alter table public.runtime_environment_identity enable row level security"));
    assert.ok(sql.includes("grant select on table public.runtime_environment_identity to service_role"));
    assert.ok(sql.includes("revoke insert, update, delete, truncate"));
  });

  it("allows a quarantined legacy owner to receive one active production binding", async () => {
    const sql = normalizeSql(await readFile(canaryOwnerRebindingMigrationPath, "utf8"));

    assert.ok(sql.includes("drop constraint if exists verified_owner_identities_owner_address_key"));
    assert.ok(
      sql.includes(
        "create unique index if not exists verified_owner_identities_verified_owner_idx on public.verified_owner_identities (lower(owner_address)) where status = 'verified'",
      ),
    );
    assert.ok(sql.includes("notify pgrst, 'reload schema'"));
  });

  it("binds paid ASP settlement to one tenant-safe lifecycle and stores deterministic replay output", async () => {
    const sql = normalizeSql(await readFile(paidExecutionLifecycleMigrationPath, "utf8"));

    assert.ok(sql.includes("create table if not exists public.paid_execution_lifecycles"));
    for (const column of [
      "tenant_id uuid not null",
      "idempotency_key text not null",
      "payment_payload_hash text not null",
      "payment_requirements_hash text not null",
      "request_hash text not null",
      "arguments_hash text not null",
      "settlement_tx_hash text",
      "response_body_base64 text",
    ]) {
      assert.ok(sql.includes(column), column);
    }
    for (const status of ["claimed", "settling", "settled", "executing", "completed", "failed"]) {
      assert.ok(sql.includes(status), `status ${status}`);
    }
    assert.ok(sql.includes("unique (tenant_id, idempotency_key)"));
    assert.ok(sql.includes("foreign key (tenant_id, payment_intent_id)"));
    assert.ok(sql.includes("alter table public.paid_execution_lifecycles enable row level security"));
    assert.ok(sql.includes("revoke all on table public.paid_execution_lifecycles from public, anon, authenticated"));
    assert.ok(sql.includes("grant select, insert, update on table public.paid_execution_lifecycles to service_role"));
    assert.ok(sql.includes("set_paid_execution_lifecycles_updated_at"));
  });

  it("adds durable challenge, independent fee/refund states, and signed invoice outbox controls", async () => {
    const sql = normalizeSql(await readFile(paidExecutionChallengeOutboxMigrationPath, "utf8"));

    for (const column of ["authorization_hash text", "fee_status text", "execution_status text", "refund_status text"]) {
      assert.ok(sql.includes(column), column);
    }
    for (const status of ["settlement_unknown", "settlement_rejected", "broadcast_unknown", "manual_review", "required"]) {
      assert.ok(sql.includes(status), status);
    }
    assert.ok(sql.includes("create table if not exists public.asp_payment_challenges"));
    assert.ok(sql.includes("payment_requirements_hash text not null"));
    assert.ok(sql.includes("status text not null default 'offered'"));
    assert.ok(sql.includes("create table if not exists public.invoice_execution_outbox"));
    assert.ok(sql.includes("raw_tx_ciphertext text"));
    assert.ok(sql.includes("raw_tx_hash text"));
    assert.ok(sql.includes("unique (chain_id, executor_address, executor_nonce)"));
    assert.ok(sql.includes("alter table public.asp_payment_challenges enable row level security"));
    assert.ok(sql.includes("alter table public.invoice_execution_outbox enable row level security"));
    assert.ok(sql.includes("grant select, insert, update on table public.asp_payment_challenges, public.invoice_execution_outbox to service_role"));
  });

  it("adds a transactional canary reservation ledger without enabling execution", async () => {
    const sql = normalizeSql(await readFile(paidExecutionCanaryLedgerMigrationPath, "utf8"));

    assert.ok(sql.includes("create table if not exists public.paid_execution_canary_reservations"));
    assert.ok(sql.includes("unique (environment, reservation_key)"));
    assert.ok(sql.includes("unique (environment, lifecycle_id)"));
    assert.ok(sql.includes("length(reservation_key) between 1 and 256"), "reservation key length is bounded without PostgreSQL's 255 repetition limit");
    assert.ok(!sql.includes("{1,256}"), "PostgreSQL does not accept a 256 repetition upper bound");
    assert.ok(sql.includes("amount_atomic numeric(78, 0) not null"));
    assert.ok(sql.includes("status in ('reserved', 'completed', 'manual_review')"));
    assert.ok(sql.includes("pg_advisory_xact_lock"));
    assert.ok(sql.includes("agentpay:canary:' || p_environment"), "campaign-wide advisory lock");
    assert.ok(sql.includes("'accepted_lifecycles', ( select count(*)::bigint from public.paid_execution_canary_reservations where environment = p_environment )"), "lifecycle cap does not reset daily");
    assert.ok(sql.includes("where environment = p_environment and tenant_id = p_tenant_id and status in ('reserved', 'manual_review')"), "cross-midnight in-flight fence");
    assert.ok(sql.includes("create or replace function public.reserve_paid_execution_canary"));
    assert.ok(sql.includes("create or replace function public.get_paid_execution_canary_usage"));
    assert.ok(sql.includes("create or replace function public.complete_paid_execution_canary"));
    assert.ok(sql.includes("canary_auto_stop"));
    assert.ok(sql.includes("alter table public.paid_execution_canary_reservations enable row level security"));
    assert.ok(sql.includes("revoke all on table public.paid_execution_canary_reservations from public, anon, authenticated"));
    assert.ok(sql.includes("grant execute on function public.reserve_paid_execution_canary"));
  });
});
