import { createHmac, timingSafeEqual } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import { z } from "zod";

export const WEB_ROLE = "agentpay_setup_web";
export const WORKER_ROLE = "agentpay_setup_worker";
export const SETUP_ROLES = [WEB_ROLE, WORKER_ROLE] as const;
export const WEB_TOKEN_ENV_KEY = "AGENTPAY_SETUP_WEB_TOKEN";
export const WORKER_TOKEN_ENV_KEY = "AGENTPAY_SETUP_WORKER_TOKEN";
export const MIN_TOKEN_REMAINING_SECONDS = 900;
export const MAX_TOKEN_REMAINING_SECONDS = 7_200;
export const DEFAULT_TOKEN_TTL_SECONDS = 6_900;

export const ROLE_PROBES = Object.freeze({
  [WEB_ROLE]: Object.freeze({
    tokenEnvironmentKey: WEB_TOKEN_ENV_KEY,
    ownRpc: "read_production_setup_runtime_state",
    deniedRpc: "read_production_setup_worker_runtime_state",
  }),
  [WORKER_ROLE]: Object.freeze({
    tokenEnvironmentKey: WORKER_TOKEN_ENV_KEY,
    ownRpc: "read_production_setup_worker_runtime_state",
    deniedRpc: "read_production_setup_runtime_state",
  }),
});

export type SetupRole = (typeof SETUP_ROLES)[number];
export type SetupJwtInput = Readonly<{ role: SetupRole; issuedAt: number; expiresAt: number }>;
export type VerifiedSetupJwt = Readonly<{
  algorithm: "HS256";
  issuer: "supabase";
  role: SetupRole;
  issuedAt: number;
  expiresAt: number;
}>;

export interface SetupJwtSigner {
  sign(input: SetupJwtInput): Promise<string>;
}

export interface RotatorConfiguration {
  readonly supabaseUrl: "https://zcwsmivbgcrfyrvfptxk.supabase.co";
  readonly supabasePublishableKey: string;
  readonly signingSecret: string;
  readonly webEnvironmentPath: "/opt/agentpay/private/onboarding-web.env";
  readonly workerEnvironmentPath: "/opt/agentpay/private/setup-worker.env";
  readonly stateDirectory: "/opt/agentpay/private/setup-jwt-rotator";
  readonly lockPath: "/run/agentpay/setup-jwt-rotator.lock";
  readonly webService: "agentpay-onboarding-web.service";
  readonly workerService: "agentpay-setup-worker.service";
  readonly localHealthUrl: URL;
  readonly publicHealthUrl: URL;
  readonly publicReadyUrl: URL;
  readonly tokenTtlSeconds: number;
}

export interface PrivateFileMetadata {
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

const payloadSchema = z.object({
  iss: z.literal("supabase"),
  role: z.enum(SETUP_ROLES),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
}).strict();

const publishableKeySchema = z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{16,}$/);
const setupModes = new Set(["OFF", "CANARY", "PUBLIC", "DRAIN"]);
const forbiddenApplicationKeys = new Set([
  "SUPABASE_JWT_SECRET",
  "SUPABASE_SIGNING_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_PRODUCTION_SERVICE_ROLE_KEY",
]);

