import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  keccak256,
} from "ethers";
import { z } from "zod";

import {
  createProductionSetupWorkerStoreFromConfig,
  type SetupWorkerClaim,
} from "@agentpay-ai/mcp-server";
import { MAINNET_SETUP_USDT0, toEip712Sha256Bytes32 } from "@agentpay-ai/shared";
import { bindOwnerRuntimeArtifact, type AccountRuntimeArtifact } from "../onboarding/runtime.ts";
import {
  verifySetupAccount,
  type SetupAccountVerificationReader,
  type SetupVerificationLogFilter,
} from "./setup-account-verifier.ts";
import { createSetupDeploymentWorker } from "./setup-deployment-worker.ts";

const POLICY_VERSION = "0x9ffc525f976679dba1c4b7719e4a88a5ab29462373ca8c14513ab633beae5e3d";
const FORBIDDEN_ENV_KEYS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "AGENTPAY_SETUP_WEB_TOKEN",
  "AGENTPAY_COOKIE_HMAC_SECRET",
  "AGENTPAY_CAPABILITY_HASH_SECRET",
  "AGENTPAY_REVIEW_TOKEN_SECRET",
  "AGENTPAY_EXECUTOR_PRIVATE_KEY",
  "AGENTPAY_OAUTH_CLIENT_SECRET",
  "AGENTPAY_PAYMENT_SIGNER_PRIVATE_KEY",
  "XLAYER_TESTNET_RPC_URL",
] as const;

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const hashSchema = z.string().regex(/^0x[a-f0-9]{64}$/);
const bareHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const publishableKeySchema = z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{16,}$/);
const positiveDecimalSchema = z.string().regex(/^[1-9][0-9]*$/).max(78);
const positiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const referenceSchema = z.object({ start: z.number().int().nonnegative(), length: z.literal(20) }).strict();
const artifactSchema = z.object({
  bytecode: z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/),
  immutableReferences: z.array(referenceSchema).min(1),
  creationCodeHash: hashSchema,
  runtimeTemplateHash: hashSchema,
}).strict();
const manifestSchema = z.object({
  environment: z.literal("production"),
  chainId: z.literal(196),
  setupMode: z.enum(["OFF", "CANARY", "PUBLIC", "DRAIN"]),
  onboardingOrigin: z.literal("https://onboard.agentpay.site"),
  factory: z.object({
    address: addressSchema,
    deploymentTxHash: hashSchema,
    deploymentBlock: positiveIntegerSchema,
    runtimeCodeHash: hashSchema,
    executor: addressSchema,
    usdt0: z.literal(MAINNET_SETUP_USDT0),
    policyVersion: z.literal(POLICY_VERSION),
  }).strict(),
  account: z.object({
    creationCodeHash: hashSchema,
    runtimeTemplateHash: hashSchema,
    immutableReferences: z.array(referenceSchema).min(1),
    routeTargets: z.array(z.never()).length(0),
  }).strict(),
  sponsor: z.object({
    deployerAddress: addressSchema,
    maxDeploymentsPerDay: positiveIntegerSchema,
    maxNativeCostPerDayWei: positiveDecimalSchema,
    maxGasPerDeployment: positiveIntegerSchema,
    maxPending: positiveIntegerSchema,
  }).strict(),
}).strict();
const databaseRuntimeSchema = z.object({
  environment: z.literal("production"), chainId: z.literal(196),
  setupMode: z.enum(["OFF", "CANARY", "PUBLIC", "DRAIN"]),
  manifestSha256: hashSchema, factoryAddress: addressSchema, factoryRuntimeCodeHash: hashSchema,
  executorAddress: addressSchema, sponsorDeployerAddress: addressSchema,
  maxDeploymentsPerDay: positiveIntegerSchema, maxGasPerDeployment: positiveDecimalSchema,
  maxNativeCostPerDayWei: positiveDecimalSchema, maxPending: positiveIntegerSchema,
}).strict();

type WorkerManifest = z.infer<typeof manifestSchema>;
type WorkerDatabaseRuntime = z.infer<typeof databaseRuntimeSchema>;

