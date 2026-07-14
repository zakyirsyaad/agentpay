import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const defaultArtifactPath = fileURLToPath(
  new URL("../contracts/out/AgentPayAccountV2.sol/AgentPayAccountV2.json", import.meta.url),
);
const defaultOutputPath = fileURLToPath(new URL("../packages/cli/assets/AgentPayAccount.bin", import.meta.url));

export function extractAgentPayAccountBytecode(artifact) {
  const bytecode = artifact?.bytecode?.object;

  if (typeof bytecode !== "string" || !/^0x(?:[a-fA-F0-9]{2})+$/.test(bytecode)) {
    throw new Error("Foundry artifact is missing valid AgentPayAccountV2 deploy bytecode.");
  }

  return bytecode;
}

export const extractAgentPayAccountV2Bytecode = extractAgentPayAccountBytecode;

export async function exportAgentPayAccountBytecode(options = {}) {
  const artifactPath = options.artifactPath ?? defaultArtifactPath;
  const outputPath = options.outputPath ?? defaultOutputPath;
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  const bytecode = extractAgentPayAccountBytecode(artifact);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${bytecode}\n`, "utf8");

  return {
    artifactPath,
    outputPath,
    bytecodeBytes: (bytecode.length - 2) / 2,
    bytecodeHash: `0x${bytesToHex(keccak_256(hexToBytes(bytecode.slice(2))))}`,
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
    "  node scripts/export-agentpay-bytecode.mjs [--artifact path] [--out path]",
    "",
    `Default artifact: ${defaultArtifactPath}`,
    `Default output:   ${defaultOutputPath}`,
  ].join("\n");
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
