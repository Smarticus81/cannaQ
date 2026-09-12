# CannaQMS — Requirements Register

**What this is.** Every requirement the software has to satisfy, where it comes from, how we
meet it, and whether that has actually been proven. One row per requirement.

**Why it exists.** Started 2026-09-11 at Jonathan's instruction: *"Can we keep a list of
requirements we have and how we are meeting them? If this requirement (or any other) doesn't
work because we do not have production ready data and no real-life testing labs, put that shit
on the list as unverifiable until production ready information is available."*

## Status vocabulary — use these words, no others

| Status | Means |
|---|---|
| **Met — verified** | Built, and exercised end to end against the live system. Evidence named. |
| **Met — unverified** | Built, but never run against the real thing. Not the same as met. |
| **Unverifiable (sandbox)** | Cannot be proven here. Needs production-ready data, a real laboratory, or METRC UI access. Says exactly what is missing. |
| **Partial** | Some of the requirement is met; the gap is named. |
| **Not built** | Known requirement, nothing implemented. |

⛔ A requirement is never marked verified on the strength of a code read. Verified means it was
run and the result was seen.

---

## A. Laboratory testing and sampling — MI R 420.304 / R 420.305

| # | Requirement | Source | How we meet it | Status |
|---|---|---|---|---|
| A1 | A representative sample is taken from the batch and recorded | R 420.304(2) | "Record Test Sample" on the batch — source package, amount, the lab's tag | **Met — unverified.** The METRC sample create has never completed successfully; blocked first by a browser timeout, then by the missing lab test batch on the item (fixed 09-11, not yet re-run). |
| A2 | Sample size for a 100-unit infused batch is 2 units | R 420.304 + CRA bulletin, read from Jonathan's own Michigan folder | Recorded on the sample form | **Met — unverified.** No completed sample yet. |
| A3 | The business — not the laboratory — enters the sample in METRC, with the date AND TIME collected and transferred | R 420.304(2)(j) | `sample_collected_at`, `sample_transferred_at` on `batch_testing`; the operator records both | **Met — unverified.** |
| A4 | Sampled product is quarantined and cannot move | R 420.304(2)(k) | `labSampleQuarantineBlock()` on release, packaging, Label & Finalize and manifest push | **Met — unverified** in a real sampling run. |
| A5 | Chain of custody is attested by the person who witnessed collection | R 420.304(2)(h) | Four attestations + a Part 11 signature on the sample form; the signature IS the verification (his ruling 08-31) | **Met — unverified.** |
| A6b | ⛔ The required safety tests are the SAME for every product; the rule does not vary them by product type | R 420.305(3)(a)–(i) | Nothing in the software adds, removes or conditions a required test. `metrcLabTestBatches.ts` names the Metrc *panel* only. | **Met — verified 09-11 by reading the rule.** R 420.305(3) lists one set of tests for all product in a harvest or production batch; residual solvents are required of production batches of infused and edible product under (f). The only product-type variation the rule contemplates is delegated: *"The agency may publish a guide indicating which of the following safety tests are required based on product type when the marihuana product has changed form."* ⛔ **The rule draws no solvent/solventless distinction** — that split exists only as two Metrc panel names. |
| A6 | The product is tested under the safety panels Michigan requires for its product type | R 420.305 | Per-state `additional_config.safetyPanels`, resolved by the facility's state and the product type. MI = 5 panels | **Met — verified 08-30** (live). ⚠️ The METRC-side equivalent — which lab test batch the item names — is NOT yet wired to this config; see A7. |
| A7 | The test sample package names the lab test batch it will be tested under | METRC requirement, surfaced 09-11: *"At least one Lab Test Batch is required for Item …"* | **The field is `RequiredLabTestBatches`, and it belongs on the PACKAGE.** Documented in Metrc's v2 API reference (`sandbox-api-mi.metrc.com/Documentation`) on **both** create endpoints — `POST /packages/v2/` (example `null`) and `POST /packages/v2/testing` (example `["Usable Marijuana for Retail"]`) — and settable afterwards on an existing tag via `PUT /packages/v2/labtests/required` with body `[{"Label":"<tag>","RequiredLabTestBatches":[…]}]`. Valid names come from `GET /labtests/v2/batches`. | ✅ **Met — verified 09-11 (live).** Sample `AAA05030000213A000000142` created off source `…000138` under panel **Inhalable Concentrate**: METRC answered 200, the sample reads `LabTestingState: SubmittedForTesting` / `IsTestingSample: true`, and the source dropped 74 g → 72 g and also moved to SubmittedForTesting. ⛔ **This is the first time anything in this sandbox has left `NotSubmitted`** — the wall that blocked A1 all week. The acceptance is the proof the panel attached: METRC refused these creates outright with *"At least one Lab Test Batch is required for Item X"* until the field was sent. ⚠️ The panel value itself is NOT readable back from `GET /packages/v2/active` (no such field on that response) — absence there is not evidence either way, and nothing further should be inferred from it.

