import { createHash } from "node:crypto";

import type { PaymentPayload, PaymentRequirements } from "@okxweb3/x402-core/types";
import { executePaymentInputSchema, type ExecutePaymentInput } from "@agentpay-ai/shared";

const PAYMENT_IDENTIFIER = "payment-identifier";
const PAYMENT_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const PAID_EXECUTION_TOOL = "execute_payment" as const;

export type PaidExecutionLifecycleStatus =
  | "CLAIMED"
  | "SETTLING"
  | "SETTLED"
  | "EXECUTING"
  | "COMPLETED"
  | "FAILED";

/** The fee, invoice, and recovery states are intentionally independent. */
export type PaidExecutionFeeStatus =
  | "ACCEPTED"
  | "SETTLING"
  | "SETTLED"
  | "SETTLEMENT_UNKNOWN"
  | "SETTLEMENT_REJECTED"
  | "MANUAL_REVIEW";
export type PaidExecutionExecutionStatus =
  | "NOT_QUEUED"
  | "QUEUED"
  | "TX_PREPARED"
  | "BROADCAST_UNKNOWN"
  | "BROADCASTED"
  | "CONFIRMED"
  | "REVERTED"
  | "EXPIRED_UNBROADCAST"
  | "MANUAL_REVIEW";
export type PaidExecutionRefundStatus =
  | "NOT_REQUIRED"
  | "REQUIRED"
  | "PROCESSING"
  | "UNKNOWN"
  | "REFUNDED"
  | "MANUAL_REVIEW";

export interface PaidExecutionLifecycleRecord {
  id: string;
  tenantId?: string;
  idempotencyKey: string;
  paymentIdentifier?: string;
  paymentPayloadHash: string;
  paymentRequirementsHash: string;
  requestHash: string;
  toolName: typeof PAID_EXECUTION_TOOL;
  paymentIntentId: string;
  argumentsHash: string;
  authorizationHash?: string;
  challengeId?: string;
  environment?: "staging" | "production";
  payer?: string;
  status: PaidExecutionLifecycleStatus;
  feeStatus: PaidExecutionFeeStatus;
  executionStatus: PaidExecutionExecutionStatus;
  refundStatus: PaidExecutionRefundStatus;
  settlementTxHash?: string;
  settlementHeaders?: Record<string, string>;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBodyBase64?: string;
  executionTxHash?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
  completedAt?: string;
}

export interface PaidExecutionLifecycleClaimInput {
  id: string;
  tenantId?: string;
  paymentIdentifier?: string;
  paymentPayloadHash: string;
  paymentRequirementsHash: string;
  requestHash: string;
  toolName: typeof PAID_EXECUTION_TOOL;
  paymentIntentId: string;
  argumentsHash: string;
  authorizationHash?: string;
  challengeId?: string;
  environment?: "staging" | "production";
  payer?: string;
  createdAt: string;
}

export type PaidExecutionLifecycleClaim =
  | { disposition: "CLAIMED"; record: PaidExecutionLifecycleRecord }
  | { disposition: "REPLAY"; record: PaidExecutionLifecycleRecord }
  | { disposition: "CONFLICT"; record: PaidExecutionLifecycleRecord };

export interface PaidExecutionResponseSnapshot {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  executionTxHash?: string;
}

export interface PaidExecutionLifecycleStore {
  claim(input: PaidExecutionLifecycleClaimInput): Promise<PaidExecutionLifecycleClaim>;
  markSettling(id: string, at: string): Promise<PaidExecutionLifecycleRecord>;
  markSettled(
    id: string,
    input: { transaction: string; headers: Record<string, string>; at: string },
  ): Promise<PaidExecutionLifecycleRecord>;
  markSettlementUnknown(id: string, errorCode: string, errorMessage: string, at: string): Promise<PaidExecutionLifecycleRecord>;
  markSettlementRejected(id: string, errorCode: string, errorMessage: string, at: string): Promise<PaidExecutionLifecycleRecord>;
  markExecuting(id: string, at: string): Promise<PaidExecutionLifecycleRecord>;
  markExecutionBroadcasted(id: string, txHash: string, at: string): Promise<PaidExecutionLifecycleRecord>;
  markExecutionReceipt(id: string, success: boolean, at: string): Promise<PaidExecutionLifecycleRecord>;
  markExecutionPersistenceUnknown(id: string, errorCode: string, errorMessage: string, at: string): Promise<PaidExecutionLifecycleRecord>;
  markExecutionFailed(id: string, errorCode: string, errorMessage: string, at: string): Promise<PaidExecutionLifecycleRecord>;
  markRefundRequired(id: string, reason: string, at: string): Promise<PaidExecutionLifecycleRecord>;
  markCompleted(id: string, snapshot: PaidExecutionResponseSnapshot, at: string): Promise<PaidExecutionLifecycleRecord>;
  markFailed(id: string, errorCode: string, errorMessage: string, at: string): Promise<PaidExecutionLifecycleRecord>;
}

