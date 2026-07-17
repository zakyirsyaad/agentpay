import {
  createHmac,
  randomBytes as secureRandomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ONBOARDING_BODY_LIMIT_BYTES = 4_096;
export const ONBOARDING_TRANSACTION_COOKIE = "__Host-agentpay_setup";

interface BrowserTransactionPayload {
  readonly capabilityDigest: string;
  readonly csrfDigest: string;
  readonly expiresAtMs: number;
  readonly state?: Readonly<Record<string, unknown>>;
}

export interface CreateBrowserTransactionInput {
  readonly cookieSecret: string;
  readonly capabilitySecret: string;
  readonly expiresAt: Date;
  readonly now?: Date;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly state?: Readonly<Record<string, unknown>>;
}

export interface VerifyBrowserTransactionInput {
  readonly cookieHeader?: string;
  readonly capability?: string;
  readonly csrfToken?: string;
  readonly cookieSecret: string;
  readonly capabilitySecret: string;
  readonly now: Date;
  readonly requireCsrf: boolean;
}

export function createBrowserTransaction(input: CreateBrowserTransactionInput) {
  assertSecret(input.cookieSecret, "cookie");
  assertSecret(input.capabilitySecret, "capability");
  if (!Number.isSafeInteger(input.expiresAt.getTime())) {
    throw new Error("SETUP_TRANSACTION_INVALID");
  }

  const bytes = input.randomBytes ?? ((size: number) => secureRandomBytes(size));
  const capability = Buffer.from(bytes(32)).toString("base64url");
  const csrfToken = Buffer.from(bytes(32)).toString("base64url");
  if (!isToken(capability) || !isToken(csrfToken) || capability === csrfToken) {
    throw new Error("SETUP_RANDOMNESS_INVALID");
  }

  const payload: BrowserTransactionPayload = Object.freeze({
    capabilityDigest: hashBrowserSecret(capability, input.capabilitySecret),
    csrfDigest: hashBrowserSecret(csrfToken, input.capabilitySecret),
    expiresAtMs: input.expiresAt.getTime(),
    ...(input.state ? { state: Object.freeze({ ...input.state }) } : {}),
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = signCookie(encodedPayload, input.cookieSecret);
  const maxAge = Math.max(0, Math.floor((input.expiresAt.getTime() - (input.now?.getTime() ?? Date.now())) / 1_000));

  return Object.freeze({
    capability,
    csrfToken,
    capabilityDigest: payload.capabilityDigest,
    setCookie: `${ONBOARDING_TRANSACTION_COOKIE}=${encodedPayload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
  });
}

export function verifyBrowserTransaction(
  input: VerifyBrowserTransactionInput,
): Readonly<{ capabilityDigest: string; state?: Readonly<Record<string, unknown>> }> | null {
  try {
    assertSecret(input.cookieSecret, "cookie");
    assertSecret(input.capabilitySecret, "capability");
    if (!isToken(input.capability)) return null;
    if (input.requireCsrf && !isToken(input.csrfToken)) return null;

    const rawCookie = readCookie(input.cookieHeader, ONBOARDING_TRANSACTION_COOKIE);
    if (!rawCookie) return null;
    const separator = rawCookie.lastIndexOf(".");
    if (separator <= 0) return null;
    const encodedPayload = rawCookie.slice(0, separator);
    const suppliedSignature = rawCookie.slice(separator + 1);
    if (!safeEqual(suppliedSignature, signCookie(encodedPayload, input.cookieSecret))) return null;

    const payload = parsePayload(encodedPayload);
    if (!payload || input.now.getTime() >= payload.expiresAtMs) return null;
    const capabilityDigest = hashBrowserSecret(input.capability, input.capabilitySecret);
    if (!safeEqual(capabilityDigest, payload.capabilityDigest)) return null;
    if (
      input.requireCsrf &&
      !safeEqual(hashBrowserSecret(input.csrfToken!, input.capabilitySecret), payload.csrfDigest)
    ) return null;

    return Object.freeze({ capabilityDigest, ...(payload.state ? { state: payload.state } : {}) });
  } catch {
    return null;
  }
}

export function hashBrowserSecret(value: string, secret: string): string {
  assertSecret(secret, "capability");
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

export async function readBoundedJsonBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new Error("SETUP_JSON_REQUIRED");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) throw new Error("SETUP_JSON_INVALID");
    if (parsedLength > ONBOARDING_BODY_LIMIT_BYTES) throw new Error("SETUP_BODY_TOO_LARGE");
  }
  if (!request.body) throw new Error("SETUP_JSON_INVALID");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > ONBOARDING_BODY_LIMIT_BYTES) {
        await reader.cancel();
        throw new Error("SETUP_BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message === "SETUP_BODY_TOO_LARGE") throw error;
    throw new Error("SETUP_JSON_INVALID");
  }
}

function parsePayload(encoded: string): BrowserTransactionPayload | null {
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      !["capabilityDigest,csrfDigest,expiresAtMs", "capabilityDigest,csrfDigest,expiresAtMs,state"]
        .includes(Object.keys(value).sort().join(",")) ||
      typeof value.capabilityDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.capabilityDigest) ||
      typeof value.csrfDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.csrfDigest) ||
      typeof value.expiresAtMs !== "number" || !Number.isSafeInteger(value.expiresAtMs) ||
      (value.state !== undefined && !isPlainRecord(value.state))
    ) return null;
    return {
      capabilityDigest: value.capabilityDigest,
      csrfDigest: value.csrfDigest,
      expiresAtMs: value.expiresAtMs,
      ...(value.state ? { state: Object.freeze({ ...value.state }) } : {}),
    };
  } catch {
    return null;
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const entry of header.split(";")) {
    const trimmed = entry.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return null;
}

function signCookie(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function assertSecret(value: string, label: string): void {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`SETUP_${label.toUpperCase()}_SECRET_INVALID`);
  }
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
