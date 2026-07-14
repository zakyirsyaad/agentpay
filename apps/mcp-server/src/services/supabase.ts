import { randomUUID } from "node:crypto";
import { getAddress } from "ethers";
import { createClient } from "@supabase/supabase-js";
import {
  AgentPayAuthError,
  requireSessionContext,
  type PaymentReviewHandoffRecord,
  type PaymentEventRecord,
  type PaymentIntentRecord,
  type SessionContext,
  type SessionEnvironment,
  type SetupIntentRecord,
} from "@agentpay-ai/shared";

import type { ExecutePaymentIntentRepository } from "../tools/execute-payment.ts";
import type {
  ListPaymentEventRepository,
  ListPaymentIntentRepository,
  TrackPaymentIntentRepository,
} from "../tools/payment-tracking.ts";
import type { AgentWallet, AgentWalletRepository, PaymentIntentRepository } from "../tools/prepare-payment.ts";
import type { PaymentReviewRepository } from "./payment-review.ts";
import type { SetupIntentRepository } from "../tools/wallet-setup.ts";
import type {
  AuthChallengeStore,
  ResolvedTenantBinding,
  ServiceSessionRecord,
  ServiceSessionStore,
} from "../auth/session.ts";
import { SERVICE_SESSION_TTL_SECONDS, type SiweChallenge } from "../auth/siwe.ts";
import type { RuntimeEnvironmentIdentity } from "../runtime/production-readiness.ts";
import { CanaryPolicyError, decimalToAtomic6 } from "../runtime/paid-execution-canary.ts";
import type {
  CanaryLedgerReserveInput,
  CanaryLedgerSnapshotInput,
  CanaryLedgerStore,
} from "../runtime/paid-execution-canary-ledger.ts";
import {
  createPaidExecutionIdempotencyKey,
  type PaidExecutionLifecycleClaim,
  type PaidExecutionLifecycleClaimInput,
  type PaidExecutionLifecycleRecord,
  type PaidExecutionLifecycleStore,
  type PaidExecutionLifecycleStatus,
  type PaidExecutionResponseSnapshot,
} from "./paid-execution-lifecycle.ts";
import type {
  PaidExecutionChallengeOffer,
  PaidExecutionChallengeOfferInput,
  PaidExecutionChallengeRecord,
  PaidExecutionChallengeStore,
} from "./paid-execution-challenge.ts";
import type {
  EncryptedRawTransaction,
  InvoiceExecutionOutboxInput,
  InvoiceExecutionOutboxRecord,
  InvoiceExecutionOutboxStatus,
  InvoiceExecutionOutboxStore,
} from "./paid-execution-outbox.ts";

interface SupabaseQueryResult<T> {
  data: T | null;
  error: { message: string } | null;
}

interface SupabaseListQueryResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

interface SupabaseSelectQuery<T> extends PromiseLike<SupabaseListQueryResult<T>> {
  select(columns: string): SupabaseSelectQuery<T>;
  eq(column: string, value: string | number): SupabaseSelectQuery<T>;
  order(column: string, options: { ascending: boolean }): SupabaseSelectQuery<T>;
  limit(count: number): SupabaseSelectQuery<T>;
  is(column: string, value: null): SupabaseSelectQuery<T>;
  lt(column: string, value: string | number): SupabaseSelectQuery<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T>>;
}

interface SupabaseInsertQuery {
  insert(row: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
}

interface SupabaseUpdateBuilder<T> extends PromiseLike<{ error: { message: string } | null }> {
  eq(column: string, value: string): SupabaseUpdateBuilder<T>;
  gt(column: string, value: string | number): SupabaseUpdateBuilder<T>;
  is(column: string, value: null): SupabaseUpdateBuilder<T>;
  lt(column: string, value: string | number): SupabaseUpdateBuilder<T>;
  select(columns: string): SupabaseUpdateBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T>>;
}

interface SupabaseUpdateQuery<T> {
  update(row: Record<string, unknown>): SupabaseUpdateBuilder<T>;
}

interface SupabaseRpcClient {
  rpc<T>(functionName: string, args: Record<string, unknown>): Promise<SupabaseQueryResult<T>>;
}

export interface AgentPaySupabaseClient extends SupabaseRpcClient {
  from(table: "setup_intents"): SupabaseInsertQuery & SupabaseSelectQuery<SetupIntentRow> & SupabaseUpdateQuery<SetupIntentRow>;
  from(table: "payment_intents"): SupabaseInsertQuery & SupabaseSelectQuery<PaymentIntentRow> & SupabaseUpdateQuery<PaymentIntentRow>;
  from(table: "payment_events"): SupabaseInsertQuery & SupabaseSelectQuery<PaymentEventRow>;
  from(table: "auth_challenges"): SupabaseInsertQuery & SupabaseSelectQuery<AuthChallengeRow> & SupabaseUpdateQuery<AuthChallengeRow>;
  from(table: "service_sessions"): SupabaseInsertQuery & SupabaseSelectQuery<ServiceSessionRow> & SupabaseUpdateQuery<ServiceSessionRow>;
  from(table: "verified_owner_identities"): SupabaseInsertQuery & SupabaseSelectQuery<VerifiedOwnerIdentityRow>;
  from(table: "tenants"): SupabaseInsertQuery & SupabaseSelectQuery<TenantRow>;
  from(table: "agent_wallets"): SupabaseInsertQuery & SupabaseSelectQuery<AgentWalletRow> & SupabaseUpdateQuery<AgentWalletRow>;
  from(table: "payment_review_handoffs"): SupabaseInsertQuery & SupabaseSelectQuery<PaymentReviewHandoffRow> & SupabaseUpdateQuery<PaymentReviewHandoffRow>;
  from(table: "paid_execution_lifecycles"): SupabaseInsertQuery & SupabaseSelectQuery<PaidExecutionLifecycleRow> & SupabaseUpdateQuery<PaidExecutionLifecycleRow>;
  from(table: "asp_payment_challenges"): SupabaseInsertQuery & SupabaseSelectQuery<AspPaymentChallengeRow> & SupabaseUpdateQuery<AspPaymentChallengeRow>;
  from(table: "invoice_execution_outbox"): SupabaseInsertQuery & SupabaseSelectQuery<InvoiceExecutionOutboxRow> & SupabaseUpdateQuery<InvoiceExecutionOutboxRow>;
  from(table: "runtime_environment_identity"): SupabaseSelectQuery<RuntimeEnvironmentIdentityRow>;
}

interface AgentWalletRow {
  tenant_id?: string;
  owner_address: string;
  account_address: string;
  home_chain_id: number;
  executor_address: string;
  status: "ACTIVE" | "PAUSED" | "CLOSED";
}

interface PaymentIntentRow {
  tenant_id?: string | null;
  id: string;
  account_address: string;
  owner_address: string;
  status: PaymentIntentRecord["status"];
  payment_type: PaymentIntentRecord["paymentType"];
  source_chain_id: number;
  destination_chain_id: number;
  source_token_address: string;
  source_token_symbol: string;
  destination_token_address: string;
  destination_token_symbol: string;
  recipient_address: string;
  amount_out: string;
  min_amount_out: string | null;
  max_amount_in: string;
  max_native_fee: string;
  native_value: string | null;
  route_provider: PaymentIntentRecord["routeProvider"];
  route_target: string;
  route_calldata: string;
  route_calldata_hash: string;
  route_summary: string;
  estimated_fee: string | null;
  estimated_eta_seconds: number | null;
  nonce: string;
  deadline: string;
  purpose: string | null;
  approval_phrase: string;
  approved_at: string | null;
  source_tx_hash: string | null;
  destination_tx_hash: string | null;
  lifi_tracking_id: string | null;
  error_code: string | null;
  error_message: string | null;
  completed_at?: string | null;
  created_at?: string;
}

interface PaymentEventRow {
  id: string;
  payment_intent_id: string;
  event_type: string;
  message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface PaymentReviewHandoffRow {
  id: string;
  payment_intent_id: string;
  tenant_id: string;
  owner_address: string;
  account_address: string;
  source_chain_id: number;
  authorization_hash: string;
  token_digest: string;
  status: PaymentReviewHandoffRecord["status"];
  signature: string | null;
  created_at: string;
  expires_at: string;
  signed_at: string | null;
}

interface SetupIntentRow {
  id: string;
  tenant_id: string | null;
  owner_address: string | null;
  executor_address: string;
  message_to_sign: string;
  signature: string | null;
  status: "PENDING" | "SIGNED" | "DEPLOYING" | "COMPLETED" | "EXPIRED" | "FAILED";
  expires_at: string;
  account_address: string | null;
  error_code: string | null;
  error_message: string | null;
  completed_at: string | null;
  home_chain_id: number | null;
}

interface TenantRow {
  id: string;
  auth_epoch: number;
  environment: "staging" | "production" | "legacy";
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
}

interface VerifiedOwnerIdentityRow {
  tenant_id: string;
  owner_address: string;
  status: "VERIFIED" | "REVOKED" | "QUARANTINED";
}

interface AuthChallengeRow {
  id: string;
  tenant_id: string | null;
  request_id: string;
  domain: string;
  uri: string;
  owner_address: string;
  account_address: string;
  chain_id: 196 | 1952;
  nonce: string;
  scopes: string[];
  message: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
}

interface ServiceSessionRow {
  id: string;
  tenant_id: string;
  owner_address: string;
  account_address: string;
  home_chain_id: 196 | 1952;
  audience: string;
  environment: "staging" | "production";
  scopes: string[];
  authentication_epoch: number;
  credential_digest: string;
  issued_at: string;
  expires_at: string;
  last_used_at: string;
  revoked_at: string | null;
}

interface RuntimeEnvironmentIdentityRow {
  id: number;
  environment: "staging" | "production";
  chain_id: number;
  caip2: string;
  supabase_project_ref: string;
  migration_head: string;
  release_commit: string | null;
  manifest_sha256: string;
  account_version: "v2";
  account_address: string | null;
  deployment_tx_hash: string | null;
  creation_bytecode_hash: string;
  runtime_bytecode_hash: string | null;
  abi_sha256: string | null;
  owner_address: string | null;
  executor_address: string | null;
  deployer_address: string | null;
  eip712_verifying_contract: string | null;
  token_address: string;
  token_code_hash: string;
  token_decimals: number;
  x402_network: string;
  x402_asset: string;
  x402_price: string;
  x402_price_atomic: string;
  x402_sync_settle: boolean;
  x402_enabled: boolean;
  pay_to_address: string | null;
  facilitator_ref: string | null;
  public_origin: string | null;
  execution_mode: RuntimeEnvironmentIdentity["executionMode"];
  status: RuntimeEnvironmentIdentity["status"];
}

interface PaidExecutionLifecycleRow {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  payment_identifier: string | null;
  payment_payload_hash: string;
  payment_requirements_hash: string;
  request_hash: string;
  tool_name: "execute_payment";
  payment_intent_id: string;
  arguments_hash: string;
  authorization_hash?: string | null;
  challenge_id?: string | null;
  environment?: "staging" | "production" | null;
  payer: string | null;
  status: PaidExecutionLifecycleStatus;
  fee_status?: PaidExecutionLifecycleRecord["feeStatus"];
  execution_status?: PaidExecutionLifecycleRecord["executionStatus"];
  refund_status?: PaidExecutionLifecycleRecord["refundStatus"];
  settlement_tx_hash: string | null;
  settlement_headers: Record<string, string> | null;
  response_status: number | null;
  response_headers: Record<string, string> | null;
  response_body_base64: string | null;
  execution_tx_hash: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
  completed_at: string | null;
}

interface AspPaymentChallengeRow {
  id: string;
  tenant_id: string;
  environment: "staging" | "production";
  payment_intent_id: string;
  owner_address: string;
  account_address: string;
  request_hash: string;
  arguments_hash: string;
  authorization_hash: string;
  fee_terms_hash: string;
  payment_requirements_hash: string;
  status: "OFFERED" | "CONSUMED" | "EXPIRED";
  offered_at: string;
  expires_at: string;
  consumed_at: string | null;
}

interface InvoiceExecutionOutboxRow {
  id: string;
  tenant_id: string;
  lifecycle_id: string;
  payment_intent_id: string;
  status: InvoiceExecutionOutboxStatus;
  chain_id: number;
  executor_address: string;
  executor_nonce: string | null;
  transaction_hash: string | null;
  calldata_hash: string | null;
  owner_authorization_nonce: string | null;
  raw_tx_ciphertext: string | null;
  raw_tx_iv: string | null;
  raw_tx_tag: string | null;
  raw_tx_hash: string | null;
  lease_until: string | null;
  fencing_token: string | null;
  attempt_count: number;
  broadcast_at: string | null;
  confirmed_at: string | null;
  receipt_status: 0 | 1 | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupabaseRuntimeConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetch?: typeof fetch;
  tenantContext?: SessionContext;
}

export function createSupabaseAgentPayRepositoriesFromConfig(config: SupabaseRuntimeConfig) {
  const client = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: config.fetch
      ? {
          fetch: config.fetch,
        }
      : undefined,
  });

