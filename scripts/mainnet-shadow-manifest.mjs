import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { keccak256 } from "ethers";

export const MAINNET_CHAIN_ID = 196;
export const STAGING_CHAIN_ID = 1952;
export const MAINNET_CAIP2 = "eip155:196";
export const MAINNET_USDT0_ADDRESS = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
export const MAINNET_USDT0_DECIMALS = 6;
export const MAINNET_USDT0_CODE_HASH =
  "0x4d9be648c5bf39973670d9f8b481d5d0b971e6a2db2deccc6b98cde21c5dd83e";
export const MAINNET_ACCOUNT_CREATION_BYTECODE_HASH =
  "0x41fb5a4c59d1af753553e5dcf9e9ed345506ecaa8040298d17dc9c629fbd5b49";
export const MAINNET_MIGRATION_HEAD = "20260714180000_canary_owner_rebinding";
export const FORBIDDEN_PRODUCTION_RUNTIME_ENV_REFS = Object.freeze([
  "XLAYER_RPC_URL",
  "XLAYER_TESTNET_RPC_URL",
  "AGENTPAY_XLAYER_TESTNET_USDT0_ADDRESS",
  "AGENTPAY_XLAYER_TESTNET_USDC_ADDRESS",
]);
export const MAINNET_SHADOW_MANIFEST_PATH = fileURLToPath(
  new URL("../ops/manifests/xlayer-mainnet.shadow.json", import.meta.url),
);

const HEX_HASH_PATTERN = /^0x[a-f0-9]{64}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/i;
const REQUIRED_SECRET_KEYS = new Set([
  "privateKey",
  "secret",
  "serviceRoleKey",
  "apiKey",
  "facilitatorCredential",
  "rawTransaction",
  "sessionSigningKey",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addIssue(issues, path, message) {
  issues.push(`${path}: ${message}`);
}

function requireRecord(value, path, issues) {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return false;
  }
  return true;
}

function requireEqual(value, expected, path, issues) {
  if (value !== expected) {
    addIssue(issues, path, `must equal ${JSON.stringify(expected)}`);
  }
}

function requireArrayEqual(value, expected, path, issues) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((entry, index) => entry !== expected[index])) {
    addIssue(issues, path, `must equal ${JSON.stringify(expected)}`);
  }
}

function requireNullableString(value, path, issues) {
  if (value !== null && typeof value !== "string") {
    addIssue(issues, path, "must be a string or null");
  }
}

function requireAddress(value, path, issues, { nullable = false } = {}) {
  if (nullable && value === null) {
    return;
  }
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    addIssue(issues, path, nullable ? "must be a valid address or null" : "must be a valid address");
  }
}

function requireHash(value, path, issues, { nullable = false } = {}) {
  if (nullable && value === null) {
    return;
  }
  if (typeof value !== "string" || !HEX_HASH_PATTERN.test(value)) {
    addIssue(issues, path, nullable ? "must be a 32-byte hex hash or null" : "must be a 32-byte hex hash");
  }
}

function requireSha256(value, path, issues, { nullable = false } = {}) {
  if (nullable && value === null) {
    return;
  }
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    addIssue(issues, path, nullable ? "must be a SHA-256 digest or null" : "must be a SHA-256 digest");
  }
}

function visitForSecretKeys(value, path, issues) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitForSecretKeys(entry, `${path}[${index}]`, issues));
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (REQUIRED_SECRET_KEYS.has(key)) {
      addIssue(issues, `${path}.${key}`, "secret-bearing fields are forbidden in a shadow manifest");
    }
    visitForSecretKeys(child, `${path}.${key}`, issues);
  }
}

export async function computeArtifactDigests(rootDir = fileURLToPath(new URL("..", import.meta.url))) {
  const lockfile = await readFile(`${rootDir}/package-lock.json`);
  const bytecodeText = (await readFile(`${rootDir}/packages/cli/assets/AgentPayAccount.bin`, "utf8")).trim();

  if (!/^0x(?:[a-fA-F0-9]{2})+$/.test(bytecodeText)) {
    throw new Error("AgentPayAccount.bin is not valid deploy bytecode.");
  }

  return {
    packageLockSha256: createHash("sha256").update(lockfile).digest("hex"),
    creationBytecodeKeccak256: keccak256(bytecodeText).toLowerCase(),
  };
}

