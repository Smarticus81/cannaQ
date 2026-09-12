import { Router } from "express";
import { db, pool } from "@workspace/db";
import { facilitiesTable, userFacilitiesTable, nonConformancesTable, capasTable, complaintsTable, fieldActionsTable } from "@workspace/db";
import { asc, eq, inArray } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { SCOPED_DB_ROLE } from "../middlewares/facilityContext";

// THE CORPORATE VIEW — multi-facility Phase 4 (2026-08-28).
//
// One screen across the sites a person is listed at. His reason for wanting it:
//   "If I were director over all sites, I would want to see metrics from everyone.
//    That could help me identify global issues."
// Three plants hitting the same cartridge failure is a pattern nobody can see from
// inside one plant.
//
// ⛔ IT DOES NOT GO AROUND THE PROTECTION. Two different jobs, two honest methods:
//
//   * Quality events — non-conformances, CAPAs, complaints, field actions — are
//     raised at a plant and listed company-wide by design, so their tables carry no
//     facility rule and one grouped query answers for every site at once.
//
//   * Everything that belongs to ONE plant — batches, lots, training records — is
//     hidden from the other plants by the database itself. So this asks each site IN
//     TURN: it becomes that site, counts what that site can see, and moves on. Slower
//     than one clever query, and the slowness is the point — there is no back door
//     here for anyone to find later.
//
// ⛔ And only the sites the person is LISTED at. A director covering three plants
// sees three; somebody at one plant sees one, and the screen does not appear for them.
const router = Router();

/**
 * Count something at each site in turn, as that site.
 *
 * One connection, becoming each facility in sequence: exactly what an ordinary
 * request does, repeated. The restricted identity is used throughout, so the row
 * rules apply here the same as anywhere else.
 */
async function countAtEachSite(facilityIds: number[], sql: string): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (facilityIds.length === 0) return out;
  const client = await pool.connect();
  try {
    await client.query(`SET ROLE ${SCOPED_DB_ROLE}`);
    for (const id of facilityIds) {
      await client.query("SELECT set_config('app.facility_id', $1, false)", [String(id)]);
      const { rows } = await client.query<{ n: string }>(sql);
      out.set(id, Number(rows[0]?.n ?? 0));
    }
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query("SELECT set_config('app.facility_id', '', false)").catch(() => undefined);
    client.release();
  }
  return out;
}

function tally<T extends { facilityId: number | null }>(rows: T[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of rows) {
    if (r.facilityId == null) continue;
    m.set(r.facilityId, (m.get(r.facilityId) ?? 0) + 1);
  }
  return m;
}

// GET /corporate/summary — every site this person works at, side by side.
router.get("/corporate/summary", async (req, res) => {
  try {
    const user = await getOrProvisionCurrentUser(req);
    if (!user) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }

    const sites = await db
      .select({
        id: facilitiesTable.id,
        name: facilitiesTable.name,
        code: facilitiesTable.code,
        state: facilitiesTable.state,
        licenseType: facilitiesTable.licenseType,
      })
      .from(userFacilitiesTable)
      .innerJoin(facilitiesTable, eq(facilitiesTable.id, userFacilitiesTable.facilityId))
      .where(eq(userFacilitiesTable.userId, user.id))
      .orderBy(asc(facilitiesTable.id));

    const ids = sites.map((s) => s.id);
    if (ids.length === 0) {
      res.json({ sites: [] });
      return;
    }

    // Company-wide tables: one query each, grouped in memory. Restricted to the
    // person's own sites — a record raised somewhere they do not work is not theirs
    // to count.
    const [ncs, capas, complaints, fieldActions] = await Promise.all([
      db.select({ facilityId: nonConformancesTable.facilityId }).from(nonConformancesTable).where(inArray(nonConformancesTable.facilityId, ids)),
      db.select({ facilityId: capasTable.facilityId }).from(capasTable).where(inArray(capasTable.facilityId, ids)),
      db.select({ facilityId: complaintsTable.facilityId }).from(complaintsTable).where(inArray(complaintsTable.facilityId, ids)),
      db.select({ facilityId: fieldActionsTable.facilityId }).from(fieldActionsTable).where(inArray(fieldActionsTable.facilityId, ids)),
    ]);
    const ncBy = tally(ncs);
    const capaBy = tally(capas);
    const complaintBy = tally(complaints);
    const faBy = tally(fieldActions);

    // Site-owned tables: asked of each site, as that site.
    const [batches, lots, training, docs] = await Promise.all([
      countAtEachSite(ids, "SELECT count(*)::int AS n FROM batch_records"),
      countAtEachSite(ids, "SELECT count(*)::int AS n FROM lots"),
      countAtEachSite(ids, "SELECT count(*)::int AS n FROM training_records"),
      countAtEachSite(ids, "SELECT count(*)::int AS n FROM documents WHERE facility_id IS NOT NULL"),
    ]);

    res.json({
      sites: sites.map((s) => ({
        ...s,
        nonConformances: ncBy.get(s.id) ?? 0,
        capas: capaBy.get(s.id) ?? 0,
        complaints: complaintBy.get(s.id) ?? 0,
        fieldActions: faBy.get(s.id) ?? 0,
        batches: batches.get(s.id) ?? 0,
        lots: lots.get(s.id) ?? 0,
        trainingRecords: training.get(s.id) ?? 0,
        localDocuments: docs.get(s.id) ?? 0,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to build the corporate summary");
    res.status(500).json({ error: "Failed to build the corporate summary" });
  }
});

export default router;
