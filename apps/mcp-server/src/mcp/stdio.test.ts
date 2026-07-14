import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentPayRuntime } from "../runtime/agentpay-runtime.ts";
import type { AgentPayMcpServer } from "./agentpay-mcp.ts";
import { createAgentPayMcpServer, startAgentPayMcpServer } from "./stdio.ts";

class FakeSdkServer implements AgentPayMcpServer {
  public registeredToolNames: string[] = [];

  registerTool(name: string): void {
    this.registeredToolNames.push(name);
  }
}

describe("createAgentPayMcpServer", () => {
  it("creates an AgentPay MCP server and registers payment tools", () => {
    const server = createAgentPayMcpServer(createRuntime(), () => new FakeSdkServer());

    assert.deepEqual(server.registeredToolNames, [
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
  });
});

describe("startAgentPayMcpServer", () => {
  it("fails closed instead of starting a production stdio execution surface", async () => {
    await assert.rejects(
      () =>
        startAgentPayMcpServer({
          env: {
            AGENTPAY_ENVIRONMENT: "production",
            AGENTPAY_HOME_CHAIN_ID: "196",
            AGENTPAY_ACCOUNT_VERSION: "v2",
            SUPABASE_PRODUCTION_URL: "https://abcdefghijklmnopqrst.supabase.co",
            SUPABASE_PRODUCTION_SERVICE_ROLE_KEY: "production-service-role-key",
            XLAYER_MAINNET_RPC_URL: "https://rpc.xlayer.tech",
            EXECUTOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
            AGENTPAY_SESSION_HASH_KEY: "session-hash-key-012345678901234567890123",
            AGENTPAY_REVIEW_TOKEN_SECRET: "review-token-secret-012345678901234567890123",
          },
        }),
      /readiness-gated HTTP surface/i,
    );
  });

  it("parses env, creates runtime, and connects the stdio transport", async () => {
    const runtime = createRuntime();
    const transport = { kind: "stdio" };
    const connectedTransports: unknown[] = [];
    const createdConfigs: unknown[] = [];

    await startAgentPayMcpServer({
      env: {
        SUPABASE_URL: "https://agentpay.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        XLAYER_RPC_URL: "https://rpc.xlayer.tech",
        EXECUTOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      },
      createRuntime(config) {
        createdConfigs.push(config);
        return runtime;
      },
      createServer(createdRuntime) {
        assert.equal(createdRuntime, runtime);
        return {
          async connect(createdTransport: unknown) {
            connectedTransports.push(createdTransport);
          },
        };
      },
      createTransport() {
        return transport;
      },
    });

    assert.deepEqual(createdConfigs, [
      {
        supabaseUrl: "https://agentpay.supabase.co",
        serviceRoleKey: "service-role-key",
        xlayerRpcUrl: "https://rpc.xlayer.tech",
        executorPrivateKey: `0x${"1".repeat(64)}`,
      },
    ]);
    assert.deepEqual(connectedTransports, [transport]);
  });
});

function createRuntime(): AgentPayRuntime {
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
  };
}
