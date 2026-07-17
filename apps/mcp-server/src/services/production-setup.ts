import { randomUUID } from "node:crypto";
import type { MainnetWalletSetupPublicStatus } from "@agentpay-ai/shared";
export type ProductionSetupStatus =
  | "PENDING"
  | "ADMITTED"
  | "SIGNING"
  | "SIGNED"
  | "BROADCAST"
  | "BROADCAST_UNKNOWN"
  | "CONFIRMING"
  | "COMPLETED"
  | "EXPIRED"
  | "FAILED"
  | "MANUAL_REVIEW";
export type SetupDeploymentJobStatus =
  | "QUEUED"
  | "SIGNING"
  | "SIGNED"
  | "BROADCAST"
  | "BROADCAST_UNKNOWN"
  | "CONFIRMING"
  | "COMPLETED"
  | "FAILED"
  | "MANUAL_REVIEW";
export interface ProductionSetupIntent {
  readonly id: string;
  readonly capabilityDigest: string;
  readonly ownerAddress: string;
  readonly executorAddress: string;
  readonly messageToSign: string;
  readonly homeChainId: 196;
  readonly deploymentNonce: string;
  readonly manifestSha256: string;
  readonly factoryAddress: string;
  readonly factoryRuntimeCodeHash: string;
  readonly deploymentSalt: string;
  readonly predictedAccount: string;
  readonly accountCreationCodeHash: string;
  readonly accountRuntimeCodeHash: string;
  readonly authorizationHash: string;
  readonly status: ProductionSetupStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly admittedAt?: string;
  readonly signedAt?: string;
  readonly completedAt?: string;
  readonly publicCode?: string;
}
export interface EncryptedSetupTransaction {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
  readonly hash: string;
}
export interface SetupDeploymentJob {
  readonly id: string;
  readonly setupIntentId: string;
  readonly tenantId: string;
  readonly status: SetupDeploymentJobStatus;
  readonly chainId: 196;
  readonly deployerAddress?: string;
  readonly deployerNonce?: string;
  readonly transactionHash?: string;
  readonly rawTransaction?: EncryptedSetupTransaction;
  readonly workerId?: string;
  readonly fencingToken?: string;
  readonly leaseUntil?: string;
  readonly attemptCount: number;
  readonly receiptStatus?: 0 | 1;
  readonly receiptBlockNumber?: string;
  readonly existingAccountVerified?: boolean;
  readonly broadcastAt?: string;
  readonly confirmedAt?: string;
  readonly completedAt?: string;
  readonly publicCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface SetupDeploymentEvent {
  readonly id: string;
  readonly setupIntentId: string;
  readonly jobId?: string;
  readonly tenantId?: string;
  readonly eventType: string;
  readonly publicCode?: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  readonly createdAt: string;
}
export interface SetupSponsorReservation {
  readonly id: string;
  readonly jobId: string;
  readonly dayKey: string;
  readonly deployerAddress: string;
  readonly deployerNonce: string;
  readonly gasLimit: bigint;
  readonly nativeCostWei: bigint;
  readonly status: "CHARGED";
  readonly reservedAt: string;
}
export interface ProductionSetupChallengeInput {
  setupIntentId: string;
  capabilityDigest: string;
  ownerAddress: string;
  executorAddress: string;
  messageToSign: string;
  homeChainId: 196;
  deploymentNonce: string;
  manifestSha256: string;
  factoryAddress: string;
  factoryRuntimeCodeHash: string;
  deploymentSalt: string;
  predictedAccount: string;
  accountCreationCodeHash: string;
  accountRuntimeCodeHash: string;
  authorizationHash: string;
  expiresAt: string;
  at: string;
  rateLimitKeyDigest: string;
}
export interface SetupAdmissionInput {
  capabilityDigest: string;
  ownerSetupSignature: string;
  at: string;
}
export interface SetupWorkerClaim {
  readonly disposition: "CLAIMED";
  readonly jobStatus: Extract<SetupDeploymentJobStatus,
    "SIGNING" | "SIGNED" | "BROADCAST" | "BROADCAST_UNKNOWN" | "CONFIRMING">;
  readonly jobId: string;
  readonly setupIntentId: string;
  readonly tenantId: string;
  readonly fencingToken: string;
  readonly leaseUntil: string;
  readonly ownerSetupSignature: string;
  readonly ownerAddress: string;
  readonly executorAddress: string;
  readonly homeChainId: 196;
  readonly deploymentNonce: string;
  readonly manifestSha256: string;
  readonly factoryAddress: string;
  readonly factoryRuntimeCodeHash: string;
  readonly deploymentSalt: string;
  readonly predictedAccount: string;
  readonly accountCreationCodeHash: string;
  readonly accountRuntimeCodeHash: string;
  readonly authorizationHash: string;
  readonly expiresAt: string;
  readonly deployerAddress?: string;
  readonly deployerNonce?: string;
  readonly transactionHash?: string;
  readonly rawTransaction?: EncryptedSetupTransaction;
  readonly receiptStatus?: 0 | 1;
  readonly receiptBlockNumber?: string;
  readonly existingAccountVerified?: boolean;
  readonly broadcastAt?: string;
}
export interface SponsorPolicy {
  readonly deployerAddress: string;
  readonly maxDeploymentsPerDay: number;
  readonly maxGasPerDeployment: bigint;
  readonly maxNativeCostPerDayWei: bigint;
  readonly maxPending: number;
}
export interface ProductionSetupWebStore {
  challenge(input: ProductionSetupChallengeInput): Promise<{
    disposition: "CREATED" | "REPLAY";
    setupIntentId: string;
    expiresAt: string;
  }>;
  admit(input: SetupAdmissionInput): Promise<{
    disposition: "ADMITTED" | "REPLAY";
    setupIntentId: string;
    jobId: string;
  }>;
  status(input: { capabilityDigest: string; at: string }): Promise<MainnetWalletSetupPublicStatus>;
  prune(input: { at: string }): Promise<{ expiredSetups: number; deletedRateBuckets: number }>;
}
export interface ProductionSetupWorkerStore {
  claim(input: { workerId: string; at: string; leaseSeconds: number }): Promise<SetupWorkerClaim | null>;
  reserve(input: {
    jobId: string;
    fencingToken: string;
    deployerAddress: string;
    deployerNonce: string;
    gasLimit: string;
    nativeCostWei: string;
    at: string;
  }): Promise<{ disposition: "RESERVED" | "REPLAY"; jobId: string; dayKey: string }>;
  persistSignedTransaction(input: {
    jobId: string;
    fencingToken: string;
    rawTransaction: EncryptedSetupTransaction;
    transactionHash: string;
    at: string;
  }): Promise<{ disposition: "SIGNED" | "REPLAY"; jobId: string; status: "SIGNED"; transactionHash: string }>;
  markBroadcastResult(input: {
    jobId: string;
    fencingToken: string;
    result: "BROADCAST" | "BROADCAST_UNKNOWN";
    at: string;
    publicCode?: string;
  }): Promise<{
    disposition: "BROADCAST" | "BROADCAST_UNKNOWN" | "REPLAY";
    jobId: string;
    status: "BROADCAST" | "BROADCAST_UNKNOWN";
  }>;
  recordReceipt(input: {
    jobId: string;
    fencingToken: string;
    transactionHash: string;
    receiptStatus: 0 | 1;
    receiptBlockNumber: string;
    at: string;
  }): Promise<{ disposition: "RECORDED" | "REPLAY"; jobId: string; status: "CONFIRMING" | "FAILED" }>;
  recordExistingAccount(input: {
    jobId: string;
    fencingToken: string;
    verificationBlockNumber: string;
    at: string;
  }): Promise<{ disposition: "RECORDED" | "REPLAY"; jobId: string; status: "CONFIRMING" }>;
  finalize(input: { jobId: string; fencingToken: string; at: string }): Promise<{
    disposition: "COMPLETED" | "REPLAY";
    jobId: string;
    tenantId: string;
    accountAddress: string;
  }>;
  markManualReview(input: {
    jobId: string;
    fencingToken: string;
    publicCode: string;
    at: string;
  }): Promise<{ disposition: "MANUAL_REVIEW" | "REPLAY"; jobId: string; status: "MANUAL_REVIEW" }>;
}
export class ProductionSetupStoreError extends Error {
  constructor(readonly code: string, message = "Production setup operation failed.") {
    super(message);
    this.name = "ProductionSetupStoreError";
  }
}
interface InternalIntent extends ProductionSetupIntent {
  readonly ownerSetupSignature?: string;
  readonly tenantId?: string;
  readonly jobId?: string;
}

export function createInMemoryProductionSetupStores(options: {
  createId?: () => string;
  createFencingToken?: () => string;
  sponsorPolicy: SponsorPolicy;
}): {
  web: ProductionSetupWebStore;
  worker: ProductionSetupWorkerStore;
  inspect: {
    intent(id: string): ProductionSetupIntent | null;
    events(): readonly SetupDeploymentEvent[];
    jobs(): readonly SetupDeploymentJob[];
    reservations(): readonly SetupSponsorReservation[];
  };
} {
  const createId = options.createId ?? randomUUID;
  const createFencingToken = options.createFencingToken ?? randomUUID;
  const sponsorPolicy: SponsorPolicy = freeze({
    deployerAddress: normalizeAddress(options.sponsorPolicy.deployerAddress),
    maxDeploymentsPerDay: options.sponsorPolicy.maxDeploymentsPerDay,
    maxGasPerDeployment: options.sponsorPolicy.maxGasPerDeployment,
    maxNativeCostPerDayWei: options.sponsorPolicy.maxNativeCostPerDayWei,
    maxPending: options.sponsorPolicy.maxPending,
  });
  if (!Number.isSafeInteger(sponsorPolicy.maxDeploymentsPerDay) || sponsorPolicy.maxDeploymentsPerDay <= 0
    || !Number.isSafeInteger(sponsorPolicy.maxPending) || sponsorPolicy.maxPending <= 0
    || sponsorPolicy.maxGasPerDeployment <= 0n || sponsorPolicy.maxNativeCostPerDayWei <= 0n) {
    throw setupError("SETUP_SPONSOR_POLICY_INVALID");
  }
  const intents = new Map<string, InternalIntent>();
  const capabilityToIntent = new Map<string, string>();
  const jobs = new Map<string, SetupDeploymentJob>();
  const reservations = new Map<string, SetupSponsorReservation>();
  const events: SetupDeploymentEvent[] = [];

  const web: ProductionSetupWebStore = {
    async challenge(input) {
      const normalized = normalizeChallenge(input);
      const existingId = capabilityToIntent.get(normalized.capabilityDigest);
      if (existingId) {
        const existing = requireIntent(intents, existingId);
        if (!sameChallenge(existing, normalized)) throw setupError("SETUP_REPLAY_CONFLICT");
        return freeze({ disposition: "REPLAY" as const, setupIntentId: existing.id, expiresAt: existing.expiresAt });
      }
      if ([...intents.values()].some((intent) =>
        intent.ownerAddress === normalized.ownerAddress && !isTerminalIntent(intent.status))) {
        throw setupError("SETUP_OWNER_BUSY");
      }
      if ([...intents.values()].some((intent) => intent.deploymentNonce === normalized.deploymentNonce)) {
        throw setupError("SETUP_DEPLOYMENT_NONCE_CONFLICT");
      }
      const record: InternalIntent = freeze({
        id: normalized.setupIntentId,
        capabilityDigest: normalized.capabilityDigest,
        ownerAddress: normalized.ownerAddress,
        executorAddress: normalized.executorAddress,
        messageToSign: normalized.messageToSign,
        homeChainId: 196 as const,
        deploymentNonce: normalized.deploymentNonce,
        manifestSha256: normalized.manifestSha256,
        factoryAddress: normalized.factoryAddress,
        factoryRuntimeCodeHash: normalized.factoryRuntimeCodeHash,
        deploymentSalt: normalized.deploymentSalt,
        predictedAccount: normalized.predictedAccount,
        accountCreationCodeHash: normalized.accountCreationCodeHash,
        accountRuntimeCodeHash: normalized.accountRuntimeCodeHash,
        authorizationHash: normalized.authorizationHash,
        status: "PENDING" as const,
        expiresAt: normalized.expiresAt,
        createdAt: normalized.at,
        updatedAt: normalized.at,
      });
      intents.set(record.id, record);
      capabilityToIntent.set(record.capabilityDigest, record.id);
      appendEvent(record.id, "SETUP_CHALLENGE_CREATED", normalized.at);
      return freeze({ disposition: "CREATED" as const, setupIntentId: record.id, expiresAt: record.expiresAt });
    },

    async admit(input) {
      assertDigest(input.capabilityDigest);
      assertSignature(input.ownerSetupSignature);
      assertTimestamp(input.at);
      const intent = requireIntentByCapability(capabilityToIntent, intents, input.capabilityDigest.toLowerCase());
      const normalizedSignature = input.ownerSetupSignature.toLowerCase();
      if (intent.status !== "PENDING") {
        if (intent.ownerSetupSignature === normalizedSignature && intent.jobId && !["FAILED", "EXPIRED", "MANUAL_REVIEW"].includes(intent.status)) {
          return freeze({ disposition: "REPLAY" as const, setupIntentId: intent.id, jobId: intent.jobId });
        }
        throw setupError("SETUP_STATE_CONFLICT");
      }
      if (Date.parse(intent.expiresAt) <= Date.parse(input.at)) throw setupError("SETUP_EXPIRED");
      const tenantId = createId();
      const jobId = createId();
      const admitted: InternalIntent = freeze({
        ...intent,
        status: "ADMITTED" as const,
        ownerSetupSignature: normalizedSignature,
        tenantId,
        jobId,
        admittedAt: input.at,
        updatedAt: input.at,
      });
      const job: SetupDeploymentJob = freeze({
        id: jobId,
        setupIntentId: intent.id,
        tenantId,
        status: "QUEUED" as const,
        chainId: 196 as const,
        attemptCount: 0,
        createdAt: input.at,
        updatedAt: input.at,
      });
      intents.set(intent.id, admitted);
      jobs.set(job.id, job);
      appendEvent(intent.id, "SETUP_ADMITTED", input.at, job);
      return freeze({ disposition: "ADMITTED" as const, setupIntentId: intent.id, jobId });
    },

    async status(input) {
      assertDigest(input.capabilityDigest);
      assertTimestamp(input.at);
      const intent = requireIntentByCapability(capabilityToIntent, intents, input.capabilityDigest.toLowerCase());
      const job = intent.jobId ? jobs.get(intent.jobId) : undefined;
      const publicStatus = mapPublicStatus(intent, input.at);
      return freeze({
        setupIntentId: intent.id,
        status: publicStatus,
        predictedAccount: intent.predictedAccount,
        ...(job?.transactionHash && ["BROADCAST", "BROADCAST_UNKNOWN", "CONFIRMING", "COMPLETED", "FAILED", "MANUAL_REVIEW"].includes(job.status)
          ? { transactionHash: job.transactionHash }
          : {}),
        ...(intent.publicCode ? { publicCode: intent.publicCode } : {}),
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
        ...(intent.completedAt ? { completedAt: intent.completedAt } : {}),
      });
    },

    async prune(input) {
      assertTimestamp(input.at);
      let expiredSetups = 0;
      for (const [id, intent] of intents) {
        if (intent.status === "PENDING" && Date.parse(intent.expiresAt) <= Date.parse(input.at)) {
          intents.set(id, freeze({ ...intent, status: "EXPIRED" as const, publicCode: "SETUP_EXPIRED", updatedAt: input.at }));
          expiredSetups += 1;
        }
      }
      return freeze({ expiredSetups, deletedRateBuckets: 0 });
    },
  };

  const worker: ProductionSetupWorkerStore = {
    async claim(input) {
      assertTimestamp(input.at);
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(input.workerId) || input.leaseSeconds < 15 || input.leaseSeconds > 900) {
        throw setupError("SETUP_INPUT_INVALID");
      }
      const recoverableStatuses: readonly SetupDeploymentJobStatus[] = [
        "SIGNING", "SIGNED", "BROADCAST", "BROADCAST_UNKNOWN", "CONFIRMING",
      ];
      const candidate = [...jobs.values()]
        .filter((job) => job.status === "QUEUED" || (recoverableStatuses.includes(job.status)
          && Date.parse(job.leaseUntil ?? "") <= Date.parse(input.at)))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!candidate) return null;
      const intent = requireIntent(intents, candidate.setupIntentId);
      if (!intent.ownerSetupSignature) throw setupError("SETUP_SIGNATURE_MISSING");
      const jobStatus = candidate.status === "QUEUED" ? "SIGNING" as const : candidate.status as SetupWorkerClaim["jobStatus"];
      const updatedJob: SetupDeploymentJob = freeze({
        ...candidate,
        status: jobStatus,
        workerId: input.workerId,
        fencingToken: createFencingToken(),
        leaseUntil: new Date(Date.parse(input.at) + input.leaseSeconds * 1_000).toISOString(),
        attemptCount: candidate.attemptCount + 1,
        updatedAt: input.at,
      });
      const intentStatus: ProductionSetupStatus = candidate.status === "QUEUED" ? "SIGNING" : intent.status;
      const updatedIntent: InternalIntent = freeze({ ...intent, status: intentStatus, updatedAt: input.at });
      jobs.set(candidate.id, updatedJob);
      intents.set(intent.id, updatedIntent);
      appendEvent(intent.id, "SETUP_JOB_CLAIMED", input.at, updatedJob);
      return freeze({
        disposition: "CLAIMED" as const,
        jobStatus,
        jobId: updatedJob.id,
        setupIntentId: updatedIntent.id,
        tenantId: updatedJob.tenantId,
        fencingToken: updatedJob.fencingToken!,
        leaseUntil: updatedJob.leaseUntil!,
        ownerSetupSignature: intent.ownerSetupSignature,
        ownerAddress: updatedIntent.ownerAddress,
        executorAddress: updatedIntent.executorAddress,
        homeChainId: 196,
        deploymentNonce: updatedIntent.deploymentNonce,
        manifestSha256: updatedIntent.manifestSha256,
        factoryAddress: updatedIntent.factoryAddress,
        factoryRuntimeCodeHash: updatedIntent.factoryRuntimeCodeHash,
        deploymentSalt: updatedIntent.deploymentSalt,
        predictedAccount: updatedIntent.predictedAccount,
        accountCreationCodeHash: updatedIntent.accountCreationCodeHash,
        accountRuntimeCodeHash: updatedIntent.accountRuntimeCodeHash,
        authorizationHash: updatedIntent.authorizationHash,
        expiresAt: updatedIntent.expiresAt,
        ...(updatedJob.deployerAddress ? { deployerAddress: updatedJob.deployerAddress } : {}),
        ...(updatedJob.deployerNonce ? { deployerNonce: updatedJob.deployerNonce } : {}),
        ...(updatedJob.transactionHash ? { transactionHash: updatedJob.transactionHash } : {}),
        ...(updatedJob.rawTransaction ? { rawTransaction: updatedJob.rawTransaction } : {}),
        ...(updatedJob.receiptStatus !== undefined ? { receiptStatus: updatedJob.receiptStatus } : {}),
        ...(updatedJob.receiptBlockNumber ? { receiptBlockNumber: updatedJob.receiptBlockNumber } : {}),
        ...(updatedJob.existingAccountVerified ? { existingAccountVerified: true } : {}),
        ...(updatedJob.broadcastAt ? { broadcastAt: updatedJob.broadcastAt } : {}),
      });
    },

