import { TypedDataEncoder, verifyTypedData } from "ethers";
import {
  createDirectPaymentTypedData,
  createRoutePaymentTypedData,
  createRouteCalldataHash,
  DIRECT_PAYMENT_AUTHORIZATION_TYPES,
  ROUTE_PAYMENT_AUTHORIZATION_TYPES,
  type AgentPayTypedData,
  type DirectPaymentAuthorization,
  type RoutePaymentAuthorization,
  type PaymentIntentRecord,
  getStableTokenDecimalsForChain,
} from "@agentpay-ai/shared";

export type DirectPaymentAuthorizationTypedData = AgentPayTypedData<DirectPaymentAuthorization>;
export type RoutePaymentAuthorizationTypedData = AgentPayTypedData<RoutePaymentAuthorization>;
export type PaymentAuthorizationTypedData = DirectPaymentAuthorizationTypedData | RoutePaymentAuthorizationTypedData;

export function createDirectPaymentAuthorizationFromIntent(
  intent: PaymentIntentRecord,
  tenantId: string,
): DirectPaymentAuthorizationTypedData {
  assertDirectPaymentIntent(intent);

  return createDirectPaymentTypedData({
    chainId: intent.sourceChainId,
    verifyingContract: intent.accountAddress,
    intentId: intent.id,
    tenantId: requireTenantId(tenantId),
    owner: intent.ownerAddress,
    account: intent.accountAddress,
    token: intent.sourceTokenAddress,
    recipient: intent.recipientAddress,
    amount: decimalToAtomicAmount(
      intent.amountOut,
      getStableTokenDecimalsForChain(intent.sourceChainId, intent.sourceTokenSymbol),
    ),
    nonce: intent.nonce,
    deadline: deadlineToUnixSeconds(intent.deadline),
    purpose: intent.purpose,
  });
}

export function createRoutePaymentAuthorizationFromIntent(
  intent: PaymentIntentRecord,
  tenantId: string,
): RoutePaymentAuthorizationTypedData {
  assertRoutePaymentIntent(intent);

  if (!intent.minAmountOut) {
    throw new Error("Route authorization requires a provider-verified minAmountOut.");
  }
  if (intent.nativeValue === undefined) {
    throw new Error("Route authorization requires the immutable route native value.");
  }
  assertNativeValueWithinCap(intent.nativeValue, intent.maxNativeFee);

  const expectedRouteCalldataHash = createRouteCalldataHash(intent.routeCalldata);
  if (expectedRouteCalldataHash.toLowerCase() !== intent.routeCalldataHash.toLowerCase()) {
    throw new Error("Route authorization calldata hash does not match the immutable route calldata.");
  }

  return createRoutePaymentTypedData({
    chainId: intent.sourceChainId,
    verifyingContract: intent.accountAddress,
    intentId: intent.id,
    tenantId: requireTenantId(tenantId),
    owner: intent.ownerAddress,
    account: intent.accountAddress,
    sourceToken: intent.sourceTokenAddress,
    maxAmountIn: decimalToAtomicAmount(
      intent.maxAmountIn,
      getStableTokenDecimalsForChain(intent.sourceChainId, intent.sourceTokenSymbol),
    ),
    destinationChainId: String(intent.destinationChainId),
    destinationToken: intent.destinationTokenAddress,
    recipient: intent.recipientAddress,
    minAmountOut: decimalToAtomicAmount(
      intent.minAmountOut,
      getStableTokenDecimalsForChain(intent.destinationChainId, intent.destinationTokenSymbol),
    ),
    routeTarget: intent.routeTarget,
    routeCalldataHash: intent.routeCalldataHash,
    maxNativeFee: intent.maxNativeFee,
    nonce: intent.nonce,
    deadline: deadlineToUnixSeconds(intent.deadline),
    purpose: intent.purpose,
  });
}

