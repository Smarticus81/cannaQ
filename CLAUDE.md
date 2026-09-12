# CLAUDE.md — Compliance-Compass / CannaQMS

> **2026-09-12 repository cleanup:** Start with `README.md` and
> `docs/CODEBASE_REVIEW.md` for current setup and verification. The unused
> mockup app and historical session files have been archived outside the repo.
> The user explicitly authorized commits/pushes to `Smarticus81/cannaQ` for
> this cleanup, superseding the older handoff-only convention below.

> Canonical, version-controlled project context. Because this lives in the git
> repo (and is pushed to GitHub), it survives regardless of local/OneDrive sync
> state. **If you are an AI assistant resuming work: read this file first, plus
> `artifacts/api-server/METRC_INTEGRATION.md`, before doing anything.**

_Last updated: 2026-07-02 (Session 95 — Metrc read+write routes, safeguards, and soak all deployed)_

## What this is

**CannaQMS** (site: `cannaqms.com`) — a quality-management system for licensed
cannabis operators, with a Metrc (state seed-to-sale tracking) integration.
Monorepo, pnpm workspaces.

- **API server:** `artifacts/api-server/` — package `@workspace/api-server`
  - Typecheck (run from that folder): `pnpm typecheck` (= `tsc -p tsconfig.json --noEmit`)
- **Web apps:** `artifacts/cannaqms`, `artifacts/mockup-sandbox`

## Working conventions

> **MANDATORY — GITHUB HANDOFF FORMAT (Jonathan's standing rule).** EVERY time
> you hand back files for GitHub — every single change, no exceptions — you MUST
> also provide, in the same message:
> 1. **Summary** — one short line (the commit title).
> 2. **Description** — a plain-English paragraph (what changed, why, which files).
> Provide these WITH the handoff, unprompted. Never deliver a file change without
> them. If you are about to say "here's the file," stop and add the two headings.


- **Jonathan runs the typechecks and git commits himself.** Assistants should
  make the edits, then hand back the exact commands / commit text — do not assume
  a sandbox is available to run `tsc`.
- Commit small and often; push to GitHub so nothing is lost.
- OneDrive keeps files "online-only," which makes them look missing to tools
  until opened. That is a sync-display quirk, **NOT deletion**. Fix: right-click
  the folder → "Always keep on this device."

## Metrc integration — overview

- **Env:** Michigan Sandbox — `https://sandbox-api-mi.metrc.com`
- **Processor license:** `SF-SBX-MI-6-13501` · counterparty `SF-SBX-MI-15-13501`
- **Auth:** HTTP Basic — username = Vendor key, password = User key. (User key is
  the one generated in the Metrc UI; it carries the View Wholesale grant. Vendor
  key is the emailed integrator key.)
- **Env vars (secrets never committed):**
  `METRC_VENDOR_KEY`, `METRC_USER_KEY`, `METRC_BASE_URL`, `METRC_LICENSE_NUMBER`,
  `METRC_WRITE_ENABLED` (must be exactly `"true"` to allow any write-back; OFF by default).
- **Scope decision (2026-07-02):** production ships reads AND write-back. Write-back
  is disabled by default behind `METRC_WRITE_ENABLED` and needs a safeguard pass
  (preview/dry-run, confirmation, sandbox soak) before use against a live license.

Code + endpoint reference: **`artifacts/api-server/METRC_INTEGRATION.md`**.

## Metrc v2 gotchas (already encoded in code — don't rediscover)

- External-incoming: `TransferTypeName` = `"External Cannabinoids"` at the TOP
  level of each payload object (not only the destination). `ExternalId` = null.
- PUT id fields differ: external incoming = `TransferId`; templates = `TransferTemplateId`.
- Outgoing licensed types (e.g. "AU Affiliated Transfer") require destination
  `GrossWeight` + `GrossUnitOfWeightName`. Templates accept empty `Packages`.
- Template LIST path is `/transfers/v2/templates/outgoing`; plain `/transfers/v2/templates` 404s.
- Base URL must be `https://` or Metrc's 301 downgrades POST→GET ("405 GET not supported").
- Transfer/template GET search window capped at ~24h (lastModified).
- Empty body + 2xx = success on mutations (PUT/DELETE).
- View Wholesale is a separate grant from Transfers, on the User key. Symptom:
  200 on `/packages`, 401 on `/packages/wholesale` for the same delivery.

## Where the running notes live

Day-to-day session handoffs (what happened when) are kept OUTSIDE the repo in
`Documents\Claude\Projects\Cannabis QMS\` — `_PROJECT_CONTEXT.md` (canonical
resume) plus dated `Session*` / `WeeklySync*` files. This CLAUDE.md is the
in-repo mirror of the stable facts; the session files carry the play-by-play.

## Metrc integration status (as of 2026-07-02, Session 95 — all deployed)

Shipped and deployed to `cannaq-validation-production` (Railway):
- Read routes (facilities, transfers, deliveries, templates, catalog, **items list**).
- Guarded write-back (create/update/delete external-incoming; create/update
  templates) behind `METRC_WRITE_ENABLED` + Admin + audit log.
- Safeguards: **dry-run preview** (`dryRun=true`, no switch needed) and
  **confirmation** (`confirm=true`, else 428) on all writes.
- Sandbox soak script `artifacts/api-server/scripts/metrc-sandbox-soak.js`.

**Soak result:** everything passes — reads, both guardrails, all previews, and
the full TEMPLATE write lifecycle (create→find→update). The ONLY gap is
external-incoming *create*, and it is a **sandbox data gap, not a code bug**: the
sandbox facility currently has **zero active items** (`GET /items/v2/active` →
Total 0), so there is no item for the transfer to reference. Proven correct at
the payload/preview level.

## Environment note: sandbox vs real license

Sandbox is reached via the current keys (`sandbox-api-mi.metrc.com`). To point at
a **real** license you need PRODUCTION keys + `METRC_BASE_URL=https://mi.metrc.com`
+ the real license number. A real license is fine for READS (safe, real data) but
writes must stay OFF against it — write testing stays in the sandbox.

## Current open items

1. Fill the Metrc eval workbook's CompanyInformation + keys (at submission only).
2. Option B (deferred): seed ONE item in the sandbox facility via the API, then
   re-run the soak to see external-incoming create go green (needs a valid MI
   item category).
3. Before enabling write-back against a live license: keep the switch off; use
   dry-run previews only until a full pre-live review.
4. Expand eval read-row JSON to full bodies only if a reviewer requires it.
5. (Product) CannaQMS UI/UX needs work — Jonathan is not yet happy with how it
   looks/functions; a long way from going live against a real license.
