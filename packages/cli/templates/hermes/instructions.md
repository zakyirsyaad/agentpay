# AgentPay Instructions

Use AgentPay MCP tools when the user wants to create an AgentPay wallet, check balance, prepare a stablecoin payment, swap, bridge, pay across chains, execute after owner Review & Sign, or track payment status.

If the human asks you to make a crypto payment and AgentPay tools are not available, install AgentPay yourself only if you have terminal access and explicit approval to modify local runtime configuration:

```bash
npx @agentpay-ai/agentpay install
```

The default install connects to the authenticated consumer AgentPay MCP at `https://wallet.agentpay.site/mcp`, so humans do not need Supabase, RPC, executor, deployer, or bytecode config. The separate paid public execution ASP is `https://mcp.agentpay.site/mcp` and is used only after Review & Sign. Ask them to reload or reconnect the runtime if needed, then return to the agent chat. Use `npx @agentpay-ai/agentpay doctor` only for self-hosted/operator diagnostics. Use `npx @agentpay-ai/agentpay setup-web` only for self-hosted/operator fallback when the setup/signing page cannot be served through the hosted agent flow.

Hosted onboarding is X Layer mainnet only (chain ID `196`). New owners continue at `https://onboard.agentpay.site/setup`, where AgentPay sponsors exactly one smart-account deployment. The setup signature proves ownership and is not payment authorization. A new wallet starts USDT0-only with no route targets; production payments use Review & Sign. Testnet is self-hosted, staging, or development only.

Use AgentPay MCP tools only. Never bypass AgentPay with raw RPC calls, manual wallet transfers, raw LI.FI calls, shell scripts, or private-key handling.

Use `network: "mainnet"` for hosted AgentPay. A testnet request requires an explicitly configured self-hosted, staging, or development runtime and must never be sent to hosted production.

Cross-chain routes are payment-time choices, not wallet-creation choices. Create the X Layer mainnet wallet first, then decide during quote or payment preparation whether the payment stays on that network or uses a cross-chain route.

Balance workflow: for hosted AgentPay, call `get_agent_wallet` with `network: "mainnet"`, then call `get_balance` with the same network. Report the AgentPay smart account address, network, USDT0, and native OKB balances. Never use raw wallet balances, exchange balances, or generic RPC balance as AgentPay balance.

Payment workflow: call `quote_payment_route` when previewing direct paths, cross-chain routes, source token, fee, native fee, ETA, or max spend is useful. Then call `prepare_payment`, show all returned details, open the returned `reviewUrl`, and ask the owner to use Review & Sign for the EIP-712 signature. Poll `get_payment_signature`, then hand the signed `paymentIntentId` and signature to the public paid ASP's `execute_payment`; the consumer surface never executes directly. Then call `track_payment` plus `list_payment_events` for status or audit detail. The exact approval phrase is migration-only.

After installation, continue in chat: create the human's AgentPay wallet with `prepare_wallet_creation`, provide the setup signing link, use `check_wallet_creation`, help the human fund the wallet, parse invoices with `parse_invoice_payment`, preserve the returned `paymentType` when preparing parsed payments, search Bazaar with `search_x402_services` when the human wants a paid x402/API service but does not provide a URL, prepare the selected Bazaar service with `prepare_x402_service_request`, parse x402 v2 `PAYMENT-REQUIRED` responses with `parse_x402_payment_required`, preserve `paymentType: "X402_PAYMENT"`, run the Review & Sign owner-signature flow, call `retry_x402_request` after `track_payment` returns `COMPLETED`, read V2 `PAYMENT-RESPONSE`, include `payment-identifier` idempotency data when advertised, and explain that AgentPay receipt proof works when the merchant supports this proof bridge, prepare owner controls with `prepare_account_admin_transaction`, prepare payments, show max source spend, minimum output, exact native value, and max native fee before Review & Sign, use `prepare_contract_call` only to prepare a same-chain contract-call review and treat its execution as local/migration-only until a dedicated V2 typed authorization exists, explain the required top-up instead of asking for Review & Sign when AgentPay reports insufficient balance during quote or preparation, call `check_route_target_allowance` for LI.FI targets, call `prepare_route_target_allowance` when the owner needs an allowlist transaction, show target details and calldata hashes when present, call `track_payment` after execution before reporting completion, use `list_payment_events` for audit history, and never execute without a valid owner EIP-712 signature.

Reject vague confirmations like `yes`, `ok`, `go`, or `send it`; chat-only messages are not payment authorization. If balance is insufficient, do not ask for approval or Review & Sign; explain the required top-up.

The setup signature proves ownership only; the setup signature is not payment approval.

If you do not have terminal access, explain that AgentPay cannot be installed from this session.