  return createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient, config.tenantContext);
}

export function createTenantScopedSupabaseAgentPayRepositoriesFromConfig(
  config: SupabaseRuntimeConfig & { tenantContext: SessionContext },
): AgentPayRepositoryBundle {
  const client = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: config.fetch
      ? {
          fetch: config.fetch,
        }
      : undefined,
  });

  return createTenantScopedSupabaseAgentPayRepositories(
    client as unknown as AgentPaySupabaseClient,
    config.tenantContext,
  );
}

export type AgentPayRepositoryBundle = {
  wallets: AgentWalletRepository & { createAgentWallet(wallet: AgentWallet): Promise<void> };
  setupIntents: SetupIntentRepository & {
    markSetupSigned(setupIntentId: string, ownerAddress: string, signature: string, tenantId?: string): Promise<void>;
    markSetupCompleted(setupIntentId: string, accountAddress: string, completedAt: string): Promise<void>;
    markSetupExpired(setupIntentId: string): Promise<void>;
    markSetupFailed(setupIntentId: string, errorCode: string, errorMessage: string): Promise<void>;
  };
  paymentIntents: PaymentIntentRepository &
    ExecutePaymentIntentRepository &
    TrackPaymentIntentRepository &
    ListPaymentIntentRepository;
  paymentEvents: ListPaymentEventRepository;
  paymentReviews: PaymentReviewRepository;
  paidExecutionLifecycle: PaidExecutionLifecycleStore;
  paidExecutionChallenge?: PaidExecutionChallengeStore;
  invoiceExecutionOutbox?: InvoiceExecutionOutboxStore;
  canaryLedger?: CanaryLedgerStore;
  authChallenges: AuthChallengeStore;
  serviceSessions: ServiceSessionStore;
  tenantBindings: {
    resolveTenant(ownerAddress: string, accountAddress: string, chainId: number, environment?: SessionEnvironment): Promise<ResolvedTenantBinding>;
    getAuthenticationEpoch(tenantId: string): Promise<number>;
    getTenantState(tenantId: string): Promise<{
      authenticationEpoch: number;
      environment: SessionEnvironment;
      status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
    }>;
    bindVerifiedOwner(ownerAddress: string, chainId: number): Promise<ResolvedTenantBinding>;
  };
  runtimeEnvironment: {
    getIdentity(): Promise<RuntimeEnvironmentIdentity | null>;
  };
};

export function createSupabaseAgentPayRepositories(client: AgentPaySupabaseClient, tenantContext?: SessionContext): AgentPayRepositoryBundle {
  const context = tenantContext;
  const scoped = context ? requireSessionContext(context) : undefined;

  return createRepositoryBundle(client, scoped);
}

export function createTenantScopedSupabaseAgentPayRepositories(
  client: AgentPaySupabaseClient,
  tenantContext: SessionContext,
): AgentPayRepositoryBundle {
  return createRepositoryBundle(client, requireSessionContext(tenantContext));
}

