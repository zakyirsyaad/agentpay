import {
  createApprovalInstruction,
  createApprovalPhrase,
  createDirectPaymentRouteQuote,
  formatNativeAmount,
  getChainName,
  isDirectPaymentRoute,
  resolveXLayerHomeChainId,
  type PaymentIntentRecord,
  type PreparePaymentInput,
  preparePaymentInputSchema,
  type RouteProvider,
  type RouteQuote,
} from "@agentpay-ai/shared";
import {
  createPaymentAuthorizationFromIntent,
  hashPaymentAuthorization,
  type PaymentAuthorizationTypedData,
} from "../services/payment-authorization.ts";
import {
  createPaymentReviewToken,
  createPaymentReviewUrl,
  hashPaymentReviewToken,
  type PaymentReviewRepository,
} from "../services/payment-review.ts";

import type { TokenBalanceChecker } from "./execute-payment.ts";

export interface AgentWallet {
  tenantId?: string;
  ownerAddress: string;
  accountAddress: string;
  homeChainId: number;
  executorAddress: string;
  status: "ACTIVE" | "PAUSED" | "CLOSED";
}

export interface AgentWalletRepository {
  getActiveWallet(request?: { homeChainId?: number }): Promise<AgentWallet | null>;
}

export interface RouteQuoteRequest {
  accountAddress: string;
  ownerAddress: string;
  sourceChainId: number;
  destinationChainId: number;
  sourceTokenSymbol: string;
  destinationTokenSymbol: string;
  recipientAddress: string;
  amountOut: string;
  purpose?: string;
}

export interface RouteQuoteProvider {
  quotePaymentRoute(request: RouteQuoteRequest): Promise<RouteQuote>;
}

export interface PaymentIntentRepository {
  createPaymentIntent(intent: PaymentIntentRecord): Promise<void>;
  markPaymentFailed?(paymentIntentId: string, errorCode: string, errorMessage: string): Promise<void>;
}

export interface PreparePaymentDependencies {
  wallets: AgentWalletRepository;
  routes: RouteQuoteProvider;
  balances: TokenBalanceChecker;
  paymentIntents: PaymentIntentRepository;
  clock: () => Date;
  createId: () => string;
  createNonce: () => string;
  homeChainId?: number;
  approvalTtlSeconds?: number;
  tenantId?: string;
  setupWebUrl?: string;
  reviewTokenSecret?: string;
  paymentReviews?: PaymentReviewRepository;
  createReviewToken?: () => string;
}

export interface PreparePaymentOutput {
  paymentIntentId: string;
  status: "AWAITING_APPROVAL";
  approvalPhrase: string;
  summary: {
    pay: string;
    recipientAddress: string;
    destinationChain: string;
    sourceSpend: string;
    routeProvider: RouteProvider;
    routeSummary: string;
    routeTarget: string;
    routeCalldataHash: string;
    requiresRouteTargetAllowlist: boolean;
    estimatedFee: string;
    estimatedEtaSeconds: number;
    deadline: string;
    purpose: string;
    maxNativeFee: string;
    maxNativeFeeDisplay: string;
    minAmountOut?: string;
    nativeValue?: string;
  };
  instructionToAgent: string;
  reviewUrl?: string;
  authorization?: PaymentAuthorizationTypedData;
  authorizationHash?: string;
}

