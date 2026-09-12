import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { onboardingFixture } from "./onboarding-fixture";
import { createOnboardingRouter } from "../src/routes/onboarding";

test("onboarding persists per-user drafts, rejects stale writes, and atomically sets up a workspace", async () => {
  const { pg, service, actors } = await onboardingFixture();
  try {
    const start = await service.get(actors.admin);
    assert.equal(start.needsWorkspace, true);
    assert.equal(start.revision, 0);
    await assert.rejects(
      service.complete(actors.admin, 0),
      /confirm your name/,
    );
    const draft = {
      ...start.draft,
      step: 3,
      identityConfirmed: true,
      companyName: "Willow Quality",
      facilityName: "Ann Arbor",
      licenseNumber: "TEST-001",
      theme: "dark" as const,
    };
    const saved = await service.save(actors.admin, 0, draft);
    assert.deepEqual((await service.get(actors.admin)).draft, draft);
    assert.equal((await service.get(actors.colleague)).draft.companyName, "");
    await assert.rejects(
      service.save(actors.admin, 0, { ...draft, companyName: "Stale edit" }),
      /another tab/,
    );
    const deferred = await service.defer(actors.admin, saved.revision);
    assert(deferred.deferredAt);
    assert.equal(deferred.completedAt, null);
    assert.equal(
      (await pg.query("SELECT * FROM company_profile")).rows.length,
      0,
    );
    const complete = await service.complete(actors.admin, deferred.revision);
    assert(complete.completedAt);
    assert.equal(complete.deferredAt, null);
    assert.equal(complete.needsWorkspace, false);
    assert.equal(complete.facility?.licenseNumber, "TEST-001");
    assert.equal(
      (await pg.query("SELECT * FROM user_facilities WHERE user_id=1")).rows
        .length,
      1,
    );
    assert.equal(
      (
        await pg.query<{ active_facility_id: number }>(
          "SELECT active_facility_id FROM users WHERE id=1",
        )
      ).rows[0].active_facility_id,
      complete.facility?.id,
    );
    await service.complete(actors.admin, deferred.revision);
    assert.equal(
      (await pg.query("SELECT * FROM audit_log")).rows.length,
      1,
      "network retry must not duplicate completion",
    );
    const revised = await service.save(actors.admin, complete.revision, {
      ...complete.draft,
      theme: "light",
      companyName: "Do not overwrite",
    });
    const revisited = await service.complete(actors.admin, revised.revision);
    assert.equal(revisited.draft.theme, "light");
    assert.equal(revisited.companyName, "Willow Quality");
  } finally {
    await pg.close();
  }
});

test("onboarding enforces assignment, validates setup, and never exposes unassigned facilities", async () => {
  const { pg, service, actors } = await onboardingFixture();
  try {
    const admin = await service.get(actors.admin);
    let state = await service.save(actors.admin, admin.revision, {
      ...admin.draft,
      identityConfirmed: true,
    });
    await assert.rejects(
      service.complete(actors.admin, state.revision),
      /clear identity/,
    );
    assert.equal((await pg.query("SELECT * FROM facilities")).rows.length, 0);
    state = await service.save(actors.admin, state.revision, {
      ...state.draft,
      companyName: "Willow",
      facilityName: "North",
      licenseNumber: "TEST-002",
      timeZone: "not-a-zone",
    });
    await assert.rejects(
      service.complete(actors.admin, state.revision),
      /valid time zone/,
    );
    state = await service.save(actors.admin, state.revision, {
      ...state.draft,
      timeZone: "America/Detroit",
    });
    const ready = await service.complete(actors.admin, state.revision);
    const member = await service.get(actors.member);
    assert.equal(member.accessPending, true);
    assert.deepEqual(member.facilities, []);
    assert.equal(member.companyName, "");
    const forged = await service.save(actors.member, member.revision, {
      ...member.draft,
      identityConfirmed: true,
      facilityId: ready.facility!.id,
    });
    await assert.rejects(
      service.complete(actors.member, forged.revision),
      /assign you/,
    );
    await pg.exec(
      `INSERT INTO user_facilities(user_id,facility_id) VALUES(2,${ready.facility!.id})`,
    );
    const assigned = await service.get(actors.member);
    assert.equal(assigned.accessPending, false);
    const wrongSite = await service.save(actors.member, assigned.revision, {
      ...assigned.draft,
      facilityId: 999,
    });
    await assert.rejects(
      service.complete(actors.member, wrongSite.revision),
      /no longer available/,
    );
    const corrected = await service.save(actors.member, wrongSite.revision, {
      ...wrongSite.draft,
      facilityId: ready.facility!.id,
    });
    assert(
      (await service.complete(actors.member, corrected.revision)).completedAt,
    );
    await pg.exec("DELETE FROM user_facilities WHERE user_id=2");
    assert.equal((await service.get(actors.member)).accessPending, true);
    await assert.rejects(service.defer(actors.inactive, 0), /inactive/);
  } finally {
    await pg.close();
  }
});

test("HTTP onboarding routes require an active identity and reject role injection and malformed revisions", async () => {
  const { pg, service, actors } = await onboardingFixture();
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createOnboardingRouter(
      service,
      async (req) => actors[String(req.headers.authorization)] ?? null,
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/onboarding`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal(
      (await fetch(url, { headers: { authorization: "inactive" } })).status,
      401,
    );
    const response = await fetch(url, { headers: { authorization: "admin" } });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const state = await response.json();
    const patch = (body: unknown) =>
      fetch(url, {
        method: "PATCH",
        headers: { authorization: "admin", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await patch({ revision: 0, draft: { ...state.draft, role: "Admin" } }))
        .status,
      422,
    );
    assert.equal(
      (await patch({ revision: -1, draft: state.draft })).status,
      422,
    );
    assert.equal(
      (await patch({ revision: 0, draft: { ...state.draft, step: 2 } })).status,
      200,
    );
    assert.equal(
      (await patch({ revision: 0, draft: state.draft })).status,
      409,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pg.close();
  }
});

test("legacy single-site membership migrates once and never re-grants removed access", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { MEMBERSHIP_SCHEMA_SQL } = await import("../src/lib/membershipSchema");
  const pg = new PGlite();
  try {
    await pg.exec(
      "CREATE TABLE users(id integer PRIMARY KEY,active boolean); CREATE TABLE facilities(id integer PRIMARY KEY,is_active boolean); INSERT INTO users VALUES(1,true),(2,false); INSERT INTO facilities VALUES(1,true);",
    );
    await pg.exec(MEMBERSHIP_SCHEMA_SQL);
    assert.deepEqual(
      (await pg.query("SELECT user_id,facility_id FROM user_facilities")).rows,
      [{ user_id: 1, facility_id: 1 }],
    );
    await pg.exec(
      "DELETE FROM user_facilities; INSERT INTO users VALUES(3,true);",
    );
    await pg.exec(MEMBERSHIP_SCHEMA_SQL);
    assert.equal(
      (await pg.query("SELECT * FROM user_facilities")).rows.length,
      0,
    );
  } finally {
    await pg.close();
  }
});
