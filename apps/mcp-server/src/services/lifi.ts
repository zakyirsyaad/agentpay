import { createRouteCalldataHash, getStableTokenDecimalsForChain, type RouteQuote } from "@agentpay-ai/shared";

import type { RouteStatusProvider, RouteStatusRequest, RouteStatusResult } from "../tools/payment-tracking.ts";
import type { RouteQuoteProvider, RouteQuoteRequest } from "../tools/prepare-payment.ts";

const DEFAULT_LIFI_BASE_URL = "https://li.quest";
export interface LifiRouteQuoteProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  integrator?: string;
  slippage?: number;
  sourceAmountBufferBps?: number;
  fetch?: typeof fetch;
}

interface LifiToken {
  address: string;
  symbol: string;
  decimals: number;
}

interface LifiQuoteResponse {
  action?: {
    fromToken?: LifiToken;
    toToken?: LifiToken;
    fromAmount?: string;
  };
  estimate?: {
    fromAmount?: string;
    toAmount?: string;
    toAmountMin?: string;
    gasCosts?: Array<{ amountUSD?: string }>;
    feeCosts?: Array<{ amountUSD?: string }>;
    executionDuration?: number;
  };
  transactionRequest?: {
    to?: string;
    data?: string;
    value?: string;
  };
  message?: string;
}

interface LifiStatusResponse {
  status?: RouteStatusResult["status"];
  substatus?: string;
  substatusMessage?: string;
  receiving?: {
    txHash?: string;
  };
  message?: string;
}

export function createLifiRouteQuoteProvider(config: LifiRouteQuoteProviderConfig = {}): RouteQuoteProvider {
  const baseUrl = config.baseUrl ?? DEFAULT_LIFI_BASE_URL;
  const fetchImpl = config.fetch ?? fetch;

  return {
    async quotePaymentRoute(request: RouteQuoteRequest): Promise<RouteQuote> {
      const url = buildQuoteUrl(baseUrl, request, config);
      const headers = config.apiKey ? { "x-lifi-api-key": config.apiKey } : undefined;
      const response = await fetchImpl(url, headers ? { headers } : undefined);
      const body = (await response.json().catch(() => ({}))) as LifiQuoteResponse;

      if (!response.ok) {
        throw new Error(`LI.FI quote failed (${response.status}): ${body.message ?? response.statusText}`);
      }

      return normalizeLifiQuote(body);
    },
  };
}

export function createLifiRouteStatusProvider(config: LifiRouteQuoteProviderConfig = {}): RouteStatusProvider {
  const baseUrl = config.baseUrl ?? DEFAULT_LIFI_BASE_URL;
  const fetchImpl = config.fetch ?? fetch;

  return {
    async getRouteStatus(request: RouteStatusRequest): Promise<RouteStatusResult> {
      const url = buildStatusUrl(baseUrl, request);
      const headers = config.apiKey ? { "x-lifi-api-key": config.apiKey } : undefined;
      const response = await fetchImpl(url, headers ? { headers } : undefined);
      const body = (await response.json().catch(() => ({}))) as LifiStatusResponse;

      if (!response.ok) {
        throw new Error(`LI.FI status failed (${response.status}): ${body.message ?? response.statusText}`);
      }

      return normalizeLifiStatus(body);
    },
  };
}

function buildQuoteUrl(baseUrl: string, request: RouteQuoteRequest, config: LifiRouteQuoteProviderConfig): string {
  const url = new URL("/v1/quote", baseUrl);
  url.searchParams.set("fromChain", String(request.sourceChainId));
  url.searchParams.set("toChain", String(request.destinationChainId));
  url.searchParams.set("fromToken", request.sourceTokenSymbol);
  url.searchParams.set("toToken", request.destinationTokenSymbol);
  url.searchParams.set("fromAddress", request.accountAddress);
  url.searchParams.set("toAddress", request.recipientAddress);
  url.searchParams.set(
    "fromAmount",
    applyBufferBps(
      decimalToAtomic(request.amountOut, getStableTokenDecimalsForChain(request.sourceChainId, request.sourceTokenSymbol)),
      config.sourceAmountBufferBps ?? 200,
    ).toString(),
  );

  if (config.slippage !== undefined) {
    url.searchParams.set("slippage", String(config.slippage));
  }

  if (config.integrator) {
    url.searchParams.set("integrator", config.integrator);
  }

  return url.toString();
}

function buildStatusUrl(baseUrl: string, request: RouteStatusRequest): string {
  const url = new URL("/v1/status", baseUrl);
  url.searchParams.set("txHash", request.txHash);
  url.searchParams.set("fromChain", String(request.fromChainId));
  url.searchParams.set("toChain", String(request.toChainId));
  return url.toString();
}

