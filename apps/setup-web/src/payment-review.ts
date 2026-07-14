import { createHash, randomBytes } from "node:crypto";

import {
  createPaymentAuthorizationFromIntent,
  hashPaymentReviewToken,
  hashPaymentAuthorization,
  isStrictLowSSignature,
  verifyPaymentAuthorizationSignature,
  type PaymentReviewRepository,
} from "@agentpay-ai/mcp-server";
import {
  formatNativeAmount,
  paymentReviewSignatureSchema,
  paymentReviewTokenSchema,
  type PaymentIntentRecord,
} from "@agentpay-ai/shared";
import { z } from "zod";

const reviewSignatureBodySchema = z.object({
  signature: paymentReviewSignatureSchema,
}).strict();

export interface PaymentReviewWebDependencies {
  paymentReviews?: PaymentReviewRepository;
  paymentIntents?: {
    getPaymentIntent(paymentIntentId: string): Promise<PaymentIntentRecord | null>;
  };
  reviewTokenSecret?: string;
  clock: () => Date;
  rateLimiter?: PaymentReviewRateLimiter;
}

export interface PaymentReviewRateLimiter {
  allow(token: string, now: Date, clientId?: string): boolean;
  readonly entryCount: number;
  readonly clientEntryCount: number;
}

export interface PaymentReviewRateLimitOptions {
  windowMs?: number;
  maxEntries?: number;
  maxClientEntries?: number;
  maxRequestsPerToken?: number;
  maxRequestsPerClient?: number;
}

const maxReviewBodyBytes = 4096;
export const paymentReviewClientIdHeader = "x-agentpay-internal-client-id";

export function createPaymentReviewRateLimiter(
  options: PaymentReviewRateLimitOptions = {},
): PaymentReviewRateLimiter {
  const windowMs = positiveInteger(options.windowMs, 60_000);
  const maxEntries = positiveInteger(options.maxEntries, 1024);
  const maxClientEntries = positiveInteger(options.maxClientEntries, 1024);
  const maxRequestsPerToken = positiveInteger(options.maxRequestsPerToken, 60);
  const maxRequestsPerClient = positiveInteger(options.maxRequestsPerClient, 120);
  const entries = new Map<string, { windowStart: number; count: number }>();
  const clientEntries = new Map<string, { windowStart: number; count: number }>();

  return {
    get entryCount() {
      return entries.size;
    },
    get clientEntryCount() {
      return clientEntries.size;
    },
    allow(token, now, clientId = "direct") {
      const timestamp = now.getTime();
      const windowBoundary = timestamp - windowMs;
      const clientKey = createHash("sha256").update(clientId).digest("hex");
      if (!consumeRateLimitEntry({
        entries: clientEntries,
        key: clientKey,
        timestamp,
        windowBoundary,
        maxCount: maxRequestsPerClient,
        maxEntries: maxClientEntries,
      })) {
        return false;
      }

      const key = hashPaymentReviewToken(token);
      return consumeRateLimitEntry({
        entries,
        key,
        timestamp,
        windowBoundary,
        maxCount: maxRequestsPerToken,
        maxEntries,
      });
    },
  };
}

interface LoadedPaymentReview {
  handoff: NonNullable<Awaited<ReturnType<PaymentReviewRepository["getPaymentReviewHandoffByTokenDigest"]>>>;
  intent: PaymentIntentRecord;
  authorization: ReturnType<typeof createPaymentAuthorizationFromIntent>;
  authorizationHash: string;
  expiresAt: number;
}

export function createPaymentReviewPageResponse(): Response {
  const nonce = Buffer.from(randomBytes(18)).toString("base64");
  return new Response(renderPaymentReviewPage(nonce), {
    status: 200,
    headers: reviewHeaders({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    }),
  });
}

