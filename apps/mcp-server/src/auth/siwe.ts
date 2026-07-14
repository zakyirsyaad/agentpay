import { getAddress, isAddress, verifyMessage } from "ethers";

import {
  AgentPayAuthError,
  sessionScopeSchema,
  type SessionScope,
} from "@agentpay-ai/shared";

export const AGENTPAY_SIWE_DOMAIN = "wallet.agentpay.site";
export const AGENTPAY_CONSUMER_URI = "https://wallet.agentpay.site/mcp";
export const SIWE_CHALLENGE_TTL_SECONDS = 5 * 60;
export const SERVICE_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SUPPORTED_XLAYER_CHAIN_IDS = new Set([196, 1952]);

const allowedScopes = new Set<SessionScope>([
  "wallet:read",
  "payment:prepare",
  "payment:read",
  "payment:review",
  "session:manage",
]);

export const DEFAULT_SESSION_SCOPES = Object.freeze([
  "wallet:read",
  "payment:prepare",
  "payment:read",
  "payment:review",
  "session:manage",
] as SessionScope[]);

export interface SiweChallenge {
  readonly challengeId: string;
  readonly requestId: string;
  readonly domain: typeof AGENTPAY_SIWE_DOMAIN;
  readonly uri: typeof AGENTPAY_CONSUMER_URI;
  readonly ownerAddress: string;
  readonly accountAddress: string;
  readonly chainId: 196 | 1952;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly sessionLifetimeSeconds: typeof SERVICE_SESSION_TTL_SECONDS;
  readonly scopes: readonly SessionScope[];
  readonly message: string;
  readonly consumedAt?: string;
}

export interface CreateSiweChallengeInput {
  challengeId: string;
  requestId: string;
  domain: string;
  uri: string;
  ownerAddress: string;
  accountAddress: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  scopes: readonly SessionScope[];
}

export function createSiweChallenge(input: CreateSiweChallengeInput): SiweChallenge {
  if (input.domain !== AGENTPAY_SIWE_DOMAIN) {
    throw new AgentPayAuthError("SIWE_DOMAIN_INVALID", `SIWE domain must be ${AGENTPAY_SIWE_DOMAIN}.`);
  }
  if (input.uri !== AGENTPAY_CONSUMER_URI) {
    throw new AgentPayAuthError("SIWE_URI_INVALID", `SIWE URI must be ${AGENTPAY_CONSUMER_URI}.`);
  }
  if (!SUPPORTED_XLAYER_CHAIN_IDS.has(input.chainId)) {
    throw new AgentPayAuthError("SIWE_CHAIN_INVALID", "SIWE challenge must target X Layer mainnet or testnet.");
  }
  if (!isAddress(input.ownerAddress) || !isAddress(input.accountAddress)) {
    throw new AgentPayAuthError("SIWE_ADDRESS_INVALID", "SIWE challenge addresses must be valid EVM addresses.");
  }
  if (input.nonce.trim().length < 8 || /\s/.test(input.nonce)) {
    throw new AgentPayAuthError("SIWE_NONCE_INVALID", "SIWE challenge nonce is invalid.");
  }
  if (!input.challengeId.trim() || !input.requestId.trim()) {
    throw new AgentPayAuthError("SIWE_REQUEST_INVALID", "SIWE challenge identifiers are required.");
  }

  const scopes = [...new Set(input.scopes)].sort();
  if (scopes.length === 0 || scopes.some((scope) => !allowedScopes.has(scope))) {
    throw new AgentPayAuthError("SIWE_SCOPE_INVALID", "SIWE challenge requested an unsupported scope.");
  }
  for (const scope of scopes) {
    sessionScopeSchema.parse(scope);
  }

  const issuedAt = new Date(input.issuedAt);
  const expiresAt = new Date(input.expiresAt);
  if (!Number.isFinite(issuedAt.getTime()) || !Number.isFinite(expiresAt.getTime())) {
    throw new AgentPayAuthError("SIWE_TIME_INVALID", "SIWE challenge timestamps are invalid.");
  }
  if (expiresAt.getTime() <= issuedAt.getTime() || expiresAt.getTime() - issuedAt.getTime() > SIWE_CHALLENGE_TTL_SECONDS * 1000) {
    throw new AgentPayAuthError("SIWE_EXPIRY_INVALID", "SIWE challenge expiry must be within five minutes.");
  }

  const challenge = {
    challengeId: input.challengeId,
    requestId: input.requestId,
    domain: AGENTPAY_SIWE_DOMAIN,
    uri: AGENTPAY_CONSUMER_URI,
    ownerAddress: getAddress(input.ownerAddress),
    accountAddress: getAddress(input.accountAddress).toLowerCase(),
    chainId: input.chainId as 196 | 1952,
    nonce: input.nonce,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    sessionLifetimeSeconds: SERVICE_SESSION_TTL_SECONDS,
    scopes: Object.freeze(scopes as SessionScope[]),
  } as const;

  return Object.freeze({
    ...challenge,
    message: buildSiweMessage(challenge),
  });
}