    async reserve(input) {
      const job = requireJob(jobs, input.jobId);
      requireFence(job, input.fencingToken);
      assertTimestamp(input.at);
      const gasLimit = parseAtomic(input.gasLimit);
      const nativeCostWei = parseAtomic(input.nativeCostWei);
      const deployerAddress = normalizeAddress(input.deployerAddress);
      const nonce = parseAtomic(input.deployerNonce, true);
      const existing = reservations.get(job.id);
      if (existing) {
        if (existing.deployerAddress === deployerAddress && existing.deployerNonce === nonce.toString()
          && existing.gasLimit === gasLimit && existing.nativeCostWei === nativeCostWei) {
          return freeze({ disposition: "REPLAY" as const, jobId: job.id, dayKey: existing.dayKey });
        }
        throw setupError("SETUP_BUDGET_CONFLICT");
      }
      if (job.status !== "SIGNING") throw setupError("SETUP_STATE_CONFLICT");
      if (deployerAddress !== sponsorPolicy.deployerAddress
        || gasLimit > sponsorPolicy.maxGasPerDeployment) throw setupError("SETUP_SPONSOR_POLICY_MISMATCH");
      if ([...reservations.values()].some((record) =>
        record.deployerAddress === deployerAddress && record.deployerNonce === nonce.toString())) {
        throw setupError("SETUP_DEPLOYER_NONCE_CONFLICT");
      }
      const dayKey = input.at.slice(0, 10);
      const daily = [...reservations.values()].filter((record) => record.dayKey === dayKey && record.deployerAddress === deployerAddress);
      const dailyCost = daily.reduce((sum, record) => sum + record.nativeCostWei, 0n);
      const pending = [...jobs.values()].filter((record) =>
        record.deployerAddress === deployerAddress && ["SIGNING", "SIGNED", "BROADCAST", "BROADCAST_UNKNOWN", "CONFIRMING"].includes(record.status)).length;
      if (daily.length >= sponsorPolicy.maxDeploymentsPerDay
        || dailyCost + nativeCostWei > sponsorPolicy.maxNativeCostPerDayWei
        || pending >= sponsorPolicy.maxPending) throw setupError("SETUP_SPONSOR_CAP");
      const reservation: SetupSponsorReservation = freeze({
        id: createId(), jobId: job.id, dayKey, deployerAddress, deployerNonce: nonce.toString(),
        gasLimit, nativeCostWei, status: "CHARGED" as const, reservedAt: input.at,
      });
      const updatedJob = freeze({ ...job, deployerAddress, deployerNonce: nonce.toString(), updatedAt: input.at });
      reservations.set(job.id, reservation);
      jobs.set(job.id, updatedJob);
      appendEvent(job.setupIntentId, "SETUP_SPONSOR_RESERVED", input.at, updatedJob);
      return freeze({ disposition: "RESERVED" as const, jobId: job.id, dayKey });
    },

