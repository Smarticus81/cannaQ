import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { validateEnvironment } from "../src/lib/environment";
import healthRouter from "../src/routes/health";
import { markReady } from "../src/lib/readiness";

test("startup reports all missing required variables without exposing values", () => {
  assert.throws(
    () => validateEnvironment({ NODE_ENV: "production" }),
    (error: Error) => {
      for (const name of [
        "DATABASE_URL",
        "CLERK_SECRET_KEY",
        "CLERK_PUBLISHABLE_KEY",
        "VITE_CLERK_PUBLISHABLE_KEY",
      ]) {
        assert.match(error.message, new RegExp(`${name} is required`));
      }
      return true;
    },
  );
  assert.throws(
    () => validateEnvironment({ DATABASE_URL: "sensitive-invalid-value" }),
    (error: Error) => {
      assert(!error.message.includes("sensitive-invalid-value"));
      return true;
    },
  );
});

test("startup respects Railway PORT and rejects inconsistent configuration", () => {
  const env = {
    DATABASE_URL: "postgresql://localhost/cannaq",
    CLERK_SECRET_KEY: "secret",
    CLERK_PUBLISHABLE_KEY: "public",
    VITE_CLERK_PUBLISHABLE_KEY: "public",
    NODE_ENV: "production",
    PORT: "8080",
  };
  assert.equal(validateEnvironment(env), 8080);
  assert.equal(validateEnvironment({ ...env, PORT: undefined }), 3001);
  assert.throws(
    () => validateEnvironment({ ...env, PORT: "0", DATABASE_POOL_MAX: "NaN" }),
    /PORT[\s\S]*DATABASE_POOL_MAX/,
  );
  assert.throws(
    () =>
      validateEnvironment({
        ...env,
        DATABASE_URL: "${{Postgres.DATABASE_URL}}",
      }),
    /unresolved Railway reference/,
  );
  assert.throws(
    () =>
      validateEnvironment({ ...env, VITE_CLERK_PUBLISHABLE_KEY: "different" }),
    /must match/,
  );
  assert.throws(
    () => validateEnvironment({ ...env, SERVICE_API_TOKEN: "secret" }),
    /configured together/,
  );
});

test("health returns 503 until bootstrap marks the application ready", async () => {
  const app = express();
  app.use(healthRouter);
  app.use("/api", healthRouter);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const paths = ["/health", "/api/health", "/api/healthz"];
  try {
    for (const path of paths)
      assert.equal(
        (await fetch(`http://127.0.0.1:${address.port}${path}`)).status,
        503,
      );
    markReady();
    for (const path of paths) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok" });
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
