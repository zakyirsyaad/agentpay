import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256 } from "ethers";

import {
  MAINNET_ONBOARDING_ORIGIN,
  MAINNET_POLICY_VERSION,
  MAINNET_USDT0,
  bindVerifiedFactoryDeployment,
  buildMainnetOnboardingOffManifest,
  computeMainnetOnboardingManifestSha256,
  validateMainnetOnboardingManifest,
} from "./mainnet-onboarding-manifest.mjs";

const runtimeTemplateBytecode = `0x${"11".repeat(4)}${"00".repeat(32)}${"22".repeat(4)}`;
const accountArtifact = Object.freeze({
  bytecode: runtimeTemplateBytecode,
  immutableReferences: Object.freeze([{ start: 16, length: 20 }]),
  creationCodeHash: `0x${"a".repeat(64)}`,
  runtimeTemplateHash: keccak256(runtimeTemplateBytecode),
});

const sponsor = Object.freeze({
  deployerAddress: "0x3333333333333333333333333333333333333333",
  maxDeploymentsPerDay: 100,
  maxNativeCostPerDayWei: "1000000000000000000",
  maxGasPerDeployment: 5_000_000,
  maxPending: 5,
});

const deployment = Object.freeze({
  address: "0x1111111111111111111111111111111111111111",
  deploymentTxHash: `0x${"2".repeat(64)}`,
  deploymentBlock: 12_345_678,
  runtimeCodeHash: `0x${"3".repeat(64)}`,
  executor: "0x4444444444444444444444444444444444444444",
  usdt0: MAINNET_USDT0,
  policyVersion: MAINNET_POLICY_VERSION,
});

function offManifest() {
  return buildMainnetOnboardingOffManifest({ accountArtifact, sponsor });
}

function boundManifest() {
  return bindVerifiedFactoryDeployment({ manifest: offManifest(), deployment });
}

describe("X Layer mainnet onboarding manifest", () => {
  it("builds an immutable production OFF manifest before factory deployment", () => {
    const manifest = offManifest();
    const result = validateMainnetOnboardingManifest(manifest, { accountArtifact });

    assert.equal(result.valid, true, result.errors.join("; "));
    assert.deepEqual(manifest, {
      environment: "production",
      chainId: 196,
      setupMode: "OFF",
      onboardingOrigin: MAINNET_ONBOARDING_ORIGIN,
      factory: {
        address: null,
        deploymentTxHash: null,
        deploymentBlock: null,
        runtimeCodeHash: null,
        executor: null,
        usdt0: MAINNET_USDT0,
        policyVersion: MAINNET_POLICY_VERSION,
      },
      account: {
        creationCodeHash: accountArtifact.creationCodeHash,
        runtimeTemplateHash: accountArtifact.runtimeTemplateHash,
        immutableReferences: [{ start: 16, length: 20 }],
        routeTargets: [],
      },
      sponsor: { ...sponsor },
    });
  });

  it("binds complete verified factory evidence without enabling setup or payment execution", () => {
    const manifest = boundManifest();
    const digest = computeMainnetOnboardingManifestSha256(manifest);
    const result = validateMainnetOnboardingManifest(manifest, {
      accountArtifact,
      expectedSha256: digest,
      requireFactory: true,
    });

    assert.equal(result.valid, true, result.errors.join("; "));
    assert.equal(manifest.setupMode, "OFF");
    assert.deepEqual(manifest.factory, deployment);
    assert.match(digest, /^[a-f0-9]{64}$/);
  });

  it("uses canonical sorted-key JSON for a stable bare SHA-256 digest", () => {
    const manifest = boundManifest();
    const reordered = {
      sponsor: manifest.sponsor,
      factory: manifest.factory,
      onboardingOrigin: manifest.onboardingOrigin,
      setupMode: manifest.setupMode,
      chainId: manifest.chainId,
      environment: manifest.environment,
      account: manifest.account,
    };

    assert.equal(
      computeMainnetOnboardingManifestSha256(reordered),
      computeMainnetOnboardingManifestSha256(manifest),
    );
  });

  it("rejects chain, token, route, origin, mode, factory-evidence, and metadata drift", () => {
    const cases = [
      ["chainId", (manifest) => { manifest.chainId = 1952; }],
      ["factory.usdt0", (manifest) => { manifest.factory.usdt0 = "0x5555555555555555555555555555555555555555"; }],
      ["account.routeTargets", (manifest) => { manifest.account.routeTargets = [deployment.address]; }],
      ["onboardingOrigin", (manifest) => { manifest.onboardingOrigin = "http://onboard.agentpay.site"; }],
      ["setupMode", (manifest) => { manifest.setupMode = "ENABLED"; }],
      ["factory.deploymentTxHash", (manifest) => { manifest.factory.deploymentTxHash = null; }],
      ["factory", (manifest) => { manifest.factory.admin = sponsor.deployerAddress; }],
    ];

    for (const [expectedPath, mutate] of cases) {
      const manifest = structuredClone(boundManifest());
      mutate(manifest);
      const result = validateMainnetOnboardingManifest(manifest, { accountArtifact, requireFactory: true });
      assert.equal(result.valid, false, expectedPath);
      assert.match(result.errors.join("; "), new RegExp(expectedPath.replace(".", "\\."), "i"));
    }
  });

  it("rejects secret-like keys and any expected digest or account-artifact mismatch", () => {
    const manifest = structuredClone(boundManifest());
    manifest.sponsor.privateKey = "must-not-exist";
    let result = validateMainnetOnboardingManifest(manifest, { accountArtifact, requireFactory: true });
    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /secret|privateKey/i);

    result = validateMainnetOnboardingManifest(boundManifest(), {
      accountArtifact,
      expectedSha256: "0".repeat(64),
      requireFactory: true,
    });
    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /digest/i);

    result = validateMainnetOnboardingManifest(boundManifest(), {
      accountArtifact: { ...accountArtifact, runtimeTemplateHash: `0x${"c".repeat(64)}` },
      requireFactory: true,
    });
    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /runtimeTemplateHash/i);
  });

  it("accepts only OFF, CANARY, PUBLIC, and DRAIN setup modes", () => {
    for (const setupMode of ["OFF", "CANARY", "PUBLIC", "DRAIN"]) {
      const manifest = structuredClone(boundManifest());
      manifest.setupMode = setupMode;
      const result = validateMainnetOnboardingManifest(manifest, { accountArtifact, requireFactory: true });
      assert.equal(result.valid, true, `${setupMode}: ${result.errors.join("; ")}`);
    }
  });

  it("rejects actor collisions and malformed sponsor limits before binding", () => {
    assert.throws(
      () => bindVerifiedFactoryDeployment({
        manifest: offManifest(),
        deployment: { ...deployment, executor: sponsor.deployerAddress },
      }),
      /executor|deployer/i,
    );
    assert.throws(
      () => buildMainnetOnboardingOffManifest({
        accountArtifact,
        sponsor: { ...sponsor, maxNativeCostPerDayWei: "0" },
      }),
      /maxNativeCostPerDayWei/i,
    );
  });

  it("rejects unrecognized deployment metadata and a corrupt runtime artifact digest", () => {
    assert.throws(
      () => bindVerifiedFactoryDeployment({
        manifest: offManifest(),
        deployment: { ...deployment, admin: sponsor.deployerAddress },
      }),
      /admin|not allowed/i,
    );
    assert.throws(
      () => buildMainnetOnboardingOffManifest({
        accountArtifact: { ...accountArtifact, runtimeTemplateHash: `0x${"c".repeat(64)}` },
        sponsor,
      }),
      /runtimeTemplateHash/i,
    );
  });
});
