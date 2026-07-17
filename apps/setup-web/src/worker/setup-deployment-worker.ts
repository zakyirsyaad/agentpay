import { Transaction, getAddress, keccak256, type TransactionRequest } from "ethers";

import type {
  ProductionSetupWorkerStore,
  SetupWorkerClaim,
} from "@agentpay-ai/mcp-server";
import {
  buildSetupDeploymentTransaction,
  decryptSetupRawTransaction,
  encryptSetupRawTransaction,
  signSetupDeploymentTransaction,
  type SetupTransactionLimits,
  type SetupTransactionSigner,
} from "./setup-transaction.ts";
import type {
  SetupAccountVerificationResult,
  SetupDeploymentReceipt,
} from "./setup-account-verifier.ts";

export interface SetupDeploymentChain {
  getCode(address: string): Promise<string>;
  getTransactionCount(address: string, blockTag: "latest" | "pending"): Promise<number>;
  getFeeData(): Promise<Readonly<{ maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null }>>;
  estimateGas(transaction: TransactionRequest): Promise<bigint>;
  broadcastTransaction(rawTransaction: string): Promise<Readonly<{ hash: string }>>;
  getTransactionReceipt(transactionHash: string): Promise<SetupDeploymentReceipt | null>;
  getBlockNumber(): Promise<number>;
}

export interface SetupDeploymentWorkerConfig {
  readonly workerId: string;
  readonly leaseSeconds: number;
  readonly encryptionKey: Uint8Array;
  readonly factoryDeploymentBlock: number;
  readonly receiptTimeoutSeconds: number;
  readonly limits: SetupTransactionLimits;
}

export interface SetupDeploymentWorkerDependencies {
  readonly store: ProductionSetupWorkerStore;
  readonly signer: SetupTransactionSigner;
  readonly chain: SetupDeploymentChain;
  readonly config: SetupDeploymentWorkerConfig;
  readonly verifyPreflight: (claim: SetupWorkerClaim) => Promise<void>;
  readonly verifyAccount: (input: {
    readonly claim: SetupWorkerClaim;
    readonly factoryDeploymentBlock: number;
    readonly verificationBlockNumber: number;
    readonly receipt?: SetupDeploymentReceipt;
  }) => Promise<SetupAccountVerificationResult>;
}

export type SetupDeploymentWorkerResult = Readonly<{
  jobId?: string;
  status: "IDLE" | "SIGNED" | "BROADCAST" | "BROADCAST_UNKNOWN" | "PENDING" | "FAILED" | "MANUAL_REVIEW" | "COMPLETED";
}>;

