import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSupabaseAgentPayRepositories, type AgentPaySupabaseClient } from "../services/supabase.ts";
import { CanaryPolicyError, DEFAULT_CANARY_CAPS } from "./paid-execution-canary.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const lifecycleId = "22222222-2222-4222-8222-222222222222";

function usageRow(disposition?: "RESERVED" | "REPLAY") {
  return {
    ...(disposition ? { disposition } : {}),
    accepted_lifecycles: "1",
    tenant_daily_atomic: "100000",
    global_daily_atomic: 100000,
    tenant_in_flight: "1",
  };
}

describe("durable canary ledger repository", () => {
  it("passes cap terms to the atomic reserve RPC and maps its usage", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      from() {
        throw new Error("unexpected table access");
      },
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return { data: usageRow("RESERVED"), error: null };
      },
    };
    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);

    const result = await repositories.canaryLedger!.reserve({
      environment: "production",
      reservationKey: lifecycleId,
      lifecycleId,
      tenantId,
      paymentIntentId: "pay_canary",
      amount: "0.10",
      at: "2026-07-13T00:00:00.000Z",
      caps: DEFAULT_CANARY_CAPS,
    });

    assert.equal(result.disposition, "RESERVED");
    assert.deepEqual(result.usage, {
      acceptedLifecycles: 1,
      tenantDailyAtomic: 100000n,
      globalDailyAtomic: 100000n,
      tenantInFlight: 1,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "reserve_paid_execution_canary");
    assert.equal(calls[0].args.p_amount_atomic, "100000");
    assert.equal(calls[0].args.p_max_global_daily_atomic, DEFAULT_CANARY_CAPS.maxGlobalDailyAtomic.toString());
    assert.equal(calls[0].args.p_lifecycle_id, lifecycleId);
  });

  it("supports informational snapshots and idempotent completion", async () => {
    const calls: string[] = [];
    const client = {
      from() {
        throw new Error("unexpected table access");
      },
      async rpc(name: string) {
        calls.push(name);
        return { data: usageRow(name === "reserve_paid_execution_canary" ? "REPLAY" : undefined), error: null };
      },
    };
    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    const snapshot = await repositories.canaryLedger!.snapshot({
      environment: "production",
      tenantId,
      at: "2026-07-13T00:00:00.000Z",
    });
    const completed = await repositories.canaryLedger!.complete({
      environment: "production",
      reservationKey: lifecycleId,
      tenantId,
      at: "2026-07-13T00:01:00.000Z",
    });

    assert.deepEqual(snapshot, completed);
    assert.deepEqual(calls, ["get_paid_execution_canary_usage", "complete_paid_execution_canary"]);
  });

  it("maps atomic cap rejection to a typed canary policy error", async () => {
    const client = {
      from() {
        throw new Error("unexpected table access");
      },
      async rpc() {
        return { data: null, error: { message: "CANARY_AUTO_STOP: The canary has already consumed its lifecycle cap." } };
      },
    };
    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);

    await assert.rejects(
      repositories.canaryLedger!.reserve({
        environment: "production",
        reservationKey: lifecycleId,
        lifecycleId,
        tenantId,
        paymentIntentId: "pay_canary",
        amount: "0.10",
        at: "2026-07-13T00:00:00.000Z",
        caps: DEFAULT_CANARY_CAPS,
      }),
      (error: unknown) => error instanceof CanaryPolicyError && error.code === "CANARY_AUTO_STOP",
    );
  });
});
