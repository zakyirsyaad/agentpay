import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createAgentPayConfig,
  installAgentPay,
  loadAgentPayConfigEnv,
  parseCliArgs,
  runAgentPayDoctor,
  runAgentPayCli,
} from "./index.ts";

const cliFixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("parseCliArgs", () => {
  it("parses install runtime, output directory, and force flag", () => {
    assert.deepEqual(parseCliArgs(["install", "--runtime", "codex", "--output-dir", "/tmp/agentpay", "--force"]), {
      command: "install",
      runtime: "codex",
      outputDir: "/tmp/agentpay",
      force: true,
      selfHosted: false,
      mcpUrl: "https://mcp.agentpay.site/mcp",
    });
  });

  it("parses self-hosted install mode", () => {
    assert.deepEqual(parseCliArgs(["install", "--self-hosted", "--mcp-url", "https://mcp.example/mcp"]), {
      command: "install",
      runtime: "generic",
      outputDir: `${process.env.HOME}/.agentpay`,
      force: false,
      selfHosted: true,
      mcpUrl: "https://mcp.example/mcp",
    });
  });

  it("parses mcp command", () => {
    assert.deepEqual(parseCliArgs(["mcp"]), {
      command: "mcp",
    });
  });

  it("parses doctor command", () => {
    assert.deepEqual(parseCliArgs(["doctor"]), {
      command: "doctor",
    });
  });

  it("parses setup-web command", () => {
    assert.deepEqual(parseCliArgs(["setup-web"]), {
      command: "setup-web",
    });
  });

  it("parses serve-http command", () => {
    assert.deepEqual(parseCliArgs(["serve-http", "--host", "0.0.0.0", "--port", "8080"]), {
      command: "serve-http",
      hostname: "0.0.0.0",
      port: 8080,
    });
  });
});

