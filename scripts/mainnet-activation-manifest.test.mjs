import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { keccak256 } from "ethers";

import {
  buildMainnetActivatedManifest,
  buildMainnetCanaryManifest,
  buildMainnetDeployedManifest,
  bindMainnetActivationOnboarding,
  bindMainnetCanaryPolicy,
  computeActivationManifestSha256,
  validateMainnetActivationManifest,
} from "./mainnet-activation-manifest.mjs";
import {
  MAINNET_POLICY_VERSION,
  MAINNET_USDT0,
  bindVerifiedFactoryDeployment,
  buildMainnetOnboardingOffManifest,
  computeMainnetOnboardingManifestSha256,
} from "./mainnet-onboarding-manifest.mjs";
import { buildMainnetShadowManifest, computeArtifactDigests } from "./mainnet-shadow-manifest.mjs";

const artifactDigests = await computeArtifactDigests();
const shadowManifest = buildMainnetShadowManifest({
  artifactDigests,
  generatedAt: "2026-07-13T00:00:00.000Z",
});
const onboardingRuntimeTemplate = `0x${"11".repeat(4)}${"00".repeat(32)}${"22".repeat(4)}`;
const onboardingManifest = bindVerifiedFactoryDeployment({
  manifest: buildMainnetOnboardingOffManifest({
    accountArtifact: {
      bytecode: onboardingRuntimeTemplate,
      immutableReferences: [{ start: 16, length: 20 }],
      creationCodeHash: `0x${"a".repeat(64)}`,
      runtimeTemplateHash: keccak256(onboardingRuntimeTemplate),
    },
    sponsor: {
      deployerAddress: "0x3333333333333333333333333333333333333333",
      maxDeploymentsPerDay: 100,
      maxNativeCostPerDayWei: "1000000000000000000",
      maxGasPerDeployment: 5_000_000,
      maxPending: 5,
    },
  }),
  deployment: {
    address: "0x1111111111111111111111111111111111111111",
    deploymentTxHash: `0x${"2".repeat(64)}`,
    deploymentBlock: 12_345_678,
    runtimeCodeHash: `0x${"3".repeat(64)}`,
    executor: "0x4444444444444444444444444444444444444444",
    usdt0: MAINNET_USDT0,
    policyVersion: MAINNET_POLICY_VERSION,
  },
});

