import { Router } from "express";
import { db, pool } from "@workspace/db";
import { facilitiesTable, companyProfileTable, facilityMetrcCredentialsTable, auditLogTable, userFacilitiesTable, usersTable, regulatoryConfigTable, LABEL_CHECKLIST_TEMPLATES, LABEL_CHECKLIST_VERSION } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { setFacilityTimeZone } from "../lib/facilityDate";
import { setFacilityMetrcConfig, getMetrcConfigStatus, getMetrcConfigSource } from "../lib/metrcClient";
import { setFacilityCode, setPrimaryFacilityId } from "../lib/recordNumber";
import { setRegulatoryConfigs, setFacilityState, getCachedRegulatoryStates } from "../lib/regulatoryRules";
import { setActingFacilityId, getActingFacilityId, SCOPED_DB_ROLE } from "../middlewares/facilityContext";
import { logger } from "../lib/logger";

// FACILITIES — multi-facility Phase 1 (2026-08-28).
//
// A facility IS a licence: the operating site that batches, inventory, training
// records and (from Phase 3) METRC credentials belong to. Exactly one exists
// today, seeded from the company profile by ensureSchema, so nothing in the app
// behaves differently — this router only makes that record readable and editable.
//
// No create/delete endpoint on purpose. A second facility is Phase 4, and it
// arrives with the switcher and the cross-site view rather than as a bare row
// somebody can add before any query is scoped to protect it.
const router = Router();

// Editing the site's licence details is a compliance function, so writes match the
// licence register's gate. Reads stay open to any signed-in user.
const WRITE_ROLES = new Set(["Admin", "Quality", "Manager"]);

/**
 * THE facility. Normally seeded by ensureSchema from the company profile; this
 * provisions one if that INSERT found no profile to copy, so the app can never be
 * in a state where records have nowhere to belong.
 */
export async function getOrCreatePrimaryFacility(): Promise<typeof facilitiesTable.$inferSelect> {
  const [existing] = await db.select().from(facilitiesTable).orderBy(asc(facilitiesTable.id)).limit(1);
  if (existing) return existing;

  const [profile] = await db.select().from(companyProfileTable).limit(1);
  const [created] = await db
    .insert(facilitiesTable)
    .values({
      name: (profile?.companyName ?? "").trim() || "Main Facility",
      licenseNumber: profile?.licenseNumber ?? null,
      state: (profile?.state ?? "").trim() || "MI",
      address: profile?.address ?? null,
      city: profile?.city ?? null,
      zip: profile?.zip ?? null,
      phone: profile?.phone ?? null,
      contactPerson: profile?.contactPerson ?? null,
      timeZone: profile?.timeZone ?? null,
    })
    .returning();
  logger.info({ facilityId: created?.id }, "Primary facility provisioned");
  return created;
}

/**
 * Load the facility time zone into the date layer at boot.
 *
 * Moved off the company profile 2026-08-28: the zone belongs to the SITE, and an
 * operator with a Michigan plant and a Missouri plant has two of them. Until the
 * per-facility date layer of a later phase, the primary facility's zone is the
 * one the server stamps dates in — which for a single-site customer is the same
 * value they already had, carried across by the seed.
 *
 * Held in memory rather than read per call because every caller of
 * facilityDateStr() is synchronous and there are dozens of them.
 */
export async function loadFacilityTimeZone(): Promise<void> {
  const facility = await getOrCreatePrimaryFacility();
  // Phase 2: the request middleware needs the facility id too, and this is the one
  // place that already resolves it at boot.
  setActingFacilityId(facility?.id ?? null);
  const applied = setFacilityTimeZone(facility?.timeZone ?? null);
  logger.info(
    { facilityId: facility?.id, timeZone: applied, configured: facility?.timeZone ?? null },
    "Facility time zone loaded",
  );
}

