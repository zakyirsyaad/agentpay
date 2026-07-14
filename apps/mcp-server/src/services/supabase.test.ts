import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSessionContext, type PaymentReviewHandoffRecord } from "@agentpay-ai/shared";

import {
  type AgentPaySupabaseClient,
  createSupabaseAgentPayRepositories,
  toPaymentIntentRow,
} from "./supabase.ts";
import { createPaidExecutionIdempotencyKey } from "./paid-execution-lifecycle.ts";

class FakeSelectQuery {
  public calls: Array<[string, unknown[]]> = [];

  select(columns: string) {
    this.calls.push(["select", [columns]]);
    return this;
  }

  eq(column: string, value: string) {
    this.calls.push(["eq", [column, value]]);
    return this;
  }

  order(column: string, options: { ascending: boolean }) {
    this.calls.push(["order", [column, options]]);
    return this;
  }

  limit(count: number) {
    this.calls.push(["limit", [count]]);
    return this;
  }

  maybeSingle() {
    this.calls.push(["maybeSingle", []]);
    return Promise.resolve({
      data: {
        owner_address: "0x2222222222222222222222222222222222222222",
        account_address: "0x3333333333333333333333333333333333333333",
        home_chain_id: 196,
        executor_address: "0x4444444444444444444444444444444444444444",
        status: "ACTIVE" as const,
      },
      error: null,
    });
  }
}

class FakeAgentWalletMutationQuery extends FakeSelectQuery {
  public inserted: unknown;

  insert(row: unknown) {
    this.inserted = row;
    return Promise.resolve({ error: null });
  }
}

class FakeInsertQuery {
  public inserted: unknown;

  insert(row: unknown) {
    this.inserted = row;
    return Promise.resolve({ error: null });
  }
}

class FakePaymentEventQuery {
  public calls: Array<[string, unknown[]]> = [];
  public data: unknown[] = [];
  public inserted: unknown[] = [];

  insert(row: unknown) {
    this.inserted.push(row);
    return Promise.resolve({ error: null });
  }

  select(columns: string) {
    this.calls.push(["select", [columns]]);
    return this;
  }

  eq(column: string, value: string) {
    this.calls.push(["eq", [column, value]]);
    return this;
  }

  order(column: string, options: { ascending: boolean }) {
    this.calls.push(["order", [column, options]]);
    return this;
  }

  limit(count: number) {
    this.calls.push(["limit", [count]]);
    return this;
  }

  then(resolve: (value: { data: unknown[]; error: null }) => void) {
    this.calls.push(["then", []]);
    resolve({ data: this.data, error: null });
  }
}

class FakePaymentIntentQuery {
  public calls: Array<[string, unknown[]]> = [];
  public inserted: unknown;
  public updated: unknown;
  public maybeSingleData: unknown | null | undefined;

  select(columns: string) {
    this.calls.push(["select", [columns]]);
    return this;
  }

  insert(row: unknown) {
    this.inserted = row;
    return Promise.resolve({ error: null });
  }

  update(row: unknown) {
    this.updated = row;
    this.calls.push(["update", [row]]);
    return this;
  }

  eq(column: string, value: string) {
    this.calls.push(["eq", [column, value]]);
    return this;
  }

  maybeSingle() {
    this.calls.push(["maybeSingle", []]);
    const data =
      this.maybeSingleData === undefined
        ? {
            id: "pay_123",
            account_address: "0x3333333333333333333333333333333333333333",
            owner_address: "0x2222222222222222222222222222222222222222",
            status: "AWAITING_APPROVAL",
            payment_type: "WALLET_PAYMENT",
            source_chain_id: 196,
            destination_chain_id: 8453,
            source_token_address: "0x5555555555555555555555555555555555555555",
            source_token_symbol: "USDT0",
            destination_token_address: "0x6666666666666666666666666666666666666666",
            destination_token_symbol: "USDC",
            recipient_address: "0x1111111111111111111111111111111111111111",
            amount_out: "10",
            max_amount_in: "10.18",
            max_native_fee: "0",
            route_provider: "LI.FI",
            route_target: "0x7777777777777777777777777777777777777777",
            route_calldata: "0x1234",
            route_calldata_hash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
            route_summary: "Swap and bridge.",
            estimated_fee: "0.12",
            estimated_eta_seconds: 120,
            nonce: "42",
            deadline: "2026-07-02T14:45:00.000Z",
            purpose: "design bounty",
            approval_phrase: "APPROVE pay_123",
            approved_at: null,
            source_tx_hash: null,
            destination_tx_hash: null,
            lifi_tracking_id: null,
            error_code: null,
            error_message: null,
            created_at: "2026-07-02T14:30:00.000Z",
          }
        : this.maybeSingleData;

    return Promise.resolve({
      data,
      error: null,
    });
  }

