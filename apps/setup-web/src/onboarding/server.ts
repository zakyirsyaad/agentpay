import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  MAINNET_SETUP_CHAIN_ID,
  mainnetWalletSetupAuthorizeRequestSchema,
  mainnetWalletSetupChallengeRequestSchema,
  mainnetWalletSetupChallengeResponseSchema,
  mainnetWalletSetupPublicStatusSchema,
  type MainnetWalletSetupPolicyContext,
  type MainnetWalletSetupTypedData,
} from "@agentpay-ai/shared";
import type { ProductionSetupWebStore } from "@agentpay-ai/mcp-server";
import { TypedDataEncoder, getAddress } from "ethers";

import {
  createBrowserTransaction,
  hashBrowserSecret,
  readBoundedJsonBody,
  verifyBrowserTransaction,
} from "./browser-transaction.ts";
import { verifyProductionSetupAuthorization } from "./authorization.ts";
import { renderProductionOnboardingPage } from "./page.ts";

type EthersTypedDataTypes = Record<string, Array<{ name: string; type: string }>>;

export type ProductionSetupMode = "OFF" | "CANARY" | "PUBLIC" | "DRAIN";

export interface ProductionOnboardingPolicyAdapter {
  derive(input: {
    ownerAddress: string;
    setupIntentId: string;
    deploymentNonce: string;
    deadline: string;
    currentUnixTime: number;
  }): Promise<Readonly<{
    typedData: MainnetWalletSetupTypedData;
    policyContext: MainnetWalletSetupPolicyContext;
  }>>;
  getOwnerCode(ownerAddress: string): Promise<string>;
}

export interface ProductionOnboardingDependencies {
  readonly store: ProductionSetupWebStore;
  readonly policy: ProductionOnboardingPolicyAdapter;
  readonly mode: ProductionSetupMode;
  readonly origin: "https://onboard.agentpay.site";
  readonly host: "onboard.agentpay.site";
  readonly cookieSecret: string;
  readonly capabilitySecret: string;
  readonly trustedProxyIdentity: string;
  readonly clock: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly createSetupIntentId?: () => string;
  readonly createDeploymentNonce?: () => string;
  readonly authorizationLifetimeSeconds?: number;
  readonly rateLimiter: { allow(key: string, now: Date): boolean | Promise<boolean> };
  readonly ready?: () => boolean | Promise<boolean>;
}

interface TransactionState {
  setupIntentId: string;
  ownerAddress: string;
  deploymentNonce: string;
  deadline: string;
  authorizationHash: string;
}

const routes = Object.freeze(new Map([
  ["/setup", "GET"],
  ["/api/setup/challenge", "POST"],
  ["/api/setup/status", "GET"],
  ["/api/setup/authorize", "POST"],
  ["/healthz", "GET"],
  ["/readyz", "GET"],
]));