    async persistSignedTransaction(input) {
      const job = requireJob(jobs, input.jobId);
      requireFence(job, input.fencingToken);
      assertTimestamp(input.at);
      assertHash(input.transactionHash);
      assertEncryptedTransaction(input.rawTransaction);
      if (job.status === "SIGNED") {
        if (job.transactionHash === input.transactionHash.toLowerCase() && sameEncrypted(job.rawTransaction, input.rawTransaction)) {
          return freeze({
            disposition: "REPLAY" as const, jobId: job.id, status: "SIGNED" as const,
            transactionHash: job.transactionHash,
          });
        }
        throw setupError("SETUP_OUTBOX_CONFLICT");
      }
      if (job.status !== "SIGNING" || !reservations.has(job.id)) throw setupError("SETUP_STATE_CONFLICT");
      if ([...jobs.values()].some((other) => other.id !== job.id && other.transactionHash === input.transactionHash.toLowerCase())) {
        throw setupError("SETUP_TRANSACTION_HASH_CONFLICT");
      }
      const rawTransaction = freeze({ ...input.rawTransaction, hash: input.rawTransaction.hash.toLowerCase() });
      const updatedJob: SetupDeploymentJob = freeze({
        ...job, status: "SIGNED" as const, transactionHash: input.transactionHash.toLowerCase(),
        rawTransaction, updatedAt: input.at,
      });
      updateIntentStatus(job.setupIntentId, "SIGNED", input.at, { signedAt: input.at });
      jobs.set(job.id, updatedJob);
      appendEvent(job.setupIntentId, "SETUP_TRANSACTION_SIGNED", input.at, updatedJob);
      return freeze({
        disposition: "SIGNED" as const, jobId: job.id, status: "SIGNED" as const,
        transactionHash: updatedJob.transactionHash!,
      });
    },

