import { constants, type Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  Hs256SetupJwtSigner,
  ROLE_PROBES,
  WEB_ROLE,
  WEB_TOKEN_ENV_KEY,
  WORKER_ROLE,
  WORKER_TOKEN_ENV_KEY,
  assertPrivateFileMetadata,
  parseRotatorConfiguration,
  redactSensitiveText,
  replaceScopedToken,
  validateApplicationEnvironment,
  verifySetupJwt,
  type RotatorConfiguration,
  type SetupJwtSigner,
  type SetupRole,
} from "./setup-jwt-rotation.ts";

const execFile = promisify(execFileCallback);
const EXPECTED_APPLICATION_MODE = 0o640;
const CONFIGURATION_MODE = 0o600;
const BACKUP_MODE = 0o600;
const STATE_DIRECTORY_MODE = 0o700;
const HTTP_TIMEOUT_MS = 10_000;

export interface PrivateEnvironmentFile {
  readonly path: string;
  readonly text: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

export type RotationPhase =
  | "lock"
  | "read"
  | "mint"
  | "preflight"
  | "stage"
  | "install"
  | "activate"
  | "readiness"
  | "postflight"
  | "rollback"
  | "cleanup"
  | "complete";

export interface RotationLogEvent {
  readonly timestamp: string;
  readonly phase: RotationPhase;
  readonly status: "started" | "passed" | "failed" | "skipped";
  readonly role?: SetupRole;
  readonly expiresAt?: number;
  readonly httpStatus?: number;
  readonly errorCode?: string;
}

export interface RotationDependencies {
  readonly effectiveUserId: () => number;
  readonly nowSeconds: () => number;
  readonly acquireLock: (
    path: string,
  ) => Promise<Readonly<{ release: () => Promise<void> }> | null>;
  readonly readPrivateFile: (path: string, expectedMode: number) => Promise<PrivateEnvironmentFile>;
  readonly stagePrivateFile: (input: Readonly<{
    targetPath: string;
    text: string;
    uid: number;
    gid: number;
    mode: number;
  }>) => Promise<string>;
  readonly saveRollbackGeneration: (files: readonly PrivateEnvironmentFile[]) => Promise<string>;
  readonly installStagedPair: (input: Readonly<{
    webStage: string;
    webTarget: string;
    workerStage: string;
    workerTarget: string;
  }>) => Promise<void>;
  readonly restoreRollbackGeneration: (generation: string) => Promise<void>;
  readonly pruneRollbackGenerations: (keep: string) => Promise<void>;
  readonly probeRoleIsolation: (input: Readonly<{
    role: SetupRole;
    token: string;
    phase: "pre-install" | "post-install";
  }>) => Promise<void>;
  readonly restartService: (name: string) => Promise<void>;
  readonly requireServiceActive: (name: string) => Promise<void>;
  readonly requireHttpStatus: (url: URL, status: number) => Promise<void>;
  readonly cleanupStage: (path: string) => Promise<void>;
  readonly log: (event: RotationLogEvent) => void;
}

export type RotationResult =
  | Readonly<{ status: "SKIPPED_LOCKED" }>
  | Readonly<{ status: "ROTATED"; expiresAt: number }>;

export async function rotateSetupScopedJwts(
  config: RotatorConfiguration,
  signer: SetupJwtSigner,
  dependencies: RotationDependencies,
): Promise<RotationResult> {
  if (dependencies.effectiveUserId() !== 0) {
    throw new Error("Setup JWT rotation must run as root.");
  }
  const lock = await dependencies.acquireLock(config.lockPath);
  if (!lock) return Object.freeze({ status: "SKIPPED_LOCKED" as const });

  let webStage: string | undefined;
  let workerStage: string | undefined;
  let rollbackGeneration: string | undefined;
  let installationAttempted = false;
  let workerRestartAttempted = false;
  let webRestartAttempted = false;
  let primaryError: unknown;

  try {
    dependencies.log(logEvent("read", "started"));
    const webFile = await dependencies.readPrivateFile(config.webEnvironmentPath, EXPECTED_APPLICATION_MODE);
    const workerFile = await dependencies.readPrivateFile(config.workerEnvironmentPath, EXPECTED_APPLICATION_MODE);
    validateApplicationEnvironment(webFile.text, WEB_ROLE, config.supabaseUrl);
    validateApplicationEnvironment(workerFile.text, WORKER_ROLE, config.supabaseUrl);
    dependencies.log(logEvent("read", "passed"));

    const issuedAt = dependencies.nowSeconds();
    const expiresAt = issuedAt + config.tokenTtlSeconds;
    const webToken = await signer.sign({ role: WEB_ROLE, issuedAt, expiresAt });
    const workerToken = await signer.sign({ role: WORKER_ROLE, issuedAt, expiresAt });
    verifySetupJwt(webToken, config.signingSecret, WEB_ROLE, issuedAt);
    verifySetupJwt(workerToken, config.signingSecret, WORKER_ROLE, issuedAt);
    dependencies.log(logEvent("mint", "passed", { role: WEB_ROLE, expiresAt }));
    dependencies.log(logEvent("mint", "passed", { role: WORKER_ROLE, expiresAt }));

    const nextWebText = replaceScopedToken(webFile.text, WEB_TOKEN_ENV_KEY, webToken);
    const nextWorkerText = replaceScopedToken(workerFile.text, WORKER_TOKEN_ENV_KEY, workerToken);
    validateApplicationEnvironment(nextWebText, WEB_ROLE, config.supabaseUrl);
    validateApplicationEnvironment(nextWorkerText, WORKER_ROLE, config.supabaseUrl);

    await probeBothRoles(dependencies, "pre-install", webToken, workerToken);

    webStage = await dependencies.stagePrivateFile({
      targetPath: webFile.path,
      text: nextWebText,
      uid: webFile.uid,
      gid: webFile.gid,
      mode: webFile.mode,
    });
    workerStage = await dependencies.stagePrivateFile({
      targetPath: workerFile.path,
      text: nextWorkerText,
      uid: workerFile.uid,
      gid: workerFile.gid,
      mode: workerFile.mode,
    });
    rollbackGeneration = await dependencies.saveRollbackGeneration([webFile, workerFile]);

    installationAttempted = true;
    await dependencies.installStagedPair({
      webStage,
      webTarget: webFile.path,
      workerStage,
      workerTarget: workerFile.path,
    });
    await dependencies.cleanupStage(webStage);
    await dependencies.cleanupStage(workerStage);
    webStage = undefined;
    workerStage = undefined;

    workerRestartAttempted = true;
    await dependencies.restartService(config.workerService);
    await dependencies.requireServiceActive(config.workerService);
    webRestartAttempted = true;
    await dependencies.restartService(config.webService);
    await dependencies.requireServiceActive(config.webService);

    await dependencies.requireHttpStatus(config.localHealthUrl, 200);
    await dependencies.requireHttpStatus(config.publicHealthUrl, 200);
    await dependencies.requireHttpStatus(config.publicReadyUrl, 200);
    await probeBothRoles(dependencies, "post-install", webToken, workerToken);

    await dependencies.pruneRollbackGenerations(rollbackGeneration);
    if (webStage) await dependencies.cleanupStage(webStage);
    if (workerStage) await dependencies.cleanupStage(workerStage);
    dependencies.log(logEvent("complete", "passed", { expiresAt }));
    return Object.freeze({ status: "ROTATED" as const, expiresAt });
  } catch (error) {
    primaryError = error;
    if (installationAttempted && rollbackGeneration) {
      try {
        dependencies.log(logEvent("rollback", "started"));
        await dependencies.restoreRollbackGeneration(rollbackGeneration);
        if (workerRestartAttempted) {
          await dependencies.restartService(config.workerService);
          await dependencies.requireServiceActive(config.workerService);
        }
        if (webRestartAttempted) {
          await dependencies.restartService(config.webService);
          await dependencies.requireServiceActive(config.webService);
        }
        dependencies.log(logEvent("rollback", "passed"));
      } catch (rollbackError) {
        dependencies.log(logEvent("rollback", "failed", { errorCode: "ROLLBACK_FAILED" }));
        throw new AggregateError([error, rollbackError], "Rotation failed and rollback failed.");
      }
    }
    throw error;
  } finally {
    for (const stage of [webStage, workerStage]) {
      if (!stage) continue;
      try {
        await dependencies.cleanupStage(stage);
      } catch (cleanupError) {
        dependencies.log(logEvent("cleanup", "failed", { errorCode: "STAGE_CLEANUP_FAILED" }));
        if (!primaryError) primaryError = cleanupError;
      }
    }
    try {
      await lock.release();
    } catch (releaseError) {
      dependencies.log(logEvent("lock", "failed", { errorCode: "LOCK_RELEASE_FAILED" }));
      if (primaryError) {
        throw new AggregateError([primaryError, releaseError], "Rotation failed and lock release failed.");
      }
      throw releaseError;
    }
    if (primaryError && !(primaryError instanceof Error)) {
      dependencies.log(logEvent("complete", "failed", { errorCode: "ROTATION_FAILED" }));
    }
  }
}

function logEvent(
  phase: RotationPhase,
  status: RotationLogEvent["status"],
  extra: Pick<RotationLogEvent, "role" | "expiresAt" | "httpStatus" | "errorCode"> = {},
): RotationLogEvent {
  return Object.freeze({ timestamp: new Date().toISOString(), phase, status, ...extra });
}

async function probeBothRoles(
  dependencies: RotationDependencies,
  phase: "pre-install" | "post-install",
  webToken: string,
  workerToken: string,
): Promise<void> {
  await dependencies.probeRoleIsolation({ role: WEB_ROLE, token: webToken, phase });
  await dependencies.probeRoleIsolation({ role: WORKER_ROLE, token: workerToken, phase });
}

export function createProductionRotationDependencies(
  config: RotatorConfiguration,
  options: Readonly<{
    fetchImplementation?: typeof fetch;
    effectiveUserId?: () => number;
    nowSeconds?: () => number;
  }> = {},
): RotationDependencies {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const serviceAllowlist = new Set([config.webService, config.workerService]);
  const dependencies: RotationDependencies = {
    effectiveUserId: options.effectiveUserId ?? (() => process.geteuid?.() ?? -1),
    nowSeconds: options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000)),
    acquireLock,
    readPrivateFile,
    stagePrivateFile,
    saveRollbackGeneration: (files) => saveRollbackGeneration(config.stateDirectory, files),
    installStagedPair,
    restoreRollbackGeneration,
    pruneRollbackGenerations: (keep) => pruneRollbackGenerations(config.stateDirectory, keep),
    probeRoleIsolation: (input) => probeRoleIsolation(config, fetchImplementation, input),
    restartService: (name) => restartService(serviceAllowlist, name),
    requireServiceActive: (name) => requireServiceActive(serviceAllowlist, name),
    requireHttpStatus: (url, status) => requireHttpStatus(fetchImplementation, url, status),
    cleanupStage,
    log: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  };
  return Object.freeze(dependencies);
}