export async function verifySiweChallengeSignature(
  challenge: SiweChallenge,
  signature: string,
  now: Date,
): Promise<string> {
  if (
    challenge.domain !== AGENTPAY_SIWE_DOMAIN ||
    challenge.uri !== AGENTPAY_CONSUMER_URI ||
    challenge.sessionLifetimeSeconds !== SERVICE_SESSION_TTL_SECONDS
  ) {
    throw new AgentPayAuthError("SIWE_MESSAGE_MISMATCH", "SIWE challenge binding is invalid.");
  }
  const canonicalMessage = buildSiweMessage(challenge);
  if (canonicalMessage !== challenge.message) {
    throw new AgentPayAuthError("SIWE_MESSAGE_MISMATCH", "SIWE message does not match the issued challenge.");
  }

  const nowMs = now.getTime();
  const issuedAtMs = new Date(challenge.issuedAt).getTime();
  const expiresAtMs = new Date(challenge.expiresAt).getTime();
  if (
    !Number.isFinite(issuedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= issuedAtMs
  ) {
    throw new AgentPayAuthError("SIWE_TIME_INVALID", "SIWE challenge timestamps are invalid.");
  }
  if (!Number.isFinite(nowMs) || nowMs < issuedAtMs || nowMs >= expiresAtMs) {
    throw new AgentPayAuthError("SIWE_EXPIRED", "SIWE challenge expired or is not active yet.");
  }

  let recoveredAddress: string;
  try {
    recoveredAddress = getAddress(verifyMessage(challenge.message, signature));
  } catch {
    throw new AgentPayAuthError("SIWE_SIGNATURE_INVALID", "Invalid SIWE signature.");
  }

  if (recoveredAddress.toLowerCase() !== challenge.ownerAddress.toLowerCase()) {
    throw new AgentPayAuthError("SIWE_SIGNER_MISMATCH", "SIWE signer does not match the challenge owner.");
  }

  return recoveredAddress;
}

function buildSiweMessage(
  input: Pick<
    SiweChallenge,
    "domain" | "ownerAddress" | "uri" | "issuedAt" | "expiresAt" | "chainId" | "nonce" | "requestId" | "accountAddress" | "scopes"
  > & { sessionLifetimeSeconds?: number },
): string {
  const resources = [
    `- urn:agentpay:account:${input.accountAddress.toLowerCase()}`,
    ...input.scopes.map((scope) => `- urn:agentpay:scope:${scope}`),
  ];

  return [
    `${input.domain} wants you to sign in with your Ethereum account:`,
    input.ownerAddress,
    "",
    "AgentPay consumer session consent. This session permits wallet reads, payment preparation, payment review orchestration, payment history, and session management. It does not authorize a payment or token transfer.",
    "",
    `URI: ${input.uri}`,
    "Version: 1",
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expiresAt}`,
    `Session Lifetime: ${input.sessionLifetimeSeconds ?? SERVICE_SESSION_TTL_SECONDS} seconds`,
    `Request ID: ${input.requestId}`,
    "Resources:",
    ...resources,
  ].join("\n");
}
