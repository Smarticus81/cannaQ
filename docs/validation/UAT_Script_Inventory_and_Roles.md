# CannaQ UAT Test Script — Inventory & Role / Part 11 Segregation
_Created 2026-06-04. Focus areas: inventory add/remove, role-based access + 21 CFR Part 11 segregation._

## How to use this
Each test has: the **role** to run it as, the **steps**, the **expected result**, and a blank **Result** to mark Pass / Fail / Note. Where a test depends on role, run it twice — once as an **allowed** role (expect success) and once as a **disallowed** role (expect the exact error noted). Server behavior is the source of truth; if the UI hides a button but the API still allows the action, that's a finding (see Part C).

Convention reminders for this build:
- Records are **soft-cancelled, never hard-deleted** (Cancel → reason + Part 11 e-sig; Reopen is Admin-only).
- **Number gaps are expected** after the 55.1 fix (old polluted numbers stay; new ones continue from the max). Not a bug.
- Two inventory models coexist: **`inventory_items`** (created from passed inspections, consumed by batches) and **`lots`** (first-class, full traceability). Keep that in mind when checking quantities.

---

## Part 0 — Setup prerequisites (do these first)

### Test accounts — use Clerk's `+clerk_test` addresses (not real inboxes)
This avoids yesterday's duck.com delivery problem entirely. On a Clerk **development** instance, any email containing the `+clerk_test` subaddress is a test account: **no email is sent**, and the verification code is always **`424242`**. Domain can be anything (use `example.com`).

Create accounts like:
- `operator1+clerk_test@example.com`, `operator2+clerk_test@example.com`
- `super2+clerk_test@example.com`, `manager2+clerk_test@example.com`, `quality2+clerk_test@example.com`

Sign in with each, enter code `424242`, then have the **Admin** promote each to its role (new logins auto-provision as **Operator**; `users.role` is the source of truth).

> Limits: a dev instance allows ~100 email OTPs/month, but `+clerk_test` addresses don't consume that since nothing is sent. Test addresses won't carry to a production instance.

### Recommended account matrix
You already have **Admin (your email), Quality 1, Manager 1, Supervisor 1.** Adding **Operator 1, Operator 2, Quality 2, Manager 2, Supervisor 2 is the better setup** — here's why: Gate 1 requires **two distinct approvers**, and the segregation checks ("can't sign your own", EC-owner ≠ signer, action-owner ≠ signer) are enforced by **identity, not role**. A second same-role account (e.g. Quality 2) lets you prove a Quality user *can* sign when they're not conflicted and *can't* when they are — which a single Quality account can't demonstrate.

- **Minimum to run Part B:** Admin + two approvers (e.g. Manager 1 + Quality 1) + one Operator (as originator).
- **Full matrix (recommended):** Admin, Quality 1/2, Manager 1/2, Supervisor 1/2, Operator 1/2.

| # | Step | Expected |
|---|------|----------|
| 0.1 | Create the `+clerk_test` accounts above; sign in to each with code `424242`. | Each can log in. |
| 0.2 | As Admin, set each user's **role** (new accounts default to **Operator**). | `users.role` matches intended role. |
| 0.3 | Confirm a **baseline dataset**: ≥1 supplier, ≥1 recipe/batch, and note starting quantities for the math checks. | Known starting state. |
| 0.4 | Pick one record of each type to exercise (NC, CAPA, FA, inspection, lot, batch, document). | Test fixtures identified. |

---

## Part A — Inventory add / remove

> Math check pattern: note quantity **before**, perform action, confirm quantity **after** = expected.

