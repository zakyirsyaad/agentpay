# AgentPay

Owner-authorized stablecoin payments for AI agents.

AgentPay is a plugin-first, MCP-first payment runtime for X Layer. Your agent prepares a payment in chat; you review the immutable details and authorize it with your wallet. It supports direct stablecoin payments, routes when appropriate, invoices, guarded contract calls, x402 services, and auditable payment history—without giving an agent your private key.

## Quick Start

Install it into Codex, Claude, Cursor, Hermes, or another supported MCP runtime:

```bash
npx @agentpay-ai/agentpay install
```

The installer detects the target runtime when possible (or accepts `--runtime codex|claude|cursor|generic|hermes`), installs MCP configuration, and copies `skills/agentpay/SKILL.md`. It uses the authenticated consumer MCP at `https://wallet.agentpay.site/mcp`; normal users do not need Supabase, RPC, executor, deployer, or bytecode configuration.

Reload your agent runtime, return to chat, and ask:

```txt
Create an AgentPay wallet for me on X Layer mainnet.
```

Hosted AgentPay uses X Layer mainnet only (chain ID `196`). New owners are routed to `https://onboard.agentpay.site/setup`, where AgentPay sponsors exactly one smart-account deployment. The setup signature proves ownership and is not payment authorization. A new wallet starts USDT0-only with no route targets; production payments use **Review & Sign**. Testnet remains self-hosted, staging, or development only. Cross-chain routes are selected later, when preparing a payment.

## Production Services

| Service | URL | Purpose | Status |
| --- | --- | --- | --- |
| Consumer MCP | `https://wallet.agentpay.site/mcp` | Authenticated setup, balance, preparation, review, and history | Live |
| Mainnet onboarding | `https://onboard.agentpay.site/setup` | One sponsored chain-196 smart-account deployment | Rollout-gated |
| Paid public ASP | `https://mcp.agentpay.site/mcp` | Owner-signed execution | READY/PUBLIC |
| Review & Sign | `https://setup.agentpay.site/review` | Wallet review and signing | Live |
| Health | `https://mcp.agentpay.site/healthz` | Uptime check | Live |
| Readiness | `https://mcp.agentpay.site/readyz` | Production readiness check | READY/PUBLIC |

Technical production readiness is complete. The OKX.AI marketplace listing for AgentPay #4138 remains under review as a separate external approval; this README does not claim that the listing is approved.

The public production golden path is direct X Layer mainnet canonical USDT0 only (chain ID `196`, no route targets). An unsigned request to the public `/mcp` returns HTTP `402`.

## How It Works

Wallet setup and payments remain chat-first:

1. Ask your agent to create an AgentPay wallet on X Layer mainnet.
2. The agent calls `prepare_wallet_creation`; new owners continue at `https://onboard.agentpay.site/setup`. The setup signature proves ownership and is not payment authorization.
3. The agent calls `check_wallet_creation` and returns your AgentPay smart account address. Fund it with a supported token on that network.
4. Ask to pay a wallet or invoice, use an x402 service, prepare a route, or call a supported contract.
5. The agent checks balance, parses inputs, optionally quotes a route, and calls `prepare_payment` or `prepare_contract_call`.
6. Review recipient, amount, token, chain, route, limits, deadline, and purpose at `https://setup.agentpay.site/review`, then sign the server-derived EIP-712 authorization.
7. The agent retrieves the tenant-scoped handoff with `get_payment_signature`; the paid public ASP executes once through `execute_payment`, and `track_payment` reports the result.

Words such as `yes`, `ok`, or `APPROVE pay_123` are not payment authorization on the public V2 surface. Exact approval phrases only remain for local migration compatibility.

## What AgentPay Supports

- Owner-signed direct same-chain payments and supported LI.FI swap or bridge routes. New hosted wallets start USDT0-only with no route targets.
- Invoice parsing, recipient payments, guarded same-chain contract calls, and payment tracking.
- An AgentPay smart account address for each wallet setup.
- x402 Bazaar discovery through `search_x402_services` when you do not have a URL, and selected-service preparation through `prepare_x402_service_request` with no URL required.
- x402 V2 `PAYMENT-REQUIRED` handling: AgentPay can make the owner-signed payment, retry with receipt proof, read `PAYMENT-RESPONSE` (with legacy `X-PAYMENT-RESPONSE` fallback), and preserve `payment-identifier` idempotency data when the service provides it.

## Safety Model

AgentPay separates ownership from execution.

- **Owner:** your wallet. Only the owner can pause or unpause, rotate the Executor, allowlist tokens or route targets, cancel nonces, and withdraw funds.
- **Executor:** the relayer that submits transactions. It can only use guarded `AgentPayAccountV2` methods after a valid owner signature.
- **Smart account:** token and route-target allowlists, nonce replay protection, deadlines, max token spend, max native fee, calldata-hash validation, balance checks, pause control, and guarded-call approval reset.
- **Runtime:** tenant-bound setup/payment intents, typed-data limits, status transitions, and `payment_events` audit logging.

