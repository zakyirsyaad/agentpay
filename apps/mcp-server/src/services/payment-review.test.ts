import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createPaymentReviewToken,
  createPaymentReviewUrl,
  hashPaymentReviewToken,
} from "./payment-review.ts";

describe("payment review capability", () => {
  it("creates a 256-bit opaque token and keyed digest", () => {
    const token = createPaymentReviewToken((size) => Uint8Array.from({ length: size }, (_, index) => index));

    assert.match(token, /^apr_[A-Za-z0-9_-]{43}$/);
    assert.equal(hashPaymentReviewToken(token, "secret").length, 66);
    assert.notEqual(hashPaymentReviewToken(token, "secret"), hashPaymentReviewToken(token, "other-secret"));
  });

  it("uses a fragment and does not duplicate the review path", () => {
    const token = createPaymentReviewToken(() => Uint8Array.from({ length: 32 }, () => 1));

    assert.equal(
      createPaymentReviewUrl("https://wallet.agentpay.site/setup", token),
      `https://wallet.agentpay.site/review#review_token=${token}`,
    );
    assert.equal(
      createPaymentReviewUrl("https://wallet.agentpay.site/review", token),
      `https://wallet.agentpay.site/review#review_token=${token}`,
    );
  });
});
