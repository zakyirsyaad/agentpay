# @agentpay-ai/setup-web

Local setup and signing web server for AgentPay wallets.

Most users start it through the CLI:

```bash
npx @agentpay-ai/agentpay setup-web
```

## What It Does

- Displays setup intent details for the human owner.
- Collects an owner signature that proves wallet ownership.
- Deploys or records the AgentPay smart account using server-side config.
- Keeps setup signatures separate from payment approval.
- Serves a no-store `/review` page for owner EIP-712 payment signatures and hands the verified signature back to the authenticated consumer without sending a payment transaction.

## Programmatic Usage

```ts
import { createSetupWebDependencies, parseSetupWebEnv, startSetupWebServer } from "@agentpay-ai/setup-web";

const config = parseSetupWebEnv(process.env);
await startSetupWebServer(createSetupWebDependencies(config));
```

## Configuration

Required values include `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `XLAYER_RPC_URL`, and `SETUP_DEPLOYER_PRIVATE_KEY`. Setup defaults to X Layer testnet (`1952`) and keeps its USDT0 + USDC faucet allowlist. The setup parser rejects a production environment or explicit mainnet chain; the production deployment surface is the dedicated Foundry V2 command, where mainnet allows only USDT0 and no route targets. Provide `AGENTPAY_ACCOUNT_BYTECODE_PATH` or `AGENTPAY_ACCOUNT_BYTECODE` for the non-upgradeable `AgentPayAccountV2`; `AGENTPAY_ACCOUNT_BYTECODE_HASH` is mandatory before any X Layer mainnet deployment and pins the exact creation artifact. Review & Sign uses `AGENTPAY_REVIEW_TOKEN_SECRET` when set (otherwise the service-role key fallback) and persists the signature handoff in Supabase.

Use a dedicated random `AGENTPAY_REVIEW_TOKEN_SECRET` in staging and production, and give the consumer MCP plus setup-web the same value. Remote `SETUP_WEB_URL` values must use HTTPS; plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1`.

Apply distributed per-source rate limiting at the trusted reverse proxy before the Node process. The application keeps bounded per-client and per-token secondary limits. It trusts a forwarded client address only when the direct peer is loopback, and then uses only the right-most `X-Forwarded-For` hop so a client-controlled prefix cannot rotate the application identity. Keep the Node listener private and configure the loopback proxy to overwrite the header with its observed client address (recommended, for example `proxy_set_header X-Forwarded-For $remote_addr`) or append that observed address as the final hop. Reverse proxies and observability pipelines must also redact the `x-agentpay-review-token` request header.

`startSetupWebServer` overwrites the internal review client identity from trusted socket metadata. A custom HTTP adapter that exposes `createSetupWebHandler` must likewise discard any inbound `x-agentpay-internal-client-id` value and replace it from trusted transport metadata before forwarding the request.

## Review & Sign Tests

Unit and HTTP integration tests:

```bash
npm run test --workspace @agentpay-ai/setup-web
```

Browser integration gate using a deterministic unfunded EIP-1193 wallet fixture:

```bash
npx playwright install chromium
npm run test:e2e
```

Set `AGENTPAY_E2E_BROWSER_CHANNEL=chrome` when intentionally testing against an installed Chrome channel instead of the Playwright-managed Chromium binary.

The browser gate covers the canonical prepare-to-signature handoff, owner and chain changes, expiry, wallet rejection, lost responses, idempotent retry, conflict handling, fragment removal, and the absence of transaction RPC calls. It does not access Supabase, an external RPC, a funded wallet, or the public paid ASP.