const rotatorKeys = Object.freeze({
  AGENTPAY_ROTATOR_SUPABASE_URL: "supabaseUrl",
  AGENTPAY_ROTATOR_SUPABASE_PUBLISHABLE_KEY: "supabasePublishableKey",
  AGENTPAY_ROTATOR_SUPABASE_SIGNING_SECRET: "signingSecret",
  AGENTPAY_ROTATOR_WEB_ENV_PATH: "webEnvironmentPath",
  AGENTPAY_ROTATOR_WORKER_ENV_PATH: "workerEnvironmentPath",
  AGENTPAY_ROTATOR_STATE_DIR: "stateDirectory",
  AGENTPAY_ROTATOR_LOCK_PATH: "lockPath",
  AGENTPAY_ROTATOR_WEB_SERVICE: "webService",
  AGENTPAY_ROTATOR_WORKER_SERVICE: "workerService",
  AGENTPAY_ROTATOR_LOCAL_HEALTH_URL: "localHealthUrl",
  AGENTPAY_ROTATOR_PUBLIC_HEALTH_URL: "publicHealthUrl",
  AGENTPAY_ROTATOR_PUBLIC_READY_URL: "publicReadyUrl",
  AGENTPAY_ROTATOR_TOKEN_TTL_SECONDS: "tokenTtlSeconds",
} as const);

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function assertLifetime(issuedAt: number, expiresAt: number): void {
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) {
    throw new Error("Setup JWT timestamps must be safe integers.");
  }
  const lifetime = expiresAt - issuedAt;
  if (lifetime < MIN_TOKEN_REMAINING_SECONDS || lifetime > MAX_TOKEN_REMAINING_SECONDS) {
    throw new Error("Setup JWT lifetime is outside the allowed window.");
  }
}

function assertSigningMaterial(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("Signing material is too weak.");
}

export class Hs256SetupJwtSigner implements SetupJwtSigner {
  constructor(private readonly secret: string) {
    assertSigningMaterial(secret);
  }

  async sign(input: SetupJwtInput): Promise<string> {
    if (!(SETUP_ROLES as readonly string[]).includes(input.role)) {
      throw new Error("Unsupported setup role.");
    }
    assertLifetime(input.issuedAt, input.expiresAt);
    const encodedHeader = encode({ alg: "HS256", typ: "JWT" });
    const encodedPayload = encode({
      iss: "supabase",
      role: input.role,
      iat: input.issuedAt,
      exp: input.expiresAt,
    });
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = createHmac("sha256", this.secret).update(signingInput).digest("base64url");
    return `${signingInput}.${signature}`;
  }
}

export function verifySetupJwt(
  token: string,
  secret: string,
  expectedRole: SetupRole,
  nowSeconds: number,
): VerifiedSetupJwt {
  assertSigningMaterial(secret);
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new Error("Malformed setup JWT.");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  let decodedHeader: unknown;
  let decodedPayload: unknown;
  try {
    decodedHeader = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    decodedPayload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Malformed setup JWT encoding.");
  }
  if (!decodedHeader || typeof decodedHeader !== "object"
    || (decodedHeader as Record<string, unknown>).alg !== "HS256"
    || (decodedHeader as Record<string, unknown>).typ !== "JWT"
    || Object.keys(decodedHeader).length !== 2) {
    throw new Error("Unsupported setup JWT algorithm or header.");
  }
  const payload = payloadSchema.parse(decodedPayload);
  const expectedSignature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const receivedSignature = Buffer.from(encodedSignature, "base64url");
  if (receivedSignature.length !== expectedSignature.length
    || !timingSafeEqual(receivedSignature, expectedSignature)) {
    throw new Error("Setup JWT signature verification failed.");
  }
  if (payload.role !== expectedRole) throw new Error("Setup JWT role mismatch.");
  assertLifetime(payload.iat, payload.exp);
  const remaining = payload.exp - nowSeconds;
  if (remaining < MIN_TOKEN_REMAINING_SECONDS || remaining > MAX_TOKEN_REMAINING_SECONDS) {
    throw new Error("Setup JWT remaining lifetime is outside the allowed window.");
  }
  return Object.freeze({
    algorithm: "HS256",
    issuer: payload.iss,
    role: payload.role,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  });
}

