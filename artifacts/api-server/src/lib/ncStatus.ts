import { db } from "@workspace/db";
import { ncCorrectionsTable, capasTable } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";

// NC-8 (2026-07-13) — event-derived NC status.
//
// The middle NC states (In Progress / Awaiting Mgt Acknowledgement / Under
// Review) used to be set by hand from an "Update Status" button card, so the
// record routinely lied — it sat at "Open" while corrections were done, or read
// "Under Review" with nothing ready. This module computes the status from what
// is actually on the record, the same derive-on-read approach the app already
// uses for supplier-qualified status and the bell/queue tiles. The status is
// never written for these middle states; it's always calculated fresh.
//
// Terminal states stay persisted and authoritative: Closed is written by
// POST /approve (a signed Part 11 event) and Cancelled is tracked by
// cancelledAt (POST /cancel). Derivation never overrides those.
//
// Close-ready ("Under Review") gates, per Jonathan's 2026-07-13 decision:
//   - every recorded correction task complete,
//   - a root cause recorded,
//   - a disposition set,
//   - and (Major/Critical only) linked CAPA(s) closed — or a skip-CAPA
//     rationale on file, the same escape hatch the close gate already honors.
// Major/Critical NCs pause at "Awaiting Mgt Acknowledgement" between meeting
// those gates and management signing off; Minor NCs skip that rung.

export type NcStatusAgg = {
  correctionTotal: number;
  correctionPending: number;
  capaTotal: number;
};

export const EMPTY_NC_AGG: NcStatusAgg = {
  correctionTotal: 0,
  correctionPending: 0,
  capaTotal: 0,
};

export type NcStatusInput = {
  status: string;
  severity: string | null;
  rootCause: string | null;
  rootCauses: string[] | null;
  disposition: string | null;
  skipCapaRationale: string | null;
  mgmtAcknowledgedAt: Date | string | null;
  closedAt: Date | string | null;
  cancelledAt: Date | string | null;
  // Product context — a disposition is only required to become close-ready when
  // the NC actually concerns product (a batch/lot/named product). Pure process
  // or system NCs advance without one. (Jonathan, 2026-07-13.)
  batchId: number | null;
  lotNumber: string | null;
  productName: string | null;
  productType: string | null;
};

// True when the NC concerns physical product that would need a disposition.
function productInvolved(nc: NcStatusInput): boolean {
  return !!(
    nc.batchId ||
    (nc.lotNumber && nc.lotNumber.trim()) ||
    (nc.productName && nc.productName.trim()) ||
    (nc.productType && nc.productType.trim())
  );
}

// Compute the display status for one NC from its record + rolled-up aggregates.
export function deriveNcStatus(nc: NcStatusInput, agg: NcStatusAgg = EMPTY_NC_AGG): string {
  // Terminal, persisted states are authoritative — never re-derive them. A
  // cancelled NC keeps whatever status it carried (the UI marks it via
  // cancelledAt); a closed NC always reads "Closed".
  if (nc.cancelledAt) return nc.status;
  if (nc.closedAt || nc.status === "Closed") return "Closed";

  const correctionsComplete = agg.correctionPending === 0; // vacuously true when none recorded
  const rcaDone =
    !!(nc.rootCause && nc.rootCause.trim()) ||
    (Array.isArray(nc.rootCauses) && nc.rootCauses.length > 0);
  const dispositionDone = !!(nc.disposition && nc.disposition.trim());
  // Disposition is a close-ready gate only when the NC concerns product.
  const dispositionSatisfied = dispositionDone || !productInvolved(nc);

  const sev = (nc.severity ?? "").toLowerCase();
  const isHigh = sev === "major" || sev === "critical";

  // CAPA gate (Major/Critical only): a linked CAPA exists, or a skip-CAPA
  // rationale is on file. This matches the actual NC close rule in /approve.
  // It is deliberately NOT "CAPA closed": CAPAs routinely stay open long after
  // the NC is otherwise done, and CAPA closure lives on `stage`/`closedAt`, not
  // the legacy `status` column. (Corrected 2026-07-13.)
  const skip = !!(nc.skipCapaRationale && nc.skipCapaRationale.trim());
  const capaGate = !isHigh || skip || agg.capaTotal > 0;

  const anyWork =
    agg.correctionTotal > 0 ||
    agg.capaTotal > 0 ||
    rcaDone ||
    dispositionDone ||
    !!nc.mgmtAcknowledgedAt;
  if (!anyWork) return "Open";

  // #13 (2026-08-03) — when a CAPA is linked, the root-cause investigation
  // lives in the CAPA, so the NC itself is not blocked on a recorded root
  // cause. Escalating to a CAPA satisfies the RCA gate at close.
  const rcaSatisfied = rcaDone || agg.capaTotal > 0;
  const baseDone = correctionsComplete && rcaSatisfied && dispositionSatisfied && capaGate;
  if (!baseDone) return "In Progress";

  if (isHigh && !nc.mgmtAcknowledgedAt) return "Awaiting Mgt Acknowledgement";
  return "Under Review";
}

