import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createSupabaseAgentPayRepositoriesFromConfig,
  type SupabaseRuntimeConfig,
} from "@agentpay-ai/mcp-server";
import type { PaymentReviewRepository } from "@agentpay-ai/mcp-server";
import {
  configureStableTokenMetadataOverrides,
  type SetupIntentRecord,
  type StableTokenMetadataOverrides,
} from "@agentpay-ai/shared";

import {
  createEthersAgentPayAccountDeployer,
  type EthersAgentPayAccountDeployerConfig,
} from "./services/account-deployer.ts";
import {
  completeWalletSetup,
  createEthersSetupSignatureVerifier,
  DEFAULT_SETUP_HOME_CHAIN_ID,
  type AgentPayAccountDeployer,
  type CompleteWalletSetupDependencies,
  type CompleteWalletSetupOutput,
} from "./services/complete-wallet-setup.ts";
import type { SetupWebDependencies } from "./server.ts";

const requiredEnvNames = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "XLAYER_RPC_URL",
  "SETUP_DEPLOYER_PRIVATE_KEY",
] as const;
const privateKeyPattern = /^0x[a-fA-F0-9]{64}$/;
const hexDataPattern = /^0x(?:[a-fA-F0-9]{2})+$/;
const bytes32Pattern = /^0x[a-fA-F0-9]{64}$/;
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const setupHomeChainIds = new Set([196, 1952]);

export interface SetupWebRuntimeConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  xlayerRpcUrl: string;
  xlayerRpcUrls?: Partial<Record<number, string>>;
  setupDeployerPrivateKey: string;
  agentPayAccountBytecode: string;
  accountVersion?: "v2";
  agentPayAccountBytecodeHash?: string;
  reviewTokenSecret?: string;
  homeChainId?: number;
  stableTokenOverrides?: StableTokenMetadataOverrides;
  initialAllowedRouteTargets?: string[];
  setupWebPort?: number;
}

export interface SetupWebRepositoryBundle {
  setupIntents: CompleteWalletSetupDependencies["setupIntents"] & {
    getSetupIntent(setupIntentId: string): Promise<SetupIntentRecord | null>;
  };
  wallets: CompleteWalletSetupDependencies["wallets"];
  tenantBindings?: {
    bindVerifiedOwner(ownerAddress: string, chainId: number): Promise<{ tenantId: string }>;
  };
  paymentReviews?: PaymentReviewRepository;
  paymentIntents?: NonNullable<SetupWebDependencies["paymentIntents"]>;
}

export interface SetupWebRuntimeOptions {
  clock?: () => Date;
  fetch?: typeof fetch;
  createRepositories?: (config: SupabaseRuntimeConfig) => SetupWebRepositoryBundle;
  createDeployer?: (config: EthersAgentPayAccountDeployerConfig) => AgentPayAccountDeployer;
}

export function loadSetupWebConfigEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string | undefined> {
  const configPath = env.AGENTPAY_CONFIG ? expandHome(env.AGENTPAY_CONFIG) : undefined;

  if (!configPath) {
    return { ...env };
  }

  const rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const configEnv = Object.fromEntries(
    Object.entries(rawConfig)
      .filter(([, value]) => typeof value === "string")
      .map(([key, value]) => [key, value as string]),
  );

  return {
    ...configEnv,
    ...env,
  };
}

