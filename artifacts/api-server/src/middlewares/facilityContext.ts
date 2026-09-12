import type { NextFunction, Request, Response } from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import { dbContext, pool, schema, db, usersTable, userFacilitiesTable, facilitiesTable } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { serviceTokenUser } from "../lib/currentUser";
import { logger } from "../lib/logger";
import { facilityIdStore } from "../lib/recordNumber";

// FACILITY CONTEXT — multi-facility Phase 2, step 1 (2026-08-28).
//
// ⛔ THE POINT: scoping that cannot be forgotten.
//
// Every request checks out one database connection and TELLS Postgres which
// facility it is acting for, as a session setting (`app.facility_id`). Two things
// then follow without a single route being edited:
//
//   1. New records are stamped with that facility, because the facility_id columns
//      take their DEFAULT from this setting (see ensureSchema).
//   2. Row-level security reads it back to decide which rows a query may see
//      (step 2 — the policies are not on yet).
//
// The alternative was a helper every query had to remember to use, and a forgotten
// one shows a Michigan operator a Missouri batch. This way the guarantee sits below
// the code that could forget it.
//
// ⚠️ A CONNECTION IS HELD FOR THE LIFE OF THE REQUEST. It has to be: the setting
// and the query that reads it must be on the same connection. A screen waiting on
// METRC therefore holds a connection while it waits. The pool is sized for that
// (see @workspace/db) — if this app ever HANGS rather than errors, start here.

/**
 * Which facility a request is acting for.
 *
 * Today there is exactly one, loaded at boot, so this is not a per-request query —
 * it is a lookup of a number that cannot change. When the facility switcher lands
 * (Phase 4) this is the ONE function that has to learn about the person's choice
 * and the sites they are listed at; nothing else in the request path changes.
 */
// ⛔ THE OFF SWITCH. Delete this line (and the SET LOCAL ROLE that uses it, four
// lines further down) and the app goes back to talking to the database as the
// account Railway gave it — which walks straight past the facility rules, exactly
// as it did before 2026-08-28. That is the one-line rollback if this ever locks a
// screen out with a "permission denied": the app keeps working, unscoped, and I
// can fix the missing grant without the app being down.
//
// WHY IT EXISTS: Railway connects the app as the database's master account, and
// Postgres exempts that account from its own rules. The nineteen tables were
// protected and the protection was doing nothing — proven, not assumed, by
// /api/scoping-status: claiming to be a facility that does not exist still
// returned all 107 lots. Switching to a restricted identity for the life of the
// request is what makes the rules bite. The identity cannot log in from outside
// and has no password, so it is not a credential anyone has to look after.
export const SCOPED_DB_ROLE = "cannaqms_scoped";

let actingFacilityId: number | null = null;

/** Called at boot, and whenever the facility record changes. */
export function setActingFacilityId(id: number | null): void {
  actingFacilityId = id ?? null;
}

/**
 * The facility whatever is running right now is acting for.
 *
 * ⛔ THE REQUEST'S facility first, and only then the single boot-time one. This read
 * the boot value alone until 2026-08-28, which meant a person standing at Bay City
 * had their new records stamped as Detroit's — and the database then refused to save
 * them, because a request acting for one site may not write into another. Caught by
 * creating a work instruction at the second site; it failed with a 500.
 */
export function getActingFacilityId(): number | null {
  return facilityIdStore.getStore() ?? actingFacilityId;
}

/**
 * Which facility THIS request is acting for.
 *
 * The person's own choice first (they switched to a site), then the first site they
 * are listed at, then the one facility that exists. The last of those is what a
 * single-site operator always gets, so nothing about their day changes.
 *
 * ⛔ Read from the database, never from the request. A facility the browser could
 * send is a facility the browser could lie about, and the lie would be "show me the
 * other plant's batches". The switch endpoint checks membership before storing it, so
 * by the time it is read here it has already been earned.
 *
 * This runs on the pooled handle, before the request's own connection is claimed —
 * it has to, because it is what decides what that connection will be told.
 */
