import { z } from "zod";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { getChainName } from "./chains.ts";
import { evmAddressSchema, preparePaymentInputSchema, type PaymentIntentRecord } from "./payment-intent.ts";
import { getStableTokenMetadata, STABLE_TOKEN_SYMBOLS, stableTokenSymbolSchema } from "./tokens.ts";
import type { StableTokenSymbol } from "./tokens.ts";

const positiveIntegerStringSchema = z.string().regex(/^[1-9]\d*$/, "Expected a positive integer string");
const PAYMENT_IDENTIFIER = "payment-identifier";
const paymentIdentifierSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

export const parseX402PaymentRequiredInputSchema = z.object({
  paymentRequired: z.union([z.string().trim().min(1), z.record(z.string(), z.unknown())]),
  sourceTokenSymbol: stableTokenSymbolSchema.default("USDT0"),
});

export type ParseX402PaymentRequiredInput = z.input<typeof parseX402PaymentRequiredInputSchema>;

const retryX402HttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET");

export const retryX402RequestInputSchema = z.object({
  paymentRequired: parseX402PaymentRequiredInputSchema.shape.paymentRequired,
  paymentIntentId: z.string().trim().min(1),
  request: z
    .object({
      url: z.string().url().optional(),
      method: retryX402HttpMethodSchema,
      headers: z.record(z.string(), z.string()).default({}),
      body: z.string().optional(),
    })
    .default({ method: "GET", headers: {} }),
});

export type RetryX402RequestInput = z.input<typeof retryX402RequestInputSchema>;
export type ParsedRetryX402RequestInput = z.output<typeof retryX402RequestInputSchema>;

