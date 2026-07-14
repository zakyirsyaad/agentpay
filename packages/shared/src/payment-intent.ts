import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";

import { getChainName, networkSelectionShape } from "./chains.ts";
import { getStableTokenMetadata, stableTokenSymbolSchema } from "./tokens.ts";

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const hexPattern = /^0x(?:[a-fA-F0-9]{2})*$/;
const positiveDecimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export const evmAddressSchema = z.string().regex(addressPattern, "Expected an EVM address");

export const hexDataSchema = z.string().regex(hexPattern, "Expected 0x-prefixed even-length hex data");

export const positiveDecimalStringSchema = z.string().refine(
  (value) => positiveDecimalPattern.test(value) && Number(value) > 0,
  "Expected a positive decimal string",
);

export const paymentIntentStatusSchema = z.enum([
  "AWAITING_APPROVAL",
  "APPROVED",
  "EXECUTING",
  "COMPLETED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
]);

export type PaymentIntentStatus = z.infer<typeof paymentIntentStatusSchema>;

export const paymentTypeSchema = z.enum(["WALLET_PAYMENT", "INVOICE_PAYMENT", "X402_PAYMENT", "CONTRACT_CALL"]);

export type PaymentType = z.infer<typeof paymentTypeSchema>;

export const stablecoinPaymentTypeSchema = z.enum(["WALLET_PAYMENT", "INVOICE_PAYMENT", "X402_PAYMENT"]);

export type StablecoinPaymentType = z.infer<typeof stablecoinPaymentTypeSchema>;

export const preparePaymentInputSchema = z.object({
  recipientAddress: evmAddressSchema,
  destinationChainId: z.number().int().positive(),
  destinationTokenSymbol: stableTokenSymbolSchema,
  amountOut: positiveDecimalStringSchema,
  purpose: z.string().trim().min(1).max(280),
  sourceTokenSymbol: stableTokenSymbolSchema.default("USDT0"),
  paymentType: stablecoinPaymentTypeSchema.default("WALLET_PAYMENT"),
  ...networkSelectionShape,
});

export const quotePaymentRouteInputSchema = preparePaymentInputSchema.omit({ purpose: true, paymentType: true });

export type QuotePaymentRouteInput = z.input<typeof quotePaymentRouteInputSchema>;
export type ParsedQuotePaymentRouteInput = z.output<typeof quotePaymentRouteInputSchema>;

export type PreparePaymentInput = z.input<typeof preparePaymentInputSchema>;
export type ParsedPreparePaymentInput = z.output<typeof preparePaymentInputSchema>;

export const executePaymentInputSchema = z.object({
  paymentIntentId: z.string().trim().min(1),
  approvalText: z.string().min(1).optional(),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/, "Expected an EVM payment authorization signature").optional(),
}).refine((value) => Boolean(value.approvalText || value.signature), {
  message: "Provide an owner payment signature or the legacy approval text.",
});

export type ExecutePaymentInput = z.infer<typeof executePaymentInputSchema>;

export const executeAuthorizedPaymentInputSchema = z.object({
  paymentIntentId: z.string().trim().min(1),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/, "Expected an EVM payment authorization signature"),
});

export type ExecuteAuthorizedPaymentInput = z.infer<typeof executeAuthorizedPaymentInputSchema>;

export const prepareContractCallInputSchema = z.object({
  targetAddress: evmAddressSchema,
  callData: hexDataSchema.refine((value) => value !== "0x", "Expected non-empty calldata"),
  sourceTokenSymbol: stableTokenSymbolSchema.default("USDT0"),
  maxTokenSpend: positiveDecimalStringSchema,
  maxNativeFee: z.string().regex(/^(?:0|[1-9]\d*)$/, "Expected a non-negative integer string").default("0"),
  purpose: z.string().trim().min(1).max(280),
  ...networkSelectionShape,
});

export type PrepareContractCallInput = z.input<typeof prepareContractCallInputSchema>;
export type ParsedPrepareContractCallInput = z.output<typeof prepareContractCallInputSchema>;

export const routeProviderSchema = z.enum(["DIRECT", "LI.FI", "CONTRACT_CALL"]);

export type RouteProvider = z.infer<typeof routeProviderSchema>;

export const DIRECT_PAYMENT_ROUTE_TARGET = "0x0000000000000000000000000000000000000000";
export const DIRECT_PAYMENT_ROUTE_CALLDATA = "0x";

export interface RouteQuote {
  routeProvider: RouteProvider;
  sourceTokenAddress: string;
  destinationTokenAddress: string;
  maxAmountIn: string;
  maxNativeFee: string;
  nativeValue?: string;
  routeTarget: string;
  routeCalldata: string;
  routeCalldataHash: string;
  routeSummary: string;
  minAmountOut?: string;
  estimatedFee?: string;
  estimatedEtaSeconds?: number;
}

export function isDirectPaymentRoute(
  sourceChainId: number,
  destinationChainId: number,
  sourceTokenSymbol: string,
  destinationTokenSymbol: string,
): boolean {
  return sourceChainId === destinationChainId && sourceTokenSymbol === destinationTokenSymbol;
}

export function createDirectPaymentRouteQuote(request: {
  chainId: number;
  tokenSymbol: string;
  amountOut: string;
}): RouteQuote {
  const token = getStableTokenMetadata(request.chainId, request.tokenSymbol);
  const routeCalldata = DIRECT_PAYMENT_ROUTE_CALLDATA;

  return {
    routeProvider: "DIRECT",
    sourceTokenAddress: token.address,
    destinationTokenAddress: token.address,
    maxAmountIn: request.amountOut,
    maxNativeFee: "0",
    routeTarget: DIRECT_PAYMENT_ROUTE_TARGET,
    routeCalldata,
    routeCalldataHash: createRouteCalldataHash(routeCalldata),
    routeSummary: `Direct ${request.amountOut} ${token.symbol} transfer on ${getChainName(request.chainId)}.`,
    estimatedFee: "0",
    estimatedEtaSeconds: 0,
  };
}

export interface PaymentIntentRecord {
  id: string;
  tenantId?: string;
  accountAddress: string;
  ownerAddress: string;
  status: PaymentIntentStatus;
  paymentType: PaymentType;
  sourceChainId: number;
  destinationChainId: number;
  sourceTokenAddress: string;
  sourceTokenSymbol: string;
  destinationTokenAddress: string;
  destinationTokenSymbol: string;
  recipientAddress: string;
  amountOut: string;
  minAmountOut?: string;
  nativeValue?: string;
  maxAmountIn: string;
  maxNativeFee: string;
  routeProvider: RouteProvider;
  routeTarget: string;
  routeCalldata: string;
  routeCalldataHash: string;
  routeSummary: string;
  estimatedFee?: string;
  estimatedEtaSeconds?: number;
  nonce: string;
  deadline: string;
  purpose: string;
  approvalPhrase: string;
  approvedAt?: string;
  sourceTxHash?: string;
  destinationTxHash?: string;
  lifiTrackingId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt?: string;
  completedAt?: string;
}

export function createRouteCalldataHash(routeCalldata: string): string {
  const parsed = hexDataSchema.parse(routeCalldata);
  return `0x${bytesToHex(keccak_256(hexToBytes(parsed.slice(2))))}`;
}
