import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  AgentPayAuthError,
  createSessionContext,
  requireSessionScope,
  type SessionContext,
  type SessionEnvironment,
  type SessionScope,
} from "@agentpay-ai/shared";

import {
  SERVICE_SESSION_TTL_SECONDS,
  verifySiweChallengeSignature,
  type SiweChallenge,
} from "./siwe.ts";

export interface AuthChallengeStore {
  create(record: SiweChallenge): Promise<void>;
  get(challengeId: string): Promise<SiweChallenge | null>;
  consume(challengeId: string, consumedAt: string): Promise<boolean>;
}

export interface ServiceSessionRecord {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly ownerAddress: string;
  readonly accountAddress: string;
  readonly homeChainId: number;
  readonly audience: string;
  readonly environment: SessionEnvironment;
  readonly scopes: readonly SessionScope[];
  readonly authenticationEpoch: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string;
  readonly credentialDigest: string;
  readonly revokedAt?: string;
}

export interface ServiceSessionStore {
  create(record: ServiceSessionRecord): Promise<void>;
  findByCredentialDigest(digest: string): Promise<ServiceSessionRecord | null>;
  revoke(sessionId: string, revokedAt: string): Promise<void>;
  revokeAll(tenantId: string, revokedAt: string): Promise<void>;
  touch(sessionId: string, lastUsedAt: string): Promise<void>;
}

export interface ResolvedTenantBinding {
  tenantId: string;
  authenticationEpoch: number;
  environment?: SessionEnvironment;
}

export interface IssueServiceSessionOptions {
  challenge: SiweChallenge;
  signature: string;
  challengeStore: AuthChallengeStore;
  sessionStore: ServiceSessionStore;
  serverSecret: string | Uint8Array;
  audience: string;
  environment: SessionEnvironment;
  clock: () => Date;
  resolveTenant(ownerAddress: string, accountAddress: string, chainId: number, environment?: SessionEnvironment): Promise<ResolvedTenantBinding>;
  verifySignature?: (challenge: SiweChallenge, signature: string, now: Date) => Promise<string>;
  createSessionId?: () => string;
  randomCredentialBytes?: () => Uint8Array;
}

export interface IssuedServiceSession {
  readonly credential: string;
  readonly context: SessionContext;
  readonly record: ServiceSessionRecord;
}

export interface AuthenticateServiceSessionOptions {
  credential: string;
  sessionStore: ServiceSessionStore;
  serverSecret: string | Uint8Array;
  audience: string;
  environment: SessionEnvironment;
  clock: () => Date;
  currentAuthenticationEpoch(tenantId: string): Promise<number>;
  currentTenantState?: (tenantId: string) => Promise<{
    authenticationEpoch: number;
    environment: SessionEnvironment;
    status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  }>;
  requiredScope?: SessionScope;
}

export async function issueServiceSession(options: IssueServiceSessionOptions): Promise<IssuedServiceSession> {
  const now = options.clock();
  const expectedEnvironment = options.challenge.chainId === 196 ? "production" : "staging";
  if (options.environment !== expectedEnvironment) {
    throw new AgentPayAuthError("AUTH_ENVIRONMENT_MISMATCH", "SIWE chain does not match the session environment.");
  }
  const verify = options.verifySignature ?? verifySiweChallengeSignature;
  const recoveredOwner = await verify(options.challenge, options.signature, now);
  if (recoveredOwner.toLowerCase() !== options.challenge.ownerAddress.toLowerCase()) {
    throw new AgentPayAuthError("SIWE_SIGNER_MISMATCH", "SIWE signer does not match the challenge owner.");
  }
  const binding = await options.resolveTenant(
    recoveredOwner,
    options.challenge.accountAddress,
    options.challenge.chainId,
    options.environment,
  );
  if (binding.environment && binding.environment !== options.environment) {
    throw new AgentPayAuthError("AUTH_ENVIRONMENT_MISMATCH", "Owner tenant environment does not match this endpoint.");
  }

  const challengeIssuedAt = new Date(options.challenge.issuedAt).getTime();
  const expiresAt = new Date(challengeIssuedAt + SERVICE_SESSION_TTL_SECONDS * 1000).toISOString();
  if (now.getTime() >= new Date(expiresAt).getTime()) {
    throw new AgentPayAuthError("SIWE_EXPIRED", "SIWE challenge no longer permits a new service session.");
  }
  const consumed = await options.challengeStore.consume(options.challenge.challengeId, now.toISOString());
  if (!consumed) {
    throw new AgentPayAuthError("SIWE_REPLAYED", "SIWE challenge has already been consumed or is unavailable.");
  }

  const issuedAt = now.toISOString();
  const rawBytes = options.randomCredentialBytes?.() ?? randomBytes(32);
  if (rawBytes.byteLength !== 32) {
    throw new AgentPayAuthError("AUTH_CREDENTIAL_INVALID", "Session credential generator must return 32 bytes.");
  }
  const credential = Buffer.from(rawBytes).toString("base64url");
  const sessionId = options.createSessionId?.() ?? `session_${randomBytes(12).toString("hex")}`;
  const credentialDigest = digestCredential(credential, options.serverSecret);
  const record: ServiceSessionRecord = Object.freeze({
    sessionId,
    tenantId: binding.tenantId,
    ownerAddress: recoveredOwner.toLowerCase(),
    accountAddress: options.challenge.accountAddress.toLowerCase(),
    homeChainId: options.challenge.chainId,
    audience: options.audience,
    environment: options.environment,
    scopes: Object.freeze([...options.challenge.scopes]),
    authenticationEpoch: binding.authenticationEpoch,
    issuedAt,
    expiresAt,
    lastUsedAt: issuedAt,
    credentialDigest,
  });

  await options.sessionStore.create(record);
  const context = createSessionContext({ ...record, authEpoch: record.authenticationEpoch });
  return Object.freeze({ credential, context, record });
}

