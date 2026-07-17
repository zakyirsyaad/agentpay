import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { spawn } from "node:child_process";

const postgresImage = "postgres:17-alpine";
const containerName = `agentpay-setup-pg-${randomUUID()}`;
const postgresPassword = randomBytes(24).toString("hex");
const migrationsDir = "supabase/migrations";

const owner = "0x1111111111111111111111111111111111111111";
const executor = "0x2222222222222222222222222222222222222222";
const factory = "0x3333333333333333333333333333333333333333";
const deployer = "0x4444444444444444444444444444444444444444";
const predictedAccount = "0x5555555555555555555555555555555555555555";
const hash = (digit) => `0x${digit.repeat(64)}`;
const bareHash = (digit) => digit.repeat(64);
const signature = `0x${"12".repeat(65)}`;
const intentId = "setup-production-postgres-0001";
const capabilityDigest = bareHash("a");
const now = "2026-07-17T05:00:00.000Z";
const expiresAt = "2026-07-17T05:15:00.000Z";

function run(command, args, { input, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
    });
    child.stdin.end(input);
  });
}

async function dockerPsql(sql, { role, tuplesOnly = true, allowFailure = false } = {}) {
  const rolePrefix = role ? `set session authorization authenticator;\nset role ${role};\n` : "";
  const args = ["exec", "-i", containerName, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"];
  if (tuplesOnly) args.push("-A", "-t", "-q");
  return run("docker", args, { input: `${rolePrefix}${sql}\n`, allowFailure });
}

async function waitForPostgres() {
  let lastError = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await run(
      "docker",
      ["exec", containerName, "pg_isready", "-U", "postgres", "-d", "postgres"],
      { allowFailure: true },
    );
    if (result.code === 0) return;
    lastError = result.stderr || result.stdout;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`PostgreSQL did not become ready: ${lastError}`);
}

async function installMigrations() {
  await dockerPsql(`
    create role anon nologin noinherit;
    create role authenticated nologin noinherit;
    create role service_role nologin noinherit;
    create role authenticator nologin noinherit;
    grant anon, authenticated to authenticator;
  `, { tuplesOnly: false });

  const migrationNames = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const migrationName of migrationNames) {
    await dockerPsql(await readFile(`${migrationsDir}/${migrationName}`, "utf8"), { tuplesOnly: false });
  }
}

async function seedRuntimeState() {
  await dockerPsql(`
    insert into public.setup_runtime_state (
      id, environment, chain_id, setup_mode, manifest_sha256, factory_address,
      factory_runtime_code_hash, executor_address, sponsor_deployer_address,
      max_deployments_per_day, max_gas_per_deployment, max_native_cost_per_day_wei, max_pending
    ) values (
      1, 'production', 196, 'PUBLIC', '${hash("1")}', '${factory}', '${hash("2")}',
      '${executor}', '${deployer}', 10, 5000000, 1000000000000000000, 4
    );
  `, { tuplesOnly: false });
}

function createChallengeSql() {
  return `select public.create_production_setup_challenge(
    '${intentId}', '${capabilityDigest}', '${owner}', '${executor}', 'canonical typed data',
    '${hash("3")}', '${hash("1")}', '${factory}', '${hash("2")}', '${hash("4")}',
    '${predictedAccount}', '${hash("5")}', '${hash("6")}', '${hash("7")}',
    '${expiresAt}'::timestamptz, '${now}'::timestamptz, '${bareHash("b")}', 60, 20
  )::text;`;
}

async function scalar(sql, options) {
  return (await dockerPsql(sql, options)).stdout;
}

