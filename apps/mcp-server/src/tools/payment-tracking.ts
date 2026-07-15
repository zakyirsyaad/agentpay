import {
  listPaymentEventsInputSchema,
  type ListPaymentEventsInput,
  listTransactionsInputSchema,
  type ListTransactionsInput,
  type PaymentEventRecord,
  type PaymentIntentRecord,
  type PaymentIntentStatus,
  type PaymentType,
  type TrackPaymentInput,
  trackPaymentInputSchema,
} from "@agentpay-ai/shared";

export interface RouteStatusRequest {
  txHash: string;
  fromChainId: number;
  toChainId: number;
}

export interface RouteStatusResult {
  status: "NOT_FOUND" | "INVALID" | "PENDING" | "DONE" | "FAILED";
  substatus?: string;
  substatusMessage?: string;
  destinationTxHash?: string;
}

export interface RouteStatusProvider {
  getRouteStatus(request: RouteStatusRequest): Promise<RouteStatusResult>;
}

export interface SourceTransactionStatusRequest {
  txHash: string;
  chainId: number;
}

export interface SourceTransactionStatusResult {
  status: "PENDING" | "SUCCESS" | "FAILED";
}

export interface SourceTransactionStatusProvider {
  getSourceTransactionStatus(request: SourceTransactionStatusRequest): Promise<SourceTransactionStatusResult>;
}

export interface TrackPaymentIntentRepository {
  getPaymentIntent(paymentIntentId: string): Promise<PaymentIntentRecord | null>;
  markPaymentCompleted(paymentIntentId: string, destinationTxHash: string | undefined, completedAt: string, tenantId?: string): Promise<void>;
  markPaymentFailed(paymentIntentId: string, errorCode: string, errorMessage: string, tenantId?: string): Promise<void>;
}

export interface ListPaymentIntentRepository {
  listPaymentIntents(request: { limit: number }): Promise<PaymentIntentRecord[]>;
}

export interface ListPaymentEventRepository {
  listPaymentEvents(request: { paymentIntentId: string; limit: number }): Promise<PaymentEventRecord[]>;
}

export interface TrackPaymentDependencies {
  paymentIntents: TrackPaymentIntentRepository;
  routeStatuses: RouteStatusProvider;
  sourceTransactions: SourceTransactionStatusProvider;
  clock: () => Date;
}

export interface ListTransactionsDependencies {
  paymentIntents: ListPaymentIntentRepository;
}

export interface ListPaymentEventsDependencies {
  paymentEvents: ListPaymentEventRepository;
}

export interface TrackPaymentOutput {
  paymentIntentId: string;
  status: PaymentIntentStatus;
  sourceTxHash?: string;
  destinationTxHash?: string;
  message: string;
}

export interface ListTransactionsOutput {
  transactions: Array<{
    paymentIntentId: string;
    status: PaymentIntentStatus;
    paymentType: PaymentType;
    amountOut: string;
    destinationTokenSymbol: string;
    destinationChainId: number;
    recipientAddress: string;
    sourceTxHash?: string;
    destinationTxHash?: string;
    createdAt: string;
  }>;
}

