import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TOKEN_TTL_SECONDS,
  Hs256SetupJwtSigner,
  WEB_ROLE,
  WEB_TOKEN_ENV_KEY,
  WORKER_ROLE,
  WORKER_TOKEN_ENV_KEY,
  assertPrivateFileMetadata,
  parseRotatorConfiguration,
  readTrustedProxyIdentity,
  redactSensitiveText,
  replaceScopedToken,
  validateApplicationEnvironment,
  verifySetupJwt,
} from "./setup-jwt-rotation.ts";

const signingSecret = "test-only-signing-secret-with-at-least-32-bytes";
const nowSeconds = 1_800_000_000;

const validRotatorEnvironment = `
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
`;

test("mints distinct verified JWTs for the two exact setup roles", async () => {
  const signer = new Hs256SetupJwtSigner(signingSecret);
  const webToken = await signer.sign({
    role: WEB_ROLE,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + DEFAULT_TOKEN_TTL_SECONDS,
  });
  const workerToken = await signer.sign({
    role: WORKER_ROLE,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + DEFAULT_TOKEN_TTL_SECONDS,
  });

  assert.notEqual(webToken, workerToken);
  assert.deepEqual(verifySetupJwt(webToken, signingSecret, WEB_ROLE, nowSeconds), {
    algorithm: "HS256",
    issuer: "supabase",
    role: WEB_ROLE,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + DEFAULT_TOKEN_TTL_SECONDS,
  });
  assert.equal(verifySetupJwt(workerToken, signingSecret, WORKER_ROLE, nowSeconds).role, WORKER_ROLE);
});

test("rejects wrong roles, unsupported algorithms, bad signatures, and unsafe lifetimes", async () => {
  const signer = new Hs256SetupJwtSigner(signingSecret);
  await assert.rejects(
    () => signer.sign({
      role: "service_role" as typeof WEB_ROLE,
      issuedAt: nowSeconds,
      expiresAt: nowSeconds + DEFAULT_TOKEN_TTL_SECONDS,
    }),
    /Unsupported setup role/,
  );
  await assert.rejects(
    () => signer.sign({ role: WEB_ROLE, issuedAt: nowSeconds, expiresAt: nowSeconds + 7_201 }),
    /lifetime/,
  );
  const token = await signer.sign({ role: WEB_ROLE, issuedAt: nowSeconds, expiresAt: nowSeconds + 6_900 });
  assert.throws(() => verifySetupJwt(token, `${signingSecret}-wrong`, WEB_ROLE, nowSeconds), /signature/);

  const [, payload] = token.split(".");
  const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  assert.throws(() => verifySetupJwt(`${noneHeader}.${payload}.x`, signingSecret, WEB_ROLE, nowSeconds), /algorithm/);
  assert.throws(() => verifySetupJwt(token, signingSecret, WORKER_ROLE, nowSeconds), /role/);
  assert.throws(() => verifySetupJwt(token, signingSecret, WEB_ROLE, nowSeconds + 6_001), /remaining lifetime/);
});

test("replaces only the role-specific token line and preserves every other byte", () => {
  const previous = "NODE_ENV=production\r\nAGENTPAY_SETUP_WEB_TOKEN=old-value\r\nAGENTPAY_SETUP_MODE=PUBLIC\r\n";
  const next = replaceScopedToken(previous, WEB_TOKEN_ENV_KEY, "new-value");
  assert.equal(next, "NODE_ENV=production\r\nAGENTPAY_SETUP_WEB_TOKEN=new-value\r\nAGENTPAY_SETUP_MODE=PUBLIC\r\n");
});

test("rejects missing, duplicate, cross-role, signing-secret, and service-role assignments", () => {
  assert.throws(() => replaceScopedToken("NODE_ENV=production\n", WEB_TOKEN_ENV_KEY, "new"), /exactly one/);
  assert.throws(
    () => replaceScopedToken(
      "AGENTPAY_SETUP_WEB_TOKEN=a\nAGENTPAY_SETUP_WEB_TOKEN=b\n",
      WEB_TOKEN_ENV_KEY,
      "new",
    ),
    /exactly one/,
  );
  assert.throws(
    () => replaceScopedToken(
      "AGENTPAY_SETUP_WEB_TOKEN=a\nAGENTPAY_SETUP_WORKER_TOKEN=forbidden\n",
      WEB_TOKEN_ENV_KEY,
      "new",
    ),
    /Forbidden credential/,
  );
  assert.throws(
    () => replaceScopedToken(
      "AGENTPAY_SETUP_WEB_TOKEN=a\nSUPABASE_JWT_SECRET=forbidden\n",
      WEB_TOKEN_ENV_KEY,
      "new",
    ),
    /Forbidden credential/,
  );
  assert.throws(
    () => replaceScopedToken(
      "AGENTPAY_SETUP_WEB_TOKEN=a\nSUPABASE_SERVICE_ROLE_KEY=forbidden\n",
      WEB_TOKEN_ENV_KEY,
      "new",
    ),
    /Forbidden credential/,
  );
});

