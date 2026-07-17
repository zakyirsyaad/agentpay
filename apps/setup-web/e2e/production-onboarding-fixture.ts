import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";

import {
  Interface,
  TypedDataEncoder,
  Wallet,
  keccak256,
  type TransactionRequest,
} from "ethers";

import {
  createInMemoryProductionSetupStores,
  type ProductionSetupWorkerStore,
} from "@agentpay-ai/mcp-server";
import {
  MAINNET_SETUP_ROUTE_ALLOWLIST_HASH,
  MAINNET_SETUP_TOKEN_ALLOWLIST_HASH,
  MAINNET_SETUP_USDT0,
  createMainnetWalletSetupTypedData,
  type MainnetWalletSetupPolicyContext,
} from "@agentpay-ai/shared";

import {
  createProductionOnboardingHandler,
  type ProductionOnboardingDependencies,
  type ProductionSetupMode,
} from "../src/onboarding/server.ts";
import { createSetupDeploymentWorker } from "../src/worker/setup-deployment-worker.ts";
import { verifySetupAccount } from "../src/worker/setup-account-verifier.ts";

const origin = "https://onboard.agentpay.site" as const;
const host = "onboard.agentpay.site" as const;
const proxyIdentity = "e2e-proxy-identity-012345678901234567890123";
const cookieSecret = "e2e-cookie-secret-012345678901234567890123";
const capabilitySecret = "e2e-capability-secret-01234567890123456789";
const initialNow = Date.parse("2026-07-17T08:00:00.000Z");
const setupIntentId = "setup_production_e2e_0001";
const deploymentNonce = hex32("1");
const executorAddress = address("2");
const factoryAddress = address("3");
const factoryRuntimeCodeHash = hex32("4");
const deploymentSalt = hex32("5");
const predictedAccount = address("6");
const accountCreationCodeHash = hex32("7");
const manifestSha256 = hex32("9");
const runtimeCode = "0x60016000556001600055";
const accountRuntimeCodeHash = keccak256(runtimeCode).toLowerCase();
const deployer = new Wallet(`0x${"b".repeat(64)}`);
const owner = new Wallet(`0x${"a".repeat(64)}`);
const factoryEvents = new Interface([
  "event AccountDeployed(address indexed owner,address indexed account,bytes32 indexed salt,bytes32 authorizationHash)",
]);

export interface ProductionOnboardingFixtureOptions {
  readonly mode?: ProductionSetupMode;
  readonly rateLimited?: boolean;
  readonly existingUser?: boolean;
  readonly existingAccount?: boolean;
  readonly failBroadcastRecordOnce?: boolean;
  readonly failVerification?: boolean;
}

