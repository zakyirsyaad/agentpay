import { randomUUID } from "node:crypto";

export type PaidExecutionChallengeStatus = "OFFERED" | "CONSUMED" | "EXPIRED";

export interface PaidExecutionChallengeRecord {
  id: string;
  tenantId: string;
  environment: "staging" | "production";
  paymentIntentId: string;
  ownerAddress: string;
  accountAddress: string;
  requestHash: string;
  argumentsHash: string;
  authorizationHash: string;
  feeTermsHash: string;
  paymentRequirementsHash: string;
  status: PaidExecutionChallengeStatus;
  offeredAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface PaidExecutionChallengeOfferInput {
  id?: string;
  tenantId: string;
  environment: "staging" | "production";
  paymentIntentId: string;
  ownerAddress: string;
  accountAddress: string;
  requestHash: string;
  argumentsHash: string;
  authorizationHash: string;
  feeTermsHash: string;
  paymentRequirementsHash: string;
  offeredAt: string;
  expiresAt: string;
}

export type PaidExecutionChallengeOffer =
  | { disposition: "OFFERED"; record: PaidExecutionChallengeRecord }
  | { disposition: "REPLAY"; record: PaidExecutionChallengeRecord }
  | { disposition: "CONFLICT"; record: PaidExecutionChallengeRecord };

export interface PaidExecutionChallengeStore {
  offer(input: PaidExecutionChallengeOfferInput): Promise<PaidExecutionChallengeOffer>;
  consume(input: {
    tenantId: string;
    requestHash: string;
    argumentsHash: string;
    authorizationHash: string;
    paymentRequirementsHash: string;
    at: string;
  }): Promise<PaidExecutionChallengeRecord | null>;
  expire(at: string): Promise<number>;
}

export function createInMemoryPaidExecutionChallengeStore(
  createId: () => string = randomUUID,
): PaidExecutionChallengeStore {
  const records = new Map<string, PaidExecutionChallengeRecord>();
  const bindings = new Map<string, string>();

  return {
    async offer(input) {
      if (Date.parse(input.expiresAt) <= Date.parse(input.offeredAt)) {
        throw new Error("Paid challenge expiry must be after its offer time.");
      }
      const key = createChallengeKey(input);
      const existingId = bindings.get(key);
      if (existingId) {
        const existing = records.get(existingId)!;
        return sameChallenge(existing, input)
          ? { disposition: "REPLAY", record: cloneChallenge(existing) }
          : { disposition: "CONFLICT", record: cloneChallenge(existing) };
      }
      const record: PaidExecutionChallengeRecord = {
        id: input.id ?? createId(),
        tenantId: input.tenantId,
        environment: input.environment,
        paymentIntentId: input.paymentIntentId,
        ownerAddress: input.ownerAddress,
        accountAddress: input.accountAddress,
        requestHash: input.requestHash,
        argumentsHash: input.argumentsHash,
        authorizationHash: input.authorizationHash,
        feeTermsHash: input.feeTermsHash,
        paymentRequirementsHash: input.paymentRequirementsHash,
        status: "OFFERED",
        offeredAt: input.offeredAt,
        expiresAt: input.expiresAt,
      };
      records.set(record.id, record);
      bindings.set(key, record.id);
      return { disposition: "OFFERED", record: cloneChallenge(record) };
    },
    async consume(input) {
      const candidates = [...records.values()].filter(
        (record) =>
          record.tenantId === input.tenantId &&
          record.requestHash === input.requestHash &&
          record.argumentsHash === input.argumentsHash &&
          record.authorizationHash === input.authorizationHash &&
          record.paymentRequirementsHash === input.paymentRequirementsHash,
      );
      const record = candidates[0];
      if (!record) return null;
      if (record.status === "CONSUMED") return cloneChallenge(record);
      if (Date.parse(record.expiresAt) <= Date.parse(input.at)) {
        record.status = "EXPIRED";
        return null;
      }
      if (record.status !== "OFFERED") return null;
      record.status = "CONSUMED";
      record.consumedAt = input.at;
      return cloneChallenge(record);
    },
    async expire(at) {
      let count = 0;
      for (const record of records.values()) {
        if (record.status === "OFFERED" && Date.parse(record.expiresAt) <= Date.parse(at)) {
          record.status = "EXPIRED";
          count += 1;
        }
      }
      return count;
    },
  };
}

function createChallengeKey(input: PaidExecutionChallengeOfferInput): string {
  return [input.tenantId, input.requestHash, input.authorizationHash, input.feeTermsHash].join(":");
}

function sameChallenge(record: PaidExecutionChallengeRecord, input: PaidExecutionChallengeOfferInput): boolean {
  return (
    record.paymentIntentId === input.paymentIntentId &&
    record.argumentsHash === input.argumentsHash &&
    record.paymentRequirementsHash === input.paymentRequirementsHash &&
    record.expiresAt === input.expiresAt
  );
}

function cloneChallenge(record: PaidExecutionChallengeRecord): PaidExecutionChallengeRecord {
  return { ...record };
}
