import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AbiCoder, keccak256 } from "ethers";

import {
  MAINNET_ONBOARDING_URL,
  MAINNET_SETUP_CHAIN_ID,
  MAINNET_SETUP_ENVIRONMENT,
  MAINNET_SETUP_ROUTE_ALLOWLIST_HASH,
  MAINNET_SETUP_TOKEN_ALLOWLIST_HASH,
  MAINNET_SETUP_USDT0,
  MAINNET_WALLET_SETUP_TYPES,
  createMainnetWalletSetupTypedData,
  mainnetWalletSetupAuthorizeRequestSchema,
  mainnetWalletSetupChallengeRequestSchema,
  mainnetWalletSetupChallengeResponseSchema,
  mainnetWalletSetupMessageSchema,
  mainnetWalletSetupPublicStatusCodeSchema,
  mainnetWalletSetupPublicStatusSchema,
  mainnetWalletSetupTypedDataSchema,
  toEip712Sha256Bytes32,
  type MainnetWalletSetupMessage,
  type MainnetWalletSetupPolicyContext,
} from "./mainnet-wallet-setup.ts";

const owner = "0x1111111111111111111111111111111111111111";
const executor = "0x2222222222222222222222222222222222222222";
const factory = "0x3333333333333333333333333333333333333333";
const deployer = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const predictedAccount = "0x5555555555555555555555555555555555555555";
const hash = (digit: string) => `0x${digit.repeat(64)}`;

function validMessage(overrides: Partial<MainnetWalletSetupMessage> = {}): MainnetWalletSetupMessage {
  return {
    setupIntentId: "setup-intent-0000000001",
    deploymentNonce: hash("1"),
    owner,
    executor,
    homeChainId: MAINNET_SETUP_CHAIN_ID,
    environment: MAINNET_SETUP_ENVIRONMENT,
    deadline: "2000000000",
    factory,
    factoryRuntimeCodeHash: hash("2"),
    deploymentSalt: hash("3"),
    predictedAccount,
    accountCreationCodeHash: hash("4"),
    accountRuntimeCodeHash: hash("5"),
    token: MAINNET_SETUP_USDT0,
    tokenAllowlistHash: MAINNET_SETUP_TOKEN_ALLOWLIST_HASH,
    routeAllowlistHash: MAINNET_SETUP_ROUTE_ALLOWLIST_HASH,
    manifestSha256: hash("6"),
    ...overrides,
  };
}

function validPolicyContext(
  message = validMessage(),
  overrides: Partial<MainnetWalletSetupPolicyContext> = {},
): MainnetWalletSetupPolicyContext {
  return {
    ownerAddress: message.owner,
    executorAddress: message.executor,
    factoryAddress: message.factory,
    factoryRuntimeCodeHash: message.factoryRuntimeCodeHash,
    deploymentSalt: message.deploymentSalt,
    predictedAccount: message.predictedAccount,
    accountCreationCodeHash: message.accountCreationCodeHash,
    accountRuntimeCodeHash: message.accountRuntimeCodeHash,
    manifestSha256: message.manifestSha256,
    sponsorDeployerAddress: deployer,
    currentUnixTime: 1_900_000_000,
    ...overrides,
  };
}

function createTypedData(message = validMessage()) {
  return createMainnetWalletSetupTypedData(message, validPolicyContext(message));
}

describe("mainnet wallet setup constants", () => {
  it("pins the hosted production policy", () => {
    assert.equal(MAINNET_SETUP_CHAIN_ID, 196);
    assert.equal(MAINNET_SETUP_ENVIRONMENT, "production");
    assert.equal(MAINNET_SETUP_USDT0, "0x779Ded0c9e1022225f8E0630b35a9b54bE713736");
    assert.equal(MAINNET_ONBOARDING_URL, "https://onboard.agentpay.site/setup");
  });

  it("pins ABI-encoded token and route allowlist hashes", () => {
    const abiCoder = AbiCoder.defaultAbiCoder();
    assert.equal(
      MAINNET_SETUP_TOKEN_ALLOWLIST_HASH,
      keccak256(abiCoder.encode(["address[]"], [[MAINNET_SETUP_USDT0]])),
    );
    assert.equal(MAINNET_SETUP_ROUTE_ALLOWLIST_HASH, keccak256(abiCoder.encode(["address[]"], [[]])));
  });
});