  then(resolve: (value: { error: null }) => void) {
    resolve({ error: null });
  }
}

class FakePaymentIntentListQuery {
  public calls: Array<[string, unknown[]]> = [];
  public data: unknown[] = [];

  select(columns: string) {
    this.calls.push(["select", [columns]]);
    return this;
  }

  order(column: string, options: { ascending: boolean }) {
    this.calls.push(["order", [column, options]]);
    return this;
  }

  limit(count: number) {
    this.calls.push(["limit", [count]]);
    return this;
  }

  then(resolve: (value: { data: unknown[]; error: null }) => void) {
    this.calls.push(["then", []]);
    resolve({ data: this.data, error: null });
  }
}

class FakePaymentReviewQuery {
  public calls: Array<[string, unknown[]]> = [];
  public inserted: unknown;
  public updated: unknown;
  public maybeSingleData: unknown;
  public maybeSingleDataQueue: unknown[] = [];

  select(columns: string) { this.calls.push(["select", [columns]]); return this; }
  insert(row: unknown) { this.inserted = row; return Promise.resolve({ error: null }); }
  update(row: unknown) { this.updated = row; this.calls.push(["update", [row]]); return this; }
  eq(column: string, value: string) { this.calls.push(["eq", [column, value]]); return this; }
  gt(column: string, value: string) { this.calls.push(["gt", [column, value]]); return this; }
  maybeSingle() {
    this.calls.push(["maybeSingle", []]);
    const data = this.maybeSingleDataQueue.length > 0
      ? this.maybeSingleDataQueue.shift()
      : this.maybeSingleData;
    return Promise.resolve({ data: data ?? null, error: null });
  }
}

class FakePaidExecutionLifecycleQuery {
  public calls: Array<[string, unknown[]]> = [];
  public inserted: unknown;
  public updated: unknown;
  public insertError: { message: string } | null = null;
  public maybeSingleData: any = null;

  select(columns: string) { this.calls.push(["select", [columns]]); return this; }
  insert(row: unknown) { this.inserted = row; return Promise.resolve({ error: this.insertError }); }
  update(row: unknown) { this.updated = row; this.calls.push(["update", [row]]); return this; }
  eq(column: string, value: string) { this.calls.push(["eq", [column, value]]); return this; }
  maybeSingle() { this.calls.push(["maybeSingle", []]); return Promise.resolve({ data: this.maybeSingleData, error: null }); }
}

class FakeSetupIntentQuery {
  public calls: Array<[string, unknown[]]> = [];
  public inserted: unknown;
  public updated: unknown;

  select(columns: string) {
    this.calls.push(["select", [columns]]);
    return this;
  }

  insert(row: unknown) {
    this.inserted = row;
    return Promise.resolve({ error: null });
  }

  update(row: unknown) {
    this.updated = row;
    this.calls.push(["update", [row]]);
    return this;
  }

  eq(column: string, value: string) {
    this.calls.push(["eq", [column, value]]);
    return this;
  }

  maybeSingle() {
    this.calls.push(["maybeSingle", []]);
    return Promise.resolve({
      data: {
        id: "setup_123",
        owner_address: "0x2222222222222222222222222222222222222222",
        executor_address: "0x4444444444444444444444444444444444444444",
        message_to_sign: "AgentPay wallet setup",
        signature: null,
        status: "COMPLETED",
        expires_at: "2026-07-03T04:15:00.000Z",
        account_address: "0x3333333333333333333333333333333333333333",
        error_code: null,
        error_message: null,
        completed_at: "2026-07-03T04:02:00.000Z",
        home_chain_id: 196,
      },
      error: null,
    });
  }
}

