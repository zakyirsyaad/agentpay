import { createServer, type IncomingMessage } from "node:http";
import { isIP } from "node:net";

import {
  checkWalletCreationInputSchema,
  completeWalletSetupInputSchema,
  type CompleteWalletSetupInput,
  type SetupIntentRecord,
} from "@agentpay-ai/shared";

import type { CompleteWalletSetupOutput } from "./services/complete-wallet-setup.ts";
import {
  createPaymentReviewHandler,
  createPaymentReviewPageResponse,
  paymentReviewClientIdHeader,
  type PaymentReviewWebDependencies,
} from "./payment-review.ts";

export interface SetupWebDependencies {
  getSetupIntent(setupIntentId: string): Promise<SetupIntentRecord | null>;
  completeWalletSetup(input: CompleteWalletSetupInput): Promise<CompleteWalletSetupOutput>;
  clock: () => Date;
  paymentReviews?: PaymentReviewWebDependencies["paymentReviews"];
  paymentIntents?: PaymentReviewWebDependencies["paymentIntents"];
  reviewTokenSecret?: string;
  rateLimiter?: PaymentReviewWebDependencies["rateLimiter"];
}

export function createSetupWebHandler(dependencies: SetupWebDependencies) {
  const paymentReviewHandler = createPaymentReviewHandler(dependencies);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/review" && request.method === "GET") {
      return createPaymentReviewPageResponse();
    }

    if (url.pathname === "/api/payment-review") {
      return paymentReviewHandler(request);
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/setup")) {
      return htmlResponse(renderSetupPage());
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/setup-intents/")) {
      return handleGetSetupIntent(url.pathname, dependencies);
    }

    if (request.method === "POST" && url.pathname === "/api/setup-complete") {
      return handleSetupComplete(request, dependencies);
    }

    return jsonResponse({ error: "Not found." }, 404);
  };
}

export function renderSetupPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentPay setup</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Newsreader:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Public+Sans:wght@400;500;600;700&display=swap"
      rel="stylesheet"
    />
    <style>${setupPageCss}</style>
  </head>
  <body>
    <main class="setup-shell" id="setup-root">
      <nav class="setup-nav" aria-label="Setup">
        <span class="setup-wordmark" aria-hidden="true">AgentPay</span>
        <span class="status-pill" id="status-pill" data-tone="loading">Loading</span>
      </nav>

      <section class="setup-hero">
        <p class="setup-eyebrow">AgentPay setup</p>
        <h1 id="setup-title">Create the wallet your agent can use with approval.</h1>
        <p class="setup-subhead">
          Connect the owner wallet, review the setup message, and sign. This only proves ownership — it does not approve a payment or token transfer.
        </p>
      </section>

      <section class="setup-panel" aria-labelledby="setup-title">
        <div class="notice" id="notice" role="status">Loading setup intent...</div>

        <div class="flow" id="flow" data-flow="pending">
          <ol class="steps" aria-label="Setup steps">
            <li class="step step--connect" id="step-connect" data-state="pending">
              <span class="step-index" aria-hidden="true">01</span>
              <div class="step-body">
                <h2 class="step-title">Connect your wallet</h2>
                <p class="step-hint">Use the wallet that should own this agent wallet.</p>
                <div class="step-receipt" id="connect-receipt" hidden>
                  <span class="receipt-label">Connected</span>
                  <code class="receipt-value" id="connect-account">—</code>
                </div>
                <button class="primary-action" id="connect-button" type="button">Connect wallet</button>
              </div>
            </li>

            <li class="step step--sign" id="step-sign" data-state="pending">
              <span class="step-index" aria-hidden="true">02</span>
              <div class="step-body">
                <h2 class="step-title">Review &amp; sign</h2>
                <p class="step-hint">Read the message below before signing with your wallet.</p>
                <label class="message-label" for="message-to-sign">Message to sign</label>
                <pre class="message-box" id="message-to-sign">-</pre>
                <button class="primary-action" id="sign-button" type="button" disabled>Sign setup message</button>
              </div>
            </li>
          </ol>

          <aside class="intent-meta" aria-label="Setup details">
            <p class="meta-eyebrow">Setup details</p>
            <dl class="intent-grid">
              <div>
                <dt>Setup intent</dt>
                <dd id="setup-intent-id">-</dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd id="owner-address">-</dd>
              </div>
              <div>
                <dt>Executor</dt>
                <dd id="executor-address">-</dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd id="expires-at">-</dd>
              </div>
            </dl>
            <p class="footnote">
              This signature only proves wallet ownership for setup. It does not approve a payment or token transfer.
            </p>
          </aside>
        </div>
      </section>
    </main>
    <script>
      window.AgentPaySetup = ${clientScript};
      window.AgentPaySetup.start();
    </script>
  </body>
