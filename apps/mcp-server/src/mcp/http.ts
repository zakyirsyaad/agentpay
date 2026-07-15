import { EventEmitter, once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { PassThrough } from "node:stream";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
  HTTPAdapter,
  HTTPRequestContext,
  HTTPResponseInstructions,
  HTTPTransportContext,
} from "@okxweb3/x402-core/http";
import type { PaymentPayload, PaymentRequirements } from "@okxweb3/x402-core/types";
import { AgentPayAuthError, type SessionContext } from "@agentpay-ai/shared";
import { AGENTPAY_CONSUMER_URI } from "../auth/siwe.ts";
import { authenticateServiceSession } from "../auth/session.ts";
import { createConsumerSessionApi, type ConsumerSessionApi } from "../auth/consumer-session-api.ts";
import { createConsumerOAuthApi, type ConsumerOAuthApi } from "../auth/oauth-api.ts";
import { createSupabaseAgentPayRepositoriesFromConfig } from "../services/supabase.ts";
import {
  evaluateProductionReadiness,
  fingerprintRuntimeIdentity,
  loadProductionManifest,
  MAINNET_CAIP2,
  MAINNET_CHAIN_ID,
  MAINNET_USDT0_ADDRESS,
  type ExecutionMode,
  type ProductionReadinessResult,
  type RuntimeEnvironmentIdentity,
} from "../runtime/production-readiness.ts";
import {
  createEthersMainnetAccountVerificationReader,
  verifyMainnetAccount,
  type MainnetAccountVerificationExpected,
  type MainnetAccountVerificationResult,
} from "../services/mainnet-account-verifier.ts";

import {
  createAgentPayRuntime,
  parseAgentPayEnv,
  type AgentPayRuntime,
  type AgentPayRuntimeConfig,
} from "../runtime/agentpay-runtime.ts";
import { authenticateConsumerRequest, type ConsumerSessionAuthenticator } from "./consumer-auth.ts";
import {
  createOkxAgentPaymentProcessorFromEnv,
  parseAgentPayMcpPaymentEnv,
  type AgentPayMcpPaymentProcessor,
} from "./okx-agent-payment.ts";
import {
  createInMemoryPaidExecutionLifecycleStore,
  createPaidExecutionLifecycleClaimInput,
  hashCanonicalJson,
  PaidExecutionRequestError,
  parsePaidExecutionRequest,
  type PaidExecutionLifecycleRecord,
  type PaidExecutionLifecycleStore,
  type PaidExecutionRequestBinding,
} from "../services/paid-execution-lifecycle.ts";
import {
  createInMemoryPaidExecutionChallengeStore,
  type PaidExecutionChallengeStore,
} from "../services/paid-execution-challenge.ts";
import type { InvoiceExecutionOutboxStore } from "../services/paid-execution-outbox.ts";
import {
  assertCanaryRequestShapeAllowed,
  assertCanaryUsageWithinCaps,
  CanaryPolicyError,
  DEFAULT_CANARY_CAPS,
  decimalToAtomic6,
  type CanaryPolicy,
} from "../runtime/paid-execution-canary.ts";
import type { CanaryLedgerStore } from "../runtime/paid-execution-canary-ledger.ts";
import type { DurableExecutionContext, PaymentPreflightResult } from "../tools/execute-payment.ts";
import {
  createPaymentAuthorizationFromIntent,
  hashPaymentAuthorization,
} from "../services/payment-authorization.ts";
import { createAgentPayMcpServer, type ConnectableAgentPayMcpServer } from "./stdio.ts";

export type { AgentPayMcpPaymentProcessor } from "./okx-agent-payment.ts";

const defaultHostname = "0.0.0.0";
const defaultPort = 3001;
const defaultMcpPath = "/mcp";
const defaultHealthPath = "/healthz";
const freeJsonRpcMethods = new Set(["initialize", "notifications/initialized", "ping", "tools/list"]);
const consumerAuthorizationServer = "https://wallet.agentpay.site";
const consumerResourceMetadataPath = "/.well-known/oauth-protected-resource/mcp";
const consumerAuthorizationMetadataPath = "/.well-known/oauth-authorization-server";

export interface AgentPayHttpServer {
  url: string;
  mcpUrl: string;
  healthUrl: string;
  readinessUrl: string;
  close(): Promise<void>;
}

export interface StartAgentPayHttpServerOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  hostname?: string;
  port?: number;
  mcpPath?: string;
  healthPath?: string;
  paymentProcessor?: AgentPayMcpPaymentProcessor;
  paidExecutionLifecycle?: PaidExecutionLifecycleStore;
  paidExecutionChallenge?: PaidExecutionChallengeStore;
  invoiceExecutionOutbox?: InvoiceExecutionOutboxStore;
  /** Durable admission ledger required when executionMode is CANARY. */
  canaryLedger?: CanaryLedgerStore;
  /** Static canary allowlist/caps, normally loaded from the frozen manifest. */
  canaryPolicy?: CanaryPolicy;
  createRuntime?: (config: AgentPayRuntimeConfig, tenantContext?: SessionContext) => AgentPayRuntime;
  createServer?: (runtime: AgentPayRuntime, tenantContext?: SessionContext) => ConnectableAgentPayMcpServer;
  createTransport?: () => StreamableHTTPServerTransport;
  mode?: "public" | "consumer";
  consumerAuth?: ConsumerSessionAuthenticator;
  sessionApi?: ConsumerSessionApi;
  oauthApi?: ConsumerOAuthApi;
}

/** @internal Dependency seam for resolver tests; production callers use the pinned defaults. */
export interface ResolveProductionReadinessDependencies {
  loadRuntimeIdentity?: () => Promise<RuntimeEnvironmentIdentity | null>;
  verifyAccount?: (expected: MainnetAccountVerificationExpected) => Promise<MainnetAccountVerificationResult>;
}

/**
 * OFF is a hard execution gate, so its liveness path must not wait for the
 * historical allowlist scan. Every mode that may later serve an executable
 * surface retains the complete on-chain verifier.
 */
export function shouldVerifyMainnetAccountAtStartup(requestedMode: ExecutionMode | undefined): boolean {
  return requestedMode !== "OFF";
}

