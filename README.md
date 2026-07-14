# AgentPay

Owner-authorized stablecoin payments for AI agents.

AgentPay is a plugin-first, MCP-first payment runtime that lets an AI agent prepare X Layer stablecoin payments while the owner keeps cryptographic authorization. It supports owner-signed direct same-chain USDT0/USDC transfers, owner-signed LI.FI swap and bridge routes, invoice parsing, x402 Bazaar service discovery, x402 payment parsing plus AgentPay receipt-proof retry, legacy/local guarded same-chain contract calls, and audit-friendly payment tracking.

## Quick Start

Install AgentPay into a Codex, Claude, Cursor, Hermes, or generic MCP runtime:

```bash
npx @agentpay-ai/agentpay install
```

The installer detects the target runtime when possible, accepts `--runtime codex|claude|cursor|generic|hermes`, installs runtime MCP config, and copies `skills/agentpay/SKILL.md`. By default the MCP config points to the authenticated consumer endpoint `https://wallet.agentpay.site/mcp`, so normal users do not need Supabase, RPC, executor, deployer, or bytecode config. Claude, Cursor, and Hermes installs also upsert `agentpay` into their native MCP config files so those runtimes can discover AgentPay tools directly. The separate paid public execution ASP is hosted at `https://mcp.agentpay.site/mcp` and is only used after Review & Sign.

Reload or reconnect the agent runtime if needed. After that, return to chat and ask naturally:

```txt
Create an AgentPay wallet for me on X Layer testnet.
```

AgentPay supports X Layer mainnet and testnet. If the user does not name one, the agent should ask for mainnet or testnet before creating a wallet, checking balance, preparing admin actions, or preparing payments. Agent tools accept `network: "mainnet" | "testnet"` so users can switch networks per request without changing the install command.

Cross-chain routes are selected during quote or payment preparation, not during wallet setup. Create an X Layer mainnet or X Layer testnet AgentPay wallet first, then decide whether a specific payment stays on that network or uses a cross-chain route.

## Chat Flow

Wallet setup is driven from chat:

1. The user asks the agent to create an AgentPay wallet.
2. The agent confirms the target X Layer network when it is ambiguous.
3. The agent calls `prepare_wallet_creation` with the selected network and sends the setup signing link.
4. The user signs in the browser wallet. This proves ownership only; it does not approve a payment.
5. The agent calls `check_wallet_creation`.
6. The agent returns the AgentPay smart account address.
7. The user funds that smart account with supported USDT0/USDC on the same network.

Payments also stay in chat, with the owner signing the immutable payment details:

1. The user asks to pay a wallet, invoice, x402 prompt, paid API/service without a URL, route, or supported contract call.
2. The agent confirms or carries forward the selected X Layer network, checks balance, parses inputs, quotes routes when useful, and calls `prepare_payment` or `prepare_contract_call`.
3. The agent shows recipient, amount, token, chain, route, max spend, minimum output, exact native value, deadline, purpose, and the canonical EIP-712 authorization when the session is trusted.
4. The owner opens the returned **Review & Sign** URL and signs the server-derived EIP-712 authorization in the wallet. The signature is the only payment authorization.
5. The agent calls `get_payment_signature` to retrieve the tenant-scoped handoff, then hands the signed authorization to the public paid ASP's `execute_payment` tool, which verifies it and executes once before `track_payment` reports status.

Chat phrases such as `yes`, `ok`, or `APPROVE pay_123` are not payment authorization on the public/V2 surface. Exact approval phrases remain only as a local migration compatibility path.

## Safety Model

AgentPay separates ownership from execution.

- Owner: the user's wallet that signs setup and submits admin transactions. Only the owner can pause, unpause, rotate the executor, allowlist tokens or route targets, cancel nonces, and withdraw funds.
- Executor: the relayer wallet that submits prepared payment transactions. It can execute only through AgentPayAccountV2's guarded methods and only after the owner signature verifies.
- Smart account guards: token allowlists, route-target allowlists, nonce checks, deadlines, max token spend, max native fee, calldata hash checks, balance checks, pause control, and approval reset after guarded calls.
- Offchain guards: Supabase stores setup intents, tenant-bound payment intents, typed-data limits, status transitions, and `payment_events` audit history. Legacy approval phrases are retained only for migration records.
- x402 support can search Bazaar with `search_x402_services` when the user does not provide a URL, prepare the selected service with `prepare_x402_service_request`, parse v2 `PAYMENT-REQUIRED`, execute an owner-signed AgentPay payment, and retry the protected resource with `X-PAYMENT` / `PAYMENT-SIGNATURE` headers containing an AgentPay receipt proof. The retry reads the V2 `PAYMENT-RESPONSE` header, keeps legacy `X-PAYMENT-RESPONSE` fallback, and appends `payment-identifier` idempotency data when the server advertises it. Strict standard x402 exact endpoints must support that AgentPay receipt proof bridge or use their native signer/facilitator path.