async function acquireLock(path: string): Promise<Readonly<{ release: () => Promise<void> }> | null> {
  assertAbsolutePath(path);
  await requireSafeDirectory(dirname(path), 0);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
        | platformNoFollowFlag(), CONFIGURATION_MODE);
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
      await handle.sync();
      await handle.close();
      return Object.freeze({
        async release() {
          await rm(path, { force: true });
          await syncDirectory(dirname(path));
        },
      });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const lockFile = await readPrivateFile(path, CONFIGURATION_MODE);
      const pid = Number(lockFile.text.trim().split(/\s+/u)[0]);
      if (Number.isSafeInteger(pid) && pid > 1 && isProcessRunning(pid)) return null;
      await rm(path);
      await syncDirectory(dirname(path));
    }
  }
  return null;
}

async function readPrivateFile(path: string, expectedMode: number): Promise<PrivateEnvironmentFile> {
  assertAbsolutePath(path);
  const handle = await open(path, constants.O_RDONLY | platformNoFollowFlag());
  try {
    const metadata: Stats = await handle.stat();
    assertPrivateFileMetadata(toPrivateFileMetadata(metadata), { uid: 0, mode: expectedMode });
    const text = await handle.readFile("utf8");
    return Object.freeze({
      path,
      text,
      uid: metadata.uid,
      gid: metadata.gid,
      mode: metadata.mode & 0o777,
    });
  } finally {
    await handle.close();
  }
}