export async function startAgentPayHttpServer(options: StartAgentPayHttpServerOptions = {}): Promise<AgentPayHttpServer> {
  const config = parseAgentPayEnv(options.env ?? process.env);
  const mode = options.mode ?? config.httpMode ?? "public";
  const paymentEnabled = String((options.env ?? process.env).AGENTPAY_A2MCP_PAYMENT_ENABLED ?? "")
    .trim()
    .toLowerCase();
  const paymentNetwork = String((options.env ?? process.env).AGENTPAY_A2MCP_PAYMENT_NETWORK ?? MAINNET_CAIP2).trim();
  if (
    mode === "public" &&
    ["1", "true", "yes", "on"].includes(paymentEnabled) &&
    paymentNetwork === MAINNET_CAIP2 &&
    (config.environment !== "production" || config.homeChainId !== MAINNET_CHAIN_ID)
  ) {
    throw new Error("Mainnet paid public execution requires AGENTPAY_ENVIRONMENT=production and chain 196.");
  }
  let readiness = createNonProductionReadiness();
  let refreshReadiness: ((current: ProductionReadinessResult) => Promise<ProductionReadinessResult>) | undefined;
  let canaryLedger = options.canaryLedger;
  let canaryPolicy = options.canaryPolicy;
  if (config.environment === "production") {
    const identityRepository = createSupabaseAgentPayRepositoriesFromConfig({
      supabaseUrl: config.supabaseUrl,
      serviceRoleKey: config.serviceRoleKey,
    });
    // Production CANARY may only use the service-role-backed repository and
    // the frozen manifest policy. Test doubles/options cannot bypass this
    // authority boundary.
    canaryLedger = identityRepository.canaryLedger;
    canaryPolicy = await loadManifestCanaryPolicy(config.productionManifestPath);
    readiness = await resolveProductionReadiness(config, options.env ?? process.env, {
      canaryLedger,
      canaryPolicy,
    });
    refreshReadiness = async (current) => {
      try {
        const identity = await identityRepository.runtimeEnvironment.getIdentity();
        if (!identity) {
          return withReadinessError(current, "runtime identity: singleton identity disappeared after startup");
        }
        if (
          (current.identityFingerprint && fingerprintRuntimeIdentity(identity) !== current.identityFingerprint) ||
          identity.executionMode !== current.mode ||
          identity.status !== current.status
        ) {
          return withReadinessError(current, "runtime identity: database identity changed after startup");
        }
        if (current.mode === "CANARY") {
          if (!canaryLedger || !canaryPolicy) {
            return withReadinessError(current, "canary admission: durable ledger or frozen allowlist disappeared");
          }
          try {
            await canaryLedger.snapshot({
              environment: "production",
              tenantId: canaryPolicy.allowlist.tenantId,
              at: new Date().toISOString(),
            });
          } catch {
            return withReadinessError(current, "canary admission: live Supabase ledger read failed");
          }
        }
        return current;
      } catch {
        return withReadinessError(current, "runtime identity: live kill-switch read failed");
      }
    };
  }
  if (mode === "consumer" && !config.environment) {
    throw new AgentPayAuthError("AUTH_ENVIRONMENT_REQUIRED", "Consumer mode requires AGENTPAY_ENVIRONMENT.");
  }
  let consumerAuth = options.consumerAuth;
  let sessionApi: ConsumerSessionApi | undefined = options.sessionApi;
  let oauthApi: ConsumerOAuthApi | undefined = options.oauthApi;
  const legacySiweSessionApiEnabled = mode === "consumer" && isEnabledFlag(
    (options.env ?? process.env).AGENTPAY_ENABLE_LEGACY_SIWE_SESSION_API,
  );
  let authRepositories: ReturnType<typeof createSupabaseAgentPayRepositoriesFromConfig> | undefined;
  const getAuthRepositories = () => {
    authRepositories ??= createSupabaseAgentPayRepositoriesFromConfig({
      supabaseUrl: config.supabaseUrl,
      serviceRoleKey: config.serviceRoleKey,
    });
    return authRepositories;
  };
  if (mode === "consumer" && !consumerAuth) {
    if (!config.sessionHashKey) {
      throw new AgentPayAuthError("AUTH_SECRET_REQUIRED", "Consumer mode requires AGENTPAY_SESSION_HASH_KEY.");
    }
    const repositories = getAuthRepositories();
    const environment = config.environment!;
    consumerAuth = {
      async authenticate(credential, requiredScope) {
        return authenticateServiceSession({
          credential,
          sessionStore: repositories.serviceSessions,
          serverSecret: config.sessionHashKey!,
          audience: AGENTPAY_CONSUMER_URI,
          environment,
          clock: () => new Date(),
          currentAuthenticationEpoch: repositories.tenantBindings.getAuthenticationEpoch,
          currentTenantState: repositories.tenantBindings.getTenantState,
          requiredScope,
        });
      },
    };
  }
  if (mode === "consumer" && legacySiweSessionApiEnabled && !sessionApi) {
    if (!config.sessionHashKey) {
      throw new AgentPayAuthError("AUTH_SECRET_REQUIRED", "Legacy SIWE session API requires AGENTPAY_SESSION_HASH_KEY.");
    }
    const repositories = getAuthRepositories();
    sessionApi = createConsumerSessionApi({
      challengeStore: repositories.authChallenges,
      sessionStore: repositories.serviceSessions,
      serverSecret: config.sessionHashKey,
      audience: AGENTPAY_CONSUMER_URI,
      environment: config.environment!,
      clock: () => new Date(),
      resolveTenant: repositories.tenantBindings.resolveTenant,
    });
  }
  if (mode === "consumer" && !oauthApi && config.sessionHashKey) {
    const repositories = getAuthRepositories();
    oauthApi = createConsumerOAuthApi({
      clientStore: repositories.oauthClients,
      authorizationStore: repositories.oauthAuthorizations,
      challengeStore: repositories.authChallenges,
      admissionStore: repositories.oauthAdmission,
      serverSecret: config.sessionHashKey,
      audience: AGENTPAY_CONSUMER_URI,
      environment: config.environment!,
      clock: () => new Date(),
      resolveOwner: repositories.tenantBindings.resolveOwner,
      currentAuthenticationEpoch: repositories.tenantBindings.getAuthenticationEpoch,
    });
  }
  if (mode === "consumer" && !consumerAuth) {
    throw new AgentPayAuthError("AUTH_PROVIDER_REQUIRED", "Consumer mode requires a session authenticator.");
  }
  const gatedConfig = config.environment === "production"
    ? {
        ...config,
        executionMode: mode === "public" ? readiness.mode : ("OFF" as const),
        executionModeVerified: mode === "public" && readiness.executionAllowed,
      }
    : config;
  const createRuntime = options.createRuntime ?? ((runtimeConfig, tenantContext) =>
    createAgentPayRuntime(runtimeConfig, { tenantContext }));
  const runtime = mode === "public" && (config.environment !== "production" || readiness.executionAllowed)
    ? createRuntime(gatedConfig)
    : undefined;
  const paidExecutionLifecycle = options.paidExecutionLifecycle ?? runtime?.paidExecutionLifecycle ??
    (config.environment === "production" ? undefined : createInMemoryPaidExecutionLifecycleStore());
  const paidExecutionChallenge = options.paidExecutionChallenge ?? runtime?.paidExecutionChallenge ??
    (config.environment === "production" ? undefined : createInMemoryPaidExecutionChallengeStore());
  const invoiceExecutionOutbox = options.invoiceExecutionOutbox ?? runtime?.invoiceExecutionOutbox;
  canaryLedger ??= runtime?.canaryLedger;
  if (config.environment === "production" && mode === "public" &&
    (!paidExecutionLifecycle || !paidExecutionChallenge || !invoiceExecutionOutbox)) {
    readiness = withReadinessError(readiness, "paid execution lifecycle: durable challenge, lifecycle, and outbox stores are required");
  }
  const hostname = options.hostname ?? defaultHostname;
  const port = options.port ?? defaultPort;
  const mcpPath = normalizePath(options.mcpPath ?? defaultMcpPath);
  const healthPath = normalizePath(options.healthPath ?? defaultHealthPath);
  const readinessPath = normalizePath("/readyz");
  let paymentProcessor: AgentPayMcpPaymentProcessor | undefined;
  if (mode === "public" && (config.environment !== "production" || readiness.publicPaymentAllowed)) {
    try {
      paymentProcessor = config.environment === "production"
        ? await createOkxAgentPaymentProcessorFromEnv(options.env ?? process.env, { mcpPath })
        : options.paymentProcessor ?? await createOkxAgentPaymentProcessorFromEnv(options.env ?? process.env, { mcpPath });
      if (config.environment === "production" && !paymentProcessor) {
        readiness = withReadinessError(readiness, "payment processor: exact production x402 processor was not created");
      }
    } catch {
      if (config.environment === "production") {
        readiness = withReadinessError(readiness, "payment processor: initialization failed");
      } else {
        throw new Error("AgentPay payment processor initialization failed.");
      }
    }
  }
  const server = createServer((request, response) => {
    void handleAgentPayHttpRequest({
      request,
      response,
      runtime,
      config: gatedConfig,
      mode,
      consumerAuth,
      sessionApi,
      oauthApi,
      legacySiweSessionApiEnabled,
      createRuntime,
      mcpPath,
      healthPath,
      readinessPath,
      readiness,
      refreshReadiness,
      paymentProcessor,
      paidExecutionLifecycle: paidExecutionLifecycle!,
      paidExecutionChallenge,
      invoiceExecutionOutbox,
      canaryLedger,
      canaryPolicy,
      createServer:
        options.createServer ??
        ((runtime, tenantContext) =>
          createAgentPayMcpServer(runtime, undefined, {
            sessionContext: tenantContext,
            publicExecutionOnly: mode === "public",
          })),
      createTransport: options.createTransport ?? createStatelessTransport,
    });
  });

  server.listen(port, hostname);
  await once(server, "listening");

  // Recover any persisted broadcast/receipt work from the previous process
  // after listening. This never creates a new transaction and must not block
  // readiness or the first request on a slow RPC.
  if (runtime?.reconcileInvoiceExecutions) {
    void runtime.reconcileInvoiceExecutions().catch(() => {
      if (config.environment === "production") {
        readiness = withReadinessError(readiness, "invoice execution reconciler: startup recovery failed");
      }
    });
  }

  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${hostname}:${resolvedPort}`;

  return {
    url: baseUrl,
    mcpUrl: `${baseUrl}${mcpPath}`,
    healthUrl: `${baseUrl}${healthPath}`,
    readinessUrl: `${baseUrl}${readinessPath}`,
    async close() {
      await closeServer(server);
    },
  };
}

interface HandleAgentPayHttpRequestOptions {
  request: IncomingMessage;
  response: ServerResponse;
  runtime?: AgentPayRuntime;
  config: AgentPayRuntimeConfig;
  mode: "public" | "consumer";
  consumerAuth?: ConsumerSessionAuthenticator;
  sessionApi?: ConsumerSessionApi;
  oauthApi?: ConsumerOAuthApi;
  legacySiweSessionApiEnabled: boolean;
  createRuntime: (config: AgentPayRuntimeConfig, tenantContext?: SessionContext) => AgentPayRuntime;
  mcpPath: string;
  healthPath: string;
  readinessPath: string;
  readiness: ProductionReadinessResult;
  refreshReadiness?: (current: ProductionReadinessResult) => Promise<ProductionReadinessResult>;
  paymentProcessor?: AgentPayMcpPaymentProcessor;
  paidExecutionLifecycle: PaidExecutionLifecycleStore;
  paidExecutionChallenge?: PaidExecutionChallengeStore;
  invoiceExecutionOutbox?: InvoiceExecutionOutboxStore;
  canaryLedger?: CanaryLedgerStore;
  canaryPolicy?: CanaryPolicy;
  createServer: (runtime: AgentPayRuntime, tenantContext?: SessionContext) => ConnectableAgentPayMcpServer;
  createTransport: () => StreamableHTTPServerTransport;
}

async function handleAgentPayHttpRequest(options: HandleAgentPayHttpRequestOptions): Promise<void> {
  setCorsHeaders(options.response, options.mode);
  const pathname = getRequestPathname(options.request);

  if (options.request.method === "OPTIONS") {
    options.response.writeHead(204).end();
    return;
  }

  if (pathname === options.healthPath && options.request.method === "GET") {
    writeJson(options.response, 200, {
      ok: true,
      service: "agentpay-a2mcp",
      transport: "streamable-http",
    });
    return;
  }

  let currentReadiness = options.readiness;
  if (
    options.refreshReadiness &&
    currentReadiness.identityFingerprint &&
    ((pathname === options.readinessPath && options.request.method === "GET") ||
      (options.mode === "public" && pathname === options.mcpPath))
  ) {
    currentReadiness = await options.refreshReadiness(currentReadiness);
  }

  if (pathname === options.readinessPath && options.request.method === "GET") {
    writeJson(options.response, currentReadiness.ready ? 200 : 503, {
      ok: currentReadiness.ready,
      code: currentReadiness.ready ? "READY" : "PRODUCTION_NOT_READY",
      mode: currentReadiness.mode,
      status: currentReadiness.status,
      checks: currentReadiness.checks,
    });
    return;
  }

  if (options.mode === "consumer" && options.oauthApi && isConsumerOAuthPath(pathname)) {
    if (requestContentLengthExceeds(options.request, 16_384)) {
      writeJson(options.response, 413, { error: "Request body too large." }, { "cache-control": "no-store" });
      return;
    }
    const headers = toWebHeaders(options.request.headers);
    headers.set("x-agentpay-oauth-client", consumerOAuthRateLimitKey(options.request));
    const preflightRequest = new Request(createRequestUrl(options.request), {
      method: options.request.method,
      headers,
    });
    if (options.oauthApi.preflight) {
      try {
        const preflightResponse = await options.oauthApi.preflight(preflightRequest);
        if (preflightResponse) {
          options.response.writeHead(preflightResponse.status, Object.fromEntries(preflightResponse.headers.entries()));
          options.response.end(Buffer.from(await preflightResponse.arrayBuffer()));
          return;
        }
      } catch {
        writeJson(options.response, 503, { error: "Authorization service unavailable." }, { "cache-control": "no-store" });
        return;
      }
    }
    let body: Buffer;
    try {
      body = await readRequestBody(options.request, 16_384);
    } catch {
      writeJson(options.response, 413, { error: "Request body too large." }, { "cache-control": "no-store" });
      return;
    }
    const oauthRequest = new Request(createRequestUrl(options.request), {
      method: options.request.method,
      headers,
      body: body.length > 0 ? new Uint8Array(body) : undefined,
    });
    try {
      const oauthResponse = await options.oauthApi.handle(oauthRequest, { admitted: Boolean(options.oauthApi.preflight) });
      options.response.writeHead(oauthResponse.status, Object.fromEntries(oauthResponse.headers.entries()));
      options.response.end(Buffer.from(await oauthResponse.arrayBuffer()));
    } catch {
      writeJson(options.response, 503, { error: "Authorization service unavailable." }, { "cache-control": "no-store" });
    }
    return;
  }

  if (options.mode === "consumer" && options.legacySiweSessionApiEnabled && options.sessionApi && pathname.startsWith("/auth/siwe/")) {
    let body: Buffer;
    try {
      body = await readRequestBody(options.request);
    } catch {
      writeJson(options.response, 413, { error: "Request body too large." });
      return;
    }
    const sessionRequest = new Request(createRequestUrl(options.request), {
      method: options.request.method,
      headers: toWebHeaders(options.request.headers),
      body: body.length > 0 ? new Uint8Array(body) : undefined,
    });
    try {
      const sessionResponse = await options.sessionApi.handle(sessionRequest);
      options.response.writeHead(sessionResponse.status, Object.fromEntries(sessionResponse.headers.entries()));
      options.response.end(Buffer.from(await sessionResponse.arrayBuffer()));
    } catch {
      writeJson(options.response, 500, { error: "Session service unavailable." });
    }
    return;
  }

  if (pathname !== options.mcpPath) {
    writeJson(options.response, 404, { error: "Not found" });
    return;
  }

  if (options.mode === "public" && options.config.environment === "production" && !currentReadiness.executionAllowed) {
    writeJson(options.response, 503, {
      error: "Production execution unavailable.",
      code: "PRODUCTION_NOT_READY",
    });
    return;
  }

  let requestRuntime = options.runtime;
  let tenantContext: SessionContext | undefined;
  const stripAuthorization = options.mode === "consumer";
  if (options.mode === "consumer") {
    try {
      tenantContext = await authenticateConsumerRequest(
        {
          ...options.request.headers,
          query: getRequestQuery(options.request),
        },
        options.consumerAuth as ConsumerSessionAuthenticator,
      );
      if (
        tenantContext.audience !== AGENTPAY_CONSUMER_URI ||
        (options.config.environment && tenantContext.environment !== options.config.environment)
      ) {
        throw new AgentPayAuthError("AUTH_CONTEXT_INVALID", "Consumer session context does not match this endpoint.");
      }
      requestRuntime = options.createRuntime(options.config, tenantContext);
    } catch {
      writeJson(options.response, 401, { error: "Consumer authentication required." }, {
        "cache-control": "no-store",
        "www-authenticate": options.oauthApi
          ? `Bearer resource_metadata="${consumerAuthorizationServer}${consumerResourceMetadataPath}"`
          : "Bearer",
      });
      return;
    }
  }

  if (!requestRuntime) {
    writeJson(options.response, 500, { error: "AgentPay runtime unavailable." });
    return;
  }

  if (options.request.method !== "POST") {
    if (options.paymentProcessor && isGenericPaymentProbe(options.request)) {
      let paymentResult;
      try {
        paymentResult = await options.paymentProcessor.processHTTPRequest(
          createPaymentRequestContext(options.request, pathname),
        );
      } catch {
        writeJson(options.response, 503, { error: "Payment processor unavailable.", code: "PAYMENT_PROCESSOR_UNAVAILABLE" });
        return;
      }

      if (paymentResult.type === "payment-error") {
        writeHttpInstruction(options.response, paymentResult.response);
        return;
      }
    }

    writeJson(options.response, 405, {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
    return;
  }

  let requestBody: Buffer;
  try {
    requestBody = await readRequestBody(options.request);
  } catch {
    writeJson(options.response, 413, { error: "Request body too large." });
    return;
  }
  const requestClassification = classifyPublicPostRequest(requestBody);
  if (options.mode === "public" && requestClassification.kind === "invalid") {
    writeJson(options.response, requestClassification.status, {
      error: requestClassification.message,
      code: requestClassification.code,
    });
    return;
  }
  if (options.mode === "public" && requestClassification.kind === "paid" && !options.paidExecutionLifecycle) {
    writeJson(options.response, 503, {
      error: "Durable paid lifecycle is unavailable.",
      code: "PAID_LIFECYCLE_UNAVAILABLE",
    });
    return;
  }
  if (options.mode === "public" && requestClassification.kind === "paid" && !options.paymentProcessor) {
    // A paid request must never fall through to the MCP handler when the
    // facilitator is absent.  This is deliberately enforced for staging too;
    // only an explicit free JSON-RPC method may bypass x402.
    writeJson(options.response, 503, {
      error: "Paid payment processor unavailable.",
      code: "PAID_PROCESSOR_UNAVAILABLE",
    });
    return;
  }
  const shouldProcessPayment = requestClassification.kind === "paid";
  if (
    options.mode === "public" &&
    options.config.environment === "production" &&
    !isFreeMcpRequest(requestBody) &&
    !options.paymentProcessor
  ) {
    writeJson(options.response, 503, {
      error: "Production payment processor unavailable.",
      code: "PRODUCTION_PAYMENT_UNAVAILABLE",
    });
    return;
  }

  let paidExecutionBinding: PaidExecutionRequestBinding | undefined;
  let paidPreflight: PaymentPreflightResult | undefined;
  if (options.mode === "public" && shouldProcessPayment && requestClassification.kind === "paid") {
    try {
      paidExecutionBinding = parsePaidExecutionRequest(requestBody);
    } catch (error) {
      if (error instanceof PaidExecutionRequestError) {
        writeJson(options.response, 400, { error: error.message, code: error.code });
      } else {
        writeJson(options.response, 400, { error: "Paid request is invalid.", code: "PAID_REQUEST_INVALID" });
      }
      return;
    }
    if (!requestRuntime.preflightPayment) {
      writeJson(options.response, 503, {
        error: "Paid execution preflight unavailable.",
        code: "PAID_PREFLIGHT_UNAVAILABLE",
      });
      return;
    }
    try {
      paidPreflight = await requestRuntime.preflightPayment(paidExecutionBinding.input);
    } catch {
      writeJson(options.response, 422, {
        error: "Paid execution preflight failed.",
        code: "PAID_PREFLIGHT_FAILED",
      });
      return;
    }
    if (options.config.executionMode === "CANARY") {
      const canaryAdmission = await admitCanaryBeforeChallenge({
        config: options.config,
        request: options.request,
        intent: paidPreflight.intent,
        ledger: options.canaryLedger,
        policy: options.canaryPolicy,
        at: new Date().toISOString(),
      });
      if (!canaryAdmission.ok) {
        writeJson(options.response, canaryAdmission.status, {
          error: canaryAdmission.message,
          code: canaryAdmission.code,
        });
        return;
      }
    }
  }
  const paymentContext = createPaymentRequestContext(options.request, pathname);
  let paymentResult;
  try {
    paymentResult = options.mode === "public" && shouldProcessPayment && options.paymentProcessor
      ? await options.paymentProcessor.processHTTPRequest(paymentContext)
      : { type: "no-payment-required" as const };
  } catch {
    writeJson(options.response, 503, { error: "Payment processor unavailable.", code: "PAYMENT_PROCESSOR_UNAVAILABLE" });
    return;
  }

  if (options.mode === "public" && requestClassification.kind === "paid" && paymentResult.type === "no-payment-required") {
    writeJson(options.response, 503, {
      error: "Paid payment processor returned no payment proof.",
      code: "PAID_PROCESSOR_PROTOCOL_ERROR",
    });
    return;
  }

  if (paymentResult.type === "payment-error") {
    if (
      options.config.executionMode === "CANARY" &&
      requestClassification.kind === "paid" &&
      hasPaymentProofHeader(options.request)
    ) {
      const policy = options.canaryPolicy;
      const ledger = options.canaryLedger;
      if (!policy || !ledger || !paidPreflight) {
        writeJson(options.response, 503, {
          error: "Canary admission is unavailable.",
          code: "CANARY_ADMISSION_UNAVAILABLE",
        });
        return;
      }
      try {
        const usage = await ledger.snapshot({
          environment: options.config.environment ?? "staging",
          tenantId: policy.allowlist.tenantId,
          at: new Date().toISOString(),
        });
        assertCanaryUsageWithinCaps(paidPreflight.intent, usage, policy.caps ?? DEFAULT_CANARY_CAPS);
      } catch (error) {
        if (error instanceof CanaryPolicyError) {
          writeJson(options.response, 409, { error: error.message, code: error.code });
        } else {
          writeJson(options.response, 503, {
            error: "Canary admission is unavailable.",
            code: "CANARY_ADMISSION_UNAVAILABLE",
          });
        }
        return;
      }
    }
    if (requestClassification.kind === "paid" && paidExecutionBinding && paidPreflight && paidPreflight.intent.tenantId && options.paidExecutionChallenge) {
      const challengeRequirements = decodePaymentRequiredRequirements(paymentResult.response.headers);
      if (challengeRequirements) {
        if (options.config.executionMode === "CANARY") {
          try {
            assertCanaryPaymentRequirements(challengeRequirements);
          } catch (error) {
            if (error instanceof CanaryPolicyError) {
              writeJson(options.response, 409, { error: error.message, code: error.code });
              return;
            }
            writeJson(options.response, 503, { error: "Canary payment terms are unavailable.", code: "CANARY_PAYMENT_INVALID" });
            return;
          }
        }
        const authorizationHash = hashPaymentAuthorization(createPaymentAuthorizationForLifecycle(paidPreflight));
        const offeredAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + challengeRequirements.maxTimeoutSeconds * 1000).toISOString();
        try {
          await options.paidExecutionChallenge.offer({
            id: randomUUID(),
            tenantId: paidPreflight.intent.tenantId!,
            environment: options.config.environment ?? "staging",
            paymentIntentId: paidPreflight.intent.id,
            ownerAddress: paidPreflight.intent.ownerAddress,
            accountAddress: paidPreflight.intent.accountAddress,
            requestHash: paidExecutionBinding.requestHash,
            argumentsHash: paidExecutionBinding.argumentsHash,
            authorizationHash,
            feeTermsHash: hashCanonicalJson({
              network: challengeRequirements.network,
              asset: challengeRequirements.asset,
              amount: challengeRequirements.amount,
              payTo: challengeRequirements.payTo,
            }),
            paymentRequirementsHash: hashCanonicalJson(challengeRequirements),
            offeredAt,
            expiresAt,
          });
        } catch {
          writeJson(options.response, 503, { error: "Paid challenge ledger unavailable.", code: "PAID_CHALLENGE_UNAVAILABLE" });
          return;
        }
      } else if (options.config.environment === "production") {
        writeJson(options.response, 503, { error: "Paid challenge is not persistable.", code: "PAID_CHALLENGE_INVALID" });
        return;
      }
    }
    writeHttpInstruction(options.response, paymentResult.response);
    return;
  }

  if (paymentResult.type === "payment-verified") {
    if (!paidExecutionBinding || !paidPreflight) {
      writeJson(options.response, 400, {
        error: "The public paid surface accepts only a preflighted execute_payment request.",
        code: "PAID_TOOL_NOT_ALLOWED",
      });
      return;
    }

    const payer = extractPaymentPayer(paymentResult.paymentPayload);
    if (!payer) {
      writeJson(options.response, 503, {
        error: "Verified payment proof does not identify a payer.",
        code: "PAID_PAYER_UNBOUND",
      });
      return;
    }
    if (options.config.executionMode === "CANARY") {
      try {
        assertCanaryPaymentRequirements(paymentResult.paymentRequirements);
      } catch (error) {
        if (error instanceof CanaryPolicyError) {
          writeJson(options.response, 409, { error: error.message, code: error.code });
        } else {
          writeJson(options.response, 503, { error: "Canary payment terms are unavailable.", code: "CANARY_PAYMENT_INVALID" });
        }
        return;
      }
    }

    if (options.config.executionMode === "CANARY") {
      if (!options.canaryLedger || !options.canaryPolicy) {
        writeJson(options.response, 503, {
          error: "Canary admission is unavailable; the durable ledger and allowlist are required.",
          code: "CANARY_ADMISSION_UNAVAILABLE",
        });
        return;
      }
      try {
        assertCanaryRequestShapeAllowed(
          paidPreflight.intent,
          options.canaryPolicy.allowlist,
          payer,
          options.canaryPolicy.caps ?? DEFAULT_CANARY_CAPS,
          new Date(),
        );
      } catch (error) {
        if (error instanceof CanaryPolicyError) {
          writeJson(options.response, 409, { error: error.message, code: error.code });
          return;
        }
        writeJson(options.response, 503, {
          error: "Canary admission unavailable.",
          code: "CANARY_ADMISSION_UNAVAILABLE",
        });
        return;
      }
    }

    let challengeId: string | undefined;
    if (options.paidExecutionChallenge && paidPreflight.intent.tenantId) {
      const authorizationHash = hashPaymentAuthorization(createPaymentAuthorizationForLifecycle(paidPreflight));
      try {
        const consumed = await options.paidExecutionChallenge.consume({
            tenantId: paidPreflight.intent.tenantId,
          requestHash: paidExecutionBinding.requestHash,
          argumentsHash: paidExecutionBinding.argumentsHash,
          authorizationHash,
          paymentRequirementsHash: hashCanonicalJson(paymentResult.paymentRequirements),
          at: new Date().toISOString(),
        });
        challengeId = consumed?.id;
        if (!consumed && options.config.environment === "production") {
          writeJson(options.response, 409, {
            error: "Payment challenge was not offered by this ASP instance.",
            code: "PAID_CHALLENGE_NOT_FOUND",
          });
          return;
        }
      } catch {
        writeJson(options.response, 503, { error: "Paid challenge ledger unavailable.", code: "PAID_CHALLENGE_UNAVAILABLE" });
        return;
      }
    }

    const lifecycleInput = createPaidExecutionLifecycleClaimInput({
      lifecycleId: randomUUID(),
      tenantId: paidPreflight.intent.tenantId,
      binding: paidExecutionBinding,
      paymentPayload: paymentResult.paymentPayload,
      paymentRequirements: paymentResult.paymentRequirements,
      authorizationHash: paidPreflight.intent.tenantId
        ? hashPaymentAuthorization(
            // Preflight already verified this exact typed data; hashing it here
            // binds retries without persisting the reusable signature.
            createPaymentAuthorizationForLifecycle(paidPreflight),
          )
        : undefined,
      challengeId,
      environment: options.config.environment,
      payer,
      createdAt: new Date().toISOString(),
    });
    let lifecycleClaim;
    try {
      lifecycleClaim = await options.paidExecutionLifecycle.claim(lifecycleInput);
    } catch {
      writeJson(options.response, 503, { error: "Paid lifecycle unavailable.", code: "PAID_LIFECYCLE_UNAVAILABLE" });
      return;
    }
    if (lifecycleClaim.disposition === "CONFLICT") {
      writeJson(options.response, 409, { error: "Paid request binding conflicts with an existing payment.", code: "PAID_LIFECYCLE_CONFLICT" });
      return;
    }
    if (lifecycleClaim.disposition === "REPLAY") {
      if (lifecycleClaim.record.status === "COMPLETED" && lifecycleClaim.record.responseBodyBase64) {
        replayPaidLifecycleResponse(options.response, lifecycleClaim.record);
        return;
      }
      if (lifecycleClaim.record.status === "FAILED") {
        replayPaidLifecycleFailure(options.response, lifecycleClaim.record);
        return;
      }
      writeJson(options.response, 409, {
        error: "Paid request is already being processed.",
        code: "PAID_LIFECYCLE_IN_PROGRESS",
      });
      return;
    }

    const lifecycleId = lifecycleClaim.record.id;
    let canaryReservation: CanaryReservationContext | undefined;
    const now = () => new Date().toISOString();
    // Reserve the execution outbox while the fee is still uncharged. This
    // closes the SETTLED -> QUEUED crash window: a process dying after fee
    // settlement cannot leave an invoice with no durable execution record.
    // The lifecycle id is already a UUID, so reusing it keeps the Supabase
    // outbox primary key and lifecycle foreign key deterministic and valid.
    const durableExecution = createDurableExecutionContext({
      lifecycleId,
      paymentIntentId: paidPreflight.intent.id,
      tenantId: paidPreflight.intent.tenantId,
      ownerAuthorizationNonce: paidPreflight.intent.nonce,
      executorAddress: requestRuntime.executorAddress,
      rawTxEncryptionKey: options.config.rawTxEncryptionKey,
      outbox: options.invoiceExecutionOutbox,
      lifecycle: options.paidExecutionLifecycle,
      now,
    });
    const durableExecutorReady = Boolean(durableExecution && requestRuntime.executePaymentWithContext);
    if (options.config.environment === "production" && !durableExecutorReady) {
      await markLifecycleFailureFallback(
        options.paidExecutionLifecycle,
        lifecycleId,
        "DURABLE_EXECUTOR_UNAVAILABLE",
        "Production paid execution requires an outbox-aware sign-before-broadcast executor.",
        now(),
      );
      writeJson(options.response, 503, { error: "Durable paid executor unavailable.", code: "PAID_EXECUTOR_UNAVAILABLE" });
      return;
    }
    if (options.config.executionMode === "CANARY") {
      const policy = options.canaryPolicy;
      const ledger = options.canaryLedger;
      if (!policy || !ledger || !paidPreflight.intent.tenantId) {
        await markLifecycleFailureFallback(
          options.paidExecutionLifecycle,
          lifecycleId,
          "CANARY_ADMISSION_UNAVAILABLE",
          "Canary execution requires a durable ledger, allowlist, and tenant-bound intent.",
          now(),
        );
        writeJson(options.response, 503, {
          error: "Canary admission is unavailable.",
          code: "CANARY_ADMISSION_UNAVAILABLE",
        });
        return;
      }
      try {
        const reservation = await ledger.reserve({
          environment: options.config.environment ?? "staging",
          reservationKey: lifecycleId,
          lifecycleId,
          tenantId: paidPreflight.intent.tenantId,
          paymentIntentId: paidPreflight.intent.id,
          amount: paidPreflight.intent.amountOut,
          at: now(),
          caps: policy.caps ?? DEFAULT_CANARY_CAPS,
        });
        canaryReservation = {
          ledger,
          environment: options.config.environment ?? "staging",
          reservationKey: lifecycleId,
          tenantId: paidPreflight.intent.tenantId,
        };
        // REPLAY is safe here: the lifecycle claim above is the stronger
        // replay fence and the ledger RPC never consumes another slot.
        void reservation;
      } catch (error) {
        await markLifecycleFailureFallback(
          options.paidExecutionLifecycle,
          lifecycleId,
          error instanceof CanaryPolicyError ? error.code : "CANARY_LEDGER_UNAVAILABLE",
          error instanceof Error ? error.message : "Canary reservation failed.",
          now(),
        );
        if (error instanceof CanaryPolicyError) {
          writeJson(options.response, 409, { error: error.message, code: error.code });
        } else {
          writeJson(options.response, 503, {
            error: "Canary admission is unavailable.",
            code: "CANARY_ADMISSION_UNAVAILABLE",
          });
        }
        return;
      }
    }
    if (durableExecutorReady && durableExecution) {
      try {
        const reservation = await durableExecution.outbox.enqueue({
          id: durableExecution.outboxId,
          tenantId: durableExecution.tenantId,
          lifecycleId: durableExecution.lifecycleId,
          paymentIntentId: durableExecution.paymentIntentId,
          chainId: paidPreflight.intent.sourceChainId,
          executorAddress: durableExecution.executorAddress,
          createdAt: now(),
        });
        if (
          reservation.disposition === "CONFLICT" ||
          (reservation.disposition === "REPLAY" && reservation.record.status !== "QUEUED")
        ) {
          throw new Error("Execution outbox reservation is already bound to a different or terminal record.");
        }
      } catch {
        await markReservedInvoiceManualReview(
          durableExecution,
          "EXECUTION_RESERVATION_FAILED",
          "Execution outbox reservation failed before fee settlement; manual review is required.",
          now(),
        );
        await markLifecycleFailureFallback(
          options.paidExecutionLifecycle,
          lifecycleId,
          "EXECUTION_RESERVATION_FAILED",
          "Paid execution could not reserve its durable outbox before settlement.",
          now(),
        );
        await completeCanaryReservation(canaryReservation, now());
        writeJson(options.response, 503, { error: "Paid execution unavailable.", code: "PAID_EXECUTION_UNAVAILABLE" });
        return;
      }
    }
    try {
      await options.paidExecutionLifecycle.markSettling(lifecycleId, now());
    } catch {
      await markReservedInvoiceManualReview(
        durableExecution,
        "SETTLEMENT_LIFECYCLE_PERSISTENCE_UNKNOWN",
        "Paid lifecycle could not be advanced to settlement after outbox reservation; manual review is required.",
        now(),
      );
      await markLifecycleFailureFallback(
        options.paidExecutionLifecycle,
        lifecycleId,
        "SETTLEMENT_LIFECYCLE_PERSISTENCE_UNKNOWN",
        "Paid lifecycle claim could not be advanced to settlement; reconciliation is required.",
        now(),
      );
      await completeCanaryReservation(canaryReservation, now());
      writeJson(options.response, 503, { error: "Paid lifecycle unavailable.", code: "PAID_LIFECYCLE_UNAVAILABLE" });
      return;
    }
    let settlement;
    try {
      settlement = await options.paymentProcessor?.processSettlement(
        paymentResult.paymentPayload,
        paymentResult.paymentRequirements,
        paymentResult.declaredExtensions,
        createPaymentTransportContext(paymentContext),
      );
    } catch {
      await markReservedInvoiceManualReview(
        durableExecution,
        "SETTLEMENT_UNKNOWN",
        "Settlement outcome is unknown and no invoice transaction was signed; manual review is required.",
        now(),
      );
      await markLifecycleSettlementUnknown(
        options.paidExecutionLifecycle,
        lifecycleId,
        "SETTLEMENT_UNKNOWN",
        "Settlement outcome is unknown; reconciliation is required before retry.",
        now(),
      );
      writeJson(options.response, 503, { error: "Payment settlement unavailable.", code: "PAYMENT_SETTLEMENT_UNAVAILABLE" });
      return;
    }

    if (!settlement?.success) {
      await markReservedInvoiceManualReview(
        durableExecution,
        "SETTLEMENT_REJECTED",
        settlement?.errorReason ?? "Payment settlement was rejected before invoice execution.",
        now(),
      );
      await markLifecycleSettlementRejected(
        options.paidExecutionLifecycle,
        lifecycleId,
        "SETTLEMENT_REJECTED",
        settlement?.errorReason ?? "Payment settlement was rejected.",
        now(),
      );
      await completeCanaryReservation(canaryReservation, now());
      writeHttpInstruction(
        options.response,
        settlement?.response ?? {
          status: 402,
          headers: { "content-type": "application/json" },
          body: { error: "Payment settlement failed." },
        },
      );
      return;
    }

    if (
      !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction) ||
      settlement.network !== paymentResult.paymentRequirements.network ||
      hashCanonicalJson(settlement.requirements) !== hashCanonicalJson(paymentResult.paymentRequirements)
    ) {
      await markReservedInvoiceManualReview(
        durableExecution,
        "SETTLEMENT_RESPONSE_INVALID",
        "Facilitator returned a settlement reference that does not match the accepted payment requirements.",
        now(),
      );
      await markLifecycleSettlementUnknown(
        options.paidExecutionLifecycle,
        lifecycleId,
        "SETTLEMENT_RESPONSE_INVALID",
        "Facilitator returned a settlement reference that does not match the accepted payment requirements.",
        now(),
      );
      writeJson(options.response, 503, { error: "Payment settlement response invalid.", code: "PAYMENT_SETTLEMENT_INVALID" });
      return;
    }

    try {
      await options.paidExecutionLifecycle.markSettled(lifecycleId, {
        transaction: settlement.transaction,
        headers: settlement.headers,
        at: now(),
      });
    } catch {
      await markReservedInvoiceManualReview(
        durableExecution,
        "LIFECYCLE_PERSISTENCE_UNKNOWN",
        "Settlement succeeded but lifecycle persistence is unknown; manual review is required.",
        now(),
      );
      await markLifecycleSettlementUnknown(
        options.paidExecutionLifecycle,
        lifecycleId,
        "LIFECYCLE_PERSISTENCE_UNKNOWN",
        "Settlement succeeded but lifecycle persistence is unknown; reconciliation is required.",
        now(),
      );
      writeJson(options.response, 503, { error: "Paid lifecycle unavailable.", code: "PAID_LIFECYCLE_UNAVAILABLE" });
      return;
    }
    try {
      await options.paidExecutionLifecycle.markExecuting(lifecycleId, now());
    } catch {
      await markReservedInvoiceManualReview(
        durableExecution,
        "EXECUTION_QUEUE_UNKNOWN",
        "Fee settlement is confirmed but execution queue persistence is unknown; manual review is required.",
        now(),
      );
      await markLifecycleExecutionFailure(
        options.paidExecutionLifecycle,
        lifecycleId,
        "EXECUTION_QUEUE_UNKNOWN",
        "Fee settlement is confirmed but invoice queue persistence is unknown; reconciliation is required.",
        now(),
      );
      writeJson(options.response, 503, { error: "Paid lifecycle unavailable.", code: "PAID_LIFECYCLE_UNAVAILABLE" });
      return;
    }

    const bufferedResponse = new BufferedServerResponse();

    await serveMcpRequest({
      request: options.request,
      requestBody,
      response: bufferedResponse as unknown as ServerResponse,
      runtime: durableExecutorReady && durableExecution
        ? withDurableExecutionContext(requestRuntime, durableExecution)
        : requestRuntime,
      createServer: options.createServer,
      createTransport: options.createTransport,
      stripAuthorization,
      tenantContext: options.mode === "consumer" ? tenantContext : undefined,
    });

    const finalHeaders = { ...bufferedResponse.headers, ...settlement.headers };
    if (bufferedResponse.statusCode >= 400 || hasMcpExecutionError(bufferedResponse.body)) {
      if (hasAmbiguousMcpExecutionError(bufferedResponse.body)) {
        await markLifecycleExecutionPersistenceUnknown(
          options.paidExecutionLifecycle,
          lifecycleId,
          "DURABLE_EXECUTION_AMBIGUOUS",
          "Transaction broadcast outcome or execution persistence is unknown; reconciliation/manual review is required.",
          now(),
        );
      } else {
        await markReservedInvoiceManualReview(
          durableExecution,
          "EXECUTION_FAILED",
          "Invoice execution failed before a durable broadcast outcome was recorded; manual review is required.",
          now(),
        );
        await markLifecycleExecutionFailure(
          options.paidExecutionLifecycle,
          lifecycleId,
          "EXECUTION_FAILED",
          "AgentPay execution failed after fee settlement; refund/manual review is required.",
          now(),
        );
        await completeCanaryReservation(canaryReservation, now());
      }
      bufferedResponse.flushTo(options.response, settlement.headers);
      return;
    }
    try {
      await options.paidExecutionLifecycle.markCompleted(
        lifecycleId,
        { status: bufferedResponse.statusCode, headers: finalHeaders, body: bufferedResponse.body },
        now(),
      );
    } catch {
      await markLifecycleExecutionPersistenceUnknown(
        options.paidExecutionLifecycle,
        lifecycleId,
        "RESULT_PERSISTENCE_UNKNOWN",
        "Invoice execution result persistence is unknown; reconciliation/manual review is required.",
        now(),
      );
      writeJson(options.response, 503, { error: "Paid lifecycle unavailable.", code: "PAID_LIFECYCLE_UNAVAILABLE" });
      return;
    }
    await completeCanaryReservation(canaryReservation, now());
    bufferedResponse.flushTo(options.response, settlement.headers);
    return;
  }

  await serveMcpRequest({
    request: options.request,
    requestBody,
    response: options.response,
    runtime: requestRuntime,
    createServer: options.createServer,
    createTransport: options.createTransport,
    stripAuthorization,
    tenantContext: options.mode === "consumer" ? tenantContext : undefined,
  });
}

interface ServeMcpRequestOptions {
  request: IncomingMessage;
  requestBody: Buffer;
  response: ServerResponse;
  runtime: AgentPayRuntime;
  createServer: (runtime: AgentPayRuntime, tenantContext?: SessionContext) => ConnectableAgentPayMcpServer;
  createTransport: () => StreamableHTTPServerTransport;
  stripAuthorization?: boolean;
  tenantContext?: SessionContext;
}

async function serveMcpRequest(options: ServeMcpRequestOptions): Promise<void> {
  const mcpServer = options.createServer(options.runtime, options.tenantContext);
  const transport = options.createTransport();

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(
      createReplayableRequest(options.request, options.requestBody, options.stripAuthorization),
      options.response,
      parseJsonBody(options.requestBody),
    );
  } catch {
    if (!options.response.headersSent) {
      writeJson(options.response, 500, {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error.",
        },
        id: null,
      });
    }
  } finally {
    await Promise.allSettled([transport.close(), mcpServer.close()]);
  }
}

function isGenericPaymentProbe(request: IncomingMessage): boolean {
  if (request.method !== "GET") {
    return false;
  }

  const accept = String(request.headers.accept ?? "");
  return !accept.toLowerCase().includes("text/event-stream");
}

async function readRequestBody(request: IncomingMessage, maxBodyBytes = 1_048_576): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = toBuffer(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new AgentPayAuthError("REQUEST_BODY_TOO_LARGE", "Request body exceeds the maximum size.");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function requestContentLengthExceeds(request: IncomingMessage, maxBodyBytes: number): boolean {
  const header = request.headers["content-length"];
  const value = Array.isArray(header) ? header[0] : header;
  const length = Number(value ?? "0");
  return Number.isFinite(length) && length > maxBodyBytes;
}

function createReplayableRequest(request: IncomingMessage, body: Buffer, stripAuthorization = false): IncomingMessage {
  const replay = new PassThrough();
  const headers = { ...request.headers };
  const rawHeaders = [...request.rawHeaders];
  if (stripAuthorization) {
    delete headers.authorization;
    for (let index = rawHeaders.length - 2; index >= 0; index -= 2) {
      if (rawHeaders[index]?.toLowerCase() === "authorization") {
        rawHeaders.splice(index, 2);
      }
    }
  }
  Object.assign(replay, {
    complete: true,
    headers,
    httpVersion: request.httpVersion,
    httpVersionMajor: request.httpVersionMajor,
    httpVersionMinor: request.httpVersionMinor,
    method: request.method,
    rawHeaders,
    rawTrailers: request.rawTrailers,
    url: request.url,
    socket: request.socket,
    trailers: request.trailers,
  });
  replay.end(body);

  return replay as unknown as IncomingMessage;
}

function toWebHeaders(headers: IncomingMessage["headers"]): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  return result;
}

function isFreeMcpRequest(body: Buffer): boolean {
  const classification = classifyPublicPostRequest(body);
  return classification.kind === "free";
}

type PublicPostRequestClassification =
  | { kind: "free" }
  | { kind: "paid" }
  | { kind: "invalid"; status: 400; code: "PAID_REQUEST_INVALID" | "PAID_TOOL_NOT_ALLOWED"; message: string };

function classifyPublicPostRequest(body: Buffer): PublicPostRequestClassification {
  const parsed = parseJsonBody(body);
  if (!isRecordValue(parsed)) {
    return {
      kind: "invalid",
      status: 400,
      code: "PAID_REQUEST_INVALID",
      message: "Public MCP requests must contain one JSON-RPC object.",
    };
  }
  if (typeof parsed.method !== "string") {
    return {
      kind: "invalid",
      status: 400,
      code: "PAID_REQUEST_INVALID",
      message: "Public MCP requests must contain a JSON-RPC method.",
    };
  }
  if (freeJsonRpcMethods.has(parsed.method)) return { kind: "free" };
  if (parsed.method === "tools/call" && isRecordValue(parsed.params) && parsed.params.name === "execute_payment") {
    if (!isJsonRpcRequestId(parsed.id)) {
      return {
        kind: "invalid",
        status: 400,
        code: "PAID_REQUEST_INVALID",
        message: "Paid execute_payment requests require a non-null JSON-RPC id.",
      };
    }
    return { kind: "paid" };
  }
  return {
    kind: "invalid",
    status: 400,
    code: "PAID_TOOL_NOT_ALLOWED",
    message: "The public paid surface accepts only the execute_payment MCP tool.",
  };
}

function isJsonRpcRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function parseJsonRpcMessages(body: Buffer): JsonRpcMessage[] {
  const parsed = parseJsonBody(body);

  if (parsed === undefined) {
    return [];
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];

  return messages.filter(isJsonRpcMessage);
}

function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

interface JsonRpcMessage {
  method?: unknown;
  params?: unknown;
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return typeof value === "object" && value !== null;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFreeJsonRpcMessage(message: JsonRpcMessage): boolean {
  if (typeof message.method !== "string") {
    return false;
  }

  return freeJsonRpcMethods.has(message.method);
}

function createPaymentAuthorizationForLifecycle(preflight: PaymentPreflightResult) {
  if (!preflight.intent.tenantId) {
    throw new Error("Paid lifecycle requires a tenant-bound payment intent.");
  }
  return createPaymentAuthorizationFromIntent(preflight.intent, preflight.intent.tenantId);
}

function createDurableExecutionContext(input: {
  lifecycleId: string;
  paymentIntentId: string;
  tenantId?: string;
  ownerAuthorizationNonce: string;
  executorAddress?: string;
  rawTxEncryptionKey?: string;
  outbox?: InvoiceExecutionOutboxStore;
  lifecycle?: PaidExecutionLifecycleStore;
  now: () => string;
}): DurableExecutionContext | undefined {
  if (!input.tenantId || !input.executorAddress || !input.rawTxEncryptionKey || !input.outbox || !input.lifecycle) return undefined;
  return Object.freeze({
    lifecycleId: input.lifecycleId,
    outboxId: input.lifecycleId,
    tenantId: input.tenantId,
    paymentIntentId: input.paymentIntentId,
    executorAddress: input.executorAddress,
    ownerAuthorizationNonce: input.ownerAuthorizationNonce,
    rawTxEncryptionKey: input.rawTxEncryptionKey,
    outbox: input.outbox,
    lifecycle: input.lifecycle,
    now: input.now,
  });
}

async function markReservedInvoiceManualReview(
  context: DurableExecutionContext | undefined,
  code: string,
  message: string,
  at: string,
): Promise<void> {
  if (!context) return;
  try {
    const record = await context.outbox.get(context.outboxId);
    if (!record || ["CONFIRMED", "REVERTED"].includes(record.status)) return;
    await context.outbox.markManualReview(context.outboxId, code, message, at, record.fencingToken);
  } catch {
    // The lifecycle response remains fail-closed. The reconciler/operator must
    // inspect the durable row if the compensating outbox update also failed.
  }
}

function withDurableExecutionContext(
  runtime: AgentPayRuntime,
  context: DurableExecutionContext,
): AgentPayRuntime {
  if (!runtime.executePaymentWithContext) {
    return runtime;
  }
  return {
    ...runtime,
    executePayment: (input) => runtime.executePaymentWithContext!(input, context),
  };
}

function extractPaymentPayer(paymentPayload: PaymentPayload): string | undefined {
  const payload = paymentPayload.payload;
  if (!isRecordValue(payload)) return undefined;
  const authorization = isRecordValue(payload.authorization) ? payload.authorization : payload;
  const payer = authorization.from ?? authorization.payer ?? authorization.owner;
  return typeof payer === "string" && /^0x[0-9a-fA-F]{40}$/.test(payer) ? payer.toLowerCase() : undefined;
}

function hasMcpExecutionError(body: Buffer): boolean {
  if (body.length === 0) return false;
  const text = body.toString("utf8");
  const candidates: unknown[] = [];

  // Streamable HTTP may return an SSE envelope even when the MCP tool result
  // itself is a normal JSON-RPC object.  Inspect each `data:` frame and the
  // plain JSON body, without treating arbitrary text as an execution failure.
  try {
    candidates.push(JSON.parse(text));
  } catch {
    // Not a plain JSON response; inspect SSE frames below.
  }
  for (const line of text.split(/\r?\n/)) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data || data === "[DONE]") continue;
    try {
      candidates.push(JSON.parse(data));
    } catch {
      // Ignore keep-alive/non-JSON SSE frames.
    }
  }

  return candidates.some((candidate) => {
    if (!isRecordValue(candidate)) return false;
    if (candidate.error !== undefined) return true;
    const result = candidate.result;
    return isRecordValue(result) && result.isError === true;
  });
}

function hasAmbiguousMcpExecutionError(body: Buffer): boolean {
  return body.toString("utf8").includes("DURABLE_EXECUTION_AMBIGUOUS");
}

function decodePaymentRequiredRequirements(headers: Record<string, string>): PaymentRequirements | undefined {
  const header = Object.entries(headers).find(([name]) => name.toLowerCase() === "payment-required")?.[1];
  if (!header) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: unknown };
    const requirements = Array.isArray(decoded.accepts) ? decoded.accepts[0] : undefined;
    if (!isRecordValue(requirements)) return undefined;
    if (
      typeof requirements.scheme !== "string" ||
      typeof requirements.network !== "string" ||
      typeof requirements.asset !== "string" ||
      typeof requirements.amount !== "string" ||
      typeof requirements.payTo !== "string" ||
      typeof requirements.maxTimeoutSeconds !== "number"
    ) return undefined;
    return requirements as unknown as PaymentRequirements;
  } catch {
    return undefined;
  }
}

function createStatelessTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
}

function setCorsHeaders(response: ServerResponse, mode: "public" | "consumer"): void {
  response.setHeader("access-control-allow-origin", mode === "consumer" ? "https://wallet.agentpay.site" : "*");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "content-type, authorization, mcp-session-id, mcp-protocol-version, payment-signature, PAYMENT-SIGNATURE",
  );
  response.setHeader("access-control-expose-headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, WWW-Authenticate");
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, { "content-type": "application/json", ...headers });
  response.end(`${JSON.stringify(body)}\n`);
}

function getRequestPathname(request: IncomingMessage): string {
  const host = request.headers.host ?? "127.0.0.1";
  return new URL(request.url ?? "/", `http://${host}`).pathname;
}