export function createSetupDeploymentWorker(dependencies: SetupDeploymentWorkerDependencies) {
  validateWorkerConfig(dependencies.config);

  async function processNext(at: string): Promise<SetupDeploymentWorkerResult> {
    const claim = await dependencies.store.claim({
      workerId: dependencies.config.workerId,
      at,
      leaseSeconds: dependencies.config.leaseSeconds,
    });
    if (!claim) return Object.freeze({ status: "IDLE" as const });
    return processClaim(claim, at);
  }

  async function processClaim(claim: SetupWorkerClaim, at: string): Promise<SetupDeploymentWorkerResult> {
    switch (claim.jobStatus) {
      case "SIGNING":
        return processSigning(claim, at);
      case "SIGNED":
        return processPersistedSigned(claim, at);
      case "BROADCAST":
      case "BROADCAST_UNKNOWN":
        return reconcileBroadcast(claim, at);
      case "CONFIRMING":
        return reconcileConfirming(claim, at);
    }
  }

  async function processSigning(claim: SetupWorkerClaim, at: string): Promise<SetupDeploymentWorkerResult> {
    await dependencies.verifyPreflight(claim);
    const existingCode = await dependencies.chain.getCode(claim.predictedAccount);
    if (existingCode !== "0x") {
      const verificationBlockNumber = await dependencies.chain.getBlockNumber();
      if (!await verifyOrManual(claim, at, verificationBlockNumber)) return result(claim, "MANUAL_REVIEW");
      await dependencies.store.recordExistingAccount({
        jobId: claim.jobId,
        fencingToken: claim.fencingToken,
        verificationBlockNumber: String(verificationBlockNumber),
        at,
      });
      await dependencies.store.finalize({ jobId: claim.jobId, fencingToken: claim.fencingToken, at });
      return result(claim, "COMPLETED");
    }

    const deployerAddress = getAddress(await dependencies.signer.getAddress()).toLowerCase();
    const [nonce, feeData] = await Promise.all([
      dependencies.signer.getNonce("pending"),
      dependencies.chain.getFeeData(),
    ]);
    if (!Number.isSafeInteger(nonce) || nonce < 0 || feeData.maxFeePerGas === null
      || feeData.maxPriorityFeePerGas === null) throw new Error("SETUP_CHAIN_FEE_DATA_INVALID");

    const estimateRequest = buildSetupDeploymentTransaction({
      claim,
      deployerAddress,
      deployerNonce: BigInt(nonce),
      gasLimit: 1n,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      limits: dependencies.config.limits,
    });
    const { gasLimit: _estimateGasLimit, ...unboundedEstimateRequest } = estimateRequest;
    const gasLimit = await dependencies.chain.estimateGas(unboundedEstimateRequest);
    const transaction = buildSetupDeploymentTransaction({
      claim,
      deployerAddress,
      deployerNonce: BigInt(nonce),
      gasLimit,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      limits: dependencies.config.limits,
    });
    await dependencies.store.reserve({
      jobId: claim.jobId,
      fencingToken: claim.fencingToken,
      deployerAddress,
      deployerNonce: String(nonce),
      gasLimit: gasLimit.toString(),
      nativeCostWei: (gasLimit * feeData.maxFeePerGas).toString(),
      at,
    });
    const signed = await signSetupDeploymentTransaction({ transaction, signer: dependencies.signer });
    const encrypted = encryptSetupRawTransaction(signed.rawTransaction, dependencies.config.encryptionKey);
    await dependencies.store.persistSignedTransaction({
      jobId: claim.jobId,
      fencingToken: claim.fencingToken,
      rawTransaction: encrypted,
      transactionHash: signed.transactionHash,
      at,
    });
    return broadcastPersisted(claim, signed.rawTransaction, signed.transactionHash, at);
  }

  async function processPersistedSigned(claim: SetupWorkerClaim, at: string): Promise<SetupDeploymentWorkerResult> {
    if (!claim.rawTransaction || !claim.transactionHash || !claim.deployerAddress || claim.deployerNonce === undefined) {
      return manualReview(claim, at, "SETUP_OUTBOX_MISSING");
    }
    let rawTransaction: string;
    try {
      rawTransaction = decryptSetupRawTransaction(claim.rawTransaction, dependencies.config.encryptionKey);
      assertPersistedTransaction(claim, rawTransaction, dependencies.config.limits);
    } catch {
      return manualReview(claim, at, "SETUP_OUTBOX_MISMATCH");
    }
    return broadcastPersisted(claim, rawTransaction, claim.transactionHash, at);
  }

  async function broadcastPersisted(
    claim: SetupWorkerClaim,
    rawTransaction: string,
    transactionHash: string,
    at: string,
  ): Promise<SetupDeploymentWorkerResult> {
    let broadcastStatus: "BROADCAST" | "BROADCAST_UNKNOWN";
    try {
      const response = await dependencies.chain.broadcastTransaction(rawTransaction);
      if (response.hash.toLowerCase() !== transactionHash.toLowerCase()) {
        return manualReview(claim, at, "SETUP_BROADCAST_HASH_MISMATCH");
      }
      broadcastStatus = "BROADCAST";
    } catch (error) {
      if (isAlreadyKnown(error)) {
        broadcastStatus = "BROADCAST";
      } else {
        broadcastStatus = "BROADCAST_UNKNOWN";
      }
    }
    await dependencies.store.markBroadcastResult({
      jobId: claim.jobId,
      fencingToken: claim.fencingToken,
      result: broadcastStatus,
      ...(broadcastStatus === "BROADCAST_UNKNOWN" ? { publicCode: "SETUP_RPC_AMBIGUOUS" } : {}),
      at,
    });
    return result(claim, broadcastStatus);
  }

  async function reconcileBroadcast(claim: SetupWorkerClaim, at: string): Promise<SetupDeploymentWorkerResult> {
    if (!claim.transactionHash || !claim.deployerAddress || claim.deployerNonce === undefined) {
      return manualReview(claim, at, "SETUP_OUTBOX_MISSING");
    }
    const receipt = await dependencies.chain.getTransactionReceipt(claim.transactionHash);
    if (!receipt) {
      const latestNonce = await dependencies.chain.getTransactionCount(claim.deployerAddress, "latest");
      if (BigInt(latestNonce) > BigInt(claim.deployerNonce)) {
        return manualReview(claim, at, "SETUP_TRANSACTION_REPLACED");
      }
      const broadcastAt = claim.broadcastAt ? Date.parse(claim.broadcastAt) : Number.NaN;
      const checkedAt = Date.parse(at);
      if (!Number.isFinite(broadcastAt) || !Number.isFinite(checkedAt)) {
        return manualReview(claim, at, "SETUP_BROADCAST_TIME_MISSING");
      }
      if (checkedAt - broadcastAt >= dependencies.config.receiptTimeoutSeconds * 1_000) {
        return manualReview(claim, at, "SETUP_TRANSACTION_UNCONFIRMED");
      }
      return result(claim, "PENDING");
    }
    const receiptStatus = receipt.status === 1 ? 1 as const : 0 as const;
    await dependencies.store.recordReceipt({
      jobId: claim.jobId,
      fencingToken: claim.fencingToken,
      transactionHash: claim.transactionHash,
      receiptStatus,
      receiptBlockNumber: String(receipt.blockNumber),
      at,
    });
    if (receiptStatus === 0) return result(claim, "FAILED");
    const verificationBlockNumber = await dependencies.chain.getBlockNumber();
    if (!await verifyOrManual(claim, at, verificationBlockNumber, receipt)) return result(claim, "MANUAL_REVIEW");
    await dependencies.store.finalize({ jobId: claim.jobId, fencingToken: claim.fencingToken, at });
    return result(claim, "COMPLETED");
  }

  async function reconcileConfirming(claim: SetupWorkerClaim, at: string): Promise<SetupDeploymentWorkerResult> {
    if (claim.existingAccountVerified) {
      const blockNumber = parseBlock(claim.receiptBlockNumber);
      if (!await verifyOrManual(claim, at, blockNumber)) return result(claim, "MANUAL_REVIEW");
    } else {
      if (!claim.transactionHash) return manualReview(claim, at, "SETUP_OUTBOX_MISSING");
      const receipt = await dependencies.chain.getTransactionReceipt(claim.transactionHash);
      if (!receipt || receipt.status !== 1) return result(claim, "PENDING");
      const verificationBlockNumber = await dependencies.chain.getBlockNumber();
      if (!await verifyOrManual(claim, at, verificationBlockNumber, receipt)) return result(claim, "MANUAL_REVIEW");
    }
    await dependencies.store.finalize({ jobId: claim.jobId, fencingToken: claim.fencingToken, at });
    return result(claim, "COMPLETED");
  }

  async function verifyOrManual(
    claim: SetupWorkerClaim,
    at: string,
    verificationBlockNumber: number,
    receipt?: SetupDeploymentReceipt,
  ): Promise<boolean> {
    try {
      await dependencies.verifyAccount({
        claim,
        factoryDeploymentBlock: dependencies.config.factoryDeploymentBlock,
        verificationBlockNumber,
        ...(receipt ? { receipt } : {}),
      });
      return true;
    } catch {
      await dependencies.store.markManualReview({
        jobId: claim.jobId,
        fencingToken: claim.fencingToken,
        publicCode: "SETUP_VERIFICATION_FAILED",
        at,
      });
      return false;
    }
  }

  async function manualReview(claim: SetupWorkerClaim, at: string, publicCode: string) {
    await dependencies.store.markManualReview({
      jobId: claim.jobId,
      fencingToken: claim.fencingToken,
      publicCode,
      at,
    });
    return result(claim, "MANUAL_REVIEW");
  }

  return Object.freeze({ processNext, processClaim });
}

