import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  MAINNET_SETUP_CHAIN_ID,
  MAINNET_SETUP_USDT0,
  createMainnetWalletSetupTypedData,
  toEip712Sha256Bytes32,
} from "@agentpay-ai/shared";
import { createProductionSetupWebStoreFromConfig } from "@agentpay-ai/mcp-server";
import {
  Contract,
  JsonRpcProvider,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
} from "ethers";
import { z } from "zod";

import type {
  ProductionOnboardingDependencies,
  ProductionOnboardingPolicyAdapter,
  ProductionSetupMode,
} from "./server.ts";

const ONBOARDING_ORIGIN = "https://onboard.agentpay.site" as const;
const ONBOARDING_HOST = "onboard.agentpay.site" as const;
const POLICY_VERSION = "0x9ffc525f976679dba1c4b7719e4a88a5ab29462373ca8c14513ab633beae5e3d";
const TOKEN_ALLOWLIST_HASH = "0xc0687130b337dbc04821b9bd064027dd46ef43a11adc8c2d98fccd719152b4a5";
const ROUTE_ALLOWLIST_HASH = "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd";
const FORBIDDEN_ENVIRONMENT_KEYS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SETUP_DEPLOYER_PRIVATE_KEY",
  "AGENTPAY_EXECUTOR_PRIVATE_KEY",
  "XLAYER_TESTNET_RPC_URL",
  "AGENTPAY_INITIAL_ROUTE_TARGETS",
  "AGENTPAY_ROUTE_TARGETS",
  "AGENTPAY_USDC_ADDRESS",
] as const;

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const lowercaseHashSchema = z.string().regex(/^0x[a-f0-9]{64}$/);
const bareDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const positiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const positiveDecimalSchema = z.string().regex(/^[1-9][0-9]*$/).max(78);
const immutableReferenceSchema = z.object({ start: z.number().int().nonnegative(), length: z.literal(20) }).strict();

const runtimeArtifactSchema = z.object({
  bytecode: z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/),
  immutableReferences: z.array(immutableReferenceSchema).min(1),
  creationCodeHash: lowercaseHashSchema,
  runtimeTemplateHash: lowercaseHashSchema,
}).strict();

const manifestSchema = z.object({
  environment: z.literal("production"),
  chainId: z.literal(MAINNET_SETUP_CHAIN_ID),
  setupMode: z.enum(["OFF", "CANARY", "PUBLIC", "DRAIN"]),
  onboardingOrigin: z.literal(ONBOARDING_ORIGIN),
  factory: z.object({
    address: addressSchema,
    deploymentTxHash: lowercaseHashSchema,
    deploymentBlock: positiveIntegerSchema,
    runtimeCodeHash: lowercaseHashSchema,
    executor: addressSchema,
    usdt0: z.literal(MAINNET_SETUP_USDT0),
    policyVersion: z.literal(POLICY_VERSION),
  }).strict(),
  account: z.object({
    creationCodeHash: lowercaseHashSchema,
    runtimeTemplateHash: lowercaseHashSchema,
    immutableReferences: z.array(immutableReferenceSchema).min(1),
    routeTargets: z.array(z.never()).length(0),
  }).strict(),
  sponsor: z.object({
    deployerAddress: addressSchema,
    maxDeploymentsPerDay: positiveIntegerSchema,
    maxGasPerDeployment: positiveIntegerSchema,
    maxNativeCostPerDayWei: positiveDecimalSchema,
    maxPending: positiveIntegerSchema,
  }).strict(),
}).strict();

const databaseRuntimeSchema = z.object({
  environment: z.literal("production"),
  chainId: z.literal(MAINNET_SETUP_CHAIN_ID),
  setupMode: z.enum(["OFF", "CANARY", "PUBLIC", "DRAIN"]),
  manifestSha256: lowercaseHashSchema,
  factoryAddress: addressSchema,
  factoryRuntimeCodeHash: lowercaseHashSchema,
  executorAddress: addressSchema,
  sponsorDeployerAddress: addressSchema,
  maxDeploymentsPerDay: positiveIntegerSchema,
  maxGasPerDeployment: positiveDecimalSchema,
  maxNativeCostPerDayWei: positiveDecimalSchema,
  maxPending: positiveIntegerSchema,
}).strict();