export async function preparePayment(
  rawInput: PreparePaymentInput,
  dependencies: PreparePaymentDependencies,
): Promise<PreparePaymentOutput> {
  const input = preparePaymentInputSchema.parse(rawInput);
  const fallbackHomeChainId = dependencies.homeChainId === 1952 ? 1952 : 196;
  const homeChainId = resolveXLayerHomeChainId(input, fallbackHomeChainId);
  const wallet = await dependencies.wallets.getActiveWallet({ homeChainId });

  if (!wallet || wallet.status !== "ACTIVE") {
    throw new Error("No active AgentPay wallet is available.");
  }
  if (dependencies.tenantId && dependencies.setupWebUrl && !dependencies.paymentReviews) {
    throw new Error("Payment Review & Sign handoff is not configured for this consumer runtime.");
  }

  const quote = isDirectPaymentRoute(
    wallet.homeChainId,
    input.destinationChainId,
    input.sourceTokenSymbol,
    input.destinationTokenSymbol,
  )
    ? createDirectPaymentRouteQuote({
        chainId: wallet.homeChainId,
        tokenSymbol: input.sourceTokenSymbol,
        amountOut: input.amountOut,
      })
    : await dependencies.routes.quotePaymentRoute({
        accountAddress: wallet.accountAddress,
        ownerAddress: wallet.ownerAddress,
        sourceChainId: wallet.homeChainId,
        destinationChainId: input.destinationChainId,
        sourceTokenSymbol: input.sourceTokenSymbol,
        destinationTokenSymbol: input.destinationTokenSymbol,
        recipientAddress: input.recipientAddress,
        amountOut: input.amountOut,
        purpose: input.purpose,
      });

  await assertSufficientSourceTokenBalance({
    balances: dependencies.balances,
    wallet,
    tokenAddress: quote.sourceTokenAddress,
    tokenSymbol: input.sourceTokenSymbol,
    requiredAmount: quote.maxAmountIn,
  });

  const paymentIntentId = dependencies.createId();
  const approvalPhrase = createApprovalPhrase(paymentIntentId);
  const approvalTtlSeconds = Math.min(
    dependencies.approvalTtlSeconds ?? 900,
    quote.routeProvider === "DIRECT" ? 900 : 300,
  );
  const deadline = new Date(dependencies.clock().getTime() + approvalTtlSeconds * 1000).toISOString();

  const intent: PaymentIntentRecord = {
    id: paymentIntentId,
    ...(dependencies.tenantId ? { tenantId: dependencies.tenantId } : {}),
    accountAddress: wallet.accountAddress,
    ownerAddress: wallet.ownerAddress,
    status: "AWAITING_APPROVAL",
    paymentType: input.paymentType,
    sourceChainId: wallet.homeChainId,
    destinationChainId: input.destinationChainId,
    sourceTokenAddress: quote.sourceTokenAddress,
    sourceTokenSymbol: input.sourceTokenSymbol,
    destinationTokenAddress: quote.destinationTokenAddress,
    destinationTokenSymbol: input.destinationTokenSymbol,
    recipientAddress: input.recipientAddress,
    amountOut: input.amountOut,
    ...(quote.minAmountOut ? { minAmountOut: quote.minAmountOut } : {}),
    maxAmountIn: quote.maxAmountIn,
    maxNativeFee: quote.maxNativeFee,
    ...(quote.nativeValue ? { nativeValue: quote.nativeValue } : {}),
    routeProvider: quote.routeProvider,
    routeTarget: quote.routeTarget,
    routeCalldata: quote.routeCalldata,
    routeCalldataHash: quote.routeCalldataHash,
    routeSummary: quote.routeSummary,
    estimatedFee: quote.estimatedFee,
    estimatedEtaSeconds: quote.estimatedEtaSeconds,
    nonce: dependencies.createNonce(),
    deadline,
    purpose: input.purpose,
    approvalPhrase,
  };

  const authorization = dependencies.tenantId
    ? createPaymentAuthorizationFromIntent(intent, dependencies.tenantId)
    : undefined;
  const reviewToken = authorization && dependencies.tenantId && dependencies.setupWebUrl && dependencies.paymentReviews
    ? (dependencies.createReviewToken ?? (() => createPaymentReviewToken()))()
    : undefined;
  const reviewUrl = reviewToken && dependencies.setupWebUrl
    ? createPaymentReviewUrl(dependencies.setupWebUrl, reviewToken)
    : undefined;
  const reviewHandoff = reviewToken && dependencies.tenantId && authorization
    ? {
        id: `review_${paymentIntentId}`,
        paymentIntentId,
        tenantId: dependencies.tenantId,
        ownerAddress: intent.ownerAddress,
        accountAddress: intent.accountAddress,
        sourceChainId: intent.sourceChainId,
        authorizationHash: hashPaymentAuthorization(authorization),
        tokenDigest: hashPaymentReviewToken(reviewToken, dependencies.reviewTokenSecret),
        status: "PENDING" as const,
        createdAt: dependencies.clock().toISOString(),
        expiresAt: deadline,
      }
    : undefined;

  await dependencies.paymentIntents.createPaymentIntent(intent);
  if (reviewHandoff && dependencies.paymentReviews) {
    try {
      await dependencies.paymentReviews.createPaymentReviewHandoff(reviewHandoff);
    } catch (error) {
      await dependencies.paymentIntents.markPaymentFailed?.(
        paymentIntentId,
        "REVIEW_HANDOFF_FAILED",
        "Payment Review & Sign handoff could not be persisted.",
      );
      throw error;
    }
  }

  const instructionToAgent = reviewUrl
    ? `Open Review & Sign at ${reviewUrl}, then call get_payment_signature and hand the owner signature to the public paid execute_payment ASP.`
    : authorization
      ? "Open Review & Sign for the returned EIP-712 authorization, then hand the owner signature to the public paid execute_payment ASP."
    : createApprovalInstruction(paymentIntentId);

  return {
    paymentIntentId,
    status: "AWAITING_APPROVAL",
    approvalPhrase,
    summary: {
      pay: `${input.amountOut} ${input.destinationTokenSymbol}`,
      recipientAddress: input.recipientAddress,
      destinationChain: getChainName(input.destinationChainId),
      sourceSpend: `${quote.maxAmountIn} ${input.sourceTokenSymbol}`,
      routeProvider: quote.routeProvider,
      routeSummary: quote.routeSummary,
      routeTarget: quote.routeTarget,
      routeCalldataHash: quote.routeCalldataHash,
      requiresRouteTargetAllowlist: quote.routeProvider !== "DIRECT",
      estimatedFee: quote.estimatedFee ?? "0",
      estimatedEtaSeconds: quote.estimatedEtaSeconds ?? 0,
      deadline,
      purpose: input.purpose,
      maxNativeFee: quote.maxNativeFee,
      maxNativeFeeDisplay: formatNativeAmount(quote.maxNativeFee, wallet.homeChainId),
      ...(quote.minAmountOut ? { minAmountOut: quote.minAmountOut } : {}),
      ...(quote.nativeValue ? { nativeValue: quote.nativeValue } : {}),
    },
    instructionToAgent,
    ...(reviewUrl ? { reviewUrl } : {}),
    ...(authorization
      ? {
          authorization,
          authorizationHash: hashPaymentAuthorization(authorization),
        }
      : {}),
  };
}

