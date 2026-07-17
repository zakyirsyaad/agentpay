import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Interface, TypedDataEncoder, keccak256 } from "ethers";

import type { SetupWorkerClaim } from "@agentpay-ai/mcp-server";
import {
  MAINNET_SETUP_ROUTE_ALLOWLIST_HASH,
  MAINNET_SETUP_TOKEN_ALLOWLIST_HASH,
  MAINNET_SETUP_USDT0,
  MAINNET_WALLET_SETUP_TYPES,
} from "@agentpay-ai/shared";
import {
  MAINNET_SETUP_USDC,
  verifySetupAccount,
  type SetupVerificationLog,
  type SetupAccountVerificationReader,
} from "./setup-account-verifier.ts";

const owner = "0x1111111111111111111111111111111111111111";
const executor = "0x2222222222222222222222222222222222222222";
const factory = "0x3333333333333333333333333333333333333333";
const predicted = "0x5555555555555555555555555555555555555555";
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const accountCode = `0x${"60".repeat(20)}`;
const factoryInterface = new Interface([
  "event AccountDeployed(address indexed owner,address indexed account,bytes32 indexed salt,bytes32 authorizationHash)",
]);
const accountInterface = new Interface([
  "event TokenAllowedUpdated(address indexed token,bool allowed)",
  "event RouteTargetAllowedUpdated(address indexed target,bool allowed)",
  "event ExecutorUpdated(address indexed oldExecutor,address indexed newExecutor)",
  "event AccountPaused()",
]);

function claim(): SetupWorkerClaim {
  const authorization = {
    setupIntentId: "setup-production-verifier-0001", deploymentNonce: hash("1"), owner, executor,
    homeChainId: 196, environment: "production", deadline: "1784265300", factory,
    factoryRuntimeCodeHash: hash("3"), deploymentSalt: hash("4"), predictedAccount: predicted,
    accountCreationCodeHash: hash("5"), accountRuntimeCodeHash: keccak256(accountCode), token: MAINNET_SETUP_USDT0,
    tokenAllowlistHash: MAINNET_SETUP_TOKEN_ALLOWLIST_HASH,
    routeAllowlistHash: MAINNET_SETUP_ROUTE_ALLOWLIST_HASH, manifestSha256: hash("2"),
  } as const;
  return Object.freeze({
    disposition: "CLAIMED", jobStatus: "CONFIRMING",
    jobId: "00000000-0000-4000-8000-000000000001",
    setupIntentId: authorization.setupIntentId,
    tenantId: "00000000-0000-4000-8000-000000000002",
    fencingToken: "00000000-0000-4000-8000-000000000003",
    leaseUntil: "2026-07-17T05:02:00.000Z", ownerSetupSignature: `0x${"12".repeat(65)}`,
    ownerAddress: owner, executorAddress: executor, homeChainId: 196,
    deploymentNonce: authorization.deploymentNonce, manifestSha256: authorization.manifestSha256,
    factoryAddress: factory, factoryRuntimeCodeHash: authorization.factoryRuntimeCodeHash,
    deploymentSalt: authorization.deploymentSalt, predictedAccount: predicted,
    accountCreationCodeHash: authorization.accountCreationCodeHash,
    accountRuntimeCodeHash: authorization.accountRuntimeCodeHash,
    authorizationHash: TypedDataEncoder.hash(
      { name: "AgentPay Setup", version: "1", chainId: 196, verifyingContract: factory },
      MAINNET_WALLET_SETUP_TYPES as never,
      authorization,
    ),
    expiresAt: "2026-07-17T05:15:00.000Z",
  });
}

function encodedLog(
  contract: string,
  iface: Interface,
  event: string,
  values: readonly unknown[],
  blockNumber: number,
  transactionHash = hash("8"),
): SetupVerificationLog {
  const encoded = iface.encodeEventLog(iface.getEvent(event)!, values);
  return { address: contract, topics: encoded.topics, data: encoded.data, blockNumber, transactionHash };
}