describe("createSupabaseAgentPayRepositories", () => {
  it("loads the latest active wallet from agent_wallets", async () => {
    const query = new FakeSelectQuery();
    const client = {
      from(table: string) {
        assert.equal(table, "agent_wallets");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    const wallet = await repositories.wallets.getActiveWallet();

    assert.deepEqual(wallet, {
      ownerAddress: "0x2222222222222222222222222222222222222222",
      accountAddress: "0x3333333333333333333333333333333333333333",
      homeChainId: 196,
      executorAddress: "0x4444444444444444444444444444444444444444",
      status: "ACTIVE",
    });
    assert.deepEqual(query.calls, [
      ["select", ["owner_address, account_address, home_chain_id, executor_address, status"]],
      ["eq", ["status", "ACTIVE"]],
      ["order", ["created_at", { ascending: false }]],
      ["limit", [1]],
      ["maybeSingle", []],
    ]);
  });

  it("loads the latest active wallet for a requested X Layer network", async () => {
    const query = new FakeSelectQuery();
    const client = {
      from(table: string) {
        assert.equal(table, "agent_wallets");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    await repositories.wallets.getActiveWallet({ homeChainId: 1952 });

    assert.deepEqual(query.calls, [
      ["select", ["owner_address, account_address, home_chain_id, executor_address, status"]],
      ["eq", ["status", "ACTIVE"]],
      ["eq", ["home_chain_id", 1952]],
      ["order", ["created_at", { ascending: false }]],
      ["limit", [1]],
      ["maybeSingle", []],
    ]);
  });

  it("maps payment intent records to payment_intents insert rows", async () => {
    const query = new FakeInsertQuery();
    const eventQuery = new FakePaymentEventQuery();
    const client = {
      from(table: string) {
        if (table === "payment_events") {
          return eventQuery;
        }

        assert.equal(table, "payment_intents");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    await repositories.paymentIntents.createPaymentIntent({
      id: "pay_123",
      accountAddress: "0x3333333333333333333333333333333333333333",
      ownerAddress: "0x2222222222222222222222222222222222222222",
      status: "AWAITING_APPROVAL",
      paymentType: "WALLET_PAYMENT",
      sourceChainId: 196,
      destinationChainId: 8453,
      sourceTokenAddress: "0x5555555555555555555555555555555555555555",
      sourceTokenSymbol: "USDT0",
      destinationTokenAddress: "0x6666666666666666666666666666666666666666",
      destinationTokenSymbol: "USDC",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountOut: "10",
      maxAmountIn: "10.18",
      maxNativeFee: "0",
      routeProvider: "LI.FI",
      routeTarget: "0x7777777777777777777777777777777777777777",
      routeCalldata: "0x1234",
      routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
      routeSummary: "Swap and bridge.",
      estimatedFee: "0.12",
      estimatedEtaSeconds: 120,
      nonce: "42",
      deadline: "2026-07-02T14:45:00.000Z",
      purpose: "design bounty",
      approvalPhrase: "APPROVE pay_123",
    });

    assert.deepEqual(query.inserted, {
      id: "pay_123",
      account_address: "0x3333333333333333333333333333333333333333",
      owner_address: "0x2222222222222222222222222222222222222222",
      status: "AWAITING_APPROVAL",
      payment_type: "WALLET_PAYMENT",
      source_chain_id: 196,
      destination_chain_id: 8453,
      source_token_address: "0x5555555555555555555555555555555555555555",
      source_token_symbol: "USDT0",
      destination_token_address: "0x6666666666666666666666666666666666666666",
      destination_token_symbol: "USDC",
      recipient_address: "0x1111111111111111111111111111111111111111",
      amount_out: "10",
      max_amount_in: "10.18",
      max_native_fee: "0",
      route_provider: "LI.FI",
      route_target: "0x7777777777777777777777777777777777777777",
      route_calldata: "0x1234",
      route_calldata_hash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
      route_summary: "Swap and bridge.",
      estimated_fee: "0.12",
      estimated_eta_seconds: 120,
      nonce: "42",
      deadline: "2026-07-02T14:45:00.000Z",
      purpose: "design bounty",
      approval_phrase: "APPROVE pay_123",
    });
    assert.deepEqual(eventQuery.inserted, [
      {
        payment_intent_id: "pay_123",
        event_type: "PAYMENT_CREATED",
        message: "Payment intent created.",
        metadata: {
          status: "AWAITING_APPROVAL",
          amountOut: "10",
          destinationChainId: 8453,
          destinationTokenSymbol: "USDC",
          recipientAddress: "0x1111111111111111111111111111111111111111",
        },
      },
    ]);
  });

  it("loads a payment intent by id from payment_intents", async () => {
    const query = new FakePaymentIntentQuery();
    const client = {
      from(table: string) {
        assert.equal(table, "payment_intents");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    const intent = await repositories.paymentIntents.getPaymentIntent("pay_123");

    assert.equal(intent?.id, "pay_123");
    assert.equal(intent?.status, "AWAITING_APPROVAL");
    assert.equal(intent?.routeCalldata, "0x1234");
    assert.deepEqual(query.calls, [
      ["select", ["*"]],
      ["eq", ["id", "pay_123"]],
      ["maybeSingle", []],
    ]);
  });

  it("marks a payment intent executing with source transaction hash", async () => {
    const query = new FakePaymentIntentQuery();
    const eventQuery = new FakePaymentEventQuery();
    const client = {
      from(table: string) {
        if (table === "payment_events") {
          return eventQuery;
        }

        assert.equal(table, "payment_intents");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    await repositories.paymentIntents.markPaymentExecuting(
      "pay_123",
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "2026-07-02T14:40:00.000Z",
    );

    assert.deepEqual(query.updated, {
      status: "EXECUTING",
      source_tx_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      approved_at: "2026-07-02T14:40:00.000Z",
    });
    assert.deepEqual(query.calls, [
      [
        "update",
        [
          {
            status: "EXECUTING",
            source_tx_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            approved_at: "2026-07-02T14:40:00.000Z",
          },
        ],
      ],
      ["eq", ["id", "pay_123"]],
    ]);
    assert.deepEqual(eventQuery.inserted, [
      {
        payment_intent_id: "pay_123",
        event_type: "PAYMENT_EXECUTING",
        message: "Payment execution started.",
        metadata: {
          sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          approvedAt: "2026-07-02T14:40:00.000Z",
        },
      },
    ]);
  });

  it("claims payment approval only while the intent is awaiting approval", async () => {
    const query = new FakePaymentIntentQuery();
    const eventQuery = new FakePaymentEventQuery();
    const client = {
      from(table: string) {
        if (table === "payment_events") {
          return eventQuery;
        }

        assert.equal(table, "payment_intents");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    const claimed = await repositories.paymentIntents.claimPaymentApproval(
      "pay_123",
      "2026-07-02T14:40:00.000Z",
    );

    assert.equal(claimed, true);
    assert.deepEqual(query.updated, {
      status: "APPROVED",
      approved_at: "2026-07-02T14:40:00.000Z",
    });
    assert.deepEqual(query.calls, [
      [
        "update",
        [
          {
            status: "APPROVED",
            approved_at: "2026-07-02T14:40:00.000Z",
          },
        ],
      ],
      ["eq", ["id", "pay_123"]],
      ["eq", ["status", "AWAITING_APPROVAL"]],
      ["select", ["id"]],
      ["maybeSingle", []],
    ]);
    assert.deepEqual(eventQuery.inserted, [
      {
        payment_intent_id: "pay_123",
        event_type: "PAYMENT_APPROVED",
        message: "Exact approval phrase accepted.",
        metadata: {
          approvedAt: "2026-07-02T14:40:00.000Z",
        },
      },
    ]);
  });

  it("returns false when payment approval was already claimed", async () => {
    const query = new FakePaymentIntentQuery();
    query.maybeSingleData = null;
    const eventQuery = new FakePaymentEventQuery();
    const client = {
      from(table: string) {
        if (table === "payment_events") {
          return eventQuery;
        }

        assert.equal(table, "payment_intents");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    const claimed = await repositories.paymentIntents.claimPaymentApproval(
      "pay_123",
      "2026-07-02T14:40:00.000Z",
    );

    assert.equal(claimed, false);
    assert.deepEqual(eventQuery.inserted, []);
  });

  it("marks a payment intent failed", async () => {
    const query = new FakePaymentIntentQuery();
    const eventQuery = new FakePaymentEventQuery();
    const client = {
      from(table: string) {
        if (table === "payment_events") {
          return eventQuery;
        }

        assert.equal(table, "payment_intents");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    await repositories.paymentIntents.markPaymentFailed("pay_123", "EXECUTION_FAILED", "RPC failed");

    assert.deepEqual(query.updated, {
      status: "FAILED",
      error_code: "EXECUTION_FAILED",
      error_message: "RPC failed",
    });
    assert.deepEqual(eventQuery.inserted, [
      {
        payment_intent_id: "pay_123",
        event_type: "PAYMENT_FAILED",
        message: "RPC failed",
        metadata: {
          errorCode: "EXECUTION_FAILED",
        },
      },
    ]);
  });

  it("marks a payment intent expired", async () => {
    const query = new FakePaymentIntentQuery();
    const eventQuery = new FakePaymentEventQuery();
    const client = {
      from(table: string) {
        if (table === "payment_events") {
          return eventQuery;
        }

        assert.equal(table, "payment_intents");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    await repositories.paymentIntents.markPaymentExpired("pay_123");

    assert.deepEqual(query.updated, {
      status: "EXPIRED",
      error_code: "DEADLINE_EXPIRED",
      error_message: "Payment approval deadline expired.",
    });
    assert.deepEqual(eventQuery.inserted, [
      {
        payment_intent_id: "pay_123",
        event_type: "PAYMENT_EXPIRED",
        message: "Payment approval deadline expired.",
        metadata: {
          errorCode: "DEADLINE_EXPIRED",
        },
      },
    ]);
  });

  it("marks a payment intent completed with destination transaction hash", async () => {
    const query = new FakePaymentIntentQuery();
    const eventQuery = new FakePaymentEventQuery();
    const client = {
      from(table: string) {
        if (table === "payment_events") {
          return eventQuery;
        }

        assert.equal(table, "payment_intents");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    await repositories.paymentIntents.markPaymentCompleted(
      "pay_123",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "2026-07-02T14:43:00.000Z",
    );

    assert.deepEqual(query.updated, {
      status: "COMPLETED",
      destination_tx_hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      completed_at: "2026-07-02T14:43:00.000Z",
    });
    assert.deepEqual(eventQuery.inserted, [
      {
        payment_intent_id: "pay_123",
        event_type: "PAYMENT_COMPLETED",
        message: "Payment completed.",
        metadata: {
          destinationTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          completedAt: "2026-07-02T14:43:00.000Z",
        },
      },
    ]);
  });

  it("lists latest payment intents by creation time", async () => {
    const query = new FakePaymentIntentListQuery();
    query.data = [
      {
        id: "pay_123",
        account_address: "0x3333333333333333333333333333333333333333",
        owner_address: "0x2222222222222222222222222222222222222222",
        status: "EXECUTING",
        payment_type: "WALLET_PAYMENT",
        source_chain_id: 196,
        destination_chain_id: 8453,
        source_token_address: "0x5555555555555555555555555555555555555555",
        source_token_symbol: "USDT0",
        destination_token_address: "0x6666666666666666666666666666666666666666",
        destination_token_symbol: "USDC",
        recipient_address: "0x1111111111111111111111111111111111111111",
        amount_out: "10",
        max_amount_in: "10.18",
        max_native_fee: "0",
        route_provider: "LI.FI",
        route_target: "0x7777777777777777777777777777777777777777",
        route_calldata: "0x1234",
        route_calldata_hash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
        route_summary: "Swap and bridge.",
        estimated_fee: "0.12",
        estimated_eta_seconds: 120,
        nonce: "42",
        deadline: "2026-07-02T14:45:00.000Z",
        purpose: "design bounty",
        approval_phrase: "APPROVE pay_123",
        approved_at: "2026-07-02T14:40:00.000Z",
        source_tx_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        destination_tx_hash: null,
        lifi_tracking_id: null,
        error_code: null,
        error_message: null,
        created_at: "2026-07-02T14:30:00.000Z",
      },
    ];
    const client = {
      from(table: string) {
        assert.equal(table, "payment_intents");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    const intents = await repositories.paymentIntents.listPaymentIntents({ limit: 5 });

    assert.equal(intents.length, 1);
    assert.equal(intents[0].id, "pay_123");
    assert.equal(intents[0].createdAt, "2026-07-02T14:30:00.000Z");
    assert.deepEqual(query.calls, [
      ["select", ["*"]],
      ["order", ["created_at", { ascending: false }]],
      ["limit", [5]],
      ["then", []],
    ]);
  });

  it("lists payment events for an intent by creation time", async () => {
    const query = new FakePaymentEventQuery();
    query.data = [
      {
        id: "event_1",
        payment_intent_id: "pay_123",
        event_type: "PAYMENT_EXECUTING",
        message: "Payment execution started.",
        metadata: {
          sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        created_at: "2026-07-02T14:40:00.000Z",
      },
      {
        id: "event_0",
        payment_intent_id: "pay_123",
        event_type: "PAYMENT_CREATED",
        message: null,
        metadata: {},
        created_at: "2026-07-02T14:30:00.000Z",
      },
    ];
    const client = {
      from(table: string) {
        assert.equal(table, "payment_events");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    const events = await repositories.paymentEvents.listPaymentEvents({ paymentIntentId: "pay_123", limit: 2 });

    assert.deepEqual(events, [
      {
        id: "event_1",
        paymentIntentId: "pay_123",
        eventType: "PAYMENT_EXECUTING",
        message: "Payment execution started.",
        metadata: {
          sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        createdAt: "2026-07-02T14:40:00.000Z",
      },
      {
        id: "event_0",
        paymentIntentId: "pay_123",
        eventType: "PAYMENT_CREATED",
        message: undefined,
        metadata: {},
        createdAt: "2026-07-02T14:30:00.000Z",
      },
    ]);
    assert.deepEqual(query.calls, [
      ["select", ["*"]],
      ["eq", ["payment_intent_id", "pay_123"]],
      ["order", ["created_at", { ascending: false }]],
      ["limit", [2]],
      ["then", []],
    ]);
  });

  it("throws useful errors from Supabase failures", async () => {
    const client = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({ data: null, error: { message: "permission denied" } });
          },
        };
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);

    await assert.rejects(() => repositories.wallets.getActiveWallet(), /Failed to load active AgentPay wallet/);
  });

  it("maps setup intents to setup_intents insert rows", async () => {
    const query = new FakeSetupIntentQuery();
    const client = {
      from(table: string) {
        assert.equal(table, "setup_intents");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    await repositories.setupIntents.createSetupIntent({
      id: "setup_123",
      ownerAddress: "0x2222222222222222222222222222222222222222",
      executorAddress: "0x4444444444444444444444444444444444444444",
      messageToSign: "AgentPay wallet setup",
      status: "PENDING",
      expiresAt: "2026-07-03T04:15:00.000Z",
      homeChainId: 1952,
    });

    assert.deepEqual(query.inserted, {
      id: "setup_123",
      owner_address: "0x2222222222222222222222222222222222222222",
      executor_address: "0x4444444444444444444444444444444444444444",
      message_to_sign: "AgentPay wallet setup",
      status: "PENDING",
      expires_at: "2026-07-03T04:15:00.000Z",
      home_chain_id: 1952,
    });
  });

  it("loads setup intent by id from setup_intents", async () => {
    const query = new FakeSetupIntentQuery();
    const client = {
      from(table: string) {
        assert.equal(table, "setup_intents");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    const intent = await repositories.setupIntents.getSetupIntent("setup_123");

    assert.equal(intent?.id, "setup_123");
    assert.equal(intent?.status, "COMPLETED");
    assert.equal(intent?.accountAddress, "0x3333333333333333333333333333333333333333");
    assert.deepEqual(query.calls, [
      ["select", ["*"]],
      ["eq", ["id", "setup_123"]],
      ["maybeSingle", []],
    ]);
  });

  it("updates setup intent lifecycle states", async () => {
    const query = new FakeSetupIntentQuery();
    const client = {
      from(table: string) {
        assert.equal(table, "setup_intents");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    await repositories.setupIntents.markSetupSigned(
      "setup_123",
      "0x2222222222222222222222222222222222222222",
      "0xaaaaaaaa",
    );

    assert.deepEqual(query.updated, {
      status: "SIGNED",
      owner_address: "0x2222222222222222222222222222222222222222",
      signature: "0xaaaaaaaa",
    });

    await repositories.setupIntents.markSetupCompleted(
      "setup_123",
      "0x3333333333333333333333333333333333333333",
      "2026-07-03T04:02:00.000Z",
    );

    assert.deepEqual(query.updated, {
      status: "COMPLETED",
      account_address: "0x3333333333333333333333333333333333333333",
      completed_at: "2026-07-03T04:02:00.000Z",
    });
  });

  it("creates an agent wallet row", async () => {
    const query = new FakeAgentWalletMutationQuery();
    const client = {
      from(table: string) {
        assert.equal(table, "agent_wallets");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    await repositories.wallets.createAgentWallet({
      ownerAddress: "0x2222222222222222222222222222222222222222",
      accountAddress: "0x3333333333333333333333333333333333333333",
      homeChainId: 196,
      executorAddress: "0x4444444444444444444444444444444444444444",
      status: "ACTIVE",
    });

    assert.deepEqual(query.inserted, {
      owner_address: "0x2222222222222222222222222222222222222222",
      account_address: "0x3333333333333333333333333333333333333333",
      home_chain_id: 196,
      executor_address: "0x4444444444444444444444444444444444444444",
      status: "ACTIVE",
    });
  });

  it("keeps Review & Sign handoffs tenant-scoped and performs an atomic signature transition", async () => {
    const reviewRow = {
      id: "review_123",
      payment_intent_id: "pay_123",
      tenant_id: "tenant_a",
      owner_address: "0x2222222222222222222222222222222222222222",
      account_address: "0x3333333333333333333333333333333333333333",
      source_chain_id: 196,
      authorization_hash: `0x${"a".repeat(64)}`,
      token_digest: `0x${"b".repeat(64)}`,
      status: "PENDING",
      signature: null,
      created_at: "2026-07-12T23:00:00.000Z",
      expires_at: "2026-07-13T00:00:00.000Z",
      signed_at: null,
    };
    const reviewQuery = new FakePaymentReviewQuery();
    reviewQuery.maybeSingleData = reviewRow;
    const events = new FakePaymentEventQuery();
    const client = {
      from(table: string) {
        if (table === "payment_review_handoffs") return reviewQuery;
        if (table === "payment_events") return events;
        throw new Error(`Unexpected table ${table}`);
      },
    };
    const context = createSessionContext({
      sessionId: "session_review",
      tenantId: "tenant_a",
      ownerAddress: reviewRow.owner_address,
      accountAddress: reviewRow.account_address,
      homeChainId: 196,
      audience: "https://wallet.agentpay.site/mcp",
      environment: "staging",
      scopes: ["payment:review"],
      authEpoch: 0,
      issuedAt: "2026-07-12T22:00:00.000Z",
      expiresAt: "2026-07-13T01:00:00.000Z",
    });
    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient, context);
    const handoff = await repositories.paymentReviews.getPaymentReviewHandoffByTokenDigest(reviewRow.token_digest);
    assert.equal(handoff?.tenantId, "tenant_a");
    assert.ok(reviewQuery.calls.some(([name, args]) => name === "eq" && args[0] === "tenant_id" && args[1] === "tenant_a"));

    const result = await repositories.paymentReviews.attachPaymentReviewSignature({
      tokenDigest: reviewRow.token_digest,
      signature: `0x${"c".repeat(130)}`,
      signedAt: "2026-07-12T23:30:00.000Z",
    });
    assert.equal(result.status, "SIGNED");
    assert.deepEqual(reviewQuery.updated, {
      status: "SIGNED",
      signature: `0x${"c".repeat(130)}`,
      signed_at: "2026-07-12T23:30:00.000Z",
    });
    assert.ok(reviewQuery.calls.some(([name]) => name === "gt"));
    assert.equal(events.inserted.length, 0, "database triggers own atomic Review & Sign audit events");
  });

  it("recovers a concurrent identical signature by token digest after losing the atomic update", async () => {
    const signature = `0x${"c".repeat(130)}`;
    const signedRow = {
      id: "review_race",
      payment_intent_id: "pay_race",
      tenant_id: "tenant_a",
      owner_address: "0x2222222222222222222222222222222222222222",
      account_address: "0x3333333333333333333333333333333333333333",
      source_chain_id: 196,
      authorization_hash: `0x${"a".repeat(64)}`,
      token_digest: `0x${"b".repeat(64)}`,
      status: "SIGNED",
      signature,
      created_at: "2026-07-12T23:00:00.000Z",
      expires_at: "2026-07-13T00:00:00.000Z",
      signed_at: "2026-07-12T23:30:00.000Z",
    };
    const reviewQuery = new FakePaymentReviewQuery();
    reviewQuery.maybeSingleDataQueue = [null, signedRow];
    const client = {
      from(table: string) {
        if (table === "payment_review_handoffs") return reviewQuery;
        if (table === "payment_events") return new FakePaymentEventQuery();
        throw new Error(`Unexpected table ${table}`);
      },
    };
    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);

    const result = await repositories.paymentReviews.attachPaymentReviewSignature({
      tokenDigest: signedRow.token_digest,
      signature,
      signedAt: "2026-07-12T23:30:01.000Z",
    });

    assert.equal(result.status, "ALREADY_SIGNED");
    assert.equal(
      reviewQuery.calls.filter(([name, args]) => name === "eq" && args[0] === "token_digest").length,
      2,
    );
    assert.equal(
      reviewQuery.calls.some(([name, args]) => name === "eq" && args[0] === "payment_intent_id"),
      false,
    );
  });

  it("loads the operator-seeded singleton runtime environment identity", async () => {
    const identityRow = {
      id: 1,
      environment: "production",
      chain_id: 196,
      caip2: "eip155:196",
      supabase_project_ref: "abcdefghijklmnopqrst",
      migration_head: "20260713140000_runtime_environment_identity",
      release_commit: null,
      manifest_sha256: "a".repeat(64),
      account_version: "v2",
      account_address: null,
      deployment_tx_hash: null,
      creation_bytecode_hash: `0x${"b".repeat(64)}`,
      runtime_bytecode_hash: null,
      abi_sha256: null,
      owner_address: null,
      executor_address: null,
      deployer_address: null,
      eip712_verifying_contract: null,
      token_address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      token_code_hash: `0x${"c".repeat(64)}`,
      token_decimals: 6,
      x402_network: "eip155:196",
      x402_asset: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      x402_price: "$0.01",
      x402_price_atomic: "10000",
      x402_sync_settle: true,
      x402_enabled: false,
      pay_to_address: null,
      facilitator_ref: null,
      public_origin: null,
      execution_mode: "OFF",
      status: "SHADOW_ONLY",
    } as const;
    const query = {
      select() { return this; },
      eq() { return this; },
      maybeSingle() { return Promise.resolve({ data: identityRow, error: null }); },
    };
    const client = {
      from(table: string) {
        assert.equal(table, "runtime_environment_identity");
        return query;
      },
    };

    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    const identity = await repositories.runtimeEnvironment.getIdentity();
    assert.equal(identity?.environment, "production");
    assert.equal(identity?.chainId, 196);
    assert.equal(identity?.executionMode, "OFF");
    assert.equal(identity?.status, "SHADOW_ONLY");
  });

  it("persists paid execution lifecycle bindings and transitions", async () => {
    const query = new FakePaidExecutionLifecycleQuery();
    const client = {
      from(table: string) {
        assert.equal(table, "paid_execution_lifecycles");
        return query;
      },
    };
    const repositories = createSupabaseAgentPayRepositories(client as unknown as AgentPaySupabaseClient);
    const input = {
      id: "11111111-1111-4111-8111-111111111111",
      tenantId: "22222222-2222-4222-8222-222222222222",
      paymentIdentifier: "pay_identifier_123456",
      paymentPayloadHash: "a".repeat(64),
      paymentRequirementsHash: "b".repeat(64),
      requestHash: "c".repeat(64),
      toolName: "execute_payment" as const,
      paymentIntentId: "pay_123",
      argumentsHash: "d".repeat(64),
      authorizationHash: `0x${"e".repeat(64)}`,
      environment: "staging" as const,
      createdAt: "2026-07-13T00:00:00.000Z",
    };

    const claim = await repositories.paidExecutionLifecycle.claim(input);
    assert.equal(claim.disposition, "CLAIMED");
    assert.deepEqual(query.inserted, {
      id: input.id,
      tenant_id: input.tenantId,
      idempotency_key: createPaidExecutionIdempotencyKey({
        paymentIdentifier: input.paymentIdentifier,
        paymentPayloadHash: input.paymentPayloadHash,
        tenantId: input.tenantId,
      }),
      payment_identifier: input.paymentIdentifier,
      payment_payload_hash: input.paymentPayloadHash,
      payment_requirements_hash: input.paymentRequirementsHash,
      request_hash: input.requestHash,
      tool_name: "execute_payment",
      payment_intent_id: input.paymentIntentId,
      arguments_hash: input.argumentsHash,
      authorization_hash: input.authorizationHash,
      environment: input.environment,
      status: "CLAIMED",
      fee_status: "ACCEPTED",
      execution_status: "NOT_QUEUED",
      refund_status: "NOT_REQUIRED",
      created_at: input.createdAt,
      updated_at: input.createdAt,
    });

    query.maybeSingleData = {
      ...query.inserted,
      status: "SETTLED",
      fee_status: "SETTLED",
      settlement_tx_hash: `0x${"1".repeat(64)}`,
      settlement_headers: { "PAYMENT-RESPONSE": "receipt" },
      response_status: null,
      response_headers: null,
      response_body_base64: null,
      execution_tx_hash: null,
      error_code: null,
      error_message: null,
      settled_at: "2026-07-13T00:00:01.000Z",
      completed_at: null,
    };
    const settled = await repositories.paidExecutionLifecycle.markSettled(input.id, {
      transaction: `0x${"1".repeat(64)}`,
      headers: { "PAYMENT-RESPONSE": "receipt" },
      at: "2026-07-13T00:00:01.000Z",
    });
    assert.equal(settled.status, "SETTLED");
    assert.equal((query.updated as Record<string, unknown>).status, "SETTLED");
    assert.equal((query.updated as Record<string, unknown>).settlement_tx_hash, `0x${"1".repeat(64)}`);
  });
});

describe("toPaymentIntentRow", () => {
  it("omits undefined optional values", () => {
    const row = toPaymentIntentRow({
      id: "pay_123",
      accountAddress: "0x3333333333333333333333333333333333333333",
      ownerAddress: "0x2222222222222222222222222222222222222222",
      status: "AWAITING_APPROVAL",
      paymentType: "WALLET_PAYMENT",
      sourceChainId: 196,
      destinationChainId: 8453,
      sourceTokenAddress: "0x5555555555555555555555555555555555555555",
      sourceTokenSymbol: "USDT0",
      destinationTokenAddress: "0x6666666666666666666666666666666666666666",
      destinationTokenSymbol: "USDC",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountOut: "10",
      minAmountOut: "9.8",
      maxAmountIn: "10.18",
      maxNativeFee: "0",
      nativeValue: "0",
      routeProvider: "LI.FI",
      routeTarget: "0x7777777777777777777777777777777777777777",
      routeCalldata: "0x1234",
      routeCalldataHash: "0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432",
      routeSummary: "Swap and bridge.",
      nonce: "42",
      deadline: "2026-07-02T14:45:00.000Z",
      purpose: "design bounty",
      approvalPhrase: "APPROVE pay_123",
    });

    assert.equal("estimated_fee" in row, false);
    assert.equal("estimated_eta_seconds" in row, false);
    assert.equal(row.min_amount_out, "9.8");
    assert.equal(row.native_value, "0");
  });
});
