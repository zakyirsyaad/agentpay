import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAINNET_SHADOW_MANIFEST_PATH,
  assertMainnetShadowManifest,
  buildMainnetShadowManifest,
  computeArtifactDigests,
} from "./mainnet-shadow-manifest.mjs";

function requireValue(value, optionName) {
  if (!value || value.startsWith("--")) {
    throw new Error(`Expected a value after ${optionName}.`);
  }
  return value;
}

function parseCliArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--out") {
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

export async function generateMainnetShadowManifest({ outputPath = MAINNET_SHADOW_MANIFEST_PATH } = {}) {
  const artifactDigests = await computeArtifactDigests();
  const manifest = buildMainnetShadowManifest({ artifactDigests });
  assertMainnetShadowManifest(manifest, { artifactDigests });

  const resolvedOutputPath = resolve(outputPath);
  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { outputPath: resolvedOutputPath, manifest, artifactDigests };
}

function helpText() {
  return [
    "Generate the non-secret X Layer mainnet SHADOW_ONLY/OFF manifest.",
    "",
    "Usage:",
    "  npm run manifest:mainnet:shadow [-- --out path]",
    "",
    `Default output: ${MAINNET_SHADOW_MANIFEST_PATH}`,
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      console.log(helpText());
    } else {
      const result = await generateMainnetShadowManifest(options);
      console.log(`Generated SHADOW_ONLY/OFF manifest at ${result.outputPath}`);
      console.log(`Artifact pins: lockfile ${result.artifactDigests.packageLockSha256.slice(0, 12)}…, bytecode ${result.artifactDigests.creationBytecodeKeccak256.slice(0, 14)}…`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Failed to generate mainnet shadow manifest.");
    process.exitCode = 1;
  }
}
