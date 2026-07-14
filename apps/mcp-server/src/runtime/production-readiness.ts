import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { PaymentIntentRecord, SessionEnvironment } from "@agentpay-ai/shared";

import type { MainnetAccountVerificationResult } from "../services/mainnet-account-verifier.ts";

export type ExecutionMode = "OFF" | "CANARY" | "PUBLIC" | "DRAIN";
export type RuntimeIdentityStatus = "SHADOW_ONLY" | "DEPLOYED" | "READY" | "DRAINING";

export const MAINNET_CHAIN_ID = 196;
export const MAINNET_CAIP2 = "eip155:196";
export const MAINNET_USDT0_ADDRESS = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
export const MAINNET_USDT0_CODE_HASH =
  "0x4d9be648c5bf39973670d9f8b481d5d0b971e6a2db2deccc6b98cde21c5dd83e";
export const MAINNET_MIGRATION_HEAD = "20260714180000_canary_owner_rebinding";
export const DEFAULT_PRODUCTION_MANIFEST_PATH = fileURLToPath(
  new URL("../../../../ops/manifests/xlayer-mainnet.shadow.json", import.meta.url),
);

const MAINNET_USDC_ADDRESS = "0x74b7F16337b8972027F6196A17a631aC6dE26d22";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/i;
const HEX_HASH_PATTERN = /^0x[a-f0-9]{64}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const PRODUCTION_ENVIRONMENT_KEYS = [
  "XLAYER_RPC_URL",
  "XLAYER_TESTNET_RPC_URL",
  "AGENTPAY_XLAYER_TESTNET_USDT0_ADDRESS",
  "AGENTPAY_XLAYER_TESTNET_USDC_ADDRESS",
  "AGENTPAY_XLAYER_USDT0_ADDRESS",
  "AGENTPAY_XLAYER_USDC_ADDRESS",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DIRECT_URL",
];
const EXECUTION_MODES = new Set<ExecutionMode>(["OFF", "CANARY", "PUBLIC", "DRAIN"]);
const MANIFEST_STATUSES = new Set<RuntimeIdentityStatus>(["SHADOW_ONLY", "DEPLOYED", "READY", "DRAINING"]);

export interface RuntimeEnvironmentIdentity {
  id: number;
  environment: SessionEnvironment;
  chainId: number;
  caip2: string;
  supabaseProjectRef: string;
  migrationHead: string;
  releaseCommit: string | null;
  manifestSha256: string;
  accountVersion: "v2";
  accountAddress: string | null;
  deploymentTxHash: string | null;
  creationBytecodeHash: string;
  runtimeBytecodeHash: string | null;
  abiSha256: string | null;
  ownerAddress: string | null;
  executorAddress: string | null;
  deployerAddress: string | null;
  eip712VerifyingContract: string | null;
  tokenAddress: string;
  tokenCodeHash: string;
  tokenDecimals: number;
  x402Network: string;
  x402Asset: string;
  x402Price: string;
  x402PriceAtomic: string;
  x402SyncSettle: boolean;
  x402Enabled: boolean;
  payToAddress: string | null;
  facilitatorRef: string | null;
  publicOrigin?: string | null;
  executionMode: ExecutionMode;
  status: RuntimeIdentityStatus;
}

export interface ProductionPaymentConfigSnapshot {
  enabled: boolean;
  payTo: string;
  price: string;
  network: string;
  asset?: string;
  assetDecimals: number;
  syncSettle?: boolean;
  facilitatorUrl?: string;
  okxBaseUrl?: string;
  okxApiKey?: string;
  okxSecretKey?: string;
  okxPassphrase?: string;
}

export interface ProductionReadinessResult {
  ready: boolean;
  executionAllowed: boolean;
  publicPaymentAllowed: boolean;
  mode: ExecutionMode;
  status: RuntimeIdentityStatus;
  errors: string[];
  checks: Record<string, boolean>;
  /** Internal immutable snapshot used to detect post-start database drift. */
  identityFingerprint?: string;
}

