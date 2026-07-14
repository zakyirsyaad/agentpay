import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENT_PAY_EIP712_DOMAIN_NAME,
  AGENT_PAY_EIP712_DOMAIN_VERSION,
  createDirectPaymentTypedData,
  createRoutePaymentTypedData,
  hashUtf8,
} from "./payment-authorization.ts";

const owner = "0x2222222222222222222222222222222222222222";
const account = "0x3333333333333333333333333333333333333333";
const tokenAddress = "0x5555555555555555555555555555555555555555";
const recipient = "0x1111111111111111111111111111111111111111";

describe("AgentPay EIP-712 typed data", () => {
  it("builds the canonical direct authorization envelope", () => {
    const typedData = createDirectPaymentTypedData({
      chainId: 196,
      verifyingContract: account,
      intentId: "pay_123",
      tenantId: "tenant_123",
      owner,
      account,
      token: tokenAddress,
      recipient,
      amount: "10000000",
      nonce: "42",
      deadline: "1783003500",
      purpose: "invoice payment",
    });

    assert.deepEqual(typedData.domain, {
      name: AGENT_PAY_EIP712_DOMAIN_NAME,
      version: AGENT_PAY_EIP712_DOMAIN_VERSION,
      chainId: 196,
      verifyingContract: account,
    });
    assert.equal(typedData.primaryType, "DirectPaymentAuthorization");
    assert.equal(typedData.message.intentIdHash, hashUtf8("pay_123"));
    assert.equal(typedData.message.tenantIdHash, hashUtf8("tenant_123"));
    assert.equal(typedData.message.paymentType, hashUtf8("DIRECT_PAYMENT"));
    assert.equal(typedData.message.amount, "10000000");
    assert.equal(typedData.message.nonce, "42");
    assert.equal(typedData.message.deadline, "1783003500");
    assert.equal(typedData.message.purposeHash, hashUtf8("invoice payment"));
  });

  it("binds every route limit and rejects empty tenant or route hash values", () => {
    const typedData = createRoutePaymentTypedData({
      chainId: 196,
      verifyingContract: account,
      intentId: "pay_route",
      tenantId: "tenant_123",
      owner,
      account,
      sourceToken: tokenAddress,
      maxAmountIn: "10180000",
      destinationChainId: "8453",
      destinationToken: "0x6666666666666666666666666666666666666666",
      recipient,
      minAmountOut: "10000000",
      routeTarget: "0x7777777777777777777777777777777777777777",
      routeCalldataHash: `0x${"12".repeat(32)}`,
      maxNativeFee: "250000000000000",
      nonce: "43",
      deadline: "1783003500",
      purpose: "cross-chain invoice",
    });

    assert.equal(typedData.primaryType, "RoutePaymentAuthorization");
    assert.equal(typedData.message.destinationChainId, "8453");
    assert.equal(typedData.message.minAmountOut, "10000000");
    assert.equal(typedData.message.routeCalldataHash, `0x${"12".repeat(32)}`);
    assert.throws(
      () =>
        createRoutePaymentTypedData({
          chainId: 196,
          verifyingContract: account,
          intentId: "pay_route",
          tenantId: "",
          owner,
          account,
          sourceToken: tokenAddress,
          maxAmountIn: "10180000",
          destinationChainId: "8453",
          destinationToken: "0x6666666666666666666666666666666666666666",
          recipient,
          minAmountOut: "10000000",
          routeTarget: "0x7777777777777777777777777777777777777777",
          purpose: "cross-chain invoice",
          routeCalldataHash: "0x1234",
          maxNativeFee: "250000000000000",
          nonce: "43",
          deadline: "1783003500",
        }),
      /tenantId|routeCalldataHash/,
    );
  });
});