function normalizeLifiQuote(quote: LifiQuoteResponse): RouteQuote {
  const fromToken = quote.action?.fromToken;
  const toToken = quote.action?.toToken;
  const transaction = quote.transactionRequest;

  if (!fromToken?.address || !toToken?.address || !transaction?.to || !transaction.data) {
    throw new Error("LI.FI quote response is missing token or transaction data.");
  }

  const fromAmount = quote.estimate?.fromAmount ?? quote.action?.fromAmount;
  if (!fromAmount) {
    throw new Error("LI.FI quote response is missing source amount.");
  }

  return {
    routeProvider: "LI.FI",
    sourceTokenAddress: fromToken.address,
    destinationTokenAddress: toToken.address,
    maxAmountIn: atomicToDecimal(fromAmount, fromToken.decimals),
    nativeValue: normalizeNativeValue(transaction.value ?? "0"),
    ...(quote.estimate?.toAmountMin
      ? { minAmountOut: atomicToDecimal(quote.estimate.toAmountMin, toToken.decimals) }
      : {}),
    maxNativeFee: normalizeNativeValue(transaction.value ?? "0"),
    routeTarget: transaction.to,
    routeCalldata: transaction.data,
    routeCalldataHash: createRouteCalldataHash(transaction.data),
    routeSummary: createRouteSummary(quote),
    estimatedFee: estimateFeeUsd(quote),
    estimatedEtaSeconds: quote.estimate?.executionDuration,
  };
}

function normalizeNativeValue(value: string): string {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) {
      throw new Error("negative value");
    }
    return parsed.toString();
  } catch {
    throw new Error("LI.FI quote response contains an invalid native transaction value.");
  }
}

function normalizeLifiStatus(status: LifiStatusResponse): RouteStatusResult {
  if (!status.status) {
    throw new Error("LI.FI status response is missing status.");
  }

  return {
    status: status.status,
    substatus: status.substatus,
    substatusMessage: status.substatusMessage,
    destinationTxHash: status.receiving?.txHash,
  };
}

function createRouteSummary(quote: LifiQuoteResponse): string {
  const fromToken = quote.action?.fromToken;
  const toToken = quote.action?.toToken;
  const toAmount = quote.estimate?.toAmount;

  if (!fromToken || !toToken || !toAmount) {
    return "LI.FI route prepared.";
  }

  return `Spend ${atomicToDecimal(quote.estimate?.fromAmount ?? quote.action?.fromAmount ?? "0", fromToken.decimals)} ${
    fromToken.symbol
  } for an estimated ${atomicToDecimal(toAmount, toToken.decimals)} ${toToken.symbol}.`;
}

function estimateFeeUsd(quote: LifiQuoteResponse): string | undefined {
  const costs = [...(quote.estimate?.gasCosts ?? []), ...(quote.estimate?.feeCosts ?? [])];
  const totalCents = costs.reduce((sum, cost) => sum + decimalUsdToCents(cost.amountUSD ?? "0"), 0n);
  return totalCents > 0n ? centsToDecimalUsd(totalCents) : undefined;
}

function decimalToAtomic(amount: string, decimals: number): string {
  const [whole, fractional = ""] = amount.split(".");
  if (!whole || !/^\d+$/.test(whole) || !/^\d*$/.test(fractional) || fractional.length > decimals) {
    throw new Error(`Invalid decimal amount for ${decimals} decimals: ${amount}`);
  }

  return `${whole}${fractional.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
}

function applyBufferBps(amount: string, bufferBps: number): bigint {
  if (!Number.isInteger(bufferBps) || bufferBps < 0) {
    throw new Error(`Invalid source amount buffer bps: ${bufferBps}`);
  }

  const numerator = BigInt(10_000 + bufferBps);
  return (BigInt(amount) * numerator + 9_999n) / 10_000n;
}

function atomicToDecimal(amount: string, decimals: number): string {
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fractional = padded.slice(-decimals).replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole;
}

function decimalUsdToCents(amount: string): bigint {
  const [whole, fractional = ""] = amount.split(".");
  return BigInt(whole || "0") * 100n + BigInt(fractional.padEnd(2, "0").slice(0, 2) || "0");
}

function centsToDecimalUsd(cents: bigint): string {
  const whole = cents / 100n;
  const fractional = (cents % 100n).toString().padStart(2, "0");
  return fractional === "00" ? whole.toString() : `${whole}.${fractional}`;
}
