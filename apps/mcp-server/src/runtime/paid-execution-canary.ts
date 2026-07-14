import { MAINNET_CHAIN_ID, MAINNET_USDT0_ADDRESS } from "./production-readiness.ts";
import {
  DIRECT_PAYMENT_ROUTE_CALLDATA,
  DIRECT_PAYMENT_ROUTE_TARGET,
  type PaymentIntentRecord,
} from "@agentpay-ai/shared";

export interface CanaryCaps {
  maxAcceptedLifecycles: number;
  maxInvoiceAtomic: bigint;
  maxTenantDailyAtomic: bigint;
  maxGlobalDailyAtomic: bigint;
  maxInFlightPerTenant: number;
  maxNativeFee: bigint;
}

export const DEFAULT_CANARY_CAPS: CanaryCaps = {
  maxAcceptedLifecycles: 1,
  maxInvoiceAtomic: 100_000n,
  maxTenantDailyAtomic: 100_000n,
  maxGlobalDailyAtomic: 100_000n,
  maxInFlightPerTenant: 1,
  maxNativeFee: 0n,
};

export interface CanaryAllowlist {
  tenantId: string;
  ownerAddress: string;
  accountAddress: string;
  payerAddress: string;
  recipientAddress: string;
}

/**
 * Static policy used by the HTTP admission gate.  The allowlist is kept out
 * of the usage ledger so an operator can rotate the one permitted account or
 * payer without changing the accounting implementation.
 */
export interface CanaryPolicy {
  allowlist: CanaryAllowlist;
  caps?: CanaryCaps;
}

export interface CanaryUsage {
  acceptedLifecycles: number;
  tenantDailyAtomic: bigint;
  globalDailyAtomic: bigint;
  tenantInFlight: number;
}

export interface CanaryUsageStore {
  snapshot(): CanaryUsage;
  /**
   * Atomically reserve one lifecycle. Reusing the same key is an idempotent
   * replay and never consumes another canary slot.
   */
  reserve(reservationKey: string, tenantId: string, amount: string): CanaryUsage;
  /** Compatibility helper for unit/demo callers without a lifecycle key. */
  accept(amount: string): CanaryUsage;
  complete(reservationKey?: string): CanaryUsage;
}

export class CanaryPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CanaryPolicyError";
  }
}

/**
 * Validate the intent and payer shape without consulting usage counters.
 * This is useful when an x402 challenge is about to be issued: a counter
 * reservation may already exist, so running the full usage gate again would
 * incorrectly reject the same request as in-flight.
 */
export function assertCanaryRequestShapeAllowed(
  intent: PaymentIntentRecord,
  allowlist: CanaryAllowlist,
  payerAddress: string | undefined,
  caps: CanaryCaps = DEFAULT_CANARY_CAPS,
  now: Date = new Date(),
): void {
  if (intent.tenantId !== allowlist.tenantId || intent.ownerAddress.toLowerCase() !== allowlist.ownerAddress.toLowerCase() || intent.accountAddress.toLowerCase() !== allowlist.accountAddress.toLowerCase()) {
    throw new CanaryPolicyError("CANARY_ALLOWLIST", "Payment intent is outside the canary tenant/account allowlist.");
  }
  if (intent.recipientAddress.toLowerCase() !== allowlist.recipientAddress.toLowerCase()) {
    throw new CanaryPolicyError("CANARY_ALLOWLIST", "Payment recipient is outside the canary allowlist.");
  }
  if (payerAddress && payerAddress.toLowerCase() !== allowlist.payerAddress.toLowerCase()) {
    throw new CanaryPolicyError("CANARY_ALLOWLIST", "x402 payer is outside the canary allowlist.");
  }
  if (intent.sourceChainId !== MAINNET_CHAIN_ID || intent.destinationChainId !== MAINNET_CHAIN_ID || intent.routeProvider !== "DIRECT") {
    throw new CanaryPolicyError("CANARY_ROUTE", "Canary permits only direct chain-196 execution.");
  }
  if (intent.sourceTokenAddress.toLowerCase() !== MAINNET_USDT0_ADDRESS.toLowerCase() || intent.destinationTokenAddress.toLowerCase() !== MAINNET_USDT0_ADDRESS.toLowerCase()) {
    throw new CanaryPolicyError("CANARY_ASSET", "Canary permits only mainnet USDT0.");
  }
  const amountAtomic = decimalToAtomic6(intent.amountOut);
  if (amountAtomic > caps.maxInvoiceAtomic) {
    throw new CanaryPolicyError("CANARY_CAP", "Payment exceeds the canary amount cap.");
  }
  if (
    intent.routeTarget.toLowerCase() !== DIRECT_PAYMENT_ROUTE_TARGET ||
    intent.routeCalldata.toLowerCase() !== DIRECT_PAYMENT_ROUTE_CALLDATA ||
    intent.maxAmountIn !== intent.amountOut ||
    (intent.minAmountOut ?? intent.amountOut) !== intent.amountOut ||
    (intent.nativeValue ?? "0") !== "0" ||
    intent.status !== "AWAITING_APPROVAL" ||
    !intent.nonce ||
    new Date(intent.deadline).getTime() <= now.getTime()
  ) {
    throw new CanaryPolicyError("CANARY_ROUTE", "Canary direct execution fields or intent state are invalid.");
  }
  if (intent.maxNativeFee !== caps.maxNativeFee.toString()) {
    throw new CanaryPolicyError("CANARY_NATIVE_FEE", "Canary native fee cap must be zero.");
  }
}

