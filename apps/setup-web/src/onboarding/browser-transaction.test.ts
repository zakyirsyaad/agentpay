import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ONBOARDING_BODY_LIMIT_BYTES,
  createBrowserTransaction,
  hashBrowserSecret,
  readBoundedJsonBody,
  verifyBrowserTransaction,
} from "./browser-transaction.ts";

const cookieSecret = "cookie-secret-that-is-at-least-thirty-two-bytes";
const capabilitySecret = "capability-secret-that-is-at-least-thirty-two-bytes";
const now = new Date("2026-07-17T08:00:00.000Z");
const expiresAt = new Date("2026-07-17T08:10:00.000Z");

describe("production onboarding browser transaction", () => {
  it("creates independent 256-bit tokens and a signed hardened cookie", () => {
    let fill = 1;
    const transaction = createBrowserTransaction({
      cookieSecret,
      capabilitySecret,
      expiresAt,
      randomBytes: (size) => Uint8Array.from({ length: size }, () => fill++),
    });

    assert.match(transaction.capability, /^[A-Za-z0-9_-]{43}$/);
    assert.match(transaction.csrfToken, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(transaction.capability, transaction.csrfToken);
    assert.equal(transaction.capabilityDigest, hashBrowserSecret(transaction.capability, capabilitySecret));
    assert.match(transaction.setCookie, /^__Host-agentpay_setup=/);
    assert.match(transaction.setCookie, /Path=\/; HttpOnly; Secure; SameSite=Strict/);
    assert.doesNotMatch(transaction.setCookie, new RegExp(transaction.capability));
    assert.doesNotMatch(transaction.setCookie, new RegExp(transaction.csrfToken));

    assert.deepEqual(
      verifyBrowserTransaction({
        cookieHeader: transaction.setCookie,
        capability: transaction.capability,
        csrfToken: transaction.csrfToken,
        cookieSecret,
        capabilitySecret,
        now,
        requireCsrf: true,
      }),
      { capabilityDigest: transaction.capabilityDigest },
    );
  });

  it("rejects missing, tampered, expired, capability-mismatched, and CSRF-mismatched transactions", () => {
    let fill = 9;
    const transaction = createBrowserTransaction({
      cookieSecret,
      capabilitySecret,
      expiresAt,
      randomBytes: (size) => new Uint8Array(size).fill(fill++),
    });
    const base = {
      cookieHeader: transaction.setCookie,
      capability: transaction.capability,
      csrfToken: transaction.csrfToken,
      cookieSecret,
      capabilitySecret,
      now,
      requireCsrf: true,
    } as const;

    assert.equal(verifyBrowserTransaction({ ...base, cookieHeader: undefined }), null);
    const [cookieValue, ...attributes] = transaction.setCookie.split(";");
    const tamperedCookie = `${cookieValue.slice(0, -1)}${cookieValue.endsWith("A") ? "B" : "A"};${attributes.join(";")}`;
    assert.equal(verifyBrowserTransaction({ ...base, cookieHeader: tamperedCookie }), null);
    assert.equal(verifyBrowserTransaction({ ...base, capability: "A".repeat(43) }), null);
    assert.equal(verifyBrowserTransaction({ ...base, csrfToken: "B".repeat(43) }), null);
    assert.equal(
      verifyBrowserTransaction({ ...base, now: new Date("2026-07-17T08:10:00.000Z") }),
      null,
    );
  });
});

describe("bounded onboarding JSON", () => {
  it("accepts JSON within the limit and rejects before buffering an oversized declared body", async () => {
    const small = new Request("https://onboard.agentpay.site/api/setup/challenge", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "17" },
      body: JSON.stringify({ hello: "world" }),
    });
    assert.deepEqual(await readBoundedJsonBody(small), { hello: "world" });

    const oversized = new Request("https://onboard.agentpay.site/api/setup/challenge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(ONBOARDING_BODY_LIMIT_BYTES + 1),
      },
      body: new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([1])); } }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await assert.rejects(() => readBoundedJsonBody(oversized), /SETUP_BODY_TOO_LARGE/);
  });

  it("rejects non-JSON, malformed JSON, and streamed bodies over 4 KiB", async () => {
    await assert.rejects(
      () => readBoundedJsonBody(new Request("https://onboard.agentpay.site", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      })),
      /SETUP_JSON_REQUIRED/,
    );
    await assert.rejects(
      () => readBoundedJsonBody(new Request("https://onboard.agentpay.site", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })),
      /SETUP_JSON_INVALID/,
    );
    await assert.rejects(
      () => readBoundedJsonBody(new Request("https://onboard.agentpay.site", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: "x".repeat(ONBOARDING_BODY_LIMIT_BYTES) }),
      })),
      /SETUP_BODY_TOO_LARGE/,
    );
  });
});