**Build detail:** `lib/metrcLabTestBatches.ts` maps product type → panel and the sample create sends it; `routes/metrc.ts` refuses with 409 if a product type is unmapped; the dialog sends the batch's product type and names the panel back in the toast. Flower/Pre-Roll → Raw Plant Material · Infused Pre-Roll → **Inhalable Compound Concentrate** · Vape Cartridge + Dual Chamber → Vape Concentrate · **Concentrate → Inhalable Concentrate (ALL concentrate, one panel — Jonathan 09-11)** · Edible + Capsule → Infused Edible · Topical → Infused Non-Edible · Tincture → Tinctures. A solventless site overrides per sample with `labTestBatches` until a site-level default exists. Moves to **Met — verified** only when METRC accepts a sample create with the panel attached. ⚠️ **Three readings today, two of them wrong — the audit trail matters here.** (1) ❌ *On the item:* we sent `LabTestBatchNames` on item create; METRC answers 200 and silently discards it (item id 173707 reads back `[]`). Manual p.40-42 confirms the item form is Name / Category / Unit of Measure only. Dead code removed 09-11. (2) ❌ *"Not on the sample create at all":* I asserted this after a truncated read of the documented body. **Wrong** — `RequiredLabTestBatches` sits immediately after `Ingredients` on `POST /packages/v2/testing`. (3) ✅ *The above.* ⛔ The PDF manuals do **not** answer this: the 2021 manual's "Required Testing" (p.125-126, Item 6) is **CBD / THC checkboxes**, not panel names, and its Testing section (p.170) is a one-line pointer to the State Supplemental, which has no lab-test-batch content at all. **Only the API reference answers it.** |
| A8 | Laboratory results are filed against the sample and returned to the batch | R 420.305 | `recordLabTests` + the results pull keyed on the sample tag | **Unverifiable (sandbox).** Only a licensed lab holding the sample can file results. Filing as our own licence → 401; as the lab licence without holding the package → 400. Needs a real laboratory, or METRC UI access to register the sample transfer. |
| A9 | A failing result holds the batch and blocks release | R 420.304(6) | The quarantine block keeps the hold on a Fail and cites the rule | **Met — unverified.** |
| A10 | A batch cannot be shipped without a passing test on record | R 420.305 | Manifest pre-flight check `tested_passed` | **Met — verified 09-11.** Pre-flight refused the push with no result row, and passed once a Pass existed. |
| A11 | A batch cannot reach "Passed" without a test record | R 420.305 | Status-transition gate in `routes/batches.ts`: entering `passed_awaiting_packaging` requires at least one `batch_testing` row reading Pass. Jonathan's ruling when asked block-or-warn: *"For A11, blocked."* | **Met — verified 09-11 (live).** Defect found and fixed the same day. `PATCH /api/batch-records/34 {status:'passed_awaiting_packaging'}` on a batch with zero testing rows → **409** *"Cannot mark this batch Passed — no laboratory result is recorded. Record the result on the Testing tab first (R 420.305)."* Batch re-read afterwards: still `in_production`, so the refusal has no side effect. The second branch (rows exist, none reads Pass) is the same code path and was not separately exercised. |

## B. Packaging, labelling and transfer — R 420.504 / R 420.502

| # | Requirement | Source | How we meet it | Status |
|---|---|---|---|---|
| B1 | Every sellable unit carries the state compliance label | R 420.504 | Label & Finalize applies labels to the recorded packages and stamps the approval | **Met — unverified.** |
| B2 | The label carries every element Michigan requires | R 420.504(1) | 15-item checklist per product type, generated from the state rule set, answered by a person. Two gates — `POST /batch-labeling/:id/approve` and Label & Finalize — each read the response rows directly and refuse with 409 while any required item lacks a Pass or N/A. Both fail **closed** on an empty checklist. | **Met — verified 09-11.** ⚠️ I reported this as a defect earlier the same day. **That report was wrong** — I read a `response` field that does not exist on the list endpoint and concluded nothing was answered. `checklist-detail` shows all 15 items answered by Jonathan at 14:36:35–53, five seconds before he signed the approval. Code re-read 09-11 confirms neither gate trusts the stored `checklistCompletePct`; that number is display-only. |
| B3 | Label warning text is the rule's text, not a paraphrase | R 420.504(1)(j)(i)-(v) | `seedLabelDefaults.ts` carries the wording verbatim; a one-time pass corrected the invented text | **Met — verified 08-31.** Three blocks (edible onset, vape inhalation, topical) are company standard and labelled as such — no CRA rule located. |
| B4 | Product on hold, failed or destroyed cannot be transferred | R 420.502 | Pre-flight check `batch_not_held` | **Met — verified 09-11.** |
| B5 | Every package on a manifest is tagged and labelled | R 420.504 | Pre-flight checks `all_have_tags`, `all_labeled` | **Met — verified 09-11.** |
| B6 | The outbound transfer is registered with the state | METRC | Template pushed via API; registration is a click in METRC's own site | **Unverifiable (sandbox).** METRC has no API for registering a template as a live transfer. Needs METRC UI access, which we do not have. |
| B7 | Untested product cannot be transferred to a retailer | METRC / R 420.305 | METRC enforces it | **Met — verified 09-11**, by refusal: *"marked as NotSubmitted and cannot be transferred."* ⚠️ Verified that METRC refuses it — NOT that our software prevents attempting it. |

