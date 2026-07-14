import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertNoCallerAuthority,
  createSessionContext,
  requireSessionContext,
  requireSessionScope,
  type SessionContext,
} from "./auth.ts";

const ownerAddress = "0x1111111111111111111111111111111111111111";
const accountAddress = "0x2222222222222222222222222222222222222222";

function context(overrides: Partial<SessionContext> = {}): SessionContext {
  return createSessionContext({
    sessionId: "session_123",
    tenantId: "tenant_123",
    ownerAddress,
    accountAddress,
    homeChainId: 1952,
    audience: "https://wallet.agentpay.site/mcp",
    environment: "staging",
    scopes: ["wallet:read", "payment:prepare", "payment:read", "payment:review", "session:manage"],
    authEpoch: 0,
    issuedAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  });
}

describe("session context", () => {
  it("creates an immutable trusted context with normalized addresses and scopes", () => {
    const trusted = context({
      ownerAddress: ownerAddress.toUpperCase(),
      accountAddress: accountAddress.toUpperCase(),
      scopes: ["payment:read", "wallet:read", "payment:read"],
    });

    assert.equal(trusted.ownerAddress, ownerAddress);
    assert.equal(trusted.accountAddress, accountAddress);
    assert.deepEqual(trusted.scopes, ["payment:read", "wallet:read"]);
    assert.equal(Object.isFrozen(trusted), true);
    assert.equal(Object.isFrozen(trusted.scopes), true);
  });

  it("fails closed when context is absent or a scope is missing", () => {
    assert.throws(() => requireSessionContext(undefined), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTH_CONTEXT_REQUIRED");
      return true;
    });

    assert.throws(() => requireSessionScope(context({ scopes: ["wallet:read"] }), "payment:prepare"), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "AUTH_SCOPE_REQUIRED");
      return true;
    });
  });

  it("rejects caller-supplied authority fields", () => {
    assert.doesNotThrow(() => assertNoCallerAuthority({ tokenSymbols: ["USDT0"] }));

    for (const field of ["tenantId", "ownerAddress", "accountAddress"]) {
      assert.throws(() => assertNoCallerAuthority({ [field]: "attacker-controlled" }), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "CALLER_AUTHORITY_FORBIDDEN");
        return true;
      });
    }
  });
});
