#!/usr/bin/env node
import { constants as fsConstants, existsSync } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  startAgentPayHttpServer,
  startAgentPayMcpServer,
  type AgentPayHttpServer,
  type StartAgentPayHttpServerOptions,
  type StartAgentPayMcpServerOptions,
} from "@agentpay-ai/mcp-server";
import {
  createSetupWebDependencies,
  parseSetupWebEnv,
  startSetupWebServer,
  type SetupWebDependencies,
} from "@agentpay-ai/setup-web";

const runtimeNames = ["codex", "claude", "cursor", "generic", "hermes"] as const;
const requiredConfigKeys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "XLAYER_RPC_URL", "EXECUTOR_PRIVATE_KEY"] as const;
const setupRequiredConfigKeys = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "XLAYER_RPC_URL",
  "SETUP_DEPLOYER_PRIVATE_KEY",
] as const;
const optionalConfigKeys = [
  "BASE_RPC_URL",
  "XLAYER_MAINNET_RPC_URL",
  "XLAYER_TESTNET_RPC_URL",
  "SETUP_WEB_URL",
  "LIFI_API_KEY",
  "LIFI_BASE_URL",
  "SETUP_DEPLOYER_PRIVATE_KEY",
  "AGENTPAY_OWNER_ADDRESS",
  "AGENTPAY_EXECUTOR_ADDRESS",
  "AGENTPAY_HOME_CHAIN_ID",
  "AGENTPAY_ACCOUNT_ADDRESS",
  "AGENTPAY_XLAYER_USDT0_ADDRESS",
  "AGENTPAY_XLAYER_USDC_ADDRESS",
  "AGENTPAY_XLAYER_TESTNET_USDT0_ADDRESS",
  "AGENTPAY_XLAYER_TESTNET_USDC_ADDRESS",
  "AGENTPAY_ACCOUNT_BYTECODE_PATH",
  "AGENTPAY_ACCOUNT_BYTECODE",
  "AGENTPAY_INITIAL_ROUTE_TARGETS",
  "SETUP_WEB_PORT",
  "X402_BAZAAR_FACILITATOR_URL",
  "AGENTPAY_A2MCP_PAYMENT_ENABLED",
  "AGENTPAY_A2MCP_PAYMENT_PAY_TO",
  "AGENTPAY_A2MCP_PAYMENT_PRICE",
  "AGENTPAY_A2MCP_PAYMENT_NETWORK",
  "AGENTPAY_A2MCP_PAYMENT_MAX_TIMEOUT_SECONDS",
  "AGENTPAY_A2MCP_PAYMENT_SYNC_SETTLE",
  "AGENTPAY_A2MCP_PAYMENT_ASSET_TRANSFER_METHOD",
  "AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL",
  "OKX_APP_API_KEY",
  "OKX_APP_SECRET_KEY",
  "OKX_APP_PASSPHRASE",
  "OKX_APP_BASE_URL",
] as const;
const privateKeyPattern = /^0x[a-fA-F0-9]{64}$/;
const hexDataPattern = /^0x(?:[a-fA-F0-9]{2})+$/;
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const require = createRequire(import.meta.url);

export type AgentPayRuntimeName = (typeof runtimeNames)[number];

export type AgentPayCliCommand =
  | { command: "install"; runtime: AgentPayRuntimeName; outputDir: string; force: boolean }
  | { command: "mcp" }
  | { command: "serve-http"; hostname: string; port: number }
  | { command: "setup-web" }
  | { command: "doctor" }
  | { command: "help" };

export interface InstallAgentPayOptions {
  runtime: AgentPayRuntimeName;
  outputDir: string;
  packageRoot?: string;
  force?: boolean;
}

export interface InstallAgentPayResult {
  outputDir: string;
  runtime: AgentPayRuntimeName;
  writtenFiles: string[];
}

export interface RunAgentPayCliDependencies {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  startMcpServer?: (options: StartAgentPayMcpServerOptions) => Promise<void>;
  startHttpServer?: (options: StartAgentPayHttpServerOptions) => Promise<AgentPayHttpServer>;
  startSetupWebServer?: (
    dependencies: SetupWebDependencies,
    options?: { port?: number; hostname?: string },
  ) => Promise<{ close(): Promise<void>; url: string }>;
  install?: (options: InstallAgentPayOptions) => Promise<InstallAgentPayResult>;
}

