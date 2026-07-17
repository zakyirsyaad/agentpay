import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concat, Signature, toBeHex, Wallet } from "ethers";

import {
  MAINNET_SETUP_USDT0,
  createMainnetWalletSetupTypedData,
  type MainnetWalletSetupPolicyContext,
  type MainnetWalletSetupTypedData,
} from "@agentpay-ai/shared";

import { verifyProductionSetupAuthorization } from "./authorization.ts";

const owner = Wallet.createRandom();
const other = Wallet.createRandom();
const address = (digit: string) => `0x${digit.repeat(40)}`;
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const nowUnix = 1_768_000_000;

const policy: MainnetWalletSetupPolicyContext = {
  ownerAddress: owner.address,
  executorAddress: address("2"),
  factoryAddress: address("3"),
  factoryRuntimeCodeHash: hash("4"),
  deploymentSalt: hash("5"),
  predictedAccount: address("6"),
  accountCreationCodeHash: hash("7"),
  accountRuntimeCodeHash: hash("8"),
  manifestSha256: hash("9"),
  sponsorDeployerAddress: address("a"),
  currentUnixTime: nowUnix,
};

const typedData = createMainnetWalletSetupTypedData({
  setupIntentId: "setup_production_123456789",
  deploymentNonce: hash("1"),
  owner: owner.address,
  executor: policy.executorAddress,
  homeChainId: 196,
  environment: "production",
  deadline: String(nowUnix + 600),
  factory: policy.factoryAddress,
  factoryRuntimeCodeHash: policy.factoryRuntimeCodeHash,
  deploymentSalt: policy.deploymentSalt,
  predictedAccount: policy.predictedAccount,
  accountCreationCodeHash: policy.accountCreationCodeHash,
  accountRuntimeCodeHash: policy.accountRuntimeCodeHash,
  token: MAINNET_SETUP_USDT0,
  tokenAllowlistHash: "0xc0687130b337dbc04821b9bd064027dd46ef43a11adc8c2d98fccd719152b4a5",
  routeAllowlistHash: "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd",
  manifestSha256: policy.manifestSha256,
}, policy);

async function sign(value: MainnetWalletSetupTypedData = typedData, wallet = owner) {
  return wallet.signTypedData(
    value.domain,
    value.types as unknown as Record<string, Array<{ name: string; type: string }>>,
    value.message,
  );
}

describe("production setup owner authorization", () => {
  it("accepts only the bound EOA and returns a canonical low-s 65-byte signature", async () => {
    const signature = await sign();
    const result = await verifyProductionSetupAuthorization({
      typedData,
      signature,
      expectedOwnerAddress: owner.address,
      policy,
      nowUnix,
      getOwnerCode: async () => "0x",
    });

    assert.equal(result.ownerAddress, owner.address.toLowerCase());
    assert.equal(result.signature, Signature.from(signature).serialized);
    assert.match(result.signature, /^0x[0-9a-f]{130}$/);
    assert.match(result.authorizationHash, /^0x[0-9a-f]{64}$/);
  });

  it("rejects another wallet without changing the reusable server-bound authorization", async () => {
    const wrong = await sign(typedData, other);
    await assert.rejects(
      () => verifyProductionSetupAuthorization({
        typedData,
        signature: wrong,
        expectedOwnerAddress: owner.address,
        policy,
        nowUnix,
        getOwnerCode: async () => "0x",
      }),
      /SETUP_SIGNATURE_INVALID/,
    );

    const valid = await verifyProductionSetupAuthorization({
      typedData,
      signature: await sign(),
      expectedOwnerAddress: owner.address,
      policy,
      nowUnix,
      getOwnerCode: async () => "0x",
    });
    assert.equal(valid.ownerAddress, owner.address.toLowerCase());
  });

  it("rejects policy drift, expiry, contract owners, malformed and malleable signatures", async () => {
    const signature = await sign();
    const mutations: Array<Partial<MainnetWalletSetupPolicyContext>> = [
      { factoryAddress: address("b") },
      { executorAddress: address("b") },
      { deploymentSalt: hash("b") },
      { predictedAccount: address("b") },
      { factoryRuntimeCodeHash: hash("b") },
      { accountRuntimeCodeHash: hash("b") },
      { manifestSha256: hash("b") },
    ];
    for (const mutation of mutations) {
      await assert.rejects(
        () => verifyProductionSetupAuthorization({
          typedData,
          signature,
          expectedOwnerAddress: owner.address,
          policy: { ...policy, ...mutation },
          nowUnix,
          getOwnerCode: async () => "0x",
        }),
        /SETUP_AUTHORIZATION_INVALID/,
      );
    }

    await assert.rejects(
      () => verifyProductionSetupAuthorization({ ...baseInput(signature), nowUnix: nowUnix + 600 }),
      /SETUP_AUTHORIZATION_EXPIRED/,
    );
    await assert.rejects(
      () => verifyProductionSetupAuthorization({ ...baseInput(signature), getOwnerCode: async () => "0x6000" }),
      /SETUP_OWNER_NOT_EOA/,
    );
    await assert.rejects(
      () => verifyProductionSetupAuthorization({ ...baseInput("0x1234") }),
      /SETUP_SIGNATURE_INVALID/,
    );

    const parsed = Signature.from(signature);
    const curveOrder = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const highS = curveOrder - BigInt(parsed.s);
    const malleable = concat([parsed.r, toBeHex(highS, 32), toBeHex(parsed.v === 27 ? 28 : 27, 1)]);
    await assert.rejects(
      () => verifyProductionSetupAuthorization({ ...baseInput(malleable) }),
      /SETUP_SIGNATURE_INVALID/,
    );
  });
});

function baseInput(signature: string) {
  return {
    typedData,
    signature,
    expectedOwnerAddress: owner.address,
    policy,
    nowUnix,
    getOwnerCode: async () => "0x",
  };
}