export function replaceScopedToken(environmentText: string, tokenKey: string, token: string): string {
  if (tokenKey !== WEB_TOKEN_ENV_KEY && tokenKey !== WORKER_TOKEN_ENV_KEY) {
    throw new Error("Unsupported setup token environment key.");
  }
  if (!token || /[\r\n]/u.test(token)) throw new Error("Replacement token is invalid.");

  const lines = environmentText.match(/[^\r\n]*(?:\r\n|\n|$)/gu)?.filter((line) => line.length > 0) ?? [];
  let tokenAssignments = 0;
  const otherTokenKey = tokenKey === WEB_TOKEN_ENV_KEY ? WORKER_TOKEN_ENV_KEY : WEB_TOKEN_ENV_KEY;
  const nextLines = lines.map((line) => {
    const assignment = /^([ \t]*)([A-Z][A-Z0-9_]*)([ \t]*=[ \t]*)([^\r\n]*)(\r\n|\n)?$/u.exec(line);
    if (!assignment) return line;
    const [, indentation, key, separator, , newline = ""] = assignment;
    if (forbiddenApplicationKeys.has(key) || key === otherTokenKey) {
      throw new Error(`Forbidden credential in application environment: ${key}`);
    }
    if (key !== tokenKey) return line;
    tokenAssignments += 1;
    return `${indentation}${key}${separator}${token}${newline}`;
  });
  if (tokenAssignments !== 1) throw new Error(`Expected exactly one ${tokenKey} assignment.`);
  return nextLines.join("");
}

export function validateApplicationEnvironment(
  environmentText: string,
  role: SetupRole,
  expectedSupabaseUrl: string,
): Readonly<{ token: string; mode: "OFF" | "CANARY" | "PUBLIC" | "DRAIN" }> {
  const values = parseStrictEnvironment(environmentText);
  const tokenKey = ROLE_PROBES[role].tokenEnvironmentKey;
  const otherTokenKey = role === WEB_ROLE ? WORKER_TOKEN_ENV_KEY : WEB_TOKEN_ENV_KEY;
  for (const key of [...forbiddenApplicationKeys, otherTokenKey]) {
    if (values.has(key)) throw new Error(`Forbidden credential in application environment: ${key}`);
  }
  const token = values.get(tokenKey);
  const mode = values.get("AGENTPAY_SETUP_MODE");
  if (values.get("AGENTPAY_ENVIRONMENT") !== "production"
    || values.get("AGENTPAY_HOME_CHAIN_ID") !== "196"
    || values.get("SUPABASE_URL") !== expectedSupabaseUrl
    || !mode || !setupModes.has(mode)
    || !token) {
    throw new Error("Application environment does not match the production setup boundary.");
  }
  return Object.freeze({ token, mode: mode as "OFF" | "CANARY" | "PUBLIC" | "DRAIN" });
}

