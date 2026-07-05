import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  type HTTPProcessResult,
  type HTTPRequestContext,
  type PaymentOption,
  type ProcessSettleResultResponse,
} from "@okxweb3/x402-core/http";
import { x402ResourceServer } from "@okxweb3/x402-core/server";
import type { Network, PaymentPayload, PaymentRequirements } from "@okxweb3/x402-core/types";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

const enabledValues = new Set(["1", "true", "yes", "on"]);
const DEFAULT_A2MCP_PAYMENT_NETWORK = "eip155:196" satisfies Network;
const DEFAULT_A2MCP_PAYMENT_TIMEOUT_SECONDS = 300;
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const caip2EvmNetworkPattern = /^eip155:\d+$/;

export interface AgentPayMcpPaymentProcessor {
  processHTTPRequest(context: HTTPRequestContext): Promise<HTTPProcessResult>;
  processSettlement(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    declaredExtensions?: Record<string, unknown>,
    transportContext?: Parameters<x402HTTPResourceServer["processSettlement"]>[3],
  ): Promise<ProcessSettleResultResponse>;
}

export interface AgentPayMcpPaymentConfig {
  enabled: boolean;
  payTo: string;
  price: string;
  network: Network;
  maxTimeoutSeconds: number;
  facilitatorUrl?: string;
  okxApiKey?: string;
  okxSecretKey?: string;
  okxPassphrase?: string;
  okxBaseUrl?: string;
  syncSettle?: boolean;
  assetTransferMethod?: "eip3009" | "permit2";
}

export interface CreateOkxAgentPaymentProcessorOptions {
  mcpPath: string;
}

export function parseAgentPayMcpPaymentEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): AgentPayMcpPaymentConfig | undefined {
  const normalized = normalizeEnv(env);

  if (!enabledValues.has((normalized.AGENTPAY_A2MCP_PAYMENT_ENABLED ?? "").toLowerCase())) {
    return undefined;
  }

  const maxTimeoutSeconds = parseOptionalPositiveInteger(
    normalized.AGENTPAY_A2MCP_PAYMENT_MAX_TIMEOUT_SECONDS,
    DEFAULT_A2MCP_PAYMENT_TIMEOUT_SECONDS,
  );
  const network = normalized.AGENTPAY_A2MCP_PAYMENT_NETWORK ?? DEFAULT_A2MCP_PAYMENT_NETWORK;
  const missing = [
    normalized.AGENTPAY_A2MCP_PAYMENT_PAY_TO ? undefined : "AGENTPAY_A2MCP_PAYMENT_PAY_TO",
    normalized.AGENTPAY_A2MCP_PAYMENT_PRICE ? undefined : "AGENTPAY_A2MCP_PAYMENT_PRICE",
  ].filter((name): name is string => Boolean(name));
  const facilitatorCredentialNames = ["OKX_APP_API_KEY", "OKX_APP_SECRET_KEY", "OKX_APP_PASSPHRASE"] as const;
  const providedFacilitatorCredentials = facilitatorCredentialNames.filter((name) => normalized[name]);
  const hasAllOkxCredentials = providedFacilitatorCredentials.length === facilitatorCredentialNames.length;

  if (!normalized.AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL && !hasAllOkxCredentials) {
    missing.push(
      ...facilitatorCredentialNames.filter((name) => !normalized[name]),
      "or AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL",
    );
  }

  const invalid = [
    normalized.AGENTPAY_A2MCP_PAYMENT_PAY_TO && !addressPattern.test(normalized.AGENTPAY_A2MCP_PAYMENT_PAY_TO)
      ? "AGENTPAY_A2MCP_PAYMENT_PAY_TO"
      : undefined,
    !caip2EvmNetworkPattern.test(network) ? "AGENTPAY_A2MCP_PAYMENT_NETWORK" : undefined,
    normalized.AGENTPAY_A2MCP_PAYMENT_MAX_TIMEOUT_SECONDS && !maxTimeoutSeconds
      ? "AGENTPAY_A2MCP_PAYMENT_MAX_TIMEOUT_SECONDS"
      : undefined,
    normalized.AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL &&
    !isHttpUrl(normalized.AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL)
      ? "AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL"
      : undefined,
    normalized.OKX_APP_BASE_URL && !isHttpUrl(normalized.OKX_APP_BASE_URL) ? "OKX_APP_BASE_URL" : undefined,
    normalized.AGENTPAY_A2MCP_PAYMENT_ASSET_TRANSFER_METHOD &&
    !["eip3009", "permit2"].includes(normalized.AGENTPAY_A2MCP_PAYMENT_ASSET_TRANSFER_METHOD)
      ? "AGENTPAY_A2MCP_PAYMENT_ASSET_TRANSFER_METHOD"
      : undefined,
  ].filter((name): name is string => Boolean(name));

  if (missing.length > 0 || invalid.length > 0) {
    throw new Error(createPaymentConfigErrorMessage(missing, invalid));
  }

  return omitUndefined({
    enabled: true,
    payTo: normalized.AGENTPAY_A2MCP_PAYMENT_PAY_TO,
    price: normalized.AGENTPAY_A2MCP_PAYMENT_PRICE,
    network: network as Network,
    maxTimeoutSeconds,
    facilitatorUrl: normalized.AGENTPAY_A2MCP_PAYMENT_FACILITATOR_URL,
    okxApiKey: normalized.OKX_APP_API_KEY,
    okxSecretKey: normalized.OKX_APP_SECRET_KEY,
    okxPassphrase: normalized.OKX_APP_PASSPHRASE,
    okxBaseUrl: normalized.OKX_APP_BASE_URL,
    syncSettle: parseOptionalBoolean(normalized.AGENTPAY_A2MCP_PAYMENT_SYNC_SETTLE),
    assetTransferMethod: normalized.AGENTPAY_A2MCP_PAYMENT_ASSET_TRANSFER_METHOD as
      | AgentPayMcpPaymentConfig["assetTransferMethod"]
      | undefined,
  }) as AgentPayMcpPaymentConfig;
}

export async function createOkxAgentPaymentProcessorFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options: CreateOkxAgentPaymentProcessorOptions,
): Promise<AgentPayMcpPaymentProcessor | undefined> {
  const config = parseAgentPayMcpPaymentEnv(env);

  return config ? createOkxAgentPaymentProcessor(config, options) : undefined;
}

export async function createOkxAgentPaymentProcessor(
  config: AgentPayMcpPaymentConfig,
  options: CreateOkxAgentPaymentProcessorOptions,
): Promise<AgentPayMcpPaymentProcessor> {
  const resourceServer = new x402ResourceServer(createFacilitatorClient(config));
  resourceServer.register(config.network, new ExactEvmScheme());

  const paymentServer = new x402HTTPResourceServer(resourceServer, {
    [`POST ${options.mcpPath}`]: {
      accepts: createPaymentOption(config),
      description: "AgentPay public MCP endpoint",
      mimeType: "application/json",
      unpaidResponseBody() {
        return {
          contentType: "application/json",
          body: {
            error: "Payment required.",
            protocol: "OKX Agent Payments Protocol",
          },
        };
      },
      settlementFailedResponseBody() {
        return {
          contentType: "application/json",
          body: {
            error: "Payment settlement failed.",
            protocol: "OKX Agent Payments Protocol",
          },
        };
      },
    },
  });

  await paymentServer.initialize();

  return paymentServer;
}

function createFacilitatorClient(config: AgentPayMcpPaymentConfig) {
  if (config.facilitatorUrl) {
    return new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  }

  return new OKXFacilitatorClient(
    omitUndefined({
      apiKey: config.okxApiKey,
      secretKey: config.okxSecretKey,
      passphrase: config.okxPassphrase,
      baseUrl: config.okxBaseUrl,
      syncSettle: config.syncSettle,
    }) as ConstructorParameters<typeof OKXFacilitatorClient>[0],
  );
}

function createPaymentOption(config: AgentPayMcpPaymentConfig): PaymentOption {
  return {
    scheme: "exact",
    network: config.network,
    payTo: config.payTo,
    price: config.price,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    extra: omitUndefined({
      assetTransferMethod: config.assetTransferMethod,
    }),
  };
}

function createPaymentConfigErrorMessage(missing: string[], invalid: string[]): string {
  const parts = [
    missing.length > 0 ? `missing: ${missing.join(", ")}` : undefined,
    invalid.length > 0 ? `invalid: ${invalid.join(", ")}` : undefined,
  ].filter(Boolean);

  return `Invalid AgentPay A2MCP payment environment (${parts.join("; ")}).`;
}

function normalizeEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value?.trim() === "" ? undefined : value?.trim()]),
  );
}

function parseOptionalPositiveInteger(value: string | undefined, fallback: number): number | undefined {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  return enabledValues.has(value.toLowerCase());
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function omitUndefined<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;
}
