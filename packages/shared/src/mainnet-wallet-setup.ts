import { z } from "zod";

import { evmAddressSchema } from "./payment-intent.ts";
import { setupSignatureSchema } from "./wallet-setup.ts";

export const MAINNET_SETUP_CHAIN_ID = 196 as const;
export const MAINNET_SETUP_ENVIRONMENT = "production" as const;
export const MAINNET_SETUP_USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736" as const;
export const MAINNET_ONBOARDING_URL = "https://onboard.agentpay.site/setup" as const;
export const MAINNET_SETUP_TOKEN_ALLOWLIST_HASH =
  "0xc0687130b337dbc04821b9bd064027dd46ef43a11adc8c2d98fccd719152b4a5" as const;
export const MAINNET_SETUP_ROUTE_ALLOWLIST_HASH =
  "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd" as const;

const MAX_UINT256_DECIMAL =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const MAX_UINT256_DECIMAL_DIGITS = MAX_UINT256_DECIMAL.length;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const bytes32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Expected a 32-byte hex value");
const transactionHashSchema = bytes32Schema;
const setupIntentIdSchema = z.string().min(16).max(128);
const isoTimestampSchema = z.string().datetime({ offset: true });

const nonzeroEvmAddressSchema = evmAddressSchema.refine(
  (value) => value.toLowerCase() !== ZERO_ADDRESS,
  "Expected a nonzero EVM address",
);

const positiveUint256StringSchema = z.string().superRefine((value, context) => {
  if (!/^[1-9][0-9]*$/.test(value)) {
    context.addIssue({ code: "custom", message: "Expected a positive decimal uint256 string" });
    return;
  }

  if (value.length > MAX_UINT256_DECIMAL_DIGITS) {
    context.addIssue({ code: "custom", message: "Expected at most 78 decimal digits for uint256" });
    return;
  }

  if (value.length === MAX_UINT256_DECIMAL_DIGITS && value > MAX_UINT256_DECIMAL) {
    context.addIssue({ code: "custom", message: "Expected a decimal uint256 string" });
  }
});

export const mainnetWalletSetupMessageSchema = z
  .object({
    setupIntentId: setupIntentIdSchema,
    deploymentNonce: bytes32Schema,
    owner: nonzeroEvmAddressSchema,
    executor: nonzeroEvmAddressSchema,
    homeChainId: z.literal(MAINNET_SETUP_CHAIN_ID),
    environment: z.literal(MAINNET_SETUP_ENVIRONMENT),
    deadline: positiveUint256StringSchema,
    factory: nonzeroEvmAddressSchema,
    factoryRuntimeCodeHash: bytes32Schema,
    deploymentSalt: bytes32Schema,
    predictedAccount: nonzeroEvmAddressSchema,
    accountCreationCodeHash: bytes32Schema,
    accountRuntimeCodeHash: bytes32Schema,
    token: z.literal(MAINNET_SETUP_USDT0),
    tokenAllowlistHash: z.literal(MAINNET_SETUP_TOKEN_ALLOWLIST_HASH),
    routeAllowlistHash: z.literal(MAINNET_SETUP_ROUTE_ALLOWLIST_HASH),
    manifestSha256: bytes32Schema,
  })
  .strict()
  .superRefine((message, context) => {
    const signedActors = [message.owner, message.executor, message.factory].map((address) => address.toLowerCase());
    if (new Set(signedActors).size !== signedActors.length) {
      context.addIssue({
        code: "custom",
        message: "Owner, executor, and factory must be distinct addresses",
      });
    }
  });

export type MainnetWalletSetupMessage = z.infer<typeof mainnetWalletSetupMessageSchema>;

const mainnetWalletSetupTypeFields = [
  { name: "setupIntentId", type: "string" },
  { name: "deploymentNonce", type: "bytes32" },
  { name: "owner", type: "address" },
  { name: "executor", type: "address" },
  { name: "homeChainId", type: "uint256" },
  { name: "environment", type: "string" },
  { name: "deadline", type: "uint256" },
  { name: "factory", type: "address" },
  { name: "factoryRuntimeCodeHash", type: "bytes32" },
  { name: "deploymentSalt", type: "bytes32" },
  { name: "predictedAccount", type: "address" },
  { name: "accountCreationCodeHash", type: "bytes32" },
  { name: "accountRuntimeCodeHash", type: "bytes32" },
  { name: "token", type: "address" },
  { name: "tokenAllowlistHash", type: "bytes32" },
  { name: "routeAllowlistHash", type: "bytes32" },
  { name: "manifestSha256", type: "bytes32" },
] as const;