export function createProductionOnboardingHandler(dependencies: ProductionOnboardingDependencies) {
  assertDependencies(dependencies);
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const expectedMethod = routes.get(path);
    if (!expectedMethod) return json({ error: "SETUP_NOT_FOUND" }, 404);
    if (request.method !== expectedMethod) return json({ error: "SETUP_METHOD_NOT_ALLOWED" }, 405);
    if (request.headers.get("host") !== dependencies.host) return json({ error: "SETUP_UNAVAILABLE" }, 404);

    if (path === "/healthz") return json({ status: "ok", mode: dependencies.mode }, 200);
    if (path === "/readyz") {
      try {
        return await dependencies.ready?.() === false
          ? json({ error: "SETUP_UNAVAILABLE" }, 503)
          : json({ status: "ready", mode: dependencies.mode }, 200);
      } catch {
        return json({ error: "SETUP_UNAVAILABLE" }, 503);
      }
    }
    if (path === "/setup") {
      if (!validNavigationBoundary(request)) return json({ error: "SETUP_UNAVAILABLE" }, 404);
      const nonce = Buffer.from(randomBytes(18)).toString("base64");
      return new Response(renderProductionOnboardingPage(nonce), {
        status: 200,
        headers: responseHeaders({
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; font-src 'none'; img-src 'none'; object-src 'none'`,
        }),
      });
    }
    if (!validApiBoundary(request, dependencies)) return json({ error: "SETUP_UNAVAILABLE" }, 404);

    try {
      const rateKey = `${path}:${request.headers.get("x-agentpay-client-address")}`;
      if (!await dependencies.rateLimiter.allow(rateKey, dependencies.clock())) {
        return json({ error: "SETUP_RATE_LIMITED" }, 429);
      }
      if (path === "/api/setup/challenge") return await handleChallenge(request, dependencies);
      if (path === "/api/setup/status") return await handleStatus(request, dependencies);
      return await handleAuthorization(request, dependencies);
    } catch (error) {
      return publicError(error);
    }
  };
}

async function handleChallenge(
  request: Request,
  dependencies: ProductionOnboardingDependencies,
): Promise<Response> {
  if (dependencies.mode === "OFF" || dependencies.mode === "DRAIN") {
    return json({ error: "SETUP_NOT_ACCEPTING_CHALLENGES" }, 503);
  }
  const parsed = mainnetWalletSetupChallengeRequestSchema.safeParse(await readBoundedJsonBody(request));
  if (!parsed.success) return json({ error: "SETUP_REQUEST_INVALID" }, 400);
  const ownerAddress = getAddress(parsed.data.ownerAddress).toLowerCase();
  if (await dependencies.policy.getOwnerCode(ownerAddress) !== "0x") {
    return json({ error: "SETUP_OWNER_NOT_EOA" }, 400);
  }

  const at = dependencies.clock();
  const currentUnixTime = Math.floor(at.getTime() / 1_000);
  const lifetime = dependencies.authorizationLifetimeSeconds ?? 600;
  const deadline = String(currentUnixTime + lifetime);
  const expiresAt = new Date(Number(deadline) * 1_000);
  const setupIntentId = dependencies.createSetupIntentId?.() ?? `setup_${randomUUID()}`;
  const deploymentNonce = dependencies.createDeploymentNonce?.() ??
    `0x${Buffer.from((dependencies.randomBytes ?? randomBytes)(32)).toString("hex")}`;
  const derived = await dependencies.policy.derive({
    ownerAddress,
    setupIntentId,
    deploymentNonce,
    deadline,
    currentUnixTime,
  });
  const authorizationHash = TypedDataEncoder.hash(
    derived.typedData.domain,
    derived.typedData.types as unknown as EthersTypedDataTypes,
    derived.typedData.message,
  ).toLowerCase();
  const transaction = createBrowserTransaction({
    cookieSecret: dependencies.cookieSecret,
    capabilitySecret: dependencies.capabilitySecret,
    expiresAt,
    now: at,
    randomBytes: dependencies.randomBytes,
    state: { setupIntentId, ownerAddress, deploymentNonce, deadline, authorizationHash },
  });
  const message = derived.typedData.message;
  await dependencies.store.challenge({
    setupIntentId,
    capabilityDigest: transaction.capabilityDigest,
    ownerAddress,
    executorAddress: message.executor.toLowerCase(),
    messageToSign: JSON.stringify(derived.typedData),
    homeChainId: MAINNET_SETUP_CHAIN_ID,
    deploymentNonce: message.deploymentNonce.toLowerCase(),
    manifestSha256: message.manifestSha256.toLowerCase(),
    factoryAddress: message.factory.toLowerCase(),
    factoryRuntimeCodeHash: message.factoryRuntimeCodeHash.toLowerCase(),
    deploymentSalt: message.deploymentSalt.toLowerCase(),
    predictedAccount: message.predictedAccount.toLowerCase(),
    accountCreationCodeHash: message.accountCreationCodeHash.toLowerCase(),
    accountRuntimeCodeHash: message.accountRuntimeCodeHash.toLowerCase(),
    authorizationHash,
    expiresAt: expiresAt.toISOString(),
    at: at.toISOString(),
    rateLimitKeyDigest: hashBrowserSecret(
      request.headers.get("x-agentpay-client-address")!,
      dependencies.capabilitySecret,
    ),
  });

  const responseBody = mainnetWalletSetupChallengeResponseSchema.parse({
    capability: transaction.capability,
    csrfToken: transaction.csrfToken,
    typedData: derived.typedData,
    expiresAt: expiresAt.toISOString(),
  });
  return json(responseBody, 201, { "set-cookie": transaction.setCookie });
}

async function handleStatus(
  request: Request,
  dependencies: ProductionOnboardingDependencies,
): Promise<Response> {
  const transaction = loadTransaction(request, dependencies, false);
  if (!transaction) return json({ error: "SETUP_UNAVAILABLE" }, 404);
  const status = await dependencies.store.status({
    capabilityDigest: transaction.capabilityDigest,
    at: dependencies.clock().toISOString(),
  });
  return json(mainnetWalletSetupPublicStatusSchema.parse(status), 200);
}

async function handleAuthorization(
  request: Request,
  dependencies: ProductionOnboardingDependencies,
): Promise<Response> {
  if (dependencies.mode === "OFF") return json({ error: "SETUP_UNAVAILABLE" }, 503);
  const transaction = loadTransaction(request, dependencies, true);
  if (!transaction) return json({ error: "SETUP_UNAVAILABLE" }, 404);
  const state = parseTransactionState(transaction.state);
  if (!state) return json({ error: "SETUP_UNAVAILABLE" }, 404);
  const parsed = mainnetWalletSetupAuthorizeRequestSchema.safeParse(await readBoundedJsonBody(request));
  if (!parsed.success) return json({ error: "SETUP_REQUEST_INVALID" }, 400);

  const now = dependencies.clock();
  const currentUnixTime = Math.floor(now.getTime() / 1_000);
  const derived = await dependencies.policy.derive({
    ownerAddress: state.ownerAddress,
    setupIntentId: state.setupIntentId,
    deploymentNonce: state.deploymentNonce,
    deadline: state.deadline,
    currentUnixTime,
  });
  const authorizationHash = TypedDataEncoder.hash(
    derived.typedData.domain,
    derived.typedData.types as unknown as EthersTypedDataTypes,
    derived.typedData.message,
  ).toLowerCase();
  if (authorizationHash !== state.authorizationHash) return json({ error: "SETUP_UNAVAILABLE" }, 409);
  const verified = await verifyProductionSetupAuthorization({
    typedData: derived.typedData,
    signature: parsed.data.signature,
    expectedOwnerAddress: state.ownerAddress,
    policy: derived.policyContext,
    nowUnix: currentUnixTime,
    getOwnerCode: dependencies.policy.getOwnerCode,
  });
  const admission = await dependencies.store.admit({
    capabilityDigest: transaction.capabilityDigest,
    ownerSetupSignature: verified.signature,
    at: now.toISOString(),
  });
  return json({
    setupIntentId: admission.setupIntentId,
    jobId: admission.jobId,
    status: "SETUP_PENDING",
  }, 202);
}

function loadTransaction(
  request: Request,
  dependencies: ProductionOnboardingDependencies,
  requireCsrf: boolean,
) {
  return verifyBrowserTransaction({
    cookieHeader: request.headers.get("cookie") ?? undefined,
    capability: request.headers.get("x-agentpay-setup-capability") ?? undefined,
    csrfToken: request.headers.get("x-agentpay-csrf-token") ?? undefined,
    cookieSecret: dependencies.cookieSecret,
    capabilitySecret: dependencies.capabilitySecret,
    now: dependencies.clock(),
    requireCsrf,
  });
}

function parseTransactionState(value: unknown): TransactionState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (Object.keys(state).sort().join(",") !==
    "authorizationHash,deadline,deploymentNonce,ownerAddress,setupIntentId") return null;
  if (typeof state.setupIntentId !== "string" || state.setupIntentId.length < 16 || state.setupIntentId.length > 128) return null;
  if (typeof state.ownerAddress !== "string" || !/^0x[0-9a-f]{40}$/.test(state.ownerAddress)) return null;
  if (typeof state.deploymentNonce !== "string" || !/^0x[0-9a-f]{64}$/.test(state.deploymentNonce)) return null;
  if (typeof state.authorizationHash !== "string" || !/^0x[0-9a-f]{64}$/.test(state.authorizationHash)) return null;
  if (typeof state.deadline !== "string" || !/^[1-9][0-9]*$/.test(state.deadline)) return null;
  return state as unknown as TransactionState;
}

function validNavigationBoundary(request: Request): boolean {
  return request.headers.get("sec-fetch-mode") === "navigate" &&
    request.headers.get("sec-fetch-dest") === "document" &&
    new Set(["none", "same-origin", "same-site", "cross-site"]).has(request.headers.get("sec-fetch-site") ?? "");
}

function validApiBoundary(request: Request, dependencies: ProductionOnboardingDependencies): boolean {
  const clientAddress = request.headers.get("x-agentpay-client-address") ?? "";
  const suppliedOrigin = request.headers.get("origin");
  const validOrigin = request.method === "GET"
    ? suppliedOrigin === null || suppliedOrigin === dependencies.origin
    : suppliedOrigin === dependencies.origin;
  return validOrigin &&
    request.headers.get("sec-fetch-site") === "same-origin" &&
    request.headers.get("sec-fetch-mode") === "cors" &&
    request.headers.get("x-agentpay-proxy-identity") === dependencies.trustedProxyIdentity &&
    clientAddress.length >= 3 && clientAddress.length <= 128 && !/[\r\n]/.test(clientAddress);
}

function publicError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  if (message === "SETUP_BODY_TOO_LARGE") return json({ error: message }, 413);
  if (message === "SETUP_JSON_REQUIRED") return json({ error: message }, 415);
  if (message === "SETUP_JSON_INVALID") return json({ error: message }, 400);
  if (message === "SETUP_SIGNATURE_INVALID" || message === "SETUP_AUTHORIZATION_INVALID" ||
    message === "SETUP_AUTHORIZATION_EXPIRED" || message === "SETUP_OWNER_NOT_EOA") {
    return json({ error: message }, 400);
  }
  return json({ error: "SETUP_UNAVAILABLE" }, 503);
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: responseHeaders({ "content-type": "application/json; charset=utf-8", ...extraHeaders }),
  });
}

function responseHeaders(extra: Record<string, string>): Headers {
  return new Headers({
    "cache-control": "no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    ...extra,
  });
}

function assertDependencies(dependencies: ProductionOnboardingDependencies): void {
  if (dependencies.origin !== "https://onboard.agentpay.site" || dependencies.host !== "onboard.agentpay.site") {
    throw new Error("Production onboarding origin is invalid.");
  }
  for (const secret of [dependencies.cookieSecret, dependencies.capabilitySecret, dependencies.trustedProxyIdentity]) {
    if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("Production onboarding secret is invalid.");
  }
  const lifetime = dependencies.authorizationLifetimeSeconds ?? 600;
  if (!Number.isSafeInteger(lifetime) || lifetime < 60 || lifetime > 900) {
    throw new Error("Production onboarding authorization lifetime is invalid.");
  }
}

export async function startProductionOnboardingServer(
  dependencies: ProductionOnboardingDependencies,
  options: { port?: number; hostname?: string } = {},
): Promise<Readonly<{ url: string; close(): Promise<void> }>> {
  const handler = createProductionOnboardingHandler(dependencies);
  const server: Server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
        else if (value !== undefined) headers.set(name, value);
      }
      const method = incoming.method ?? "GET";
      const init: RequestInit & { duplex?: "half" } = { method, headers };
      if (method !== "GET" && method !== "HEAD") {
        init.body = Readable.toWeb(incoming) as ReadableStream;
        init.duplex = "half";
      }
      const response = await handler(new Request(`${dependencies.origin}${incoming.url ?? "/"}`, init));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(503, Object.fromEntries(responseHeaders({ "content-type": "application/json" }).entries()));
      outgoing.end(JSON.stringify({ error: "SETUP_UNAVAILABLE" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3000, options.hostname ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Production onboarding server failed to bind.");
  return Object.freeze({
    url: `http://${options.hostname ?? "127.0.0.1"}:${address.port}/setup`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  });
}
