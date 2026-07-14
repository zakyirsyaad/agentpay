import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Wallet } from "ethers";

import type { PaymentIntentRecord, PaymentReviewHandoffRecord } from "@agentpay-ai/shared";
import { createPaymentAuthorizationFromIntent, hashPaymentAuthorization } from "../services/payment-authorization.ts";
import type { PaymentReviewRepository } from "../services/payment-review.ts";
import { getPaymentSignature } from "./payment-review.ts";

const owner = new Wallet(`0x${"a".repeat(64)}`);
const intent: PaymentIntentRecord = {
  id: "pay_signature_123",
  tenantId: "tenant_a",
  accountAddress: "0x3333333333333333333333333333333333333333",
  ownerAddress: owner.address,
  status: "AWAITING_APPROVAL",
  paymentType: "WALLET_PAYMENT",
  sourceChainId: 196,
  destinationChainId: 196,
  sourceTokenAddress: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
  sourceTokenSymbol: "USDT0",
  destinationTokenAddress: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
  destinationTokenSymbol: "USDT0",
  recipientAddress: "0x1111111111111111111111111111111111111111",
  amountOut: "1",
  maxAmountIn: "1",
  maxNativeFee: "0",
  routeProvider: "DIRECT",
  routeTarget: "0x0000000000000000000000000000000000000000",
  routeCalldata: "0x",
  routeCalldataHash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  routeSummary: "Direct payment.",
  nonce: "1",
  deadline: "2026-07-13T00:00:00.000Z",
  purpose: "signature handoff test",
  approvalPhrase: "APPROVE pay_signature_123",
};

function createDependencies(overrides: Partial<PaymentReviewHandoffRecord> = {}) {
  const authorization = createPaymentAuthorizationFromIntent(intent, intent.tenantId!);
  const handoff: PaymentReviewHandoffRecord = {
    id: "review_signature_123",
    paymentIntentId: intent.id,
    tenantId: intent.tenantId!,
    ownerAddress: intent.ownerAddress,
    accountAddress: intent.accountAddress,
    sourceChainId: intent.sourceChainId,
    authorizationHash: hashPaymentAuthorization(authorization),
    tokenDigest: "0x" + "1".repeat(64),
    status: "PENDING",
    createdAt: "2026-07-12T23:00:00.000Z",
    expiresAt: intent.deadline,
    ...overrides,
  };
  const paymentReviews: PaymentReviewRepository = {
    async createPaymentReviewHandoff() {},
    async getPaymentReviewHandoffByTokenDigest() { return handoff; },
    async getPaymentReviewHandoff() { return handoff; },
    async attachPaymentReviewSignature() { return { status: "SIGNED" as const }; },
  };
  return {
    paymentReviews,
    paymentIntents: { async getPaymentIntent() { return intent; } },
    clock: () => new Date("2026-07-12T23:30:00.000Z"),
    authorization,
    handoff,
  };
}

describe("getPaymentSignature", () => {
  it("returns a pending state without changing payment execution status", async () => {
    const fixture = createDependencies();
    const result = await getPaymentSignature({ paymentIntentId: intent.id }, fixture);

    assert.equal(result.status, "AWAITING_SIGNATURE");
    assert.equal(result.signature, undefined);
    assert.equal(intent.status, "AWAITING_APPROVAL");
  });

  it("returns a verified owner signature and rejects an invalid stored signature", async () => {
    const fixture = createDependencies();
    const signature = await owner.signTypedData(
      fixture.authorization.domain,
      fixture.authorization.types as unknown as Record<string, Array<{ name: string; type: string }>>,
      fixture.authorization.message,
    );
    fixture.handoff.status = "SIGNED";
    fixture.handoff.signature = signature;
    fixture.handoff.signedAt = "2026-07-12T23:31:00.000Z";

    const result = await getPaymentSignature({ paymentIntentId: intent.id }, fixture);
    assert.equal(result.status, "SIGNED");
    assert.equal(result.signature, signature);

    fixture.handoff.signature = await new Wallet(`0x${"b".repeat(64)}`).signTypedData(
      fixture.authorization.domain,
      fixture.authorization.types as unknown as Record<string, Array<{ name: string; type: string }>>,
      fixture.authorization.message,
    );
    await assert.rejects(
      getPaymentSignature({ paymentIntentId: intent.id }, fixture),
      /no longer valid/,
    );
  });

  it("expires at the earlier intent deadline or handoff expiry", async () => {
    const fixture = createDependencies({ expiresAt: "2026-07-12T23:29:59.000Z" });
    const result = await getPaymentSignature({ paymentIntentId: intent.id }, fixture);

    assert.equal(result.status, "EXPIRED");
    assert.equal(result.signature, undefined);
  });
});