async function resolveFacilityForRequest(req: Request): Promise<number | null> {
  try {
    // 2026-09-08 — a service-token request has no browser session, so resolve
    // its facility from the account the token acts as. Without this the token
    // would silently work against the DEFAULT facility while the same account in
    // a browser worked against its own site — the kind of split that shows up
    // later as "why is this batch on the wrong plant".
    const viaToken = await serviceTokenUser(req);
    let user: { id: number; activeFacilityId: number | null } | undefined;
    if (viaToken) {
      user = { id: viaToken.id, activeFacilityId: viaToken.activeFacilityId };
    } else {
      const { userId: clerkUserId } = getAuth(req);
      if (!clerkUserId) return null;
      [user] = await db
        .select({ id: usersTable.id, activeFacilityId: usersTable.activeFacilityId })
        .from(usersTable)
        .where(eq(usersTable.clerkUserId, clerkUserId));
    }
    if (!user) return null;

    const sites = await db
      .select({ facilityId: userFacilitiesTable.facilityId })
      .from(userFacilitiesTable)
      .innerJoin(facilitiesTable, eq(facilitiesTable.id, userFacilitiesTable.facilityId))
      .where(and(eq(userFacilitiesTable.userId, user.id), eq(facilitiesTable.isActive, true)))
      .orderBy(asc(userFacilitiesTable.facilityId));

    // Their choice only counts while they are still listed there — somebody taken off
    // a site should stop seeing it on their next click, not at their next sign-in.
    if (user.activeFacilityId && sites.some((s) => s.facilityId === user.activeFacilityId)) {
      return user.activeFacilityId;
    }
    return sites[0]?.facilityId ?? null;
  } catch (error) {
    // A lookup failure must not silently switch someone to a different facility.
    throw error;
  }
}

export function facilityContext() {
  return function facilityContextMiddleware(req: Request, res: Response, next: NextFunction): void {
    void resolveFacilityForRequest(req).then((facilityId) => {

    // New and unassigned accounts may use their personal onboarding endpoints,
    // which are mounted before this middleware, but never unscoped business data.
    if (facilityId == null) {
      res.status(403).json({ error: "Your administrator needs to assign an active facility.", code: "FACILITY_ACCESS_REQUIRED" });
      return;
    }

    void pool
      .connect()
      .then((client) => {
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          // Clear the setting before the connection goes back in the pool, so a
          // connection can never carry one request's facility into the next.
          // Hand the connection back as it was found: ordinary identity, no facility.
          // A pooled connection must never carry one request's identity or facility
          // into the next request that picks it up.
          client
            .query("RESET ROLE; SELECT set_config('app.facility_id', '', false)")
            .then(() => client.release())
            .catch((error) => client.release(error));
        };
        // Both, because a client that disconnects mid-response fires 'close' and
        // never 'finish' — and a leaked connection here is a connection gone for
        // the life of the process.
        res.on("finish", release);
        res.on("close", release);

        client
          // Two queries, not one string: a statement carrying a parameter cannot be
          // batched with another in the same call. Order matters — become the
          // restricted identity first, then declare the facility, so the whole
          // request runs as an account the facility rules actually apply to.
          //
          // This is why the connection is held for the request: the identity, the
          // facility setting, and every query that reads them back have to be the
          // same session. RESET happens on release.
          .query(`SET ROLE ${SCOPED_DB_ROLE}`)
          .then(() => client.query("SELECT set_config('app.facility_id', $1, false)", [String(facilityId)]))
          .then(() => {
            const scoped = drizzle(client, { schema });
            // The facility travels with the request too, not just its connection:
            // the METRC client reads it to pick the right licence, so a request acting
            // for Bay City can never write a package into Detroit's licence.
            dbContext.run({ db: scoped }, () => facilityIdStore.run(facilityId, () => next()));
          })
          .catch((err) => {
            // ⛔ FAIL CLOSED. Serving this request without a facility context would
            // mean serving it unscoped, and from step 2 unscoped means the database
            // hands back every site's rows. Refusing is the safe answer: a screen
            // that will not load is a support call, a screen showing another plant's
            // batches is a compliance incident.
            logger.error({ err }, "Could not set the facility context — refusing the request");
            release();
            res.status(503).json({ error: "Facility context unavailable. Please retry." });
          });
      })
      .catch((err) => {
        // Same reasoning as above — no connection means no scoping, so no answer.
        logger.error({ err }, "Could not check out a connection for the facility context");
        res.status(503).json({ error: "Facility context unavailable. Please retry." });
      });
    }).catch((err) => {
      logger.error({ err }, "Could not resolve the user's facility");
      if (!res.headersSent) res.status(503).json({ error: "Facility context unavailable. Please retry." });
    });
  };
}
