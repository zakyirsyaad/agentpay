import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const servicePath = new URL("../systemd/agentpay-setup-jwt-rotator.service.example", import.meta.url);
const timerPath = new URL("../systemd/agentpay-setup-jwt-rotator.timer.example", import.meta.url);
const environmentPath = new URL("../systemd/agentpay-setup-jwt-rotator.env.example", import.meta.url);

test("rotator service is root-only, oneshot, sandboxed, and argument-safe", async () => {
  const service = await readFile(servicePath, "utf8");
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^User=root$/m);
  assert.match(service, /^Group=root$/m);
  assert.match(service, /^UMask=0077$/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^ProtectHome=true$/m);
  assert.match(service, /^PrivateTmp=true$/m);
  assert.match(service, /^PrivateDevices=true$/m);
  assert.match(service, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
  assert.match(service, /^SocketBindDeny=any$/m);
  assert.match(service, /^ReadWritePaths=\/opt\/agentpay\/private \/run\/agentpay$/m);
  assert.match(service, /^RuntimeDirectory=agentpay$/m);
  assert.match(service, /^CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER$/m);
  assert.doesNotMatch(service, /^EnvironmentFile=/m);
  assert.doesNotMatch(service, /(JWT_SECRET|SIGNING_SECRET|SERVICE_ROLE_KEY)=/);
  assert.doesNotMatch(service, /agentpay-(mcp|consumer|review-web)\.service/);
});

test("timer runs after boot and every 45 minutes with persistence", async () => {
  const timer = await readFile(timerPath, "utf8");
  assert.match(timer, /^OnBootSec=5min$/m);
  assert.match(timer, /^OnUnitActiveSec=45min$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^RandomizedDelaySec=2min$/m);
  assert.match(timer, /^AccuracySec=30s$/m);
  assert.match(timer, /^Unit=agentpay-setup-jwt-rotator.service$/m);
  assert.match(timer, /^WantedBy=timers.target$/m);
});

test("rotator environment example contains only explicit non-secret placeholders", async () => {
  const environment = await readFile(environmentPath, "utf8");
  assert.match(environment, /^AGENTPAY_ROTATOR_SUPABASE_SIGNING_SECRET=__PROVISION_SECURELY__$/m);
  assert.match(environment, /^AGENTPAY_ROTATOR_SUPABASE_PUBLISHABLE_KEY=__PROVISION_PUBLISHABLE_KEY__$/m);
  assert.doesNotMatch(environment, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  assert.doesNotMatch(environment, /^AGENTPAY_(SETUP_WEB|SETUP_WORKER)_TOKEN=/m);
  assert.doesNotMatch(environment, /^SUPABASE_(SERVICE_ROLE_KEY|PRODUCTION_SERVICE_ROLE_KEY)=/m);
});
