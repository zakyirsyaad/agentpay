import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

const publishablePackages = [
  "packages/skill",
  "packages/shared",
  "apps/mcp-server",
  "apps/setup-web",
  "packages/cli",
];
const publishScope = "@agentpay-ai";
const expectedPackageNames = new Map([
  ["packages/skill", "@agentpay-ai/skill"],
  ["packages/shared", "@agentpay-ai/shared"],
  ["apps/mcp-server", "@agentpay-ai/mcp-server"],
  ["apps/setup-web", "@agentpay-ai/setup-web"],
  ["packages/cli", "@agentpay-ai/agentpay"],
]);

async function readPackageJson(packageDir) {
  const path = join(process.cwd(), packageDir, "package.json");
  return JSON.parse(await readFile(path, "utf8"));
}

describe("publishable AgentPay package manifests", () => {
  it("exposes a local tarball smoke command before publishing", async () => {
    const rootManifest = await readPackageJson(".");
    const command = rootManifest.scripts?.["release:smoke"];

    assert.equal(command, "node scripts/smoke-agentpay-release.mjs");
    await access("scripts/smoke-agentpay-release.mjs");
  });

  it("keeps the npx install dependency chain publishable", async () => {
    const packages = new Map(
      await Promise.all(
        publishablePackages.map(async (packageDir) => {
          const manifest = await readPackageJson(packageDir);
          assert.equal(
            manifest.name,
            expectedPackageNames.get(packageDir),
            `${packageDir} must publish under the ${publishScope} npm org`,
          );
          return [manifest.name, { packageDir, manifest }];
        }),
      ),
    );

    for (const { packageDir, manifest } of packages.values()) {
      assert.notEqual(manifest.private, true, `${packageDir} must be publishable`);
      assert.ok(Array.isArray(manifest.files), `${packageDir} must explicitly whitelist package files`);
      assert.ok(manifest.files.length > 0, `${packageDir} must include package files`);

      for (const filePattern of manifest.files) {
        assert.doesNotMatch(filePattern, /\.test\./, `${packageDir} must not publish test files`);
      }

      if (manifest.name.startsWith(`${publishScope}/`)) {
        assert.equal(manifest.publishConfig?.access, "public", `${packageDir} scoped package must publish public`);
      }
    }

    for (const { packageDir, manifest } of packages.values()) {
      for (const [dependencyName, dependencyVersion] of Object.entries(manifest.dependencies ?? {})) {
        const dependency = packages.get(dependencyName);

        if (!dependency) {
          continue;
        }

        assert.equal(
          dependencyVersion,
          dependency.manifest.version,
          `${packageDir} must depend on published ${dependencyName} ${dependency.manifest.version}`,
        );
      }
    }
  });

  it("declares runtime dependencies in the package that imports them", async () => {
    const rootManifest = await readPackageJson(".");
    const expectedDependencies = {
      "@agentpay-ai/shared": {
        "@noble/hashes": rootManifest.dependencies["@noble/hashes"],
        zod: rootManifest.dependencies.zod,
      },
      "@agentpay-ai/mcp-server": {
        "@supabase/supabase-js": rootManifest.dependencies["@supabase/supabase-js"],
        ethers: rootManifest.dependencies.ethers,
      },
      "@agentpay-ai/setup-web": {
        ethers: rootManifest.dependencies.ethers,
      },
      "@agentpay-ai/agentpay": {
        "@agentpay-ai/skill": "0.1.0",
      },
    };

    const packages = new Map(
      await Promise.all(
        publishablePackages.map(async (packageDir) => {
          const manifest = await readPackageJson(packageDir);
          return [manifest.name, { packageDir, manifest }];
        }),
      ),
    );

    for (const [packageName, dependencies] of Object.entries(expectedDependencies)) {
      const entry = packages.get(packageName);
      assert.ok(entry, `${packageName} package must exist`);

      for (const [dependencyName, dependencyVersion] of Object.entries(dependencies)) {
        assert.equal(
          entry.manifest.dependencies?.[dependencyName],
          dependencyVersion,
          `${entry.packageDir} must declare ${dependencyName} as a direct runtime dependency`,
        );
      }
    }
  });

  it("keeps the CLI bin wrapper trackable by Git", () => {
    const result = spawnSync("git", ["check-ignore", "-q", "packages/cli/dist/index.js"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 1, "packages/cli/dist/index.js must not be ignored");
  });

  it("keeps the CLI bin path in npm publish-normalized form", async () => {
    const manifest = await readPackageJson("packages/cli");

    assert.equal(manifest.bin?.agentpay, "dist/index.js");
  });

  it("keeps the published CLI wrapper resolving tsx from its package dependency", async () => {
    const wrapper = await readFile("packages/cli/dist/index.js", "utf8");

    assert.match(wrapper, /createRequire\(import\.meta\.url\)/);
    assert.match(wrapper, /require\.resolve\("tsx"\)/);
    assert.doesNotMatch(wrapper, /\["--import", "tsx"/);
  });
});
