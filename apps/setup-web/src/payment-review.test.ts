import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concat, hexlify, Signature, toBeHex, Wallet } from "ethers";

import {
  createPaymentAuthorizationFromIntent,
  createPaymentReviewToken,
  hashPaymentAuthorization,
  hashPaymentReviewToken,
  type PaymentReviewRepository,
} from "@agentpay-ai/mcp-server";
import type { PaymentIntentRecord, PaymentReviewHandoffRecord } from "@agentpay-ai/shared";

import {
  createPaymentReviewHandler,
  createPaymentReviewPageResponse,
  createPaymentReviewRateLimiter,
} from "./payment-review.ts";

const owner = new Wallet(`0x${"a".repeat(64)}`);
const otherOwner = new Wallet(`0x${"b".repeat(64)}`);
const accountAddress = "0x3333333333333333333333333333333333333333";
const reviewTokenSecret = "review-secret-for-tests-0123456789";
const token = createPaymentReviewToken((size) => Uint8Array.from({ length: size }, () => 7));
const intent: PaymentIntentRecord = {
  id: "pay_review_123",
  tenantId: "tenant_review",
  accountAddress,
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
  routeSummary: "Direct 1 USDT0 transfer on X Layer.",
  nonce: "7",
  deadline: "2026-07-13T00:00:00.000Z",
  purpose: "Review flow test",
  approvalPhrase: "APPROVE pay_review_123",
};

function createFixture(overrides: Partial<PaymentReviewHandoffRecord> = {}) {
  const authorization = createPaymentAuthorizationFromIntent(intent, intent.tenantId!);
  let handoff: PaymentReviewHandoffRecord = {
    id: "review_pay_review_123",
    paymentIntentId: intent.id,
    tenantId: intent.tenantId!,
    ownerAddress: intent.ownerAddress,
    accountAddress: intent.accountAddress,
    sourceChainId: intent.sourceChainId,
    authorizationHash: hashPaymentAuthorization(authorization),
    tokenDigest: hashPaymentReviewToken(token, reviewTokenSecret),
    status: "PENDING",
    createdAt: "2026-07-12T23:00:00.000Z",
    expiresAt: intent.deadline,
    ...overrides,
  };
  const paymentReviews: PaymentReviewRepository = {
    async createPaymentReviewHandoff(record) {
      handoff = record;
    },
    async getPaymentReviewHandoffByTokenDigest(digest) {
      return digest === handoff.tokenDigest ? handoff : null;
    },
    async getPaymentReviewHandoff(paymentIntentId) {
      return paymentIntentId === handoff.paymentIntentId ? handoff : null;
    },
    async attachPaymentReviewSignature(input) {
      if (handoff.status === "SIGNED") {
        return handoff.signature === input.signature
          ? { status: "ALREADY_SIGNED" as const, signature: handoff.signature }
          : { status: "CONFLICT" as const };
      }
      handoff = { ...handoff, status: "SIGNED", signature: input.signature, signedAt: input.signedAt };
      return { status: "SIGNED" as const };
    },
  };
  return {
    paymentReviews,
    paymentIntents: { async getPaymentIntent() { return intent; } },
    clock: () => new Date("2026-07-12T23:30:00.000Z"),
    reviewTokenSecret,
    authorization,
    authorizationHash: hashPaymentAuthorization(authorization),
  };
}

describe("Review & Sign page", () => {
  it("uses a strict no-store security header and never exposes a transaction method", async () => {
    const response = createPaymentReviewPageResponse();
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.match(html, /eth_signTypedData_v4/);
    assert.doesNotMatch(html, /eth_sendTransaction|personal_sign/);
    assert.doesNotMatch(html, /localStorage/);
  });
});

describe("Review & Sign request limits", () => {
  it("bounds random-token state and applies a per-client request ceiling", () => {
    const limiter = createPaymentReviewRateLimiter({
      maxEntries: 3,
      maxClientEntries: 2,
      maxRequestsPerToken: 60,
      maxRequestsPerClient: 4,
      windowMs: 60_000,
    });
    const now = new Date("2026-07-12T23:30:00.000Z");
    const tokens = Array.from({ length: 5 }, (_, index) =>
      createPaymentReviewToken((size) => Uint8Array.from({ length: size }, () => index + 1)),
    );

    assert.deepEqual(
      tokens.slice(0, 4).map((candidate) => limiter.allow(candidate, now, "client-a")),
      [true, true, true, true],
    );
    assert.equal(limiter.entryCount, 3);
    assert.equal(limiter.allow(tokens[4], now, "client-a"), false);
    assert.equal(limiter.allow(tokens[4], now, "client-b"), true);
    assert.equal(limiter.entryCount, 3);
    assert.equal(limiter.clientEntryCount, 2);
  });
});

