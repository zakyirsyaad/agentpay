import {
  buildX402BazaarHttpRequest,
  getX402BazaarHttpMethod,
  getX402BazaarRequiredParameters,
  normalizeX402BazaarResource,
  prepareX402ServiceRequestInputSchema,
  searchX402ServicesInputSchema,
  type ParsedSearchX402ServicesInput,
  type PrepareX402ServiceRequestInput,
  type SearchX402ServicesInput,
  type X402BazaarPaymentRequirement,
  type X402BazaarPaymentRequiredObject,
  type X402BazaarResource,
} from "@agentpay-ai/shared";

export interface X402BazaarDiscoverySearchResult {
  resources: X402BazaarResource[];
  nextCursor?: string;
  partialResults?: boolean;
}

export interface X402BazaarDiscoveryProvider {
  search(input: ParsedSearchX402ServicesInput): Promise<X402BazaarDiscoverySearchResult>;
}

export interface SearchX402ServicesDependencies {
  discovery: X402BazaarDiscoveryProvider;
}

export interface SearchX402ServicesOutput {
  status: "FOUND" | "NO_RESULTS";
  query: string;
  type: "http" | "mcp";
  network?: string;
  results: X402ServiceSearchResult[];
  nextCursor?: string;
  partialResults?: boolean;
  instructionToAgent: string;
}

export interface X402ServiceSearchResult {
  resourceUrl: string;
  type: "http" | "mcp";
  serviceName?: string;
  description?: string;
  method?: string;
  tags?: string[];
  requiredParameters: string[];
  accepts: X402BazaarPaymentRequirement[];
  resource: X402BazaarResource;
}

export interface PrepareX402ServiceRequestOutput {
  status: "REQUEST_READY" | "NEEDS_INPUT";
  request?: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  };
  paymentRequired?: X402BazaarPaymentRequiredObject;
  missingParameters: string[];
  instructionToAgent: string;
}

export async function searchX402Services(
  rawInput: SearchX402ServicesInput,
  dependencies: SearchX402ServicesDependencies,
): Promise<SearchX402ServicesOutput> {
  const input = searchX402ServicesInputSchema.parse(rawInput);
  const result = await dependencies.discovery.search(input);
  const resources = result.resources.map(normalizeX402BazaarResource);

  return {
    status: resources.length > 0 ? "FOUND" : "NO_RESULTS",
    query: input.query,
    type: input.type,
    ...(input.network ? { network: input.network } : {}),
    results: resources.map(toSearchResult),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    ...(result.partialResults !== undefined ? { partialResults: result.partialResults } : {}),
    instructionToAgent:
      resources.length > 0
        ? "Ask the user to choose a service, collect any required parameters, then call prepare_x402_service_request with the selected resource."
        : "No x402 Bazaar services matched the request. Ask the user for a more specific service, category, or URL.",
  };
}

export async function prepareX402ServiceRequestForAgent(
  rawInput: PrepareX402ServiceRequestInput,
): Promise<PrepareX402ServiceRequestOutput> {
  const input = prepareX402ServiceRequestInputSchema.parse(rawInput);
  const built = buildX402BazaarHttpRequest({
    resource: input.resource,
    parameters: input.parameters,
    headers: input.headers,
    body: input.body,
  });

  if (built.status === "NEEDS_INPUT") {
    return {
      status: "NEEDS_INPUT",
      missingParameters: built.missingParameters,
      instructionToAgent: `Ask the user for missing parameter(s): ${built.missingParameters.join(", ")}.`,
    };
  }

  return {
    status: "REQUEST_READY",
    request: built.request!,
    paymentRequired: built.paymentRequired!,
    missingParameters: [],
    instructionToAgent:
      "Call parse_x402_payment_required with paymentRequired, review details with the user, run the Review & Sign owner-authorization flow, then call retry_x402_request with this request after track_payment returns COMPLETED.",
  };
}

export const searchX402ServicesTool = {
  name: "search_x402_services",
  description: "Search x402 Bazaar for paid HTTP or MCP services when the user does not provide a resource URL.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string" },
      type: { type: "string", enum: ["http", "mcp"] },
      network: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 20 },
      cursor: { type: "string" },
    },
  },
} as const;

export const prepareX402ServiceRequestTool = {
  name: "prepare_x402_service_request",
  description: "Prepare a selected x402 Bazaar HTTP service request and PAYMENT-REQUIRED object for AgentPay approval.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["resource"],
    properties: {
      resource: { type: "object" },
      parameters: {
        type: "object",
        additionalProperties: {
          anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
        },
      },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
      },
      body: {},
    },
  },
} as const;

export function createSearchX402ServicesHandler(dependencies: SearchX402ServicesDependencies) {
  return (input: SearchX402ServicesInput) => searchX402Services(input, dependencies);
}

export function createPrepareX402ServiceRequestHandler() {
  return (input: PrepareX402ServiceRequestInput) => prepareX402ServiceRequestForAgent(input);
}

function toSearchResult(resource: X402BazaarResource): X402ServiceSearchResult {
  const method = getX402BazaarHttpMethod(resource);

  return {
    resourceUrl: resource.resource,
    type: resource.type,
    ...(resource.serviceName ? { serviceName: resource.serviceName } : {}),
    ...(resource.description ? { description: resource.description } : {}),
    ...(method ? { method } : {}),
    ...(resource.tags ? { tags: resource.tags } : {}),
    requiredParameters: getX402BazaarRequiredParameters(resource),
    accepts: resource.accepts,
    resource,
  };
}

export { prepareX402ServiceRequestInputSchema, searchX402ServicesInputSchema };