`doctor`, `setup-web`, `mcp`, and `serve-http` are self-hosted/operator commands, not the main user chat flow. Use `npx @agentpay-ai/agentpay install --self-hosted` when you intentionally want local operator config and bytecode, `npx @agentpay-ai/agentpay doctor` for self-hosted diagnostics, `npx @agentpay-ai/agentpay setup-web` only as a self-hosted fallback, and `npx @agentpay-ai/agentpay serve-http` when deploying a public MCP endpoint behind HTTPS for A2MCP listing.

## Public A2MCP Endpoint

For OKX.AI A2MCP registration, deploy AgentPay behind a public HTTPS domain and run the Streamable HTTP MCP transport:

```bash
npx @agentpay-ai/agentpay serve-http --host 0.0.0.0 --port 3001
```

Expose `/mcp` through your HTTPS reverse proxy or platform route, and use `/healthz` for uptime checks. The Node server listens over HTTP internally; TLS should terminate at the deployment platform, load balancer, or reverse proxy.

For OKX.AI listing, protect `/mcp` with the **OKX Agent Payments Protocol** seller gate. Set `AGENTPAY_A2MCP_PAYMENT_ENABLED=true`, `AGENTPAY_A2MCP_PAYMENT_PAY_TO`, `AGENTPAY_A2MCP_PAYMENT_PRICE`, and OKX facilitator credentials (`OKX_APP_API_KEY`, `OKX_APP_SECRET_KEY`, `OKX_APP_PASSPHRASE`) or `AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL`. Unpaid MCP calls then return HTTP `402` with `PAYMENT-REQUIRED`; paid calls are verified, settled, and returned with `PAYMENT-RESPONSE`. `/healthz` remains free.

## Repository Layout

- `apps/mcp-server/` - AgentPay MCP tools, runtime wiring, Supabase, Ethers, and LI.FI adapters.
- `apps/setup-web/` - setup/signing web server for wallet ownership proof and account deployment.
- `packages/cli/` - published `@agentpay-ai/agentpay` installer and runtime templates.
- `packages/skill/` - AgentPay `SKILL.md` and OpenAI/Codex metadata.
- `packages/shared/` - schemas, chain/token metadata, approval helpers, and intent types.
- `contracts/` - Foundry smart account, deploy scripts, and Solidity tests.
- `supabase/migrations/` - tables, indexes, RLS, setup intents, payment intents, wallets, and audit events.

## Development Commands

Use workspace-specific tests while iterating, then run the full checks before handoff.

```bash
npm test
npm run test:e2e
npm run typecheck
npm run build
npm run demo:local
npm run release:smoke
npm audit --audit-level=high
```

Useful targeted commands:

```bash
npm --workspace @agentpay-ai/mcp-server test
npm --workspace @agentpay-ai/setup-web test
npm run test:e2e
npm --workspace @agentpay-ai/agentpay test
cd contracts && forge test
cd contracts && forge fmt --check
```

`npm run demo:local` runs an in-memory wallet setup and migration-compatible local payment flow with no Supabase, RPC credentials, or private keys.

`npm run release:smoke` packs `@agentpay-ai/skill`, `@agentpay-ai/shared`, `@agentpay-ai/mcp-server`, `@agentpay-ai/setup-web`, and `@agentpay-ai/agentpay` into local tarballs, installs them into a temporary project, verifies the hosted MCP config, then runs `agentpay install --self-hosted` plus `agentpay doctor` with dummy non-secret config. Run it before publishing npm packages.

## Self-Hosted Configuration