describe("X Layer mainnet activation manifest", () => {
  it("promotes the frozen shadow surface to DEPLOYED/OFF without provisioning an account", () => {
    const manifest = buildMainnetActivatedManifest({ shadowManifest });
    const result = validateMainnetActivationManifest(manifest, { artifactDigests });

    assert.equal(result.valid, true, result.errors.join("; "));
    assert.equal(manifest.status, "DEPLOYED");
    assert.equal(manifest.executionMode, "OFF");
    assert.equal(manifest.x402.enabled, false);
    assert.equal(manifest.activation.accountDeployment, "PENDING");
    assert.equal(manifest.contract.address, null);
    assert.equal(manifest.contract.domain.verifyingContract, null);
    assert.deepEqual(manifest.onboarding, {
      setupMode: "OFF",
      onboardingOrigin: "https://onboard.agentpay.site",
      manifestSha256: null,
      factoryAddress: null,
    });
    assert.match(computeActivationManifestSha256(manifest), /^[a-f0-9]{64}$/);
  });

  it("pins an independent onboarding manifest without changing payment execution mode", () => {
    const activationManifest = buildMainnetActivatedManifest({ shadowManifest });
    const bound = bindMainnetActivationOnboarding({ activationManifest, onboardingManifest });
    const result = validateMainnetActivationManifest(bound, { artifactDigests });

    assert.equal(result.valid, true, result.errors.join("; "));
    assert.equal(bound.executionMode, "OFF");
    assert.equal(bound.x402.enabled, false);
    assert.deepEqual(bound.onboarding, {
      setupMode: "OFF",
      onboardingOrigin: "https://onboard.agentpay.site",
      manifestSha256: computeMainnetOnboardingManifestSha256(onboardingManifest),
      factoryAddress: onboardingManifest.factory.address,
    });
  });

  it("rejects invalid onboarding metadata independently from payment execution", () => {
    const manifest = bindMainnetActivationOnboarding({
      activationManifest: buildMainnetActivatedManifest({ shadowManifest }),
      onboardingManifest,
    });
    manifest.onboarding.setupMode = "ENABLED";
    manifest.onboarding.manifestSha256 = "not-a-digest";

    const result = validateMainnetActivationManifest(manifest, { artifactDigests });
    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /onboarding\.setupMode/);
    assert.match(result.errors.join("; "), /onboarding\.manifestSha256/);
    assert.equal(manifest.executionMode, "OFF");
  });

  it("rejects activation drift that could silently enable execution or deployment", () => {
    const manifest = buildMainnetActivatedManifest({ shadowManifest });
    manifest.executionMode = "PUBLIC";
    manifest.contract.executorAddress = "0x1111111111111111111111111111111111111111";
    manifest.x402.enabled = true;

    const result = validateMainnetActivationManifest(manifest, { artifactDigests });
    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /executionMode/);
    assert.match(result.errors.join("; "), /executorAddress/);
    assert.match(result.errors.join("; "), /x402.enabled/);
  });

  it("preserves the artifact pins from the canonical shadow manifest", async () => {
    const source = JSON.parse(await readFile(new URL("../ops/manifests/xlayer-mainnet.shadow.json", import.meta.url), "utf8"));
    const manifest = buildMainnetActivatedManifest({ shadowManifest: source });
    assert.equal(manifest.release.packageLockSha256, source.release.packageLockSha256);
    assert.equal(manifest.release.creationBytecodeKeccak256, source.release.creationBytecodeKeccak256);
    assert.equal(manifest.contract.creationBytecodeHash, source.contract.creationBytecodeHash);
  });

  it("promotes the OFF activation surface after a verified immutable account deployment", () => {
    const activationManifest = buildMainnetActivatedManifest({ shadowManifest });
    const deployed = buildMainnetDeployedManifest({
      activationManifest,
      deployment: {
        accountAddress: "0x1111111111111111111111111111111111111111",
        deploymentTxHash: `0x${"2".repeat(64)}`,
        runtimeBytecodeHash: `0x${"3".repeat(64)}`,
        abiSha256: "4".repeat(64),
        ownerAddress: "0x4444444444444444444444444444444444444444",
        executorAddress: "0x5555555555555555555555555555555555555555",
        deployerAddress: "0x6666666666666666666666666666666666666666",
      },
    });

    const result = validateMainnetActivationManifest(deployed, { artifactDigests });

    assert.equal(result.valid, true, result.errors.join("; "));
    assert.equal(deployed.activation.accountDeployment, "DEPLOYED");
    assert.equal(deployed.executionMode, "OFF");
    assert.equal(deployed.x402.enabled, false);
    assert.equal(deployed.contract.domain.verifyingContract, deployed.contract.address);
    assert.equal(deployed.release.runtimeBytecodeKeccak256, deployed.contract.runtimeBytecodeHash);
    assert.match(computeActivationManifestSha256(deployed), /^[a-f0-9]{64}$/);
  });

  it("rejects a deployed manifest with incomplete account identity", () => {
    const activationManifest = buildMainnetActivatedManifest({ shadowManifest });
    activationManifest.activation.accountDeployment = "DEPLOYED";

    const result = validateMainnetActivationManifest(activationManifest, { artifactDigests });

    assert.equal(result.valid, false);
    assert.match(result.errors.join("; "), /contract.address/);
    assert.match(result.errors.join("; "), /release.runtimeBytecodeKeccak256/);
  });

  it("binds one tenant, payer, and self-recipient without enabling execution", () => {
    const activationManifest = buildMainnetActivatedManifest({ shadowManifest });
    const deployed = buildMainnetDeployedManifest({
      activationManifest,
      deployment: {
        accountAddress: "0x1111111111111111111111111111111111111111",
        deploymentTxHash: `0x${"2".repeat(64)}`,
        runtimeBytecodeHash: `0x${"3".repeat(64)}`,
        abiSha256: "4".repeat(64),
        ownerAddress: "0x4444444444444444444444444444444444444444",
        executorAddress: "0x5555555555555555555555555555555555555555",
        deployerAddress: "0x6666666666666666666666666666666666666666",
      },
    });

    const bound = bindMainnetCanaryPolicy({
      deployedManifest: deployed,
      tenantId: "55def02c-c219-4d98-aa56-445795c9d0ff",
      payerAddress: "0x4444444444444444444444444444444444444444",
      recipientAddress: "0x4444444444444444444444444444444444444444",
    });

    assert.equal(bound.executionMode, "OFF");
    assert.equal(bound.x402.enabled, false);
    assert.deepEqual(bound.canaryPolicy, {
      ...deployed.canaryPolicy,
      allowlistedTenantId: "55def02c-c219-4d98-aa56-445795c9d0ff",
      allowlistedOwnerAddress: "0x4444444444444444444444444444444444444444",
      allowlistedAccountAddress: "0x1111111111111111111111111111111111111111",
      payerAddress: "0x4444444444444444444444444444444444444444",
      recipientAddress: "0x4444444444444444444444444444444444444444",
    });
  });

  it("rejects malformed canary binding input", () => {
    const activationManifest = buildMainnetActivatedManifest({ shadowManifest });
    const deployed = buildMainnetDeployedManifest({
      activationManifest,
      deployment: {
        accountAddress: "0x1111111111111111111111111111111111111111",
        deploymentTxHash: `0x${"2".repeat(64)}`,
        runtimeBytecodeHash: `0x${"3".repeat(64)}`,
        abiSha256: "4".repeat(64),
        ownerAddress: "0x4444444444444444444444444444444444444444",
        executorAddress: "0x5555555555555555555555555555555555555555",
        deployerAddress: "0x6666666666666666666666666666666666666666",
      },
    });

    assert.throws(
      () => bindMainnetCanaryPolicy({
        deployedManifest: deployed,
        tenantId: "not-a-uuid",
        payerAddress: "0x4444444444444444444444444444444444444444",
        recipientAddress: "0x4444444444444444444444444444444444444444",
      }),
      /tenantId/i,
    );
  });

  it("promotes only a fully bound deployed manifest to READY/CANARY", () => {
    const activationManifest = buildMainnetActivatedManifest({ shadowManifest });
    const deployed = bindMainnetCanaryPolicy({
      deployedManifest: buildMainnetDeployedManifest({
        activationManifest,
        deployment: {
          accountAddress: "0x1111111111111111111111111111111111111111",
          deploymentTxHash: `0x${"2".repeat(64)}`,
          runtimeBytecodeHash: `0x${"3".repeat(64)}`,
          abiSha256: "4".repeat(64),
          ownerAddress: "0x4444444444444444444444444444444444444444",
          executorAddress: "0x5555555555555555555555555555555555555555",
          deployerAddress: "0x6666666666666666666666666666666666666666",
        },
      }),
      tenantId: "55def02c-c219-4d98-aa56-445795c9d0ff",
      payerAddress: "0x4444444444444444444444444444444444444444",
      recipientAddress: "0x4444444444444444444444444444444444444444",
    });

    const canary = buildMainnetCanaryManifest({
      deployedManifest: deployed,
      projectRef: "zcwsmivbgcrfyrvfptxk",
      releaseCommit: "a".repeat(40),
      publicOrigin: "https://mcp.agentpay.site",
    });

    assert.equal(canary.status, "READY");
    assert.equal(canary.executionMode, "CANARY");
    assert.equal(canary.x402.enabled, true);
    assert.equal(canary.activation.executionEnabled, true);
    assert.equal(canary.database.projectRef, "zcwsmivbgcrfyrvfptxk");
    assert.equal(canary.release.commit, "a".repeat(40));
    assert.equal(canary.domains.publicOrigin, "https://mcp.agentpay.site");
    assert.equal(canary.canaryPolicy.allowlistedTenantId, "55def02c-c219-4d98-aa56-445795c9d0ff");
  });

  it("refuses READY/CANARY promotion without immutable release metadata or policy", () => {
    const activationManifest = buildMainnetActivatedManifest({ shadowManifest });
    const deployed = buildMainnetDeployedManifest({
      activationManifest,
      deployment: {
        accountAddress: "0x1111111111111111111111111111111111111111",
        deploymentTxHash: `0x${"2".repeat(64)}`,
        runtimeBytecodeHash: `0x${"3".repeat(64)}`,
        abiSha256: "4".repeat(64),
        ownerAddress: "0x4444444444444444444444444444444444444444",
        executorAddress: "0x5555555555555555555555555555555555555555",
        deployerAddress: "0x6666666666666666666666666666666666666666",
      },
    });

    assert.throws(
      () => buildMainnetCanaryManifest({
        deployedManifest: deployed,
        projectRef: "zcwsmivbgcrfyrvfptxk",
        releaseCommit: "not-a-commit",
        publicOrigin: "https://mcp.agentpay.site",
      }),
      /releaseCommit/i,
    );
  });
});
