import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { evmAddressSchema, hexDataSchema } from "./payment-intent.ts";

export const AGENT_PAY_EIP712_DOMAIN_NAME = "AgentPay" as const;
export const AGENT_PAY_EIP712_DOMAIN_VERSION = "1" as const;
export const AGENT_PAY_ACCOUNT_VERSION = "v2" as const;
export const DIRECT_PAYMENT_AUTHORIZATION_KIND = "DIRECT_PAYMENT" as const;
export const ROUTE_PAYMENT_AUTHORIZATION_KIND = "ROUTE_PAYMENT" as const;

export interface AgentPayEip712Domain {
  name: typeof AGENT_PAY_EIP712_DOMAIN_NAME;
  version: typeof AGENT_PAY_EIP712_DOMAIN_VERSION;
  chainId: number;
  verifyingContract: string;
}

export interface DirectPaymentAuthorization {
  intentIdHash: string;
  tenantIdHash: string;
  paymentType: string;
  owner: string;
  account: string;
  token: string;
  recipient: string;
  amount: string;
  nonce: string;
  deadline: string;
  purposeHash: string;
}

export interface RoutePaymentAuthorization {
  intentIdHash: string;
  tenantIdHash: string;
  paymentType: string;
  owner: string;
  account: string;
  sourceToken: string;
  maxAmountIn: string;
  destinationChainId: string;
  destinationToken: string;
  recipient: string;
  minAmountOut: string;
  routeTarget: string;
  routeCalldataHash: string;
  maxNativeFee: string;
  nonce: string;
  deadline: string;
  purposeHash: string;
}

export interface AgentPayTypedData<TMessage> {
  domain: AgentPayEip712Domain;
  primaryType: "DirectPaymentAuthorization" | "RoutePaymentAuthorization";
  types: TMessage extends DirectPaymentAuthorization
    ? typeof DIRECT_PAYMENT_AUTHORIZATION_TYPES
    : typeof ROUTE_PAYMENT_AUTHORIZATION_TYPES;
  message: TMessage;
}

export const DIRECT_PAYMENT_AUTHORIZATION_TYPES = {
  DirectPaymentAuthorization: [
    { name: "intentIdHash", type: "bytes32" },
    { name: "tenantIdHash", type: "bytes32" },
    { name: "paymentType", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "account", type: "address" },
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "purposeHash", type: "bytes32" },
  ],
} as const;

export const ROUTE_PAYMENT_AUTHORIZATION_TYPES = {
  RoutePaymentAuthorization: [
    { name: "intentIdHash", type: "bytes32" },
    { name: "tenantIdHash", type: "bytes32" },
    { name: "paymentType", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "account", type: "address" },
    { name: "sourceToken", type: "address" },
    { name: "maxAmountIn", type: "uint256" },
    { name: "destinationChainId", type: "uint256" },
    { name: "destinationToken", type: "address" },
    { name: "recipient", type: "address" },
    { name: "minAmountOut", type: "uint256" },
    { name: "routeTarget", type: "address" },
    { name: "routeCalldataHash", type: "bytes32" },
    { name: "maxNativeFee", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "purposeHash", type: "bytes32" },
  ],
} as const;

export function createAgentPayEip712Domain(input: {
  chainId: number;
  verifyingContract: string;
}): AgentPayEip712Domain {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new Error(`Invalid EIP-712 chain ID: ${input.chainId}`);
  }

  return {
    name: AGENT_PAY_EIP712_DOMAIN_NAME,
    version: AGENT_PAY_EIP712_DOMAIN_VERSION,
    chainId: input.chainId,
    verifyingContract: evmAddressSchema.parse(input.verifyingContract),
  };
}