export async function createProductionOnboardingE2eFixture(
  options: ProductionOnboardingFixtureOptions = {},
) {
  let now = initialNow;
  let idCounter = 0;
  let randomFill = 10;
  let server: Server | undefined;
  let port = 0;
  let deployed = options.existingAccount ?? false;
  let receiptReady = false;
  let broadcastRecordFailurePending = options.failBroadcastRecordOnce ?? false;
  let activeWallet = options.existingUser ?? false;
  const broadcastAttempts: string[] = [];
  let transactionHash: string | undefined;
  const stores = createInMemoryProductionSetupStores({
    createId: () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`,
    createFencingToken: () => `fence_${String(++idCounter).padStart(4, "0")}`,
    sponsorPolicy: {
      deployerAddress: deployer.address,
      maxDeploymentsPerDay: 10,
      maxGasPerDeployment: 1_000_000n,
      maxNativeCostPerDayWei: 10_000_000_000_000_000n,
      maxPending: 4,
    },
  });
  const workerStore: ProductionSetupWorkerStore = {
    ...stores.worker,
    async markBroadcastResult(input) {
      if (broadcastRecordFailurePending) {
        broadcastRecordFailurePending = false;
        throw new Error("simulated lost database response");
      }
      return stores.worker.markBroadcastResult(input);
    },
  };
  const policyBase = Object.freeze({
    executorAddress,
    factoryAddress,
    factoryRuntimeCodeHash,
    deploymentSalt,
    predictedAccount,
    accountCreationCodeHash,
    accountRuntimeCodeHash,
    manifestSha256,
    sponsorDeployerAddress: deployer.address,
  });
  const typedData = deriveTypedData({
    ...policyBase,
    ownerAddress: owner.address.toLowerCase(),
    currentUnixTime: Math.floor(now / 1_000),
  }, String(Math.floor(now / 1_000) + 600));
  const ownerSignature = await owner.signTypedData(
    typedData.domain,
    typedData.types as unknown as Record<string, Array<{ name: string; type: string }>>,
    typedData.message,
  );
  const dependencies: ProductionOnboardingDependencies = {
    store: stores.web,
    mode: options.mode ?? "PUBLIC",
    origin,
    host,
    cookieSecret,
    capabilitySecret,
    trustedProxyIdentity: proxyIdentity,
    clock: () => new Date(now),
    randomBytes: (size) => new Uint8Array(size).fill(++randomFill),
    createSetupIntentId: () => setupIntentId,
    createDeploymentNonce: () => deploymentNonce,
    authorizationLifetimeSeconds: 600,
    rateLimiter: { async allow() { return !(options.rateLimited ?? false); } },
    policy: {
      async derive(input) {
        const context: MainnetWalletSetupPolicyContext = {
          ...policyBase,
          ownerAddress: input.ownerAddress,
          currentUnixTime: input.currentUnixTime,
        };
        return { typedData: deriveTypedData(context, input.deadline), policyContext: context };
      },
      async getOwnerCode() { return "0x"; },
    },
  };
  const handler = createProductionOnboardingHandler(dependencies);
  const chain = {
    async getCode(requestedAddress: string) {
      return requestedAddress.toLowerCase() === predictedAccount.toLowerCase() && deployed ? runtimeCode : "0x";
    },
    async getTransactionCount(_address: string, _blockTag: "latest" | "pending") { return 7; },
    async getFeeData() { return { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }; },
    async estimateGas(_transaction: TransactionRequest) { return 500_000n; },
    async broadcastTransaction(rawTransaction: string) {
      broadcastAttempts.push(rawTransaction);
      const hash = keccak256(rawTransaction).toLowerCase();
      if (transactionHash) throw new Error("already known");
      transactionHash = hash;
      return { hash };
    },
    async getTransactionReceipt(requestedHash: string) {
      if (!receiptReady || requestedHash.toLowerCase() !== transactionHash) return null;
      return { status: 1, blockNumber: 150, transactionHash: requestedHash.toLowerCase() };
    },
    async getBlockNumber() { return 160; },
  };
  const signer = {
    async getAddress() { return deployer.address; },
    async getNonce(_blockTag?: "latest" | "pending") { return 7; },
    async signTransaction(transaction: TransactionRequest) { return deployer.signTransaction(transaction); },
  };

  function createWorker() {
    return createSetupDeploymentWorker({
      store: workerStore,
      signer,
      chain,
      config: {
        workerId: "production-e2e-worker",
        leaseSeconds: 15,
        encryptionKey: new Uint8Array(32).fill(23),
        factoryDeploymentBlock: 100,
        receiptTimeoutSeconds: 60,
        limits: {
          maxGasLimit: 1_000_000n,
          maxFeePerGas: 3_000_000_000n,
          maxPriorityFeePerGas: 2_000_000_000n,
          maxNativeCostWei: 3_000_000_000_000_000n,
        },
      },
      async verifyPreflight(claim) {
        if (claim.homeChainId !== 196 || claim.factoryAddress.toLowerCase() !== factoryAddress.toLowerCase()
          || claim.accountRuntimeCodeHash.toLowerCase() !== accountRuntimeCodeHash) {
          throw new Error("SETUP_PREFLIGHT_MISMATCH");
        }
      },
      async verifyAccount(input) {
        if (options.failVerification) throw new Error("simulated verifier failure");
        const txHash = input.receipt?.transactionHash ?? hex32("e");
        const encoded = factoryEvents.encodeEventLog(factoryEvents.getEvent("AccountDeployed")!, [
          input.claim.ownerAddress,
          input.claim.predictedAccount,
          input.claim.deploymentSalt,
          input.claim.authorizationHash,
        ]);
        return verifySetupAccount({
          ...input,
          reader: {
            async getChainId() { return 196; },
            async getCode() { return runtimeCode; },
            async getAccountState() {
              return {
                owner: input.claim.ownerAddress,
                executor: input.claim.executorAddress,
                paused: false,
                domainSeparator: TypedDataEncoder.hashDomain({
                  name: "AgentPay",
                  version: "1",
                  chainId: 196,
                  verifyingContract: input.claim.predictedAccount,
                }),
                allowedUsdt0: true,
                allowedUsdc: false,
              };
            },
            async getLogs(filter) {
              if (filter.address.toLowerCase() !== factoryAddress.toLowerCase()
                || filter.fromBlock > 150 || filter.toBlock < 150) return [];
              return [{
                address: factoryAddress,
                topics: encoded.topics,
                data: encoded.data,
                blockNumber: 150,
                transactionHash: txHash,
              }];
            },
          },
        });
      },
    });
  }

  async function start(requestedPort = 0) {
    server = createServer(async (incoming, outgoing) => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
          else if (value !== undefined) headers.set(name, value);
        }
        headers.set("host", host);
        const path = incoming.url ?? "/";
        if (path.startsWith("/api/")) {
          headers.set("origin", origin);
          headers.set("x-agentpay-proxy-identity", proxyIdentity);
          headers.set("x-agentpay-client-address", "198.51.100.42");
        }
        const method = incoming.method ?? "GET";
        const init: RequestInit & { duplex?: "half" } = { method, headers };
        if (method !== "GET" && method !== "HEAD") {
          init.body = Readable.toWeb(incoming) as ReadableStream;
          init.duplex = "half";
        }
        const response = await handler(new Request(`${origin}${path}`, init));
        outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        outgoing.writeHead(503, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: "SETUP_UNAVAILABLE" }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(requestedPort, "127.0.0.1", resolve);
    });
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("E2E server did not bind.");
    port = bound.port;
  }

  async function closeServer() {
    const active = server;
    server = undefined;
    if (active) await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
  }

  await start();
  return {
    owner,
    ownerSignature,
    typedData,
    stores,
    broadcastAttempts,
    get url() { return `http://localhost:${port}/setup`; },
    oauthState() {
      const completed = stores.inspect.jobs().some((job) => job.status === "COMPLETED");
      return activeWallet || completed
        ? { status: 200, state: "OAUTH_READY" as const }
        : { status: 409, state: "AGENTPAY_SETUP_REQUIRED" as const, setupUrl: `${origin}/setup` };
    },
    async runWorkerStart() {
      const result = await createWorker().processNext(new Date(now).toISOString());
      if (result.status === "COMPLETED") activeWallet = true;
      return result;
    },
    async restartWorkerAndRebroadcast() {
      now += 20_000;
      return createWorker().processNext(new Date(now).toISOString());
    },
    async settleAndComplete() {
      receiptReady = true;
      deployed = true;
      now += 20_000;
      const result = await createWorker().processNext(new Date(now).toISOString());
      if (result.status === "COMPLETED") activeWallet = true;
      return result;
    },
    advanceTime(milliseconds: number) { now += milliseconds; },
    async restartWeb() {
      const previousPort = port;
      await closeServer();
      await start(previousPort);
    },
    close: closeServer,
  };
}

function deriveTypedData(context: MainnetWalletSetupPolicyContext, deadline: string) {
  return createMainnetWalletSetupTypedData({
    setupIntentId,
    deploymentNonce,
    owner: context.ownerAddress,
    executor: context.executorAddress,
    homeChainId: 196,
    environment: "production",
    deadline,
    factory: context.factoryAddress,
    factoryRuntimeCodeHash: context.factoryRuntimeCodeHash,
    deploymentSalt: context.deploymentSalt,
    predictedAccount: context.predictedAccount,
    accountCreationCodeHash: context.accountCreationCodeHash,
    accountRuntimeCodeHash: context.accountRuntimeCodeHash,
    token: MAINNET_SETUP_USDT0,
    tokenAllowlistHash: MAINNET_SETUP_TOKEN_ALLOWLIST_HASH,
    routeAllowlistHash: MAINNET_SETUP_ROUTE_ALLOWLIST_HASH,
    manifestSha256: context.manifestSha256,
  }, context);
}

function address(digit: string): string { return `0x${digit.repeat(40)}`; }
function hex32(digit: string): string { return `0x${digit.repeat(64)}`; }