const x402ResourceInfoSchema = z
  .object({
    url: z.string().url(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    serviceName: z.string().optional(),
  })
  .passthrough();

const x402PaymentRequirementSchema = z
  .object({
    scheme: z.string(),
    network: z.string(),
    amount: positiveIntegerStringSchema,
    asset: z.string(),
    payTo: evmAddressSchema,
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const x402PaymentRequiredSchema = z
  .object({
    x402Version: z.literal(2),
    error: z.string().optional(),
    resource: x402ResourceInfoSchema,
    accepts: z.array(x402PaymentRequirementSchema).min(1),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export interface ParsedX402PaymentRequired {
  x402Version: 2;
  resource: {
    url: string;
    description?: string;
    serviceName?: string;
    mimeType?: string;
  };
  selectedRequirement: {
    scheme: "exact";
    network: string;
    chainId: number;
    chain: string;
    asset: string;
    tokenSymbol: StableTokenSymbol;
    payTo: string;
    amountAtomic: string;
    amount: string;
    maxTimeoutSeconds: number;
  };
  paymentInput: {
    recipientAddress: string;
    destinationChainId: number;
    destinationChain: string;
    destinationTokenSymbol: StableTokenSymbol;
    amountOut: string;
    purpose: string;
    sourceTokenSymbol: StableTokenSymbol;
    paymentType: "X402_PAYMENT";
  };
  extensions?: {
    "payment-identifier"?: {
      info: {
        required: boolean;
      };
    };
  };
  standardX402SignatureRequired: true;
}

export interface AgentPayX402PaymentProof {
  x402Version: 2;
  scheme: "agentpay-receipt";
  paymentIntentId: string;
  paymentType: "X402_PAYMENT";
  payer: string;
  ownerAddress: string;
  resourceUrl: string;
  requirementHash: string;
  network: string;
  chainId: number;
  asset: string;
  payTo: string;
  amount: string;
  amountDecimal: string;
  sourceTxHash: string;
  destinationTxHash?: string;
  settlementTxHash: string;
  completedAt?: string;
  paymentIdentifier?: string;
  extensions?: {
    "payment-identifier"?: {
      info: {
        required: boolean;
        id: string;
      };
    };
  };
}

export function parseX402PaymentRequired(rawInput: ParseX402PaymentRequiredInput): ParsedX402PaymentRequired {
  const input = parseX402PaymentRequiredInputSchema.parse(rawInput);
  const paymentRequired = x402PaymentRequiredSchema.parse(decodePaymentRequired(input.paymentRequired));
  const selected = paymentRequired.accepts.map(toSupportedRequirement).find((requirement) => requirement !== null);
  const paymentIdentifierExtension = parsePaymentIdentifierExtension(paymentRequired.extensions);

  if (!selected) {
    throw new Error("No AgentPay-supported x402 payment requirement was found.");
  }

  const purpose = createX402Purpose(paymentRequired.resource);
  const paymentInput = preparePaymentInputSchema.parse({
    recipientAddress: selected.payTo,
    destinationChainId: selected.chainId,
    destinationTokenSymbol: selected.tokenSymbol,
    amountOut: selected.amount,
    purpose,
    sourceTokenSymbol: input.sourceTokenSymbol,
    paymentType: "X402_PAYMENT",
  });

  return {
    x402Version: 2,
    resource: {
      url: paymentRequired.resource.url,
      description: paymentRequired.resource.description,
      serviceName: paymentRequired.resource.serviceName,
      mimeType: paymentRequired.resource.mimeType,
    },
    selectedRequirement: selected,
    paymentInput: {
      recipientAddress: paymentInput.recipientAddress,
      destinationChainId: paymentInput.destinationChainId,
      destinationChain: getChainName(paymentInput.destinationChainId),
      destinationTokenSymbol: paymentInput.destinationTokenSymbol,
      amountOut: paymentInput.amountOut,
      purpose: paymentInput.purpose,
      sourceTokenSymbol: paymentInput.sourceTokenSymbol,
      paymentType: "X402_PAYMENT",
    },
    ...(paymentIdentifierExtension
      ? {
          extensions: {
            [PAYMENT_IDENTIFIER]: paymentIdentifierExtension,
          },
        }
      : {}),
    standardX402SignatureRequired: true,
  };
}

export function createAgentPayX402PaymentHeader(request: {
  parsed: ParsedX402PaymentRequired;
  paymentIntent: PaymentIntentRecord;
}): string {
  return encodeBase64UrlJson(createAgentPayX402PaymentProof(request));
}

export function decodeAgentPayX402PaymentHeader(header: string): AgentPayX402PaymentProof {
  const decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as unknown;
  return agentPayX402PaymentProofSchema.parse(decoded);
}

export function createAgentPayX402PaymentProof(request: {
  parsed: ParsedX402PaymentRequired;
  paymentIntent: PaymentIntentRecord;
}): AgentPayX402PaymentProof {
  const { parsed, paymentIntent } = request;
  const selected = parsed.selectedRequirement;

  validateCompletedX402Intent(parsed, paymentIntent);

  const settlementTxHash = paymentIntent.destinationTxHash ?? paymentIntent.sourceTxHash;
  const paymentIdentifierExtension = parsed.extensions?.[PAYMENT_IDENTIFIER];
  const paymentIdentifier = paymentIdentifierExtension ? createPaymentIdentifier(paymentIntent.id) : undefined;

  return {
    x402Version: 2,
    scheme: "agentpay-receipt",
    paymentIntentId: paymentIntent.id,
    paymentType: "X402_PAYMENT",
    payer: paymentIntent.accountAddress,
    ownerAddress: paymentIntent.ownerAddress,
    resourceUrl: parsed.resource.url,
    requirementHash: createX402RequirementHash(parsed),
    network: selected.network,
    chainId: selected.chainId,
    asset: selected.asset,
    payTo: selected.payTo,
    amount: selected.amountAtomic,
    amountDecimal: selected.amount,
    sourceTxHash: paymentIntent.sourceTxHash!,
    ...(paymentIntent.destinationTxHash ? { destinationTxHash: paymentIntent.destinationTxHash } : {}),
    settlementTxHash: settlementTxHash!,
    ...(paymentIntent.completedAt ? { completedAt: paymentIntent.completedAt } : {}),
    ...(paymentIdentifier
      ? {
          paymentIdentifier,
          extensions: {
            [PAYMENT_IDENTIFIER]: {
              info: {
                required: paymentIdentifierExtension!.info.required,
                id: paymentIdentifier,
              },
            },
          },
        }
      : {}),
  };
}

export function createX402RequirementHash(parsed: ParsedX402PaymentRequired): string {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(stableStringify({
    resourceUrl: parsed.resource.url,
    selectedRequirement: parsed.selectedRequirement,
  }))))}`;
}

function decodePaymentRequired(paymentRequired: string | Record<string, unknown>): unknown {
  if (typeof paymentRequired !== "string") {
    return paymentRequired;
  }

  const trimmed = paymentRequired.trim();
  const json = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");

  return JSON.parse(json) as unknown;
}

const agentPayX402PaymentProofSchema = z.object({
  x402Version: z.literal(2),
  scheme: z.literal("agentpay-receipt"),
  paymentIntentId: z.string().min(1),
  paymentType: z.literal("X402_PAYMENT"),
  payer: evmAddressSchema,
  ownerAddress: evmAddressSchema,
  resourceUrl: z.string().url(),
  requirementHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  network: z.string().min(1),
  chainId: z.number().int().positive(),
  asset: z.string().min(1),
  payTo: evmAddressSchema,
  amount: positiveIntegerStringSchema,
  amountDecimal: z.string().min(1),
  sourceTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  destinationTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  settlementTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  completedAt: z.string().optional(),
  paymentIdentifier: paymentIdentifierSchema.optional(),
  extensions: z
    .object({
      "payment-identifier": z
        .object({
          info: z.object({
            required: z.boolean(),
            id: paymentIdentifierSchema,
          }),
        })
        .optional(),
    })
    .optional(),
});

function validateCompletedX402Intent(parsed: ParsedX402PaymentRequired, paymentIntent: PaymentIntentRecord): void {
  if (paymentIntent.status !== "COMPLETED") {
    throw new Error(`Payment intent ${paymentIntent.id} must be COMPLETED before x402 proof can be generated.`);
  }

  if (paymentIntent.paymentType !== "X402_PAYMENT") {
    throw new Error(`Payment intent ${paymentIntent.id} must be an X402_PAYMENT intent.`);
  }

  if (!paymentIntent.sourceTxHash) {
    throw new Error(`Payment intent ${paymentIntent.id} is missing a source transaction hash.`);
  }

  const selected = parsed.selectedRequirement;
  const matchesRequirement =
    paymentIntent.destinationChainId === selected.chainId &&
    paymentIntent.destinationTokenAddress.toLowerCase() === selected.asset.toLowerCase() &&
    paymentIntent.destinationTokenSymbol === selected.tokenSymbol &&
    paymentIntent.recipientAddress.toLowerCase() === selected.payTo.toLowerCase() &&
    paymentIntent.amountOut === selected.amount;

  if (!matchesRequirement) {
    throw new Error(`Payment intent ${paymentIntent.id} does not match the x402 requirement.`);
  }
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parsePaymentIdentifierExtension(
  extensions: Record<string, unknown> | undefined,
): ParsedX402PaymentRequired["extensions"] extends infer Extensions
  ? Extensions extends { "payment-identifier"?: infer Extension }
    ? Extension | undefined
    : never
  : never {
  const extension = extensions?.[PAYMENT_IDENTIFIER];

  if (extension === undefined) {
    return undefined;
  }

  if (!extension || typeof extension !== "object") {
    throw new Error("Unsupported x402 payment-identifier extension.");
  }

  const info = (extension as { info?: unknown }).info;

  if (!info || typeof info !== "object" || typeof (info as { required?: unknown }).required !== "boolean") {
    throw new Error("Unsupported x402 payment-identifier extension.");
  }

  return {
    info: {
      required: (info as { required: boolean }).required,
    },
  };
}

function createPaymentIdentifier(paymentIntentId: string): string {
  return paymentIdentifierSchema.parse(paymentIntentId);
}

function toSupportedRequirement(requirement: z.infer<typeof x402PaymentRequirementSchema>):
  | ParsedX402PaymentRequired["selectedRequirement"]
  | null {
  if (requirement.scheme !== "exact") {
    return null;
  }

  const chainId = parseEip155Network(requirement.network);

  if (!chainId) {
    return null;
  }

  const tokenSymbol = findStableTokenSymbolByAddress(chainId, requirement.asset);

  if (!tokenSymbol) {
    return null;
  }

  const token = getStableTokenMetadata(chainId, tokenSymbol);

  return {
    scheme: "exact",
    network: requirement.network,
    chainId,
    chain: getChainName(chainId),
    asset: requirement.asset,
    tokenSymbol,
    payTo: requirement.payTo,
    amountAtomic: requirement.amount,
    amount: atomicToDecimal(BigInt(requirement.amount), token.decimals),
    maxTimeoutSeconds: requirement.maxTimeoutSeconds,
  };
}

function parseEip155Network(network: string): number | null {
  const match = network.match(/^eip155:(\d+)$/);

  return match ? Number(match[1]) : null;
}

function findStableTokenSymbolByAddress(chainId: number, asset: string): StableTokenSymbol | null {
  const normalizedAsset = asset.toLowerCase();

  for (const symbol of STABLE_TOKEN_SYMBOLS) {
    try {
      if (getStableTokenMetadata(chainId, symbol).address.toLowerCase() === normalizedAsset) {
        return symbol;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function atomicToDecimal(amount: bigint, decimals: number): string {
  const padded = amount.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fractional = padded.slice(-decimals).replace(/0+$/, "");

  return fractional ? `${whole}.${fractional}` : whole;
}

function createX402Purpose(resource: z.infer<typeof x402ResourceInfoSchema>): string {
  const details = [resource.serviceName, resource.description].filter(Boolean).join(": ") || resource.url;

  return `x402 payment for ${details}`.slice(0, 280);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