export async function authenticateServiceSession(
  options: AuthenticateServiceSessionOptions,
): Promise<SessionContext> {
  const credential = validateCredential(options.credential);
  const digest = digestCredential(credential, options.serverSecret);
  const record = await options.sessionStore.findByCredentialDigest(digest);

  if (!record || !constantTimeEqual(record.credentialDigest, digest)) {
    throw new AgentPayAuthError("AUTH_CREDENTIAL_INVALID", "Consumer session credential is invalid.");
  }

  const now = options.clock();
  if (record.revokedAt) {
    throw new AgentPayAuthError("AUTH_SESSION_REVOKED", "Consumer session has been revoked.");
  }
  if (now.getTime() >= new Date(record.expiresAt).getTime()) {
    throw new AgentPayAuthError("AUTH_SESSION_EXPIRED", "Consumer session has expired.");
  }
  if (record.audience !== options.audience) {
    throw new AgentPayAuthError("AUTH_AUDIENCE_MISMATCH", "Consumer session audience does not match this endpoint.");
  }
  if (record.environment !== options.environment) {
    throw new AgentPayAuthError("AUTH_ENVIRONMENT_MISMATCH", "Consumer session environment does not match this endpoint.");
  }
  const expectedEnvironment = record.homeChainId === 196 ? "production" : "staging";
  if (record.environment !== expectedEnvironment) {
    throw new AgentPayAuthError("AUTH_ENVIRONMENT_MISMATCH", "Consumer session chain does not match its environment.");
  }

  const tenantState = options.currentTenantState
    ? await options.currentTenantState(record.tenantId)
    : undefined;
  if (tenantState && tenantState.status !== "ACTIVE") {
    throw new AgentPayAuthError("AUTH_TENANT_INACTIVE", "Consumer tenant is not active.");
  }
  if (tenantState && tenantState.environment !== record.environment) {
    throw new AgentPayAuthError("AUTH_ENVIRONMENT_MISMATCH", "Consumer tenant environment does not match this endpoint.");
  }
  const currentEpoch = tenantState?.authenticationEpoch ?? (await options.currentAuthenticationEpoch(record.tenantId));
  if (currentEpoch !== record.authenticationEpoch) {
    throw new AgentPayAuthError("AUTH_EPOCH_MISMATCH", "Consumer session authentication epoch is stale.");
  }

  const context = createSessionContext({ ...record, authEpoch: record.authenticationEpoch });
  if (options.requiredScope) {
    requireSessionScope(context, options.requiredScope);
  }
  await options.sessionStore.touch(record.sessionId, now.toISOString());
  return context;
}

export async function revokeServiceSession(
  sessionId: string,
  sessionStore: ServiceSessionStore,
  revokedAt: string,
): Promise<void> {
  await sessionStore.revoke(sessionId, revokedAt);
}

export async function revokeAllTenantSessions(
  tenantId: string,
  sessionStore: ServiceSessionStore,
  revokedAt: string,
): Promise<void> {
  await sessionStore.revokeAll(tenantId, revokedAt);
}

export function parseBearerToken(header: string | null | undefined): string {
  if (!header) {
    throw new AgentPayAuthError("AUTH_CREDENTIAL_REQUIRED", "Bearer credential required.");
  }

  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) {
    throw new AgentPayAuthError("AUTH_CREDENTIAL_REQUIRED", "Bearer credential required.");
  }

  return match[1];
}

export function digestCredential(credential: string, serverSecret: string | Uint8Array): string {
  const key = typeof serverSecret === "string" ? Buffer.from(serverSecret, "utf8") : Buffer.from(serverSecret);
  if (key.byteLength < 16) {
    throw new AgentPayAuthError("AUTH_SECRET_INVALID", "Session hash secret is too short.");
  }

  return createHmac("sha256", key).update(credential, "utf8").digest("hex");
}

function validateCredential(credential: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) {
    throw new AgentPayAuthError("AUTH_CREDENTIAL_INVALID", "Consumer session credential is invalid.");
  }

  return credential;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  try {
    return timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}
