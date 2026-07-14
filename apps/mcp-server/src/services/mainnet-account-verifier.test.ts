import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, TypedDataEncoder } from "ethers";

import {
  MAINNET_USDC_ADDRESS,
  MAINNET_ACCOUNT_CREATION_BYTECODE_HASH,
  fetchLogsInChunks,
  verifyMainnetAccount,
  type MainnetAccountVerificationReader,
} from "./mainnet-account-verifier.ts";
import { MAINNET_USDT0_ADDRESS } from "../runtime/production-readiness.ts";

const accountAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ownerAddress = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const executorAddress = "0xcccccccccccccccccccccccccccccccccccccc";
const creationHash = MAINNET_ACCOUNT_CREATION_BYTECODE_HASH;
const domainSeparator = TypedDataEncoder.hashDomain({
  name: "AgentPay",
  version: "1",
  chainId: 196,
  verifyingContract: accountAddress,
});

function reader(overrides: Partial<MainnetAccountVerificationReader> = {}): MainnetAccountVerificationReader {
  return {
    getChainId: async () => 196,
    getCode: async () => "0x6001600055",
    getTransactionReceipt: async () => ({ status: 1, blockNumber: 100, contractAddress: accountAddress }),
    getTransactionData: async () => "0x6001600055",
    getAccountState: async () => ({
      owner: ownerAddress,
      executor: executorAddress,
      paused: false,
      domainSeparator,
      allowedUsdt0: true,
      allowedUsdc: false,
    }),
    getTokenState: async () => ({ code: "0x6002", decimals: 6 }),
    getAllowlistEvents: async () => ({ tokenEvents: [], routeTargetEvents: [] }),
    ...overrides,
  };
}

function expected(overrides: Record<string, unknown> = {}) {
  const runtimeCode = "0x6001600055";
  const tokenCode = "0x6002";
  return {
    accountAddress,
    deploymentTxHash: `0x${"44".repeat(32)}`,
    creationBytecodeHash: creationHash,
    runtimeBytecodeHash: keccak256(runtimeCode),
    ownerAddress,
    executorAddress,
    domainSeparator,
    tokenAddress: MAINNET_USDT0_ADDRESS,
    tokenCodeHash: keccak256(tokenCode),
    tokenDecimals: 6,
    ...overrides,
  };
}

describe("mainnet AgentPayAccountV2 verifier", () => {
  it("limits historical log requests to the RPC block-range ceiling", async () => {
    const requests: Array<{ fromBlock: number; toBlock: number }> = [];
    const delays: number[] = [];

    await fetchLogsInChunks(
      async () => 205,
      async (filter) => {
        requests.push({ fromBlock: filter.fromBlock, toBlock: filter.toBlock });
        return [];
      },
      { address: accountAddress, topics: ["0xtopic"], fromBlock: 100 },
      {
        interChunkDelayMs: 7,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
    );

    assert.deepEqual(requests, [
      { fromBlock: 100, toBlock: 199 },
      { fromBlock: 200, toBlock: 205 },
    ]);
    assert.deepEqual(delays, [7]);
  });

  it("fails closed when the scan starts after the captured latest block", async () => {
    await assert.rejects(
      fetchLogsInChunks(
        async () => 99,
        async () => [],
        { address: accountAddress, topics: ["0xtopic"], fromBlock: 100 },
        { sleep: async () => undefined },
      ),
      /start block is after the latest block/i,
    );
  });

  it("retries a transient historical log failure before failing closed", async () => {
    let attempts = 0;

    await fetchLogsInChunks(
      async () => 100,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("rate limited");
        return [];
      },
      { address: accountAddress, topics: ["0xtopic"], fromBlock: 100 },
      { maxAttempts: 2, sleep: async () => undefined },
    );

    assert.equal(attempts, 2);
  });

  it("accepts a read-only account observation when every production invariant matches", async () => {
    const result = await verifyMainnetAccount(reader(), expected());

    assert.equal(result.valid, true, result.errors.join("; "));
  });

  it("rejects chain, receipt, owner/executor, pause, domain, and token drift", async () => {
    const result = await verifyMainnetAccount(reader({
      getChainId: async () => 1952,
      getTransactionReceipt: async () => ({ status: 0, blockNumber: 100, contractAddress: accountAddress }),
      getAccountState: async () => ({
        owner: executorAddress,
        executor: executorAddress,
        paused: true,
        domainSeparator: `0x${"99".repeat(32)}`,
        allowedUsdt0: false,
        allowedUsdc: true,
      }),
      getTokenState: async () => ({ code: "0x6003", decimals: 18 }),
    }), expected());

    assert.equal(result.valid, false);
    for (const text of ["chain id", "deployment receipt", "owner and executor", "paused", "domain separator", "USDT0", "USDC", "decimals", "USDT0 code hash"]) {
      assert.match(result.errors.join("; "), new RegExp(text, "i"));
    }
  });

  it("rejects a route target or non-USDT0 token left enabled by deployment events", async () => {
    const result = await verifyMainnetAccount(reader({
      getAllowlistEvents: async () => ({
        tokenEvents: [
          { token: MAINNET_USDC_ADDRESS, allowed: true },
          { token: MAINNET_USDT0_ADDRESS, allowed: true },
        ],
        routeTargetEvents: [{ target: "0xdddddddddddddddddddddddddddddddddddddddd", allowed: true }],
      }),
    }), expected());

    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /non-USDT0|74b7/i);
    assert.match(result.errors.join("; "), /route target/i);
  });

  it("fails closed when the deployment receipt omits its created account", async () => {
    const result = await verifyMainnetAccount(reader({
      getTransactionReceipt: async () => ({ status: 1, blockNumber: 100, contractAddress: null }),
    }), expected());

    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /deployment receipt does not point/i);
  });

  it("fails closed when a deployment transaction or runtime code is missing", async () => {
    const result = await verifyMainnetAccount(reader({
      getCode: async () => "0x",
      getTransactionReceipt: async () => null,
    }), expected());

    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /runtime code|deployment receipt/i);
  });
});