export interface AgentPayDoctorSection {
  status: "ready" | "missing" | "invalid";
  missing: string[];
  invalid: string[];
}

export interface AgentPayDoctorReport {
  ok: boolean;
  mcp: AgentPayDoctorSection;
  setup: AgentPayDoctorSection;
  text: string;
}

export interface CreateAgentPayConfigOptions {
  accountBytecodePath?: string;
}

export function parseCliArgs(args: string[]): AgentPayCliCommand {
  const [command = "help", ...rest] = args;

  if (command === "mcp") {
    return { command: "mcp" };
  }

  if (command === "serve-http") {
    return {
      command: "serve-http",
      hostname: readOption(rest, "--host") ?? "0.0.0.0",
      port: parsePort(readOption(rest, "--port") ?? "3001"),
    };
  }

  if (command === "doctor") {
    return { command: "doctor" };
  }

  if (command === "setup-web") {
    return { command: "setup-web" };
  }

  if (command === "install") {
    return {
      command: "install",
      runtime: parseRuntime(readOption(rest, "--runtime") ?? "generic"),
      outputDir: expandHome(readOption(rest, "--output-dir") ?? "~/.agentpay"),
      force: rest.includes("--force"),
    };
  }

  if (command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }

  throw new Error(`Unknown AgentPay command: ${command}`);
}

export async function runAgentPayCli(
  args: string[],
  dependencies: RunAgentPayCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((message: string) => console.log(message));
  const stderr = dependencies.stderr ?? ((message: string) => console.error(message));

  try {
    const command = parseCliArgs(args);

    if (command.command === "help") {
      stdout(createHelpText());
      return 0;
    }

    if (command.command === "mcp") {
      const env = await loadAgentPayConfigEnv(dependencies.env ?? process.env);
      await (dependencies.startMcpServer ?? startAgentPayMcpServer)({ env });
      return 0;
    }

    if (command.command === "serve-http") {
      const env = await loadAgentPayConfigEnv(dependencies.env ?? process.env);
      const server = await (dependencies.startHttpServer ?? startAgentPayHttpServer)({
        env,
        hostname: command.hostname,
        port: command.port,
      });
      stdout(`AgentPay public MCP listening at ${server.mcpUrl}`);
      stdout(`AgentPay health check at ${server.healthUrl}`);
      return 0;
    }

    if (command.command === "doctor") {
      const report = await runAgentPayDoctor(dependencies.env ?? process.env);
      stdout(report.text);
      return report.ok ? 0 : 1;
    }

    if (command.command === "setup-web") {
      const env = await loadAgentPayConfigEnv(dependencies.env ?? process.env);
      const config = parseSetupWebEnv(env);
      const server = await (dependencies.startSetupWebServer ?? startSetupWebServer)(
        createSetupWebDependencies(config),
        {
          port: config.setupWebPort ?? 3000,
        },
      );
      stdout(`AgentPay setup web listening at ${server.url}`);
      return 0;
    }

    const installCommand = {
      ...command,
      runtime: hasOption(args, "--runtime") ? command.runtime : detectAgentPayRuntime(process.cwd()) ?? command.runtime,
    };
    const result = await (dependencies.install ?? installAgentPay)(installCommand);
    stdout(`AgentPay installed for ${result.runtime} at ${result.outputDir}`);
    stdout(`Wrote ${result.writtenFiles.length} files.`);
    return 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : "AgentPay CLI failed.");
    return 1;
  }
}

