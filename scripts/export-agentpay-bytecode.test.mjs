import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { exportAgentPayAccountBytecode, extractAgentPayAccountBytecode } from "./export-agentpay-bytecode.mjs";

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
  it("writes plain hex bytecode for setup-web configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentpay-bytecode-export-"));

    try {
      const artifactPath = join(dir, "AgentPayAccount.json");
      const outputPath = join(dir, "AgentPayAccount.bin");
      await writeFile(
        artifactPath,
        JSON.stringify({
          bytecode: {
            object: "0x60006000",
          },
        }),
        "utf8",
      );

      const result = await exportAgentPayAccountBytecode({ artifactPath, outputPath });

      assert.deepEqual(result, {
        artifactPath,
        outputPath,
        bytecodeBytes: 4,
        bytecodeHash: "0x5e3ce470a8506d55e59815db7232a08774174ae0c7fdb2fbc81a49e4e242b0d6",
      });
      assert.equal(await readFile(outputPath, "utf8"), "0x60006000\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