export function createDirectPaymentTypedData(input: {
  chainId: number;
  verifyingContract: string;
  intentId: string;
  tenantId: string;
  owner: string;
  account: string;
  token: string;
  recipient: string;
  amount: string;
  nonce: string;
  deadline: string;
  purpose: string;
}): AgentPayTypedData<DirectPaymentAuthorization> {
  const message: DirectPaymentAuthorization = {
    intentIdHash: hashUtf8(input.intentId),
    tenantIdHash: hashRequiredUtf8(input.tenantId, "tenantId"),
    paymentType: hashUtf8(DIRECT_PAYMENT_AUTHORIZATION_KIND),
    owner: evmAddressSchema.parse(input.owner),
    account: evmAddressSchema.parse(input.account),
    token: evmAddressSchema.parse(input.token),
    recipient: evmAddressSchema.parse(input.recipient),
    amount: positiveUint256String(input.amount, "amount"),
    nonce: uint256String(input.nonce, "nonce"),
    deadline: positiveUint256String(input.deadline, "deadline"),
    purposeHash: hashRequiredUtf8(input.purpose, "purpose"),
  };

  return {
    domain: createAgentPayEip712Domain(input),
    primaryType: "DirectPaymentAuthorization",
    types: DIRECT_PAYMENT_AUTHORIZATION_TYPES,
    message,
  };
}

export function createRoutePaymentTypedData(input: {
  chainId: number;
  verifyingContract: string;
  intentId: string;
  tenantId: string;
  owner: string;
  account: string;
  sourceToken: string;
  maxAmountIn: string;
  destinationChainId: string;
  destinationToken: string;
  recipient: string;
  minAmountOut: string;
  routeTarget: string;
  routeCalldataHash: string;
  maxNativeFee: string;
  nonce: string;
  deadline: string;
  purpose: string;
}): AgentPayTypedData<RoutePaymentAuthorization> {
  const message: RoutePaymentAuthorization = {
    intentIdHash: hashUtf8(input.intentId),
    tenantIdHash: hashRequiredUtf8(input.tenantId, "tenantId"),
    paymentType: hashUtf8(ROUTE_PAYMENT_AUTHORIZATION_KIND),
    owner: evmAddressSchema.parse(input.owner),
    account: evmAddressSchema.parse(input.account),
    sourceToken: evmAddressSchema.parse(input.sourceToken),
    maxAmountIn: positiveUint256String(input.maxAmountIn, "maxAmountIn"),
    destinationChainId: positiveUint256String(input.destinationChainId, "destinationChainId"),
    destinationToken: evmAddressSchema.parse(input.destinationToken),
    recipient: evmAddressSchema.parse(input.recipient),
    minAmountOut: positiveUint256String(input.minAmountOut, "minAmountOut"),
    routeTarget: evmAddressSchema.parse(input.routeTarget),
    routeCalldataHash: bytes32(input.routeCalldataHash, "routeCalldataHash"),
    maxNativeFee: uint256String(input.maxNativeFee, "maxNativeFee"),
    nonce: uint256String(input.nonce, "nonce"),
    deadline: positiveUint256String(input.deadline, "deadline"),
    purposeHash: hashRequiredUtf8(input.purpose, "purpose"),
  };

  return {
    domain: createAgentPayEip712Domain(input),
    primaryType: "RoutePaymentAuthorization",
    types: ROUTE_PAYMENT_AUTHORIZATION_TYPES,
    message,
  };
}

export function hashUtf8(value: string): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(value)))}`;
}

function hashRequiredUtf8(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} is required for an owner authorization.`);
  }

  return hashUtf8(value);
}

function bytes32(value: string, fieldName: string): string {
  const parsed = hexDataSchema.parse(value);
  if (parsed.length !== 66) {
    throw new Error(`${fieldName} must be a 32-byte hex value.`);
  }

  return parsed;
}

function uint256String(value: string, fieldName: string): string {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${fieldName} must be a non-negative integer string.`);
  }

  return value;
}

function positiveUint256String(value: string, fieldName: string): string {
  const parsed = uint256String(value, fieldName);
  if (parsed === "0") {
    throw new Error(`${fieldName} must be greater than zero.`);
  }

  return parsed;
}
