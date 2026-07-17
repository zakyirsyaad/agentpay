import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const defaultArtifactPath = fileURLToPath(
  new URL("../contracts/out/AgentPayAccountV2.sol/AgentPayAccountV2.json", import.meta.url),
);
const defaultOutputPath = fileURLToPath(new URL("../packages/cli/assets/AgentPayAccount.bin", import.meta.url));
const defaultRuntimeOutputPath = fileURLToPath(
  new URL("../packages/cli/assets/AgentPayAccountV2.runtime.json", import.meta.url),
);

const BYTECODE_PATTERN = /^0x(?:[a-fA-F0-9]{2})+$/;
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export function extractAgentPayAccountBytecode(artifact) {
  const bytecode = artifact?.bytecode?.object;

  if (typeof bytecode !== "string" || !BYTECODE_PATTERN.test(bytecode)) {
    throw new Error("Foundry artifact is missing valid AgentPayAccountV2 deploy bytecode.");
  }

  return bytecode;
}

export const extractAgentPayAccountV2Bytecode = extractAgentPayAccountBytecode;

export function extractAgentPayAccountV2RuntimeArtifact(artifact) {
  const creationBytecode = extractAgentPayAccountBytecode(artifact);
  const runtimeBytecode = artifact?.deployedBytecode?.object;
  if (typeof runtimeBytecode !== "string" || !BYTECODE_PATTERN.test(runtimeBytecode)) {
    throw new Error("Foundry artifact is missing valid AgentPayAccountV2 deployed bytecode.");
  }

  const immutableReferences = normalizeFoundryOwnerReferences(
    artifact?.deployedBytecode?.immutableReferences,
    runtimeBytecode,
  );
  return {
    bytecode: runtimeBytecode,
    immutableReferences,
    creationCodeHash: keccakHex(creationBytecode),
    runtimeTemplateHash: keccakHex(runtimeBytecode),
  };
}

export function bindRuntimeOwner(artifact, owner) {
  const normalized = validateRuntimeArtifact(artifact);
  if (typeof owner !== "string" || !ADDRESS_PATTERN.test(owner)) {
    throw new Error("Runtime owner must be a 20-byte EVM address.");
  }

  const runtimeBytes = hexToBytes(normalized.bytecode.slice(2));
  const ownerBytes = hexToBytes(owner.slice(2));
  for (const reference of normalized.immutableReferences) {
    runtimeBytes.set(ownerBytes, reference.start);
  }
  const bytecode = `0x${bytesToHex(runtimeBytes)}`;
  return { bytecode, runtimeCodeHash: keccakHex(bytecode) };
}

export async function exportAgentPayAccountBytecode(options = {}) {
  const artifactPath = options.artifactPath ?? defaultArtifactPath;
  const outputPath = options.outputPath ?? defaultOutputPath;
  const runtimeOutputPath = options.runtimeOutputPath ?? defaultRuntimeOutputPath;
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  const bytecode = extractAgentPayAccountBytecode(artifact);
  const runtimeArtifact = extractAgentPayAccountV2RuntimeArtifact(artifact);

  await writeFileAtomically(outputPath, `${bytecode}\n`);
  await writeFileAtomically(runtimeOutputPath, `${JSON.stringify(runtimeArtifact, null, 2)}\n`);

  return {
    artifactPath,
    outputPath,
    runtimeOutputPath,
    bytecodeBytes: (bytecode.length - 2) / 2,
    bytecodeHash: keccakHex(bytecode),
    runtimeBytecodeBytes: (runtimeArtifact.bytecode.length - 2) / 2,
    runtimeTemplateHash: runtimeArtifact.runtimeTemplateHash,
  };
}

function parseCliArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--artifact") {
      options.artifactPath = requireValue(args[index + 1], arg);
      index += 1;
    } else if (arg === "--out") {
      options.outputPath = requireValue(args[index + 1], arg);
      index += 1;
    } else if (arg === "--runtime-out") {
      options.runtimeOutputPath = requireValue(args[index + 1], arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function requireValue(value, optionName) {
  if (!value || value.startsWith("--")) {
    throw new Error(`Expected a value after ${optionName}.`);
  }

  return value;
}

function helpText() {
  return [
    "Export AgentPayAccountV2 deploy bytecode from the Foundry artifact for packaged setup-web installs.",
    "",
    "Usage:",
    "  node scripts/export-agentpay-bytecode.mjs [--artifact path] [--out path] [--runtime-out path]",
    "",
    `Default artifact: ${defaultArtifactPath}`,
    `Default output:   ${defaultOutputPath}`,
    `Runtime output:   ${defaultRuntimeOutputPath}`,
  ].join("\n");
}

function normalizeFoundryOwnerReferences(referenceGroups, runtimeBytecode) {
  if (!referenceGroups || typeof referenceGroups !== "object" || Array.isArray(referenceGroups)) {
    throw new Error("Foundry artifact is missing AgentPayAccountV2 owner immutable references.");
  }
  const groups = Object.values(referenceGroups);
  if (groups.length !== 1 || !Array.isArray(groups[0]) || groups[0].length === 0) {
    throw new Error("Foundry artifact must contain exactly one owner immutable reference group.");
  }

  const runtimeBytes = hexToBytes(runtimeBytecode.slice(2));
  const normalized = groups[0].map((reference) => {
    if (
      !reference ||
      !Number.isSafeInteger(reference.start) ||
      reference.start < 0 ||
      reference.length !== 32 ||
      reference.start + reference.length > runtimeBytes.length
    ) {
      throw new Error("Foundry owner immutable reference must be an in-bounds 32-byte address slot.");
    }
    const slot = runtimeBytes.subarray(reference.start, reference.start + reference.length);
    if (slot.some((byte) => byte !== 0)) {
      throw new Error("Foundry owner immutable reference template must contain only zero bytes.");
    }
    return { start: reference.start + 12, length: 20 };
  });

  return validateReferences(normalized, runtimeBytes.length);
}

function validateRuntimeArtifact(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("Runtime artifact must be an object.");
  }
  if (typeof artifact.bytecode !== "string" || !BYTECODE_PATTERN.test(artifact.bytecode)) {
    throw new Error("Runtime artifact bytecode is invalid.");
  }
  if (typeof artifact.creationCodeHash !== "string" || !HASH_PATTERN.test(artifact.creationCodeHash)) {
    throw new Error("Runtime artifact creationCodeHash is invalid.");
  }
  if (
    typeof artifact.runtimeTemplateHash !== "string" ||
    !HASH_PATTERN.test(artifact.runtimeTemplateHash) ||
    artifact.runtimeTemplateHash.toLowerCase() !== keccakHex(artifact.bytecode)
  ) {
    throw new Error("Runtime artifact runtimeTemplateHash does not match its bytecode template.");
  }

  const runtimeBytes = hexToBytes(artifact.bytecode.slice(2));
  const immutableReferences = validateReferences(artifact.immutableReferences, runtimeBytes.length);
  for (const reference of immutableReferences) {
    if (runtimeBytes.subarray(reference.start, reference.start + reference.length).some((byte) => byte !== 0)) {
      throw new Error("Runtime artifact template immutable owner bytes must be zero.");
    }
  }
  return { ...artifact, immutableReferences };
}

function validateReferences(references, byteLength) {
  if (!Array.isArray(references) || references.length === 0) {
    throw new Error("Runtime artifact must contain owner immutable references.");
  }
  const normalized = references.map((reference) => {
    if (
      !reference ||
      !Number.isSafeInteger(reference.start) ||
      reference.start < 0 ||
      reference.length !== 20 ||
      reference.start + reference.length > byteLength
    ) {
      throw new Error("Runtime owner immutable reference must be an in-bounds 20-byte range.");
    }
    return { start: reference.start, length: reference.length };
  }).sort((left, right) => left.start - right.start);

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    if (previous.start + previous.length > normalized[index].start) {
      throw new Error("Runtime owner immutable references must not overlap.");
    }
  }
  return normalized;
}

function keccakHex(bytecode) {
  return `0x${bytesToHex(keccak_256(hexToBytes(bytecode.slice(2))))}`;
}

async function writeFileAtomically(outputPath, contents) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseCliArgs(process.argv.slice(2));

  if (options.help) {
    console.log(helpText());
  } else {
    exportAgentPayAccountBytecode(options)
      .then((result) => {
        console.log(`Exported ${result.bytecodeBytes} bytes to ${result.outputPath}`);
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : "Failed to export AgentPayAccount bytecode.");
        process.exitCode = 1;
      });
  }
}
