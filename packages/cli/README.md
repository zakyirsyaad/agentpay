# AgentPay

Chat-approved stablecoin payments for AI agents.

AgentPay installs MCP tools and runtime instructions for chat-approved X Layer payments. By default it connects users to the hosted AgentPay MCP endpoint, so normal users do not manage Supabase, RPC, executor, deployer, or bytecode config.

## Quick Start

```bash
npx @agentpay-ai/agentpay install
```

Use `--runtime codex|claude|cursor|generic|hermes` to choose a runtime explicitly:

```bash
npx @agentpay-ai/agentpay install --runtime codex
```

The installer writes MCP runtime files and `skills/agentpay/SKILL.md`. The generated MCP config points to `https://mcp.agentpay.site/mcp`. For Claude, Cursor, and Hermes, the installer also registers `agentpay` in the runtime's native MCP config, so the agent can discover AgentPay tools instead of falling back to web search or raw RPC calls.

After install, reload or reconnect your agent runtime if needed, then return to your agent chat. From there, ask naturally:

```txt
Create an AgentPay wallet for me on X Layer testnet.
```

or:

```txt
Pay 5 USDT0 to 0x... on X Layer testnet for invoice INV-001.
```

AgentPay supports X Layer mainnet and testnet. If you do not name one, the agent should ask for mainnet or testnet before creating a wallet or payment. Agent tools accept `network: "mainnet" | "testnet"`, so you can switch networks per request from chat.

Cross-chain routes are selected during quote or payment preparation, not during wallet setup. Create an X Layer mainnet or X Layer testnet AgentPay wallet first, then decide whether a specific payment stays on that network or uses a cross-chain route.

The agent should use AgentPay tools in chat to create the wallet setup link, check wallet creation, prepare payments, request the exact approval phrase, execute after exact approval, and track status.

For x402 paid APIs, the agent uses `search_x402_services` when you do not provide a URL, prepares the selected Bazaar service with `prepare_x402_service_request`, parses the `PAYMENT-REQUIRED` response, runs the same exact-approval payment flow, then calls `retry_x402_request` to retry the protected resource with AgentPay receipt-proof headers. The retry reads V2 `PAYMENT-RESPONSE`, keeps legacy fallback, and includes `payment-identifier` idempotency data when the server advertises it.

## Commands

- `agentpay install` creates hosted AgentPay runtime files. No user secrets are required.
- `agentpay install --self-hosted` creates local operator config, bytecode, and stdio MCP files.
- `agentpay mcp` starts the self-hosted AgentPay MCP server over stdio.
- `agentpay serve-http --host 0.0.0.0 --port 3001` starts the Streamable HTTP MCP server for public HTTPS A2MCP deployments.
- `agentpay doctor` is a self-hosted/operator diagnostic check for required config without printing secrets.
- `agentpay setup-web` is a self-hosted/operator fallback way to serve the setup/signing web server.

For OKX.AI A2MCP listing, run `agentpay serve-http` behind your HTTPS domain or reverse proxy and register the public `/mcp` URL. Enable the **OKX Agent Payments Protocol** seller gate with `AGENTPAY_A2MCP_PAYMENT_ENABLED=true`, pay-to, price, network, and facilitator credentials. The built-in `/healthz` route remains free for platform health checks.

## Self-Hosted Configuration

Normal hosted installs do not require these values. Use them only for `agentpay install --self-hosted`, `agentpay mcp`, `agentpay setup-web`, or `agentpay serve-http`.

Fill the self-hosted config or provide equivalent environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `XLAYER_RPC_URL` as the fallback RPC
- `XLAYER_MAINNET_RPC_URL` and `XLAYER_TESTNET_RPC_URL` for per-request network switching
- `EXECUTOR_PRIVATE_KEY`
- `SETUP_DEPLOYER_PRIVATE_KEY` for setup web

Optional values include `SETUP_WEB_URL`, `LIFI_API_KEY`, `X402_BAZAAR_FACILITATOR_URL`, `AGENTPAY_ACCOUNT_BYTECODE_PATH`, `AGENTPAY_INITIAL_ROUTE_TARGETS`, X Layer token overrides, and `AGENTPAY_A2MCP_PAYMENT_*` values for public OKX.AI A2MCP seller payments.

## Safety Model

- Setup signatures prove wallet ownership only. They do not approve payments.
- Payments require exact chat approval before execution.
- The smart account enforces token and route-target allowlists, nonces, deadlines, max spend, max native fee, calldata hash checks, and allowance reset after guarded calls.
- Keep service role keys and private keys server-side. Never paste secrets into chat.

## Packages

This CLI installs and wires the AgentPay package set:

- `@agentpay-ai/skill`
- `@agentpay-ai/shared`
- `@agentpay-ai/mcp-server`
- `@agentpay-ai/setup-web`

See the repository README for development, contract, and release commands.
