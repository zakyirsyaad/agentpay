import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type InvoiceExecutionOutboxStatus =
  | "NOT_QUEUED"
  | "QUEUED"
  | "TX_PREPARED"
  | "BROADCAST_UNKNOWN"
  | "BROADCASTED"
  | "CONFIRMED"
  | "REVERTED"
  | "EXPIRED_UNBROADCAST"
  | "MANUAL_REVIEW";

export interface InvoiceExecutionOutboxRecord {
  id: string;
  tenantId: string;
  lifecycleId: string;
  paymentIntentId: string;
  status: InvoiceExecutionOutboxStatus;
  chainId: number;
  executorAddress: string;
  executorNonce?: string;
  transactionHash?: string;
  calldataHash?: string;
  ownerAuthorizationNonce?: string;
  rawTransaction?: EncryptedRawTransaction;
  leaseUntil?: string;
  fencingToken?: string;
  attemptCount: number;
  broadcastAt?: string;
  confirmedAt?: string;
  receiptStatus?: 0 | 1;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedRawTransaction {
  ciphertext: string;
  iv: string;
  tag: string;
  hash: string;
}

export interface InvoiceExecutionOutboxInput {
  id: string;
  tenantId: string;
  lifecycleId: string;
  paymentIntentId: string;
  chainId: number;
  executorAddress: string;
  createdAt: string;
}

export interface InvoiceExecutionOutboxStore {
  get(id: string): Promise<InvoiceExecutionOutboxRecord | null>;
  listRecoverable(at: string): Promise<InvoiceExecutionOutboxRecord[]>;
  claimRecoverable(id: string, at: string, leaseUntil: string): Promise<InvoiceExecutionOutboxRecord | null>;
  enqueue(input: InvoiceExecutionOutboxInput): Promise<{ disposition: "QUEUED" | "REPLAY" | "CONFLICT"; record: InvoiceExecutionOutboxRecord }>;
  prepare(
    id: string,
    input: {
      executorNonce: string;
      transactionHash: string;
      calldataHash: string;
      ownerAuthorizationNonce: string;
      rawTransaction: EncryptedRawTransaction;
      at: string;
    },
  ): Promise<InvoiceExecutionOutboxRecord>;
  markBroadcastUnknown(id: string, at: string, fencingToken?: string): Promise<InvoiceExecutionOutboxRecord>;
  markBroadcasted(id: string, txHash: string, at: string, fencingToken?: string): Promise<InvoiceExecutionOutboxRecord>;
  markReceipt(id: string, success: boolean, at: string, fencingToken?: string): Promise<InvoiceExecutionOutboxRecord>;
  markManualReview(id: string, code: string, message: string, at: string, fencingToken?: string): Promise<InvoiceExecutionOutboxRecord>;
}

export function encryptRawTransaction(rawTransaction: string, encryptionKey: string | Uint8Array): EncryptedRawTransaction {
  const key = normalizeEncryptionKey(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(rawTransaction, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    hash: createHash("sha256").update(rawTransaction, "utf8").digest("hex"),
  };
}

export function decryptRawTransaction(encrypted: EncryptedRawTransaction, encryptionKey: string | Uint8Array): string {
  const key = normalizeEncryptionKey(encryptionKey);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const hash = createHash("sha256").update(plaintext, "utf8").digest("hex");
  if (hash !== encrypted.hash) throw new Error("Persisted raw transaction integrity check failed.");
  return plaintext;
}

export function createInMemoryInvoiceExecutionOutboxStore(
  createFencingToken: () => string = () => `fence_${randomBytes(16).toString("hex")}`,
): InvoiceExecutionOutboxStore {
  const records = new Map<string, InvoiceExecutionOutboxRecord>();
  const byLifecycle = new Map<string, string>();
  const byTransactionHash = new Map<string, string>();
  const byExecutorNonce = new Map<string, string>();

  return {
    async get(id) {
      const record = records.get(id);
      return record ? cloneRecord(record) : null;
    },
    async listRecoverable(at) {
      const cutoff = Date.parse(at);
      return [...records.values()]
        .filter((record) =>
          ["QUEUED", "TX_PREPARED", "BROADCAST_UNKNOWN", "BROADCASTED"].includes(record.status) &&
          (!record.leaseUntil || !Number.isFinite(cutoff) || Date.parse(record.leaseUntil) <= cutoff),
        )
        .map(cloneRecord);
    },
    async claimRecoverable(id, at, leaseUntil) {
      const record = requireRecord(records, id);
      if (!["QUEUED", "BROADCAST_UNKNOWN", "BROADCASTED"].includes(record.status)) return null;
      if (record.leaseUntil && Date.parse(record.leaseUntil) > Date.parse(at)) return null;
      const claimed = {
        ...record,
        leaseUntil,
        fencingToken: createFencingToken(),
        updatedAt: at,
      };
      records.set(id, claimed);
      return cloneRecord(claimed);
    },
    async enqueue(input) {
      const idExisting = records.get(input.id);
      if (idExisting) {
        return idExisting.tenantId === input.tenantId &&
          idExisting.lifecycleId === input.lifecycleId &&
          idExisting.paymentIntentId === input.paymentIntentId
          ? { disposition: "REPLAY", record: cloneRecord(idExisting) }
          : { disposition: "CONFLICT", record: cloneRecord(idExisting) };
      }
      const lifecycleExistingId = byLifecycle.get(`${input.tenantId}:${input.lifecycleId}`);
      const existing = lifecycleExistingId ? records.get(lifecycleExistingId) : undefined;
      if (existing) {
        return existing.paymentIntentId === input.paymentIntentId
          ? { disposition: "REPLAY", record: cloneRecord(existing) }
          : { disposition: "CONFLICT", record: cloneRecord(existing) };
      }
      const record: InvoiceExecutionOutboxRecord = {
        ...input,
        status: "QUEUED",
        attemptCount: 0,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      records.set(input.id, record);
      byLifecycle.set(`${input.tenantId}:${input.lifecycleId}`, input.id);
      return { disposition: "QUEUED", record: cloneRecord(record) };
    },
    async prepare(id, input) {
      const record = requireRecord(records, id);
      if (record.status !== "QUEUED") {
        throw new Error(`Outbox ${id} cannot be prepared from ${record.status}.`);
      }
      const executorNonceKey = `${record.chainId}:${record.executorAddress.toLowerCase()}:${input.executorNonce}`;
      const nonceOwner = byExecutorNonce.get(executorNonceKey);
      if (nonceOwner && nonceOwner !== id) throw new Error("Executor nonce is already reserved by another outbox item.");
      const hashOwner = byTransactionHash.get(input.transactionHash.toLowerCase());
      if (hashOwner && hashOwner !== id) throw new Error("Transaction hash is already bound to another outbox item.");
      byExecutorNonce.set(executorNonceKey, id);
      byTransactionHash.set(input.transactionHash.toLowerCase(), id);
      const prepared: InvoiceExecutionOutboxRecord = {
        ...record,
        status: "TX_PREPARED" as const,
        ...input,
        fencingToken: record.fencingToken ?? createFencingToken(),
        updatedAt: input.at,
      };
      records.set(id, prepared);
      return cloneRecord(prepared);
    },
    async markBroadcastUnknown(id, at, fencingToken) {
      const record = requireRecord(records, id);
      requireFencingToken(record, fencingToken);
      requirePrepared(record);
      if (!["TX_PREPARED", "BROADCAST_UNKNOWN"].includes(record.status)) {
        throw new Error(`Outbox ${id} cannot enter BROADCAST_UNKNOWN from ${record.status}.`);
      }
      const updated = { ...record, status: "BROADCAST_UNKNOWN" as const, attemptCount: record.attemptCount + 1, updatedAt: at };
      records.set(id, updated);
      return cloneRecord(updated);
    },
    async markBroadcasted(id, txHash, at, fencingToken) {
      const record = requireRecord(records, id);
      requireFencingToken(record, fencingToken);
      requirePrepared(record);
      if (record.transactionHash?.toLowerCase() !== txHash.toLowerCase()) {
        throw new Error("Broadcast hash does not match the persisted signed transaction.");
      }
      if (record.status === "BROADCASTED") return cloneRecord(record);
      if (!["TX_PREPARED", "BROADCAST_UNKNOWN"].includes(record.status)) {
        throw new Error(`Outbox ${id} cannot enter BROADCASTED from ${record.status}.`);
      }
      const updated = { ...record, status: "BROADCASTED" as const, broadcastAt: at, updatedAt: at };
      records.set(id, updated);
      return cloneRecord(updated);
    },
    async markReceipt(id, success, at, fencingToken) {
      const record = requireRecord(records, id);
      requireFencingToken(record, fencingToken);
      if (record.status === "CONFIRMED" || record.status === "REVERTED") {
        if (record.receiptStatus === (success ? 1 : 0)) return cloneRecord(record);
        throw new Error(`Outbox ${id} already has a terminal receipt.`);
      }
      if (!["BROADCASTED", "BROADCAST_UNKNOWN"].includes(record.status)) {
        throw new Error(`Outbox ${id} cannot finalize from ${record.status}.`);
      }
      const updated = {
        ...record,
        status: success ? "CONFIRMED" as const : "REVERTED" as const,
        receiptStatus: success ? 1 as const : 0 as const,
        confirmedAt: at,
        leaseUntil: undefined,
        updatedAt: at,
      };
      records.set(id, updated);
      return cloneRecord(updated);
    },
    async markManualReview(id, code, message, at, fencingToken) {
      const record = requireRecord(records, id);
      requireFencingToken(record, fencingToken);
      if (["CONFIRMED", "REVERTED"].includes(record.status)) {
        throw new Error(`Outbox ${id} is already terminal.`);
      }
      const updated = { ...record, status: "MANUAL_REVIEW" as const, errorCode: code, errorMessage: message, updatedAt: at };
      records.set(id, updated);
      return cloneRecord(updated);
    },
  };
}

function normalizeEncryptionKey(value: string | Uint8Array): Buffer {
  const raw = typeof value === "string"
    ? (/^[a-fA-F0-9]{64}$/.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64url"))
    : Buffer.from(value);
  if (raw.length !== 32) throw new Error("AGENTPAY_RAW_TX_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return raw;
}

function requireRecord(records: Map<string, InvoiceExecutionOutboxRecord>, id: string): InvoiceExecutionOutboxRecord {
  const record = records.get(id);
  if (!record) throw new Error(`Invoice execution outbox ${id} was not found.`);
  return record;
}

function requirePrepared(record: InvoiceExecutionOutboxRecord): void {
  if (!record.rawTransaction || !record.transactionHash || !record.executorNonce) {
    throw new Error("Outbox transaction bytes must be persisted before broadcast.");
  }
}

function requireFencingToken(record: InvoiceExecutionOutboxRecord, fencingToken?: string): void {
  if (fencingToken && record.fencingToken !== fencingToken) {
    throw new Error("Invoice execution outbox fencing token is stale.");
  }
}

function cloneRecord(record: InvoiceExecutionOutboxRecord): InvoiceExecutionOutboxRecord {
  return {
    ...record,
    ...(record.rawTransaction ? { rawTransaction: { ...record.rawTransaction } } : {}),
  };
}