describe("createMainnetWalletSetupTypedData", () => {
  it("creates the exact canonical EIP-712 envelope and field order", () => {
    const typedData = createTypedData();

    assert.deepEqual(typedData.domain, {
      name: "AgentPay Setup",
      version: "1",
      chainId: 196,
      verifyingContract: factory,
    });
    assert.equal(typedData.primaryType, "MainnetWalletSetup");
    assert.deepEqual(
      typedData.types.MainnetWalletSetup.map(({ name, type }) => [name, type]),
      [
        ["setupIntentId", "string"],
        ["deploymentNonce", "bytes32"],
        ["owner", "address"],
        ["executor", "address"],
        ["homeChainId", "uint256"],
        ["environment", "string"],
        ["deadline", "uint256"],
        ["factory", "address"],
        ["factoryRuntimeCodeHash", "bytes32"],
        ["deploymentSalt", "bytes32"],
        ["predictedAccount", "address"],
        ["accountCreationCodeHash", "bytes32"],
        ["accountRuntimeCodeHash", "bytes32"],
        ["token", "address"],
        ["tokenAllowlistHash", "bytes32"],
        ["routeAllowlistHash", "bytes32"],
        ["manifestSha256", "bytes32"],
      ],
    );
    assert.deepEqual(Object.keys(typedData.message), MAINNET_WALLET_SETUP_TYPES.MainnetWalletSetup.map(({ name }) => name));
    assert.equal(typedData.message.predictedAccount, predictedAccount);
    assert.equal(typedData.message.environment, "production");
  });

  it("returns detached, deeply frozen typed data", () => {
    const input = validMessage();
    const typedData = createTypedData(input);

    assert.notEqual(typedData.message, input);
    assert.equal(Object.isFrozen(typedData), true);
    assert.equal(Object.isFrozen(typedData.domain), true);
    assert.equal(Object.isFrozen(typedData.message), true);
    assert.equal(Object.isFrozen(typedData.types), true);
    assert.equal(Object.isFrozen(typedData.types.MainnetWalletSetup), true);
    assert.equal(Object.isFrozen(typedData.types.MainnetWalletSetup[0]), true);
    assert.throws(() => {
      (typedData.message as { owner: string }).owner = deployer;
    }, TypeError);
    assert.equal(JSON.stringify(typedData).includes("sponsorDeployerAddress"), false);
    assert.equal(JSON.stringify(typedData).includes(deployer), false);
  });

  it("rejects unknown message and policy fields", () => {
    const message = validMessage();
    assert.throws(() =>
      createMainnetWalletSetupTypedData(
        { ...message, sourceToken: MAINNET_SETUP_USDT0 } as MainnetWalletSetupMessage,
        validPolicyContext(message),
      ),
    );
    assert.throws(() =>
      createMainnetWalletSetupTypedData(message, {
        ...validPolicyContext(message),
        homeChainId: 1952,
      } as never),
    );
  });

  it("rejects every message field that differs from the server-validated dynamic policy", () => {
    const message = validMessage();
    const mutations: Partial<MainnetWalletSetupMessage>[] = [
      { owner: "0x6666666666666666666666666666666666666666" },
      { executor: "0x7777777777777777777777777777777777777777" },
      { factory: "0x8888888888888888888888888888888888888888" },
      { factoryRuntimeCodeHash: hash("7") },
      { deploymentSalt: hash("8") },
      { predictedAccount: "0x9999999999999999999999999999999999999999" },
      { accountCreationCodeHash: hash("a") },
      { accountRuntimeCodeHash: hash("b") },
      { manifestSha256: hash("c") },
    ];

    for (const mutation of mutations) {
      assert.throws(() =>
        createMainnetWalletSetupTypedData(
          { ...message, ...mutation },
          validPolicyContext(message),
        ),
      );
    }
  });

  it("compares server-validated addresses and bytes semantically", () => {
    const caseSensitiveMessage = validMessage({
      owner: "0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA",
      factoryRuntimeCodeHash: hash("a"),
      deploymentSalt: hash("b"),
      manifestSha256: hash("c"),
    });

    assert.doesNotThrow(() =>
      createMainnetWalletSetupTypedData(
        caseSensitiveMessage,
        validPolicyContext(caseSensitiveMessage, {
          ownerAddress: caseSensitiveMessage.owner.toLowerCase(),
          factoryRuntimeCodeHash: hash("A"),
          deploymentSalt: hash("B"),
          manifestSha256: hash("C"),
        }),
      ),
    );
  });

  it("rejects testnet and mutable token policy", () => {
    const nonCanonicalAddress = "0x0000000000000000000000000000000000000001";
    const mutations: Record<string, unknown>[] = [
      { homeChainId: 1952 },
      { environment: "staging" },
      { token: nonCanonicalAddress },
      { tokenAllowlistHash: hash("a") },
      { routeAllowlistHash: hash("b") },
    ];

    for (const mutation of mutations) {
      assert.throws(() => createTypedData({ ...validMessage(), ...mutation } as MainnetWalletSetupMessage));
    }
  });

  it("rejects invalid and zero actor/account addresses", () => {
    const zeroAddress = "0x0000000000000000000000000000000000000000";
    const addressFields = ["owner", "executor", "factory", "predictedAccount"] as const;
    for (const field of addressFields) {
      assert.throws(() => createTypedData(validMessage({ [field]: zeroAddress })));
      assert.throws(() => createTypedData(validMessage({ [field]: "0xnot-an-address" })));
    }
    assert.throws(() =>
      createMainnetWalletSetupTypedData(validMessage(), {
        ...validPolicyContext(),
        sponsorDeployerAddress: zeroAddress,
      }),
    );
    assert.throws(() =>
      createMainnetWalletSetupTypedData(validMessage(), {
        ...validPolicyContext(),
        factoryRuntimeCodeHash: "0x1234",
      }),
    );
  });

  it("requires owner, executor, factory, and sponsor deployer to be pairwise distinct", () => {
    assert.throws(() => createTypedData(validMessage({ executor: owner })));
    assert.throws(() => createTypedData(validMessage({ factory: owner })));
    assert.throws(() =>
      createMainnetWalletSetupTypedData(validMessage(), {
        ...validPolicyContext(),
        sponsorDeployerAddress: owner,
      }),
    );
    assert.throws(() => createTypedData(validMessage({ factory: executor })));
    assert.throws(() =>
      createMainnetWalletSetupTypedData(validMessage(), {
        ...validPolicyContext(),
        sponsorDeployerAddress: executor,
      }),
    );
    assert.throws(() =>
      createMainnetWalletSetupTypedData(validMessage(), {
        ...validPolicyContext(),
        sponsorDeployerAddress: factory,
      }),
    );
  });

  it("rejects case-insensitive collisions among every actor pair", () => {
    const mixedOwner = "0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA";
    const mixedExecutor = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
    const mixedFactory = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";
    const actorsMessage = validMessage({ owner: mixedOwner, executor: mixedExecutor, factory: mixedFactory });

    assert.throws(() => createTypedData({ ...actorsMessage, executor: mixedOwner.toLowerCase() }));
    assert.throws(() => createTypedData({ ...actorsMessage, factory: mixedOwner.toLowerCase() }));
    assert.throws(() =>
      createMainnetWalletSetupTypedData(
        actorsMessage,
        validPolicyContext(actorsMessage, { sponsorDeployerAddress: mixedOwner.toLowerCase() }),
      ),
    );
    assert.throws(() => createTypedData({ ...actorsMessage, factory: mixedExecutor.toUpperCase().replace("0X", "0x") }));
    assert.throws(() =>
      createMainnetWalletSetupTypedData(
        actorsMessage,
        validPolicyContext(actorsMessage, { sponsorDeployerAddress: mixedExecutor.toLowerCase() }),
      ),
    );
    assert.throws(() =>
      createMainnetWalletSetupTypedData(
        actorsMessage,
        validPolicyContext(actorsMessage, { sponsorDeployerAddress: mixedFactory.toLowerCase() }),
      ),
    );
  });

  it("rejects malformed bytes32 fields", () => {
    const bytes32Fields = [
      "deploymentNonce",
      "factoryRuntimeCodeHash",
      "deploymentSalt",
      "accountCreationCodeHash",
      "accountRuntimeCodeHash",
      "tokenAllowlistHash",
      "routeAllowlistHash",
      "manifestSha256",
    ] as const;

    for (const field of bytes32Fields) {
      assert.throws(() => createTypedData(validMessage({ [field]: "0x1234" })));
      assert.throws(() => createTypedData(validMessage({ [field]: `0x${"g".repeat(64)}` })));
    }
  });

  it("rejects invalid, zero, expired, and overflowing uint256 deadlines", () => {
    const invalidDeadlines = [
      "0",
      "01",
      "-1",
      "1.5",
      "not-a-number",
      "1900000000",
      (1n << 256n).toString(),
    ];
    for (const deadline of invalidDeadlines) {
      assert.throws(() => createTypedData(validMessage({ deadline })));
    }

    assert.doesNotThrow(() => mainnetWalletSetupMessageSchema.safeParse(validMessage({ deadline: "not-a-number" })));
    assert.equal(mainnetWalletSetupMessageSchema.safeParse(validMessage({ deadline: "not-a-number" })).success, false);
  });

  it("accepts MAX_UINT256 and rejects lexical overflow without parsing overlong input", () => {
    const maxUint256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    const maxUint256PlusOne = "115792089237316195423570985008687907853269984665640564039457584007913129639936";
    assert.doesNotThrow(() => createTypedData(validMessage({ deadline: maxUint256 })));
    assert.throws(() => createTypedData(validMessage({ deadline: maxUint256PlusOne })));

    const overlongResult = mainnetWalletSetupMessageSchema.safeParse(validMessage({ deadline: "9".repeat(10_000) }));
    assert.equal(overlongResult.success, false);
    if (!overlongResult.success) {
      assert.equal(overlongResult.error.issues.some(({ message }) => message.includes("at most 78 decimal digits")), true);
    }
  });

  it("rejects shuffled or mutated EIP-712 types and a mismatched verifying contract", () => {
    const typedData = createTypedData();
    const fields = typedData.types.MainnetWalletSetup.map((field) => ({ ...field }));
    const shuffledFields = [fields[1]!, fields[0]!, ...fields.slice(2)];
    const mutatedFields = fields.map((field, index) => (index === 4 ? { ...field, type: "string" } : field));

    assert.equal(
      mainnetWalletSetupTypedDataSchema.safeParse({
        ...typedData,
        types: { MainnetWalletSetup: shuffledFields },
      }).success,
      false,
    );
    assert.equal(
      mainnetWalletSetupTypedDataSchema.safeParse({
        ...typedData,
        types: { MainnetWalletSetup: mutatedFields },
      }).success,
      false,
    );
    assert.equal(
      mainnetWalletSetupTypedDataSchema.safeParse({
        ...typedData,
        domain: { ...typedData.domain, verifyingContract: "0x6666666666666666666666666666666666666666" },
      }).success,
      false,
    );
  });
});

