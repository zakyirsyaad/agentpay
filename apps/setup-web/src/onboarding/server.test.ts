import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TypedDataEncoder, Wallet } from "ethers";

import {
  MAINNET_SETUP_USDT0,
  createMainnetWalletSetupTypedData,
  type MainnetWalletSetupPolicyContext,
  type MainnetWalletSetupPublicStatus,
} from "@agentpay-ai/shared";
import type {
  ProductionSetupChallengeInput,
  ProductionSetupWebStore,
  SetupAdmissionInput,
} from "@agentpay-ai/mcp-server";

import {
  createProductionOnboardingHandler,
  type ProductionOnboardingDependencies,
} from "./server.ts";

const origin = "https://onboard.agentpay.site";
const host = "onboard.agentpay.site";
const cookieSecret = "cookie-secret-that-is-at-least-thirty-two-bytes";
const capabilitySecret = "capability-secret-that-is-at-least-thirty-two-bytes";
const proxyIdentity = "proxy-identity-that-is-at-least-thirty-two-bytes";
const now = new Date("2026-07-17T08:00:00.000Z");
const owner = Wallet.createRandom();
const address = (digit: string) => `0x${digit.repeat(40)}`;
const hash = (digit: string) => `0x${digit.repeat(64)}`;

function createFixture(overrides: Partial<ProductionOnboardingDependencies> = {}) {
  let randomFill = 11;
  const challenges: ProductionSetupChallengeInput[] = [];
  const admissions: SetupAdmissionInput[] = [];
  const policyBase: Omit<MainnetWalletSetupPolicyContext, "ownerAddress" | "currentUnixTime"> = {
    executorAddress: address("2"),
    factoryAddress: address("3"),
    factoryRuntimeCodeHash: hash("4"),
    deploymentSalt: hash("5"),
    predictedAccount: address("6"),
    accountCreationCodeHash: hash("7"),
    accountRuntimeCodeHash: hash("8"),
    manifestSha256: hash("9"),
    sponsorDeployerAddress: address("a"),
  };
  const status: MainnetWalletSetupPublicStatus = {
    setupIntentId: "setup_production_123456789",
    status: "SETUP_PENDING",
    predictedAccount: policyBase.predictedAccount,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const store: ProductionSetupWebStore = {
    async challenge(input) {
      challenges.push(input);
      return { disposition: "CREATED", setupIntentId: input.setupIntentId, expiresAt: input.expiresAt };
    },
    async admit(input) {
      admissions.push(input);
      return {
        disposition: admissions.length === 1 ? "ADMITTED" : "REPLAY",
        setupIntentId: status.setupIntentId,
        jobId: "11111111-1111-4111-8111-111111111111",
      };
    },
    async status() { return status; },
    async prune() { return { expiredSetups: 0, deletedRateBuckets: 0 }; },
  };
  const dependencies: ProductionOnboardingDependencies = {
    store,
    mode: "PUBLIC",
    origin,
    host,
    cookieSecret,
    capabilitySecret,
    trustedProxyIdentity: proxyIdentity,
    clock: () => now,
    randomBytes: (size) => new Uint8Array(size).fill(randomFill++),
    createSetupIntentId: () => status.setupIntentId,
    createDeploymentNonce: () => hash("1"),
    authorizationLifetimeSeconds: 600,
    rateLimiter: { async allow() { return true; } },
    policy: {
      async derive(input) {
        const context: MainnetWalletSetupPolicyContext = {
          ...policyBase,
          ownerAddress: input.ownerAddress,
          currentUnixTime: input.currentUnixTime,
        };
        const typedData = createMainnetWalletSetupTypedData({
          setupIntentId: input.setupIntentId,
          deploymentNonce: input.deploymentNonce,
          owner: input.ownerAddress,
          executor: context.executorAddress,
          homeChainId: 196,
          environment: "production",
          deadline: input.deadline,
          factory: context.factoryAddress,
          factoryRuntimeCodeHash: context.factoryRuntimeCodeHash,
          deploymentSalt: context.deploymentSalt,
          predictedAccount: context.predictedAccount,
          accountCreationCodeHash: context.accountCreationCodeHash,
          accountRuntimeCodeHash: context.accountRuntimeCodeHash,
          token: MAINNET_SETUP_USDT0,
          tokenAllowlistHash: "0xc0687130b337dbc04821b9bd064027dd46ef43a11adc8c2d98fccd719152b4a5",
          routeAllowlistHash: "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd",
          manifestSha256: context.manifestSha256,
        }, context);
        return { typedData, policyContext: context };
      },
      async getOwnerCode() { return "0x"; },
    },
    ...overrides,
  };
  return { handler: createProductionOnboardingHandler(dependencies), challenges, admissions, status };
}

function apiHeaders(extra: Record<string, string> = {}) {
  return {
    host,
    origin,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "content-type": "application/json",
    "x-agentpay-proxy-identity": proxyIdentity,
    "x-agentpay-client-address": "198.51.100.42",
    ...extra,
  };
}

async function createChallenge(fixture = createFixture()) {
  const response = await fixture.handler(new Request(`${origin}/api/setup/challenge`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ ownerAddress: owner.address }),
  }));
  return { fixture, response, body: await response.json() as Record<string, any> };
}

