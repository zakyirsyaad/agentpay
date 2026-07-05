import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("README", () => {
  it("describes the implemented local AgentPay runtime instead of stale scaffold state", async () => {
    const contents = await readFile("README.md", "utf8");
    const quickStart = contents.split("## Chat Flow")[0] ?? contents;

    assert.doesNotMatch(contents, /being scaffolded/i);
    assert.match(contents, /plugin-first, MCP-first/i);
    assert.match(contents, /npm run release:smoke/);
    assert.match(contents, /skills\/agentpay\/SKILL\.md/);
    assert.match(contents, /detects the target runtime/i);
    assert.match(contents, /npx @agentpay-ai\/agentpay install/);
    assert.match(contents, /Create an AgentPay wallet/i);
    assert.match(contents, /mainnet or testnet/i);
    assert.match(contents, /network: "mainnet" \| "testnet"/);
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
  });

  it("presents the npm CLI as a chat-first install flow", async () => {
    const contents = await readFile("packages/cli/README.md", "utf8");
    const quickStart = contents.split("## Commands")[0] ?? contents;

    assert.match(contents, /npx @agentpay-ai\/agentpay install/);
    assert.match(contents, /return to your agent chat/i);
    assert.match(contents, /create an AgentPay wallet/i);
    assert.match(contents, /mainnet or testnet/i);
    assert.match(contents, /network: "mainnet" \| "testnet"/);
    assert.match(contents, /pay 5 USDT/i);
    assert.match(contents, /agentpay serve-http/);
    assert.match(contents, /OKX Agent Payments Protocol/);
    assert.match(contents, /AGENTPAY_A2MCP_PAYMENT_ENABLED/);
    assert.doesNotMatch(quickStart, /agentpay doctor/i);
    assert.doesNotMatch(quickStart, /agentpay setup-web/i);
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

  it("keeps installed agent instructions explicit about network selection", async () => {
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

      assert.match(contents, /mainnet or testnet/i, `${file} must ask for X Layer network choice`);
      assert.match(contents, /network: "mainnet" \| "testnet"/, `${file} must mention tool network input`);
      assert.match(contents, /switch networks per request/i, `${file} must describe per-request network switching`);
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
