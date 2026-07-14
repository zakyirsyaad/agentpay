import { expect, test } from "@playwright/test";
import { Wallet } from "ethers";

import { createPaymentReviewE2eFixture } from "./payment-review-fixture.ts";
import { installMockWallet, setWalletAccount, setWalletChain, walletMethods } from "./eip1193-wallet.ts";

type ReviewFixture = Awaited<ReturnType<typeof createPaymentReviewE2eFixture>>;

let fixture: ReviewFixture;
let fixtureStarted = false;

test.beforeEach(async () => {
  fixture = await createPaymentReviewE2eFixture();
  fixtureStarted = true;
});

test.afterEach(async () => {
  if (fixtureStarted) {
    await fixture.server.close();
    fixtureStarted = false;
  }
});

test("completes prepare -> browser sign -> scoped signature handoff without a transaction", async ({ page }) => {
  const apiRequests: Array<{ method: string; url: string; token?: string }> = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/payment-review") {
      apiRequests.push({
        method: request.method(),
        url: request.url(),
        token: request.headers()["x-agentpay-review-token"],
      });
    }
  });
  await installMockWallet(page, {
    account: fixture.owner.address,
    chainIdHex: fixture.expectedChainHex,
    expectedTypedData: fixture.prepared.authorization,
    signature: fixture.signature,
  });

  await page.goto(fixture.prepared.reviewUrl!);
  await expect(page).toHaveURL(new URL("/review", fixture.server.url).toString());
  await expect(page.locator("#notice")).toContainText("Everything matches");
  await expect(page.locator("#summary")).toContainText(fixture.recipientAddress);
  await expect(page.locator("#summary")).toContainText("0 OKB");
  await expect(page.locator("#typed-data")).toContainText(fixture.prepared.authorization!.message.intentIdHash);
  expect((await fixture.pollSignature()).status).toBe("AWAITING_SIGNATURE");

  await page.locator("#sign").click();
  await expect(page.locator("#notice")).toContainText("Signature accepted");

  const signed = await fixture.pollSignature();
  expect(signed.status).toBe("SIGNED");
  expect(signed.signature).toBe(fixture.signature);
  expect(signed.authorizationHash).toBe(fixture.prepared.authorizationHash);
  expect(fixture.store.getIntent(fixture.prepared.paymentIntentId)?.status).toBe("AWAITING_APPROVAL");
  expect(fixture.store.getHandoff(fixture.prepared.paymentIntentId)?.tokenDigest).not.toBe(fixture.rawReviewToken);

  const methods = await walletMethods(page);
  expect(methods).toContain("eth_signTypedData_v4");
  expect(methods).not.toContain("eth_sendTransaction");
  expect(methods).not.toContain("eth_sendRawTransaction");
  expect(methods).not.toContain("wallet_sendCalls");
  expect(methods).not.toContain("personal_sign");
  expect(methods).not.toContain("eth_sign");
  expect(apiRequests.map((request) => request.method)).toEqual(["GET", "POST"]);
  expect(apiRequests.every((request) => request.token === fixture.rawReviewToken)).toBe(true);
  expect(apiRequests.every((request) => !request.url.includes(fixture.rawReviewToken))).toBe(true);

  const reopenedPage = await page.context().newPage();
  await installMockWallet(reopenedPage, {
    account: fixture.owner.address,
    chainIdHex: fixture.expectedChainHex,
    expectedTypedData: fixture.prepared.authorization,
    signature: fixture.signature,
  });
  await reopenedPage.goto(fixture.prepared.reviewUrl!);
  await expect(reopenedPage.locator("#notice")).toContainText("already signed");
  expect(await walletMethods(reopenedPage)).toEqual([]);
  await reopenedPage.close();
});

test("blocks a wrong owner and resumes only after accountsChanged matches the owner", async ({ page }) => {
  const otherOwner = new Wallet(`0x${"b".repeat(64)}`);
  await installMockWallet(page, {
    account: otherOwner.address,
    chainIdHex: fixture.expectedChainHex,
    expectedTypedData: fixture.prepared.authorization,
    signature: fixture.signature,
  });

  await page.goto(fixture.prepared.reviewUrl!);
  await expect(page.locator("#notice")).toContainText("Connect the owner wallet");
  await page.locator("#sign").click();
  await expect(page.locator("#notice")).toContainText("Connect the owner wallet");

  expect(await walletMethods(page)).not.toContain("eth_signTypedData_v4");
  expect((await fixture.pollSignature()).status).toBe("AWAITING_SIGNATURE");

  await setWalletAccount(page, fixture.owner.address);
  await expect(page.locator("#notice")).toContainText("Everything matches");
  await page.locator("#sign").click();
  await expect(page.locator("#notice")).toContainText("Signature accepted");
});

