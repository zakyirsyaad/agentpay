import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { describe, it } from "node:test";

import {
  createSessionContext,
  type SessionContext,
} from "@agentpay-ai/shared";
import { createSiweChallenge, verifySiweChallengeSignature } from "../auth/siwe.ts";
import type { ServiceSessionRecord } from "../auth/session.ts";

import {
  createSupabaseAgentPayRepositories,
  createTenantScopedSupabaseAgentPayRepositories,
  type AgentPaySupabaseClient,
} from "./supabase.ts";

const ownerAddress = "0x1111111111111111111111111111111111111111";
const accountAddress = "0x2222222222222222222222222222222222222222";

function context(): SessionContext {
  return createSessionContext({
    sessionId: "session_123",
    tenantId: "tenant_a",
    ownerAddress,
    accountAddress,
    homeChainId: 1952,
    audience: "https://wallet.agentpay.site/mcp",
    environment: "staging",
    scopes: ["wallet:read", "payment:prepare", "payment:read", "payment:review", "session:manage"],
    authEpoch: 0,
    issuedAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2026-07-19T00:00:00.000Z",
  });
}

class QuerySpy {
  public readonly calls: Array<[string, unknown[]]> = [];
  public inserted: Record<string, unknown> | undefined;
  public updated: Record<string, unknown> | undefined;

  public select(columns: string): this {
    this.calls.push(["select", [columns]]);
    return this;
  }

  public eq(column: string, value: string | number): this {
    this.calls.push(["eq", [column, value]]);
    return this;
  }

  public is(column: string, value: null): this {
    this.calls.push(["is", [column, value]]);
    return this;
  }

  public order(column: string, options: { ascending: boolean }): this {
    this.calls.push(["order", [column, options]]);
    return this;
  }

  public limit(count: number): this {
    this.calls.push(["limit", [count]]);
    return this;
  }

  public insert(row: Record<string, unknown>): Promise<{ error: null }> {
    this.inserted = row;
    return Promise.resolve({ error: null });
  }

  public update(row: Record<string, unknown>): this {
    this.updated = row;
    this.calls.push(["update", [row]]);
    return this;
  }

  public maybeSingle(): Promise<{ data: unknown; error: null }> {
    this.calls.push(["maybeSingle", []]);
    return Promise.resolve({
      data: {
        owner_address: ownerAddress,
        account_address: accountAddress,
        home_chain_id: 1952,
        executor_address: "0x3333333333333333333333333333333333333333",
        status: "ACTIVE",
      },
      error: null,
    });
  }

  public then(resolve: (value: { data: unknown[]; error: null }) => void): void {
    resolve({ data: [], error: null });
  }
}

class TenantBindingQuery {
  public readonly calls: Array<[string, unknown[]]> = [];

  public constructor(private readonly table: string) {}

  public select(columns: string): this {
    this.calls.push(["select", [columns]]);
    return this;
  }

  public eq(column: string, value: string | number): this {
    this.calls.push(["eq", [column, value]]);
    return this;
  }

  public maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: null }> {
    this.calls.push(["maybeSingle", []]);
    if (this.table === "verified_owner_identities") {
      const verifiedOnly = this.calls.some(([name, args]) => name === "eq" && args[0] === "status" && args[1] === "VERIFIED");
      return Promise.resolve({
        data: verifiedOnly
          ? { tenant_id: "tenant_production", owner_address: ownerAddress, status: "VERIFIED" }
          : { tenant_id: "tenant_legacy", owner_address: ownerAddress, status: "QUARANTINED" },
        error: null,
      });
    }
    if (this.table === "tenants") {
      return Promise.resolve({
        data: { auth_epoch: 0, environment: "production", status: "ACTIVE" },
        error: null,
      });
    }
    throw new Error(`Unexpected table ${this.table}`);
  }
}

class AuthChallengeQuery extends QuerySpy {
  public constructor(private readonly row: Record<string, unknown>) {
    super();
  }

  public override maybeSingle(): Promise<{ data: unknown; error: null }> {
    this.calls.push(["maybeSingle", []]);
    return Promise.resolve({ data: this.row, error: null });
  }
}

