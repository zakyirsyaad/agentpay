import { verifyMessage } from "ethers";

import {
  completeWalletSetupInputSchema,
  getStableTokenAddress,
  DEFAULT_STABLE_TOKEN_SYMBOLS,
  type CompleteWalletSetupInput,
  type SetupIntentRecord,
} from "@agentpay-ai/shared";

const MAINNET_USDT0_ADDRESS = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";

export interface AgentWalletRecord {
  tenantId?: string;
  ownerAddress: string;
  accountAddress: string;
  homeChainId: number;
  executorAddress: string;
  status: "ACTIVE" | "PAUSED" | "CLOSED";
}

export interface SetupCompletionSetupIntentRepository {
  getSetupIntent(setupIntentId: string): Promise<SetupIntentRecord | null>;
  markSetupSigned(setupIntentId: string, ownerAddress: string, signature: string, tenantId?: string): Promise<void>;
  markSetupCompleted(setupIntentId: string, accountAddress: string, completedAt: string): Promise<void>;
  markSetupExpired(setupIntentId: string): Promise<void>;
  markSetupFailed(setupIntentId: string, errorCode: string, errorMessage: string): Promise<void>;
}

export interface SetupCompletionWalletRepository {
  createAgentWallet(wallet: AgentWalletRecord): Promise<void>;
}

export interface AgentPayAccountDeploymentRequest {
  ownerAddress: string;
  executorAddress: string;
  homeChainId: number;
  initialAllowedTokenAddresses: string[];
  initialAllowedRouteTargets: string[];
}

export interface AgentPayAccountDeploymentResult {
  accountAddress: string;
  deploymentTxHash?: string;
}

export interface AgentPayAccountDeployer {
  deployAgentPayAccount(request: AgentPayAccountDeploymentRequest): Promise<AgentPayAccountDeploymentResult>;
}

export interface SetupSignatureVerifier {
  recoverSignerAddress(message: string, signature: string): Promise<string>;
}

export interface CompleteWalletSetupDependencies {
  setupIntents: SetupCompletionSetupIntentRepository;
  wallets: SetupCompletionWalletRepository;
  deployer: AgentPayAccountDeployer;
  signatureVerifier: SetupSignatureVerifier;
  clock: () => Date;
  homeChainId?: number;
  initialAllowedTokenAddresses?: string[];
  initialAllowedRouteTargets?: string[];
  bindVerifiedOwner?: (ownerAddress: string, homeChainId: number) => Promise<{ tenantId: string }>;
}

export interface CompleteWalletSetupOutput {
  setupIntentId: string;
  status: "COMPLETED";
  ownerAddress: string;
  accountAddress: string;
  deploymentTxHash?: string;
  completedAt: string;
}

export const DEFAULT_SETUP_HOME_CHAIN_ID = 1952;

