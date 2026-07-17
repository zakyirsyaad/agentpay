import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MAINNET_SHADOW_MANIFEST_PATH,
  assertMainnetShadowManifest,
  computeArtifactDigests,
} from "./mainnet-shadow-manifest.mjs";
import {
  MAINNET_ONBOARDING_ORIGIN,
  computeMainnetOnboardingManifestSha256,
  validateMainnetOnboardingManifest,
} from "./mainnet-onboarding-manifest.mjs";

export const MAINNET_ACTIVATED_MANIFEST_PATH = fileURLToPath(
  new URL("../ops/manifests/xlayer-mainnet.activated.json", import.meta.url),
);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/i;
const HASH_PATTERN = /^0x[a-f0-9]{64}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SETUP_MODES = new Set(["OFF", "CANARY", "PUBLIC", "DRAIN"]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeActivationManifestSha256(manifest) {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export function buildMainnetActivatedManifest({ shadowManifest } = {}) {
  if (!isRecord(shadowManifest)) {
    throw new Error("A generated mainnet shadow manifest is required for activation.");
  }
  if (shadowManifest.status !== "SHADOW_ONLY" || shadowManifest.executionMode !== "OFF") {
    throw new Error("Activation requires an unchanged SHADOW_ONLY/OFF source manifest.");
  }

  const manifest = structuredClone(shadowManifest);
  manifest.kind = "agentpay-mainnet-activated-manifest";
  manifest.status = "DEPLOYED";
  manifest.executionMode = "OFF";
  manifest.activation = {
    sourceManifest: "xlayer-mainnet.shadow.json",
    accountDeployment: "PENDING",
    executionEnabled: false,
  };
  manifest.onboarding = {
    setupMode: "OFF",
    onboardingOrigin: MAINNET_ONBOARDING_ORIGIN,
    manifestSha256: null,
    factoryAddress: null,
  };

  if (manifest.x402?.enabled !== false) {
    throw new Error("Mainnet activation must keep x402 disabled until account deployment.");
  }
  const contract = manifest.contract;
  for (const key of [
    "address",
    "deploymentTxHash",
    "runtimeBytecodeHash",
    "ownerAddress",
    "executorAddress",
    "deployerAddress",
  ]) {
    if (contract?.[key] !== null) {
      throw new Error(`Mainnet activation cannot provision contract.${key}.`);
    }
  }
  if (contract?.domain?.verifyingContract !== null) {
    throw new Error("Mainnet activation cannot provision contract.domain.verifyingContract.");
  }

  return manifest;
}

export function bindMainnetActivationOnboarding({ activationManifest, onboardingManifest } = {}) {
  if (!isRecord(activationManifest)) throw new Error("A DEPLOYED/OFF activation manifest is required.");
  if (activationManifest.status !== "DEPLOYED" || activationManifest.executionMode !== "OFF") {
    throw new Error("Onboarding binding requires a DEPLOYED/OFF payment activation manifest.");
  }
  const onboardingResult = validateMainnetOnboardingManifest(onboardingManifest, { requireFactory: true });
  if (!onboardingResult.valid) {
    throw new Error(`Invalid mainnet onboarding manifest: ${onboardingResult.errors.join("; ")}`);
  }

  const manifest = structuredClone(activationManifest);
  manifest.onboarding = {
    setupMode: onboardingManifest.setupMode,
    onboardingOrigin: onboardingManifest.onboardingOrigin,
    manifestSha256: computeMainnetOnboardingManifestSha256(onboardingManifest),
    factoryAddress: onboardingManifest.factory.address,
  };
  return manifest;
}

export function buildMainnetDeployedManifest({ activationManifest, deployment } = {}) {
  if (!isRecord(activationManifest)) {
    throw new Error("A DEPLOYED/OFF activation manifest is required.");
  }
  if (activationManifest.status !== "DEPLOYED" || activationManifest.executionMode !== "OFF") {
    throw new Error("Account deployment promotion requires a DEPLOYED/OFF activation manifest.");
  }
  if (activationManifest.activation?.accountDeployment !== "PENDING") {
    throw new Error("Account deployment promotion requires a PENDING account deployment.");
  }
  if (activationManifest.x402?.enabled !== false) {
    throw new Error("Account deployment promotion requires x402 to remain disabled.");
  }
  if (!isRecord(deployment)) {
    throw new Error("Verified deployment identity is required.");
  }

  const requiredAddresses = ["accountAddress", "ownerAddress", "executorAddress", "deployerAddress"];
  for (const key of requiredAddresses) {
    if (typeof deployment[key] !== "string" || !ADDRESS_PATTERN.test(deployment[key])) {
      throw new Error(`deployment.${key} must be a valid address.`);
    }
  }
  if (deployment.ownerAddress.toLowerCase() === deployment.executorAddress.toLowerCase()) {
    throw new Error("deployment.ownerAddress and deployment.executorAddress must differ.");
  }
  if (typeof deployment.deploymentTxHash !== "string" || !HASH_PATTERN.test(deployment.deploymentTxHash)) {
    throw new Error("deployment.deploymentTxHash must be a 32-byte transaction hash.");
  }
  if (typeof deployment.runtimeBytecodeHash !== "string" || !HASH_PATTERN.test(deployment.runtimeBytecodeHash)) {
    throw new Error("deployment.runtimeBytecodeHash must be a 32-byte hash.");
  }
  if (typeof deployment.abiSha256 !== "string" || !SHA256_PATTERN.test(deployment.abiSha256)) {
    throw new Error("deployment.abiSha256 must be a SHA-256 digest.");
  }

  const manifest = structuredClone(activationManifest);
  manifest.activation = {
    ...manifest.activation,
    accountDeployment: "DEPLOYED",
  };
  manifest.release = {
    ...manifest.release,
    runtimeBytecodeKeccak256: deployment.runtimeBytecodeHash.toLowerCase(),
    abiSha256: deployment.abiSha256.toLowerCase(),
  };
  manifest.contract = {
    ...manifest.contract,
    address: deployment.accountAddress,
    deploymentTxHash: deployment.deploymentTxHash.toLowerCase(),
    runtimeBytecodeHash: deployment.runtimeBytecodeHash.toLowerCase(),
    ownerAddress: deployment.ownerAddress,
    executorAddress: deployment.executorAddress,
    deployerAddress: deployment.deployerAddress,
    paused: false,
    domain: {
      ...manifest.contract.domain,
      verifyingContract: deployment.accountAddress,
    },
  };

  return manifest;
}

export function bindMainnetCanaryPolicy({ deployedManifest, tenantId, payerAddress, recipientAddress } = {}) {
  if (!isRecord(deployedManifest)) {
    throw new Error("A deployed manifest is required before canary binding.");
  }
  if (deployedManifest.status !== "DEPLOYED" || deployedManifest.executionMode !== "OFF") {
    throw new Error("Canary binding requires a DEPLOYED/OFF manifest.");
  }
  if (deployedManifest.activation?.accountDeployment !== "DEPLOYED") {
    throw new Error("Canary binding requires a deployed account.");
  }
  if (deployedManifest.x402?.enabled !== false) {
    throw new Error("Canary binding requires x402 to remain disabled.");
  }
  if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
    throw new Error("canary tenantId must be a valid UUID.");
  }
  for (const [name, value] of [["payerAddress", payerAddress], ["recipientAddress", recipientAddress]]) {
    if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
      throw new Error(`canary ${name} must be a valid address.`);
    }
  }

  const contract = deployedManifest.contract;
  if (
    !isRecord(contract) ||
    typeof contract.address !== "string" ||
    !ADDRESS_PATTERN.test(contract.address) ||
    typeof contract.ownerAddress !== "string" ||
    !ADDRESS_PATTERN.test(contract.ownerAddress)
  ) {
    throw new Error("Canary binding requires a deployed account and owner address.");
  }

  const existing = isRecord(deployedManifest.canaryPolicy) ? deployedManifest.canaryPolicy : {};
  const expected = {
    allowlistedTenantId: tenantId,
    allowlistedOwnerAddress: contract.ownerAddress,
    allowlistedAccountAddress: contract.address,
    payerAddress,
    recipientAddress,
  };
  for (const [key, value] of Object.entries(expected)) {
    const previous = existing[key];
    if (previous !== null && previous !== undefined && String(previous).toLowerCase() !== String(value).toLowerCase()) {
      throw new Error(`Canary policy ${key} is already bound to a different value.`);
    }
  }

  return {
    ...structuredClone(deployedManifest),
    canaryPolicy: {
      ...existing,
      ...expected,
    },
  };
}

