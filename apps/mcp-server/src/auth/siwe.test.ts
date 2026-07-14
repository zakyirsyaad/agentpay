import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { describe, it } from "node:test";

import {
  createSiweChallenge,
  verifySiweChallengeSignature,
  type SiweChallenge,
} from "./siwe.ts";

const wallet = new Wallet(`0x${"1".repeat(64)}`);
const otherWallet = new Wallet(`0x${"2".repeat(64)}`);
const clock = () => new Date("2026-07-12T00:00:00.000Z");

function challenge(overrides: Partial<Parameters<typeof createSiweChallenge>[0]> = {}): SiweChallenge {
  return createSiweChallenge({
    challengeId: "challenge_123",
    requestId: "request_123",
    domain: "wallet.agentpay.site",
    uri: "https://wallet.agentpay.site/mcp",
    ownerAddress: wallet.address,
    accountAddress: "0x3333333333333333333333333333333333333333",
    chainId: 1952,
    nonce: "nonce_1234567890",
    issuedAt: clock().toISOString(),
    expiresAt: new Date(clock().getTime() + 5 * 60_000).toISOString(),
    scopes: ["wallet:read", "payment:prepare", "payment:read", "payment:review", "session:manage"],
    ...overrides,
  });
}

describe("SIWE consumer challenge", () => {
  it("binds the wallet, consumer URI, account, scopes, and explicit no-payment consent", async () => {
    const record = challenge();

    assert.match(record.message, /^wallet\.agentpay\.site wants you to sign in with your Ethereum account:/);
    assert.match(record.message, new RegExp(wallet.address));
    assert.match(record.message, /URI: https:\/\/wallet\.agentpay\.site\/mcp/);
    assert.match(record.message, /Chain ID: 1952/);
    assert.match(record.message, /Nonce: nonce_1234567890/);
    assert.match(record.message, /Request ID: request_123/);
    assert.match(record.message, /Session Lifetime: 604800 seconds/);
    assert.match(record.message, /urn:agentpay:account:0x3333333333333333333333333333333333333333/);
    assert.match(record.message, /urn:agentpay:scope:payment:review/);
    assert.match(record.message, /does not authorize a payment or token transfer/i);
    assert.equal(await verifySiweChallengeSignature(record, await wallet.signMessage(record.message), clock()), wallet.address);
  });

  it("rejects a wrong signer, altered challenge, and expired challenge", async () => {
    const record = challenge();
    const signature = await wallet.signMessage(record.message);

    await assert.rejects(
      verifySiweChallengeSignature(record, await otherWallet.signMessage(record.message), clock()),
      /SIWE signer does not match the challenge owner/i,
    );

    await assert.rejects(
      verifySiweChallengeSignature({ ...record, message: `${record.message}\nattacker` }, signature, clock()),
      /SIWE message does not match the issued challenge/i,
    );

    await assert.rejects(
      verifySiweChallengeSignature(record, signature, new Date(new Date(record.expiresAt).getTime())),
      /SIWE challenge expired/i,
    );

    await assert.rejects(
      verifySiweChallengeSignature(
        { ...record, uri: "https://evil.example/mcp" } as unknown as SiweChallenge,
        signature,
        clock(),
      ),
      /SIWE challenge binding is invalid/i,
    );
  });

  it("rejects malformed signatures and invalid challenge fields", async () => {
    assert.throws(
      () => challenge({ domain: "evil.example.com" }),
      /SIWE domain must be wallet\.agentpay\.site/i,
    );

    await assert.rejects(
      verifySiweChallengeSignature(challenge(), "0x1234", clock()),
      /invalid SIWE signature/i,
    );
  });

  it("rejects challenges with non-finite timestamps even when the message matches", async () => {
    const record = challenge();
    const invalidIssuedAt = {
      ...record,
      issuedAt: "not-a-date",
      message: record.message.replace(record.issuedAt, "not-a-date"),
    } as SiweChallenge;
    const invalidExpiresAt = {
      ...record,
      expiresAt: "not-a-date",
      message: record.message.replace(record.expiresAt, "not-a-date"),
    } as SiweChallenge;

    await assert.rejects(
      verifySiweChallengeSignature(invalidIssuedAt, await wallet.signMessage(invalidIssuedAt.message), clock()),
      /SIWE challenge timestamps are invalid/i,
    );
    await assert.rejects(
      verifySiweChallengeSignature(invalidExpiresAt, await wallet.signMessage(invalidExpiresAt.message), clock()),
      /SIWE challenge timestamps are invalid/i,
    );
  });
});