export function createPaymentReviewHandler(dependencies: PaymentReviewWebDependencies) {
  const rateLimiter = dependencies.rateLimiter ?? createPaymentReviewRateLimiter();

  return async (request: Request): Promise<Response> => {
    try {
      const token = request.headers.get("x-agentpay-review-token");
      const parsedToken = paymentReviewTokenSchema.safeParse(token);
      if (
        !parsedToken.success ||
        !rateLimiter.allow(
          parsedToken.data,
          dependencies.clock(),
          request.headers.get(paymentReviewClientIdHeader) ?? "direct",
        )
      ) {
        return reviewJsonResponse({ error: "Review unavailable." }, 404);
      }

      if (request.method === "GET") {
        return await handleOpenReview(parsedToken.data, dependencies);
      }

      if (request.method === "POST") {
        return await handleSubmitReview(request, parsedToken.data, dependencies);
      }

      return reviewJsonResponse({ error: "Method not allowed." }, 405);
    } catch {
      return reviewJsonResponse({ error: "Review unavailable." }, 503);
    }
  };
}

async function handleOpenReview(token: string, dependencies: PaymentReviewWebDependencies): Promise<Response> {
  const loaded = await loadPaymentReview(token, dependencies);
  if (!loaded || dependencies.clock().getTime() >= loaded.expiresAt) {
    return reviewJsonResponse({ error: "Review unavailable." }, 404);
  }

  return reviewJsonResponse({
    paymentIntentId: loaded.intent.id,
    status: loaded.handoff.status,
    authorization: loaded.authorization,
    authorizationHash: loaded.authorizationHash,
    summary: createReviewSummary(loaded.intent, loaded.authorization.domain.chainId, loaded.authorizationHash),
  });
}

async function handleSubmitReview(
  request: Request,
  token: string,
  dependencies: PaymentReviewWebDependencies,
): Promise<Response> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return reviewJsonResponse({ error: "Invalid review request." }, 415);
  }
  let body: unknown;
  try {
    const rawBody = await readBoundedRequestBody(request, maxReviewBodyBytes);
    if (rawBody === undefined) {
      return reviewJsonResponse({ error: "Review unavailable." }, 413);
    }
    body = JSON.parse(rawBody);
  } catch {
    return reviewJsonResponse({ error: "Invalid review request." }, 400);
  }

  const parsedBody = reviewSignatureBodySchema.safeParse(body);
  if (!parsedBody.success || !dependencies.paymentReviews) {
    return reviewJsonResponse({ error: "Invalid review request." }, 400);
  }

  const loaded = await loadPaymentReview(token, dependencies);
  if (!loaded || dependencies.clock().getTime() >= loaded.expiresAt) {
    return reviewJsonResponse({ error: "Review unavailable." }, 404);
  }

  if (loaded.handoff.status === "SIGNED") {
    return loaded.handoff.signature === parsedBody.data.signature
      ? reviewJsonResponse({
          paymentIntentId: loaded.intent.id,
          status: "SIGNED",
          authorizationHash: loaded.authorizationHash,
        })
      : reviewJsonResponse({ error: "Review unavailable." }, 409);
  }

  if (
    !isStrictLowSSignature(parsedBody.data.signature) ||
    !verifyPaymentAuthorizationSignature({
      typedData: loaded.authorization,
      signature: parsedBody.data.signature,
      expectedOwner: loaded.intent.ownerAddress,
    })
  ) {
    return reviewJsonResponse({ error: "Signature does not match the owner wallet." }, 400);
  }

  const result = await dependencies.paymentReviews.attachPaymentReviewSignature({
    tokenDigest: hashPaymentReviewToken(token, dependencies.reviewTokenSecret),
    signature: parsedBody.data.signature,
    signedAt: dependencies.clock().toISOString(),
  });

  if (result.status === "CONFLICT") {
    return reviewJsonResponse({ error: "Review unavailable." }, 409);
  }

  return reviewJsonResponse({
    paymentIntentId: loaded.intent.id,
    status: "SIGNED",
    authorizationHash: loaded.authorizationHash,
  });
}

