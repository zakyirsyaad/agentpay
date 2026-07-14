import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSiweChallenge } from "./siwe.ts";
import {
  authenticateServiceSession,
  issueServiceSession,
  parseBearerToken,
  revokeAllTenantSessions,
  revokeServiceSession,
  type AuthChallengeStore,
  type ServiceSessionRecord,
  type ServiceSessionStore,
} from "./session.ts";

const ownerAddress = "0x1111111111111111111111111111111111111111";
const accountAddress = "0x2222222222222222222222222222222222222222";
const sessionHashKey = "session-hash-secret-for-tests";

class FakeChallengeStore implements AuthChallengeStore {
  public readonly records = new Map<string, ReturnType<typeof createSiweChallenge>>();
  public async create(record: ReturnType<typeof createSiweChallenge>): Promise<void> {
    this.records.set(record.challengeId, record);
  }
  public async get(challengeId: string) {
    return this.records.get(challengeId) ?? null;
  }
  public async consume(challengeId: string, consumedAt: string): Promise<boolean> {
    const record = this.records.get(challengeId);
    if (!record || record.consumedAt) return false;
    this.records.set(challengeId, { ...record, consumedAt });
    return true;
  }
}

class FakeSessionStore implements ServiceSessionStore {
  public readonly records = new Map<string, ServiceSessionRecord>();
  public async create(record: ServiceSessionRecord): Promise<void> {
    this.records.set(record.sessionId, record);
  }
  public async findByCredentialDigest(digest: string): Promise<ServiceSessionRecord | null> {
    return [...this.records.values()].find((record) => record.credentialDigest === digest) ?? null;
  }
  public async revoke(sessionId: string, revokedAt: string): Promise<void> {
    const record = this.records.get(sessionId);
    if (record) this.records.set(sessionId, { ...record, revokedAt });
  }
  public async revokeAll(tenantId: string, revokedAt: string): Promise<void> {
    for (const [sessionId, record] of this.records) {
      if (record.tenantId === tenantId && !record.revokedAt) {
        this.records.set(sessionId, { ...record, revokedAt });
      }
    }
  }
  public async touch(sessionId: string, lastUsedAt: string): Promise<void> {
    const record = this.records.get(sessionId);
    if (record) this.records.set(sessionId, { ...record, lastUsedAt });
  }
}

function createChallenge(overrides: Partial<Parameters<typeof createSiweChallenge>[0]> = {}) {
  return createSiweChallenge({
    challengeId: "challenge_123",
    requestId: "request_123",
    domain: "wallet.agentpay.site",
    uri: "https://wallet.agentpay.site/mcp",
    ownerAddress,
    accountAddress,
    chainId: 1952,
    nonce: "nonce_1234567890",
    issuedAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2026-07-12T00:05:00.000Z",
    scopes: ["wallet:read", "payment:prepare", "payment:read", "payment:review", "session:manage"],
    ...overrides,
  });
}

