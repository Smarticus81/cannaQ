# CannaQ × METRC — Integration Concept Brief

**Date:** 2026-06-23
**Status:** Concept — for understanding and decision, **not** a build plan. No code changes proposed yet.
**Origin:** OQ-2026-001 open questions OVQ-2 (inventory decrement / source of truth) and OVQ-3 (METRC interoperability), plus customer feedback that cannabis should be tracked *in* CannaQ rather than across two systems.

---

## Start here — the one prerequisite that gates everything

Nothing below can connect to a real facility until CannaQ is a **Metrc Validated Integrator** (signed Metrc API user agreement + training + licensed posture). A facility is only permitted to share its confidential METRC API key with state-approved vendors. So the first real-world step is the Validated Integrator application (free Standard tier to begin), *before* any import code is worth writing. Everything else in this brief assumes that step is underway.

---

## 1. The problem we're solving

Today CannaQ keeps cannabis quantities in two places that don't talk to each other — the `inventory_items` table and the `lots` table — so the Inventory screen and the Lot Traceability screen drift apart the moment a lot is split, shipped, or consumed. Meanwhile, the real legal record for cannabis lives in METRC, and operators don't want to enter the same data twice. The goal is one place to look (CannaQ), cannabis included, fed by METRC instead of double-entered.

## 2. Core principle — one quantity ledger with a cannabis overlay

There is exactly **one** table that stores "how much of something we have," for every material in the building. Every quantity-changing event (receive, split, consume in production, ship, adjust, destroy) writes one signed line to a single event ledger. That ledger is the only home for a quantity, so nothing can drift.

"Cannabis" is an **overlay** on that ledger — a flag plus extra attributes (METRC package tag, tag lineage/splits, lab results, regulated status) and a filtered view. The overlay never stores its own quantity; it reads from the ledger underneath. Concretely:

- **Inventory** = the ledger grouped by item, with reorder points.
- **Lot Traceability** = the ledger filtered to cannabis lots, showing METRC tags and splits.
- **Dashboard** = the rollup totals (e.g. "60 lb of butter across 3 lots").

All three are *views* of the same numbers, so they reconcile by construction.

## 3. The two-layer model (where METRC fits)

**Layer 1 — CannaQ-owned, active, read-write (up to final form).**
Incoming materials, bulk production, and each batch's output recorded as the **range of METRC tags** assigned to that output. This is the part operators actively run in CannaQ.

**Layer 2 — METRC mirror, passive, read-only (after final form).**
Once product is in final form and ordered, picking and manifesting happen **in METRC, not CannaQ**. A scheduled end-of-day job pulls finished-goods packages and outbound transfers back from METRC so a manager can see finished-goods inventory in CannaQ — without doing the work twice.

The boundary is **final form**: CannaQ writes up to the handoff, then mirrors what happens after it. Caveats: the mirror is only as fresh as the last pull, and only as accurate as what's in METRC.

## 4. Direction of truth / data governance

- **Cannabis data imported from METRC is read-only**, editable only by an **Admin** — and an Admin edit is a deliberate, audited correction (reason + e-signature to the audit log), i.e. a "break-glass," not free editing. (21 CFR Part 11 pattern already in CannaQ.)
- **METRC is authoritative for cannabis**; CannaQ mirrors it.
- **CannaQ is authoritative for everything non-cannabis** (butter, sugar, packaging, labels) — METRC doesn't track those.

## 5. What we pull from METRC

The METRC API exposes the data this design needs:

- **Active inventory / finished goods** — `packages/active` (and `packages/inactive`).
- **Outbound shipments / manifests** — `transfers/outgoing` and the related delivery/manifest endpoints.
- **Lab results / COAs** — lab-test result endpoints, attachable to the cannabis lot/batch.
- **Incoming/bulk cannabis quantities** — package data by tag, used to populate and reconcile the cannabis lots.

Endpoint versions vary by state; Michigan's specifics live at the Michigan API documentation. The join key throughout is the **METRC package tag**, which CannaQ already stores (`metrcPackageId`).

## 6. Sync cadence

A **daily end-of-day pull** (simple polling) is the proposed default — enough for a finished-goods overview, low cost, no real-time infrastructure. Metrc Connect also offers **webhooks** if closer-to-live updates are ever wanted; not needed for v1.

## 7. Traceability is preserved across the boundary

Because the batch's **output tag range** is recorded before handoff, a complaint that comes in on a final-form product by its METRC tag still traces back to the source batch — via the tag lookup already built (Session 74), on top of the tag lineage (Session 73). So drawing the boundary at final form does not weaken recall.