export interface PaidExecutionRequestBinding {
  toolName: typeof PAID_EXECUTION_TOOL;
  input: ExecutePaymentInput;
  requestHash: string;
  argumentsHash: string;
}

export function parsePaidExecutionRequest(body: Buffer): PaidExecutionRequestBinding {
  if (body.length === 0) {
    throw new PaidExecutionRequestError("PAID_REQUEST_INVALID", "A paid request body is required.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new PaidExecutionRequestError("PAID_REQUEST_INVALID", "Paid requests must contain valid JSON-RPC.");
  }

  if (Array.isArray(parsed) || !isRecord(parsed)) {
    throw new PaidExecutionRequestError("PAID_REQUEST_INVALID", "Paid requests must contain one JSON-RPC object.");
  }
  if (parsed.method !== "tools/call" || !isRecord(parsed.params) || parsed.params.name !== PAID_EXECUTION_TOOL) {
    throw new PaidExecutionRequestError(
      "PAID_TOOL_NOT_ALLOWED",
      "The public paid surface accepts only the execute_payment MCP tool.",
    );
  }
  if (typeof parsed.id !== "string" && !(typeof parsed.id === "number" && Number.isFinite(parsed.id))) {
    throw new PaidExecutionRequestError(
      "PAID_REQUEST_INVALID",
      "Paid execute_payment requests require a non-null JSON-RPC id.",
    );
  }
  if (!isRecord(parsed.params.arguments)) {
    throw new PaidExecutionRequestError("PAID_REQUEST_INVALID", "execute_payment arguments are required.");
  }

  const input = executePaymentInputSchema.safeParse(parsed.params.arguments);
  if (!input.success || !input.data.signature) {
    throw new PaidExecutionRequestError(
      "PAID_SIGNATURE_REQUIRED",
      "Owner EIP-712 signature is required before a paid challenge can be issued.",
    );
  }

  const argumentsHash = hashCanonicalJson(input.data);
  const { id: _requestId, ...semanticRequest } = parsed;
  return {
    toolName: PAID_EXECUTION_TOOL,
    input: input.data,
    // Bind the complete semantic JSON-RPC request. The transport correlation
    // id is intentionally excluded so a lost-response retry with a fresh id
    // replays the same lifecycle instead of charging/executing again.
    requestHash: hashCanonicalJson(semanticRequest),
    argumentsHash,
  };
}

export function createPaidExecutionLifecycleClaimInput(input: {
  lifecycleId: string;
  tenantId?: string;
  binding: PaidExecutionRequestBinding;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  authorizationHash?: string;
  challengeId?: string;
  environment?: "staging" | "production";
  payer?: string;
  createdAt: string;
}): PaidExecutionLifecycleClaimInput {
  const paymentIdentifier = extractPaymentIdentifier(input.paymentPayload);
  const paymentPayloadHash = hashCanonicalJson(input.paymentPayload);
  const paymentRequirementsHash = hashCanonicalJson(input.paymentRequirements);
  return {
    id: input.lifecycleId,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    ...(paymentIdentifier ? { paymentIdentifier } : {}),
    paymentPayloadHash,
    paymentRequirementsHash,
    requestHash: input.binding.requestHash,
    toolName: input.binding.toolName,
    paymentIntentId: input.binding.input.paymentIntentId,
    argumentsHash: input.binding.argumentsHash,
    ...(input.authorizationHash ? { authorizationHash: input.authorizationHash } : {}),
    ...(input.challengeId ? { challengeId: input.challengeId } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.payer ? { payer: input.payer } : {}),
    createdAt: input.createdAt,
  };
}

export function createPaidExecutionIdempotencyKey(input: {
  paymentPayloadHash: string;
  paymentIdentifier?: string;
  tenantId?: string;
}): string {
  const material = {
    version: 2,
    tenantId: input.tenantId ?? null,
    paymentIdentifier: input.paymentIdentifier ?? null,
    paymentPayloadHash: input.paymentPayloadHash,
  };
  return `v2:${hashCanonicalJson(material)}`;
}

export function extractPaymentIdentifier(paymentPayload: PaymentPayload): string | undefined {
  const extension = paymentPayload.extensions?.[PAYMENT_IDENTIFIER];
  if (extension === undefined) return undefined;
  if (!isRecord(extension)) {
    throw new PaidExecutionRequestError("PAID_PAYMENT_IDENTIFIER_INVALID", "Payment identifier extension is invalid.");
  }

  const info = extension.info;
  const identifier = isRecord(info) ? info.id : extension.id;
  if (typeof identifier !== "string" || !PAYMENT_IDENTIFIER_PATTERN.test(identifier)) {
    throw new PaidExecutionRequestError("PAID_PAYMENT_IDENTIFIER_INVALID", "Payment identifier extension is invalid.");
  }
  return identifier;
}

export function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}