export interface ProductionSetupWorkerConfig {
  readonly environment: "production";
  readonly chainId: 196;
  readonly mode: "OFF" | "CANARY" | "PUBLIC" | "DRAIN";
  readonly scopedWorkerToken: string;
  readonly supabaseUrl: string;
  readonly supabaseApiKey: string;
  readonly mainnetRpcUrl: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly runtimeArtifactPath: string;
  readonly factoryAddress: string;
  readonly factoryRuntimeCodeHash: string;
  readonly factoryDeploymentBlock: number;
  readonly signerAddress: string;
  readonly workerId: string;
  readonly leaseSeconds: number;
  readonly pollIntervalMs: number;
  readonly receiptTimeoutSeconds: number;
  readonly encryptionKey: Uint8Array;
  readonly minimumSignerBalanceWei: bigint;
  readonly maximumSignerBalanceWei: bigint;
  readonly limits: Readonly<{
    maxGasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    maxNativeCostWei: bigint;
  }>;
  readonly manifest: WorkerManifest;
  readonly runtimeArtifact: AccountRuntimeArtifact;
}

export interface ParseProductionSetupWorkerOptions {
  readonly manifestJson: string;
  readonly runtimeArtifactJson: string;
  readonly nowUnix?: number;
}

export function parseProductionSetupWorkerConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options: ParseProductionSetupWorkerOptions,
): ProductionSetupWorkerConfig {
  const values = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value?.trim() || undefined]),
  ) as Record<string, string | undefined>;
  for (const key of FORBIDDEN_ENV_KEYS) if (values[key]) throw new Error(`SETUP_WORKER_FORBIDDEN_ENV:${key}`);
  const required = [
    "AGENTPAY_ENVIRONMENT", "AGENTPAY_SETUP_MODE", "AGENTPAY_SETUP_WORKER_TOKEN", "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "XLAYER_MAINNET_RPC_URL", "AGENTPAY_ONBOARDING_MANIFEST_PATH", "AGENTPAY_ONBOARDING_MANIFEST_SHA256",
    "AGENTPAY_ACCOUNT_RUNTIME_ARTIFACT_PATH", "AGENTPAY_FACTORY_ADDRESS", "AGENTPAY_FACTORY_RUNTIME_CODE_HASH",
    "AGENTPAY_SETUP_DEPLOYER_PRIVATE_KEY", "AGENTPAY_SETUP_RAW_TX_ENCRYPTION_KEY", "AGENTPAY_SETUP_WORKER_ID",
    "AGENTPAY_SETUP_WORKER_LEASE_SECONDS", "AGENTPAY_SETUP_WORKER_POLL_INTERVAL_MS",
    "AGENTPAY_SETUP_RECEIPT_TIMEOUT_SECONDS",
    "AGENTPAY_SETUP_MAX_DEPLOYMENTS_PER_DAY", "AGENTPAY_SETUP_MAX_GAS_PER_DEPLOYMENT",
    "AGENTPAY_SETUP_MAX_NATIVE_COST_PER_DAY_WEI", "AGENTPAY_SETUP_MAX_PENDING",
    "AGENTPAY_SETUP_MAX_FEE_PER_GAS_WEI", "AGENTPAY_SETUP_MAX_PRIORITY_FEE_PER_GAS_WEI",
    "AGENTPAY_SETUP_MIN_SIGNER_BALANCE_WEI", "AGENTPAY_SETUP_MAX_SIGNER_BALANCE_WEI",
  ] as const;
  const missing = required.filter((key) => !values[key]);
  if (missing.length > 0) throw new Error(`SETUP_WORKER_CONFIG_MISSING:${missing.join(",")}`);
  if (values.AGENTPAY_ENVIRONMENT !== "production") throw new Error("SETUP_WORKER_ENVIRONMENT_INVALID");

  const manifest = parseJson(values.AGENTPAY_ONBOARDING_MANIFEST_PATH!, options.manifestJson, manifestSchema);
  const runtimeArtifact = parseJson(values.AGENTPAY_ACCOUNT_RUNTIME_ARTIFACT_PATH!, options.runtimeArtifactJson, artifactSchema);
  validateArtifact(runtimeArtifact);
  const manifestSha256 = bareHashSchema.parse(values.AGENTPAY_ONBOARDING_MANIFEST_SHA256);
  if (canonicalSha256(manifest) !== manifestSha256) throw new Error("SETUP_WORKER_MANIFEST_DIGEST_MISMATCH");
  if (manifest.account.creationCodeHash !== runtimeArtifact.creationCodeHash
    || manifest.account.runtimeTemplateHash !== runtimeArtifact.runtimeTemplateHash
    || canonicalJson(manifest.account.immutableReferences) !== canonicalJson(runtimeArtifact.immutableReferences)) {
    throw new Error("SETUP_WORKER_ARTIFACT_MISMATCH");
  }
  const mode = z.enum(["OFF", "CANARY", "PUBLIC", "DRAIN"]).parse(values.AGENTPAY_SETUP_MODE);
  if (mode !== manifest.setupMode) throw new Error("SETUP_WORKER_MODE_MISMATCH");
  const factoryAddress = getAddress(addressSchema.parse(values.AGENTPAY_FACTORY_ADDRESS)).toLowerCase();
  const factoryRuntimeCodeHash = hashSchema.parse(values.AGENTPAY_FACTORY_RUNTIME_CODE_HASH);
  if (factoryAddress !== manifest.factory.address.toLowerCase()
    || factoryRuntimeCodeHash !== manifest.factory.runtimeCodeHash) throw new Error("SETUP_WORKER_FACTORY_MISMATCH");

  const privateKey = values.AGENTPAY_SETUP_DEPLOYER_PRIVATE_KEY!;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("SETUP_WORKER_SIGNER_INVALID");
  const signerAddress = new Wallet(privateKey).address.toLowerCase();
  if (signerAddress !== manifest.sponsor.deployerAddress.toLowerCase()
    || [factoryAddress, manifest.factory.executor.toLowerCase()].includes(signerAddress)) {
    throw new Error("SETUP_WORKER_SIGNER_INVALID");
  }
  const encryptionKey = Buffer.from(values.AGENTPAY_SETUP_RAW_TX_ENCRYPTION_KEY!, "base64url");
  if (encryptionKey.byteLength !== 32) throw new Error("SETUP_WORKER_ENCRYPTION_KEY_INVALID");
  validateScopedWorkerToken(values.AGENTPAY_SETUP_WORKER_TOKEN!, options.nowUnix ?? Math.floor(Date.now() / 1_000));
  const supabaseUrl = requireHttpsUrl(values.SUPABASE_URL!, "SETUP_WORKER_SUPABASE_URL_INVALID");
  const parsedSupabaseApiKey = publishableKeySchema.safeParse(values.SUPABASE_PUBLISHABLE_KEY);
  if (!parsedSupabaseApiKey.success) throw new Error("SETUP_WORKER_SUPABASE_API_KEY_INVALID");
  const supabaseApiKey = parsedSupabaseApiKey.data;
  if (!new URL(supabaseUrl).hostname.endsWith(".supabase.co")) throw new Error("SETUP_WORKER_SUPABASE_URL_INVALID");
  const mainnetRpcUrl = requireHttpsUrl(values.XLAYER_MAINNET_RPC_URL!, "SETUP_WORKER_RPC_URL_INVALID");
  if (/test|dev|staging/i.test(new URL(mainnetRpcUrl).hostname)) throw new Error("SETUP_WORKER_RPC_URL_INVALID");

  const maxDeploymentsPerDay = parseSafeInteger(values.AGENTPAY_SETUP_MAX_DEPLOYMENTS_PER_DAY!);
  const maxGasLimit = parseBigint(values.AGENTPAY_SETUP_MAX_GAS_PER_DEPLOYMENT!);
  const maxNativeCostWei = parseBigint(values.AGENTPAY_SETUP_MAX_NATIVE_COST_PER_DAY_WEI!);
  const maxPending = parseSafeInteger(values.AGENTPAY_SETUP_MAX_PENDING!);
  if (maxDeploymentsPerDay !== manifest.sponsor.maxDeploymentsPerDay
    || maxGasLimit !== BigInt(manifest.sponsor.maxGasPerDeployment)
    || maxNativeCostWei !== BigInt(manifest.sponsor.maxNativeCostPerDayWei)
    || maxPending !== manifest.sponsor.maxPending) throw new Error("SETUP_WORKER_LIMIT_DRIFT");
  const maxFeePerGas = parseBigint(values.AGENTPAY_SETUP_MAX_FEE_PER_GAS_WEI!);
  const maxPriorityFeePerGas = parseBigint(values.AGENTPAY_SETUP_MAX_PRIORITY_FEE_PER_GAS_WEI!);
  const minimumSignerBalanceWei = parseBigint(values.AGENTPAY_SETUP_MIN_SIGNER_BALANCE_WEI!);
  const maximumSignerBalanceWei = parseBigint(values.AGENTPAY_SETUP_MAX_SIGNER_BALANCE_WEI!);
  if (maxPriorityFeePerGas > maxFeePerGas || minimumSignerBalanceWei > maximumSignerBalanceWei
    || maximumSignerBalanceWei > maxNativeCostWei) throw new Error("SETUP_WORKER_LIMITS_INVALID");
  const workerId = values.AGENTPAY_SETUP_WORKER_ID!;
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(workerId)) throw new Error("SETUP_WORKER_ID_INVALID");
  const leaseSeconds = parseSafeInteger(values.AGENTPAY_SETUP_WORKER_LEASE_SECONDS!);
  const pollIntervalMs = parseSafeInteger(values.AGENTPAY_SETUP_WORKER_POLL_INTERVAL_MS!);
  const receiptTimeoutSeconds = parseSafeInteger(values.AGENTPAY_SETUP_RECEIPT_TIMEOUT_SECONDS!);
  if (leaseSeconds < 15 || leaseSeconds > 900 || pollIntervalMs < 250 || pollIntervalMs > 60_000
    || receiptTimeoutSeconds < 30 || receiptTimeoutSeconds > 3_600) {
    throw new Error("SETUP_WORKER_TIMING_INVALID");
  }

  return deepFreeze({
    environment: "production" as const, chainId: 196 as const, mode,
    scopedWorkerToken: values.AGENTPAY_SETUP_WORKER_TOKEN!, supabaseUrl, supabaseApiKey, mainnetRpcUrl,
    manifestPath: values.AGENTPAY_ONBOARDING_MANIFEST_PATH!, manifestSha256,
    runtimeArtifactPath: values.AGENTPAY_ACCOUNT_RUNTIME_ARTIFACT_PATH!, factoryAddress,
    factoryRuntimeCodeHash, factoryDeploymentBlock: manifest.factory.deploymentBlock,
    signerAddress, workerId, leaseSeconds, pollIntervalMs, receiptTimeoutSeconds,
    encryptionKey: Uint8Array.from(encryptionKey),
    minimumSignerBalanceWei, maximumSignerBalanceWei,
    limits: { maxGasLimit, maxFeePerGas, maxPriorityFeePerGas, maxNativeCostWei },
    manifest, runtimeArtifact,
  });
}

export async function loadProductionSetupWorkerConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<ProductionSetupWorkerConfig> {
  const manifestPath = env.AGENTPAY_ONBOARDING_MANIFEST_PATH?.trim();
  const runtimeArtifactPath = env.AGENTPAY_ACCOUNT_RUNTIME_ARTIFACT_PATH?.trim();
  if (!manifestPath || !runtimeArtifactPath) throw new Error("SETUP_WORKER_CONFIG_MISSING:artifact paths");
  const [manifestJson, runtimeArtifactJson] = await Promise.all([
    readFile(manifestPath, "utf8"), readFile(runtimeArtifactPath, "utf8"),
  ]);
  return parseProductionSetupWorkerConfig(env, { manifestJson, runtimeArtifactJson });
}

export async function createProductionSetupWorkerRuntime(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options: { provider?: JsonRpcProvider; fetch?: typeof fetch } = {},
) {
  const config = await loadProductionSetupWorkerConfig(env);
  const provider = options.provider ?? new JsonRpcProvider(config.mainnetRpcUrl);
  const privateKey = env.AGENTPAY_SETUP_DEPLOYER_PRIVATE_KEY?.trim();
  if (!privateKey) throw new Error("SETUP_WORKER_SIGNER_INVALID");
  const signer = new Wallet(privateKey, provider);
  const factory = createFactory(config, provider);
  const fetchImplementation = options.fetch ?? fetch;
  await verifyWorkerRuntime(config, provider, signer, factory, fetchImplementation);
  const store = createProductionSetupWorkerStoreFromConfig({
    supabaseUrl: config.supabaseUrl,
    supabaseApiKey: config.supabaseApiKey,
    token: config.scopedWorkerToken,
    sponsorPolicy: {
      maxDeploymentsPerDay: config.manifest.sponsor.maxDeploymentsPerDay,
      maxGasPerDeployment: String(config.manifest.sponsor.maxGasPerDeployment),
      maxNativeCostPerDayWei: config.manifest.sponsor.maxNativeCostPerDayWei,
      maxPending: config.manifest.sponsor.maxPending,
    },
  });
  const reader = createVerificationReader(provider);
  const worker = createSetupDeploymentWorker({
    store,
    signer,
    chain: {
      async getCode(address) { return provider.getCode(address); },
      async getTransactionCount(address, blockTag) { return provider.getTransactionCount(address, blockTag); },
      async getFeeData() { return provider.getFeeData(); },
      async estimateGas(transaction) { return provider.estimateGas(transaction); },
      async broadcastTransaction(rawTransaction) { return provider.broadcastTransaction(rawTransaction); },
      async getTransactionReceipt(transactionHash) {
        const receipt = await provider.getTransactionReceipt(transactionHash);
        return receipt ? { status: receipt.status ?? 0, blockNumber: receipt.blockNumber, transactionHash: receipt.hash } : null;
      },
      async getBlockNumber() { return provider.getBlockNumber(); },
    },
    config: {
      workerId: config.workerId, leaseSeconds: config.leaseSeconds, encryptionKey: config.encryptionKey,
      factoryDeploymentBlock: config.factoryDeploymentBlock,
      receiptTimeoutSeconds: config.receiptTimeoutSeconds,
      limits: config.limits,
    },
    verifyPreflight: async (claim) => verifyClaimPreflight(config, provider, signer, factory, claim, fetchImplementation),
    verifyAccount: async (input) => verifySetupAccount({ reader, ...input }),
  });
  return Object.freeze({ config, worker });
}

