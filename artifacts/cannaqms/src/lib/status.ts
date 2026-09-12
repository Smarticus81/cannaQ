// Session 97 (#6) — the single source of truth for the status traffic-light
// system. Every module's status/severity value resolves to one of four TONES,
// and tones render as a left-edge ACCENT LINE on cards/rows/headers (not filled
// blocks) plus a neutral-surface StatusBadge. Sage stays brand-only; these
// green/amber/red tokens ONLY ever mean status.

export type StatusTone = "good" | "caution" | "urgent" | "neutral";

const norm = (v: string | null | undefined): string => String(v ?? "").trim().toLowerCase();

// ── Rendering helpers ───────────────────────────────────────────────────────

/** Left-edge accent line for a tone. Neutral = no line (plain surface). */
export function accentClass(tone: StatusTone): string {
  switch (tone) {
    case "good":    return "border-l-[3px] border-l-status-good";
    case "caution": return "border-l-[3px] border-l-status-caution";
    case "urgent":  return "border-l-[3px] border-l-status-urgent";
    default:        return "";
  }
}

/** Text color per tone (for the StatusBadge label). */
export const toneText: Record<StatusTone, string> = {
  good:    "text-status-good",
  caution: "text-status-caution",
  urgent:  "text-status-urgent",
  neutral: "text-muted-foreground",
};

/** Dot color per tone (for the StatusBadge dot). */
export const toneDot: Record<StatusTone, string> = {
  good:    "bg-status-good",
  caution: "bg-status-caution",
  urgent:  "bg-status-urgent",
  neutral: "bg-muted-foreground/50",
};

// ── Per-module tone resolvers ───────────────────────────────────────────────

export function toneNcSeverity(v: string | null | undefined): StatusTone {
  switch (norm(v)) {
    case "critical": return "urgent";
    case "major":    return "caution";
    case "minor":    return "good";
    default:         return "neutral";
  }
}

export function toneNcStatus(v: string | null | undefined): StatusTone {
  const s = norm(v);
  if (s === "closed") return "good";
  if (s === "open" || s.includes("awaiting")) return "urgent";
  return "neutral"; // In Progress, Under Review, …
}

export function toneComplaintSeverity(v: string | null | undefined): StatusTone {
  switch (norm(v)) {
    case "critical": return "urgent";
    case "high":     return "caution";
    case "low":      return "good";
    default:         return "neutral"; // Medium
  }
}

export function toneComplaintStatus(v: string | null | undefined): StatusTone {
  const s = norm(v);
  if (s === "closed") return "good";
  if (s === "open") return "urgent";
  if (s.includes("escalated")) return "caution";
  return "neutral"; // Under Investigation
}

export function toneCapaStatus(v: string | null | undefined, hasOverdueActions = false): StatusTone {
  const s = norm(v);
  if (s === "closed") return "good";
  if (s === "cancelled" || hasOverdueActions) return "urgent";
  if (s === "open" || s.includes("implementation")) return "caution";
  return "neutral";
}

export function toneFieldActionType(v: string | null | undefined): StatusTone {
  const s = norm(v);
  if (s.includes("recall")) return "urgent";
  if (s.includes("stop") || s.includes("withdrawal") || s.includes("safety")) return "caution";
  return "neutral";
}

export function toneFieldActionStatus(v: string | null | undefined): StatusTone {
  const s = norm(v);
  if (s === "closed") return "good";
  if (s.includes("rejected")) return "urgent";
  if (s.includes("response active")) return "caution";
  return "neutral";
}

/**
 * BATCH STATE LABELS — ⛔ ONE list. The Batches list and the batch detail page
 * each kept their own map and they had already drifted: the same
 * `released_to_inventory` batch read "Released" on the list and "Final Form" on
 * its own page.
 *
 * 2026-09-07 (Jonathan) — "Final Form" is renamed **Bulk — Released**. It never
 * meant finished goods: it is bulk that has passed testing and been released,
 * with nothing packaged yet, and the old name told every reader the opposite.
 * He had to invent a mnemonic to keep it straight, which is the tell. Its
 * pre-testing sibling is **Bulk — Untested**, so the two now sort and read as
 * the pair they are.
 *
 * 2026-09-07, same conversation — **"Depleted" is gone too.** It described the
 * bulk being spent, but it read as *the product is gone* when in fact the units
 * exist, labeled, sitting in fulfillment, waiting to be sold. Jonathan, on
 * seeing it after a clean run: "Nothing is depleted."
 *
 * 2026-09-08 (Jonathan) — the label he chose is **"Production Batch Closed —
 * In Fulfillment"**: the production record is finished AND the units are in the
 * warehouse ready for orders to be picked against. His definition of the state:
 * "the final product, in the warehouse, ready for orders to be sent in so the
 * product can be picked for shipment." "Finished Goods" was rejected because the
 * left-nav Finished Goods page is a different thing (METRC packages on hand).
 * The chip/short label is just "In Fulfillment" — the sentence will not fit.
 *
 * ⛔ These are DISPLAY labels only. The stored status values never change.
 */