describe("installAgentPay", () => {
  it("writes config and runtime templates into the output directory", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "agentpay-cli-"));

    try {
      const result = await installAgentPay({
        runtime: "codex",
        outputDir,
        packageRoot: process.cwd(),
      });

      const mcpConfig = JSON.parse(await readFile(join(outputDir, "runtimes", "codex", "mcp.json"), "utf8"));
      const instructions = await readFile(join(outputDir, "runtimes", "codex", "AGENTS.md"), "utf8");
      const skill = await readFile(join(outputDir, "skills", "agentpay", "SKILL.md"), "utf8");
      const skillMetadata = await readFile(join(outputDir, "skills", "agentpay", "agents", "openai.yaml"), "utf8");

      assert.match(skill, /Requires exact chat approval before execution/);
      assert.match(skillMetadata, /display_name: AgentPay/);
      assert.deepEqual(mcpConfig.mcpServers.agentpay, {
        url: "https://mcp.agentpay.site/mcp",
      });
      assert.match(instructions, /return to the agent chat/i);
      assert.match(instructions, /hosted AgentPay MCP/i);
      assert.doesNotMatch(instructions, /fills? the generated config/i);
      assert.match(instructions, /prepare_wallet_creation/);
      assert.match(instructions, /check_wallet_creation/);
      assert.match(instructions, /Never call `execute_payment`/);
      assert.match(instructions, /call `track_payment`/);
      assert.deepEqual(result.writtenFiles.sort(), [
        join(outputDir, "runtimes", "codex", "AGENTS.md"),
        join(outputDir, "runtimes", "codex", "mcp.json"),
        join(outputDir, "skills", "agentpay", "SKILL.md"),
        join(outputDir, "skills", "agentpay", "agents", "openai.yaml"),
      ].sort());
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("writes self-hosted config, bytecode, and local MCP command only when requested", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "agentpay-cli-"));

    try {
      const result = await installAgentPay({
        runtime: "codex",
        outputDir,
        packageRoot: process.cwd(),
        selfHosted: true,
      });

      const config = JSON.parse(await readFile(join(outputDir, "config.json"), "utf8"));
      const bytecodePath = join(outputDir, "AgentPayAccount.bin");
      const bytecode = await readFile(bytecodePath, "utf8");
      const mcpConfig = JSON.parse(await readFile(join(outputDir, "runtimes", "codex", "mcp.json"), "utf8"));

      assert.deepEqual(
        config,
        createAgentPayConfig({
          accountBytecodePath: bytecodePath,
        }),
      );
      assert.equal("SETUP_DEPLOYER_PRIVATE_KEY" in config, true);
      assert.equal("XLAYER_MAINNET_RPC_URL" in config, true);
      assert.equal("XLAYER_TESTNET_RPC_URL" in config, true);
      assert.equal("AGENTPAY_OWNER_ADDRESS" in config, true);
      assert.equal("AGENTPAY_EXECUTOR_ADDRESS" in config, true);
      assert.equal("AGENTPAY_INITIAL_ROUTE_TARGETS" in config, true);
      assert.equal("X402_BAZAAR_FACILITATOR_URL" in config, true);
      assert.equal("SETUP_WEB_PORT" in config, true);
      assert.equal(config.AGENTPAY_ACCOUNT_BYTECODE_PATH, bytecodePath);
      assert.match(bytecode, /^0x[a-fA-F0-9]{200,}\n$/);
      assert.equal(mcpConfig.mcpServers.agentpay.command, "npx");
      assert.deepEqual(mcpConfig.mcpServers.agentpay.args, ["-y", "@agentpay-ai/agentpay", "mcp"]);
      assert.deepEqual(mcpConfig.mcpServers.agentpay.env, {
        AGENTPAY_CONFIG: "~/.agentpay/config.json",
      });
      assert.ok(result.writtenFiles.includes(join(outputDir, "config.json")));
      assert.ok(result.writtenFiles.includes(bytecodePath));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps critical payment safety instructions in every runtime template", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "agentpay-cli-"));
    const runtimes = ["codex", "claude", "cursor", "generic", "hermes"] as const;
    const instructionFiles = {
      codex: "AGENTS.md",
      claude: "CLAUDE.md",
      cursor: "rules.md",
      generic: "instructions.md",
      hermes: "instructions.md",
    } as const;

    try {
      for (const runtime of runtimes) {
        await installAgentPay({
          runtime,
          outputDir: join(outputDir, runtime),
          packageRoot: process.cwd(),
          installNativeRuntimeConfig: false,
        });

        const instructions = await readFile(
          join(outputDir, runtime, "runtimes", runtime, instructionFiles[runtime]),
          "utf8",
        );

        assert.match(instructions, /return to the agent chat/i, runtime);
        assert.match(instructions, /setup signature.*not payment approval/i, runtime);
        assert.match(instructions, /prepare_wallet_creation/, runtime);
        assert.match(instructions, /check_wallet_creation/, runtime);
        assert.match(instructions, /get_agent_wallet[\s\S]*get_balance|get_balance[\s\S]*get_agent_wallet/, runtime);
        assert.match(instructions, /Never use raw wallet balances, exchange balances, or generic RPC balance/i, runtime);
        assert.match(instructions, /hosted AgentPay MCP/i, runtime);
        assert.match(instructions, /doctor.*self-hosted|self-hosted.*doctor/i, runtime);
        assert.match(instructions, /setup-web.*self-hosted|self-hosted.*setup-web/i, runtime);
        assert.doesNotMatch(instructions, /fills? the generated config/i, runtime);
        assert.match(instructions, /parse_invoice_payment/, runtime);
        assert.match(instructions, /parse_x402_payment_required/, runtime);
        assert.match(instructions, /search_x402_services/, runtime);
        assert.match(instructions, /prepare_x402_service_request/, runtime);
        assert.match(instructions, /no URL|without a URL|does not provide a URL/i, runtime);
        assert.match(instructions, /check_route_target_allowance/, runtime);
        assert.match(instructions, /prepare_route_target_allowance/, runtime);
        assert.match(instructions, /exact approval phrase/i, runtime);
        assert.match(instructions, /track_payment/, runtime);
        assert.match(instructions, /list_payment_events/, runtime);
        assert.match(instructions, /raw RPC calls?|manual (?:wallet )?transfers?|private[- ]key handling/i, runtime);
      }
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("registers hosted AgentPay MCP in native Hermes config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agentpay-cli-hermes-"));
    const outputDir = join(tempDir, "install");
    const hermesConfigPath = join(tempDir, ".hermes", "config.yaml");

    try {
      await mkdir(dirname(hermesConfigPath), { recursive: true });
      await writeFile(
        hermesConfigPath,
        [
          "_config_version: 9",
          "mcp_servers:",
          "  roblox_studio:",
          '    command: "roblox-studio-mcp"',
          "    enabled: true",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await installAgentPay({
        runtime: "hermes",
        outputDir,
        packageRoot: process.cwd(),
        hermesConfigPath,
      });

      const config = await readFile(hermesConfigPath, "utf8");

      assert.match(config, /mcp_servers:/);
      assert.match(config, /roblox_studio:/);
      assert.match(config, /agentpay:/);
      assert.match(config, /url: "https:\/\/mcp\.agentpay\.site\/mcp"/);
      assert.match(config, /enabled: true/);
      assert.ok(result.writtenFiles.includes(hermesConfigPath));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("registers hosted AgentPay MCP in native Claude Desktop config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agentpay-cli-claude-"));
    const outputDir = join(tempDir, "install");
    const claudeDesktopConfigPath = join(tempDir, "Claude", "claude_desktop_config.json");

    try {
      await mkdir(dirname(claudeDesktopConfigPath), { recursive: true });
      await writeFile(
        claudeDesktopConfigPath,
        `${JSON.stringify(
          {
            preferences: {
              theme: "dark",
            },
            mcpServers: {
              existing: {
                url: "https://example.com/mcp",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = await installAgentPay({
        runtime: "claude",
        outputDir,
        packageRoot: process.cwd(),
        claudeDesktopConfigPath,
      });
      const config = JSON.parse(await readFile(claudeDesktopConfigPath, "utf8"));

      assert.deepEqual(config.preferences, { theme: "dark" });
      assert.deepEqual(config.mcpServers.existing, { url: "https://example.com/mcp" });
      assert.deepEqual(config.mcpServers.agentpay, { url: "https://mcp.agentpay.site/mcp" });
      assert.ok(result.writtenFiles.includes(claudeDesktopConfigPath));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("registers hosted AgentPay MCP in native Cursor config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agentpay-cli-cursor-"));
    const outputDir = join(tempDir, "install");
    const cursorMcpConfigPath = join(tempDir, ".cursor", "mcp.json");

    try {
      await mkdir(dirname(cursorMcpConfigPath), { recursive: true });
      await writeFile(
        cursorMcpConfigPath,
        `${JSON.stringify(
          {
            mcpServers: {
              filesystem: {
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-filesystem"],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = await installAgentPay({
        runtime: "cursor",
        outputDir,
        packageRoot: process.cwd(),
        cursorMcpConfigPath,
      });
      const config = JSON.parse(await readFile(cursorMcpConfigPath, "utf8"));

      assert.deepEqual(config.mcpServers.filesystem, {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
      });
      assert.deepEqual(config.mcpServers.agentpay, { url: "https://mcp.agentpay.site/mcp" });
      assert.ok(result.writtenFiles.includes(cursorMcpConfigPath));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite existing files unless force is enabled", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "agentpay-cli-"));

    try {
      await installAgentPay({ runtime: "generic", outputDir, packageRoot: process.cwd() });
      await assert.rejects(
        () => installAgentPay({ runtime: "generic", outputDir, packageRoot: process.cwd() }),
        /already exists/,
      );

      const forced = await installAgentPay({ runtime: "generic", outputDir, packageRoot: process.cwd(), force: true });

      assert.ok(forced.writtenFiles.includes(join(outputDir, "runtimes", "generic", "mcp.json")));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("installs from a published package root without a workspace packages/cli path", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agentpay-cli-published-"));
    const packageRoot = join(tempDir, "agentpay");
    const outputDir = join(tempDir, "install");

    try {
      await mkdir(join(packageRoot, "assets"), { recursive: true });
      await mkdir(join(packageRoot, "templates", "generic"), { recursive: true });
      await copyFile(
        join(cliFixtureRoot, "assets", "AgentPayAccount.bin"),
        join(packageRoot, "assets", "AgentPayAccount.bin"),
      );
      await copyFile(
        join(cliFixtureRoot, "templates", "generic", "instructions.md"),
        join(packageRoot, "templates", "generic", "instructions.md"),
      );
      await copyFile(
        join(cliFixtureRoot, "templates", "generic", "mcp.json"),
        join(packageRoot, "templates", "generic", "mcp.json"),
      );

      const result = await installAgentPay({
        runtime: "generic",
        outputDir,
        packageRoot,
      });

      const mcpConfig = JSON.parse(await readFile(join(outputDir, "runtimes", "generic", "mcp.json"), "utf8"));

      assert.deepEqual(mcpConfig.mcpServers.agentpay, {
        url: "https://mcp.agentpay.site/mcp",
      });
      assert.ok(result.writtenFiles.includes(join(outputDir, "runtimes", "generic", "instructions.md")));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("loadAgentPayConfigEnv", () => {
  it("merges AGENTPAY_CONFIG JSON with process env values", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "agentpay-cli-"));
    const configPath = join(outputDir, "config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify(
          {
            SUPABASE_URL: "https://agentpay.supabase.co",
            XLAYER_RPC_URL: "https://rpc.example",
            EXECUTOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
          },
          null,
          2,
        ),
      );

      const env = await loadAgentPayConfigEnv({
        AGENTPAY_CONFIG: configPath,
        SUPABASE_SERVICE_ROLE_KEY: "env-service-key",
      });

      assert.equal(env.SUPABASE_URL, "https://agentpay.supabase.co");
      assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, "env-service-key");
      assert.equal(env.XLAYER_RPC_URL, "https://rpc.example");
      assert.equal(env.EXECUTOR_PRIVATE_KEY, `0x${"1".repeat(64)}`);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

describe("runAgentPayDoctor", () => {
  it("reports missing MCP runtime keys without leaking configured secrets", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "agentpay-cli-"));
    const configPath = join(outputDir, "config.json");

    try {
      await writeFile(
        configPath,
        JSON.stringify(
          {
            SUPABASE_URL: "https://agentpay.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
            XLAYER_RPC_URL: "",
            XLAYER_MAINNET_RPC_URL: "mainnet-rpc",
            XLAYER_TESTNET_RPC_URL: "testnet-rpc",
            EXECUTOR_PRIVATE_KEY: "",
          },
          null,
          2,
        ),
      );

      const report = await runAgentPayDoctor({
        AGENTPAY_CONFIG: configPath,
      });

      assert.equal(report.ok, false);
      assert.deepEqual(report.mcp.missing, ["XLAYER_RPC_URL", "EXECUTOR_PRIVATE_KEY"]);
      assert.deepEqual(report.mcp.invalid, ["XLAYER_MAINNET_RPC_URL", "XLAYER_TESTNET_RPC_URL"]);
      assert.match(report.text, /MCP runtime: missing XLAYER_RPC_URL, EXECUTOR_PRIVATE_KEY; invalid XLAYER_MAINNET_RPC_URL, XLAYER_TESTNET_RPC_URL/);
      assert.doesNotMatch(report.text, /service-role-secret/);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reports MCP and setup readiness when required keys are present", async () => {
    const report = await runAgentPayDoctor({
      SUPABASE_URL: "https://agentpay.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
      XLAYER_RPC_URL: "https://rpc.example",
      XLAYER_MAINNET_RPC_URL: "https://mainnet-rpc.example",
      XLAYER_TESTNET_RPC_URL: "https://testnet-rpc.example",
      EXECUTOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      SETUP_DEPLOYER_PRIVATE_KEY: `0x${"2".repeat(64)}`,
      AGENTPAY_ACCOUNT_BYTECODE: "0x6000",
      AGENTPAY_INITIAL_ROUTE_TARGETS: "0x7777777777777777777777777777777777777777",
    });

    assert.equal(report.ok, true);
    assert.equal(report.mcp.status, "ready");
    assert.equal(report.setup.status, "ready");
    assert.match(report.text, /MCP runtime: ready/);
    assert.match(report.text, /Setup web: ready/);
    assert.doesNotMatch(report.text, /service-role-secret/);
    assert.doesNotMatch(report.text, new RegExp(`0x${"1".repeat(64)}`));
  });
});

describe("runAgentPayCli", () => {
  it("detects the target runtime from project markers when install omits --runtime", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agentpay-cli-detect-"));
    const projectDir = join(tempDir, "project");
    const outputDir = join(tempDir, "install");
    const originalCwd = process.cwd();
    let installedRuntime: string | undefined;

    try {
      await mkdir(join(projectDir, ".codex"), { recursive: true });
      process.chdir(projectDir);

      const exitCode = await runAgentPayCli(["install", "--output-dir", outputDir], {
        stdout: () => undefined,
        stderr: () => undefined,
        install: async (options) => {
          installedRuntime = options.runtime;
          return {
            outputDir: options.outputDir,
            runtime: options.runtime,
            writtenFiles: [],
          };
        },
      });

      assert.equal(exitCode, 0);
      assert.equal(installedRuntime, "codex");
    } finally {
      process.chdir(originalCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("starts the MCP server with config-aware env", async () => {
    const startedEnvs: Array<Record<string, string | undefined>> = [];
    const exitCode = await runAgentPayCli(["mcp"], {
      env: {
        SUPABASE_URL: "https://agentpay.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        XLAYER_RPC_URL: "https://rpc.example",
        EXECUTOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      },
      async startMcpServer(options) {
        startedEnvs.push(options.env as Record<string, string | undefined>);
      },
      stdout() {},
      stderr() {},
    });

    assert.equal(exitCode, 0);
    assert.equal(startedEnvs.length, 1);
    assert.equal(startedEnvs[0].SUPABASE_URL, "https://agentpay.supabase.co");
  });

  it("prints doctor results and exits non-zero when required config is missing", async () => {
    const stdoutLines: string[] = [];
    const exitCode = await runAgentPayCli(["doctor"], {
      env: {
        SUPABASE_URL: "https://agentpay.supabase.co",
      },
      stdout(message) {
        stdoutLines.push(message);
      },
      stderr() {},
    });

    assert.equal(exitCode, 1);
    assert.match(stdoutLines.join("\n"), /MCP runtime: missing/);
  });

  it("starts setup web with config-aware env", async () => {
    const stdoutLines: string[] = [];
    const started: Array<{ port?: number }> = [];
    const exitCode = await runAgentPayCli(["setup-web"], {
      env: {
        SUPABASE_URL: "https://agentpay.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        XLAYER_RPC_URL: "https://rpc.example",
        SETUP_DEPLOYER_PRIVATE_KEY: `0x${"2".repeat(64)}`,
        AGENTPAY_ACCOUNT_BYTECODE: "0x6000",
        SETUP_WEB_PORT: "3333",
      },
      async startSetupWebServer(_dependencies, options) {
        started.push({ port: options?.port });
        return {
          url: "http://127.0.0.1:3333/setup",
          async close() {},
        };
      },
      stdout(message) {
        stdoutLines.push(message);
      },
      stderr() {},
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(started, [{ port: 3333 }]);
    assert.match(stdoutLines.join("\n"), /AgentPay setup web listening at http:\/\/127\.0\.0\.1:3333\/setup/);
  });

  it("starts the public MCP HTTP server with config-aware env", async () => {
    const stdoutLines: string[] = [];
    const started: Array<{ port?: number; hostname?: string; env?: Record<string, string | undefined> }> = [];
    const exitCode = await runAgentPayCli(["serve-http", "--host", "0.0.0.0", "--port", "8080"], {
      env: {
        SUPABASE_URL: "https://agentpay.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        XLAYER_RPC_URL: "https://rpc.example",
        EXECUTOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      },
      async startHttpServer(options) {
        started.push({
          port: options.port,
          hostname: options.hostname,
          env: options.env as Record<string, string | undefined>,
        });
        return {
          url: "http://0.0.0.0:8080",
          mcpUrl: "http://0.0.0.0:8080/mcp",
          healthUrl: "http://0.0.0.0:8080/healthz",
          async close() {},
        };
      },
      stdout(message) {
        stdoutLines.push(message);
      },
      stderr() {},
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(started, [
      {
        port: 8080,
        hostname: "0.0.0.0",
        env: {
          SUPABASE_URL: "https://agentpay.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
          XLAYER_RPC_URL: "https://rpc.example",
          EXECUTOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        },
      },
    ]);
    assert.match(stdoutLines.join("\n"), /AgentPay public MCP listening at http:\/\/0\.0\.0\.0:8080\/mcp/);
  });
});
