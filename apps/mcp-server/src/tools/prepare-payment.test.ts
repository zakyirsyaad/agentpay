import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { preparePayment } from "./prepare-payment.ts";
import { hashPaymentReviewToken } from "../services/payment-review.ts";

describe("preparePayment", () => {
  it("creates an awaiting-approval payment intent and returns agent instructions", async () => {
    const saved: unknown[] = [];
    const walletReads: unknown[] = [];

    const result = await preparePayment(
      {
        recipientAddress: "0x1111111111111111111111111111111111111111",
        destinationChainId: 8453,
        destinationTokenSymbol: "USDC",
        amountOut: "10",
        purpose: "design bounty",
      },
      {
        clock: () => new Date("2026-07-02T14:30:00.000Z"),
        createId: () => "pay_123",
        createNonce: () => "42",
        approvalTtlSeconds: 900,
        wallets: {
          getActiveWallet: async (request) => {
            walletReads.push(request);
            return {
              ownerAddress: "0x2222222222222222222222222222222222222222",
              accountAddress: "0x3333333333333333333333333333333333333333",
              homeChainId: 196,
              executorAddress: "0x4444444444444444444444444444444444444444",
              status: "ACTIVE",
            };
          },
        },
        routes: {
          quotePaymentRoute: async () => ({
            routeProvider: "LI.FI",
            sourceTokenAddress: "0x5555555555555555555555555555555555555555",
            destinationTokenAddress: "0x6666666666666666666666666666666666666666",
            maxAmountIn: "10.18",
            maxNativeFee: "2500000000000000",
            nativeValue: "2000000000000000",
            minAmountOut: "9.95",
            routeTarget: "0x7777777777777777777777777777777777777777",
            routeCalldata: "0x1234",
            routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
            routeSummary: "Swap USDT0 on X Layer, bridge, and pay USDC on Base.",
            estimatedFee: "0.12",
            estimatedEtaSeconds: 120,
          }),
        },
        paymentIntents: {
          createPaymentIntent: async (intent) => {
            saved.push(intent);
          },
        },
        balances: {
          hasSufficientTokenBalance: async (request) => {
            assert.deepEqual(request, {
              accountAddress: "0x3333333333333333333333333333333333333333",
              chainId: 196,
              tokenAddress: "0x5555555555555555555555555555555555555555",
              tokenSymbol: "USDT0",
              requiredAmount: "10.18",
            });
            return true;
          },
        },
      },
    );

    assert.deepEqual(walletReads, [{ homeChainId: 196 }]);
    assert.equal(result.paymentIntentId, "pay_123");
    assert.equal(result.status, "AWAITING_APPROVAL");
    assert.equal(result.approvalPhrase, "APPROVE pay_123");
    assert.equal(result.summary.destinationChain, "Base");
    assert.equal(result.summary.maxNativeFee, "2500000000000000");
    assert.equal(result.summary.maxNativeFeeDisplay, "0.0025 OKB");
    assert.equal(result.summary.deadline, "2026-07-02T14:35:00.000Z");
    assert.equal(result.summary.minAmountOut, "9.95");
    assert.equal(result.summary.nativeValue, "2000000000000000");
    assert.equal(result.summary.routeTarget, "0x7777777777777777777777777777777777777777");
    assert.equal(result.summary.routeCalldataHash, "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432");
    assert.equal(result.summary.requiresRouteTargetAllowlist, true);
    assert.match(result.instructionToAgent, /reply exactly:\nAPPROVE pay_123/);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0], {
      id: "pay_123",
      accountAddress: "0x3333333333333333333333333333333333333333",
      ownerAddress: "0x2222222222222222222222222222222222222222",
      status: "AWAITING_APPROVAL",
      paymentType: "WALLET_PAYMENT",
      sourceChainId: 196,
      destinationChainId: 8453,
      sourceTokenAddress: "0x5555555555555555555555555555555555555555",
      sourceTokenSymbol: "USDT0",
      destinationTokenAddress: "0x6666666666666666666666666666666666666666",
      destinationTokenSymbol: "USDC",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountOut: "10",
      minAmountOut: "9.95",
      maxAmountIn: "10.18",
      maxNativeFee: "2500000000000000",
      nativeValue: "2000000000000000",
      routeProvider: "LI.FI",
      routeTarget: "0x7777777777777777777777777777777777777777",
      routeCalldata: "0x1234",
      routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
      routeSummary: "Swap USDT0 on X Layer, bridge, and pay USDC on Base.",
      estimatedFee: "0.12",
      estimatedEtaSeconds: 120,
      nonce: "42",
      deadline: "2026-07-02T14:35:00.000Z",
      purpose: "design bounty",
      approvalPhrase: "APPROVE pay_123",
    });
  });

  it("creates a direct payment intent without requesting a LI.FI route", async () => {
    const saved: unknown[] = [];

    const result = await preparePayment(
      {
        recipientAddress: "0x1111111111111111111111111111111111111111",
        destinationChainId: 196,
        destinationTokenSymbol: "USDT0",
        amountOut: "10",
        purpose: "same-chain payout",
        sourceTokenSymbol: "USDT0",
      },
      {
        clock: () => new Date("2026-07-02T14:30:00.000Z"),
        createId: () => "pay_direct",
        createNonce: () => "43",
        approvalTtlSeconds: 900,
        wallets: {
          getActiveWallet: async () => ({
            ownerAddress: "0x2222222222222222222222222222222222222222",
            accountAddress: "0x3333333333333333333333333333333333333333",
            homeChainId: 196,
            executorAddress: "0x4444444444444444444444444444444444444444",
            status: "ACTIVE",
          }),
        },
        routes: {
          quotePaymentRoute: async () => {
            throw new Error("should not call LI.FI for direct payments");
          },
        },
        paymentIntents: {
          createPaymentIntent: async (intent) => {
            saved.push(intent);
          },
        },
        balances: {
          hasSufficientTokenBalance: async (request) => {
            assert.deepEqual(request, {
              accountAddress: "0x3333333333333333333333333333333333333333",
              chainId: 196,
              tokenAddress: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
              tokenSymbol: "USDT0",
              requiredAmount: "10",
            });
            return true;
          },
        },
      },
    );

    assert.equal(result.summary.routeProvider, "DIRECT");
    assert.equal(result.summary.sourceSpend, "10 USDT0");
    assert.equal(result.summary.maxNativeFeeDisplay, "0 OKB");
    assert.equal(result.summary.routeTarget, "0x0000000000000000000000000000000000000000");
    assert.equal(result.summary.routeCalldataHash, "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    assert.equal(result.summary.requiresRouteTargetAllowlist, false);
    assert.equal(result.summary.routeSummary, "Direct 10 USDT0 transfer on X Layer.");
    assert.deepEqual(saved[0], {
      id: "pay_direct",
      accountAddress: "0x3333333333333333333333333333333333333333",
      ownerAddress: "0x2222222222222222222222222222222222222222",
      status: "AWAITING_APPROVAL",
      paymentType: "WALLET_PAYMENT",
      sourceChainId: 196,
      destinationChainId: 196,
      sourceTokenAddress: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      sourceTokenSymbol: "USDT0",
      destinationTokenAddress: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      destinationTokenSymbol: "USDT0",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountOut: "10",
      maxAmountIn: "10",
      maxNativeFee: "0",
      routeProvider: "DIRECT",
      routeTarget: "0x0000000000000000000000000000000000000000",
      routeCalldata: "0x",
      routeCalldataHash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
      routeSummary: "Direct 10 USDT0 transfer on X Layer.",
      estimatedFee: "0",
      estimatedEtaSeconds: 0,
      nonce: "43",
      deadline: "2026-07-02T14:45:00.000Z",
      purpose: "same-chain payout",
      approvalPhrase: "APPROVE pay_direct",
    });
  });

  it("returns canonical owner typed data for a trusted tenant session", async () => {
    const result = await preparePayment(
      {
        recipientAddress: "0x1111111111111111111111111111111111111111",
        destinationChainId: 196,
        destinationTokenSymbol: "USDT0",
        amountOut: "1",
        purpose: "tenant review",
      },
      {
        tenantId: "tenant_123",
        clock: () => new Date("2026-07-02T14:30:00.000Z"),
        createId: () => "pay_signed",
        createNonce: () => "99",
        wallets: {
          getActiveWallet: async () => ({
            tenantId: "tenant_123",
            ownerAddress: "0x2222222222222222222222222222222222222222",
            accountAddress: "0x3333333333333333333333333333333333333333",
            homeChainId: 196,
            executorAddress: "0x4444444444444444444444444444444444444444",
            status: "ACTIVE",
          }),
        },
        routes: {
          quotePaymentRoute: async () => {
            throw new Error("direct route should not call LI.FI");
          },
        },
        balances: {
          hasSufficientTokenBalance: async () => true,
        },
        paymentIntents: {
          createPaymentIntent: async () => undefined,
        },
      },
    );

    assert.equal(result.authorization?.primaryType, "DirectPaymentAuthorization");
    assert.equal((result.authorization?.message as { amount?: string } | undefined)?.amount, "1000000");
    assert.equal(result.authorizationHash?.length, 66);
    assert.match(result.instructionToAgent, /Review & Sign/);
    assert.doesNotMatch(result.instructionToAgent, /APPROVE pay_signed/);
  });

  it("creates a durable Review & Sign URL only for a configured tenant handoff", async () => {
    const handoffs: unknown[] = [];
    const reviewToken = `apr_${"a".repeat(43)}`;
    const result = await preparePayment(
      {
        recipientAddress: "0x1111111111111111111111111111111111111111",
        destinationChainId: 196,
        destinationTokenSymbol: "USDT0",
        amountOut: "1",
        purpose: "review handoff",
      },
      {
        tenantId: "tenant_123",
        setupWebUrl: "https://wallet.agentpay.site/setup",
        reviewTokenSecret: "review-secret-012345678901234567890123",
        createReviewToken: () => reviewToken,
        clock: () => new Date("2026-07-02T14:30:00.000Z"),
        createId: () => "pay_review",
        createNonce: () => "100",
        wallets: {
          getActiveWallet: async () => ({
            tenantId: "tenant_123",
            ownerAddress: "0x2222222222222222222222222222222222222222",
            accountAddress: "0x3333333333333333333333333333333333333333",
            homeChainId: 196,
            executorAddress: "0x4444444444444444444444444444444444444444",
            status: "ACTIVE",
          }),
        },
        routes: { quotePaymentRoute: async () => { throw new Error("direct route should not call LI.FI"); } },
        balances: { hasSufficientTokenBalance: async () => true },
        paymentIntents: { createPaymentIntent: async () => undefined },
        paymentReviews: {
          async createPaymentReviewHandoff(record) { handoffs.push(record); },
          async getPaymentReviewHandoffByTokenDigest() { return null; },
          async getPaymentReviewHandoff() { return null; },
          async attachPaymentReviewSignature() { return { status: "CONFLICT" as const }; },
        },
      },
    );

    assert.match(result.reviewUrl ?? "", /^https:\/\/wallet\.agentpay\.site\/review#review_token=/);
    assert.match(result.instructionToAgent, /get_payment_signature/);
    assert.equal(handoffs.length, 1);
    assert.equal((handoffs[0] as { tokenDigest: string }).tokenDigest, hashPaymentReviewToken(reviewToken, "review-secret-012345678901234567890123"));
  });

  it("persists parser-provided invoice and x402 payment types for audit history", async () => {
    const saved: unknown[] = [];

    await preparePayment(
      {
        recipientAddress: "0x1111111111111111111111111111111111111111",
        destinationChainId: 196,
        destinationTokenSymbol: "USDT0",
        amountOut: "10",
        purpose: "Invoice inv_123",
        sourceTokenSymbol: "USDT0",
        paymentType: "INVOICE_PAYMENT",
      },
      {
        clock: () => new Date("2026-07-02T14:30:00.000Z"),
        createId: () => "pay_invoice",
        createNonce: () => "44",
        wallets: {
          getActiveWallet: async () => ({
            ownerAddress: "0x2222222222222222222222222222222222222222",
            accountAddress: "0x3333333333333333333333333333333333333333",
            homeChainId: 196,
            executorAddress: "0x4444444444444444444444444444444444444444",
            status: "ACTIVE",
          }),
        },
        routes: {
          quotePaymentRoute: async () => {
            throw new Error("should not call LI.FI for direct payments");
          },
        },
        paymentIntents: {
          createPaymentIntent: async (intent) => {
            saved.push(intent);
          },
        },
        balances: {
          hasSufficientTokenBalance: async () => true,
        },
      },
    );

    await preparePayment(
      {
        recipientAddress: "0x1111111111111111111111111111111111111111",
        destinationChainId: 196,
        destinationTokenSymbol: "USDT0",
        amountOut: "0.01",
        purpose: "x402 payment for Market API",
        sourceTokenSymbol: "USDT0",
        paymentType: "X402_PAYMENT",
      },
      {
        clock: () => new Date("2026-07-02T14:30:00.000Z"),
        createId: () => "pay_x402",
        createNonce: () => "45",
        wallets: {
          getActiveWallet: async () => ({
            ownerAddress: "0x2222222222222222222222222222222222222222",
            accountAddress: "0x3333333333333333333333333333333333333333",
            homeChainId: 196,
            executorAddress: "0x4444444444444444444444444444444444444444",
            status: "ACTIVE",
          }),
        },
        routes: {
          quotePaymentRoute: async () => {
            throw new Error("should not call LI.FI for direct payments");
          },
        },
        paymentIntents: {
          createPaymentIntent: async (intent) => {
            saved.push(intent);
          },
        },
        balances: {
          hasSufficientTokenBalance: async () => true,
        },
      },
    );

    assert.deepEqual(
      saved.map((intent) => (intent as { paymentType: string }).paymentType),
      ["INVOICE_PAYMENT", "X402_PAYMENT"],
    );
  });

  it("rejects invalid payment amounts before calling dependencies", async () => {
    await assert.rejects(
      () =>
        preparePayment(
          {
            recipientAddress: "0x1111111111111111111111111111111111111111",
            destinationChainId: 8453,
            destinationTokenSymbol: "USDC",
            amountOut: "0",
            purpose: "design bounty",
          },
          {
            clock: () => new Date(),
            createId: () => "pay_123",
            createNonce: () => "42",
            wallets: {
              getActiveWallet: async () => {
                throw new Error("should not be called");
              },
            },
            routes: {
              quotePaymentRoute: async () => {
                throw new Error("should not be called");
              },
            },
            paymentIntents: {
              createPaymentIntent: async () => {
                throw new Error("should not be called");
              },
            },
            balances: {
              hasSufficientTokenBalance: async () => {
                throw new Error("should not be called");
              },
            },
          },
        ),
      /amountOut/,
    );
  });

  it("rejects insufficient source balance before creating an approval intent", async () => {
    const saved: unknown[] = [];

    await assert.rejects(
      () =>
        preparePayment(
          {
            recipientAddress: "0x1111111111111111111111111111111111111111",
            destinationChainId: 8453,
            destinationTokenSymbol: "USDC",
            amountOut: "10",
            purpose: "design bounty",
          },
          {
            clock: () => new Date("2026-07-02T14:30:00.000Z"),
            createId: () => {
              throw new Error("should not create approval id");
            },
            createNonce: () => {
              throw new Error("should not create nonce");
            },
            wallets: {
              getActiveWallet: async () => ({
                ownerAddress: "0x2222222222222222222222222222222222222222",
                accountAddress: "0x3333333333333333333333333333333333333333",
                homeChainId: 196,
                executorAddress: "0x4444444444444444444444444444444444444444",
                status: "ACTIVE",
              }),
            },
            routes: {
              quotePaymentRoute: async () => ({
                routeProvider: "LI.FI",
                sourceTokenAddress: "0x5555555555555555555555555555555555555555",
                destinationTokenAddress: "0x6666666666666666666666666666666666666666",
                maxAmountIn: "10.18",
                maxNativeFee: "0",
                routeTarget: "0x7777777777777777777777777777777777777777",
                routeCalldata: "0x1234",
                routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
                routeSummary: "Swap USDT0 on X Layer, bridge, and pay USDC on Base.",
                estimatedFee: "0.12",
                estimatedEtaSeconds: 120,
              }),
            },
            paymentIntents: {
              createPaymentIntent: async (intent) => {
                saved.push(intent);
              },
            },
            balances: {
              hasSufficientTokenBalance: async () => false,
            },
          },
        ),
      /Insufficient AgentPay USDT0 balance/,
    );

    assert.deepEqual(saved, []);
  });
});