### Adds
| ID | Run as | Steps | Expected result |
|----|--------|-------|-----------------|
| A1 | Operator | Create an Incoming Inspection → add a line item with **result = Pass** (qty e.g. 100). | An **`inventory_items`** row appears immediately (item name, lot #, qty = 100). Propagation is per-item Pass — does **not** wait for whole-inspection Pass. Re-saving Pass on the same item does **not** double-add (idempotent). |
| A2 | Operator | Lots page → **New Lot** → fill itemName, quantity (e.g. 50), UoM, origin → Create. | New **`lots`** row: status **Active**, `currentQuantity = originalQuantity = 50`, lot number auto-generated (`LOT-…`). A `lot create` event is logged. |
| A3 | Operator | On a batch, record the output as a **METRC package** — enter the `metrcPackageId` (the Michigan METRC tag) and the total units / weight (`outputQuantity`) and mark it **Finished Good**. | This is the **terminus** for CannaQ by design: the finished good is the METRC package + quantity. CannaQ does **not** create a downstream lot and does **not** track shipments — METRC owns finished-goods shipment tracking. ✅ Verify the batch-output flow actually captures `metrcPackageId` + total units and surfaces the Finished Good state; if the UI doesn't capture the METRC tag at output, that's the one thing to flag here. |

### Removes / adjustments
| ID | Run as | Steps | Expected result |
|----|--------|-------|-----------------|
| A4 | **Manager** (allowed) | Lot detail → **Split** an Active lot (qty 50) into 2 parts (e.g. 20 + 10) → enter initials + meaning. | Parent `currentQuantity` 50 → **20** (50 − 30); two child lots created (origin = **split**, qty 20 and 10, Active). Parent → **Consumed** only if it hits 0. Events signed. |
| A4b | **Operator** (blocked) | Attempt the same Split. | **403** "Lot splits require Manager, Quality, or Admin role." |
| A5 | **Manager** | Merge 2+ Active lots (same item + UoM) → initials + meaning. | Sources set to qty 0 / **Consumed**; new **merged** lot = sum of sources, Active. Events signed. |
| A6 | **Supervisor** (allowed) | Lot detail → **Ship** → customer, shippedQty (e.g. 5) → confirm. | `currentQuantity` decremented by 5; a shipment row is created; event logged. Drops to **Consumed** if it hits 0. |
| A6b | **Operator** (blocked) | Attempt the same Ship. | **403** (requires Supervisor / Manager / Quality / Admin). |
| A7 | **Manager** | Lot detail → **Recall** → reason + initials + meaning. | Lot status → **Recalled** (quantity unchanged). Forward lineage traced: descendant lots **and** downstream shipments also flip to **Recalled**. |
| A8 | Operator | Batch → **Add Ingredient** → pick a source lot/item, actualQty (e.g. 30 from a 100-qty item). | `inventory_items` qty 100 → **70**. Decrement is clamped at 0 (no negative). |
| A9 | Operator | Edit that ingredient: 30 → **20**. | 10 is **refunded** to the same inventory row (70 → 80). Edit 20 → 40 takes another 20 (80 → 60). Delta-based, no double counting. |
| A10 | Operator | Delete the ingredient row. | The amount taken is **refunded** back to inventory. |
| A11 | (per FA close rules) | Field Action detail → **Add Lot** with **Auto-Quarantine** on → initials + meaning. | Lot status → **Quarantined**, `quarantinedAt` set, **quantity unchanged**. Must be Active to quarantine (else 409). Event signed. |
| A12 | Manager/Quality | On an NC, set disposition **Destroy** and link a destruction record. | ⚠ The destruction link is a **reference only** — it does **not** auto-change the linked lot's status or decrement quantity (known gap — Part C/D). Confirm this is acceptable or flag it. |

---

## Part B — Role / Part 11 segregation
> For each: run as an **allowed** role (expect success + signature captured) and a **disallowed** role / the **same person** (expect the exact error). Roles: Operator, Supervisor, Manager, Quality, Admin.

| ID | Action | Allowed roles | Segregation rule | Expected when blocked |
|----|--------|---------------|------------------|------------------------|
| B1 | **CAPA Gate 0** (acceptance) | Manager, Quality, Admin (**Supervisor excluded**) | Originator ≠ signer | 403 "Gate 0 acceptance requires Manager, Quality, or Admin role"; 409 if originator tries |
| B2 | **CAPA Gate 1** (two signatures) | Supervisor, Manager, Quality, Admin | Two **distinct** signers; **originator, EC Owner, and action-item owners all blocked**; signer1 ≠ signer2 | 409 "the originator cannot approve their own Gate 1"; 409 "Effectiveness Check Owner cannot sign Gate 1"; 409 "already signed Gate 1 — a second distinct approver is required" |
| B2b | **Gate 1 readiness** | — | Requires RCA + action plan + EC steps + **EC Owner assigned** + stage = Planning | 409 if any piece missing (try signing an incomplete CAPA) |
| B3 | **CAPA Gate 2** (closure) | Manager, Quality, Admin | Originator / EC Owner / action-item owner ≠ signer; stage = EC Execution | 403 role; 409 originator |
| B4 | **NC Close / Approve** | ⚠ **No server role check** (any authenticated user) | E-sig required (initials + meaning); no self-sign block | Verify the **UI** restricts this; server only blocks on pending corrections / missing mgmt-ack / missing CAPA-or-rationale for Major-Critical. **Flag (Part C).** |
| B5 | **NC Use-As-Is** disposition | Supervisor, Manager, Quality, Admin | approver initials + meaning | 403 "requires Supervisor / Manager / Quality / Admin role" |
| B6 | **NC Cancel** / **Reopen** | Cancel: Manager, Quality, Admin · Reopen: **Admin only** | e-sig + reason | 403 "Cancelling requires Manager, Quality, or Admin"; reopen 403 "restricted to Admin" |
| B7 | **Inspection Cancel** / **Reopen** | Cancel: Manager, Quality, Admin · Reopen: **Admin only** | e-sig + reason | same 403s as B6 |
| B8 | **Inspection Pass-with-Fails** | Supervisor, Manager, Quality, Admin (only when a line item is Fail) | approver initials + meaning | 403 "Pass requires Supervisor+/… when any line item is Fail" |
| B9 | **Field Action Close** | ⚠ **No server role check** (any authenticated user) | E-sig required (initials + meaning) | Verify the **UI** restricts this. **Flag (Part C).** |
| B10 | **Document Review → Approve** | Approve: Supervisor, Manager, Quality, Admin | **Reviewer ≠ Approver**; reviewer must sign first; must be the assigned approver | 403 "role not permitted to approve"; 403 "Approver cannot also be the Reviewer". Note: **sign-review itself has no role check** (ID-gated to assigned reviewer only) — flag. |

---

## Part C — Tighten-up findings + decisions (2026-06-04)

### Decided — DO (strict Part 11): role-gate the closure/review/approval endpoints
For record **closure** and document **review/approval** we want to track Part 11 closely. These currently enforce the e-signature but have **no server-side role check** (UI-only), which is the gap to close:
- **NC Close/Approve** (B4) — add the approver-role gate (and consider a self-sign check) server-side.
- **Field Action Close** (B9) — add the approver-role gate server-side.
- **NC Management-Acknowledge** — add role gate.
- **Document sign-review** — add a role gate (today it's only identity-gated to the assigned reviewer; approve is already correctly gated + reviewer≠approver).
→ Scope as a focused **Part 11 role-gate hardening session** (server-only, mirrors the existing cancel/use-as-is gate pattern).

### Decided — OK with caveat: ingredient weights via audit trail
Relying on the audit trail for who-entered-which-weight is acceptable under Part 11 — **but** the batch-ingredient add/edit/delete handlers currently record `createdAt`/`updatedAt` only, **no acting user**. To actually satisfy Part 11 attribution, that flow needs to capture **who** (acting user id/name) and, on edits, **before → after** values. So this is "audit-trail, yes — but the audit trail needs a who." Small server fix; bundle with the hardening session.

### Resolved — NOT a gap: batch output / METRC
Batch output = a **METRC package** (`metrcPackageId`) + total units/weight = **Finished Good**, and shipments are tracked in METRC, not CannaQ. The schema already carries `metrcPackageId` + `outputQuantity`, so this is the intended terminus, not a missing-lot bug. The only thing to verify is that the **UI captures the METRC tag at output** (see A3).

### Still open — your call
- **No dedicated lot quantity-adjustment endpoint:** physical-count corrections only happen via Split/Merge/Ship today. Consider an `adjust` action with Part 11 e-sig + reason.
- **Destruction link is reference-only** (A12): disposition = Destroy + linked destruction record does **not** change the lot. Decide if it should auto-flip the lot to Destroyed/Consumed (note: in METRC, destruction may also be the system of record — confirm where the truth lives).
- **Two inventory models** (`inventory_items` vs `lots`): clarify the intended mental model / whether to reconcile into one view.

---

## Part D — New function ideas (running list — add as you test)
- **Lot quantity adjustment** action (correction after physical count) with Part 11 e-sig + reason + audit event.
- **Acting-user attribution** on batch-ingredient entry/edit (prerequisite for the audit-trail approach above).
- **Destruction disposition** behavior decision (auto-flip lot vs METRC-owned).
- Unified **inventory view** reconciling `inventory_items` and `lots`.
- _(add your own here as ideas come up during the walkthrough)_

---

## Results capture
Mark each test `PASS` / `FAIL` / `N/A` with a note. Anything unexpected → capture the screen + the Network/Console detail and we'll triage.

| Test | Result | Notes |
|------|--------|-------|
| A1 … A12 | | |
| B1 … B10 | | |
