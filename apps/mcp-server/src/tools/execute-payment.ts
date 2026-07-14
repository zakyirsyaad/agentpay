import {
  type DirectPaymentAuthorization,
  type ExecutePaymentInput,
  executePaymentInputSchema,
  type PaymentIntentRecord,
  type RoutePaymentAuthorization,
} from "@agentpay-ai/shared";
import { executeAuthorizedPaymentInputSchema, type ExecuteAuthorizedPaymentInput } from "@agentpay-ai/shared";
import {
  createPaymentAuthorizationFromIntent,
  verifyPaymentAuthorizationSignature,
} from "../services/payment-authorization.ts";
import type { InvoiceExecutionOutboxStore } from "../services/paid-execution-outbox.ts";
import type { PaidExecutionLifecycleStore } from "../services/paid-execution-lifecycle.ts";
import { assertProductionExecutionAllowed, type ExecutionMode } from "../runtime/production-readiness.ts";

export interface ExecutePaymentIntentRepository {
  getPaymentIntent(paymentIntentId: string): Promise<PaymentIntentRecord | null>;
  claimPaymentApproval(paymentIntentId: string, approvedAt: string): Promise<boolean>;
  markPaymentExecuting(paymentIntentId: string, sourceTxHash: string, approvedAt: string): Promise<void>;
  markPaymentFailed(paymentIntentId: string, errorCode: string, errorMessage: string): Promise<void>;
  markPaymentExpired(paymentIntentId: string): Promise<void>;
}

export interface TokenBalanceCheckRequest {
  accountAddress: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  requiredAmount: string;
}

export interface TokenBalanceChecker {
  hasSufficientTokenBalance(request: TokenBalanceCheckRequest): Promise<boolean>;
}

export interface DirectPaymentExecutionRequest {
  accountAddress: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  recipientAddress: string;
  amount: string;
  nonce: string;
  deadline: string;
}

export interface RoutePaymentExecutionRequest {
  accountAddress: string;
  sourceChainId: number;
  sourceTokenAddress: string;
  sourceTokenSymbol: string;
  maxAmountIn: string;
  destinationChainId: number;
  recipientAddress: string;
  destinationTokenSymbol: string;
  amountOut: string;
  routeTarget: string;
  routeCalldata: string;
  routeCalldataHash: string;
  maxNativeFee: string;
  nonce: string;
  deadline: string;
}

export interface ContractCallExecutionRequest {
  accountAddress: string;
  chainId: number;
  target: string;
  tokenAddress: string;
  tokenSymbol: string;
  maxTokenSpend: string;
  callData: string;
  callDataHash: string;
  maxNativeFee: string;
  nonce: string;
  deadline: string;
}

export interface AuthorizedDirectPaymentExecutionRequest {
  accountAddress: string;
  chainId: number;
  authorization: DirectPaymentAuthorization;
  signature: string;
  durableExecution?: DurableExecutionContext;
}

export interface AuthorizedRoutePaymentExecutionRequest {
  accountAddress: string;
  sourceChainId: number;
  authorization: RoutePaymentAuthorization;
  routeCalldata: string;
  nativeValue: string;
  signature: string;
  durableExecution?: DurableExecutionContext;
}

/**
 * Request-scoped information required to make a paid invoice execution
 * durable. The context is created and its outbox is reserved before the x402
 * fee is settled; it is never accepted from an MCP caller.
 */
export interface DurableExecutionContext {
  readonly lifecycleId: string;
  readonly outboxId: string;
  readonly tenantId: string;
  readonly paymentIntentId: string;
  readonly executorAddress: string;
  readonly ownerAuthorizationNonce: string;
  readonly rawTxEncryptionKey: string;
  readonly outbox: InvoiceExecutionOutboxStore;
  readonly lifecycle: PaidExecutionLifecycleStore;
  readonly now: () => string;
}

export class DurableExecutionError extends Error {
  readonly code = "DURABLE_EXECUTION_AMBIGUOUS";
  constructor(message: string, readonly ambiguous = true) {
    super(message);
    this.name = "DurableExecutionError";
  }
}

export interface RoutePaymentExecutionResult {
  sourceTxHash: string;
}

export interface PaymentExecutor {
  executeDirectPayment(request: DirectPaymentExecutionRequest): Promise<RoutePaymentExecutionResult>;
  executeRoutePayment(request: RoutePaymentExecutionRequest): Promise<RoutePaymentExecutionResult>;
  executeContractCall(request: ContractCallExecutionRequest): Promise<RoutePaymentExecutionResult>;
}

export interface AuthorizedPaymentExecutor {
  executeAuthorizedDirectPayment(request: AuthorizedDirectPaymentExecutionRequest): Promise<RoutePaymentExecutionResult>;
  executeAuthorizedRoutePayment(request: AuthorizedRoutePaymentExecutionRequest): Promise<RoutePaymentExecutionResult>;
}

