# Metrc Integration — File & Endpoint Reference

Reference for the CannaQMS ↔ Metrc v2 integration. Kept in-repo so it is
version-controlled and cannot be lost. See repo-root `CLAUDE.md` for the wider
project context and the Metrc v2 gotchas.

_Last updated: 2026-07-02 (Session 95)_

## Library files — `src/lib/`

| File | Role |
|------|------|
| `metrcClient.ts` | The single typed HTTP client every Metrc call goes through. `normalizeBaseUrl()` forces an `https://` scheme (kills the POST→GET redirect-downgrade bug). `metrcGet/metrcPost/metrcPut/metrcDelete` share `metrcSend`. `interpretResponse` treats an empty 2xx body as success and maps 401/403 → `unauthorized`. `getMetrcConfig()` / `getMetrcConfigStatus()` read env without exposing secrets. `getFacilities()` + `summarizeFacilities()` back the Phase-0 smoke test. Exports the `MetrcResult<T>` discriminated result type. |
| `metrcEndpoints.ts` | Every verified path (`MetrcPaths`), transfer-type names (`MetrcTransferTypes`), PUT id field names (`MetrcPutIdField`), and `transferWindow()` (24h-clamped lastModified window). One place so no caller re-guesses a path or magic string. |
| `metrcTransfers.ts` | Typed transfer/template **reads**, payload **builders** (`buildExternalIncomingPayload`, `buildTemplateOutgoingPayload` — top-level transfer type, null ExternalId, required gross weight baked in), and **write** helpers (`createExternalIncoming`, `updateExternalIncoming`, `deleteExternalIncoming`, `createTemplateOutgoing`, `updateTemplateOutgoing`). |
| `metrcCatalog.ts` | Catalog get-by-id (`getStrain`, `getItem`, `getPackage`) + `diagnoseWholesaleAccess()`, which turns the "200 on /packages, 401 on /packages/wholesale" symptom into a clear "missing View Wholesale grant" verdict. |

## Route file — `src/routes/metrc.ts`

All endpoints are **Admin-gated**. All use the house **diagnostic-200 shape**: a
Metrc-side 4xx returns `{ ok:false, kind, error, config }` (HTTP 200 from us) so
the UI can explain it; a non-2xx from us means our own gate only (not signed in /
not Admin / write switch off / bad body).

### Reads (read-only overlay)

| Method + path | Backed by |
|---------------|-----------|
| `GET /metrc/status` | `getMetrcConfigStatus()` + `writeEnabled` |
| `GET /metrc/facilities` | `getFacilities()` + `summarizeFacilities()` |
| `GET /metrc/transfers/incoming` \| `/outgoing` \| `/rejected` | 24h window, overridable via `?lastModifiedStart/End`; `?licenseNumber` optional |
| `GET /metrc/transfers/types` | `getTransferTypes()` |
| `GET /metrc/transfers/:transferId/deliveries` | `getTransferDeliveries()` (outgoing-only per Metrc) |
| `GET /metrc/deliveries/:deliveryId/packages` | `getDeliveryPackages()` |
| `GET /metrc/deliveries/:deliveryId/packages/wholesale` | `getDeliveryPackagesWholesale()` |
| `GET /metrc/deliveries/:deliveryId/wholesale-diagnosis` | `diagnoseWholesaleAccess()` |
| `GET /metrc/templates/outgoing` | `getOutgoingTemplates()` |
| `GET /metrc/templates/:templateId/deliveries` | `getTemplateDeliveries()` |
| `GET /metrc/items` | `getActiveItems()` — active item catalog for the facility |
| `GET /metrc/strains/:id` \| `/items/:id` \| `/packages/:label` | catalog get-by-id |

### Writes (Phase 3 — GUARDED)

Gated three ways: **Admin role** + **`METRC_WRITE_ENABLED="true"`** (off by
default — writes cannot fire until deliberately enabled) + an **audit-log line**
on every attempt. Bodies get a required-field check before reaching Metrc.

**Dry-run / preview:** add `?dryRun=true` (or `dryRun:true` in the body) to any
write endpoint to get back the exact request that WOULD be sent to Metrc
(`{ ok:true, dryRun:true, wouldSend:{ method, path, body } }`) **without calling
Metrc**. Preview requires Admin but does NOT require `METRC_WRITE_ENABLED`, so
payloads can be inspected safely before write-back is ever turned on.

**Confirmation:** a real (non-preview) write also requires `confirm=true` (query
or body). Without it the endpoint returns **428** `{ needsConfirmation:true }`.
Intended flow: preview with `dryRun=true` → review `wouldSend` → resend with
`confirm=true` to execute. This makes accidental writes near-impossible even when
the write switch is on.

| Method + path | Backed by |
|---------------|-----------|
| `POST /metrc/transfers/external-incoming` | `createExternalIncoming()` |
| `PUT /metrc/transfers/external-incoming/:transferId` | `updateExternalIncoming()` |
| `DELETE /metrc/transfers/external-incoming/:transferId` | `deleteExternalIncoming()` |
| `POST /metrc/templates/outgoing` | `createTemplateOutgoing()` |
| `PUT /metrc/templates/outgoing/:templateId` | `updateTemplateOutgoing()` |

The router is mounted in `src/routes/index.ts` (`router.use(metrcRouter)`).

## Environment variables

| Var | Purpose |
|-----|---------|
| `METRC_VENDOR_KEY` | Vendor (integrator) key — Basic auth username |
| `METRC_USER_KEY` | API User key (from Metrc UI; carries View Wholesale) — Basic auth password |
| `METRC_BASE_URL` | Defaults to the MI sandbox host; forced to https by the client |
| `METRC_LICENSE_NUMBER` | Processor license used by package/transfer calls |
| `METRC_WRITE_ENABLED` | Must be exactly `"true"` to allow any write-back. OFF by default. |

## Sandbox soak test

`scripts/metrc-sandbox-soak.js` exercises these endpoints against the MI sandbox
to prove the whole path through our own code works (reads, guardrails, dry-run
previews, and a full confirmed create→find→update→delete lifecycle).

Run it: deploy with sandbox keys + `METRC_WRITE_ENABLED=true`, sign into CannaQMS
as an **Admin**, open DevTools → Console, paste the script, read the PASS/FAIL
summary. It uses your logged-in session (no tokens), and refuses to run writes
unless `/metrc/status` reports `isSandbox=true`. Set `runWrites=false` in its
CONFIG for read-only. Edit `externalIncomingItemName` if the sandbox rejects the
default item name.

## Before enabling write-back on a live license

`METRC_WRITE_ENABLED=true` against a real (non-sandbox) license mutates state the
regulator sees. Do a safeguard pass first: a preview/dry-run mode, an explicit
confirmation step, rollback/undo thinking, and a sandbox soak. Until then, keep
the switch off in production.