</html>`;
}

export async function startSetupWebServer(
  dependencies: SetupWebDependencies,
  options: { port?: number; hostname?: string } = {},
): Promise<{ close(): Promise<void>; url: string }> {
  const handler = createSetupWebHandler(dependencies);
  const server = createServer(async (request, response) => {
    try {
      const origin = `http://${request.headers.host ?? "localhost"}`;
      const headers = new Headers(request.headers as HeadersInit);
      headers.set(paymentReviewClientIdHeader, resolveReviewClientId(request));
      const webRequest = new Request(new URL(request.url ?? "/", origin), {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request,
        duplex: "half",
      } as RequestInit);
      const webResponse = await handler(webRequest);

      response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch {
      response.writeHead(503, {
        "cache-control": "no-store",
        "content-type": "application/json",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify({ error: "Service unavailable." }));
    }
  });
  const port = options.port ?? 3000;
  const hostname = options.hostname ?? "127.0.0.1";

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Setup web server did not expose a TCP address.");
  }

  return {
    url: `http://${hostname}:${address.port}/setup`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function resolveReviewClientId(request: IncomingMessage): string {
  const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress ?? "unknown");
  const forwarded = request.headers["x-forwarded-for"];
  const forwardedValues = Array.isArray(forwarded) ? forwarded : forwarded ? [forwarded] : [];
  const forwardedAddress = forwardedValues
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .at(-1);

  if (isLoopbackAddress(remoteAddress) && forwardedAddress && isIP(forwardedAddress) > 0) {
    return normalizeRemoteAddress(forwardedAddress);
  }
  return remoteAddress;
}

function normalizeRemoteAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

async function handleGetSetupIntent(pathname: string, dependencies: SetupWebDependencies): Promise<Response> {
  const setupIntentId = decodeURIComponent(pathname.replace("/api/setup-intents/", ""));
  const input = checkWalletCreationInputSchema.parse({ setupIntentId });
  const intent = await dependencies.getSetupIntent(input.setupIntentId);

  if (!intent) {
    return jsonResponse({ error: `Setup intent ${input.setupIntentId} was not found.` }, 404);
  }

  return jsonResponse({
    setupIntentId: intent.id,
    ownerAddress: intent.ownerAddress,
    executorAddress: intent.executorAddress,
    messageToSign: intent.messageToSign,
    status: pendingExpiredStatus(intent, dependencies.clock()),
    expiresAt: intent.expiresAt,
    accountAddress: intent.accountAddress,
    completedAt: intent.completedAt,
  });
}

async function handleSetupComplete(request: Request, dependencies: SetupWebDependencies): Promise<Response> {
  try {
    const input = completeWalletSetupInputSchema.parse(await request.json());
    return jsonResponse(await dependencies.completeWalletSetup(input));
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Setup completion failed." }, 400);
  }
}

