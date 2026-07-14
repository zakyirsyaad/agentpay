import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Wallet } from "ethers";

import { createSetupWebDependencies, loadSetupWebConfigEnv, parseSetupWebEnv } from "./runtime.ts";

const validPrivateKey = `0x${"1".repeat(64)}`;
const owner = new Wallet("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const routeTarget = "0x7777777777777777777777777777777777777777";

describe("parseSetupWebEnv", () => {
  it("parses required setup web config", () => {
    const config = parseSetupWebEnv({
      SUPABASE_URL: " https://agentpay.supabase.co ",
      SUPABASE_SERVICE_ROLE_KEY: " service-role-key ",
      XLAYER_RPC_URL: " https://rpc.xlayer.tech ",
      XLAYER_MAINNET_RPC_URL: " https://mainnet.xlayer.tech ",
      XLAYER_TESTNET_RPC_URL: " https://testnet.xlayer.tech ",
      SETUP_DEPLOYER_PRIVATE_KEY: ` ${validPrivateKey} `,
      AGENTPAY_ACCOUNT_BYTECODE: " 0x60006000 ",
      SETUP_WEB_PORT: " 3333 ",
      AGENTPAY_REVIEW_TOKEN_SECRET: " review-token-secret-012345678901234567890123 ",
    });

    assert.deepEqual(config, {
      supabaseUrl: "https://agentpay.supabase.co",
      serviceRoleKey: "service-role-key",
      xlayerRpcUrl: "https://rpc.xlayer.tech",
      xlayerRpcUrls: {
        196: "https://mainnet.xlayer.tech",
        1952: "https://testnet.xlayer.tech",
      },
      setupDeployerPrivateKey: validPrivateKey,
      agentPayAccountBytecode: "0x60006000",
      homeChainId: 1952,
      setupWebPort: 3333,
      reviewTokenSecret: "review-token-secret-012345678901234567890123",
    });
  });

  it("loads bytecode from AGENTPAY_ACCOUNT_BYTECODE_PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentpay-bytecode-"));
    const bytecodePath = join(dir, "AgentPayAccount.bin");

    try {
      await writeFile(bytecodePath, "0x60006000\n", "utf8");
      const config = parseSetupWebEnv({
        SUPABASE_URL: "https://agentpay.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        XLAYER_RPC_URL: "https://rpc.xlayer.tech",
        SETUP_DEPLOYER_PRIVATE_KEY: validPrivateKey,
        AGENTPAY_ACCOUNT_BYTECODE_PATH: bytecodePath,
      });

      assert.equal(config.agentPayAccountBytecode, "0x60006000");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses initial route targets for setup-time allowlisting", () => {
    const config = parseSetupWebEnv({
      SUPABASE_URL: "https://agentpay.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      XLAYER_RPC_URL: "https://rpc.xlayer.tech",
      SETUP_DEPLOYER_PRIVATE_KEY: validPrivateKey,
      AGENTPAY_ACCOUNT_BYTECODE: "0x60006000",
      AGENTPAY_INITIAL_ROUTE_TARGETS: ` ${routeTarget}, 0x8888888888888888888888888888888888888888 `,
    });

    assert.deepEqual(config.initialAllowedRouteTargets, [
      routeTarget,
      "0x8888888888888888888888888888888888888888",
    ]);
  });

  it("parses X Layer testnet as the setup home chain", () => {
    const config = parseSetupWebEnv({
      SUPABASE_URL: "https://agentpay.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      XLAYER_RPC_URL: "https://testrpc.xlayer.tech",
      SETUP_DEPLOYER_PRIVATE_KEY: validPrivateKey,
      AGENTPAY_ACCOUNT_BYTECODE: "0x60006000",
      AGENTPAY_HOME_CHAIN_ID: " 1952 ",
      AGENTPAY_XLAYER_TESTNET_USDT0_ADDRESS: "0x1111111111111111111111111111111111111111",
      AGENTPAY_XLAYER_TESTNET_USDC_ADDRESS: "0x2222222222222222222222222222222222222222",
    });

    assert.equal(config.homeChainId, 1952);
    assert.deepEqual(config.stableTokenOverrides, {
      1952: {
        USDT0: {
          address: "0x1111111111111111111111111111111111111111",
        },
        USDC: {
          address: "0x2222222222222222222222222222222222222222",
        },
      },
    });
  });

  it("merges AGENTPAY_CONFIG JSON with setup web env values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentpay-setup-config-"));
    const configPath = join(dir, "config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify(
          {
            SUPABASE_URL: "https://agentpay.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "config-service-key",
            XLAYER_RPC_URL: "https://rpc.xlayer.tech",
            SETUP_DEPLOYER_PRIVATE_KEY: validPrivateKey,
            AGENTPAY_ACCOUNT_BYTECODE: "0x60006000",
          },
          null,
          2,
        ),
      );

      const env = loadSetupWebConfigEnv({
        AGENTPAY_CONFIG: configPath,
        SUPABASE_SERVICE_ROLE_KEY: "env-service-key",
        SETUP_WEB_PORT: "3333",
      });

      assert.equal(env.SUPABASE_URL, "https://agentpay.supabase.co");
      assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, "env-service-key");
      assert.equal(env.SETUP_DEPLOYER_PRIVATE_KEY, validPrivateKey);
      assert.equal(env.AGENTPAY_ACCOUNT_BYTECODE, "0x60006000");
      assert.equal(env.SETUP_WEB_PORT, "3333");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports invalid variable names without leaking secret values", () => {
    assert.throws(
      () =>
        parseSetupWebEnv({
          SUPABASE_URL: "notaurl",
          SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
          XLAYER_RPC_URL: "",
          SETUP_DEPLOYER_PRIVATE_KEY: "secret-private-key",
        AGENTPAY_ACCOUNT_BYTECODE: "nothex",
        AGENTPAY_INITIAL_ROUTE_TARGETS: "0xnot-an-address",
        AGENTPAY_HOME_CHAIN_ID: "98",
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /SUPABASE_URL/);
        assert.match(error.message, /XLAYER_RPC_URL/);
        assert.match(error.message, /SETUP_DEPLOYER_PRIVATE_KEY/);
        assert.match(error.message, /AGENTPAY_ACCOUNT_BYTECODE/);
        assert.match(error.message, /AGENTPAY_INITIAL_ROUTE_TARGETS/);
        assert.match(error.message, /AGENTPAY_HOME_CHAIN_ID/);
        assert.doesNotMatch(error.message, /service-role-secret/);
        assert.doesNotMatch(error.message, /secret-private-key/);
        return true;
      },
    );
  });

  it("accepts only the V2 account marker and a 32-byte artifact hash", () => {
    assert.throws(
      () =>
        parseSetupWebEnv({
          SUPABASE_URL: "https://agentpay.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
          XLAYER_RPC_URL: "https://rpc.xlayer.tech",
          SETUP_DEPLOYER_PRIVATE_KEY: validPrivateKey,
          AGENTPAY_ACCOUNT_BYTECODE: "0x60006000",
          AGENTPAY_ACCOUNT_VERSION: "v1",
        }),
      /AGENTPAY_ACCOUNT_VERSION/,
    );
    assert.throws(
      () =>
        parseSetupWebEnv({
          SUPABASE_URL: "https://agentpay.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
          XLAYER_RPC_URL: "https://rpc.xlayer.tech",
          SETUP_DEPLOYER_PRIVATE_KEY: validPrivateKey,
          AGENTPAY_ACCOUNT_BYTECODE: "0x60006000",
          AGENTPAY_ACCOUNT_BYTECODE_HASH: "0x1234",
        }),
      /AGENTPAY_ACCOUNT_BYTECODE_HASH/,
    );
  });

  it("fails closed when the deployment UI is pointed at production", () => {
    assert.throws(
      () =>
        parseSetupWebEnv({
          AGENTPAY_ENVIRONMENT: "production",
          SUPABASE_URL: "https://agentpay.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
          XLAYER_RPC_URL: "https://rpc.xlayer.tech",
          SETUP_DEPLOYER_PRIVATE_KEY: validPrivateKey,
          AGENTPAY_ACCOUNT_BYTECODE: "0x60006000",
        }),
      /production setup deployment surface/i,
    );
  });

  it("does not allow an implicit mainnet setup chain", () => {
    assert.throws(
      () =>
        parseSetupWebEnv({
          SUPABASE_URL: "https://agentpay.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
          XLAYER_RPC_URL: "https://rpc.xlayer.tech",
          SETUP_DEPLOYER_PRIVATE_KEY: validPrivateKey,
          AGENTPAY_ACCOUNT_BYTECODE: "0x60006000",
          AGENTPAY_HOME_CHAIN_ID: "196",
        }),
      /mainnet setup deployment surface/i,
    );
  });
});