export class PaidExecutionRequestError extends Error {
  constructor(
    readonly code:
      | "PAID_REQUEST_INVALID"
      | "PAID_TOOL_NOT_ALLOWED"
      | "PAID_SIGNATURE_REQUIRED"
      | "PAID_PAYMENT_IDENTIFIER_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "PaidExecutionRequestError";
  }
}

export function createInMemoryPaidExecutionLifecycleStore(
  createId: () => string = () => `lifecycle_${Math.random().toString(16).slice(2)}`,
): PaidExecutionLifecycleStore {
  const records = new Map<string, PaidExecutionLifecycleRecord>();
  const bindingKeys = new Map<string, string>();
  const paymentKeys = new Map<string, string>();
  const paymentIntentKeys = new Map<string, string>();

  return {
    async claim(input) {
      const idempotencyKey = createPaidExecutionIdempotencyKey({
        paymentPayloadHash: input.paymentPayloadHash,
        paymentIdentifier: input.paymentIdentifier,
        tenantId: input.tenantId,
      });
      const bindingKey = createLifecycleBindingKey(input);
      const paymentKey = createPaymentProofKey(input);
      const paymentIntentKey = `${input.tenantId ?? ""}:${input.paymentIntentId}`;
      const existingId =
        paymentKeys.get(paymentKey) ??
        paymentIntentKeys.get(paymentIntentKey) ??
        bindingKeys.get(bindingKey) ??
        idempotencyKey;
      const existing = records.get(existingId);
      if (existing) {
        return {
          disposition: hasSameBinding(existing, input) ? "REPLAY" : "CONFLICT",
          record: cloneLifecycleRecord(existing),
        };
      }
      const record: PaidExecutionLifecycleRecord = {
        id: input.id || createId(),
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
        idempotencyKey,
        ...(input.paymentIdentifier ? { paymentIdentifier: input.paymentIdentifier } : {}),
        paymentPayloadHash: input.paymentPayloadHash,
        paymentRequirementsHash: input.paymentRequirementsHash,
        requestHash: input.requestHash,
        toolName: input.toolName,
        paymentIntentId: input.paymentIntentId,
        argumentsHash: input.argumentsHash,
        ...(input.authorizationHash ? { authorizationHash: input.authorizationHash } : {}),
        ...(input.challengeId ? { challengeId: input.challengeId } : {}),
        ...(input.environment ? { environment: input.environment } : {}),
        ...(input.payer ? { payer: input.payer } : {}),
        status: "CLAIMED",
        feeStatus: "ACCEPTED",
        executionStatus: "NOT_QUEUED",
        refundStatus: "NOT_REQUIRED",
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      records.set(idempotencyKey, record);
      bindingKeys.set(bindingKey, idempotencyKey);
      paymentKeys.set(paymentKey, idempotencyKey);
      paymentIntentKeys.set(paymentIntentKey, idempotencyKey);
      return { disposition: "CLAIMED", record: cloneLifecycleRecord(record) };
    },
    async markSettling(id, at) {
      const record = transition(records, id, "SETTLING", at, ["CLAIMED"]);
      record.feeStatus = "SETTLING";
      return cloneLifecycleRecord(record);
    },
    async markSettled(id, input) {
      const record = transition(records, id, "SETTLED", input.at, ["SETTLING", "SETTLED"]);
      record.feeStatus = "SETTLED";
      record.settlementTxHash = input.transaction;
      record.settlementHeaders = { ...input.headers };
      record.settledAt = input.at;
      return cloneLifecycleRecord(record);
    },
    async markSettlementUnknown(id, errorCode, errorMessage, at) {
      const record = transition(records, id, "FAILED", at, ["CLAIMED", "SETTLING"]);
      record.feeStatus = "SETTLEMENT_UNKNOWN";
      record.errorCode = errorCode;
      record.errorMessage = errorMessage;
      return cloneLifecycleRecord(record);
    },
    async markSettlementRejected(id, errorCode, errorMessage, at) {
      const record = transition(records, id, "FAILED", at, ["CLAIMED", "SETTLING"]);
      record.feeStatus = "SETTLEMENT_REJECTED";
      record.errorCode = errorCode;
      record.errorMessage = errorMessage;
      return cloneLifecycleRecord(record);
    },
    async markExecuting(id, at) {
      const record = transition(records, id, "EXECUTING", at, ["SETTLED", "EXECUTING"]);
      record.executionStatus = "QUEUED";
      return record;
    },
    async markExecutionBroadcasted(id, txHash, at) {
      const record = findLifecycleRecord(records, id);
      if (!["EXECUTING", "COMPLETED"].includes(record.status)) {
        throw new Error(`Paid execution lifecycle ${id} cannot mark execution broadcasted from ${record.status}.`);
      }
      record.updatedAt = at;
      if (record.executionStatus === "BROADCASTED" || record.executionStatus === "CONFIRMED") {
        if (record.executionTxHash?.toLowerCase() === txHash.toLowerCase()) return cloneLifecycleRecord(record);
        throw new Error(`Paid execution lifecycle ${id} is already bound to a different execution transaction.`);
      }
      if (!["QUEUED", "TX_PREPARED", "BROADCAST_UNKNOWN", "BROADCASTED"].includes(record.executionStatus)) {
        throw new Error(`Paid execution lifecycle ${id} cannot mark execution broadcasted from ${record.executionStatus}.`);
      }
      record.executionStatus = "BROADCASTED";
      record.executionTxHash = txHash;
      return cloneLifecycleRecord(record);
    },
    async markExecutionReceipt(id, success, at) {
      const record = findLifecycleRecord(records, id);
      if (record.executionStatus === (success ? "CONFIRMED" : "REVERTED")) return cloneLifecycleRecord(record);
      if (!["EXECUTING", "COMPLETED"].includes(record.status)) {
        throw new Error(`Paid execution lifecycle ${id} cannot finalize a receipt from ${record.status}.`);
      }
      record.updatedAt = at;
      if (!["BROADCASTED", "CONFIRMED", "REVERTED"].includes(record.executionStatus)) {
        throw new Error(`Paid execution lifecycle ${id} cannot finalize a receipt from ${record.executionStatus}.`);
      }
      record.executionStatus = success ? "CONFIRMED" : "REVERTED";
      if (!success) {
        record.status = "FAILED";
        record.refundStatus = "REQUIRED";
        record.errorCode = "EXECUTION_REVERTED";
        record.errorMessage = "The executor transaction reverted on-chain.";
      }
      return cloneLifecycleRecord(record);
    },
    async markExecutionPersistenceUnknown(id, errorCode, errorMessage, at) {
      const record = findLifecycleRecord(records, id);
      if (!["EXECUTING", "COMPLETED"].includes(record.status)) {
        throw new Error(`Paid execution lifecycle ${id} cannot mark persistence unknown from ${record.status}.`);
      }
      record.executionStatus = "BROADCAST_UNKNOWN";
      record.errorCode = errorCode;
      record.errorMessage = errorMessage;
      record.updatedAt = at;
      return cloneLifecycleRecord(record);
    },
    async markExecutionFailed(id, errorCode, errorMessage, at) {
      const record = transition(records, id, "FAILED", at, ["SETTLED", "EXECUTING", "FAILED"]);
      record.executionStatus = "MANUAL_REVIEW";
      record.errorCode = errorCode;
      record.errorMessage = errorMessage;
      return cloneLifecycleRecord(record);
    },
    async markRefundRequired(id, reason, at) {
      const existing = findLifecycleRecord(records, id);
      if (existing.status === "FAILED" && existing.refundStatus === "REQUIRED") {
        return cloneLifecycleRecord(existing);
      }
      const record = transition(records, id, "FAILED", at, ["SETTLED", "EXECUTING", "FAILED"]);
      record.refundStatus = "REQUIRED";
      record.executionStatus = "MANUAL_REVIEW";
      record.errorCode = "REFUND_REQUIRED";
      record.errorMessage = reason;
      return cloneLifecycleRecord(record);
    },
    async markCompleted(id, snapshot, at) {
      const record = transition(records, id, "COMPLETED", at, ["EXECUTING", "COMPLETED"]);
      record.responseStatus = snapshot.status;
      record.responseHeaders = { ...snapshot.headers };
      record.responseBodyBase64 = snapshot.body.toString("base64");
      if (snapshot.executionTxHash) record.executionTxHash = snapshot.executionTxHash;
      record.completedAt = at;
      return cloneLifecycleRecord(record);
    },
    async markFailed(id, errorCode, errorMessage, at) {
      const record = transition(records, id, "FAILED", at, ["CLAIMED", "SETTLING", "SETTLED", "EXECUTING", "FAILED"]);
      record.errorCode = errorCode;
      record.errorMessage = errorMessage;
      return cloneLifecycleRecord(record);
    },
  };
}

function transition(
  records: Map<string, PaidExecutionLifecycleRecord>,
  id: string,
  status: PaidExecutionLifecycleStatus,
  at: string,
  allowedFrom: PaidExecutionLifecycleStatus[],
): PaidExecutionLifecycleRecord {
  const record = [...records.values()].find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Paid execution lifecycle ${id} was not found.`);
  if (!allowedFrom.includes(record.status)) {
    throw new Error(`Paid execution lifecycle ${id} cannot transition from ${record.status} to ${status}.`);
  }
  record.status = status;
  record.updatedAt = at;
  return record;
}

function findLifecycleRecord(
  records: Map<string, PaidExecutionLifecycleRecord>,
  id: string,
): PaidExecutionLifecycleRecord {
  const record = [...records.values()].find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Paid execution lifecycle ${id} was not found.`);
  return record;
}