export function buildMainnetShadowManifest({ artifactDigests, generatedAt } = {}) {
  if (!artifactDigests || typeof artifactDigests !== "object") {
    throw new Error("Artifact digests are required to build the mainnet shadow manifest.");
  }

  return {
    schemaVersion: 1,
    kind: "agentpay-mainnet-shadow-manifest",
    ...(generatedAt === undefined ? {} : { generatedAt }),
    status: "SHADOW_ONLY",
    environment: "production",
    executionMode: "OFF",
    chain: {
      name: "X Layer",
      chainId: MAINNET_CHAIN_ID,
      caip2: MAINNET_CAIP2,
      nativeSymbol: "OKB",
      rpcEnvRef: "XLAYER_MAINNET_RPC_URL",
      expectedRpcHost: "rpc.xlayer.tech",
    },
    database: {
      environment: "production",
      projectRef: null,
      urlEnvRef: "SUPABASE_PRODUCTION_URL",
      serviceRoleKeyEnvRef: "SUPABASE_PRODUCTION_SERVICE_ROLE_KEY",
      databaseUrlEnvRef: "DIRECT_URL_PRODUCTION",
      migrationHead: MAINNET_MIGRATION_HEAD,
    },
    secretRefs: {
      namespace: "agentpay/production",
      executorPrivateKeyEnvRef: "EXECUTOR_PRIVATE_KEY",
      setupDeployerPrivateKeyEnvRef: "SETUP_DEPLOYER_PRIVATE_KEY",
      sessionHashKeyEnvRef: "AGENTPAY_SESSION_HASH_KEY",
      reviewTokenSecretEnvRef: "AGENTPAY_REVIEW_TOKEN_SECRET",
      rawTransactionEncryptionKeyEnvRef: "AGENTPAY_RAW_TX_ENCRYPTION_KEY",
    },
    release: {
      commit: null,
      packageLockSha256: artifactDigests.packageLockSha256,
      creationBytecodeKeccak256: artifactDigests.creationBytecodeKeccak256,
      runtimeBytecodeKeccak256: null,
      abiSha256: null,
      migrationHead: MAINNET_MIGRATION_HEAD,
    },
    contract: {
      version: "v2",
      address: null,
      deploymentTxHash: null,
      creationBytecodeHash: artifactDigests.creationBytecodeKeccak256,
      runtimeBytecodeHash: null,
      ownerAddress: null,
      executorAddress: null,
      deployerAddress: null,
      paused: null,
      domain: {
        name: "AgentPay",
        version: "1",
        chainId: MAINNET_CHAIN_ID,
        verifyingContract: null,
      },
      allowedTokens: [MAINNET_USDT0_ADDRESS],
      allowedRouteTargets: [],
    },
    token: {
      symbol: "USDT0",
      address: MAINNET_USDT0_ADDRESS,
      decimals: MAINNET_USDT0_DECIMALS,
      codeHash: MAINNET_USDT0_CODE_HASH,
    },
    x402: {
      enabled: false,
      network: MAINNET_CAIP2,
      asset: "USDT0",
      tokenAddress: MAINNET_USDT0_ADDRESS,
      decimals: MAINNET_USDT0_DECIMALS,
      price: "$0.01",
      priceAtomic: "10000",
      syncSettle: true,
      payToEnvRef: "AGENTPAY_A2MCP_PAYMENT_PAY_TO",
      facilitatorEnvRef: "AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL",
      toolAllowlist: ["execute_payment"],
    },
    domains: {
      publicOrigin: null,
      consumerOrigin: "https://wallet.agentpay.site/mcp",
      siweAudience: "https://wallet.agentpay.site/mcp",
    },
    canaryPolicy: {
      maxAcceptedLifecycles: 1,
      invoiceMaxUsdt0: "0.10",
      accountFundingUsdt0: "0.10",
      payerFeeWalletFundingMaxUsdt0: "0.02",
      aspFeeUsdt0: "0.01",
      maxNativeFee: "0",
      executorGasMaxOkb: "0.005",
      allowlistedTenantId: null,
      allowlistedOwnerAddress: null,
      allowlistedAccountAddress: null,
      payerAddress: null,
      recipientAddress: null,
    },
    isolation: {
      stagingChainId: STAGING_CHAIN_ID,
      productionChainId: MAINNET_CHAIN_ID,
      forbiddenRuntimeEnvRefs: [
        ...FORBIDDEN_PRODUCTION_RUNTIME_ENV_REFS,
      ],
      secretNamespaces: {
        staging: "agentpay/staging",
        production: "agentpay/production",
      },
      separateSupabase: true,
      separateExecutor: true,
      separateDeployment: true,
    },
  };
}