    async markBroadcastResult(input) {
      const job = requireJob(jobs, input.jobId);
      requireFence(job, input.fencingToken);
      assertTimestamp(input.at);
      if (input.publicCode) assertPublicCode(input.publicCode);
      if (job.status === input.result) {
        return freeze({ disposition: "REPLAY" as const, jobId: job.id, status: input.result });
      }
      if (job.status !== "SIGNED") throw setupError("SETUP_STATE_CONFLICT");
      const updatedJob: SetupDeploymentJob = freeze({
        ...job, status: input.result, broadcastAt: job.broadcastAt ?? input.at,
        ...(input.publicCode ? { publicCode: input.publicCode } : {}), updatedAt: input.at,
      });
      updateIntentStatus(job.setupIntentId, input.result, input.at, input.publicCode ? { publicCode: input.publicCode } : {});
      jobs.set(job.id, updatedJob);
      appendEvent(job.setupIntentId, "SETUP_BROADCAST_RECORDED", input.at, updatedJob, input.publicCode, { result: input.result });
      return freeze({ disposition: input.result, jobId: job.id, status: input.result });
    },

    async recordReceipt(input) {
      const job = requireJob(jobs, input.jobId);
      requireFence(job, input.fencingToken);
      assertTimestamp(input.at);
      assertHash(input.transactionHash);
      parseAtomic(input.receiptBlockNumber, true);
      if (job.transactionHash !== input.transactionHash.toLowerCase()) throw setupError("SETUP_TRANSACTION_MISMATCH");
      if (["CONFIRMING", "FAILED"].includes(job.status) && job.receiptStatus === input.receiptStatus
        && job.receiptBlockNumber === input.receiptBlockNumber) {
        return freeze({ disposition: "REPLAY" as const, jobId: job.id, status: job.status as "CONFIRMING" | "FAILED" });
      }
      if (!["BROADCAST", "BROADCAST_UNKNOWN"].includes(job.status)) throw setupError("SETUP_STATE_CONFLICT");
      const nextStatus = input.receiptStatus === 1 ? "CONFIRMING" as const : "FAILED" as const;
      const publicCode = input.receiptStatus === 0 ? "SETUP_TRANSACTION_REVERTED" : undefined;
      const updatedJob: SetupDeploymentJob = freeze({
        ...job, status: nextStatus, receiptStatus: input.receiptStatus,
        receiptBlockNumber: input.receiptBlockNumber,
        ...(input.receiptStatus === 1 ? { confirmedAt: input.at } : { publicCode }), updatedAt: input.at,
      });
      updateIntentStatus(job.setupIntentId, nextStatus, input.at, publicCode ? { publicCode } : {});
      jobs.set(job.id, updatedJob);
      appendEvent(job.setupIntentId, "SETUP_RECEIPT_RECORDED", input.at, updatedJob, publicCode, {
        receiptStatus: input.receiptStatus, blockNumber: input.receiptBlockNumber,
      });
      return freeze({ disposition: "RECORDED" as const, jobId: job.id, status: nextStatus });
    },