export async function completeWalletSetup(
  rawInput: CompleteWalletSetupInput,
  dependencies: CompleteWalletSetupDependencies,
): Promise<CompleteWalletSetupOutput> {
  const input = completeWalletSetupInputSchema.parse(rawInput);
  const intent = await dependencies.setupIntents.getSetupIntent(input.setupIntentId);

  if (!intent) {
    throw new Error(`Setup intent ${input.setupIntentId} was not found.`);
  }

  if (intent.status === "COMPLETED" && intent.ownerAddress && intent.accountAddress && intent.completedAt) {
    return {
      setupIntentId: intent.id,
      status: "COMPLETED",
      ownerAddress: intent.ownerAddress,
      accountAddress: intent.accountAddress,
      completedAt: intent.completedAt,
    };
  }

  if (!["PENDING", "SIGNED"].includes(intent.status)) {
    throw new Error(`Setup intent ${intent.id} is ${intent.status}, not PENDING.`);
  }

  if (new Date(intent.expiresAt).getTime() <= dependencies.clock().getTime()) {
    await dependencies.setupIntents.markSetupExpired(intent.id);
    throw new Error(`Setup intent ${intent.id} expired.`);
  }

  const ownerAddress = await dependencies.signatureVerifier.recoverSignerAddress(intent.messageToSign, input.signature);

  if (intent.ownerAddress && !sameAddress(intent.ownerAddress, ownerAddress)) {
    const message = "Setup signature does not match the expected owner address.";
    await dependencies.setupIntents.markSetupFailed(intent.id, "OWNER_MISMATCH", message);
    throw new Error(message);
  }

  try {
    const homeChainId = intent.homeChainId ?? dependencies.homeChainId ?? DEFAULT_SETUP_HOME_CHAIN_ID;
    const initialAllowedTokenAddresses =
      dependencies.initialAllowedTokenAddresses ?? defaultAllowedTokenAddresses(homeChainId);
    const initialAllowedRouteTargets = dependencies.initialAllowedRouteTargets ?? [];
    assertDeploymentAllowlist(homeChainId, initialAllowedTokenAddresses, initialAllowedRouteTargets);
    const tenantBinding = dependencies.bindVerifiedOwner
      ? await dependencies.bindVerifiedOwner(ownerAddress, homeChainId)
      : undefined;
    await dependencies.setupIntents.markSetupSigned(intent.id, ownerAddress, input.signature, tenantBinding?.tenantId);
    const deployment = await dependencies.deployer.deployAgentPayAccount({
      ownerAddress,
      executorAddress: intent.executorAddress,
      homeChainId,
      initialAllowedTokenAddresses,
      initialAllowedRouteTargets,
    });
    const completedAt = dependencies.clock().toISOString();

    await dependencies.wallets.createAgentWallet({
      ...(tenantBinding ? { tenantId: tenantBinding.tenantId } : {}),
      ownerAddress,
      accountAddress: deployment.accountAddress,
      homeChainId,
      executorAddress: intent.executorAddress,
      status: "ACTIVE",
    });
    await dependencies.setupIntents.markSetupCompleted(intent.id, deployment.accountAddress, completedAt);

    return {
      setupIntentId: intent.id,
      status: "COMPLETED",
      ownerAddress,
      accountAddress: deployment.accountAddress,
      deploymentTxHash: deployment.deploymentTxHash,
      completedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown setup deployment failure.";
    await dependencies.setupIntents.markSetupFailed(intent.id, "DEPLOYMENT_FAILED", message);
    throw error;
  }
}

export function createEthersSetupSignatureVerifier(): SetupSignatureVerifier {
  return {
    async recoverSignerAddress(message, signature) {
      return verifyMessage(message, signature);
    },
  };
}

export function createCompleteWalletSetupHttpHandler(dependencies: CompleteWalletSetupDependencies) {
  return async (request: Request): Promise<Response> => {
    try {
      const body = (await request.json()) as unknown;
      const output = await completeWalletSetup(completeWalletSetupInputSchema.parse(body), dependencies);
      return jsonResponse(output, 200);
    } catch (error) {
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : "Unknown setup completion failure.",
        },
        400,
      );
    }
  };
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function defaultAllowedTokenAddresses(homeChainId: number): string[] {
  const symbols = homeChainId === 196 ? (["USDT0"] as const) : DEFAULT_STABLE_TOKEN_SYMBOLS;
  return symbols.map((symbol) => getStableTokenAddress(homeChainId, symbol));
}

function assertDeploymentAllowlist(homeChainId: number, tokenAddresses: string[], routeTargets: string[]): void {
  if (homeChainId !== 196 && homeChainId !== 1952) {
    throw new Error(`Unsupported AgentPay setup chain ${homeChainId}; only X Layer mainnet (196) and testnet (1952) are allowed.`);
  }
  if (homeChainId !== 196) {
    return;
  }
  if (tokenAddresses.length !== 1 || tokenAddresses[0]?.toLowerCase() !== MAINNET_USDT0_ADDRESS.toLowerCase()) {
    throw new Error("X Layer mainnet setup requires the canonical USDT0 token allowlist only.");
  }
  if (routeTargets.length !== 0) {
    throw new Error("X Layer mainnet setup requires an empty route-target allowlist.");
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
