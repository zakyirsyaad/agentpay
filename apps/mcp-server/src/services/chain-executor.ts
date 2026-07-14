import { AbiCoder, Interface, JsonRpcProvider, Wallet, keccak256 } from "ethers";
import { getStableTokenDecimalsForChain } from "@agentpay-ai/shared";

import type {
  ContractCallExecutionRequest,
  AuthorizedDirectPaymentExecutionRequest,
  AuthorizedPaymentExecutor,
  AuthorizedRoutePaymentExecutionRequest,
  DirectPaymentExecutionRequest,
  PaymentExecutor,
  RoutePaymentExecutionRequest,
  RoutePaymentExecutionResult,
  TokenBalanceChecker,
  TokenBalanceCheckRequest,
  DurableExecutionContext,
} from "../tools/execute-payment.ts";
import { DurableExecutionError } from "../tools/execute-payment.ts";
import { encryptRawTransaction } from "./paid-execution-outbox.ts";
import type {
  NativeBalanceReader,
  NativeBalanceReadRequest,
  TokenBalanceReader,
  TokenBalanceReadRequest,
  TokenBalanceReadResult,
} from "../tools/get-balance.ts";
import type {
  SourceTransactionStatusProvider,
  SourceTransactionStatusRequest,
  SourceTransactionStatusResult,
} from "../tools/payment-tracking.ts";
import type {
  RouteTargetAllowanceChecker,
  RouteTargetAllowanceCheckRequest,
} from "../tools/route-target-allowance.ts";

export const agentPayAccountInterface = new Interface([
  "function allowedRouteTargets(address target) view returns (bool)",
  "function executeContractCall((address target,address token,uint256 maxTokenSpend,bytes32 callDataHash,uint256 maxNativeFee,uint256 nonce,uint256 deadline),bytes callData)",
  "function executeDirectPayment((address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline))",
  "function executeRoutePayment((address sourceToken,uint256 maxAmountIn,uint256 destinationChainId,address recipient,uint256 amountOut,address routeTarget,bytes32 routeCalldataHash,uint256 maxNativeFee,uint256 nonce,uint256 deadline),bytes routeCalldata)",
]);

/** ABI for AgentPayAccountV2. The legacy interface above is retained for migration-only adapters. */
export const agentPayAccountV2Interface = new Interface([
  "function allowedRouteTargets(address target) view returns (bool)",
  "function executeAuthorizedDirectPayment((bytes32 intentIdHash,bytes32 tenantIdHash,bytes32 paymentType,address owner,address account,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline,bytes32 purposeHash),bytes signature)",
  "function executeAuthorizedRoutePayment((bytes32 intentIdHash,bytes32 tenantIdHash,bytes32 paymentType,address owner,address account,address sourceToken,uint256 maxAmountIn,uint256 destinationChainId,address destinationToken,address recipient,uint256 minAmountOut,address routeTarget,bytes32 routeCalldataHash,uint256 maxNativeFee,uint256 nonce,uint256 deadline,bytes32 purposeHash),bytes routeCalldata,bytes signature)",
]);

export const erc20Interface = new Interface(["function balanceOf(address account) view returns (uint256)"]);

export interface TransactionSender {
  sendTransaction(transaction: { to: string; data: string; value: bigint }, chainId?: number): Promise<{ hash: string }>;
  prepareAndSignTransaction?(
    transaction: { to: string; data: string; value: bigint },
    chainId?: number,
  ): Promise<PreparedSignedTransaction>;
  broadcastSignedTransaction?(rawTransaction: string, chainId?: number): Promise<{ hash: string }>;
}

export interface PreparedSignedTransaction {
  rawTransaction: string;
  transactionHash: string;
  executorNonce: string;
  chainId: number;
  from: string;
  to: string;
  data: string;
  value: string;
}

export interface RpcCaller {
  call(transaction: { to: string; data: string }, chainId?: number): Promise<string>;
}

export interface NativeBalanceCaller {
  getBalance(accountAddress: string, chainId?: number): Promise<bigint>;
}