function pendingExpiredStatus(intent: SetupIntentRecord, now: Date): SetupIntentRecord["status"] {
  return ["PENDING", "SIGNED", "DEPLOYING"].includes(intent.status) && new Date(intent.expiresAt).getTime() <= now.getTime()
    ? "EXPIRED"
    : intent.status;
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

const setupPageCss = `
:root {
  color-scheme: dark;
  --color-cream: #050505;
  --color-tan: #0f0f0f;
  --color-paper: #171717;
  --color-ink: #f4f4f4;
  --color-soft: #c9c9c9;
  --color-muted: #a3a3a3;
  --color-muted-strong: #b8b8b8;
  --color-accent: #f4f4f4;
  --color-accent-hover: #d8d8d8;
  --color-accent-pale: #252525;
  --color-border-subtle: rgba(255, 255, 255, 0.12);
  --color-border-muted: rgba(255, 255, 255, 0.16);
  --color-border-strong: rgba(255, 255, 255, 0.28);
  --color-surface-glint: rgba(255, 255, 255, 0.05);
  --font-newsreader: "Newsreader", Georgia, "Times New Roman", serif;
  --font-public-sans: "Public Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-plex-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-family: var(--font-public-sans);
}

* {
  box-sizing: border-box;
}

html {
  min-width: 320px;
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background: var(--color-cream);
  color: var(--color-ink);
  font-family: var(--font-public-sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

button,
pre {
  font: inherit;
}

a,
button {
  -webkit-tap-highlight-color: transparent;
}

:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 3px;
}

::selection {
  background: var(--color-accent-pale);
  color: var(--color-ink);
}

.setup-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--color-cream);
}

.setup-nav {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px clamp(20px, 5vw, 64px);
  border-bottom: 1px solid var(--color-border-subtle);
  background: rgba(5, 5, 5, 0.9);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.setup-wordmark {
  font-family: var(--font-newsreader);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--color-ink);
}

.status-pill {
  flex: 0 0 auto;
  border-radius: 100px;
  border: 1px solid var(--color-border-muted);
  background: var(--color-tan);
  color: var(--color-soft);
  padding: 7px 14px;
  font-family: var(--font-plex-mono);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.04em;
}

.status-pill[data-tone="loading"] {
  color: var(--color-muted);
}

.status-pill[data-tone="active"] {
  border-color: var(--color-border-strong);
  color: var(--color-ink);
}

.status-pill[data-tone="done"] {
  background: var(--color-ink);
  border-color: var(--color-ink);
  color: var(--color-cream);
  font-weight: 600;
}

.status-pill[data-tone="error"] {
  border-color: var(--color-border-strong);
  color: var(--color-ink);
}

.setup-hero {
  text-align: center;
  padding: clamp(40px, 6vw, 72px) clamp(20px, 6vw, 64px) clamp(32px, 5vw, 56px);
}

.setup-eyebrow {
  margin: 0 0 18px;
  color: var(--color-accent);
  font-family: var(--font-plex-mono);
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0.14em;
  line-height: 1.4;
  text-transform: uppercase;
}

.setup-hero h1 {
  max-width: 18ch;
  margin: 0 auto 20px;
  font-family: var(--font-newsreader);
  font-size: clamp(32px, 5vw, 48px);
  font-weight: 500;
  letter-spacing: 0;
  line-height: 1.1;
  text-wrap: balance;
}

.setup-subhead {
  max-width: 54ch;
  margin: 0 auto;
  color: var(--color-soft);
  font-family: var(--font-public-sans);
  font-size: clamp(15px, 1.6vw, 17px);
  font-weight: 400;
  line-height: 1.6;
  text-wrap: pretty;
}

.setup-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  width: min(920px, 100%);
  margin: 0 auto;
  padding: 0 clamp(20px, 5vw, 64px) clamp(56px, 8vw, 96px);
}

.notice {
  border: 1px solid var(--color-border-subtle);
  border-radius: 14px;
  background: var(--color-tan);
  color: var(--color-soft);
  padding: 14px 16px;
  margin-bottom: 24px;
  font-size: 14px;
  line-height: 1.5;
}

.notice[data-tone="error"] {
  border-color: var(--color-border-strong);
  color: var(--color-ink);
}

.notice[data-tone="success"] {
  background: var(--color-ink);
  border-color: var(--color-ink);
  color: var(--color-cream);
  font-weight: 500;
}

.flow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: clamp(28px, 4vw, 56px);
  align-items: start;
}

.steps {
  list-style: none;
  counter-reset: step;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.step {
  display: grid;
  grid-template-columns: 56px 1fr;
  gap: 20px;
  padding: 28px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 24px;
  background: var(--color-paper);
  box-shadow: inset 0 1px 0 var(--color-surface-glint);
  transition: border-color 200ms ease;
}

.step[data-state="active"] {
  border-color: var(--color-border-strong);
}

.step[data-state="done"] {
  opacity: 0.72;
}

.step-index {
  font-family: var(--font-newsreader);
  font-size: 34px;
  font-weight: 500;
  line-height: 1;
  color: var(--color-muted);
}

.step[data-state="active"] .step-index,
.step[data-state="done"] .step-index {
  color: var(--color-ink);
}

.step-body {
  min-width: 0;
}

.step-title {
  margin: 2px 0 8px;
  font-family: var(--font-public-sans);
  font-size: 17px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--color-ink);
}

.step-hint {
  margin: 0 0 18px;
  color: var(--color-muted-strong);
  font-size: 14px;
  line-height: 1.55;
}

.step-receipt {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 18px;
  padding: 12px 16px;
  border-radius: 14px 14px 14px 4px;
  background: var(--color-ink);
  color: var(--color-cream);
}

.receipt-label {
  flex: none;
  font-family: var(--font-plex-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.7;
}

.receipt-value {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-plex-mono);
  font-size: 13px;
  font-weight: 400;
}

.message-label {
  display: block;
  margin-bottom: 10px;
  color: var(--color-muted);
  font-family: var(--font-plex-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.message-box {
  min-height: 132px;
  max-height: 260px;
  overflow: auto;
  margin: 0 0 18px;
  border-radius: 14px;
  background: var(--color-tan);
  color: var(--color-ink);
  padding: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--font-plex-mono);
  font-size: 13px;
  line-height: 1.55;
}

button {
  min-height: 46px;
  border-radius: 100px;
  border: 1px solid transparent;
  padding: 0 22px;
  font-family: var(--font-public-sans);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 180ms ease, border-color 180ms ease, color 180ms ease, opacity 180ms ease;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.primary-action {
  background: var(--color-accent);
  color: var(--color-cream);
}

.primary-action:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

#sign-button:disabled {
  background: var(--color-tan);
  border-color: var(--color-border-muted);
  color: var(--color-muted);
  opacity: 1;
}

.intent-meta {
  position: sticky;
  top: 96px;
  border-top: 1px solid var(--color-border-subtle);
  padding-top: 28px;
}

.meta-eyebrow {
  margin: 0 0 18px;
  color: var(--color-muted);
  font-family: var(--font-plex-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.intent-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 0 0 24px;
}

.intent-grid div {
  min-width: 0;
}

.intent-grid dt {
  margin-bottom: 6px;
  color: var(--color-muted);
  font-family: var(--font-plex-mono);
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.07em;
  line-height: 1.35;
  text-transform: uppercase;
}

.intent-grid dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-plex-mono);
  font-size: 13px;
  line-height: 1.4;
  color: var(--color-ink);
}

.footnote {
  margin: 0;
  max-width: 36ch;
  color: var(--color-muted-strong);
  font-family: var(--font-public-sans);
  font-size: 13px;
  line-height: 1.55;
}

@media (max-width: 880px) {
  .flow {
    grid-template-columns: minmax(0, 1fr);
  }

  .intent-meta {
    position: static;
    border-top: 0;
    border-top: 1px solid var(--color-border-subtle);
    margin-top: 8px;
    padding-top: 36px;
  }
}

@media (max-width: 640px) {
  .step {
    grid-template-columns: 1fr;
    gap: 14px;
    padding: 24px;
    border-radius: 20px;
  }

  .step-index {
    font-size: 28px;
  }

  .setup-hero h1 {
    font-size: clamp(28px, 7vw, 36px);
  }
}

@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }

  * {
    transition-duration: 1ms !important;
  }
}
`;

const clientScript = `(() => {
  const state = {
    setupIntentId: new URLSearchParams(window.location.search).get("setup_intent_id") || "",
    intent: null,
    account: "",
  };

  const elements = {};

  function get(id) {
    return document.getElementById(id);
  }

  function setNotice(message, tone) {
    elements.notice.textContent = message;
    if (tone) {
      elements.notice.dataset.tone = tone;
    } else {
      delete elements.notice.dataset.tone;
    }
  }

  function setStatus(status) {
    elements.status.textContent = status;
    const tone = status === "COMPLETED"
      ? "done"
      : status === "EXPIRED" || status === "Error" || status === "Unavailable" || status === "Missing"
        ? "error"
        : status === "PENDING" || status === "SIGNED" || status === "DEPLOYING"
          ? "active"
          : "loading";
    elements.status.dataset.tone = tone;
  }

  function renderConnectStep() {
    const connected = Boolean(state.account);
    const mismatch = hasOwnerMismatch();
    elements.stepConnect.dataset.state = connected ? (mismatch ? "active" : "done") : (state.intent && state.intent.status === "PENDING" ? "active" : "pending");
    if (connected) {
      elements.receipt.hidden = false;
      elements.account.textContent = state.account;
    } else {
      elements.receipt.hidden = true;
      elements.account.textContent = "—";
    }
  }

  function renderSignStep() {
    const canSign = Boolean(state.intent && state.account && state.intent.status === "PENDING" && !hasOwnerMismatch());
    elements.stepSign.dataset.state = state.intent && state.intent.status === "COMPLETED"
      ? "done"
      : canSign
        ? "active"
        : "pending";
  }

  function renderFlow() {
    elements.flow.dataset.flow = state.intent ? String(state.intent.status).toLowerCase() : "pending";
    renderConnectStep();
    renderSignStep();
  }

  function sameAddress(left, right) {
    return left && right && left.toLowerCase() === right.toLowerCase();
  }

  function hasOwnerMismatch() {
    return Boolean(state.intent && state.intent.ownerAddress && state.account && !sameAddress(state.intent.ownerAddress, state.account));
  }

  function setBusy(isBusy) {
    elements.connect.disabled = isBusy;
    elements.sign.disabled = isBusy || !state.intent || !state.account || state.intent.status !== "PENDING" || hasOwnerMismatch();
    renderFlow();
  }

  async function loadIntent() {
    if (!state.setupIntentId) {
      setStatus("Missing");
      setNotice("The setup link is missing a setup_intent_id.", "error");
      setBusy(false);
      return;
    }

    const response = await fetch("/api/setup-intents/" + encodeURIComponent(state.setupIntentId));
    const body = await response.json();

    if (!response.ok) {
      setStatus("Unavailable");
      setNotice(body.error || "Setup intent could not be loaded.", "error");
      setBusy(false);
      return;
    }

    state.intent = body;
    elements.intentId.textContent = body.setupIntentId;
    elements.owner.textContent = body.ownerAddress || "Signing wallet";
    elements.executor.textContent = body.executorAddress;
    elements.expires.textContent = new Date(body.expiresAt).toLocaleString();
    elements.message.textContent = body.messageToSign;
    setStatus(body.status);

    if (body.status === "COMPLETED") {
      setNotice("Wallet setup is complete. You can return to chat and ask AgentPay to check the wallet.", "success");
    } else if (body.status === "EXPIRED") {
      setNotice("This setup link has expired. Return to chat and ask AgentPay for a new setup link.", "error");
    } else {
      setNotice("Review this setup message, connect the owner wallet, then sign. This does not approve a payment.");
    }

    setBusy(false);
  }

  async function connectWallet() {
    if (!window.ethereum) {
      setNotice("No injected wallet was found. Open this page in a browser with an EVM wallet extension.", "error");
      return;
    }

    setBusy(true);
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      state.account = accounts[0] || "";
      if (hasOwnerMismatch()) {
        setNotice("Connected wallet does not match the expected owner address. Switch wallets before signing.", "error");
      } else {
        setNotice("Connected " + state.account + ". Review the message before signing.");
      }
    } catch (error) {
      setNotice(error && error.message ? error.message : "Wallet connection failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function signSetupMessage() {
    if (!window.ethereum || !state.intent || !state.account) {
      return;
    }

    if (hasOwnerMismatch()) {
      setNotice("Connected wallet does not match the expected owner address. Switch wallets before signing.", "error");
      setBusy(false);
      return;
    }

    setBusy(true);
    try {
      const signature = await window.ethereum.request({
        method: "personal_sign",
        params: [state.intent.messageToSign, state.account],
      });
      const response = await fetch("/api/setup-complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupIntentId: state.setupIntentId, signature }),
      });
      const body = await response.json();

      if (!response.ok) {
        throw new Error(body.error || "Setup completion failed.");
      }

      setStatus("COMPLETED");
      setNotice("AgentPay wallet created at " + body.accountAddress + ". Return to chat to continue.", "success");
      state.intent.status = "COMPLETED";
    } catch (error) {
      setNotice(error && error.message ? error.message : "Signing failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  function start() {
    elements.notice = get("notice");
    elements.status = get("status-pill");
    elements.flow = get("flow");
    elements.stepConnect = get("step-connect");
    elements.stepSign = get("step-sign");
    elements.receipt = get("connect-receipt");
    elements.account = get("connect-account");
    elements.intentId = get("setup-intent-id");
    elements.owner = get("owner-address");
    elements.executor = get("executor-address");
    elements.expires = get("expires-at");
    elements.message = get("message-to-sign");
    elements.connect = get("connect-button");
    elements.sign = get("sign-button");
    elements.connect.addEventListener("click", connectWallet);
    elements.sign.addEventListener("click", signSetupMessage);
    loadIntent().catch((error) => {
      setStatus("Error");
      setNotice(error && error.message ? error.message : "Setup intent could not be loaded.", "error");
    });
  }

  return { start };
})()`;
