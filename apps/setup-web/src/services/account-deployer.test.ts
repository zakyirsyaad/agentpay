import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256 } from "ethers";

import {
  AGENT_PAY_ACCOUNT_V2_REQUIRED_SELECTORS,
  assertSetupRpcChain,
  assertAgentPayAccountV2Bytecode,
  createContractFactoryAgentPayAccountDeployer,
  createEthersAgentPayAccountDeployer,
  MAINNET_USDT0_ADDRESS,
  resolveSetupRpcUrlForChain,
  assertSupportedSetupChain,
} from "./account-deployer.ts";

describe("createContractFactoryAgentPayAccountDeployer", () => {
  it("returns the deployed AgentPayAccountV2 address plus tx hash", async () => {
    const calls: unknown[] = [];
    const deployer = createContractFactoryAgentPayAccountDeployer({
      async deploy(
        ownerAddress: string,
        executorAddress: string,
        initialAllowedTokenAddresses: string[],
        initialAllowedRouteTargets: string[],
      ) {
        calls.push([ownerAddress, executorAddress, initialAllowedTokenAddresses, initialAllowedRouteTargets]);
        return {
          target: "0x3333333333333333333333333333333333333333",
          deploymentTransaction() {
            return {
              hash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            };
          },
          async waitForDeployment() {
            calls.push("wait");
          },
        };
      },
    });

    const result = await deployer.deployAgentPayAccount({
      ownerAddress: "0x2222222222222222222222222222222222222222",
      executorAddress: "0x4444444444444444444444444444444444444444",
      initialAllowedTokenAddresses: [
        "0x5555555555555555555555555555555555555555",
        "0x6666666666666666666666666666666666666666",
      ],
      initialAllowedRouteTargets: ["0x7777777777777777777777777777777777777777"],
      homeChainId: 1952,
    });

    assert.deepEqual(calls, [
      [
        "0x2222222222222222222222222222222222222222",
        "0x4444444444444444444444444444444444444444",
        [
          "0x5555555555555555555555555555555555555555",
          "0x6666666666666666666666666666666666666666",
        ],
        ["0x7777777777777777777777777777777777777777"],
      ],
      "wait",
    ]);
    assert.deepEqual(result, {
      accountAddress: "0x3333333333333333333333333333333333333333",
      deploymentTxHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
  });

  it("rejects mainnet USDC/custom tokens and route targets before factory deployment", async () => {
    let deployCalls = 0;
    const deployer = createContractFactoryAgentPayAccountDeployer({
      async deploy() {
        deployCalls += 1;
        return {
          target: "0x3333333333333333333333333333333333333333",
          deploymentTransaction: () => null,
          async waitForDeployment() {},
        };
      },
    });
    const baseRequest = {
      ownerAddress: "0x2222222222222222222222222222222222222222",
      executorAddress: "0x4444444444444444444444444444444444444444",
      homeChainId: 196,
      initialAllowedRouteTargets: [],
    };

    await assert.rejects(
      () =>
        deployer.deployAgentPayAccount({
          ...baseRequest,
          initialAllowedTokenAddresses: ["0x74b7F16337b8972027F6196A17a631aC6dE26d22"],
        }),
      /canonical USDT0/i,
    );
    await assert.rejects(
      () =>
        deployer.deployAgentPayAccount({
          ...baseRequest,
          initialAllowedTokenAddresses: [MAINNET_USDT0_ADDRESS],
          initialAllowedRouteTargets: ["0x7777777777777777777777777777777777777777"],
        }),
      /empty route-target/i,
    );
    assert.equal(deployCalls, 0);
  });
});

describe("assertAgentPayAccountV2Bytecode", () => {
  it("rejects a V1 or arbitrary creation bytecode before deployment", () => {
    assert.throws(() => assertAgentPayAccountV2Bytecode("0x60006000"), /missing required selector/);
  });

  it("accepts the V2 selector fingerprint and optional pinned hash", () => {
    const bytecode = `0x${AGENT_PAY_ACCOUNT_V2_REQUIRED_SELECTORS.map((selector) => selector.slice(2)).join("")}`;
    assert.doesNotThrow(() => assertAgentPayAccountV2Bytecode(bytecode, keccak256(bytecode)));
    assert.throws(
      () => assertAgentPayAccountV2Bytecode(bytecode, `0x${"00".repeat(32)}`),
      /bytecode hash/,
    );
  });
});

describe("assertSetupRpcChain", () => {
  it("fails closed when the selected RPC is on a different chain", () => {
    assert.doesNotThrow(() => assertSetupRpcChain(1952, 1952));
    assert.throws(() => assertSetupRpcChain(1952, 196), /chain mismatch/);
  });
});

describe("setup RPC boundary", () => {
  it("requires an explicit chain-specific mainnet RPC mapping", () => {
    assert.throws(
      () => resolveSetupRpcUrlForChain({ rpcUrl: "https://generic.example" }, 196),
      /XLAYER_MAINNET_RPC_URL/i,
    );
    assert.equal(
      resolveSetupRpcUrlForChain(
        { rpcUrl: "https://generic.example", rpcUrls: { 196: "https://rpc.xlayer.tech" } },
        196,
      ),
      "https://rpc.xlayer.tech",
    );
  });

  it("rejects non-X Layer deployment chains", () => {
    assert.doesNotThrow(() => assertSupportedSetupChain(196));
    assert.doesNotThrow(() => assertSupportedSetupChain(1952));
    assert.throws(() => assertSupportedSetupChain(1), /only X Layer/i);
  });
});

describe("mainnet bytecode deployment policy", () => {
  it("requires an exact creation-bytecode hash before mainnet deployment", async () => {
    const bytecode = `0x${AGENT_PAY_ACCOUNT_V2_REQUIRED_SELECTORS.map((selector) => selector.slice(2)).join("")}`;
    const deployer = createEthersAgentPayAccountDeployer({
      rpcUrl: "https://rpc.example",
      deployerPrivateKey: `0x${"11".repeat(32)}`,
      bytecode,
    });

    await assert.rejects(
      deployer.deployAgentPayAccount({
        ownerAddress: "0x2222222222222222222222222222222222222222",
        executorAddress: "0x4444444444444444444444444444444444444444",
        initialAllowedTokenAddresses: [MAINNET_USDT0_ADDRESS],
        initialAllowedRouteTargets: [],
        homeChainId: 196,
      }),
      /BYTECODE_HASH pinning/,
    );
  });
});