export async function installAgentPay(options: InstallAgentPayOptions): Promise<InstallAgentPayResult> {
  const packageRoot = options.packageRoot ?? findPackageRoot();
  const cliRoot = resolveCliPackageRoot(packageRoot);
  const skillRoot = resolveAgentPaySkillRoot(packageRoot);
  const runtimeDir = join(options.outputDir, "runtimes", options.runtime);
  const skillDir = join(options.outputDir, "skills", "agentpay");
  const templateDir = join(cliRoot, "templates", options.runtime);
  const templateFiles = getRuntimeTemplateFiles(options.runtime);
  const bytecodePath = join(options.outputDir, "AgentPayAccount.bin");
  const filesToWrite = [
    {
      from: undefined,
      to: join(options.outputDir, "config.json"),
      contents: `${JSON.stringify(createAgentPayConfig({ accountBytecodePath: bytecodePath }), null, 2)}\n`,
    },
    {
      from: join(cliRoot, "assets", "AgentPayAccount.bin"),
      to: bytecodePath,
      contents: undefined,
    },
    {
      from: join(skillRoot, "SKILL.md"),
      to: join(skillDir, "SKILL.md"),
      contents: undefined,
    },
    {
      from: join(skillRoot, "agents", "openai.yaml"),
      to: join(skillDir, "agents", "openai.yaml"),
      contents: undefined,
    },
    ...templateFiles.map((fileName) => ({
      from: join(templateDir, fileName),
      to: join(runtimeDir, fileName),
      contents: undefined,
    })),
  ];

  await Promise.all(filesToWrite.map((file) => assertWritable(file.to, Boolean(options.force))));
  await mkdir(runtimeDir, { recursive: true });

  const writtenFiles = await Promise.all(
    filesToWrite.map(async (file) => {
      await mkdir(dirname(file.to), { recursive: true });

      if (file.contents !== undefined) {
        await writeFile(file.to, file.contents, "utf8");
      } else if (file.from) {
        await copyFile(file.from, file.to);
      }

      return file.to;
    }),
  );

  return {
    outputDir: options.outputDir,
    runtime: options.runtime,
    writtenFiles,
  };
}

export function createAgentPayConfig(options: CreateAgentPayConfigOptions = {}): Record<string, string> {
  return {
    ...Object.fromEntries([...requiredConfigKeys, ...optionalConfigKeys].map((key) => [key, ""])),
    AGENTPAY_ACCOUNT_BYTECODE_PATH: options.accountBytecodePath ?? "",
  };
}

export async function loadAgentPayConfigEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<Record<string, string | undefined>> {
  const configPath = env.AGENTPAY_CONFIG ? expandHome(env.AGENTPAY_CONFIG) : undefined;

  if (!configPath) {
    return { ...env };
  }

  const rawConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const configEnv = Object.fromEntries(
    Object.entries(rawConfig)
      .filter(([, value]) => typeof value === "string")
      .map(([key, value]) => [key, value as string]),
  );

  return {
    ...configEnv,
    ...env,
  };
}