export interface ProductionReadinessInput {
  env: Record<string, string | undefined>;
  manifest: unknown;
  identity: RuntimeEnvironmentIdentity | null;
  accountVerification: MainnetAccountVerificationResult | null;
  paymentConfig?: ProductionPaymentConfigSnapshot;
  /** True only after the durable Supabase ledger and frozen allowlist probe pass. */
  canaryAdmissionReady?: boolean;
}

export async function loadProductionManifest(path = DEFAULT_PRODUCTION_MANIFEST_PATH): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export function validateProductionEnvironment(env: Record<string, string | undefined>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const add = (name: string, message: string) => errors.push(`${name}: ${message}`);
  const has = (name: string) => typeof env[name] === "string" && env[name]!.trim() !== "";

  if (env.AGENTPAY_ENVIRONMENT !== "production") add("AGENTPAY_ENVIRONMENT", "must be production");
  if (String(env.AGENTPAY_HOME_CHAIN_ID ?? "") !== String(MAINNET_CHAIN_ID)) add("AGENTPAY_HOME_CHAIN_ID", "must be 196");
  if (env.AGENTPAY_ACCOUNT_VERSION !== "v2") add("AGENTPAY_ACCOUNT_VERSION", "must be v2");

  for (const name of [
    "SUPABASE_PRODUCTION_URL",
    "SUPABASE_PRODUCTION_SERVICE_ROLE_KEY",
    "XLAYER_MAINNET_RPC_URL",
    "AGENTPAY_SESSION_HASH_KEY",
    "AGENTPAY_REVIEW_TOKEN_SECRET",
  ]) {
    if (!has(name)) add(name, "is required for production");
  }

  if (has("XLAYER_MAINNET_RPC_URL")) {
    try {
      const rpcUrl = new URL(env.XLAYER_MAINNET_RPC_URL!);
      if (rpcUrl.protocol !== "https:" || rpcUrl.hostname !== "rpc.xlayer.tech") {
        add("XLAYER_MAINNET_RPC_URL", "must be the pinned mainnet HTTPS host");
      }
    } catch {
      add("XLAYER_MAINNET_RPC_URL", "must be a valid HTTPS URL");
    }
  }

  if (has("SUPABASE_PRODUCTION_URL")) {
    try {
      const supabaseUrl = new URL(env.SUPABASE_PRODUCTION_URL!);
      if (supabaseUrl.protocol !== "https:" || !supabaseUrl.hostname.endsWith(".supabase.co")) {
        add("SUPABASE_PRODUCTION_URL", "must be an HTTPS Supabase project URL");
      }
    } catch {
      add("SUPABASE_PRODUCTION_URL", "must be a valid HTTPS URL");
    }
  }

  for (const name of PRODUCTION_ENVIRONMENT_KEYS) {
    if (has(name)) add(name, "generic or staging runtime reference is forbidden in production");
  }
  for (const name of ["AGENTPAY_SESSION_HASH_KEY", "AGENTPAY_REVIEW_TOKEN_SECRET"]) {
    if (has(name) && env[name]!.length < 32) add(name, "must be at least 32 characters");
  }
  if (has("AGENTPAY_EXECUTION_MODE") && !EXECUTION_MODES.has(env.AGENTPAY_EXECUTION_MODE as ExecutionMode)) {
    add("AGENTPAY_EXECUTION_MODE", "must be OFF, CANARY, PUBLIC, or DRAIN");
  }

  return { valid: errors.length === 0, errors };
}