export const MAINNET_WALLET_SETUP_TYPES = Object.freeze({
  MainnetWalletSetup: Object.freeze(
    mainnetWalletSetupTypeFields.map((field) => Object.freeze({ ...field })),
  ),
});

const eip712TypeFieldSchema = z.object({ name: z.string(), type: z.string() }).strict();
const exactMainnetWalletSetupTypeFieldsSchema = z
  .array(eip712TypeFieldSchema)
  .length(MAINNET_WALLET_SETUP_TYPES.MainnetWalletSetup.length)
  .superRefine((fields, context) => {
    for (const [index, expected] of MAINNET_WALLET_SETUP_TYPES.MainnetWalletSetup.entries()) {
      const actual = fields[index];
      if (actual?.name !== expected.name || actual.type !== expected.type) {
        context.addIssue({
          code: "custom",
          message: `Expected canonical MainnetWalletSetup EIP-712 field at index ${index}`,
        });
      }
    }
  });

export const mainnetWalletSetupTypedDataSchema = z
  .object({
    domain: z
      .object({
        name: z.literal("AgentPay Setup"),
        version: z.literal("1"),
        chainId: z.literal(MAINNET_SETUP_CHAIN_ID),
        verifyingContract: nonzeroEvmAddressSchema,
      })
      .strict(),
    types: z.object({ MainnetWalletSetup: exactMainnetWalletSetupTypeFieldsSchema }).strict(),
    primaryType: z.literal("MainnetWalletSetup"),
    message: mainnetWalletSetupMessageSchema,
  })
  .strict()
  .superRefine((typedData, context) => {
    if (typedData.domain.verifyingContract.toLowerCase() !== typedData.message.factory.toLowerCase()) {
      context.addIssue({
        code: "custom",
        message: "EIP-712 verifying contract must match the setup factory",
      });
    }
  });

export type MainnetWalletSetupTypedDataEnvelope = z.infer<typeof mainnetWalletSetupTypedDataSchema>;

export interface MainnetWalletSetupTypedData {
  readonly domain: Readonly<{
    name: "AgentPay Setup";
    version: "1";
    chainId: typeof MAINNET_SETUP_CHAIN_ID;
    verifyingContract: string;
  }>;
  readonly types: typeof MAINNET_WALLET_SETUP_TYPES;
  readonly primaryType: "MainnetWalletSetup";
  readonly message: Readonly<MainnetWalletSetupMessage>;
}

export const mainnetWalletSetupPolicyContextSchema = z
  .object({
    ownerAddress: nonzeroEvmAddressSchema,
    executorAddress: nonzeroEvmAddressSchema,
    factoryAddress: nonzeroEvmAddressSchema,
    factoryRuntimeCodeHash: bytes32Schema,
    deploymentSalt: bytes32Schema,
    predictedAccount: nonzeroEvmAddressSchema,
    accountCreationCodeHash: bytes32Schema,
    accountRuntimeCodeHash: bytes32Schema,
    manifestSha256: bytes32Schema,
    sponsorDeployerAddress: nonzeroEvmAddressSchema,
    currentUnixTime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

export type MainnetWalletSetupPolicyContext = z.infer<typeof mainnetWalletSetupPolicyContextSchema>;

export function createMainnetWalletSetupTypedData(
  input: MainnetWalletSetupMessage,
  policyContext: MainnetWalletSetupPolicyContext,
): MainnetWalletSetupTypedData {
  const message = mainnetWalletSetupMessageSchema.parse(input);
  const policy = mainnetWalletSetupPolicyContextSchema.parse(policyContext);
  const currentUnixTime = policy.currentUnixTime ?? Math.floor(Date.now() / 1_000);

  if (compareDecimalIntegerStrings(message.deadline, String(currentUnixTime)) <= 0) {
    throw new Error("Mainnet wallet setup deadline must be in the future.");
  }

  assertExpectedSetupPolicy(message, policy);
  assertDistinctSetupActors(message, policy.sponsorDeployerAddress);

  return Object.freeze({
    domain: Object.freeze({
      name: "AgentPay Setup" as const,
      version: "1" as const,
      chainId: MAINNET_SETUP_CHAIN_ID,
      verifyingContract: message.factory,
    }),
    types: MAINNET_WALLET_SETUP_TYPES,
    primaryType: "MainnetWalletSetup" as const,
    message: Object.freeze({ ...message }),
  });
}

export function toEip712Sha256Bytes32(bareDigest: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(bareDigest)) {
    throw new Error("Expected a bare 64-character SHA-256 hex digest.");
  }

  return `0x${bareDigest.toLowerCase()}`;
}

export const mainnetWalletSetupChallengeRequestSchema = z
  .object({ ownerAddress: nonzeroEvmAddressSchema })
  .strict();

export type MainnetWalletSetupChallengeRequest = z.infer<typeof mainnetWalletSetupChallengeRequestSchema>;

const base64Url32ByteSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, "Expected an unpadded 32-byte base64url value");

