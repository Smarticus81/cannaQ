import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

// This check initializes a database. Restrict it to an explicitly supplied,
// empty loopback test database; never fall back to the application's .env.
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("Set TEST_DATABASE_URL to an empty local test database");
assert(
  ["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(connectionString).hostname,
  ),
  "Test database must be on loopback",
);
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const client = new pg.Client({ connectionString });
const env = {
  ...process.env,
  DATABASE_URL: connectionString,
  NODE_ENV: "production",
  PORT: process.env.TEST_API_PORT ?? "8080",
  CLERK_PUBLISHABLE_KEY: "pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXYk",
  VITE_CLERK_PUBLISHABLE_KEY: "pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXYk",
  CLERK_SECRET_KEY: "sk_test_fixture",
};
for (const key of Object.keys(env)) {
  if (
    /^(SERVICE_API_|METRC_|RESEND_|AI_INTEGRATIONS_|BOOTSTRAP_ADMIN_)/.test(key)
  )
    delete env[key];
}
let server;
let logs = "";
try {
  await client.connect();
  const tables = await client.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
  );
  assert.equal(
    tables.rows[0].n,
    0,
    "Refusing to initialize a nonempty database",
  );

  const before = spawnSync(
    process.execPath,
    ["artifacts/api-server/dist/index.mjs"],
    { cwd: root, env, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(before.status, 1);
  assert.match(
    before.stderr,
    /Base database schema is missing.*pnpm db:migrate/,
  );

  for (let run = 0; run < 2; run++) {
    const result = spawnSync(
      process.execPath,
      [process.env.npm_execpath, "db:migrate"],
      { cwd: root, env, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const migrations = await client.query(
    "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
  );
  assert.equal(
    migrations.rows[0].n,
    1,
    "Repeated migration must not reapply the base schema",
  );

  server = spawn(process.execPath, ["artifacts/api-server/dist/index.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => {
    logs = (logs + chunk).slice(-20000);
  });
  server.stderr.on("data", (chunk) => {
    logs = (logs + chunk).slice(-20000);
  });
  server.on("error", (error) => {
    logs += error.message;
  });
  const base = `http://127.0.0.1:${env.PORT}`;
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* Not listening until bootstrap finishes. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(ready, `Server did not become ready:\n${logs}`);
  for (const route of ["/health", "/api/health", "/api/healthz"]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.deepEqual(await response.json(), { status: "ok" });
  }
  for (const route of ["/", "/onboarding"]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    const asset = html.match(/src="([^"]+\.js)"/);
    assert(asset, "SPA must reference a built JavaScript asset");
    assert.equal((await fetch(base + asset[1])).status, 200);
  }
  assert.equal((await fetch(`${base}/api/suppliers`)).status, 401);
  const facility = await client.query(
    "SELECT count(*)::int AS n FROM facilities",
  );
  assert(
    facility.rows[0].n > 0,
    "Facility bootstrap must finish before readiness",
  );
  console.log(
    "Fresh database: migration twice, bootstrap, readiness, SPA/assets, and API authentication passed.",
  );
} finally {
  if (server && server.exitCode === null) {
    await new Promise((resolve) => {
      server.once("exit", resolve);
      server.kill();
    });
  }
  await client.end();
}
