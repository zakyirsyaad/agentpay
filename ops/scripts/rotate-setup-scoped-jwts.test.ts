import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  Hs256SetupJwtSigner,
  WEB_ROLE,
  WORKER_ROLE,
  parseRotatorConfiguration,
  type RotatorConfiguration,
} from "./setup-jwt-rotation.ts";
import {
  createProductionRotationDependencies,
  parseCliArguments,
  rotateSetupScopedJwts,
  type PrivateEnvironmentFile,
  type RotationDependencies,
} from "./rotate-setup-scoped-jwts.ts";

const signingSecret = "test-only-signing-secret-with-at-least-32-bytes";
const trustedProxyIdentity = "test-only-trusted-proxy-identity-with-32-bytes";
const config = parseRotatorConfiguration(`
AGENTPAY_ROTATOR_SUPABASE_URL=https://zcwsmivbgcrfyrvfptxk.supabase.co
AGENTPAY_ROTATOR_SUPABASE_PUBLISHABLE_KEY=sb_publishable_agentpay_test_key_1234567890
AGENTPAY_ROTATOR_SUPABASE_SIGNING_SECRET=${signingSecret}
AGENTPAY_ROTATOR_WEB_ENV_PATH=/opt/agentpay/private/onboarding-web.env
AGENTPAY_ROTATOR_WORKER_ENV_PATH=/opt/agentpay/private/setup-worker.env
AGENTPAY_ROTATOR_STATE_DIR=/opt/agentpay/private/setup-jwt-rotator
AGENTPAY_ROTATOR_LOCK_PATH=/run/agentpay/setup-jwt-rotator.lock
AGENTPAY_ROTATOR_WEB_SERVICE=agentpay-onboarding-web.service
AGENTPAY_ROTATOR_WORKER_SERVICE=agentpay-setup-worker.service
AGENTPAY_ROTATOR_LOCAL_HEALTH_URL=http://127.0.0.1:3004/healthz
AGENTPAY_ROTATOR_PUBLIC_HEALTH_URL=https://onboard.agentpay.site/healthz
AGENTPAY_ROTATOR_PUBLIC_READY_URL=https://onboard.agentpay.site/readyz
AGENTPAY_ROTATOR_TOKEN_TTL_SECONDS=6900
`);

const webFile: PrivateEnvironmentFile = Object.freeze({
  path: config.webEnvironmentPath,
  text: [
    "AGENTPAY_ENVIRONMENT=production",
    "AGENTPAY_HOME_CHAIN_ID=196",
    "AGENTPAY_SETUP_MODE=PUBLIC",
    `SUPABASE_URL=${config.supabaseUrl}`,
    "AGENTPAY_SETUP_WEB_TOKEN=old-web",
    `AGENTPAY_TRUSTED_PROXY_IDENTITY=${trustedProxyIdentity}`,
    "",
  ].join("\n"),
  uid: 0,
  gid: 991,
  mode: 0o640,
});

const workerFile: PrivateEnvironmentFile = Object.freeze({
  path: config.workerEnvironmentPath,
  text: [
    "AGENTPAY_ENVIRONMENT=production",
    "AGENTPAY_HOME_CHAIN_ID=196",
    "AGENTPAY_SETUP_MODE=PUBLIC",
    `SUPABASE_URL=${config.supabaseUrl}`,
    "AGENTPAY_SETUP_WORKER_TOKEN=old-worker",
    "",
  ].join("\n"),
  uid: 0,
  gid: 992,
  mode: 0o640,
});

type DependencyOverrides = Partial<RotationDependencies>;

function createDependencies(overrides: DependencyOverrides = {}) {
  const events: string[] = [];
  const dependencies: RotationDependencies = {
    effectiveUserId: () => 0,
    nowSeconds: () => 1_800_000_000,
    async acquireLock() {
      events.push("lock");
      return Object.freeze({
        async release() {
          events.push("unlock");
        },
      });
    },
    async readPrivateFile(path) {
      if (path === config.webEnvironmentPath) {
        events.push("read:web");
        return webFile;
      }
      events.push("read:worker");
      return workerFile;
    },
    async stagePrivateFile(input) {
      const label = input.targetPath === config.webEnvironmentPath ? "web" : "worker";
      events.push(`stage:${label}`);
      return `/stage/${label}`;
    },
    async saveRollbackGeneration() {
      events.push("backup");
      return "/backup/one";
    },
    async installStagedPair() {
      events.push("install");
    },
    async restoreRollbackGeneration() {
      events.push("restore");
    },
    async pruneRollbackGenerations() {
      events.push("prune");
    },
    async probeRoleIsolation(input) {
      events.push(`probe:${input.phase}:${input.role}`);
    },
    async restartService(name) {
      events.push(`restart:${name}`);
    },
    async requireServiceActive(name) {
      events.push(`active:${name}`);
    },
    async requireHttpStatus(url, status) {
      events.push(`http:${url.toString()}:${status}`);
    },
    async cleanupStage(path) {
      events.push(`cleanup:${path.endsWith("web") ? "web" : "worker"}`);
    },
    log() {},
    ...overrides,
  };
  return { dependencies, events };
}