describe("tenant-scoped Supabase repositories", () => {
  it("ignores a quarantined legacy identity when binding the production owner", async () => {
    const queries = new Map<string, TenantBindingQuery>();
    const client = {
      from(table: string) {
        const query = queries.get(table) ?? new TenantBindingQuery(table);
        queries.set(table, query);
        return query;
      },
    } as unknown as AgentPaySupabaseClient;

    const repositories = createSupabaseAgentPayRepositories(client);
    const binding = await repositories.tenantBindings.bindVerifiedOwner(ownerAddress, 196);

    assert.equal(binding.tenantId, "tenant_production");
    assert.ok(
      queries.get("verified_owner_identities")?.calls.some(
        ([name, args]) => name === "eq" && args[0] === "status" && args[1] === "VERIFIED",
      ),
    );
  });

  it("requires trusted context and adds tenant and owner filters to wallet reads", async () => {
    const query = new QuerySpy();
    const client = {
      from(table: string) {
        assert.equal(table, "agent_wallets");
        return query;
      },
    } as unknown as AgentPaySupabaseClient;

    assert.throws(
      () => createTenantScopedSupabaseAgentPayRepositories(client, undefined as unknown as SessionContext),
      (error: unknown) => (error as { code?: string }).code === "AUTH_CONTEXT_REQUIRED",
    );

    const repositories = createTenantScopedSupabaseAgentPayRepositories(client, context());
    const wallet = await repositories.wallets.getActiveWallet({ homeChainId: 1952 });

    assert.equal(wallet?.accountAddress, accountAddress);
    assert.deepEqual(
      query.calls.filter(([name]) => name === "eq"),
      [
        ["eq", ["status", "ACTIVE"]],
        ["eq", ["tenant_id", "tenant_a"]],
        ["eq", ["owner_address", ownerAddress]],
        ["eq", ["account_address", accountAddress]],
        ["eq", ["home_chain_id", 1952]],
      ],
    );
  });

  it("writes tenant ownership and rejects a resource from another owner", async () => {
    const query = new QuerySpy();
    const client = {
      from(table: string) {
        assert.equal(table, "agent_wallets");
        return query;
      },
    } as unknown as AgentPaySupabaseClient;
    const repositories = createTenantScopedSupabaseAgentPayRepositories(client, context());

    await repositories.wallets.createAgentWallet({
      ownerAddress,
      accountAddress,
      homeChainId: 1952,
      executorAddress: "0x3333333333333333333333333333333333333333",
      status: "ACTIVE",
    });
    assert.equal(query.inserted?.tenant_id, "tenant_a");

    await assert.rejects(
      repositories.wallets.createAgentWallet({
        ownerAddress: "0x4444444444444444444444444444444444444444",
        accountAddress,
        homeChainId: 1952,
        executorAddress: "0x3333333333333333333333333333333333333333",
        status: "ACTIVE",
      }),
      /does not match the consumer session/i,
    );
  });

  it("scopes payment reads, writes, and network selection to the authenticated account", async () => {
    const query = new QuerySpy();
    const client = {
      from(table: string) {
        assert.ok(["payment_intents", "agent_wallets"].includes(table));
        return query;
      },
    } as unknown as AgentPaySupabaseClient;
    const repositories = createTenantScopedSupabaseAgentPayRepositories(client, context());

    await repositories.paymentIntents.getPaymentIntent("pay_tenant_a");
    assert.deepEqual(
      query.calls.filter(([name]) => name === "eq"),
      [
        ["eq", ["id", "pay_tenant_a"]],
        ["eq", ["tenant_id", "tenant_a"]],
        ["eq", ["owner_address", ownerAddress]],
        ["eq", ["account_address", accountAddress]],
      ],
    );

    await assert.rejects(
      repositories.wallets.getActiveWallet({ homeChainId: 196 }),
      (error: unknown) => (error as { code?: string }).code === "TENANT_RESOURCE_MISMATCH",
    );
  });

  it("persists one-time challenges and only the keyed session digest", async () => {
    const queries = new Map<string, QuerySpy>();
    const client = {
      from(table: string) {
        const query = queries.get(table) ?? new QuerySpy();
        queries.set(table, query);
        return query;
      },
    } as unknown as AgentPaySupabaseClient;
    const repositories = createTenantScopedSupabaseAgentPayRepositories(client, context());
    const challenge = createSiweChallenge({
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
      scopes: ["wallet:read"],
    });
    await repositories.authChallenges.create(challenge);
    assert.equal(queries.get("auth_challenges")?.inserted?.message, challenge.message);
    await repositories.authChallenges.consume(challenge.challengeId, "2026-07-12T00:01:00.000Z");
    assert.deepEqual(
      queries.get("auth_challenges")?.calls.filter(([name]) => name === "is"),
      [["is", ["consumed_at", null]]],
    );

    const session: ServiceSessionRecord = {
      sessionId: "session_123",
      tenantId: "tenant_a",
      ownerAddress,
      accountAddress,
      homeChainId: 1952,
      audience: "https://wallet.agentpay.site/mcp",
      environment: "staging",
      scopes: ["wallet:read"],
      authenticationEpoch: 0,
      issuedAt: "2026-07-12T00:01:00.000Z",
      expiresAt: "2026-07-19T00:01:00.000Z",
      lastUsedAt: "2026-07-12T00:01:00.000Z",
      credentialDigest: "a".repeat(64),
    };
    await repositories.serviceSessions.create(session);
    assert.equal(queries.get("service_sessions")?.inserted?.credential_digest, "a".repeat(64));
    assert.equal(JSON.stringify(queries.get("service_sessions")?.inserted).includes("Bearer"), false);
  });

  it("round-trips lowercased SIWE owners without changing the signed message", async () => {
    const wallet = new Wallet(`0x${"1".repeat(64)}`);
    const challenge = createSiweChallenge({
      challengeId: "challenge_roundtrip",
      requestId: "request_roundtrip",
      domain: "wallet.agentpay.site",
      uri: "https://wallet.agentpay.site/mcp",
      ownerAddress: wallet.address,
      accountAddress,
      chainId: 1952,
      nonce: "nonce_roundtrip",
      issuedAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:05:00.000Z",
      scopes: ["wallet:read"],
    });
    const query = new AuthChallengeQuery({
      id: challenge.challengeId,
      request_id: challenge.requestId,
      domain: challenge.domain,
      uri: challenge.uri,
      owner_address: challenge.ownerAddress.toLowerCase(),
      account_address: challenge.accountAddress,
      chain_id: challenge.chainId,
      nonce: challenge.nonce,
      scopes: [...challenge.scopes],
      message: challenge.message,
      issued_at: challenge.issuedAt,
      expires_at: challenge.expiresAt,
      consumed_at: null,
    });
    const client = {
      from(table: string) {
        assert.equal(table, "auth_challenges");
        return query;
      },
    } as unknown as AgentPaySupabaseClient;

    const repositories = createTenantScopedSupabaseAgentPayRepositories(client, context());
    const loaded = await repositories.authChallenges.get(challenge.challengeId);
    assert.ok(loaded);
    assert.equal(await verifySiweChallengeSignature(loaded, await wallet.signMessage(challenge.message), new Date("2026-07-12T00:01:00.000Z")), wallet.address);
  });

  it("normalizes Supabase timestamptz offsets before verifying the signed SIWE message", async () => {
    const wallet = new Wallet(`0x2222222222222222222222222222222222222222222222222222222222222222`);
    const challenge = createSiweChallenge({
      challengeId: "challenge_timestamptz_offset",
      requestId: "request_timestamptz_offset",
      domain: "wallet.agentpay.site",
      uri: "https://wallet.agentpay.site/mcp",
      ownerAddress: wallet.address,
      accountAddress,
      chainId: 1952,
      nonce: "nonce_timestamptz_offset",
      issuedAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:05:00.000Z",
      scopes: ["wallet:read"],
    });
    const query = new AuthChallengeQuery({
      id: challenge.challengeId,
      request_id: challenge.requestId,
      domain: challenge.domain,
      uri: challenge.uri,
      owner_address: challenge.ownerAddress.toLowerCase(),
      account_address: challenge.accountAddress,
      chain_id: challenge.chainId,
      nonce: challenge.nonce,
      scopes: [...challenge.scopes],
      message: challenge.message,
      issued_at: "2026-07-12T02:00:00.000+02:00",
      expires_at: "2026-07-12T02:05:00.000+02:00",
      consumed_at: null,
    });
    const client = {
      from(table: string) {
        assert.equal(table, "auth_challenges");
        return query;
      },
    } as unknown as AgentPaySupabaseClient;

    const repositories = createTenantScopedSupabaseAgentPayRepositories(client, context());
    const loaded = await repositories.authChallenges.get(challenge.challengeId);
    assert.ok(loaded);
    assert.equal(
      await verifySiweChallengeSignature(loaded, await wallet.signMessage(challenge.message), new Date("2026-07-12T00:01:00.000Z")),
      wallet.address,
    );
  });

  it("fails closed when Supabase returns an invalid SIWE timestamp", async () => {
    const query = new AuthChallengeQuery({
      id: "challenge_invalid_timestamp",
      request_id: "request_invalid_timestamp",
      domain: "wallet.agentpay.site",
      uri: "https://wallet.agentpay.site/mcp",
      owner_address: ownerAddress,
      account_address: accountAddress,
      chain_id: 1952,
      nonce: "nonce_invalid_timestamp",
      scopes: ["wallet:read"],
      message: "invalid",
      issued_at: "not-a-timestamp",
      expires_at: "2026-07-12T00:05:00.000+00:00",
      consumed_at: null,
    });
    const client = {
      from(table: string) {
        assert.equal(table, "auth_challenges");
        return query;
      },
    } as unknown as AgentPaySupabaseClient;

    const repositories = createTenantScopedSupabaseAgentPayRepositories(client, context());
    await assert.rejects(
      repositories.authChallenges.get("challenge_invalid_timestamp"),
      (error: unknown) => (error as { code?: string }).code === "SIWE_TIME_INVALID",
    );
  });
});