describe("production onboarding route and browser boundary", () => {
  it("exposes only the six exact routes and applies hardened no-store headers without CORS", async () => {
    const { handler } = createFixture();
    const page = await handler(new Request(`${origin}/setup`, {
      headers: { host, "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    }));
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("access-control-allow-origin"), null);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.doesNotMatch(await page.text(), /fonts\.google|https:\/\/(?!onboard\.agentpay\.site)/);

    const sameSiteNavigation = await handler(new Request(`${origin}/setup`, {
      headers: { host, "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    }));
    assert.equal(sameSiteNavigation.status, 200);

    for (const path of ["/", "/review", "/api/setup", "/api/setup/challenge/", "/favicon.ico"]) {
      const response = await handler(new Request(`${origin}${path}`, { headers: { host } }));
      assert.equal(response.status, 404, path);
    }
    const wrongMethod = await handler(new Request(`${origin}/api/setup/status`, {
      method: "POST", headers: apiHeaders(), body: "{}",
    }));
    assert.equal(wrongMethod.status, 405);
  });

  it("rejects wrong Host, Origin, Fetch Metadata, proxy identity, and unavailable rate limiter", async () => {
    const invalidHeaders: Array<Record<string, string>> = [
      { host: "evil.example" },
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-mode": "navigate" },
      { "x-agentpay-proxy-identity": "spoofed" },
    ];
    for (const invalid of invalidHeaders) {
      const { handler } = createFixture();
      const response = await handler(new Request(`${origin}/api/setup/challenge`, {
        method: "POST", headers: apiHeaders(invalid), body: JSON.stringify({ ownerAddress: owner.address }),
      }));
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "SETUP_UNAVAILABLE" });
    }

    const { handler } = createFixture({ rateLimiter: { async allow() { throw new Error("redis down"); } } });
    const response = await handler(new Request(`${origin}/api/setup/challenge`, {
      method: "POST", headers: apiHeaders(), body: JSON.stringify({ ownerAddress: owner.address }),
    }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "SETUP_UNAVAILABLE" });

    const limited = createFixture({ rateLimiter: { async allow() { return false; } } });
    const limitedResponse = await limited.handler(new Request(`${origin}/api/setup/challenge`, {
      method: "POST", headers: apiHeaders(), body: JSON.stringify({ ownerAddress: owner.address }),
    }));
    assert.equal(limitedResponse.status, 429);
    assert.deepEqual(await limitedResponse.json(), { error: "SETUP_RATE_LIMITED" });
  });
});

describe("production onboarding challenge, authorization, and status", () => {
  it("derives and stores all policy fields server-side, returning capability once with a hardened cookie", async () => {
    const { fixture, response, body } = await createChallenge();
    assert.equal(response.status, 201);
    assert.match(body.capability, /^[A-Za-z0-9_-]{43}$/);
    assert.match(body.csrfToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(body.typedData.message.owner, owner.address.toLowerCase());
    assert.equal(body.typedData.message.homeChainId, 196);
    assert.equal(body.typedData.message.token, MAINNET_SETUP_USDT0);
    assert.equal(body.typedData.message.routeAllowlistHash, "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd");
    assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly; Secure; SameSite=Strict/);
    assert.equal(fixture.challenges.length, 1);
    assert.equal(fixture.challenges[0]?.ownerAddress, owner.address.toLowerCase());
    assert.equal(fixture.challenges[0]?.messageToSign, JSON.stringify(body.typedData));
    assert.equal(
      fixture.challenges[0]?.authorizationHash,
      TypedDataEncoder.hash(body.typedData.domain, body.typedData.types, body.typedData.message),
    );
    assert.doesNotMatch(JSON.stringify(fixture.challenges[0]), new RegExp(body.capability));
    assert.equal("signature" in body, false);
  });

  it("requires the bound cookie, capability, and CSRF then admits the valid owner signature idempotently", async () => {
    const challenge = await createChallenge();
    const cookie = challenge.response.headers.get("set-cookie")!;
    const signature = await owner.signTypedData(
      challenge.body.typedData.domain,
      challenge.body.typedData.types,
      challenge.body.typedData.message,
    );
    const authorizationRequest = (csrfToken = challenge.body.csrfToken, capability = challenge.body.capability) =>
      new Request(`${origin}/api/setup/authorize`, {
        method: "POST",
        headers: apiHeaders({
          cookie,
          "x-agentpay-setup-capability": capability,
          "x-agentpay-csrf-token": csrfToken,
        }),
        body: JSON.stringify({ signature }),
      });

    const badCsrf = await challenge.fixture.handler(authorizationRequest("A".repeat(43)));
    assert.equal(badCsrf.status, 404);
    assert.equal(challenge.fixture.admissions.length, 0);

    const first = await challenge.fixture.handler(authorizationRequest());
    const second = await challenge.fixture.handler(authorizationRequest());
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(challenge.fixture.admissions.length, 2);
    assert.equal(challenge.fixture.admissions[0]?.ownerSetupSignature, signature.toLowerCase());
    assert.equal("signature" in await first.json(), false);
  });

  it("does not consume admission for a wrong signature and returns only sanitized status", async () => {
    const challenge = await createChallenge();
    const wrongSignature = await Wallet.createRandom().signTypedData(
      challenge.body.typedData.domain,
      challenge.body.typedData.types,
      challenge.body.typedData.message,
    );
    const common = {
      cookie: challenge.response.headers.get("set-cookie")!,
      "x-agentpay-setup-capability": challenge.body.capability,
      "x-agentpay-csrf-token": challenge.body.csrfToken,
    };
    const wrong = await challenge.fixture.handler(new Request(`${origin}/api/setup/authorize`, {
      method: "POST", headers: apiHeaders(common), body: JSON.stringify({ signature: wrongSignature }),
    }));
    assert.equal(wrong.status, 400);
    assert.equal(challenge.fixture.admissions.length, 0);

    const { origin: _omittedOrigin, ...statusHeaders } = apiHeaders({
        cookie: common.cookie,
        "x-agentpay-setup-capability": common["x-agentpay-setup-capability"],
      });
    const statusResponse = await challenge.fixture.handler(new Request(`${origin}/api/setup/status`, {
      headers: statusHeaders,
    }));
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.deepEqual(status, challenge.fixture.status);
    assert.equal("signature" in status, false);
  });

  it("keeps health/status available but refuses new challenges in OFF and DRAIN", async () => {
    for (const mode of ["OFF", "DRAIN"] as const) {
      const { handler } = createFixture({ mode });
      const health = await handler(new Request(`${origin}/healthz`, { headers: { host } }));
      assert.equal(health.status, 200);
      const challenge = await handler(new Request(`${origin}/api/setup/challenge`, {
        method: "POST", headers: apiHeaders(), body: JSON.stringify({ ownerAddress: owner.address }),
      }));
      assert.equal(challenge.status, 503);
      assert.deepEqual(await challenge.json(), { error: "SETUP_NOT_ACCEPTING_CHALLENGES" });
    }
  });
});
