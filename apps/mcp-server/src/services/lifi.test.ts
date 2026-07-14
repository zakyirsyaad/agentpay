import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLifiRouteQuoteProvider, createLifiRouteStatusProvider } from "./lifi.ts";

describe("createLifiRouteQuoteProvider", () => {
  it("requests LI.FI quote and normalizes the route", async () => {
    const requests: Array<{ url: string; headers?: HeadersInit }> = [];
    const provider = createLifiRouteQuoteProvider({
      apiKey: "test-key",
      integrator: "agentpay",
      slippage: 0.005,
      fetch: async (url, init) => {
        requests.push({ url: String(url), headers: init?.headers });
        return new Response(
          JSON.stringify({
            action: {
              fromToken: {
                address: "0x5555555555555555555555555555555555555555",
                symbol: "USDT0",
                decimals: 6,
              },
              toToken: {
                address: "0x6666666666666666666666666666666666666666",
                symbol: "USDC",
                decimals: 6,
              },
              fromAmount: "10000000",
            },
            estimate: {
              fromAmount: "10200000",
              toAmount: "10170000",
              toAmountMin: "10150000",
              gasCosts: [
                {
                  amountUSD: "0.12",
                },
              ],
              executionDuration: 120,
            },
            transactionRequest: {
              to: "0x7777777777777777777777777777777777777777",
              data: "0x1234",
              value: "0",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const quote = await provider.quotePaymentRoute({
      accountAddress: "0x3333333333333333333333333333333333333333",
      ownerAddress: "0x2222222222222222222222222222222222222222",
      sourceChainId: 196,
      destinationChainId: 8453,
      sourceTokenSymbol: "USDT0",
      destinationTokenSymbol: "USDC",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountOut: "10",
      purpose: "design bounty",
    });

    assert.equal(requests.length, 1);
    const url = new URL(requests[0].url);
    assert.equal(url.origin + url.pathname, "https://li.quest/v1/quote");
    assert.equal(url.searchParams.get("fromChain"), "196");
    assert.equal(url.searchParams.get("toChain"), "8453");
    assert.equal(url.searchParams.get("fromToken"), "USDT0");
    assert.equal(url.searchParams.get("toToken"), "USDC");
    assert.equal(url.searchParams.get("fromAddress"), "0x3333333333333333333333333333333333333333");
    assert.equal(url.searchParams.get("toAddress"), "0x1111111111111111111111111111111111111111");
    assert.equal(url.searchParams.get("fromAmount"), "10200000");
    assert.equal(url.searchParams.get("slippage"), "0.005");
    assert.equal(url.searchParams.get("integrator"), "agentpay");
    assert.deepEqual(requests[0].headers, { "x-lifi-api-key": "test-key" });
    assert.equal(quote.routeProvider, "LI.FI");
    assert.equal(quote.sourceTokenAddress, "0x5555555555555555555555555555555555555555");
    assert.equal(quote.destinationTokenAddress, "0x6666666666666666666666666666666666666666");
    assert.equal(quote.maxAmountIn, "10.2");
    assert.equal(quote.nativeValue, "0");
    assert.equal(quote.minAmountOut, "10.15");
    assert.equal(quote.maxNativeFee, "0");
    assert.equal(quote.routeTarget, "0x7777777777777777777777777777777777777777");
    assert.equal(quote.routeCalldata, "0x1234");
    assert.equal(quote.routeCalldataHash, "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432");
    assert.equal(quote.estimatedFee, "0.12");
    assert.equal(quote.estimatedEtaSeconds, 120);
  });

  it("throws useful errors for LI.FI HTTP failures", async () => {
    const provider = createLifiRouteQuoteProvider({
      fetch: async () => new Response(JSON.stringify({ message: "No quote found" }), { status: 400 }),
    });

    await assert.rejects(
      () =>
        provider.quotePaymentRoute({
          accountAddress: "0x3333333333333333333333333333333333333333",
          ownerAddress: "0x2222222222222222222222222222222222222222",
          sourceChainId: 196,
          destinationChainId: 8453,
          sourceTokenSymbol: "USDT0",
          destinationTokenSymbol: "USDC",
          recipientAddress: "0x1111111111111111111111111111111111111111",
          amountOut: "10",
          purpose: "design bounty",
        }),
      /LI.FI quote failed \(400\): No quote found/,
    );
  });
});

describe("createLifiRouteStatusProvider", () => {
  it("requests LI.FI status and normalizes destination transaction details", async () => {
    const requests: Array<{ url: string; headers?: HeadersInit }> = [];
    const provider = createLifiRouteStatusProvider({
      apiKey: "test-key",
      fetch: async (url, init) => {
        requests.push({ url: String(url), headers: init?.headers });
        return new Response(
          JSON.stringify({
            status: "DONE",
            substatus: "COMPLETED",
            substatusMessage: "The transfer is complete.",
            receiving: {
              txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const status = await provider.getRouteStatus({
      txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      fromChainId: 196,
      toChainId: 8453,
    });

    assert.equal(requests.length, 1);
    const url = new URL(requests[0].url);
    assert.equal(url.origin + url.pathname, "https://li.quest/v1/status");
    assert.equal(url.searchParams.get("txHash"), "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(url.searchParams.get("fromChain"), "196");
    assert.equal(url.searchParams.get("toChain"), "8453");
    assert.deepEqual(requests[0].headers, { "x-lifi-api-key": "test-key" });
    assert.deepEqual(status, {
      status: "DONE",
      substatus: "COMPLETED",
      substatusMessage: "The transfer is complete.",
      destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  });

  it("throws useful errors for LI.FI status HTTP failures", async () => {
    const provider = createLifiRouteStatusProvider({
      fetch: async () => new Response(JSON.stringify({ message: "Bad tx hash" }), { status: 400 }),
    });

    await assert.rejects(
      () =>
        provider.getRouteStatus({
          txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          fromChainId: 196,
          toChainId: 8453,
        }),
      /LI.FI status failed \(400\): Bad tx hash/,
    );
  });
});
