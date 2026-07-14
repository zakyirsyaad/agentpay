import { Interface, JsonRpcProvider, TypedDataEncoder, keccak256, toUtf8Bytes } from "ethers";

const MAINNET_CHAIN_ID = 196;
const MAINNET_USDT0_ADDRESS = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
export const MAINNET_USDC_ADDRESS = "0x74b7F16337b8972027F6196A17a631aC6dE26d22";
const MAINNET_USDT0_CODE_HASH =
  "0x4d9be648c5bf39973670d9f8b481d5d0b971e6a2db2deccc6b98cde21c5dd83e";
export const MAINNET_ACCOUNT_CREATION_BYTECODE_HASH =
  "0x41fb5a4c59d1af753553e5dcf9e9ed345506ecaa8040298d17dc9c629fbd5b49";

const accountInterface = new Interface([
  "function owner() view returns (address)",
  "function executor() view returns (address)",
  "function paused() view returns (bool)",
  "function domainSeparator() view returns (bytes32)",
  "function allowedTokens(address token) view returns (bool)",
]);
const erc20Interface = new Interface(["function decimals() view returns (uint8)"]);
const tokenAllowedTopic = keccak256(toUtf8Bytes("TokenAllowedUpdated(address,bool)"));
const routeTargetAllowedTopic = keccak256(toUtf8Bytes("RouteTargetAllowedUpdated(address,bool)"));

export const MAINNET_LOG_BLOCK_RANGE = 100;

export interface MainnetLogFilter {
  address: string;
  topics?: Array<string | string[] | null>;
  fromBlock: number;
  toBlock: number;
}

export interface MainnetAccountLog {
  topics: readonly string[];
  data: string;
  blockNumber: number;
}

export interface MainnetLogScanOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  interChunkDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * X Layer limits eth_getLogs requests to a 100-block range. Keep this read-only
 * scan bounded and retry transient provider throttling without ever widening the
 * requested range or treating a partial scan as valid.
 */
export async function fetchLogsInChunks(
  getBlockNumber: () => Promise<number>,
  getLogs: (filter: MainnetLogFilter) => Promise<ReadonlyArray<MainnetAccountLog>>,
  filter: Omit<MainnetLogFilter, "toBlock">,
  options: MainnetLogScanOptions = {},
): Promise<MainnetAccountLog[]> {
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const interChunkDelayMs = options.interChunkDelayMs ?? 250;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("RPC log scan maxAttempts must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("RPC log scan retryDelayMs must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(interChunkDelayMs) || interChunkDelayMs < 0) {
    throw new Error("RPC log scan interChunkDelayMs must be a non-negative safe integer.");
  }
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) await sleep(retryDelayMs * attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("RPC operation failed.");
  }

  if (!Number.isSafeInteger(filter.fromBlock) || filter.fromBlock < 0) {
    throw new Error("RPC log scan start block must be a non-negative safe integer.");
  }

  const latestBlock = await withRetry(getBlockNumber);
  if (!Number.isSafeInteger(latestBlock) || latestBlock < 0) {
    throw new Error("RPC log scan latest block must be a non-negative safe integer.");
  }
  if (filter.fromBlock > latestBlock) {
    throw new Error("RPC log scan start block is after the latest block.");
  }

  const logs: MainnetAccountLog[] = [];
  for (let fromBlock = filter.fromBlock; fromBlock <= latestBlock; fromBlock += MAINNET_LOG_BLOCK_RANGE) {
    if (fromBlock > filter.fromBlock && interChunkDelayMs > 0) await sleep(interChunkDelayMs);
    const toBlock = Math.min(fromBlock + MAINNET_LOG_BLOCK_RANGE - 1, latestBlock);
    const chunk = await withRetry(() => getLogs({ ...filter, fromBlock, toBlock }));
    logs.push(...chunk);
  }
  return logs;
}

export interface MainnetAccountVerificationReader {
  getChainId(): Promise<number>;
  getCode(address: string): Promise<string>;
  getTransactionReceipt(txHash: string): Promise<{
    status: number | bigint | null;
    blockNumber: number;
    contractAddress: string | null;
  } | null>;
  getTransactionData(txHash: string): Promise<string | null>;
  getAccountState(accountAddress: string): Promise<{
    owner: string;
    executor: string;
    paused: boolean;
    domainSeparator: string;
    allowedUsdt0: boolean;
    allowedUsdc: boolean;
  }>;
  getTokenState(tokenAddress: string): Promise<{ code: string; decimals: number }>;
  getAllowlistEvents(accountAddress: string, fromBlock: number): Promise<{
    tokenEvents: Array<{ token: string; allowed: boolean }>;
    routeTargetEvents: Array<{ target: string; allowed: boolean }>;
  }>;
}