test("parses only the fixed production rotator configuration", () => {
  const config = parseRotatorConfiguration(validRotatorEnvironment);
  assert.equal(config.webService, "agentpay-onboarding-web.service");
  assert.equal(config.workerService, "agentpay-setup-worker.service");
  assert.equal(config.tokenTtlSeconds, 6_900);
  assert.equal(config.supabaseUrl, "https://zcwsmivbgcrfyrvfptxk.supabase.co");
  assert.ok(Object.isFrozen(config));
});

test("rejects duplicate keys, unknown rotator keys, relative paths, and unexpected services", () => {
  assert.throws(
    () => parseRotatorConfiguration(`${validRotatorEnvironment}AGENTPAY_ROTATOR_TOKEN_TTL_SECONDS=6900\n`),
    /duplicate/i,
  );
  assert.throws(
    () => parseRotatorConfiguration(`${validRotatorEnvironment}AGENTPAY_ROTATOR_TYPO=value\n`),
    /Unrecognized key/,
  );
  assert.throws(
    () => parseRotatorConfiguration(validRotatorEnvironment.replace(
      "/opt/agentpay/private/onboarding-web.env",
      "private/onboarding-web.env",
    )),
    /absolute/,
  );
  assert.throws(
    () => parseRotatorConfiguration(validRotatorEnvironment.replace(
      "agentpay-onboarding-web.service",
      "ssh.service",
    )),
    /web service/i,
  );
});

test("validates the exact production application boundary before replacement", () => {
  const webEnvironment = [
    "AGENTPAY_ENVIRONMENT=production",
    "AGENTPAY_HOME_CHAIN_ID=196",
    "AGENTPAY_SETUP_MODE=PUBLIC",
    "SUPABASE_URL=https://zcwsmivbgcrfyrvfptxk.supabase.co",
    "AGENTPAY_SETUP_WEB_TOKEN=old",
    "",
  ].join("\n");
  assert.equal(
    validateApplicationEnvironment(webEnvironment, WEB_ROLE, "https://zcwsmivbgcrfyrvfptxk.supabase.co").token,
    "old",
  );
  assert.throws(
    () => validateApplicationEnvironment(webEnvironment.replace("196", "195"), WEB_ROLE,
      "https://zcwsmivbgcrfyrvfptxk.supabase.co"),
    /boundary/,
  );
  assert.throws(
    () => validateApplicationEnvironment(`${webEnvironment}AGENTPAY_SETUP_WORKER_TOKEN=wrong\n`, WEB_ROLE,
      "https://zcwsmivbgcrfyrvfptxk.supabase.co"),
    /Forbidden credential/,
  );
  assert.throws(
    () => validateApplicationEnvironment(webEnvironment.replace(WEB_TOKEN_ENV_KEY, WORKER_TOKEN_ENV_KEY), WEB_ROLE,
      "https://zcwsmivbgcrfyrvfptxk.supabase.co"),
    /Forbidden credential|exactly one/,
  );
});

test("accepts only one strong trusted proxy identity from the web environment", () => {
  const environment = [
    "AGENTPAY_TRUSTED_PROXY_IDENTITY=trusted_proxy_identity_with_at_least_32_bytes",
    "",
  ].join("\n");
  assert.equal(
    readTrustedProxyIdentity(environment),
    "trusted_proxy_identity_with_at_least_32_bytes",
  );
  assert.throws(() => readTrustedProxyIdentity("AGENTPAY_SETUP_MODE=PUBLIC\n"), /missing or invalid/i);
  assert.throws(() => readTrustedProxyIdentity("AGENTPAY_TRUSTED_PROXY_IDENTITY=short\n"), /invalid/i);
  assert.throws(() => readTrustedProxyIdentity(`${environment}${environment}`), /duplicate/i);
});

test("requires regular root-owned private files with their exact modes", () => {
  assert.doesNotThrow(() => assertPrivateFileMetadata(
    { isFile: true, isSymbolicLink: false, uid: 0, gid: 991, mode: 0o640 },
    { uid: 0, mode: 0o640 },
  ));
  assert.throws(() => assertPrivateFileMetadata(
    { isFile: true, isSymbolicLink: true, uid: 0, gid: 991, mode: 0o640 },
    { uid: 0, mode: 0o640 },
  ), /symbolic link/);
  assert.throws(() => assertPrivateFileMetadata(
    { isFile: true, isSymbolicLink: false, uid: 501, gid: 991, mode: 0o640 },
    { uid: 0, mode: 0o640 },
  ), /owner/);
  assert.throws(() => assertPrivateFileMetadata(
    { isFile: true, isSymbolicLink: false, uid: 0, gid: 991, mode: 0o644 },
    { uid: 0, mode: 0o640 },
  ), /mode/);
});

test("redacts configured secrets and JWT-shaped values", () => {
  const token = [
    "eyJhbGciOiJIUzI1NiJ9",
    "eyJyb2xlIjoiYWdlbnRwYXlfc2V0dXBfd2ViIn0",
    "signature",
  ].join(".");
  const output = redactSensitiveText(`request failed: ${signingSecret} ${token}`, [signingSecret, token]);
  assert.equal(output, "request failed: [REDACTED] [REDACTED]");
});