function getRequestQuery(request: IncomingMessage): string {
  const host = request.headers.host ?? "127.0.0.1";
  return new URL(request.url ?? "/", `http://${host}`).search;
}

function consumerOAuthRateLimitKey(request: IncomingMessage): string {
  const remoteAddress = normalizeClientAddress(request.socket.remoteAddress ?? "unknown");
  const realIp = request.headers["x-real-ip"];
  const trustedProxyAddress = Array.isArray(realIp) ? realIp[0] : realIp;
  if (isLoopbackAddress(remoteAddress) && trustedProxyAddress && isIP(trustedProxyAddress.trim()) > 0) {
    return normalizeClientAddress(trustedProxyAddress.trim());
  }
  return remoteAddress;
}

function normalizeClientAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

function isConsumerOAuthPath(pathname: string): boolean {
  return pathname === consumerResourceMetadataPath ||
    pathname === consumerAuthorizationMetadataPath ||
    pathname.startsWith("/oauth/");
}

function createPaymentRequestContext(request: IncomingMessage, path: string): HTTPRequestContext {
  const adapter = createNodeHttpPaymentAdapter(request, path);

  return {
    adapter,
    path,
    method: adapter.getMethod(),
    paymentHeader: adapter.getHeader("PAYMENT-SIGNATURE"),
  };
}