export const BATCH_STATE_LABELS: Record<string, string> = {
  in_production:             "In Production",
  in_inventory_untested:     "Bulk — Untested",
  testing_in_progress:       "Testing In Progress",
  passed_awaiting_packaging: "Passed — Awaiting Packaging",
  released_to_inventory:     "Bulk — Released",
  finished_goods:            "Production Batch Closed — In Fulfillment",
  on_hold:                   "On Hold",
  failed:                    "Failed",
  destroyed:                 "Destroyed",
};

/** Compact variants for chips, tables and the lifecycle rail. */
export const BATCH_STATE_LABELS_SHORT: Record<string, string> = {
  in_production:             "In Production",
  in_inventory_untested:     "Untested",
  testing_in_progress:       "Testing",
  passed_awaiting_packaging: "Passed",
  released_to_inventory:     "Bulk — Released",
  finished_goods:            "In Fulfillment",
  on_hold:                   "On Hold",
  failed:                    "Failed",
  destroyed:                 "Destroyed",
};

export function batchStateLabel(status: string | null | undefined, short = false): string {
  const key = (status ?? "").trim();
  const map = short ? BATCH_STATE_LABELS_SHORT : BATCH_STATE_LABELS;
  return map[key] ?? BATCH_STATE_LABELS[key] ?? key;
}

export function toneBatchStatus(v: string | null | undefined): StatusTone {
  const s = norm(v);
  if (s === "failed" || s === "destroyed") return "urgent";
  if (s === "on_hold" || s === "in_inventory_untested") return "caution";
  if (s === "passed_awaiting_packaging" || s === "released_to_inventory" || s === "finished_goods") return "good";
  return "neutral"; // in_production, testing_in_progress
}

export function toneReviewStatus(v: string | null | undefined): StatusTone {
  switch (norm(v)) {
    case "overdue":  return "urgent";
    case "due-soon": return "caution";
    case "current":  return "good";
    default:         return "neutral"; // never-qualified
  }
}

export function toneRiskTier(v: string | null | undefined): StatusTone {
  switch (norm(v)) {
    case "critical": return "urgent";
    case "high":     return "caution";
    case "low":      return "good";
    default:         return "neutral"; // Medium
  }
}

export function toneInspectionResult(v: string | null | undefined): StatusTone {
  switch (norm(v)) {
    case "fail":        return "urgent";
    case "conditional": return "caution";
    case "pass":        return "good";
    default:            return "neutral"; // Pending
  }
}

/** Map the dashboard KpiTile's legacy `accent` prop onto a tone. */
export function toneFromAccent(accent: string | null | undefined): StatusTone {
  switch (norm(accent)) {
    case "red":            return "urgent";
    case "orange":
    case "amber":          return "caution";
    case "green":          return "good";
    default:               return "neutral"; // blue, slate
  }
}

// ── Document revision display (major.minor) ─────────────────────────────────
// Released versions (Approved / historical) show `${major}.0` (Rev 1.0, 2.0).
// While a change is in its cycle (Draft / Under Review) it shows the CURRENT major
// with an incrementing minor per review round (revising 1.0 reads 1.1, 1.2, …),
// becoming 2.0 only once approved. The stored `revision` holds the number the draft
// will become when approved (bumped when the revision starts), so during a cycle the
// displayed major is stored − 1. Minor is at least .1 for a fresh draft.
// Single source of truth — used by the document list and detail alike.
export function formatRevision(
  revision: string | null | undefined,
  status: string,
  reviewRound: number,
): string {
  const stored = Math.floor(parseFloat(String(revision ?? "1")) || 1);
  const inCycle = status === "Draft" || status === "Under Review";
  if (inCycle) {
    const major = Math.max(stored - 1, 0);
    const minor = Math.max(reviewRound, 1);
    return `${major}.${minor}`;
  }
  return `${stored}.0`;
}

/**
 * A Part 11 signature timestamp with its time zone, e.g. "Aug 27, 2026 8:49 AM EDT".
 *
 * 2026-08-27, Jonathan: "as long as we include the timestamp and timezone so
 * 01:45:00 EST on 2/12/26 can be easily proven to be 22:45:00 PST on 2/11/26".
 * These are timestamptz columns — real instants — so they are correct wherever
 * they are read, but rendered bare a reader has to guess which zone they are
 * looking at, and near midnight that guess changes the DATE. The zone is what makes
 * the record self-proving.
 *
 * It shows the READER's zone, which is right for an instant: the same signature
 * reads 01:45 EST in Michigan and 22:45 PST the previous evening in California, and
 * both are true. Date-only fields are the opposite — they come from the facility —
 * see lib/facilityDate.ts on the server.
 */
export function formatSignedAt(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}
