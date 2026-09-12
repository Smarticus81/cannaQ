// Session 75 — shared helpers for connecting quality events (Complaint ↔ NC,
// NC → Field Action + CAPA, and "every Field Action has a CAPA"). Centralized so
// the NEW cross-event flows all use the correct MAX-parsed record-number
// generator (NOT count(*), which historically produced concat/collision bugs —
// see Session 55.1) and a single CAPA-from-source builder.
import { db } from "@workspace/db";
import { capasTable, fieldActionsTable, nonConformancesTable } from "@workspace/db";
import { like } from "drizzle-orm";

function nextFromExisting(values: Array<string | null | undefined>, prefix: string): string {
  let max = 0;
  for (const v of values) {
    const m = v?.match(/-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

const yy = () => new Date().getFullYear().toString().slice(-2);

export async function nextCapaNumber(): Promise<string> {
  const prefix = `CAPA-${yy()}-`;
  const rows = await db.select({ n: capasTable.capaNumber }).from(capasTable).where(like(capasTable.capaNumber, `${prefix}%`));
  return nextFromExisting(rows.map((r) => r.n), prefix);
}

export async function nextFaNumber(): Promise<string> {
  const prefix = `FA-${yy()}-`;
  const rows = await db.select({ n: fieldActionsTable.faNumber }).from(fieldActionsTable).where(like(fieldActionsTable.faNumber, `${prefix}%`));
  return nextFromExisting(rows.map((r) => r.n), prefix);
}

export async function nextNcNumber(): Promise<string> {
  const prefix = `NC-${yy()}-`;
  const rows = await db.select({ n: nonConformancesTable.ncNumber }).from(nonConformancesTable).where(like(nonConformancesTable.ncNumber, `${prefix}%`));
  return nextFromExisting(rows.map((r) => r.n), prefix);
}

// Map a source record's severity onto a CAPA risk level + a documented rationale.
// CAPA risk levels are Critical | High | Medium | Low (required at open). NC
// severities are Critical | Major | Minor; complaint severities are
// Critical | High | Medium | Low. A Field Action with no severity context is
// treated as High by default (a market action inherently implies risk).
export function deriveCapaRisk(severity: string | null | undefined, originLabel: string): { riskLevel: string; riskRationale: string } {
  const s = (severity ?? "").trim();
  const level =
    s === "Critical" ? "Critical" :
    s === "Major" || s === "High" ? "High" :
    s === "Minor" || s === "Medium" ? "Medium" :
    s === "Low" ? "Low" :
    "High";
  return {
    riskLevel: level,
    riskRationale: `Risk auto-classified as ${level} on creation from ${originLabel} (source severity: ${s || "n/a"}). Re-assess during Investigation.`,
  };
}
