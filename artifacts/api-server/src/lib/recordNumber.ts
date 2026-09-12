import { AsyncLocalStorage } from "node:async_hooks";
import { pool } from "@workspace/db";

// RECORD NUMBERS ACROSS SITES — multi-facility Phase 4 (2026-08-28).
//
// ⛔ THE PROBLEM THIS SOLVES, found before it bit anyone. Every record number in this
// app is worked out by looking at what already exists and adding one. Once each plant
// only sees its own records, two plants both look, both see nothing, and both try to
// create 0001 — and the second one dies on a unique constraint. Not a silent
// duplicate, a failed save in front of an operator.
//
// ⛔ HIS RULING (2026-08-28), and the shape of the fix:
//   * A record that belongs to ONE plant carries that plant's code — NC-BA-26-0001 —
//     "so you can tell them apart".
//   * A record everyone sees keeps one plain company-wide number with a site column
//     beside it — "No code buried in a number you'd have to decode."
//
// And the code does more than label: putting it in the prefix is what makes the
// counting safe. Bay City counts LOT-BA-26-… and Detroit counts LOT-DE-26-…, so
// neither can land on the other's number even though neither can see the other's
// records. Each site gets its own run from 0001.
//
// ⚠️ Records made before this keep the numbers they have. Nothing is renumbered — a
// number that has been signed, printed and stuck on a pallet is not ours to change.

/**
 * The facility the current request is acting for. Set by the facility-context
 * middleware, empty everywhere else. Lives here rather than in the METRC client so
 * both can read it without importing each other.
 */
export const facilityIdStore = new AsyncLocalStorage<number>();

const codeById = new Map<number, string>();
let primaryFacilityId: number | null = null;

/** Record a facility's short code. Called at boot and whenever a facility is saved. */
export function setFacilityCode(facilityId: number, code: string | null | undefined): void {
  const c = (code ?? "").trim().toUpperCase();
  if (c) codeById.set(facilityId, c);
  else codeById.delete(facilityId);
}

export function setPrimaryFacilityId(id: number | null): void {
  primaryFacilityId = id;
}

export function getPrimaryFacilityId(): number | null {
  return primaryFacilityId;
}

/** The site code for this request, or null when there is nothing to distinguish. */
export function currentFacilityCode(): string | null {
  const id = facilityIdStore.getStore() ?? primaryFacilityId;
  if (id == null) return null;
  return codeById.get(id) ?? null;
}

/** How many facilities the app knows about — one site needs no codes in its numbers. */
export function facilityCount(): number {
  return codeById.size;
}

/**
 * The prefix for a record that BELONGS TO ONE PLANT: "LOT-BA-26-".
 *
 * Falls back to the plain "LOT-26-" when the site has no code — which is every
 * single-site operator, whose numbers therefore never change shape.
 */
export function facilityPrefix(base: string, year?: string): string {
  const yy = year ?? new Date().getFullYear().toString().slice(-2);
  const code = currentFacilityCode();
  return code ? `${base}-${code}-${yy}-` : `${base}-${yy}-`;
}

/** The prefix for a record EVERY SITE SEES: "NC-26-". No code, by his ruling. */
export function companyPrefix(base: string, year?: string): string {
  const yy = year ?? new Date().getFullYear().toString().slice(-2);
  return `${base}-${yy}-`;
}

/**
 * The next number for a prefix, given the numbers already using it.
 *
 * Reads the trailing digits rather than counting rows, so a deleted or cancelled
 * record cannot compress the sequence and hand a number out twice.
 */
export function nextForPrefix(prefix: string, existing: (string | null | undefined)[]): string {
  let maxSeq = 0;
  for (const n of existing) {
    if (!n || !n.startsWith(prefix)) continue;
    const m = n.match(/-(\d+)$/);
    if (m) {
      const v = parseInt(m[1], 10);
      if (Number.isFinite(v) && v > maxSeq) maxSeq = v;
    }
  }
  return `${prefix}${String(maxSeq + 1).padStart(4, "0")}`;
}

/**
 * The numbers already using a prefix, looked up ACROSS EVERY SITE.
 *
 * ⛔ A company-wide number has to be unique company-wide, so it has to be checked
 * company-wide — and the ordinary query cannot do that, because it only sees this
 * site's records. Bay City asked for the next company-wide work-instruction number,
 * could not see Detroit's WI-26-0001, and produced WI-26-0001 again. The save failed.
 *
 * So this one query runs on a plain pooled connection, which carries no facility and
 * is therefore unrestricted. That is the single deliberate exception to the scoping,
 * and it is narrow on purpose: it reads NOTHING but the number column, never returns
 * a record to anybody, and exists only so two sites cannot claim the same number.
 */
export async function numbersInUseEverywhere(table: string, column: string, prefix: string): Promise<string[]> {
  // Table and column names are literals from the call sites, never user input.
  const { rows } = await pool.query<{ n: string | null }>(
    `SELECT ${column} AS n FROM ${table} WHERE ${column} LIKE $1`,
    [`${prefix}%`],
  );
  return rows.map((r) => r.n ?? "");
}