export async function runAgentPayDoctor(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<AgentPayDoctorReport> {
  const merged = await loadAgentPayConfigEnv(env);
  const normalized = normalizeEnv(merged);
  const mcp = validateMcpConfig(normalized);
  const setup = await validateSetupConfig(normalized);
  const ok = mcp.status === "ready" && setup.status === "ready";

  return {
    ok,
    mcp,
    setup,
    text: [
      "AgentPay doctor",
      formatDoctorSection("MCP runtime", mcp),
      formatDoctorSection("Setup web", setup),
      ok ? "Ready: MCP and setup web configuration are complete." : "Not ready: fill the missing or invalid config names above.",
    ].join("\n"),
  };
}

function parseRuntime(value: string): AgentPayRuntimeName {
  if (runtimeNames.includes(value as AgentPayRuntimeName)) {
    return value as AgentPayRuntimeName;
  }

  throw new Error(`Unsupported AgentPay runtime: ${value}`);
}

function parsePort(value: string): number {
  if (!isPort(value)) {
    throw new Error(`Unsupported AgentPay HTTP port: ${value}`);
  }

  return Number(value);
}

function validateMcpConfig(env: Record<string, string | undefined>): AgentPayDoctorSection {
  const missing = requiredConfigKeys.filter((name) => !env[name]);
  const invalid = [
    env.SUPABASE_URL && !isHttpUrl(env.SUPABASE_URL) ? "SUPABASE_URL" : undefined,
    env.XLAYER_RPC_URL && !isHttpUrl(env.XLAYER_RPC_URL) ? "XLAYER_RPC_URL" : undefined,
    env.XLAYER_MAINNET_RPC_URL && !isHttpUrl(env.XLAYER_MAINNET_RPC_URL)
      ? "XLAYER_MAINNET_RPC_URL"
      : undefined,
    env.XLAYER_TESTNET_RPC_URL && !isHttpUrl(env.XLAYER_TESTNET_RPC_URL)
      ? "XLAYER_TESTNET_RPC_URL"
      : undefined,
    env.EXECUTOR_PRIVATE_KEY && !privateKeyPattern.test(env.EXECUTOR_PRIVATE_KEY)
      ? "EXECUTOR_PRIVATE_KEY"
      : undefined,
    env.LIFI_BASE_URL && !isHttpUrl(env.LIFI_BASE_URL) ? "LIFI_BASE_URL" : undefined,
    env.X402_BAZAAR_FACILITATOR_URL && !isHttpUrl(env.X402_BAZAAR_FACILITATOR_URL)
      ? "X402_BAZAAR_FACILITATOR_URL"
      : undefined,
    env.SETUP_WEB_URL && !isHttpUrl(env.SETUP_WEB_URL) ? "SETUP_WEB_URL" : undefined,
  ].filter((name): name is string => Boolean(name));

  return createDoctorSection(missing, invalid);
}

async function validateSetupConfig(env: Record<string, string | undefined>): Promise<AgentPayDoctorSection> {
  const hasInlineBytecode = Boolean(env.AGENTPAY_ACCOUNT_BYTECODE);
  const hasBytecodePath = Boolean(env.AGENTPAY_ACCOUNT_BYTECODE_PATH);
  const missing = [
    ...setupRequiredConfigKeys.filter((name) => !env[name]),
    !hasInlineBytecode && !hasBytecodePath ? "AGENTPAY_ACCOUNT_BYTECODE" : undefined,
  ].filter((name): name is string => Boolean(name));
  const invalid = [
    env.SUPABASE_URL && !isHttpUrl(env.SUPABASE_URL) ? "SUPABASE_URL" : undefined,
    env.XLAYER_RPC_URL && !isHttpUrl(env.XLAYER_RPC_URL) ? "XLAYER_RPC_URL" : undefined,
    env.XLAYER_MAINNET_RPC_URL && !isHttpUrl(env.XLAYER_MAINNET_RPC_URL)
      ? "XLAYER_MAINNET_RPC_URL"
      : undefined,
    env.XLAYER_TESTNET_RPC_URL && !isHttpUrl(env.XLAYER_TESTNET_RPC_URL)
      ? "XLAYER_TESTNET_RPC_URL"
      : undefined,
    env.SETUP_DEPLOYER_PRIVATE_KEY && !privateKeyPattern.test(env.SETUP_DEPLOYER_PRIVATE_KEY)
      ? "SETUP_DEPLOYER_PRIVATE_KEY"
      : undefined,
    env.AGENTPAY_ACCOUNT_BYTECODE && !hexDataPattern.test(env.AGENTPAY_ACCOUNT_BYTECODE)
      ? "AGENTPAY_ACCOUNT_BYTECODE"
      : undefined,
    env.AGENTPAY_ACCOUNT_BYTECODE_PATH && !(await canReadFile(env.AGENTPAY_ACCOUNT_BYTECODE_PATH))
      ? "AGENTPAY_ACCOUNT_BYTECODE_PATH"
      : undefined,
    parseAddressList(env.AGENTPAY_INITIAL_ROUTE_TARGETS).some((target) => !addressPattern.test(target))
      ? "AGENTPAY_INITIAL_ROUTE_TARGETS"
      : undefined,
    env.AGENTPAY_HOME_CHAIN_ID && !isSetupHomeChainId(env.AGENTPAY_HOME_CHAIN_ID)
      ? "AGENTPAY_HOME_CHAIN_ID"
      : undefined,
    env.AGENTPAY_ACCOUNT_ADDRESS && !addressPattern.test(env.AGENTPAY_ACCOUNT_ADDRESS)
      ? "AGENTPAY_ACCOUNT_ADDRESS"
      : undefined,
    ...validateStableTokenOverrideAddresses(env),
    env.SETUP_WEB_PORT && !isPort(env.SETUP_WEB_PORT) ? "SETUP_WEB_PORT" : undefined,
  ].filter((name): name is string => Boolean(name));

  return createDoctorSection(missing, invalid);
}

function createDoctorSection(missing: string[], invalid: string[]): AgentPayDoctorSection {
  return {
    status: missing.length > 0 ? "missing" : invalid.length > 0 ? "invalid" : "ready",
    missing,
    invalid,
  };
}

function formatDoctorSection(label: string, section: AgentPayDoctorSection): string {
  if (section.status === "ready") {
    return `${label}: ready`;
  }

  const parts = [
    section.missing.length > 0 ? `missing ${section.missing.join(", ")}` : undefined,
    section.invalid.length > 0 ? `invalid ${section.invalid.join(", ")}` : undefined,
  ].filter(Boolean);

  return `${label}: ${parts.join("; ")}`;
}

function normalizeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value?.trim() === "" ? undefined : value?.trim()]),
  );
}

