import { Interface, TypedDataEncoder, keccak256 } from "ethers";

import type { SetupWorkerClaim } from "@agentpay-ai/mcp-server";
import { MAINNET_SETUP_USDT0 } from "@agentpay-ai/shared";

export const MAINNET_SETUP_USDC = "0x74b7F16337b8972027F6196A17a631aC6dE26d22";
export const SETUP_LOG_BLOCK_RANGE = 100;

const factoryInterface = new Interface([
  "event AccountDeployed(address indexed owner,address indexed account,bytes32 indexed salt,bytes32 authorizationHash)",
  "event AccountReused(address indexed owner,address indexed account,bytes32 indexed authorizationHash)",
]);
const accountInterface = new Interface([
  "event TokenAllowedUpdated(address indexed token,bool allowed)",
  "event RouteTargetAllowedUpdated(address indexed target,bool allowed)",
  "event ExecutorUpdated(address indexed oldExecutor,address indexed newExecutor)",
  "event AccountPaused()",
  "event AccountUnpaused()",
]);

export interface SetupVerificationLogFilter {
  readonly address: string;
  readonly fromBlock: number;
  readonly toBlock: number;
}

export interface SetupVerificationLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: number;
  readonly transactionHash: string;
}

export interface SetupAccountVerificationReader {
  getChainId(): Promise<number>;
  getCode(address: string): Promise<string>;
  getAccountState(address: string): Promise<Readonly<{
    owner: string;
    executor: string;
    paused: boolean;
    domainSeparator: string;
    allowedUsdt0: boolean;
    allowedUsdc: boolean;
  }>>;
  getLogs(filter: SetupVerificationLogFilter): Promise<ReadonlyArray<SetupVerificationLog>>;
}

export interface SetupDeploymentReceipt {
  readonly status: number;
  readonly blockNumber: number;
  readonly transactionHash: string;
}

export interface SetupAccountVerificationResult {
  readonly accountAddress: string;
  readonly deploymentBlockNumber: number;
  readonly verificationBlockNumber: number;
}

export async function verifySetupAccount(input: {
  readonly reader: SetupAccountVerificationReader;
  readonly claim: SetupWorkerClaim;
  readonly factoryDeploymentBlock: number;
  readonly verificationBlockNumber: number;
  readonly receipt?: SetupDeploymentReceipt;
}): Promise<SetupAccountVerificationResult> {
  assertBlockNumber(input.factoryDeploymentBlock, "SETUP_FACTORY_BLOCK_INVALID");
  assertBlockNumber(input.verificationBlockNumber, "SETUP_VERIFICATION_BLOCK_INVALID");
  if (input.factoryDeploymentBlock > input.verificationBlockNumber) throw new Error("SETUP_VERIFICATION_BLOCK_INVALID");
  if (input.receipt) {
    assertBlockNumber(input.receipt.blockNumber, "SETUP_RECEIPT_INVALID");
    if (input.receipt.status !== 1 || input.receipt.blockNumber > input.verificationBlockNumber
      || (input.claim.transactionHash
        && input.receipt.transactionHash.toLowerCase() !== input.claim.transactionHash.toLowerCase())
      || !/^0x[0-9a-fA-F]{64}$/.test(input.receipt.transactionHash)) throw new Error("SETUP_RECEIPT_INVALID");
  }

  const [chainId, accountCode, state, factoryLogs] = await Promise.all([
    input.reader.getChainId(),
    input.reader.getCode(input.claim.predictedAccount),
    input.reader.getAccountState(input.claim.predictedAccount),
    fetchSetupLogsInChunks(input.reader, input.claim.factoryAddress, input.factoryDeploymentBlock, input.verificationBlockNumber),
  ]);
  if (chainId !== 196) throw new Error("SETUP_CHAIN_MISMATCH");
  if (accountCode === "0x" || keccak256(accountCode).toLowerCase() !== input.claim.accountRuntimeCodeHash.toLowerCase()) {
    throw new Error("SETUP_ACCOUNT_CODE_MISMATCH");
  }

  const factoryEvent = findFactoryDeployment(factoryLogs, input.claim, input.receipt);
  const deploymentBlockNumber = factoryEvent.blockNumber;
  if (input.receipt && deploymentBlockNumber !== input.receipt.blockNumber) throw new Error("SETUP_FACTORY_EVENT_MISMATCH");

  const expectedDomain = TypedDataEncoder.hashDomain({
    name: "AgentPay",
    version: "1",
    chainId: 196,
    verifyingContract: input.claim.predictedAccount,
  });
  if (
    state.owner.toLowerCase() !== input.claim.ownerAddress.toLowerCase()
    || state.executor.toLowerCase() !== input.claim.executorAddress.toLowerCase()
    || state.owner.toLowerCase() === state.executor.toLowerCase()
    || state.paused
    || state.domainSeparator.toLowerCase() !== expectedDomain.toLowerCase()
    || !state.allowedUsdt0
    || state.allowedUsdc
  ) throw new Error("SETUP_ACCOUNT_POLICY_MISMATCH");

  const accountLogs = await fetchSetupLogsInChunks(
    input.reader,
    input.claim.predictedAccount,
    deploymentBlockNumber,
    input.verificationBlockNumber,
  );
  assertSafeAccountHistory(accountLogs, input.claim.executorAddress);
  return Object.freeze({
    accountAddress: input.claim.predictedAccount.toLowerCase(),
    deploymentBlockNumber,
    verificationBlockNumber: input.verificationBlockNumber,
  });
}