// The specific unmet gates, for the read-only status stepper's "what's missing"
// line. Returns [] once the NC is close-ready (or terminal).
export function ncStatusBlockers(nc: NcStatusInput, agg: NcStatusAgg = EMPTY_NC_AGG): string[] {
  if (nc.cancelledAt || nc.closedAt || nc.status === "Closed") return [];
  const blockers: string[] = [];
  if (agg.correctionPending > 0) {
    blockers.push(`${agg.correctionPending} correction${agg.correctionPending === 1 ? "" : "s"} still open`);
  }
  const rcaDone =
    !!(nc.rootCause && nc.rootCause.trim()) ||
    (Array.isArray(nc.rootCauses) && nc.rootCauses.length > 0);
  if (!rcaDone && agg.capaTotal === 0) blockers.push("Root cause not recorded (or escalate to a CAPA to investigate)");
  if (productInvolved(nc) && !(nc.disposition && nc.disposition.trim())) blockers.push("Disposition not set");
  const sev = (nc.severity ?? "").toLowerCase();
  if (sev === "major" || sev === "critical") {
    const skip = !!(nc.skipCapaRationale && nc.skipCapaRationale.trim());
    if (!skip && agg.capaTotal === 0) {
      blockers.push("No CAPA linked (or record a skip-CAPA rationale)");
    }
    if (!nc.mgmtAcknowledgedAt) blockers.push("Management acknowledgement pending");
  }
  return blockers;
}

// Roll up correction-completion and linked-CAPA-closure counts for a set of NC
// ids in two grouped queries, so the list endpoint derives status without an
// N+1. Returns a map keyed by nc id; ids with no corrections/CAPAs are absent
// (callers fall back to EMPTY_NC_AGG).
export async function loadNcStatusAggregates(ncIds: number[]): Promise<Map<number, NcStatusAgg>> {
  const map = new Map<number, NcStatusAgg>();
  if (ncIds.length === 0) return map;

  const ensure = (id: number): NcStatusAgg => {
    let a = map.get(id);
    if (!a) { a = { ...EMPTY_NC_AGG }; map.set(id, a); }
    return a;
  };

  const corrRows = await db
    .select({
      ncId: ncCorrectionsTable.ncId,
      total: sql<number>`count(*)`,
      pending: sql<number>`count(*) filter (where ${ncCorrectionsTable.completed} = false)`,
    })
    .from(ncCorrectionsTable)
    .where(inArray(ncCorrectionsTable.ncId, ncIds))
    .groupBy(ncCorrectionsTable.ncId);
  for (const r of corrRows) {
    const a = ensure(Number(r.ncId));
    a.correctionTotal = Number(r.total);
    a.correctionPending = Number(r.pending);
  }

  const capaRows = await db
    .select({
      ncId: capasTable.sourceNcId,
      total: sql<number>`count(*)`,
    })
    .from(capasTable)
    .where(inArray(capasTable.sourceNcId, ncIds))
    .groupBy(capasTable.sourceNcId);
  for (const r of capaRows) {
    if (r.ncId == null) continue;
    const a = ensure(Number(r.ncId));
    a.capaTotal = Number(r.total);
  }

  return map;
}
