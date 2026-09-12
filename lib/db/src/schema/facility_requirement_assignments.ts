// ⛔ RETIRED 2026-08-31. This table is no longer part of the schema and this file
// exports nothing. It is no longer re-exported from schema/index.ts.
//
// It stored one answer per SITE for where a labelling requirement is met.
// Coverage belongs to the ARTEFACT that carries the requirement, so it lives on
// `packaging_designs` (approved_states / requirement_targets / requirement_notes)
// and, next, on the label template. See lib/db/src/schema/packaging_designs.ts,
// COVERAGE_TARGETS, which replaced REQUIREMENT_TARGETS.
//
// The TABLE is deliberately left in existing databases — it holds the answers
// recorded on 2026-08-30 and dropping it is irreversible — but ensureSchema no
// longer creates it, so a new database never grows one.
//
// The file itself is safe to delete; it is only still here because the bridge
// this was written through cannot unlink files on that mount.
export {};