function createNodeHttpPaymentAdapter(request: IncomingMessage, path: string): HTTPAdapter {
  return {
    getHeader(name) {
      const value = request.headers[name.toLowerCase()];

      return Array.isArray(value) ? value.join(", ") : value;
    },
    getMethod() {
      return request.method ?? "GET";
    },
    getPath() {
      return path;
    },
    getUrl() {
      return createRequestUrl(request);
    },
    getAcceptHeader() {
      return this.getHeader("accept") ?? "";
    },
    getUserAgent() {
      return this.getHeader("user-agent") ?? "";
    },
    getQueryParams() {
      return Object.fromEntries(new URL(createRequestUrl(request)).searchParams.entries());
    },
    getQueryParam(name) {
      return new URL(createRequestUrl(request)).searchParams.get(name) ?? undefined;
    },
  };
}

function createRequestUrl(request: IncomingMessage): string {
  const host = getForwardedHeader(request, "x-forwarded-host") ?? request.headers.host ?? "127.0.0.1";
  const proto =
    getForwardedHeader(request, "x-forwarded-proto") ??
    ((request.socket as { encrypted?: boolean }).encrypted ? "https" : "http");

  return `${proto}://${host}${request.url ?? "/"}`;
}

function getForwardedHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  const firstValue = Array.isArray(value) ? value[0] : value;

  return firstValue?.split(",")[0]?.trim();
}