function createRepositoryBundle(client: AgentPaySupabaseClient, tenantContext?: SessionContext): AgentPayRepositoryBundle {
  return {
    setupIntents: {
      async createSetupIntent(intent): Promise<void> {
        assertSetupIntentOwnership(tenantContext, intent.ownerAddress);
        assertTenantId(tenantContext, intent.tenantId);
        const { error } = await client.from("setup_intents").insert(toSetupIntentRow(intent, tenantContext));

        if (error) {
          throw new Error(`Failed to create setup intent ${intent.id}: ${error.message}`);
        }
      },
      async getSetupIntent(setupIntentId): Promise<SetupIntentRecord | null> {
        let query = client.from("setup_intents").select("*").eq("id", setupIntentId);
        if (tenantContext) {
          query = query.eq("tenant_id", tenantContext.tenantId);
        }
        const { data, error } = await query.maybeSingle();

        if (error) {
          throw new Error(`Failed to load setup intent ${setupIntentId}: ${error.message}`);
        }

        return data ? toSetupIntentRecord(data) : null;
      },
      async markSetupSigned(setupIntentId, ownerAddress, signature, tenantId?: string): Promise<void> {
        if (tenantContext && tenantId && tenantId !== tenantContext.tenantId) {
          throw new AgentPayAuthError(
            "TENANT_RESOURCE_MISMATCH",
            "Setup intent tenant does not match the consumer session.",
          );
        }
        const boundTenantId = tenantContext?.tenantId ?? tenantId;
        await updateSetupIntent(client, setupIntentId, {
          status: "SIGNED",
          owner_address: ownerAddress.toLowerCase(),
          signature,
          ...(boundTenantId ? { tenant_id: boundTenantId } : {}),
        }, tenantContext);
      },
      async markSetupCompleted(setupIntentId, accountAddress, completedAt): Promise<void> {
        await updateSetupIntent(client, setupIntentId, {
          status: "COMPLETED",
          account_address: accountAddress.toLowerCase(),
          completed_at: completedAt,
        }, tenantContext);
      },
      async markSetupExpired(setupIntentId): Promise<void> {
        await updateSetupIntent(client, setupIntentId, {
          status: "EXPIRED",
          error_code: "SETUP_EXPIRED",
          error_message: "Wallet setup intent expired.",
        }, tenantContext);
      },
      async markSetupFailed(setupIntentId, errorCode, errorMessage): Promise<void> {
        await updateSetupIntent(client, setupIntentId, {
          status: "FAILED",
          error_code: errorCode,
          error_message: errorMessage,
        }, tenantContext);
      },
    },
    wallets: {
      async getActiveWallet(request = {}): Promise<AgentWallet | null> {
        let query = client
          .from("agent_wallets")
          .select("owner_address, account_address, home_chain_id, executor_address, status")
          .eq("status", "ACTIVE");

        if (tenantContext) {
          query = query
            .eq("tenant_id", tenantContext.tenantId)
            .eq("owner_address", tenantContext.ownerAddress)
            .eq("account_address", tenantContext.accountAddress);
          if (request.homeChainId !== undefined && request.homeChainId !== tenantContext.homeChainId) {
            throw new AgentPayAuthError(
              "TENANT_RESOURCE_MISMATCH",
              "Wallet network does not match the consumer session.",
            );
          }
        }

        if (request.homeChainId !== undefined) {
          query = query.eq("home_chain_id", request.homeChainId);
        }

        const { data, error } = await query
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error) {
          throw new Error(`Failed to load active AgentPay wallet: ${error.message}`);
        }

        return data ? toAgentWallet(data) : null;
      },
      async createAgentWallet(wallet): Promise<void> {
        assertTenantId(tenantContext, wallet.tenantId);
        assertWalletOwnership(tenantContext, wallet.ownerAddress, wallet.accountAddress);
        const { error } = await client.from("agent_wallets").insert(toAgentWalletRow(wallet, tenantContext));

        if (error) {
          throw new Error(`Failed to create AgentPay wallet ${wallet.accountAddress}: ${error.message}`);
        }
      },
    },
    paymentIntents: {
      async createPaymentIntent(intent: PaymentIntentRecord): Promise<void> {
        assertWalletOwnership(tenantContext, intent.ownerAddress, intent.accountAddress);
        const { error } = await client.from("payment_intents").insert(toPaymentIntentRow(intent, tenantContext));

        if (error) {
          throw new Error(`Failed to create payment intent ${intent.id}: ${error.message}`);
        }

        await insertPaymentEvent(client, intent.id, "PAYMENT_CREATED", "Payment intent created.", {
          status: intent.status,
          amountOut: intent.amountOut,
          destinationChainId: intent.destinationChainId,
          destinationTokenSymbol: intent.destinationTokenSymbol,
          recipientAddress: intent.recipientAddress,
        }, tenantContext);
      },
      async getPaymentIntent(paymentIntentId: string): Promise<PaymentIntentRecord | null> {
        let query = client.from("payment_intents").select("*").eq("id", paymentIntentId);
        if (tenantContext) {
          query = query
            .eq("tenant_id", tenantContext.tenantId)
            .eq("owner_address", tenantContext.ownerAddress)
            .eq("account_address", tenantContext.accountAddress);
        }
        const { data, error } = await query.maybeSingle();

        if (error) {
          throw new Error(`Failed to load payment intent ${paymentIntentId}: ${error.message}`);
        }

        return data ? toPaymentIntentRecord(data) : null;
      },
      async claimPaymentApproval(paymentIntentId: string, approvedAt: string): Promise<boolean> {
        let query = client
          .from("payment_intents")
          .update({
            status: "APPROVED",
            approved_at: approvedAt,
          })
          .eq("id", paymentIntentId)
          .eq("status", "AWAITING_APPROVAL")
          .select("id");

        if (tenantContext) {
          query = query
            .eq("tenant_id", tenantContext.tenantId)
            .eq("owner_address", tenantContext.ownerAddress)
            .eq("account_address", tenantContext.accountAddress);
        }
        const { data, error } = await query.maybeSingle();

        if (error) {
          throw new Error(`Failed to claim payment intent ${paymentIntentId}: ${error.message}`);
        }

        if (!data) {
          return false;
        }

        await insertPaymentEvent(client, paymentIntentId, "PAYMENT_APPROVED", "Exact approval phrase accepted.", {
          approvedAt,
        }, tenantContext);

        return true;
      },
      async markPaymentExecuting(paymentIntentId: string, sourceTxHash: string, approvedAt: string): Promise<void> {
        await updatePaymentIntent(client, paymentIntentId, {
          status: "EXECUTING",
          source_tx_hash: sourceTxHash,
          approved_at: approvedAt,
        }, tenantContext);
        await insertPaymentEvent(client, paymentIntentId, "PAYMENT_EXECUTING", "Payment execution started.", {
          sourceTxHash,
          approvedAt,
        }, tenantContext);
      },
      async markPaymentFailed(paymentIntentId: string, errorCode: string, errorMessage: string): Promise<void> {
        await updatePaymentIntent(client, paymentIntentId, {
          status: "FAILED",
          error_code: errorCode,
          error_message: errorMessage,
        }, tenantContext);
        await insertPaymentEvent(client, paymentIntentId, "PAYMENT_FAILED", errorMessage, {
          errorCode,
        }, tenantContext);
      },
      async markPaymentExpired(paymentIntentId: string): Promise<void> {
        const errorMessage = "Payment approval deadline expired.";

        await updatePaymentIntent(client, paymentIntentId, {
          status: "EXPIRED",
          error_code: "DEADLINE_EXPIRED",
          error_message: errorMessage,
        }, tenantContext);
        await insertPaymentEvent(client, paymentIntentId, "PAYMENT_EXPIRED", errorMessage, {
          errorCode: "DEADLINE_EXPIRED",
        }, tenantContext);
      },
      async markPaymentCompleted(
        paymentIntentId: string,
        destinationTxHash: string | undefined,
        completedAt: string,
      ): Promise<void> {
        await updatePaymentIntent(
          client,
          paymentIntentId,
          omitUndefined({
            status: "COMPLETED",
            destination_tx_hash: destinationTxHash,
            completed_at: completedAt,
          }),
          tenantContext,
        );
        await insertPaymentEvent(client, paymentIntentId, "PAYMENT_COMPLETED", "Payment completed.", {
          destinationTxHash,
          completedAt,
        }, tenantContext);
      },
      async listPaymentIntents(request: { limit: number }): Promise<PaymentIntentRecord[]> {
        let query = client
          .from("payment_intents")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(request.limit);

        if (tenantContext) {
          query = query
            .eq("tenant_id", tenantContext.tenantId)
            .eq("owner_address", tenantContext.ownerAddress)
            .eq("account_address", tenantContext.accountAddress);
        }
        const { data, error } = await query;

        if (error) {
          throw new Error(`Failed to list payment intents: ${error.message}`);
        }

        return (data ?? []).map(toPaymentIntentRecord);
      },
    },
    paymentEvents: {
      async listPaymentEvents(request: { paymentIntentId: string; limit: number }): Promise<PaymentEventRecord[]> {
        if (tenantContext) {
          let intentQuery = client.from("payment_intents").select("id").eq("id", request.paymentIntentId);
          intentQuery = intentQuery
            .eq("tenant_id", tenantContext.tenantId)
            .eq("owner_address", tenantContext.ownerAddress)
            .eq("account_address", tenantContext.accountAddress);
          const { data: intent, error: intentError } = await intentQuery.maybeSingle();
          if (intentError) {
            throw new Error(`Failed to verify payment event ownership for ${request.paymentIntentId}.`);
          }
          if (!intent) {
            return [];
          }
        }
        let query = client
          .from("payment_events")
          .select("*")
          .eq("payment_intent_id", request.paymentIntentId)
          .order("created_at", { ascending: false })
          .limit(request.limit);

        if (tenantContext) {
          query = query.eq("tenant_id", tenantContext.tenantId);
        }
        const { data, error } = await query;

        if (error) {
          throw new Error(`Failed to list payment events for ${request.paymentIntentId}: ${error.message}`);
        }

        return (data ?? []).map(toPaymentEventRecord);
      },
    },
    paymentReviews: {
      async createPaymentReviewHandoff(record: PaymentReviewHandoffRecord): Promise<void> {
        assertTenantId(tenantContext, record.tenantId);
        if (tenantContext) {
          assertWalletOwnership(tenantContext, record.ownerAddress, record.accountAddress);
        }
        const { error } = await client.from("payment_review_handoffs").insert(toPaymentReviewHandoffRow(record));
        if (error) {
          throw new Error(`Failed to create payment review handoff ${record.id}: ${error.message}`);
        }
      },
      async getPaymentReviewHandoffByTokenDigest(tokenDigest: string): Promise<PaymentReviewHandoffRecord | null> {
        let query = client.from("payment_review_handoffs").select("*").eq("token_digest", tokenDigest);
        if (tenantContext) {
          query = query
            .eq("tenant_id", tenantContext.tenantId)
            .eq("owner_address", tenantContext.ownerAddress)
            .eq("account_address", tenantContext.accountAddress);
        }
        const { data, error } = await query.maybeSingle();
        if (error) {
          throw new Error("Failed to load payment review handoff.");
        }
        return data ? toPaymentReviewHandoff(data) : null;
      },
      async getPaymentReviewHandoff(paymentIntentId: string): Promise<PaymentReviewHandoffRecord | null> {
        let query = client.from("payment_review_handoffs").select("*").eq("payment_intent_id", paymentIntentId);
        if (tenantContext) {
          query = query
            .eq("tenant_id", tenantContext.tenantId)
            .eq("owner_address", tenantContext.ownerAddress)
            .eq("account_address", tenantContext.accountAddress);
        }
        const { data, error } = await query.maybeSingle();
        if (error) {
          throw new Error(`Failed to load payment review for ${paymentIntentId}.`);
        }
        return data ? toPaymentReviewHandoff(data) : null;
      },
      async attachPaymentReviewSignature(input): Promise<{ status: "SIGNED" | "ALREADY_SIGNED" | "CONFLICT"; signature?: string }> {
        let query = client
          .from("payment_review_handoffs")
          .update({
            status: "SIGNED",
            signature: input.signature,
            signed_at: input.signedAt,
          })
          .eq("token_digest", input.tokenDigest)
          .eq("status", "PENDING")
          .gt("expires_at", input.signedAt)
          .select("*");
        if (tenantContext) {
          query = query
            .eq("tenant_id", tenantContext.tenantId)
            .eq("owner_address", tenantContext.ownerAddress)
            .eq("account_address", tenantContext.accountAddress);
        }
        const { data, error } = await query.maybeSingle();
        if (error) {
          throw new Error("Failed to save the payment signature.");
        }
        if (data) {
          return { status: "SIGNED" };
        }

        const existing = await this.getPaymentReviewHandoffByTokenDigest(input.tokenDigest);
        if (existing?.status === "SIGNED") {
          return existing.signature === input.signature
            ? { status: "ALREADY_SIGNED", signature: existing.signature }
            : { status: "CONFLICT" };
        }
        return { status: "CONFLICT" };
      },
    },
    paidExecutionLifecycle: createPaidExecutionLifecycleRepository(client, tenantContext),
    paidExecutionChallenge: createPaidExecutionChallengeRepository(client, tenantContext),
    invoiceExecutionOutbox: createInvoiceExecutionOutboxRepository(client, tenantContext),
    canaryLedger: createCanaryLedgerRepository(client, tenantContext),
    authChallenges: {
      async create(record: SiweChallenge): Promise<void> {
        const { error } = await client.from("auth_challenges").insert(toAuthChallengeRow(record));
        if (error) {
          throw new Error(`Failed to create auth challenge ${record.challengeId}: ${error.message}`);
        }
      },
      async get(challengeId: string): Promise<SiweChallenge | null> {
        const { data, error } = await client.from("auth_challenges").select("*").eq("id", challengeId).maybeSingle();
        if (error) {
          throw new Error(`Failed to load auth challenge ${challengeId}: ${error.message}`);
        }
        return data ? toSiweChallenge(data) : null;
      },
      async consume(challengeId: string, consumedAt: string): Promise<boolean> {
        const { data, error } = await client
          .from("auth_challenges")
          .update({ consumed_at: consumedAt })
          .eq("id", challengeId)
          .is("consumed_at", null)
          .select("id")
          .maybeSingle();
        if (error) {
          throw new Error(`Failed to consume auth challenge ${challengeId}: ${error.message}`);
        }
        return Boolean(data);
      },
    },
    serviceSessions: {
      async create(record: ServiceSessionRecord): Promise<void> {
        const { error } = await client.from("service_sessions").insert(toServiceSessionRow(record));
        if (error) {
          throw new Error(`Failed to create service session ${record.sessionId}: ${error.message}`);
        }
      },
      async findByCredentialDigest(digest: string): Promise<ServiceSessionRecord | null> {
        const { data, error } = await client
          .from("service_sessions")
          .select("*")
          .eq("credential_digest", digest)
          .maybeSingle();
        if (error) {
          throw new Error("Failed to load consumer session.");
        }
        return data ? toServiceSessionRecord(data) : null;
      },
      async revoke(sessionId: string, revokedAt: string): Promise<void> {
        const { error } = await client.from("service_sessions").update({ revoked_at: revokedAt }).eq("id", sessionId);
        if (error) {
          throw new Error("Failed to revoke consumer session.");
        }
      },
      async revokeAll(tenantId: string, revokedAt: string): Promise<void> {
        const { error } = await client
          .from("service_sessions")
          .update({ revoked_at: revokedAt })
          .eq("tenant_id", tenantId)
          .is("revoked_at", null);
        if (error) {
          throw new Error("Failed to revoke consumer sessions.");
        }
      },
      async touch(sessionId: string, lastUsedAt: string): Promise<void> {
        const { error } = await client
          .from("service_sessions")
          .update({ last_used_at: lastUsedAt })
          .eq("id", sessionId)
          .is("revoked_at", null);
        if (error) {
          throw new Error("Failed to update consumer session activity.");
        }
      },
    },
    tenantBindings: {
      async resolveTenant(ownerAddress, accountAddress, chainId, environment): Promise<ResolvedTenantBinding> {
        const normalizedOwner = ownerAddress.toLowerCase();
        const normalizedAccount = accountAddress.toLowerCase();
        const identity = await client
          .from("verified_owner_identities")
          .select("tenant_id, owner_address, status")
          .eq("owner_address", normalizedOwner)
          .eq("status", "VERIFIED")
          .maybeSingle();
        if (identity.error || !identity.data) {
          throw new AgentPayAuthError("TENANT_BINDING_REQUIRED", "Owner identity is not verified for AgentPay.");
        }

        const tenantState = await getTenantState(client, identity.data.tenant_id);
        if (tenantState.status !== "ACTIVE" || (environment && tenantState.environment !== environment)) {
          throw new AgentPayAuthError("AUTH_ENVIRONMENT_MISMATCH", "Consumer tenant is not active for this environment.");
        }

        const wallet = await client
          .from("agent_wallets")
          .select("account_address, owner_address, home_chain_id, status")
          .eq("tenant_id", identity.data.tenant_id)
          .eq("owner_address", normalizedOwner)
          .eq("account_address", normalizedAccount)
          .eq("home_chain_id", chainId)
          .eq("status", "ACTIVE")
          .maybeSingle();
        if (wallet.error || !wallet.data) {
          throw new AgentPayAuthError("TENANT_ACCOUNT_MISMATCH", "AgentPay account is not bound to the verified owner.");
        }

        return {
          tenantId: identity.data.tenant_id,
          authenticationEpoch: tenantState.authenticationEpoch,
          environment: tenantState.environment,
        };
      },
      async getAuthenticationEpoch(tenantId): Promise<number> {
        const state = await getTenantState(client, tenantId);
        if (state.status !== "ACTIVE") {
          throw new AgentPayAuthError("AUTH_TENANT_INACTIVE", "Consumer tenant is not active.");
        }
        return state.authenticationEpoch;
      },
      async getTenantState(tenantId) {
        return getTenantState(client, tenantId);
      },
      async bindVerifiedOwner(ownerAddress, chainId): Promise<ResolvedTenantBinding> {
        if (chainId !== 196 && chainId !== 1952) {
          throw new AgentPayAuthError("SIWE_CHAIN_INVALID", "Owner tenant binding requires an X Layer chain.");
        }
        const normalizedOwner = ownerAddress.toLowerCase();
        const environment: SessionEnvironment = chainId === 196 ? "production" : "staging";
        const existing = await client
          .from("verified_owner_identities")
          .select("tenant_id, owner_address, status")
          .eq("owner_address", normalizedOwner)
          .eq("status", "VERIFIED")
          .maybeSingle();
        if (existing.error) {
          throw new AgentPayAuthError("TENANT_BINDING_FAILED", "Owner tenant binding failed.");
        }
        if (existing.data) {
          const state = await getTenantState(client, existing.data.tenant_id);
          if (existing.data.status !== "VERIFIED" || state.status !== "ACTIVE" || state.environment !== environment) {
            throw new AgentPayAuthError("TENANT_BINDING_FAILED", "Owner identity is not active for this environment.");
          }
          return {
            tenantId: existing.data.tenant_id,
            authenticationEpoch: state.authenticationEpoch,
            environment: state.environment,
          };
        }

        const tenantId = randomUUID();
        const tenantInsert = await client.from("tenants").insert({
          id: tenantId,
          environment,
          status: "ACTIVE",
          auth_epoch: 0,
        });
        if (tenantInsert.error) {
          throw new AgentPayAuthError("TENANT_BINDING_FAILED", "Owner tenant binding failed.");
        }
        const identityInsert = await client.from("verified_owner_identities").insert({
          tenant_id: tenantId,
          owner_address: normalizedOwner,
          status: "VERIFIED",
        });
        if (identityInsert.error) {
          throw new AgentPayAuthError("TENANT_BINDING_FAILED", "Owner identity binding failed.");
        }
        return { tenantId, authenticationEpoch: 0, environment };
      },
    },
    runtimeEnvironment: {
      async getIdentity(): Promise<RuntimeEnvironmentIdentity | null> {
        const { data, error } = await client
          .from("runtime_environment_identity")
          .select("*")
          .eq("id", 1)
          .maybeSingle();
        if (error) {
          throw new Error(`Failed to load runtime environment identity: ${error.message}`);
        }
        return data ? toRuntimeEnvironmentIdentity(data) : null;
      },
    },
  };
}

