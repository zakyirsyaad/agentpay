# @agentpay-ai/shared

Shared schemas, chain metadata, token helpers, and intent types for AgentPay.

Hosted onboarding is X Layer mainnet only (chain ID `196`) at `https://onboard.agentpay.site/setup`. AgentPay sponsors exactly one smart-account deployment. The setup signature proves ownership and is not payment authorization. New accounts start USDT0-only with no route targets, while production payments use **Review & Sign**. Testnet is self-hosted, staging, or development only.

Use this package when building AgentPay-compatible tools that need the same validation rules as the MCP server, setup web, and CLI.

## Included Modules

- Legacy approval phrase parsing and payment intent types.
- Canonical AgentPayAccountV2 EIP-712 typed-data builders and authorization schemas.
- Opaque Review & Sign token and signature-handoff schemas.
- X Layer stablecoin metadata and balance helpers.
- Wallet setup, invoice, x402, x402 Bazaar discovery, account admin, and payment tracking schemas, including x402 `PAYMENT-RESPONSE` and `payment-identifier` proof helpers.
- Mainnet wallet-setup typed data that binds factory provenance, deterministic account address, runtime hashes, canonical USDT0, empty routes, and the sponsored deployment deadline.
- Route calldata hashing helpers used by guarded contract calls.

## Example

```ts
import { preparePaymentInputSchema } from "@agentpay-ai/shared";

const input = preparePaymentInputSchema.parse(candidatePayment);
```

AgentPay validates untrusted inputs at runtime boundaries with Zod. Keep that pattern when extending the package.