async function verifyWorkerRuntime(
  config: ProductionSetupWorkerConfig,
  provider: JsonRpcProvider,
  signer: Wallet,
  factory: Contract,
  fetchImplementation: typeof fetch,
): Promise<void> {
  const [network, code, executor, usdt0, policyVersion, creationHash, balance, database] = await Promise.all([
    provider.getNetwork(), provider.getCode(config.factoryAddress), factory.executor(), factory.USDT0(),
    factory.POLICY_VERSION(), factory.accountCreationCodeHash(), provider.getBalance(signer.address),
    readWorkerDatabaseRuntime(config, fetchImplementation),
  ]);
  if (network.chainId !== 196n || code === "0x" || keccak256(code).toLowerCase() !== config.factoryRuntimeCodeHash
    || String(executor).toLowerCase() !== config.manifest.factory.executor.toLowerCase()
    || String(usdt0).toLowerCase() !== MAINNET_SETUP_USDT0.toLowerCase()
    || String(policyVersion).toLowerCase() !== POLICY_VERSION
    || String(creationHash).toLowerCase() !== config.manifest.account.creationCodeHash
    || balance < config.minimumSignerBalanceWei || balance > config.maximumSignerBalanceWei
    || !databaseMatches(config, database)) throw new Error("SETUP_WORKER_RUNTIME_MISMATCH");
}

