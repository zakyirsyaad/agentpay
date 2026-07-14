import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import type { PaymentIntentRecord } from "@agentpay-ai/shared";

import {
  assertProductionExecutionAllowed,
  computeManifestSha256,
  evaluateProductionReadiness,
  validateProductionEnvironment,
  type RuntimeEnvironmentIdentity,
} from "./production-readiness.ts";

const baseManifest = JSON.parse(
  await readFile(new URL("../../../../ops/manifests/xlayer-mainnet.shadow.json", import.meta.url), "utf8"),
) as Record<string, any>;

function productionEnv(): Record<string, string> {
  return {
    AGENTPAY_ENVIRONMENT: "production",
    AGENTPAY_HOME_CHAIN_ID: "196",
    AGENTPAY_ACCOUNT_VERSION: "v2",
    XLAYER_MAINNET_RPC_URL: "https://rpc.xlayer.tech/terigon",
    SUPABASE_PRODUCTION_URL: "https://abcdefghijklmnopqrst.supabase.co",
    SUPABASE_PRODUCTION_SERVICE_ROLE_KEY: "service-role-key",
    DIRECT_URL_PRODUCTION: "postgresql://production.example.invalid/postgres",
    AGENTPAY_RAW_TX_ENCRYPTION_KEY: "a".repeat(64),
    AGENTPAY_SESSION_HASH_KEY: "s".repeat(64),
    AGENTPAY_REVIEW_TOKEN_SECRET: "r".repeat(64),
  };
}

function readyManifest(): Record<string, any> {
  const manifest = structuredClone(baseManifest);
  const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const owner = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const executor = `0x${"c".repeat(40)}`;
  const deployer = `0x${"d".repeat(40)}`;
  const runtimeHash = `0x${"11".repeat(32)}`;
  const abiHash = "22".repeat(32);

  manifest.status = "READY";
  manifest.executionMode = "PUBLIC";
  manifest.database.projectRef = "abcdefghijklmnopqrst";
  manifest.release.commit = "a".repeat(40);
  manifest.release.runtimeBytecodeKeccak256 = runtimeHash;
  manifest.release.abiSha256 = abiHash;
  manifest.contract.address = address;
  manifest.contract.deploymentTxHash = `0x${"44".repeat(32)}`;
  manifest.contract.runtimeBytecodeHash = runtimeHash;
  manifest.contract.ownerAddress = owner;
  manifest.contract.executorAddress = executor;
  manifest.contract.deployerAddress = deployer;
  manifest.contract.domain.verifyingContract = address;
  manifest.domains.publicOrigin = "https://wallet.agentpay.site";
  manifest.x402.enabled = true;
  return manifest;
}

function identityFor(manifest: Record<string, any>): RuntimeEnvironmentIdentity {
  return {
    id: 1,
    environment: "production",
    chainId: 196,
    caip2: "eip155:196",
    supabaseProjectRef: "abcdefghijklmnopqrst",
    migrationHead: manifest.database.migrationHead,
    releaseCommit: manifest.release.commit,
    manifestSha256: computeManifestSha256(manifest),
    accountVersion: "v2",
    accountAddress: manifest.contract.address,
    deploymentTxHash: manifest.contract.deploymentTxHash,
    creationBytecodeHash: manifest.contract.creationBytecodeHash,
    runtimeBytecodeHash: manifest.contract.runtimeBytecodeHash,
    abiSha256: manifest.release.abiSha256,
    ownerAddress: manifest.contract.ownerAddress,
    executorAddress: manifest.contract.executorAddress,
    deployerAddress: manifest.contract.deployerAddress,
    eip712VerifyingContract: manifest.contract.domain.verifyingContract,
    tokenAddress: manifest.token.address,
    tokenCodeHash: manifest.token.codeHash,
    tokenDecimals: manifest.token.decimals,
    x402Network: manifest.x402.network,
    x402Asset: manifest.x402.tokenAddress,
    x402Price: manifest.x402.price,
    x402PriceAtomic: manifest.x402.priceAtomic,
    x402SyncSettle: manifest.x402.syncSettle,
    x402Enabled: manifest.x402.enabled,
    payToAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    facilitatorRef: "https://facilitator.example.com",
    executionMode: "PUBLIC",
    status: "READY",
  };
}

const exactPaymentConfig = {
  enabled: true,
  payTo: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  price: "$0.01",
  network: "eip155:196" as const,
  asset: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
  assetDecimals: 6,
  syncSettle: true,
  facilitatorUrl: "https://facilitator.example.com",
};