Keep private keys and Supabase service-role keys server-side. Never paste secrets into chat.

## x402 Payments

For a service that asks for payment, AgentPay parses `PAYMENT-REQUIRED`, prepares the required owner-signed payment, and retries the protected request with an AgentPay receipt proof. Bazaar can discover a service before there is a URL, while strict standard x402 exact endpoints must support the receipt-proof bridge or use their native signer/facilitator path.

For a public HTTPS A2MCP/public MCP endpoint, run the Streamable HTTP transport behind your TLS terminator:

```bash
npx @agentpay-ai/agentpay serve-http --host 0.0.0.0 --port 3001
```

Protect `/mcp` with the **OKX Agent Payments Protocol** seller gate. Set `AGENTPAY_A2MCP_PAYMENT_ENABLED=true` plus the required `AGENTPAY_A2MCP_PAYMENT_*` and facilitator credentials. Unpaid calls return `402` with `PAYMENT-REQUIRED`; settled calls return `PAYMENT-RESPONSE`. Keep `/healthz` free.

## Self-Hosting

Hosted user installs need no local configuration. Use self-hosting only when you operate your own runtime:

```bash
npx @agentpay-ai/agentpay install --self-hosted
npx @agentpay-ai/agentpay serve-http
```

`agentpay doctor` and `agentpay setup-web` are diagnostics or self-hosted fallbacks, not the normal user path. A self-hosted deployment uses `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, X Layer RPC configuration, executor/deployer keys, and AgentPay bytecode configuration. `XLAYER_TESTNET_RPC_URL` is only for self-hosted, staging, or development use. Keep every secret server-side.

## Production Operator Notes

Production uses `AGENTPAY_ENVIRONMENT=production`, `AGENTPAY_HOME_CHAIN_ID=196`, `AGENTPAY_ACCOUNT_VERSION=v2`, production Supabase credentials, and `XLAYER_MAINNET_RPC_URL`. `DIRECT_URL_PRODUCTION` is migration-admin-only. Mainnet x402 cannot run on a non-production or testnet public HTTP surface.

The A2MCP seller configuration (`AGENTPAY_A2MCP_PAYMENT_*` and `OKX_APP_*`) belongs only on the public server, never in a local stdio install. Terminate TLS at the platform, load balancer, or reverse proxy; the Node HTTP server listens internally.

## Smart Account Deployment

The setup web flow deploys the non-upgradeable owner-signed `AgentPayAccountV2`. Its mainnet setup boundary remains distinct from the dedicated Foundry deployment surface: the former handles user setup, while the latter is the controlled production deployment path. Mainnet Foundry deployment allows only X Layer USDT0 and no route targets; testnet setup defaults to OKX faucet USDT0 and USDC.

For an approved mainnet Foundry deployment, set `XLAYER_MAINNET_RPC_URL`, `SETUP_DEPLOYER_PRIVATE_KEY`, `AGENTPAY_OWNER_ADDRESS`, and `AGENTPAY_EXECUTOR_ADDRESS`, then run:

```bash
npm run contracts:deploy:xlayer
```

For testnet-only deployment, use `XLAYER_TESTNET_RPC_URL` and `npm run contracts:deploy:xlayer:testnet`. During contract development, `npm run contracts:bytecode` refreshes the packaged bytecode asset.

## Repository Layout

- `apps/mcp-server/` — MCP tools, runtime wiring, Supabase, Ethers, and LI.FI services.
- `apps/setup-web/` — wallet setup, review, signing, and account deployment services.
- `packages/cli/` — published `@agentpay-ai/agentpay` installer, templates, and bytecode.
- `packages/skill/` — the AgentPay skill instructions.
- `packages/shared/` — schemas, token metadata, approval helpers, and intent types.
- `contracts/` — Foundry contracts, deploy scripts, mocks, and Solidity tests.
- `supabase/migrations/` — database schema migrations.

## Development and Verification

Run the focused checks while iterating, then the full gates before release:

```bash
npm test
npm run test:e2e
npm run typecheck
npm run build
npm run release:smoke
npm audit --audit-level=high
cd contracts && forge test
cd contracts && forge fmt --check
```

`npm run release:smoke` packs publishable packages, installs them in a temporary project, validates hosted MCP configuration, and exercises self-hosted installation with dummy non-secret configuration.

## Published Packages

- `@agentpay-ai/agentpay` — CLI installer and `agentpay` binary.
- `@agentpay-ai/skill` — agent skill pack.
- `@agentpay-ai/shared` — shared schemas and helpers.
- `@agentpay-ai/mcp-server` — MCP server runtime and tools.
- `@agentpay-ai/setup-web` — wallet setup and signing service.
