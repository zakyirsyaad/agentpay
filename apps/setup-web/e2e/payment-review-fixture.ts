import { Wallet } from "ethers";

import {
  createPaymentReviewToken,
  getPaymentSignature,
  preparePayment,
  type PaymentReviewRepository,
} from "@agentpay-ai/mcp-server";
import type { PaymentIntentRecord, PaymentReviewHandoffRecord } from "@agentpay-ai/shared";

import { startSetupWebServer } from "../src/server.ts";

const tenantId = "00000000-0000-4000-8000-000000000025";
const accountAddress = "0x3333333333333333333333333333333333333333";
const recipientAddress = "0x1111111111111111111111111111111111111111";
const executorAddress = "0x4444444444444444444444444444444444444444";
const reviewSecret = "review-e2e-secret-012345678901234567890123";
const initialNow = Date.parse("2026-07-12T23:30:00.000Z");

export class InMemoryPaymentReviewStore {
  private readonly intents = new Map<string, PaymentIntentRecord>();
  private readonly handoffs = new Map<string, PaymentReviewHandoffRecord>();

  readonly paymentIntents = {
    createPaymentIntent: async (intent: PaymentIntentRecord) => {
      this.intents.set(intent.id, { ...intent });
    },
    getPaymentIntent: async (paymentIntentId: string) => {
      const intent = this.intents.get(paymentIntentId);
      return intent ? { ...intent } : null;
    },
    markPaymentFailed: async (paymentIntentId: string, errorCode: string, errorMessage: string) => {
      const intent = this.intents.get(paymentIntentId);
      if (intent) {
        this.intents.set(paymentIntentId, { ...intent, status: "FAILED", errorCode, errorMessage });
      }
    },
  };

  readonly paymentReviews: PaymentReviewRepository = {
    createPaymentReviewHandoff: async (record) => {
      this.handoffs.set(record.paymentIntentId, { ...record });
    },
    getPaymentReviewHandoffByTokenDigest: async (tokenDigest) => {
      const record = [...this.handoffs.values()].find((candidate) => candidate.tokenDigest === tokenDigest);
      return record ? { ...record } : null;
    },
    getPaymentReviewHandoff: async (paymentIntentId) => {
      const record = this.handoffs.get(paymentIntentId);
      return record ? { ...record } : null;
    },
    attachPaymentReviewSignature: async ({ tokenDigest, signature, signedAt }) => {
      const record = [...this.handoffs.values()].find((candidate) => candidate.tokenDigest === tokenDigest);
      if (!record) {
        return { status: "CONFLICT" };
      }
      if (record.status === "SIGNED") {
        return record.signature === signature
          ? { status: "ALREADY_SIGNED", signature: record.signature }
          : { status: "CONFLICT" };
      }
      this.handoffs.set(record.paymentIntentId, { ...record, status: "SIGNED", signature, signedAt });
      return { status: "SIGNED" };
    },
  };

  getIntent(paymentIntentId: string): PaymentIntentRecord | undefined {
    const intent = this.intents.get(paymentIntentId);
    return intent ? { ...intent } : undefined;
  }

  getHandoff(paymentIntentId: string): PaymentReviewHandoffRecord | undefined {
    const handoff = this.handoffs.get(paymentIntentId);
    return handoff ? { ...handoff } : undefined;
  }
}

export async function createPaymentReviewE2eFixture() {
  const owner = new Wallet(`0x${"a".repeat(64)}`);
  const store = new InMemoryPaymentReviewStore();
  const rawReviewToken = createPaymentReviewToken((size) => Uint8Array.from({ length: size }, () => 25));
  let now = initialNow;
  const clock = () => new Date(now);
  const server = await startSetupWebServer(
    {
      async getSetupIntent() {
        return null;
      },
      async completeWalletSetup() {
        throw new Error("Wallet setup is outside the Review & Sign E2E fixture.");
      },
      clock,
      paymentReviews: store.paymentReviews,
      paymentIntents: store.paymentIntents,
      reviewTokenSecret: reviewSecret,
    },
    { port: 0 },
  );
  try {
    const prepared = await preparePayment(
      {
        recipientAddress,
        destinationChainId: 1952,
        destinationTokenSymbol: "USDT0",
        sourceTokenSymbol: "USDT0",
        amountOut: "1",
        purpose: "I-002.5 browser integration proof",
        paymentType: "INVOICE_PAYMENT",
        network: "testnet",
      },
      {
        wallets: {
          async getActiveWallet() {
            return {
              tenantId,
              ownerAddress: owner.address,
              accountAddress,
              homeChainId: 1952,
              executorAddress,
              status: "ACTIVE",
            };
          },
        },
        routes: {
          async quotePaymentRoute() {
            throw new Error("The direct X Layer testnet path must not call a route provider.");
          },
        },
        balances: {
          async hasSufficientTokenBalance() {
            return true;
          },
        },
        paymentIntents: store.paymentIntents,
        paymentReviews: store.paymentReviews,
        clock,
        createId: () => "pay_review_e2e",
        createNonce: () => "25",
        createReviewToken: () => rawReviewToken,
        homeChainId: 1952,
        tenantId,
        setupWebUrl: server.url,
        reviewTokenSecret: reviewSecret,
      },
    );

    if (!prepared.reviewUrl || !prepared.authorization || !prepared.authorizationHash) {
      throw new Error("Review & Sign fixture did not create a canonical authorization handoff.");
    }

    const signature = await owner.signTypedData(
      prepared.authorization.domain,
      prepared.authorization.types as unknown as Record<string, Array<{ name: string; type: string }>>,
      prepared.authorization.message,
    );

    return {
      owner,
      store,
      server,
      prepared,
      rawReviewToken,
      signature,
      recipientAddress,
      expectedChainHex: `0x${prepared.authorization.domain.chainId.toString(16)}`,
      setNow(value: string | number | Date) {
        now = new Date(value).getTime();
      },
      pollSignature() {
        return getPaymentSignature(
          { paymentIntentId: prepared.paymentIntentId },
          { paymentReviews: store.paymentReviews, paymentIntents: store.paymentIntents, clock },
        );
      },
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}