async function stagePrivateFile(input: Readonly<{
  targetPath: string;
  text: string;
  uid: number;
  gid: number;
  mode: number;
}>): Promise<string> {
  assertAbsolutePath(input.targetPath);
  const targetDirectory = dirname(input.targetPath);
  await requireSafeDirectory(targetDirectory, 0);
  const stagePath = join(
    targetDirectory,
    `.${basename(input.targetPath)}.jwt-rotation.${process.pid}.${Date.now()}.${randomSuffix()}.tmp`,
  );
  await writeExclusivePrivateFile(stagePath, input.text, input.uid, input.gid, input.mode);
  const metadata = await lstat(stagePath);
  assertPrivateFileMetadata(toPrivateFileMetadata(metadata), { uid: input.uid, mode: input.mode });
  if (metadata.gid !== input.gid) throw new Error("Staged private file group is invalid.");
  return stagePath;
}

async function saveRollbackGeneration(
  stateDirectory: string,
  files: readonly PrivateEnvironmentFile[],
): Promise<string> {
  if (files.length !== 2) throw new Error("Rollback generation requires exactly two files.");
  await ensureStateDirectory(stateDirectory);
  const generation = await mkdtemp(join(stateDirectory, "generation-"));
  await chmod(generation, STATE_DIRECTORY_MODE);
  await chown(generation, 0, 0);
  const metadata = files.map((file, index) => Object.freeze({
    slot: index === 0 ? "web" : "worker",
    targetPath: file.path,
    uid: file.uid,
    gid: file.gid,
    mode: file.mode,
  }));
  await writeExclusivePrivateFile(join(generation, "web.env"), files[0]!.text, 0, 0, BACKUP_MODE);
  await writeExclusivePrivateFile(join(generation, "worker.env"), files[1]!.text, 0, 0, BACKUP_MODE);
  await writeExclusivePrivateFile(
    join(generation, "metadata.json"),
    `${JSON.stringify(metadata)}\n`,
    0,
    0,
    BACKUP_MODE,
  );
  await syncDirectory(generation);
  await syncDirectory(stateDirectory);
  return generation;
}

