import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TypedDataEncoder, Wallet, keccak256 } from "ethers";

import type {
  EncryptedSetupTransaction,
  ProductionSetupWorkerStore,
  SetupWorkerClaim,
} from "@agentpay-ai/mcp-server";
import {
  MAINNET_SETUP_ROUTE_ALLOWLIST_HASH,
  MAINNET_SETUP_TOKEN_ALLOWLIST_HASH,
  MAINNET_SETUP_USDT0,
  MAINNET_WALLET_SETUP_TYPES,
} from "@agentpay-ai/shared";
import { buildSetupDeploymentTransaction, encryptSetupRawTransaction } from "./setup-transaction.ts";
import { createSetupDeploymentWorker } from "./setup-deployment-worker.ts";

const owner = "0x1111111111111111111111111111111111111111";
const executor = "0x2222222222222222222222222222222222222222";
const factory = "0x3333333333333333333333333333333333333333";
const predicted = "0x5555555555555555555555555555555555555555";
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const encryptionKey = Buffer.alloc(32, 7);
const signer = new Wallet(`0x${"09".repeat(32)}`);

function claim(status: SetupWorkerClaim["jobStatus"] = "SIGNING", extra: Partial<SetupWorkerClaim> = {}): SetupWorkerClaim {
  const authorization = {
    setupIntentId: "setup-production-deployment-worker-0001", deploymentNonce: hash("1"), owner, executor,
    homeChainId: 196, environment: "production", deadline: "1784265300", factory,
    factoryRuntimeCodeHash: hash("3"), deploymentSalt: hash("4"), predictedAccount: predicted,
    accountCreationCodeHash: hash("5"), accountRuntimeCodeHash: hash("6"), token: MAINNET_SETUP_USDT0,
    tokenAllowlistHash: MAINNET_SETUP_TOKEN_ALLOWLIST_HASH,
    routeAllowlistHash: MAINNET_SETUP_ROUTE_ALLOWLIST_HASH, manifestSha256: hash("2"),
  } as const;
  return Object.freeze({
    disposition: "CLAIMED", jobStatus: status,
    jobId: "00000000-0000-4000-8000-000000000001", setupIntentId: authorization.setupIntentId,
    tenantId: "00000000-0000-4000-8000-000000000002",
    fencingToken: "00000000-0000-4000-8000-000000000003", leaseUntil: "2026-07-17T05:02:00.000Z",
    ownerSetupSignature: `0x${"12".repeat(65)}`, ownerAddress: owner, executorAddress: executor,
    homeChainId: 196, deploymentNonce: authorization.deploymentNonce, manifestSha256: authorization.manifestSha256,
    factoryAddress: factory, factoryRuntimeCodeHash: authorization.factoryRuntimeCodeHash,
    deploymentSalt: authorization.deploymentSalt, predictedAccount: predicted,
    accountCreationCodeHash: authorization.accountCreationCodeHash,
    accountRuntimeCodeHash: authorization.accountRuntimeCodeHash,
    authorizationHash: TypedDataEncoder.hash(
      { name: "AgentPay Setup", version: "1", chainId: 196, verifyingContract: factory },
      MAINNET_WALLET_SETUP_TYPES as never,
      authorization,
    ),
    expiresAt: "2026-07-17T05:15:00.000Z", ...extra,
  });
}

function mockStore(admitted: SetupWorkerClaim, events: string[], overrides: Partial<ProductionSetupWorkerStore> = {}) {
  const store: ProductionSetupWorkerStore = {
    claim: async () => admitted,
    reserve: async () => { events.push("reserve"); return { disposition: "RESERVED", jobId: admitted.jobId, dayKey: "2026-07-17" }; },
    persistSignedTransaction: async (input) => {
      events.push("persist");
      assert.ok(input.rawTransaction.ciphertext);
      return { disposition: "SIGNED", jobId: admitted.jobId, status: "SIGNED", transactionHash: input.transactionHash };
    },
    markBroadcastResult: async (input) => { events.push(`mark:${input.result}`); return { disposition: input.result, jobId: admitted.jobId, status: input.result }; },
    recordReceipt: async (input) => { events.push(`receipt:${input.receiptStatus}`); return { disposition: "RECORDED", jobId: admitted.jobId, status: input.receiptStatus === 1 ? "CONFIRMING" : "FAILED" }; },
    recordExistingAccount: async () => { events.push("existing"); return { disposition: "RECORDED", jobId: admitted.jobId, status: "CONFIRMING" }; },
    finalize: async () => { events.push("finalize"); return { disposition: "COMPLETED", jobId: admitted.jobId, tenantId: admitted.tenantId, accountAddress: predicted }; },
    markManualReview: async () => { events.push("manual"); return { disposition: "MANUAL_REVIEW", jobId: admitted.jobId, status: "MANUAL_REVIEW" }; },
    ...overrides,
  };
  return store;
}