function hasSameBinding(existing: PaidExecutionLifecycleRecord, input: PaidExecutionLifecycleClaimInput): boolean {
  return (
    existing.paymentPayloadHash === input.paymentPayloadHash &&
    existing.paymentRequirementsHash === input.paymentRequirementsHash &&
    existing.requestHash === input.requestHash &&
    existing.toolName === input.toolName &&
    existing.paymentIntentId === input.paymentIntentId &&
    existing.argumentsHash === input.argumentsHash
    && (existing.authorizationHash ?? null) === (input.authorizationHash ?? null)
    && (existing.challengeId ?? null) === (input.challengeId ?? null)
  );
}

function createLifecycleBindingKey(input: PaidExecutionLifecycleClaimInput): string {
  return `${input.tenantId ?? ""}:${input.paymentIntentId}:${input.authorizationHash ?? ""}`;
}

function createPaymentProofKey(input: PaidExecutionLifecycleClaimInput): string {
  return `${input.tenantId ?? ""}:${input.paymentIdentifier ? `id:${input.paymentIdentifier}` : `payload:${input.paymentPayloadHash}`}`;
}

function cloneLifecycleRecord(record: PaidExecutionLifecycleRecord): PaidExecutionLifecycleRecord {
  return {
    ...record,
    ...(record.settlementHeaders ? { settlementHeaders: { ...record.settlementHeaders } } : {}),
    ...(record.responseHeaders ? { responseHeaders: { ...record.responseHeaders } } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