type MainnetOnboardingManifest = z.infer<typeof manifestSchema>;
export type AccountRuntimeArtifact = z.infer<typeof runtimeArtifactSchema>;
export type DatabaseSetupRuntime = z.infer<typeof databaseRuntimeSchema>;

export interface ProductionOnboardingConfig {
  readonly environment: "production";
  readonly chainId: 196;
  readonly mode: ProductionSetupMode;
  readonly scopedWebToken: string;
  readonly supabaseUrl: string;
  readonly mainnetRpcUrl: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly runtimeArtifactPath: string;
  readonly factoryAddress: string;
  readonly factoryRuntimeCodeHash: string;
  readonly cookieSecret: string;
  readonly capabilitySecret: string;
  readonly trustedProxyIdentity: string;
  readonly origin: typeof ONBOARDING_ORIGIN;
  readonly host: typeof ONBOARDING_HOST;
  readonly port: number;
  readonly manifest: MainnetOnboardingManifest;
  readonly runtimeArtifact: AccountRuntimeArtifact;
}

export interface ParseProductionOnboardingOptions {
  readonly manifestJson: string;
  readonly runtimeArtifactJson: string;
  readonly nowUnix?: number;
}

export interface ProductionOnboardingReadinessDependencies {
  getChainId(): Promise<number>;
  getFactoryCode(): Promise<string>;
  getFactoryIdentity(): Promise<Readonly<{
    executorAddress: string;
    usdt0: string;
    policyVersion: string;
    accountCreationCodeHash: string;
  }>>;
  readDatabaseRuntime(): Promise<DatabaseSetupRuntime>;
}

