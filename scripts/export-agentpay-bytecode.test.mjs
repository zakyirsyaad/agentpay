import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { keccak256 } from "ethers";

import {
  bindRuntimeOwner,
  exportAgentPayAccountBytecode,
  extractAgentPayAccountBytecode,
  extractAgentPayAccountV2RuntimeArtifact,
} from "./export-agentpay-bytecode.mjs";

const creationBytecode = "0x60006000";
const runtimeBytecode = `0x${"11".repeat(4)}${"00".repeat(32)}${"22".repeat(4)}`;

function foundryArtifact(overrides = {}) {
  return {
    bytecode: { object: creationBytecode },
    deployedBytecode: {
      object: runtimeBytecode,
      immutableReferences: { "2277": [{ start: 4, length: 32 }] },
    },
    ...overrides,
  };
}

describe("extractAgentPayAccountBytecode", () => {
  it("reads deploy bytecode from a Foundry artifact", () => {
    assert.equal(
      extractAgentPayAccountBytecode({
        bytecode: {
          object: "0x60006000",
        },
      }),
      "0x60006000",
    );
  });

  it("rejects missing or invalid deploy bytecode", () => {
    assert.throws(() => extractAgentPayAccountBytecode({ bytecode: { object: "" } }), /deploy bytecode/);
    assert.throws(() => extractAgentPayAccountBytecode({ bytecode: { object: "6000" } }), /deploy bytecode/);
    assert.throws(() => extractAgentPayAccountBytecode({ bytecode: { object: "0x123" } }), /deploy bytecode/);
  });
});

describe("exportAgentPayAccountBytecode", () => {
  it("writes deploy bytecode and a validated runtime-template artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentpay-bytecode-export-"));

    try {
      const artifactPath = join(dir, "AgentPayAccount.json");
      const outputPath = join(dir, "AgentPayAccount.bin");
      const runtimeOutputPath = join(dir, "AgentPayAccountV2.runtime.json");
      await writeFile(artifactPath, JSON.stringify(foundryArtifact()), "utf8");

      const result = await exportAgentPayAccountBytecode({ artifactPath, outputPath, runtimeOutputPath });

      assert.deepEqual(result, {
        artifactPath,
        outputPath,
        runtimeOutputPath,
        bytecodeBytes: 4,
        bytecodeHash: "0x5e3ce470a8506d55e59815db7232a08774174ae0c7fdb2fbc81a49e4e242b0d6",
        runtimeBytecodeBytes: 40,
        runtimeTemplateHash: keccak256(runtimeBytecode),
      });
      assert.equal(await readFile(outputPath, "utf8"), `${creationBytecode}\n`);
      assert.deepEqual(JSON.parse(await readFile(runtimeOutputPath, "utf8")), {
        bytecode: runtimeBytecode,
        immutableReferences: [{ start: 16, length: 20 }],
        creationCodeHash: keccak256(creationBytecode),
        runtimeTemplateHash: keccak256(runtimeBytecode),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("AgentPayAccountV2 runtime artifact", () => {
  it("normalizes each 32-byte Foundry address slot to its 20-byte owner payload", () => {
    assert.deepEqual(extractAgentPayAccountV2RuntimeArtifact(foundryArtifact()), {
      bytecode: runtimeBytecode,
      immutableReferences: [{ start: 16, length: 20 }],
      creationCodeHash: keccak256(creationBytecode),
      runtimeTemplateHash: keccak256(runtimeBytecode),
    });
  });

  it("binds only the immutable owner bytes and returns a deterministic runtime hash", () => {
    const artifact = extractAgentPayAccountV2RuntimeArtifact(foundryArtifact());
    const owner = `0x${"ab".repeat(20)}`;
    const expectedBytecode = `0x${"11".repeat(4)}${"00".repeat(12)}${"ab".repeat(20)}${"22".repeat(4)}`;

    const first = bindRuntimeOwner(artifact, owner);
    const second = bindRuntimeOwner(structuredClone(artifact), owner.toUpperCase().replace("0X", "0x"));

    assert.deepEqual(first, { bytecode: expectedBytecode, runtimeCodeHash: keccak256(expectedBytecode) });
    assert.deepEqual(second, first);
    assert.equal(artifact.bytecode, runtimeBytecode);
  });

  it("rejects malformed immutable slots, offsets, owners, and pre-bound templates", () => {
    assert.throws(
      () => extractAgentPayAccountV2RuntimeArtifact(foundryArtifact({
        bytecode: { object: creationBytecode },
        deployedBytecode: {
          object: runtimeBytecode,
          immutableReferences: { "2277": [{ start: 4, length: 31 }] },
        },
      })),
      /immutable reference/i,
    );
    assert.throws(
      () => extractAgentPayAccountV2RuntimeArtifact(foundryArtifact({
        bytecode: { object: creationBytecode },
        deployedBytecode: {
          object: runtimeBytecode,
          immutableReferences: { "2277": [{ start: 20, length: 32 }] },
        },
      })),
      /immutable reference/i,
    );

    const artifact = extractAgentPayAccountV2RuntimeArtifact(foundryArtifact());
    assert.throws(() => bindRuntimeOwner(artifact, "0x1234"), /owner/i);
    const prebound = structuredClone(artifact);
    prebound.bytecode = `0x${"11".repeat(4)}${"00".repeat(12)}${"ab".repeat(20)}${"22".repeat(4)}`;
    assert.throws(() => bindRuntimeOwner(prebound, `0x${"cd".repeat(20)}`), /template/i);
  });

  it("binds the tracked runtime template to the known owner-specific deployed hash", async () => {
    const artifact = JSON.parse(
      await readFile(new URL("../packages/cli/assets/AgentPayAccountV2.runtime.json", import.meta.url), "utf8"),
    );

    assert.equal(artifact.creationCodeHash, "0x41fb5a4c59d1af753553e5dcf9e9ed345506ecaa8040298d17dc9c629fbd5b49");
    assert.equal(artifact.immutableReferences.length, 14);
    assert.equal(
      bindRuntimeOwner(artifact, "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7").runtimeCodeHash,
      "0xdbecd7f561aed661107064b029bb64660db94b1e5c2a448316a062314ee20d6f",
    );
  });
});
