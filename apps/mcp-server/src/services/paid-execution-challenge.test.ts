import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createInMemoryPaidExecutionChallengeStore } from "./paid-execution-challenge.ts";

const offer = {
  id: "challenge_1",
  tenantId: "tenant_1",
  environment: "staging" as const,
  paymentIntentId: "pay_1",
  ownerAddress: "0x1111111111111111111111111111111111111111",
  accountAddress: "0x2222222222222222222222222222222222222222",
  requestHash: "a".repeat(64),
  argumentsHash: "b".repeat(64),
  authorizationHash: `0x${"c".repeat(64)}`,
  feeTermsHash: "d".repeat(64),
  paymentRequirementsHash: "e".repeat(64),
  offeredAt: "2026-07-13T00:00:00.000Z",
  expiresAt: "2026-07-13T00:05:00.000Z",
};

describe("paid execution challenge ledger", () => {
  it("offers once, consumes atomically, and replays a consumed challenge", async () => {
    const store = createInMemoryPaidExecutionChallengeStore(() => "challenge_1");
    assert.equal((await store.offer(offer)).disposition, "OFFERED");
    assert.equal((await store.offer(offer)).disposition, "REPLAY");
    const consumed = await store.consume({
      tenantId: offer.tenantId,
      requestHash: offer.requestHash,
      argumentsHash: offer.argumentsHash,
      authorizationHash: offer.authorizationHash,
      paymentRequirementsHash: offer.paymentRequirementsHash,
      at: "2026-07-13T00:01:00.000Z",
    });
    assert.equal(consumed?.status, "CONSUMED");
    const replay = await store.consume({
      tenantId: offer.tenantId,
      requestHash: offer.requestHash,
      argumentsHash: offer.argumentsHash,
      authorizationHash: offer.authorizationHash,
      paymentRequirementsHash: offer.paymentRequirementsHash,
      at: "2026-07-13T00:02:00.000Z",
    });
    assert.equal(replay?.status, "CONSUMED");
  });

  it("does not consume a challenge with altered args or after expiry", async () => {
    const store = createInMemoryPaidExecutionChallengeStore(() => "challenge_1");
    await store.offer(offer);
    assert.equal(
      await store.consume({
        tenantId: offer.tenantId,
        requestHash: offer.requestHash,
        argumentsHash: "f".repeat(64),
        authorizationHash: offer.authorizationHash,
        paymentRequirementsHash: offer.paymentRequirementsHash,
        at: "2026-07-13T00:01:00.000Z",
      }),
      null,
    );
    assert.equal(await store.expire("2026-07-13T00:06:00.000Z"), 1);
    assert.equal(
      await store.consume({
        tenantId: offer.tenantId,
        requestHash: offer.requestHash,
        argumentsHash: offer.argumentsHash,
        authorizationHash: offer.authorizationHash,
        paymentRequirementsHash: offer.paymentRequirementsHash,
        at: "2026-07-13T00:06:01.000Z",
      }),
      null,
    );
  });
});
