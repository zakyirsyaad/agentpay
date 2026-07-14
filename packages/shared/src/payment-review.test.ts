import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getPaymentSignatureInputSchema, paymentReviewTokenSchema } from "./payment-review.ts";

describe("payment review schemas", () => {
  it("accepts only the opaque 256-bit review token shape", () => {
    const token = `apr_${"a".repeat(43)}`;
    assert.equal(paymentReviewTokenSchema.parse(token), token);
    assert.throws(() => paymentReviewTokenSchema.parse("apr_short"));
    assert.throws(() => paymentReviewTokenSchema.parse(`apr_${"a".repeat(42)}`));
  });

  it("rejects caller-supplied review authority fields", () => {
    assert.deepEqual(getPaymentSignatureInputSchema.parse({ paymentIntentId: "pay_123" }), {
      paymentIntentId: "pay_123",
    });
    assert.throws(() => getPaymentSignatureInputSchema.parse({ paymentIntentId: "pay_123", ownerAddress: "0x1" }));
  });
});