/**
 * Load the facility's METRC connection into the client at boot.
 *
 * A facility IS a licence and METRC issues credentials per licence, so this is
 * where the connection belongs. Held in memory rather than read per call because
 * getMetrcConfig() is synchronous and dozens of call sites depend on that — the
 * same arrangement the time zone uses.
 *
 * ⚠️ Never fatal. A database that cannot be read here must not take METRC down:
 * the client simply carries on with the METRC_* environment variables, which is
 * how it worked before any of this existed.
 */
export async function loadFacilityMetrcConfig(): Promise<void> {
  try {
    const primary = await getOrCreatePrimaryFacility();
    setPrimaryFacilityId(primary.id);

    // EVERY facility, not just the first: a request acting for Bay City needs Bay
    // City's licence, and it needs it without a database round trip on every METRC
    // call. Refreshed whenever a connection is saved.
    const all = await db.select().from(facilitiesTable);
    const creds = await db.select().from(facilityMetrcCredentialsTable);
    const credsById = new Map(creds.map((c) => [c.facilityId, c]));
    for (const f of all) {
      // The site code is needed by record numbering on every insert, so it is held in
      // memory beside the connection rather than fetched per record.
      setFacilityCode(f.id, f.code);
      setFacilityMetrcConfig(f.id, {
        baseUrl: f.metrcBaseUrl,
        licenseNumber: f.metrcLicenseNumber,
        vendorKey: credsById.get(f.id)?.vendorKey ?? null,
        userKey: credsById.get(f.id)?.userKey ?? null,
      });
    }
    logger.info(
      { facilities: all.length, primaryFacilityId: primary.id, source: getMetrcConfigSource() },
      "Facility METRC connections loaded",
    );
  } catch (err) {
    logger.warn({ err }, "Could not load the facility METRC connections — falling back to the environment");
  }
}

/**
 * Seed Michigan's label checklist onto its rule set — ONCE, and only if absent.
 *
 * Phase 5 step 1. The question set used to live only in the constants of
 * lib/db/src/schema/batch_labeling.ts, which made the CODE the source of truth
 * for what a state requires. It is written here FROM those same constants rather
 * than retyped into a migration, so the seeded questions are byte-identical to
 * what the app asked yesterday and this move cannot change a single word.
 *
 * ⛔ MICHIGAN ONLY. Those templates are Michigan's, cited to Michigan rules
 * (badly - see the found list), and copying them onto Illinois or New York would
 * assert that those states ask the same questions. They do not. A state with no
 * set falls back to the code, which is exactly today's behaviour.
 *
 * ⛔ Never overwrites. Once a set exists it is the customer's, and step 2 of this
 * work replaces the content deliberately, not on a boot pass.
 */
async function seedMichiganLabelChecklists(): Promise<void> {
  const [mi] = await db.select().from(regulatoryConfigTable).where(eq(regulatoryConfigTable.state, "MI"));
  if (!mi) return;
  const existing = (mi.additionalConfig ?? {}) as Record<string, unknown>;
  // A seeded copy records the version it came from. Replace it only when the code
  // carries a HIGHER one — that is the single sanctioned way to push a content
  // correction onto an already-seeded state, and without it the 2026-08-30 rewrite
  // (which replaced citations pointing at the hearings chapter) would never land.
  const seededVersion = Number(existing["labelChecklistsVersion"] ?? 0);
  if (existing["labelChecklists"] && seededVersion >= LABEL_CHECKLIST_VERSION) return;
  await db
    .update(regulatoryConfigTable)
    .set({
      additionalConfig: {
        ...existing,
        labelChecklists: LABEL_CHECKLIST_TEMPLATES,
        labelChecklistsVersion: LABEL_CHECKLIST_VERSION,
      },
    })
    .where(eq(regulatoryConfigTable.id, mi.id));
  logger.info(
    { productTypes: Object.keys(LABEL_CHECKLIST_TEMPLATES).length, from: seededVersion, to: LABEL_CHECKLIST_VERSION },
    "Michigan label checklists seeded onto the state rule set",
  );
}