test("rotates both roles, activates worker before web, and verifies readiness", async () => {
  const { dependencies, events } = createDependencies();
  const result = await rotateSetupScopedJwts(config, new Hs256SetupJwtSigner(signingSecret), dependencies);

  assert.equal(result.status, "ROTATED");
  assert.deepEqual(events, [
    "lock",
    "read:web", "read:worker",
    `probe:pre-install:${WEB_ROLE}`, `probe:pre-install:${WORKER_ROLE}`,
    "stage:web", "stage:worker", "backup", "install", "cleanup:web", "cleanup:worker",
    `restart:${config.workerService}`, `active:${config.workerService}`,
    `restart:${config.webService}`, `active:${config.webService}`,
    `http:${config.localHealthUrl.toString()}:200`,
    `http:${config.publicHealthUrl.toString()}:200`,
    `http:${config.publicReadyUrl.toString()}:200`,
    `probe:post-install:${WEB_ROLE}`, `probe:post-install:${WORKER_ROLE}`,
    "prune", "unlock",
  ]);
  assert.equal(result.expiresAt, 1_800_006_900);
});

test("authenticates the direct local health probe with the configured trusted proxy identity", async () => {
  const requests: Array<Readonly<{
    url: string;
    headers: Readonly<Record<string, string>> | undefined;
  }>> = [];
  const { dependencies } = createDependencies({
    async requireHttpStatus(url, _status, headers) {
      requests.push(Object.freeze({ url: url.toString(), headers }));
    },
  });

  await rotateSetupScopedJwts(config, new Hs256SetupJwtSigner(signingSecret), dependencies);

  assert.deepEqual(requests, [
    {
      url: config.localHealthUrl.toString(),
      headers: {
        host: "onboard.agentpay.site",
        "x-agentpay-proxy-identity": trustedProxyIdentity,
        "x-forwarded-proto": "https",
      },
    },
    { url: config.publicHealthUrl.toString(), headers: undefined },
    { url: config.publicReadyUrl.toString(), headers: undefined },
  ]);
});

test("skips a concurrent rotation without reading or changing state", async () => {
  const events: string[] = [];
  const { dependencies } = createDependencies({
    async acquireLock() {
      events.push("lock");
      return null;
    },
  });
  const result = await rotateSetupScopedJwts(config, new Hs256SetupJwtSigner(signingSecret), dependencies);
  assert.deepEqual(result, { status: "SKIPPED_LOCKED" });
  assert.deepEqual(events, ["lock"]);
});

test("fails before staging when a pre-install isolation probe fails", async () => {
  const { dependencies, events } = createDependencies({
    async probeRoleIsolation(input) {
      events.push(`probe:${input.phase}:${input.role}`);
      if (input.phase === "pre-install" && input.role === WEB_ROLE) throw new Error("isolation failed");
    },
  });
  await assert.rejects(
    () => rotateSetupScopedJwts(config, new Hs256SetupJwtSigner(signingSecret), dependencies),
    /isolation failed/,
  );
  assert.deepEqual(events, [
    "lock", "read:web", "read:worker", `probe:pre-install:${WEB_ROLE}`, "unlock",
  ]);
});

test("rejects non-root execution before acquiring the lock", async () => {
  const { dependencies, events } = createDependencies({ effectiveUserId: () => 501 });
  await assert.rejects(
    () => rotateSetupScopedJwts(config, new Hs256SetupJwtSigner(signingSecret), dependencies),
    /run as root/,
  );
  assert.deepEqual(events, []);
});