export function parseSetupWebEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): SetupWebRuntimeConfig {
  const normalized = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value?.trim() === "" ? undefined : value?.trim()]),
  ) as Record<string, string | undefined>;
  const bytecode = normalized.AGENTPAY_ACCOUNT_BYTECODE ?? readBytecode(normalized.AGENTPAY_ACCOUNT_BYTECODE_PATH);
  const accountVersion = normalized.AGENTPAY_ACCOUNT_VERSION ?? "v2";
  const agentPayAccountBytecodeHash = normalized.AGENTPAY_ACCOUNT_BYTECODE_HASH;
  const initialAllowedRouteTargets = parseAddressList(normalized.AGENTPAY_INITIAL_ROUTE_TARGETS);
  const parsedHomeChainId = parseOptionalHomeChainId(normalized.AGENTPAY_HOME_CHAIN_ID);
  const homeChainId = parsedHomeChainId ?? DEFAULT_SETUP_HOME_CHAIN_ID;
  const xlayerRpcUrls = parseXLayerRpcUrls(normalized);
  const stableTokenOverrides = parseStableTokenOverrides(normalized);
  const productionEnvironment = normalized.AGENTPAY_ENVIRONMENT === "production";
  const missing = [
    ...requiredEnvNames.filter((name) => !normalized[name]),
    !bytecode ? "AGENTPAY_ACCOUNT_BYTECODE" : undefined,
  ].filter((name): name is string => Boolean(name));
  const invalid = [
    normalized.SUPABASE_URL && !isHttpUrl(normalized.SUPABASE_URL) ? "SUPABASE_URL" : undefined,
    normalized.XLAYER_RPC_URL && !isHttpUrl(normalized.XLAYER_RPC_URL) ? "XLAYER_RPC_URL" : undefined,
    normalized.XLAYER_MAINNET_RPC_URL && !isHttpUrl(normalized.XLAYER_MAINNET_RPC_URL)
      ? "XLAYER_MAINNET_RPC_URL"
      : undefined,
    normalized.XLAYER_TESTNET_RPC_URL && !isHttpUrl(normalized.XLAYER_TESTNET_RPC_URL)
      ? "XLAYER_TESTNET_RPC_URL"
      : undefined,
    normalized.SETUP_DEPLOYER_PRIVATE_KEY && !privateKeyPattern.test(normalized.SETUP_DEPLOYER_PRIVATE_KEY)
      ? "SETUP_DEPLOYER_PRIVATE_KEY"
      : undefined,
    bytecode && !hexDataPattern.test(bytecode) ? "AGENTPAY_ACCOUNT_BYTECODE" : undefined,
    accountVersion !== "v2" ? "AGENTPAY_ACCOUNT_VERSION" : undefined,
    agentPayAccountBytecodeHash && !bytes32Pattern.test(agentPayAccountBytecodeHash)
      ? "AGENTPAY_ACCOUNT_BYTECODE_HASH"
      : undefined,
    normalized.AGENTPAY_REVIEW_TOKEN_SECRET && normalized.AGENTPAY_REVIEW_TOKEN_SECRET.length < 32
      ? "AGENTPAY_REVIEW_TOKEN_SECRET"
      : undefined,
    initialAllowedRouteTargets.some((target) => !addressPattern.test(target))
      ? "AGENTPAY_INITIAL_ROUTE_TARGETS"
      : undefined,
    normalized.AGENTPAY_HOME_CHAIN_ID && !parsedHomeChainId ? "AGENTPAY_HOME_CHAIN_ID" : undefined,
    parsedHomeChainId === 196 ? "mainnet setup deployment surface" : undefined,
    normalized.SETUP_WEB_PORT && !isPort(normalized.SETUP_WEB_PORT) ? "SETUP_WEB_PORT" : undefined,
    productionEnvironment ? "production setup deployment surface" : undefined,
    ...validateStableTokenOverrideAddresses(normalized),
  ].filter((name): name is string => Boolean(name));

  if (missing.length > 0 || invalid.length > 0) {
    throw new Error(createConfigErrorMessage(missing, invalid));
  }

  return omitUndefined({
    supabaseUrl: normalized.SUPABASE_URL,
    serviceRoleKey: normalized.SUPABASE_SERVICE_ROLE_KEY,
    xlayerRpcUrl: normalized.XLAYER_RPC_URL,
    xlayerRpcUrls,
    setupDeployerPrivateKey: normalized.SETUP_DEPLOYER_PRIVATE_KEY,
    agentPayAccountBytecode: bytecode,
    accountVersion: normalized.AGENTPAY_ACCOUNT_VERSION ? "v2" : undefined,
    agentPayAccountBytecodeHash,
    reviewTokenSecret: normalized.AGENTPAY_REVIEW_TOKEN_SECRET,
    homeChainId,
    stableTokenOverrides,
    initialAllowedRouteTargets: initialAllowedRouteTargets.length > 0 ? initialAllowedRouteTargets : undefined,
    setupWebPort: normalized.SETUP_WEB_PORT ? Number(normalized.SETUP_WEB_PORT) : undefined,
  }) as SetupWebRuntimeConfig;
}

