import { z } from "zod";

export const paymentReviewTokenSchema = z
  .string()
  .regex(/^apr_[A-Za-z0-9_-]{43}$/, "Expected an opaque AgentPay review token");

export const paymentReviewSignatureSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{130}$/, "Expected a 65-byte EVM signature");

export const getPaymentSignatureInputSchema = z.object({
  paymentIntentId: z.string().trim().min(1),
}).strict();

export type GetPaymentSignatureInput = z.infer<typeof getPaymentSignatureInputSchema>;

export const paymentReviewHandoffStatusSchema = z.enum(["PENDING", "SIGNED"]);
export type PaymentReviewHandoffStatus = z.infer<typeof paymentReviewHandoffStatusSchema>;

export interface PaymentReviewHandoffRecord {
  id: string;
  paymentIntentId: string;
  tenantId: string;
  ownerAddress: string;
  accountAddress: string;
  sourceChainId: number;
  authorizationHash: string;
  tokenDigest: string;
  status: PaymentReviewHandoffStatus;
  signature?: string;
  createdAt: string;
  expiresAt: string;
  signedAt?: string;
}
