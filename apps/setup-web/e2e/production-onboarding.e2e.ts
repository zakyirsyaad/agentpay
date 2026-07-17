import { expect, test } from "@playwright/test";
import { TypedDataEncoder, Wallet } from "ethers";

import { createPaymentReviewE2eFixture } from "./payment-review-fixture.ts";
import { createProductionOnboardingE2eFixture } from "./production-onboarding-fixture.ts";
import {
  installMockWallet,
  setWalletAccount,
  setWalletChain,
  walletMethods,
} from "./eip1193-wallet.ts";

type OnboardingFixture = Awaited<ReturnType<typeof createProductionOnboardingE2eFixture>>;

let fixture: OnboardingFixture;
let fixtureStarted = false;

test.beforeEach(async () => {
  fixture = await createProductionOnboardingE2eFixture();
  fixtureStarted = true;
});

test.afterEach(async () => {
  if (fixtureStarted) {
    await fixture.close();
    fixtureStarted = false;
  }
});

test("production onboarding completes setup-required -> signed sponsorship -> OAuth retry", async ({ page }) => {
  expect(fixture.oauthState()).toEqual({
    status: 409,
    state: "AGENTPAY_SETUP_REQUIRED",
    setupUrl: "https://onboard.agentpay.site/setup",
  });
  await installOnboardingWallet(page, fixture);
  await page.goto(fixture.url);
  await expect(page.locator("h1")).toHaveText("Create your AgentPay wallet");

  await page.locator("#action").click();
  await expect(page.locator("#status")).toContainText("Check every field");
  await expect(page.locator("#details")).toContainText(fixture.owner.address.toLowerCase());
  await expect(page.locator("#details")).toContainText("196");

  await page.locator("#action").click();
  await expect(page.locator("#status")).toContainText("Deployment status: SETUP_PENDING");
  expect(await fixture.runWorkerStart()).toMatchObject({ status: "BROADCAST" });
  await expect(page.locator("#status")).toContainText("SETUP_DEPLOYING", { timeout: 5_000 });
  expect(await fixture.settleAndComplete()).toMatchObject({ status: "COMPLETED" });
  await expect(page.locator("#status")).toHaveText("Setup completed. Return to chat to continue.", { timeout: 5_000 });

  const [job] = fixture.stores.inspect.jobs();
  expect(job?.status).toBe("COMPLETED");
  expect(job?.rawTransaction?.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(job?.rawTransaction?.ciphertext).not.toBe(fixture.broadcastAttempts[0]);
  expect(job?.rawTransaction?.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(fixture.broadcastAttempts).toHaveLength(1);
  expect(fixture.oauthState()).toEqual({ status: 200, state: "OAUTH_READY" });
  expect(await walletMethods(page)).toContain("eth_signTypedData_v4");
  expect(await walletMethods(page)).not.toContain("eth_sendTransaction");
});

test("production onboarding lets an existing active user bypass sponsorship", async () => {
  const existing = await createProductionOnboardingE2eFixture({ existingUser: true });
  try {
    expect(existing.oauthState()).toEqual({ status: 200, state: "OAUTH_READY" });
    expect(existing.stores.inspect.jobs()).toHaveLength(0);
    expect(existing.broadcastAttempts).toHaveLength(0);
  } finally {
    await existing.close();
  }
});

test("production onboarding blocks wrong chain and wrong wallet while duplicate clicks stay idempotent", async ({ page }) => {
  await installOnboardingWallet(page, fixture, "0x1");
  await page.goto(fixture.url);
  await page.locator("#action").click();
  await expect(page.locator("#status")).toContainText("Switch the owner wallet to X Layer mainnet");
  expect(fixture.stores.inspect.events()).toHaveLength(0);

  await setWalletChain(page, "0xc4");
  await page.locator("#action").click();
  await expect(page.locator("#status")).toContainText("Check every field");
  const wrongOwner = new Wallet(`0x${"c".repeat(64)}`);
  await setWalletAccount(page, wrongOwner.address);
  await page.locator("#action").click();
  await expect(page.locator("#status")).toContainText("does not match the setup owner");
  expect(await walletMethods(page)).not.toContain("eth_signTypedData_v4");

  await setWalletAccount(page, fixture.owner.address);
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>("#action")!;
    button.click();
    button.click();
  });
  await expect(page.locator("#status")).toContainText("SETUP_PENDING");
  expect(fixture.stores.inspect.jobs()).toHaveLength(1);
  expect(fixture.stores.inspect.events().filter((event) => event.eventType === "SETUP_ADMITTED")).toHaveLength(1);
});