function dependencies(admitted: SetupWorkerClaim, events: string[], extra: Record<string, unknown> = {}) {
  return {
    store: mockStore(admitted, events),
    signer: {
      getAddress: async () => signer.address,
      getNonce: async () => 7,
      signTransaction: async (transaction: Parameters<typeof signer.signTransaction>[0]) => signer.signTransaction(transaction),
    },
    chain: {
      getCode: async () => "0x",
      getTransactionCount: async () => 7,
      getFeeData: async () => ({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
      estimateGas: async () => 1_000_000n,
      broadcastTransaction: async (raw: string) => { events.push("broadcast"); return { hash: keccak256(raw) }; },
      getTransactionReceipt: async () => null,
      getBlockNumber: async () => 305,
    },
    verifyPreflight: async () => { events.push("preflight"); },
    verifyAccount: async () => { events.push("verify"); return { accountAddress: predicted, deploymentBlockNumber: 100, verificationBlockNumber: 305 }; },
    config: {
      workerId: "worker-1", leaseSeconds: 120, encryptionKey,
      factoryDeploymentBlock: 1,
      receiptTimeoutSeconds: 300,
      limits: { maxGasLimit: 2_000_000n, maxFeePerGas: 3_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n, maxNativeCostWei: 3_000_000_000_000_000n },
    },
    ...extra,
  };
}

describe("recoverable setup deployment worker", () => {
  it("persists encrypted signed bytes before the first broadcast", async () => {
    const admitted = claim();
    const events: string[] = [];
    const worker = createSetupDeploymentWorker(dependencies(admitted, events));
    const result = await worker.processNext("2026-07-17T05:00:00.000Z");
    assert.equal(result.status, "BROADCAST");
    assert.deepEqual(events, ["preflight", "reserve", "persist", "broadcast", "mark:BROADCAST"]);
  });

  it("rebroadcasts the identical persisted raw transaction after restart without resigning", async () => {
    const initial = claim();
    const raw = await signer.signTransaction(buildSetupDeploymentTransaction({
      claim: initial, deployerAddress: signer.address, deployerNonce: 7n, gasLimit: 1_000_000n,
      maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
      limits: { maxGasLimit: 2_000_000n, maxFeePerGas: 3_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n, maxNativeCostWei: 3_000_000_000_000_000n },
    }));
    const encrypted: EncryptedSetupTransaction = encryptSetupRawTransaction(raw, encryptionKey, Buffer.alloc(12, 8));
    const admitted = claim("SIGNED", {
      deployerAddress: signer.address.toLowerCase(), deployerNonce: "7", transactionHash: keccak256(raw), rawTransaction: encrypted,
    });
    const events: string[] = [];
    let observedRaw = "";
    const base = dependencies(admitted, events);
    const worker = createSetupDeploymentWorker({
      ...base,
      chain: { ...base.chain, broadcastTransaction: async (value) => { events.push("broadcast"); observedRaw = value; return { hash: keccak256(value) }; } },
    });
    const result = await worker.processNext("2026-07-17T05:02:01.000Z");
    assert.equal(result.status, "BROADCAST");
    assert.equal(observedRaw, raw.toLowerCase());
    assert.deepEqual(events, ["broadcast", "mark:BROADCAST"]);
  });

  it("activates an existing exact account without sponsor reservation or broadcast", async () => {
    const admitted = claim();
    const events: string[] = [];
    const base = dependencies(admitted, events);
    const worker = createSetupDeploymentWorker({
      ...base,
      chain: { ...base.chain, getCode: async () => "0x6000" },
    });
    const result = await worker.processNext("2026-07-17T05:00:00.000Z");
    assert.equal(result.status, "COMPLETED");
    assert.deepEqual(events, ["preflight", "verify", "existing", "finalize"]);
  });

  it("records reverts and sends a missing replaced transaction to manual review", async () => {
    const broadcast = claim("BROADCAST", { deployerAddress: signer.address.toLowerCase(), deployerNonce: "7", transactionHash: hash("8") });
    const revertedEvents: string[] = [];
    const revertedBase = dependencies(broadcast, revertedEvents);
    const reverted = createSetupDeploymentWorker({
      ...revertedBase,
      chain: { ...revertedBase.chain, getTransactionReceipt: async () => ({ status: 0, blockNumber: 100, transactionHash: hash("8") }) },
    });
    assert.equal((await reverted.processNext("2026-07-17T05:03:00.000Z")).status, "FAILED");
    assert.deepEqual(revertedEvents, ["receipt:0"]);

    const missingEvents: string[] = [];
    const missingBase = dependencies(broadcast, missingEvents);
    const missing = createSetupDeploymentWorker({
      ...missingBase,
      chain: { ...missingBase.chain, getTransactionCount: async () => 8 },
    });
    assert.equal((await missing.processNext("2026-07-17T05:03:00.000Z")).status, "MANUAL_REVIEW");
    assert.deepEqual(missingEvents, ["manual"]);
  });

  it("keeps a recent missing receipt pending but quarantines a dropped transaction after timeout", async () => {
    for (const [checkedAt, expected] of [
      ["2026-07-17T05:04:59.000Z", "PENDING"],
      ["2026-07-17T05:05:00.000Z", "MANUAL_REVIEW"],
    ] as const) {
      const admitted = claim("BROADCAST", {
        deployerAddress: signer.address.toLowerCase(), deployerNonce: "7", transactionHash: hash("8"),
        broadcastAt: "2026-07-17T05:00:00.000Z",
      });
      const events: string[] = [];
      const worker = createSetupDeploymentWorker(dependencies(admitted, events));
      assert.equal((await worker.processNext(checkedAt)).status, expected);
      assert.deepEqual(events, expected === "PENDING" ? [] : ["manual"]);
    }
  });

  it("verifies and finalizes a successful receipt", async () => {
    const broadcast = claim("BROADCAST", {
      deployerAddress: signer.address.toLowerCase(), deployerNonce: "7", transactionHash: hash("8"),
    });
    const events: string[] = [];
    const base = dependencies(broadcast, events);
    const worker = createSetupDeploymentWorker({
      ...base,
      chain: { ...base.chain, getTransactionReceipt: async () => ({ status: 1, blockNumber: 100, transactionHash: hash("8") }) },
    });
    assert.equal((await worker.processNext("2026-07-17T05:03:00.000Z")).status, "COMPLETED");
    assert.deepEqual(events, ["receipt:1", "verify", "finalize"]);
  });

  it("treats already-known as broadcast and a timeout as broadcast-unknown", async () => {
    const initial = claim();
    const raw = await signer.signTransaction(buildSetupDeploymentTransaction({
      claim: initial, deployerAddress: signer.address, deployerNonce: 7n, gasLimit: 1_000_000n,
      maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
      limits: { maxGasLimit: 2_000_000n, maxFeePerGas: 3_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n, maxNativeCostWei: 3_000_000_000_000_000n },
    }));
    const persisted = claim("SIGNED", {
      deployerAddress: signer.address.toLowerCase(), deployerNonce: "7", transactionHash: keccak256(raw),
      rawTransaction: encryptSetupRawTransaction(raw, encryptionKey, Buffer.alloc(12, 6)),
    });

    for (const [message, expected] of [["already known", "BROADCAST"], ["RPC timeout", "BROADCAST_UNKNOWN"]] as const) {
      const events: string[] = [];
      const base = dependencies(persisted, events);
      const worker = createSetupDeploymentWorker({
        ...base,
        chain: { ...base.chain, broadcastTransaction: async () => { throw new Error(message); } },
      });
      assert.equal((await worker.processNext("2026-07-17T05:03:00.000Z")).status, expected);
      assert.deepEqual(events, [`mark:${expected}`]);
    }
  });

  it("does not broadcast when outbox persistence fails and leaves post-send DB failures recoverable", async () => {
    const admitted = claim();
    const beforeEvents: string[] = [];
    const beforeBase = dependencies(admitted, beforeEvents);
    const before = createSetupDeploymentWorker({
      ...beforeBase,
      store: mockStore(admitted, beforeEvents, { persistSignedTransaction: async () => { beforeEvents.push("persist"); throw new Error("db down"); } }),
    });
    await assert.rejects(before.processNext("2026-07-17T05:00:00.000Z"), /db down/);
    assert.deepEqual(beforeEvents, ["preflight", "reserve", "persist"]);

    const afterEvents: string[] = [];
    const afterBase = dependencies(admitted, afterEvents);
    const after = createSetupDeploymentWorker({
      ...afterBase,
      store: mockStore(admitted, afterEvents, { markBroadcastResult: async () => { afterEvents.push("mark:BROADCAST"); throw new Error("db down after send"); } }),
    });
    await assert.rejects(after.processNext("2026-07-17T05:00:00.000Z"), /db down after send/);
    assert.deepEqual(afterEvents, ["preflight", "reserve", "persist", "broadcast", "mark:BROADCAST"]);
  });
});
