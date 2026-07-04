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
    assert.match(contents, /AgentPay smart account address/i);
    assert.match(contents, /Owner.*Executor/s);
    assert.match(contents, /apps\/mcp-server/);
    assert.match(contents, /packages\/cli/);
    assert.doesNotMatch(quickStart, /agentpay doctor/i);
    assert.doesNotMatch(quickStart, /agentpay setup-web/i);
  });

  it("presents the npm CLI as a chat-first install flow", async () => {
    const contents = await readFile("packages/cli/README.md", "utf8");
    const quickStart = contents.split("## Commands")[0] ?? contents;

    assert.match(contents, /npx @agentpay-ai\/agentpay install/);
    assert.match(contents, /return to your agent chat/i);
    assert.match(contents, /create an AgentPay wallet/i);
    assert.match(contents, /pay 5 USDT/i);
    assert.doesNotMatch(quickStart, /agentpay doctor/i);
    assert.doesNotMatch(quickStart, /agentpay setup-web/i);
  });
});