export async function fetchSetupLogsInChunks(
  reader: Pick<SetupAccountVerificationReader, "getLogs">,
  address: string,
  fromBlock: number,
  toBlock: number,
): Promise<SetupVerificationLog[]> {
  assertBlockNumber(fromBlock, "SETUP_LOG_RANGE_INVALID");
  assertBlockNumber(toBlock, "SETUP_LOG_RANGE_INVALID");
  if (fromBlock > toBlock) throw new Error("SETUP_LOG_RANGE_INVALID");
  const logs: SetupVerificationLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += SETUP_LOG_BLOCK_RANGE) {
    const end = Math.min(start + SETUP_LOG_BLOCK_RANGE - 1, toBlock);
    const chunk = await reader.getLogs({ address, fromBlock: start, toBlock: end });
    for (const log of chunk) {
      if (log.address.toLowerCase() !== address.toLowerCase() || log.blockNumber < start || log.blockNumber > end) {
        throw new Error("SETUP_LOG_RESPONSE_INVALID");
      }
      logs.push(log);
    }
  }
  return logs;
}

function findFactoryDeployment(
  logs: readonly SetupVerificationLog[],
  claim: SetupWorkerClaim,
  receipt?: SetupDeploymentReceipt,
): SetupVerificationLog {
  const matching = logs.filter((log) => {
    if (receipt && log.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase()) return false;
    try {
      const parsed = factoryInterface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed || !["AccountDeployed", "AccountReused"].includes(parsed.name)) return false;
      if (!receipt && parsed.name !== "AccountDeployed") return false;
      if (String(parsed.args.owner).toLowerCase() !== claim.ownerAddress.toLowerCase()
        || String(parsed.args.account).toLowerCase() !== claim.predictedAccount.toLowerCase()) return false;
      if (parsed.name === "AccountDeployed" && String(parsed.args.salt).toLowerCase() !== claim.deploymentSalt.toLowerCase()) {
        return false;
      }
      if (receipt && String(parsed.args.authorizationHash).toLowerCase() !== claim.authorizationHash.toLowerCase()) return false;
      return true;
    } catch {
      return false;
    }
  });
  if (matching.length !== 1) throw new Error("SETUP_FACTORY_EVENT_MISMATCH");
  return matching[0]!;
}

function assertSafeAccountHistory(logs: readonly SetupVerificationLog[], expectedExecutor: string): void {
  for (const log of logs) {
    let parsed: ReturnType<Interface["parseLog"]>;
    try {
      parsed = accountInterface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.name === "TokenAllowedUpdated") {
      const token = String(parsed.args.token).toLowerCase();
      const allowed = Boolean(parsed.args.allowed);
      if ((token !== MAINNET_SETUP_USDT0.toLowerCase() && allowed)
        || (token === MAINNET_SETUP_USDT0.toLowerCase() && !allowed)) {
        throw new Error("SETUP_ACCOUNT_POLICY_MISMATCH");
      }
    }
    if (parsed.name === "RouteTargetAllowedUpdated" && Boolean(parsed.args.allowed)) {
      throw new Error("SETUP_ACCOUNT_POLICY_MISMATCH");
    }
    if (parsed.name === "ExecutorUpdated") {
      const expected = expectedExecutor.toLowerCase();
      if (String(parsed.args.oldExecutor).toLowerCase() !== expected
        || String(parsed.args.newExecutor).toLowerCase() !== expected) {
        throw new Error("SETUP_ACCOUNT_POLICY_MISMATCH");
      }
    }
    if (parsed.name === "AccountPaused") throw new Error("SETUP_ACCOUNT_POLICY_MISMATCH");
  }
}

function assertBlockNumber(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
}
