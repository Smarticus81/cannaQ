import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import { requireActiveUser } from "../src/middlewares/requireActiveUser";
import { convertQuantity } from "../src/lib/units";
import { resolveLabTestBatches } from "../src/lib/metrcLabTestBatches";
import { transferWindow } from "../src/lib/metrcEndpoints";

test("API authentication rejects anonymous/inactive accounts and preserves public health", async () => {
  const app = express();
  let businessRequests = 0;
  app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));
  app.use("/api", requireActiveUser(async (req) => {
    if (req.headers.authorization === "Bearer active") return { active: true };
    if (req.headers.authorization === "Bearer inactive") return { active: false };
    if (req.headers.authorization === "Bearer failure") throw new Error("Auth provider unavailable");
    return null;
  }));
  app.all("/api/suppliers", (_req, res) => { businessRequests++; res.json({ ok: true }); });
  app.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(503).json({ error: "Unavailable" });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/healthz`)).status, 200);
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      assert.equal((await fetch(`${base}/api/suppliers`, { method })).status, 401);
    }
    assert.equal((await fetch(`${base}/api/suppliers`, { headers: { authorization: "Bearer inactive" } })).status, 403);
    assert.equal((await fetch(`${base}/api/suppliers`, { headers: { authorization: "Bearer failure" } })).status, 503);
    assert.equal(businessRequests, 0);
    assert.equal((await fetch(`${base}/api/suppliers`, { headers: { authorization: "Bearer active" } })).status, 200);
    assert.equal(businessRequests, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test("inventory conversion preserves quantities and rejects incompatible dimensions", () => {
  assert.deepEqual(convertQuantity(1, "kg", "g"), { ok: true, value: 1000, sameUnit: false });
  assert.deepEqual(convertQuantity(-500, "mg", "grams"), { ok: true, value: -0.5, sameUnit: false });
  assert.deepEqual(convertQuantity(12, "units", "each"), { ok: true, value: 12, sameUnit: false });
  assert.equal(convertQuantity(10, "ml", "g").ok, false);
  assert.equal(convertQuantity(10, "mystery", "g").ok, false);
});

test("sample panel selection fails closed and honors explicit panels", () => {
  assert.equal(resolveLabTestBatches(undefined).ok, false);
  assert.equal(resolveLabTestBatches("unknown product").ok, false);
  assert.deepEqual(resolveLabTestBatches("Infused Pre-Roll"), {
    ok: true, batches: ["Inhalable Compound Concentrate"], source: "productType",
  });
  assert.deepEqual(resolveLabTestBatches("Concentrate", [" Non-Solvent Concentrate "]), {
    ok: true, batches: ["Non-Solvent Concentrate"], source: "explicit",
  });
});

test("Metrc transfer queries stay inside the 24-hour window", () => {
  const end = new Date("2026-09-12T12:00:00Z");
  assert.deepEqual(transferWindow(end, 72), {
    lastModifiedStart: "2026-09-11T12:00:00.000Z", lastModifiedEnd: end.toISOString(),
  });
  assert.equal(transferWindow(end, 0).lastModifiedStart, "2026-09-12T11:00:00.000Z");
});

test("the real application protects business routes without contacting a database", async () => {
  // Import the app without its startup/migration entry point. These fixture keys
  // are deliberately not real credentials; anonymous requests need no provider call.
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  process.env.CLERK_PUBLISHABLE_KEY = "pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXYk";
  process.env.CLERK_SECRET_KEY = "sk_test_fixture";
  const { default: app } = await import("../src/app");
  const { pool } = await import("@workspace/db");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${base}/api/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    for (const route of ["suppliers", "batch-records", "inventory", "documents", "audit-log", "facilities"]) {
      assert.equal((await fetch(`${base}/api/${route}`)).status, 401, route);
    }
    assert.equal((await fetch(`${base}/api/suppliers`, { method: "POST" })).status, 401);
    assert.equal(pool.totalCount, 0, "anonymous requests must not acquire a database connection");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await pool.end();
  }
});