export function validateMainnetShadowManifest(manifest, { artifactDigests } = {}) {
  const issues = [];

  if (!requireRecord(manifest, "manifest", issues)) {
    return { valid: false, errors: issues };
  }

  visitForSecretKeys(manifest, "manifest", issues);
  requireEqual(manifest.schemaVersion, 1, "schemaVersion", issues);
  requireEqual(manifest.kind, "agentpay-mainnet-shadow-manifest", "kind", issues);
  requireEqual(manifest.status, "SHADOW_ONLY", "status", issues);
  requireEqual(manifest.environment, "production", "environment", issues);
  requireEqual(manifest.executionMode, "OFF", "executionMode", issues);

  if (manifest.generatedAt !== undefined && (typeof manifest.generatedAt !== "string" || Number.isNaN(Date.parse(manifest.generatedAt)))) {
    addIssue(issues, "generatedAt", "must be a valid ISO timestamp when present");
  }

  const chain = manifest.chain;
  if (requireRecord(chain, "chain", issues)) {
    requireEqual(chain.name, "X Layer", "chain.name", issues);
    requireEqual(chain.chainId, MAINNET_CHAIN_ID, "chain.chainId", issues);
    requireEqual(chain.caip2, MAINNET_CAIP2, "chain.caip2", issues);
    requireEqual(chain.nativeSymbol, "OKB", "chain.nativeSymbol", issues);
    requireEqual(chain.rpcEnvRef, "XLAYER_MAINNET_RPC_URL", "chain.rpcEnvRef", issues);
    requireEqual(chain.expectedRpcHost, "rpc.xlayer.tech", "chain.expectedRpcHost", issues);
  }

  const database = manifest.database;
  if (requireRecord(database, "database", issues)) {
    requireEqual(database.environment, "production", "database.environment", issues);
    requireEqual(database.urlEnvRef, "SUPABASE_PRODUCTION_URL", "database.urlEnvRef", issues);
    requireEqual(database.serviceRoleKeyEnvRef, "SUPABASE_PRODUCTION_SERVICE_ROLE_KEY", "database.serviceRoleKeyEnvRef", issues);
    requireEqual(database.databaseUrlEnvRef, "DIRECT_URL_PRODUCTION", "database.databaseUrlEnvRef", issues);
    requireEqual(database.migrationHead, MAINNET_MIGRATION_HEAD, "database.migrationHead", issues);
    requireNullableString(database.projectRef, "database.projectRef", issues);
    if (database.projectRef !== null && !/^[a-z0-9]{20}$/.test(database.projectRef)) {
      addIssue(issues, "database.projectRef", "must be a Supabase project ref or null in shadow mode");
    }
  }

  const secretRefs = manifest.secretRefs;
  if (requireRecord(secretRefs, "secretRefs", issues)) {
    requireEqual(secretRefs.namespace, "agentpay/production", "secretRefs.namespace", issues);
    requireEqual(secretRefs.executorPrivateKeyEnvRef, "EXECUTOR_PRIVATE_KEY", "secretRefs.executorPrivateKeyEnvRef", issues);
    requireEqual(secretRefs.setupDeployerPrivateKeyEnvRef, "SETUP_DEPLOYER_PRIVATE_KEY", "secretRefs.setupDeployerPrivateKeyEnvRef", issues);
    requireEqual(secretRefs.sessionHashKeyEnvRef, "AGENTPAY_SESSION_HASH_KEY", "secretRefs.sessionHashKeyEnvRef", issues);
    requireEqual(secretRefs.reviewTokenSecretEnvRef, "AGENTPAY_REVIEW_TOKEN_SECRET", "secretRefs.reviewTokenSecretEnvRef", issues);
    requireEqual(
      secretRefs.rawTransactionEncryptionKeyEnvRef,
      "AGENTPAY_RAW_TX_ENCRYPTION_KEY",
      "secretRefs.rawTransactionEncryptionKeyEnvRef",
      issues,
    );
  }

  const release = manifest.release;
  if (requireRecord(release, "release", issues)) {
    requireNullableString(release.commit, "release.commit", issues);
    requireSha256(release.packageLockSha256, "release.packageLockSha256", issues);
    requireHash(release.creationBytecodeKeccak256, "release.creationBytecodeKeccak256", issues);
    requireEqual(
      release.creationBytecodeKeccak256?.toLowerCase(),
      MAINNET_ACCOUNT_CREATION_BYTECODE_HASH.toLowerCase(),
      "release.creationBytecodeKeccak256",
      issues,
    );
    requireHash(release.runtimeBytecodeKeccak256, "release.runtimeBytecodeKeccak256", issues, { nullable: true });
    requireSha256(release.abiSha256, "release.abiSha256", issues, { nullable: true });
    requireEqual(release.migrationHead, MAINNET_MIGRATION_HEAD, "release.migrationHead", issues);
  }

  const contract = manifest.contract;
  if (requireRecord(contract, "contract", issues)) {
    requireEqual(contract.version, "v2", "contract.version", issues);
    requireAddress(contract.address, "contract.address", issues, { nullable: true });
    requireHash(contract.deploymentTxHash, "contract.deploymentTxHash", issues, { nullable: true });
    requireHash(contract.creationBytecodeHash, "contract.creationBytecodeHash", issues);
    requireEqual(
      contract.creationBytecodeHash?.toLowerCase(),
      MAINNET_ACCOUNT_CREATION_BYTECODE_HASH.toLowerCase(),
      "contract.creationBytecodeHash",
      issues,
    );
    requireHash(contract.runtimeBytecodeHash, "contract.runtimeBytecodeHash", issues, { nullable: true });
    requireAddress(contract.ownerAddress, "contract.ownerAddress", issues, { nullable: true });
    requireAddress(contract.executorAddress, "contract.executorAddress", issues, { nullable: true });
    requireAddress(contract.deployerAddress, "contract.deployerAddress", issues, { nullable: true });
    if (contract.ownerAddress && contract.executorAddress && contract.ownerAddress.toLowerCase() === contract.executorAddress.toLowerCase()) {
      addIssue(issues, "contract", "owner and executor must be different addresses");
    }
    if (contract.deployerAddress && contract.executorAddress && contract.deployerAddress.toLowerCase() === contract.executorAddress.toLowerCase()) {
      addIssue(issues, "contract", "deployer and executor must be different addresses");
    }
    if (contract.paused !== null && typeof contract.paused !== "boolean") {
      addIssue(issues, "contract.paused", "must be boolean or null");
    }
    if (requireRecord(contract.domain, "contract.domain", issues)) {
      requireEqual(contract.domain.name, "AgentPay", "contract.domain.name", issues);
      requireEqual(contract.domain.version, "1", "contract.domain.version", issues);
      requireEqual(contract.domain.chainId, MAINNET_CHAIN_ID, "contract.domain.chainId", issues);
      requireAddress(contract.domain.verifyingContract, "contract.domain.verifyingContract", issues, { nullable: true });
    }
    requireArrayEqual(contract.allowedTokens, [MAINNET_USDT0_ADDRESS], "contract.allowedTokens", issues);
    requireArrayEqual(contract.allowedRouteTargets, [], "contract.allowedRouteTargets", issues);
  }

  const token = manifest.token;
  if (requireRecord(token, "token", issues)) {
    requireEqual(token.symbol, "USDT0", "token.symbol", issues);
    requireEqual(token.address?.toLowerCase(), MAINNET_USDT0_ADDRESS.toLowerCase(), "token.address", issues);
    requireEqual(token.decimals, MAINNET_USDT0_DECIMALS, "token.decimals", issues);
    requireEqual(token.codeHash?.toLowerCase(), MAINNET_USDT0_CODE_HASH.toLowerCase(), "token.codeHash", issues);
  }

  const x402 = manifest.x402;
  if (requireRecord(x402, "x402", issues)) {
    requireEqual(x402.enabled, false, "x402.enabled", issues);
    requireEqual(x402.network, MAINNET_CAIP2, "x402.network", issues);
    requireEqual(x402.asset, "USDT0", "x402.asset", issues);
    requireEqual(x402.tokenAddress?.toLowerCase(), MAINNET_USDT0_ADDRESS.toLowerCase(), "x402.tokenAddress", issues);
    requireEqual(x402.decimals, MAINNET_USDT0_DECIMALS, "x402.decimals", issues);
    requireEqual(x402.price, "$0.01", "x402.price", issues);
    requireEqual(x402.priceAtomic, "10000", "x402.priceAtomic", issues);
    requireEqual(x402.syncSettle, true, "x402.syncSettle", issues);
    requireEqual(x402.payToEnvRef, "AGENTPAY_A2MCP_PAYMENT_PAY_TO", "x402.payToEnvRef", issues);
    requireEqual(x402.facilitatorEnvRef, "AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL", "x402.facilitatorEnvRef", issues);
    requireArrayEqual(x402.toolAllowlist, ["execute_payment"], "x402.toolAllowlist", issues);
  }

  const domains = manifest.domains;
  if (requireRecord(domains, "domains", issues)) {
    requireNullableString(domains.publicOrigin, "domains.publicOrigin", issues);
    requireEqual(domains.consumerOrigin, "https://wallet.agentpay.site/mcp", "domains.consumerOrigin", issues);
    requireEqual(domains.siweAudience, "https://wallet.agentpay.site/mcp", "domains.siweAudience", issues);
  }

  const canary = manifest.canaryPolicy;
  if (requireRecord(canary, "canaryPolicy", issues)) {
    requireEqual(canary.maxAcceptedLifecycles, 1, "canaryPolicy.maxAcceptedLifecycles", issues);
    requireEqual(canary.invoiceMaxUsdt0, "0.10", "canaryPolicy.invoiceMaxUsdt0", issues);
    requireEqual(canary.accountFundingUsdt0, "0.10", "canaryPolicy.accountFundingUsdt0", issues);
    requireEqual(canary.payerFeeWalletFundingMaxUsdt0, "0.02", "canaryPolicy.payerFeeWalletFundingMaxUsdt0", issues);
    requireEqual(canary.aspFeeUsdt0, "0.01", "canaryPolicy.aspFeeUsdt0", issues);
    requireEqual(canary.maxNativeFee, "0", "canaryPolicy.maxNativeFee", issues);
    requireEqual(canary.executorGasMaxOkb, "0.005", "canaryPolicy.executorGasMaxOkb", issues);
    for (const key of [
      "allowlistedTenantId",
      "allowlistedOwnerAddress",
      "allowlistedAccountAddress",
      "payerAddress",
      "recipientAddress",
    ]) {
      requireNullableString(canary[key], `canaryPolicy.${key}`, issues);
    }
  }

  const isolation = manifest.isolation;
  if (requireRecord(isolation, "isolation", issues)) {
    requireEqual(isolation.stagingChainId, STAGING_CHAIN_ID, "isolation.stagingChainId", issues);
    requireEqual(isolation.productionChainId, MAINNET_CHAIN_ID, "isolation.productionChainId", issues);
    requireArrayEqual(
      isolation.forbiddenRuntimeEnvRefs,
      FORBIDDEN_PRODUCTION_RUNTIME_ENV_REFS,
      "isolation.forbiddenRuntimeEnvRefs",
      issues,
    );
    if (requireRecord(isolation.secretNamespaces, "isolation.secretNamespaces", issues)) {
      requireEqual(isolation.secretNamespaces.staging, "agentpay/staging", "isolation.secretNamespaces.staging", issues);
      requireEqual(
        isolation.secretNamespaces.production,
        "agentpay/production",
        "isolation.secretNamespaces.production",
        issues,
      );
    }
    requireEqual(isolation.separateSupabase, true, "isolation.separateSupabase", issues);
    requireEqual(isolation.separateExecutor, true, "isolation.separateExecutor", issues);
    requireEqual(isolation.separateDeployment, true, "isolation.separateDeployment", issues);
  }

  if (artifactDigests && typeof artifactDigests === "object") {
    requireEqual(
      manifest.release?.packageLockSha256,
      artifactDigests.packageLockSha256,
      "release.packageLockSha256",
      issues,
    );
    requireEqual(
      manifest.release?.creationBytecodeKeccak256?.toLowerCase(),
      artifactDigests.creationBytecodeKeccak256?.toLowerCase(),
      "release.creationBytecodeKeccak256",
      issues,
    );
    requireEqual(
      manifest.contract?.creationBytecodeHash?.toLowerCase(),
      artifactDigests.creationBytecodeKeccak256?.toLowerCase(),
      "contract.creationBytecodeHash",
      issues,
    );
  }

  return { valid: issues.length === 0, errors: issues };
}