    async recordExistingAccount(input) {
      const job = requireJob(jobs, input.jobId);
      requireFence(job, input.fencingToken);
      assertTimestamp(input.at);
      parseAtomic(input.verificationBlockNumber, true);
      if (job.status === "CONFIRMING" && job.existingAccountVerified
        && job.receiptBlockNumber === input.verificationBlockNumber) {
        return freeze({ disposition: "REPLAY" as const, jobId: job.id, status: "CONFIRMING" as const });
      }
      if (job.status !== "SIGNING" || reservations.has(job.id) || job.transactionHash || job.rawTransaction) {
        throw setupError("SETUP_STATE_CONFLICT");
      }
      const updatedJob: SetupDeploymentJob = freeze({
        ...job,
        status: "CONFIRMING" as const,
        receiptStatus: 1 as const,
        receiptBlockNumber: input.verificationBlockNumber,
        existingAccountVerified: true,
        confirmedAt: input.at,
        updatedAt: input.at,
      });
      updateIntentStatus(job.setupIntentId, "CONFIRMING", input.at);
      jobs.set(job.id, updatedJob);
      appendEvent(job.setupIntentId, "SETUP_EXISTING_ACCOUNT_VERIFIED", input.at, updatedJob, undefined, {
        blockNumber: input.verificationBlockNumber,
      });
      return freeze({ disposition: "RECORDED" as const, jobId: job.id, status: "CONFIRMING" as const });
    },

