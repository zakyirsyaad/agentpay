import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDirectPaymentRouteQuote } from "@agentpay-ai/shared";
import { MAINNET_USDT0_ADDRESS } from "./production-readiness.ts";
import { assertCanaryRequestAllowed, createCanaryUsageStore, DEFAULT_CANARY_CAPS } from "./paid-execution-canary.ts";

const intent = {
  id: "pay_canary",
  tenantId: "tenant_1",
  accountAddress: "0x2222222222222222222222222222222222222222",
  ownerAddress: "0x1111111111111111111111111111111111111111",
  status: "AWAITING_APPROVAL" as const,
  paymentType: "WALLET_PAYMENT" as const,
  sourceChainId: 196,
  destinationChainId: 196,
  sourceTokenSymbol: "USDT0",
  destinationTokenSymbol: "USDT0",
  recipientAddress: "0x3333333333333333333333333333333333333333",
  amountOut: "0.10",
  minAmountOut: "0.10",
  nativeValue: "0",
  ...createDirectPaymentRouteQuote({ chainId: 196, tokenSymbol: "USDT0", amountOut: "0.10" }),
  sourceTokenAddress: MAINNET_USDT0_ADDRESS,
  destinationTokenAddress: MAINNET_USDT0_ADDRESS,
  maxAmountIn: "0.10",
  maxNativeFee: "0",
  nonce: "1",
  deadline: "2026-07-14T00:00:00.000Z",
  purpose: "canary",
  approvalPhrase: "APPROVE pay_canary",
};

const allowlist = {
  tenantId: "tenant_1",
  ownerAddress: intent.ownerAddress,
  accountAddress: intent.accountAddress,
  payerAddress: "0x4444444444444444444444444444444444444444",
  recipientAddress: intent.recipientAddress,
};

describe("mainnet canary caps", () => {
  it("allows exactly the first bounded direct payment and auto-stops the second", () => {
    const usage = createCanaryUsageStore();
    assertCanaryRequestAllowed(intent, allowlist, usage.snapshot(), allowlist.payerAddress, DEFAULT_CANARY_CAPS, new Date("2026-07-13T00:00:00.000Z"));
    usage.accept(intent.amountOut);
    assert.throws(() => assertCanaryRequestAllowed(intent, allowlist, usage.snapshot(), allowlist.payerAddress, DEFAULT_CANARY_CAPS, new Date("2026-07-13T00:00:00.000Z")), /auto-stopped/i);
  });

  it("rejects non-USDT0, cross-chain, and over-cap intents before a challenge", () => {
    const usage = createCanaryUsageStore();
    const now = new Date("2026-07-13T00:00:00.000Z");
    assert.throws(() => assertCanaryRequestAllowed({ ...intent, destinationChainId: 1 }, allowlist, usage.snapshot(), allowlist.payerAddress, DEFAULT_CANARY_CAPS, now), /direct chain-196/i);
    assert.throws(() => assertCanaryRequestAllowed({ ...intent, sourceTokenAddress: "0x5555555555555555555555555555555555555555" }, allowlist, usage.snapshot(), allowlist.payerAddress, DEFAULT_CANARY_CAPS, now), /USDT0/i);
    assert.throws(() => assertCanaryRequestAllowed({ ...intent, amountOut: "0.100001" }, allowlist, usage.snapshot(), allowlist.payerAddress, DEFAULT_CANARY_CAPS, now), /cap/i);
    assert.equal(DEFAULT_CANARY_CAPS.maxAcceptedLifecycles, 1);
  });

  it("makes a repeated lifecycle reservation idempotent", () => {
    const usage = createCanaryUsageStore();
    const first = usage.reserve("lifecycle_1", "tenant_1", intent.amountOut);
    const replay = usage.reserve("lifecycle_1", "tenant_1", intent.amountOut);
    assert.deepEqual(replay, first);
    assert.throws(() => usage.reserve("lifecycle_2", "tenant_1", intent.amountOut), /OFF|cap/i);
    usage.complete("lifecycle_1");
    assert.equal(usage.snapshot().tenantInFlight, 0);
  });
});
