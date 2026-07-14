import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { describe, it } from "node:test";

import {
  createConsumerSessionApi,
  type ConsumerSessionApiDependencies,
} from "./consumer-session-api.ts";
import { createSiweChallenge, type SiweChallenge } from "./siwe.ts";
import type { AuthChallengeStore, ServiceSessionRecord, ServiceSessionStore } from "./session.ts";

const owner = new Wallet(`0x${"1".repeat(64)}`);
const accountAddress = "0x2222222222222222222222222222222222222222";

class ChallengeStore implements AuthChallengeStore {
  public readonly records = new Map<string, SiweChallenge>();
  async create(record: SiweChallenge): Promise<void> {
    this.records.set(record.challengeId, record);
  }
  async get(challengeId: string): Promise<SiweChallenge | null> {
    return this.records.get(challengeId) ?? null;
  }
  async consume(challengeId: string, consumedAt: string): Promise<boolean> {
    const record = this.records.get(challengeId);
    if (!record || record.consumedAt) return false;
    this.records.set(challengeId, { ...record, consumedAt });
    return true;
  }
}

class SessionStore implements ServiceSessionStore {
  public readonly records = new Map<string, ServiceSessionRecord>();
  async create(record: ServiceSessionRecord): Promise<void> {
    this.records.set(record.sessionId, record);
  }
  async findByCredentialDigest(digest: string): Promise<ServiceSessionRecord | null> {
    return [...this.records.values()].find((record) => record.credentialDigest === digest) ?? null;
  }
  async revoke(): Promise<void> {}
  async revokeAll(): Promise<void> {}
  async touch(): Promise<void> {}
}

function dependencies(overrides: Partial<ConsumerSessionApiDependencies> = {}): ConsumerSessionApiDependencies {
  return {
    challengeStore: new ChallengeStore(),
    sessionStore: new SessionStore(),
    serverSecret: "consumer-session-secret",
    audience: "https://wallet.agentpay.site/mcp",
    environment: "staging",
    clock: () => new Date("2026-07-12T00:00:00.000Z"),
    resolveTenant: async () => ({ tenantId: "tenant_a", authenticationEpoch: 0 }),
    createChallengeId: () => "challenge_123",
    createRequestId: () => "request_123",
    createNonce: () => "nonce_1234567890",
    createSessionId: () => "session_123",
    randomCredentialBytes: () => Buffer.alloc(32, 7),
    ...overrides,
  };
}

describe("consumer SIWE session API", () => {
  it("creates a short-lived SIWE challenge and issues a session only after its signature verifies", async () => {
    const deps = dependencies();
    const api = createConsumerSessionApi(deps);
    const challengeResponse = await api.handle(
      new Request("https://wallet.agentpay.site/auth/siwe/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerAddress: owner.address, accountAddress, chainId: 1952 }),
      }),
    );
    assert.equal(challengeResponse.status, 200);
    const challengeBody = (await challengeResponse.json()) as { challengeId: string; message: string; expiresAt: string };
    assert.equal(challengeBody.challengeId, "challenge_123");

    const challenge = (deps.challengeStore as ChallengeStore).records.get(challengeBody.challengeId);
    assert.ok(challenge);
    const verifyResponse = await api.handle(
      new Request("https://wallet.agentpay.site/auth/siwe/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: challengeBody.challengeId, signature: await owner.signMessage(challenge.message) }),
      }),
    );
    assert.equal(verifyResponse.status, 200);
    const body = (await verifyResponse.json()) as { credential: string; tenantId: string; sessionId: string };
    assert.equal(body.tenantId, "tenant_a");
    assert.equal(body.sessionId, "session_123");
    assert.equal(body.credential.length, 43);
  });

  it("does not mint a session from an invalid signature or a setup-only signature", async () => {
    const deps = dependencies();
    const api = createConsumerSessionApi(deps);
    const challengeResponse = await api.handle(
      new Request("https://wallet.agentpay.site/auth/siwe/challenge", {
        method: "POST",
        body: JSON.stringify({ ownerAddress: owner.address, accountAddress, chainId: 1952 }),
      }),
    );
    const challengeBody = (await challengeResponse.json()) as { challengeId: string };
    const response = await api.handle(
      new Request("https://wallet.agentpay.site/auth/siwe/verify", {
        method: "POST",
        body: JSON.stringify({ challengeId: challengeBody.challengeId, signature: "0x" + "11".repeat(65) }),
      }),
    );
    assert.equal(response.status, 400);
    assert.equal((deps.sessionStore as SessionStore).records.size, 0);
  });

  it("rejects unknown routes and oversized request bodies", async () => {
    const api = createConsumerSessionApi(dependencies());
    const notFound = await api.handle(new Request("https://wallet.agentpay.site/auth/other", { method: "POST" }));
    assert.equal(notFound.status, 404);
    const oversized = await api.handle(
      new Request("https://wallet.agentpay.site/auth/siwe/challenge", {
        method: "POST",
        headers: { "content-length": "20000" },
        body: "{}",
      }),
    );
    assert.equal(oversized.status, 413);
  });
});