function createPaidExecutionLifecycleRepository(
  client: AgentPaySupabaseClient,
  tenantContext?: SessionContext,
): PaidExecutionLifecycleStore {
  const scopeQuery = (query: SupabaseSelectQuery<PaidExecutionLifecycleRow>) =>
    tenantContext ? query.eq("tenant_id", tenantContext.tenantId) : query;
  const scopeUpdate = (query: SupabaseUpdateBuilder<PaidExecutionLifecycleRow>) =>
    tenantContext ? query.eq("tenant_id", tenantContext.tenantId) : query;

  return {
    async claim(input: PaidExecutionLifecycleClaimInput): Promise<PaidExecutionLifecycleClaim> {
      if (tenantContext && input.tenantId && input.tenantId !== tenantContext.tenantId) {
        throw new AgentPayAuthError("TENANT_RESOURCE_MISMATCH", "Paid lifecycle tenant does not match the consumer session.");
      }
      const idempotencyKey = createPaidExecutionIdempotencyKey({
        paymentPayloadHash: input.paymentPayloadHash,
        paymentIdentifier: input.paymentIdentifier,
        tenantId: tenantContext?.tenantId ?? input.tenantId,
      });
      const row = toPaidExecutionLifecycleRow(input, idempotencyKey, tenantContext);
      const inserted = await client.from("paid_execution_lifecycles").insert(row);
      if (!inserted.error) {
        return { disposition: "CLAIMED", record: toPaidExecutionLifecycleRecord(row as unknown as PaidExecutionLifecycleRow) };
      }

      const tenantId = tenantContext?.tenantId ?? input.tenantId;
      if (!tenantId) {
        throw new Error("Paid execution lifecycle requires a tenant binding.");
      }
      const existing = await findExistingPaidLifecycle(client, scopeQuery, tenantId, idempotencyKey, input);
      if (existing.error || !existing.data) {
        throw new Error(`Failed to claim paid execution lifecycle ${input.id}: ${inserted.error.message}`);
      }
      const record = toPaidExecutionLifecycleRecord(existing.data);
      return {
        disposition: hasSameLifecycleBinding(record, input) ? "REPLAY" : "CONFLICT",
        record,
      };
    },
    async markSettling(id, at) {
      return updatePaidExecutionLifecycle(client, scopeUpdate, id, { status: "SETTLING", updated_at: at }, "CLAIMED");
    },
    async markSettled(id, input) {
      return updatePaidExecutionLifecycle(client, scopeUpdate, id, {
        status: "SETTLED",
        fee_status: "SETTLED",
        settlement_tx_hash: input.transaction,
        settlement_headers: input.headers,
        settled_at: input.at,
        updated_at: input.at,
      }, "SETTLING");
    },
    async markSettlementUnknown(id, errorCode, errorMessage, at) {
      return updatePaidExecutionLifecycle(client, scopeUpdate, id, {
        status: "FAILED",
        fee_status: "SETTLEMENT_UNKNOWN",
        error_code: errorCode,
        error_message: errorMessage,
        updated_at: at,
      }, "SETTLING");
    },
    async markSettlementRejected(id, errorCode, errorMessage, at) {
      return updatePaidExecutionLifecycle(client, scopeUpdate, id, {
        status: "FAILED",
        fee_status: "SETTLEMENT_REJECTED",
        error_code: errorCode,
        error_message: errorMessage,
        updated_at: at,
      }, "SETTLING");
    },
    async markExecuting(id, at) {
      return updatePaidExecutionLifecycle(client, scopeUpdate, id, {
        status: "EXECUTING",
        execution_status: "QUEUED",
        updated_at: at,
      }, "SETTLED");
    },
    async markExecutionBroadcasted(id, txHash, at) {
      const current = await scopeQuery(client.from("paid_execution_lifecycles").select("*").eq("id", id)).maybeSingle();
      if (current.error || !current.data) {
        throw new Error(`Failed to load paid execution lifecycle ${id}.`);
      }
      if (["BROADCASTED", "CONFIRMED"].includes(current.data.execution_status ?? "")) {
        if (current.data.execution_tx_hash?.toLowerCase() === txHash.toLowerCase()) {
          return toPaidExecutionLifecycleRecord(current.data);
        }
        throw new Error(`Paid execution lifecycle ${id} is already bound to a different execution transaction.`);
      }
      if (
        !["EXECUTING", "COMPLETED"].includes(current.data.status) ||
        !["QUEUED", "TX_PREPARED", "BROADCAST_UNKNOWN"].includes(current.data.execution_status ?? "")
      ) {
        throw new Error(`Paid execution lifecycle ${id} cannot mark execution broadcasted from its current state.`);
      }
      const update = {
        execution_status: "BROADCASTED",
        execution_tx_hash: txHash,
        updated_at: at,
      };
      return updatePaidExecutionLifecycle(client, scopeUpdate, id, update, current.data.status);
    },
    async markExecutionReceipt(id, success, at) {
      const current = await scopeQuery(client.from("paid_execution_lifecycles").select("*").eq("id", id)).maybeSingle();
      if (current.error || !current.data) {
        throw new Error(`Failed to load paid execution lifecycle ${id}.`);
      }
      const terminalExecutionStatus = success ? "CONFIRMED" : "REVERTED";
      if (current.data.execution_status === terminalExecutionStatus) {
        return toPaidExecutionLifecycleRecord(current.data);
      }
      const update = success
        ? { execution_status: "CONFIRMED", updated_at: at }
        : {
            status: "FAILED",
            execution_status: "REVERTED",
            refund_status: "REQUIRED",
            error_code: "EXECUTION_REVERTED",
            error_message: "The executor transaction reverted on-chain.",
            updated_at: at,
          };
      try {
        return await updatePaidExecutionLifecycle(client, scopeUpdate, id, update, "EXECUTING");
      } catch {
        return updatePaidExecutionLifecycle(client, scopeUpdate, id, update, "COMPLETED");
      }
    },
    async markExecutionPersistenceUnknown(id, errorCode, errorMessage, at) {
      const current = await scopeQuery(client.from("paid_execution_lifecycles").select("*").eq("id", id)).maybeSingle();
      if (current.error || !current.data || !["EXECUTING", "COMPLETED"].includes(current.data.status)) {
        throw new Error(`Failed to load paid execution lifecycle ${id}.`);
      }
      const update = {
        execution_status: "BROADCAST_UNKNOWN",
        error_code: errorCode,
        error_message: errorMessage,
        updated_at: at,
      };
      return updatePaidExecutionLifecycle(client, scopeUpdate, id, update, current.data.status);
    },
    async markExecutionFailed(id, errorCode, errorMessage, at) {
      const update = {
        status: "FAILED",
        execution_status: "MANUAL_REVIEW",
        error_code: errorCode,
        error_message: errorMessage,
        updated_at: at,
      };
      try {
        return await updatePaidExecutionLifecycle(client, scopeUpdate, id, update, "EXECUTING");
      } catch {
        // If queue persistence failed immediately after fee settlement, the
        // row is still SETTLED. Move it to manual review instead of leaving a
        // replay permanently stuck in a non-terminal state.
        return updatePaidExecutionLifecycle(client, scopeUpdate, id, update, "SETTLED");
      }
    },
    async markRefundRequired(id, reason, at) {
      const update = {
        status: "FAILED",
        execution_status: "MANUAL_REVIEW",
        refund_status: "REQUIRED",
        error_code: "REFUND_REQUIRED",
        error_message: reason,
        updated_at: at,
      };
      try {
        return await updatePaidExecutionLifecycle(client, scopeUpdate, id, update, "EXECUTING");
      } catch {
        try {
          return await updatePaidExecutionLifecycle(client, scopeUpdate, id, update, "SETTLED");
        } catch {
          // A retry after the compensating transition may observe FAILED. The
          // refund obligation is idempotent and must not keep the reconciler
          // from fencing the corresponding outbox row.
          return updatePaidExecutionLifecycle(client, scopeUpdate, id, update, "FAILED");
        }
      }
    },
    async markCompleted(id, snapshot: PaidExecutionResponseSnapshot, at) {
      return updatePaidExecutionLifecycle(client, scopeUpdate, id, {
        status: "COMPLETED",
        response_status: snapshot.status,
        response_headers: snapshot.headers,
        response_body_base64: snapshot.body.toString("base64"),
        ...(snapshot.executionTxHash ? { execution_tx_hash: snapshot.executionTxHash } : {}),
        completed_at: at,
        updated_at: at,
      }, "EXECUTING");
    },
    async markFailed(id, errorCode, errorMessage, at) {
      return updatePaidExecutionLifecycle(client, scopeUpdate, id, {
        status: "FAILED",
        error_code: errorCode,
        error_message: errorMessage,
        updated_at: at,
      });
    },
  };
}