export const preparePaymentTool = {
  name: "prepare_payment",
  description:
    "Prepare an AgentPay payment intent. Trusted consumer sessions receive canonical owner EIP-712 typed data for Review & Sign; the legacy approval phrase is migration-only.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["recipientAddress", "destinationChainId", "destinationTokenSymbol", "amountOut", "purpose"],
    properties: {
      recipientAddress: { type: "string" },
      destinationChainId: { type: "number" },
      destinationTokenSymbol: { type: "string", enum: ["USDT0", "USDC", "USDT"] },
      amountOut: { type: "string" },
      purpose: { type: "string" },
      sourceTokenSymbol: { type: "string", enum: ["USDT0", "USDC", "USDT"] },
      paymentType: { type: "string", enum: ["WALLET_PAYMENT", "INVOICE_PAYMENT", "X402_PAYMENT"] },
      network: { type: "string", enum: ["mainnet", "testnet"] },
      homeChainId: { type: "number", enum: [196, 1952] },
    },
  },
} as const;

export function createPreparePaymentHandler(dependencies: PreparePaymentDependencies) {
  return (input: PreparePaymentInput) => preparePayment(input, dependencies);
}

export async function assertSufficientSourceTokenBalance(request: {
  balances: TokenBalanceChecker;
  wallet: AgentWallet;
  tokenAddress: string;
  tokenSymbol: string;
  requiredAmount: string;
}): Promise<void> {
  const hasBalance = await request.balances.hasSufficientTokenBalance({
    accountAddress: request.wallet.accountAddress,
    chainId: request.wallet.homeChainId,
    tokenAddress: request.tokenAddress,
    tokenSymbol: request.tokenSymbol,
    requiredAmount: request.requiredAmount,
  });

  if (!hasBalance) {
    throw new Error(
      `Insufficient AgentPay ${request.tokenSymbol} balance. Required up to ${request.requiredAmount} ${request.tokenSymbol}; top up the AgentPay wallet before requesting approval.`,
    );
  }
}
