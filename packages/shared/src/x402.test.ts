import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createAgentPayX402PaymentHeader,
  decodeAgentPayX402PaymentHeader,
  parseX402PaymentRequired,
} from "./x402.ts";

const basePaymentRequired = {
  x402Version: 2,
  error: "PAYMENT-SIGNATURE header is required",
  resource: {
    url: "https://api.example.com/premium-data",
    description: "Premium market data",
    serviceName: "Market API",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "10000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 60,
      extra: {
        name: "USDC",
        version: "2",
      },
    },
  ],
  extensions: {},
};

const paymentIdentifierExtension = {
  "payment-identifier": {
    info: {
      required: false,
    },
    schema: {
      type: "object",
      properties: {
        required: { type: "boolean" },
        id: { type: "string" },
      },
    },
  },
};

describe("parseX402PaymentRequired", () => {
  it("decodes a v2 PAYMENT-REQUIRED header into prepare_payment fields", () => {
    const paymentRequired = Buffer.from(JSON.stringify(basePaymentRequired), "utf8").toString("base64");

    const parsed = parseX402PaymentRequired({ paymentRequired });

    assert.deepEqual(parsed, {
      x402Version: 2,
      resource: {
        url: "https://api.example.com/premium-data",
        description: "Premium market data",
        serviceName: "Market API",
        mimeType: "application/json",
      },
      selectedRequirement: {
        scheme: "exact",
        network: "eip155:8453",
        chainId: 8453,
        chain: "Base",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tokenSymbol: "USDC",
        payTo: "0x1111111111111111111111111111111111111111",
        amountAtomic: "10000",
        amount: "0.01",
        maxTimeoutSeconds: 60,
      },
      paymentInput: {
        recipientAddress: "0x1111111111111111111111111111111111111111",
        destinationChainId: 8453,
        destinationChain: "Base",
        destinationTokenSymbol: "USDC",
        amountOut: "0.01",
        purpose: "x402 payment for Market API: Premium market data",
        sourceTokenSymbol: "USDT0",
        paymentType: "X402_PAYMENT",
      },
      standardX402SignatureRequired: true,
    });
  });

  it("skips unsupported requirements and uses an explicit source token", () => {
    const parsed = parseX402PaymentRequired({
      sourceTokenSymbol: "USDC",
      paymentRequired: JSON.stringify({
        ...basePaymentRequired,
        accepts: [
          {
            scheme: "upto",
            network: "eip155:8453",
            amount: "10000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x1111111111111111111111111111111111111111",
            maxTimeoutSeconds: 60,
          },
          {
            scheme: "exact",
            network: "eip155:196",
            amount: "2500000",
            asset: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
            payTo: "0x1111111111111111111111111111111111111111",
            maxTimeoutSeconds: 60,
          },
        ],
      }),
    });

    assert.equal(parsed.selectedRequirement.chainId, 196);
    assert.equal(parsed.selectedRequirement.tokenSymbol, "USDT0");
    assert.equal(parsed.selectedRequirement.amount, "2.5");
    assert.equal(parsed.paymentInput.sourceTokenSymbol, "USDC");
    assert.equal(parsed.paymentInput.paymentType, "X402_PAYMENT");
  });

  it("rejects payment requirements with no AgentPay-supported stablecoin target", () => {
    assert.throws(
      () =>
        parseX402PaymentRequired({
          paymentRequired: JSON.stringify({
            ...basePaymentRequired,
            accepts: [
              {
                scheme: "exact",
                network: "eip155:1",
                amount: "10000",
                asset: "0x0000000000000000000000000000000000000001",
                payTo: "0x1111111111111111111111111111111111111111",
                maxTimeoutSeconds: 60,
              },
            ],
          }),
        }),
      /No AgentPay-supported x402 payment requirement/,
    );
  });
});

