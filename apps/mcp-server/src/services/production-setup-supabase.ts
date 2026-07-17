import { createClient } from "@supabase/supabase-js";
import { mainnetWalletSetupPublicStatusSchema } from "@agentpay-ai/shared";
import { z } from "zod";

import {
  ProductionSetupStoreError,
  type ProductionSetupWebStore,
  type ProductionSetupWorkerStore,
  type SetupWorkerClaim,
} from "./production-setup.ts";

export { ProductionSetupStoreError } from "./production-setup.ts";

export interface ScopedProductionSetupClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown | null; error: { message: string } | null }>;
}

export interface ScopedProductionSetupClientOptions {
  auth: { autoRefreshToken: false; persistSession: false };
  accessToken: () => Promise<string>;
}

export type ScopedProductionSetupClientFactory = (
  supabaseUrl: string,
  token: string,
  options: ScopedProductionSetupClientOptions,
) => ScopedProductionSetupClient;

export interface ScopedProductionSetupConfig {
  supabaseUrl: string;
  supabaseApiKey: string;
  token: string;
  nowUnix?: number;
  minimumRemainingSeconds?: number;
  maximumRemainingSeconds?: number;
  clientFactory?: ScopedProductionSetupClientFactory;
}

export interface ScopedProductionSetupWebConfig extends ScopedProductionSetupConfig {
  rateLimit: {
    windowSeconds: number;
    maxRequests: number;
  };
}

export interface ScopedProductionSetupWorkerConfig extends ScopedProductionSetupConfig {
  sponsorPolicy: {
    maxDeploymentsPerDay: number;
    maxGasPerDeployment: string;
    maxNativeCostPerDayWei: string;
    maxPending: number;
  };
}