export interface ExecutePaymentDependencies {
  paymentIntents: ExecutePaymentIntentRepository;
  balances: TokenBalanceChecker;
  executor: PaymentExecutor;
  authorizedExecutor?: AuthorizedPaymentExecutor;
  clock: () => Date;
  executionPolicy?: PaymentExecutionPolicy;
}

export interface PaymentPreflightResult {
  paymentIntentId: string;
  intent: PaymentIntentRecord;
  input: ExecutePaymentInput;
}

export interface ExecuteAuthorizedPaymentDependencies {
  paymentIntents: ExecutePaymentIntentRepository;
  balances: TokenBalanceChecker;
  authorizedExecutor?: AuthorizedPaymentExecutor;
  clock: () => Date;
  executionPolicy?: PaymentExecutionPolicy;
}

export interface PaymentExecutionPolicy {
  environment?: "staging" | "production";
  mode?: ExecutionMode;
  directMainnetOnly?: boolean;
}

export interface ExecutePaymentOutput {
  paymentIntentId: string;
  status: "EXECUTING";
  sourceTxHash: string;
  message: "Payment execution started.";
}

/**
 * Validate a signed execution request without claiming the payment intent or
 * broadcasting a transaction. Public paid execution calls this before x402
 * can issue a challenge, so malformed or unauthorized requests never become
 * billable.
 */
export async function preflightPayment(
  rawInput: ExecutePaymentInput,
  dependencies: ExecuteAuthorizedPaymentDependencies,
): Promise<PaymentPreflightResult> {
  const input = executePaymentInputSchema.parse(rawInput);
  if (!input.signature) {
    throw new Error("Owner EIP-712 payment authorization is required for paid execution.");
  }

  const intent = await dependencies.paymentIntents.getPaymentIntent(input.paymentIntentId);
  if (!intent) {
    throw new Error(`Payment intent ${input.paymentIntentId} was not found.`);
  }
  if (dependencies.executionPolicy) {
    assertProductionExecutionAllowed(
      {
        environment: dependencies.executionPolicy.environment,
        mode: dependencies.executionPolicy.mode ?? "OFF",
        directMainnetOnly: dependencies.executionPolicy.directMainnetOnly,
      },
      intent,
    );
  }
  if (intent.status !== "AWAITING_APPROVAL") {
    throw new Error(`Payment intent ${intent.id} is ${intent.status}, not AWAITING_APPROVAL.`);
  }
  if (new Date(intent.deadline).getTime() <= dependencies.clock().getTime()) {
    throw new Error(`Payment intent ${intent.id} expired.`);
  }
  if (!dependencies.authorizedExecutor || !intent.tenantId) {
    throw new Error("AgentPayAccountV2 authorized execution is not configured for this payment.");
  }

  const typedData = createPaymentAuthorizationFromIntent(intent, intent.tenantId);
  if (!verifyPaymentAuthorizationSignature({ typedData, signature: input.signature, expectedOwner: intent.ownerAddress })) {
    throw new Error("Owner payment authorization signature is invalid.");
  }

  const hasBalance = await dependencies.balances.hasSufficientTokenBalance({
    accountAddress: intent.accountAddress,
    chainId: intent.sourceChainId,
    tokenAddress: intent.sourceTokenAddress,
    tokenSymbol: intent.sourceTokenSymbol,
    requiredAmount: intent.maxAmountIn,
  });
  if (!hasBalance) {
    throw new Error(`Insufficient balance for payment intent ${intent.id}.`);
  }

  return { paymentIntentId: intent.id, intent, input };
}

