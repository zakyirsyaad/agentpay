import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packagePaths = ["packages/skill", "packages/shared", "apps/mcp-server", "apps/setup-web", "packages/cli"];
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

async function main() {
  const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const packDir = await mkdtemp(join(tmpdir(), "agentpay-release-pack-"));
  const appDir = await mkdtemp(join(tmpdir(), "agentpay-release-app-"));
  const installDir = await mkdtemp(join(tmpdir(), "agentpay-release-install-"));
  const selfHostedInstallDir = await mkdtemp(join(tmpdir(), "agentpay-release-self-hosted-"));
  const claudeHomeDir = await mkdtemp(join(tmpdir(), "agentpay-release-claude-home-"));
  const claudeInstallDir = await mkdtemp(join(tmpdir(), "agentpay-release-claude-install-"));
  const cursorHomeDir = await mkdtemp(join(tmpdir(), "agentpay-release-cursor-home-"));
  const cursorInstallDir = await mkdtemp(join(tmpdir(), "agentpay-release-cursor-install-"));
  const hermesHomeDir = await mkdtemp(join(tmpdir(), "agentpay-release-hermes-home-"));
  const hermesInstallDir = await mkdtemp(join(tmpdir(), "agentpay-release-hermes-install-"));
  const claudeHomeEnv = createHomeEnv(claudeHomeDir);
  const cursorHomeEnv = createHomeEnv(cursorHomeDir);
  const hermesHomeEnv = createHomeEnv(hermesHomeDir);

  try {
    const tarballs = packagePaths.map((packagePath) =>
      packPackage({
        rootDir,
        packagePath,
        packDir,
      }),
    );

    run(npmCommand, ["init", "-y"], { cwd: appDir, quiet: true });
    await mkdir(join(appDir, ".codex"));
    run(npmCommand, ["install", "--ignore-scripts", ...tarballs], { cwd: appDir, quiet: true });
    run(npxCommand, ["@agentpay-ai/agentpay", "install", "--output-dir", installDir], { cwd: appDir });
    run(npxCommand, ["@agentpay-ai/agentpay", "install", "--self-hosted", "--output-dir", selfHostedInstallDir], {
      cwd: appDir,
    });
    run(npxCommand, ["@agentpay-ai/agentpay", "install", "--runtime", "claude", "--output-dir", claudeInstallDir], {
      cwd: appDir,
      env: claudeHomeEnv,
    });
    run(npxCommand, ["@agentpay-ai/agentpay", "install", "--runtime", "cursor", "--output-dir", cursorInstallDir], {
      cwd: appDir,
      env: cursorHomeEnv,
    });
    run(npxCommand, ["@agentpay-ai/agentpay", "install", "--runtime", "hermes", "--output-dir", hermesInstallDir], {
      cwd: appDir,
      env: hermesHomeEnv,
    });
    run(npxCommand, ["@agentpay-ai/agentpay", "doctor"], {
      cwd: appDir,
      env: {
        AGENTPAY_CONFIG: join(selfHostedInstallDir, "config.json"),
        SUPABASE_URL: "https://agentpay.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
        XLAYER_RPC_URL: "https://rpc.example",
        EXECUTOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        SETUP_DEPLOYER_PRIVATE_KEY: `0x${"2".repeat(64)}`,
      },
    });

    await access(join(installDir, "runtimes", "codex", "AGENTS.md"));
    await access(join(installDir, "runtimes", "codex", "mcp.json"));
    await access(join(installDir, "skills", "agentpay", "SKILL.md"));
    await access(join(installDir, "skills", "agentpay", "agents", "openai.yaml"));
    const mcpConfig = JSON.parse(await readFile(join(installDir, "runtimes", "codex", "mcp.json"), "utf8"));
    if (mcpConfig.mcpServers?.agentpay?.url !== "https://mcp.agentpay.site/mcp") {
      throw new Error("Default AgentPay install did not use the hosted MCP URL.");
    }
    const claudeConfig = JSON.parse(await readFile(getClaudeDesktopConfigPath(claudeHomeEnv), "utf8"));
    if (claudeConfig.mcpServers?.agentpay?.url !== "https://mcp.agentpay.site/mcp") {
      throw new Error("Claude install did not register the hosted AgentPay MCP URL.");
    }
    const cursorConfig = JSON.parse(await readFile(join(cursorHomeDir, ".cursor", "mcp.json"), "utf8"));
    if (cursorConfig.mcpServers?.agentpay?.url !== "https://mcp.agentpay.site/mcp") {
      throw new Error("Cursor install did not register the hosted AgentPay MCP URL.");
    }
    const hermesConfig = await readFile(join(hermesHomeDir, ".hermes", "config.yaml"), "utf8");
    if (!/agentpay:[\s\S]*url: "https:\/\/mcp\.agentpay\.site\/mcp"/.test(hermesConfig)) {
      throw new Error("Hermes install did not register the hosted AgentPay MCP URL.");
    }
    await access(join(selfHostedInstallDir, "AgentPayAccount.bin"));
    await access(join(selfHostedInstallDir, "config.json"));
    console.log("AgentPay release smoke passed.");
  } finally {
    await rm(packDir, { recursive: true, force: true });
    await rm(appDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
    await rm(selfHostedInstallDir, { recursive: true, force: true });
    await rm(claudeHomeDir, { recursive: true, force: true });
    await rm(claudeInstallDir, { recursive: true, force: true });
    await rm(cursorHomeDir, { recursive: true, force: true });
    await rm(cursorInstallDir, { recursive: true, force: true });
    await rm(hermesHomeDir, { recursive: true, force: true });
    await rm(hermesInstallDir, { recursive: true, force: true });
  }
}

function packPackage({ rootDir, packagePath, packDir }) {
  const result = run(npmCommand, ["pack", `./${packagePath}`, "--pack-destination", packDir], {
    cwd: rootDir,
    quiet: true,
  });
  const tarballName = result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

  if (!tarballName) {
    throw new Error(`npm pack did not return a tarball name for ${packagePath}.`);
  }

  return join(packDir, tarballName);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: "utf8",
  });

  if (!options.quiet && result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (!options.quiet && result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}.\n${output}`);
  }

  return result;
}

function createHomeEnv(homeDir) {
  return {
    HOME: homeDir,
    APPDATA: join(homeDir, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(homeDir, ".config"),
  };
}

function getClaudeDesktopConfigPath(env) {
  if (process.platform === "win32") {
    return join(env.APPDATA, "Claude", "claude_desktop_config.json");
  }

  if (process.platform === "darwin") {
    return join(env.HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }

  return join(env.XDG_CONFIG_HOME, "Claude", "claude_desktop_config.json");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "AgentPay release smoke failed.");
  process.exitCode = 1;
});