export interface TransactionReceiptCaller {
  getTransactionReceipt(txHash: string, chainId?: number): Promise<{ status: number | bigint | null } | null>;
}

export interface EthersRuntimeConfig {
  rpcUrl: string;
  rpcUrls?: Partial<Record<number, string>>;
  executorPrivateKey: string;
}

export function createEthersRoutePaymentExecutor(sender: TransactionSender): PaymentExecutor {
  return {
    async executeDirectPayment(request: DirectPaymentExecutionRequest): Promise<RoutePaymentExecutionResult> {
      const transaction = await sender.sendTransaction({
        to: request.accountAddress,
        data: encodeExecuteDirectPaymentCalldata(request),
        value: 0n,
      }, request.chainId);

      return { sourceTxHash: transaction.hash };
    },
    async executeRoutePayment(request: RoutePaymentExecutionRequest): Promise<RoutePaymentExecutionResult> {
      const transaction = await sender.sendTransaction({
        to: request.accountAddress,
        data: encodeExecuteRoutePaymentCalldata(request),
        value: BigInt(request.maxNativeFee),
      }, request.sourceChainId);

      return { sourceTxHash: transaction.hash };
    },
    async executeContractCall(request: ContractCallExecutionRequest): Promise<RoutePaymentExecutionResult> {
      const transaction = await sender.sendTransaction({
        to: request.accountAddress,
        data: encodeExecuteContractCallCalldata(request),
        value: BigInt(request.maxNativeFee),
      }, request.chainId);

      return { sourceTxHash: transaction.hash };
    },
  };
}

export function createEthersAuthorizedPaymentExecutor(sender: TransactionSender): AuthorizedPaymentExecutor {
  return {
    async executeAuthorizedDirectPayment(
      request: AuthorizedDirectPaymentExecutionRequest,
    ): Promise<RoutePaymentExecutionResult> {
      assertAuthorizationNonceBinding(request.durableExecution, request.authorization.nonce);
      const transaction = await sendAuthorizedTransaction(
        sender,
        {
          to: request.accountAddress,
          data: encodeExecuteAuthorizedDirectPaymentCalldata(request),
          value: 0n,
        },
        request.chainId,
        request.durableExecution,
      );

      return { sourceTxHash: transaction.hash };
    },
    async executeAuthorizedRoutePayment(
      request: AuthorizedRoutePaymentExecutionRequest,
    ): Promise<RoutePaymentExecutionResult> {
      assertAuthorizationNonceBinding(request.durableExecution, request.authorization.nonce);
      const transaction = await sendAuthorizedTransaction(
        sender,
        {
          to: request.accountAddress,
          data: encodeExecuteAuthorizedRoutePaymentCalldata(request),
          value: boundedNativeValue(request.nativeValue, request.authorization.maxNativeFee),
        },
        request.sourceChainId,
        request.durableExecution,
      );

      return { sourceTxHash: transaction.hash };
    },
  };
}