const DEFAULT_MINIMUM_REMAINING_SECONDS = 900;
const DEFAULT_MAXIMUM_REMAINING_SECONDS = 7_200;
const uuidSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const hashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const signatureSchema = z.string().regex(/^0x[0-9a-f]{130}$/);
const atomicSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const encryptedTransactionSchema = z.object({
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const challengeResultSchema = z.object({
  disposition: z.enum(["CREATED", "REPLAY"]),
  setupIntentId: z.string().min(16).max(128),
  expiresAt: timestampSchema,
}).strict();

const admissionResultSchema = z.object({
  disposition: z.enum(["ADMITTED", "REPLAY"]),
  setupIntentId: z.string().min(16).max(128),
  jobId: uuidSchema,
}).strict();

const pruneResultSchema = z.object({
  expiredSetups: z.number().int().nonnegative(),
  deletedRateBuckets: z.number().int().nonnegative(),
}).strict();

const workerClaimSchema = z.object({
  disposition: z.literal("CLAIMED"),
  jobStatus: z.enum(["SIGNING", "SIGNED", "BROADCAST", "BROADCAST_UNKNOWN", "CONFIRMING"]),
  jobId: uuidSchema,
  setupIntentId: z.string().min(16).max(128),
  tenantId: uuidSchema,
  fencingToken: uuidSchema,
  leaseUntil: timestampSchema,
  ownerSetupSignature: signatureSchema,
  ownerAddress: addressSchema,
  executorAddress: addressSchema,
  homeChainId: z.literal(196),
  deploymentNonce: hashSchema,
  manifestSha256: hashSchema,
  factoryAddress: addressSchema,
  factoryRuntimeCodeHash: hashSchema,
  deploymentSalt: hashSchema,
  predictedAccount: addressSchema,
  accountCreationCodeHash: hashSchema,
  accountRuntimeCodeHash: hashSchema,
  authorizationHash: hashSchema,
  expiresAt: timestampSchema,
  deployerAddress: addressSchema.optional(),
  deployerNonce: atomicSchema.optional(),
  transactionHash: hashSchema.optional(),
  rawTransaction: encryptedTransactionSchema.optional(),
  receiptStatus: z.union([z.literal(0), z.literal(1)]).optional(),
  receiptBlockNumber: atomicSchema.optional(),
  existingAccountVerified: z.boolean().optional(),
  broadcastAt: timestampSchema.optional(),
}).strict();

const reservationResultSchema = z.object({
  disposition: z.enum(["RESERVED", "REPLAY"]),
  jobId: uuidSchema,
  dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

const signedResultSchema = z.object({
  disposition: z.enum(["SIGNED", "REPLAY"]),
  jobId: uuidSchema,
  transactionHash: hashSchema,
}).strict();

const broadcastResultSchema = z.object({
  disposition: z.enum(["BROADCAST", "BROADCAST_UNKNOWN", "REPLAY"]),
  jobId: uuidSchema,
  status: z.enum(["BROADCAST", "BROADCAST_UNKNOWN"]),
}).strict();

const receiptResultSchema = z.object({
  disposition: z.enum(["RECORDED", "REPLAY"]),
  jobId: uuidSchema,
  status: z.enum(["CONFIRMING", "FAILED"]),
}).strict();

const existingAccountResultSchema = z.object({
  disposition: z.enum(["RECORDED", "REPLAY"]),
  jobId: uuidSchema,
  status: z.literal("CONFIRMING"),
}).strict();

const finalizeResultSchema = z.object({
  disposition: z.enum(["COMPLETED", "REPLAY"]),
  jobId: uuidSchema,
  tenantId: uuidSchema,
  accountAddress: addressSchema,
}).strict();

const manualReviewResultSchema = z.object({
  disposition: z.enum(["MANUAL_REVIEW", "REPLAY"]),
  jobId: uuidSchema,
}).strict();

export function createProductionSetupWebStoreFromConfig(
  config: ScopedProductionSetupWebConfig,
): ProductionSetupWebStore {
  assertRateLimit(config.rateLimit);
  const client = createScopedClient(config, "agentpay_setup_web");
  const store: ProductionSetupWebStore = {
    async challenge(input) {
      return callRpc(client, "create_production_setup_challenge", {
        p_setup_intent_id: input.setupIntentId,
        p_capability_digest: input.capabilityDigest,
        p_owner_address: input.ownerAddress,
        p_executor_address: input.executorAddress,
        p_message_to_sign: input.messageToSign,
        p_deployment_nonce: input.deploymentNonce,
        p_manifest_sha256: input.manifestSha256,
        p_factory_address: input.factoryAddress,
        p_factory_runtime_code_hash: input.factoryRuntimeCodeHash,
        p_deployment_salt: input.deploymentSalt,
        p_predicted_account: input.predictedAccount,
        p_account_creation_code_hash: input.accountCreationCodeHash,
        p_account_runtime_code_hash: input.accountRuntimeCodeHash,
        p_authorization_hash: input.authorizationHash,
        p_expires_at: input.expiresAt,
        p_at: input.at,
        p_rate_limit_key_digest: input.rateLimitKeyDigest,
        p_rate_limit_window_seconds: config.rateLimit.windowSeconds,
        p_rate_limit_max_requests: config.rateLimit.maxRequests,
      }, challengeResultSchema);
    },
    async admit(input) {
      return callRpc(client, "consume_production_setup_admission", {
        p_capability_digest: input.capabilityDigest,
        p_owner_setup_signature: input.ownerSetupSignature,
        p_at: input.at,
      }, admissionResultSchema);
    },
    async status(input) {
      return callRpc(client, "read_production_setup_status", {
        p_capability_digest: input.capabilityDigest,
        p_at: input.at,
      }, mainnetWalletSetupPublicStatusSchema);
    },
    async prune(input) {
      return callRpc(client, "prune_expired_production_setups", { p_at: input.at }, pruneResultSchema);
    },
  };
  return Object.freeze(store);
}

export function createProductionSetupWorkerStoreFromConfig(
  config: ScopedProductionSetupWorkerConfig,
): ProductionSetupWorkerStore {
  assertSponsorPolicy(config.sponsorPolicy);
  const client = createScopedClient(config, "agentpay_setup_worker");
  const store: ProductionSetupWorkerStore = {
    async claim(input): Promise<SetupWorkerClaim | null> {
      return callNullableRpc(client, "claim_setup_deployment_job", {
        p_worker_id: input.workerId,
        p_at: input.at,
        p_lease_seconds: input.leaseSeconds,
      }, workerClaimSchema);
    },
    async reserve(input) {
      return callRpc(client, "reserve_setup_sponsor_budget", {
        p_job_id: input.jobId,
        p_fencing_token: input.fencingToken,
        p_deployer_address: input.deployerAddress,
        p_deployer_nonce: input.deployerNonce,
        p_gas_limit: input.gasLimit,
        p_native_cost_wei: input.nativeCostWei,
        p_at: input.at,
        p_max_deployments_per_day: config.sponsorPolicy.maxDeploymentsPerDay,
        p_max_gas_per_deployment: config.sponsorPolicy.maxGasPerDeployment,
        p_max_native_cost_per_day_wei: config.sponsorPolicy.maxNativeCostPerDayWei,
        p_max_pending: config.sponsorPolicy.maxPending,
      }, reservationResultSchema);
    },
    async persistSignedTransaction(input) {
      const result = await callRpc(client, "persist_setup_signed_transaction", {
        p_job_id: input.jobId,
        p_fencing_token: input.fencingToken,
        p_raw_tx_ciphertext: input.rawTransaction.ciphertext,
        p_raw_tx_iv: input.rawTransaction.iv,
        p_raw_tx_tag: input.rawTransaction.tag,
        p_raw_tx_hash: input.rawTransaction.hash,
        p_transaction_hash: input.transactionHash,
        p_at: input.at,
      }, signedResultSchema);
      return Object.freeze({ ...result, status: "SIGNED" as const });
    },
    async markBroadcastResult(input) {
      return callRpc(client, "mark_setup_broadcast_result", {
        p_job_id: input.jobId,
        p_fencing_token: input.fencingToken,
        p_result: input.result,
        p_at: input.at,
        p_public_error_code: input.publicCode,
      }, broadcastResultSchema);
    },
    async recordReceipt(input) {
      return callRpc(client, "record_setup_receipt", {
        p_job_id: input.jobId,
        p_fencing_token: input.fencingToken,
        p_transaction_hash: input.transactionHash,
        p_receipt_status: input.receiptStatus,
        p_receipt_block_number: input.receiptBlockNumber,
        p_at: input.at,
      }, receiptResultSchema);
    },
    async recordExistingAccount(input) {
      return callRpc(client, "record_existing_setup_account", {
        p_job_id: input.jobId,
        p_fencing_token: input.fencingToken,
        p_verification_block_number: input.verificationBlockNumber,
        p_at: input.at,
      }, existingAccountResultSchema);
    },
    async finalize(input) {
      return callRpc(client, "finalize_verified_setup_wallet", {
        p_job_id: input.jobId,
        p_fencing_token: input.fencingToken,
        p_at: input.at,
      }, finalizeResultSchema);
    },
    async markManualReview(input) {
      const result = await callRpc(client, "mark_setup_manual_review", {
        p_job_id: input.jobId,
        p_fencing_token: input.fencingToken,
        p_public_error_code: input.publicCode,
        p_at: input.at,
      }, manualReviewResultSchema);
      return Object.freeze({ ...result, status: "MANUAL_REVIEW" as const });
    },
  };
  return Object.freeze(store);
}

function createScopedClient(
  config: ScopedProductionSetupConfig,
  requiredRole: "agentpay_setup_web" | "agentpay_setup_worker",
): ScopedProductionSetupClient {
  assertScopedToken(config, requiredRole);
  assertPublicApiKey(config.supabaseApiKey);
  let url: URL;
  try {
    url = new URL(config.supabaseUrl);
  } catch {
    throw invalidTokenConfiguration();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") {
    throw invalidTokenConfiguration();
  }
  const options = {
    auth: { autoRefreshToken: false as const, persistSession: false as const },
    accessToken: async () => config.token,
  };
  const factory = config.clientFactory ?? ((supabaseUrl, apiKey, clientOptions) =>
    createClient(supabaseUrl, apiKey, clientOptions) as unknown as ScopedProductionSetupClient);
  return factory(url.toString().replace(/\/$/, ""), config.supabaseApiKey, options);
}

function assertPublicApiKey(value: string): void {
  if (!/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(value)) throw invalidTokenConfiguration();
}

function assertScopedToken(
  config: ScopedProductionSetupConfig,
  requiredRole: "agentpay_setup_web" | "agentpay_setup_worker",
): void {
  const nowUnix = config.nowUnix ?? Math.floor(Date.now() / 1_000);
  const minimum = config.minimumRemainingSeconds ?? DEFAULT_MINIMUM_REMAINING_SECONDS;
  const maximum = config.maximumRemainingSeconds ?? DEFAULT_MAXIMUM_REMAINING_SECONDS;
  if (!Number.isSafeInteger(nowUnix) || !Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)
    || minimum < DEFAULT_MINIMUM_REMAINING_SECONDS || maximum < minimum
    || maximum > DEFAULT_MAXIMUM_REMAINING_SECONDS) throw invalidTokenConfiguration();
  const parts = config.token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw invalidTokenConfiguration();
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(parts[1]!));
  } catch {
    throw invalidTokenConfiguration();
  }
  const parsed = z.object({ role: z.string(), exp: z.number().int().positive() }).passthrough().safeParse(payload);
  if (!parsed.success || parsed.data.role !== requiredRole) {
    throw invalidTokenConfiguration();
  }
  const remaining = parsed.data.exp - nowUnix;
  if (remaining < minimum || remaining > maximum) throw invalidTokenConfiguration();
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

async function callRpc<TSchema extends z.ZodType>(
  client: ScopedProductionSetupClient,
  functionName: string,
  args: Record<string, unknown>,
  schema: TSchema,
): Promise<z.output<TSchema>> {
  const result = await executeRpc(client, functionName, withoutUndefined(args));
  if (result.data === null) throw new ProductionSetupStoreError("SETUP_RESPONSE_INVALID");
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new ProductionSetupStoreError("SETUP_RESPONSE_INVALID");
  return Object.freeze(parsed.data) as z.output<TSchema>;
}

async function callNullableRpc<TSchema extends z.ZodType>(
  client: ScopedProductionSetupClient,
  functionName: string,
  args: Record<string, unknown>,
  schema: TSchema,
): Promise<z.output<TSchema> | null> {
  const result = await executeRpc(client, functionName, withoutUndefined(args));
  if (result.data === null) return null;
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new ProductionSetupStoreError("SETUP_RESPONSE_INVALID");
  return Object.freeze(parsed.data) as z.output<TSchema>;
}

async function executeRpc(
  client: ScopedProductionSetupClient,
  functionName: string,
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: { message: string } | null }> {
  let result: { data: unknown; error: { message: string } | null };
  try {
    result = await client.rpc(functionName, args);
  } catch {
    throw new ProductionSetupStoreError("SETUP_STORE_UNAVAILABLE");
  }
  if (result.error) {
    const stableCode = /^([A-Z][A-Z0-9_]{1,63}):/.exec(result.error.message)?.[1];
    throw new ProductionSetupStoreError(stableCode?.startsWith("SETUP_") ? stableCode : "SETUP_STORE_UNAVAILABLE");
  }
  return result;
}

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function assertSponsorPolicy(policy: ScopedProductionSetupWorkerConfig["sponsorPolicy"]): void {
  if (!Number.isSafeInteger(policy.maxDeploymentsPerDay) || policy.maxDeploymentsPerDay <= 0
    || !Number.isSafeInteger(policy.maxPending) || policy.maxPending <= 0
    || !/^[1-9][0-9]*$/.test(policy.maxGasPerDeployment)
    || !/^[1-9][0-9]*$/.test(policy.maxNativeCostPerDayWei)
    || BigInt(policy.maxGasPerDeployment) >= 2n ** 256n
    || BigInt(policy.maxNativeCostPerDayWei) >= 2n ** 256n) {
    throw new ProductionSetupStoreError("SETUP_SPONSOR_POLICY_INVALID");
  }
}

function assertRateLimit(policy: ScopedProductionSetupWebConfig["rateLimit"]): void {
  if (!Number.isSafeInteger(policy.windowSeconds) || policy.windowSeconds < 1 || policy.windowSeconds > 3_600
    || !Number.isSafeInteger(policy.maxRequests) || policy.maxRequests < 1 || policy.maxRequests > 10_000) {
    throw new ProductionSetupStoreError("SETUP_RATE_LIMIT_POLICY_INVALID");
  }
}

function invalidTokenConfiguration(): ProductionSetupStoreError {
  return new ProductionSetupStoreError("SETUP_SCOPED_TOKEN_INVALID", "Scoped setup token is invalid.");
}