test("restores both files and only the worker when worker activation fails", async () => {
  const { dependencies, events } = createDependencies({
    async requireServiceActive(name) {
      events.push(`active:${name}`);
      if (name === config.workerService && events.filter((event) => event === `active:${name}`).length === 1) {
        throw new Error("worker inactive");
      }
    },
  });
  await assert.rejects(
    () => rotateSetupScopedJwts(config, new Hs256SetupJwtSigner(signingSecret), dependencies),
    /worker inactive/,
  );
  assert.ok(events.indexOf("restore") > events.indexOf(`active:${config.workerService}`));
  assert.deepEqual(events.filter((event) => event.startsWith("restart:")), [
    `restart:${config.workerService}`,
    `restart:${config.workerService}`,
  ]);
});

test("restores both files and both services when public readiness fails", async () => {
  const { dependencies, events } = createDependencies({
    async requireHttpStatus(url, status) {
      events.push(`http:${url.toString()}:${status}`);
      if (url.pathname === "/readyz") throw new Error("readiness failed");
    },
  });
  await assert.rejects(
    () => rotateSetupScopedJwts(config, new Hs256SetupJwtSigner(signingSecret), dependencies),
    /readiness failed/,
  );
  assert.ok(events.includes("restore"));
  assert.deepEqual(events.filter((event) => event.startsWith("restart:")).slice(-2), [
    `restart:${config.workerService}`,
    `restart:${config.webService}`,
  ]);
});

test("surfaces both activation and rollback failures without leaking credentials", async () => {
  const { dependencies } = createDependencies({
    async requireServiceActive() {
      throw new Error("activation failed");
    },
    async restoreRollbackGeneration() {
      throw new Error("rollback failed");
    },
  });
  await assert.rejects(
    () => rotateSetupScopedJwts(config, new Hs256SetupJwtSigner(signingSecret), dependencies),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.doesNotMatch(error.message, new RegExp(signingSecret));
      return true;
    },
  );
});

test("does not hide the primary failure when lock release also fails", async () => {
  const { dependencies } = createDependencies({
    async acquireLock() {
      return Object.freeze({
        async release() {
          throw new Error("lock release failed");
        },
      });
    },
    async probeRoleIsolation() {
      throw new Error("primary isolation failure");
    },
  });
  await assert.rejects(
    () => rotateSetupScopedJwts(config, new Hs256SetupJwtSigner(signingSecret), dependencies),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match((error.errors[0] as Error).message, /primary isolation failure/);
      assert.match((error.errors[1] as Error).message, /lock release failed/);
      return true;
    },
  );
});

test("passes role-specific replacement files to staging", async () => {
  const stagedTexts: string[] = [];
  const { dependencies } = createDependencies({
    async stagePrivateFile(input) {
      stagedTexts.push(input.text);
      return `/stage/${stagedTexts.length}`;
    },
  });
  await rotateSetupScopedJwts(config, new Hs256SetupJwtSigner(signingSecret), dependencies);
  assert.match(stagedTexts[0]!, /^AGENTPAY_SETUP_WEB_TOKEN=eyJ/m);
  assert.doesNotMatch(stagedTexts[0]!, /AGENTPAY_SETUP_WORKER_TOKEN/);
  assert.match(stagedTexts[1]!, /^AGENTPAY_SETUP_WORKER_TOKEN=eyJ/m);
  assert.doesNotMatch(stagedTexts[1]!, /AGENTPAY_SETUP_WEB_TOKEN/);
});

test("configuration remains reusable across consecutive rotations", async () => {
  let now = 1_800_000_000;
  const stagedTokens: string[] = [];
  const { dependencies } = createDependencies({
    nowSeconds: () => now,
    async stagePrivateFile(input) {
      stagedTokens.push(input.text.match(/TOKEN=(.+)$/m)?.[1] ?? "");
      return `/stage/${stagedTokens.length}`;
    },
  });
  await rotateSetupScopedJwts(config as RotatorConfiguration, new Hs256SetupJwtSigner(signingSecret), dependencies);
  now += 2_700;
  await rotateSetupScopedJwts(config as RotatorConfiguration, new Hs256SetupJwtSigner(signingSecret), dependencies);
  assert.equal(new Set(stagedTokens).size, 4);
});