export function assertCanaryRequestAllowed(
  intent: PaymentIntentRecord,
  allowlist: CanaryAllowlist,
  usage: CanaryUsage,
  payerAddress: string,
  caps: CanaryCaps = DEFAULT_CANARY_CAPS,
  now: Date = new Date(),
): void {
  assertCanaryRequestShapeAllowed(intent, allowlist, payerAddress, caps, now);
  assertCanaryUsageWithinCaps(intent, usage, caps);
}

/**
 * Check counters before a challenge. The database reservation remains the
 * authoritative second check immediately before settlement because a snapshot
 * can become stale when two requests arrive concurrently.
 */
export function assertCanaryUsageWithinCaps(
  intent: PaymentIntentRecord,
  usage: CanaryUsage,
  caps: CanaryCaps = DEFAULT_CANARY_CAPS,
): void {
  if (usage.acceptedLifecycles >= caps.maxAcceptedLifecycles) {
    throw new CanaryPolicyError("CANARY_AUTO_STOP", "The one-lifecycle canary has already auto-stopped.");
  }
  const amountAtomic = decimalToAtomic6(intent.amountOut);
  if (usage.tenantDailyAtomic + amountAtomic > caps.maxTenantDailyAtomic || usage.globalDailyAtomic + amountAtomic > caps.maxGlobalDailyAtomic) {
    throw new CanaryPolicyError("CANARY_CAP", "Payment exceeds the canary amount cap.");
  }
  if (usage.tenantInFlight >= caps.maxInFlightPerTenant) {
    throw new CanaryPolicyError("CANARY_IN_FLIGHT", "The canary tenant already has an in-flight invoice.");
  }
}

export function decimalToAtomic6(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > 6) {
    throw new CanaryPolicyError("CANARY_AMOUNT", "Canary amount must be a non-negative six-decimal value.");
  }
  return BigInt(`${whole}${fraction.padEnd(6, "0")}`);
}

/**
 * Process-local canary ledger for tests and staging demos. Production must
 * replace this with a durable transactional implementation before CANARY can
 * become readiness-eligible.
 */
export function createCanaryUsageStore(caps: CanaryCaps = DEFAULT_CANARY_CAPS): CanaryUsageStore {
  let usage: CanaryUsage = { acceptedLifecycles: 0, tenantDailyAtomic: 0n, globalDailyAtomic: 0n, tenantInFlight: 0 };
  let legacySequence = 0;
  const reservations = new Map<string, { tenantId: string; amountAtomic: bigint }>();
  const reserve = (reservationKey: string, tenantId: string, amount: string): CanaryUsage => {
    const existing = reservations.get(reservationKey);
    if (existing) {
      if (existing.tenantId !== tenantId || existing.amountAtomic !== decimalToAtomic6(amount)) {
        throw new CanaryPolicyError("CANARY_RESERVATION_CONFLICT", "Canary reservation key is bound to different payment terms.");
      }
      return { ...usage };
    }
    const atomic = decimalToAtomic6(amount);
    if (usage.acceptedLifecycles >= caps.maxAcceptedLifecycles) throw new CanaryPolicyError("CANARY_AUTO_STOP", "Canary is OFF after its first accepted lifecycle.");
    if (usage.tenantDailyAtomic + atomic > caps.maxTenantDailyAtomic || usage.globalDailyAtomic + atomic > caps.maxGlobalDailyAtomic) {
      throw new CanaryPolicyError("CANARY_CAP", "Payment exceeds the canary amount cap.");
    }
    if (usage.tenantInFlight >= caps.maxInFlightPerTenant) throw new CanaryPolicyError("CANARY_IN_FLIGHT", "The canary tenant already has an in-flight invoice.");
    const next = { acceptedLifecycles: usage.acceptedLifecycles + 1, tenantDailyAtomic: usage.tenantDailyAtomic + atomic, globalDailyAtomic: usage.globalDailyAtomic + atomic, tenantInFlight: usage.tenantInFlight + 1 };
    usage = next;
    reservations.set(reservationKey, { tenantId, amountAtomic: atomic });
    return { ...usage };
  };
  return {
    snapshot(): CanaryUsage { return { ...usage }; },
    reserve,
    accept(amount: string): CanaryUsage {
      legacySequence += 1;
      return reserve(`legacy_${legacySequence}`, "", amount);
    },
    complete(reservationKey?: string): CanaryUsage {
      const key = reservationKey ?? reservations.keys().next().value;
      if (typeof key === "string" && reservations.delete(key)) {
        usage = { ...usage, tenantInFlight: Math.max(0, usage.tenantInFlight - 1) };
      }
      return { ...usage };
    },
  };
}
