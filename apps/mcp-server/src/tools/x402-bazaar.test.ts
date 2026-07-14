import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  prepareX402ServiceRequestForAgent,
  searchX402Services,
  type X402BazaarDiscoveryProvider,
} from "./x402-bazaar.ts";

const bazaarResource = {
  resource: "https://api.market.example.com/prices",
  type: "http" as const,
  x402Version: 2 as const,
  serviceName: "Market Bazaar",
  description: "Paid market prices",
  tags: ["markets", "okx"],
  lastUpdated: "2026-07-05T08:00:00.000Z",
  accepts: [
    {
      scheme: "exact",
      network: "eip155:196",
      amount: "250000",
      asset: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 60,
    },
  ],
  extensions: {
    bazaar: {
      info: {
        input: {
          type: "http",
          method: "GET",
          queryParams: {
            symbol: "BTC-USDT",
          },
        },
      },
    },
  },
};

describe("searchX402Services", () => {
  it("returns agent-friendly Bazaar search results", async () => {
    const calls: unknown[] = [];
    const discovery: X402BazaarDiscoveryProvider = {
      async search(request) {
        calls.push(request);
        return {
          resources: [bazaarResource],
          nextCursor: "next-cursor",
          partialResults: true,
};
      },
    };

    const output = await searchX402Services(
      {
        query: "market data for btc",
        network: "eip155:196",
        limit: 3,
      },
      { discovery },
    );

    assert.deepEqual(calls, [
      {
        query: "market data for btc",
        type: "http",
        network: "eip155:196",
        limit: 3,
      },
    ]);
    assert.equal(output.status, "FOUND");
    assert.equal(output.results.length, 1);
    assert.equal(output.results[0]?.resourceUrl, "https://api.market.example.com/prices");
    assert.equal(output.results[0]?.serviceName, "Market Bazaar");
    assert.equal(output.results[0]?.method, "GET");
    assert.deepEqual(output.results[0]?.requiredParameters, ["symbol"]);
    assert.equal(output.results[0]?.resource.resource, "https://api.market.example.com/prices");
    assert.equal(output.nextCursor, "next-cursor");
    assert.equal(output.partialResults, true);
    assert.match(output.instructionToAgent, /Ask the user to choose/i);
    assert.match(output.instructionToAgent, /prepare_x402_service_request/);
  });
});

describe("prepareX402ServiceRequestForAgent", () => {
  it("prepares a selected Bazaar HTTP resource for the existing x402 flow", async () => {
    const output = await prepareX402ServiceRequestForAgent({
      resource: bazaarResource,
      parameters: {
        symbol: "ETH-USDT",
      },
      headers: {
        Accept: "application/json",
      },
    });

    assert.equal(output.status, "REQUEST_READY");
    assert.deepEqual(output.request, {
      url: "https://api.market.example.com/prices?symbol=ETH-USDT",
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });
    assert.equal(output.paymentRequired?.resource.url, "https://api.market.example.com/prices?symbol=ETH-USDT");
    assert.match(output.instructionToAgent, /parse_x402_payment_required/);
    assert.match(output.instructionToAgent, /Review & Sign/i);
  });

  it("asks for missing request parameters before payment preparation", async () => {
    const output = await prepareX402ServiceRequestForAgent({
      resource: bazaarResource,
    });

    assert.equal(output.status, "NEEDS_INPUT");
    assert.deepEqual(output.missingParameters, ["symbol"]);
    assert.equal(output.request, undefined);
    assert.match(output.instructionToAgent, /Ask the user for missing parameter\(s\): symbol/);
  });
});