    async finalize(input) {
      const job = requireJob(jobs, input.jobId);
      requireFence(job, input.fencingToken);
      assertTimestamp(input.at);
      const intent = requireIntent(intents, job.setupIntentId);
      if (job.status === "COMPLETED" && intent.status === "COMPLETED") {
        return freeze({
          disposition: "REPLAY" as const, jobId: job.id, tenantId: job.tenantId,
          accountAddress: intent.predictedAccount,
        });
      }
      if (job.status !== "CONFIRMING" || job.receiptStatus !== 1 || intent.status !== "CONFIRMING") {
        throw setupError("SETUP_STATE_CONFLICT");
      }
      const updatedJob: SetupDeploymentJob = freeze({ ...job, status: "COMPLETED" as const, completedAt: input.at, updatedAt: input.at });
      updateIntentStatus(intent.id, "COMPLETED", input.at, { completedAt: input.at });
      jobs.set(job.id, updatedJob);
      appendEvent(intent.id, "SETUP_COMPLETED", input.at, updatedJob, undefined, { accountAddress: intent.predictedAccount });
      return freeze({
        disposition: "COMPLETED" as const, jobId: job.id, tenantId: job.tenantId,
        accountAddress: intent.predictedAccount,
      });
    },

    async markManualReview(input) {
      const job = requireJob(jobs, input.jobId);
      requireFence(job, input.fencingToken);
      assertTimestamp(input.at);
      assertPublicCode(input.publicCode);
      if (job.status === "MANUAL_REVIEW" && job.publicCode === input.publicCode) {
        return freeze({ disposition: "REPLAY" as const, jobId: job.id, status: "MANUAL_REVIEW" as const });
      }
      if (["COMPLETED", "FAILED", "MANUAL_REVIEW"].includes(job.status)) throw setupError("SETUP_STATE_CONFLICT");
      const updatedJob: SetupDeploymentJob = freeze({ ...job, status: "MANUAL_REVIEW" as const, publicCode: input.publicCode, updatedAt: input.at });
      updateIntentStatus(job.setupIntentId, "MANUAL_REVIEW", input.at, { publicCode: input.publicCode });
      jobs.set(job.id, updatedJob);
      appendEvent(job.setupIntentId, "SETUP_MANUAL_REVIEW", input.at, updatedJob, input.publicCode);
      return freeze({ disposition: "MANUAL_REVIEW" as const, jobId: job.id, status: "MANUAL_REVIEW" as const });
    },
  };
  function appendEvent(
    setupIntentId: string,
    eventType: string,
    createdAt: string,
    job?: SetupDeploymentJob,
    publicCode?: string,
    metadata: Record<string, string | number | boolean> = {},
  ): void {
    if (JSON.stringify(metadata).match(/owner.?setup.?signature|raw.?tx|ciphertext/i)) throw setupError("SETUP_AUDIT_INVALID");
    events.push(freeze({
      id: createId(), setupIntentId, ...(job ? { jobId: job.id, tenantId: job.tenantId } : {}),
      eventType, ...(publicCode ? { publicCode } : {}), metadata: freeze({ ...metadata }), createdAt,
    }));
  }
  function updateIntentStatus(
    id: string,
    status: ProductionSetupStatus,
    updatedAt: string,
    extra: Pick<ProductionSetupIntent, "signedAt" | "completedAt" | "publicCode"> = {},
  ): void {
    const intent = requireIntent(intents, id);
    intents.set(id, freeze({ ...intent, status, updatedAt, ...extra }));
  }
  return freeze({
    web: freeze(web),
    worker: freeze(worker),
    inspect: freeze({
      intent(id: string) { const intent = intents.get(id); return intent ? publicIntent(intent) : null; },
      events() { return freeze(events.map(cloneEvent)); },
      jobs() { return freeze([...jobs.values()].map(cloneJob)); },
      reservations() { return freeze([...reservations.values()].map(cloneReservation)); },
    }),
  });
}
function normalizeChallenge(input: ProductionSetupChallengeInput): ProductionSetupChallengeInput {
  if (input.homeChainId !== 196 || input.setupIntentId.length < 16 || input.messageToSign.length === 0) throw setupError("SETUP_INPUT_INVALID");
  assertDigest(input.capabilityDigest);
  assertTimestamp(input.at);
  assertTimestamp(input.expiresAt);
  if (Date.parse(input.expiresAt) <= Date.parse(input.at)) throw setupError("SETUP_INPUT_INVALID");
  const ownerAddress = normalizeAddress(input.ownerAddress);
  const executorAddress = normalizeAddress(input.executorAddress);
  const factoryAddress = normalizeAddress(input.factoryAddress);
  if (new Set([ownerAddress, executorAddress, factoryAddress]).size !== 3) throw setupError("SETUP_ACTOR_COLLISION");
  for (const value of [input.deploymentNonce, input.manifestSha256, input.factoryRuntimeCodeHash,
    input.deploymentSalt, input.accountCreationCodeHash, input.accountRuntimeCodeHash, input.authorizationHash]) assertHash(value);
  return freeze({
    ...input, capabilityDigest: input.capabilityDigest.toLowerCase(), ownerAddress, executorAddress, factoryAddress,
    predictedAccount: normalizeAddress(input.predictedAccount), deploymentNonce: input.deploymentNonce.toLowerCase(),
    manifestSha256: input.manifestSha256.toLowerCase(), factoryRuntimeCodeHash: input.factoryRuntimeCodeHash.toLowerCase(),
    deploymentSalt: input.deploymentSalt.toLowerCase(), accountCreationCodeHash: input.accountCreationCodeHash.toLowerCase(),
    accountRuntimeCodeHash: input.accountRuntimeCodeHash.toLowerCase(), authorizationHash: input.authorizationHash.toLowerCase(),
  });
}
function sameChallenge(existing: ProductionSetupIntent, input: ProductionSetupChallengeInput): boolean {
  return existing.id === input.setupIntentId && existing.ownerAddress === input.ownerAddress
    && existing.executorAddress === input.executorAddress && existing.messageToSign === input.messageToSign
    && existing.deploymentNonce === input.deploymentNonce && existing.manifestSha256 === input.manifestSha256
    && existing.factoryAddress === input.factoryAddress && existing.factoryRuntimeCodeHash === input.factoryRuntimeCodeHash
    && existing.deploymentSalt === input.deploymentSalt && existing.predictedAccount === input.predictedAccount
    && existing.accountCreationCodeHash === input.accountCreationCodeHash
    && existing.accountRuntimeCodeHash === input.accountRuntimeCodeHash
    && existing.authorizationHash === input.authorizationHash && existing.expiresAt === input.expiresAt;
}
function mapPublicStatus(intent: ProductionSetupIntent, at: string): MainnetWalletSetupPublicStatus["status"] {
  if (intent.status === "PENDING" && Date.parse(intent.expiresAt) <= Date.parse(at)) return "SETUP_EXPIRED";
  if (["PENDING", "ADMITTED"].includes(intent.status)) return "SETUP_PENDING";
  if (["SIGNING", "SIGNED", "BROADCAST", "BROADCAST_UNKNOWN", "CONFIRMING"].includes(intent.status)) return "SETUP_DEPLOYING";
  if (intent.status === "COMPLETED") return "SETUP_COMPLETED";
  if (intent.status === "EXPIRED") return "SETUP_EXPIRED";
  if (intent.status === "MANUAL_REVIEW") return "SETUP_MANUAL_REVIEW";
  return "SETUP_FAILED";
}
function publicIntent(intent: InternalIntent): ProductionSetupIntent {
  const { ownerSetupSignature: _signature, tenantId: _tenant, jobId: _job, ...record } = intent;
  return freeze({ ...record });
}
function cloneJob(job: SetupDeploymentJob): SetupDeploymentJob {
  return freeze({ ...job, ...(job.rawTransaction ? { rawTransaction: freeze({ ...job.rawTransaction }) } : {}) });
}
function cloneEvent(event: SetupDeploymentEvent): SetupDeploymentEvent {
  return freeze({ ...event, metadata: freeze({ ...event.metadata }) });
}
function cloneReservation(reservation: SetupSponsorReservation): SetupSponsorReservation {
  return freeze({ ...reservation });
}
function requireIntent(records: Map<string, InternalIntent>, id: string): InternalIntent {
  const record = records.get(id);
  if (!record) throw setupError("SETUP_NOT_FOUND");
  return record;
}
function requireIntentByCapability(
  byCapability: Map<string, string>, records: Map<string, InternalIntent>, digest: string,
): InternalIntent {
  const id = byCapability.get(digest);
  if (!id) throw setupError("SETUP_NOT_FOUND");
  return requireIntent(records, id);
}
function requireJob(records: Map<string, SetupDeploymentJob>, id: string): SetupDeploymentJob {
  const job = records.get(id);
  if (!job) throw setupError("SETUP_JOB_NOT_FOUND");
  return job;
}
function requireFence(job: SetupDeploymentJob, fencingToken: string): void {
  if (!job.fencingToken || job.fencingToken !== fencingToken) throw setupError("SETUP_FENCE_STALE");
}
function assertDigest(value: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw setupError("SETUP_INPUT_INVALID");
}
function assertHash(value: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw setupError("SETUP_INPUT_INVALID");
}
function assertSignature(value: string): void {
  if (!/^0x[0-9a-fA-F]{130}$/.test(value)) throw setupError("SETUP_INPUT_INVALID");
}
function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw setupError("SETUP_INPUT_INVALID");
}
function assertPublicCode(value: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) throw setupError("SETUP_INPUT_INVALID");
}
function normalizeAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw setupError("SETUP_INPUT_INVALID");
  return value.toLowerCase();
}
function parseAtomic(value: string, allowZero = false): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw setupError("SETUP_INPUT_INVALID");
  const parsed = BigInt(value);
  if ((!allowZero && parsed <= 0n) || parsed >= 2n ** 256n) throw setupError("SETUP_INPUT_INVALID");
  return parsed;
}
function assertEncryptedTransaction(value: EncryptedSetupTransaction): void {
  if (!value.ciphertext || !value.iv || !value.tag) throw setupError("SETUP_INPUT_INVALID");
  assertDigest(value.hash);
}
function sameEncrypted(left: EncryptedSetupTransaction | undefined, right: EncryptedSetupTransaction): boolean {
  return left?.ciphertext === right.ciphertext && left.iv === right.iv && left.tag === right.tag
    && left.hash === right.hash.toLowerCase();
}
function isTerminalIntent(status: ProductionSetupStatus): boolean {
  return ["COMPLETED", "EXPIRED", "FAILED", "MANUAL_REVIEW"].includes(status);
}
function setupError(code: string): ProductionSetupStoreError {
  return new ProductionSetupStoreError(code);
}
function freeze<T>(value: T): Readonly<T> & T {
  return Object.freeze(value);
}