async function sendAuthorizedTransaction(
  sender: TransactionSender,
  transaction: { to: string; data: string; value: bigint },
  chainId: number,
  durableExecution?: DurableExecutionContext,
): Promise<{ hash: string }> {
  if (!durableExecution) {
    return sender.sendTransaction(transaction, chainId);
  }

  if (!sender.prepareAndSignTransaction || !sender.broadcastSignedTransaction) {
    throw new Error("Durable paid execution requires a sign-before-broadcast transaction sender.");
  }

  const queued = await durableExecution.outbox.enqueue({
    id: durableExecution.outboxId,
    tenantId: durableExecution.tenantId,
    lifecycleId: durableExecution.lifecycleId,
    paymentIntentId: durableExecution.paymentIntentId,
    chainId,
    executorAddress: durableExecution.executorAddress,
    createdAt: durableExecution.now(),
  });
  if (queued.disposition === "CONFLICT") {
    throw new Error("Invoice execution outbox conflicts with an existing lifecycle.");
  }

  const existing = queued.record;
  assertOutboxBinding(existing, durableExecution, chainId);
  if (queued.disposition === "REPLAY") {
    if (["BROADCASTED", "CONFIRMED"].includes(existing.status) && existing.transactionHash) {
      return { hash: existing.transactionHash };
    }
    if (existing.status === "BROADCAST_UNKNOWN" && existing.transactionHash) {
      throw new Error("Invoice execution broadcast is unknown; reconciliation is required before retry.");
    }
    if (existing.status !== "QUEUED") {
      throw new Error(`Invoice execution outbox cannot resume from ${existing.status}.`);
    }
  }

  const prepared = await sender.prepareAndSignTransaction(transaction, chainId);
  assertPreparedTransactionBinding(prepared, transaction, chainId, durableExecution);
  const preparedRecord = await durableExecution.outbox.prepare(existing.id, {
    executorNonce: prepared.executorNonce,
    transactionHash: prepared.transactionHash,
    calldataHash: keccak256(transaction.data),
    ownerAuthorizationNonce: durableExecution.ownerAuthorizationNonce,
    rawTransaction: encryptRawTransaction(prepared.rawTransaction, durableExecution.rawTxEncryptionKey),
    at: durableExecution.now(),
  });
  const broadcastUnknownRecord = await durableExecution.outbox.markBroadcastUnknown(
    preparedRecord.id,
    durableExecution.now(),
    preparedRecord.fencingToken,
  );

  let broadcast: { hash: string };
  try {
    broadcast = await sender.broadcastSignedTransaction(prepared.rawTransaction, chainId);
  } catch (error) {
    throw new DurableExecutionError(
      `Transaction broadcast outcome is unknown: ${error instanceof Error ? error.message : "unknown RPC error"}`,
    );
  }

  try {
    await durableExecution.outbox.markBroadcasted(
      broadcastUnknownRecord.id,
      broadcast.hash,
      durableExecution.now(),
      broadcastUnknownRecord.fencingToken,
    );
  } catch (error) {
    throw new DurableExecutionError(
      `Transaction was submitted but outbox broadcast persistence is unknown: ${error instanceof Error ? error.message : "unknown persistence error"}`,
    );
  }

  try {
    await durableExecution.lifecycle.markExecutionBroadcasted(
      durableExecution.lifecycleId,
      broadcast.hash,
      durableExecution.now(),
    );
  } catch (error) {
    throw new DurableExecutionError(
      `Transaction was submitted but lifecycle broadcast persistence is unknown: ${error instanceof Error ? error.message : "unknown persistence error"}`,
    );
  }
  return broadcast;
}

function assertOutboxBinding(
  record: { tenantId: string; lifecycleId: string; paymentIntentId: string; chainId: number; executorAddress: string },
  context: DurableExecutionContext,
  chainId: number,
): void {
  if (
    record.tenantId !== context.tenantId ||
    record.lifecycleId !== context.lifecycleId ||
    record.paymentIntentId !== context.paymentIntentId ||
    record.chainId !== chainId ||
    record.executorAddress.toLowerCase() !== context.executorAddress.toLowerCase()
  ) {
    throw new Error("Invoice execution outbox binding does not match the request-scoped execution context.");
  }
}

function assertPreparedTransactionBinding(
  prepared: PreparedSignedTransaction,
  transaction: { to: string; data: string; value: bigint },
  chainId: number,
  context: DurableExecutionContext,
): void {
  if (keccak256(prepared.rawTransaction).toLowerCase() !== prepared.transactionHash.toLowerCase()) {
    throw new Error("Signed transaction hash does not match its raw transaction bytes.");
  }
  if (prepared.chainId !== chainId || prepared.from.toLowerCase() !== context.executorAddress.toLowerCase()) {
    throw new Error("Signed transaction chain or executor binding does not match the durable execution context.");
  }
  if (
    prepared.to.toLowerCase() !== transaction.to.toLowerCase() ||
    prepared.data.toLowerCase() !== transaction.data.toLowerCase() ||
    BigInt(prepared.value) !== transaction.value
  ) {
    throw new Error("Signed transaction payload does not match the authorized payment request.");
  }
}

