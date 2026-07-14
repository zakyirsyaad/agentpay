import {
  createAgentPayX402PaymentHeader,
  parseX402PaymentRequired,
  type ParsedX402PaymentRequired,
  type ParseX402PaymentRequiredInput,
  parseX402PaymentRequiredInputSchema,
  type PaymentIntentRecord,
  type RetryX402RequestInput,
  retryX402RequestInputSchema,
} from "@agentpay-ai/shared";

export interface ParseX402PaymentRequiredOutput extends ParsedX402PaymentRequired {
  status: "PARSED";
  instructionToAgent: string;
}

export async function parseX402PaymentRequiredForAgent(
  rawInput: ParseX402PaymentRequiredInput,
): Promise<ParseX402PaymentRequiredOutput> {
  const parsed = parseX402PaymentRequired(rawInput);

  return {
    status: "PARSED",
    ...parsed,
    instructionToAgent:
      "Review the x402 requirement with the user. Prepare payment with paymentInput, preserve paymentType: X402_PAYMENT, send the owner to Review & Sign for the EIP-712 authorization, execute with the verified signature, track until COMPLETED, then call retry_x402_request with the original PAYMENT-REQUIRED response and paymentIntentId.",
  };
}

export interface RetryX402PaymentIntentRepository {
  getPaymentIntent(paymentIntentId: string): Promise<PaymentIntentRecord | null>;
}

export interface RetryX402RequestDependencies {
  paymentIntents: RetryX402PaymentIntentRepository;
  fetch: typeof fetch;
}

export interface RetryX402RequestOutput {
  status: "RESOURCE_FETCHED";
  paymentIntentId: string;
  requestUrl: string;
  method: string;
  httpStatus: number;
  paymentHeader: string;
  paymentResponse?: string;
  bodyText: string;
  instructionToAgent: string;
}

export async function retryX402Request(
  rawInput: RetryX402RequestInput,
  dependencies: RetryX402RequestDependencies,
): Promise<RetryX402RequestOutput> {
  const input = retryX402RequestInputSchema.parse(rawInput);
  const parsed = parseX402PaymentRequired({ paymentRequired: input.paymentRequired });
  const paymentIntent = await dependencies.paymentIntents.getPaymentIntent(input.paymentIntentId);

  if (!paymentIntent) {
    throw new Error(`Payment intent ${input.paymentIntentId} was not found.`);
  }

  const requestUrl = input.request.url ?? parsed.resource.url;

  if (requestUrl !== parsed.resource.url) {
    throw new Error("x402 retry URL must match the resource URL from the PAYMENT-REQUIRED response.");
  }

  const paymentHeader = createAgentPayX402PaymentHeader({ parsed, paymentIntent });
  const headers = createRetryHeaders(input.request.headers, paymentHeader);
  const response = await dependencies.fetch(requestUrl, {
    method: input.request.method,
    headers,
    ...(input.request.body !== undefined ? { body: input.request.body } : {}),
  });
  const bodyText = await response.text();
  const paymentResponse = response.headers.get("payment-response") ?? response.headers.get("x-payment-response") ?? undefined;

  return {
    status: "RESOURCE_FETCHED",
    paymentIntentId: paymentIntent.id,
    requestUrl,
    method: input.request.method,
    httpStatus: response.status,
    paymentHeader,
    ...(paymentResponse ? { paymentResponse } : {}),
    bodyText,
    instructionToAgent:
      response.ok
        ? "x402 retry succeeded. Return the protected resource response to the user."
        : "x402 retry returned a non-2xx response. Show the HTTP status and response body to the user.",
  };
}

export const parseX402PaymentRequiredTool = {
  name: "parse_x402_payment_required",
  description: "Parse a v2 x402 PAYMENT-REQUIRED object or header into AgentPay payment fields.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["paymentRequired"],
    properties: {
      paymentRequired: {
        anyOf: [{ type: "string" }, { type: "object" }],
      },
      sourceTokenSymbol: { type: "string", enum: ["USDT0", "USDC", "USDT"] },
    },
  },
} as const;

export const retryX402RequestTool = {
  name: "retry_x402_request",
  description:
    "Retry an x402-protected HTTP request after the AgentPay payment intent is COMPLETED, attaching AgentPay payment proof headers.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["paymentRequired", "paymentIntentId"],
    properties: {
      paymentRequired: {
        anyOf: [{ type: "string" }, { type: "object" }],
      },
      paymentIntentId: { type: "string" },
      request: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          body: { type: "string" },
        },
      },
    },
  },
} as const;

export function createParseX402PaymentRequiredHandler() {
  return (input: ParseX402PaymentRequiredInput) => parseX402PaymentRequiredForAgent(input);
}

export function createRetryX402RequestHandler(dependencies: RetryX402RequestDependencies) {
  return (input: RetryX402RequestInput) => retryX402Request(input, dependencies);
}

export { parseX402PaymentRequiredInputSchema, retryX402RequestInputSchema };

function createRetryHeaders(inputHeaders: Record<string, string>, paymentHeader: string): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(inputHeaders).filter(([name]) => {
      const normalized = name.toLowerCase();
      return normalized !== "x-payment" && normalized !== "payment-signature";
    }),
  );

  return {
    ...headers,
    "X-PAYMENT": paymentHeader,
    "PAYMENT-SIGNATURE": paymentHeader,
    "Access-Control-Expose-Headers": "PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
  };
}
