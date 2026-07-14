import { randomBytes } from "node:crypto";

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { Signature } from "ethers";

import {
  paymentReviewTokenSchema,
  type PaymentReviewHandoffRecord,
} from "@agentpay-ai/shared";

export interface PaymentReviewRepository {
  createPaymentReviewHandoff(record: PaymentReviewHandoffRecord): Promise<void>;
  getPaymentReviewHandoffByTokenDigest(tokenDigest: string): Promise<PaymentReviewHandoffRecord | null>;
  getPaymentReviewHandoff(paymentIntentId: string): Promise<PaymentReviewHandoffRecord | null>;
  attachPaymentReviewSignature(input: {
    tokenDigest: string;
    signature: string;
    signedAt: string;
  }): Promise<{ status: "SIGNED" | "ALREADY_SIGNED" | "CONFLICT"; signature?: string }>;
}

export function createPaymentReviewToken(
  randomByteSource: (size: number) => Uint8Array = (size) => randomBytes(size),
): string {
  return `apr_${Buffer.from(randomByteSource(32)).toString("base64url")}`;
}

export function hashPaymentReviewToken(token: string, secret = ""): string {
  const parsed = paymentReviewTokenSchema.parse(token);
  const digest = secret.length > 0
    ? hmac(sha256, utf8ToBytes(secret), utf8ToBytes(parsed))
    : sha256(utf8ToBytes(parsed));
  return `0x${bytesToHex(digest)}`;
}

export function createPaymentReviewUrl(reviewWebUrl: string, token: string): string {
  paymentReviewTokenSchema.parse(token);
  const url = new URL(reviewWebUrl);
  const currentPath = url.pathname.replace(/\/+$/, "");

  if (currentPath.endsWith("/setup")) {
    url.pathname = `${currentPath.slice(0, -"/setup".length)}/review` || "/review";
  } else if (currentPath.endsWith("/review")) {
    url.pathname = currentPath || "/review";
  } else {
    url.pathname = `${currentPath}/review` || "/review";
  }

  url.search = "";
  url.hash = `review_token=${encodeURIComponent(token)}`;
  return url.toString();
}

export function isStrictLowSSignature(signature: string): boolean {
  try {
    const parsed = Signature.from(signature);
    const halfOrder = BigInt("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");
    return parsed.v === 27 || parsed.v === 28 ? BigInt(parsed.s) <= halfOrder : false;
  } catch {
    return false;
  }
}