function assertAuthorizationNonceBinding(context: DurableExecutionContext | undefined, nonce: bigint | string | number): void {
  if (context && String(nonce) !== context.ownerAuthorizationNonce) {
    throw new Error("Authorized payment nonce does not match the durable execution context.");
  }
}

function boundedNativeValue(nativeValue: string, maxNativeFee: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/.test(nativeValue)) {
    throw new Error("Route native value must be a non-negative decimal integer.");
  }
  const value = BigInt(nativeValue);
  const cap = BigInt(maxNativeFee);
  if (value > cap) {
    throw new Error("Route native value exceeds the signed native fee cap.");
  }
  return value;
}

export function createEthersTokenBalanceChecker(caller: RpcCaller): TokenBalanceChecker {
  return {
    async hasSufficientTokenBalance(request: TokenBalanceCheckRequest): Promise<boolean> {
      const balanceData = await caller.call({
        to: request.tokenAddress,
        data: erc20Interface.encodeFunctionData("balanceOf", [request.accountAddress]),
      }, request.chainId);
      const [balance] = AbiCoder.defaultAbiCoder().decode(["uint256"], balanceData);
      return (
        BigInt(balance) >=
        decimalToAtomic(request.requiredAmount, getStableTokenDecimalsForChain(request.chainId, request.tokenSymbol))
      );
    },
  };
}

export function createEthersSourceTransactionStatusProvider(
  caller: TransactionReceiptCaller,
): SourceTransactionStatusProvider {
  return {
    async getSourceTransactionStatus(
      request: SourceTransactionStatusRequest,
    ): Promise<SourceTransactionStatusResult> {
      const receipt = await caller.getTransactionReceipt(request.txHash, request.chainId);

      if (!receipt || receipt.status === null) {
        return { status: "PENDING" };
      }

      return Number(receipt.status) === 1 ? { status: "SUCCESS" } : { status: "FAILED" };
    },
  };
}

export function createEthersRouteTargetAllowanceChecker(caller: RpcCaller): RouteTargetAllowanceChecker {
  return {
    async isRouteTargetAllowed(request: RouteTargetAllowanceCheckRequest): Promise<boolean> {
      const allowedData = await caller.call({
        to: request.accountAddress,
        data: agentPayAccountInterface.encodeFunctionData("allowedRouteTargets", [request.routeTarget]),
      }, request.chainId);
      const [allowed] = AbiCoder.defaultAbiCoder().decode(["bool"], allowedData);
      return Boolean(allowed);
    },
  };
}

export function createEthersTokenBalanceReader(caller: RpcCaller): TokenBalanceReader {
  return {
    async getTokenBalance(request: TokenBalanceReadRequest): Promise<TokenBalanceReadResult> {
      const balanceData = await caller.call({
        to: request.tokenAddress,
        data: erc20Interface.encodeFunctionData("balanceOf", [request.accountAddress]),
      }, request.chainId);
      const [balance] = AbiCoder.defaultAbiCoder().decode(["uint256"], balanceData);
      return {
        amount: atomicToDecimal(BigInt(balance), request.decimals),
      };
    },
  };
}

export function createEthersNativeBalanceReader(caller: NativeBalanceCaller): NativeBalanceReader {
  return {
    async getNativeBalance(request: NativeBalanceReadRequest): Promise<TokenBalanceReadResult> {
      const balance = await caller.getBalance(request.accountAddress, request.chainId);
      return {
        amount: atomicToDecimal(balance, request.decimals),
      };
    },
  };
}