describe("Review & Sign handoff API", () => {
  it("returns server-derived typed data and summary without the raw signature", async () => {
    const fixture = createFixture();
    const handler = createPaymentReviewHandler(fixture);
    const response = await handler(new Request("https://wallet.agentpay.site/api/payment-review", {
      headers: { "x-agentpay-review-token": token },
    }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, "PENDING");
    assert.equal(body.authorizationHash, fixture.authorizationHash);
    assert.equal(body.summary.ownerAddress, owner.address);
    assert.equal("signature" in body, false);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("accepts only the owner EIP-712 signature and makes the same signature retry idempotent", async () => {
    const fixture = createFixture();
    const handler = createPaymentReviewHandler(fixture);
    const signature = await owner.signTypedData(
      fixture.authorization.domain,
      fixture.authorization.types as unknown as Record<string, Array<{ name: string; type: string }>>,
      fixture.authorization.message,
    );

    const first = await handler(new Request("https://wallet.agentpay.site/api/payment-review", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentpay-review-token": token },
      body: JSON.stringify({ signature }),
    }));
    const second = await handler(new Request("https://wallet.agentpay.site/api/payment-review", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentpay-review-token": token },
      body: JSON.stringify({ signature }),
    }));

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).status, "SIGNED");
  });

  it("rejects a signature from another owner and a tampered typed-data payload", async () => {
    const fixture = createFixture();
    const handler = createPaymentReviewHandler(fixture);
    const wrongOwnerSignature = await otherOwner.signTypedData(
      fixture.authorization.domain,
      fixture.authorization.types as unknown as Record<string, Array<{ name: string; type: string }>>,
      fixture.authorization.message,
    );
    const wrongOwner = await handler(new Request("https://wallet.agentpay.site/api/payment-review", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentpay-review-token": token },
      body: JSON.stringify({ signature: wrongOwnerSignature }),
    }));
    assert.equal(wrongOwner.status, 400);

    const tampered = { ...fixture.authorization.message, amount: "2" };
    const tamperedSignature = await owner.signTypedData(
      fixture.authorization.domain,
      fixture.authorization.types as unknown as Record<string, Array<{ name: string; type: string }>>,
      tampered,
    );
    const tamperedResponse = await handler(new Request("https://wallet.agentpay.site/api/payment-review", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentpay-review-token": token },
      body: JSON.stringify({ signature: tamperedSignature }),
    }));
    assert.equal(tamperedResponse.status, 400);
  });

  it("rejects a malleable high-S owner signature", async () => {
    const fixture = createFixture();
    const handler = createPaymentReviewHandler(fixture);
    const signature = Signature.from(await owner.signTypedData(
      fixture.authorization.domain,
      fixture.authorization.types as unknown as Record<string, Array<{ name: string; type: string }>>,
      fixture.authorization.message,
    ));
    const curveOrder = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const highS = toBeHex(curveOrder - BigInt(signature.s), 32);
    const flippedV = toBeHex(signature.v === 27 ? 28 : 27, 1);
    const malleableSignature = hexlify(concat([signature.r, highS, flippedV]));

    const response = await handler(new Request("https://wallet.agentpay.site/api/payment-review", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentpay-review-token": token },
      body: JSON.stringify({ signature: malleableSignature }),
    }));

    assert.equal(response.status, 400);
    assert.equal((await fixture.paymentReviews.getPaymentReviewHandoff(intent.id))?.status, "PENDING");
  });

  it("returns a generic unavailable response for an expired review token", async () => {
    const fixture = createFixture({ expiresAt: "2026-07-12T23:29:59.000Z" });
    const handler = createPaymentReviewHandler(fixture);
    const response = await handler(new Request("https://wallet.agentpay.site/api/payment-review", {
      headers: { "x-agentpay-review-token": token },
    }));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Review unavailable." });
  });

  it("returns the same generic response for malformed, unknown, and secret-mismatched tokens", async () => {
    const fixture = createFixture();
    const unknownToken = createPaymentReviewToken((size) => Uint8Array.from({ length: size }, () => 8));
    const requests = [
      createPaymentReviewHandler(fixture)(new Request("https://wallet.agentpay.site/api/payment-review", {
        headers: { "x-agentpay-review-token": "not-a-review-token" },
      })),
      createPaymentReviewHandler(fixture)(new Request("https://wallet.agentpay.site/api/payment-review", {
        headers: { "x-agentpay-review-token": unknownToken },
      })),
      createPaymentReviewHandler({ ...fixture, reviewTokenSecret: "different-review-secret-012345678901" })(
        new Request("https://wallet.agentpay.site/api/payment-review", {
          headers: { "x-agentpay-review-token": token },
        }),
      ),
    ];

    for (const response of await Promise.all(requests)) {
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Review unavailable." });
    }
  });

  it("rejects oversized declared and chunked request bodies before parsing JSON", async () => {
    const fixture = createFixture();
    const handler = createPaymentReviewHandler(fixture);
    const declared = await handler(new Request("https://wallet.agentpay.site/api/payment-review", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "5000",
        "x-agentpay-review-token": token,
      },
      body: "{}",
    }));
    assert.equal(declared.status, 413);

    const chunked = await handler(new Request("https://wallet.agentpay.site/api/payment-review", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentpay-review-token": token,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(5000)));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit));
    assert.equal(chunked.status, 413);
  });

  it("turns repository failures into a generic no-store service response", async () => {
    const fixture = createFixture();
    const handler = createPaymentReviewHandler({
      ...fixture,
      paymentReviews: {
        ...fixture.paymentReviews,
        async getPaymentReviewHandoffByTokenDigest() {
          throw new Error("sensitive database failure");
        },
      },
    });

    const response = await handler(new Request("https://wallet.agentpay.site/api/payment-review", {
      headers: { "x-agentpay-review-token": token },
    }));
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.deepEqual(body, { error: "Review unavailable." });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(JSON.stringify(body), /sensitive database failure/);
  });
});