async function loadPaymentReview(
  token: string,
  dependencies: PaymentReviewWebDependencies,
): Promise<LoadedPaymentReview | null> {
  if (!dependencies.paymentReviews || !dependencies.paymentIntents) {
    return null;
  }

  const handoff = await dependencies.paymentReviews.getPaymentReviewHandoffByTokenDigest(
    hashPaymentReviewToken(token, dependencies.reviewTokenSecret),
  );
  if (!handoff) {
    return null;
  }

  const intent = await dependencies.paymentIntents.getPaymentIntent(handoff.paymentIntentId);
  if (
    !intent ||
    intent.status !== "AWAITING_APPROVAL" ||
    !intent.tenantId ||
    intent.tenantId !== handoff.tenantId ||
    intent.ownerAddress.toLowerCase() !== handoff.ownerAddress.toLowerCase() ||
    intent.accountAddress.toLowerCase() !== handoff.accountAddress.toLowerCase() ||
    intent.sourceChainId !== handoff.sourceChainId
  ) {
    return null;
  }

  let authorization: ReturnType<typeof createPaymentAuthorizationFromIntent>;
  try {
    authorization = createPaymentAuthorizationFromIntent(intent, handoff.tenantId);
  } catch {
    return null;
  }

  const authorizationHash = hashPaymentAuthorization(authorization);
  if (authorizationHash.toLowerCase() !== handoff.authorizationHash.toLowerCase()) {
    return null;
  }

  const expiresAt = Math.min(Date.parse(intent.deadline), Date.parse(handoff.expiresAt));
  if (!Number.isFinite(expiresAt)) {
    return null;
  }

  return { handoff, intent, authorization, authorizationHash, expiresAt };
}

function createReviewSummary(intent: PaymentIntentRecord, sourceChainId: number, authorizationHash: string) {
  return {
    paymentType: intent.paymentType,
    ownerAddress: intent.ownerAddress,
    accountAddress: intent.accountAddress,
    sourceChainId,
    destinationChainId: intent.destinationChainId,
    sourceTokenAddress: intent.sourceTokenAddress,
    sourceTokenSymbol: intent.sourceTokenSymbol,
    destinationTokenAddress: intent.destinationTokenAddress,
    destinationTokenSymbol: intent.destinationTokenSymbol,
    recipientAddress: intent.recipientAddress,
    amountOut: intent.amountOut,
    minAmountOut: intent.minAmountOut,
    maxAmountIn: intent.maxAmountIn,
    maxNativeFee: intent.maxNativeFee,
    maxNativeFeeDisplay: formatNativeAmount(intent.maxNativeFee, sourceChainId),
    nativeValue: intent.nativeValue,
    nativeValueDisplay: formatNativeAmount(intent.nativeValue ?? "0", sourceChainId),
    routeProvider: intent.routeProvider,
    routeTarget: intent.routeTarget,
    routeCalldataHash: intent.routeCalldataHash,
    routeSummary: intent.routeSummary,
    purpose: intent.purpose,
    nonce: intent.nonce,
    deadline: intent.deadline,
    authorizationHash,
  };
}

async function readBoundedRequestBody(request: Request, maxBytes: number): Promise<string | undefined> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    return undefined;
  }
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function consumeRateLimitEntry(input: {
  entries: Map<string, { windowStart: number; count: number }>;
  key: string;
  timestamp: number;
  windowBoundary: number;
  maxCount: number;
  maxEntries: number;
}): boolean {
  const stored = input.entries.get(input.key);
  const active = !stored || stored.windowStart <= input.windowBoundary
    ? { windowStart: input.timestamp, count: 0 }
    : stored;
  if (active.count >= input.maxCount) {
    return false;
  }

  if (input.entries.size >= input.maxEntries) {
    pruneExpiredRateLimitEntries(input.entries, input.windowBoundary);
  }
  input.entries.delete(input.key);
  input.entries.set(input.key, { ...active, count: active.count + 1 });
  trimOldestRateLimitEntries(input.entries, input.maxEntries);
  return true;
}

function pruneExpiredRateLimitEntries(
  entries: Map<string, { windowStart: number; count: number }>,
  windowBoundary: number,
): void {
  for (const [key, entry] of entries) {
    if (entry.windowStart <= windowBoundary) {
      entries.delete(key);
    }
  }
}

