import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  ProductionSetupStoreError,
  createProductionSetupWebStoreFromConfig,
  createProductionSetupWorkerStoreFromConfig,
  type ScopedProductionSetupClient,
} from "./production-setup-supabase.ts";

function token(role: string, expiresAt: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, exp: expiresAt })}.signature`;
}

function clientReturning(dataByRpc: Record<string, unknown>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: ScopedProductionSetupClient = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: dataByRpc[name] ?? null, error: null };
    },
  };
  return { client, calls };
}

const nowUnix = 1_800_000_000;
const future = nowUnix + 3_600;
const baseConfig = { supabaseUrl: "https://production.supabase.co", nowUnix, minimumRemainingSeconds: 900 };
const rateLimit = { windowSeconds: 60, maxRequests: 20 };
const sponsorPolicy = {
  maxDeploymentsPerDay: 10,
  maxGasPerDeployment: "5000000",
  maxNativeCostPerDayWei: "1000000000000000000",
  maxPending: 4,
};

describe("scoped production setup Supabase adapters", () => {
  it("constructs exact RPC-only web and worker surfaces with non-persistent auth", () => {
    const webMock = clientReturning({});
    const workerMock = clientReturning({});
    const options: unknown[] = [];
    const web = createProductionSetupWebStoreFromConfig({
      ...baseConfig,
      token: token("agentpay_setup_web", future),
      rateLimit,
      clientFactory: (_url, _token, config) => {
        options.push(config);
        return webMock.client;
      },
    });
    const worker = createProductionSetupWorkerStoreFromConfig({
      ...baseConfig,
      token: token("agentpay_setup_worker", future),
      sponsorPolicy,
      clientFactory: (_url, _token, config) => {
        options.push(config);
        return workerMock.client;
      },
    });

    assert.deepEqual(Object.keys(web).sort(), ["admit", "challenge", "prune", "status"]);
    assert.deepEqual(Object.keys(worker).sort(), [
      "claim",
      "finalize",
      "markBroadcastResult",
      "markManualReview",
      "persistSignedTransaction",
      "recordReceipt",
      "reserve",
    ]);
    for (const config of options) {
      assert.deepEqual(config, { auth: { autoRefreshToken: false, persistSession: false } });
    }
  });

  it("rejects service-role, wrong-role, short-lived, and overlong scoped tokens", () => {
    const clientFactory = () => clientReturning({}).client;
    for (const [role, expiresAt] of [
      ["service_role", future],
      ["agentpay_setup_worker", future],
      ["agentpay_setup_web", nowUnix + 899],
      ["agentpay_setup_web", nowUnix + 7_201],
    ] as const) {
      assert.throws(
        () => createProductionSetupWebStoreFromConfig({
          ...baseConfig,
          token: token(role, expiresAt),
          rateLimit,
          maximumRemainingSeconds: 7_200,
          clientFactory,
        }),
        (error: unknown) => error instanceof ProductionSetupStoreError && error.code === "SETUP_SCOPED_TOKEN_INVALID",
      );
    }
  });

  it("maps strict web RPC responses without returning the owner setup signature", async () => {
    const { client, calls } = clientReturning({
      create_production_setup_challenge: {
        disposition: "CREATED",
        setupIntentId: "setup-production-adapter-0001",
        expiresAt: "2026-07-17T05:15:00.000Z",
      },
      consume_production_setup_admission: {
        disposition: "ADMITTED",
        setupIntentId: "setup-production-adapter-0001",
        jobId: "00000000-0000-4000-8000-000000000001",
      },
      read_production_setup_status: {
        setupIntentId: "setup-production-adapter-0001",
        status: "SETUP_PENDING",
        predictedAccount: "0x5555555555555555555555555555555555555555",
        createdAt: "2026-07-17T05:00:00.000Z",
        updatedAt: "2026-07-17T05:00:00.000Z",
      },
      prune_expired_production_setups: { expiredSetups: 1, deletedRateBuckets: 2 },
    });
    const web = createProductionSetupWebStoreFromConfig({
      ...baseConfig,
      token: token("agentpay_setup_web", future),
      rateLimit,
      clientFactory: () => client,
    });
    const challengeResult = await web.challenge({ marker: "challenge" } as never);
    const admission = await web.admit({ capabilityDigest: "a".repeat(64), ownerSetupSignature: `0x${"12".repeat(65)}`, at: "2026-07-17T05:00:00.000Z" });
    const status = await web.status({ capabilityDigest: "a".repeat(64), at: "2026-07-17T05:00:00.000Z" });
    const pruned = await web.prune({ at: "2026-07-17T05:00:00.000Z" });
    assert.equal(challengeResult.disposition, "CREATED");
    assert.equal(admission.disposition, "ADMITTED");
    assert.equal(status.status, "SETUP_PENDING");
    assert.deepEqual(pruned, { expiredSetups: 1, deletedRateBuckets: 2 });
    assert.ok(!JSON.stringify([challengeResult, admission, status]).includes("ownerSetupSignature"));
    assert.deepEqual(calls.map((call) => call.name), [
      "create_production_setup_challenge",
      "consume_production_setup_admission",
      "read_production_setup_status",
      "prune_expired_production_setups",
    ]);
    assert.equal(calls[0].args.p_rate_limit_window_seconds, rateLimit.windowSeconds);
    assert.equal(calls[0].args.p_rate_limit_max_requests, rateLimit.maxRequests);
  });

  it("returns setup signature only from worker claim and maps RPC errors to stable codes", async () => {
    const { client, calls } = clientReturning({
      claim_setup_deployment_job: {
        disposition: "CLAIMED",
        jobId: "00000000-0000-4000-8000-000000000001",
        setupIntentId: "setup-production-adapter-0001",
        tenantId: "00000000-0000-4000-8000-000000000002",
        fencingToken: "00000000-0000-4000-8000-000000000003",
        leaseUntil: "2026-07-17T05:02:00.000Z",
        ownerSetupSignature: `0x${"12".repeat(65)}`,
        ownerAddress: "0x1111111111111111111111111111111111111111",
        executorAddress: "0x2222222222222222222222222222222222222222",
        homeChainId: 196,
        deploymentNonce: `0x${"1".repeat(64)}`,
        manifestSha256: `0x${"2".repeat(64)}`,
        factoryAddress: "0x3333333333333333333333333333333333333333",
        factoryRuntimeCodeHash: `0x${"3".repeat(64)}`,
        deploymentSalt: `0x${"4".repeat(64)}`,
        predictedAccount: "0x5555555555555555555555555555555555555555",
        accountCreationCodeHash: `0x${"5".repeat(64)}`,
        accountRuntimeCodeHash: `0x${"6".repeat(64)}`,
        authorizationHash: `0x${"7".repeat(64)}`,
        expiresAt: "2026-07-17T05:15:00.000Z",
      },
    });
    const worker = createProductionSetupWorkerStoreFromConfig({
      ...baseConfig,
      token: token("agentpay_setup_worker", future),
      sponsorPolicy,
      clientFactory: () => client,
    });
    const claim = await worker.claim({ workerId: "worker-1", at: "2026-07-17T05:00:00.000Z", leaseSeconds: 120 });
    assert.equal(claim?.ownerSetupSignature, `0x${"12".repeat(65)}`);
    assert.equal(calls[0].name, "claim_setup_deployment_job");

    const failingClient: ScopedProductionSetupClient = {
      async rpc() {
        return { data: null, error: { message: "relation secret_table leaked through SQL" } };
      },
    };
    const failingWorker = createProductionSetupWorkerStoreFromConfig({
      ...baseConfig,
      token: token("agentpay_setup_worker", future),
      sponsorPolicy,
      clientFactory: () => failingClient,
    });
    await assert.rejects(
      failingWorker.claim({ workerId: "worker-1", at: "2026-07-17T05:00:00.000Z", leaseSeconds: 120 }),
      (error: unknown) =>
        error instanceof ProductionSetupStoreError
        && error.code === "SETUP_STORE_UNAVAILABLE"
        && !error.message.includes("secret_table"),
    );
  });

  it("maps every worker transition to the exact scoped RPC and pinned sponsor limits", async () => {
    const jobId = "00000000-0000-4000-8000-000000000001";
    const tenantId = "00000000-0000-4000-8000-000000000002";
    const fence = "00000000-0000-4000-8000-000000000003";
    const txHash = `0x${"8".repeat(64)}`;
    const { client, calls } = clientReturning({
      reserve_setup_sponsor_budget: { disposition: "RESERVED", jobId, dayKey: "2026-07-17" },
      persist_setup_signed_transaction: { disposition: "SIGNED", jobId, transactionHash: txHash },
      mark_setup_broadcast_result: { disposition: "BROADCAST", jobId, status: "BROADCAST" },
      record_setup_receipt: { disposition: "RECORDED", jobId, status: "CONFIRMING" },
      finalize_verified_setup_wallet: {
        disposition: "COMPLETED",
        jobId,
        tenantId,
        accountAddress: "0x5555555555555555555555555555555555555555",
      },
      mark_setup_manual_review: { disposition: "MANUAL_REVIEW", jobId },
    });
    const worker = createProductionSetupWorkerStoreFromConfig({
      ...baseConfig,
      token: token("agentpay_setup_worker", future),
      sponsorPolicy,
      clientFactory: () => client,
    });
    const common = { jobId, fencingToken: fence, at: "2026-07-17T05:00:00.000Z" };
    await worker.reserve({
      ...common,
      deployerAddress: "0x4444444444444444444444444444444444444444",
      deployerNonce: "7",
      gasLimit: "1000000",
      nativeCostWei: "1000",
    });
    await worker.persistSignedTransaction({
      ...common,
      rawTransaction: { ciphertext: "cipher", iv: "iv", tag: "tag", hash: "b".repeat(64) },
      transactionHash: txHash,
    });
    await worker.markBroadcastResult({ ...common, result: "BROADCAST" });
    await worker.recordReceipt({
      ...common,
      transactionHash: txHash,
      receiptStatus: 1,
      receiptBlockNumber: "12345",
    });
    await worker.finalize(common);
    await worker.markManualReview({ ...common, publicCode: "SETUP_RPC_AMBIGUOUS" });

    assert.deepEqual(calls.map((call) => call.name), [
      "reserve_setup_sponsor_budget",
      "persist_setup_signed_transaction",
      "mark_setup_broadcast_result",
      "record_setup_receipt",
      "finalize_verified_setup_wallet",
      "mark_setup_manual_review",
    ]);
    assert.equal(calls[0].args.p_max_deployments_per_day, sponsorPolicy.maxDeploymentsPerDay);
    assert.equal(calls[0].args.p_max_native_cost_per_day_wei, sponsorPolicy.maxNativeCostPerDayWei);
  });

  it("never performs direct table access", async () => {
    const source = await readFile(new URL("./production-setup-supabase.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /\.from\s*\(/);
  });
});