export interface ListPaymentEventsOutput {
  events: Array<{
    eventId: string;
    paymentIntentId: string;
    eventType: string;
    message?: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
}

export async function trackPayment(
  rawInput: TrackPaymentInput,
  dependencies: TrackPaymentDependencies,
): Promise<TrackPaymentOutput> {
  const input = trackPaymentInputSchema.parse(rawInput);
  const intent = await dependencies.paymentIntents.getPaymentIntent(input.paymentIntentId);

  if (!intent) {
    throw new Error(`Payment intent ${input.paymentIntentId} was not found.`);
  }

  if (intent.status !== "EXECUTING" || !intent.sourceTxHash) {
    return toStoredStatusOutput(intent);
  }

  if (intent.routeProvider === "DIRECT" || intent.routeProvider === "CONTRACT_CALL") {
    const sourceStatus = await dependencies.sourceTransactions.getSourceTransactionStatus({
      txHash: intent.sourceTxHash,
      chainId: intent.sourceChainId,
    });

    if (sourceStatus.status === "SUCCESS") {
      await dependencies.paymentIntents.markPaymentCompleted(
        intent.id,
        intent.sourceTxHash,
        dependencies.clock().toISOString(),
        intent.tenantId,
      );

      return {
        paymentIntentId: intent.id,
        status: "COMPLETED",
        sourceTxHash: intent.sourceTxHash,
        destinationTxHash: intent.sourceTxHash,
        message: sourceOnlyCompletedMessage(intent.routeProvider),
      };
    }

    if (sourceStatus.status === "FAILED") {
      const message = sourceOnlyFailedMessage(intent.routeProvider);
      await dependencies.paymentIntents.markPaymentFailed(intent.id, "SOURCE_TX_FAILED", message, intent.tenantId);

      return {
        paymentIntentId: intent.id,
        status: "FAILED",
        sourceTxHash: intent.sourceTxHash,
        message,
      };
    }

    return {
      paymentIntentId: intent.id,
      status: "EXECUTING",
      sourceTxHash: intent.sourceTxHash,
      message: sourceOnlyPendingMessage(intent.routeProvider),
    };
  }

  const routeStatus = await dependencies.routeStatuses.getRouteStatus({
    txHash: intent.sourceTxHash,
    fromChainId: intent.sourceChainId,
    toChainId: intent.destinationChainId,
  });

  if (routeStatus.status === "DONE") {
    const message = routeStatus.substatusMessage ?? "Payment completed.";
    await dependencies.paymentIntents.markPaymentCompleted(
      intent.id,
      routeStatus.destinationTxHash,
      dependencies.clock().toISOString(),
      intent.tenantId,
    );

    return {
      paymentIntentId: intent.id,
      status: "COMPLETED",
      sourceTxHash: intent.sourceTxHash,
      destinationTxHash: routeStatus.destinationTxHash,
      message,
    };
  }

  if (routeStatus.status === "FAILED" || routeStatus.status === "INVALID") {
    const message = routeStatus.substatusMessage ?? "Payment route failed.";
    await dependencies.paymentIntents.markPaymentFailed(intent.id, "ROUTE_FAILED", message, intent.tenantId);

    return {
      paymentIntentId: intent.id,
      status: "FAILED",
      sourceTxHash: intent.sourceTxHash,
      message,
    };
  }

  return {
    paymentIntentId: intent.id,
    status: "EXECUTING",
    sourceTxHash: intent.sourceTxHash,
    message: routeStatus.substatusMessage ?? pendingRouteStatusMessage(routeStatus.status),
  };
}

export async function listTransactions(
  rawInput: ListTransactionsInput,
  dependencies: ListTransactionsDependencies,
): Promise<ListTransactionsOutput> {
  const input = listTransactionsInputSchema.parse(rawInput);
  const intents = await dependencies.paymentIntents.listPaymentIntents({ limit: input.limit });

  return {
    transactions: intents.map((intent) =>
      omitUndefined({
        paymentIntentId: intent.id,
        status: intent.status,
        paymentType: intent.paymentType,
        amountOut: intent.amountOut,
        destinationTokenSymbol: intent.destinationTokenSymbol,
        destinationChainId: intent.destinationChainId,
        recipientAddress: intent.recipientAddress,
        sourceTxHash: intent.sourceTxHash,
        destinationTxHash: intent.destinationTxHash,
        createdAt: intent.createdAt ?? "",
      }),
    ) as ListTransactionsOutput["transactions"],
  };
}

export async function listPaymentEvents(
  rawInput: ListPaymentEventsInput,
  dependencies: ListPaymentEventsDependencies,
): Promise<ListPaymentEventsOutput> {
  const input = listPaymentEventsInputSchema.parse(rawInput);
  const events = await dependencies.paymentEvents.listPaymentEvents({
    paymentIntentId: input.paymentIntentId,
    limit: input.limit,
  });

  return {
    events: events.map((event) =>
      omitUndefined({
        eventId: event.id,
        paymentIntentId: event.paymentIntentId,
        eventType: event.eventType,
        message: event.message,
        metadata: event.metadata,
        createdAt: event.createdAt,
      }),
    ) as ListPaymentEventsOutput["events"],
  };
}

export const trackPaymentTool = {
  name: "track_payment",
  description: "Track an AgentPay payment intent through source and destination transaction status.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["paymentIntentId"],
    properties: {
      paymentIntentId: { type: "string" },
    },
  },
} as const;

export const listTransactionsTool = {
  name: "list_transactions",
  description: "List recent AgentPay payment intents for audit and history.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "number", minimum: 1, maximum: 50 },
    },
  },
} as const;

export const listPaymentEventsTool = {
  name: "list_payment_events",
  description: "List audit events for a specific AgentPay payment intent.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["paymentIntentId"],
    properties: {
      paymentIntentId: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 50 },
    },
  },
} as const;

export function createTrackPaymentHandler(dependencies: TrackPaymentDependencies) {
  return (input: TrackPaymentInput) => trackPayment(input, dependencies);
}

export function createListTransactionsHandler(dependencies: ListTransactionsDependencies) {
  return (input: ListTransactionsInput) => listTransactions(input, dependencies);
}

export function createListPaymentEventsHandler(dependencies: ListPaymentEventsDependencies) {
  return (input: ListPaymentEventsInput) => listPaymentEvents(input, dependencies);
}

function toStoredStatusOutput(intent: PaymentIntentRecord): TrackPaymentOutput {
  return omitUndefined({
    paymentIntentId: intent.id,
    status: intent.status,
    sourceTxHash: intent.sourceTxHash,
    destinationTxHash: intent.destinationTxHash,
    message: storedStatusMessage(intent.status),
  }) as TrackPaymentOutput;
}

function sourceOnlyCompletedMessage(routeProvider: PaymentIntentRecord["routeProvider"]): string {
  return routeProvider === "CONTRACT_CALL"
    ? "Contract call completed in the source transaction."
    : "Direct payment completed in the source transaction.";
}

function sourceOnlyFailedMessage(routeProvider: PaymentIntentRecord["routeProvider"]): string {
  return routeProvider === "CONTRACT_CALL"
    ? "Contract call source transaction failed."
    : "Direct payment source transaction failed.";
}

function sourceOnlyPendingMessage(routeProvider: PaymentIntentRecord["routeProvider"]): string {
  return routeProvider === "CONTRACT_CALL"
    ? "Contract call source transaction is still pending."
    : "Direct payment source transaction is still pending.";
}

function storedStatusMessage(status: PaymentIntentStatus): string {
  const messages: Record<PaymentIntentStatus, string> = {
    AWAITING_APPROVAL: "Payment is awaiting approval.",
    APPROVED: "Payment is approved but not executing yet.",
    EXECUTING: "Payment execution has started.",
    COMPLETED: "Payment is complete.",
    FAILED: "Payment failed.",
    EXPIRED: "Payment approval deadline expired.",
    CANCELLED: "Payment was cancelled.",
  };

  return messages[status];
}

function pendingRouteStatusMessage(status: RouteStatusResult["status"]): string {
  return status === "NOT_FOUND" ? "Payment source transaction has not been indexed yet." : "Payment route is still executing.";
}

function omitUndefined<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;
}
