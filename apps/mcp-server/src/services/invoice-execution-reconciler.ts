import type { SourceTransactionStatusProvider } from "../tools/payment-tracking.ts";
import type { PaidExecutionLifecycleStore } from "./paid-execution-lifecycle.ts";
import type { InvoiceExecutionOutboxStore } from "./paid-execution-outbox.ts";

export interface InvoiceExecutionReconciliationResult {
  inspected: number;
  pending: number;
  finalized: number;
  stalled: number;
  errors: number;
}

/**
 * Reconcile only persisted invoice transactions. A missing receipt is not a
 * failure: the transaction may still be pending. The worker never creates a
 * new transaction and therefore cannot double-spend after a broadcast crash.
 */
export async function reconcileInvoiceExecutionOutbox(options: {
  outbox: InvoiceExecutionOutboxStore;
  sourceTransactions: SourceTransactionStatusProvider;
  lifecycle?: PaidExecutionLifecycleStore;
  at: string;
  queuedGracePeriodMs?: number;
}): Promise<InvoiceExecutionReconciliationResult> {
  const records = await options.outbox.listRecoverable(options.at);
  const result: InvoiceExecutionReconciliationResult = {
    inspected: records.length,
    pending: 0,
    finalized: 0,
    stalled: 0,
    errors: 0,
  };
  const queuedGracePeriodMs = options.queuedGracePeriodMs ?? 5 * 60_000;

  for (const record of records) {
    let candidate = record;
    if (candidate.status === "QUEUED") {
      const queuedAt = Date.parse(candidate.updatedAt);
      const currentAt = Date.parse(options.at);
      if (
        Number.isFinite(queuedAt) &&
        Number.isFinite(currentAt) &&
        currentAt - queuedAt >= queuedGracePeriodMs
      ) {
        try {
          // Claim the stale queue row before compensating it. The lease and
          // fencing token make concurrent reconcilers converge on one manual
          // review decision instead of issuing duplicate refund work.
          const leaseUntil = new Date(currentAt + 30_000).toISOString();
          const claimed = await options.outbox.claimRecoverable(candidate.id, options.at, leaseUntil);
          if (!claimed) continue;
          if (options.lifecycle) {
            try {
              await options.lifecycle.markRefundRequired(
                candidate.lifecycleId,
                "Execution queue stalled before a signed transaction was persisted; manual review is required.",
                options.at,
              );
            } catch {
              // A SETTLING/CLAIMED lifecycle may not have a settled fee yet.
              // Keep the outbox decision manual-review-only until an operator
              // confirms the facilitator outcome; never infer a refund here.
              result.errors += 1;
            }
          }
          await options.outbox.markManualReview(
            candidate.id,
            "EXECUTION_QUEUE_STALLED",
            "No signed transaction was persisted before the execution queue grace period elapsed.",
            options.at,
            claimed.fencingToken,
          );
          result.stalled += 1;
        } catch {
          result.errors += 1;
        }
      }
      continue;
    }
    if (candidate.status === "TX_PREPARED") {
      try {
        candidate = await options.outbox.markBroadcastUnknown(candidate.id, options.at, candidate.fencingToken);
      } catch {
        result.errors += 1;
        continue;
      }
    }
    if (!(candidate.status === "BROADCASTED" || candidate.status === "BROADCAST_UNKNOWN") || !candidate.transactionHash) {
      continue;
    }

    const leaseUntil = new Date(Date.parse(options.at) + 30_000).toISOString();
    const claimed = await options.outbox.claimRecoverable(candidate.id, options.at, leaseUntil);
    if (!claimed || !claimed.transactionHash) continue;

    try {
      const receipt = await options.sourceTransactions.getSourceTransactionStatus({
        txHash: claimed.transactionHash,
        chainId: claimed.chainId,
      });
      if (receipt.status === "PENDING") {
        result.pending += 1;
        continue;
      }
      const success = receipt.status === "SUCCESS";
      if (options.lifecycle) {
        await options.lifecycle.markExecutionReceipt(claimed.lifecycleId, success, options.at);
      }
      await options.outbox.markReceipt(claimed.id, success, options.at, claimed.fencingToken);
      result.finalized += 1;
    } catch {
      result.errors += 1;
    }
  }

  return result;
}
