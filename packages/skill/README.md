# @agentpay-ai/skill

AgentPay runtime instructions for AI coding agents.

This package contains the AgentPay `SKILL.md` and OpenAI metadata used by `npx @agentpay-ai/agentpay install`. Most users should install the CLI instead of installing this package directly:

Hosted onboarding is X Layer mainnet only (chain ID `196`) at `https://onboard.agentpay.site/setup`. AgentPay sponsors exactly one smart-account deployment. The setup signature proves ownership and is not payment authorization. New accounts start USDT0-only with no route targets, and production payments use **Review & Sign**. Testnet is self-hosted, staging, or development only.

```bash
npx @agentpay-ai/agentpay install
```

After installation, users should return to their agent chat and ask for wallet creation or payment there. The agent uses AgentPay MCP tools to create setup links, prepare payments, send the owner to Review & Sign for an EIP-712 authorization, execute with the resulting signature, and track status.

## Contents

- `SKILL.md` defines AgentPay payment, setup, Review & Sign, and safety workflows.
- `agents/openai.yaml` provides Codex/OpenAI agent metadata.

## Safety Notes

The skill requires a verified human owner EIP-712 signature before payment execution, keeps wallet setup separate from payment authorization, and instructs agents not to expose secrets. Exact approval phrases are migration-only.