export interface MainnetAccountVerificationExpected {
  accountAddress: string;
  deploymentTxHash: string;
  creationBytecodeHash: string;
  runtimeBytecodeHash: string;
  ownerAddress: string;
  executorAddress: string;
  tokenAddress?: string;
  tokenCodeHash: string;
  tokenDecimals: number;
  domainSeparator?: string;
}

export interface MainnetAccountVerificationResult {
  valid: boolean;
  checks: Record<string, boolean>;
  errors: string[];
  observed?: {
    chainId?: number;
    runtimeBytecodeHash?: string;
    ownerAddress?: string;
    executorAddress?: string;
    paused?: boolean;
    domainSeparator?: string;
    tokenCodeHash?: string;
    tokenDecimals?: number;
  };
}

export async function verifyMainnetAccount(
  reader: MainnetAccountVerificationReader,
  expected: MainnetAccountVerificationExpected,
): Promise<MainnetAccountVerificationResult> {
  const errors: string[] = [];
  const checks: Record<string, boolean> = {};
  const observed: MainnetAccountVerificationResult["observed"] = {};

  function check(name: string, valid: boolean, message: string): void {
    checks[name] = valid;
    if (!valid) {
      errors.push(message);
    }
  }

  check("creation bytecode pin", expected.creationBytecodeHash.toLowerCase() === MAINNET_ACCOUNT_CREATION_BYTECODE_HASH.toLowerCase(), "Creation bytecode hash does not match the pinned V2 artifact.");

  try {
    const chainId = await reader.getChainId();
    observed.chainId = chainId;
    check("chain id", chainId === MAINNET_CHAIN_ID, `Mainnet account verifier received chain id ${chainId}, expected ${MAINNET_CHAIN_ID}.`);
  } catch {
    check("chain id", false, "Mainnet account chain id could not be read.");
  }

  try {
    const code = await reader.getCode(expected.accountAddress);
    const runtimeBytecodeHash = code === "0x" ? undefined : keccak256(code).toLowerCase();
    observed.runtimeBytecodeHash = runtimeBytecodeHash;
    check("runtime code exists", Boolean(runtimeBytecodeHash), "AgentPay account has no runtime code.");
    check(
      "runtime bytecode hash",
      Boolean(runtimeBytecodeHash) && runtimeBytecodeHash === expected.runtimeBytecodeHash.toLowerCase(),
      "AgentPay account runtime bytecode hash does not match the manifest.",
    );
  } catch {
    check("runtime bytecode hash", false, "AgentPay account runtime code could not be read.");
  }

  let deploymentBlock: number | undefined;
  try {
    const receipt = await reader.getTransactionReceipt(expected.deploymentTxHash);
    check("deployment receipt", Boolean(receipt), "Mainnet account deployment receipt is missing.");
    if (receipt) {
      deploymentBlock = receipt.blockNumber;
      check("deployment receipt status", Number(receipt.status) === 1, "Mainnet account deployment receipt did not succeed.");
      check(
        "deployment account",
        typeof receipt.contractAddress === "string" && receipt.contractAddress.toLowerCase() === expected.accountAddress.toLowerCase(),
        "Mainnet deployment receipt does not point to the manifest account.",
      );
    }
  } catch {
    check("deployment receipt", false, "Mainnet account deployment receipt could not be read.");
  }

  try {
    const account = await reader.getAccountState(expected.accountAddress);
    observed.ownerAddress = account.owner;
    observed.executorAddress = account.executor;
    observed.paused = account.paused;
    observed.domainSeparator = account.domainSeparator;
    check("owner", account.owner.toLowerCase() === expected.ownerAddress.toLowerCase(), "Account owner does not match the manifest.");
    check("executor", account.executor.toLowerCase() === expected.executorAddress.toLowerCase(), "Account executor does not match the manifest.");
    check("owner and executor distinct", account.owner.toLowerCase() !== account.executor.toLowerCase(), "Account owner and executor must be different.");
    check("paused", account.paused === false, "Mainnet AgentPay account is paused.");
    const expectedDomain = TypedDataEncoder.hashDomain({
      name: "AgentPay",
      version: "1",
      chainId: MAINNET_CHAIN_ID,
      verifyingContract: expected.accountAddress,
    });
    check("domain separator", account.domainSeparator.toLowerCase() === expectedDomain.toLowerCase(), "Account EIP-712 domain separator does not match AgentPay/mainnet.");
    if (expected.domainSeparator) {
      check("manifest domain separator", account.domainSeparator.toLowerCase() === expected.domainSeparator.toLowerCase(), "Account domain separator does not match the manifest.");
    }
    check("USDT0 allowlist", account.allowedUsdt0, "Mainnet USDT0 is not allowlisted on the AgentPay account.");
    check("USDC allowlist", account.allowedUsdc === false, "USDC must not be allowlisted on the mainnet golden-path account.");
  } catch {
    check("account state", false, "AgentPay account state could not be read.");
  }

  try {
    const tokenAddress = expected.tokenAddress ?? MAINNET_USDT0_ADDRESS;
    const token = await reader.getTokenState(tokenAddress);
    const tokenCodeHash = token.code === "0x" ? undefined : keccak256(token.code).toLowerCase();
    observed.tokenCodeHash = tokenCodeHash;
    observed.tokenDecimals = token.decimals;
    check("token code", Boolean(tokenCodeHash) && tokenCodeHash === expected.tokenCodeHash.toLowerCase(), "Mainnet USDT0 code hash does not match the manifest.");
    check("token decimals", token.decimals === expected.tokenDecimals, "Mainnet USDT0 decimals do not match the manifest.");
  } catch {
    check("token state", false, "Mainnet USDT0 code or decimals could not be read.");
  }

  if (deploymentBlock !== undefined) {
    try {
      const events = await reader.getAllowlistEvents(expected.accountAddress, deploymentBlock);
      for (const event of events.tokenEvents) {
        if (event.allowed && event.token.toLowerCase() !== MAINNET_USDT0_ADDRESS.toLowerCase()) {
          errors.push(`Token allowlist event enables non-USDT0 token ${event.token}.`);
        }
      }
      for (const event of events.routeTargetEvents) {
        if (event.allowed) {
          errors.push(`Route target ${event.target} is enabled; mainnet route-target allowlist must remain empty.`);
        }
      }
      checks["allowlist event history"] = !events.tokenEvents.some(
        (event) => event.allowed && event.token.toLowerCase() !== MAINNET_USDT0_ADDRESS.toLowerCase(),
      ) && !events.routeTargetEvents.some((event) => event.allowed);
      if (!checks["allowlist event history"]) {
        checks["allowlist event history"] = false;
      }
    } catch {
      checks["allowlist event history"] = false;
      errors.push("Account allowlist event history could not be read.");
    }
  }

  return { valid: errors.length === 0, checks, errors, observed };
}