export function parseProductionOnboardingConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options: ParseProductionOnboardingOptions,
): ProductionOnboardingConfig {
  const normalized = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value?.trim() || undefined]),
  ) as Record<string, string | undefined>;
  for (const key of FORBIDDEN_ENVIRONMENT_KEYS) {
    if (normalized[key]) throw new Error(`SETUP_FORBIDDEN_ENV:${key}`);
  }
  const required = [
    "AGENTPAY_ENVIRONMENT", "AGENTPAY_SETUP_MODE", "AGENTPAY_SETUP_WEB_TOKEN", "SUPABASE_URL",
    "XLAYER_MAINNET_RPC_URL", "AGENTPAY_ONBOARDING_MANIFEST_PATH",
    "AGENTPAY_ONBOARDING_MANIFEST_SHA256", "AGENTPAY_ACCOUNT_RUNTIME_ARTIFACT_PATH",
    "AGENTPAY_FACTORY_ADDRESS", "AGENTPAY_FACTORY_RUNTIME_CODE_HASH", "AGENTPAY_COOKIE_HMAC_SECRET",
    "AGENTPAY_CAPABILITY_HASH_SECRET", "AGENTPAY_TRUSTED_PROXY_IDENTITY", "AGENTPAY_ONBOARDING_ORIGIN",
  ] as const;
  const missing = required.filter((key) => !normalized[key]);
  if (missing.length > 0) throw new Error(`SETUP_CONFIG_MISSING:${missing.join(",")}`);
  if (normalized.AGENTPAY_ENVIRONMENT !== "production") throw new Error("SETUP_ENVIRONMENT_INVALID");
  if (normalized.AGENTPAY_ONBOARDING_ORIGIN !== ONBOARDING_ORIGIN) throw new Error("SETUP_ORIGIN_INVALID");

  const mode = z.enum(["OFF", "CANARY", "PUBLIC", "DRAIN"]).parse(normalized.AGENTPAY_SETUP_MODE);
  const manifestDigest = bareDigestSchema.parse(normalized.AGENTPAY_ONBOARDING_MANIFEST_SHA256);
  const factoryAddress = getAddress(addressSchema.parse(normalized.AGENTPAY_FACTORY_ADDRESS)).toLowerCase();
  const factoryRuntimeCodeHash = lowercaseHashSchema.parse(normalized.AGENTPAY_FACTORY_RUNTIME_CODE_HASH);
  const supabaseUrl = requireProductionUrl(normalized.SUPABASE_URL!, "supabase");
  const mainnetRpcUrl = requireProductionUrl(normalized.XLAYER_MAINNET_RPC_URL!, "rpc");
  if (!new URL(supabaseUrl).hostname.endsWith(".supabase.co")) throw new Error("SETUP_SUPABASE_URL_INVALID");
  if (/test|dev|staging/i.test(new URL(mainnetRpcUrl).hostname)) throw new Error("SETUP_MAINNET_RPC_INVALID");

  const secrets = [
    normalized.AGENTPAY_COOKIE_HMAC_SECRET!,
    normalized.AGENTPAY_CAPABILITY_HASH_SECRET!,
    normalized.AGENTPAY_TRUSTED_PROXY_IDENTITY!,
  ];
  if (secrets.some((secret) => Buffer.byteLength(secret, "utf8") < 32) || new Set(secrets).size !== secrets.length) {
    throw new Error("SETUP_SECRETS_INVALID");
  }
  validateScopedToken(normalized.AGENTPAY_SETUP_WEB_TOKEN!, options.nowUnix ?? Math.floor(Date.now() / 1_000));

  const manifest = parseJson(options.manifestJson, manifestSchema, "SETUP_MANIFEST_INVALID");
  const runtimeArtifact = parseJson(options.runtimeArtifactJson, runtimeArtifactSchema, "SETUP_ARTIFACT_INVALID");
  validateArtifact(runtimeArtifact);
  if (canonicalManifestSha256(manifest) !== manifestDigest) throw new Error("SETUP_MANIFEST_DIGEST_MISMATCH");
  if (manifest.setupMode !== mode) throw new Error("SETUP_MODE_MISMATCH");
  if (manifest.factory.address.toLowerCase() !== factoryAddress) throw new Error("SETUP_FACTORY_MISMATCH");
  if (manifest.factory.runtimeCodeHash !== factoryRuntimeCodeHash) throw new Error("SETUP_FACTORY_HASH_MISMATCH");
  if (
    manifest.account.creationCodeHash !== runtimeArtifact.creationCodeHash ||
    manifest.account.runtimeTemplateHash !== runtimeArtifact.runtimeTemplateHash ||
    canonicalJson(manifest.account.immutableReferences) !== canonicalJson(runtimeArtifact.immutableReferences)
  ) throw new Error("SETUP_ARTIFACT_MISMATCH");
  const actors = [manifest.factory.address, manifest.factory.executor, manifest.sponsor.deployerAddress]
    .map((value) => value.toLowerCase());
  if (new Set(actors).size !== actors.length) throw new Error("SETUP_ACTORS_INVALID");

  const portValue = normalized.SETUP_WEB_PORT ?? "3000";
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("SETUP_PORT_INVALID");

  return deepFreeze({
    environment: "production",
    chainId: MAINNET_SETUP_CHAIN_ID,
    mode,
    scopedWebToken: normalized.AGENTPAY_SETUP_WEB_TOKEN!,
    supabaseUrl,
    mainnetRpcUrl,
    manifestPath: normalized.AGENTPAY_ONBOARDING_MANIFEST_PATH!,
    manifestSha256: manifestDigest,
    runtimeArtifactPath: normalized.AGENTPAY_ACCOUNT_RUNTIME_ARTIFACT_PATH!,
    factoryAddress,
    factoryRuntimeCodeHash,
    cookieSecret: normalized.AGENTPAY_COOKIE_HMAC_SECRET!,
    capabilitySecret: normalized.AGENTPAY_CAPABILITY_HASH_SECRET!,
    trustedProxyIdentity: normalized.AGENTPAY_TRUSTED_PROXY_IDENTITY!,
    origin: ONBOARDING_ORIGIN,
    host: ONBOARDING_HOST,
    port,
    manifest,
    runtimeArtifact,
  });
}