function writeHttpInstruction(response: ServerResponse, instruction: HTTPResponseInstructions): void {
  for (const [name, value] of Object.entries(instruction.headers)) {
    response.setHeader(name, value);
  }

  if (instruction.body === undefined) {
    response.writeHead(instruction.status).end();
    return;
  }

  if (typeof instruction.body === "string") {
    response.writeHead(instruction.status).end(instruction.body);
    return;
  }

  response.writeHead(instruction.status).end(`${JSON.stringify(instruction.body)}\n`);
}

function replayPaidLifecycleResponse(response: ServerResponse, record: PaidExecutionLifecycleRecord): void {
  const body = Buffer.from(record.responseBodyBase64 ?? "", "base64");
  for (const [name, value] of Object.entries(record.responseHeaders ?? {})) {
    response.setHeader(name, value);
  }
  response.writeHead(record.responseStatus ?? 200);
  response.end(body);
}

function replayPaidLifecycleFailure(response: ServerResponse, record: PaidExecutionLifecycleRecord): void {
  const status = record.feeStatus === "SETTLEMENT_REJECTED" ? 402 : 503;
  writeJson(response, status, {
    error: record.errorMessage ?? "Paid lifecycle requires reconciliation.",
    code: record.errorCode ?? "PAID_LIFECYCLE_MANUAL_REVIEW",
    lifecycleId: record.id,
    feeStatus: record.feeStatus,
    executionStatus: record.executionStatus,
    refundStatus: record.refundStatus,
  });
}

