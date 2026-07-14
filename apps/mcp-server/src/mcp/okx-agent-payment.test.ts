import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseAgentPayMcpPaymentEnv } from "./okx-agent-payment.ts";

describe("parseAgentPayMcpPaymentEnv", () => {
  it("leaves public MCP payments disabled by default", () => {
    assert.equal(parseAgentPayMcpPaymentEnv({}), undefined);
  });

  it("parses OKX Agent Payments Protocol seller config", () => {
    assert.deepEqual(
      parseAgentPayMcpPaymentEnv({
        AGENTPAY_A2MCP_PAYMENT_ENABLED: "true",
        AGENTPAY_A2MCP_PAYMENT_PAY_TO: "0x0000000000000000000000000000000000000002",
        AGENTPAY_A2MCP_PAYMENT_PRICE: "$0.01",
        AGENTPAY_A2MCP_PAYMENT_NETWORK: "eip155:196",
        AGENTPAY_A2MCP_PAYMENT_MAX_TIMEOUT_SECONDS: "120",
        AGENTPAY_A2MCP_PAYMENT_ASSET_DECIMALS: "6",
        AGENTPAY_A2MCP_PAYMENT_SYNC_SETTLE: "yes",
        AGENTPAY_A2MCP_PAYMENT_ASSET_TRANSFER_METHOD: "permit2",
        OKX_APP_API_KEY: "dummy-api-key",
        OKX_APP_SECRET_KEY: "dummy-secret-key",
        OKX_APP_PASSPHRASE: "dummy-passphrase",
      }),
      {
        enabled: true,
        payTo: "0x0000000000000000000000000000000000000002",
        price: "$0.01",
        network: "eip155:196",
        asset: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
        maxTimeoutSeconds: 120,
        assetDecimals: 6,
        okxApiKey: "dummy-api-key",
        okxSecretKey: "dummy-secret-key",
        okxPassphrase: "dummy-passphrase",
        syncSettle: true,
        assetTransferMethod: "permit2",
      },
    );
  });

  it("reports invalid config names without echoing secret values", () => {
    assert.throws(
      () =>
        parseAgentPayMcpPaymentEnv({
          AGENTPAY_A2MCP_PAYMENT_ENABLED: "true",
          AGENTPAY_A2MCP_PAYMENT_PAY_TO: "not-an-address",
          AGENTPAY_A2MCP_PAYMENT_PRICE: "$0.01",
          OKX_APP_API_KEY: "dummy-api-key-value",
          OKX_APP_SECRET_KEY: "dummy-secret-value",
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /AGENTPAY_A2MCP_PAYMENT_PAY_TO/);
        assert.match(error.message, /OKX_APP_PASSPHRASE/);
        assert.doesNotMatch(error.message, /dummy-api-key-value/);
        assert.doesNotMatch(error.message, /dummy-secret-value/);
        return true;
      },
    );
  });

  it("rejects unknown boolean values instead of silently disabling payment or sync settlement", () => {
    assert.throws(
      () => parseAgentPayMcpPaymentEnv({ AGENTPAY_A2MCP_PAYMENT_ENABLED: "treu" }),
      /AGENTPAY_A2MCP_PAYMENT_ENABLED/i,
    );
    assert.throws(
      () =>
        parseAgentPayMcpPaymentEnv({
          AGENTPAY_A2MCP_PAYMENT_ENABLED: "true",
          AGENTPAY_A2MCP_PAYMENT_PAY_TO: "0x0000000000000000000000000000000000000002",
          AGENTPAY_A2MCP_PAYMENT_PRICE: "$0.01",
          AGENTPAY_A2MCP_PAYMENT_SYNC_SETTLE: "tru",
          AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL: "https://facilitator.example.com",
        }),
      /AGENTPAY_A2MCP_PAYMENT_SYNC_SETTLE/i,
    );
  });

  it("pins mainnet x402 to the canonical USDT0 asset", () => {
    assert.throws(
      () =>
        parseAgentPayMcpPaymentEnv({
          AGENTPAY_A2MCP_PAYMENT_ENABLED: "true",
          AGENTPAY_A2MCP_PAYMENT_PAY_TO: "0x0000000000000000000000000000000000000002",
          AGENTPAY_A2MCP_PAYMENT_PRICE: "$0.01",
          AGENTPAY_A2MCP_PAYMENT_ASSET: "0x0000000000000000000000000000000000000003",
          OKX_APP_API_KEY: "dummy-api-key",
          OKX_APP_SECRET_KEY: "dummy-secret-key",
          OKX_APP_PASSPHRASE: "dummy-passphrase",
        }),
      /AGENTPAY_A2MCP_PAYMENT_ASSET/i,
    );
  });
});