export function createEthersRuntimeAdapters(config: EthersRuntimeConfig): {
  executor: PaymentExecutor;
  authorizedExecutor: AuthorizedPaymentExecutor;
  balances: TokenBalanceChecker;
  sourceTransactions: SourceTransactionStatusProvider;
  tokenBalances: TokenBalanceReader;
  nativeBalances: NativeBalanceReader;
  routeTargetAllowances: RouteTargetAllowanceChecker;
} {
  const providerRouter = createProviderRouter(config);
  const sender: TransactionSender = {
    async sendTransaction(transaction, chainId) {
      const provider = providerRouter.getProvider(chainId);
      if (chainId !== undefined) {
        const network = await provider.getNetwork();
        assertExecutorRpcChain(chainId, Number(network.chainId));
      }
      const wallet = new Wallet(config.executorPrivateKey, provider);
      return wallet.sendTransaction(transaction);
    },
    async prepareAndSignTransaction(transaction, chainId) {
      const provider = providerRouter.getProvider(chainId);
      if (chainId !== undefined) {
        const network = await provider.getNetwork();
        assertExecutorRpcChain(chainId, Number(network.chainId));
      }
      const wallet = new Wallet(config.executorPrivateKey, provider);
      const populated = await wallet.populateTransaction({ ...transaction, chainId });
      const rawTransaction = await wallet.signTransaction(populated);
      if (populated.nonce === undefined) throw new Error("Signed transaction nonce was not populated.");
      if (populated.to === null || populated.to === undefined || populated.data === null || populated.data === undefined || populated.value === undefined) {
        throw new Error("Signed transaction payload was not fully populated.");
      }
      return {
        rawTransaction,
        transactionHash: keccak256(rawTransaction),
        executorNonce: String(populated.nonce),
        chainId: Number(populated.chainId ?? chainId),
        from: populated.from ?? wallet.address,
        to: populated.to,
        data: populated.data,
        value: String(populated.value),
      };
    },
    async broadcastSignedTransaction(rawTransaction, chainId) {
      const provider = providerRouter.getProvider(chainId);
      if (chainId !== undefined) {
        const network = await provider.getNetwork();
        assertExecutorRpcChain(chainId, Number(network.chainId));
      }
      const transaction = await provider.broadcastTransaction(rawTransaction);
      return { hash: transaction.hash };
    },
  };

  return {
    executor: createEthersRoutePaymentExecutor(sender),
    authorizedExecutor: createEthersAuthorizedPaymentExecutor(sender),
    balances: createEthersTokenBalanceChecker(providerRouter),
    sourceTransactions: createEthersSourceTransactionStatusProvider(providerRouter),
    tokenBalances: createEthersTokenBalanceReader(providerRouter),
    nativeBalances: createEthersNativeBalanceReader(providerRouter),
    routeTargetAllowances: createEthersRouteTargetAllowanceChecker(providerRouter),
  };
}

export function assertExecutorRpcChain(expectedChainId: number, actualChainId: number): void {
  if (expectedChainId !== actualChainId) {
    throw new Error(`Executor RPC chain mismatch: expected ${expectedChainId}, received ${actualChainId}.`);
  }
}

export function resolveRpcUrlForChain(config: Pick<EthersRuntimeConfig, "rpcUrl" | "rpcUrls">, chainId?: number): string {
  return chainId !== undefined ? config.rpcUrls?.[chainId] ?? config.rpcUrl : config.rpcUrl;
}

function createProviderRouter(config: EthersRuntimeConfig): RpcCaller & NativeBalanceCaller & TransactionReceiptCaller & {
  getProvider(chainId?: number): JsonRpcProvider;
} {
  const providers = new Map<string, JsonRpcProvider>();

  function getProvider(chainId?: number): JsonRpcProvider {
    const rpcUrl = resolveRpcUrlForChain(config, chainId);
    const cacheKey = `${chainId ?? "default"}:${rpcUrl}`;
    const existing = providers.get(cacheKey);

    if (existing) {
      return existing;
    }

    const provider = new JsonRpcProvider(rpcUrl);
    providers.set(cacheKey, provider);
    return provider;
  }

  async function getCheckedProvider(chainId?: number): Promise<JsonRpcProvider> {
    const provider = getProvider(chainId);
    if (chainId !== undefined) {
      const network = await provider.getNetwork();
      assertExecutorRpcChain(chainId, Number(network.chainId));
    }
    return provider;
  }

  return {
    getProvider,
    async call(transaction, chainId) {
      return (await getCheckedProvider(chainId)).call(transaction);
    },
    async getBalance(accountAddress, chainId) {
      return (await getCheckedProvider(chainId)).getBalance(accountAddress);
    },
    async getTransactionReceipt(txHash, chainId) {
      return (await getCheckedProvider(chainId)).getTransactionReceipt(txHash);
    },
  };
}

