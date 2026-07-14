import {
  AgentPayAuthError,
  checkWalletCreationInputSchema,
  checkRouteTargetAllowanceInputSchema,
  executePaymentInputSchema,
  getPaymentSignatureInputSchema,
  getBalanceInputSchema,
  getAgentWalletInputSchema,
  listPaymentEventsInputSchema,
  listTransactionsInputSchema,
  parseInvoicePaymentInputSchema,
  parseX402PaymentRequiredInputSchema,
  prepareX402ServiceRequestInputSchema,
  prepareAccountAdminTransactionInputSchema,
  prepareContractCallInputSchema,
  preparePaymentInputSchema,
  prepareRouteTargetAllowanceInputSchema,
  prepareWalletCreationInputSchema,
  quotePaymentRouteInputSchema,
  retryX402RequestInputSchema,
  searchX402ServicesInputSchema,
  trackPaymentInputSchema,
  requireSessionScope,
  assertNoCallerAuthority,
  type SessionContext,
  type SessionScope,
} from "@agentpay-ai/shared";

import type { AgentPayRuntime } from "../runtime/agentpay-runtime.ts";
import { prepareAccountAdminTransactionTool } from "../tools/account-admin.ts";
import { DurableExecutionError, executePaymentTool } from "../tools/execute-payment.ts";
import { getBalanceTool } from "../tools/get-balance.ts";
import { parseInvoicePaymentTool } from "../tools/invoice.ts";
import { prepareX402ServiceRequestTool, searchX402ServicesTool } from "../tools/x402-bazaar.ts";
import { parseX402PaymentRequiredTool, retryX402RequestTool } from "../tools/x402.ts";
import { listPaymentEventsTool, listTransactionsTool, trackPaymentTool } from "../tools/payment-tracking.ts";
import { prepareContractCallTool } from "../tools/prepare-contract-call.ts";
import { preparePaymentTool } from "../tools/prepare-payment.ts";
import { getPaymentSignatureTool } from "../tools/payment-review.ts";
import { quotePaymentRouteTool } from "../tools/quote-payment-route.ts";
import {
  checkRouteTargetAllowanceTool,
  prepareRouteTargetAllowanceTool,
} from "../tools/route-target-allowance.ts";
import {
  checkWalletCreationTool,
  getAgentWalletTool,
  prepareWalletCreationTool,
} from "../tools/wallet-setup.ts";

export interface AgentPayMcpServer {
  registerTool(
    name: string,
    metadata: Record<string, unknown>,
    handler: (input: unknown) => Promise<AgentPayMcpToolResult>,
  ): void;
}

export interface AgentPayMcpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface AgentPayMcpRegistrationOptions {
  sessionContext?: SessionContext;
  /** Public paid ASP mode exposes only execute_payment. */
  publicExecutionOnly?: boolean;
  /** Explicit local/migration escape hatch. Production/public registration leaves this off. */
  legacyApprovalEnabled?: boolean;
}

