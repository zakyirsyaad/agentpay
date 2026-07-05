import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const expectedKeys = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "XLAYER_RPC_URL",
  "XLAYER_MAINNET_RPC_URL",
  "XLAYER_TESTNET_RPC_URL",
  "BASE_RPC_URL",
  "EXECUTOR_PRIVATE_KEY",
  "SETUP_DEPLOYER_PRIVATE_KEY",
  "AGENTPAY_OWNER_ADDRESS",
  "AGENTPAY_EXECUTOR_ADDRESS",
  "AGENTPAY_HOME_CHAIN_ID",
  "AGENTPAY_ACCOUNT_ADDRESS",
  "AGENTPAY_XLAYER_USDT0_ADDRESS",
  "AGENTPAY_XLAYER_USDC_ADDRESS",
  "AGENTPAY_XLAYER_TESTNET_USDT0_ADDRESS",
  "AGENTPAY_XLAYER_TESTNET_USDC_ADDRESS",
  "AGENTPAY_ACCOUNT_BYTECODE_PATH",
  "AGENTPAY_ACCOUNT_BYTECODE",
  "AGENTPAY_INITIAL_ROUTE_TARGETS",
  "SETUP_WEB_URL",
  "SETUP_WEB_PORT",
  "LIFI_API_KEY",
  "LIFI_BASE_URL",
  "X402_BAZAAR_FACILITATOR_URL",
  "AGENTPAY_A2MCP_PAYMENT_ENABLED",
  "AGENTPAY_A2MCP_PAYMENT_PAY_TO",
  "AGENTPAY_A2MCP_PAYMENT_PRICE",
  "AGENTPAY_A2MCP_PAYMENT_NETWORK",
  "AGENTPAY_A2MCP_PAYMENT_MAX_TIMEOUT_SECONDS",
  "AGENTPAY_A2MCP_PAYMENT_SYNC_SETTLE",
  "AGENTPAY_A2MCP_PAYMENT_ASSET_TRANSFER_METHOD",
  "AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL",
  "OKX_APP_API_KEY",
  "OKX_APP_SECRET_KEY",
  "OKX_APP_PASSPHRASE",
  "OKX_APP_BASE_URL",
];

function parseEnvExampleKeys(contents) {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split("=", 1)[0]);
}

describe(".env.example", () => {
  it("matches the AgentPay installer and runtime config keys", async () => {
    const contents = await readFile(".env.example", "utf8");
    const keys = parseEnvExampleKeys(contents);

    assert.deepEqual(keys, expectedKeys);
  });
});