export function buildMainnetCanaryManifest({ deployedManifest, projectRef, releaseCommit, publicOrigin } = {}) {
  if (!isRecord(deployedManifest)) {
    throw new Error("A deployed manifest is required before canary activation.");
  }
  if (deployedManifest.status !== "DEPLOYED" || deployedManifest.executionMode !== "OFF") {
    throw new Error("Canary activation requires a DEPLOYED/OFF manifest.");
  }
  if (deployedManifest.activation?.accountDeployment !== "DEPLOYED") {
    throw new Error("Canary activation requires a deployed account.");
  }
  if (deployedManifest.x402?.enabled !== false) {
    throw new Error("Canary activation requires x402 to remain disabled before promotion.");
  }
  if (typeof projectRef !== "string" || !/^[a-z0-9]{20}$/.test(projectRef)) {
    throw new Error("projectRef must be a 20-character Supabase project reference.");
  }
  if (typeof releaseCommit !== "string" || !COMMIT_PATTERN.test(releaseCommit)) {
    throw new Error("releaseCommit must be an immutable 40-character commit SHA.");
  }
  if (typeof publicOrigin !== "string" || !/^https:\/\//.test(publicOrigin)) {
    throw new Error("publicOrigin must be an HTTPS URL.");
  }

  const policy = deployedManifest.canaryPolicy;
  if (
    !isRecord(policy) ||
    typeof policy.allowlistedTenantId !== "string" ||
    !UUID_PATTERN.test(policy.allowlistedTenantId) ||
    [
      policy.allowlistedOwnerAddress,
      policy.allowlistedAccountAddress,
      policy.payerAddress,
      policy.recipientAddress,
    ].some((value) => typeof value !== "string" || !ADDRESS_PATTERN.test(value))
  ) {
    throw new Error("Canary activation requires a fully bound tenant, account, payer, and recipient policy.");
  }

  const manifest = structuredClone(deployedManifest);
  manifest.status = "READY";
  manifest.executionMode = "CANARY";
  manifest.x402 = {
    ...manifest.x402,
    enabled: true,
  };
  manifest.database = {
    ...manifest.database,
    projectRef,
  };
  manifest.release = {
    ...manifest.release,
    commit: releaseCommit.toLowerCase(),
  };
  manifest.domains = {
    ...manifest.domains,
    publicOrigin,
  };
  manifest.activation = {
    ...manifest.activation,
    executionEnabled: true,
  };
  return manifest;
}