function hasRuntimeValue(env, name) {
  return typeof env?.[name] === "string" && env[name].trim() !== "";
}

export function validateProductionEnvironmentIsolation(env, { manifest } = {}) {
  const issues = [];
  if (!isRecord(env)) {
    return { valid: false, errors: ["environment: must be an object"] };
  }

  requireEqual(env.AGENTPAY_ENVIRONMENT, "production", "AGENTPAY_ENVIRONMENT", issues);
  requireEqual(String(env.AGENTPAY_HOME_CHAIN_ID ?? ""), String(MAINNET_CHAIN_ID), "AGENTPAY_HOME_CHAIN_ID", issues);
  requireEqual(env.AGENTPAY_ACCOUNT_VERSION, "v2", "AGENTPAY_ACCOUNT_VERSION", issues);

  if (!hasRuntimeValue(env, "XLAYER_MAINNET_RPC_URL")) {
    addIssue(issues, "XLAYER_MAINNET_RPC_URL", "must be configured for production");
  } else {
    try {
      const rpcUrl = new URL(env.XLAYER_MAINNET_RPC_URL);
      if (rpcUrl.protocol !== "https:" || rpcUrl.hostname !== "rpc.xlayer.tech") {
        addIssue(issues, "XLAYER_MAINNET_RPC_URL", "must use the pinned mainnet RPC host over HTTPS");
      }
    } catch {
      addIssue(issues, "XLAYER_MAINNET_RPC_URL", "must be a valid HTTPS URL");
    }
  }

  for (const name of FORBIDDEN_PRODUCTION_RUNTIME_ENV_REFS) {
    if (hasRuntimeValue(env, name)) {
      addIssue(issues, name, "must be absent in production");
    }
  }

  if (!hasRuntimeValue(env, "SUPABASE_PRODUCTION_URL")) {
    addIssue(issues, "SUPABASE_PRODUCTION_URL", "must be configured for production");
  }
  if (hasRuntimeValue(env, "SUPABASE_URL")) {
    addIssue(issues, "SUPABASE_URL", "generic Supabase URL is forbidden in production");
  }
  if (!hasRuntimeValue(env, "DIRECT_URL_PRODUCTION")) {
    addIssue(issues, "DIRECT_URL_PRODUCTION", "must be configured for production migrations");
  }
  if (hasRuntimeValue(env, "DIRECT_URL")) {
    addIssue(issues, "DIRECT_URL", "generic database URL is forbidden in production");
  }

  if (hasRuntimeValue(env, "AGENTPAY_A2MCP_PAYMENT_ENABLED")) {
    requireEqual(env.AGENTPAY_A2MCP_PAYMENT_ENABLED, "false", "AGENTPAY_A2MCP_PAYMENT_ENABLED", issues);
  }
  if (hasRuntimeValue(env, "AGENTPAY_EXECUTION_MODE")) {
    requireEqual(env.AGENTPAY_EXECUTION_MODE, "OFF", "AGENTPAY_EXECUTION_MODE", issues);
  }

  if (manifest) {
    const manifestResult = validateMainnetShadowManifest(manifest);
    for (const error of manifestResult.errors) {
      addIssue(issues, "manifest", error);
    }
  }

  return { valid: issues.length === 0, errors: issues };
}

export function assertMainnetShadowManifest(manifest, options = {}) {
  const result = validateMainnetShadowManifest(manifest, options);
  if (!result.valid) {
    throw new Error(`PRODUCTION_NOT_READY: invalid mainnet shadow manifest (${result.errors.join("; ")})`);
  }
  return manifest;
}