describe("createSetupWebDependencies", () => {
  it("wires repositories and completion service with injected factories", async () => {
    const calls: Array<[string, unknown]> = [];
    const dependencies = createSetupWebDependencies(
      {
        supabaseUrl: "https://agentpay.supabase.co",
        serviceRoleKey: "service-role-key",
        xlayerRpcUrl: "https://rpc.xlayer.tech",
        setupDeployerPrivateKey: validPrivateKey,
        agentPayAccountBytecode: "0x60006000",
      },
      {
        clock: () => new Date("2026-07-03T04:00:00.000Z"),
        createRepositories(config) {
          calls.push(["supabase", config]);
          return {
            setupIntents: {
              async getSetupIntent() {
                return null;
              },
              async createSetupIntent() {},
              async markSetupSigned() {},
              async markSetupCompleted() {},
              async markSetupExpired() {},
              async markSetupFailed() {},
            },
            wallets: {
              async getActiveWallet() {
                return null;
              },
              async createAgentWallet(wallet) {
                calls.push(["wallet", wallet]);
              },
            },
          };
        },
        createDeployer(config) {
          calls.push(["deployer", config]);
          return {
            async deployAgentPayAccount() {
              return { accountAddress: "0x3333333333333333333333333333333333333333" };
            },
          };
        },
      },
    );

    const missing = await dependencies.getSetupIntent("setup_123");

    assert.equal(missing, null);
    assert.deepEqual(calls, [
      [
        "supabase",
        {
          supabaseUrl: "https://agentpay.supabase.co",
          serviceRoleKey: "service-role-key",
        },
      ],
      [
        "deployer",
        {
          rpcUrl: "https://rpc.xlayer.tech",
          rpcUrls: undefined,
          deployerPrivateKey: validPrivateKey,
          bytecode: "0x60006000",
        },
      ],
    ]);
  });

  it("passes configured initial route targets into wallet deployment", async () => {
    const messageToSign = "AgentPay wallet setup\nSetup intent: setup_123";
    const signature = await owner.signMessage(messageToSign);
    const deployments: unknown[] = [];
    const dependencies = createSetupWebDependencies(
      {
        supabaseUrl: "https://agentpay.supabase.co",
        serviceRoleKey: "service-role-key",
        xlayerRpcUrl: "https://rpc.xlayer.tech",
        setupDeployerPrivateKey: validPrivateKey,
        agentPayAccountBytecode: "0x60006000",
        initialAllowedRouteTargets: [routeTarget],
      },
      {
        clock: () => new Date("2026-07-03T04:00:00.000Z"),
        createRepositories() {
          return {
            setupIntents: {
              async getSetupIntent() {
                return {
                  id: "setup_123",
                  executorAddress: "0x4444444444444444444444444444444444444444",
                  messageToSign,
                  status: "PENDING",
                  expiresAt: "2026-07-03T04:15:00.000Z",
                };
              },
              async createSetupIntent() {},
              async markSetupSigned() {},
              async markSetupCompleted() {},
              async markSetupExpired() {},
              async markSetupFailed() {},
            },
            wallets: {
              async getActiveWallet() {
                return null;
              },
              async createAgentWallet() {},
            },
          };
        },
        createDeployer() {
          return {
            async deployAgentPayAccount(request) {
              deployments.push(request);
              return { accountAddress: "0x3333333333333333333333333333333333333333" };
            },
          };
        },
      },
    );

    await dependencies.completeWalletSetup({ setupIntentId: "setup_123", signature });

    assert.deepEqual(deployments, [
      {
        ownerAddress: owner.address,
        executorAddress: "0x4444444444444444444444444444444444444444",
        homeChainId: 1952,
        initialAllowedTokenAddresses: [
          "0x9e29b3AaDa05Bf2D2c827Af80Bd28Dc0b9b4FB0c",
          "0xcB8BF24c6cE16Ad21D707c9505421a17f2bec79D",
        ],
        initialAllowedRouteTargets: [routeTarget],
      },
    ]);
  });

  it("passes configured X Layer testnet home chain and token allowlist into wallet deployment", async () => {
    const messageToSign = "AgentPay wallet setup\nSetup intent: setup_123";
    const signature = await owner.signMessage(messageToSign);
    const deployments: unknown[] = [];
    const wallets: unknown[] = [];
    const dependencies = createSetupWebDependencies(
      {
        supabaseUrl: "https://agentpay.supabase.co",
        serviceRoleKey: "service-role-key",
        xlayerRpcUrl: "https://testrpc.xlayer.tech",
        xlayerRpcUrls: {
          196: "https://mainnet.xlayer.tech",
          1952: "https://testnet.xlayer.tech",
        },
        setupDeployerPrivateKey: validPrivateKey,
        agentPayAccountBytecode: "0x60006000",
        homeChainId: 1952,
        stableTokenOverrides: {
          1952: {
            USDT0: {
              address: "0x1111111111111111111111111111111111111111",
            },
            USDC: {
              address: "0x2222222222222222222222222222222222222222",
            },
          },
        },
      },
      {
        clock: () => new Date("2026-07-03T04:00:00.000Z"),
        createRepositories() {
          return {
            setupIntents: {
              async getSetupIntent() {
                return {
                  id: "setup_123",
                  executorAddress: "0x4444444444444444444444444444444444444444",
                  messageToSign,
                  status: "PENDING",
                  expiresAt: "2026-07-03T04:15:00.000Z",
                };
              },
              async createSetupIntent() {},
              async markSetupSigned() {},
              async markSetupCompleted() {},
              async markSetupExpired() {},
              async markSetupFailed() {},
            },
            wallets: {
              async getActiveWallet() {
                return null;
              },
              async createAgentWallet(wallet) {
                wallets.push(wallet);
              },
            },
          };
        },
        createDeployer() {
          return {
            async deployAgentPayAccount(request) {
              deployments.push(request);
              return { accountAddress: "0x3333333333333333333333333333333333333333" };
            },
          };
        },
      },
    );

    await dependencies.completeWalletSetup({ setupIntentId: "setup_123", signature });

    assert.deepEqual(deployments, [
      {
        ownerAddress: owner.address,
        executorAddress: "0x4444444444444444444444444444444444444444",
        homeChainId: 1952,
        initialAllowedTokenAddresses: [
          "0x1111111111111111111111111111111111111111",
          "0x2222222222222222222222222222222222222222",
        ],
        initialAllowedRouteTargets: [],
      },
    ]);
    assert.deepEqual(wallets, [
      {
        ownerAddress: owner.address,
        accountAddress: "0x3333333333333333333333333333333333333333",
        homeChainId: 1952,
        executorAddress: "0x4444444444444444444444444444444444444444",
        status: "ACTIVE",
      },
    ]);
  });
});