## C. Production records — R 420.504 traceability, FDA GMP

| # | Requirement | Source | How we meet it | Status |
|---|---|---|---|---|
| C1 | Every ingredient is recorded with its lot and the amount actually used | R 420.504 traceability | Ingredients tab; the Testing gate refuses lines without a lot and a quantity | **Met — verified 09-11.** |
| C2 | Ingredient lots must trace to received, inspected stock | Traceability | Provenance check at the Testing gate; BOM hard stop on the picker and on the server | **Met — verified 09-06/09-11.** ⚠️ No correction path when a recipe line names material that does not exist — a stranded batch cannot be fixed. |
| C3 | Inventory is decremented when material is consumed | GMP | Signed "Confirm ingredients & remove from inventory"; release refuses until every line is drawn | **Met — verified 09-11.** |
| C4 | Process steps are signed by the person who performed them | 21 CFR Part 11 | Per-step e-signature, initials matched to the account | **Met — verified 09-11.** |
| C5 | The batch's METRC package is created from its source package | METRC production batch model | The form-change step creates the package and writes the tag back as the batch number | **Met — verified 09-11.** Batch `AAA05030000213A000001142`, cut from `…000134`. |
| C6 | Units produced are recorded before release | Internal rule 08-10 | Release refuses with no output quantity | **Met — verified 09-11.** |

## D. Electronic records — 21 CFR Part 11

| # | Requirement | Source | How we meet it | Status |
|---|---|---|---|---|
| D1 | Signatures carry the signer's name, initials, meaning and time | Part 11 | Server sets name and time from the account and the clock; initials must match | **Met — verified.** |
| D2 | Records are append-only; nothing is hard-deleted | Part 11 | Audit trail on every change; no destructive deletes | **Met — unverified** as a whole-system claim. |
| D3 | Timestamps carry their time zone | Part 11 | All dates go through `lib/facilityDate.ts`; the facility's zone is stored on the facility | **Met — verified 08-26/28.** |
| D4 | A signature cannot be applied by someone other than the signer | Part 11 | Initials must match the signed-in account | ⚠️ **Sandbox exception:** Jonathan authorised Claude to sign as JO in the sandbox on 09-09. That authorisation does NOT extend to production and must not appear in a customer environment. |

---

## Open items this register is waiting on

1. **A7** — built; now EXERCISE it. Create a sample against a real package and confirm METRC accepts `RequiredLabTestBatches`. No support email needed — it was in Metrc's published v2 API reference the whole time.
   ⬜ Follow-on: a **site-level** solvent/solventless default, so a solventless producer's concentrate resolves to "Non-Solvent Concentrate" without a per-sample override (Jonathan 09-11: *"all that 'is it solventless' will be answered by the site"*).
   **The 37 live MI batch names** (`GET /labtests/v2/batches`, read 09-11). Production panels:
   Raw Plant Material · Vape Concentrate · Inhalable Concentrate · **Inhalable Compound Concentrate** ·
   Non-Solvent Concentrate · Infused Edible · Infused Non-Edible · Infused Beverages · Tinctures ·
   Vape Surveillance · Retest Batch. The rest are 11 "Additional Tests – …" and 14 "R&D Testing …".
   ⚠️ Note **Inhalable Compound Concentrate** is a real METRC panel — that is the ICC row below, and it
   means the infused pre-roll maps to an existing state panel rather than anything we invent.
2. **A8 / B6** — both need METRC UI access or a real laboratory. Nothing in the software fixes them.
3. **C2** — no correction path for a batch stranded by a recipe line naming material that does not exist.
4. **ICC (new, not yet a numbered row)** — an infused pre-roll is an inhalable compound concentrate, not a raw pre-roll. Per CRA Best Practices p.53 every cannabis component must hold passing METRC results before the combined product is created, and the combined product is then tested in its final form. Not scoped, not built.

**Closed 09-11:** A11 (built and verified blocked), B2 (my defect report was false; the gate works).

## How to keep this file

Add a row when a requirement is identified, not when it is built. Move a row to
**Met — verified** only when it has been run and the result seen, and name the evidence
(a batch number, a date, a refusal message). When something cannot be proven here, say
**Unverifiable (sandbox)** and name exactly what is missing.
