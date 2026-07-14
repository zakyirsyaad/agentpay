import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export * from "./mcp/agentpay-mcp.ts";
export * from "./mcp/consumer-auth.ts";
export * from "./mcp/http.ts";
export * from "./mcp/okx-agent-payment.ts";
export * from "./mcp/stdio.ts";
export * from "./runtime/agentpay-runtime.ts";
export * from "./runtime/production-readiness.ts";
export * from "./runtime/paid-execution-canary.ts";
export * from "./runtime/paid-execution-canary-ledger.ts";
export * from "./auth/siwe.ts";
export * from "./auth/session.ts";
export * from "./auth/consumer-session-api.ts";
export * from "./services/lifi.ts";
export * from "./services/chain-executor.ts";
export * from "./services/payment-authorization.ts";
export * from "./services/mainnet-account-verifier.ts";
export * from "./services/payment-review.ts";
export * from "./services/paid-execution-lifecycle.ts";
export * from "./services/paid-execution-outbox.ts";
export * from "./services/paid-execution-challenge.ts";
export * from "./services/invoice-execution-reconciler.ts";
export * from "./services/supabase.ts";
export * from "./services/x402-bazaar.ts";
export * from "./tools/account-admin.ts";
export * from "./tools/execute-payment.ts";
export * from "./tools/get-balance.ts";
export * from "./tools/invoice.ts";
export * from "./tools/payment-tracking.ts";
export * from "./tools/payment-review.ts";
export * from "./tools/prepare-contract-call.ts";
export * from "./tools/prepare-payment.ts";
export * from "./tools/quote-payment-route.ts";
export * from "./tools/route-target-allowance.ts";
export * from "./tools/wallet-setup.ts";
export * from "./tools/x402.ts";
export * from "./tools/x402-bazaar.ts";

import { startAgentPayMcpServer } from "./mcp/stdio.ts";

if (isMainModule(import.meta.url, process.argv[1])) {
  startAgentPayMcpServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "AgentPay MCP server failed to start.");
    process.exitCode = 1;
  });
}

function isMainModule(moduleUrl: string, entrypoint: string | undefined): boolean {
  return entrypoint !== undefined && fileURLToPath(moduleUrl) === resolve(entrypoint);
}
