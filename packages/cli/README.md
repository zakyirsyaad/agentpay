# AgentPay

Owner-authorized stablecoin payments for AI agents.

AgentPay installs MCP tools and runtime instructions for owner-authorized X Layer payments. By default it connects users to the hosted AgentPay MCP endpoint, so normal users do not manage Supabase, RPC, executor, deployer, or bytecode config.

Hosted onboarding is X Layer mainnet only (chain ID `196`). New owners continue at `https://onboard.agentpay.site/setup`, where AgentPay sponsors exactly one smart-account deployment. The setup signature proves ownership and is not payment authorization. A new wallet starts USDT0-only with no route targets, and production payments use **Review & Sign**. Testnet is self-hosted, staging, or development only.

## Quick Start

```bash
npx @agentpay-ai/agentpay install
```

Use `--runtime codex|claude|cursor|generic|hermes` to choose a runtime explicitly:

```bash
npx @agentpay-ai/agentpay install --runtime codex
```

The installer writes MCP runtime files and `skills/agentpay/SKILL.md`. The generated MCP config points to the authenticated consumer endpoint `https://wallet.agentpay.site/mcp`. For Claude, Cursor, and Hermes, the installer also registers `agentpay` in the runtime's native MCP config, so the agent can discover AgentPay tools instead of falling back to web search or raw RPC calls. The separate paid public execution ASP is `https://mcp.agentpay.site/mcp` and is used only after Review & Sign.

After install, reload or reconnect your agent runtime if needed, then return to your agent chat. From there, ask naturally:

```txt
Create an AgentPay wallet for me on X Layer mainnet.
```

or:

```txt
Pay 5 USDT0 to 0x... on X Layer mainnet for invoice INV-001.
```

The hosted agent uses `network: "mainnet"`. A testnet request requires an explicitly configured self-hosted, staging, or development runtime and is never sent to hosted production.

Cross-chain routes are selected during quote or payment preparation, not during wallet setup. Create the X Layer mainnet wallet first, then decide whether a specific payment stays on that network or uses a cross-chain route.

The agent should use AgentPay tools in chat to create the wallet setup link, check wallet creation, prepare payments, show the canonical EIP-712 authorization, send the owner to Review & Sign, execute with the returned signature, and track status. Exact approval phrases are migration-only and are not accepted on the public V2 execution surface.

For x402 paid APIs, the agent uses `search_x402_services` when you do not provide a URL, prepares the selected Bazaar service with `prepare_x402_service_request`, parses the `PAYMENT-REQUIRED` response, runs the same Review & Sign owner-authorization flow, then calls `retry_x402_request` to retry the protected resource with AgentPay receipt-proof headers. The retry reads V2 `PAYMENT-RESPONSE`, keeps legacy fallback, and includes `payment-identifier` idempotency data when the server advertises it.

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

For a production HTTP surface, use only the explicit production aliases with
`AGENTPAY_ENVIRONMENT=production`, `AGENTPAY_HOME_CHAIN_ID=196`, and
`AGENTPAY_ACCOUNT_VERSION=v2`. Set `AGENTPAY_MAINNET_MANIFEST_PATH` to the copied
tracked shadow manifest when running from a published package; the repository-level
`ops/` directory is not included in the package.

## Safety Model

- Setup signatures prove wallet ownership only. They do not approve payments.
- Payments require a verified owner EIP-712 signature before execution; exact chat approval is migration-only.
- The smart account enforces token and route-target allowlists, nonces, deadlines, max spend, max native fee, calldata hash checks, and allowance reset after guarded calls.
- Keep service role keys and private keys server-side. Never paste secrets into chat.

## Packages

This CLI installs and wires the AgentPay package set:

- `@agentpay-ai/skill`
- `@agentpay-ai/shared`
- `@agentpay-ai/mcp-server`
- `@agentpay-ai/setup-web`

See the repository README for development, contract, and release commands.