export function registerAgentPayMcpTools(
  server: AgentPayMcpServer,
  runtime: AgentPayRuntime,
  options: AgentPayMcpRegistrationOptions = {},
): void {
  if (options.publicExecutionOnly) {
    registerExecutePaymentTool(server, runtime, options);
    return;
  }

  server.registerTool(
    prepareWalletCreationTool.name,
    {
      title: "Prepare Wallet Creation",
      description: prepareWalletCreationTool.description,
      inputSchema: prepareWalletCreationInputSchema.shape,
    },
    guardedTool(options.sessionContext, "session:manage", async (input) =>
      toMcpResult(
        await runtime.prepareWalletCreation({
          ...prepareWalletCreationInputSchema.parse(input),
          ...(options.sessionContext ? { ownerAddress: options.sessionContext.ownerAddress } : {}),
        }),
      ),
    ),
  );

  server.registerTool(
    checkWalletCreationTool.name,
    {
      title: "Check Wallet Creation",
      description: checkWalletCreationTool.description,
      inputSchema: checkWalletCreationInputSchema.shape,
    },
    guardedTool(options.sessionContext, "wallet:read", async (input) =>
      toMcpResult(await runtime.checkWalletCreation(checkWalletCreationInputSchema.parse(input))),
    ),
  );

  server.registerTool(
    getAgentWalletTool.name,
    {
      title: "Get Agent Wallet",
      description: getAgentWalletTool.description,
      inputSchema: getAgentWalletInputSchema.shape,
    },
    guardedTool(options.sessionContext, "wallet:read", async (input) =>
      toMcpResult(await runtime.getAgentWallet(getAgentWalletInputSchema.parse(input))),
    ),
  );

  server.registerTool(
    getBalanceTool.name,
    {
      title: "Get Balance",
      description: getBalanceTool.description,
      inputSchema: getBalanceInputSchema.shape,
    },
    guardedTool(options.sessionContext, "wallet:read", async (input) =>
      toMcpResult(await runtime.getBalance(getBalanceInputSchema.parse(input))),
    ),
  );

  server.registerTool(
    parseInvoicePaymentTool.name,
    {
      title: "Parse Invoice Payment",
      description: parseInvoicePaymentTool.description,
      inputSchema: parseInvoicePaymentInputSchema.shape,
    },
    async (input) => toMcpResult(await runtime.parseInvoicePayment(parseInvoicePaymentInputSchema.parse(input))),
  );

  server.registerTool(
    searchX402ServicesTool.name,
    {
      title: "Search x402 Services",
      description: searchX402ServicesTool.description,
      inputSchema: searchX402ServicesInputSchema.shape,
    },
    async (input) => toMcpResult(await runtime.searchX402Services(searchX402ServicesInputSchema.parse(input))),
  );

  server.registerTool(
    prepareX402ServiceRequestTool.name,
    {
      title: "Prepare x402 Service Request",
      description: prepareX402ServiceRequestTool.description,
      inputSchema: prepareX402ServiceRequestInputSchema.shape,
    },
    guardedTool(options.sessionContext, "payment:prepare", async (input) =>
      toMcpResult(await runtime.prepareX402ServiceRequest(prepareX402ServiceRequestInputSchema.parse(input))),
    ),
  );

  server.registerTool(
    parseX402PaymentRequiredTool.name,
    {
      title: "Parse x402 Payment Required",
      description: parseX402PaymentRequiredTool.description,
      inputSchema: parseX402PaymentRequiredInputSchema.shape,
    },
    async (input) =>
      toMcpResult(await runtime.parseX402PaymentRequired(parseX402PaymentRequiredInputSchema.parse(input))),
  );

  server.registerTool(
    retryX402RequestTool.name,
    {
      title: "Retry x402 Request",
      description: retryX402RequestTool.description,
      inputSchema: retryX402RequestInputSchema.shape,
    },
    guardedTool(options.sessionContext, "payment:read", async (input) =>
      toMcpResult(await runtime.retryX402Request(retryX402RequestInputSchema.parse(input))),
    ),
  );

  server.registerTool(
    prepareContractCallTool.name,
    {
      title: "Prepare Contract Call",
      description: prepareContractCallTool.description,
      inputSchema: prepareContractCallInputSchema.shape,
    },
    guardedTool(options.sessionContext, "payment:prepare", async (input) =>
      toMcpResult(await runtime.prepareContractCall(prepareContractCallInputSchema.parse(input))),
    ),
  );

  server.registerTool(
    quotePaymentRouteTool.name,
    {
      title: "Quote Payment Route",
      description: quotePaymentRouteTool.description,
      inputSchema: quotePaymentRouteInputSchema.shape,
    },
    guardedTool(options.sessionContext, "payment:prepare", async (input) =>
      toMcpResult(await runtime.quotePaymentRoute(quotePaymentRouteInputSchema.parse(input))),
    ),
  );

  server.registerTool(
    checkRouteTargetAllowanceTool.name,
    {
      title: "Check Route Target Allowance",
      description: checkRouteTargetAllowanceTool.description,
      inputSchema: checkRouteTargetAllowanceInputSchema.shape,
    },
    guardedTool(options.sessionContext, "payment:read", async (input) =>
      toMcpResult(await runtime.checkRouteTargetAllowance(checkRouteTargetAllowanceInputSchema.parse(input))),
    ),
  );

  server.registerTool(
    prepareRouteTargetAllowanceTool.name,
    {
      title: "Prepare Route Target Allowance",
      description: prepareRouteTargetAllowanceTool.description,
      inputSchema: prepareRouteTargetAllowanceInputSchema.shape,
    },
    guardedTool(options.sessionContext, "payment:prepare", async (input) =>
      toMcpResult(await runtime.prepareRouteTargetAllowance(prepareRouteTargetAllowanceInputSchema.parse(input))),
    ),
  );

  server.registerTool(
    prepareAccountAdminTransactionTool.name,
    {
      title: "Prepare Account Admin Transaction",
      description: prepareAccountAdminTransactionTool.description,
      inputSchema: prepareAccountAdminTransactionInputSchema,
    },
    guardedTool(options.sessionContext, "payment:review", async (input) =>
      toMcpResult(
        await runtime.prepareAccountAdminTransaction(prepareAccountAdminTransactionInputSchema.parse(input)),
      ),
    ),
  );

  server.registerTool(
    preparePaymentTool.name,
    {
      title: "Prepare Payment",
      description: preparePaymentTool.description,
      inputSchema: preparePaymentInputSchema.shape,
    },
    guardedTool(options.sessionContext, "payment:prepare", async (input) =>
      toMcpResult(await runtime.preparePayment(preparePaymentInputSchema.parse(input))),
    ),
  );

  if (options.sessionContext) {
    server.registerTool(
      getPaymentSignatureTool.name,
      {
        title: "Get Payment Signature",
        description: getPaymentSignatureTool.description,
        inputSchema: getPaymentSignatureInputSchema.shape,
      },
      guardedTool(options.sessionContext, "payment:review", async (input) =>
        toMcpResult(await runtime.getPaymentSignature(getPaymentSignatureInputSchema.parse(input))),
      ),
    );
  }

  registerExecutePaymentTool(server, runtime, options);

  server.registerTool(
    trackPaymentTool.name,
    {
      title: "Track Payment",
      description: trackPaymentTool.description,
      inputSchema: trackPaymentInputSchema.shape,
    },
    guardedTool(options.sessionContext, "payment:read", async (input) =>
      toMcpResult(await runtime.trackPayment(trackPaymentInputSchema.parse(input))),
    ),
  );

  server.registerTool(
    listTransactionsTool.name,
    {
      title: "List Transactions",
      description: listTransactionsTool.description,
      inputSchema: listTransactionsInputSchema.shape,
    },
    guardedTool(options.sessionContext, "payment:read", async (input) =>
      toMcpResult(await runtime.listTransactions(listTransactionsInputSchema.parse(input))),
    ),
  );

  server.registerTool(
    listPaymentEventsTool.name,
    {
      title: "List Payment Events",
      description: listPaymentEventsTool.description,
      inputSchema: listPaymentEventsInputSchema.shape,
    },
    guardedTool(options.sessionContext, "payment:read", async (input) =>
      toMcpResult(await runtime.listPaymentEvents(listPaymentEventsInputSchema.parse(input))),
    ),
  );
}

