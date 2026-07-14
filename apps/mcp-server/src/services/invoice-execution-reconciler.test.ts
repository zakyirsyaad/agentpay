import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createInMemoryInvoiceExecutionOutboxStore } from "./paid-execution-outbox.ts";
import { reconcileInvoiceExecutionOutbox } from "./invoice-execution-reconciler.ts";
import type { PaidExecutionLifecycleStore } from "./paid-execution-lifecycle.ts";

const at = "2026-07-13T00:10:00.000Z";

async function createBroadcastedOutbox(status: "BROADCASTED" | "BROADCAST_UNKNOWN" = "BROADCASTED") {
  const outbox = createInMemoryInvoiceExecutionOutboxStore(() => "fence_reconcile");
  await outbox.enqueue({
    id: "outbox_reconcile",
    tenantId: "tenant_1",
    lifecycleId: "lifecycle_reconcile",
    paymentIntentId: "pay_reconcile",
    chainId: 196,
    executorAddress: "0x9999999999999999999999999999999999999999",
    createdAt: "2026-07-13T00:00:00.000Z",
  });
  await outbox.prepare("outbox_reconcile", {
    executorNonce: "1",
    transactionHash: `0x${"ab".repeat(32)}`,
    calldataHash: `0x${"cd".repeat(32)}`,
    ownerAuthorizationNonce: "1",
    rawTransaction: { ciphertext: "cipher", iv: "iv", tag: "tag", hash: "hash" },
    at: "2026-07-13T00:01:00.000Z",
  });
  if (status === "BROADCAST_UNKNOWN") {
    await outbox.markBroadcastUnknown("outbox_reconcile", "2026-07-13T00:03:00.000Z");
  } else {
    await outbox.markBroadcasted("outbox_reconcile", `0x${"ab".repeat(32)}`, "2026-07-13T00:02:00.000Z");
  }
  return outbox;
}