export function validateProductionManifest(manifest: unknown): { valid: boolean; errors: string[]; status: RuntimeIdentityStatus; mode: ExecutionMode } {
  const errors: string[] = [];
  const add = (path: string, message: string) => errors.push(`${path}: ${message}`);
  const record = manifest as Record<string, any>;
  const isRecord = record !== null && typeof record === "object" && !Array.isArray(record);
  if (!isRecord) return { valid: false, errors: ["manifest: must be an object"], status: "SHADOW_ONLY", mode: "OFF" };

  const status = MANIFEST_STATUSES.has(record.status) ? (record.status as RuntimeIdentityStatus) : "SHADOW_ONLY";
  const mode = EXECUTION_MODES.has(record.executionMode) ? (record.executionMode as ExecutionMode) : "OFF";
  if (!MANIFEST_STATUSES.has(record.status)) add("status", "must be SHADOW_ONLY, DEPLOYED, READY, or DRAINING");
  if (!EXECUTION_MODES.has(record.executionMode)) add("executionMode", "must be OFF, CANARY, PUBLIC, or DRAIN");
  if (record.environment !== "production") add("environment", "must be production");
  if (record.schemaVersion !== 1) add("schemaVersion", "must be 1");
  if (record.chain?.chainId !== MAINNET_CHAIN_ID) add("chain.chainId", "must be 196");
  if (record.chain?.caip2 !== MAINNET_CAIP2) add("chain.caip2", "must be eip155:196");
  if (record.chain?.rpcEnvRef !== "XLAYER_MAINNET_RPC_URL") add("chain.rpcEnvRef", "must be XLAYER_MAINNET_RPC_URL");
  if (record.database?.environment !== "production") add("database.environment", "must be production");
  if (record.database?.migrationHead !== MAINNET_MIGRATION_HEAD) add("database.migrationHead", "does not match the identity migration head");
  if (record.release?.migrationHead !== MAINNET_MIGRATION_HEAD) add("release.migrationHead", "does not match the identity migration head");
  if (record.contract?.version !== "v2") add("contract.version", "must be v2");
  if (record.contract?.domain?.name !== "AgentPay" || record.contract?.domain?.version !== "1" || record.contract?.domain?.chainId !== MAINNET_CHAIN_ID) {
    add("contract.domain", "must be AgentPay/1 on chain 196");
  }
  if (record.token?.symbol !== "USDT0" || record.token?.address?.toLowerCase() !== MAINNET_USDT0_ADDRESS.toLowerCase()) add("token", "must be mainnet USDT0");
  if (record.token?.decimals !== 6 || record.token?.codeHash?.toLowerCase() !== MAINNET_USDT0_CODE_HASH.toLowerCase()) add("token", "code hash and decimals must match mainnet USDT0");
  if (JSON.stringify(record.contract?.allowedTokens ?? []) !== JSON.stringify([MAINNET_USDT0_ADDRESS])) add("contract.allowedTokens", "must contain only mainnet USDT0");
  if (!Array.isArray(record.contract?.allowedRouteTargets) || record.contract.allowedRouteTargets.length !== 0) add("contract.allowedRouteTargets", "must be empty");
  if (record.x402?.network !== MAINNET_CAIP2 || record.x402?.asset !== "USDT0" || record.x402?.tokenAddress?.toLowerCase() !== MAINNET_USDT0_ADDRESS.toLowerCase()) add("x402", "must target mainnet USDT0 on eip155:196");
  if (record.x402?.decimals !== 6 || record.x402?.price !== "$0.01" || record.x402?.priceAtomic !== "10000" || record.x402?.syncSettle !== true) add("x402", "must use 6 decimals, $0.01/10000, and synchronous settlement");
  if (JSON.stringify(record.x402?.toolAllowlist ?? []) !== JSON.stringify(["execute_payment"])) add("x402.toolAllowlist", "must contain only execute_payment");
  if (mode === "OFF" && status !== "SHADOW_ONLY" && status !== "DEPLOYED") add("executionMode", "OFF is only valid before activation");
  if (status === "SHADOW_ONLY" && mode !== "OFF") add("executionMode", "SHADOW_ONLY manifests must remain OFF");

  const isReadySurface = status === "READY" || status === "DRAINING";
  if (isReadySurface) {
    if (record.x402?.enabled !== true) add("x402.enabled", "must be true for a ready surface");
    if (!/^[a-z0-9]{20}$/.test(record.database?.projectRef ?? "")) add("database.projectRef", "must be provisioned for a ready surface");
    if (typeof record.release?.commit !== "string" || !COMMIT_PATTERN.test(record.release.commit)) add("release.commit", "must be a frozen commit");
    if (typeof record.release?.runtimeBytecodeKeccak256 !== "string" || !HEX_HASH_PATTERN.test(record.release.runtimeBytecodeKeccak256)) add("release.runtimeBytecodeKeccak256", "must be pinned for a ready surface");
    if (typeof record.release?.abiSha256 !== "string" || !SHA256_PATTERN.test(record.release.abiSha256)) add("release.abiSha256", "must be pinned for a ready surface");
    for (const path of ["address", "deploymentTxHash", "runtimeBytecodeHash", "ownerAddress", "executorAddress", "deployerAddress"]) {
      const value = path === "deploymentTxHash" ? record.contract?.[path] : record.contract?.[path];
      const isHash = path === "deploymentTxHash" || path === "runtimeBytecodeHash";
      if (typeof value !== "string" || (isHash ? !HEX_HASH_PATTERN.test(value) : !ADDRESS_PATTERN.test(value))) add(`contract.${path}`, "must be provisioned for a ready surface");
    }
    if (!ADDRESS_PATTERN.test(record.contract?.domain?.verifyingContract ?? "")) add("contract.domain.verifyingContract", "must be provisioned for a ready surface");
    if (typeof record.domains?.publicOrigin !== "string" || !record.domains.publicOrigin.startsWith("https://")) add("domains.publicOrigin", "must be HTTPS for a ready surface");
  }

  return { valid: errors.length === 0, errors, status, mode };
}