async function markLifecycleSettlementUnknown(
  store: PaidExecutionLifecycleStore,
  lifecycleId: string,
  code: string,
  message: string,
  at: string,
): Promise<void> {
  try {
    await store.markSettlementUnknown(lifecycleId, code, message, at);
  } catch {
    await markLifecycleFailureFallback(store, lifecycleId, code, message, at);
  }
}

async function markLifecycleSettlementRejected(
  store: PaidExecutionLifecycleStore,
  lifecycleId: string,
  code: string,
  message: string,
  at: string,
): Promise<void> {
  try {
    await store.markSettlementRejected(lifecycleId, code, message, at);
  } catch {
    await markLifecycleFailureFallback(store, lifecycleId, code, message, at);
  }
}

async function markLifecycleExecutionFailure(
  store: PaidExecutionLifecycleStore,
  lifecycleId: string,
  code: string,
  message: string,
  at: string,
): Promise<void> {
  try {
    // A deterministic MCP failure after fee settlement creates one exact-fee
    // refund obligation. The transition itself also fences execution into
    // manual review, so it is a single durable write.
    await store.markRefundRequired(lifecycleId, `${code}: ${message}`, at);
  } catch {
    await markLifecycleFailureFallback(
      store,
      lifecycleId,
      code,
      `${message} Refund obligation could not be persisted automatically.`,
      at,
    );
  }
}

