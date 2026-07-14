import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSessionContext } from "@agentpay-ai/shared";
import type { AgentPayRuntime } from "../runtime/agentpay-runtime.ts";
import { registerAgentPayMcpTools, type AgentPayMcpServer } from "./agentpay-mcp.ts";

class FakeMcpServer implements AgentPayMcpServer {
  public tools = new Map<
    string,
    {
      metadata: Record<string, unknown>;
      handler: (input: unknown) => Promise<unknown>;
    }
  >();

  registerTool(name: string, metadata: Record<string, unknown>, handler: (input: unknown) => Promise<unknown>): void {
    this.tools.set(name, { metadata, handler });
  }
}

describe("registerAgentPayMcpTools", () => {
  it("registers wallet setup tools and returns structured setup content", async () => {
    const server = new FakeMcpServer();
    const runtime = createRuntime({
      async prepareWalletCreation(input) {
        assert.deepEqual(input, {});
        return {
          setupIntentId: "setup_runtime",
          status: "PENDING",
          setupUrl: "https://setup.agentpay.dev/setup?setup_intent_id=setup_runtime",
          messageToSign: "AgentPay wallet setup",
          expiresAt: "2026-07-03T04:15:00.000Z",
          homeChainId: 196,
          homeChain: "X Layer",
        };
      },
    });

    registerAgentPayMcpTools(server, runtime);

    assert.deepEqual([...server.tools.keys()], [
      "prepare_wallet_creation",
      "check_wallet_creation",
      "get_agent_wallet",
      "get_balance",
      "parse_invoice_payment",
      "search_x402_services",
      "prepare_x402_service_request",
      "parse_x402_payment_required",
      "retry_x402_request",
      "prepare_contract_call",
      "quote_payment_route",
      "check_route_target_allowance",
      "prepare_route_target_allowance",
      "prepare_account_admin_transaction",
      "prepare_payment",
      "execute_payment",
      "track_payment",
      "list_transactions",
      "list_payment_events",
    ]);

    const registered = server.tools.get("prepare_wallet_creation");
    assert.ok(registered);
    assert.match(String(registered.metadata.description), /wallet setup intent/);

    const result = await registered.handler({});

    assert.deepEqual(result, {
      content: [
        {
          type: "text",
          text: JSON.stringify((result as { structuredContent: unknown }).structuredContent, null, 2),
        },
      ],
      structuredContent: {
        setupIntentId: "setup_runtime",
        status: "PENDING",
        setupUrl: "https://setup.agentpay.dev/setup?setup_intent_id=setup_runtime",
        messageToSign: "AgentPay wallet setup",
        expiresAt: "2026-07-03T04:15:00.000Z",
        homeChainId: 196,
        homeChain: "X Layer",
      },
    });
  });

  it("registers x402 Bazaar discovery tools for users who do not provide a URL", async () => {
    const server = new FakeMcpServer();
    const runtime = createRuntime({
      async searchX402Services(input) {
        assert.deepEqual(input, {
          query: "okx market data",
          type: "http",
          limit: 5,
        });
        return {
          status: "FOUND",
          query: "okx market data",
          type: "http",
          results: [
            {
              resourceUrl: "https://api.market.example.com/prices",
              type: "http",
              serviceName: "Market Bazaar",
              description: "Paid market prices",
              method: "GET",
              requiredParameters: ["symbol"],
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
              resource: {
                resource: "https://api.market.example.com/prices",
                type: "http",
                x402Version: 2,
                serviceName: "Market Bazaar",
              description: "Paid market prices",
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
              },
            },
          ],
          instructionToAgent:
            "Ask the user to choose a service, then call prepare_x402_service_request with the selected resource.",
        };
      },
      async prepareX402ServiceRequest(input) {
        assert.equal(input.parameters?.symbol, "ETH-USDT");
        return {
          status: "REQUEST_READY",
          request: {
            url: "https://api.market.example.com/prices?symbol=ETH-USDT",
            method: "GET",
            headers: {},
          },
          paymentRequired: {
            x402Version: 2,
            resource: {
              url: "https://api.market.example.com/prices?symbol=ETH-USDT",
              description: "Paid market prices",
              serviceName: "Market Bazaar",
            },
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
          },
          missingParameters: [],
          instructionToAgent:
            "Call parse_x402_payment_required with paymentRequired, then run the Review & Sign owner-authorization flow before retry_x402_request.",
        };
      },
    });

    registerAgentPayMcpTools(server, runtime);

    const search = server.tools.get("search_x402_services");
    const prepare = server.tools.get("prepare_x402_service_request");
    assert.ok(search);
    assert.ok(prepare);
    assert.match(String(search.metadata.description), /Bazaar/i);
    assert.match(String(prepare.metadata.description), /Bazaar/i);

    const searchResult = await search.handler({ query: "okx market data" });
    const selected = (
      searchResult as {
        structuredContent: { results: Array<{ resource: unknown }> };
      }
    ).structuredContent.results[0]!.resource;
    const prepareResult = await prepare.handler({
      resource: selected,
      parameters: {
        symbol: "ETH-USDT",
      },
    });

    assert.match(JSON.stringify(searchResult), /prepare_x402_service_request/);
    assert.match(JSON.stringify(prepareResult), /parse_x402_payment_required/);
  });

  it("registers get_balance and returns structured balance content", async () => {
    const server = new FakeMcpServer();
    const balanceInputs: unknown[] = [];
    const runtime = createRuntime({
      async getBalance(input) {
        balanceInputs.push(input);
        return {
          status: "ACTIVE",
          accountAddress: "0x3333333333333333333333333333333333333333",
          ownerAddress: "0x2222222222222222222222222222222222222222",
          chainId: 196,
          chain: "X Layer",
          balances: [
            {
              tokenSymbol: "USDT0",
              tokenAddress: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
              amount: "12.5",
              decimals: 18,
            },
          ],
          nativeBalance: {
            tokenSymbol: "OKB",
            tokenAddress: "native",
            amount: "0.03",
            decimals: 18,
          },
        };
      },
    });

    registerAgentPayMcpTools(server, runtime);
    const registered = server.tools.get("get_balance");

    assert.ok(registered);
    assert.match(String(registered.metadata.description), /Read AgentPay wallet token balances/);

    const result = await registered.handler({ tokenSymbols: ["USDT0"] });

    assert.deepEqual(balanceInputs, [{ tokenSymbols: ["USDT0"] }]);
    assert.deepEqual(result, {
      content: [
        {
          type: "text",
          text: JSON.stringify((result as { structuredContent: unknown }).structuredContent, null, 2),
        },
      ],
      structuredContent: {
        status: "ACTIVE",
        accountAddress: "0x3333333333333333333333333333333333333333",
        ownerAddress: "0x2222222222222222222222222222222222222222",
        chainId: 196,
        chain: "X Layer",
        balances: [
          {
            tokenSymbol: "USDT0",
            tokenAddress: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
            amount: "12.5",
            decimals: 18,
          },
        ],
        nativeBalance: {
          tokenSymbol: "OKB",
          tokenAddress: "native",
          amount: "0.03",
          decimals: 18,
        },
      },
    });
  });

  it("registers parse_invoice_payment and returns normalized payment fields", async () => {
    const server = new FakeMcpServer();
    const invoiceInputs: unknown[] = [];
    const runtime = createRuntime({
      async parseInvoicePayment(input) {
        invoiceInputs.push(input);
        return {
          status: "PARSED",
          invoiceId: "inv_runtime",
          paymentInput: {
            recipientAddress: "0x1111111111111111111111111111111111111111",
            destinationChainId: 8453,
            destinationChain: "Base",
            destinationTokenSymbol: "USDC",
            amountOut: "10",
            purpose: "design bounty",
            sourceTokenSymbol: "USDT0",
            paymentType: "INVOICE_PAYMENT",
          },
          instructionToAgent:
            "Review these invoice payment fields with the user, then call prepare_payment with paymentInput if they match the invoice.",
        };
      },
    });

    registerAgentPayMcpTools(server, runtime);
    const registered = server.tools.get("parse_invoice_payment");

    assert.ok(registered);
    assert.match(String(registered.metadata.description), /invoice/);

    const result = await registered.handler({
      invoice: [
        "Invoice ID: inv_runtime",
        "Recipient: 0x1111111111111111111111111111111111111111",
        "Destination Chain: Base",
        "Token: USDC",
        "Amount: 10",
        "Purpose: design bounty",
      ].join("\n"),
    });

    assert.equal(invoiceInputs.length, 1);
    assert.equal((invoiceInputs[0] as { sourceTokenSymbol: string }).sourceTokenSymbol, "USDT0");
    assert.deepEqual((result as { structuredContent: unknown }).structuredContent, {
      status: "PARSED",
      invoiceId: "inv_runtime",
      paymentInput: {
        recipientAddress: "0x1111111111111111111111111111111111111111",
        destinationChainId: 8453,
        destinationChain: "Base",
        destinationTokenSymbol: "USDC",
        amountOut: "10",
        purpose: "design bounty",
        sourceTokenSymbol: "USDT0",
        paymentType: "INVOICE_PAYMENT",
      },
      instructionToAgent:
        "Review these invoice payment fields with the user, then call prepare_payment with paymentInput if they match the invoice.",
    });
  });

  it("registers parse_x402_payment_required and returns normalized payment fields", async () => {
    const server = new FakeMcpServer();
    const x402Inputs: unknown[] = [];
    const runtime = createRuntime({
      async parseX402PaymentRequired(input) {
        x402Inputs.push(input);
        return {
          status: "PARSED",
          x402Version: 2,
          resource: {
            url: "https://api.example.com/premium-data",
            description: "Premium market data",
            serviceName: "Market API",
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
            "Review the x402 requirement with the user. Prepare payment with paymentInput, preserve paymentType: X402_PAYMENT, send the owner to Review & Sign for the EIP-712 authorization, execute with the verified signature, track until COMPLETED, then call retry_x402_request with the original PAYMENT-REQUIRED response and paymentIntentId.",
        };
      },
    });

    registerAgentPayMcpTools(server, runtime);
    const registered = server.tools.get("parse_x402_payment_required");

    assert.ok(registered);
    assert.match(String(registered.metadata.description), /x402/);

    const result = await registered.handler({
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
    });

    assert.equal(x402Inputs.length, 1);
    assert.equal((x402Inputs[0] as { sourceTokenSymbol: string }).sourceTokenSymbol, "USDT0");
    assert.deepEqual((result as { structuredContent: unknown }).structuredContent, {
      status: "PARSED",
      x402Version: 2,
      resource: {
        url: "https://api.example.com/premium-data",
        description: "Premium market data",
        serviceName: "Market API",
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
        "Review the x402 requirement with the user. Prepare payment with paymentInput, preserve paymentType: X402_PAYMENT, send the owner to Review & Sign for the EIP-712 authorization, execute with the verified signature, track until COMPLETED, then call retry_x402_request with the original PAYMENT-REQUIRED response and paymentIntentId.",
    });
  });

  it("registers retry_x402_request and returns protected resource content", async () => {
    const server = new FakeMcpServer();
    const retryInputs: unknown[] = [];
    const runtime = createRuntime({
      async retryX402Request(input) {
        retryInputs.push(input);
        return {
          status: "RESOURCE_FETCHED",
          paymentIntentId: "pay_x402",
          requestUrl: "https://api.example.com/premium-data",
          method: "GET",
          httpStatus: 200,
          paymentHeader: "eyJzY2hlbWUiOiJhZ2VudHBheS1yZWNlaXB0In0",
          paymentResponse: "settled",
          bodyText: "{\"ok\":true}",
          instructionToAgent: "x402 retry succeeded. Return the protected resource response to the user.",
        };
      },
    });

    registerAgentPayMcpTools(server, runtime);
    const registered = server.tools.get("retry_x402_request");

    assert.ok(registered);
    assert.match(String(registered.metadata.description), /Retry an x402-protected HTTP request/);

    const result = await registered.handler({
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
    });

    assert.equal(retryInputs.length, 1);
    assert.deepEqual((result as { structuredContent: unknown }).structuredContent, {
      status: "RESOURCE_FETCHED",
      paymentIntentId: "pay_x402",
      requestUrl: "https://api.example.com/premium-data",
      method: "GET",
      httpStatus: 200,
      paymentHeader: "eyJzY2hlbWUiOiJhZ2VudHBheS1yZWNlaXB0In0",
      paymentResponse: "settled",
      bodyText: "{\"ok\":true}",
      instructionToAgent: "x402 retry succeeded. Return the protected resource response to the user.",
    });
  });

  it("registers prepare_payment and returns structured MCP content", async () => {
    const server = new FakeMcpServer();
    const prepareInputs: unknown[] = [];
    const runtime = createRuntime({
      async preparePayment(input) {
        prepareInputs.push(input);
        return {
          paymentIntentId: "pay_runtime",
          status: "AWAITING_APPROVAL",
          approvalPhrase: "APPROVE pay_runtime",
          summary: {
            pay: "10 USDC",
            recipientAddress: "0x1111111111111111111111111111111111111111",
            destinationChain: "Base",
            sourceSpend: "10.2 USDT0",
            maxNativeFee: "2500000000000000",
            maxNativeFeeDisplay: "0.0025 OKB",
            routeProvider: "LI.FI",
            routeSummary: "LI.FI route prepared.",
            routeTarget: "0x7777777777777777777777777777777777777777",
            routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
            requiresRouteTargetAllowlist: true,
            estimatedFee: "0.12",
            estimatedEtaSeconds: 120,
            deadline: "2026-07-02T14:45:00.000Z",
            purpose: "design bounty",
          },
          instructionToAgent: "Ask the user to reply exactly: APPROVE pay_runtime",
        };
      },
    });

    registerAgentPayMcpTools(server, runtime);
    const registered = server.tools.get("prepare_payment");

    assert.ok(registered);
    assert.match(String(registered.metadata.description), /Prepare an AgentPay payment intent/);
    assert.ok("recipientAddress" in (registered.metadata.inputSchema as Record<string, unknown>));

    const result = await registered.handler({
      recipientAddress: "0x1111111111111111111111111111111111111111",
      destinationChainId: 8453,
      destinationTokenSymbol: "USDC",
      amountOut: "10",
      purpose: "design bounty",
    });

    assert.deepEqual(prepareInputs, [
      {
        recipientAddress: "0x1111111111111111111111111111111111111111",
        destinationChainId: 8453,
        destinationTokenSymbol: "USDC",
        amountOut: "10",
        purpose: "design bounty",
        sourceTokenSymbol: "USDT0",
        paymentType: "WALLET_PAYMENT",
      },
    ]);
    assert.deepEqual(result, {
      content: [
        {
          type: "text",
          text: JSON.stringify((result as { structuredContent: unknown }).structuredContent, null, 2),
        },
      ],
      structuredContent: {
        paymentIntentId: "pay_runtime",
        status: "AWAITING_APPROVAL",
        approvalPhrase: "APPROVE pay_runtime",
        summary: {
          pay: "10 USDC",
          recipientAddress: "0x1111111111111111111111111111111111111111",
          destinationChain: "Base",
          sourceSpend: "10.2 USDT0",
          maxNativeFee: "2500000000000000",
          maxNativeFeeDisplay: "0.0025 OKB",
          routeProvider: "LI.FI",
          routeSummary: "LI.FI route prepared.",
          routeTarget: "0x7777777777777777777777777777777777777777",
          routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
          requiresRouteTargetAllowlist: true,
          estimatedFee: "0.12",
          estimatedEtaSeconds: 120,
          deadline: "2026-07-02T14:45:00.000Z",
          purpose: "design bounty",
        },
        instructionToAgent: "Ask the user to reply exactly: APPROVE pay_runtime",
      },
    });
  });

  it("registers prepare_contract_call and returns structured MCP content", async () => {
    const server = new FakeMcpServer();
    const contractInputs: unknown[] = [];
    const runtime = createRuntime({
      async prepareContractCall(input) {
        contractInputs.push(input);
        return {
          paymentIntentId: "pay_contract",
          status: "AWAITING_APPROVAL",
          approvalPhrase: "APPROVE pay_contract",
          summary: {
            targetAddress: "0x8888888888888888888888888888888888888888",
            chainId: 196,
            chain: "X Layer",
            sourceTokenSymbol: "USDT0",
            maxTokenSpend: "7.5",
            maxNativeFee: "0",
            callDataHash: "0x40eed0325a12c6c6af8db2ea05450bfe21d6343b6fe955bff65045b67d9d5fe6",
            requiresTargetAllowlist: true,
            deadline: "2026-07-02T14:45:00.000Z",
            purpose: "mint access pass",
          },
          instructionToAgent:
            "Ask the user to reply exactly:\nAPPROVE pay_contract",
        };
      },
    });

    registerAgentPayMcpTools(server, runtime);
    const registered = server.tools.get("prepare_contract_call");

    assert.ok(registered);
    assert.match(String(registered.metadata.description), /contract call/);

    const result = await registered.handler({
      targetAddress: "0x8888888888888888888888888888888888888888",
      callData: "0xaabbccdd",
      maxTokenSpend: "7.5",
      purpose: "mint access pass",
    });

    assert.deepEqual(contractInputs, [
      {
        targetAddress: "0x8888888888888888888888888888888888888888",
        callData: "0xaabbccdd",
        sourceTokenSymbol: "USDT0",
        maxTokenSpend: "7.5",
        maxNativeFee: "0",
        purpose: "mint access pass",
      },
    ]);
    assert.deepEqual((result as { structuredContent: unknown }).structuredContent, {
      paymentIntentId: "pay_contract",
      status: "AWAITING_APPROVAL",
      approvalPhrase: "APPROVE pay_contract",
      summary: {
        targetAddress: "0x8888888888888888888888888888888888888888",
        chainId: 196,
        chain: "X Layer",
        sourceTokenSymbol: "USDT0",
        maxTokenSpend: "7.5",
        maxNativeFee: "0",
        callDataHash: "0x40eed0325a12c6c6af8db2ea05450bfe21d6343b6fe955bff65045b67d9d5fe6",
        requiresTargetAllowlist: true,
        deadline: "2026-07-02T14:45:00.000Z",
        purpose: "mint access pass",
      },
      instructionToAgent:
        "Ask the user to reply exactly:\nAPPROVE pay_contract",
    });
  });

  it("registers quote_payment_route and returns structured MCP content", async () => {
    const server = new FakeMcpServer();
    const quoteInputs: unknown[] = [];
    const runtime = createRuntime({
      async quotePaymentRoute(input) {
        quoteInputs.push(input);
        return {
          paymentType: "SWAP_BRIDGE_PAY",
          routeProvider: "LI.FI",
          sourceChainId: 196,
          sourceChain: "X Layer",
          destinationChainId: 8453,
          destinationChain: "Base",
          sourceTokenSymbol: "USDT0",
          sourceTokenAddress: "0x5555555555555555555555555555555555555555",
          destinationTokenSymbol: "USDC",
          destinationTokenAddress: "0x6666666666666666666666666666666666666666",
          amountOut: "10",
          maxAmountIn: "10.2",
          maxNativeFee: "0",
          maxNativeFeeDisplay: "0 OKB",
          routeTarget: "0x7777777777777777777777777777777777777777",
          routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
          requiresRouteTargetAllowlist: true,
          estimatedFee: "0.12",
          estimatedEtaSeconds: 120,
          routeSummary: "Spend 10.2 USDT0 for an estimated 10.17 USDC.",
        };
      },
    });

    registerAgentPayMcpTools(server, runtime);
    const registered = server.tools.get("quote_payment_route");

    assert.ok(registered);
    assert.match(String(registered.metadata.description), /Quote an AgentPay payment route/);

    const result = await registered.handler({
      recipientAddress: "0x1111111111111111111111111111111111111111",
      destinationChainId: 8453,
      destinationTokenSymbol: "USDC",
      amountOut: "10",
    });

    assert.deepEqual(quoteInputs, [
      {
        recipientAddress: "0x1111111111111111111111111111111111111111",
        destinationChainId: 8453,
        destinationTokenSymbol: "USDC",
        amountOut: "10",
        sourceTokenSymbol: "USDT0",
      },
    ]);
    assert.deepEqual((result as { structuredContent: unknown }).structuredContent, {
      paymentType: "SWAP_BRIDGE_PAY",
      routeProvider: "LI.FI",
      sourceChainId: 196,
      sourceChain: "X Layer",
      destinationChainId: 8453,
      destinationChain: "Base",
      sourceTokenSymbol: "USDT0",
      sourceTokenAddress: "0x5555555555555555555555555555555555555555",
      destinationTokenSymbol: "USDC",
      destinationTokenAddress: "0x6666666666666666666666666666666666666666",
      amountOut: "10",
      maxAmountIn: "10.2",
      maxNativeFee: "0",
      maxNativeFeeDisplay: "0 OKB",
      routeTarget: "0x7777777777777777777777777777777777777777",
      routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
      requiresRouteTargetAllowlist: true,
      estimatedFee: "0.12",
      estimatedEtaSeconds: 120,
      routeSummary: "Spend 10.2 USDT0 for an estimated 10.17 USDC.",
    });
  });

  it("registers prepare_route_target_allowance and returns owner transaction content", async () => {
    const server = new FakeMcpServer();
    const allowanceInputs: unknown[] = [];
    const runtime = createRuntime({
      async prepareRouteTargetAllowance(input) {
        allowanceInputs.push(input);
        return {
          status: "READY",
          action: "ALLOW",
          routeTarget: "0x7777777777777777777777777777777777777777",
          allowed: true,
          ownerAddress: "0x2222222222222222222222222222222222222222",
          accountAddress: "0x3333333333333333333333333333333333333333",
          chainId: 196,
          chain: "X Layer",
          transaction: {
            from: "0x2222222222222222222222222222222222222222",
            to: "0x3333333333333333333333333333333333333333",
            value: "0",
            chainId: 196,
            data: "0xabcdef",
          },
          instructionToAgent:
            "Ask the owner wallet 0x2222222222222222222222222222222222222222 to submit this transaction on X Layer. It allows route target 0x7777777777777777777777777777777777777777 and does not approve any payment.",
        };
      },
    });

    registerAgentPayMcpTools(server, runtime);
    const registered = server.tools.get("prepare_route_target_allowance");

    assert.ok(registered);
    assert.match(String(registered.metadata.description), /owner transaction/);

    const result = await registered.handler({
      routeTarget: "0x7777777777777777777777777777777777777777",
    });

    assert.deepEqual(allowanceInputs, [
      {
        routeTarget: "0x7777777777777777777777777777777777777777",
        allowed: true,
      },
    ]);
    assert.deepEqual((result as { structuredContent: unknown }).structuredContent, {
      status: "READY",
      action: "ALLOW",
      routeTarget: "0x7777777777777777777777777777777777777777",
      allowed: true,
      ownerAddress: "0x2222222222222222222222222222222222222222",
      accountAddress: "0x3333333333333333333333333333333333333333",
      chainId: 196,
      chain: "X Layer",
      transaction: {
        from: "0x2222222222222222222222222222222222222222",
        to: "0x3333333333333333333333333333333333333333",
        value: "0",
        chainId: 196,
        data: "0xabcdef",
      },
      instructionToAgent:
        "Ask the owner wallet 0x2222222222222222222222222222222222222222 to submit this transaction on X Layer. It allows route target 0x7777777777777777777777777777777777777777 and does not approve any payment.",
    });
  });

  it("registers check_route_target_allowance and returns allowlist status", async () => {
    const server = new FakeMcpServer();
    const allowanceInputs: unknown[] = [];
    const runtime = createRuntime({
      async checkRouteTargetAllowance(input) {
        allowanceInputs.push(input);
        return {
          status: "ACTIVE",
          routeTarget: "0x7777777777777777777777777777777777777777",
          routeTargetAllowed: false,
          ownerAddress: "0x2222222222222222222222222222222222222222",
          accountAddress: "0x3333333333333333333333333333333333333333",
          chainId: 196,
          chain: "X Layer",
          instructionToAgent:
            "Route target 0x7777777777777777777777777777777777777777 is not allowlisted on X Layer; call prepare_route_target_allowance before execution.",
        };
      },
    });

    registerAgentPayMcpTools(server, runtime);
    const registered = server.tools.get("check_route_target_allowance");

    assert.ok(registered);
    assert.match(String(registered.metadata.description), /allowlisted/);

    const result = await registered.handler({
      routeTarget: "0x7777777777777777777777777777777777777777",
    });

    assert.deepEqual(allowanceInputs, [
      {
        routeTarget: "0x7777777777777777777777777777777777777777",
      },
    ]);
    assert.deepEqual((result as { structuredContent: unknown }).structuredContent, {
      status: "ACTIVE",
      routeTarget: "0x7777777777777777777777777777777777777777",
      routeTargetAllowed: false,
      ownerAddress: "0x2222222222222222222222222222222222222222",
      accountAddress: "0x3333333333333333333333333333333333333333",
      chainId: 196,
      chain: "X Layer",
      instructionToAgent:
        "Route target 0x7777777777777777777777777777777777777777 is not allowlisted on X Layer; call prepare_route_target_allowance before execution.",
    });
  });

  it("registers prepare_account_admin_transaction and returns owner admin transaction content", async () => {
    const server = new FakeMcpServer();
    const adminInputs: unknown[] = [];
    const runtime = createRuntime({
      async prepareAccountAdminTransaction(input) {
        adminInputs.push(input);
        return {
          status: "READY",
          action: "PAUSE",
          ownerAddress: "0x2222222222222222222222222222222222222222",
          accountAddress: "0x3333333333333333333333333333333333333333",
          chainId: 196,
          chain: "X Layer",
          transaction: {
            from: "0x2222222222222222222222222222222222222222",
            to: "0x3333333333333333333333333333333333333333",
            value: "0",
            chainId: 196,
            data: "0xpause",
          },
          instructionToAgent:
            "Ask the owner wallet 0x2222222222222222222222222222222222222222 to submit this PAUSE transaction on X Layer. This is an owner admin action and does not approve any payment.",
        };
      },
    });

    registerAgentPayMcpTools(server, runtime);
    const registered = server.tools.get("prepare_account_admin_transaction");

    assert.ok(registered);
    assert.match(String(registered.metadata.description), /owner transaction/);

    const result = await registered.handler({ action: "PAUSE" });

    assert.deepEqual(adminInputs, [{ action: "PAUSE" }]);
    assert.deepEqual((result as { structuredContent: unknown }).structuredContent, {
      status: "READY",
      action: "PAUSE",
      ownerAddress: "0x2222222222222222222222222222222222222222",
      accountAddress: "0x3333333333333333333333333333333333333333",
      chainId: 196,
      chain: "X Layer",
      transaction: {
        from: "0x2222222222222222222222222222222222222222",
        to: "0x3333333333333333333333333333333333333333",
        value: "0",
        chainId: 196,
        data: "0xpause",
      },
      instructionToAgent:
        "Ask the owner wallet 0x2222222222222222222222222222222222222222 to submit this PAUSE transaction on X Layer. This is an owner admin action and does not approve any payment.",
    });
  });

  it("registers execute_payment and returns MCP errors without throwing from the handler", async () => {
    const server = new FakeMcpServer();
    const runtime = createRuntime({
      async executePayment() {
        throw new Error("Approval text does not exactly match the required phrase.");
      },
    });

    registerAgentPayMcpTools(server, runtime, { legacyApprovalEnabled: true });
    const registered = server.tools.get("execute_payment");

    assert.ok(registered);
    assert.ok("paymentIntentId" in (registered.metadata.inputSchema as Record<string, unknown>));

    const result = await registered.handler({
      paymentIntentId: "pay_runtime",
      approvalText: "yes",
    });

    assert.deepEqual(result, {
      content: [
        {
          type: "text",
          text: "Approval text does not exactly match the required phrase.",
        },
      ],
      isError: true,
    });
  });

  it("rejects legacy approval text on the public execution surface", async () => {
    const server = new FakeMcpServer();
    const runtime = createRuntime({});

    registerAgentPayMcpTools(server, runtime);
    const registered = server.tools.get("execute_payment");

    assert.ok(registered);
    const result = await registered.handler({
      paymentIntentId: "pay_public",
      approvalText: "APPROVE pay_public",
    });

    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(JSON.stringify(result), /EIP-712 payment authorization is required/i);
  });

  it("registers track_payment, list_transactions, and list_payment_events", async () => {
    const server = new FakeMcpServer();
    const runtime = createRuntime({
      async trackPayment(input) {
        assert.deepEqual(input, { paymentIntentId: "pay_runtime" });
        return {
          paymentIntentId: "pay_runtime",
          status: "COMPLETED",
          sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          message: "The transfer is complete.",
        };
      },
      async listTransactions(input) {
        assert.deepEqual(input, { limit: 2 });
        return {
          transactions: [
            {
              paymentIntentId: "pay_runtime",
              status: "COMPLETED",
              paymentType: "WALLET_PAYMENT",
              amountOut: "10",
              destinationTokenSymbol: "USDC",
              destinationChainId: 8453,
              recipientAddress: "0x1111111111111111111111111111111111111111",
              sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              createdAt: "2026-07-02T14:30:00.000Z",
            },
          ],
        };
      },
      async listPaymentEvents(input) {
        assert.deepEqual(input, { paymentIntentId: "pay_runtime", limit: 2 });
        return {
          events: [
            {
              eventId: "event_runtime",
              paymentIntentId: "pay_runtime",
              eventType: "PAYMENT_CREATED",
              message: "Payment intent created.",
              metadata: { status: "AWAITING_APPROVAL" },
              createdAt: "2026-07-02T14:30:00.000Z",
            },
          ],
        };
      },
    });

    registerAgentPayMcpTools(server, runtime);
    const tracked = await server.tools.get("track_payment")?.handler({ paymentIntentId: "pay_runtime" });
    const listed = await server.tools.get("list_transactions")?.handler({ limit: 2 });
    const events = await server.tools.get("list_payment_events")?.handler({ paymentIntentId: "pay_runtime", limit: 2 });

    assert.deepEqual((tracked as { structuredContent: unknown }).structuredContent, {
      paymentIntentId: "pay_runtime",
      status: "COMPLETED",
      sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      message: "The transfer is complete.",
    });
    assert.deepEqual((listed as { structuredContent: unknown }).structuredContent, {
      transactions: [
        {
          paymentIntentId: "pay_runtime",
          status: "COMPLETED",
          paymentType: "WALLET_PAYMENT",
          amountOut: "10",
          destinationTokenSymbol: "USDC",
          destinationChainId: 8453,
          recipientAddress: "0x1111111111111111111111111111111111111111",
          sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          createdAt: "2026-07-02T14:30:00.000Z",
        },
      ],
    });
    assert.deepEqual((events as { structuredContent: unknown }).structuredContent, {
      events: [
        {
          eventId: "event_runtime",
          paymentIntentId: "pay_runtime",
          eventType: "PAYMENT_CREATED",
          message: "Payment intent created.",
          metadata: { status: "AWAITING_APPROVAL" },
          createdAt: "2026-07-02T14:30:00.000Z",
        },
      ],
    });
  });

  it("enforces session scopes and never treats a consumer session as payment authorization", async () => {
    const server = new FakeMcpServer();
    const runtime = createRuntime({});
    const sessionContext = createSessionContext({
      sessionId: "session_123",
      tenantId: "tenant_a",
      ownerAddress: "0x1111111111111111111111111111111111111111",
      accountAddress: "0x2222222222222222222222222222222222222222",
      homeChainId: 1952,
      audience: "https://wallet.agentpay.site/mcp",
      environment: "staging",
      scopes: ["payment:read"],
      authEpoch: 0,
      issuedAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-19T00:00:00.000Z",
    });

    registerAgentPayMcpTools(server, runtime, { sessionContext });
    const balance = server.tools.get("get_balance");
    const execute = server.tools.get("execute_payment");
    const executeAuthorized = server.tools.get("execute_authorized_payment");
    const getSignature = server.tools.get("get_payment_signature");
    assert.ok(balance);
    assert.ok(execute);
    assert.equal(executeAuthorized, undefined);
    assert.ok(getSignature);

    await assert.rejects(balance.handler({}), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTH_SCOPE_REQUIRED");
      return true;
    });
    await assert.rejects(
      balance.handler({ accountAddress: "0x9999999999999999999999999999999999999999" }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "CALLER_AUTHORITY_FORBIDDEN");
        return true;
      },
    );
    const executionResult = await execute.handler({ paymentIntentId: "pay_123", approvalText: "ignored" });
    assert.equal((executionResult as { isError?: boolean }).isError, true);
    assert.match(JSON.stringify(executionResult), /public paid ASP/i);
    await assert.rejects(getSignature.handler({ paymentIntentId: "pay_123" }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTH_SCOPE_REQUIRED");
      return true;
    });
  });

  it("returns a tenant-scoped signature only with the payment:review scope", async () => {
    const server = new FakeMcpServer();
    const sessionContext = createSessionContext({
      sessionId: "session_review",
      tenantId: "tenant_a",
      ownerAddress: "0x1111111111111111111111111111111111111111",
      accountAddress: "0x2222222222222222222222222222222222222222",
      homeChainId: 1952,
      audience: "https://wallet.agentpay.site/mcp",
      environment: "staging",
      scopes: ["payment:review"],
      authEpoch: 0,
      issuedAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-19T00:00:00.000Z",
    });
    const runtime = createRuntime({
      async getPaymentSignature(input) {
        assert.deepEqual(input, { paymentIntentId: "pay_review" });
        return {
          paymentIntentId: "pay_review",
          status: "SIGNED",
          authorizationHash: `0x${"a".repeat(64)}`,
          signature: `0x${"b".repeat(130)}`,
        };
      },
    });

    registerAgentPayMcpTools(server, runtime, { sessionContext });
    const tool = server.tools.get("get_payment_signature");
    assert.ok(tool);
    const result = await tool.handler({ paymentIntentId: "pay_review" });
    assert.equal((result as { structuredContent?: { status?: string } }).structuredContent?.status, "SIGNED");
  });

  it("derives wallet setup ownership from the trusted session", async () => {
    const server = new FakeMcpServer();
    const sessionContext = createSessionContext({
      sessionId: "session_setup",
      tenantId: "tenant_setup",
      ownerAddress: "0x1111111111111111111111111111111111111111",
      accountAddress: "0x2222222222222222222222222222222222222222",
      homeChainId: 1952,
      audience: "https://wallet.agentpay.site/mcp",
      environment: "staging",
      scopes: ["session:manage"],
      authEpoch: 0,
      issuedAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-19T00:00:00.000Z",
    });
    let receivedOwner: string | undefined;
    const runtime = createRuntime({
      async prepareWalletCreation(input) {
        receivedOwner = input.ownerAddress;
        return {
          setupIntentId: "setup_session",
          status: "PENDING",
          setupUrl: "https://wallet.agentpay.site/setup?setup_intent_id=setup_session",
          messageToSign: "setup",
          expiresAt: "2026-07-12T00:05:00.000Z",
          homeChainId: 1952,
          homeChain: "X Layer testnet",
        };
      },
    });

    registerAgentPayMcpTools(server, runtime, { sessionContext });
    const result = await server.tools.get("prepare_wallet_creation")?.handler({ network: "testnet" });

    assert.equal(receivedOwner, sessionContext.ownerAddress);
    assert.equal((result as { structuredContent?: { setupIntentId?: string } }).structuredContent?.setupIntentId, "setup_session");
  });
});