describe("production readiness gate", () => {
  it("requires explicit production aliases and rejects generic or staging boundaries", () => {
    const valid = validateProductionEnvironment(productionEnv());
    assert.equal(valid.valid, true, valid.errors.join("; "));

    const invalid = productionEnv();
    invalid.XLAYER_RPC_URL = "https://testrpc.xlayer.tech/terigon";
    invalid.XLAYER_TESTNET_RPC_URL = "https://testrpc.xlayer.tech/terigon";
    invalid.SUPABASE_URL = "https://qwywcungxmhoctmehcze.supabase.co";
    invalid.AGENTPAY_A2MCP_PAYMENT_ENABLED = "true";
    assert.equal(validateProductionEnvironment(invalid).valid, false);
    assert.match(validateProductionEnvironment(invalid).errors.join("; "), /XLAYER_RPC_URL|SUPABASE_URL|testnet/i);

  });

  it("keeps a shadow/OFF manifest unavailable for production execution", async () => {
    const result = await evaluateProductionReadiness({
      env: productionEnv(),
      manifest: structuredClone(baseManifest),
      identity: null,
      accountVerification: null,
      paymentConfig: undefined,
    });

    assert.equal(result.ready, false);
    assert.equal(result.mode, "OFF");
    assert.equal(result.executionAllowed, false);
    assert.match(result.errors.join("; "), /shadow|identity|account/i);
  });

  it("rejects a singleton identity mismatch instead of trusting process env", async () => {
    const manifest = readyManifest();
    const identity = identityFor(manifest);
    identity.manifestSha256 = "0".repeat(64);

    const result = await evaluateProductionReadiness({
      env: productionEnv(),
      manifest,
      identity,
      accountVerification: { valid: true, errors: [], checks: {} },
      paymentConfig: exactPaymentConfig,
    });

    assert.equal(result.ready, false);
    assert.match(result.errors.join("; "), /manifest.*digest|identity/i);
  });

  it("accepts a fully observed READY/PUBLIC identity and exact payment config", async () => {
    const manifest = readyManifest();
    const result = await evaluateProductionReadiness({
      env: productionEnv(),
      manifest,
      identity: identityFor(manifest),
      accountVerification: { valid: true, errors: [], checks: { account: true } },
      paymentConfig: exactPaymentConfig,
    });

    assert.equal(result.ready, true, result.errors.join("; "));
    assert.equal(result.executionAllowed, true);
    assert.equal(result.publicPaymentAllowed, true);

    const missingRawTransactionKey = productionEnv();
    delete missingRawTransactionKey.AGENTPAY_RAW_TX_ENCRYPTION_KEY;
    const missingKeyResult = await evaluateProductionReadiness({
      env: missingRawTransactionKey,
      manifest,
      identity: identityFor(manifest),
      accountVerification: { valid: true, errors: [], checks: { account: true } },
      paymentConfig: exactPaymentConfig,
    });
    assert.equal(missingKeyResult.ready, false);
    assert.match(missingKeyResult.errors.join("; "), /RAW_TX_ENCRYPTION_KEY/i);
  });

  it("keeps CANARY fail-closed until the durable admission probe passes", async () => {
    const manifest = readyManifest();
    manifest.executionMode = "CANARY";
    const identity = identityFor(manifest);
    identity.executionMode = "CANARY";

    const result = await evaluateProductionReadiness({
      env: { ...productionEnv(), AGENTPAY_EXECUTION_MODE: "CANARY" },
      manifest,
      identity,
      accountVerification: { valid: true, errors: [], checks: { account: true } },
      paymentConfig: exactPaymentConfig,
    });

    assert.equal(result.executionAllowed, false);
    assert.match(result.errors.join("; "), /durable Supabase ledger|allowlist/i);
  });

  it("allows CANARY only when the durable admission probe is explicitly green", async () => {
    const manifest = readyManifest();
    manifest.executionMode = "CANARY";
    const identity = identityFor(manifest);
    identity.executionMode = "CANARY";

    const result = await evaluateProductionReadiness({
      env: { ...productionEnv(), AGENTPAY_EXECUTION_MODE: "CANARY" },
      manifest,
      identity,
      accountVerification: { valid: true, errors: [], checks: { account: true } },
      paymentConfig: exactPaymentConfig,
      canaryAdmissionReady: true,
    });

    assert.equal(result.ready, true, result.errors.join("; "));
    assert.equal(result.executionAllowed, true);
    assert.equal(result.publicPaymentAllowed, true);
  });

  it("rejects payment drift and disallows non-direct production intents", async () => {
    const manifest = readyManifest();
    const result = await evaluateProductionReadiness({
      env: productionEnv(),
      manifest,
      identity: identityFor(manifest),
      accountVerification: { valid: true, errors: [], checks: {} },
      paymentConfig: { ...exactPaymentConfig, network: "eip155:1952", syncSettle: false },
    });
    assert.equal(result.ready, false);
    assert.match(result.errors.join("; "), /network|sync/i);

    const routeIntent = {
      id: "pay_route",
      sourceChainId: 196,
      destinationChainId: 8453,
      sourceTokenSymbol: "USDT0",
      destinationTokenSymbol: "USDC",
      sourceTokenAddress: manifest.token.address,
      destinationTokenAddress: "0x1111111111111111111111111111111111111111",
      routeProvider: "LI.FI",
    } as unknown as PaymentIntentRecord;
    assert.throws(
      () => assertProductionExecutionAllowed({ mode: "PUBLIC", environment: "production", directMainnetOnly: true }, routeIntent),
      /direct|mainnet|production/i,
    );
  });

  it("rejects an insecure custom OKX base URL", async () => {
    const result = await evaluateProductionReadiness({
      env: productionEnv(),
      manifest: readyManifest(),
      identity: identityFor(readyManifest()),
      accountVerification: { valid: true, errors: [], checks: {} },
      paymentConfig: { ...exactPaymentConfig, okxBaseUrl: "http://127.0.0.1:8080" },
    });

    assert.equal(result.ready, false);
    assert.match(result.errors.join("; "), /OKX base URL/i);
  });
});