export async function verifyProductionOnboardingRuntime(
  config: ProductionOnboardingConfig,
  dependencies: ProductionOnboardingReadinessDependencies,
): Promise<void> {
  try {
    const [chainId, factoryCode, identity, rawDatabaseRuntime] = await Promise.all([
      dependencies.getChainId(),
      dependencies.getFactoryCode(),
      dependencies.getFactoryIdentity(),
      dependencies.readDatabaseRuntime(),
    ]);
    const database = databaseRuntimeSchema.parse(rawDatabaseRuntime);
    const expected = config.manifest;
    const equalAddress = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
    if (
      chainId !== MAINNET_SETUP_CHAIN_ID ||
      !/^0x(?:[a-fA-F0-9]{2})+$/.test(factoryCode) || factoryCode === "0x" ||
      keccak256(factoryCode).toLowerCase() !== config.factoryRuntimeCodeHash ||
      !equalAddress(identity.executorAddress, expected.factory.executor) ||
      !equalAddress(identity.usdt0, MAINNET_SETUP_USDT0) ||
      identity.policyVersion.toLowerCase() !== POLICY_VERSION ||
      identity.accountCreationCodeHash.toLowerCase() !== expected.account.creationCodeHash ||
      database.setupMode !== config.mode ||
      database.manifestSha256 !== toEip712Sha256Bytes32(config.manifestSha256) ||
      !equalAddress(database.factoryAddress, config.factoryAddress) ||
      database.factoryRuntimeCodeHash !== config.factoryRuntimeCodeHash ||
      !equalAddress(database.executorAddress, expected.factory.executor) ||
      !equalAddress(database.sponsorDeployerAddress, expected.sponsor.deployerAddress) ||
      database.maxDeploymentsPerDay !== expected.sponsor.maxDeploymentsPerDay ||
      database.maxGasPerDeployment !== String(expected.sponsor.maxGasPerDeployment) ||
      database.maxNativeCostPerDayWei !== expected.sponsor.maxNativeCostPerDayWei ||
      database.maxPending !== expected.sponsor.maxPending
    ) throw new Error("mismatch");
  } catch {
    throw new Error("SETUP_RUNTIME_MISMATCH");
  }
}

export function bindOwnerRuntimeArtifact(
  artifact: AccountRuntimeArtifact,
  ownerAddress: string,
): Readonly<{ bytecode: string; runtimeCodeHash: string }> {
  const validated = runtimeArtifactSchema.parse(artifact);
  validateArtifact(validated);
  const owner = getBytes(getAddress(ownerAddress));
  const runtime = Uint8Array.from(getBytes(validated.bytecode));
  for (const reference of validated.immutableReferences) runtime.set(owner, reference.start);
  const bytecode = hexlify(runtime).toLowerCase();
  return Object.freeze({ bytecode, runtimeCodeHash: keccak256(bytecode).toLowerCase() });
}

export function canonicalManifestSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export async function loadProductionOnboardingConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<ProductionOnboardingConfig> {
  const manifestPath = env.AGENTPAY_ONBOARDING_MANIFEST_PATH?.trim();
  const runtimeArtifactPath = env.AGENTPAY_ACCOUNT_RUNTIME_ARTIFACT_PATH?.trim();
  if (!manifestPath || !runtimeArtifactPath) throw new Error("SETUP_CONFIG_MISSING:artifact paths");
  const [manifestJson, runtimeArtifactJson] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(runtimeArtifactPath, "utf8"),
  ]);
  return parseProductionOnboardingConfig(env, { manifestJson, runtimeArtifactJson });
}