async function updatePaidExecutionLifecycle(
  client: AgentPaySupabaseClient,
  scopeUpdate: (query: SupabaseUpdateBuilder<PaidExecutionLifecycleRow>) => SupabaseUpdateBuilder<PaidExecutionLifecycleRow>,
  id: string,
  update: Record<string, unknown>,
  expectedStatus?: PaidExecutionLifecycleStatus,
): Promise<PaidExecutionLifecycleRecord> {
  let updateQuery = scopeUpdate(client.from("paid_execution_lifecycles").update(update).eq("id", id));
  if (expectedStatus) updateQuery = updateQuery.eq("status", expectedStatus);
  const query = updateQuery.select("*");
  const { data, error } = await query.maybeSingle();
  if (error || !data) {
    throw new Error(`Failed to update paid execution lifecycle ${id}${error ? `: ${error.message}` : "."}`);
  }
  return toPaidExecutionLifecycleRecord(data);
}

function toPaidExecutionLifecycleRow(
  input: PaidExecutionLifecycleClaimInput,
  idempotencyKey: string,
  tenantContext?: SessionContext,
): Record<string, unknown> {
  const tenantId = tenantContext?.tenantId ?? input.tenantId;
  if (!tenantId) {
    throw new Error("Paid execution lifecycle requires a tenant binding.");
  }
  return omitUndefined({
    id: input.id,
    tenant_id: tenantId,
    idempotency_key: idempotencyKey,
    payment_identifier: input.paymentIdentifier,
    payment_payload_hash: input.paymentPayloadHash,
    payment_requirements_hash: input.paymentRequirementsHash,
    request_hash: input.requestHash,
    tool_name: input.toolName,
    payment_intent_id: input.paymentIntentId,
    arguments_hash: input.argumentsHash,
    authorization_hash: input.authorizationHash,
    challenge_id: input.challengeId,
    environment: input.environment,
    payer: input.payer,
    status: "CLAIMED",
    fee_status: "ACCEPTED",
    execution_status: "NOT_QUEUED",
    refund_status: "NOT_REQUIRED",
    created_at: input.createdAt,
    updated_at: input.createdAt,
  });
}