export function encodeExecuteDirectPaymentCalldata(request: DirectPaymentExecutionRequest): string {
  return agentPayAccountInterface.encodeFunctionData("executeDirectPayment", [
    {
      token: request.tokenAddress,
      recipient: request.recipientAddress,
      amount: decimalToAtomic(request.amount, getStableTokenDecimalsForChain(request.chainId, request.tokenSymbol)),
      nonce: BigInt(request.nonce),
      deadline: isoTimestampToUnixSeconds(request.deadline),
    },
  ]);
}

export function encodeExecuteAuthorizedDirectPaymentCalldata(
  request: AuthorizedDirectPaymentExecutionRequest,
): string {
  return agentPayAccountV2Interface.encodeFunctionData("executeAuthorizedDirectPayment", [
    request.authorization,
    request.signature,
  ]);
}

export function encodeExecuteRoutePaymentCalldata(request: RoutePaymentExecutionRequest): string {
  return agentPayAccountInterface.encodeFunctionData("executeRoutePayment", [
    {
      sourceToken: request.sourceTokenAddress,
      maxAmountIn: decimalToAtomic(
        request.maxAmountIn,
        getStableTokenDecimalsForChain(request.sourceChainId, request.sourceTokenSymbol),
      ),
      destinationChainId: BigInt(request.destinationChainId),
      recipient: request.recipientAddress,
      amountOut: decimalToAtomic(
        request.amountOut,
        getStableTokenDecimalsForChain(request.destinationChainId, request.destinationTokenSymbol),
      ),
      routeTarget: request.routeTarget,
      routeCalldataHash: request.routeCalldataHash,
      maxNativeFee: BigInt(request.maxNativeFee),
      nonce: BigInt(request.nonce),
      deadline: isoTimestampToUnixSeconds(request.deadline),
    },
    request.routeCalldata,
  ]);
}

export function encodeExecuteAuthorizedRoutePaymentCalldata(
  request: AuthorizedRoutePaymentExecutionRequest,
): string {
  return agentPayAccountV2Interface.encodeFunctionData("executeAuthorizedRoutePayment", [
    request.authorization,
    request.routeCalldata,
    request.signature,
  ]);
}

export function encodeExecuteContractCallCalldata(request: ContractCallExecutionRequest): string {
  return agentPayAccountInterface.encodeFunctionData("executeContractCall", [
    {
      target: request.target,
      token: request.tokenAddress,
      maxTokenSpend: decimalToAtomic(
        request.maxTokenSpend,
        getStableTokenDecimalsForChain(request.chainId, request.tokenSymbol),
      ),
      callDataHash: request.callDataHash,
      maxNativeFee: BigInt(request.maxNativeFee),
      nonce: BigInt(request.nonce),
      deadline: isoTimestampToUnixSeconds(request.deadline),
    },
    request.callData,
  ]);
}

function decimalToAtomic(amount: string, decimals: number): bigint {
  const [whole, fractional = ""] = amount.split(".");
  if (!whole || !/^\d+$/.test(whole) || !/^\d*$/.test(fractional) || fractional.length > decimals) {
    throw new Error(`Invalid decimal amount for ${decimals} decimals: ${amount}`);
  }

  return BigInt(`${whole}${fractional.padEnd(decimals, "0")}`);
}

function atomicToDecimal(amount: bigint, decimals: number): string {
  const padded = amount.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fractional = padded.slice(-decimals).replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole;
}

function isoTimestampToUnixSeconds(value: string): bigint {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }

  return BigInt(Math.floor(millis / 1000));
}
