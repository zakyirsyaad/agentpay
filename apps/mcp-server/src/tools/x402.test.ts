import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseX402PaymentRequiredForAgent, retryX402Request } from "./x402.ts";

const completedX402Intent = {
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
  createdAt: "2026-07-03T12:00:00.000Z",
  completedAt: "2026-07-03T12:02:00.000Z",
};

describe("parseX402PaymentRequiredForAgent", () => {
  it("returns normalized payment fields and x402 protocol details", async () => {
    const paymentRequired = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        resource: {
          url: "https://api.example.com/premium-data",
          description: "Premium market data",
          serviceName: "Market API",
        },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "10000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x1111111111111111111111111111111111111111",
            maxTimeoutSeconds: 60,
          },
        ],
      }),
      "utf8",
    ).toString("base64");

    const output = await parseX402PaymentRequiredForAgent({ paymentRequired });

    assert.deepEqual(output, {
      status: "PARSED",
      x402Version: 2,
      resource: {
        url: "https://api.example.com/premium-data",
        description: "Premium market data",
        serviceName: "Market API",
        mimeType: undefined,
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
      instructionToAgent:
        "Review the x402 requirement with the user. Prepare payment with paymentInput, preserve paymentType: X402_PAYMENT, execute only after exact approval, track until COMPLETED, then call retry_x402_request with the original PAYMENT-REQUIRED response and paymentIntentId.",
    });
  });
});

describe("retryX402Request", () => {
  it("retries the protected resource with AgentPay x402 proof headers after payment completion", async () => {
    const paymentRequired = {
      x402Version: 2,
      resource: {
        url: "https://api.example.com/premium-data",
        description: "Premium market data",
        serviceName: "Market API",
      },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "10000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 60,
        },
      ],
    };
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];

    const output = await retryX402Request(
      {
        paymentRequired,
        paymentIntentId: "pay_x402",
        request: {
          headers: {
            Accept: "application/json",
          },
        },
      },
      {
        paymentIntents: {
          async getPaymentIntent(paymentIntentId) {
            assert.equal(paymentIntentId, "pay_x402");
            return completedX402Intent;
          },
        },
        async fetch(url, init) {
          fetchCalls.push({ url: String(url), init: init ?? {} });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "payment-response": "settled-v2",
              "x-payment-response": "settled-legacy",
            },
          });
        },
      },
    );

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.url, "https://api.example.com/premium-data");
    assert.equal(fetchCalls[0]?.init.method, "GET");
    assert.equal((fetchCalls[0]?.init.headers as Record<string, string>)["X-PAYMENT"], output.paymentHeader);
    assert.equal((fetchCalls[0]?.init.headers as Record<string, string>)["PAYMENT-SIGNATURE"], output.paymentHeader);
    assert.equal(
      (fetchCalls[0]?.init.headers as Record<string, string>)["Access-Control-Expose-Headers"],
      "PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
    );
    assert.equal(output.status, "RESOURCE_FETCHED");
    assert.equal(output.httpStatus, 200);
    assert.equal(output.paymentResponse, "settled-v2");
    assert.equal(output.bodyText, "{\"ok\":true}");
    assert.match(output.instructionToAgent, /retry succeeded/i);
  });

  it("refuses to retry when the AgentPay payment is not completed", async () => {
    await assert.rejects(
      () =>
        retryX402Request(
          {
            paymentRequired: {
              x402Version: 2,
              resource: {
                url: "https://api.example.com/premium-data",
              },
              accepts: [
                {
                  scheme: "exact",
                  network: "eip155:8453",
                  amount: "10000",
                  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                  payTo: "0x1111111111111111111111111111111111111111",
                  maxTimeoutSeconds: 60,
                },
              ],
            },
            paymentIntentId: "pay_x402",
          },
          {
            paymentIntents: {
              async getPaymentIntent() {
                return {
                  ...completedX402Intent,
                  status: "EXECUTING",
                };
              },
            },
            async fetch() {
              throw new Error("fetch should not be called.");
            },
          },
        ),
      /must be COMPLETED/,
    );
  });
});