function toPaidExecutionLifecycleRecord(row: PaidExecutionLifecycleRow): PaidExecutionLifecycleRecord {
  return {
    id: row.id,
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    idempotencyKey: row.idempotency_key,
    ...(row.payment_identifier ? { paymentIdentifier: row.payment_identifier } : {}),
    paymentPayloadHash: row.payment_payload_hash,
    paymentRequirementsHash: row.payment_requirements_hash,
    requestHash: row.request_hash,
    toolName: row.tool_name,
    paymentIntentId: row.payment_intent_id,
    argumentsHash: row.arguments_hash,
    ...(row.authorization_hash ? { authorizationHash: row.authorization_hash } : {}),
    ...(row.challenge_id ? { challengeId: row.challenge_id } : {}),
    ...(row.environment ? { environment: row.environment } : {}),
    ...(row.payer ? { payer: row.payer } : {}),
    status: row.status,
    feeStatus: row.fee_status ?? defaultFeeStatusForLifecycle(row.status),
    executionStatus: row.execution_status ?? defaultExecutionStatusForLifecycle(row.status),
    refundStatus: row.refund_status ?? "NOT_REQUIRED",
    ...(row.settlement_tx_hash ? { settlementTxHash: row.settlement_tx_hash } : {}),
    ...(row.settlement_headers ? { settlementHeaders: row.settlement_headers } : {}),
    ...(row.response_status !== null ? { responseStatus: row.response_status } : {}),
    ...(row.response_headers ? { responseHeaders: row.response_headers } : {}),
    ...(row.response_body_base64 ? { responseBodyBase64: row.response_body_base64 } : {}),
    ...(row.execution_tx_hash ? { executionTxHash: row.execution_tx_hash } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.settled_at ? { settledAt: row.settled_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

async function findExistingPaidLifecycle(
  client: AgentPaySupabaseClient,
  scopeQuery: (query: SupabaseSelectQuery<PaidExecutionLifecycleRow>) => SupabaseSelectQuery<PaidExecutionLifecycleRow>,
  tenantId: string,
  idempotencyKey: string,
  input: PaidExecutionLifecycleClaimInput,
): Promise<SupabaseQueryResult<PaidExecutionLifecycleRow>> {
  const byIdempotency = await scopeQuery(
    client
      .from("paid_execution_lifecycles")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("idempotency_key", idempotencyKey),
  ).maybeSingle();
  if (byIdempotency.data || byIdempotency.error) return byIdempotency;

  if (input.paymentIdentifier) {
    const byPaymentIdentifier = await scopeQuery(
      client
        .from("paid_execution_lifecycles")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("payment_identifier", input.paymentIdentifier),
    ).maybeSingle();
    if (byPaymentIdentifier.data || byPaymentIdentifier.error) return byPaymentIdentifier;
  } else {
    const byPaymentPayload = await scopeQuery(
      client
        .from("paid_execution_lifecycles")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("payment_payload_hash", input.paymentPayloadHash),
    ).maybeSingle();
    if (byPaymentPayload.data || byPaymentPayload.error) return byPaymentPayload;
  }

  const byIntent = await scopeQuery(
    client
      .from("paid_execution_lifecycles")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("payment_intent_id", input.paymentIntentId),
  ).maybeSingle();
  if (byIntent.data || byIntent.error || !input.authorizationHash) return byIntent;

  return scopeQuery(
    client
      .from("paid_execution_lifecycles")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("authorization_hash", input.authorizationHash),
  ).maybeSingle();
}

function defaultFeeStatusForLifecycle(status: PaidExecutionLifecycleStatus): PaidExecutionLifecycleRecord["feeStatus"] {
  if (status === "SETTLING") return "SETTLING";
  if (status === "SETTLED" || status === "EXECUTING" || status === "COMPLETED") return "SETTLED";
  return "ACCEPTED";
}

function defaultExecutionStatusForLifecycle(status: PaidExecutionLifecycleStatus): PaidExecutionLifecycleRecord["executionStatus"] {
  if (status === "EXECUTING") return "QUEUED";
  if (status === "COMPLETED") return "BROADCASTED";
  return "NOT_QUEUED";
}

function createPaidExecutionChallengeRepository(
  client: AgentPaySupabaseClient,
  tenantContext?: SessionContext,
): PaidExecutionChallengeStore {
  const scope = (query: SupabaseSelectQuery<AspPaymentChallengeRow>) =>
    tenantContext ? query.eq("tenant_id", tenantContext.tenantId) : query;
  const scopeUpdate = (query: SupabaseUpdateBuilder<AspPaymentChallengeRow>) =>
    tenantContext ? query.eq("tenant_id", tenantContext.tenantId) : query;

  return {
    async offer(input: PaidExecutionChallengeOfferInput): Promise<PaidExecutionChallengeOffer> {
      assertChallengeTenant(tenantContext, input.tenantId);
      const row = toPaidExecutionChallengeRow(input);
      const inserted = await client.from("asp_payment_challenges").insert(row);
      if (!inserted.error) return { disposition: "OFFERED", record: toPaidExecutionChallengeRecord(row as unknown as AspPaymentChallengeRow) };

      const existing = await scope(
        client
          .from("asp_payment_challenges")
          .select("*")
          .eq("tenant_id", input.tenantId)
          .eq("request_hash", input.requestHash)
          .eq("authorization_hash", input.authorizationHash)
          .eq("fee_terms_hash", input.feeTermsHash),
      ).maybeSingle();
      if (existing.error || !existing.data) throw new Error(`Failed to offer paid challenge: ${inserted.error.message}`);
      const record = toPaidExecutionChallengeRecord(existing.data);
      return {
        disposition: samePaidChallenge(record, input) ? "REPLAY" : "CONFLICT",
        record,
      };
    },
    async consume(input) {
      const existing = await scope(
        client
          .from("asp_payment_challenges")
          .select("*")
          .eq("tenant_id", input.tenantId)
          .eq("request_hash", input.requestHash)
          .eq("arguments_hash", input.argumentsHash)
          .eq("authorization_hash", input.authorizationHash)
          .eq("payment_requirements_hash", input.paymentRequirementsHash),
      ).maybeSingle();
      if (existing.error || !existing.data) return null;
      if (existing.data.status === "CONSUMED") return toPaidExecutionChallengeRecord(existing.data);
      if (existing.data.status !== "OFFERED" || Date.parse(existing.data.expires_at) <= Date.parse(input.at)) return null;
      const consumed = await scopeUpdate(
        client
          .from("asp_payment_challenges")
          .update({ status: "CONSUMED", consumed_at: input.at })
          .eq("id", existing.data.id)
          .eq("status", "OFFERED")
          .select("*"),
      ).maybeSingle();
      return consumed.data ? toPaidExecutionChallengeRecord(consumed.data) : null;
    },
    async expire(at) {
      const offered = await scope(
        client
          .from("asp_payment_challenges")
          .select("*")
          .eq("status", "OFFERED")
          .lt("expires_at", at),
      );
      const rows = offered.data ?? [];
      for (const row of rows) {
        await scopeUpdate(
          client.from("asp_payment_challenges").update({ status: "EXPIRED" }).eq("id", row.id),
        );
      }
      return rows.length;
    },
  };
}

interface CanaryUsageRpcRow {
  disposition?: "RESERVED" | "REPLAY";
  accepted_lifecycles: string | number;
  tenant_daily_atomic: string | number;
  global_daily_atomic: string | number;
  tenant_in_flight: string | number;
}

function createCanaryLedgerRepository(
  client: AgentPaySupabaseClient,
  tenantContext?: SessionContext,
): CanaryLedgerStore {
  return {
    async snapshot(input: CanaryLedgerSnapshotInput) {
      assertCanaryTenant(tenantContext, input.tenantId);
      const row = await callCanaryLedgerRpc<CanaryUsageRpcRow>(client, "get_paid_execution_canary_usage", {
        p_environment: input.environment,
        p_tenant_id: input.tenantId,
        p_at: input.at,
      });
      return toCanaryUsage(row);
    },
    async reserve(input: CanaryLedgerReserveInput) {
      assertCanaryTenant(tenantContext, input.tenantId);
      const amountAtomic = decimalToAtomic6(input.amount);
      const row = await callCanaryLedgerRpc<CanaryUsageRpcRow>(client, "reserve_paid_execution_canary", {
        p_environment: input.environment,
        p_reservation_key: input.reservationKey,
        p_lifecycle_id: input.lifecycleId,
        p_tenant_id: input.tenantId,
        p_payment_intent_id: input.paymentIntentId,
        p_amount_atomic: amountAtomic.toString(),
        p_at: input.at,
        p_max_accepted_lifecycles: input.caps.maxAcceptedLifecycles,
        p_max_invoice_atomic: input.caps.maxInvoiceAtomic.toString(),
        p_max_tenant_daily_atomic: input.caps.maxTenantDailyAtomic.toString(),
        p_max_global_daily_atomic: input.caps.maxGlobalDailyAtomic.toString(),
        p_max_in_flight_per_tenant: input.caps.maxInFlightPerTenant,
      });
      const disposition = row.disposition ?? "RESERVED";
      if (disposition !== "RESERVED" && disposition !== "REPLAY") {
        throw new Error("Canary ledger returned an invalid reservation disposition.");
      }
      return {
        disposition,
        usage: toCanaryUsage(row),
      };
    },
    async complete(input) {
      assertCanaryTenant(tenantContext, input.tenantId);
      const row = await callCanaryLedgerRpc<CanaryUsageRpcRow>(client, "complete_paid_execution_canary", {
        p_environment: input.environment,
        p_reservation_key: input.reservationKey,
        p_tenant_id: input.tenantId,
        p_at: input.at,
      });
      return toCanaryUsage(row);
    },
  };
}

async function callCanaryLedgerRpc<T>(
  client: AgentPaySupabaseClient,
  functionName: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.rpc<T>(functionName, args);
  if (result.error || !result.data) {
    throw toCanaryLedgerError(result.error?.message ?? `Canary ledger RPC ${functionName} returned no data.`);
  }
  return result.data;
}

function toCanaryLedgerError(message: string): Error {
  const match = /^((?:CANARY|PAID_CANARY)_[A-Z0-9_]+):?\s*(.*)$/i.exec(message.trim());
  if (match) {
    const code = match[1].toUpperCase();
    const detail = match[2] || "Canary admission was rejected.";
    if (code.startsWith("CANARY_")) return new CanaryPolicyError(code, detail);
  }
  return new Error(`Canary ledger unavailable: ${message}`);
}

function toCanaryUsage(row: CanaryUsageRpcRow): {
  acceptedLifecycles: number;
  tenantDailyAtomic: bigint;
  globalDailyAtomic: bigint;
  tenantInFlight: number;
} {
  const acceptedLifecycles = parseSafeInteger(row.accepted_lifecycles, "accepted_lifecycles");
  const tenantDailyAtomic = parseAtomic(row.tenant_daily_atomic, "tenant_daily_atomic");
  const globalDailyAtomic = parseAtomic(row.global_daily_atomic, "global_daily_atomic");
  const tenantInFlight = parseSafeInteger(row.tenant_in_flight, "tenant_in_flight");
  return { acceptedLifecycles, tenantDailyAtomic, globalDailyAtomic, tenantInFlight };
}

function parseAtomic(value: string | number, field: string): bigint {
  try {
    const parsed = BigInt(String(value));
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(`Canary ledger returned an invalid ${field}.`);
  }
}

function parseSafeInteger(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Canary ledger returned an invalid ${field}.`);
  }
  return parsed;
}

function assertCanaryTenant(tenantContext: SessionContext | undefined, tenantId: string): void {
  if (!tenantId) throw new Error("Canary ledger requires a tenant binding.");
  if (tenantContext && tenantContext.tenantId !== tenantId) {
    throw new AgentPayAuthError("TENANT_RESOURCE_MISMATCH", "Canary ledger tenant does not match the consumer session.");
  }
}

function createInvoiceExecutionOutboxRepository(
  client: AgentPaySupabaseClient,
  tenantContext?: SessionContext,
): InvoiceExecutionOutboxStore {
  const scope = (query: SupabaseSelectQuery<InvoiceExecutionOutboxRow>) =>
    tenantContext ? query.eq("tenant_id", tenantContext.tenantId) : query;
  const scopeUpdate = (query: SupabaseUpdateBuilder<InvoiceExecutionOutboxRow>) =>
    tenantContext ? query.eq("tenant_id", tenantContext.tenantId) : query;

  return {
    async get(id) {
      const result = await scope(client.from("invoice_execution_outbox").select("*").eq("id", id)).maybeSingle();
      if (result.error) throw new Error(`Failed to load invoice execution outbox ${id}.`);
      return result.data ? toInvoiceExecutionOutboxRecord(result.data) : null;
    },
    async listRecoverable(at) {
      const statuses: InvoiceExecutionOutboxStatus[] = ["QUEUED", "TX_PREPARED", "BROADCAST_UNKNOWN", "BROADCASTED"];
      const results = await Promise.all(statuses.map((status) => scope(
        client.from("invoice_execution_outbox").select("*").eq("status", status),
      )));
      const cutoff = Date.parse(at);
      return results
        .flatMap((result) => (result.data ?? []).map(toInvoiceExecutionOutboxRecord))
        .filter((record) => !record.leaseUntil || !Number.isFinite(cutoff) || Date.parse(record.leaseUntil) <= cutoff);
    },
    async claimRecoverable(id, at, leaseUntil) {
      const current = await scope(client.from("invoice_execution_outbox").select("*").eq("id", id)).maybeSingle();
      if (current.error || !current.data) throw new Error(`Invoice execution outbox ${id} was not found.`);
      if (!["QUEUED", "BROADCAST_UNKNOWN", "BROADCASTED"].includes(current.data.status)) return null;
      if (current.data.lease_until && Date.parse(current.data.lease_until) > Date.parse(at)) return null;

      const fencingToken = randomUUID();
      let updateQuery = scopeUpdate(
        client.from("invoice_execution_outbox").update({
          lease_until: leaseUntil,
          fencing_token: fencingToken,
          updated_at: at,
        }).eq("id", id).eq("status", current.data.status),
      );
      if (current.data.lease_until) updateQuery = updateQuery.eq("lease_until", current.data.lease_until);
      else updateQuery = updateQuery.is("lease_until", null);
      if (current.data.fencing_token) updateQuery = updateQuery.eq("fencing_token", current.data.fencing_token);
      else updateQuery = updateQuery.is("fencing_token", null);
      const claimed = await updateQuery.select("*").maybeSingle();
      if (claimed.error || !claimed.data) return null;
      return toInvoiceExecutionOutboxRecord(claimed.data);
    },
    async enqueue(input: InvoiceExecutionOutboxInput) {
      assertChallengeTenant(tenantContext, input.tenantId);
      const row = toInvoiceExecutionOutboxRow(input);
      const inserted = await client.from("invoice_execution_outbox").insert(row);
      if (!inserted.error) return { disposition: "QUEUED", record: toInvoiceExecutionOutboxRecord(row as unknown as InvoiceExecutionOutboxRow) };
      const existing = await scope(
        client.from("invoice_execution_outbox").select("*").eq("tenant_id", input.tenantId).eq("lifecycle_id", input.lifecycleId),
      ).maybeSingle();
      if (existing.error || !existing.data) throw new Error(`Failed to enqueue invoice execution: ${inserted.error.message}`);
      const record = toInvoiceExecutionOutboxRecord(existing.data);
      return record.paymentIntentId === input.paymentIntentId
        ? { disposition: "REPLAY", record }
        : { disposition: "CONFLICT", record };
    },
    async prepare(id, input) {
      const current = await scope(client.from("invoice_execution_outbox").select("*").eq("id", id)).maybeSingle();
      if (current.error || !current.data) throw new Error(`Invoice execution outbox ${id} was not found.`);
      if (current.data.status !== "QUEUED") {
        throw new Error(`Invoice execution outbox ${id} cannot be prepared from ${current.data.status}.`);
      }
      return updateInvoiceExecutionOutbox(client, scopeUpdate, id, {
        status: "TX_PREPARED",
        executor_nonce: input.executorNonce,
        transaction_hash: input.transactionHash,
        calldata_hash: input.calldataHash,
        owner_authorization_nonce: input.ownerAuthorizationNonce,
        raw_tx_ciphertext: input.rawTransaction.ciphertext,
        raw_tx_iv: input.rawTransaction.iv,
        raw_tx_tag: input.rawTransaction.tag,
        raw_tx_hash: input.rawTransaction.hash,
        fencing_token: current.data.fencing_token ?? randomUUID(),
        updated_at: input.at,
      }, current.data.status, current.data.fencing_token ?? undefined);
    },
    async markBroadcastUnknown(id, at, fencingToken) {
      const current = await scope(client.from("invoice_execution_outbox").select("*").eq("id", id)).maybeSingle();
      if (current.error || !current.data) throw new Error(`Invoice execution outbox ${id} was not found.`);
      if (!["TX_PREPARED", "BROADCAST_UNKNOWN"].includes(current.data.status)) {
        throw new Error(`Invoice execution outbox ${id} cannot enter BROADCAST_UNKNOWN from ${current.data.status}.`);
      }
      return updateInvoiceExecutionOutbox(client, scopeUpdate, id, {
        status: "BROADCAST_UNKNOWN",
        attempt_count: current.data.attempt_count + 1,
        updated_at: at,
      }, current.data.status, fencingToken ?? current.data.fencing_token ?? undefined);
    },
    async markBroadcasted(id, txHash, at, fencingToken) {
      const current = await scope(client.from("invoice_execution_outbox").select("*").eq("id", id)).maybeSingle();
      if (current.error || !current.data) throw new Error(`Invoice execution outbox ${id} was not found.`);
      if (current.data.transaction_hash?.toLowerCase() !== txHash.toLowerCase()) {
        throw new Error("Broadcast hash does not match the persisted signed transaction.");
      }
      if (current.data.status === "BROADCASTED") return toInvoiceExecutionOutboxRecord(current.data);
      if (!["TX_PREPARED", "BROADCAST_UNKNOWN"].includes(current.data.status)) {
        throw new Error(`Invoice execution outbox ${id} cannot enter BROADCASTED from ${current.data.status}.`);
      }
      return updateInvoiceExecutionOutbox(client, scopeUpdate, id, { status: "BROADCASTED", transaction_hash: txHash, broadcast_at: at, updated_at: at }, current.data.status, fencingToken ?? current.data.fencing_token ?? undefined);
    },
    async markReceipt(id, success, at, fencingToken) {
      const current = await scope(client.from("invoice_execution_outbox").select("*").eq("id", id)).maybeSingle();
      if (current.error || !current.data) throw new Error(`Invoice execution outbox ${id} was not found.`);
      const terminalStatus = success ? "CONFIRMED" : "REVERTED";
      if (current.data.status === terminalStatus && current.data.receipt_status === (success ? 1 : 0)) {
        return toInvoiceExecutionOutboxRecord(current.data);
      }
      if (!["BROADCASTED", "BROADCAST_UNKNOWN"].includes(current.data.status)) {
        throw new Error(`Invoice execution outbox ${id} cannot finalize from ${current.data.status}.`);
      }
      return updateInvoiceExecutionOutbox(client, scopeUpdate, id, {
        status: terminalStatus,
        receipt_status: success ? 1 : 0,
        confirmed_at: at,
        lease_until: null,
        updated_at: at,
      }, current.data.status, fencingToken ?? current.data.fencing_token ?? undefined);
    },
    async markManualReview(id, code, message, at, fencingToken) {
      const current = await scope(client.from("invoice_execution_outbox").select("*").eq("id", id)).maybeSingle();
      if (current.error || !current.data) throw new Error(`Invoice execution outbox ${id} was not found.`);
      if (["CONFIRMED", "REVERTED"].includes(current.data.status)) {
        throw new Error(`Invoice execution outbox ${id} is already terminal.`);
      }
      return updateInvoiceExecutionOutbox(client, scopeUpdate, id, {
        status: "MANUAL_REVIEW",
        error_code: code,
        error_message: message,
        lease_until: null,
        updated_at: at,
      }, current.data.status, fencingToken ?? current.data.fencing_token ?? undefined);
    },
  };
}

async function updateInvoiceExecutionOutbox(
  client: AgentPaySupabaseClient,
  scopeUpdate: (query: SupabaseUpdateBuilder<InvoiceExecutionOutboxRow>) => SupabaseUpdateBuilder<InvoiceExecutionOutboxRow>,
  id: string,
  update: Record<string, unknown>,
  expectedStatus?: InvoiceExecutionOutboxStatus,
  expectedFencingToken?: string,
): Promise<InvoiceExecutionOutboxRecord> {
  let updateQuery = scopeUpdate(client.from("invoice_execution_outbox").update(update).eq("id", id));
  if (expectedStatus) updateQuery = updateQuery.eq("status", expectedStatus);
  if (expectedFencingToken) updateQuery = updateQuery.eq("fencing_token", expectedFencingToken);
  const result = await updateQuery.select("*")
    .maybeSingle();
  if (result.error || !result.data) throw new Error(`Failed to update invoice execution outbox ${id}.`);
  return toInvoiceExecutionOutboxRecord(result.data);
}

function assertChallengeTenant(tenantContext: SessionContext | undefined, tenantId: string): void {
  if (tenantContext && tenantContext.tenantId !== tenantId) {
    throw new AgentPayAuthError("TENANT_RESOURCE_MISMATCH", "Paid execution record does not match the consumer session.");
  }
  if (!tenantId) throw new Error("Paid execution records require a tenant binding.");
}

function toPaidExecutionChallengeRow(input: PaidExecutionChallengeOfferInput): Record<string, unknown> {
  return {
    id: input.id ?? randomUUID(),
    tenant_id: input.tenantId,
    environment: input.environment,
    payment_intent_id: input.paymentIntentId,
    owner_address: input.ownerAddress.toLowerCase(),
    account_address: input.accountAddress.toLowerCase(),
    request_hash: input.requestHash,
    arguments_hash: input.argumentsHash,
    authorization_hash: input.authorizationHash,
    fee_terms_hash: input.feeTermsHash,
    payment_requirements_hash: input.paymentRequirementsHash,
    status: "OFFERED",
    offered_at: input.offeredAt,
    expires_at: input.expiresAt,
  };
}

function toPaidExecutionChallengeRecord(row: AspPaymentChallengeRow): PaidExecutionChallengeRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    environment: row.environment,
    paymentIntentId: row.payment_intent_id,
    ownerAddress: row.owner_address,
    accountAddress: row.account_address,
    requestHash: row.request_hash,
    argumentsHash: row.arguments_hash,
    authorizationHash: row.authorization_hash,
    feeTermsHash: row.fee_terms_hash,
    paymentRequirementsHash: row.payment_requirements_hash,
    status: row.status,
    offeredAt: row.offered_at,
    expiresAt: row.expires_at,
    ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
  };
}

function samePaidChallenge(record: PaidExecutionChallengeRecord, input: PaidExecutionChallengeOfferInput): boolean {
  return record.paymentIntentId === input.paymentIntentId &&
    record.argumentsHash === input.argumentsHash &&
    record.paymentRequirementsHash === input.paymentRequirementsHash;
}

function toInvoiceExecutionOutboxRow(input: InvoiceExecutionOutboxInput): Record<string, unknown> {
  return {
    id: input.id,
    tenant_id: input.tenantId,
    lifecycle_id: input.lifecycleId,
    payment_intent_id: input.paymentIntentId,
    status: "QUEUED",
    chain_id: input.chainId,
    executor_address: input.executorAddress.toLowerCase(),
    attempt_count: 0,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  };
}

function toInvoiceExecutionOutboxRecord(row: InvoiceExecutionOutboxRow): InvoiceExecutionOutboxRecord {
  const rawTransaction: EncryptedRawTransaction | undefined =
    row.raw_tx_ciphertext && row.raw_tx_iv && row.raw_tx_tag
      ? {
          ciphertext: row.raw_tx_ciphertext,
          iv: row.raw_tx_iv,
          tag: row.raw_tx_tag,
          hash: row.raw_tx_hash ?? "",
        }
      : undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    lifecycleId: row.lifecycle_id,
    paymentIntentId: row.payment_intent_id,
    status: row.status,
    chainId: row.chain_id,
    executorAddress: row.executor_address,
    ...(row.executor_nonce !== null ? { executorNonce: row.executor_nonce } : {}),
    ...(row.transaction_hash ? { transactionHash: row.transaction_hash } : {}),
    ...(row.calldata_hash ? { calldataHash: row.calldata_hash } : {}),
    ...(row.owner_authorization_nonce ? { ownerAuthorizationNonce: row.owner_authorization_nonce } : {}),
    ...(rawTransaction ? { rawTransaction } : {}),
    ...(row.lease_until ? { leaseUntil: row.lease_until } : {}),
    ...(row.fencing_token ? { fencingToken: row.fencing_token } : {}),
    attemptCount: row.attempt_count,
    ...(row.broadcast_at ? { broadcastAt: row.broadcast_at } : {}),
    ...(row.confirmed_at ? { confirmedAt: row.confirmed_at } : {}),
    ...(row.receipt_status !== null ? { receiptStatus: row.receipt_status } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hasSameLifecycleBinding(record: PaidExecutionLifecycleRecord, input: PaidExecutionLifecycleClaimInput): boolean {
  return (
    record.paymentPayloadHash === input.paymentPayloadHash &&
    record.paymentRequirementsHash === input.paymentRequirementsHash &&
    record.requestHash === input.requestHash &&
    record.toolName === input.toolName &&
    record.paymentIntentId === input.paymentIntentId &&
    record.argumentsHash === input.argumentsHash &&
    (record.authorizationHash ?? null) === (input.authorizationHash ?? null) &&
    (record.challengeId ?? null) === (input.challengeId ?? null)
  );
}

function toRuntimeEnvironmentIdentity(row: RuntimeEnvironmentIdentityRow): RuntimeEnvironmentIdentity {
  return {
    id: row.id,
    environment: row.environment,
    chainId: row.chain_id,
    caip2: row.caip2,
    supabaseProjectRef: row.supabase_project_ref,
    migrationHead: row.migration_head,
    releaseCommit: row.release_commit,
    manifestSha256: row.manifest_sha256,
    accountVersion: row.account_version,
    accountAddress: row.account_address,
    deploymentTxHash: row.deployment_tx_hash,
    creationBytecodeHash: row.creation_bytecode_hash,
    runtimeBytecodeHash: row.runtime_bytecode_hash,
    abiSha256: row.abi_sha256,
    ownerAddress: row.owner_address,
    executorAddress: row.executor_address,
    deployerAddress: row.deployer_address,
    eip712VerifyingContract: row.eip712_verifying_contract,
    tokenAddress: row.token_address,
    tokenCodeHash: row.token_code_hash,
    tokenDecimals: row.token_decimals,
    x402Network: row.x402_network,
    x402Asset: row.x402_asset,
    x402Price: row.x402_price,
    x402PriceAtomic: row.x402_price_atomic,
    x402SyncSettle: row.x402_sync_settle,
    x402Enabled: row.x402_enabled,
    payToAddress: row.pay_to_address,
    facilitatorRef: row.facilitator_ref,
    publicOrigin: row.public_origin,
    executionMode: row.execution_mode,
    status: row.status,
  };
}

function toSetupIntentRow(intent: SetupIntentRecord, tenantContext?: SessionContext): Record<string, unknown> {
  return omitUndefined({
    tenant_id: tenantContext?.tenantId ?? intent.tenantId,
    id: intent.id,
    owner_address: intent.ownerAddress?.toLowerCase(),
    executor_address: intent.executorAddress,
    message_to_sign: intent.messageToSign,
    signature: intent.signature,
    status: intent.status,
    expires_at: intent.expiresAt,
    account_address: intent.accountAddress?.toLowerCase(),
    error_code: intent.errorCode,
    error_message: intent.errorMessage,
    completed_at: intent.completedAt,
    home_chain_id: intent.homeChainId,
  });
}

function toSetupIntentRecord(row: SetupIntentRow): SetupIntentRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id ?? undefined,
    ownerAddress: row.owner_address ?? undefined,
    executorAddress: row.executor_address,
    messageToSign: row.message_to_sign,
    signature: row.signature ?? undefined,
    status: row.status,
    expiresAt: row.expires_at,
    accountAddress: row.account_address ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    completedAt: row.completed_at ?? undefined,
    homeChainId: row.home_chain_id ?? undefined,
  };
}

function toAgentWallet(row: AgentWalletRow): AgentWallet {
  return {
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    ownerAddress: row.owner_address,
    accountAddress: row.account_address,
    homeChainId: row.home_chain_id,
    executorAddress: row.executor_address,
    status: row.status,
  };
}

function toAgentWalletRow(wallet: AgentWallet, tenantContext?: SessionContext): Record<string, unknown> {
  return omitUndefined({
    tenant_id: tenantContext?.tenantId ?? wallet.tenantId,
    owner_address: wallet.ownerAddress.toLowerCase(),
    account_address: wallet.accountAddress.toLowerCase(),
    home_chain_id: wallet.homeChainId,
    executor_address: wallet.executorAddress,
    status: wallet.status,
  });
}

export function toPaymentIntentRow(intent: PaymentIntentRecord, tenantContext?: SessionContext): Record<string, unknown> {
  return omitUndefined({
    tenant_id: tenantContext?.tenantId ?? intent.tenantId,
    id: intent.id,
    account_address: intent.accountAddress.toLowerCase(),
    owner_address: intent.ownerAddress.toLowerCase(),
    status: intent.status,
    payment_type: intent.paymentType,
    source_chain_id: intent.sourceChainId,
    destination_chain_id: intent.destinationChainId,
    source_token_address: intent.sourceTokenAddress,
    source_token_symbol: intent.sourceTokenSymbol,
    destination_token_address: intent.destinationTokenAddress,
    destination_token_symbol: intent.destinationTokenSymbol,
    recipient_address: intent.recipientAddress,
    amount_out: intent.amountOut,
    min_amount_out: intent.minAmountOut,
    max_amount_in: intent.maxAmountIn,
    max_native_fee: intent.maxNativeFee,
    native_value: intent.nativeValue,
    route_provider: intent.routeProvider,
    route_target: intent.routeTarget,
    route_calldata: intent.routeCalldata,
    route_calldata_hash: intent.routeCalldataHash,
    route_summary: intent.routeSummary,
    estimated_fee: intent.estimatedFee,
    estimated_eta_seconds: intent.estimatedEtaSeconds,
    nonce: intent.nonce,
    deadline: intent.deadline,
    purpose: intent.purpose,
    approval_phrase: intent.approvalPhrase,
    approved_at: intent.approvedAt,
    source_tx_hash: intent.sourceTxHash,
    destination_tx_hash: intent.destinationTxHash,
    lifi_tracking_id: intent.lifiTrackingId,
    error_code: intent.errorCode,
    error_message: intent.errorMessage,
    completed_at: intent.completedAt,
  });
}

function toPaymentIntentRecord(row: PaymentIntentRow): PaymentIntentRecord {
  return {
    id: row.id,
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    accountAddress: row.account_address,
    ownerAddress: row.owner_address,
    status: row.status,
    paymentType: row.payment_type,
    sourceChainId: row.source_chain_id,
    destinationChainId: row.destination_chain_id,
    sourceTokenAddress: row.source_token_address,
    sourceTokenSymbol: row.source_token_symbol,
    destinationTokenAddress: row.destination_token_address,
    destinationTokenSymbol: row.destination_token_symbol,
    recipientAddress: row.recipient_address,
    amountOut: row.amount_out,
    ...(row.min_amount_out ? { minAmountOut: row.min_amount_out } : {}),
    maxAmountIn: row.max_amount_in,
    maxNativeFee: row.max_native_fee,
    ...(row.native_value ? { nativeValue: row.native_value } : {}),
    routeProvider: row.route_provider,
    routeTarget: row.route_target,
    routeCalldata: row.route_calldata,
    routeCalldataHash: row.route_calldata_hash,
    routeSummary: row.route_summary,
    estimatedFee: row.estimated_fee ?? undefined,
    estimatedEtaSeconds: row.estimated_eta_seconds ?? undefined,
    nonce: row.nonce,
    deadline: row.deadline,
    purpose: row.purpose ?? "",
    approvalPhrase: row.approval_phrase,
    approvedAt: row.approved_at ?? undefined,
    sourceTxHash: row.source_tx_hash ?? undefined,
    destinationTxHash: row.destination_tx_hash ?? undefined,
    lifiTrackingId: row.lifi_tracking_id ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function toPaymentEventRecord(row: PaymentEventRow): PaymentEventRecord {
  return {
    id: row.id,
    paymentIntentId: row.payment_intent_id,
    eventType: row.event_type,
    message: row.message ?? undefined,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

function toPaymentReviewHandoffRow(record: PaymentReviewHandoffRecord): Record<string, unknown> {
  return omitUndefined({
    id: record.id,
    payment_intent_id: record.paymentIntentId,
    tenant_id: record.tenantId,
    owner_address: record.ownerAddress.toLowerCase(),
    account_address: record.accountAddress.toLowerCase(),
    source_chain_id: record.sourceChainId,
    authorization_hash: record.authorizationHash,
    token_digest: record.tokenDigest,
    status: record.status,
    signature: record.signature,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    signed_at: record.signedAt,
  });
}

function toPaymentReviewHandoff(row: PaymentReviewHandoffRow): PaymentReviewHandoffRecord {
  return {
    id: row.id,
    paymentIntentId: row.payment_intent_id,
    tenantId: row.tenant_id,
    ownerAddress: row.owner_address,
    accountAddress: row.account_address,
    sourceChainId: row.source_chain_id,
    authorizationHash: row.authorization_hash,
    tokenDigest: row.token_digest,
    status: row.status,
    ...(row.signature ? { signature: row.signature } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.signed_at ? { signedAt: row.signed_at } : {}),
  };
}

async function updatePaymentIntent(
  client: AgentPaySupabaseClient,
  paymentIntentId: string,
  row: Record<string, unknown>,
  tenantContext?: SessionContext,
): Promise<void> {
  let query = client.from("payment_intents").update(row).eq("id", paymentIntentId);
  if (tenantContext) {
    query = query
      .eq("tenant_id", tenantContext.tenantId)
      .eq("owner_address", tenantContext.ownerAddress)
      .eq("account_address", tenantContext.accountAddress);
  }
  const { error } = await query;

  if (error) {
    throw new Error(`Failed to update payment intent ${paymentIntentId}: ${error.message}`);
  }
}

async function insertPaymentEvent(
  client: AgentPaySupabaseClient,
  paymentIntentId: string,
  eventType: string,
  message: string,
  metadata: Record<string, unknown>,
  tenantContext?: SessionContext,
): Promise<void> {
  const { error } = await client.from("payment_events").insert({
    ...(tenantContext ? { tenant_id: tenantContext.tenantId } : {}),
    payment_intent_id: paymentIntentId,
    event_type: eventType,
    message,
    metadata: omitUndefined(metadata),
  });

  if (error) {
    throw new Error(`Failed to create payment event for ${paymentIntentId}: ${error.message}`);
  }
}

async function updateSetupIntent(
  client: AgentPaySupabaseClient,
  setupIntentId: string,
  row: Record<string, unknown>,
  tenantContext?: SessionContext,
): Promise<void> {
  let query = client.from("setup_intents").update(row).eq("id", setupIntentId);
  if (tenantContext) {
    query = query.eq("tenant_id", tenantContext.tenantId);
  }
  const { error } = await query;

  if (error) {
    throw new Error(`Failed to update setup intent ${setupIntentId}: ${error.message}`);
  }
}

function assertSetupIntentOwnership(tenantContext: SessionContext | undefined, ownerAddress: string | undefined): void {
  if (tenantContext && ownerAddress && ownerAddress.toLowerCase() !== tenantContext.ownerAddress.toLowerCase()) {
    throw new AgentPayAuthError("TENANT_RESOURCE_MISMATCH", "Setup intent owner does not match the consumer session.");
  }
}

function assertTenantId(tenantContext: SessionContext | undefined, tenantId: string | undefined): void {
  if (tenantContext && tenantId && tenantId !== tenantContext.tenantId) {
    throw new AgentPayAuthError("TENANT_RESOURCE_MISMATCH", "Resource tenant does not match the consumer session.");
  }
}

function assertWalletOwnership(
  tenantContext: SessionContext | undefined,
  ownerAddress: string,
  accountAddress: string,
): void {
  if (!tenantContext) {
    return;
  }
  if (ownerAddress.toLowerCase() !== tenantContext.ownerAddress.toLowerCase()) {
    throw new AgentPayAuthError("TENANT_RESOURCE_MISMATCH", "Wallet owner does not match the consumer session.");
  }
  if (accountAddress.toLowerCase() !== tenantContext.accountAddress.toLowerCase()) {
    throw new AgentPayAuthError("TENANT_RESOURCE_MISMATCH", "Wallet account does not match the consumer session.");
  }
}

function toAuthChallengeRow(record: SiweChallenge): Record<string, unknown> {
  return omitUndefined({
    id: record.challengeId,
    request_id: record.requestId,
    domain: record.domain,
    uri: record.uri,
    owner_address: record.ownerAddress.toLowerCase(),
    account_address: record.accountAddress.toLowerCase(),
    chain_id: record.chainId,
    nonce: record.nonce,
    scopes: [...record.scopes],
    message: record.message,
    issued_at: record.issuedAt,
    expires_at: record.expiresAt,
    consumed_at: record.consumedAt,
  });
}

function toSiweChallenge(row: AuthChallengeRow): SiweChallenge {
  return Object.freeze({
    challengeId: row.id,
    requestId: row.request_id,
    domain: row.domain as SiweChallenge["domain"],
    uri: row.uri as SiweChallenge["uri"],
    ownerAddress: getAddress(row.owner_address),
    accountAddress: row.account_address,
    chainId: row.chain_id,
    nonce: row.nonce,
    scopes: Object.freeze([...row.scopes] as SiweChallenge["scopes"]),
    message: row.message,
    issuedAt: normalizeIsoTimestamp(row.issued_at),
    expiresAt: normalizeIsoTimestamp(row.expires_at),
    sessionLifetimeSeconds: SERVICE_SESSION_TTL_SECONDS,
    consumedAt: row.consumed_at ?? undefined,
  });
}

function normalizeIsoTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new AgentPayAuthError("SIWE_TIME_INVALID", "SIWE challenge timestamps are invalid.");
  }
  return timestamp.toISOString();
}

function toServiceSessionRow(record: ServiceSessionRecord): Record<string, unknown> {
  return {
    id: record.sessionId,
    tenant_id: record.tenantId,
    owner_address: record.ownerAddress.toLowerCase(),
    account_address: record.accountAddress.toLowerCase(),
    home_chain_id: record.homeChainId,
    audience: record.audience,
    environment: record.environment,
    scopes: [...record.scopes],
    authentication_epoch: record.authenticationEpoch,
    credential_digest: record.credentialDigest,
    issued_at: record.issuedAt,
    expires_at: record.expiresAt,
    last_used_at: record.lastUsedAt,
    revoked_at: record.revokedAt,
  };
}

function toServiceSessionRecord(row: ServiceSessionRow): ServiceSessionRecord {
  return Object.freeze({
    sessionId: row.id,
    tenantId: row.tenant_id,
    ownerAddress: row.owner_address,
    accountAddress: row.account_address,
    homeChainId: row.home_chain_id,
    audience: row.audience,
    environment: row.environment,
    scopes: Object.freeze([...row.scopes] as ServiceSessionRecord["scopes"]),
    authenticationEpoch: row.authentication_epoch,
    credentialDigest: row.credential_digest,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at ?? undefined,
  });
}

async function getTenantState(
  client: AgentPaySupabaseClient,
  tenantId: string,
): Promise<{
  authenticationEpoch: number;
  environment: SessionEnvironment;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
}> {
  const { data, error } = await client
    .from("tenants")
    .select("auth_epoch, environment, status")
    .eq("id", tenantId)
    .maybeSingle();
  if (error || !data || data.environment === "legacy") {
    throw new AgentPayAuthError("TENANT_NOT_FOUND", "Consumer tenant is unavailable.");
  }
  return {
    authenticationEpoch: data.auth_epoch,
    environment: data.environment,
    status: data.status,
  };
}

function omitUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