export async function executePayment(
  rawInput: ExecutePaymentInput,
  dependencies: ExecutePaymentDependencies,
  durableExecution?: DurableExecutionContext,
): Promise<ExecutePaymentOutput> {
  const input = executePaymentInputSchema.parse(rawInput);

  if (input.signature) {
    return executeAuthorizedPayment(
      {
        paymentIntentId: input.paymentIntentId,
        signature: input.signature,
      },
      dependencies,
      durableExecution,
    );
  }

  const intent = await dependencies.paymentIntents.getPaymentIntent(input.paymentIntentId);

  if (!intent) {
    throw new Error(`Payment intent ${input.paymentIntentId} was not found.`);
  }

  if (dependencies.executionPolicy) {
    assertProductionExecutionAllowed(
      {
        environment: dependencies.executionPolicy.environment,
        mode: dependencies.executionPolicy.mode ?? "OFF",
        directMainnetOnly: dependencies.executionPolicy.directMainnetOnly,
      },
      intent,
    );
  }

  if (intent.status !== "AWAITING_APPROVAL") {
    throw new Error(`Payment intent ${intent.id} is ${intent.status}, not AWAITING_APPROVAL.`);
  }

  const now = dependencies.clock();
  if (new Date(intent.deadline).getTime() <= now.getTime()) {
    await dependencies.paymentIntents.markPaymentExpired(intent.id);
    throw new Error(`Payment intent ${intent.id} expired.`);
  }

  if (input.approvalText !== intent.approvalPhrase) {
    throw new Error("Approval text does not exactly match the required phrase.");
  }

  const hasBalance = await dependencies.balances.hasSufficientTokenBalance({
    accountAddress: intent.accountAddress,
    chainId: intent.sourceChainId,
    tokenAddress: intent.sourceTokenAddress,
    tokenSymbol: intent.sourceTokenSymbol,
    requiredAmount: intent.maxAmountIn,
  });

  if (!hasBalance) {
    const message = `Insufficient balance for payment intent ${intent.id}.`;
    await dependencies.paymentIntents.markPaymentFailed(intent.id, "INSUFFICIENT_BALANCE", message);
    throw new Error(message);
  }

  const approvedAt = now.toISOString();
  const claimed = await dependencies.paymentIntents.claimPaymentApproval(intent.id, approvedAt);

  if (!claimed) {
    throw new Error(`Payment intent ${intent.id} is already being executed or is no longer awaiting approval.`);
  }

  try {
    const execution = await executeStoredIntent(intent, dependencies.executor);

    try {
      await dependencies.paymentIntents.markPaymentExecuting(intent.id, execution.sourceTxHash, approvedAt);
    } catch (error) {
      if (durableExecution) {
        throw new DurableExecutionError(
          `The transaction was submitted but payment intent persistence is unknown: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
      throw error;
    }

    return {
      paymentIntentId: intent.id,
      status: "EXECUTING",
      sourceTxHash: execution.sourceTxHash,
      message: "Payment execution started.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown execution failure.";
    if (!(error instanceof DurableExecutionError && error.ambiguous)) {
      await dependencies.paymentIntents.markPaymentFailed(intent.id, "EXECUTION_FAILED", message);
    }
    throw error;
  }
}

export async function executeAuthorizedPayment(
  rawInput: ExecuteAuthorizedPaymentInput,
  dependencies: ExecuteAuthorizedPaymentDependencies,
  durableExecution?: DurableExecutionContext,
): Promise<ExecutePaymentOutput> {
  const input = executeAuthorizedPaymentInputSchema.parse(rawInput);
  const intent = await dependencies.paymentIntents.getPaymentIntent(input.paymentIntentId);

  if (!intent) {
    throw new Error(`Payment intent ${input.paymentIntentId} was not found.`);
  }
  if (dependencies.executionPolicy) {
    assertProductionExecutionAllowed(
      {
        environment: dependencies.executionPolicy.environment,
        mode: dependencies.executionPolicy.mode ?? "OFF",
        directMainnetOnly: dependencies.executionPolicy.directMainnetOnly,
      },
      intent,
    );
  }
  if (intent.status !== "AWAITING_APPROVAL") {
    throw new Error(`Payment intent ${intent.id} is ${intent.status}, not AWAITING_APPROVAL.`);
  }
  if (!dependencies.authorizedExecutor) {
    throw new Error("AgentPayAccountV2 authorized executor is not configured.");
  }

  const now = dependencies.clock();
  if (new Date(intent.deadline).getTime() <= now.getTime()) {
    await dependencies.paymentIntents.markPaymentExpired(intent.id);
    throw new Error(`Payment intent ${intent.id} expired.`);
  }

  if (!intent.tenantId) {
    throw new Error("Payment intent is missing its trusted tenant binding.");
  }
  if (
    durableExecution &&
    (durableExecution.paymentIntentId !== intent.id || durableExecution.tenantId !== intent.tenantId)
  ) {
    throw new Error("Durable execution context does not match the payment intent tenant binding.");
  }

  const typedData = createPaymentAuthorizationFromIntent(intent, intent.tenantId);
  if (!verifyPaymentAuthorizationSignature({ typedData, signature: input.signature, expectedOwner: intent.ownerAddress })) {
    throw new Error("Owner payment authorization signature is invalid.");
  }

  const hasBalance = await dependencies.balances.hasSufficientTokenBalance({
    accountAddress: intent.accountAddress,
    chainId: intent.sourceChainId,
    tokenAddress: intent.sourceTokenAddress,
    tokenSymbol: intent.sourceTokenSymbol,
    requiredAmount: intent.maxAmountIn,
  });
  if (!hasBalance) {
    const message = `Insufficient balance for payment intent ${intent.id}.`;
    await dependencies.paymentIntents.markPaymentFailed(intent.id, "INSUFFICIENT_BALANCE", message);
    throw new Error(message);
  }

  const approvedAt = now.toISOString();
  const claimed = await dependencies.paymentIntents.claimPaymentApproval(intent.id, approvedAt);
  if (!claimed) {
    throw new Error(`Payment intent ${intent.id} is already being executed or is no longer awaiting approval.`);
  }

  try {
    const execution = typedData.primaryType === "DirectPaymentAuthorization"
      ? await dependencies.authorizedExecutor.executeAuthorizedDirectPayment({
          accountAddress: intent.accountAddress,
          chainId: intent.sourceChainId,
          authorization: typedData.message as DirectPaymentAuthorization,
          signature: input.signature,
          durableExecution,
        })
      : await dependencies.authorizedExecutor.executeAuthorizedRoutePayment({
          accountAddress: intent.accountAddress,
          sourceChainId: intent.sourceChainId,
          authorization: typedData.message as RoutePaymentAuthorization,
          routeCalldata: intent.routeCalldata,
          nativeValue: intent.nativeValue ?? "",
          signature: input.signature,
          durableExecution,
        });

    try {
      await dependencies.paymentIntents.markPaymentExecuting(intent.id, execution.sourceTxHash, approvedAt);
    } catch (error) {
      if (durableExecution) {
        throw new DurableExecutionError(
          `The transaction was submitted but payment intent persistence is unknown: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
      throw error;
    }
    return {
      paymentIntentId: intent.id,
      status: "EXECUTING",
      sourceTxHash: execution.sourceTxHash,
      message: "Payment execution started.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown execution failure.";
    if (!(error instanceof DurableExecutionError && error.ambiguous)) {
      await dependencies.paymentIntents.markPaymentFailed(intent.id, "EXECUTION_FAILED", message);
    }
    throw error;
  }
}

async function executeStoredIntent(intent: PaymentIntentRecord, executor: PaymentExecutor): Promise<RoutePaymentExecutionResult> {
  if (intent.routeProvider === "DIRECT") {
    return executor.executeDirectPayment({
      accountAddress: intent.accountAddress,
      chainId: intent.sourceChainId,
      tokenAddress: intent.sourceTokenAddress,
      tokenSymbol: intent.sourceTokenSymbol,
      recipientAddress: intent.recipientAddress,
      amount: intent.amountOut,
      nonce: intent.nonce,
      deadline: intent.deadline,
    });
  }

  if (intent.routeProvider === "CONTRACT_CALL") {
    return executor.executeContractCall({
      accountAddress: intent.accountAddress,
      chainId: intent.sourceChainId,
      target: intent.routeTarget,
      tokenAddress: intent.sourceTokenAddress,
      tokenSymbol: intent.sourceTokenSymbol,
      maxTokenSpend: intent.maxAmountIn,
      callData: intent.routeCalldata,
      callDataHash: intent.routeCalldataHash,
      maxNativeFee: intent.maxNativeFee,
      nonce: intent.nonce,
      deadline: intent.deadline,
    });
  }

  return executor.executeRoutePayment({
    accountAddress: intent.accountAddress,
    sourceChainId: intent.sourceChainId,
    sourceTokenAddress: intent.sourceTokenAddress,
    sourceTokenSymbol: intent.sourceTokenSymbol,
    maxAmountIn: intent.maxAmountIn,
    destinationChainId: intent.destinationChainId,
    recipientAddress: intent.recipientAddress,
    destinationTokenSymbol: intent.destinationTokenSymbol,
    amountOut: intent.amountOut,
    routeTarget: intent.routeTarget,
    routeCalldata: intent.routeCalldata,
    routeCalldataHash: intent.routeCalldataHash,
    maxNativeFee: intent.maxNativeFee,
    nonce: intent.nonce,
    deadline: intent.deadline,
  });
}

export const executePaymentTool = {
  name: "execute_payment",
  description: "Execute a prepared AgentPay payment with an owner EIP-712 signature (legacy approval text is migration-only).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["paymentIntentId"],
    properties: {
      paymentIntentId: { type: "string" },
      approvalText: { type: "string" },
      signature: { type: "string", pattern: "^0x[a-fA-F0-9]{130}$" },
    },
  },
} as const;

export function createExecutePaymentHandler(dependencies: ExecutePaymentDependencies) {
  return (input: ExecutePaymentInput) => executePayment(input, dependencies);
}

export function createExecutePaymentWithDurableContextHandler(dependencies: ExecutePaymentDependencies) {
  return (input: ExecutePaymentInput, durableExecution: DurableExecutionContext) =>
    executePayment(input, dependencies, durableExecution);
}

export function createPreflightPaymentHandler(dependencies: ExecuteAuthorizedPaymentDependencies) {
  return (input: ExecutePaymentInput) => preflightPayment(input, dependencies);
}

export function createExecuteAuthorizedPaymentHandler(dependencies: ExecuteAuthorizedPaymentDependencies) {
  return (input: ExecuteAuthorizedPaymentInput) => executeAuthorizedPayment(input, dependencies);
}