describe("AgentPay x402 payment proof", () => {
  it("builds a base64url payment header bound to the x402 requirement and completed payment intent", () => {
    const parsed = parseX402PaymentRequired({ paymentRequired: basePaymentRequired });
    const header = createAgentPayX402PaymentHeader({
      parsed,
      paymentIntent: {
        id: "pay_x402",
        accountAddress: "0x3333333333333333333333333333333333333333",
        ownerAddress: "0x2222222222222222222222222222222222222222",
        status: "COMPLETED",
        paymentType: "X402_PAYMENT",
        sourceChainId: 196,
        destinationChainId: 8453,
        sourceTokenAddress: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
        sourceTokenSymbol: "USDT0",
        destinationTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        destinationTokenSymbol: "USDC",
        recipientAddress: "0x1111111111111111111111111111111111111111",
        amountOut: "0.01",
        maxAmountIn: "0.011",
        maxNativeFee: "0",
        routeProvider: "LI.FI",
        routeTarget: "0x7777777777777777777777777777777777777777",
        routeCalldata: "0x1234",
        routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
        routeSummary: "Route to Base.",
        nonce: "42",
        deadline: "2026-07-03T12:15:00.000Z",
        purpose: "x402 payment for Market API: Premium market data",
        approvalPhrase: "APPROVE pay_x402",
        sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        createdAt: "2026-07-03T12:00:00.000Z",
        completedAt: "2026-07-03T12:02:00.000Z",
      },
    });

    assert.match(header, /^[A-Za-z0-9_-]+$/);

    const proof = decodeAgentPayX402PaymentHeader(header);

    assert.deepEqual(proof, {
      x402Version: 2,
      scheme: "agentpay-receipt",
      paymentIntentId: "pay_x402",
      paymentType: "X402_PAYMENT",
      payer: "0x3333333333333333333333333333333333333333",
      ownerAddress: "0x2222222222222222222222222222222222222222",
      resourceUrl: "https://api.example.com/premium-data",
      requirementHash: "0x0260ff6a15b8cc9ef626637064b8ef9ca5a3d8c00200f8700edf41ff04f2fe11",
      network: "eip155:8453",
      chainId: 8453,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "10000",
      amountDecimal: "0.01",
      sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      settlementTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      completedAt: "2026-07-03T12:02:00.000Z",
    });
  });

  it("adds the payment-identifier extension when the x402 server advertises idempotency support", () => {
    const parsed = parseX402PaymentRequired({
      paymentRequired: {
        ...basePaymentRequired,
        extensions: paymentIdentifierExtension,
      },
    });
    const paymentIntentId = "pay_7d5d747be160e280504c099d984bcfe0";
    const header = createAgentPayX402PaymentHeader({
      parsed,
      paymentIntent: {
        id: paymentIntentId,
        accountAddress: "0x3333333333333333333333333333333333333333",
        ownerAddress: "0x2222222222222222222222222222222222222222",
        status: "COMPLETED",
        paymentType: "X402_PAYMENT",
        sourceChainId: 196,
        destinationChainId: 8453,
        sourceTokenAddress: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
        sourceTokenSymbol: "USDT0",
        destinationTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        destinationTokenSymbol: "USDC",
        recipientAddress: "0x1111111111111111111111111111111111111111",
        amountOut: "0.01",
        maxAmountIn: "0.011",
        maxNativeFee: "0",
        routeProvider: "LI.FI",
        routeTarget: "0x7777777777777777777777777777777777777777",
        routeCalldata: "0x1234",
        routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
        routeSummary: "Route to Base.",
        nonce: "42",
        deadline: "2026-07-03T12:15:00.000Z",
        purpose: "x402 payment for Market API: Premium market data",
        approvalPhrase: "APPROVE pay_7d5d747be160e280504c099d984bcfe0",
        sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        createdAt: "2026-07-03T12:00:00.000Z",
        completedAt: "2026-07-03T12:02:00.000Z",
      },
    });

    const proof = decodeAgentPayX402PaymentHeader(header);

    assert.equal(proof.paymentIdentifier, paymentIntentId);
    assert.deepEqual(proof.extensions, {
      "payment-identifier": {
        info: {
          required: false,
          id: paymentIntentId,
        },
      },
    });
  });

  it("rejects proof generation for incomplete or mismatched payment intents", () => {
    const parsed = parseX402PaymentRequired({ paymentRequired: basePaymentRequired });
    const completedIntent = {
      id: "pay_x402",
      accountAddress: "0x3333333333333333333333333333333333333333",
      ownerAddress: "0x2222222222222222222222222222222222222222",
      status: "COMPLETED" as const,
      paymentType: "X402_PAYMENT" as const,
      sourceChainId: 196,
      destinationChainId: 8453,
      sourceTokenAddress: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      sourceTokenSymbol: "USDT0",
      destinationTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      destinationTokenSymbol: "USDC",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountOut: "0.01",
      maxAmountIn: "0.011",
      maxNativeFee: "0",
      routeProvider: "LI.FI" as const,
      routeTarget: "0x7777777777777777777777777777777777777777",
      routeCalldata: "0x1234",
      routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
      routeSummary: "Route to Base.",
      nonce: "42",
      deadline: "2026-07-03T12:15:00.000Z",
      purpose: "x402 payment for Market API: Premium market data",
      approvalPhrase: "APPROVE pay_x402",
      sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };

    assert.throws(
      () =>
        createAgentPayX402PaymentHeader({
          parsed,
          paymentIntent: { ...completedIntent, status: "EXECUTING" },
        }),
      /must be COMPLETED/,
    );

    assert.throws(
      () =>
        createAgentPayX402PaymentHeader({
          parsed,
          paymentIntent: { ...completedIntent, recipientAddress: "0x9999999999999999999999999999999999999999" },
        }),
      /does not match the x402 requirement/,
    );
  });
});
