import type { CanaryCaps, CanaryUsage } from "./paid-execution-canary.ts";

export type CanaryLedgerEnvironment = "staging" | "production";

export interface CanaryLedgerUsage extends CanaryUsage {}

export interface CanaryLedgerReserveInput {
  environment: CanaryLedgerEnvironment;
  reservationKey: string;
  lifecycleId: string;
  tenantId: string;
  paymentIntentId: string;
  amount: string;
  at: string;
  caps: CanaryCaps;
}

export interface CanaryLedgerSnapshotInput {
  environment: CanaryLedgerEnvironment;
  tenantId: string;
  at: string;
}

export type CanaryLedgerReservationDisposition = "RESERVED" | "REPLAY";

export interface CanaryLedgerReservation {
  disposition: CanaryLedgerReservationDisposition;
  usage: CanaryLedgerUsage;
}

/**
 * Durable counterpart of the process-local canary usage store. Implementations
 * must enforce caps in the same transaction that inserts a reservation; a
 * snapshot is informational and is not an admission decision by itself.
 */
export interface CanaryLedgerStore {
  snapshot(input: CanaryLedgerSnapshotInput): Promise<CanaryLedgerUsage>;
  reserve(input: CanaryLedgerReserveInput): Promise<CanaryLedgerReservation>;
  complete(input: {
    environment: CanaryLedgerEnvironment;
    reservationKey: string;
    tenantId: string;
    at: string;
  }): Promise<CanaryLedgerUsage>;
}