export const mainnetWalletSetupChallengeResponseSchema = z
  .object({
    capability: base64Url32ByteSchema,
    csrfToken: base64Url32ByteSchema,
    typedData: mainnetWalletSetupTypedDataSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict();

export type MainnetWalletSetupChallengeResponse = z.infer<typeof mainnetWalletSetupChallengeResponseSchema>;

export const mainnetWalletSetupAuthorizeRequestSchema = z.object({ signature: setupSignatureSchema }).strict();

export type MainnetWalletSetupAuthorizeRequest = z.infer<typeof mainnetWalletSetupAuthorizeRequestSchema>;

export const mainnetWalletSetupPublicStatusCodeSchema = z.enum([
  "SETUP_PENDING",
  "SETUP_DEPLOYING",
  "SETUP_COMPLETED",
  "SETUP_EXPIRED",
  "SETUP_FAILED",
  "SETUP_MANUAL_REVIEW",
]);

export type MainnetWalletSetupPublicStatusCode = z.infer<typeof mainnetWalletSetupPublicStatusCodeSchema>;

const publicCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, "Expected a stable uppercase public code");

export const mainnetWalletSetupPublicStatusSchema = z
  .object({
    setupIntentId: setupIntentIdSchema,
    status: mainnetWalletSetupPublicStatusCodeSchema,
    predictedAccount: nonzeroEvmAddressSchema.optional(),
    transactionHash: transactionHashSchema.optional(),
    publicCode: publicCodeSchema.optional(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    completedAt: isoTimestampSchema.optional(),
  })
  .strict();

export type MainnetWalletSetupPublicStatus = z.infer<typeof mainnetWalletSetupPublicStatusSchema>;

function assertExpectedSetupPolicy(
  message: MainnetWalletSetupMessage,
  policy: MainnetWalletSetupPolicyContext,
): void {
  const expectedFields = [
    ["owner", message.owner, policy.ownerAddress],
    ["executor", message.executor, policy.executorAddress],
    ["factory", message.factory, policy.factoryAddress],
    ["factoryRuntimeCodeHash", message.factoryRuntimeCodeHash, policy.factoryRuntimeCodeHash],
    ["deploymentSalt", message.deploymentSalt, policy.deploymentSalt],
    ["predictedAccount", message.predictedAccount, policy.predictedAccount],
    ["accountCreationCodeHash", message.accountCreationCodeHash, policy.accountCreationCodeHash],
    ["accountRuntimeCodeHash", message.accountRuntimeCodeHash, policy.accountRuntimeCodeHash],
    ["manifestSha256", message.manifestSha256, policy.manifestSha256],
  ] as const;

  for (const [fieldName, actual, expected] of expectedFields) {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`${fieldName} does not match the server-validated mainnet setup policy.`);
    }
  }
}

function compareDecimalIntegerStrings(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }

  return left === right ? 0 : left < right ? -1 : 1;
}

function assertDistinctSetupActors(message: MainnetWalletSetupMessage, sponsorDeployerAddress: string): void {
  const actors = [message.owner, message.executor, message.factory, sponsorDeployerAddress].map((address) =>
    address.toLowerCase(),
  );
  if (new Set(actors).size !== actors.length) {
    throw new Error("Owner, executor, factory, and sponsor deployer must be distinct addresses.");
  }
}