describe("toEip712Sha256Bytes32", () => {
  it("converts an exact bare SHA-256 digest to lowercase bytes32", () => {
    assert.equal(toEip712Sha256Bytes32("A".repeat(64)), `0x${"a".repeat(64)}`);
  });

  it("rejects prefixed, short, long, and non-hex digests", () => {
    for (const digest of [`0x${"a".repeat(64)}`, "a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
      assert.throws(() => toEip712Sha256Bytes32(digest));
    }
  });
});

describe("mainnet wallet setup HTTP schemas", () => {
  it("accepts only an owner address in challenge requests", () => {
    assert.deepEqual(mainnetWalletSetupChallengeRequestSchema.parse({ ownerAddress: owner }), { ownerAddress: owner });
    assert.throws(() => mainnetWalletSetupChallengeRequestSchema.parse({ ownerAddress: owner, homeChainId: 1952 }));
    assert.throws(() => mainnetWalletSetupChallengeRequestSchema.parse({ ownerAddress: "0x0" }));
  });

  it("accepts a JSON-serializable canonical challenge response", () => {
    const response = mainnetWalletSetupChallengeResponseSchema.parse({
      capability: `${"a".repeat(42)}g`,
      csrfToken: `${"b".repeat(42)}w`,
      typedData: createTypedData(),
      expiresAt: "2033-05-18T03:33:20.000Z",
    });

    assert.doesNotThrow(() => JSON.stringify(response));
    assert.equal(JSON.stringify(response).includes("bigint"), false);
    assert.throws(() =>
      mainnetWalletSetupChallengeResponseSchema.parse({ ...response, setupIntentId: response.typedData.message.setupIntentId }),
    );
    assert.throws(() => mainnetWalletSetupChallengeResponseSchema.parse({ ...response, capability: "a".repeat(42) }));
    assert.throws(() => mainnetWalletSetupChallengeResponseSchema.parse({ ...response, csrfToken: `${"a".repeat(42)}+` }));
    assert.throws(() => mainnetWalletSetupChallengeResponseSchema.parse({ ...response, expiresAt: "not-an-iso-time" }));
  });

  it("accepts every canonical final character for a 32-byte unpadded base64url capability", () => {
    const response = {
      capability: `${"a".repeat(42)}A`,
      csrfToken: `${"b".repeat(42)}A`,
      typedData: createTypedData(),
      expiresAt: "2033-05-18T03:33:20.000Z",
    };
    for (const finalCharacter of "AEIMQUYcgkosw048") {
      assert.doesNotThrow(() => mainnetWalletSetupChallengeResponseSchema.parse({
        ...response,
        capability: `${"a".repeat(42)}${finalCharacter}`,
      }));
    }
  });

  it("accepts only an EVM signature in authorize requests", () => {
    const signature = `0x${"a".repeat(130)}`;
    assert.deepEqual(mainnetWalletSetupAuthorizeRequestSchema.parse({ signature }), { signature });
    assert.throws(() => mainnetWalletSetupAuthorizeRequestSchema.parse({ signature, setupIntentId: "caller-controlled" }));
    assert.throws(() => mainnetWalletSetupAuthorizeRequestSchema.parse({ signature: "0x1234" }));
  });

  it("exposes exactly six public status values and sanitized status fields", () => {
    assert.deepEqual(mainnetWalletSetupPublicStatusCodeSchema.options, [
      "SETUP_PENDING",
      "SETUP_DEPLOYING",
      "SETUP_COMPLETED",
      "SETUP_EXPIRED",
      "SETUP_FAILED",
      "SETUP_MANUAL_REVIEW",
    ]);

    const status = {
      setupIntentId: "setup-intent-0000000001",
      status: "SETUP_COMPLETED",
      predictedAccount,
      transactionHash: hash("a"),
      publicCode: "SETUP_DEPLOYMENT_CONFIRMED",
      createdAt: "2033-05-18T03:00:00.000Z",
      updatedAt: "2033-05-18T03:30:00.000Z",
      completedAt: "2033-05-18T03:30:00.000Z",
    };
    assert.deepEqual(mainnetWalletSetupPublicStatusSchema.parse(status), status);
    assert.throws(() => mainnetWalletSetupPublicStatusSchema.parse({ ...status, internalError: "RPC secret" }));
    assert.throws(() => mainnetWalletSetupPublicStatusSchema.parse({ ...status, publicCode: "raw rpc error" }));
    assert.throws(() => mainnetWalletSetupPublicStatusSchema.parse({ ...status, transactionHash: "0x1234" }));
    assert.throws(() => mainnetWalletSetupPublicStatusSchema.parse({ ...status, createdAt: "not-an-iso-time" }));
    assert.throws(() => mainnetWalletSetupPublicStatusSchema.parse({ ...status, updatedAt: "2026-07-17" }));
    assert.throws(() => mainnetWalletSetupPublicStatusSchema.parse({ ...status, completedAt: "tomorrow" }));
  });
});

describe("shared index", () => {
  it("exports the mainnet onboarding contract", async () => {
    const shared = await import("./index.ts");
    assert.equal(shared.MAINNET_SETUP_CHAIN_ID, 196);
    assert.equal(typeof shared.createMainnetWalletSetupTypedData, "function");
  });
});