/**
 * Load the per-state regulatory rule sets, and which state each facility sits in.
 *
 * `regulatory_config` was always keyed by state, but the live readers fetched it
 * with `.limit(1)` — the first row, whatever state it belonged to. That is
 * correct by accident for a single-state customer and wrong the moment a second
 * state exists. Caching both halves here lets `regulatoryRules.ts` answer
 * synchronously, the same arrangement the time zone and METRC connection use.
 *
 * ⚠️ Never fatal. If this cannot be read the resolver falls back to the same
 * default limits the old `.limit(1)` readers used when their query found nothing,
 * so a database hiccup cannot take testing or the tracking provider down.
 */
export async function loadRegulatoryRules(): Promise<void> {
  try {
    await seedMichiganLabelChecklists();
    const [configs, all] = await Promise.all([
      db.select().from(regulatoryConfigTable),
      db.select().from(facilitiesTable),
    ]);
    setRegulatoryConfigs(configs);
    for (const f of all) setFacilityState(f.id, f.state);
    logger.info(
      { states: getCachedRegulatoryStates(), facilities: all.length },
      "Regulatory rule sets loaded",
    );
  } catch (err) {
    logger.warn({ err }, "Could not load the regulatory rule sets — falling back to default limits");
  }
}

/**
 * GET /facilities/:id/metrc — the connection, WITHOUT the keys.
 *
 * ⛔ The vendor and user keys are never returned by any endpoint, to anyone. What
 * comes back is whether each half is set and where it is coming from, which is
 * everything the screen needs to tell somebody their connection is configured.
 */
router.get("/facilities/:id/metrc", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [facility] = await db.select().from(facilitiesTable).where(eq(facilitiesTable.id, id)).limit(1);
    if (!facility) {
      res.status(404).json({ error: "Facility not found" });
      return;
    }
    const [creds] = await db
      .select()
      .from(facilityMetrcCredentialsTable)
      .where(eq(facilityMetrcCredentialsTable.facilityId, id))
      .limit(1);

    const status = getMetrcConfigStatus();
    res.json({
      facilityId: id,
      metrcBaseUrl: facility.metrcBaseUrl,
      metrcLicenseNumber: facility.metrcLicenseNumber,
      hasVendorKey: !!(creds?.vendorKey ?? "").trim(),
      hasUserKey: !!(creds?.userKey ?? "").trim(),
      updatedByName: creds?.updatedByName ?? null,
      updatedAt: creds?.updatedAt ?? null,
      // What the server is ACTUALLY using right now, so the screen can say plainly
      // that the connection is still coming from the environment.
      effective: { ...status, source: getMetrcConfigSource() },
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get the facility METRC connection");
    res.status(500).json({ error: "Failed to get the facility METRC connection" });
  }
});

/**
 * PUT /facilities/:id/metrc — set the connection. ADMIN ONLY.
 *
 * A key is only written when a non-empty value is sent, so saving the licence
 * number does not wipe the keys: the screen never holds them and could not send
 * them back. Sending the literal string "clear" for a key removes it, which is how
 * a facility hands the connection back to the environment.
 */