Hosted user installs do not require local config. The self-hosted config and server environment use these core values:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `XLAYER_RPC_URL` as the fallback RPC
- `XLAYER_MAINNET_RPC_URL` and `XLAYER_TESTNET_RPC_URL` for per-request network switching
- `EXECUTOR_PRIVATE_KEY`
- `SETUP_DEPLOYER_PRIVATE_KEY`
- `AGENTPAY_ACCOUNT_BYTECODE_PATH` or `AGENTPAY_ACCOUNT_BYTECODE`
- `AGENTPAY_ACCOUNT_VERSION=v2` and `AGENTPAY_ACCOUNT_BYTECODE_HASH` (mandatory for X Layer mainnet deployment)

Optional values include `SETUP_WEB_URL`, `LIFI_API_KEY`, `AGENTPAY_OWNER_ADDRESS`, `AGENTPAY_EXECUTOR_ADDRESS`, `AGENTPAY_HOME_CHAIN_ID`, X Layer token overrides, `AGENTPAY_INITIAL_ROUTE_TARGETS`, and `SETUP_WEB_PORT`.

X Layer testnet defaults to the OKX faucet stablecoins: USDT0 `0x9e29b3AaDa05Bf2D2c827Af80Bd28Dc0b9b4FB0c` and USDC `0xcB8BF24c6cE16Ad21D707c9505421a17f2bec79D`. Use `AGENTPAY_XLAYER_TESTNET_USDT0_ADDRESS` and `AGENTPAY_XLAYER_TESTNET_USDC_ADDRESS` only when you intentionally want custom test tokens.

Use `X402_BAZAAR_FACILITATOR_URL` to override the default x402 Bazaar facilitator.

Use `AGENTPAY_A2MCP_PAYMENT_*` and `OKX_APP_*` only for the public A2MCP seller endpoint. Keep these values server-side; they are not needed for local stdio MCP installs.

Production is a separate, readiness-gated surface: set `AGENTPAY_ENVIRONMENT=production`, `AGENTPAY_HOME_CHAIN_ID=196`, `AGENTPAY_ACCOUNT_VERSION=v2`, `SUPABASE_PRODUCTION_URL`, `SUPABASE_PRODUCTION_SERVICE_ROLE_KEY`, and `XLAYER_MAINNET_RPC_URL`. The hosted surface uses the activated mainnet manifest and an operator-seeded singleton identity; it is currently `DEPLOYED`/`OFF`, so liveness is up but `/readyz` and public execution remain blocked until the account, contract, and canary gates are approved. `DIRECT_URL_PRODUCTION` is migration-admin-only. Production stdio and setup-web deployment remain disabled until their deployment gate is approved.
Mainnet x402 payment cannot be enabled on a non-production or testnet public HTTP surface; the server rejects that mixed boundary at startup.

Keep private keys and Supabase service-role keys server-side. Never paste secrets into chat.

## Smart Account Deployment

The setup web flow deploys the non-upgradeable owner-signed `AgentPayAccountV2`. Mainnet deployment is currently disabled at the setup boundary; the dedicated Foundry mainnet surface allows only X Layer USDT0 and no route targets. Testnet setup defaults to the OKX faucet USDT0 and USDC. The deployer rejects stale V1 or hybrid bytecode by checking the V2 selector fingerprint; X Layer mainnet additionally requires the exact creation-bytecode hash and explicit mainnet RPC mapping.

For the approved mainnet Foundry surface, set `XLAYER_MAINNET_RPC_URL`, `SETUP_DEPLOYER_PRIVATE_KEY`, `AGENTPAY_OWNER_ADDRESS`, and `AGENTPAY_EXECUTOR_ADDRESS`, then run:

```bash
npm run contracts:deploy:xlayer
```

For testnet-only deployment, use `XLAYER_TESTNET_RPC_URL` and:

```bash
npm run contracts:deploy:xlayer:testnet
```

Use `npm run contracts:bytecode` when developing contracts and refreshing the packaged bytecode asset in `packages/cli/assets/AgentPayAccount.bin`.

## Published Packages

- `@agentpay-ai/agentpay` - CLI installer and `agentpay` binary.
- `@agentpay-ai/skill` - agent skill pack.
- `@agentpay-ai/shared` - shared schemas and helpers.
- `@agentpay-ai/mcp-server` - MCP server runtime and tools.
- `@agentpay-ai/setup-web` - setup and signing web server.

External launch steps still require explicit operator approval for Supabase setup, X Layer deployment, npm publishing, and demo capture.
