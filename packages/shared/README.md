# @agentpay-ai/shared

Shared schemas, chain metadata, token helpers, and intent types for AgentPay.

Use this package when building AgentPay-compatible tools that need the same validation rules as the MCP server, setup web, and CLI.

## Included Modules

- Legacy approval phrase parsing and payment intent types.
- Canonical AgentPayAccountV2 EIP-712 typed-data builders and authorization schemas.
- Opaque Review & Sign token and signature-handoff schemas.
- X Layer stablecoin metadata and balance helpers.
- Wallet setup, invoice, x402, x402 Bazaar discovery, account admin, and payment tracking schemas, including x402 `PAYMENT-RESPONSE` and `payment-identifier` proof helpers.
- Route calldata hashing helpers used by guarded contract calls.

## Example

```ts
import { preparePaymentInputSchema } from "@agentpay-ai/shared";

const input = preparePaymentInputSchema.parse(candidatePayment);
```

AgentPay validates untrusted inputs at runtime boundaries with Zod. Keep that pattern when extending the package.