export function computeManifestSha256(manifest: unknown): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export async function evaluateProductionReadiness(input: ProductionReadinessInput): Promise<ProductionReadinessResult> {
  const envResult = validateProductionEnvironment(input.env);
  const manifestResult = validateProductionManifest(input.manifest);
  const errors = [...envResult.errors, ...manifestResult.errors];
  const checks: Record<string, boolean> = {
    environment: envResult.valid,
    manifest: manifestResult.valid,
  };
  const identity = input.identity;
  const mode = identity?.executionMode ?? (input.env.AGENTPAY_EXECUTION_MODE as ExecutionMode | undefined) ?? manifestResult.mode;
  const status = identity?.status ?? manifestResult.status;

  if (!identity) {
    checks.identity = false;
    errors.push("runtime identity: singleton production identity is missing");
  } else {
    const identityErrors = validateIdentityAgainstManifest(identity, input.manifest, input.env);
    checks.identity = identityErrors.length === 0;
    errors.push(...identityErrors);
  }

  const paymentErrors = validatePaymentConfig(input.paymentConfig, mode);
  checks.payment = paymentErrors.length === 0;
  errors.push(...paymentErrors);
  const rawTransactionEncryptionReady = mode === "OFF" || mode === "DRAIN"
    ? true
    : /^[a-fA-F0-9]{64}$/.test(String(input.env.AGENTPAY_RAW_TX_ENCRYPTION_KEY ?? ""));
  checks.rawTransactionEncryption = rawTransactionEncryptionReady;
  if (!rawTransactionEncryptionReady) {
    errors.push("raw transaction encryption: AGENTPAY_RAW_TX_ENCRYPTION_KEY must be a 32-byte hex key");
  }

  if ((mode === "PUBLIC" || mode === "CANARY") && !input.accountVerification) {
    checks.account = false;
    errors.push("mainnet account: read-only account verification is missing");
  } else if (input.accountVerification) {
    checks.account = input.accountVerification.valid;
    errors.push(...input.accountVerification.errors.map((error) => `mainnet account: ${error}`));
  } else {
    checks.account = false;
  }

  const canaryAdmissionReady = mode !== "CANARY" || input.canaryAdmissionReady === true;
  checks.canaryAdmission = canaryAdmissionReady;
  if (!canaryAdmissionReady) {
    errors.push("canary admission: durable Supabase ledger and frozen allowlist are required");
  }

  if (mode === "PUBLIC" && status !== "READY") errors.push("execution mode: PUBLIC requires READY identity status");
  if (mode === "CANARY" && status !== "READY") errors.push("execution mode: CANARY requires READY identity status");
  if (mode === "OFF" || mode === "DRAIN") errors.push(`execution mode: ${mode} does not accept new public executions`);
  if (input.env.AGENTPAY_EXECUTION_MODE && identity && input.env.AGENTPAY_EXECUTION_MODE !== identity.executionMode) {
    errors.push("execution mode: environment value does not match the database identity");
  }

  const ready = errors.length === 0 && (mode === "PUBLIC" || mode === "CANARY");
  return {
    ready,
    executionAllowed: ready,
    publicPaymentAllowed: ready && (mode === "PUBLIC" || mode === "CANARY") && input.paymentConfig?.enabled === true,
    mode,
    status,
    errors,
    checks,
    identityFingerprint: identity ? fingerprintRuntimeIdentity(identity) : undefined,
  };
}

