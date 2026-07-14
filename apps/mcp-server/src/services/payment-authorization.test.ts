import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AbiCoder, concat, keccak256, toUtf8Bytes, Wallet } from "ethers";

import type { PaymentIntentRecord } from "@agentpay-ai/shared";

import {
  createDirectPaymentAuthorizationFromIntent,
  createPaymentAuthorizationFromIntent,
  createRoutePaymentAuthorizationFromIntent,
  hashPaymentAuthorization,
  verifyPaymentAuthorizationSignature,
} from "./payment-authorization.ts";

const ownerWallet = new Wallet(`0x${"11".repeat(32)}`);

function directIntent(overrides: Partial<PaymentIntentRecord> = {}): PaymentIntentRecord {
  return {
    id: "pay_direct",
    accountAddress: "0x3333333333333333333333333333333333333333",
    ownerAddress: ownerWallet.address,
    status: "AWAITING_APPROVAL",
    paymentType: "WALLET_PAYMENT",
    sourceChainId: 196,
    destinationChainId: 196,
    sourceTokenAddress: "0x5555555555555555555555555555555555555555",
    sourceTokenSymbol: "USDT0",
    destinationTokenAddress: "0x5555555555555555555555555555555555555555",
    destinationTokenSymbol: "USDT0",
    recipientAddress: "0x2222222222222222222222222222222222222222",
    amountOut: "10",
    maxAmountIn: "10",
    maxNativeFee: "0",
    routeProvider: "DIRECT",
    routeTarget: "0x0000000000000000000000000000000000000000",
    routeCalldata: "0x",
    routeCalldataHash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    routeSummary: "Direct payment.",
    nonce: "42",
    deadline: "2026-07-02T14:45:00.000Z",
    purpose: "invoice payment",
    approvalPhrase: "APPROVE pay_direct",
    ...overrides,
  };
}

function routeIntent(overrides: Partial<PaymentIntentRecord> = {}): PaymentIntentRecord {
  return {
    ...directIntent(),
    id: "pay_route",
    routeProvider: "LI.FI",
    destinationChainId: 8453,
    destinationTokenAddress: "0x6666666666666666666666666666666666666666",
    destinationTokenSymbol: "USDC",
    maxAmountIn: "10.18",
    maxNativeFee: "250000000000000",
    nativeValue: "100000000000000",
    routeTarget: "0x7777777777777777777777777777777777777777",
    routeCalldata: "0x1234",
    routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
    minAmountOut: "10",
    ...overrides,
  };
}