router.put("/facilities/:id/metrc", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    // Deliberately tighter than the rest of this router. Editing the site's address
    // is a compliance-officer job; holding the credentials that write to the state's
    // tracking system is not.
    if (user.role !== "Admin") {
      res.status(403).json({ error: "Only an Admin can change the METRC connection." });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [facility] = await db.select().from(facilitiesTable).where(eq(facilitiesTable.id, id)).limit(1);
    if (!facility) {
      res.status(404).json({ error: "Facility not found" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const clean = (v: unknown) => {
      const t = v === null || v === undefined ? "" : String(v).trim();
      return t === "" ? null : t;
    };

    if (body.metrcBaseUrl !== undefined || body.metrcLicenseNumber !== undefined) {
      const update: Partial<typeof facilitiesTable.$inferInsert> = { updatedAt: new Date() };
      if (body.metrcBaseUrl !== undefined) update.metrcBaseUrl = clean(body.metrcBaseUrl);
      if (body.metrcLicenseNumber !== undefined) update.metrcLicenseNumber = clean(body.metrcLicenseNumber);
      await db.update(facilitiesTable).set(update).where(eq(facilitiesTable.id, id));
    }

    const [existing] = await db
      .select()
      .from(facilityMetrcCredentialsTable)
      .where(eq(facilityMetrcCredentialsTable.facilityId, id))
      .limit(1);

    const nextKey = (sent: unknown, current: string | null | undefined): string | null => {
      if (sent === undefined) return current ?? null; // not sent — leave it alone
      const v = clean(sent);
      if (v === null) return current ?? null; // blank — leave it alone
      if (v.toLowerCase() === "clear") return null; // explicit removal
      return v;
    };
    const vendorKey = nextKey(body.vendorKey, existing?.vendorKey);
    const userKey = nextKey(body.userKey, existing?.userKey);

    if (existing) {
      await db
        .update(facilityMetrcCredentialsTable)
        .set({ vendorKey, userKey, updatedByName: user.fullName, updatedAt: new Date() })
        .where(eq(facilityMetrcCredentialsTable.id, existing.id));
    } else {
      await db
        .insert(facilityMetrcCredentialsTable)
        .values({ facilityId: id, vendorKey, userKey, updatedByName: user.fullName });
    }

    // The credentials table is excluded from the audit triggers so a key value can
    // never land in the audit log. The CHANGE still has to be recorded, so it is
    // written here by hand, in terms of what was set rather than what it was set to.
    const describe = (before: string | null | undefined, after: string | null) =>
      (before ?? null) === after ? "unchanged" : after ? "set" : "cleared";
    await db.insert(auditLogTable).values({
      tableName: "facility_metrc_credentials",
      rowId: id,
      operation: "METRC_CONNECTION_CHANGED",
      changedBy: user.id,
      changedByName: user.fullName,
      beforeState: {
        vendorKey: existing?.vendorKey ? "***" : null,
        userKey: existing?.userKey ? "***" : null,
        metrcBaseUrl: facility.metrcBaseUrl,
        metrcLicenseNumber: facility.metrcLicenseNumber,
      },
      afterState: {
        vendorKey: describe(existing?.vendorKey, vendorKey),
        userKey: describe(existing?.userKey, userKey),
        metrcBaseUrl: body.metrcBaseUrl !== undefined ? clean(body.metrcBaseUrl) : facility.metrcBaseUrl,
        metrcLicenseNumber:
          body.metrcLicenseNumber !== undefined ? clean(body.metrcLicenseNumber) : facility.metrcLicenseNumber,
      },
    });

    // Take effect on the next METRC call rather than at the next deploy.
    await loadFacilityMetrcConfig();

    const [after] = await db.select().from(facilitiesTable).where(eq(facilitiesTable.id, id)).limit(1);
    res.json({
      facilityId: id,
      metrcBaseUrl: after?.metrcBaseUrl ?? null,
      metrcLicenseNumber: after?.metrcLicenseNumber ?? null,
      hasVendorKey: !!vendorKey,
      hasUserKey: !!userKey,
      effective: { ...getMetrcConfigStatus(), source: getMetrcConfigSource() },
    });
  } catch (err) {
    req.log.error({ err }, "Failed to save the facility METRC connection");
    res.status(500).json({ error: "Failed to save the facility METRC connection" });
  }
});

/**
 * GET /scoping-status — IS THE REFUSAL ACTUALLY IN FORCE?
 *
 * Row-level security is the kind of protection that fails silently. Postgres
 * exempts a table's owner from its own policies unless the table is FORCEd, and
 * exempts a SUPERUSER even then — so a database handed over with a superuser
 * connection would accept every policy without applying a single one, and the app
 * would look scoped while enforcing nothing.
 *
 * So this does not report what was configured. It PROVES it: on its own
 * connection, it claims to be a facility that does not exist and then counts the
 * rows the database is willing to return. Zero means the refusal is real.
 */
router.get("/scoping-status", async (req, res) => {
  const client = await pool.connect();
  try {
    const roles = await client.query(
      "SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    const role = roles.rows[0] ?? {};

    const tables = await client.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relkind = 'r'
          AND relrowsecurity
        ORDER BY relname`,
    );

    const scopedRole = await client.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
      [SCOPED_DB_ROLE],
    );

    // Count the rows first, as the connecting account, before switching identity.
    const total = await client.query("SELECT count(*)::int AS total FROM lots");

    // THE PROOF, run exactly as a request runs: become the restricted identity,
    // claim to be a facility that cannot exist, and count what the database is
    // still willing to hand over. Every lot belongs to facility 1, so an enforcing
    // database returns none of them. Anything above zero means the rules are not
    // being applied — which is precisely what this reported before the restricted
    // identity existed, when the master account walked past all nineteen policies.
    let visible = -1;
    try {
      await client.query(`SET ROLE ${SCOPED_DB_ROLE}`);
      await client.query("SELECT set_config('app.facility_id', '-1', false)");
      const probe = await client.query("SELECT count(*)::int AS visible FROM lots");
      visible = probe.rows[0]?.visible ?? -1;
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
    }

    res.json({
      actingFacilityId: getActingFacilityId(),
      // The account Railway connects as. Expected to be a superuser — that is the
      // whole reason requests switch identity rather than relying on this one.
      databaseUser: role.name ?? null,
      isSuperuser: !!role.rolsuper,
      bypassesRowSecurity: !!role.rolbypassrls,
      scopedRole: {
        name: SCOPED_DB_ROLE,
        exists: scopedRole.rows.length > 0,
        isSuperuser: !!scopedRole.rows[0]?.rolsuper,
        bypassesRowSecurity: !!scopedRole.rows[0]?.rolbypassrls,
      },
      tablesWithRowSecurity: tables.rows.length,
      tablesNotForced: tables.rows.filter((t: { relforcerowsecurity: boolean }) => !t.relforcerowsecurity)
        .map((t: { relname: string }) => t.relname),
      probe: {
        table: "lots",
        rowsVisibleAsAnUnknownFacility: visible,
        rowsInTable: total.rows[0]?.total ?? null,
      },
      // The single answer worth reading. It is the PROBE that decides it, not the
      // configuration: the database was asked for another facility's rows and
      // refused. Nothing else here can make this true.
      enforced: visible === 0 && tables.rows.length > 0,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to check the facility scoping status");
    res.status(500).json({ error: "Failed to check the facility scoping status" });
  } finally {
    // Never leave a probe's setting on a pooled connection.
    await client.query("SELECT set_config('app.facility_id', '', false)").catch(() => undefined);
    client.release();
  }
});

// GET /facilities — every facility, oldest first. A list today of exactly one.
router.get("/facilities", async (req, res) => {
  try {
    await getOrCreatePrimaryFacility();
    const rows = await db.select().from(facilitiesTable).orderBy(asc(facilitiesTable.id));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list facilities");
    res.status(500).json({ error: "Failed to list facilities" });
  }
});

// ── WHICH SITE AM I WORKING AT? (multi-facility Phase 4, 2026-08-28) ──────────
//
// A person can be listed at several sites — that is how a quality director covering
// three plants works, and their signature identity stays single throughout. What
// they are ACTING FOR at this moment is one site, and it decides what every screen
// shows them and where their new records belong.
//
// ⛔ The browser never tells the server which facility to use. It asks to switch, the
// server checks the person is actually listed there, and stores it on the person. A
// facility the browser could set is a facility the browser could lie about, and the
// lie would be "show me the other plant's batches".

// GET /me/facilities — the sites this person may work at, and which one is live.
router.get("/me/facilities", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user) { res.status(401).json({ error: "Not signed in" }); return; }
    const rows = await db
      .select({
        id: facilitiesTable.id,
        name: facilitiesTable.name,
        code: facilitiesTable.code,
        state: facilitiesTable.state,
        isActive: facilitiesTable.isActive,
      })
      .from(userFacilitiesTable)
      .innerJoin(facilitiesTable, eq(facilitiesTable.id, userFacilitiesTable.facilityId))
      .where(eq(userFacilitiesTable.userId, user.id))
      .orderBy(asc(facilitiesTable.id));

    const active =
      rows.find((f) => f.id === (user as { activeFacilityId?: number | null }).activeFacilityId)?.id ??
      rows[0]?.id ??
      null;
    res.json({ facilities: rows, activeFacilityId: active });
  } catch (err) {
    req.log.error({ err }, "Failed to list the sites for this person");
    res.status(500).json({ error: "Failed to list the sites for this person" });
  }
});

// POST /me/facility — switch to another site I am listed at.
router.post("/me/facility", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user) { res.status(401).json({ error: "Not signed in" }); return; }
    const facilityId = parseInt(String((req.body ?? {}).facilityId ?? ""), 10);
    if (!Number.isFinite(facilityId)) {
      res.status(400).json({ error: "Invalid facility" });
      return;
    }
    // The only check that matters: are they actually listed there? Without it, anyone
    // could switch to any site and read it.
    const [membership] = await db
      .select()
      .from(userFacilitiesTable)
      .where(and(eq(userFacilitiesTable.userId, user.id), eq(userFacilitiesTable.facilityId, facilityId)));
    if (!membership) {
      res.status(403).json({ error: "You are not listed at that facility." });
      return;
    }
    await db.update(usersTable).set({ activeFacilityId: facilityId }).where(eq(usersTable.id, user.id));
    const [facility] = await db.select().from(facilitiesTable).where(eq(facilitiesTable.id, facilityId));
    res.json({ ok: true, activeFacilityId: facilityId, name: facility?.name ?? null });
  } catch (err) {
    req.log.error({ err }, "Failed to switch facility");
    res.status(500).json({ error: "Failed to switch facility" });
  }
});

// POST /facilities — open a second site. ADMIN ONLY.
//
// Deliberately absent until now: a facility that exists before the queries are scoped
// to protect it is a facility whose records leak. That work is done, so this can
// exist. Creating a site does NOT move anybody to it — people are added separately,
// and until someone is added, nobody can switch to it.
router.post("/facilities", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user) { res.status(401).json({ error: "Not signed in" }); return; }
    if (user.role !== "Admin") {
      res.status(403).json({ error: "Only an Admin can add a facility." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = (v: unknown) => {
      const t = v === null || v === undefined ? "" : String(v).trim();
      return t === "" ? null : t;
    };
    const name = text(body.name);
    if (!name) { res.status(400).json({ error: "A facility needs a name." }); return; }

    // The code is how a record says which plant it came from, so it is required from
    // the second site onwards and checked for collisions before anything is written.
    const code = text(body.code)?.toUpperCase() ?? null;
    if (!code || !/^[A-Z0-9]{2,4}$/.test(code)) {
      res.status(400).json({ error: "Give the site a short code — two to four letters or numbers, like AA or BC." });
      return;
    }
    const existingCodes = await db.select({ code: facilitiesTable.code }).from(facilitiesTable);
    if (existingCodes.some((f) => (f.code ?? "").trim().toUpperCase() === code)) {
      res.status(409).json({ error: `Another facility already uses the code ${code}.` });
      return;
    }

    const [created] = await db
      .insert(facilitiesTable)
      .values({
        name,
        code,
        licenseNumber: text(body.licenseNumber),
        licenseType: text(body.licenseType),
        state: (text(body.state) ?? "MI").toUpperCase(),
        address: text(body.address),
        city: text(body.city),
        zip: text(body.zip),
        phone: text(body.phone),
        contactPerson: text(body.contactPerson),
        timeZone: text(body.timeZone),
      })
      .returning();

    await db.insert(auditLogTable).values({
      tableName: "facilities",
      rowId: created.id,
      operation: "FACILITY_CREATED",
      changedBy: user.id,
      changedByName: user.fullName,
      beforeState: null,
      afterState: { name: created.name, code: created.code, state: created.state },
    });

    setFacilityCode(created.id, created.code);
    // A new site's state decides which rule set its records are judged against.
    setFacilityState(created.id, created.state);

    res.status(201).json(created);
  } catch (err) {
    req.log.error({ err }, "Failed to create a facility");
    res.status(500).json({ error: "Failed to create a facility" });
  }
});

// GET /facilities/:id/people — who works at this site.
router.get("/facilities/:id/people", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const rows = await db
      .select({
        userId: usersTable.id,
        fullName: usersTable.fullName,
        email: usersTable.email,
        role: usersTable.role,
        active: usersTable.active,
      })
      .from(userFacilitiesTable)
      .innerJoin(usersTable, eq(usersTable.id, userFacilitiesTable.userId))
      .where(eq(userFacilitiesTable.facilityId, id))
      .orderBy(asc(usersTable.fullName));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list the people at a facility");
    res.status(500).json({ error: "Failed to list the people at a facility" });
  }
});

// POST /facilities/:id/people — add someone to a site. ADMIN ONLY.
//
// ⚠️ His open flag, not solved here: "we still need to be aware that people are not
// being removed with this software." METRC is the authority on who is at a site; this
// list has to be kept in step with it by hand for now.
router.post("/facilities/:id/people", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user) { res.status(401).json({ error: "Not signed in" }); return; }
    if (user.role !== "Admin") {
      res.status(403).json({ error: "Only an Admin can change who works at a facility." });
      return;
    }
    const facilityId = parseInt(req.params.id, 10);
    const userId = parseInt(String((req.body ?? {}).userId ?? ""), 10);
    if (!Number.isFinite(facilityId) || !Number.isFinite(userId)) {
      res.status(400).json({ error: "Invalid facility or user" });
      return;
    }
    await db.insert(userFacilitiesTable).values({ userId, facilityId }).onConflictDoNothing();
    res.status(201).json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to add someone to a facility");
    res.status(500).json({ error: "Failed to add someone to a facility" });
  }
});

// DELETE /facilities/:id/people/:userId — take someone off a site. ADMIN ONLY.
router.delete("/facilities/:id/people/:userId", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user) { res.status(401).json({ error: "Not signed in" }); return; }
    if (user.role !== "Admin") {
      res.status(403).json({ error: "Only an Admin can change who works at a facility." });
      return;
    }
    const facilityId = parseInt(req.params.id, 10);
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(facilityId) || !Number.isFinite(userId)) {
      res.status(400).json({ error: "Invalid facility or user" });
      return;
    }
    // Nobody may be left with no site at all: they would sign in with nothing to act
    // for, and every screen would refuse them.
    const theirSites = await db
      .select()
      .from(userFacilitiesTable)
      .where(eq(userFacilitiesTable.userId, userId));
    if (theirSites.length <= 1) {
      res.status(409).json({ error: "This is the only facility this person works at. Add them to another first." });
      return;
    }
    await db
      .delete(userFacilitiesTable)
      .where(and(eq(userFacilitiesTable.userId, userId), eq(userFacilitiesTable.facilityId, facilityId)));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to remove someone from a facility");
    res.status(500).json({ error: "Failed to remove someone from a facility" });
  }
});

// GET /facilities/primary — THE facility, provisioning it if it is somehow absent.
// Declared before /facilities/:id so "primary" is never parsed as an id.
router.get("/facilities/primary", async (req, res) => {
  try {
    res.json(await getOrCreatePrimaryFacility());
  } catch (err) {
    req.log.error({ err }, "Failed to get primary facility");
    res.status(500).json({ error: "Failed to get primary facility" });
  }
});

router.get("/facilities/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db.select().from(facilitiesTable).where(eq(facilitiesTable.id, id)).limit(1);
    if (!row) {
      res.status(404).json({ error: "Facility not found" });
      return;
    }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to get facility");
    res.status(500).json({ error: "Failed to get facility" });
  }
});

// PATCH /facilities/:id — edit the site's details (elevated roles).
router.patch("/facilities/:id", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    if (!WRITE_ROLES.has(user.role)) {
      res.status(403).json({ error: "Not permitted for your role." });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [existing] = await db.select().from(facilitiesTable).where(eq(facilitiesTable.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Facility not found" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const update: Partial<typeof facilitiesTable.$inferInsert> = { updatedAt: new Date() };
    const text = (v: unknown) => (v === null || String(v).trim() === "" ? null : String(v).trim());

    if (body.name !== undefined) {
      const name = text(body.name);
      if (!name) {
        res.status(400).json({ error: "A facility needs a name." });
        return;
      }
      update.name = name;
    }
    if (body.code !== undefined) {
      // The code goes into the numbers of records raised at this site, so it has to
      // be short, plain, and not already taken by another plant.
      const code = text(body.code)?.toUpperCase() ?? null;
      if (code && !/^[A-Z0-9]{2,4}$/.test(code)) {
        res.status(400).json({ error: "A site code is two to four letters or numbers, like BA or DE." });
        return;
      }
      if (code) {
        const others = await db.select({ id: facilitiesTable.id, code: facilitiesTable.code }).from(facilitiesTable);
        if (others.some((f) => f.id !== id && (f.code ?? "").trim().toUpperCase() === code)) {
          res.status(409).json({ error: `Another facility already uses the code ${code}.` });
          return;
        }
      }
      update.code = code;
    }
    if (body.licenseNumber !== undefined) update.licenseNumber = text(body.licenseNumber);
    if (body.licenseType !== undefined) update.licenseType = text(body.licenseType);
    if (body.state !== undefined) update.state = (text(body.state) ?? "MI").toUpperCase();
    if (body.address !== undefined) update.address = text(body.address);
    if (body.city !== undefined) update.city = text(body.city);
    if (body.zip !== undefined) update.zip = text(body.zip);
    if (body.phone !== undefined) update.phone = text(body.phone);
    if (body.contactPerson !== undefined) update.contactPerson = text(body.contactPerson);
    if (body.timeZone !== undefined) update.timeZone = text(body.timeZone);
    if (body.notes !== undefined) update.notes = text(body.notes);
    if (body.isActive !== undefined) update.isActive = !!body.isActive;

    const [updated] = await db
      .update(facilitiesTable)
      .set(update)
      .where(eq(facilitiesTable.id, id))
      .returning();

    // Take effect immediately rather than at the next deploy — the date layer holds
    // the zone in memory, so a saved change has to be pushed into it. Only the
    // primary facility drives it while there is exactly one date layer.
    if (body.timeZone !== undefined) {
      const [primary] = await db.select().from(facilitiesTable).orderBy(asc(facilitiesTable.id)).limit(1);
      if (primary?.id === id) {
        const applied = setFacilityTimeZone(updated?.timeZone ?? null);
        logger.info({ facilityId: id, timeZone: applied, requested: body.timeZone }, "Facility time zone changed");
      }
    }

    if (body.code !== undefined) setFacilityCode(id, updated?.code ?? null);
    // Moving a site to another state changes the limits its records are held to,
    // so the cached rule set has to follow the edit rather than wait for a restart.
    if (body.state !== undefined) setFacilityState(id, updated?.state ?? null);

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to update facility");
    res.status(500).json({ error: "Failed to update facility" });
  }
});

export default router;