function registerExecutePaymentTool(
  server: AgentPayMcpServer,
  runtime: AgentPayRuntime,
  options: AgentPayMcpRegistrationOptions,
): void {
  server.registerTool(
    executePaymentTool.name,
    {
      title: "Execute Payment",
      description: executePaymentTool.description,
      inputSchema: executePaymentInputSchema.shape,
    },
    async (input) => {
      if (options.sessionContext) {
        try {
          assertNoCallerAuthority(input);
        } catch (error) {
          return toMcpErrorResult(error);
        }
        return toMcpErrorResult(
          new AgentPayAuthError(
            "AUTH_PAYMENT_SIGNATURE_REQUIRED",
            "Consumer session cannot authorize payment execution; hand the owner-signed authorization to the public paid ASP.",
          ),
        );
      }
      if (!executePaymentInputSchema.safeParse(input).data?.signature && !options.legacyApprovalEnabled) {
        return toMcpErrorResult(
          new AgentPayAuthError(
            "AUTH_PAYMENT_SIGNATURE_REQUIRED",
            "Owner EIP-712 payment authorization is required; legacy approval text is disabled on this surface.",
          ),
        );
      }
      try {
        return toMcpResult(await runtime.executePayment(executePaymentInputSchema.parse(input)));
      } catch (error) {
        return toMcpErrorResult(error);
      }
    },
  );
}

function guardedTool(
  context: SessionContext | undefined,
  requiredScope: SessionScope,
  handler: (input: unknown) => Promise<AgentPayMcpToolResult>,
): (input: unknown) => Promise<AgentPayMcpToolResult> {
  return async (input) => {
    if (context) {
      assertNoCallerAuthority(input);
      requireSessionScope(context, requiredScope);
    }
    return handler(input);
  };
}

function toMcpResult(output: unknown): AgentPayMcpToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(output, null, 2),
      },
    ],
    structuredContent: output,
  };
}

function toMcpErrorResult(error: unknown): AgentPayMcpToolResult {
  const text = error instanceof DurableExecutionError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : "Unknown AgentPay tool failure.";
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    isError: true,
  };
}