export async function createProductionOnboardingRuntime(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options: { fetch?: typeof fetch; provider?: JsonRpcProvider } = {},
): Promise<Readonly<{ config: ProductionOnboardingConfig; dependencies: ProductionOnboardingDependencies }>> {
  const config = await loadProductionOnboardingConfig(env);
  const provider = options.provider ?? new JsonRpcProvider(config.mainnetRpcUrl);
  const contract = createFactoryContract(config, provider);
  const readiness = createEthersReadiness(config, provider, contract, options.fetch ?? fetch);
  await verifyProductionOnboardingRuntime(config, readiness);
  const store = createProductionSetupWebStoreFromConfig({
    supabaseUrl: config.supabaseUrl,
    token: config.scopedWebToken,
    rateLimit: { windowSeconds: 60, maxRequests: 10 },
  });
  const dependencies: ProductionOnboardingDependencies = {
    store,
    policy: createEthersPolicyAdapter(config, provider, contract),
    mode: config.mode,
    origin: config.origin,
    host: config.host,
    cookieSecret: config.cookieSecret,
    capabilitySecret: config.capabilitySecret,
    trustedProxyIdentity: config.trustedProxyIdentity,
    clock: () => new Date(),
    rateLimiter: createBoundedRateLimiter(),
    ready: async () => {
      try {
        await verifyProductionOnboardingRuntime(config, readiness);
        return true;
      } catch {
        return false;
      }
    },
  };
  return Object.freeze({ config, dependencies: Object.freeze(dependencies) });
}

function createFactoryContract(config: ProductionOnboardingConfig, provider: JsonRpcProvider): Contract {
  return new Contract(config.factoryAddress, [
    "function executor() view returns (address)",
    "function USDT0() view returns (address)",
    "function POLICY_VERSION() view returns (bytes32)",
    "function accountCreationCodeHash() view returns (bytes32)",
    "function deploymentSalt(address owner) view returns (bytes32)",
    "function predictAccount(address owner) view returns (address)",
  ], provider);
}

