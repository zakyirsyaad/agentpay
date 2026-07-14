import {
  getPaymentSignatureInputSchema,
  type PaymentIntentRecord,
  type GetPaymentSignatureInput,
} from "@agentpay-ai/shared";

import {
  createPaymentAuthorizationFromIntent,
  hashPaymentAuthorization,
  verifyPaymentAuthorizationSignature,
} from "../services/payment-authorization.ts";
import { isStrictLowSSignature, type PaymentReviewRepository } from "../services/payment-review.ts";

export const getPaymentSignatureTool = {
  name: "get_payment_signature",
  description:
    "Polls a tenant-scoped Review & Sign handoff and returns the owner EIP-712 signature when it is available. This never executes a payment.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["paymentIntentId"],
    properties: {
      paymentIntentId: { type: "string" },
    },
  },
};

export interface GetPaymentSignatureDependencies {
  paymentReviews?: PaymentReviewRepository;
  paymentIntents: {
    getPaymentIntent(paymentIntentId: string): Promise<PaymentIntentRecord | null>;
  };
  clock: () => Date;
}

export interface GetPaymentSignatureOutput {
  paymentIntentId: string;
  status: "AWAITING_SIGNATURE" | "SIGNED" | "EXPIRED";
  authorizationHash: string;
  signature?: string;
}

export async function getPaymentSignature(
  rawInput: GetPaymentSignatureInput,
  dependencies: GetPaymentSignatureDependencies,
): Promise<GetPaymentSignatureOutput> {
  const input = getPaymentSignatureInputSchema.parse(rawInput);
  if (!dependencies.paymentReviews) {
    throw new Error("Payment review handoff is not configured.");
  }
  const handoff = await dependencies.paymentReviews.getPaymentReviewHandoff(input.paymentIntentId);
  const intent = await dependencies.paymentIntents.getPaymentIntent(input.paymentIntentId);

  if (!handoff || !intent || !intent.tenantId || handoff.tenantId !== intent.tenantId) {
    throw new Error("Payment review handoff is unavailable.");
  }

  if (
    handoff.ownerAddress.toLowerCase() !== intent.ownerAddress.toLowerCase() ||
    handoff.accountAddress.toLowerCase() !== intent.accountAddress.toLowerCase() ||
    handoff.sourceChainId !== intent.sourceChainId
  ) {
    throw new Error("Payment review handoff is unavailable.");
  }

  const authorization = createPaymentAuthorizationFromIntent(intent, intent.tenantId);
  const authorizationHash = hashPaymentAuthorization(authorization);
  if (authorizationHash.toLowerCase() !== handoff.authorizationHash.toLowerCase()) {
    throw new Error("Payment review authorization is no longer valid.");
  }

  const expiresAt = Math.min(Date.parse(intent.deadline), Date.parse(handoff.expiresAt));
  if (!Number.isFinite(expiresAt) || dependencies.clock().getTime() >= expiresAt) {
    return {
      paymentIntentId: intent.id,
      status: "EXPIRED",
      authorizationHash,
    };
  }

  if (handoff.status !== "SIGNED" || !handoff.signature) {
    return {
      paymentIntentId: intent.id,
      status: "AWAITING_SIGNATURE",
      authorizationHash,
    };
  }

  if (
    !isStrictLowSSignature(handoff.signature) ||
    !verifyPaymentAuthorizationSignature({
      typedData: authorization,
      signature: handoff.signature,
      expectedOwner: intent.ownerAddress,
    })
  ) {
    throw new Error("Payment review authorization is no longer valid.");
  }

  return {
    paymentIntentId: intent.id,
    status: "SIGNED",
    authorizationHash,
    signature: handoff.signature,
  };
}

export function createGetPaymentSignatureHandler(dependencies: GetPaymentSignatureDependencies) {
  return (input: GetPaymentSignatureInput) => getPaymentSignature(input, dependencies);
}