async function markLifecycleExecutionPersistenceUnknown(
  store: PaidExecutionLifecycleStore,
  lifecycleId: string,
  code: string,
  message: string,
  at: string,
): Promise<void> {
  try {
    // Do not create a refund merely because the result write failed: the
    // invoice may already have been broadcast. Reconciliation must inspect
    // the stored transaction/outbox state first.
    await store.markExecutionPersistenceUnknown(lifecycleId, code, message, at);
  } catch {
    await markLifecycleFailureFallback(store, lifecycleId, code, message, at);
  }
}

async function markLifecycleFailureFallback(
  store: PaidExecutionLifecycleStore,
  lifecycleId: string,
  code: string,
  message: string,
  at: string,
): Promise<void> {
  try {
    await store.markFailed(lifecycleId, code, message, at);
  } catch {
    // The lifecycle store itself is unavailable. The HTTP response remains
    // fail-closed and an operator/reconciler must inspect the durable row.
  }
}

function createPaymentTransportContext(
  request: HTTPRequestContext,
  response?: BufferedServerResponse,
): HTTPTransportContext {
  return {
    request,
    ...(response ? { responseBody: response.body, responseHeaders: response.headers } : {}),
  };
}

class BufferedServerResponse extends EventEmitter {
  statusCode = 200;
  statusMessage = "";
  headersSent = false;
  writable = true;
  writableEnded = false;
  destroyed = false;
  readonly headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];

  get body(): Buffer {
    return Buffer.concat(this.chunks);
  }

  setHeader(name: string, value: number | string | readonly string[]): this {
    this.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  getHeaders(): Record<string, string> {
    return { ...this.headers };
  }

  removeHeader(name: string): void {
    delete this.headers[name.toLowerCase()];
  }

  flushHeaders(): void {
    this.headersSent = true;
  }

  writeHead(statusCode: number, statusMessageOrHeaders?: string | Record<string, number | string | readonly string[]>, headers?: Record<string, number | string | readonly string[]>): this {
    this.statusCode = statusCode;

    if (typeof statusMessageOrHeaders === "string") {
      this.statusMessage = statusMessageOrHeaders;
    } else if (statusMessageOrHeaders) {
      this.setHeaders(statusMessageOrHeaders);
    }

    if (headers) {
      this.setHeaders(headers);
    }

    this.headersSent = true;
    return this;
  }

  write(chunk: unknown, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
    this.headersSent = true;
    this.chunks.push(toBuffer(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : undefined));
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();

    return true;
  }

  end(chunk?: unknown, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void): this {
    if (chunk !== undefined) {
      this.write(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : undefined);
    }

    this.headersSent = true;
    this.writableEnded = true;
    this.emit("finish");
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();

    return this;
  }

  destroy(error?: Error): this {
    this.destroyed = true;

    if (error) {
      this.emit("error", error);
    }

    this.emit("close");
    return this;
  }

  flushTo(response: ServerResponse, extraHeaders: Record<string, string> = {}): void {
    for (const [name, value] of Object.entries({ ...this.headers, ...extraHeaders })) {
      response.setHeader(name, value);
    }

    response.writeHead(this.statusCode);
    response.end(this.body);
  }

  private setHeaders(headers: Record<string, number | string | readonly string[]>): void {
    for (const [name, value] of Object.entries(headers)) {
      this.setHeader(name, value);
    }
  }
}