function reader(extraLogs: readonly SetupVerificationLog[] = [], state: Partial<Awaited<ReturnType<SetupAccountVerificationReader["getAccountState"]>>> = {}) {
  const admitted = claim();
  const logs: SetupVerificationLog[] = [
    encodedLog(factory, factoryInterface, "AccountDeployed", [owner, predicted, admitted.deploymentSalt, admitted.authorizationHash], 100),
    encodedLog(predicted, accountInterface, "TokenAllowedUpdated", [MAINNET_SETUP_USDT0, true], 100),
    ...extraLogs,
  ];
  const calls: Array<{ fromBlock: number; toBlock: number }> = [];
  const value: SetupAccountVerificationReader = {
    getChainId: async () => 196,
    getCode: async () => accountCode,
    getAccountState: async () => ({
      owner, executor, paused: false,
      domainSeparator: TypedDataEncoder.hashDomain({ name: "AgentPay", version: "1", chainId: 196, verifyingContract: predicted }),
      allowedUsdt0: true, allowedUsdc: false, ...state,
    }),
    getLogs: async (filter) => {
      calls.push({ fromBlock: filter.fromBlock, toBlock: filter.toBlock });
      assert.ok(filter.toBlock - filter.fromBlock <= 99);
      return logs.filter((log) => log.address.toLowerCase() === filter.address.toLowerCase()
        && log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock);
    },
  };
  return { value, calls };
}

describe("mainnet setup account verifier", () => {
  it("verifies factory provenance and immutable account state in 100-block chunks", async () => {
    const admitted = claim();
    const mock = reader();
    const result = await verifySetupAccount({
      reader: mock.value,
      claim: admitted,
      factoryDeploymentBlock: 1,
      verificationBlockNumber: 305,
      receipt: { status: 1, blockNumber: 100, transactionHash: hash("8") },
    });
    assert.deepEqual(result, { accountAddress: predicted.toLowerCase(), deploymentBlockNumber: 100, verificationBlockNumber: 305 });
    assert.ok(mock.calls.length >= 7);
  });

  it("accepts an existing exact account without requiring a new transaction receipt", async () => {
    const result = await verifySetupAccount({
      reader: reader().value,
      claim: claim(),
      factoryDeploymentBlock: 1,
      verificationBlockNumber: 305,
    });
    assert.equal(result.deploymentBlockNumber, 100);
  });

  it("rejects wrong chain, receipt, runtime, state, and unsafe mutation history", async () => {
    const unsafeLogs = [
      encodedLog(predicted, accountInterface, "TokenAllowedUpdated", [MAINNET_SETUP_USDC, true], 150),
      encodedLog(predicted, accountInterface, "RouteTargetAllowedUpdated", [factory, true], 151),
      encodedLog(predicted, accountInterface, "ExecutorUpdated", [executor, factory], 152),
      encodedLog(predicted, accountInterface, "AccountPaused", [], 153),
    ];
    await assert.rejects(
      verifySetupAccount({
        reader: reader(unsafeLogs, { allowedUsdc: true }).value,
        claim: claim(), factoryDeploymentBlock: 1, verificationBlockNumber: 305,
        receipt: { status: 1, blockNumber: 100, transactionHash: hash("8") },
      }),
      /SETUP_ACCOUNT_POLICY_MISMATCH/,
    );
    await assert.rejects(
      verifySetupAccount({
        reader: { ...reader().value, getChainId: async () => 1952 },
        claim: claim(), factoryDeploymentBlock: 1, verificationBlockNumber: 305,
      }),
      /SETUP_CHAIN_MISMATCH/,
    );
    await assert.rejects(
      verifySetupAccount({
        reader: { ...reader().value, getCode: async () => "0x" },
        claim: claim(), factoryDeploymentBlock: 1, verificationBlockNumber: 305,
      }),
      /SETUP_ACCOUNT_CODE_MISMATCH/,
    );
  });
});
