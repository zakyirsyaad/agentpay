import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as agentPay from "./index.ts";

describe("published MCP server API", () => {
  it("does not expose production readiness test seams", () => {
    assert.equal("resolveProductionReadiness" in agentPay, false);
    assert.equal("shouldVerifyMainnetAccountAtStartup" in agentPay, false);
  });
});
