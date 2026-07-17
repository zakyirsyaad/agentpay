---
name: agentpay
description: Use AgentPay MCP tools when a user wants an AI agent to create an AgentPay wallet, check balance, prepare a stablecoin payment, swap, bridge, pay across chains, or track payment status. Requires a verified owner EIP-712 signature before execution.
---

# AgentPay

AgentPay is an MCP payment plugin for owner-authorized cross-chain payments from an X Layer smart account.

Use this skill when the user asks to create an AgentPay wallet, pay a wallet or invoice, swap and bridge funds, send USDT/USDC, check balance, or track an AgentPay transaction.

## Scope

Use only AgentPay MCP tools for AgentPay actions.

Do not bypass AgentPay with raw RPC calls, manual wallet transfers, raw LI.FI calls, browser automation, shell scripts, or private-key handling.

The public install command is:

```bash
npx @agentpay-ai/agentpay install
```

The install command only installs/configures the MCP plugin and instructions. It must not create a wallet, deploy a smart account, sign messages, approve payments, or move funds.

Default installs connect to the authenticated consumer AgentPay MCP endpoint at `https://wallet.agentpay.site/mcp`. Users do not need Supabase, RPC, executor, deployer, or bytecode config for normal chat usage. The separate paid public execution ASP is `https://mcp.agentpay.site/mcp` and is used only after Review & Sign.

Hosted onboarding is X Layer mainnet only (chain ID `196`). New owners continue at `https://onboard.agentpay.site/setup`, where AgentPay sponsors exactly one smart-account deployment. The setup signature proves ownership and is not payment authorization. A new wallet starts USDT0-only with no route targets. Production payments use **Review & Sign**. Testnet is self-hosted, staging, or development only.

After installation, ask the user to reload or reconnect the agent runtime if needed. Then return to the agent chat and continue with wallet creation or payment using AgentPay MCP tools.

Use this diagnostic command only when checking self-hosted/operator configuration readiness or troubleshooting:

```bash
npx @agentpay-ai/agentpay doctor
```

This checks self-hosted MCP and setup-web readiness without starting services or printing secret values.

Use this fallback command only for self-hosted/operator mode when the setup/signing page needs to be served outside the hosted agent tool flow:

```bash
npx @agentpay-ai/agentpay setup-web
```

## If AgentPay Is Not Installed

If the user asks for a crypto payment and AgentPay MCP tools are unavailable:

1. Do not attempt the payment.
2. If you have terminal/local command access, ask for explicit approval before installing:

```txt
I can install AgentPay by running `npx @agentpay-ai/agentpay install`.
This will modify local MCP/runtime configuration. Do you approve?
```

3. Only after approval, run:

```bash
npx @agentpay-ai/agentpay install
```

4. Ask the user to reload or reconnect the runtime if needed, then return to the agent chat. Do not ask normal users to fill local Supabase, RPC, executor, deployer, or bytecode config.
5. If you do not have terminal/local command access, explain that AgentPay cannot be installed or checked from this session.
6. Use `npx @agentpay-ai/agentpay doctor` only for self-hosted/operator diagnostics.
7. Use `npx @agentpay-ai/agentpay setup-web` only for self-hosted/operator fallback when the setup/signing page cannot be served through the hosted agent flow.
8. Continue in chat with wallet creation by calling `prepare_wallet_creation` and `check_wallet_creation`.

## Available MCP Tools

Expected AgentPay tools:

- `prepare_wallet_creation`: create a setup intent and return a signing link.
- `check_wallet_creation`: check whether the setup intent has completed and return the AgentPay smart account address.
- `get_agent_wallet`: return owner, executor, smart account address, home chain, and status.
- `get_balance`: read USDT/USDC and relevant native balances.
- `parse_invoice_payment`: parse structured invoice text into `prepare_payment` fields.
- `search_x402_services`: search x402 Bazaar when the user wants a paid API/service but does not provide a URL.
- `prepare_x402_service_request`: prepare a selected x402 Bazaar HTTP resource and synthetic `PAYMENT-REQUIRED` object.
- `parse_x402_payment_required`: parse a v2 x402 `PAYMENT-REQUIRED` object or header into `prepare_payment` fields.
- `retry_x402_request`: retry a protected x402 HTTP resource with AgentPay receipt-proof headers after the matching payment is complete.
- `prepare_contract_call`: prepare a guarded same-chain contract call intent with calldata hash review.
- `quote_payment_route`: quote a direct or LI.FI swap + bridge + pay route without creating an intent.
- `check_route_target_allowance`: check whether a LI.FI route target is already allowlisted.
- `prepare_route_target_allowance`: prepare the owner transaction that allows or revokes a LI.FI route target.
- `prepare_account_admin_transaction`: prepare owner transactions for pause, unpause, executor rotation, nonce cancellation, token allowlist updates, and withdrawals.
- `prepare_payment`: create a payment intent and, for trusted consumer sessions, return a server-generated Review & Sign URL plus canonical EIP-712 typed data. The legacy approval phrase is migration-only.
- `get_payment_signature`: poll the tenant-scoped Review & Sign handoff and return the verified owner signature without executing a payment.
- `execute_payment`: execute a prepared payment with the owner signature on the public paid ASP. The authenticated consumer only prepares and reviews; approval text is local/migration-only and is not public payment authorization.
- `track_payment`: track source and destination transaction status.
- `list_transactions`: show recent payment intents and transactions.
- `list_payment_events`: show lifecycle audit events for a specific payment intent.

