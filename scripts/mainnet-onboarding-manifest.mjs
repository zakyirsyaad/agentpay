import { createHash } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export const MAINNET_ONBOARDING_ORIGIN = "https://onboard.agentpay.site";
export const MAINNET_USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
export const MAINNET_POLICY_VERSION = "0x9ffc525f976679dba1c4b7719e4a88a5ab29462373ca8c14513ab633beae5e3d";

const MAINNET_CHAIN_ID = 196;
const SETUP_MODES = new Set(["OFF", "CANARY", "PUBLIC", "DRAIN"]);
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HASH_PATTERN = /^0x[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const BYTECODE_PATTERN = /^0x(?:[a-fA-F0-9]{2})+$/;
const MAX_UINT256_DECIMAL =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const SECRET_LIKE_KEY_PATTERN = /(api.?key|private.?key|mnemonic|password|secret|seed.?phrase|service.?role)/i;

const TOP_LEVEL_KEYS = ["account", "chainId", "environment", "factory", "onboardingOrigin", "setupMode", "sponsor"];
const FACTORY_KEYS = [
  "address",
  "deploymentBlock",
  "deploymentTxHash",
  "executor",
  "policyVersion",
  "runtimeCodeHash",
  "usdt0",
];
const ACCOUNT_KEYS = ["creationCodeHash", "immutableReferences", "routeTargets", "runtimeTemplateHash"];
const SPONSOR_KEYS = [
  "deployerAddress",
  "maxDeploymentsPerDay",
  "maxGasPerDeployment",
  "maxNativeCostPerDayWei",
  "maxPending",
];
const DEPLOYMENT_KEYS = [
  "address",
  "deploymentBlock",
  "deploymentTxHash",
  "executor",
  "policyVersion",
  "runtimeCodeHash",
  "usdt0",
];
const ACCOUNT_ARTIFACT_KEYS = ["bytecode", "creationCodeHash", "immutableReferences", "runtimeTemplateHash"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function computeMainnetOnboardingManifestSha256(manifest) {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export function buildMainnetOnboardingOffManifest({ accountArtifact, sponsor, onboardingOrigin } = {}) {
  const manifest = {
    environment: "production",
    chainId: MAINNET_CHAIN_ID,
    setupMode: "OFF",
    onboardingOrigin: onboardingOrigin ?? MAINNET_ONBOARDING_ORIGIN,
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
      creationCodeHash: accountArtifact?.creationCodeHash,
      runtimeTemplateHash: accountArtifact?.runtimeTemplateHash,
      immutableReferences: structuredClone(accountArtifact?.immutableReferences),
      routeTargets: [],
    },
    sponsor: structuredClone(sponsor),
  };
  const result = validateMainnetOnboardingManifest(manifest, { accountArtifact });
  if (!result.valid) throw new Error(`Invalid mainnet onboarding OFF manifest: ${result.errors.join("; ")}`);
  return deepFreeze(manifest);
}

export function bindVerifiedFactoryDeployment({ manifest, deployment } = {}) {
  const sourceResult = validateMainnetOnboardingManifest(manifest);
  if (!sourceResult.valid) {
    throw new Error(`Invalid mainnet onboarding source manifest: ${sourceResult.errors.join("; ")}`);
  }
  const evidenceKeys = ["address", "deploymentTxHash", "deploymentBlock", "runtimeCodeHash", "executor"];
  if (manifest.setupMode !== "OFF" || evidenceKeys.some((key) => manifest.factory[key] !== null)) {
    throw new Error("Factory deployment binding requires an unbound OFF onboarding manifest.");
  }
  if (!isRecord(deployment)) throw new Error("Verified factory deployment evidence is required.");
  const deploymentErrors = [];
  const addDeploymentError = (path, message) => deploymentErrors.push(`${path}: ${message}`);
  findSecretLikeKeys(deployment, "deployment", addDeploymentError);
  requireExactKeys(deployment, DEPLOYMENT_KEYS, "deployment", addDeploymentError);
  if (deploymentErrors.length > 0) {
    throw new Error(`Invalid factory deployment input: ${deploymentErrors.join("; ")}`);
  }

  const bound = structuredClone(manifest);
  bound.factory = {
    address: normalizeAddress(deployment.address),
    deploymentTxHash: normalizeHash(deployment.deploymentTxHash),
    deploymentBlock: deployment.deploymentBlock,
    runtimeCodeHash: normalizeHash(deployment.runtimeCodeHash),
    executor: normalizeAddress(deployment.executor),
    usdt0: deployment.usdt0,
    policyVersion: normalizeHash(deployment.policyVersion),
  };
  const result = validateMainnetOnboardingManifest(bound, { requireFactory: true });
  if (!result.valid) throw new Error(`Invalid verified factory deployment: ${result.errors.join("; ")}`);
  return deepFreeze(bound);
}

export function validateMainnetOnboardingManifest(
  manifest,
  { accountArtifact, expectedSha256, requireFactory = false } = {},
) {
  const errors = [];
  const add = (path, message) => errors.push(`${path}: ${message}`);
  if (!isRecord(manifest)) return { valid: false, errors: ["manifest: must be an object"] };

  findSecretLikeKeys(manifest, "manifest", add);
  requireExactKeys(manifest, TOP_LEVEL_KEYS, "manifest", add);
  if (manifest.environment !== "production") add("environment", "must be production");
  if (manifest.chainId !== MAINNET_CHAIN_ID) add("chainId", "must be X Layer mainnet chain 196");
  if (!SETUP_MODES.has(manifest.setupMode)) add("setupMode", "must be OFF, CANARY, PUBLIC, or DRAIN");
  if (manifest.onboardingOrigin !== MAINNET_ONBOARDING_ORIGIN) {
    add("onboardingOrigin", `must be ${MAINNET_ONBOARDING_ORIGIN}`);
  }

  validateFactory(manifest.factory, manifest.sponsor, { add, requireFactory });
  validateAccount(manifest.account, accountArtifact, add);
  validateSponsor(manifest.sponsor, add);

  if (expectedSha256 !== undefined) {
    if (typeof expectedSha256 !== "string" || !SHA256_PATTERN.test(expectedSha256)) {
      add("manifest digest", "expected SHA-256 must be a bare lowercase 64-character digest");
    } else if (computeMainnetOnboardingManifestSha256(manifest) !== expectedSha256) {
      add("manifest digest", "does not match canonical manifest SHA-256");
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateFactory(factory, sponsor, { add, requireFactory }) {
  if (!isRecord(factory)) {
    add("factory", "must be an object");
    return;
  }
  requireExactKeys(factory, FACTORY_KEYS, "factory", add);
  if (factory.usdt0 !== MAINNET_USDT0) add("factory.usdt0", "must be canonical X Layer USDT0");
  if (factory.policyVersion !== MAINNET_POLICY_VERSION) {
    add("factory.policyVersion", "must pin agentpay-mainnet-account-v1");
  }

  const evidenceKeys = ["address", "deploymentTxHash", "deploymentBlock", "runtimeCodeHash", "executor"];
  const populated = evidenceKeys.filter((key) => factory[key] !== null && factory[key] !== undefined);
  if (populated.length !== 0 && populated.length !== evidenceKeys.length) {
    add("factory", "deployment evidence must be entirely null or entirely populated");
    for (const key of evidenceKeys.filter((key) => factory[key] === null || factory[key] === undefined)) {
      add(`factory.${key}`, "is required when factory deployment evidence is populated");
    }
  }
  if (requireFactory && populated.length !== evidenceKeys.length) {
    add("factory", "complete verified deployment evidence is required");
    for (const key of evidenceKeys.filter((key) => factory[key] === null || factory[key] === undefined)) {
      add(`factory.${key}`, "is required for a verified factory deployment");
    }
  }
  if (populated.length === evidenceKeys.length) {
    if (!ADDRESS_PATTERN.test(factory.address ?? "")) add("factory.address", "must be a valid address");
    if (!HASH_PATTERN.test(factory.deploymentTxHash ?? "")) {
      add("factory.deploymentTxHash", "must be a lowercase 32-byte hash");
    }
    if (!Number.isSafeInteger(factory.deploymentBlock) || factory.deploymentBlock <= 0) {
      add("factory.deploymentBlock", "must be a positive safe integer");
    }
    if (!HASH_PATTERN.test(factory.runtimeCodeHash ?? "")) {
      add("factory.runtimeCodeHash", "must be a lowercase 32-byte hash");
    }
    if (!ADDRESS_PATTERN.test(factory.executor ?? "")) add("factory.executor", "must be a valid address");

    const actors = [factory.address, factory.executor, sponsor?.deployerAddress]
      .filter((value) => typeof value === "string")
      .map((value) => value.toLowerCase());
    if (actors.length === 3 && new Set(actors).size !== actors.length) {
      add("factory.executor", "factory, executor, and sponsor deployer must be distinct");
    }
  }
}

function validateAccount(account, accountArtifact, add) {
  if (!isRecord(account)) {
    add("account", "must be an object");
    return;
  }
  requireExactKeys(account, ACCOUNT_KEYS, "account", add);
  if (!HASH_PATTERN.test(account.creationCodeHash ?? "")) {
    add("account.creationCodeHash", "must be a lowercase 32-byte hash");
  }
  if (!HASH_PATTERN.test(account.runtimeTemplateHash ?? "")) {
    add("account.runtimeTemplateHash", "must be a lowercase 32-byte hash");
  }
  validateImmutableReferences(account.immutableReferences, add);
  if (!Array.isArray(account.routeTargets) || account.routeTargets.length !== 0) {
    add("account.routeTargets", "must be an empty array");
  }

  if (accountArtifact !== undefined) {
    validateAccountArtifact(accountArtifact, add);
    if (!isRecord(accountArtifact)) return;
    if (account.creationCodeHash !== accountArtifact.creationCodeHash) {
      add("account.creationCodeHash", "does not match runtime artifact");
    }
    if (account.runtimeTemplateHash !== accountArtifact.runtimeTemplateHash) {
      add("account.runtimeTemplateHash", "does not match runtime artifact");
    }
    if (canonicalJson(account.immutableReferences) !== canonicalJson(accountArtifact.immutableReferences)) {
      add("account.immutableReferences", "do not match runtime artifact");
    }
  }
}

function validateAccountArtifact(accountArtifact, add) {
  if (!isRecord(accountArtifact)) {
    add("account artifact", "must be an object");
    return;
  }
  requireExactKeys(accountArtifact, ACCOUNT_ARTIFACT_KEYS, "account artifact", add);
  if (typeof accountArtifact.bytecode !== "string" || !BYTECODE_PATTERN.test(accountArtifact.bytecode)) {
    add("account artifact.bytecode", "must be valid runtime bytecode");
  }
  if (!HASH_PATTERN.test(accountArtifact.creationCodeHash ?? "")) {
    add("account artifact.creationCodeHash", "must be a lowercase 32-byte hash");
  }
  if (!HASH_PATTERN.test(accountArtifact.runtimeTemplateHash ?? "")) {
    add("account artifact.runtimeTemplateHash", "must be a lowercase 32-byte hash");
  } else if (
    typeof accountArtifact.bytecode === "string" &&
    BYTECODE_PATTERN.test(accountArtifact.bytecode) &&
    keccakHex(accountArtifact.bytecode) !== accountArtifact.runtimeTemplateHash
  ) {
    add("account artifact.runtimeTemplateHash", "does not match runtime template bytecode");
  }

  const byteLength =
    typeof accountArtifact.bytecode === "string" && BYTECODE_PATTERN.test(accountArtifact.bytecode)
      ? (accountArtifact.bytecode.length - 2) / 2
      : undefined;
  validateImmutableReferences(accountArtifact.immutableReferences, add, {
    path: "account artifact.immutableReferences",
    byteLength,
    bytecode: accountArtifact.bytecode,
  });
}

function validateSponsor(sponsor, add) {
  if (!isRecord(sponsor)) {
    add("sponsor", "must be an object");
    return;
  }
  requireExactKeys(sponsor, SPONSOR_KEYS, "sponsor", add);
  if (!ADDRESS_PATTERN.test(sponsor.deployerAddress ?? "")) {
    add("sponsor.deployerAddress", "must be a valid address");
  }
  for (const key of ["maxDeploymentsPerDay", "maxGasPerDeployment", "maxPending"]) {
    if (!Number.isSafeInteger(sponsor[key]) || sponsor[key] <= 0) add(`sponsor.${key}`, "must be a positive safe integer");
  }
  const nativeCost = sponsor.maxNativeCostPerDayWei;
  if (
    typeof nativeCost !== "string" ||
    !POSITIVE_DECIMAL_PATTERN.test(nativeCost) ||
    nativeCost.length > MAX_UINT256_DECIMAL.length ||
    (nativeCost.length === MAX_UINT256_DECIMAL.length && nativeCost > MAX_UINT256_DECIMAL)
  ) {
    add("sponsor.maxNativeCostPerDayWei", "must be a positive decimal uint256 string");
  }
}

function validateImmutableReferences(
  references,
  add,
  { path = "account.immutableReferences", byteLength, bytecode } = {},
) {
  if (!Array.isArray(references) || references.length === 0) {
    add(path, "must contain owner reference offsets");
    return;
  }
  const runtimeBytes = typeof bytecode === "string" && BYTECODE_PATTERN.test(bytecode)
    ? hexToBytes(bytecode.slice(2))
    : undefined;
  let previousEnd = -1;
  for (const [index, reference] of references.entries()) {
    if (!isRecord(reference)) {
      add(`${path}.${index}`, "must be an object");
      continue;
    }
    requireExactKeys(reference, ["length", "start"], `${path}.${index}`, add);
    if (!Number.isSafeInteger(reference.start) || reference.start < 0 || reference.length !== 20) {
      add(`${path}.${index}`, "must be a nonnegative 20-byte range");
      continue;
    }
    if (reference.start < previousEnd) add(`${path}.${index}`, "must not overlap or reorder");
    if (byteLength !== undefined && reference.start + reference.length > byteLength) {
      add(`${path}.${index}`, "must be within runtime template bytecode");
    } else if (
      runtimeBytes &&
      runtimeBytes.subarray(reference.start, reference.start + reference.length).some((byte) => byte !== 0)
    ) {
      add(`${path}.${index}`, "must point to zero-filled owner template bytes");
    }
    previousEnd = reference.start + reference.length;
  }
}

function keccakHex(bytecode) {
  return `0x${bytesToHex(keccak_256(hexToBytes(bytecode.slice(2))))}`;
}

function requireExactKeys(value, expectedKeys, path, add) {
  if (!isRecord(value)) return;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  for (const key of actual.filter((key) => !expected.includes(key))) add(`${path}.${key}`, "is not allowed");
  for (const key of expected.filter((key) => !actual.includes(key))) add(`${path}.${key}`, "is required");
}

function findSecretLikeKeys(value, path, add) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSecretLikeKeys(item, `${path}.${index}`, add));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_LIKE_KEY_PATTERN.test(key)) add(`${path}.${key}`, "secret-like keys are forbidden");
    findSecretLikeKeys(nested, `${path}.${key}`, add);
  }
}

function normalizeAddress(value) {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) return value;
  return value.toLowerCase();
}

function normalizeHash(value) {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical manifest JSON cannot contain non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("Canonical manifest JSON supports only JSON values.");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
