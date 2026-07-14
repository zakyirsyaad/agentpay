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

The server exposes tools for wallet setup, balance checks, LI.FI route quotes, payment preparation, Review & Sign handoff polling, owner-signed EIP-712 execution, payment tracking, invoice parsing, x402 Bazaar discovery for no-URL paid API requests, x402 parsing plus receipt-proof retry, route target allowance, and account admin transactions. Trusted consumer sessions receive a server-generated Review & Sign URL and canonical typed data; `get_payment_signature` returns the verified owner signature to the tenant session, which hands it to the public paid ASP's `execute_payment` tool. Legacy approval text is migration-only. Use `search_x402_services` and `prepare_x402_service_request` before parsing when the user describes a paid service without a URL. The x402 retry path sends AgentPay proof as `X-PAYMENT` / `PAYMENT-SIGNATURE`, reads V2 `PAYMENT-RESPONSE`, falls back to `X-PAYMENT-RESPONSE`, and includes `payment-identifier` idempotency data when advertised.

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

Provide runtime config through `AGENTPAY_CONFIG` or environment variables such as `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `XLAYER_RPC_URL`, `XLAYER_MAINNET_RPC_URL`, `XLAYER_TESTNET_RPC_URL`, `EXECUTOR_PRIVATE_KEY`, `SETUP_WEB_URL`, `AGENTPAY_REVIEW_TOKEN_SECRET`, `LIFI_API_KEY`, optional `X402_BAZAAR_FACILITATOR_URL`, and public A2MCP seller-payment variables prefixed with `AGENTPAY_A2MCP_PAYMENT_`. For mainnet, use only `AGENTPAY_ENVIRONMENT=production`, `AGENTPAY_HOME_CHAIN_ID=196`, `AGENTPAY_ACCOUNT_VERSION=v2`, `SUPABASE_PRODUCTION_URL`, `SUPABASE_PRODUCTION_SERVICE_ROLE_KEY`, and `XLAYER_MAINNET_RPC_URL`; generic/staging aliases are rejected. When running from a published package, set `AGENTPAY_MAINNET_MANIFEST_PATH` to the copied tracked shadow manifest because the repository-level `ops/` directory is not included in the package. Mainnet x402 is pinned to the USDT0 contract, `$0.01`/`10000`, and synchronous settlement. The tracked shadow manifest, operator-seeded runtime identity, and read-only on-chain account verifier must all pass before `/readyz` becomes `200`; `/healthz` is liveness only. Production stdio is disabled, and setup-web refuses a production environment until the deployment gate is implemented.

Review handoffs use the configured secret to store only an opaque token digest; the Supabase service-role key is the local fallback when no dedicated secret is provided. `DIRECT_URL_PRODUCTION` is migration-admin-only and is never loaded by the application runtime.

Keep service role keys and executor private keys on the server side only.