If a tool name differs in the active MCP server, use the closest AgentPay tool with the same purpose.

## Network Selection

Use X Layer mainnet and `network: "mainnet"` for hosted AgentPay. If the user requests testnet, explain that it requires an explicitly configured self-hosted, staging, or development runtime; never send a testnet request to hosted production.

Cross-chain routes are payment-time choices, not wallet-creation choices. Create the X Layer mainnet wallet first, then decide during quote or payment preparation whether the payment stays on that network or uses a cross-chain route.

## Wallet Creation Workflow

When the user asks to create an AgentPay wallet:

1. Use X Layer mainnet (chain ID `196`) for the hosted flow.
2. Call `prepare_wallet_creation` with `network: "mainnet"`.
3. Give the user the fixed hosted onboarding link returned by AgentPay; new owners continue at `https://onboard.agentpay.site/setup`.
4. Explain that the setup signature proves wallet ownership and is not payment authorization.
5. Wait for the user to sign on the setup page.
6. Call `check_wallet_creation`.
7. When complete, show the AgentPay smart account address and network, then tell the user to fund it with supported tokens on that X Layer network.

Never claim the wallet is ready until `check_wallet_creation` confirms completion.

## Owner Admin Workflow

Use `prepare_account_admin_transaction` for emergency or owner-control requests such as pause, unpause, executor rotation, nonce cancellation, token allowlist updates, or withdrawals.

Show the action, account address, owner address, chain, transaction target, and calldata before asking the owner wallet to submit it. Make clear that admin transactions are not payment approvals.

## Balance Workflow

When the user asks about funds or before preparing payment:

1. Use X Layer mainnet for hosted AgentPay; testnet requires a self-hosted, staging, or development runtime.
2. Call `get_agent_wallet` with `network: "mainnet"` if the active wallet is unknown.
3. Call `get_balance` with the same network.
4. Show balances with token symbols, chain names, and wallet address.

Never use raw wallet balances, exchange balances, or generic RPC balance as AgentPay balance. AgentPay balance means the balance returned by `get_balance` for the AgentPay smart account on the selected network.

If the wallet is not created, use the wallet creation workflow first.

## Invoice Workflow

When the user asks to pay an invoice:

1. Call `parse_invoice_payment` with the copied invoice text.
2. Show the parsed recipient, amount, token, destination chain, source token, and purpose.
3. Ask the user to confirm the parsed fields match the invoice.
4. Continue with the normal payment workflow using the full parsed `paymentInput`, including its `paymentType`.

Do not infer missing invoice fields from vague prose. Ask the user for a complete invoice or the missing field.

## x402 Workflow

If the user asks for a paid x402/API service but does not provide a URL, call `search_x402_services` first. Show the Bazaar candidates, ask the user to choose one, collect required parameters, then call `prepare_x402_service_request`. Use the returned `paymentRequired` and `request` with the normal x402 flow below.

When an HTTP endpoint returns an x402 v2 `PAYMENT-REQUIRED` response:

1. Call `parse_x402_payment_required` with the copied response object or base64 header.
2. Show the resource, scheme, network, token, amount, recipient, and timeout.
3. Tell the user that AgentPay can prepare the stablecoin transfer with the returned `paymentInput`.
4. Continue with the normal payment workflow using the full returned `paymentInput`, including its `paymentType`.
5. After `execute_payment` and `track_payment` return `COMPLETED`, call `retry_x402_request` with the original `PAYMENT-REQUIRED` object/header and the completed `paymentIntentId`.
6. Return the protected resource response to the user when the retry succeeds.

`retry_x402_request` attaches the AgentPay receipt proof as both `X-PAYMENT` and `PAYMENT-SIGNATURE`, reads V2 `PAYMENT-RESPONSE` with legacy `X-PAYMENT-RESPONSE` fallback, and adds `payment-identifier` idempotency data when the server advertises it. Do not claim universal x402 exact facilitator compatibility unless the merchant supports this AgentPay receipt-proof bridge or the integration uses a native x402 signer/facilitator path.

## Contract Call Workflow

Use `prepare_contract_call` only for same-chain X Layer contract calls where the user provides or confirms the target address, calldata, maximum token spend, and purpose.

Before execution:

1. Show the target address, source token, max token spend, max native fee, calldata hash, deadline, and purpose.
2. Call `check_route_target_allowance` for the contract target.
3. If the target is not allowlisted, call `prepare_route_target_allowance` and ask the owner wallet to submit that owner transaction first.
4. Treat contract-call execution as legacy/local-only until a dedicated owner-signed V2 authorization exists. Do not expose phrase-based contract-call execution on the public surface.

Never prepare contract calls from vague prose, never modify calldata after preparation, and never execute against a target that AgentPay reports as not allowlisted.

## Payment Workflow

For every payment:

1. Understand the requested recipient, amount, token, X Layer mainnet source, destination chain, and purpose. Testnet is allowed only on a self-hosted, staging, or development runtime.
2. Call `quote_payment_route` when route preview is useful or the source/destination token or chain may differ.
3. Call `prepare_payment`.
4. Show the returned payment summary to the user. When `authorization` is present, show the canonical typed-data details and exact `authorizationHash`.
5. Open the returned `reviewUrl` for the owner. The connected wallet must use **Review & Sign** to sign the server-derived EIP-712 authorization. Do not let the agent, session, or x402 credential replace this signature.
6. Poll `get_payment_signature` until it returns the verified 65-byte owner signature, then hand the `paymentIntentId` and signature to the public paid ASP and call its `execute_payment` tool. The authenticated consumer does not execute payments directly.
7. Call `track_payment` until the payment reaches a clear completed, failed, or still-executing state.
8. Call `list_payment_events` when the user asks for audit history, failure detail, or lifecycle evidence for a payment.

The summary shown before approval must include:

- Recipient address.
- Amount and destination token.
- Source token and source chain.
- Destination chain.
- Max source spend.
- Max native fee.
- Payment path/provider and route summary.
- Route target and calldata hash for LI.FI routes.
- Estimated fee.
- Estimated ETA.
- Deadline or expiry.
- Purpose.
- Authorization hash and owner-signature status.

## Approval Rules

Payment authorization must be a valid owner EIP-712 signature over the immutable typed data returned by `prepare_payment`.

Reject vague confirmations or other chat-only messages as payment authorization:

```txt
yes
ok
go
approve
looks good
send it
```

If the owner has not signed Review & Sign, do not execute. The old `APPROVE pay_123` phrase is accepted only by an explicitly enabled local/migration adapter.

Never execute a payment if:

- The owner signature is missing, malformed, or does not recover to the verified owner.
- The intent expired.
- The recipient, amount, route, token, or chain changed after preparation.
- The user asks to skip confirmation.
- Balance is insufficient.
- AgentPay returns an error.

If the public paid ASP's `execute_payment` says the intent is already being executed or is no longer awaiting approval, do not retry the same signature. Call `track_payment` or `list_payment_events` for the current status.

## Insufficient Balance

If balance is insufficient, do not ask for approval and do not create pressure to proceed.

AgentPay checks source-token balance during `quote_payment_route`, `prepare_payment`, and `prepare_contract_call`, then checks again at signed execution. If a preparation tool reports insufficient balance, no Review & Sign request should be made.

Explain:

- Required source token amount.
- Available source token amount.
- Required native fee if relevant.
- Available native balance if relevant.
- Minimum top-up needed.

Then wait for the user to fund the wallet before preparing a new intent.

## Cross-Chain Route Rules

For LI.FI swap + bridge + pay routes:

- After quoting, call `check_route_target_allowance` for the returned route target.
- If the route target is not allowlisted, call `prepare_route_target_allowance` and ask the owner wallet to submit the returned transaction before execution.
- Explain that cross-chain delivery can take time.
- Do not guarantee completion until `track_payment` confirms it.
- Track both source and destination transaction hashes when available.
- If the route is delayed, report the current status and continue tracking if requested.

## Error Handling

Use these responses:

- AgentPay tools unavailable: follow the install workflow.
- Wallet not created: follow wallet creation workflow.
- Setup intent expired: create a new setup intent.
- Quote unavailable: explain that no supported route is available and ask for a different token/chain/amount.
- Insufficient balance: follow insufficient balance workflow.
- Signature mismatch: return to Review & Sign and prepare a fresh intent if any signed field changed.
- Intent expired: prepare a fresh payment intent.
- Execution failed: show the error, do not retry automatically, and ask whether to prepare a new intent.
- Payment executing: call `track_payment` and report the latest status.

## Security Rules

- Never request or display private keys or seed phrases.
- Never ask the user to send funds to an address that was not returned by AgentPay.
- Never modify payment details after approval.
- Never execute payment outside AgentPay MCP tools.
- Never run `npx @agentpay-ai/agentpay install` without explicit user approval when acting on the user's machine.
- Never treat installation approval as payment approval.
- Never treat setup signature as payment approval.
- Never treat an x402 parse result as payment approval or protocol settlement; retry x402 resources only after the matching payment intent is `COMPLETED`.
- Never promise that a bridge is complete until tracking confirms destination delivery.