export function assertProductionExecutionAllowed(
  policy: { mode: ExecutionMode; environment?: SessionEnvironment; directMainnetOnly?: boolean },
  intent: PaymentIntentRecord,
): void {
  if (policy.environment !== "production") return;
  if (policy.mode !== "PUBLIC" && policy.mode !== "CANARY") {
    throw new Error("PRODUCTION_NOT_READY: execution mode does not allow new payments.");
  }
  if (!policy.directMainnetOnly) return;
  const direct =
    intent.sourceChainId === MAINNET_CHAIN_ID &&
    intent.destinationChainId === MAINNET_CHAIN_ID &&
    intent.sourceTokenSymbol === "USDT0" &&
    intent.destinationTokenSymbol === "USDT0" &&
    intent.sourceTokenAddress.toLowerCase() === MAINNET_USDT0_ADDRESS.toLowerCase() &&
    intent.destinationTokenAddress.toLowerCase() === MAINNET_USDT0_ADDRESS.toLowerCase() &&
    intent.routeProvider === "DIRECT" &&
    intent.routeTarget.toLowerCase() === ZERO_ADDRESS &&
    intent.routeCalldata === "0x" &&
    intent.maxNativeFee === "0";
  if (!direct) {
    throw new Error("PRODUCTION_EXECUTION_RESTRICTED: only direct chain-196 USDT0 payments are enabled.");
  }
}