test("production onboarding fails closed on expiry, lost response, and reload without capability", async ({ page }) => {
  await installOnboardingWallet(page, fixture);
  await page.goto(fixture.url);
  await page.locator("#action").click();
  await expect(page.locator("#status")).toContainText("Check every field");
  fixture.advanceTime(601_000);
  await page.locator("#action").click();
  await expect(page.locator("#status")).toContainText(/unavailable/i);
  expect(fixture.stores.inspect.jobs()).toHaveLength(0);

  await page.reload();
  await page.locator("#action").click();
  await expect(page.locator("#status")).toContainText(/unavailable/i);
  expect(fixture.stores.inspect.events().filter((event) => event.eventType === "SETUP_CHALLENGE_CREATED")).toHaveLength(1);

  const lost = await createProductionOnboardingE2eFixture();
  const lostPage = await page.context().newPage();
  try {
    let dropFirstResponse = true;
    await lostPage.route("**/api/setup/challenge", async (route) => {
      if (dropFirstResponse) {
        dropFirstResponse = false;
        const response = await route.fetch();
        await response.body();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await installOnboardingWallet(lostPage, lost);
    await lostPage.goto(lost.url);
    await lostPage.locator("#action").click();
    await expect(lostPage.locator("#status")).not.toBeEmpty();
    await lostPage.locator("#action").click();
    await expect(lostPage.locator("#status")).toContainText("Check every field");
    expect(lost.stores.inspect.events().filter((event) => event.eventType === "SETUP_CHALLENGE_CREATED")).toHaveLength(1);
  } finally {
    await lostPage.close();
    await lost.close();
  }
});

test("production onboarding survives web and worker restart with an identical rebroadcast", async ({ page }) => {
  await fixture.close();
  fixture = await createProductionOnboardingE2eFixture({ failBroadcastRecordOnce: true });
  await installOnboardingWallet(page, fixture);
  await page.goto(fixture.url);
  await page.locator("#action").click();
  await page.locator("#action").click();
  await expect(page.locator("#status")).toContainText("SETUP_PENDING");

  await fixture.restartWeb();
  await expect(fixture.runWorkerStart()).rejects.toThrow("simulated lost database response");
  expect(fixture.stores.inspect.jobs()[0]?.status).toBe("SIGNED");
  expect(await fixture.restartWorkerAndRebroadcast()).toMatchObject({ status: "BROADCAST" });
  expect(fixture.broadcastAttempts).toHaveLength(2);
  expect(fixture.broadcastAttempts[1]).toBe(fixture.broadcastAttempts[0]);
  expect(await fixture.settleAndComplete()).toMatchObject({ status: "COMPLETED" });
  await expect(page.locator("#status")).toContainText("Setup completed", { timeout: 5_000 });
});

test("production onboarding enforces OFF, DRAIN, rate-limit, and manual-review states", async ({ page }) => {
  for (const options of [{ mode: "OFF" as const }, { mode: "DRAIN" as const }, { rateLimited: true }]) {
    const gated = await createProductionOnboardingE2eFixture(options);
    const gatedPage = await page.context().newPage();
    try {
      await installOnboardingWallet(gatedPage, gated);
      await gatedPage.goto(gated.url);
      await gatedPage.locator("#action").click();
      await expect(gatedPage.locator("#status")).toContainText(
        options.rateLimited ? "SETUP_RATE_LIMITED" : "SETUP_NOT_ACCEPTING_CHALLENGES",
      );
      expect(gated.stores.inspect.jobs()).toHaveLength(0);
    } finally {
      await gatedPage.close();
      await gated.close();
    }
  }

  const review = await createProductionOnboardingE2eFixture({ failVerification: true });
  const reviewPage = await page.context().newPage();
  try {
    await installOnboardingWallet(reviewPage, review);
    await reviewPage.goto(review.url);
    await reviewPage.locator("#action").click();
    await reviewPage.locator("#action").click();
    expect(await review.runWorkerStart()).toMatchObject({ status: "BROADCAST" });
    expect(await review.settleAndComplete()).toMatchObject({ status: "MANUAL_REVIEW" });
    await expect(reviewPage.locator("#status")).toContainText("SETUP_MANUAL_REVIEW", { timeout: 5_000 });
    expect(review.oauthState().state).toBe("AGENTPAY_SETUP_REQUIRED");
  } finally {
    await reviewPage.close();
    await review.close();
  }
});

test("production onboarding rollout leaves the Review & Sign route available", async ({ page }) => {
  const review = await createPaymentReviewE2eFixture();
  try {
    await installMockWallet(page, {
      account: review.owner.address,
      chainIdHex: review.expectedChainHex,
      expectedTypedData: TypedDataEncoder.getPayload(
        review.prepared.authorization!.domain,
        review.prepared.authorization!.types as unknown as Record<string, Array<{ name: string; type: string }>>,
        review.prepared.authorization!.message,
      ),
      signature: review.signature,
    });
    await page.goto(review.prepared.reviewUrl!);
    await expect(page.locator("#notice")).toContainText("Everything matches");
    await page.locator("#sign").click();
    await expect(page.locator("#notice")).toContainText("Signature accepted");
  } finally {
    await review.server.close();
  }
});

async function installOnboardingWallet(
  page: Parameters<typeof installMockWallet>[0],
  current: OnboardingFixture,
  chainIdHex = "0xc4",
) {
  await installMockWallet(page, {
    account: current.owner.address,
    chainIdHex,
    expectedTypedData: {
      ...current.typedData,
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        ...current.typedData.types,
      },
    },
    signature: current.ownerSignature,
  });
}