describe("invoice execution reconciler", () => {
  it("moves a stale queued reservation to manual review and requests a refund", async () => {
    const outbox = createInMemoryInvoiceExecutionOutboxStore();
    await outbox.enqueue({
      id: "outbox_stale",
      tenantId: "tenant_1",
      lifecycleId: "lifecycle_stale",
      paymentIntentId: "pay_stale",
      chainId: 196,
      executorAddress: "0x9999999999999999999999999999999999999999",
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    let refundReason = "";
    const lifecycle = {
      async markRefundRequired(_id: string, reason: string) {
        refundReason = reason;
      },
    } as never;

    const report = await reconcileInvoiceExecutionOutbox({
      outbox,
      lifecycle,
      sourceTransactions: { async getSourceTransactionStatus() { return { status: "PENDING" }; } },
      at: "2026-07-13T00:10:00.000Z",
      queuedGracePeriodMs: 60_000,
    });

    assert.deepEqual(report, { inspected: 1, pending: 0, finalized: 0, stalled: 1, errors: 0 });
    assert.match(refundReason, /signed transaction|queue/i);
    assert.equal((await outbox.get("outbox_stale"))?.status, "MANUAL_REVIEW");
  });

  it("does not infer a refund when the fee lifecycle is still unsettled", async () => {
    const outbox = createInMemoryInvoiceExecutionOutboxStore();
    await outbox.enqueue({
      id: "outbox_unsettled",
      tenantId: "tenant_1",
      lifecycleId: "lifecycle_unsettled",
      paymentIntentId: "pay_unsettled",
      chainId: 196,
      executorAddress: "0x9999999999999999999999999999999999999999",
      createdAt: "2026-07-13T00:00:00.000Z",
    });

    const lifecycle = {
      async markRefundRequired() {
        throw new Error("lifecycle is still SETTLING");
      },
    } as never;
    const report = await reconcileInvoiceExecutionOutbox({
      outbox,
      lifecycle,
      sourceTransactions: { async getSourceTransactionStatus() { throw new Error("must not query receipts"); } },
      at,
      queuedGracePeriodMs: 60_000,
    });

    assert.deepEqual(report, { inspected: 1, pending: 0, finalized: 0, stalled: 1, errors: 1 });
    assert.equal((await outbox.get("outbox_unsettled"))?.status, "MANUAL_REVIEW");
  });

  it("promotes a prepared transaction to broadcast-unknown and reconciles it without rebroadcasting", async () => {
    const preparedOutbox = createInMemoryInvoiceExecutionOutboxStore(() => "fence_prepared");
    await preparedOutbox.enqueue({
      id: "outbox_prepared",
      tenantId: "tenant_1",
      lifecycleId: "lifecycle_prepared",
      paymentIntentId: "pay_prepared",
      chainId: 196,
      executorAddress: "0x9999999999999999999999999999999999999999",
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    await preparedOutbox.prepare("outbox_prepared", {
      executorNonce: "2",
      transactionHash: `0x${"ef".repeat(32)}`,
      calldataHash: `0x${"cd".repeat(32)}`,
      ownerAuthorizationNonce: "2",
      rawTransaction: { ciphertext: "cipher", iv: "iv", tag: "tag", hash: "hash" },
      at: "2026-07-13T00:01:00.000Z",
    });
    const lifecycle = {
      async markExecutionReceipt(_id: string, success: boolean) {
        assert.equal(success, true);
      },
    } as unknown as PaidExecutionLifecycleStore;

    const report = await reconcileInvoiceExecutionOutbox({
      outbox: preparedOutbox,
      at,
      lifecycle,
      sourceTransactions: { async getSourceTransactionStatus() { return { status: "SUCCESS" }; } },
    });

    assert.deepEqual(report, { inspected: 1, pending: 0, finalized: 1, stalled: 0, errors: 0 });
    assert.equal((await preparedOutbox.get("outbox_prepared"))?.status, "CONFIRMED");
  });

  it("finalizes a persisted broadcast from its receipt without rebroadcasting", async () => {
    const outbox = await createBroadcastedOutbox();
    let receiptCalls = 0;
    const report = await reconcileInvoiceExecutionOutbox({
      outbox,
      at,
      sourceTransactions: {
        async getSourceTransactionStatus(request) {
          receiptCalls += 1;
          assert.equal(request.txHash, `0x${"ab".repeat(32)}`);
          assert.equal(request.chainId, 196);
          return { status: "SUCCESS" };
        },
      },
    });

    assert.deepEqual(report, { inspected: 1, pending: 0, finalized: 1, stalled: 0, errors: 0 });
    assert.equal(receiptCalls, 1);
    assert.equal((await outbox.get("outbox_reconcile"))?.status, "CONFIRMED");
  });

  it("keeps pending and unknown receipts recoverable", async () => {
    const pendingOutbox = await createBroadcastedOutbox();
    const pending = await reconcileInvoiceExecutionOutbox({
      outbox: pendingOutbox,
      at,
      sourceTransactions: { async getSourceTransactionStatus() { return { status: "PENDING" }; } },
    });
    assert.deepEqual(pending, { inspected: 1, pending: 1, finalized: 0, stalled: 0, errors: 0 });
    assert.equal((await pendingOutbox.get("outbox_reconcile"))?.status, "BROADCASTED");

    const unknownOutbox = await createBroadcastedOutbox("BROADCAST_UNKNOWN");
    const failed = await reconcileInvoiceExecutionOutbox({
      outbox: unknownOutbox,
      at,
      sourceTransactions: { async getSourceTransactionStatus() { return { status: "FAILED" }; } },
    });
    assert.deepEqual(failed, { inspected: 1, pending: 0, finalized: 1, stalled: 0, errors: 0 });
    assert.equal((await unknownOutbox.get("outbox_reconcile"))?.status, "REVERTED");
  });
});
