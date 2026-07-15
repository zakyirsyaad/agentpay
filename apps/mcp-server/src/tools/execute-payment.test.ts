import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Wallet } from "ethers";

import { executePayment } from "./execute-payment.ts";
import { createDirectPaymentAuthorizationFromIntent } from "../services/payment-authorization.ts";

const awaitingIntent = {
  id: "pay_123",
  accountAddress: "0x3333333333333333333333333333333333333333",
  ownerAddress: "0x2222222222222222222222222222222222222222",
  status: "AWAITING_APPROVAL" as const,
  paymentType: "WALLET_PAYMENT" as const,
  sourceChainId: 196,
  destinationChainId: 8453,
  sourceTokenAddress: "0x5555555555555555555555555555555555555555",
  sourceTokenSymbol: "USDT0",
  destinationTokenAddress: "0x6666666666666666666666666666666666666666",
  destinationTokenSymbol: "USDC",
  recipientAddress: "0x1111111111111111111111111111111111111111",
  amountOut: "10",
  maxAmountIn: "10.18",
  maxNativeFee: "0",
  routeProvider: "LI.FI" as const,
  routeTarget: "0x7777777777777777777777777777777777777777",
  routeCalldata: "0x1234",
  routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
  routeSummary: "Swap and bridge.",
  estimatedFee: "0.12",
  estimatedEtaSeconds: 120,
  nonce: "42",
  deadline: "2026-07-02T14:45:00.000Z",
  purpose: "design bounty",
  approvalPhrase: "APPROVE pay_123",
};

const directIntent = {
  ...awaitingIntent,
  id: "pay_direct",
  destinationChainId: 196,
  destinationTokenAddress: awaitingIntent.sourceTokenAddress,
  destinationTokenSymbol: "USDT0",
  amountOut: "10",
  maxAmountIn: "10",
  routeProvider: "DIRECT" as const,
  routeTarget: "0x0000000000000000000000000000000000000000",
  routeCalldata: "0x",
  routeCalldataHash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  routeSummary: "Direct 10 USDT0 transfer on X Layer.",
  estimatedFee: "0",
  estimatedEtaSeconds: 0,
  nonce: "43",
  approvalPhrase: "APPROVE pay_direct",
};

const contractCallIntent = {
  ...awaitingIntent,
  id: "pay_contract",
  paymentType: "CONTRACT_CALL" as const,
  destinationChainId: 196,
  destinationTokenAddress: awaitingIntent.sourceTokenAddress,
  destinationTokenSymbol: "USDT0",
  recipientAddress: "0x8888888888888888888888888888888888888888",
  amountOut: "7.5",
  maxAmountIn: "7.5",
  maxNativeFee: "250000000000000",
  routeProvider: "CONTRACT_CALL" as const,
  routeTarget: "0x8888888888888888888888888888888888888888",
  routeCalldata: "0xaabbccdd",
  routeCalldataHash: "0x40eed0325a12c6c6af8db2ea05450bfe21d6343b6fe955bff65045b67d9d5fe6",
  routeSummary: "Contract call to 0x8888888888888888888888888888888888888888 on X Layer.",
  estimatedFee: "0",
  estimatedEtaSeconds: 0,
  nonce: "44",
  approvalPhrase: "APPROVE pay_contract",
};