export function createPaymentAuthorizationFromIntent(
  intent: PaymentIntentRecord,
  tenantId: string,
): PaymentAuthorizationTypedData {
  if (intent.routeProvider === "DIRECT") {
    return createDirectPaymentAuthorizationFromIntent(intent, tenantId);
  }

  if (intent.routeProvider === "LI.FI") {
    return createRoutePaymentAuthorizationFromIntent(intent, tenantId);
  }

  throw new Error("Contract-call intents are not authorized by AgentPayAccountV2.");
}

export function hashPaymentAuthorization(typedData: PaymentAuthorizationTypedData): string {
  return TypedDataEncoder.hash(typedData.domain, ethersTypesFor(typedData), typedData.message);
}

export function verifyPaymentAuthorizationSignature(input: {
  typedData: PaymentAuthorizationTypedData;
  signature: string;
  expectedOwner: string;
}): boolean {
  try {
    const recovered = verifyTypedData(
      input.typedData.domain,
      ethersTypesFor(input.typedData),
      input.typedData.message,
      input.signature,
    );
    return recovered.toLowerCase() === input.expectedOwner.toLowerCase();
  } catch {
    return false;
  }
}

export function decimalToAtomicAmount(amount: string, decimals: number): string {
  const [whole, fractional = ""] = amount.split(".");
  if (!whole || !/^\d+$/.test(whole) || !/^\d*$/.test(fractional) || fractional.length > decimals) {
    throw new Error(`Invalid decimal amount for ${decimals} decimals: ${amount}`);
  }

  return `${whole}${fractional.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
}

function ethersTypesFor(typedData: PaymentAuthorizationTypedData): Record<string, Array<{ name: string; type: string }>> {
  return typedData.primaryType === "DirectPaymentAuthorization"
    ? (DIRECT_PAYMENT_AUTHORIZATION_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>)
    : (ROUTE_PAYMENT_AUTHORIZATION_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>);
}

function assertDirectPaymentIntent(intent: PaymentIntentRecord): void {
  if (intent.routeProvider !== "DIRECT") {
    throw new Error("Direct authorization requires a direct payment route.");
  }
  if (intent.sourceChainId !== intent.destinationChainId) {
    throw new Error("Direct authorization requires the source and destination chains to match.");
  }
  if (intent.sourceTokenAddress.toLowerCase() !== intent.destinationTokenAddress.toLowerCase()) {
    throw new Error("Direct authorization requires the source and destination tokens to match.");
  }
  if (intent.maxNativeFee !== "0") {
    throw new Error("Direct authorization cannot include a native fee.");
  }
}

function assertRoutePaymentIntent(intent: PaymentIntentRecord): void {
  if (intent.routeProvider !== "LI.FI") {
    throw new Error("Route authorization requires a LI.FI route.");
  }
  if (intent.maxAmountIn === "0" || intent.maxNativeFee === "") {
    throw new Error("Route authorization requires bounded source spend and native fee.");
  }
}

function requireTenantId(tenantId: string | undefined): string {
  if (!tenantId || tenantId.trim().length === 0) {
    throw new Error("A verified tenant ID is required for owner payment authorization.");
  }

  return tenantId;
}

function assertNativeValueWithinCap(nativeValue: string, maxNativeFee: string): void {
  if (!/^(?:0|[1-9]\d*)$/.test(nativeValue) || !/^(?:0|[1-9]\d*)$/.test(maxNativeFee)) {
    throw new Error("Route native value and fee cap must be decimal integer strings.");
  }
  if (BigInt(nativeValue) > BigInt(maxNativeFee)) {
    throw new Error("Route native value exceeds the signed native fee cap.");
  }
}

function deadlineToUnixSeconds(value: string): string {
  if (/^(?:0|[1-9]\d*)$/.test(value)) {
    return value;
  }

  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new Error(`Invalid payment authorization deadline: ${value}`);
  }

  return String(Math.floor(millis / 1000));
}