async function verifyClaimPreflight(
  config: ProductionSetupWorkerConfig,
  provider: JsonRpcProvider,
  signer: Wallet,
  factory: Contract,
  claim: SetupWorkerClaim,
  fetchImplementation: typeof fetch,
): Promise<void> {
  await verifyWorkerRuntime(config, provider, signer, factory, fetchImplementation);
  const [ownerCode, predicted, salt] = await Promise.all([
    provider.getCode(claim.ownerAddress), factory.predictAccount(claim.ownerAddress), factory.deploymentSalt(claim.ownerAddress),
  ]);
  const runtimeHash = bindOwnerRuntimeArtifact(config.runtimeArtifact, claim.ownerAddress).runtimeCodeHash;
  if (ownerCode !== "0x" || claim.homeChainId !== 196
    || claim.ownerAddress.toLowerCase() === config.signerAddress
    || claim.executorAddress.toLowerCase() !== config.manifest.factory.executor.toLowerCase()
    || claim.factoryAddress.toLowerCase() !== config.factoryAddress
    || claim.factoryRuntimeCodeHash !== config.factoryRuntimeCodeHash
    || claim.manifestSha256 !== toEip712Sha256Bytes32(config.manifestSha256)
    || claim.accountCreationCodeHash !== config.manifest.account.creationCodeHash
    || claim.accountRuntimeCodeHash !== runtimeHash
    || String(predicted).toLowerCase() !== claim.predictedAccount.toLowerCase()
    || String(salt).toLowerCase() !== claim.deploymentSalt.toLowerCase()) throw new Error("SETUP_WORKER_PREFLIGHT_MISMATCH");
}