function trimOldestRateLimitEntries(
  entries: Map<string, { windowStart: number; count: number }>,
  maxEntries: number,
): void {
  while (entries.size > maxEntries) {
    const oldestKey = entries.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    entries.delete(oldestKey);
  }
}

function reviewJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: reviewHeaders({ "content-type": "application/json" }),
  });
}

function reviewHeaders(headers: Record<string, string>): HeadersInit {
  return {
    ...headers,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function renderPaymentReviewPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentPay Review &amp; Sign</title>
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #070707; color: #f4f4f4; }
      body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #222 0, #070707 48%); }
      main { width: min(900px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 72px; }
      .eyebrow { color: #aaa; font-size: 12px; letter-spacing: .14em; text-transform: uppercase; }
      h1 { font-size: clamp(32px, 6vw, 58px); line-height: 1; margin: 8px 0 18px; }
      .lede { color: #c8c8c8; max-width: 660px; line-height: 1.6; }
      .panel { margin-top: 30px; border: 1px solid #343434; border-radius: 18px; background: rgba(18,18,18,.92); padding: 24px; }
      .notice { border-radius: 12px; background: #232323; color: #ddd; padding: 14px; line-height: 1.45; }
      .notice[data-tone="error"] { background: #3b1b1b; color: #ffb8b8; }
      .notice[data-tone="success"] { background: #183326; color: #b4f0cb; }
      dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin: 22px 0; }
      dt { color: #999; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
      dd { margin: 6px 0 0; overflow-wrap: anywhere; }
      code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #0b0b0b; border: 1px solid #2b2b2b; border-radius: 12px; padding: 16px; max-height: 320px; overflow: auto; }
      button { border: 0; border-radius: 999px; background: #f4f4f4; color: #090909; font: inherit; font-weight: 700; padding: 13px 22px; cursor: pointer; }
      button:disabled { cursor: not-allowed; opacity: .45; }
      .fine-print { color: #999; font-size: 13px; line-height: 1.55; }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">AgentPay / owner authorization</p>
      <h1>Review &amp; Sign</h1>
      <p class="lede">Review the exact payment details below. Your EIP-712 signature authorizes only these details. This page never sends a payment transaction.</p>
      <section class="panel" aria-live="polite">
        <div id="notice" class="notice">Loading payment review...</div>
        <div id="review" hidden>
          <dl id="summary"></dl>
          <p class="eyebrow">Canonical authorization</p>
          <pre id="typed-data">-</pre>
          <button id="sign" type="button" disabled>Connect wallet to Review &amp; Sign</button>
          <p class="fine-print">The connected wallet must match the owner and source X Layer network. Signing is a gasless message signature; no OKB, token approval, or transaction is requested.</p>
        </div>
      </section>
    </main>
    <script nonce="${nonce}">
      (() => {
        const state = { token: new URLSearchParams(window.location.hash.slice(1)).get("review_token") || "", payload: null };
        const notice = document.getElementById("notice");
        const review = document.getElementById("review");
        const summary = document.getElementById("summary");
        const typedData = document.getElementById("typed-data");
        const sign = document.getElementById("sign");
        const ethereum = [window.okxwallet, window.ethereum].find(
          (candidate) => candidate && typeof candidate.request === "function",
        );

        history.replaceState(null, document.title, window.location.pathname);

        const setNotice = (message, tone = "info") => { notice.textContent = message; notice.dataset.tone = tone; };
        const addField = (label, value) => {
          const wrapper = document.createElement("div");
          const dt = document.createElement("dt"); dt.textContent = label;
          const dd = document.createElement("dd"); dd.textContent = value === undefined || value === null || value === "" ? "—" : String(value);
          wrapper.append(dt, dd); summary.append(wrapper);
        };
        const chainHex = (chainId) => "0x" + Number(chainId).toString(16);
        const accountMatches = (account, expected) => String(account).toLowerCase() === String(expected).toLowerCase();
        const checkWallet = async () => {
          if (!ethereum || !state.payload) return false;
          const accounts = await ethereum.request({ method: "eth_accounts" });
          const chainId = await ethereum.request({ method: "eth_chainId" });
          if (!accounts?.[0] || !accountMatches(accounts[0], state.payload.summary.ownerAddress)) {
            setNotice("Connect the owner wallet shown in the review details.", "error"); sign.disabled = false; sign.textContent = "Connect owner wallet"; return false;
          }
          if (String(chainId).toLowerCase() !== chainHex(state.payload.authorization.domain.chainId).toLowerCase()) {
            setNotice("Switch to the source X Layer network before signing.", "error"); sign.disabled = false; sign.textContent = "Switch network to sign"; return false;
          }
          setNotice("Everything matches. Review the details, then sign the authorization."); sign.disabled = false; sign.textContent = "Review & Sign"; return true;
        };
        const connectAndSign = async () => {
          if (!ethereum || !state.payload) { setNotice("No compatible EVM wallet was found.", "error"); return; }
          sign.disabled = true;
          try {
            await ethereum.request({ method: "eth_requestAccounts" });
            if (!await checkWallet()) return;
            const accounts = await ethereum.request({ method: "eth_accounts" });
            const signature = await ethereum.request({ method: "eth_signTypedData_v4", params: [accounts[0], JSON.stringify(state.payload.authorization)] });
            const response = await fetch("/api/payment-review", { method: "POST", headers: { "content-type": "application/json", "x-agentpay-review-token": state.token }, body: JSON.stringify({ signature }) });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || "Signature handoff failed.");
            state.token = "";
            sign.disabled = true;
            setNotice("Signature accepted. Return to chat; no payment transaction was sent from this page.", "success");
          } catch (error) {
            sign.disabled = false;
            setNotice(error instanceof Error ? error.message : "Wallet signing was cancelled.", "error");
          }
        };
        const load = async () => {
          if (!state.token) { setNotice("This review link is incomplete or expired.", "error"); return; }
          try {
            const response = await fetch("/api/payment-review", { headers: { "x-agentpay-review-token": state.token } });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || "Review unavailable.");
            state.payload = body;
            review.hidden = false;
            const fields = [
              ["Payment", body.summary.amountOut + " " + body.summary.destinationTokenSymbol], ["Payment type", body.summary.paymentType],
              ["Owner", body.summary.ownerAddress], ["Agent account", body.summary.accountAddress], ["Recipient", body.summary.recipientAddress],
              ["Source chain", body.summary.sourceChainId], ["Destination chain", body.summary.destinationChainId],
              ["Source token", body.summary.sourceTokenSymbol + " · " + body.summary.sourceTokenAddress], ["Destination token", body.summary.destinationTokenSymbol + " · " + body.summary.destinationTokenAddress],
              ["Source spend cap", body.summary.maxAmountIn + " " + body.summary.sourceTokenSymbol], ["Minimum output", body.summary.minAmountOut ? body.summary.minAmountOut + " " + body.summary.destinationTokenSymbol : "—"],
              ["Native value", body.summary.nativeValueDisplay], ["Native fee cap", body.summary.maxNativeFeeDisplay], ["Route", body.summary.routeSummary],
              ["Route target", body.summary.routeTarget], ["Route calldata hash", body.summary.routeCalldataHash],
              ["Purpose", body.summary.purpose], ["Nonce", body.summary.nonce], ["Deadline", body.summary.deadline], ["Authorization hash", body.authorizationHash]
            ];
            fields.forEach(([label, value]) => addField(label, value));
            typedData.textContent = JSON.stringify(body.authorization, null, 2);
            if (body.status === "SIGNED") { sign.disabled = true; setNotice("This payment is already signed. Return to chat to continue execution.", "success"); return; }
            sign.addEventListener("click", connectAndSign);
            if (!ethereum) { setNotice("Open this page in a browser with an EVM wallet.", "error"); return; }
            ethereum.on?.("accountsChanged", () => { void checkWallet(); }); ethereum.on?.("chainChanged", () => { void checkWallet(); });
            await checkWallet();
          } catch (error) { setNotice(error instanceof Error ? error.message : "Review unavailable.", "error"); }
        };
        void load();
      })();
    </script>
  </body>
</html>`;
}
