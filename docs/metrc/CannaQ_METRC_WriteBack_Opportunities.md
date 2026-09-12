# CannaQ × METRC — Write-Back / "One System" Opportunities

**Date:** 2026-06-25
**Status:** Concept / future roadmap — **not** a build plan. Parked per Jonathan ("beneficial future moves," not now).
**Builds on:** `CannaQ_METRC_Integration_Brief.md` (2026-06-23), which covers the **read** direction. This addendum covers the **write** direction.
**Source note:** The uploaded "Metrc_Manual_2021" file was only a redirect stub to a Metrc Salesforce download link, which returned no content, so this is grounded in METRC's known data model + the existing repo brief — **not** the specific 2021 manual. Re-share the actual PDF (or paste sections) to align this to exact Michigan manual procedures.

---

## The idea, stated plainly

The existing brief draws the boundary at **final form**: CannaQ is read-write up to handoff, then *mirrors* what METRC does after. That model still has the operator doing the actual METRC data entry (creating packages, recording weights, building manifests) inside METRC.

The seminar's "enter it in CannaQ and it shows up in METRC" is the next step: CannaQ **originates** those METRC records via the API, so the operator works in **one** surface (CannaQ) and METRC is fed underneath. The QMS layer CannaQ already has — inspections, NCs/CAPAs, GMP checklists, Part 11 e-signatures — is exactly what METRC lacks, so CannaQ becomes the single operator workspace and METRC becomes the compliance ledger it writes to.

This *doesn't* replace the read mirror — you still pull back from METRC to confirm and to cover anything done directly in METRC. Write + read-back = closed loop.

## The one hard prerequisite (unchanged)

Write access is gated by **Validated Integrator** status even more than reads are. The free Standard tier is largely read/lookback; **write endpoints and the sandbox needed to test them safely are likely the paid Custom tier.** No write code is worth writing before the integrator agreement + sandbox are in hand. (See brief §9, §13.)

## Where the double-entry actually hurts — mapped to CannaQ

Ordered by how much re-keying it removes for a Michigan manufacturer:

1. **Packages — create / finish / adjust / repackage.** This is the heart of it. Every batch in CannaQ already yields output lots with a recorded METRC tag range (Sessions 71/73). Opportunity: on batch completion, CannaQ calls METRC to **create the output package(s)**, post production **weight adjustments / waste**, and **finish** consumed source packages. Today this is the biggest manual re-entry in METRC.
2. **Items.** METRC requires every package to reference a defined Item within a category. CannaQ already has recipes/products. Opportunity: map CannaQ products → METRC items and create them via API so they line up automatically.
3. **Waste / destruction.** CannaQ has destruction records (Session 49). METRC requires waste reporting with reason/method. Opportunity: push CannaQ destruction events to METRC instead of dual-logging.
4. **Tags.** CannaQ already stores tags. Opportunity: read the facility's available tag inventory from METRC and assign on package creation, so tag numbers are picked in CannaQ, not looked up in METRC.
5. **Lab results / COAs.** CannaQ already ingests COAs (test results). For a manufacturer this is mostly **read** (the lab posts results to METRC); the value is *attaching* the pulled result to the CannaQ lot/batch and gating release on it. Only a licensed lab would post results.
6. **Transfers / manifests (optional boundary push).** The brief intentionally leaves shipping in METRC. A later option: let CannaQ assemble the outgoing manifest (packages + destination + driver/vehicle) and submit it, making even shipping one-system. Higher risk, do last.
7. **Cultivation (plants/harvests).** Only relevant if CannaQ later serves cultivators; out of scope for the manufacturing focus today.

## Non-negotiables for any write path

- **METRC stays the legal source of truth.** A write that fails must be surfaced loudly — a sync/error queue + reconciliation view — so CannaQ and METRC never silently diverge. (Mirror-not-arbiter posture, brief §4/§10.)
- **Every push is a regulated action** → Part 11 attribution + audit on the originating CannaQ event. CannaQ already has this pattern.
- **Michigan endpoint confirmation.** Verify which POST endpoints MI actually exposes (packages, adjustments, waste, transfers) and their exact payloads at `api-mi.metrc.com/Documentation`. Endpoint availability varies by state.
- **Idempotency / retries.** Network failures mid-write can't create duplicate packages; each push needs a dedupe key.

## Suggested future sequence

1. Reads first, per the existing brief (mirror finished goods, lab results, incoming quantities).
2. Then writes, in pain order: **package create/finish + adjustments**, then **waste**, then (optional) **manifests**.
3. Each write behind the sandbox first, with the error-queue/reconciliation UX built alongside — never fire-and-forget.

## To sharpen this

Re-share the real 2021 Michigan manual (PDF or pasted sections). With it I can map specific manual procedures/screens to exact CannaQ features, confirm which steps METRC requires vs. which are state-optional, and tighten the package/adjustment/waste payload mapping.