function createRuntime(overrides: Partial<AgentPayRuntime>): AgentPayRuntime {
  return {
    async prepareWalletCreation() {
      throw new Error("prepareWalletCreation was not expected.");
    },
    async checkWalletCreation() {
      throw new Error("checkWalletCreation was not expected.");
    },
    async getAgentWallet() {
      throw new Error("getAgentWallet was not expected.");
    },
    async getBalance() {
      throw new Error("getBalance was not expected.");
    },
    async parseInvoicePayment() {
      throw new Error("parseInvoicePayment was not expected.");
    },
    async searchX402Services() {
      throw new Error("searchX402Services was not expected.");
    },
    async prepareX402ServiceRequest() {
      throw new Error("prepareX402ServiceRequest was not expected.");
    },
    async parseX402PaymentRequired() {
      throw new Error("parseX402PaymentRequired was not expected.");
    },
    async retryX402Request() {
      throw new Error("retryX402Request was not expected.");
    },
    async prepareContractCall() {
      throw new Error("prepareContractCall was not expected.");
    },
    async quotePaymentRoute() {
      throw new Error("quotePaymentRoute was not expected.");
    },
    async preparePayment() {
      throw new Error("preparePayment was not expected.");
    },
    async getPaymentSignature() {
      throw new Error("getPaymentSignature was not expected.");
    },
    async checkRouteTargetAllowance() {
      throw new Error("checkRouteTargetAllowance was not expected.");
    },
    async prepareAccountAdminTransaction() {
      throw new Error("prepareAccountAdminTransaction was not expected.");
    },
    async prepareRouteTargetAllowance() {
      throw new Error("prepareRouteTargetAllowance was not expected.");
    },
    async executePayment() {
      throw new Error("executePayment was not expected.");
    },
    async executeAuthorizedPayment() {
      throw new Error("executeAuthorizedPayment was not expected.");
    },
    async trackPayment() {
      throw new Error("trackPayment was not expected.");
    },
    async listTransactions() {
      throw new Error("listTransactions was not expected.");
    },
    async listPaymentEvents() {
      throw new Error("listPaymentEvents was not expected.");
    },
    ...overrides,
  };
}
