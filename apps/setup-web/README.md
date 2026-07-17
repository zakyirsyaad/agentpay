# @agentpay-ai/setup-web

Local setup and signing web server for AgentPay wallets.

The hosted onboarding surface is X Layer mainnet only (chain ID `196`) at `https://onboard.agentpay.site/setup`. AgentPay sponsors exactly one smart-account deployment. The setup signature proves ownership and is not payment authorization. A new account starts USDT0-only with no route targets; production payments continue through **Review & Sign**. Testnet is self-hosted, staging, or development only.

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

The legacy self-hosted setup command requires `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `XLAYER_RPC_URL`, and `SETUP_DEPLOYER_PRIVATE_KEY`; its testnet mode is for self-hosted, staging, or development use. Hosted production instead runs separate onboarding-web and setup-worker processes with scoped JWTs, pinned manifest/runtime artifacts, a dedicated sponsor signer, encrypted persist-before-broadcast outbox, and fail-closed readiness. Provide `AGENTPAY_ACCOUNT_BYTECODE_PATH` or `AGENTPAY_ACCOUNT_BYTECODE` for the non-upgradeable `AgentPayAccountV2`; mainnet requires exact creation/runtime artifact hashes. Review & Sign uses a dedicated `AGENTPAY_REVIEW_TOKEN_SECRET` and persists only the scoped signature handoff.

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
