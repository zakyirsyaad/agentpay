import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSessionContext, type SessionContext } from "@agentpay-ai/shared";

import { authenticateConsumerRequest, type ConsumerSessionAuthenticator } from "./consumer-auth.ts";

const trustedContext: SessionContext = createSessionContext({
  sessionId: "session_123",
  tenantId: "tenant_a",
  ownerAddress: "0x1111111111111111111111111111111111111111",
  accountAddress: "0x2222222222222222222222222222222222222222",
  homeChainId: 1952,
  audience: "https://wallet.agentpay.site/mcp",
  environment: "staging",
  scopes: ["wallet:read"],
  authEpoch: 0,
  issuedAt: "2026-07-12T00:00:00.000Z",
  expiresAt: "2026-07-19T00:00:00.000Z",
});

describe("consumer MCP bearer boundary", () => {
  it("passes only the bearer credential to the authenticator and returns trusted context", async () => {
    const seen: string[] = [];
    const authenticator: ConsumerSessionAuthenticator = {
      async authenticate(credential, requiredScope) {
        seen.push(`${credential}:${requiredScope ?? "none"}`);
        return trustedContext;
      },
    };

    const context = await authenticateConsumerRequest(
      { authorization: "Bearer " + "a".repeat(43) },
      authenticator,
      "wallet:read",
    );

    assert.equal(context, trustedContext);
    assert.deepEqual(seen, [`${"a".repeat(43)}:wallet:read`]);
  });

  it("rejects missing, malformed, and query-string credentials", async () => {
    const authenticator: ConsumerSessionAuthenticator = {
      async authenticate() {
        throw new Error("must not be called");
      },
    };

    await assert.rejects(
      authenticateConsumerRequest({}, authenticator),
      (error: unknown) => (error as { code?: string }).code === "AUTH_CREDENTIAL_REQUIRED",
    );
    await assert.rejects(
      authenticateConsumerRequest({ authorization: "Basic secret" }, authenticator),
      (error: unknown) => (error as { code?: string }).code === "AUTH_CREDENTIAL_REQUIRED",
    );
    await assert.rejects(
      authenticateConsumerRequest({ authorization: "Bearer " + "a".repeat(43), query: "token=secret" }, authenticator),
      (error: unknown) => (error as { code?: string }).code === "AUTH_CREDENTIAL_QUERY_FORBIDDEN",
    );
  });
});
