import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createInMemoryInvoiceExecutionOutboxStore,
  decryptRawTransaction,
  encryptRawTransaction,
} from "./paid-execution-outbox.ts";

describe("paid invoice execution outbox", () => {
  it("encrypts raw signed transaction bytes and verifies their hash", () => {
    const key = "11".repeat(32);
    const encrypted = encryptRawTransaction("0xdeadbeef", key);
    assert.notEqual(encrypted.ciphertext, "0xdeadbeef");
    assert.equal(decryptRawTransaction(encrypted, key), "0xdeadbeef");
    assert.throws(() => decryptRawTransaction(encrypted, "22".repeat(32)), /integrity|authenticate/i);
  });

  it("persists one signed transaction before allowing broadcast and receipt reconciliation", async () => {
    const store = createInMemoryInvoiceExecutionOutboxStore(() => "fence_1");
    const queued = await store.enqueue({
      id: "outbox_1",
      tenantId: "tenant_1",
      lifecycleId: "life_1",
      paymentIntentId: "pay_1",
      chainId: 196,
      executorAddress: "0x1111111111111111111111111111111111111111",
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    assert.equal(queued.disposition, "QUEUED");
    const prepared = await store.prepare("outbox_1", {
      executorNonce: "7",
      transactionHash: `0x${"aa".repeat(32)}`,
      calldataHash: `0x${"bb".repeat(32)}`,
      ownerAuthorizationNonce: "3",
      rawTransaction: encryptRawTransaction("0x1234", "11".repeat(32)),
      at: "2026-07-13T00:00:01.000Z",
    });
    assert.equal(prepared.status, "TX_PREPARED");
    assert.equal(prepared.fencingToken, "fence_1");
    await assert.rejects(() => store.markBroadcasted("outbox_1", `0x${"cc".repeat(32)}`, "2026-07-13T00:00:02.000Z"), /does not match/);
    await store.markBroadcastUnknown("outbox_1", "2026-07-13T00:00:02.000Z");
    const broadcasted = await store.markBroadcasted("outbox_1", `0x${"aa".repeat(32)}`, "2026-07-13T00:00:03.000Z");
    assert.equal(broadcasted.status, "BROADCASTED");
    const confirmed = await store.markReceipt("outbox_1", true, "2026-07-13T00:00:04.000Z");
    assert.equal(confirmed.status, "CONFIRMED");
  });

  it("rejects a second lifecycle item from reserving the same executor nonce", async () => {
    const store = createInMemoryInvoiceExecutionOutboxStore();
    await store.enqueue({
      id: "outbox_1",
      tenantId: "tenant_1",
      lifecycleId: "life_1",
      paymentIntentId: "pay_1",
      chainId: 196,
      executorAddress: "0x1111111111111111111111111111111111111111",
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    await store.enqueue({
      id: "outbox_2",
      tenantId: "tenant_1",
      lifecycleId: "life_2",
      paymentIntentId: "pay_2",
      chainId: 196,
      executorAddress: "0x1111111111111111111111111111111111111111",
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    const tx = {
      executorNonce: "7",
      transactionHash: `0x${"aa".repeat(32)}`,
      calldataHash: `0x${"bb".repeat(32)}`,
      ownerAuthorizationNonce: "3",
      rawTransaction: encryptRawTransaction("0x1234", "11".repeat(32)),
      at: "2026-07-13T00:00:01.000Z",
    };
    await store.prepare("outbox_1", tx);
    await assert.rejects(() => store.prepare("outbox_2", { ...tx, transactionHash: `0x${"cc".repeat(32)}` }), /nonce/);
  });

  it("does not overwrite an existing outbox id with a different lifecycle binding", async () => {
    const store = createInMemoryInvoiceExecutionOutboxStore();
    const input = {
      id: "outbox_same",
      tenantId: "tenant_1",
      lifecycleId: "life_1",
      paymentIntentId: "pay_1",
      chainId: 196,
      executorAddress: "0x1111111111111111111111111111111111111111",
      createdAt: "2026-07-13T00:00:00.000Z",
    };
    assert.equal((await store.enqueue(input)).disposition, "QUEUED");
    const conflict = await store.enqueue({ ...input, lifecycleId: "life_2", paymentIntentId: "pay_2" });
    assert.equal(conflict.disposition, "CONFLICT");
    assert.equal((await store.get("outbox_same"))?.lifecycleId, "life_1");
  });

  it("claims a broadcast row with a fencing token before receipt reconciliation", async () => {
    const store = createInMemoryInvoiceExecutionOutboxStore(() => "fence_claim");
    await store.enqueue({
      id: "outbox_claim",
      tenantId: "tenant_1",
      lifecycleId: "life_claim",
      paymentIntentId: "pay_claim",
      chainId: 196,
      executorAddress: "0x9999999999999999999999999999999999999999",
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    await store.prepare("outbox_claim", {
      executorNonce: "1",
      transactionHash: `0x${"ab".repeat(32)}`,
      calldataHash: `0x${"cd".repeat(32)}`,
      ownerAuthorizationNonce: "1",
      rawTransaction: { ciphertext: "cipher", iv: "iv", tag: "tag", hash: "hash" },
      at: "2026-07-13T00:01:00.000Z",
    });
    await store.markBroadcasted("outbox_claim", `0x${"ab".repeat(32)}`, "2026-07-13T00:02:00.000Z", "fence_claim");

    const claimed = await store.claimRecoverable(
      "outbox_claim",
      "2026-07-13T00:03:00.000Z",
      "2026-07-13T00:03:30.000Z",
    );
    assert.equal(claimed?.fencingToken, "fence_claim");
    await assert.rejects(
      () => store.markReceipt("outbox_claim", true, "2026-07-13T00:04:00.000Z", "stale_fence"),
      /fencing/i,
    );
    await store.markReceipt("outbox_claim", true, "2026-07-13T00:04:00.000Z", claimed?.fencingToken);
    assert.equal((await store.get("outbox_claim"))?.status, "CONFIRMED");
  });
});
