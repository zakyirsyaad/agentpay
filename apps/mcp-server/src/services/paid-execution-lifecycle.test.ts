import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PaymentPayload, PaymentRequirements } from "@okxweb3/x402-core/types";

import {
  canonicalJson,
  createInMemoryPaidExecutionLifecycleStore,
  createPaidExecutionIdempotencyKey,
  createPaidExecutionLifecycleClaimInput,
  extractPaymentIdentifier,
  hashCanonicalJson,
  parsePaidExecutionRequest,
  PaidExecutionRequestError,
} from "./paid-execution-lifecycle.ts";

const paymentRequirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:196",
  asset: "0x0000000000000000000000000000000000000001",
  amount: "10000",
  payTo: "0x0000000000000000000000000000000000000002",
  maxTimeoutSeconds: 300,
  extra: {},
};

const paymentPayload: PaymentPayload = {
  x402Version: 2,
  accepted: paymentRequirements,
  payload: { authorization: { from: "0x0000000000000000000000000000000000000003", nonce: "nonce-1" } },
  extensions: {
    "payment-identifier": {
      info: { id: "pay_identifier_123456" },
    },
  },
};

const validBody = Buffer.from(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "execute_payment",
      arguments: {
        paymentIntentId: "pay_123",
        signature: `0x${"11".repeat(65)}`,
      },
    },
  }),
);

describe("paid execution lifecycle bindings", () => {
  it("canonicalizes object key order before hashing", () => {
    assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
    assert.equal(hashCanonicalJson({ b: 2, a: 1 }), hashCanonicalJson({ a: 1, b: 2 }));
  });

  it("accepts one signed execute_payment JSON-RPC request and binds its hashes", () => {
    const binding = parsePaidExecutionRequest(validBody);

    assert.equal(binding.toolName, "execute_payment");
    assert.equal(binding.input.paymentIntentId, "pay_123");
    assert.match(binding.requestHash, /^[a-f0-9]{64}$/);
    assert.match(binding.argumentsHash, /^[a-f0-9]{64}$/);
  });

  it("rejects malformed, batched, wrong-tool, and unsigned paid requests before payment processing", () => {
    const invalidBodies = [
      Buffer.from("{"),
      Buffer.from("[]"),
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "resources/read", params: {} })),
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "get_balance", arguments: {} } })),
      Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "execute_payment", arguments: { paymentIntentId: "pay_123", approvalText: "APPROVE pay_123" } },
      })),
    ];

    for (const body of invalidBodies) {
      assert.throws(
        () => parsePaidExecutionRequest(body),
        (error) => error instanceof PaidExecutionRequestError,
      );
    }
  });

  it("extracts and validates the x402 payment identifier extension", () => {
    assert.equal(extractPaymentIdentifier(paymentPayload), "pay_identifier_123456");
    assert.equal(
      extractPaymentIdentifier({ ...paymentPayload, extensions: undefined }),
      undefined,
    );
    assert.throws(
      () => extractPaymentIdentifier({ ...paymentPayload, extensions: { "payment-identifier": { info: { id: "bad" } } } }),
      /payment identifier/i,
    );
  });

  it("allows exactly one concurrent lifecycle claim and replays the same binding", async () => {
    const store = createInMemoryPaidExecutionLifecycleStore(() => "life_1");
    const binding = parsePaidExecutionRequest(validBody);
    const input = createPaidExecutionLifecycleClaimInput({
      lifecycleId: "life_1",
      binding,
      paymentPayload,
      paymentRequirements,
      createdAt: "2026-07-13T00:00:00.000Z",
    });

    const claims = await Promise.all(Array.from({ length: 20 }, () => store.claim(input)));
    assert.equal(claims.filter((claim) => claim.disposition === "CLAIMED").length, 1);
    assert.equal(claims.filter((claim) => claim.disposition === "REPLAY").length, 19);
    assert.equal(new Set(claims.map((claim) => claim.record.id)).size, 1);

    const changedBinding = parsePaidExecutionRequest(
      Buffer.from(validBody.toString("utf8").replace('"pay_123"', '"pay_456"')),
    );
    const conflict = await store.claim(
      createPaidExecutionLifecycleClaimInput({
        lifecycleId: "life_2",
        binding: changedBinding,
        paymentPayload,
        paymentRequirements,
        createdAt: "2026-07-13T00:00:01.000Z",
      }),
    );
    assert.equal(conflict.disposition, "CONFLICT");
    assert.match(
      createPaidExecutionIdempotencyKey({ paymentIdentifier: "pay_identifier_123456", paymentPayloadHash: "x" }),
      /^v2:[a-f0-9]{64}$/,
    );
  });

  it("stores a deterministic response for lost-response replay", async () => {
    const store = createInMemoryPaidExecutionLifecycleStore(() => "life_2");
    const binding = parsePaidExecutionRequest(validBody);
    const input = createPaidExecutionLifecycleClaimInput({
      lifecycleId: "life_2",
      binding,
      paymentPayload,
      paymentRequirements,
      createdAt: "2026-07-13T00:00:00.000Z",
    });

    const claim = await store.claim(input);
    assert.equal(claim.disposition, "CLAIMED");
    await store.markSettling("life_2", "2026-07-13T00:00:01.000Z");
    await store.markSettled("life_2", {
      transaction: `0x${"22".repeat(32)}`,
      headers: { "PAYMENT-RESPONSE": "receipt" },
      at: "2026-07-13T00:00:02.000Z",
    });
    await store.markExecuting("life_2", "2026-07-13T00:00:03.000Z");
    const completed = await store.markCompleted(
      "life_2",
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from("deterministic result"),
      },
      "2026-07-13T00:00:04.000Z",
    );

    assert.equal(completed.status, "COMPLETED");
    assert.equal(Buffer.from(completed.responseBodyBase64!, "base64").toString("utf8"), "deterministic result");
    const replay = await store.claim(input);
    assert.equal(replay.disposition, "REPLAY");
    assert.equal(replay.record.settlementTxHash, `0x${"22".repeat(32)}`);
    assert.equal(replay.record.responseStatus, 200);
  });

  it("keeps response completion separate from broadcast and receipt state", async () => {
    const store = createInMemoryPaidExecutionLifecycleStore(() => "life_receipt");
    const binding = parsePaidExecutionRequest(validBody);
    const input = createPaidExecutionLifecycleClaimInput({
      lifecycleId: "life_receipt",
      binding,
      paymentPayload,
      paymentRequirements,
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    await store.claim(input);
    await store.markSettling("life_receipt", "2026-07-13T00:00:01.000Z");
    await store.markSettled("life_receipt", {
      transaction: `0x${"33".repeat(32)}`,
      headers: {},
      at: "2026-07-13T00:00:02.000Z",
    });
    await store.markExecuting("life_receipt", "2026-07-13T00:00:03.000Z");
    await store.markExecutionBroadcasted("life_receipt", `0x${"44".repeat(32)}`, "2026-07-13T00:00:04.000Z");
    const completed = await store.markCompleted(
      "life_receipt",
      { status: 200, headers: {}, body: Buffer.from("ok") },
      "2026-07-13T00:00:05.000Z",
    );
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.executionStatus, "BROADCASTED");
    assert.equal(completed.executionTxHash, `0x${"44".repeat(32)}`);

    const confirmed = await store.markExecutionReceipt("life_receipt", true, "2026-07-13T00:00:06.000Z");
    assert.equal(confirmed.status, "COMPLETED");
    assert.equal(confirmed.executionStatus, "CONFIRMED");
  });
});
