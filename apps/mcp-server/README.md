# @agentpay-ai/mcp-server

AgentPay MCP server and payment runtime tools.

Most users get this package through the CLI:

```bash
npx @agentpay-ai/agentpay install
npx @agentpay-ai/agentpay mcp
```

## Tools

The server exposes tools for wallet setup, balance checks, LI.FI route quotes, payment preparation, exact approval execution, payment tracking, invoice parsing, x402 parsing plus receipt-proof retry, route target allowance, and account admin transactions. The x402 retry path sends AgentPay proof as `X-PAYMENT` / `PAYMENT-SIGNATURE`, reads V2 `PAYMENT-RESPONSE`, falls back to `X-PAYMENT-RESPONSE`, and includes `payment-identifier` idempotency data when advertised.

## Programmatic Usage

```ts
import { startAgentPayMcpServer } from "@agentpay-ai/mcp-server";

await startAgentPayMcpServer();
```

## Configuration

Provide runtime config through `AGENTPAY_CONFIG` or environment variables such as `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `XLAYER_RPC_URL`, `XLAYER_MAINNET_RPC_URL`, `XLAYER_TESTNET_RPC_URL`, `EXECUTOR_PRIVATE_KEY`, `SETUP_WEB_URL`, and `LIFI_API_KEY`.

Keep service role keys and executor private keys on the server side only.