describe("payment authorization backend", () => {
  it("builds and verifies the exact direct authorization signed by the owner", async () => {
    const typedData = createDirectPaymentAuthorizationFromIntent(directIntent(), "tenant_123");
    const signature = await ownerWallet.signTypedData(
      typedData.domain,
      typedData.types as unknown as Record<string, Array<{ name: string; type: string }>>,
      typedData.message,
    );

    assert.equal(typedData.message.amount, "10000000");
    assert.equal(typedData.message.deadline, "1783003500");
    assert.equal(verifyPaymentAuthorizationSignature({ typedData, signature, expectedOwner: ownerWallet.address }), true);
    assert.equal(
      verifyPaymentAuthorizationSignature({
        typedData,
        signature,
        expectedOwner: "0x9999999999999999999999999999999999999999",
      }),
      false,
    );
    assert.equal(hashPaymentAuthorization(typedData).length, 66);
  });

  it("keeps route calldata, source cap, destination minimum, and native fee in the signed hash", () => {
    const typedData = createRoutePaymentAuthorizationFromIntent(routeIntent(), "tenant_123");
    const changed = createRoutePaymentAuthorizationFromIntent(routeIntent({ minAmountOut: "9.99" }), "tenant_123");

    assert.equal(typedData.message.maxAmountIn, "10180000");
    assert.equal(typedData.message.minAmountOut, "10000000");
    assert.equal(typedData.message.routeCalldataHash, "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432");
    assert.notEqual(hashPaymentAuthorization(typedData), hashPaymentAuthorization(changed));
    assert.equal(createPaymentAuthorizationFromIntent(routeIntent(), "tenant_123").primaryType, "RoutePaymentAuthorization");
  });

  it("matches the Solidity V2 direct EIP-712 digest word-for-word", () => {
    const typedData = createDirectPaymentAuthorizationFromIntent(directIntent(), "tenant_123");
    const coder = AbiCoder.defaultAbiCoder();
    const domainTypeHash = keccak256(
      toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    );
    const directTypeHash = keccak256(
      toUtf8Bytes(
        "DirectPaymentAuthorization(bytes32 intentIdHash,bytes32 tenantIdHash,bytes32 paymentType,address owner,address account,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline,bytes32 purposeHash)",
      ),
    );
    const domainSeparator = keccak256(
      coder.encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [domainTypeHash, keccak256(toUtf8Bytes("AgentPay")), keccak256(toUtf8Bytes("1")), 196, typedData.domain.verifyingContract],
      ),
    );
    const structHash = keccak256(
      coder.encode(
        [
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
          "address",
          "address",
          "address",
          "address",
          "uint256",
          "uint256",
          "uint256",
          "bytes32",
        ],
        [
          directTypeHash,
          typedData.message.intentIdHash,
          typedData.message.tenantIdHash,
          typedData.message.paymentType,
          typedData.message.owner,
          typedData.message.account,
          typedData.message.token,
          typedData.message.recipient,
          typedData.message.amount,
          typedData.message.nonce,
          typedData.message.deadline,
          typedData.message.purposeHash,
        ],
      ),
    );

    assert.equal(hashPaymentAuthorization(typedData), keccak256(concat(["0x1901", domainSeparator, structHash])));
  });

  it("matches the Solidity V2 route digest word-for-word", () => {
    const typedData = createRoutePaymentAuthorizationFromIntent(routeIntent(), "tenant_123");
    const coder = AbiCoder.defaultAbiCoder();
    const domainTypeHash = keccak256(
      toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    );
    const routeTypeHash = keccak256(
      toUtf8Bytes(
        "RoutePaymentAuthorization(bytes32 intentIdHash,bytes32 tenantIdHash,bytes32 paymentType,address owner,address account,address sourceToken,uint256 maxAmountIn,uint256 destinationChainId,address destinationToken,address recipient,uint256 minAmountOut,address routeTarget,bytes32 routeCalldataHash,uint256 maxNativeFee,uint256 nonce,uint256 deadline,bytes32 purposeHash)",
      ),
    );
    const domainSeparator = keccak256(
      coder.encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [domainTypeHash, keccak256(toUtf8Bytes("AgentPay")), keccak256(toUtf8Bytes("1")), 196, typedData.domain.verifyingContract],
      ),
    );
    const structHash = keccak256(
      coder.encode(
        [
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
          "address",
          "address",
          "address",
          "uint256",
          "uint256",
          "address",
          "address",
          "uint256",
          "address",
          "bytes32",
          "uint256",
          "uint256",
          "uint256",
          "bytes32",
        ],
        [
          routeTypeHash,
          typedData.message.intentIdHash,
          typedData.message.tenantIdHash,
          typedData.message.paymentType,
          typedData.message.owner,
          typedData.message.account,
          typedData.message.sourceToken,
          typedData.message.maxAmountIn,
          typedData.message.destinationChainId,
          typedData.message.destinationToken,
          typedData.message.recipient,
          typedData.message.minAmountOut,
          typedData.message.routeTarget,
          typedData.message.routeCalldataHash,
          typedData.message.maxNativeFee,
          typedData.message.nonce,
          typedData.message.deadline,
          typedData.message.purposeHash,
        ],
      ),
    );

    assert.equal(hashPaymentAuthorization(typedData), keccak256(concat(["0x1901", domainSeparator, structHash])));
  });

  it("fails closed when tenant binding or provider minimum output is missing", () => {
    assert.throws(() => createDirectPaymentAuthorizationFromIntent(directIntent(), ""), /tenant ID/);
    assert.throws(
      () => createRoutePaymentAuthorizationFromIntent(routeIntent({ minAmountOut: undefined }), "tenant_123"),
      /minAmountOut/,
    );
    assert.throws(
      () => createRoutePaymentAuthorizationFromIntent(routeIntent({ nativeValue: undefined }), "tenant_123"),
      /native value/,
    );
    assert.throws(
      () =>
        createRoutePaymentAuthorizationFromIntent(
          routeIntent({ routeCalldataHash: `0x${"00".repeat(32)}` }),
          "tenant_123",
        ),
      /calldata hash/,
    );
  });
});