function createEthersReadiness(
  config: ProductionOnboardingConfig,
  provider: JsonRpcProvider,
  contract: Contract,
  fetchImplementation: typeof fetch,
): ProductionOnboardingReadinessDependencies {
  return {
    async getChainId() { return Number((await provider.getNetwork()).chainId); },
    async getFactoryCode() { return provider.getCode(config.factoryAddress); },
    async getFactoryIdentity() {
      const [executorAddress, usdt0, policyVersion, accountCreationCodeHash] = await Promise.all([
        contract.executor(), contract.USDT0(), contract.POLICY_VERSION(), contract.accountCreationCodeHash(),
      ]);
      return { executorAddress, usdt0, policyVersion, accountCreationCodeHash } as const;
    },
    async readDatabaseRuntime() {
      const response = await fetchImplementation(`${config.supabaseUrl}/rest/v1/rpc/read_production_setup_runtime_state`, {
        method: "POST",
        headers: {
          apikey: config.scopedWebToken,
          authorization: `Bearer ${config.scopedWebToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      if (!response.ok) throw new Error("runtime state unavailable");
      return databaseRuntimeSchema.parse(await response.json());
    },
  };
}

function createEthersPolicyAdapter(
  config: ProductionOnboardingConfig,
  provider: JsonRpcProvider,
  contract: Contract,
): ProductionOnboardingPolicyAdapter {
  const adapter: ProductionOnboardingPolicyAdapter = {
    async getOwnerCode(ownerAddress: string) { return provider.getCode(ownerAddress); },
    async derive(input: Parameters<ProductionOnboardingPolicyAdapter["derive"]>[0]) {
      const ownerAddress = getAddress(input.ownerAddress).toLowerCase();
      const [deploymentSalt, predictedAccount, accountCreationCodeHash] = await Promise.all([
        contract.deploymentSalt(ownerAddress),
        contract.predictAccount(ownerAddress),
        contract.accountCreationCodeHash(),
      ]);
      const accountRuntimeCodeHash = bindOwnerRuntimeArtifact(config.runtimeArtifact, ownerAddress).runtimeCodeHash;
      const policyContext = {
        ownerAddress,
        executorAddress: config.manifest.factory.executor,
        factoryAddress: config.factoryAddress,
        factoryRuntimeCodeHash: config.factoryRuntimeCodeHash,
        deploymentSalt,
        predictedAccount,
        accountCreationCodeHash,
        accountRuntimeCodeHash,
        manifestSha256: toEip712Sha256Bytes32(config.manifestSha256),
        sponsorDeployerAddress: config.manifest.sponsor.deployerAddress,
        currentUnixTime: input.currentUnixTime,
      } as const;
      const typedData = createMainnetWalletSetupTypedData({
        setupIntentId: input.setupIntentId,
        deploymentNonce: input.deploymentNonce,
        owner: ownerAddress,
        executor: policyContext.executorAddress,
        homeChainId: MAINNET_SETUP_CHAIN_ID,
        environment: "production",
        deadline: input.deadline,
        factory: policyContext.factoryAddress,
        factoryRuntimeCodeHash: policyContext.factoryRuntimeCodeHash,
        deploymentSalt: policyContext.deploymentSalt,
        predictedAccount: policyContext.predictedAccount,
        accountCreationCodeHash: policyContext.accountCreationCodeHash,
        accountRuntimeCodeHash: policyContext.accountRuntimeCodeHash,
        token: MAINNET_SETUP_USDT0,
        tokenAllowlistHash: TOKEN_ALLOWLIST_HASH,
        routeAllowlistHash: ROUTE_ALLOWLIST_HASH,
        manifestSha256: policyContext.manifestSha256,
      }, policyContext);
      return Object.freeze({ typedData, policyContext: Object.freeze(policyContext) });
    },
  };
  return Object.freeze(adapter);
}

function createBoundedRateLimiter() {
  const entries = new Map<string, { start: number; count: number }>();
  return Object.freeze({
    allow(key: string, now: Date): boolean {
      const timestamp = now.getTime();
      const digest = createHash("sha256").update(key).digest("hex");
      const existing = entries.get(digest);
      if (existing && timestamp - existing.start < 60_000) {
        if (existing.count >= 30) return false;
        entries.set(digest, { start: existing.start, count: existing.count + 1 });
        return true;
      }
      for (const [candidate, value] of entries) {
        if (timestamp - value.start >= 60_000) entries.delete(candidate);
      }
      if (entries.size >= 4_096) return false;
      entries.set(digest, { start: timestamp, count: 1 });
      return true;
    },
  });
}

function validateScopedToken(token: string, nowUnix: number): void {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("parts");
    const claims = z.object({
      role: z.literal("agentpay_setup_web"),
      exp: z.number().int().positive(),
      iat: z.number().int().nonnegative().optional(),
    }).passthrough().parse(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
    const remaining = claims.exp - nowUnix;
    if (remaining < 900 || remaining > 7_200) throw new Error("expiry");
    if (claims.iat !== undefined && claims.iat > nowUnix + 60) throw new Error("issued in future");
  } catch {
    throw new Error("SETUP_WEB_TOKEN_INVALID");
  }
}

function validateArtifact(artifact: AccountRuntimeArtifact): void {
  if (keccak256(artifact.bytecode).toLowerCase() !== artifact.runtimeTemplateHash) {
    throw new Error("SETUP_ARTIFACT_HASH_MISMATCH");
  }
  const byteLength = getBytes(artifact.bytecode).length;
  let previousEnd = -1;
  for (const reference of [...artifact.immutableReferences].sort((a, b) => a.start - b.start)) {
    if (reference.start < previousEnd || reference.start + reference.length > byteLength) {
      throw new Error("SETUP_ARTIFACT_REFERENCES_INVALID");
    }
    previousEnd = reference.start + reference.length;
  }
}

function parseJson<T>(raw: string, schema: z.ZodType<T>, code: string): T {
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new Error(code);
  }
}

function requireProductionUrl(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error("url");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`SETUP_${label.toUpperCase()}_URL_INVALID`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite canonical JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported canonical JSON value");
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
