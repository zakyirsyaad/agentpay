# @agentpay-ai/mcp-server

AgentPay MCP server and payment runtime tools.

Most users get this package through the CLI:

```bash
npx @agentpay-ai/agentpay install
npx @agentpay-ai/agentpay mcp
```

For public A2MCP deployment, run the Streamable HTTP transport behind an HTTPS domain:

```bash
npx @agentpay-ai/agentpay serve-http --host 0.0.0.0 --port 3001
```

Register the public `/mcp` URL with OKX.AI, and use `/healthz` for health checks. The process itself listens over HTTP; terminate TLS at the hosting platform, load balancer, or reverse proxy.

For listing review, enable the **OKX Agent Payments Protocol** seller gate on `/mcp`:

```bash
AGENTPAY_A2MCP_PAYMENT_ENABLED=true
AGENTPAY_A2MCP_PAYMENT_PAY_TO=0x...
AGENTPAY_A2MCP_PAYMENT_PRICE=$0.01
AGENTPAY_A2MCP_PAYMENT_NETWORK=eip155:196
```

Provide either OKX facilitator credentials (`OKX_APP_API_KEY`, `OKX_APP_SECRET_KEY`, `OKX_APP_PASSPHRASE`) or `AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL`. Unpaid calls receive HTTP `402` with `PAYMENT-REQUIRED`; paid calls are verified, settled, and returned with `PAYMENT-RESPONSE`. `/healthz` is never paywalled.

## Tools

The server exposes tools for wallet setup, balance checks, LI.FI route quotes, payment preparation, exact approval execution, payment tracking, invoice parsing, x402 Bazaar discovery for no-URL paid API requests, x402 parsing plus receipt-proof retry, route target allowance, and account admin transactions. Use `search_x402_services` and `prepare_x402_service_request` before parsing when the user describes a paid service without a URL. The x402 retry path sends AgentPay proof as `X-PAYMENT` / `PAYMENT-SIGNATURE`, reads V2 `PAYMENT-RESPONSE`, falls back to `X-PAYMENT-RESPONSE`, and includes `payment-identifier` idempotency data when advertised.

## Programmatic Usage

```ts
import { startAgentPayMcpServer } from "@agentpay-ai/mcp-server";

await startAgentPayMcpServer();
```

```ts
import { startAgentPayHttpServer } from "@agentpay-ai/mcp-server";

await startAgentPayHttpServer({ hostname: "0.0.0.0", port: 3001 });
```

## Configuration

Provide runtime config through `AGENTPAY_CONFIG` or environment variables such as `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `XLAYER_RPC_URL`, `XLAYER_MAINNET_RPC_URL`, `XLAYER_TESTNET_RPC_URL`, `EXECUTOR_PRIVATE_KEY`, `SETUP_WEB_URL`, `LIFI_API_KEY`, optional `X402_BAZAAR_FACILITATOR_URL`, and public A2MCP seller-payment variables prefixed with `AGENTPAY_A2MCP_PAYMENT_`.

Keep service role keys and executor private keys on the server side only.
