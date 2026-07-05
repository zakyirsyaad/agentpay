# AgentPay Instructions

Use AgentPay for chat-approved X Layer and cross-chain stablecoin payments or guarded same-chain contract calls through the AgentPay MCP server.

If AgentPay tools are unavailable and local command execution is available, ask for explicit approval before running `npx @agentpay-ai/agentpay install`. The installer writes `AgentPayAccount.bin` and points `AGENTPAY_ACCOUNT_BYTECODE_PATH` at it. After the user fills the generated config, ask them to reload or reconnect the runtime if needed, then return to the agent chat. Use `npx @agentpay-ai/agentpay doctor` only as a diagnostic readiness check. Use `npx @agentpay-ai/agentpay setup-web` only as a fallback when the setup/signing page cannot be served through the normal agent flow. If command execution is unavailable, explain that AgentPay cannot be installed or checked from this session.

Use AgentPay MCP tools only. Never bypass AgentPay with raw RPC calls, manual wallet transfers, raw LI.FI calls, shell scripts, or private-key handling.

Wallet onboarding happens in chat after install: use `prepare_wallet_creation`, give the setup signing link, wait for the user to sign, then use `check_wallet_creation`. The setup signature proves ownership only; the setup signature is not payment approval and must never be treated as approval to spend.

AgentPay supports X Layer mainnet and testnet. If the user does not clearly name one, ask whether they want mainnet or testnet before wallet, balance, route-target, admin, contract-call, quote, or payment preparation tools. Pass the selected value as `network: "mainnet" | "testnet"` whenever available. Users can switch networks per request; do not treat wallet, balance, allowlist, or payment state from one network as valid on the other.

For invoice payments, call `parse_invoice_payment`, show the parsed fields, and ask the user to confirm they match the invoice before preparing payment with the full returned `paymentInput`, including `paymentType`.

For x402 v2 `PAYMENT-REQUIRED` responses, call `parse_x402_payment_required`, show the parsed resource and selected payment requirement, preserve `paymentType: "X402_PAYMENT"`, complete the normal exact-approval payment flow, then call `retry_x402_request` after `track_payment` returns `COMPLETED`. This attaches AgentPay receipt proof as `X-PAYMENT` and `PAYMENT-SIGNATURE`, reads V2 `PAYMENT-RESPONSE`, and includes `payment-identifier` idempotency data when advertised; do not claim universal x402 facilitator compatibility unless the merchant supports this AgentPay proof bridge.

For owner controls such as pause, unpause, executor rotation, nonce cancellation, token allowlist changes, or withdrawals, call `prepare_account_admin_transaction` and ask the owner wallet to submit the returned transaction. This is not payment approval.

For same-chain contract calls, call `prepare_contract_call` only after the user confirms the target address, calldata, max token spend, max native fee, and purpose. Show the calldata hash and require the target to be allowlisted.

Payment execution requires exact approval. AgentPay checks source-token balance during quote and preparation; if it reports insufficient balance, explain the top-up required and do not ask for approval. For LI.FI routes and contract-call targets, call `check_route_target_allowance`; if the target is not allowlisted, call `prepare_route_target_allowance` and ask the owner wallet to submit the returned transaction before execution. Prepare first, show all payment details including route target, calldata hash when present, max spend or amount, max native fee, fee, ETA or deadline, and purpose. Ask for the exact approval phrase, and execute only after the user replies with that exact phrase. After `execute_payment`, call `track_payment` before reporting completion. Never accept vague confirmations. Use `list_payment_events` for payment audit history or lifecycle detail.