test("blocks the wrong chain and resumes only after chainChanged matches the source chain", async ({ page }) => {
  await installMockWallet(page, {
    account: fixture.owner.address,
    chainIdHex: "0xc4",
    expectedTypedData: fixture.prepared.authorization,
    signature: fixture.signature,
  });

  await page.goto(fixture.prepared.reviewUrl!);
  await expect(page.locator("#notice")).toContainText("Switch to the source X Layer network");
  expect(await walletMethods(page)).not.toContain("eth_signTypedData_v4");

  await setWalletChain(page, fixture.expectedChainHex);
  await expect(page.locator("#notice")).toContainText("Everything matches");
  await page.locator("#sign").click();
  await expect(page.locator("#notice")).toContainText("Signature accepted");
  expect(await walletMethods(page)).not.toContain("wallet_switchEthereumChain");
});

test("keeps an expired handoff non-executable", async ({ page }) => {
  fixture.setNow(fixture.prepared.summary.deadline);
  await installMockWallet(page, {
    account: fixture.owner.address,
    chainIdHex: fixture.expectedChainHex,
    expectedTypedData: fixture.prepared.authorization,
    signature: fixture.signature,
  });

  await page.goto(fixture.prepared.reviewUrl!);
  await expect(page.locator("#notice")).toContainText("Review unavailable");
  await expect(page.locator("#review")).toBeHidden();
  expect(await walletMethods(page)).toEqual([]);
  expect((await fixture.pollSignature()).status).toBe("EXPIRED");
});

test("keeps a rejected wallet signature pending and allows an intentional retry", async ({ page }) => {
  await installMockWallet(page, {
    account: fixture.owner.address,
    chainIdHex: fixture.expectedChainHex,
    expectedTypedData: fixture.prepared.authorization,
    signature: fixture.signature,
    rejectSignCount: 1,
  });

  await page.goto(fixture.prepared.reviewUrl!);
  await page.locator("#sign").click();
  await expect(page.locator("#notice")).toContainText("User rejected the signing request");
  await expect(page.locator("#sign")).toBeEnabled();
  expect((await fixture.pollSignature()).status).toBe("AWAITING_SIGNATURE");

  await page.locator("#sign").click();
  await expect(page.locator("#notice")).toContainText("Signature accepted");
  expect((await fixture.pollSignature()).status).toBe("SIGNED");
});

test("recovers the same signature after a lost response and rejects a conflicting signature", async ({ page }) => {
  let dropFirstPostResponse = true;
  await page.route("**/api/payment-review", async (route) => {
    if (route.request().method() === "POST" && dropFirstPostResponse) {
      dropFirstPostResponse = false;
      const response = await route.fetch();
      await response.body();
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await installMockWallet(page, {
    account: fixture.owner.address,
    chainIdHex: fixture.expectedChainHex,
    expectedTypedData: fixture.prepared.authorization,
    signature: fixture.signature,
  });

  await page.goto(fixture.prepared.reviewUrl!);
  await page.locator("#sign").click();
  await expect(page.locator("#sign")).toBeEnabled();
  expect((await fixture.pollSignature()).status).toBe("SIGNED");

  await page.locator("#sign").click();
  await expect(page.locator("#notice")).toContainText("Signature accepted");

  const otherOwner = new Wallet(`0x${"b".repeat(64)}`);
  const conflictingSignature = await otherOwner.signTypedData(
    fixture.prepared.authorization!.domain,
    fixture.prepared.authorization!.types as unknown as Record<string, Array<{ name: string; type: string }>>,
    fixture.prepared.authorization!.message,
  );
  const apiUrl = new URL("/api/payment-review", fixture.server.url);
  const conflict = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agentpay-review-token": fixture.rawReviewToken,
    },
    body: JSON.stringify({ signature: conflictingSignature }),
  });
  expect(conflict.status).toBe(409);
  expect(fixture.store.getHandoff(fixture.prepared.paymentIntentId)?.signature).toBe(fixture.signature);
});