export function createEthersMainnetAccountVerificationReader(rpcUrl: string): MainnetAccountVerificationReader {
  const provider = new JsonRpcProvider(rpcUrl);

  async function call<T>(accountAddress: string, method: string, args: unknown[], types: string[]): Promise<T> {
    const data = accountInterface.encodeFunctionData(method, args);
    const result = await provider.call({ to: accountAddress, data });
    return accountInterface.decodeFunctionResult(method, result)[0] as T;
  }

  return {
    async getChainId() {
      return Number((await provider.getNetwork()).chainId);
    },
    getCode: (address) => provider.getCode(address),
    async getTransactionReceipt(txHash) {
      const receipt = await provider.getTransactionReceipt(txHash);
      return receipt
        ? {
            status: receipt.status,
            blockNumber: receipt.blockNumber,
            contractAddress: receipt.contractAddress,
          }
        : null;
    },
    async getTransactionData(txHash) {
      const transaction = await provider.getTransaction(txHash);
      return transaction?.data ?? null;
    },
    async getAccountState(accountAddress) {
      return {
        owner: await call<string>(accountAddress, "owner", [], []),
        executor: await call<string>(accountAddress, "executor", [], []),
        paused: await call<boolean>(accountAddress, "paused", [], []),
        domainSeparator: await call<string>(accountAddress, "domainSeparator", [], []),
        allowedUsdt0: await call<boolean>(accountAddress, "allowedTokens", [MAINNET_USDT0_ADDRESS], []),
        allowedUsdc: await call<boolean>(accountAddress, "allowedTokens", [MAINNET_USDC_ADDRESS], []),
      };
    },
    async getTokenState(tokenAddress) {
      const code = await provider.getCode(tokenAddress);
      const data = erc20Interface.encodeFunctionData("decimals", []);
      const result = await provider.call({ to: tokenAddress, data });
      const [decimals] = erc20Interface.decodeFunctionResult("decimals", result);
      return { code, decimals: Number(decimals) };
    },
    async getAllowlistEvents(accountAddress, fromBlock) {
      const logs = await fetchLogsInChunks(
        () => provider.getBlockNumber(),
        (filter) => provider.getLogs(filter),
        {
          address: accountAddress,
          topics: [[tokenAllowedTopic, routeTargetAllowedTopic]],
          fromBlock,
        },
      );
      const tokenLogs = logs.filter((log) => log.topics[0]?.toLowerCase() === tokenAllowedTopic.toLowerCase());
      const routeLogs = logs.filter((log) => log.topics[0]?.toLowerCase() === routeTargetAllowedTopic.toLowerCase());
      return {
        tokenEvents: tokenLogs.map((log) => ({
          token: `0x${log.topics[1]?.slice(-40) ?? ""}`,
          allowed: Boolean(Number(BigInt(log.data))),
        })),
        routeTargetEvents: routeLogs.map((log) => ({
          target: `0x${log.topics[1]?.slice(-40) ?? ""}`,
          allowed: Boolean(Number(BigInt(log.data))),
        })),
      };
    },
  };
}