## 8. What's already built (not starting from scratch)

- `lots` table with `currentQuantity` vs `originalQuantity`, a signed append-only event ledger, `metrcPackageId`, origin, and status lifecycle.
- METRC tag lineage / split history (Session 73).
- Complaint-tag → source-batch lookup (Session 74).
- Batch outputs (a batch can yield multiple output lots).

The conceptual shift is: let that one ledger cover *all* materials (add the cannabis flag), make Inventory a grouped *view* over it instead of its own stored number, and treat METRC as the import feed for the cannabis-flagged rows.

## 9. Access & compliance gating (Validated Integrator)

- **Program:** Metrc Validated Integrators — validation means licensed in the home state, completed Metrc training, signed Metrc's API user agreement, and demonstrated capability.
- **Key handling:** a licensee may share its confidential **user API key** only with state agency-approved vendors. So validation is what makes a facility able to connect CannaQ legally.
- **Levels:** Full Validation, Partial Validation, and "Get Access" — so it's possible to start smaller.
- **Fit:** Michigan is fully supported, with explicit "ERP – Manufacturing" / "ERP – Cultivation" categories and existing validated manufacturing integrators in Michigan — the path is proven.
- **Cost:** Metrc Connect has a **free Standard tier** (portal, lookback, API docs, email support); a paid **Custom** tier adds sandbox access, new endpoints, and dedicated support.

## 10. Onboarding model

**Default: follow METRC.** Because cannabis is read-only-from-METRC, CannaQ doesn't own the opening number — METRC does. So backfill the opening cannabis state *from METRC* at onboarding, and treat any weight discrepancies as the **licensee's** responsibility to reconcile in METRC (consistent with METRC's own stance that data accuracy is the licensee's responsibility).

**Optional QA: opening physical count.** Offer a site-level count at onboarding that produces a **variance report** (count vs. METRC) — but CannaQ surfaces the variance and does **not** act as the arbiter; the licensee fixes METRC. This keeps CannaQ a mirror, not a source of truth, which is the right liability posture.

## 11. Migration (internal)

"Migration" = moving today's data into the single-ledger shape without breaking anything that references it:

1. One-time script to read existing `inventory_items` + `lots` rows into the unified ledger.
2. **Preserve every identifier** — lot numbers, batch numbers, METRC tags — because signatures and audit entries reference them, and historical numbers are never renumbered (Part 11; established Session 71).
3. Verify totals reconcile before/after.

Current dev data is small (mostly OQ sample data + a few test batches) and the `lots` table is already close to target, so this migration is low-risk. The future-customer version of "migration" is the initial backfill **from METRC** via the API.

## 12. Risks & caveats

- **Freshness** — the mirror is as current as the last daily pull.
- **METRC accuracy dependence** — CannaQ reflects what's in METRC, errors included.
- **API key security** — the facility's confidential key must be stored and transmitted securely.
- **Validation timeline** — becoming a validated integrator is a process, not an instant switch.
- **Cost at scale** — the free tier may suffice initially; premium features (webhooks, expanded lookback, sandbox) are paid.

## 13. Open decisions before any build

- Commit to pursuing **Validated Integrator** status (the gating step).
- Confirm, from Michigan's API docs, that the endpoints expose package **quantities**, **lab results**, and **transfers** as assumed here.
- Confirm **source-of-truth direction** (read-only mirror for cannabis) and **sync cadence** (daily).
- Decide the **reconciliation / variance** UX (where Admin sees and resolves discrepancies).
- Approve the **unified-ledger migration** approach.

These close out OQ open questions **OVQ-2** and **OVQ-3**.

## 14. Recommended sequence

1. **Apply for the Validated Integrator program / free Standard tier** and read the Michigan API docs to confirm the endpoints (prerequisite — do this first).
2. Lock the governance decisions in §13 (source of truth, cadence, reconciliation).
3. Design the **unified ledger + cannabis overlay** (data model), with migration mapping.
4. Build the **read-only import** in stages — lab results + incoming bulk quantities first; the finished-goods/outbound mirror second.
5. Run the **internal migration**, preserving all identifiers, then verify totals.

---

### Sources
- Metrc Connect — open API, free Standard tier: https://www.metrc.com/track-and-trace-technology/metrc-connect/
- Metrc Validated Integrators — program, validation levels, Michigan list: https://www.metrc.com/validated-integrators/
- Metrc Web API Documentation — packages / transfers / sales / lab tests: https://api-co.metrc.com/Documentation/PrintableList
- Michigan Metrc API documentation: https://api-mi.metrc.com/Documentation