export function createSetupWebDependencies(
  config: SetupWebRuntimeConfig,
  options: SetupWebRuntimeOptions = {},
): SetupWebDependencies {
  configureStableTokenMetadataOverrides(config.stableTokenOverrides ?? {});
  const repositories = (options.createRepositories ?? createSupabaseAgentPayRepositoriesFromConfig)(
    omitUndefined({
      supabaseUrl: config.supabaseUrl,
      serviceRoleKey: config.serviceRoleKey,
      fetch: options.fetch,
    }) as SupabaseRuntimeConfig,
  );
  const deployer = (options.createDeployer ?? createEthersAgentPayAccountDeployer)({
    rpcUrl: config.xlayerRpcUrl,
    rpcUrls: config.xlayerRpcUrls,
    deployerPrivateKey: config.setupDeployerPrivateKey,
    bytecode: config.agentPayAccountBytecode,
    ...(config.accountVersion ? { accountVersion: config.accountVersion } : {}),
    ...(config.agentPayAccountBytecodeHash ? { bytecodeHash: config.agentPayAccountBytecodeHash } : {}),
  });
  const completeDependencies: CompleteWalletSetupDependencies = {
    setupIntents: repositories.setupIntents,
    wallets: repositories.wallets,
    deployer,
    signatureVerifier: createEthersSetupSignatureVerifier(),
    clock: options.clock ?? (() => new Date()),
    homeChainId: config.homeChainId,
    initialAllowedRouteTargets: config.initialAllowedRouteTargets,
    bindVerifiedOwner: repositories.tenantBindings?.bindVerifiedOwner,
  };

  return {
    async getSetupIntent(setupIntentId) {
      return repositories.setupIntents.getSetupIntent(setupIntentId);
    },
    async completeWalletSetup(input): Promise<CompleteWalletSetupOutput> {
      return completeWalletSetup(input, completeDependencies);
    },
    clock: completeDependencies.clock,
    paymentReviews: repositories.paymentReviews,
    paymentIntents: repositories.paymentIntents,
    reviewTokenSecret: config.reviewTokenSecret ?? config.serviceRoleKey,
  };
}

function readBytecode(path: string | undefined): string | undefined {
  return path ? readFileSync(path, "utf8").trim() : undefined;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function parseAddressList(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];
}

function parseOptionalHomeChainId(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && setupHomeChainIds.has(parsed) ? parsed : undefined;
}

function parseXLayerRpcUrls(env: Record<string, string | undefined>): Partial<Record<number, string>> | undefined {
  const rpcUrls = omitUndefined({
    196: env.XLAYER_MAINNET_RPC_URL,
    1952: env.XLAYER_TESTNET_RPC_URL,
  }) as Partial<Record<number, string>>;

  return Object.keys(rpcUrls).length > 0 ? rpcUrls : undefined;
}

function parseStableTokenOverrides(env: Record<string, string | undefined>): StableTokenMetadataOverrides | undefined {
  const xlayerOverrides = {
    ...(env.AGENTPAY_XLAYER_USDT0_ADDRESS
      ? {
          USDT0: {
            address: env.AGENTPAY_XLAYER_USDT0_ADDRESS,
          },
        }
      : {}),
    ...(env.AGENTPAY_XLAYER_USDC_ADDRESS
      ? {
          USDC: {
            address: env.AGENTPAY_XLAYER_USDC_ADDRESS,
          },
        }
      : {}),
  };
  const xlayerTestnetOverrides = {
    ...(env.AGENTPAY_XLAYER_TESTNET_USDT0_ADDRESS
      ? {
          USDT0: {
            address: env.AGENTPAY_XLAYER_TESTNET_USDT0_ADDRESS,
          },
        }
      : {}),
    ...(env.AGENTPAY_XLAYER_TESTNET_USDC_ADDRESS
      ? {
          USDC: {
            address: env.AGENTPAY_XLAYER_TESTNET_USDC_ADDRESS,
          },
        }
      : {}),
  };
  const overrides = omitUndefined({
    196: Object.keys(xlayerOverrides).length > 0 ? xlayerOverrides : undefined,
    1952: Object.keys(xlayerTestnetOverrides).length > 0 ? xlayerTestnetOverrides : undefined,
  }) as StableTokenMetadataOverrides;

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function validateStableTokenOverrideAddresses(env: Record<string, string | undefined>): string[] {
  return [
    "AGENTPAY_XLAYER_USDT0_ADDRESS",
    "AGENTPAY_XLAYER_USDC_ADDRESS",
    "AGENTPAY_XLAYER_TESTNET_USDT0_ADDRESS",
    "AGENTPAY_XLAYER_TESTNET_USDC_ADDRESS",
  ].filter((name) => env[name] && !addressPattern.test(env[name]));
}

function createConfigErrorMessage(missing: string[], invalid: string[]): string {
  const parts = [
    missing.length > 0 ? `missing: ${missing.join(", ")}` : undefined,
    invalid.length > 0 ? `invalid: ${invalid.join(", ")}` : undefined,
  ].filter(Boolean);

  return `Invalid AgentPay setup web environment (${parts.join("; ")}).`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPort(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535;
}

function omitUndefined<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;
}