describe("opaque consumer service sessions", () => {
  it("stores only a keyed digest and returns the raw credential once", async () => {
    const challengeStore = new FakeChallengeStore();
    const sessionStore = new FakeSessionStore();
    const record = createChallenge();
    await challengeStore.create(record);

    const issued = await issueServiceSession({
      challenge: record,
      signature: "0x" + "11".repeat(65),
      challengeStore,
      sessionStore,
      serverSecret: sessionHashKey,
      audience: record.uri,
      environment: "staging",
      clock: () => new Date("2026-07-12T00:01:00.000Z"),
      resolveTenant: async () => ({ tenantId: "tenant_123", authenticationEpoch: 0 }),
      verifySignature: async () => ownerAddress,
      createSessionId: () => "session_123",
      randomCredentialBytes: () => Buffer.alloc(32, 7),
    });

    assert.equal(issued.context.tenantId, "tenant_123");
    assert.equal(issued.context.ownerAddress, ownerAddress);
    assert.equal(issued.context.accountAddress, accountAddress);
    assert.equal(issued.credential.length, 43);
    const stored = sessionStore.records.get("session_123");
    assert.ok(stored);
    assert.notEqual(stored.credentialDigest, issued.credential);
    assert.equal(JSON.stringify(stored).includes(issued.credential), false);
    assert.equal(stored.expiresAt, "2026-07-19T00:00:00.000Z");
  });

  it("authenticates by bearer header and rejects malformed or insufficient credentials", async () => {
    const challengeStore = new FakeChallengeStore();
    const sessionStore = new FakeSessionStore();
    const record = createChallenge({ scopes: ["wallet:read"] });
    await challengeStore.create(record);
    const issued = await issueServiceSession({
      challenge: record,
      signature: "0x" + "11".repeat(65),
      challengeStore,
      sessionStore,
      serverSecret: sessionHashKey,
      audience: record.uri,
      environment: "staging",
      clock: () => new Date("2026-07-12T00:01:00.000Z"),
      resolveTenant: async () => ({ tenantId: "tenant_123", authenticationEpoch: 0 }),
      verifySignature: async () => ownerAddress,
      createSessionId: () => "session_123",
      randomCredentialBytes: () => Buffer.alloc(32, 7),
    });

    assert.equal(parseBearerToken(`Bearer ${issued.credential}`), issued.credential);
    assert.throws(() => parseBearerToken("Basic secret"), /Bearer credential required/i);
    assert.throws(() => parseBearerToken(`Bearer ${issued.credential} extra`), /Bearer credential required/i);
    assert.throws(() => parseBearerToken(undefined), /Bearer credential required/i);

    const context = await authenticateServiceSession({
      credential: issued.credential,
      sessionStore,
      serverSecret: sessionHashKey,
      audience: record.uri,
      environment: "staging",
      clock: () => new Date("2026-07-12T00:02:00.000Z"),
      currentAuthenticationEpoch: async () => 0,
      requiredScope: "wallet:read",
    });
    assert.equal(context.sessionId, "session_123");

    await assert.rejects(
      authenticateServiceSession({
        credential: issued.credential,
        sessionStore,
      serverSecret: sessionHashKey,
        audience: record.uri,
        environment: "staging",
        clock: () => new Date("2026-07-12T00:02:00.000Z"),
        currentAuthenticationEpoch: async () => 0,
        requiredScope: "payment:prepare",
      }),
      /scope/i,
    );
  });

  it("rejects expiry, revocation, epoch, audience, and environment mismatches", async () => {
    const challengeStore = new FakeChallengeStore();
    const sessionStore = new FakeSessionStore();
    const record = createChallenge();
    await challengeStore.create(record);
    const issued = await issueServiceSession({
      challenge: record,
      signature: "0x" + "11".repeat(65),
      challengeStore,
      sessionStore,
      serverSecret: sessionHashKey,
      audience: record.uri,
      environment: "staging",
      clock: () => new Date("2026-07-12T00:01:00.000Z"),
      resolveTenant: async () => ({ tenantId: "tenant_123", authenticationEpoch: 0 }),
      verifySignature: async () => ownerAddress,
      createSessionId: () => "session_123",
      randomCredentialBytes: () => Buffer.alloc(32, 7),
    });
    const base = {
      credential: issued.credential,
      sessionStore,
      serverSecret: sessionHashKey,
      audience: record.uri,
      environment: "staging" as const,
      currentAuthenticationEpoch: async () => 0,
    };

    await assert.rejects(authenticateServiceSession({ ...base, clock: () => new Date("2026-07-19T00:01:00.000Z") }), /expired/i);
    await assert.rejects(
      authenticateServiceSession({ ...base, clock: () => new Date("2026-07-12T00:04:00.000Z"), currentAuthenticationEpoch: async () => 1 }),
      /authentication epoch/i,
    );
    await assert.rejects(
      authenticateServiceSession({ ...base, audience: "https://evil.example/mcp", clock: () => new Date("2026-07-12T00:04:00.000Z") }),
      /audience/i,
    );
    await assert.rejects(
      authenticateServiceSession({ ...base, environment: "production", clock: () => new Date("2026-07-12T00:04:00.000Z") }),
      /environment/i,
    );
    await assert.rejects(
      authenticateServiceSession({
        ...base,
        clock: () => new Date("2026-07-12T00:04:00.000Z"),
        currentTenantState: async () => ({
          authenticationEpoch: 0,
          environment: "staging",
          status: "SUSPENDED",
        }),
      }),
      /not active/i,
    );
    await revokeServiceSession("session_123", sessionStore, "2026-07-12T00:03:00.000Z");
    await assert.rejects(authenticateServiceSession({ ...base, clock: () => new Date("2026-07-12T00:04:00.000Z") }), /revoked/i);
  });

  it("revokes all tenant sessions without making the session a payment authorization", async () => {
    const sessionStore = new FakeSessionStore();
    const challengeStore = new FakeChallengeStore();
    const record = createChallenge();
    await challengeStore.create(record);
    const issued = await issueServiceSession({
      challenge: record,
      signature: "0x" + "11".repeat(65),
      challengeStore,
      sessionStore,
      serverSecret: sessionHashKey,
      audience: record.uri,
      environment: "staging",
      clock: () => new Date("2026-07-12T00:01:00.000Z"),
      resolveTenant: async () => ({ tenantId: "tenant_123", authenticationEpoch: 0 }),
      verifySignature: async () => ownerAddress,
      createSessionId: () => "session_123",
      randomCredentialBytes: () => Buffer.alloc(32, 7),
    });
    await revokeAllTenantSessions("tenant_123", sessionStore, "2026-07-12T00:02:00.000Z");
    await assert.rejects(
      authenticateServiceSession({
        credential: issued.credential,
        sessionStore,
      serverSecret: sessionHashKey,
        audience: record.uri,
        environment: "staging",
        clock: () => new Date("2026-07-12T00:03:00.000Z"),
        currentAuthenticationEpoch: async () => 0,
      }),
      /revoked/i,
    );
  });
});