function createVerificationReader(provider: JsonRpcProvider): SetupAccountVerificationReader {
  return Object.freeze({
    async getChainId() { return Number((await provider.getNetwork()).chainId); },
    async getCode(address: string) { return provider.getCode(address); },
    async getAccountState(address: string) {
      const account = new Contract(address, [
        "function owner() view returns (address)", "function executor() view returns (address)",
        "function paused() view returns (bool)", "function domainSeparator() view returns (bytes32)",
        "function allowedTokens(address) view returns (bool)",
      ], provider);
      const [owner, executor, paused, domainSeparator, allowedUsdt0, allowedUsdc] = await Promise.all([
        account.owner(), account.executor(), account.paused(), account.domainSeparator(),
        account.allowedTokens(MAINNET_SETUP_USDT0), account.allowedTokens("0x74b7F16337b8972027F6196A17a631aC6dE26d22"),
      ]);
      return { owner, executor, paused, domainSeparator, allowedUsdt0, allowedUsdc };
    },
    async getLogs(filter: SetupVerificationLogFilter) {
      const logs = await provider.getLogs(filter);
      return logs.map((log) => ({
        address: log.address, topics: [...log.topics], data: log.data,
        blockNumber: log.blockNumber, transactionHash: log.transactionHash,
      }));
    },
  });
}

async function readWorkerDatabaseRuntime(
  config: ProductionSetupWorkerConfig,
  fetchImplementation: typeof fetch,
): Promise<WorkerDatabaseRuntime> {
  const response = await fetchImplementation(`${config.supabaseUrl}/rest/v1/rpc/read_production_setup_worker_runtime_state`, {
    method: "POST",
    headers: { apikey: config.supabaseApiKey, authorization: `Bearer ${config.scopedWorkerToken}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error("SETUP_WORKER_DATABASE_RUNTIME_UNAVAILABLE");
  return databaseRuntimeSchema.parse(await response.json());
}

function databaseMatches(config: ProductionSetupWorkerConfig, value: WorkerDatabaseRuntime): boolean {
  return value.setupMode === config.mode && value.manifestSha256 === toEip712Sha256Bytes32(config.manifestSha256)
    && value.factoryAddress.toLowerCase() === config.factoryAddress
    && value.factoryRuntimeCodeHash === config.factoryRuntimeCodeHash
    && value.executorAddress.toLowerCase() === config.manifest.factory.executor.toLowerCase()
    && value.sponsorDeployerAddress.toLowerCase() === config.signerAddress
    && value.maxDeploymentsPerDay === config.manifest.sponsor.maxDeploymentsPerDay
    && value.maxGasPerDeployment === String(config.manifest.sponsor.maxGasPerDeployment)
    && value.maxNativeCostPerDayWei === config.manifest.sponsor.maxNativeCostPerDayWei
    && value.maxPending === config.manifest.sponsor.maxPending;
}

function createFactory(config: ProductionSetupWorkerConfig, provider: JsonRpcProvider): Contract {
  return new Contract(config.factoryAddress, [
    "function executor() view returns (address)", "function USDT0() view returns (address)",
    "function POLICY_VERSION() view returns (bytes32)", "function accountCreationCodeHash() view returns (bytes32)",
    "function predictAccount(address) view returns (address)", "function deploymentSalt(address) view returns (bytes32)",
  ], provider);
}

function validateArtifact(artifact: AccountRuntimeArtifact): void {
  const length = (artifact.bytecode.length - 2) / 2;
  if (keccak256(artifact.bytecode).toLowerCase() !== artifact.runtimeTemplateHash) throw new Error("SETUP_WORKER_ARTIFACT_INVALID");
  let previousEnd = -1;
  for (const reference of artifact.immutableReferences) {
    if (reference.start < previousEnd || reference.start + reference.length > length) throw new Error("SETUP_WORKER_ARTIFACT_INVALID");
    previousEnd = reference.start + reference.length;
  }
}

function validateScopedWorkerToken(token: string, nowUnix: number): void {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !Number.isSafeInteger(nowUnix)) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (header.alg === "none" || payload.role !== "agentpay_setup_worker" || !Number.isSafeInteger(payload.exp)
      || payload.exp - nowUnix < 900 || payload.exp - nowUnix > 7_200) throw new Error();
  } catch {
    throw new Error("SETUP_WORKER_SCOPED_TOKEN_INVALID");
  }
}

function parseJson<T>(path: string, value: string, schema: z.ZodType<T>): T {
  try { return schema.parse(JSON.parse(value)); } catch { throw new Error(`SETUP_WORKER_FILE_INVALID:${path}`); }
}

function requireHttpsUrl(value: string, code: string): string {
  try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password) throw new Error(); return url.toString().replace(/\/$/, ""); }
  catch { throw new Error(code); }
}

function parseBigint(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("SETUP_WORKER_NUMBER_INVALID");
  return BigInt(value);
}

function parseSafeInteger(value: string): number {
  const parsed = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(parsed)) throw new Error("SETUP_WORKER_NUMBER_INVALID");
  return parsed;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}