async function installStagedPair(input: Readonly<{
  webStage: string;
  webTarget: string;
  workerStage: string;
  workerTarget: string;
}>): Promise<void> {
  assertStageForTarget(input.webStage, input.webTarget);
  assertStageForTarget(input.workerStage, input.workerTarget);
  await rename(input.webStage, input.webTarget);
  await syncDirectory(dirname(input.webTarget));
  await rename(input.workerStage, input.workerTarget);
  await syncDirectory(dirname(input.workerTarget));
}

async function restoreRollbackGeneration(generation: string): Promise<void> {
  assertAbsolutePath(generation);
  const generationMetadata = await lstat(generation);
  if (!generationMetadata.isDirectory() || generationMetadata.isSymbolicLink()
    || generationMetadata.uid !== 0 || (generationMetadata.mode & 0o777) !== STATE_DIRECTORY_MODE) {
    throw new Error("Rollback generation directory is invalid.");
  }
  const metadataText = await readRootBackupFile(join(generation, "metadata.json"));
  const metadata = parseRollbackMetadata(metadataText);
  const staged: string[] = [];
  try {
    for (const item of metadata) {
      const backupText = await readRootBackupFile(join(generation, `${item.slot}.env`));
      staged.push(await stagePrivateFile({
        targetPath: item.targetPath,
        text: backupText,
        uid: item.uid,
        gid: item.gid,
        mode: item.mode,
      }));
    }
    await installStagedPair({
      webStage: staged[0]!,
      webTarget: metadata[0]!.targetPath,
      workerStage: staged[1]!,
      workerTarget: metadata[1]!.targetPath,
    });
    staged.length = 0;
  } finally {
    await Promise.all(staged.map((path) => cleanupStage(path)));
  }
}