export function validateMainnetActivationManifest(manifest, { artifactDigests } = {}) {
  const errors = [];
  const add = (path, message) => errors.push(`${path}: ${message}`);

  if (!isRecord(manifest)) return { valid: false, errors: ["manifest: must be an object"] };
  if (manifest.schemaVersion !== 1) add("schemaVersion", "must be 1");
  if (manifest.kind !== "agentpay-mainnet-activated-manifest") add("kind", "must be agentpay-mainnet-activated-manifest");
  if (manifest.status !== "DEPLOYED") add("status", "must be DEPLOYED");
  if (manifest.environment !== "production") add("environment", "must be production");
  if (manifest.executionMode !== "OFF") add("executionMode", "must be OFF");
  if (manifest.chain?.chainId !== 196 || manifest.chain?.caip2 !== "eip155:196") add("chain", "must target X Layer mainnet");
  if (manifest.x402?.enabled !== false) add("x402.enabled", "must remain false while execution is OFF");
  if (manifest.activation?.sourceManifest !== "xlayer-mainnet.shadow.json") add("activation.sourceManifest", "must point to the frozen shadow artifact");
  const accountDeployment = manifest.activation?.accountDeployment;
  if (accountDeployment !== "PENDING" && accountDeployment !== "DEPLOYED") {
    add("activation.accountDeployment", "must be PENDING or DEPLOYED");
  }
  if (manifest.activation?.executionEnabled !== false) add("activation.executionEnabled", "must remain false");
  validateActivationOnboarding(manifest.onboarding, add);

  if (accountDeployment === "PENDING") {
    for (const key of [
      "address",
      "deploymentTxHash",
      "runtimeBytecodeHash",
      "ownerAddress",
      "executorAddress",
      "deployerAddress",
    ]) {
      if (manifest.contract?.[key] !== null) add(`contract.${key}`, "must remain null before deployment");
    }
    if (manifest.contract?.domain?.verifyingContract !== null) {
      add("contract.domain.verifyingContract", "must remain null before deployment");
    }
  }

  if (accountDeployment === "DEPLOYED") {
    for (const key of ["address", "ownerAddress", "executorAddress", "deployerAddress"]) {
      if (typeof manifest.contract?.[key] !== "string" || !ADDRESS_PATTERN.test(manifest.contract[key])) {
        add(`contract.${key}`, "must be a valid deployed address");
      }
    }
    if (typeof manifest.contract?.deploymentTxHash !== "string" || !HASH_PATTERN.test(manifest.contract.deploymentTxHash)) {
      add("contract.deploymentTxHash", "must be a valid deployment transaction hash");
    }
    if (typeof manifest.contract?.runtimeBytecodeHash !== "string" || !HASH_PATTERN.test(manifest.contract.runtimeBytecodeHash)) {
      add("contract.runtimeBytecodeHash", "must be a valid deployed runtime hash");
    }
    if (manifest.contract?.ownerAddress?.toLowerCase() === manifest.contract?.executorAddress?.toLowerCase()) {
      add("contract.ownerAddress", "must differ from contract.executorAddress");
    }
    if (manifest.contract?.paused !== false) add("contract.paused", "must be false before canary approval");
    if (manifest.contract?.domain?.verifyingContract?.toLowerCase() !== manifest.contract?.address?.toLowerCase()) {
      add("contract.domain.verifyingContract", "must match contract.address");
    }
    if (typeof manifest.release?.runtimeBytecodeKeccak256 !== "string" || !HASH_PATTERN.test(manifest.release.runtimeBytecodeKeccak256)) {
      add("release.runtimeBytecodeKeccak256", "must be a deployed runtime hash");
    }
    if (manifest.release?.runtimeBytecodeKeccak256?.toLowerCase() !== manifest.contract?.runtimeBytecodeHash?.toLowerCase()) {
      add("release.runtimeBytecodeKeccak256", "must match contract.runtimeBytecodeHash");
    }
    if (typeof manifest.release?.abiSha256 !== "string" || !SHA256_PATTERN.test(manifest.release.abiSha256)) {
      add("release.abiSha256", "must be an ABI SHA-256 digest after deployment");
    }
  }

  if (artifactDigests) {
    if (manifest.release?.packageLockSha256 !== artifactDigests.packageLockSha256) {
      add("release.packageLockSha256", "does not match the frozen artifact");
    }
    if (manifest.release?.creationBytecodeKeccak256?.toLowerCase() !== artifactDigests.creationBytecodeKeccak256?.toLowerCase()) {
      add("release.creationBytecodeKeccak256", "does not match the frozen artifact");
    }
    if (manifest.contract?.creationBytecodeHash?.toLowerCase() !== artifactDigests.creationBytecodeKeccak256?.toLowerCase()) {
      add("contract.creationBytecodeHash", "does not match the frozen artifact");
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateActivationOnboarding(onboarding, add) {
  if (!isRecord(onboarding)) {
    add("onboarding", "must be an object");
    return;
  }
  const allowedKeys = ["factoryAddress", "manifestSha256", "onboardingOrigin", "setupMode"];
  for (const key of Object.keys(onboarding)) {
    if (!allowedKeys.includes(key)) add(`onboarding.${key}`, "is not allowed");
  }
  for (const key of allowedKeys) {
    if (!(key in onboarding)) add(`onboarding.${key}`, "is required");
  }
  if (!SETUP_MODES.has(onboarding.setupMode)) {
    add("onboarding.setupMode", "must be OFF, CANARY, PUBLIC, or DRAIN");
  }
  if (onboarding.onboardingOrigin !== MAINNET_ONBOARDING_ORIGIN) {
    add("onboarding.onboardingOrigin", `must be ${MAINNET_ONBOARDING_ORIGIN}`);
  }
  const hasDigest = typeof onboarding.manifestSha256 === "string" && SHA256_PATTERN.test(onboarding.manifestSha256);
  const hasFactory = typeof onboarding.factoryAddress === "string" && ADDRESS_PATTERN.test(onboarding.factoryAddress);
  if (onboarding.manifestSha256 !== null && !hasDigest) {
    add("onboarding.manifestSha256", "must be null or a bare lowercase SHA-256 digest");
  }
  if (onboarding.factoryAddress !== null && !hasFactory) {
    add("onboarding.factoryAddress", "must be null or a valid factory address");
  }
  if ((onboarding.manifestSha256 === null) !== (onboarding.factoryAddress === null)) {
    add("onboarding", "manifest digest and factory address must be bound together");
  }
}

export async function generateMainnetActivatedManifest({ outputPath = MAINNET_ACTIVATED_MANIFEST_PATH } = {}) {
  const artifactDigests = await computeArtifactDigests();
  const shadowManifest = JSON.parse(await readFile(MAINNET_SHADOW_MANIFEST_PATH, "utf8"));
  assertMainnetShadowManifest(shadowManifest, { artifactDigests });
  const manifest = buildMainnetActivatedManifest({ shadowManifest });
  const result = validateMainnetActivationManifest(manifest, { artifactDigests });
  if (!result.valid) throw new Error(`Invalid mainnet activation manifest: ${result.errors.join("; ")}`);

  const resolvedOutputPath = resolve(outputPath);
  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    outputPath: resolvedOutputPath,
    manifest,
    artifactDigests,
    manifestSha256: computeActivationManifestSha256(manifest),
  };
}

function helpText() {
  return [
    "Generate the non-secret X Layer mainnet DEPLOYED/OFF activation manifest.",
    "",
    "Usage:",
    "  npm run manifest:mainnet:activate [-- --out path]",
    "",
    `Default output: ${MAINNET_ACTIVATED_MANIFEST_PATH}`,
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const outputIndex = args.indexOf("--out");
    const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
    if (args.includes("--help") || args.includes("-h")) {
      console.log(helpText());
    } else {
      if (outputIndex >= 0 && (!outputPath || outputPath.startsWith("--"))) {
        throw new Error("Expected a value after --out.");
      }
      const result = await generateMainnetActivatedManifest({ outputPath });
      console.log(`Generated DEPLOYED/OFF activation manifest at ${result.outputPath}`);
      console.log(`Manifest SHA-256: ${result.manifestSha256}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Failed to generate mainnet activation manifest.");
    process.exitCode = 1;
  }
}
