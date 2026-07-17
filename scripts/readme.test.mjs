import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("README", () => {
  it("describes the implemented local AgentPay runtime instead of stale scaffold state", async () => {
    const contents = await readFile("README.md", "utf8");
    const quickStart = contents.split("## Production Services")[0] ?? contents;

    assert.doesNotMatch(contents, /being scaffolded/i);
    assert.match(contents, /plugin-first, MCP-first/i);
    assert.match(contents, /npm run release:smoke/);
    assert.match(contents, /skills\/agentpay\/SKILL\.md/);
    assert.match(contents, /detects the target runtime/i);
    assert.match(contents, /npx @agentpay-ai\/agentpay install/);
    assert.match(contents, /https:\/\/mcp\.agentpay\.site\/mcp/);
    assert.match(contents, /READY\/PUBLIC/);
    assert.match(contents, /https:\/\/wallet\.agentpay\.site\/mcp/);
    assert.match(contents, /https:\/\/setup\.agentpay\.site\/review/);
    assert.match(contents, /https:\/\/mcp\.agentpay\.site\/healthz/);
    assert.match(contents, /https:\/\/mcp\.agentpay\.site\/readyz/);
    assert.match(contents, /marketplace listing.*under review/i);
    assert.doesNotMatch(contents, /currently `DEPLOYED`\/`OFF`/i);
    assert.doesNotMatch(contents, /public execution remain blocked/i);
    assert.match(contents, /Technical production readiness is complete\. The OKX\.AI marketplace listing for AgentPay #4138 remains under review as a separate external approval; this README does not claim that the listing is approved\./);
    assert.doesNotMatch(contents, /marketplace listing (?:is )?(?:approved|live)/i);
    assert.doesNotMatch(contents, /@agentpay-ai\/[\w-]+@0\.1\.(?:11|12|18)/);
    assert.match(contents, /Keep private keys and Supabase service-role keys server-side/i);
    assert.match(contents, /mainnet setup boundary remains distinct from the dedicated Foundry deployment surface/i);

    const headingOrder = [
      "Quick Start",
      "Production Services",
      "How It Works",
      "What AgentPay Supports",
      "Safety Model",
      "x402 Payments",
      "Self-Hosting",
      "Production Operator Notes",
      "Smart Account Deployment",
      "Repository Layout",
      "Development and Verification",
      "Published Packages",
    ];
    const headingIndices = headingOrder.map((heading) => contents.indexOf(`## ${heading}`));
    assert.ok(headingIndices.every((index) => index >= 0));
    assert.ok(headingIndices.every((index, position) => position === 0 || headingIndices[position - 1] < index));

    assert.match(contents, /\| Consumer MCP \| `https:\/\/wallet\.agentpay\.site\/mcp` \| Authenticated setup, balance, preparation, review, and history \| Live \|/);
    assert.match(contents, /\| Paid public ASP \| `https:\/\/mcp\.agentpay\.site\/mcp` \| Owner-signed execution \| READY\/PUBLIC \|/);
    assert.match(contents, /\| Review & Sign \| `https:\/\/setup\.agentpay\.site\/review` \| Wallet review and signing \| Live \|/);
    assert.match(contents, /\| Health \| `https:\/\/mcp\.agentpay\.site\/healthz` \| Uptime check \| Live \|/);
    assert.match(contents, /\| Readiness \| `https:\/\/mcp\.agentpay\.site\/readyz` \| Production readiness check \| READY\/PUBLIC \|/);
    assert.match(contents, /X Layer mainnet canonical USDT0 only \(chain ID `196`, no route targets\)/);
    assert.match(contents, /unsigned request to the public `\/mcp` returns HTTP `402`/i);
    assert.match(contents, /normal users do not need Supabase, RPC, executor, deployer, or bytecode config/i);
    assert.match(contents, /install --self-hosted/);
    assert.match(contents, /Create an AgentPay wallet/i);
    assert.match(contents, /X Layer mainnet/i);
    assert.match(contents, /chain ID `196`/i);
    assert.match(contents, /https:\/\/onboard\.agentpay\.site\/setup/);
    assert.match(contents, /AgentPay smart account address/i);
    assert.match(contents, /Owner.*Executor/s);
    assert.match(contents, /apps\/mcp-server/);
    assert.match(contents, /packages\/cli/);
    assert.match(contents, /agentpay serve-http/);
    assert.match(contents, /public HTTPS A2MCP|public MCP endpoint/i);
    assert.match(contents, /OKX Agent Payments Protocol/);
    assert.match(contents, /AGENTPAY_A2MCP_PAYMENT_ENABLED/);
    assert.match(contents, /PAYMENT-REQUIRED/);
    assert.doesNotMatch(contents, /docs\//);
    assert.doesNotMatch(contents, /AGENTPAY_CONCEPT/);
    assert.doesNotMatch(contents, /product blueprint/i);
    assert.doesNotMatch(quickStart, /agentpay doctor/i);
    assert.doesNotMatch(quickStart, /agentpay setup-web/i);
    assert.doesNotMatch(quickStart, /Fill the generated config/i);
  });

  it("presents the npm CLI as a chat-first install flow", async () => {
    const contents = await readFile("packages/cli/README.md", "utf8");
    const quickStart = contents.split("## Commands")[0] ?? contents;

    assert.match(contents, /npx @agentpay-ai\/agentpay install/);
    assert.match(contents, /return to your agent chat/i);
    assert.match(contents, /https:\/\/mcp\.agentpay\.site\/mcp/);
    assert.match(contents, /No user secrets are required|do not manage Supabase/i);
    assert.match(contents, /install --self-hosted/);
    assert.match(contents, /create an AgentPay wallet/i);
    assert.match(contents, /X Layer mainnet/i);
    assert.match(contents, /chain (?:ID )?`?196`?/i);
    assert.match(contents, /https:\/\/onboard\.agentpay\.site\/setup/);
    assert.match(contents, /pay 5 USDT/i);
    assert.match(contents, /agentpay serve-http/);
    assert.match(contents, /OKX Agent Payments Protocol/);
    assert.match(contents, /AGENTPAY_A2MCP_PAYMENT_ENABLED/);
    assert.doesNotMatch(quickStart, /agentpay doctor/i);
    assert.doesNotMatch(quickStart, /agentpay setup-web/i);
    assert.doesNotMatch(quickStart, /config\.json/);
  });

  it("keeps public AgentPay docs aligned to X Layer for the OKX branch", async () => {
    const files = [
      "README.md",
      "packages/cli/README.md",
      "packages/skill/SKILL.md",
      "apps/mcp-server/README.md",
      "packages/shared/README.md",
      "packages/cli/templates/claude/CLAUDE.md",
      "packages/cli/templates/hermes/instructions.md",
    ];

    for (const file of files) {
      const contents = await readFile(file, "utf8");

      assert.match(contents, /X Layer|XLAYER_RPC_URL|USDT0/);
      assert.doesNotMatch(contents, /\bBNB\b|BNB Chain|BNB_RPC_URL|AGENTPAY_BNB/);
    }
  });

  it("keeps hosted instructions mainnet-only while reserving testnet for non-production use", async () => {
    const files = [
      "packages/skill/SKILL.md",
      "packages/cli/templates/codex/AGENTS.md",
      "packages/cli/templates/claude/CLAUDE.md",
      "packages/cli/templates/cursor/rules.md",
      "packages/cli/templates/generic/instructions.md",
      "packages/cli/templates/hermes/instructions.md",
    ];

    for (const file of files) {
      const contents = await readFile(file, "utf8");

      assert.match(contents, /X Layer mainnet/i, `${file} must name the hosted network`);
      assert.match(contents, /chain (?:ID )?`?196`?/i, `${file} must name chain 196`);
      assert.match(contents, /testnet[^.\n]*(?:self-hosted|staging|development)|(?:self-hosted|staging|development)[^.\n]*testnet/i,
        `${file} must reserve testnet for non-production use`);
      assert.doesNotMatch(contents, /ask whether (?:they|the user|the human) want(?:s)? mainnet or testnet/i,
        `${file} must not route hosted users to testnet`);
      assert.match(contents, /Cross-chain.*payment/i, `${file} must keep cross-chain as a payment-time choice`);
      assert.doesNotMatch(
        contents,
        /cross-chain route,? before creating an AgentPay wallet/i,
        `${file} must not present cross-chain as a wallet-creation option`,
      );
    }
  });

  it("publishes one consistent production mainnet onboarding contract", async () => {
    const files = [
      "README.md",
      "apps/mcp-server/README.md",
      "apps/setup-web/README.md",
      "packages/cli/README.md",
      "packages/shared/README.md",
      "packages/skill/README.md",
      "packages/skill/SKILL.md",
      "packages/cli/templates/claude/CLAUDE.md",
      "packages/cli/templates/codex/AGENTS.md",
      "packages/cli/templates/cursor/rules.md",
      "packages/cli/templates/generic/instructions.md",
      "packages/cli/templates/hermes/instructions.md",
    ];

    for (const file of files) {
      const contents = await readFile(file, "utf8");

      assert.match(contents, /X Layer mainnet/i, `${file} must name hosted mainnet`);
      assert.match(contents, /chain (?:ID )?`?196`?/i, `${file} must name chain 196`);
      assert.match(contents, /https:\/\/onboard\.agentpay\.site\/setup/, `${file} must route new owners to onboarding`);
      assert.match(contents, /sponsors (?:exactly )?one (?:smart-account )?deployment/i,
        `${file} must state the one-deployment sponsorship boundary`);
      assert.match(contents, /setup signature[^.\n]*(?:not|does not)[^.\n]*payment|not payment authorization/i,
        `${file} must separate setup from payment authorization`);
      assert.match(contents, /USDT0-only|USDT0 only/i, `${file} must state the initial token policy`);
      assert.match(contents, /no route targets/i, `${file} must state the initial route policy`);
      assert.match(contents, /Review & Sign/i, `${file} must state the production payment authorization flow`);
      assert.match(contents, /testnet[^.\n]*(?:self-hosted|staging|development)|(?:self-hosted|staging|development)[^.\n]*testnet/i,
        `${file} must keep testnet outside hosted production`);
      assert.doesNotMatch(contents, /Create an AgentPay wallet[^.\n]*testnet|(?:^|\n)Pay [^\n]*testnet/im,
        `${file} must not publish a hosted testnet quickstart`);
      assert.doesNotMatch(contents, /production[^.\n]*USDC|USDC[^.\n]*production/i,
        `${file} must not claim production USDC support`);
      assert.doesNotMatch(contents, /production (?:setup|payment)[^\n]*(?:APPROVE|approval phrase)/i,
        `${file} must not expose phrase approval as production authorization`);
      assert.doesNotMatch(contents, /https:\/\/(?:setup|onboard)\.agentpay\.site\/api\/setup-complete/i,
        `${file} must not expose the internal setup completion endpoint`);
    }
  });

  it("keeps installed agent instructions aligned to the Codex operational workflows", async () => {
    const files = [
      "packages/skill/SKILL.md",
      "packages/cli/templates/codex/AGENTS.md",
      "packages/cli/templates/claude/CLAUDE.md",
      "packages/cli/templates/cursor/rules.md",
      "packages/cli/templates/generic/instructions.md",
      "packages/cli/templates/hermes/instructions.md",
    ];

    for (const file of files) {
      const contents = await readFile(file, "utf8");

      assert.match(contents, /Use AgentPay MCP tools|Use AgentPay when/i, `${file} must route requests to AgentPay`);
      assert.match(contents, /prepare_wallet_creation/, `${file} must describe wallet setup`);
      assert.match(contents, /check_wallet_creation/, `${file} must describe wallet completion checks`);
      assert.match(contents, /get_agent_wallet[\s\S]*get_balance|get_balance[\s\S]*get_agent_wallet/, `${file} must describe balance reads through AgentPay tools`);
      assert.match(contents, /Never use raw wallet balances, exchange balances, or generic RPC balance/i, `${file} must forbid non-AgentPay balance sources`);
      assert.match(contents, /quote_payment_route/, `${file} must describe route previews`);
      assert.match(contents, /prepare_payment/, `${file} must describe payment preparation`);
      assert.match(contents, /prepare_contract_call/, `${file} must describe guarded contract calls`);
      assert.match(contents, /check_route_target_allowance/, `${file} must describe route target checks`);
      assert.match(contents, /prepare_route_target_allowance/, `${file} must describe route target owner transactions`);
      assert.match(contents, /execute_payment/, `${file} must describe execution`);
      assert.match(contents, /track_payment/, `${file} must describe tracking`);
      assert.match(contents, /list_payment_events/, `${file} must describe audit events`);
      assert.match(contents, /Reject vague confirmations|Never accept vague confirmations/i, `${file} must reject vague approvals`);
      assert.match(contents, /insufficient balance[\s\S]*do not ask for approval|do not request approval[\s\S]*insufficient balance/i, `${file} must stop on insufficient balance`);
    }
  });

  it("keeps x402 instructions on the AgentPay receipt-proof retry flow", async () => {
    const files = [
      "README.md",
      "packages/skill/SKILL.md",
      "apps/mcp-server/README.md",
      "packages/cli/templates/codex/AGENTS.md",
      "packages/cli/templates/claude/CLAUDE.md",
      "packages/cli/templates/cursor/rules.md",
      "packages/cli/templates/generic/instructions.md",
      "packages/cli/templates/hermes/instructions.md",
    ];

    for (const file of files) {
      const contents = await readFile(file, "utf8");

      assert.match(contents, /retry_x402_request|receipt-proof retry|receipt proof/i, `${file} must describe x402 retry`);
      assert.match(contents, /PAYMENT-RESPONSE/, `${file} must mention the x402 V2 settlement response header`);
      assert.match(contents, /payment-identifier/i, `${file} must mention x402 idempotency support`);
      assert.match(contents, /search_x402_services|Bazaar/i, `${file} must describe x402 Bazaar discovery`);
      assert.match(
        contents,
        /prepare_x402_service_request|no URL|without a URL/i,
        `${file} must describe the no-URL x402 flow`,
      );
      assert.doesNotMatch(
        contents,
        /AgentPay can prepare the returned transfer, but standard x402 exact endpoints still require/i,
        `${file} must not describe x402 as parse-only`,
      );
    }
  });
});