test("production role probes require own success, cross-role denial, and table denial", async () => {
  const requests: Array<Readonly<{ url: string; method: string; headers: Headers }>> = [];
  const statuses = [200, 403, 403, 200, 401, 403];
  const webCredential = ["web", "credential"].join("-");
  const workerCredential = ["worker", "credential"].join("-");
  const fetchImplementation: typeof fetch = async (input, init) => {
    requests.push(Object.freeze({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    }));
    return { status: statuses.shift() } as Response;
  };
  const dependencies = createProductionRotationDependencies(config, {
    fetchImplementation,
    effectiveUserId: () => 0,
  });

  await dependencies.probeRoleIsolation({ role: WEB_ROLE, token: webCredential, phase: "pre-install" });
  await dependencies.probeRoleIsolation({ role: WORKER_ROLE, token: workerCredential, phase: "pre-install" });

  assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [
    { url: `${config.supabaseUrl}/rest/v1/rpc/read_production_setup_runtime_state`, method: "POST" },
    { url: `${config.supabaseUrl}/rest/v1/rpc/read_production_setup_worker_runtime_state`, method: "POST" },
    { url: `${config.supabaseUrl}/rest/v1/setup_runtime_state?select=*&limit=1`, method: "GET" },
    { url: `${config.supabaseUrl}/rest/v1/rpc/read_production_setup_worker_runtime_state`, method: "POST" },
    { url: `${config.supabaseUrl}/rest/v1/rpc/read_production_setup_runtime_state`, method: "POST" },
    { url: `${config.supabaseUrl}/rest/v1/setup_runtime_state?select=*&limit=1`, method: "GET" },
  ]);
  assert.equal(requests[0]!.headers.get("apikey"), config.supabasePublishableKey);
  assert.equal(requests[0]!.headers.get("authorization"), `Bearer ${webCredential}`);
  assert.equal(requests[3]!.headers.get("authorization"), `Bearer ${workerCredential}`);
});

test("production probes fail closed on unexpected authorization status without reading response bodies", async () => {
  let call = 0;
  const webCredential = ["web", "credential"].join("-");
  const fetchImplementation: typeof fetch = async () => {
    call += 1;
    return {
      status: call === 1 ? 200 : 404,
      async text() {
        throw new Error("sensitive-response-body");
      },
    } as unknown as Response;
  };
  const dependencies = createProductionRotationDependencies(config, { fetchImplementation });
  await assert.rejects(
    () => dependencies.probeRoleIsolation({ role: WEB_ROLE, token: webCredential, phase: "pre-install" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 404/);
      assert.doesNotMatch(error.message, /sensitive-response-body|web-credential/);
      return true;
    },
  );
});

test("production local health transport preserves the explicit Host header", async () => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    const authorized = request.headers.host === "onboard.agentpay.site"
      && request.headers["x-agentpay-proxy-identity"] === trustedProxyIdentity
      && request.headers["x-forwarded-proto"] === "https";
    response.writeHead(authorized && requestCount >= 3 ? 200 : 503).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const dependencies = createProductionRotationDependencies(config);
    await dependencies.requireHttpStatus(
      new URL(`http://127.0.0.1:${address.port}/healthz`),
      200,
      {
        host: "onboard.agentpay.site",
        "x-agentpay-proxy-identity": trustedProxyIdentity,
        "x-forwarded-proto": "https",
      },
    );
    assert.equal(requestCount, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("production public readiness retries transient HTTP failures", async () => {
  let requestCount = 0;
  const fetchImplementation: typeof fetch = async () => {
    requestCount += 1;
    return { status: requestCount >= 3 ? 200 : 503 } as Response;
  };
  const dependencies = createProductionRotationDependencies(config, { fetchImplementation });

  await dependencies.requireHttpStatus(config.publicReadyUrl, 200);

  assert.equal(requestCount, 3);
});

test("production readiness fails closed without retrying a non-transient status", async () => {
  let requestCount = 0;
  const fetchImplementation: typeof fetch = async () => {
    requestCount += 1;
    return { status: 404 } as Response;
  };
  const dependencies = createProductionRotationDependencies(config, { fetchImplementation });

  await assert.rejects(
    () => dependencies.requireHttpStatus(config.publicReadyUrl, 200),
    /HTTP 404/,
  );

  assert.equal(requestCount, 1);
});

test("CLI accepts only one absolute config path and never accepts secrets as arguments", () => {
  assert.deepEqual(parseCliArguments(["--config", "/opt/agentpay/private/setup-jwt-rotator.env"]), {
    configPath: "/opt/agentpay/private/setup-jwt-rotator.env",
  });
  assert.throws(() => parseCliArguments([]), /Usage/);
  assert.throws(() => parseCliArguments(["--config", "relative.env"]), /Usage/);
  assert.throws(() => parseCliArguments(["--config", "/one", "--config", "/two"]), /Usage/);
  assert.throws(() => parseCliArguments(["--signing-secret", signingSecret]), /Usage/);
});
