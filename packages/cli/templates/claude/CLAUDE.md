# AgentPay Instructions

Use AgentPay for owner-authorized X Layer and cross-chain stablecoin payments through the AgentPay MCP server. Guarded same-chain contract-call execution remains local/migration-only until a dedicated V2 typed authorization exists.

If AgentPay tools are unavailable and local command execution is available, ask for explicit approval before running `npx @agentpay-ai/agentpay install`. The default install connects to the authenticated consumer AgentPay MCP at `https://wallet.agentpay.site/mcp`, so users do not need Supabase, RPC, executor, deployer, or bytecode config. The separate paid public execution ASP is `https://mcp.agentpay.site/mcp` and is used only after Review & Sign. Ask them to reload or reconnect the runtime if needed, then return to the agent chat. Use `npx @agentpay-ai/agentpay doctor` only for self-hosted/operator diagnostics. Use `npx @agentpay-ai/agentpay setup-web` only for self-hosted/operator fallback when the setup/signing page cannot be served through the hosted agent flow. If command execution is unavailable, explain that AgentPay cannot be installed or checked from this session.

Hosted onboarding is X Layer mainnet only (chain ID `196`). New owners continue at `https://onboard.agentpay.site/setup`, where AgentPay sponsors exactly one smart-account deployment. The setup signature proves ownership and is not payment authorization. A new wallet starts USDT0-only with no route targets; production payments use Review & Sign. Testnet is self-hosted, staging, or development only.

Use AgentPay MCP tools only. Never bypass AgentPay with raw RPC calls, manual wallet transfers, raw LI.FI calls, shell scripts, or private-key handling.

Wallet onboarding happens in chat after install: use `prepare_wallet_creation`, give the setup signing link, wait for the user to sign, then use `check_wallet_creation`. The setup signature proves ownership only; the setup signature is not payment approval and must never be treated as approval to spend.

Use `network: "mainnet"` for hosted AgentPay. A testnet request requires an explicitly configured self-hosted, staging, or development runtime and must never be sent to hosted production.

Cross-chain routes are payment-time choices, not wallet-creation choices. Create the X Layer mainnet wallet first, then decide during quote or payment preparation whether the payment stays on that network or uses a cross-chain route.

Balance workflow: for hosted AgentPay, call `get_agent_wallet` with `network: "mainnet"`, then call `get_balance` with the same network. Report the AgentPay smart account address, network, USDT0, and native OKB balances. Never use raw wallet balances, exchange balances, or generic RPC balance as AgentPay balance.

Payment workflow: call `quote_payment_route` when previewing direct paths, cross-chain routes, source token, fee, native fee, ETA, or max spend is useful. Then call `prepare_payment`, show all returned details, open the returned `reviewUrl`, and ask the owner to use Review & Sign for the EIP-712 signature. Poll `get_payment_signature`, then hand the signed `paymentIntentId` and signature to the public paid ASP's `execute_payment`; the consumer surface never executes directly. Then call `track_payment` plus `list_payment_events` for status or audit detail. The exact approval phrase is migration-only.

For invoice payments, call `parse_invoice_payment`, show the parsed fields, and ask the user to confirm they match the invoice before preparing payment with the full returned `paymentInput`, including `paymentType`.

If the user wants a paid x402/API service but does not provide a URL, call `search_x402_services`, show Bazaar candidates, ask the user to choose one, collect required parameters, then call `prepare_x402_service_request`.

For x402 v2 `PAYMENT-REQUIRED` responses, including Bazaar-prepared responses, call `parse_x402_payment_required`, show the parsed resource and selected payment requirement, preserve `paymentType: "X402_PAYMENT"`, complete the normal Review & Sign owner-signature flow, then call `retry_x402_request` after `track_payment` returns `COMPLETED`. This attaches AgentPay receipt proof as `X-PAYMENT` and `PAYMENT-SIGNATURE`, reads V2 `PAYMENT-RESPONSE`, and includes `payment-identifier` idempotency data when advertised; do not claim universal x402 facilitator compatibility unless the merchant supports this AgentPay proof bridge.

For owner controls such as pause, unpause, executor rotation, nonce cancellation, token allowlist changes, or withdrawals, call `prepare_account_admin_transaction` and ask the owner wallet to submit the returned transaction. This is not payment approval.

For same-chain contract calls, call `prepare_contract_call` only after the user confirms the target address, calldata, max token spend, max native fee, and purpose. Show the calldata hash and require the target to be allowlisted.

Payment execution requires a valid owner EIP-712 signature. AgentPay checks source-token balance during quote and preparation; if it reports insufficient balance, explain the top-up required and do not ask for approval or Review & Sign. For LI.FI routes, call `check_route_target_allowance`; if the target is not allowlisted, call `prepare_route_target_allowance` and ask the owner wallet to submit the returned transaction before execution. Prepare first, show all payment details including route target, calldata hash when present, max spend or amount, minimum output, exact native value, max native fee, fee, ETA or deadline, purpose, and authorization hash. Send the owner to Review & Sign and execute only after the signature verifies. Contract-call execution is local/migration-only until a dedicated V2 typed authorization exists. After execution, call `track_payment` before reporting completion. Reject vague confirmations and chat-only confirmations. Use `list_payment_events` for payment audit history or lifecycle detail.