describe("executePayment", () => {
  it("executes a V2 payment only with a valid owner EIP-712 signature", async () => {
    const ownerWallet = new Wallet(`0x${"11".repeat(32)}`);
    const intent = {
      ...directIntent,
      tenantId: "tenant_123",
      ownerAddress: ownerWallet.address,
      deadline: "2026-07-02T14:45:00.000Z",
    };
    const typedData = createDirectPaymentAuthorizationFromIntent(intent, intent.tenantId);
    const signature = await ownerWallet.signTypedData(
      typedData.domain,
      typedData.types as unknown as Record<string, Array<{ name: string; type: string }>>,
      typedData.message,
    );
    const executions: unknown[] = [];
    const mutations: unknown[] = [];

    const result = await executePayment(
      { paymentIntentId: intent.id, signature },
      {
        clock: () => new Date("2026-07-02T14:40:00.000Z"),
        paymentIntents: {
          getPaymentIntent: async () => intent,
          claimPaymentApproval: async (paymentIntentId, approvedAt, tenantId) => {
            mutations.push({ type: "claim", paymentIntentId, approvedAt, tenantId });
            return true;
          },
          markPaymentExecuting: async (paymentIntentId, sourceTxHash, approvedAt, tenantId) => {
            mutations.push({ type: "executing", paymentIntentId, sourceTxHash, approvedAt, tenantId });
          },
          markPaymentFailed: async (_id, code, message) => {
            throw new Error(`${code}: ${message}`);
          },
          markPaymentExpired: async () => {
            throw new Error("should not expire");
          },
        },
        balances: {
          hasSufficientTokenBalance: async () => true,
        },
        executor: {
          executeDirectPayment: async () => {
            throw new Error("legacy executor must not be used");
          },
          executeRoutePayment: async () => {
            throw new Error("legacy executor must not be used");
          },
          executeContractCall: async () => {
            throw new Error("legacy executor must not be used");
          },
        },
        authorizedExecutor: {
          executeAuthorizedDirectPayment: async (request) => {
            executions.push(request);
            return { sourceTxHash: `0x${"aa".repeat(32)}` };
          },
          executeAuthorizedRoutePayment: async () => {
            throw new Error("should not execute route");
          },
        },
      },
    );

    assert.equal(result.sourceTxHash, `0x${"aa".repeat(32)}`);
    assert.equal(executions.length, 1);
    assert.equal((executions[0] as { authorization: { amount: string } }).authorization.amount, "10000000");
    assert.deepEqual(mutations, [
      {
        type: "claim",
        paymentIntentId: intent.id,
        approvedAt: "2026-07-02T14:40:00.000Z",
        tenantId: "tenant_123",
      },
      {
        type: "executing",
        paymentIntentId: intent.id,
        sourceTxHash: `0x${"aa".repeat(32)}`,
        approvedAt: "2026-07-02T14:40:00.000Z",
        tenantId: "tenant_123",
      },
    ]);
  });

  it("executes stored route calldata after exact approval and marks intent executing", async () => {
    const updates: unknown[] = [];
    const claims: unknown[] = [];
    const executions: unknown[] = [];

    const result = await executePayment(
      {
        paymentIntentId: "pay_123",
        approvalText: "APPROVE pay_123",
      },
      {
        clock: () => new Date("2026-07-02T14:40:00.000Z"),
        paymentIntents: {
          getPaymentIntent: async () => awaitingIntent,
          claimPaymentApproval: async (paymentIntentId, approvedAt) => {
            claims.push({ paymentIntentId, approvedAt });
            return true;
          },
          markPaymentExecuting: async (paymentIntentId, sourceTxHash, approvedAt) => {
            updates.push({ paymentIntentId, sourceTxHash, approvedAt });
          },
          markPaymentFailed: async () => {
            throw new Error("should not fail");
          },
          markPaymentExpired: async () => {
            throw new Error("should not expire");
          },
        },
        balances: {
          hasSufficientTokenBalance: async (request) => {
            assert.deepEqual(request, {
              accountAddress: awaitingIntent.accountAddress,
              chainId: 196,
              tokenAddress: awaitingIntent.sourceTokenAddress,
              tokenSymbol: "USDT0",
              requiredAmount: "10.18",
            });
            return true;
          },
        },
        executor: {
          executeDirectPayment: async () => {
            throw new Error("should not execute direct payment");
          },
          executeRoutePayment: async (request) => {
            executions.push(request);
            return { sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
          },
          executeContractCall: async () => {
            throw new Error("should not execute contract call");
          },
        },
      },
    );

    assert.deepEqual(result, {
      paymentIntentId: "pay_123",
      status: "EXECUTING",
      sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      message: "Payment execution started.",
    });
    assert.deepEqual(claims, [
      {
        paymentIntentId: "pay_123",
        approvedAt: "2026-07-02T14:40:00.000Z",
      },
    ]);
    assert.equal(executions.length, 1);
    assert.deepEqual(executions[0], {
      accountAddress: awaitingIntent.accountAddress,
      sourceChainId: 196,
      sourceTokenAddress: awaitingIntent.sourceTokenAddress,
      sourceTokenSymbol: "USDT0",
      maxAmountIn: "10.18",
      destinationChainId: 8453,
      recipientAddress: awaitingIntent.recipientAddress,
      destinationTokenSymbol: "USDC",
      amountOut: "10",
      routeTarget: awaitingIntent.routeTarget,
      routeCalldata: "0x1234",
      routeCalldataHash: awaitingIntent.routeCalldataHash,
      maxNativeFee: "0",
      nonce: "42",
      deadline: "2026-07-02T14:45:00.000Z",
    });
    assert.deepEqual(updates, [
      {
        paymentIntentId: "pay_123",
        sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        approvedAt: "2026-07-02T14:40:00.000Z",
      },
    ]);
  });

  it("executes direct payments with executeDirectPayment calldata", async () => {
    const updates: unknown[] = [];
    const executions: unknown[] = [];

    const result = await executePayment(
      {
        paymentIntentId: "pay_direct",
        approvalText: "APPROVE pay_direct",
      },
      {
        clock: () => new Date("2026-07-02T14:40:00.000Z"),
        paymentIntents: {
          getPaymentIntent: async () => directIntent,
          claimPaymentApproval: async () => true,
          markPaymentExecuting: async (paymentIntentId, sourceTxHash, approvedAt) => {
            updates.push({ paymentIntentId, sourceTxHash, approvedAt });
          },
          markPaymentFailed: async () => {
            throw new Error("should not fail");
          },
          markPaymentExpired: async () => {
            throw new Error("should not expire");
          },
        },
        balances: {
          hasSufficientTokenBalance: async (request) => {
            assert.deepEqual(request, {
              accountAddress: directIntent.accountAddress,
              chainId: 196,
              tokenAddress: directIntent.sourceTokenAddress,
              tokenSymbol: "USDT0",
              requiredAmount: "10",
            });
            return true;
          },
        },
        executor: {
          executeDirectPayment: async (request) => {
            executions.push(request);
            return { sourceTxHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" };
          },
          executeRoutePayment: async () => {
            throw new Error("should not execute route payment");
          },
          executeContractCall: async () => {
            throw new Error("should not execute contract call");
          },
        },
      },
    );

    assert.deepEqual(executions, [
      {
        accountAddress: directIntent.accountAddress,
        chainId: 196,
        tokenAddress: directIntent.sourceTokenAddress,
        tokenSymbol: "USDT0",
        recipientAddress: directIntent.recipientAddress,
        amount: "10",
        nonce: "43",
        deadline: "2026-07-02T14:45:00.000Z",
      },
    ]);
    assert.deepEqual(updates, [
      {
        paymentIntentId: "pay_direct",
        sourceTxHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        approvedAt: "2026-07-02T14:40:00.000Z",
      },
    ]);
    assert.deepEqual(result, {
      paymentIntentId: "pay_direct",
      status: "EXECUTING",
      sourceTxHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      message: "Payment execution started.",
    });
  });

  it("executes contract-call intents through executeContractCall", async () => {
    const updates: unknown[] = [];
    const executions: unknown[] = [];

    const result = await executePayment(
      {
        paymentIntentId: "pay_contract",
        approvalText: "APPROVE pay_contract",
      },
      {
        clock: () => new Date("2026-07-02T14:40:00.000Z"),
        paymentIntents: {
          getPaymentIntent: async () => contractCallIntent,
          claimPaymentApproval: async () => true,
          markPaymentExecuting: async (paymentIntentId, sourceTxHash, approvedAt) => {
            updates.push({ paymentIntentId, sourceTxHash, approvedAt });
          },
          markPaymentFailed: async () => {
            throw new Error("should not fail");
          },
          markPaymentExpired: async () => {
            throw new Error("should not expire");
          },
        },
        balances: {
          hasSufficientTokenBalance: async (request) => {
            assert.deepEqual(request, {
              accountAddress: contractCallIntent.accountAddress,
              chainId: 196,
              tokenAddress: contractCallIntent.sourceTokenAddress,
              tokenSymbol: "USDT0",
              requiredAmount: "7.5",
            });
            return true;
          },
        },
        executor: {
          executeDirectPayment: async () => {
            throw new Error("should not execute direct payment");
          },
          executeRoutePayment: async () => {
            throw new Error("should not execute route payment");
          },
          executeContractCall: async (request) => {
            executions.push(request);
            return { sourceTxHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" };
          },
        },
      },
    );

    assert.deepEqual(executions, [
      {
        accountAddress: contractCallIntent.accountAddress,
        chainId: 196,
        target: "0x8888888888888888888888888888888888888888",
        tokenAddress: contractCallIntent.sourceTokenAddress,
        tokenSymbol: "USDT0",
        maxTokenSpend: "7.5",
        callData: "0xaabbccdd",
        callDataHash: "0x40eed0325a12c6c6af8db2ea05450bfe21d6343b6fe955bff65045b67d9d5fe6",
        maxNativeFee: "250000000000000",
        nonce: "44",
        deadline: "2026-07-02T14:45:00.000Z",
      },
    ]);
    assert.deepEqual(updates, [
      {
        paymentIntentId: "pay_contract",
        sourceTxHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        approvedAt: "2026-07-02T14:40:00.000Z",
      },
    ]);
    assert.deepEqual(result, {
      paymentIntentId: "pay_contract",
      status: "EXECUTING",
      sourceTxHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      message: "Payment execution started.",
    });
  });

  it("rejects non-exact approval text before balance or execution calls", async () => {
    await assert.rejects(
      () =>
        executePayment(
          {
            paymentIntentId: "pay_123",
            approvalText: "approve pay_123",
          },
          {
            clock: () => new Date("2026-07-02T14:40:00.000Z"),
            paymentIntents: {
              getPaymentIntent: async () => awaitingIntent,
              claimPaymentApproval: async () => {
                throw new Error("should not claim approval");
              },
              markPaymentExecuting: async () => {
                throw new Error("should not update");
              },
              markPaymentFailed: async () => {
                throw new Error("should not fail");
              },
              markPaymentExpired: async () => {
                throw new Error("should not expire");
              },
            },
            balances: {
              hasSufficientTokenBalance: async () => {
                throw new Error("should not check balance");
              },
            },
            executor: {
              executeDirectPayment: async () => {
                throw new Error("should not execute");
              },
              executeRoutePayment: async () => {
                throw new Error("should not execute");
              },
              executeContractCall: async () => {
                throw new Error("should not execute");
              },
            },
          },
        ),
      /Approval text does not exactly match/,
    );
  });

  it("marks expired intents expired and does not execute", async () => {
    const expired: string[] = [];

    await assert.rejects(
      () =>
        executePayment(
          {
            paymentIntentId: "pay_123",
            approvalText: "APPROVE pay_123",
          },
          {
            clock: () => new Date("2026-07-02T14:46:00.000Z"),
            paymentIntents: {
              getPaymentIntent: async () => awaitingIntent,
              claimPaymentApproval: async () => {
                throw new Error("should not claim approval");
              },
              markPaymentExecuting: async () => {
                throw new Error("should not update");
              },
              markPaymentFailed: async () => {
                throw new Error("should not fail");
              },
              markPaymentExpired: async (paymentIntentId) => {
                expired.push(paymentIntentId);
              },
            },
            balances: {
              hasSufficientTokenBalance: async () => {
                throw new Error("should not check balance");
              },
            },
            executor: {
              executeDirectPayment: async () => {
                throw new Error("should not execute");
              },
              executeRoutePayment: async () => {
                throw new Error("should not execute");
              },
              executeContractCall: async () => {
                throw new Error("should not execute");
              },
            },
          },
        ),
      /Payment intent pay_123 expired/,
    );

    assert.deepEqual(expired, ["pay_123"]);
  });

  it("marks failed when balance is insufficient", async () => {
    const failures: unknown[] = [];

    await assert.rejects(
      () =>
        executePayment(
          {
            paymentIntentId: "pay_123",
            approvalText: "APPROVE pay_123",
          },
          {
            clock: () => new Date("2026-07-02T14:40:00.000Z"),
            paymentIntents: {
              getPaymentIntent: async () => awaitingIntent,
              claimPaymentApproval: async () => {
                throw new Error("should not claim approval");
              },
              markPaymentExecuting: async () => {
                throw new Error("should not update");
              },
              markPaymentFailed: async (paymentIntentId, errorCode, errorMessage) => {
                failures.push({ paymentIntentId, errorCode, errorMessage });
              },
              markPaymentExpired: async () => {
                throw new Error("should not expire");
              },
            },
            balances: {
              hasSufficientTokenBalance: async () => false,
            },
            executor: {
              executeDirectPayment: async () => {
                throw new Error("should not execute");
              },
              executeRoutePayment: async () => {
                throw new Error("should not execute");
              },
              executeContractCall: async () => {
                throw new Error("should not execute");
              },
            },
          },
        ),
      /Insufficient balance/,
    );

    assert.deepEqual(failures, [
      {
        paymentIntentId: "pay_123",
        errorCode: "INSUFFICIENT_BALANCE",
        errorMessage: "Insufficient balance for payment intent pay_123.",
      },
    ]);
  });

  it("does not execute when another caller already claimed the approval", async () => {
    await assert.rejects(
      () =>
        executePayment(
          {
            paymentIntentId: "pay_123",
            approvalText: "APPROVE pay_123",
          },
          {
            clock: () => new Date("2026-07-02T14:40:00.000Z"),
            paymentIntents: {
              getPaymentIntent: async () => awaitingIntent,
              claimPaymentApproval: async (paymentIntentId, approvedAt) => {
                assert.equal(paymentIntentId, "pay_123");
                assert.equal(approvedAt, "2026-07-02T14:40:00.000Z");
                return false;
              },
              markPaymentExecuting: async () => {
                throw new Error("should not mark executing");
              },
              markPaymentFailed: async () => {
                throw new Error("should not mark failed");
              },
              markPaymentExpired: async () => {
                throw new Error("should not expire");
              },
            },
            balances: {
              hasSufficientTokenBalance: async () => true,
            },
            executor: {
              executeDirectPayment: async () => {
                throw new Error("should not execute");
              },
              executeRoutePayment: async () => {
                throw new Error("should not execute");
              },
              executeContractCall: async () => {
                throw new Error("should not execute");
              },
            },
          },
        ),
      /already being executed/,
    );
  });
});