export function parseRotatorConfiguration(text: string): RotatorConfiguration {
  const values = parseStrictEnvironment(text);
  for (const key of values.keys()) {
    if (!(key in rotatorKeys)) throw new Error(`Unrecognized key in rotator configuration: ${key}`);
  }
  for (const key of Object.keys(rotatorKeys)) {
    if (!values.has(key)) throw new Error(`Missing rotator configuration key: ${key}`);
  }

  const supabaseUrl = values.get("AGENTPAY_ROTATOR_SUPABASE_URL");
  const publishableKey = values.get("AGENTPAY_ROTATOR_SUPABASE_PUBLISHABLE_KEY") ?? "";
  const signingSecret = values.get("AGENTPAY_ROTATOR_SUPABASE_SIGNING_SECRET") ?? "";
  const webEnvironmentPath = values.get("AGENTPAY_ROTATOR_WEB_ENV_PATH") ?? "";
  const workerEnvironmentPath = values.get("AGENTPAY_ROTATOR_WORKER_ENV_PATH") ?? "";
  const stateDirectory = values.get("AGENTPAY_ROTATOR_STATE_DIR") ?? "";
  const lockPath = values.get("AGENTPAY_ROTATOR_LOCK_PATH") ?? "";
  const webService = values.get("AGENTPAY_ROTATOR_WEB_SERVICE");
  const workerService = values.get("AGENTPAY_ROTATOR_WORKER_SERVICE");
  const tokenTtlSeconds = Number(values.get("AGENTPAY_ROTATOR_TOKEN_TTL_SECONDS"));

  if (supabaseUrl !== "https://zcwsmivbgcrfyrvfptxk.supabase.co") {
    throw new Error("Unexpected production Supabase URL.");
  }
  publishableKeySchema.parse(publishableKey);
  assertSigningMaterial(signingSecret);
  assertExactAbsolutePath(webEnvironmentPath, "/opt/agentpay/private/onboarding-web.env");
  assertExactAbsolutePath(workerEnvironmentPath, "/opt/agentpay/private/setup-worker.env");
  assertExactAbsolutePath(stateDirectory, "/opt/agentpay/private/setup-jwt-rotator");
  assertExactAbsolutePath(lockPath, "/run/agentpay/setup-jwt-rotator.lock");
  if (webService !== "agentpay-onboarding-web.service") throw new Error("Unexpected web service.");
  if (workerService !== "agentpay-setup-worker.service") throw new Error("Unexpected worker service.");
  if (!Number.isSafeInteger(tokenTtlSeconds)
    || tokenTtlSeconds < MIN_TOKEN_REMAINING_SECONDS
    || tokenTtlSeconds > MAX_TOKEN_REMAINING_SECONDS) {
    throw new Error("Rotator token lifetime is outside the allowed window.");
  }

  const localHealthUrl = requireExactUrl(
    values.get("AGENTPAY_ROTATOR_LOCAL_HEALTH_URL") ?? "",
    "http://127.0.0.1:3004/healthz",
  );
  const publicHealthUrl = requireExactUrl(
    values.get("AGENTPAY_ROTATOR_PUBLIC_HEALTH_URL") ?? "",
    "https://onboard.agentpay.site/healthz",
  );
  const publicReadyUrl = requireExactUrl(
    values.get("AGENTPAY_ROTATOR_PUBLIC_READY_URL") ?? "",
    "https://onboard.agentpay.site/readyz",
  );

  return Object.freeze({
    supabaseUrl,
    supabasePublishableKey: publishableKey,
    signingSecret,
    webEnvironmentPath: webEnvironmentPath as RotatorConfiguration["webEnvironmentPath"],
    workerEnvironmentPath: workerEnvironmentPath as RotatorConfiguration["workerEnvironmentPath"],
    stateDirectory: stateDirectory as RotatorConfiguration["stateDirectory"],
    lockPath: lockPath as RotatorConfiguration["lockPath"],
    webService,
    workerService,
    localHealthUrl,
    publicHealthUrl,
    publicReadyUrl,
    tokenTtlSeconds,
  });
}

export function assertPrivateFileMetadata(
  actual: PrivateFileMetadata,
  expected: Readonly<{ uid: number; mode: number }>,
): void {
  if (actual.isSymbolicLink) throw new Error("Private path must not be a symbolic link.");
  if (!actual.isFile) throw new Error("Private path must be a regular file.");
  if (actual.uid !== expected.uid) throw new Error("Private file owner is invalid.");
  if ((actual.mode & 0o777) !== expected.mode) throw new Error("Private file mode is invalid.");
  if (!Number.isSafeInteger(actual.gid) || actual.gid < 0) throw new Error("Private file group is invalid.");
}

export function redactSensitiveText(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets.filter((candidate) => candidate.length > 0).sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join("[REDACTED]");
  }
  return output.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/gu, "[REDACTED]");
}

function parseStrictEnvironment(text: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("Invalid environment assignment.");
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) throw new Error("Invalid environment key.");
    if (values.has(key)) throw new Error(`Duplicate environment key: ${key}`);
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2
      && ((value.startsWith("\"") && value.endsWith("\""))
        || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function assertExactAbsolutePath(value: string, expected: string): void {
  if (!isAbsolute(value) || normalize(value) !== value) throw new Error("Rotator path must be absolute and normalized.");
  if (value !== expected) throw new Error(`Unexpected rotator path: ${value}`);
}

function requireExactUrl(value: string, expected: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Rotator URL is invalid.");
  }
  if (parsed.toString() !== expected || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error(`Unexpected rotator URL: ${value}`);
  }
  return parsed;
}