function validateIdentityAgainstManifest(
  identity: RuntimeEnvironmentIdentity,
  manifest: unknown,
  env: Record<string, string | undefined>,
): string[] {
  const errors: string[] = [];
  const record = manifest as Record<string, any>;
  const projectRef = extractSupabaseProjectRef(env.SUPABASE_PRODUCTION_URL);
  const manifestDigest = computeManifestSha256(manifest);
  const compare = (name: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) errors.push(`runtime identity: ${name} does not match the manifest/environment`);
  };
  compare("id", identity.id, 1);
  compare("environment", identity.environment, "production");
  compare("chainId", identity.chainId, MAINNET_CHAIN_ID);
  compare("caip2", identity.caip2, MAINNET_CAIP2);
  compare("Supabase project", identity.supabaseProjectRef, projectRef);
  compare("migration head", identity.migrationHead, record.database?.migrationHead);
  compare("manifest digest", identity.manifestSha256, manifestDigest);
  compare("account version", identity.accountVersion, "v2");
  compare("execution mode", identity.executionMode, record.executionMode);
  compare("status", identity.status, record.status);
  compare("x402 enabled", identity.x402Enabled, record.x402?.enabled);
  compare("EIP-712 verifying contract", identity.eip712VerifyingContract?.toLowerCase() ?? null, record.contract?.domain?.verifyingContract?.toLowerCase() ?? null);
  compare("creation bytecode", identity.creationBytecodeHash, record.contract?.creationBytecodeHash);
  compare("token address", identity.tokenAddress.toLowerCase(), String(record.token?.address ?? "").toLowerCase());
  compare("token code hash", identity.tokenCodeHash.toLowerCase(), String(record.token?.codeHash ?? "").toLowerCase());
  compare("token decimals", identity.tokenDecimals, record.token?.decimals);
  compare("x402 network", identity.x402Network, record.x402?.network);
  compare("x402 asset", identity.x402Asset.toLowerCase(), String(record.x402?.tokenAddress ?? "").toLowerCase());
  compare("x402 price", identity.x402Price, record.x402?.price);
  compare("x402 price atomic", identity.x402PriceAtomic, record.x402?.priceAtomic);
  compare("x402 sync settlement", identity.x402SyncSettle, record.x402?.syncSettle);
  if (record.status === "READY" || record.status === "DRAINING") {
    compare("release commit", identity.releaseCommit, record.release?.commit);
    compare("account address", identity.accountAddress, record.contract?.address);
    compare("deployment tx", identity.deploymentTxHash, record.contract?.deploymentTxHash);
    compare("runtime bytecode", identity.runtimeBytecodeHash, record.contract?.runtimeBytecodeHash);
    compare("ABI digest", identity.abiSha256, record.release?.abiSha256);
    compare("owner", identity.ownerAddress, record.contract?.ownerAddress);
    compare("executor", identity.executorAddress, record.contract?.executorAddress);
    compare("deployer", identity.deployerAddress, record.contract?.deployerAddress);
    if (!identity.payToAddress || !ADDRESS_PATTERN.test(identity.payToAddress)) errors.push("runtime identity: payTo address is not provisioned");
    if (!identity.facilitatorRef) errors.push("runtime identity: facilitator reference is not provisioned");
  }
  return errors;
}

function validatePaymentConfig(config: ProductionPaymentConfigSnapshot | undefined, mode: ExecutionMode): string[] {
  const errors: string[] = [];
  if (mode === "OFF" || mode === "DRAIN") {
    if (config?.enabled) errors.push("payment config: payment must remain disabled in OFF/DRAIN mode");
    return errors;
  }
  if (!config?.enabled) {
    errors.push("payment config: public mode requires enabled x402 payment");
    return errors;
  }
  if (config.network !== MAINNET_CAIP2) errors.push("payment config: network must be eip155:196");
  if (config.asset?.toLowerCase() !== MAINNET_USDT0_ADDRESS.toLowerCase()) {
    errors.push("payment config: asset must be the canonical mainnet USDT0 contract");
  }
  if (config.price !== "$0.01") errors.push("payment config: price must be $0.01");
  if (config.assetDecimals !== 6) errors.push("payment config: asset decimals must be 6 for USDT0");
  if (config.syncSettle !== true) errors.push("payment config: synchronous settlement must be explicitly true");
  if (!ADDRESS_PATTERN.test(config.payTo) || config.payTo.toLowerCase() === ZERO_ADDRESS) errors.push("payment config: payTo must be a non-zero EVM address");
  if (config.facilitatorUrl) {
    try {
      const url = new URL(config.facilitatorUrl);
      if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) errors.push("payment config: facilitator URL must be HTTPS and non-loopback");
    } catch {
      errors.push("payment config: facilitator URL is invalid");
    }
  } else if (!(config.okxApiKey && config.okxSecretKey && config.okxPassphrase)) {
    errors.push("payment config: facilitator URL or complete OKX credentials are required");
  }
  if (config.okxBaseUrl) {
    try {
      const url = new URL(config.okxBaseUrl);
      if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
        errors.push("payment config: OKX base URL must be HTTPS and non-loopback");
      }
    } catch {
      errors.push("payment config: OKX base URL is invalid");
    }
  }
  return errors;
}

function extractSupabaseProjectRef(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const host = new URL(value).hostname;
    const match = host.match(/^([a-z0-9]{20})\.supabase\.co$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintRuntimeIdentity(identity: RuntimeEnvironmentIdentity): string {
  return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}
