import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAINNET_USDT0_ADDRESS,
  buildMainnetShadowManifest,
  computeArtifactDigests,
  validateProductionEnvironmentIsolation,
  validateMainnetShadowManifest,
} from "./mainnet-shadow-manifest.mjs";

const artifactDigests = await computeArtifactDigests();

function makeManifest() {
  return buildMainnetShadowManifest({
    artifactDigests,
    generatedAt: "2026-07-13T00:00:00.000Z",
  });
}

function validate(manifest) {
  return validateMainnetShadowManifest(manifest, { artifactDigests });
}

function makeProductionEnv() {
  return {
    AGENTPAY_ENVIRONMENT: "production",
    AGENTPAY_HOME_CHAIN_ID: "196",
    AGENTPAY_ACCOUNT_VERSION: "v2",
    XLAYER_MAINNET_RPC_URL: "https://rpc.xlayer.tech/terigon",
    SUPABASE_PRODUCTION_URL: "https://production-project.supabase.co",
    DIRECT_URL_PRODUCTION: "postgresql://production.example.invalid/postgres",
  };
}

describe("X Layer mainnet shadow manifest", () => {
  it("accepts the generated production shadow in OFF mode", () => {
    const result = validate(makeManifest());
    assert.equal(result.valid, true, result.errors.join("; "));
    assert.deepEqual(makeManifest().contract.allowedTokens, [MAINNET_USDT0_ADDRESS]);
  });

  it("rejects a staging chain or RPC reference in a production manifest", () => {
    const chainDrift = makeManifest();
    chainDrift.chain.chainId = 1952;
    chainDrift.chain.caip2 = "eip155:1952";
    let result = validate(chainDrift);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /chain\.chainId/);
    assert.match(result.errors.join("; "), /chain\.caip2/);

    const rpcDrift = makeManifest();
    rpcDrift.chain.rpcEnvRef = "XLAYER_TESTNET_RPC_URL";
    rpcDrift.chain.expectedRpcHost = "testrpc.xlayer.tech";
    result = validate(rpcDrift);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /chain\.rpcEnvRef/);
    assert.match(result.errors.join("; "), /chain\.expectedRpcHost/);
  });

  it("rejects paid-gate drift from the exact mainnet x402 policy", () => {
    const manifest = makeManifest();
    manifest.x402.enabled = true;
    manifest.x402.network = "eip155:1952";
    manifest.x402.asset = "USDC";
    manifest.x402.price = "$0.02";
    manifest.x402.priceAtomic = "20000";
    manifest.x402.syncSettle = false;
    manifest.x402.toolAllowlist = ["execute_payment", "prepare_payment"];

    const result = validate(manifest);
    assert.equal(result.valid, false);
    for (const field of ["enabled", "network", "asset", "price", "priceAtomic", "syncSettle", "toolAllowlist"]) {
      assert.match(result.errors.join("; "), new RegExp(`x402\\.${field}`));
    }
  });

  it("rejects USDC or any route target in the production golden path", () => {
    const tokenDrift = makeManifest();
    tokenDrift.contract.allowedTokens = [MAINNET_USDT0_ADDRESS, "0x74b7F16337b8972027F6196A17a631aC6dE26d22"];
    const result = validate(tokenDrift);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /contract\.allowedTokens/);

    const routeDrift = makeManifest();
    routeDrift.contract.allowedRouteTargets = ["0x1111111111111111111111111111111111111111"];
    const routeResult = validate(routeDrift);
    assert.equal(routeResult.valid, false);
    assert.match(routeResult.errors.join("; "), /contract\.allowedRouteTargets/);
  });

  it("rejects release and creation-bytecode digest drift", () => {
    const manifest = makeManifest();
    manifest.release.packageLockSha256 = "0".repeat(64);
    manifest.release.creationBytecodeKeccak256 = `0x${"1".repeat(64)}`;
    manifest.contract.creationBytecodeHash = `0x${"1".repeat(64)}`;

    const result = validate(manifest);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /release\.packageLockSha256/);
    assert.match(result.errors.join("; "), /creationBytecode/);
  });

  it("keeps shadow nulls allowed but rejects an unprovisioned READY manifest", () => {
    const shadow = makeManifest();
    assert.equal(validate(shadow).valid, true);

    const ready = makeManifest();
    ready.status = "READY";
    ready.executionMode = "PUBLIC";
    const result = validate(ready);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /status/);
    assert.match(result.errors.join("; "), /executionMode/);
  });

  it("rejects secret-bearing fields and owner/executor reuse", () => {
    const manifest = makeManifest();
    manifest.database.serviceRoleKey = "should-never-be-in-a-manifest";
    manifest.contract.ownerAddress = "0x1111111111111111111111111111111111111111";
    manifest.contract.executorAddress = "0x1111111111111111111111111111111111111111";

    const result = validate(manifest);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /secret-bearing/);
    assert.match(result.errors.join("; "), /owner and executor/);
  });

  it("accepts an isolated production environment with only mainnet references", () => {
    const result = validateProductionEnvironmentIsolation(makeProductionEnv(), { manifest: makeManifest() });
    assert.equal(result.valid, true, result.errors.join("; "));
  });

  it("rejects generic, staging, or non-OFF production environment configuration", () => {
    const env = makeProductionEnv();
    env.XLAYER_RPC_URL = "https://rpc.xlayer.tech/terigon";
    env.XLAYER_TESTNET_RPC_URL = "https://testrpc.xlayer.tech/terigon";
    env.SUPABASE_URL = "https://qwywcungxmhoctmehcze.supabase.co";
    env.DIRECT_URL = "postgresql://staging.example.invalid/postgres";
    env.AGENTPAY_A2MCP_PAYMENT_ENABLED = "true";
    env.AGENTPAY_EXECUTION_MODE = "PUBLIC";

    const result = validateProductionEnvironmentIsolation(env, { manifest: makeManifest() });
    assert.equal(result.valid, false);
    for (const field of ["XLAYER_RPC_URL", "XLAYER_TESTNET_RPC_URL", "SUPABASE_URL", "DIRECT_URL", "AGENTPAY_A2MCP_PAYMENT_ENABLED", "AGENTPAY_EXECUTION_MODE"]) {
      assert.match(result.errors.join("; "), new RegExp(field));
    }
  });

  it("rejects a missing mainnet boundary and wrong production identity", () => {
    const env = makeProductionEnv();
    delete env.XLAYER_MAINNET_RPC_URL;
    env.AGENTPAY_ENVIRONMENT = "staging";
    env.AGENTPAY_HOME_CHAIN_ID = "1952";
    env.AGENTPAY_ACCOUNT_VERSION = "v1";

    const result = validateProductionEnvironmentIsolation(env);
    assert.equal(result.valid, false);
    for (const field of ["AGENTPAY_ENVIRONMENT", "AGENTPAY_HOME_CHAIN_ID", "AGENTPAY_ACCOUNT_VERSION", "XLAYER_MAINNET_RPC_URL"]) {
      assert.match(result.errors.join("; "), new RegExp(field));
    }
  });
});