function parseAddressList(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];
}

async function canReadFile(path: string): Promise<boolean> {
  try {
    await access(expandHome(path), fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPort(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535;
}

function isSetupHomeChainId(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && [196, 1952].includes(parsed);
}

function validateStableTokenOverrideAddresses(env: Record<string, string | undefined>): string[] {
  return [
    "AGENTPAY_XLAYER_USDT0_ADDRESS",
    "AGENTPAY_XLAYER_USDC_ADDRESS",
    "AGENTPAY_XLAYER_TESTNET_USDT0_ADDRESS",
    "AGENTPAY_XLAYER_TESTNET_USDC_ADDRESS",
  ].filter((name) => env[name] && !addressPattern.test(env[name]));
}

function readOption(args: string[], optionName: string): string | undefined {
  const index = args.indexOf(optionName);

  if (index >= 0) {
    return args[index + 1];
  }

  const inlineOption = args.find((arg) => arg.startsWith(`${optionName}=`));
  return inlineOption ? inlineOption.slice(optionName.length + 1) : undefined;
}

function hasOption(args: string[], optionName: string): boolean {
  return args.some((arg) => arg === optionName || arg.startsWith(`${optionName}=`));
}

function detectAgentPayRuntime(projectDir: string): AgentPayRuntimeName | undefined {
  const markers: Array<{ runtime: AgentPayRuntimeName; paths: string[] }> = [
    { runtime: "codex", paths: [".codex"] },
    { runtime: "cursor", paths: [".cursor"] },
    { runtime: "claude", paths: [".claude", "CLAUDE.md"] },
    { runtime: "hermes", paths: [".hermes"] },
  ];

  return markers.find((marker) => marker.paths.some((path) => existsSync(join(projectDir, path))))?.runtime;
}

function getRuntimeTemplateFiles(runtime: AgentPayRuntimeName): string[] {
  if (runtime === "claude") {
    return ["CLAUDE.md", "claude_desktop_config.json"];
  }

  if (runtime === "cursor") {
    return ["mcp.json", "rules.md"];
  }

  if (runtime === "codex") {
    return ["AGENTS.md", "mcp.json"];
  }

  return ["instructions.md", "mcp.json"];
}

async function assertWritable(path: string, force: boolean): Promise<void> {
  try {
    await access(path, fsConstants.F_OK);
  } catch {
    return;
  }

  if (!force) {
    throw new Error(`${path} already exists. Re-run with --force to overwrite it.`);
  }
}

function findPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function resolveCliPackageRoot(packageRoot: string): string {
  if (existsSync(join(packageRoot, "assets")) && existsSync(join(packageRoot, "templates"))) {
    return packageRoot;
  }

  return packageRoot.endsWith(join("packages", "cli")) ? packageRoot : join(packageRoot, "packages", "cli");
}

function resolveAgentPaySkillRoot(packageRoot: string): string {
  const currentPackageRoot = findPackageRoot();
  const candidates = [
    join(packageRoot, "skill"),
    join(packageRoot, "packages", "skill"),
    join(dirname(packageRoot), "skill"),
    join(dirname(currentPackageRoot), "skill"),
    join(process.cwd(), "packages", "skill"),
  ];
  const localRoot = candidates.find((candidate) => existsSync(join(candidate, "SKILL.md")));

  if (localRoot) {
    return localRoot;
  }

  try {
    return dirname(require.resolve("@agentpay-ai/skill/package.json"));
  } catch {
    throw new Error("AgentPay skill package was not found.");
  }
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function createHelpText(): string {
  return [
    "AgentPay",
    "",
    "Commands:",
    "  agentpay install [--runtime <codex|claude|cursor|generic|hermes>] [--output-dir ~/.agentpay] [--force]",
    "  agentpay doctor",
    "  agentpay setup-web",
    "  agentpay mcp",
    "  agentpay serve-http [--host 0.0.0.0] [--port 3001]",
  ].join("\n");
}

if (isMainModule(import.meta.url, process.argv[1])) {
  void runAgentPayCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

function isMainModule(moduleUrl: string, entrypoint: string | undefined): boolean {
  return entrypoint !== undefined && fileURLToPath(moduleUrl) === resolve(entrypoint);
}
