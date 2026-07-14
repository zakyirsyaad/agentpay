import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SetupIntentRecord } from "@agentpay-ai/shared";

import { createSetupWebHandler, renderSetupPage, startSetupWebServer } from "./server.ts";

const setupIntent: SetupIntentRecord = {
  id: "setup_123",
  executorAddress: "0x4444444444444444444444444444444444444444",
  messageToSign: "AgentPay wallet setup\nSetup intent: setup_123",
  status: "PENDING",
  expiresAt: "2026-07-03T04:15:00.000Z",
};

describe("renderSetupPage", () => {
  it("renders the setup app shell with stable asset hooks", () => {
    const html = renderSetupPage();

    assert.match(html, /<main class="setup-shell"/);
    assert.match(html, /id="setup-root"/);
    assert.match(html, /AgentPay setup/);
    assert.match(html, /id="owner-address"/);
    assert.match(html, /Connected wallet does not match the expected owner address/);
    assert.match(html, /window\.AgentPaySetup/);
  });
});

describe("createSetupWebHandler", () => {
  it("serves setup HTML", async () => {
    const handler = createSetupWebHandler(createDependencies());
    const response = await handler(new Request("http://localhost:3000/setup?setup_intent_id=setup_123"));

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /AgentPay setup/);
  });

  it("serves the Review & Sign page with a no-store CSP", async () => {
    const handler = createSetupWebHandler(createDependencies());
    const response = await handler(new Request("http://localhost:3000/review"));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.match(await response.text(), /Review &amp; Sign/);
  });

  it("returns setup intent JSON", async () => {
    const handler = createSetupWebHandler(createDependencies());
    const response = await handler(new Request("http://localhost:3000/api/setup-intents/setup_123"));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.setupIntentId, "setup_123");
    assert.equal(body.status, "PENDING");
    assert.equal(body.messageToSign, setupIntent.messageToSign);
  });

  it("returns 404 for missing setup intents", async () => {
    const handler = createSetupWebHandler(createDependencies({ setupIntent: null }));
    const response = await handler(new Request("http://localhost:3000/api/setup-intents/missing"));
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.match(body.error, /not found/);
  });

  it("submits setup completion", async () => {
    const completions: unknown[] = [];
    const handler = createSetupWebHandler(
      createDependencies({
        async completeWalletSetup(input) {
          completions.push(input);
          return {
            setupIntentId: "setup_123",
            status: "COMPLETED",
            ownerAddress: "0x2222222222222222222222222222222222222222",
            accountAddress: "0x3333333333333333333333333333333333333333",
            completedAt: "2026-07-03T04:02:00.000Z",
          };
        },
      }),
    );

    const response = await handler(
      new Request("http://localhost:3000/api/setup-complete", {
        method: "POST",
        body: JSON.stringify({
          setupIntentId: "setup_123",
          signature: `0x${"a".repeat(130)}`,
        }),
      }),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, "COMPLETED");
    assert.deepEqual(completions, [
      {
        setupIntentId: "setup_123",
        signature: `0x${"a".repeat(130)}`,
      },
    ]);
  });
});

describe("startSetupWebServer", () => {
  it("returns the actual ephemeral port selected by the operating system", async () => {
    const server = await startSetupWebServer(createDependencies(), { port: 0 });

    try {
      const url = new URL(server.url);
      assert.notEqual(url.port, "0");
      assert.equal((await fetch(new URL("/review", url))).status, 200);
    } finally {
      await server.close();
    }
  });

  it("returns a generic no-store response when a dependency fails", async () => {
    const server = await startSetupWebServer(createDependencies({
      async getSetupIntent() {
        throw new Error("sensitive repository failure");
      },
    }), { port: 0 });

    try {
      const response = await fetch(new URL("/api/setup-intents/setup_123", server.url));
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(body, { error: "Service unavailable." });
      assert.doesNotMatch(JSON.stringify(body), /sensitive repository failure/);
    } finally {
      await server.close();
    }
  });

  it("uses the proxy-appended client address instead of a spoofed forwarded prefix", async () => {
    const clientIds: string[] = [];
    const server = await startSetupWebServer(createDependencies({
      rateLimiter: {
        allow(_token, _now, clientId) {
          clientIds.push(clientId ?? "direct");
          return false;
        },
        entryCount: 0,
        clientEntryCount: 0,
      },
    }), { port: 0 });

    try {
      const reviewUrl = new URL("/api/payment-review", server.url);
      const token = `apr_${"a".repeat(43)}`;
      await fetch(reviewUrl, {
        headers: {
          "x-agentpay-review-token": token,
          "x-forwarded-for": "203.0.113.111, 198.51.100.42",
        },
      });
      await fetch(reviewUrl, {
        headers: {
          "x-agentpay-review-token": token,
          "x-forwarded-for": "203.0.113.222, 198.51.100.42",
        },
      });

      assert.deepEqual(clientIds, ["198.51.100.42", "198.51.100.42"]);
    } finally {
      await server.close();
    }
  });
});

function createDependencies(overrides: Partial<Parameters<typeof createSetupWebHandler>[0]> & { setupIntent?: SetupIntentRecord | null } = {}) {
  const { setupIntent: intentOverride, ...rest } = overrides;

  return {
    async getSetupIntent() {
      return intentOverride === undefined ? setupIntent : intentOverride;
    },
    async completeWalletSetup() {
      return {
        setupIntentId: "setup_123",
        status: "COMPLETED" as const,
        ownerAddress: "0x2222222222222222222222222222222222222222",
        accountAddress: "0x3333333333333333333333333333333333333333",
        completedAt: "2026-07-03T04:02:00.000Z",
      };
    },
    clock: () => new Date("2026-07-03T04:00:00.000Z"),
    ...rest,
  };
}