async function pruneRollbackGenerations(stateDirectory: string, keep: string): Promise<void> {
  assertAbsolutePath(stateDirectory);
  assertAbsolutePath(keep);
  if (dirname(keep) !== stateDirectory || !basename(keep).startsWith("generation-")) {
    throw new Error("Rollback generation is outside the state directory.");
  }
  for (const entry of await readdir(stateDirectory, { withFileTypes: true })) {
    const candidate = join(stateDirectory, entry.name);
    if (candidate === keep) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("generation-")) {
      throw new Error("Unexpected entry in rollback state directory.");
    }
    await rm(candidate, { recursive: true });
  }
  await syncDirectory(stateDirectory);
}

async function probeRoleIsolation(
  config: RotatorConfiguration,
  fetchImplementation: typeof fetch,
  input: Readonly<{ role: SetupRole; token: string; phase: "pre-install" | "post-install" }>,
): Promise<void> {
  const probe = ROLE_PROBES[input.role];
  const headers = Object.freeze({
    apikey: config.supabasePublishableKey,
    authorization: `Bearer ${input.token}`,
    "content-type": "application/json",
  });
  const ownResponse = await fetchImplementation(`${config.supabaseUrl}/rest/v1/rpc/${probe.ownRpc}`, {
    method: "POST",
    headers,
    body: "{}",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (ownResponse.status !== 200) {
    throw new Error(`Own-role readiness RPC failed with HTTP ${ownResponse.status}.`);
  }
  const crossResponse = await fetchImplementation(`${config.supabaseUrl}/rest/v1/rpc/${probe.deniedRpc}`, {
    method: "POST",
    headers,
    body: "{}",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  assertDeniedStatus(crossResponse.status, "Cross-role RPC");
  const tableResponse = await fetchImplementation(`${config.supabaseUrl}/rest/v1/setup_runtime_state?select=*&limit=1`, {
    method: "GET",
    headers,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  assertDeniedStatus(tableResponse.status, "Direct table probe");
}

function assertDeniedStatus(status: number, probeName: string): void {
  if (status !== 401 && status !== 403) {
    throw new Error(`${probeName} expected authorization denial; received HTTP ${status}.`);
  }
}

async function restartService(allowlist: ReadonlySet<string>, name: string): Promise<void> {
  assertAllowedService(allowlist, name);
  await execFile("/usr/bin/systemctl", ["restart", name], { timeout: 30_000 });
}

async function requireServiceActive(allowlist: ReadonlySet<string>, name: string): Promise<void> {
  assertAllowedService(allowlist, name);
  await execFile("/usr/bin/systemctl", ["is-active", "--quiet", name], { timeout: 10_000 });
}

async function requireHttpStatus(fetchImplementation: typeof fetch, url: URL, status: number): Promise<void> {
  const response = await fetchImplementation(url, {
    method: "GET",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (response.status !== status) {
    throw new Error(`Readiness endpoint returned HTTP ${response.status}.`);
  }
}

async function cleanupStage(path: string): Promise<void> {
  assertAbsolutePath(path);
  if (!basename(path).includes(".jwt-rotation.")) throw new Error("Refusing to remove an unexpected stage path.");
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

async function readRootConfiguration(path: string): Promise<string> {
  const file = await readPrivateFile(path, CONFIGURATION_MODE);
  if (file.gid !== 0) throw new Error("Rotator configuration group is invalid.");
  return file.text;
}

export function parseCliArguments(argv: readonly string[]): Readonly<{ configPath: string }> {
  if (argv.length !== 2 || argv[0] !== "--config" || !argv[1] || !isAbsolute(argv[1])) {
    throw new Error("Usage: rotate-setup-scoped-jwts.ts --config /absolute/path");
  }
  return Object.freeze({ configPath: argv[1] });
}

async function runCli(): Promise<void> {
  let config: RotatorConfiguration | undefined;
  try {
    const { configPath } = parseCliArguments(process.argv.slice(2));
    const configText = await readRootConfiguration(configPath);
    config = parseRotatorConfiguration(configText);
    const dependencies = createProductionRotationDependencies(config);
    const result = await rotateSetupScopedJwts(config, new Hs256SetupJwtSigner(config.signingSecret), dependencies);
    if (result.status === "SKIPPED_LOCKED") {
      dependencies.log(logEvent("lock", "skipped"));
    }
  } catch (error) {
    const sensitiveValues = config ? [config.signingSecret] : [];
    const safeError = redactSensitiveText(error instanceof Error ? error.message : "Unknown rotation failure.", sensitiveValues);
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      phase: "complete",
      status: "failed",
      errorCode: classifyError(safeError),
    })}\n`);
    process.exitCode = 1;
  }
}

function classifyError(message: string): string {
  if (/root/iu.test(message)) return "ROOT_REQUIRED";
  if (/configuration|Usage/iu.test(message)) return "CONFIG_INVALID";
  if (/probe|RPC|authorization/iu.test(message)) return "ISOLATION_PROBE_FAILED";
  if (/rollback/iu.test(message)) return "ROLLBACK_FAILED";
  if (/service|readiness|HTTP/iu.test(message)) return "ACTIVATION_FAILED";
  return "ROTATION_FAILED";
}

function assertAllowedService(allowlist: ReadonlySet<string>, name: string): void {
  if (!allowlist.has(name)) throw new Error("Unexpected service name.");
}

function parseRollbackMetadata(text: string): readonly Readonly<{
  slot: "web" | "worker";
  targetPath: string;
  uid: number;
  gid: number;
  mode: number;
}>[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Rollback metadata is invalid.");
  }
  if (!Array.isArray(value) || value.length !== 2) throw new Error("Rollback metadata is invalid.");
  const expected = [
    { slot: "web", path: "/opt/agentpay/private/onboarding-web.env" },
    { slot: "worker", path: "/opt/agentpay/private/setup-worker.env" },
  ] as const;
  return Object.freeze(value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error("Rollback metadata is invalid.");
    const record = item as Record<string, unknown>;
    if (record.slot !== expected[index]!.slot || record.targetPath !== expected[index]!.path
      || record.uid !== 0 || !Number.isSafeInteger(record.gid) || Number(record.gid) < 0
      || record.mode !== EXPECTED_APPLICATION_MODE
      || Object.keys(record).sort().join(",") !== "gid,mode,slot,targetPath,uid") {
      throw new Error("Rollback metadata is invalid.");
    }
    return Object.freeze({
      slot: record.slot as "web" | "worker",
      targetPath: record.targetPath as string,
      uid: record.uid as number,
      gid: record.gid as number,
      mode: record.mode as number,
    });
  }));
}

async function readRootBackupFile(path: string): Promise<string> {
  const file = await readPrivateFile(path, BACKUP_MODE);
  if (file.gid !== 0) throw new Error("Rollback file group is invalid.");
  return file.text;
}

async function ensureStateDirectory(path: string): Promise<void> {
  assertAbsolutePath(path);
  await requireSafeDirectory(dirname(path), 0);
  try {
    await mkdir(path, { mode: STATE_DIRECTORY_MODE });
    await chown(path, 0, 0);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  await requireSafeDirectory(path, 0, STATE_DIRECTORY_MODE);
}

async function requireSafeDirectory(path: string, uid: number, mode?: number): Promise<void> {
  assertAbsolutePath(path);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid) {
    throw new Error("Private directory metadata is invalid.");
  }
  if ((metadata.mode & 0o022) !== 0) throw new Error("Private directory is group/other writable.");
  if (mode !== undefined && (metadata.mode & 0o777) !== mode) {
    throw new Error("Private directory mode is invalid.");
  }
}

async function writeExclusivePrivateFile(
  path: string,
  text: string,
  uid: number,
  gid: number,
  mode: number,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | platformNoFollowFlag(),
    mode,
  );
  try {
    await handle.writeFile(text, { encoding: "utf8" });
    await handle.sync();
    await handle.chown(uid, gid);
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertStageForTarget(stage: string, target: string): void {
  assertAbsolutePath(stage);
  assertAbsolutePath(target);
  if (dirname(stage) !== dirname(target) || !basename(stage).includes(".jwt-rotation.")) {
    throw new Error("Staged file is not in the target directory.");
  }
}

function assertAbsolutePath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Path must be absolute and normalized.");
}

function toPrivateFileMetadata(metadata: Stats) {
  return Object.freeze({
    isFile: metadata.isFile(),
    isSymbolicLink: metadata.isSymbolicLink(),
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode & 0o777,
  });
}

function platformNoFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function randomSuffix(): string {
  return randomBytes(8).toString("hex");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isDirectExecution(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isDirectExecution()) void runCli();