function toBuffer(chunk: unknown, encoding: BufferEncoding = "utf8"): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }

  return Buffer.from(String(chunk), encoding);
}

function createNonProductionReadiness(): ProductionReadinessResult {
  return {
    ready: true,
    executionAllowed: true,
    publicPaymentAllowed: true,
    mode: "PUBLIC",
    status: "READY",
    errors: [],
    checks: { environment: true, manifest: true, identity: true, account: true, payment: true },
  };
}

type CanaryAdmissionResult =
  | { ok: true }
  | { ok: false; status: 409 | 503; code: string; message: string };

interface CanaryReservationContext {
  ledger: CanaryLedgerStore;
  environment: "staging" | "production";
  reservationKey: string;
  tenantId: string;
}

async function completeCanaryReservation(context: CanaryReservationContext | undefined, at: string): Promise<void> {
  if (!context) return;
  try {
    await context.ledger.complete({
      environment: context.environment,
      reservationKey: context.reservationKey,
      tenantId: context.tenantId,
      at,
    });
  } catch {
    // Keep the reservation fenced when the completion write is unavailable;
    // the ledger then remains an explicit operator/reconciliation blocker.
  }
}

async function admitCanaryBeforeChallenge(input: {
  config: AgentPayRuntimeConfig;
  request: IncomingMessage;
  intent: PaymentPreflightResult["intent"];
  ledger?: CanaryLedgerStore;
  policy?: CanaryPolicy;
  at: string;
}): Promise<CanaryAdmissionResult> {
  if (!input.ledger || !input.policy) {
    return {
      ok: false,
      status: 503,
      code: "CANARY_ADMISSION_UNAVAILABLE",
      message: "Canary admission is unavailable; the durable ledger and allowlist are required.",
    };
  }
  const caps = input.policy.caps ?? DEFAULT_CANARY_CAPS;
  try {
    // This static gate is intentionally payer-less: x402 has not identified
    // the payer yet. The actual payer is checked again after verification.
    assertCanaryRequestShapeAllowed(input.intent, input.policy.allowlist, undefined, caps, new Date(input.at));
    const usage = await input.ledger.snapshot({
      environment: input.config.environment ?? "staging",
      tenantId: input.policy.allowlist.tenantId,
      at: input.at,
    });
    // A retry carrying a payment proof must reach x402/lifecycle replay so it
    // can prove no second fee or invoice transaction. New challenges still
    // receive the informational cap check here; reserve() is authoritative.
    if (!hasPaymentProofHeader(input.request)) {
      assertCanaryUsageWithinCaps(input.intent, usage, caps);
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof CanaryPolicyError) {
      return { ok: false, status: 409, code: error.code, message: error.message };
    }
    return {
      ok: false,
      status: 503,
      code: "CANARY_ADMISSION_UNAVAILABLE",
      message: "Canary admission could not read the durable ledger.",
    };
  }
}

function hasPaymentProofHeader(request: IncomingMessage): boolean {
  return Boolean(request.headers["payment-signature"] ?? request.headers["x-payment"]);
}

function assertCanaryPaymentRequirements(requirements: PaymentRequirements): void {
  if (
    requirements.network !== MAINNET_CAIP2 ||
    requirements.asset.toLowerCase() !== MAINNET_USDT0_ADDRESS.toLowerCase() ||
    requirements.amount !== "10000"
  ) {
    throw new CanaryPolicyError(
      "CANARY_PAYMENT_TERMS",
      "Canary x402 terms must be exactly 0.01 mainnet USDT0 on eip155:196.",
    );
  }
}

function withReadinessError(readiness: ProductionReadinessResult, error: string): ProductionReadinessResult {
  return {
    ...readiness,
    ready: false,
    executionAllowed: false,
    publicPaymentAllowed: false,
    errors: [...readiness.errors, error],
  };
}

export async function resolveProductionReadiness(
  config: AgentPayRuntimeConfig,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  canary?: { canaryLedger?: CanaryLedgerStore; canaryPolicy?: CanaryPolicy },
  dependencies: ResolveProductionReadinessDependencies = {},
): Promise<ProductionReadinessResult> {
  let manifest: any;
  try {
    // The path is explicit in the production environment because published
    // packages do not contain the repository-level ops directory. The manifest
    // digest is still pinned to the operator-seeded database identity below.
    manifest = await loadProductionManifest(config.productionManifestPath);
  } catch {
    return {
      ready: false,
      executionAllowed: false,
      publicPaymentAllowed: false,
      mode: "OFF",
      status: "SHADOW_ONLY",
      errors: ["manifest: tracked production shadow manifest could not be loaded"],
      checks: { environment: false, manifest: false, identity: false, account: false, payment: false },
    };
  }

  let identity = null;
  let accountVerification = null;
  const extraErrors: string[] = [];
  if (manifest.status !== "SHADOW_ONLY") {
    try {
      identity = await (dependencies.loadRuntimeIdentity ?? (() => {
        const repositories = createSupabaseAgentPayRepositoriesFromConfig({
          supabaseUrl: config.supabaseUrl,
          serviceRoleKey: config.serviceRoleKey,
        });
        return repositories.runtimeEnvironment.getIdentity();
      }))();
    } catch {
      extraErrors.push("runtime identity: singleton identity could not be read");
    }
  }

  const requestedMode = identity?.executionMode ?? config.executionMode ?? manifest.executionMode;
  const contract = manifest.contract as Record<string, unknown> | undefined;
  if (
    shouldVerifyMainnetAccountAtStartup(requestedMode) &&
    typeof contract?.address === "string" &&
    typeof contract.deploymentTxHash === "string" &&
    typeof contract.runtimeBytecodeHash === "string" &&
    typeof contract.ownerAddress === "string" &&
    typeof contract.executorAddress === "string"
  ) {
    try {
      const expected: MainnetAccountVerificationExpected = {
        accountAddress: contract.address,
        deploymentTxHash: contract.deploymentTxHash,
        creationBytecodeHash: String(contract.creationBytecodeHash ?? ""),
        runtimeBytecodeHash: contract.runtimeBytecodeHash,
        ownerAddress: contract.ownerAddress,
        executorAddress: contract.executorAddress,
        tokenAddress: manifest.token.address,
        tokenCodeHash: manifest.token.codeHash,
        tokenDecimals: manifest.token.decimals,
      };
      accountVerification = await (dependencies.verifyAccount ?? ((input) => {
        const reader = createEthersMainnetAccountVerificationReader(config.xlayerRpcUrl);
        return verifyMainnetAccount(reader, input);
      }))(expected);
    } catch {
      extraErrors.push("mainnet account: read-only verification could not be completed");
    }
  }

  let paymentConfig;
  try {
    paymentConfig = parseAgentPayMcpPaymentEnv(env);
  } catch {
    extraErrors.push("payment config: production x402 configuration is invalid");
  }

  let canaryAdmissionReady: boolean | undefined;
  if (requestedMode === "CANARY") {
    if (!canary?.canaryLedger || !canary.canaryPolicy) {
      extraErrors.push("canary admission: durable ledger or frozen allowlist is unavailable");
      canaryAdmissionReady = false;
    } else {
      try {
        await canary.canaryLedger.snapshot({
          environment: "production",
          tenantId: canary.canaryPolicy.allowlist.tenantId,
          at: new Date().toISOString(),
        });
        canaryAdmissionReady = true;
      } catch {
        extraErrors.push("canary admission: Supabase ledger readiness probe failed");
        canaryAdmissionReady = false;
      }
    }
  }

  const result = await evaluateProductionReadiness({
    env: Object.fromEntries(
      Object.entries(env).map(([key, value]) => {
        const normalized = value?.trim();
        return [key, normalized === "" ? undefined : normalized];
      }),
    ),
    manifest,
    identity,
    accountVerification,
    paymentConfig,
    canaryAdmissionReady,
  });
  return extraErrors.reduce(withReadinessError, result);
}

async function loadManifestCanaryPolicy(path: string | undefined): Promise<CanaryPolicy | undefined> {
  try {
    const manifest = await loadProductionManifest(path) as Record<string, any>;
    const policy = manifest.canaryPolicy as Record<string, unknown> | undefined;
    if (!policy) return undefined;
    const values = [
      policy.allowlistedTenantId,
      policy.allowlistedOwnerAddress,
      policy.allowlistedAccountAddress,
      policy.payerAddress,
      policy.recipientAddress,
    ];
    if (
      typeof values[0] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(values[0]) ||
      values.slice(1).some((value) => typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value))
    ) {
      return undefined;
    }
    const invoiceMaxUsdt0 = typeof policy.invoiceMaxUsdt0 === "string" ? policy.invoiceMaxUsdt0 : "0.10";
    const maxNativeFee = typeof policy.maxNativeFee === "string" ? policy.maxNativeFee : "0";
    return {
      allowlist: {
        tenantId: values[0] as string,
        ownerAddress: values[1] as string,
        accountAddress: values[2] as string,
        payerAddress: values[3] as string,
        recipientAddress: values[4] as string,
      },
      caps: {
        ...DEFAULT_CANARY_CAPS,
        maxAcceptedLifecycles: typeof policy.maxAcceptedLifecycles === "number" ? policy.maxAcceptedLifecycles : 1,
        maxInvoiceAtomic: decimalToAtomic6(invoiceMaxUsdt0),
        maxNativeFee: BigInt(maxNativeFee),
      },
    };
  } catch {
    return undefined;
  }
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function isEnabledFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
