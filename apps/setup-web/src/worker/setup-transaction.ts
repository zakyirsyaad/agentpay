import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import {
  Interface,
  Transaction,
  TypedDataEncoder,
  getAddress,
  keccak256,
  type TransactionRequest,
} from "ethers";

import type { EncryptedSetupTransaction, SetupWorkerClaim } from "@agentpay-ai/mcp-server";
import {
  MAINNET_SETUP_ENVIRONMENT,
  MAINNET_SETUP_ROUTE_ALLOWLIST_HASH,
  MAINNET_SETUP_TOKEN_ALLOWLIST_HASH,
  MAINNET_SETUP_USDT0,
  MAINNET_WALLET_SETUP_TYPES,
  mainnetWalletSetupMessageSchema,
} from "@agentpay-ai/shared";

const factoryInterface = new Interface([
  "function deployAccount((string setupIntentId,bytes32 deploymentNonce,address owner,address executor,uint256 homeChainId,string environment,uint256 deadline,address factory,bytes32 factoryRuntimeCodeHash,bytes32 deploymentSalt,address predictedAccount,bytes32 accountCreationCodeHash,bytes32 accountRuntimeCodeHash,address token,bytes32 tokenAllowlistHash,bytes32 routeAllowlistHash,bytes32 manifestSha256) authorization,bytes ownerSignature)",
]);

type EthersTypedDataTypes = Record<string, Array<{ name: string; type: string }>>;

export interface SetupTransactionLimits {
  readonly maxGasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxNativeCostWei: bigint;
}

export interface SetupDeploymentTransaction extends Readonly<TransactionRequest> {
  readonly type: 2;
  readonly chainId: 196n;
  readonly from: string;
  readonly to: string;
  readonly value: 0n;
  readonly nonce: number;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly data: string;
}

export interface SetupTransactionSigner {
  getAddress(): Promise<string>;
  getNonce(blockTag?: "latest" | "pending"): Promise<number>;
  signTransaction(transaction: TransactionRequest): Promise<string>;
}

export interface SignedSetupDeploymentTransaction {
  readonly rawTransaction: string;
  readonly transactionHash: string;
}

export function buildSetupAuthorizationFromClaim(claim: SetupWorkerClaim) {
  const deadlineMs = Date.parse(claim.expiresAt);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs % 1_000 !== 0) {
    throw new Error("SETUP_DEADLINE_INVALID");
  }
  const authorization = mainnetWalletSetupMessageSchema.parse({
    setupIntentId: claim.setupIntentId,
    deploymentNonce: claim.deploymentNonce,
    owner: claim.ownerAddress,
    executor: claim.executorAddress,
    homeChainId: claim.homeChainId,
    environment: MAINNET_SETUP_ENVIRONMENT,
    deadline: String(deadlineMs / 1_000),
    factory: claim.factoryAddress,
    factoryRuntimeCodeHash: claim.factoryRuntimeCodeHash,
    deploymentSalt: claim.deploymentSalt,
    predictedAccount: claim.predictedAccount,
    accountCreationCodeHash: claim.accountCreationCodeHash,
    accountRuntimeCodeHash: claim.accountRuntimeCodeHash,
    token: MAINNET_SETUP_USDT0,
    tokenAllowlistHash: MAINNET_SETUP_TOKEN_ALLOWLIST_HASH,
    routeAllowlistHash: MAINNET_SETUP_ROUTE_ALLOWLIST_HASH,
    manifestSha256: claim.manifestSha256,
  });
  const authorizationHash = TypedDataEncoder.hash(
    { name: "AgentPay Setup", version: "1", chainId: 196, verifyingContract: authorization.factory },
    MAINNET_WALLET_SETUP_TYPES as unknown as EthersTypedDataTypes,
    authorization,
  ).toLowerCase();
  if (authorizationHash !== claim.authorizationHash.toLowerCase()) {
    throw new Error("SETUP_AUTHORIZATION_HASH_MISMATCH");
  }
  if (!/^0x[0-9a-f]{130}$/.test(claim.ownerSetupSignature)) {
    throw new Error("SETUP_SIGNATURE_INVALID");
  }
  return Object.freeze({ ...authorization });
}