function assertPersistedTransaction(
  claim: SetupWorkerClaim,
  rawTransaction: string,
  limits: SetupTransactionLimits,
): void {
  if (keccak256(rawTransaction).toLowerCase() !== claim.transactionHash?.toLowerCase()) {
    throw new Error("SETUP_OUTBOX_MISMATCH");
  }
  const parsed = Transaction.from(rawTransaction);
  if (parsed.type !== 2 || parsed.chainId !== 196n || !parsed.from || !parsed.to
    || parsed.gasLimit === 0n || parsed.maxFeePerGas === null || parsed.maxPriorityFeePerGas === null) {
    throw new Error("SETUP_OUTBOX_MISMATCH");
  }
  const expected = buildSetupDeploymentTransaction({
    claim,
    deployerAddress: claim.deployerAddress!,
    deployerNonce: BigInt(claim.deployerNonce!),
    gasLimit: parsed.gasLimit,
    maxFeePerGas: parsed.maxFeePerGas,
    maxPriorityFeePerGas: parsed.maxPriorityFeePerGas,
    limits,
  });
  if (parsed.from.toLowerCase() !== expected.from.toLowerCase()
    || parsed.to.toLowerCase() !== expected.to.toLowerCase()
    || parsed.data.toLowerCase() !== expected.data.toLowerCase()
    || parsed.nonce !== expected.nonce || parsed.value !== 0n) throw new Error("SETUP_OUTBOX_MISMATCH");
}

function result(claim: SetupWorkerClaim, status: SetupDeploymentWorkerResult["status"]): SetupDeploymentWorkerResult {
  return Object.freeze({ jobId: claim.jobId, status });
}

function isAlreadyKnown(error: unknown): boolean {
  return error instanceof Error && /already known|known transaction/i.test(error.message);
}

function parseBlock(value: string | undefined): number {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("SETUP_BLOCK_INVALID");
  const block = Number(value);
  if (!Number.isSafeInteger(block)) throw new Error("SETUP_BLOCK_INVALID");
  return block;
}

function validateWorkerConfig(config: SetupDeploymentWorkerConfig): void {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(config.workerId)
    || !Number.isSafeInteger(config.leaseSeconds) || config.leaseSeconds < 15 || config.leaseSeconds > 900
    || !(config.encryptionKey instanceof Uint8Array) || config.encryptionKey.byteLength !== 32
    || !Number.isSafeInteger(config.factoryDeploymentBlock) || config.factoryDeploymentBlock < 0
    || !Number.isSafeInteger(config.receiptTimeoutSeconds)
    || config.receiptTimeoutSeconds < 30 || config.receiptTimeoutSeconds > 3_600) {
    throw new Error("SETUP_WORKER_CONFIG_INVALID");
  }
}
