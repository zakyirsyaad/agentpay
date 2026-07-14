import { randomBytes } from "node:crypto";

import {
  AgentPayAuthError,
  sessionScopeSchema,
  type SessionEnvironment,
  type SessionScope,
} from "@agentpay-ai/shared";
import { z } from "zod";

import {
  AGENTPAY_CONSUMER_URI,
  DEFAULT_SESSION_SCOPES,
  SERVICE_SESSION_TTL_SECONDS,
  SIWE_CHALLENGE_TTL_SECONDS,
  createSiweChallenge,
  type CreateSiweChallengeInput,
} from "./siwe.ts";
import {
  issueServiceSession,
  type AuthChallengeStore,
  type ResolvedTenantBinding,
  type ServiceSessionStore,
} from "./session.ts";

const challengeRequestSchema = z.object({
  ownerAddress: z.string(),
  accountAddress: z.string(),
  chainId: z.union([z.literal(196), z.literal(1952)]),
  scopes: z.array(sessionScopeSchema).min(1).max(DEFAULT_SESSION_SCOPES.length).optional(),
});

const verifyRequestSchema = z.object({
  challengeId: z.string().trim().min(1).max(160),
  signature: z.string().trim().min(2).max(300),
});

export interface ConsumerSessionApiDependencies {
  challengeStore: AuthChallengeStore;
  sessionStore: ServiceSessionStore;
  serverSecret: string | Uint8Array;
  audience: typeof AGENTPAY_CONSUMER_URI;
  environment: SessionEnvironment;
  clock: () => Date;
  resolveTenant(
    ownerAddress: string,
    accountAddress: string,
    chainId: number,
    environment?: SessionEnvironment,
  ): Promise<ResolvedTenantBinding>;
  createChallengeId?: () => string;
  createRequestId?: () => string;
  createNonce?: () => string;
  createSessionId?: () => string;
  randomCredentialBytes?: () => Uint8Array;
  verifySignature?: Parameters<typeof issueServiceSession>[0]["verifySignature"];
}

export interface ConsumerSessionApi {
  handle(request: Request): Promise<Response>;
}

export function createConsumerSessionApi(dependencies: ConsumerSessionApiDependencies): ConsumerSessionApi {
  const rateLimits = new Map<string, { count: number; resetAt: number }>();

  return {
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed." }, 405);
      }
      const contentLength = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > 16_384) {
        return jsonResponse({ error: "Request body too large." }, 413);
      }

      if (url.pathname === "/auth/siwe/challenge") {
        return handleChallenge(request, dependencies, rateLimits);
      }
      if (url.pathname === "/auth/siwe/verify") {
        return handleVerify(request, dependencies, rateLimits);
      }
      return jsonResponse({ error: "Not found." }, 404);
    },
  };
}

async function handleChallenge(
  request: Request,
  dependencies: ConsumerSessionApiDependencies,
  rateLimits: Map<string, { count: number; resetAt: number }>,
): Promise<Response> {
  try {
    if (!consumeRateLimit(rateLimits, "challenge", dependencies.clock())) {
      return jsonResponse({ error: "Too many session requests." }, 429);
    }
    const input = challengeRequestSchema.parse(await readJsonBody(request));
    const issuedAt = dependencies.clock();
    const challengeInput: CreateSiweChallengeInput = {
      challengeId: dependencies.createChallengeId?.() ?? `challenge_${cryptoRandomHex(12)}`,
      requestId: dependencies.createRequestId?.() ?? `request_${cryptoRandomHex(12)}`,
      domain: "wallet.agentpay.site",
      uri: AGENTPAY_CONSUMER_URI,
      ownerAddress: input.ownerAddress,
      accountAddress: input.accountAddress,
      chainId: input.chainId,
      nonce: dependencies.createNonce?.() ?? cryptoRandomHex(16),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + SIWE_CHALLENGE_TTL_SECONDS * 1000).toISOString(),
      scopes: input.scopes ?? DEFAULT_SESSION_SCOPES,
    };
    const challenge = createSiweChallenge(challengeInput);
    await dependencies.challengeStore.create(challenge);
    return jsonResponse({
      challengeId: challenge.challengeId,
      message: challenge.message,
      expiresAt: challenge.expiresAt,
      scopes: challenge.scopes,
      sessionLifetimeSeconds: SERVICE_SESSION_TTL_SECONDS,
    });
  } catch {
    return jsonResponse({ error: "Invalid SIWE challenge request." }, 400);
  }
}

async function handleVerify(
  request: Request,
  dependencies: ConsumerSessionApiDependencies,
  rateLimits: Map<string, { count: number; resetAt: number }>,
): Promise<Response> {
  try {
    if (!consumeRateLimit(rateLimits, "verify", dependencies.clock())) {
      return jsonResponse({ error: "Too many session requests." }, 429);
    }
    const input = verifyRequestSchema.parse(await readJsonBody(request));
    const challenge = await dependencies.challengeStore.get(input.challengeId);
    if (!challenge) {
      return jsonResponse({ error: "SIWE challenge unavailable." }, 404);
    }
    const issued = await issueServiceSession({
      challenge,
      signature: input.signature,
      challengeStore: dependencies.challengeStore,
      sessionStore: dependencies.sessionStore,
      serverSecret: dependencies.serverSecret,
      audience: dependencies.audience,
      environment: dependencies.environment,
      clock: dependencies.clock,
      resolveTenant: dependencies.resolveTenant,
      verifySignature: dependencies.verifySignature,
      createSessionId: dependencies.createSessionId,
      randomCredentialBytes: dependencies.randomCredentialBytes,
    });

    return jsonResponse({
      sessionId: issued.context.sessionId,
      credential: issued.credential,
      tenantId: issued.context.tenantId,
      ownerAddress: issued.context.ownerAddress,
      accountAddress: issued.context.accountAddress,
      homeChainId: issued.context.homeChainId,
      scopes: issued.context.scopes,
      expiresAt: issued.context.expiresAt,
    });
  } catch (error) {
    if (error instanceof AgentPayAuthError && error.code === "SIWE_REPLAYED") {
      return jsonResponse({ error: "SIWE challenge unavailable." }, 400);
    }
    return jsonResponse({ error: "SIWE verification failed." }, 400);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 16_384) {
    throw new AgentPayAuthError("REQUEST_BODY_TOO_LARGE", "Request body exceeds the maximum size.");
  }
  return JSON.parse(text) as unknown;
}

function consumeRateLimit(
  limits: Map<string, { count: number; resetAt: number }>,
  key: string,
  now: Date,
): boolean {
  const nowMs = now.getTime();
  const current = limits.get(key);
  if (!current || nowMs >= current.resetAt) {
    limits.set(key, { count: 1, resetAt: nowMs + 60_000 });
    return true;
  }
  if (current.count >= 60) {
    return false;
  }
  limits.set(key, { count: current.count + 1, resetAt: current.resetAt });
  return true;
}

function cryptoRandomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