describe("production setup migration on disposable PostgreSQL", () => {
  before(async () => {
    const migrationNames = await readdir(migrationsDir);
    assert.ok(
      migrationNames.includes("20260717120000_production_mainnet_onboarding.sql"),
      "production onboarding migration must exist before the integration gate can start",
    );

    const daemon = await run("docker", ["info"], { allowFailure: true });
    assert.equal(daemon.code, 0, `Docker daemon is required for the real PostgreSQL gate: ${daemon.stderr}`);
    await run("docker", [
      "run", "--detach", "--rm", "--name", containerName,
      "--publish", "127.0.0.1::5432",
      "--env", `POSTGRES_PASSWORD=${postgresPassword}`,
      postgresImage,
    ]);
    await waitForPostgres();
    await installMigrations();
    await seedRuntimeState();
  });

  after(async () => {
    await run("docker", ["rm", "--force", containerName], { allowFailure: true });
  });

  it("serializes replayed admission, claiming, sponsor reservation, outbox, and finalization", async () => {
    const challengeResults = await Promise.all(
      Array.from({ length: 8 }, () => scalar(createChallengeSql(), { role: "agentpay_setup_web" })),
    );
    assert.equal(challengeResults.filter((result) => result.includes('"disposition": "CREATED"')).length, 1);
    assert.equal(challengeResults.filter((result) => result.includes('"disposition": "REPLAY"')).length, 7);

    const admissionSql = `select public.consume_production_setup_admission(
      '${capabilityDigest}', '${signature}', '${now}'::timestamptz
    )::text;`;
    const admissionResults = await Promise.all(
      Array.from({ length: 8 }, () => scalar(admissionSql, { role: "agentpay_setup_web" })),
    );
    assert.equal(admissionResults.filter((result) => result.includes('"disposition": "ADMITTED"')).length, 1);
    assert.equal(admissionResults.filter((result) => result.includes('"disposition": "REPLAY"')).length, 7);

    assert.equal(await scalar("select count(*) from public.tenants where environment = 'production';"), "1");
    assert.equal(await scalar("select count(*) from public.verified_owner_identities where status = 'VERIFIED';"), "1");
    assert.equal(await scalar("select count(*) from public.setup_deployment_jobs;"), "1");

    const claims = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        scalar(`select public.claim_setup_deployment_job('worker-${index}', '${now}'::timestamptz, 120)::text;`, {
          role: "agentpay_setup_worker",
        }),
      ),
    );
    const claimed = claims.find((result) => result.includes('"disposition": "CLAIMED"'));
    assert.ok(claimed, "one worker must claim the job");
    assert.equal(claims.filter((result) => result.includes('"disposition": "CLAIMED"')).length, 1);
    assert.equal(claims.filter((result) => result === "").length, 3);
    const claim = JSON.parse(claimed);
    assert.equal(claim.ownerSetupSignature, signature);

    const reserveSql = `select public.reserve_setup_sponsor_budget(
      '${claim.jobId}'::uuid, '${claim.fencingToken}'::uuid, '${deployer}', 7, 1000000, 1000000000000000,
      '${now}'::timestamptz, 10, 5000000, 1000000000000000000, 4
    )::text;`;
    const reservations = await Promise.all(
      Array.from({ length: 8 }, () => scalar(reserveSql, { role: "agentpay_setup_worker" })),
    );
    assert.equal(reservations.filter((result) => result.includes('"disposition": "RESERVED"')).length, 1);
    assert.equal(reservations.filter((result) => result.includes('"disposition": "REPLAY"')).length, 7);

    const persistSql = `select public.persist_setup_signed_transaction(
      '${claim.jobId}'::uuid, '${claim.fencingToken}'::uuid, 'ciphertext', 'iv', 'tag', '${bareHash("c")}',
      '${hash("8")}', '${now}'::timestamptz
    )::text;`;
    const persisted = await Promise.all(
      Array.from({ length: 8 }, () => scalar(persistSql, { role: "agentpay_setup_worker" })),
    );
    assert.equal(persisted.filter((result) => result.includes('"disposition": "SIGNED"')).length, 1);
    assert.equal(persisted.filter((result) => result.includes('"disposition": "REPLAY"')).length, 7);

    await scalar(`select public.mark_setup_broadcast_result(
      '${claim.jobId}'::uuid, '${claim.fencingToken}'::uuid, 'BROADCAST', '${now}'::timestamptz, null
    )::text;`, { role: "agentpay_setup_worker" });
    await scalar(`select public.record_setup_receipt(
      '${claim.jobId}'::uuid, '${claim.fencingToken}'::uuid, '${hash("8")}', 1, 12345,
      '${now}'::timestamptz
    )::text;`, { role: "agentpay_setup_worker" });

    const finalizations = await Promise.all(
      Array.from({ length: 8 }, () =>
        scalar(`select public.finalize_verified_setup_wallet(
          '${claim.jobId}'::uuid, '${claim.fencingToken}'::uuid, '${now}'::timestamptz
        )::text;`, { role: "agentpay_setup_worker" }),
      ),
    );
    assert.equal(finalizations.filter((result) => result.includes('"disposition": "COMPLETED"')).length, 1);
    assert.equal(finalizations.filter((result) => result.includes('"disposition": "REPLAY"')).length, 7);
    assert.equal(await scalar("select count(*) from public.agent_wallets where status = 'ACTIVE';"), "1");
    assert.equal(await scalar("select count(*) from public.setup_sponsor_budgets;"), "1");
    assert.equal(await scalar("select count(distinct deployer_nonce) from public.setup_deployment_jobs;"), "1");
    assert.equal(await scalar("select count(distinct transaction_hash) from public.setup_deployment_jobs;"), "1");

    const publicStatus = await scalar(
      `select public.read_production_setup_status('${capabilityDigest}', '${now}'::timestamptz)::text;`,
      { role: "agentpay_setup_web" },
    );
    assert.match(publicStatus, /SETUP_COMPLETED/);
    assert.ok(!publicStatus.includes(signature));
    assert.ok(!publicStatus.includes("ciphertext"));
    const auditPayloads = await scalar("select coalesce(jsonb_agg(metadata), '[]'::jsonb)::text from public.setup_deployment_events;");
    assert.ok(!auditPayloads.includes(signature));
    assert.ok(!auditPayloads.includes("ciphertext"));

    const terminalRegression = await dockerPsql(persistSql, { role: "agentpay_setup_worker", allowFailure: true });
    assert.notEqual(terminalRegression.code, 0, "completed jobs cannot regress to signed");
    assert.match(terminalRegression.stderr, /SETUP_STATE_CONFLICT/);

    const mutateAudit = await dockerPsql(
      "update public.setup_deployment_events set event_type = 'MUTATED' where true;",
      { allowFailure: true },
    );
    assert.notEqual(mutateAudit.code, 0, "setup events are append-only");
    assert.match(mutateAudit.stderr, /SETUP_AUDIT_IMMUTABLE/);

    const mutateBudget = await dockerPsql(
      "update public.setup_sponsor_budgets set status = 'CHARGED' where true;",
      { allowFailure: true },
    );
    assert.notEqual(mutateBudget.code, 0, "charged sponsor reservations are immutable");
    assert.match(mutateBudget.stderr, /SETUP_AUDIT_IMMUTABLE/);
  });

  it("rejects duplicate sponsor nonces and transaction hashes across jobs", async () => {
    const secondOwner = "0x6666666666666666666666666666666666666666";
    const secondCapability = bareHash("d");
    const secondIntent = "setup-production-postgres-0002";
    const secondPredicted = "0x7777777777777777777777777777777777777777";
    const actorCollision = await dockerPsql(`select public.create_production_setup_challenge(
      'setup-production-postgres-collision', '${bareHash("0")}', '${deployer}', '${executor}', 'invalid actors',
      '${hash("d")}', '${hash("1")}', '${factory}', '${hash("2")}', '${hash("e")}',
      '0x8888888888888888888888888888888888888888', '${hash("5")}', '${hash("f")}', '${hash("0")}',
      '${expiresAt}'::timestamptz, '${now}'::timestamptz, '${bareHash("0")}', 60, 20
    );`, { role: "agentpay_setup_web", allowFailure: true });
    assert.notEqual(actorCollision.code, 0);
    assert.match(actorCollision.stderr, /SETUP_ACTOR_COLLISION/);

    const createSecond = `select public.create_production_setup_challenge(
      '${secondIntent}', '${secondCapability}', '${secondOwner}', '${executor}', 'canonical typed data 2',
      '${hash("9")}', '${hash("1")}', '${factory}', '${hash("2")}', '${hash("a")}',
      '${secondPredicted}', '${hash("5")}', '${hash("b")}', '${hash("c")}',
      '${expiresAt}'::timestamptz, '${now}'::timestamptz, '${bareHash("e")}', 60, 20
    )::text;`;
    await scalar(createSecond, { role: "agentpay_setup_web" });

    const ownerBusy = await dockerPsql(`select public.create_production_setup_challenge(
      'setup-production-postgres-owner-busy', '${bareHash("1")}', '${secondOwner}', '${executor}', 'different setup',
      '${hash("d")}', '${hash("1")}', '${factory}', '${hash("2")}', '${hash("e")}',
      '0x8888888888888888888888888888888888888888', '${hash("5")}', '${hash("f")}', '${hash("0")}',
      '${expiresAt}'::timestamptz, '${now}'::timestamptz, '${bareHash("1")}', 60, 20
    );`, { role: "agentpay_setup_web", allowFailure: true });
    assert.notEqual(ownerBusy.code, 0);
    assert.match(ownerBusy.stderr, /SETUP_OWNER_BUSY/);

    const deploymentNonceConflict = await dockerPsql(`select public.create_production_setup_challenge(
      'setup-production-postgres-nonce-conflict', '${bareHash("2")}',
      '0x9999999999999999999999999999999999999999', '${executor}', 'duplicate deployment nonce',
      '${hash("9")}', '${hash("1")}', '${factory}', '${hash("2")}', '${hash("f")}',
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '${hash("5")}', '${hash("0")}', '${hash("1")}',
      '${expiresAt}'::timestamptz, '${now}'::timestamptz, '${bareHash("2")}', 60, 20
    );`, { role: "agentpay_setup_web", allowFailure: true });
    assert.notEqual(deploymentNonceConflict.code, 0);
    assert.match(deploymentNonceConflict.stderr, /SETUP_DEPLOYMENT_NONCE_CONFLICT/);

    await scalar(
      `select public.consume_production_setup_admission('${secondCapability}', '${signature}', '${now}'::timestamptz)::text;`,
      { role: "agentpay_setup_web" },
    );
    const secondClaim = JSON.parse(await scalar(
      `select public.claim_setup_deployment_job('worker-second', '${now}'::timestamptz, 120)::text;`,
      { role: "agentpay_setup_worker" },
    ));

    const duplicateNonce = await dockerPsql(`select public.reserve_setup_sponsor_budget(
      '${secondClaim.jobId}'::uuid, '${secondClaim.fencingToken}'::uuid, '${deployer}', 7, 1000000,
      1000000000000000, '${now}'::timestamptz, 10, 5000000, 1000000000000000000, 4
    );`, { role: "agentpay_setup_worker", allowFailure: true });
    assert.notEqual(duplicateNonce.code, 0);
    assert.match(duplicateNonce.stderr, /SETUP_DEPLOYER_NONCE_CONFLICT/);

    await scalar(`select public.reserve_setup_sponsor_budget(
      '${secondClaim.jobId}'::uuid, '${secondClaim.fencingToken}'::uuid, '${deployer}', 8, 1000000,
      1000000000000000, '${now}'::timestamptz, 10, 5000000, 1000000000000000000, 4
    )::text;`, { role: "agentpay_setup_worker" });
    const duplicateHash = await dockerPsql(`select public.persist_setup_signed_transaction(
      '${secondClaim.jobId}'::uuid, '${secondClaim.fencingToken}'::uuid, 'ciphertext-2', 'iv-2', 'tag-2',
      '${bareHash("f")}', '${hash("8")}', '${now}'::timestamptz
    );`, { role: "agentpay_setup_worker", allowFailure: true });
    assert.notEqual(duplicateHash.code, 0);
    assert.match(duplicateHash.stderr, /SETUP_TRANSACTION_HASH_CONFLICT/);
  });

  it("enforces scoped RPC-only runtime roles", async () => {
    assert.equal(
      await scalar(`select count(*) from pg_auth_members memberships
        join pg_roles granted on granted.oid = memberships.roleid
        join pg_roles member on member.oid = memberships.member
        where member.rolname = 'authenticator'
          and granted.rolname in ('agentpay_setup_web', 'agentpay_setup_worker');`),
      "2",
    );
    assert.equal(
      await scalar(`select count(*) from pg_roles
        where rolname in ('agentpay_setup_web', 'agentpay_setup_worker')
          and rolcanlogin = false and rolinherit = false;`),
      "2",
    );

    for (const role of ["public", "anon", "authenticated", "agentpay_setup_web", "agentpay_setup_worker"]) {
      const principal = role === "public" ? "anon" : role;
      const result = await dockerPsql("select * from public.setup_intents limit 1;", { role: principal, allowFailure: true });
      assert.notEqual(result.code, 0, `${role} must not select setup tables`);
    }

    const anonStatus = await dockerPsql(
      `select public.read_production_setup_status('${capabilityDigest}', '${now}'::timestamptz);`,
      { role: "anon", allowFailure: true },
    );
    assert.notEqual(anonStatus.code, 0, "anon cannot execute web RPCs");

    const webRuntime = JSON.parse(await scalar(
      "select public.read_production_setup_runtime_state()::text;",
      { role: "agentpay_setup_web" },
    ));
    assert.deepEqual(webRuntime, {
      environment: "production",
      chainId: 196,
      setupMode: "PUBLIC",
      manifestSha256: hash("1"),
      factoryAddress: factory,
      factoryRuntimeCodeHash: hash("2"),
      executorAddress: executor,
      sponsorDeployerAddress: deployer,
      maxDeploymentsPerDay: 10,
      maxGasPerDeployment: "5000000",
      maxNativeCostPerDayWei: "1000000000000000000",
      maxPending: 4,
    });
    assert.equal(JSON.stringify(webRuntime).includes("signature"), false);

    for (const role of ["anon", "agentpay_setup_worker"]) {
      const forbiddenRuntime = await dockerPsql(
        "select public.read_production_setup_runtime_state();",
        { role, allowFailure: true },
      );
      assert.notEqual(forbiddenRuntime.code, 0, `${role} cannot read the web runtime readiness RPC`);
    }

    const webWorker = await dockerPsql(
      `select public.claim_setup_deployment_job('web', '${now}'::timestamptz, 60);`,
      { role: "agentpay_setup_web", allowFailure: true },
    );
    assert.notEqual(webWorker.code, 0, "web cannot execute worker RPCs");

    const workerWeb = await dockerPsql(
      `select public.read_production_setup_status('${capabilityDigest}', '${now}'::timestamptz);`,
      { role: "agentpay_setup_worker", allowFailure: true },
    );
    assert.notEqual(workerWeb.code, 0, "worker cannot execute web RPCs");
  });
});