export function buildSetupDeploymentTransaction(input: {
  readonly claim: SetupWorkerClaim;
  readonly deployerAddress: string;
  readonly deployerNonce: bigint;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly limits: SetupTransactionLimits;
}): SetupDeploymentTransaction {
  const deployerAddress = normalizeAddress(input.deployerAddress, "SETUP_DEPLOYER_INVALID");
  const actors = [input.claim.ownerAddress, input.claim.executorAddress, input.claim.factoryAddress]
    .map((actor) => normalizeAddress(actor, "SETUP_ACTOR_INVALID").toLowerCase());
  if (actors.includes(deployerAddress.toLowerCase())) throw new Error("SETUP_ACTOR_COLLISION");
  assertPositiveLimits(input.limits);
  if (input.deployerNonce < 0n || input.deployerNonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("SETUP_NONCE_INVALID");
  }
  if (input.gasLimit <= 0n || input.gasLimit > input.limits.maxGasLimit) throw new Error("SETUP_GAS_CAP");
  if (input.maxFeePerGas <= 0n || input.maxFeePerGas > input.limits.maxFeePerGas) throw new Error("SETUP_FEE_CAP");
  if (input.maxPriorityFeePerGas <= 0n || input.maxPriorityFeePerGas > input.limits.maxPriorityFeePerGas) {
    throw new Error("SETUP_PRIORITY_FEE_CAP");
  }
  if (input.maxPriorityFeePerGas > input.maxFeePerGas) throw new Error("SETUP_FEE_INVALID");
  if (input.gasLimit * input.maxFeePerGas > input.limits.maxNativeCostWei) throw new Error("SETUP_NATIVE_COST_CAP");

  const authorization = buildSetupAuthorizationFromClaim(input.claim);
  return Object.freeze({
    type: 2 as const,
    chainId: 196n as const,
    from: deployerAddress,
    to: normalizeAddress(input.claim.factoryAddress, "SETUP_FACTORY_INVALID"),
    value: 0n as const,
    nonce: Number(input.deployerNonce),
    gasLimit: input.gasLimit,
    maxFeePerGas: input.maxFeePerGas,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    data: factoryInterface.encodeFunctionData("deployAccount", [authorization, input.claim.ownerSetupSignature]),
  });
}

export async function signSetupDeploymentTransaction(input: {
  readonly transaction: SetupDeploymentTransaction;
  readonly signer: SetupTransactionSigner;
}): Promise<SignedSetupDeploymentTransaction> {
  const signerAddress = normalizeAddress(await input.signer.getAddress(), "SETUP_SIGNER_INVALID");
  if (signerAddress.toLowerCase() !== input.transaction.from.toLowerCase()) {
    throw new Error("SETUP_SIGNER_MISMATCH");
  }
  const rawTransaction = (await input.signer.signTransaction(input.transaction)).toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(rawTransaction)) throw new Error("SETUP_SIGNED_TRANSACTION_INVALID");
  const parsed = Transaction.from(rawTransaction);
  if (
    parsed.chainId !== input.transaction.chainId || parsed.type !== 2 || parsed.nonce !== input.transaction.nonce
    || parsed.to?.toLowerCase() !== input.transaction.to.toLowerCase() || parsed.value !== 0n
    || parsed.data.toLowerCase() !== input.transaction.data.toLowerCase()
    || parsed.gasLimit !== input.transaction.gasLimit || parsed.maxFeePerGas !== input.transaction.maxFeePerGas
    || parsed.maxPriorityFeePerGas !== input.transaction.maxPriorityFeePerGas
    || parsed.from?.toLowerCase() !== signerAddress.toLowerCase()
  ) throw new Error("SETUP_SIGNED_TRANSACTION_MISMATCH");
  return Object.freeze({ rawTransaction, transactionHash: keccak256(rawTransaction).toLowerCase() });
}

export function encryptSetupRawTransaction(
  rawTransaction: string,
  encryptionKey: Uint8Array,
  iv: Uint8Array = randomBytes(12),
): EncryptedSetupTransaction {
  const key = requireEncryptionKey(encryptionKey);
  if (!(iv instanceof Uint8Array) || iv.byteLength !== 12) throw new Error("SETUP_ENCRYPTION_IV_INVALID");
  if (!/^0x[0-9a-fA-F]+$/.test(rawTransaction)) throw new Error("SETUP_RAW_TRANSACTION_INVALID");
  const plaintext = Buffer.from(rawTransaction.toLowerCase(), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Object.freeze({
    ciphertext: ciphertext.toString("base64url"),
    iv: Buffer.from(iv).toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    hash: createHash("sha256").update(plaintext).digest("hex"),
  });
}

export function decryptSetupRawTransaction(
  encrypted: EncryptedSetupTransaction,
  encryptionKey: Uint8Array,
): string {
  const key = requireEncryptionKey(encryptionKey);
  if (!/^[0-9a-f]{64}$/.test(encrypted.hash)) throw new Error("SETUP_OUTBOX_HASH_INVALID");
  try {
    const iv = Buffer.from(encrypted.iv, "base64url");
    const tag = Buffer.from(encrypted.tag, "base64url");
    if (iv.byteLength !== 12 || tag.byteLength !== 16) throw new Error("invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]);
    if (createHash("sha256").update(plaintext).digest("hex") !== encrypted.hash) {
      throw new Error("hash mismatch");
    }
    const rawTransaction = plaintext.toString("utf8");
    if (!/^0x[0-9a-f]+$/.test(rawTransaction)) throw new Error("invalid plaintext");
    return rawTransaction;
  } catch {
    throw new Error("SETUP_OUTBOX_DECRYPT_FAILED");
  }
}

function assertPositiveLimits(limits: SetupTransactionLimits): void {
  if (limits.maxGasLimit <= 0n || limits.maxFeePerGas <= 0n || limits.maxPriorityFeePerGas <= 0n
    || limits.maxNativeCostWei <= 0n) throw new Error("SETUP_LIMITS_INVALID");
}

function normalizeAddress(address: string, code: string): string {
  try {
    return getAddress(address);
  } catch {
    throw new Error(code);
  }
}

function requireEncryptionKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error("SETUP_ENCRYPTION_KEY_INVALID");
  return Buffer.from(key);
}
