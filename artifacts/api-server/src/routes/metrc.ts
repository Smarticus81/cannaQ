import { Router, type IRouter, type Request, type Response } from "express";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { getFacilities, getMetrcConfig, getMetrcConfigStatus, metrcGet, summarizeFacilities, type MetrcResult } from "../lib/metrcClient";
import {
  getIncomingTransfers,
  getOutgoingTransfers,
  getRejectedTransfers,
  getTransferTypes,
  getTransferDeliveries,
  getDeliveryPackages,
  getDeliveryPackagesWholesale,
  getOutgoingTemplates,
  getTemplateDeliveries,
  createExternalIncoming,
  updateExternalIncoming,
  deleteExternalIncoming,
  createTemplateOutgoing,
  updateTemplateOutgoing,
  buildExternalIncomingPayload,
  buildTemplateOutgoingPayload,
  type ExternalIncomingInput,
  type TemplateOutgoingInput,
} from "../lib/metrcTransfers";
import { getStrain, getItem, getActiveItems, getPackage, getItemCategories, createItems, getLabTestBatches, diagnoseWholesaleAccess } from "../lib/metrcCatalog";
import { getLabResults, getLabTestTypes, recordLabTests, type LabResultLine, type MetrcLabTestType } from "../lib/metrcLabTests";
import { transferWindow, MetrcPaths, MetrcPutIdField } from "../lib/metrcEndpoints";
import { buildCreatePackagesPayload, getActiveLocations, getLocationTypes, createLocations, buildCreateTestingPayload, createTestingPackage, type CreateFinishedGoodsInput, type CreateTestingSampleInput } from "../lib/metrcPackages";
import { getTrackingProviderForFacility } from "../lib/trackingProvider";
import { facilityDateStr } from "../lib/facilityDate";
import { resolveLabTestBatches } from "../lib/metrcLabTestBatches";

// ---------------------------------------------------------------------------
// Metrc integration routes — Phase 0 connectivity smoke test
// ---------------------------------------------------------------------------
//
// Two Admin-gated endpoints:
//   GET /metrc/status     — reports whether the integration is configured
//                           (which env pieces are present), no external call,
//                           never returns the secret values.
//   GET /metrc/facilities — the actual smoke test: authenticates against Metrc
//                           and returns GET /facilities/v2 plus a permission
//                           summary. Runnable from the deployed app, the same
//                           house pattern as /admin/sandbox-reset.
//
// The facilities endpoint always responds 200 with a structured body (ok + the
// Metrc outcome) so a future status panel can render "Metrc returned 401" as a
// diagnostic rather than a failed request. Non-2xx from THIS endpoint means our
// own auth (not signed in / not Admin) only.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const actor = await getOrProvisionCurrentUser(req);
  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  if (actor.role !== "Admin") {
    res.status(403).json({ error: "Admin role required" });
    return false;
  }
  return true;
}

// Session 97 — some Metrc READS are safe for any enrolled staff. Mirrors the
// real Metrc model: everyone is in the system (regulatory requirement), reads are
// broadly available, and only edit/write actions are role-restricted. Used for
// the finished-goods active-packages read (Operator and up = any authenticated user).
async function requireAuth(req: Request, res: Response): Promise<boolean> {
  const actor = await getOrProvisionCurrentUser(req);
  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

router.get("/metrc/status", async (req: Request, res: Response) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    res.json({ ...getMetrcConfigStatus(), writeEnabled: metrcWriteEnabled() });
  } catch (err) {
    req.log.error({ err }, "Failed to read Metrc status");
    res.status(500).json({ error: "Failed to read Metrc status" });
  }
});

router.get("/metrc/facilities", async (req: Request, res: Response) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    const result = await getFacilities();
    if (!result.ok) {
      // Surface the Metrc-side outcome as a diagnostic (200 from us). The `kind`
      // lets the UI explain it: not_configured → set the keys; unauthorized →
      // the key lacks Facilities permission; network → host/DNS problem.
      res.json({
        ok: false,
        metrcStatus: result.status,
        kind: result.kind,
        error: result.error,
        config: getMetrcConfigStatus(),
      });
      return;
    }

    const facilities = result.data ?? [];
    res.json({
      ok: true,
      metrcStatus: result.status,
      count: Array.isArray(facilities) ? facilities.length : 0,
      summary: summarizeFacilities(facilities),
      facilities,
      config: getMetrcConfigStatus(),
    });
  } catch (err) {
    req.log.error({ err }, "Metrc facilities smoke test failed");
    res.status(500).json({ error: "Metrc facilities smoke test failed" });
  }
});

// ---------------------------------------------------------------------------
// Metrc read endpoints (Phase 1) — Admin-gated, read-only overlay
// ---------------------------------------------------------------------------
//
// These wire the typed reads in lib/metrcTransfers + lib/metrcCatalog behind the
// same Admin gate and diagnostic-200 convention as /metrc/facilities. Every
// endpoint returns 200 with { ok, ... } so a status/diagnostics UI can render a
// Metrc-side 401/404 as a diagnostic instead of a failed request; a non-2xx from
// US still means our own auth only (not signed in / not Admin).
//
// WRITE-BACK IS INTENTIONALLY PARKED. The create/update/delete helpers exist in
// lib/metrcTransfers but are deliberately NOT exposed here — production design is
// a read-only overlay. Add write routes only when that scope decision is made.
// ---------------------------------------------------------------------------

/** Coerce a query/param value to a non-empty string, else undefined. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Coerce a REQUIRED path param to a single string. Express param values type as
 * `string | string[]` here, so take the first element of an array and fall back
 * to "" (the route only matches when the segment is present).
 */
function pathParam(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

/** Render a MetrcResult with the house diagnostic-200 shape. */
function renderMetrc<T>(res: Response, result: MetrcResult<T>): void {
  if (!result.ok) {
    res.json({
      ok: false,
      metrcStatus: result.status,
      kind: result.kind,
      error: result.error,
      config: getMetrcConfigStatus(),
    });
    return;
  }
  res.json({ ok: true, metrcStatus: result.status, data: result.data, config: getMetrcConfigStatus() });
}

/**
 * Render a MetrcResult for a route that WRITES to METRC.
 *
 * renderMetrc above answers 200 even when METRC refused, because the read
 * routes use that shape as a diagnostic envelope the screens render inline.
 * On a write that is dangerous: a caller that checks the HTTP status — which is
 * the normal thing to do — reads a refusal as a success. That is exactly how
 * batch 1135 recorded four METRC packages that METRC had rejected with a 400
 * ("Package ... does not exist in the current Facility"), and then stamped them
 * as created. A write must fail loudly, so the METRC status is passed straight
 * through (502 when the failure was network-level and has no status of its own).
 * The body keeps the same ok/error/metrcStatus shape, so anything already
 * reading the payload keeps working unchanged.
 */
function renderMetrcWrite<T>(res: Response, result: MetrcResult<T>): void {
  if (!result.ok) {
    const status = result.status >= 400 && result.status <= 599 ? result.status : 502;
    res.status(status).json({
      ok: false,
      metrcStatus: result.status,
      kind: result.kind,
      error: result.error,
      config: getMetrcConfigStatus(),
    });
    return;
  }
  res.json({ ok: true, metrcStatus: result.status, data: result.data, config: getMetrcConfigStatus() });
}

/** Wrap an Admin-gated handler with requireAdmin + uniform try/catch. */
function adminRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      if (!(await requireAdmin(req, res))) return;
      await handler(req, res);
    } catch (err) {
      req.log.error({ err }, "Metrc route failed");
      res.status(500).json({ error: "Metrc request failed" });
    }
  };
}

/** Wrap a handler that only needs an authenticated user (Operator and up). For
 *  safe reads like finished-goods active packages. Writes stay Admin-gated. */
function authedRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      if (!(await requireAuth(req, res))) return;
      await handler(req, res);
    } catch (err) {
      req.log.error({ err }, "Metrc route failed");
      res.status(500).json({ error: "Metrc request failed" });
    }
  };
}

/** Build a lastModified window from query params, defaulting to a 24h window. */
function windowFromQuery(req: Request): { lastModifiedStart: string; lastModifiedEnd: string } {
  const w = transferWindow();
  return {
    lastModifiedStart: str(req.query["lastModifiedStart"]) ?? w.lastModifiedStart,
    lastModifiedEnd: str(req.query["lastModifiedEnd"]) ?? w.lastModifiedEnd,
  };
}

// --- Transfers ---------------------------------------------------------------

router.get(
  "/metrc/transfers/incoming",
  adminRoute(async (req, res) => {
    const w = windowFromQuery(req);
    renderMetrc(res, await getIncomingTransfers({ licenseNumber: str(req.query["licenseNumber"]), ...w }));
  }),
);

router.get(
  "/metrc/transfers/outgoing",
  adminRoute(async (req, res) => {
    const w = windowFromQuery(req);
    renderMetrc(res, await getOutgoingTransfers({ licenseNumber: str(req.query["licenseNumber"]), ...w }));
  }),
);

router.get(
  "/metrc/transfers/rejected",
  adminRoute(async (req, res) => {
    const w = windowFromQuery(req);
    renderMetrc(res, await getRejectedTransfers({ licenseNumber: str(req.query["licenseNumber"]), ...w }));
  }),
);

// 2026-09-08 (Jonathan) — operators ship product, so the manifest form must
// load for them. This is a READ of Metrc's transfer-type catalog and it was
// Admin-gated, which meant a Supervisor got a 403 and an EMPTY dropdown with no
// error. Any signed-in user now, same as /metrc/packages/active.
router.get(
  "/metrc/transfers/types",
  authedRoute(async (req, res) => {
    renderMetrc(res, await getTransferTypes(str(req.query["licenseNumber"])));
  }),
);

/** OUTGOING-ONLY per Metrc — returns empty for an incoming transfer id. */
router.get(
  "/metrc/transfers/:transferId/deliveries",
  adminRoute(async (req, res) => {
    renderMetrc(res, await getTransferDeliveries(pathParam(req.params["transferId"]), str(req.query["licenseNumber"])));
  }),
);

// --- Deliveries (packages + wholesale) ---------------------------------------

router.get(
  "/metrc/deliveries/:deliveryId/packages",
  adminRoute(async (req, res) => {
    renderMetrc(res, await getDeliveryPackages(pathParam(req.params["deliveryId"]), str(req.query["licenseNumber"])));
  }),
);

router.get(
  "/metrc/deliveries/:deliveryId/packages/wholesale",
  adminRoute(async (req, res) => {
    renderMetrc(res, await getDeliveryPackagesWholesale(pathParam(req.params["deliveryId"]), str(req.query["licenseNumber"])));
  }),
);

/**
 * Turns the "200 on /packages, 401 on /packages/wholesale" symptom into a clear
 * verdict about the missing View Wholesale grant. Returns its own shape (not a
 * MetrcResult), so respond directly.
 */
router.get(
  "/metrc/deliveries/:deliveryId/wholesale-diagnosis",
  adminRoute(async (req, res) => {
    const diagnosis = await diagnoseWholesaleAccess(pathParam(req.params["deliveryId"]), str(req.query["licenseNumber"]));
    res.json({ ok: true, diagnosis, config: getMetrcConfigStatus() });
  }),
);

// --- Transfer templates ------------------------------------------------------

router.get(
  "/metrc/templates/outgoing",
  adminRoute(async (req, res) => {
    const w = windowFromQuery(req);
    renderMetrc(res, await getOutgoingTemplates({ licenseNumber: str(req.query["licenseNumber"]), ...w }));
  }),
);

router.get(
  "/metrc/templates/:templateId/deliveries",
  adminRoute(async (req, res) => {
    renderMetrc(res, await getTemplateDeliveries(pathParam(req.params["templateId"]), str(req.query["licenseNumber"])));
  }),
);

// --- Catalog (get-by-id) -----------------------------------------------------

router.get(
  "/metrc/strains/:id",
  adminRoute(async (req, res) => {
    renderMetrc(res, await getStrain(pathParam(req.params["id"]), str(req.query["licenseNumber"])));
  }),
);

router.get(
  "/metrc/items",
  adminRoute(async (req, res) => {
    renderMetrc(res, await getActiveItems(str(req.query["licenseNumber"])));
  }),
);

// — 2026-09-09: this MUST stay above "/metrc/items/:id". It sat below it, so
// Express matched "ensure" as an item id and asked METRC for an item by that
// name — a 401 that looked like a credentials problem and hid the route entirely.
router.get(
  "/metrc/items/ensure",
  adminRoute(async (req, res) => {
    const licenseNumber = str(req.query["licenseNumber"]);
    const name = (str(req.query["name"]) ?? "").trim();
    const wantCategory = (str(req.query["category"]) ?? "").trim();
    const uom = (str(req.query["uom"]) ?? "Each").trim();
    // Some categories carry required fields of their own: "Buds (prepackaged)"
    // is CountBased and demands a UNIT WEIGHT and a STRAIN, "Vape Cart" demands
    // a unit weight. Read what the category asks for and pass it through rather
    // than sending a bare name and letting METRC refuse.
    const unitWeight = Number(str(req.query["unitWeight"]) ?? "");
    const unitWeightUom = (str(req.query["unitWeightUom"]) ?? "Grams").trim();
    const strain = (str(req.query["strain"]) ?? "").trim();
    if (!name) { res.status(400).json({ ok: false, error: "A name is required (?name=...)." }); return; }

    const existing = await getActiveItems(licenseNumber);
    const existingNames = existing.ok ? houseNames(existing.data) : [];
    if (existingNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
      res.json({ ok: true, created: false, name, note: "An item with this name already exists.", items: existingNames });
      return;
    }

    const cats = await getItemCategories(licenseNumber);
    if (!cats.ok) { res.status(502).json({ ok: false, step: "categories", error: cats.error }); return; }
    const catNames = houseNames(cats.data);
    // Exact match first, then a contains-match, so "Pre-Roll" finds whatever this
    // state actually calls it without hard-coding Michigan's vocabulary here.
    const category = wantCategory
      ? (catNames.find((c) => c.toLowerCase() === wantCategory.toLowerCase())
        ?? catNames.find((c) => c.toLowerCase().includes(wantCategory.toLowerCase())))
      : undefined;
    if (!category) {
      res.status(400).json({ ok: false, step: "category", error: wantCategory ? `No category on this facility matches "${wantCategory}".` : "A category is required (?category=...).", availableCategories: catNames });
      return;
    }

    const catRow = (Array.isArray((cats.data as { Data?: unknown[] })?.Data)
      ? ((cats.data as { Data?: Record<string, unknown>[] }).Data ?? [])
      : []).find((c) => String(c["Name"] ?? "") === category) ?? {};
    const item: Record<string, unknown> = { Name: name, ItemCategory: category, UnitOfMeasure: uom };
    if (catRow["RequiresUnitWeight"] === true) {
      if (!Number.isFinite(unitWeight) || unitWeight <= 0) {
        res.status(400).json({ ok: false, step: "unitWeight", error: `Category "${category}" requires a unit weight — add &unitWeight=1&unitWeightUom=Grams.` });
        return;
      }
      item["UnitWeight"] = unitWeight;
      item["UnitWeightUnitOfMeasure"] = unitWeightUom;
    }
    if (catRow["RequiresStrain"] === true) {
      if (!strain) {
        res.status(400).json({ ok: false, step: "strain", error: `Category "${category}" requires a strain — add &strain=<name>.` });
        return;
      }
      item["Strain"] = strain;
    }
    const made = await createItems([item], licenseNumber);
    if (!made.ok) {
      res.status(made.status >= 400 && made.status <= 599 ? made.status : 502)
        .json({ ok: false, step: "create", error: made.error, categoryUsed: category, availableCategories: catNames });
      return;
    }
    res.json({ ok: true, created: true, name, categoryUsed: category, unitOfMeasure: uom });
  }),
);

// 2026-09-11 — the state's lab test batches. Read-only; any signed-in user, the
// same as the other catalog reads the packaging dialog needs.
router.get(
  "/metrc/labtest/batches",
  authedRoute(async (req, res) => {
    renderMetrc(res, await getLabTestBatches(str(req.query["licenseNumber"])));
  }),
);

router.get(
  "/metrc/items/:id",
  adminRoute(async (req, res) => {
    renderMetrc(res, await getItem(pathParam(req.params["id"]), str(req.query["licenseNumber"])));
  }),
);

// Session 97 — ACTIVE packages = the facility's on-hand inventory per Metrc
// (finished goods). Read-only, for reconciling against physical counts. Must be
// registered BEFORE "/metrc/packages/:label" so "active" isn't captured as a label.
router.get(
  "/metrc/packages/active",
  // Operator and up — finished-goods on-hand read (safe; reconciliation view).
  authedRoute(async (req, res) => {
    // Routed through the state-tracking provider (the "conduit"): Metrc today,
    // BioTrack later by config — no route or frontend change. Selected per
    // facility by regulatory_config.tracing_system.
    const provider = await getTrackingProviderForFacility();
    renderMetrc(res, await provider.getActivePackages(str(req.query["licenseNumber"])));
  }),
);

// NOTE: the greedy "/metrc/packages/:label" route is registered LOWER DOWN, AFTER
// the literal "/metrc/packages/{items,available-tags,locations}" routes. Express
// matches in registration order, so a ":label" placed here captures "items" etc.
// as a package label and calls getPackage("items") → Metrc 404. Keep :label last
// among the /metrc/packages/* routes (same reason /active is registered above it).

// ---------------------------------------------------------------------------
// Metrc write-back endpoints (Phase 3) — Admin-gated + explicit safety switch
// ---------------------------------------------------------------------------
//
// These POST/PUT/DELETE endpoints mutate Metrc state. They are gated THREE ways:
//   1. Admin role (requireAdmin), like every other Metrc route.
//   2. An explicit env switch: METRC_WRITE_ENABLED must be exactly "true".
//      Off by default, so write-back CANNOT fire in any environment — including
//      production against a live license — until it is deliberately turned on.
//   3. Every attempt is audit-logged (actor + target) before the call.
//
// Metrc-side outcomes use the same diagnostic-200 shape as the reads: a Metrc
// 400/401 comes back as { ok:false, kind, error } so the UI can explain it. A
// non-2xx from US means our own gate (auth / role / switch / bad body) only.
// ---------------------------------------------------------------------------

/** True only when write-back has been explicitly enabled via env. */
function metrcWriteEnabled(): boolean {
  return (process.env["METRC_WRITE_ENABLED"] ?? "").trim().toLowerCase() === "true";
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

/** True when the caller asked for a preview (no Metrc call): ?dryRun=true or body.dryRun===true. */
function isDryRun(req: Request): boolean {
  if (str(req.query["dryRun"]) === "true") return true;
  const body = req.body as { dryRun?: unknown } | undefined;
  return body?.dryRun === true;
}

/** True when the caller explicitly confirmed a real write: ?confirm=true or body.confirm===true. */
function isConfirmed(req: Request): boolean {
  if (str(req.query["confirm"]) === "true") return true;
  const body = req.body as { confirm?: unknown } | undefined;
  return body?.confirm === true;
}

/**
 * Preview response: the exact request that WOULD be sent to Metrc, plus the
 * built payload, without calling Metrc. Lets an Admin inspect a write safely
 * even when write-back is disabled.
 */
function previewResponse(res: Response, method: string, path: string, body?: unknown): void {
  res.json({ ok: true, dryRun: true, wouldSend: { method, path, body }, config: getMetrcConfigStatus() });
}

/** Parse a required numeric path param; returns null (caller 400s) if invalid. */
function parseId(v: unknown): number | null {
  const n = Number(pathParam(v));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Wrap an Admin-gated WRITE handler. Adds the METRC_WRITE_ENABLED gate and an
 * audit log line (actor id + method + path) before the handler runs.
 */
function adminWriteRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const actor = await getOrProvisionCurrentUser(req);
      if (!actor) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (actor.role !== "Admin") {
        res.status(403).json({ error: "Admin role required" });
        return;
      }
      // A dry-run/preview never calls Metrc, so it is allowed with Admin alone —
      // it does NOT require the write switch. A real write does.
      const dry = isDryRun(req);
      if (!dry && !metrcWriteEnabled()) {
        res.status(403).json({
          error: "Metrc write-back is disabled. Set METRC_WRITE_ENABLED=true to enable it. (Add ?dryRun=true to preview the payload without writing.)",
          writeEnabled: false,
        });
        return;
      }
      // A real write must be explicitly confirmed, so nothing fires by accident
      // even with the switch on. Preview first (dryRun), then resend with confirm.
      if (!dry && !isConfirmed(req)) {
        res.status(428).json({
          error: "Confirmation required for a real Metrc write. Preview it first with dryRun=true, then resend with confirm=true (query or body) to execute.",
          needsConfirmation: true,
        });
        return;
      }
      req.log.info(
        { actorId: actor.id, method: req.method, path: req.path, dryRun: dry, sandbox: getMetrcConfigStatus().isSandbox },
        dry ? "Metrc write-back preview" : "Metrc write-back executed (confirmed)",
      );
      await handler(req, res);
    } catch (err) {
      req.log.error({ err }, "Metrc write route failed");
      res.status(500).json({ error: "Metrc write request failed" });
    }
  };
}

// FG-3 (2026-07-06) — Supervisor+ variant of adminWriteRoute. Identical gates
// (METRC_WRITE_ENABLED + dryRun preview + confirm), but authorized for
// APPROVER_ROLES instead of Admin-only, so a packaging supervisor can push
// finished-goods packages. Decision 2026-07-06: cannabis ops often have no
// dedicated Quality/Admin, and the batch RELEASE step is already Supervisor+.
const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);
function approverWriteRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const actor = await getOrProvisionCurrentUser(req);
      if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
      if (!APPROVER_ROLES.has(actor.role)) {
        res.status(403).json({ error: `Supervisor, Manager, Quality, or Admin role required. Your role is "${actor.role}".` });
        return;
      }
      const dry = isDryRun(req);
      if (!dry && !metrcWriteEnabled()) {
        res.status(403).json({
          error: "Metrc write-back is disabled. Set METRC_WRITE_ENABLED=true to enable it. (Add ?dryRun=true to preview the payload without writing.)",
          writeEnabled: false,
        });
        return;
      }
      if (!dry && !isConfirmed(req)) {
        res.status(428).json({
          error: "Confirmation required for a real Metrc write. Preview it first with dryRun=true, then resend with confirm=true (query or body) to execute.",
          needsConfirmation: true,
        });
        return;
      }
      req.log.info(
        { actorId: actor.id, method: req.method, path: req.path, dryRun: dry, sandbox: getMetrcConfigStatus().isSandbox },
        dry ? "Metrc write-back preview" : "Metrc write-back executed (confirmed)",
      );
      await handler(req, res);
    } catch (err) {
      req.log.error({ err }, "Metrc write route failed");
      res.status(500).json({ error: "Metrc write request failed" });
    }
  };
}

// --- Finished-goods packages (FG-3) ------------------------------------------
//
// Create N sellable-unit packages from a batch's source package, then let the
// caller record the tags + advance the batch to Finished Goods. Supervisor+
// (approverWriteRoute) with the standard dry-run→confirm safeguards.

router.post(
  "/metrc/packages/create-finished-goods",
  approverWriteRoute(async (req, res) => {
    const input = req.body as CreateFinishedGoodsInput;
    if (!input?.sourcePackageLabel || !input?.item || !input?.unitOfMeasure || !input?.packagedDate
        || !Array.isArray(input?.packages) || input.packages.length === 0) {
      return badRequest(res, "Body must include sourcePackageLabel, item, unitOfMeasure, packagedDate, and a non-empty packages array.");
    }
    const badLine = input.packages.find((p) => !p?.tag || !(Number(p.quantity) > 0));
    if (badLine) return badRequest(res, "Every package needs a tag and a quantity greater than 0.");
    const tags = input.packages.map((p) => p.tag.trim().toUpperCase());
    if (new Set(tags).size !== tags.length) {
      return badRequest(res, "Duplicate package tags in the request — each sellable unit needs a unique tag.");
    }
    if (isDryRun(req)) return previewResponse(res, "POST", MetrcPaths.packagesCreate, buildCreatePackagesPayload(input));
    // Commit 3 — the packaging PUSH now goes through the state-tracking provider
    // (the "conduit"), matching the read side (GET /metrc/packages/active). Metrc
    // today, BioTrack later by config — no route or frontend change. The dry-run
    // preview above stays Metrc-payload-shaped on purpose (a provider-neutral
    // preview is deferred with the return-shape normalization, per trackingProvider.ts).
    const provider = await getTrackingProviderForFacility();
    renderMetrcWrite(res, await provider.createFinishedGoods(input, str(req.query["licenseNumber"])));
  }),
);

// Read-only: available (unused) package tags for the facility — validates scans
// in the FG-3 UI. Any signed-in user (no write gate).
router.get("/metrc/packages/available-tags", async (req, res) => {
  // Commit 3 — routed through the conduit too, so tag validation for the FG-3
  // packaging flow is provider-selected like the create + active-packages calls.
  const provider = await getTrackingProviderForFacility();
  renderMetrc(res, await provider.getAvailablePackageTags(str(req.query["licenseNumber"])));
});

// Read-only: active item catalog for the finished-goods Item picker. Same data
// as /metrc/items but NOT Admin-gated, so a packaging Supervisor can pick an
// Item (the Admin-only /metrc/items is unchanged).
router.get("/metrc/packages/items", async (req, res) => {
  renderMetrc(res, await getActiveItems(str(req.query["licenseNumber"])));
});

// Read-only: active storage locations for the create-package Location picker.
// Metrc requires a Location on package create; this lets a Supervisor pick a real
// facility room instead of typing one Metrc would reject. Not Admin-gated (same
// as the Item/available-tags reads that back the FG-3 packaging dialog).
router.get("/metrc/packages/locations", async (req, res) => {
  renderMetrc(res, await getActiveLocations(str(req.query["licenseNumber"])));
});

// --- Potency for a received package (2026-09-06) ----------------------------
//
// Michigan requires transferred cannabis to be tested, so an incoming package
// already carries lab results in Metrc. Receiving can pull them instead of
// typing them off the paper COA. Two hops: resolve the TAG to a package Id
// (lab results are keyed by Id, not label), then read the analyte rows.
//
// ⚠️ This route answers real HTTP status codes rather than going through
// renderMetrc, which returns 200 even when Metrc refused. The receiving screen
// ACTS on this answer (it writes the numbers onto the line), so a refusal that
// looked like success would silently record a blank potency as if it were
// confirmed by the state system. See the phantom-packages lesson.
//
// Test-type NAMES are state-specific, so match loosely and prefer a "total"
// row over a bare one (MI reports both "THC (%)" and "Total THC (%)"; the total
// is the label-bearing number). Unreleased results are ignored — Metrc only
// considers a result final once it is released to the license.
router.get("/metrc/packages/:label/potency", async (req, res) => {
  const label = pathParam(req.params["label"]);
  const licenseNumber = str(req.query["licenseNumber"]);

  const pkg = await getPackage(label, licenseNumber);
  if (!pkg.ok) {
    const status = pkg.status >= 400 && pkg.status <= 599 ? pkg.status : 502;
    res.status(status).json({ ok: false, error: `Metrc could not find package ${label}: ${pkg.error}` });
    return;
  }
  const packageId = (pkg.data as { Id?: number } | null)?.Id;
  if (packageId == null) {
    res.status(502).json({ ok: false, error: `Metrc returned no package Id for ${label}.` });
    return;
  }

  const results = await getLabResults(packageId, licenseNumber);
  if (!results.ok) {
    const status = results.status >= 400 && results.status <= 599 ? results.status : 502;
    res.status(status).json({ ok: false, error: `Metrc lab results unavailable for ${label}: ${results.error}` });
    return;
  }

  const rows = (results.data?.Data ?? []).filter((r) => r.ResultReleased);
  const pick = (want: "thc" | "cbd"): { value: number; testedAt: string | null; lab: string | null } | null => {
    const candidates = rows.filter((r) => {
      const n = (r.TestTypeName ?? "").toLowerCase();
      if (!n.includes("%")) return false;                       // percentage analytes only
      if (want === "thc") return n.includes("thc") && !n.includes("thca") && !n.includes("cbd");
      return n.includes("cbd") && !n.includes("cbda") && !n.includes("thc");
    });
    if (candidates.length === 0) return null;
    // Prefer the "total" row when Metrc reports both.
    const best = candidates.find((r) => (r.TestTypeName ?? "").toLowerCase().includes("total")) ?? candidates[0];
    if (best.TestResultLevel == null) return null;
    return { value: best.TestResultLevel, testedAt: best.TestPerformedDate, lab: best.LabFacilityName };
  };

  const thc = pick("thc");
  const cbd = pick("cbd");
  if (!thc && !cbd) {
    res.status(404).json({
      ok: false,
      error: `Metrc holds no released THC/CBD result for ${label}. Enter the values from the COA instead.`,
    });
    return;
  }

  res.json({
    ok: true,
    thcPct: thc?.value ?? null,
    cbdPct: cbd?.value ?? null,
    testedAt: (thc ?? cbd)?.testedAt ?? null,
    labName: (thc ?? cbd)?.lab ?? null,
  });
});

// GET a single package by label. MUST stay BELOW every literal "/metrc/packages/X"
// route above (active, available-tags, items, locations) — Express matches routes
// in order, so this greedy ":label" would otherwise capture those words as labels
// and 404 (it did: /packages/items → getPackage("items") → Metrc "Not Found").
router.get(
  "/metrc/packages/:label",
  adminRoute(async (req, res) => {
    renderMetrc(res, await getPackage(pathParam(req.params["label"]), str(req.query["licenseNumber"])));
  }),
);

// --- External incoming transfers (create / update / delete) ------------------

router.post(
  "/metrc/transfers/external-incoming",
  adminWriteRoute(async (req, res) => {
    const input = req.body as ExternalIncomingInput;
    if (!input?.shipperLicenseNumber || !input?.recipientLicenseNumber || !Array.isArray(input?.packages) || input.packages.length === 0) {
      return badRequest(res, "Body must include shipperLicenseNumber, recipientLicenseNumber, and a non-empty packages array.");
    }
    if (isDryRun(req)) return previewResponse(res, "POST", MetrcPaths.externalIncoming, buildExternalIncomingPayload(input));
    renderMetrc(res, await createExternalIncoming(input, str(req.query["licenseNumber"])));
  }),
);

router.put(
  "/metrc/transfers/external-incoming/:transferId",
  adminWriteRoute(async (req, res) => {
    const transferId = parseId(req.params["transferId"]);
    if (transferId === null) return badRequest(res, "transferId must be a positive integer.");
    const input = req.body as ExternalIncomingInput;
    if (!input?.shipperLicenseNumber || !input?.recipientLicenseNumber || !Array.isArray(input?.packages) || input.packages.length === 0) {
      return badRequest(res, "Body must include shipperLicenseNumber, recipientLicenseNumber, and a non-empty packages array.");
    }
    if (isDryRun(req)) {
      const body = buildExternalIncomingPayload(input).map((obj) => ({ [MetrcPutIdField.externalIncoming]: transferId, ...obj }));
      return previewResponse(res, "PUT", MetrcPaths.externalIncoming, body);
    }
    renderMetrc(res, await updateExternalIncoming(transferId, input, str(req.query["licenseNumber"])));
  }),
);

router.delete(
  "/metrc/transfers/external-incoming/:transferId",
  adminWriteRoute(async (req, res) => {
    const transferId = parseId(req.params["transferId"]);
    if (transferId === null) return badRequest(res, "transferId must be a positive integer.");
    if (isDryRun(req)) return previewResponse(res, "DELETE", MetrcPaths.externalIncomingById(transferId));
    renderMetrc(res, await deleteExternalIncoming(transferId, str(req.query["licenseNumber"])));
  }),
);

// ---------------------------------------------------------------------------
// Lab TEST SAMPLE package (2026-09-08) — R 420.304(2)(j)
// ---------------------------------------------------------------------------
//
// The lab takes the sample; Michigan makes the LICENSEE enter it in METRC. This
// creates the child package off our bulk, which is also what deducts the
// sampled amount there. The operator gives us the source tag, the amount, the
// unit, and the tag THE LAB put on the sample — the item and the room are
// read off the source package so there is nothing else to type on the floor.
// — The sample tag belongs to the LABORATORY. We never assign one.
//
// Same guards as every other METRC write: Supervisor+, METRC_WRITE_ENABLED, a
// dryRun preview, then confirm.
router.post(
  "/metrc/packages/create-testing-sample",
  approverWriteRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sourcePackageLabel = str(body["sourcePackageLabel"])?.trim().toUpperCase();
    const quantity = Number(body["quantity"]);
    if (!sourcePackageLabel) return badRequest(res, "sourcePackageLabel is required (the package the lab sampled from).");
    if (!Number.isFinite(quantity) || quantity <= 0) return badRequest(res, "quantity must be a number greater than zero.");

    const licenseNumber = str(req.query["licenseNumber"]);

    // Resolve the source package: its item is the sample's item, its room is a
    // sane default room, and its unit is the fallback unit.
    const active = await getTrackingProviderForFacility().then((p) => p.getActivePackages(licenseNumber));
    if (!active.ok) {
      res.status(502).json({ ok: false, step: "activePackages", error: active.error, metrcStatus: active.status });
      return;
    }
    const rows = (active.data as { Data?: Record<string, unknown>[] })?.Data ?? [];
    const src = rows.find((r) => String(r["Label"] ?? "").toUpperCase() === sourcePackageLabel);
    if (!src) {
      res.status(409).json({ ok: false, error: `Package ${sourcePackageLabel} is not an active package in this facility.` });
      return;
    }
    const itemName = str(body["item"]) ?? String((src["Item"] as { Name?: string } | undefined)?.Name ?? src["ItemName"] ?? "");
    if (!itemName) {
      res.status(409).json({ ok: false, error: "Could not read the item name off the source package. Pass item explicitly." });
      return;
    }
    const unitOfMeasure = str(body["unitOfMeasure"]) ?? String(src["UnitOfMeasureName"] ?? "Each");
    const location = str(body["location"]) ?? (src["LocationName"] ? String(src["LocationName"]) : null);

    // — THE TAG IS THE LAB'S (Jonathan, 2026-09-08). A laboratory collecting a
    // sample brings its own METRC tags and puts one on the sample it takes, so
    // this must NEVER reach for our next unused tag: doing that would burn one
    // of our tags and record a different number than the one physically on the
    // container the lab drove away with. The operator scans what the lab used.
    const tag = str(body["tag"])?.trim().toUpperCase() ?? "";
    if (!tag) {
      return badRequest(res, "Scan the tag the laboratory put on the sample. The lab supplies the sample tag; we do not assign one.");
    }

    // — A7 (2026-09-11): THE TESTING PANEL. Metrc refuses a sample with no lab
    // test batch ("At least one Lab Test Batch is required for Item X"), and a
    // wrong panel cannot be fixed afterwards — the sample is discontinued and
    // remade. The product type resolves it (lib/metrcLabTestBatches.ts); an
    // explicit labTestBatches wins when the caller knows better, e.g. a
    // solventless site or a retest. A refusal here means the product type is
    // not mapped — a configuration gap, not a question for the operator.
    const explicitPanels = Array.isArray(body["labTestBatches"])
      ? (body["labTestBatches"] as unknown[]).map((v) => String(v))
      : null;
    const panels = resolveLabTestBatches(str(body["productType"]), explicitPanels);
    if (!panels.ok) {
      res.status(409).json({ ok: false, error: panels.error });
      return;
    }

    const input: CreateTestingSampleInput = {
      sourcePackageLabel,
      tag,
      item: itemName,
      quantity,
      unitOfMeasure,
      location,
      actualDate: str(body["actualDate"]) ?? facilityDateStr(),
      note: str(body["note"]) ?? "Lab test sample — R 420.304(2)",
      requiredLabTestBatches: panels.batches,
    };

    if (isDryRun(req)) return previewResponse(res, "POST", MetrcPaths.packagesTesting, buildCreateTestingPayload(input));

    const out = await createTestingPackage(input, licenseNumber);
    if (!out.ok) {
      const status = out.status >= 400 && out.status <= 599 ? out.status : 502;
      res.status(status).json({ ok: false, metrcStatus: out.status, error: out.error, tag, sourcePackageLabel });
      return;
    }
    // The panel goes back to the caller so the operator SEES which one the
    // sample went in under — the CRA makes that choice irreversible, so it is
    // not something to leave implicit in a success toast.
    res.json({ ok: true, tag, item: itemName, quantity, unitOfMeasure, location, sourcePackageLabel, labTestBatches: panels.batches });
  }),
);

// --- Outgoing transfer templates (create / update) ---------------------------

router.post(
  "/metrc/templates/outgoing",
  adminWriteRoute(async (req, res) => {
    const input = req.body as TemplateOutgoingInput;
    if (!input?.name || !input?.recipientLicenseNumber || typeof input?.grossWeight !== "number" || !input?.grossUnitOfWeightName) {
      return badRequest(res, "Body must include name, recipientLicenseNumber, grossWeight (number), and grossUnitOfWeightName.");
    }
    if (isDryRun(req)) return previewResponse(res, "POST", MetrcPaths.templatesOutgoing, buildTemplateOutgoingPayload(input));
    renderMetrc(res, await createTemplateOutgoing(input, str(req.query["licenseNumber"])));
  }),
);

router.put(
  "/metrc/templates/outgoing/:templateId",
  adminWriteRoute(async (req, res) => {
    const templateId = parseId(req.params["templateId"]);
    if (templateId === null) return badRequest(res, "templateId must be a positive integer.");
    const input = req.body as TemplateOutgoingInput;
    if (!input?.name || !input?.recipientLicenseNumber || typeof input?.grossWeight !== "number" || !input?.grossUnitOfWeightName) {
      return badRequest(res, "Body must include name, recipientLicenseNumber, grossWeight (number), and grossUnitOfWeightName.");
    }
    if (isDryRun(req)) {
      const body = buildTemplateOutgoingPayload(input).map((obj) => ({ [MetrcPutIdField.template]: templateId, ...obj }));
      return previewResponse(res, "PUT", MetrcPaths.templatesOutgoing, body);
    }
    renderMetrc(res, await updateTemplateOutgoing(templateId, input, str(req.query["licenseNumber"])));
  }),
);

// ---------------------------------------------------------------------------
// Sandbox seeding probe (diagnostic, READ-ONLY) — Session 106, 2026-07-14
// ---------------------------------------------------------------------------
//
// Answers the ONE open question before we build the sandbox-seed routine: do our
// keys authorize Metrc's /sandbox/ helper endpoints, and via which auth header?
// The four /sandbox/ paths are confirmed present in Metrc's official API docs;
// what the docs do NOT expose is the auth. metrcClient's own note says these use
// an `x-metrc-key` header rather than the Basic vendor/user auth every other
// route uses — this proves or disproves that in one click.
//
// It performs a PURE READ: GET /sandbox/v2/tagtypes just LISTS available tag
// types. It creates nothing, mutates nothing, and is safe to hit repeatedly. It
// tries three auth variants in one call and reports each HTTP status, so the
// winning method (if any) is obvious. If all three fail with 401/403, that tells
// us the /sandbox/v2/integrator/setup step must run first to mint a key.
router.get(
  "/metrc/sandbox/probe",
  adminRoute(async (req, res) => {
    const cfg = getMetrcConfig();
    if (!cfg) {
      res.json({ ok: false, error: "Metrc not configured (missing vendor/user key).", config: getMetrcConfigStatus() });
      return;
    }
    const licenseNumber = str(req.query["licenseNumber"]) ?? cfg.licenseNumber ?? undefined;
    const url = new URL(cfg.baseUrl + "/sandbox/v2/tagtypes");
    if (licenseNumber) url.searchParams.set("licenseNumber", licenseNumber);

    async function attempt(label: string, headers: Record<string, string>): Promise<{ label: string; status: number; ok: boolean; body: string }> {
      try {
        const resp = await fetch(url, { method: "GET", headers: { Accept: "application/json", ...headers } });
        const body = (await resp.text()).slice(0, 500);
        return { label, status: resp.status, ok: resp.ok, body };
      } catch (err) {
        return { label, status: 0, ok: false, body: err instanceof Error ? err.message : String(err) };
      }
    }

    const basic = "Basic " + Buffer.from(`${cfg.vendorKey}:${cfg.userKey}`).toString("base64");
    const attempts = [
      await attempt("basic-auth (vendor:user)", { Authorization: basic }),
      await attempt("x-metrc-key: userKey", { "x-metrc-key": cfg.userKey }),
      await attempt("x-metrc-key: vendorKey", { "x-metrc-key": cfg.vendorKey }),
    ];
    res.json({
      ok: true,
      endpoint: "/sandbox/v2/tagtypes",
      licenseNumber: licenseNumber ?? null,
      attempts,
      hint: "A 200 on any row = that auth header is the one the /sandbox/ helpers accept. All 401/403 = run /sandbox/v2/integrator/setup first to mint the key.",
      config: getMetrcConfigStatus(),
    });
  }),
);

// ---------------------------------------------------------------------------
// Sandbox: generate package tags (Session 106, 2026-07-14) — SANDBOX-ONLY
// ---------------------------------------------------------------------------
// Step 3 of the sandbox seed. Uses the proven x-metrc-key: vendorKey auth.
// Metrc's public docs do not expose the request body, so this tries the likely
// body shapes in order and STOPS at the first success, reporting each attempt's
// raw Metrc response — so one deploy locks the correct format. Admin-gated;
// generates tags only in the SBX-MI sandbox (harmless there).
router.get(
  "/metrc/sandbox/gen-tags",
  adminRoute(async (req, res) => {
    const cfg = getMetrcConfig();
    if (!cfg) {
      res.json({ ok: false, error: "Metrc not configured (missing vendor/user key).", config: getMetrcConfigStatus() });
      return;
    }
    const licenseNumber = str(req.query["licenseNumber"]) ?? cfg.licenseNumber ?? undefined;
    const tagType = str(req.query["type"]) ?? "CannabisPackage";
    const count = Number(str(req.query["count"]) ?? "10") || 10;
    const url = new URL(cfg.baseUrl + "/sandbox/v2/facility/tags");
    if (licenseNumber) url.searchParams.set("licenseNumber", licenseNumber);
    const headers: Record<string, string> = {
      "x-metrc-key": cfg.vendorKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    type Attempt = { label: string; status: number; ok: boolean; body: string };
    async function tryBody(label: string, body: unknown): Promise<Attempt> {
      try {
        const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        return { label, status: resp.status, ok: resp.ok, body: (await resp.text()).slice(0, 8000) };
      } catch (err) {
        return { label, status: 0, ok: false, body: err instanceof Error ? err.message : String(err) };
      }
    }

    // Metrc model is TagTypeCountRequest (a JSON object) and requires field
    // "TagType" (confirmed 2026-07-14). Unknown: whether TagType wants the
    // TagInventoryType ("CannabisPackage"), the Name ("Cannabis Package"), or the
    // Id (1); and whether the count field is Count or Quantity. Try in order.
    const candidates: Array<[string, unknown]> = [
      ["{TagType, Count}", { TagType: tagType, Count: count }],
      ["{TagType=Name, Count}", { TagType: "Cannabis Package", Count: count }],
      ["{TagType=Id, Count}", { TagType: 1, Count: count }],
      ["{TagType, Quantity}", { TagType: tagType, Quantity: count }],
    ];
    const attempts: Attempt[] = [];
    for (const [label, body] of candidates) {
      const r = await tryBody(label, body);
      attempts.push(r);
      if (r.ok) break;
    }
    // Report the ACTUAL number of tags Metrc generated (parsed from the reply),
    // so the count is never inferred from a truncated label list again.
    const success = attempts.find((a) => a.ok);
    let generated: number | null = null;
    if (success) {
      try {
        const parsed = JSON.parse(success.body) as { Labels?: string[] };
        generated = Array.isArray(parsed.Labels) ? parsed.Labels.length : null;
      } catch {
        generated = null;
      }
    }
    res.json({
      ok: true,
      endpoint: "/sandbox/v2/facility/tags",
      tagType,
      requested: count,
      generated,
      licenseNumber: licenseNumber ?? null,
      attempts,
      hint: "A 2xx row = that body shape is correct (and that many tags were generated). A 4xx body usually names the missing/renamed field so we fix it in one more pass.",
      config: getMetrcConfigStatus(),
    });
  }),
);

// ---------------------------------------------------------------------------
// Sandbox: create an opening-balance package (Session 106, 2026-07-14) SANDBOX-ONLY
// ---------------------------------------------------------------------------
// Step 4 of the seed. One click: generates a fresh tag (proven format), lists
// the facility's item categories (so we know valid ones if an item must be
// created), then tries candidate opening-balance package bodies against
// /sandbox/v2/packages/create and reports Metrc's raw response. Admin-gated.
router.get(
  "/metrc/sandbox/create-pkg",
  adminRoute(async (req, res) => {
    const cfg = getMetrcConfig();
    if (!cfg) {
      res.json({ ok: false, error: "Metrc not configured (missing vendor/user key).", config: getMetrcConfigStatus() });
      return;
    }
    const licenseNumber = str(req.query["licenseNumber"]) ?? cfg.licenseNumber ?? undefined;
    const item = str(req.query["item"]) ?? "Sandbox Seed Flower";
    const qty = Number(str(req.query["qty"]) ?? "100") || 100;
    const uom = str(req.query["uom"]) ?? "Grams";
    const today = facilityDateStr();
    const vHeaders: Record<string, string> = {
      "x-metrc-key": cfg.vendorKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    // 1) Generate one fresh tag using the proven body.
    const tagUrl = new URL(cfg.baseUrl + "/sandbox/v2/facility/tags");
    if (licenseNumber) tagUrl.searchParams.set("licenseNumber", licenseNumber);
    let tag: string | null = null;
    let tagRaw = "";
    try {
      const tr = await fetch(tagUrl, { method: "POST", headers: vHeaders, body: JSON.stringify({ TagType: "Cannabis Package", Count: 1 }) });
      tagRaw = (await tr.text()).slice(0, 300);
      const parsed = JSON.parse(tagRaw) as { Labels?: string[] };
      tag = parsed.Labels?.[0] ?? null;
    } catch (err) {
      tagRaw = err instanceof Error ? err.message : String(err);
    }

    // 2) List item categories (Basic auth) — a valid one is needed to create an item.
    const cats = await metrcGet<Array<{ Name?: string }>>("/items/v2/categories", { query: { licenseNumber } });
    const itemCategories = cats.ok && Array.isArray(cats.data) ? cats.data.map((c) => c?.Name).filter((n): n is string => !!n) : [];

    // 3) Attempt opening-balance package create with candidate body shapes.
    const pkgUrl = new URL(cfg.baseUrl + "/sandbox/v2/packages/create");
    if (licenseNumber) pkgUrl.searchParams.set("licenseNumber", licenseNumber);
    type Attempt = { label: string; status: number; ok: boolean; body: string };
    async function tryBody(label: string, body: unknown): Promise<Attempt> {
      try {
        const r = await fetch(pkgUrl, { method: "POST", headers: vHeaders, body: JSON.stringify(body) });
        return { label, status: r.status, ok: r.ok, body: (await r.text()).slice(0, 500) };
      } catch (err) {
        return { label, status: 0, ok: false, body: err instanceof Error ? err.message : String(err) };
      }
    }

    const line = { Tag: tag, Item: item, Quantity: qty, UnitOfMeasure: uom, ActualDate: today };
    const attempts: Attempt[] = [];
    if (tag) {
      const a = await tryBody("obj {Tag,Item,Quantity,UnitOfMeasure,ActualDate}", line);
      attempts.push(a);
      if (!a.ok) attempts.push(await tryBody("array [line]", [line]));
    }

    res.json({
      ok: true,
      endpoint: "/sandbox/v2/packages/create",
      tagUsed: tag,
      tagRaw,
      item,
      itemCategories,
      note: "If create says the item doesn't exist, we create it first with POST /items/v2 using one of itemCategories, then re-run. A 2xx attempt = a real package now sits in the facility.",
      attempts,
      config: getMetrcConfigStatus(),
    });
  }),
);

/** Pull `Name` values out of any of Metrc's list envelope shapes. */
function houseNames(payload: unknown): string[] {
  const root = payload as { Data?: unknown } | unknown[] | null;
  const rows = Array.isArray(root)
    ? root
    : root && typeof root === "object" && Array.isArray((root as { Data?: unknown }).Data)
      ? ((root as { Data: unknown[] }).Data)
      : root && typeof root === "object"
        ? Object.values(root as Record<string, unknown>)
        : [];
  return rows
    .map((r) => (r && typeof r === "object" ? String((r as { Name?: unknown }).Name ?? "") : ""))
    .map((n) => n.trim())
    .filter(Boolean);
}

/**
 * Ensure the facility has at least one package Location.
 *
 * Metrc REQUIRES a Location on every package create ("Location was not
 * specified."), and a fresh MI sandbox facility has ZERO locations — so
 * packaging is impossible until one exists. A real customer creates their rooms
 * in Metrc's own UI; this route is the equivalent for a sandbox that starts
 * empty. Idempotent: if any active location already exists it creates nothing
 * and just reports what is there.
 */
router.get(
  "/metrc/locations/ensure",
  adminRoute(async (req, res) => {
    const licenseNumber = str(req.query["licenseNumber"]);
    const wanted = str(req.query["name"]) ?? "Main Storage";

    const existing = await getActiveLocations(licenseNumber);
    const existingNames = existing.ok ? houseNames(existing.data) : [];
    if (existingNames.length > 0) {
      res.json({ ok: true, created: false, locations: existingNames, note: "Facility already has locations; nothing created." });
      return;
    }

    const types = await getLocationTypes(licenseNumber);
    if (!types.ok) {
      res.status(502).json({ ok: false, step: "location-types", error: types.error, metrcStatus: types.status });
      return;
    }
    const typeNames = houseNames(types.data);
    const typeName = typeNames[0];
    if (!typeName) {
      res.status(502).json({ ok: false, step: "location-types", error: "Metrc returned no location types for this facility." });
      return;
    }

    const made = await createLocations([wanted], typeName, licenseNumber);
    if (!made.ok) {
      res.status(made.status >= 400 && made.status <= 599 ? made.status : 502)
        .json({ ok: false, step: "create", error: made.error, metrcStatus: made.status, locationTypeUsed: typeName });
      return;
    }

    const after = await getActiveLocations(licenseNumber);
    res.json({ ok: true, created: true, locationTypeUsed: typeName, locations: after.ok ? houseNames(after.data) : [wanted] });
  }),
);

/**
 * Ensure the facility catalogue contains an item a given product can be packaged
 * as. A Metrc package must name an item that already exists in the facility, so
 * a product with no matching item cannot be packaged at all — and a fresh MI
 * sandbox has none for finished formats like pre-rolls. A real customer creates
 * these in Metrc; this is the sandbox equivalent.
 *
 * Idempotent: if an item with this name already exists, nothing is created.
 * The category must be one Metrc allows for THIS facility, so it is matched
 * against the facility's own list rather than guessed.
 */

/**
 * ── SANDBOX ONLY ────────────────────────────────────────────────────────────
 * Morning re-seed. The Metrc SANDBOX wipes packages nightly, so a facility that
 * was fully set up yesterday wakes up with nothing to package from, and every
 * CannaQMS inventory lot points at a package Metrc no longer has. This puts the
 * sandbox back into a workable state in one call so the day does not start with
 * twenty minutes of manual setup.
 *
 * It does the three things that do not survive, in the order they depend on
 * each other, and reports each in plain language:
 *   1. a storage Location  (Metrc rejects every package create without one)
 *   2. the facility ITEMS a product can be packaged as (items usually survive
 *      the wipe, so this is normally a no-op — but it is cheap and it is the
 *      difference between "the Item dropdown is empty" and a working screen)
 *   3. opening-balance PACKAGES to draw from
 *
 * It deliberately does NOT touch inventory: finish by clicking "Sync from Metrc"
 * on the Inventory page, so the lot refresh stays a visible, deliberate act
 * rather than something that happened invisibly inside a setup call.
 *
 * Nothing here runs against production. A real facility's rooms, items and
 * opening inventory are created in Metrc by the licensee, and none of this is
 * reachable outside an Admin session.
 * ───────────────────────────────────────────────────────────────────────────
 */
// ---------------------------------------------------------------------------
// Sandbox: file passing lab results AS THE LAB (2026-09-08) — SANDBOX-ONLY
// ---------------------------------------------------------------------------
//
// Metrc refuses a transfer whose packages are still NotSubmitted for lab
// testing: "The destination Facility cannot receive Packages with the
// NotSubmitted Lab Testing State." Nothing in the sandbox ever files results,
// so every package we build is unshippable until we file them ourselves. The
// demo licence set shares one key pair, so we can call as the LAB facility.
//
// — Never a production path. In production the laboratory files its own
//   results against the test-sample package it holds; we only read them.
//
// GET /api/metrc/sandbox/lab-pass?labels=TAG1,TAG2
//   labLicense  the lab facility (default the MI sandbox lab)
//   thc         value filed for THC-ish analytes (default 78)
//   types       optional comma list to file ONLY those test-type names
//   doc         "false" to omit the stub CoA document
//   confirm     "true" to actually file; otherwise this previews the payload
router.get(
  "/metrc/sandbox/lab-pass",
  adminRoute(async (req, res) => {
    const labels = (str(req.query["labels"]) ?? "")
      .split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (labels.length === 0) {
      return badRequest(res, "Pass ?labels=TAG1,TAG2 — the package tags to file results against.");
    }
    const labLicense = str(req.query["labLicense"]) ?? "SF-SBX-MI-8-13501";
    const thc = Number(str(req.query["thc"]) ?? "78");
    const wantDoc = (str(req.query["doc"]) ?? "true").toLowerCase() !== "false";
    const only = new Set(
      (str(req.query["types"]) ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
    );

    // 1) The analyte catalog is state-specific — read it, never hard-code it.
    const typesResult = await getLabTestTypes(labLicense);
    if (!typesResult.ok) {
      res.status(502).json({
        ok: false, step: "getLabTestTypes", labLicense,
        metrcStatus: typesResult.status, error: typesResult.error,
        hint: "A 401 here means the key pair does not cover the lab facility.",
      });
      return;
    }
    const raw = typesResult.data as unknown;
    const list: MetrcLabTestType[] = Array.isArray(raw)
      ? (raw as MetrcLabTestType[])
      : ((raw as { Data?: MetrcLabTestType[] })?.Data ?? []);
    const chosen = list.filter((t) => only.size === 0 || only.has((t.Name ?? "").toLowerCase()));
    if (chosen.length === 0) {
      res.status(409).json({ ok: false, step: "types", labLicense, error: "No lab test types matched.", available: list.map((t) => t.Name) });
      return;
    }

    // 2) Everything passes. THC-ish analytes carry a plausible number so the
    //    label data has something to read; contaminant panels file as 0 + pass.
    const results: LabResultLine[] = chosen.map((t) => {
      const name = t.Name ?? "";
      const isPotency = /thc|cbd|cannabinoid|potency/i.test(name);
      return { labTestTypeName: name, quantity: isPotency ? thc : 0, passed: true, notes: "Sandbox result" };
    });

    const resultDate = str(req.query["resultDate"]) ?? facilityDateStr();
    const inputs = labels.map((label) => ({
      label,
      resultDate,
      results,
      documentFileName: wantDoc ? "sandbox-coa.txt" : null,
      documentFileBase64: wantDoc ? Buffer.from(`Sandbox CoA for ${label}`).toString("base64") : null,
    }));

    if (!isConfirmed(req)) {
      res.json({
        ok: true, dryRun: true, labLicense, labels, resultDate,
        typeCount: chosen.length, types: chosen.map((t) => t.Name),
        hint: "Resend with &confirm=true to file these results.",
      });
      return;
    }

    const out = await recordLabTests(inputs, labLicense);
    res.status(out.ok ? 200 : (out.status >= 400 && out.status <= 599 ? out.status : 502)).json({
      ok: out.ok, labLicense, labels, resultDate,
      typeCount: chosen.length,
      metrcStatus: out.status,
      error: out.ok ? undefined : out.error,
      hint: out.ok
        ? "Re-check the packages — their Lab Testing State should now be TestPassed."
        : "Metrc refused. If it says the package is not in this facility, the lab must hold a test SAMPLE package instead.",
    });
  }),
);

router.get(
  "/metrc/sandbox/morning-reset",
  adminRoute(async (req, res) => {
    const cfg = getMetrcConfig();
    if (!cfg) { res.status(400).json({ ok: false, error: "Metrc is not configured (missing vendor/user key)." }); return; }
    if (!getMetrcConfigStatus().isSandbox) {
      res.status(400).json({ ok: false, error: "Refusing to run: this is not a sandbox. Rooms, items and opening inventory belong to the licensee in production." });
      return;
    }
    const licenseNumber = str(req.query["licenseNumber"]) ?? cfg.licenseNumber ?? undefined;
    const steps: Array<{ step: string; done: string; detail?: string }> = [];

    // 1) Location ----------------------------------------------------------
    const roomName = str(req.query["room"]) ?? "Main Storage";
    const locs = await getActiveLocations(licenseNumber);
    // Resolve the names ONCE. Narrowing `locs` through a separate boolean does not
    // survive into the else-branch, and `locs.data` only exists on the ok variant.
    const existingRooms = locs.ok ? houseNames(locs.data) : [];
    if (existingRooms.length === 0) {
      const types = await getLocationTypes(licenseNumber);
      const typeName = types.ok ? houseNames(types.data)[0] : undefined;
      if (!typeName) {
        steps.push({ step: "Storage room", done: "FAILED", detail: "Metrc returned no location types for this facility." });
      } else {
        const made = await createLocations([roomName], typeName, licenseNumber);
        steps.push({ step: "Storage room", done: made.ok ? "created" : "FAILED", detail: made.ok ? roomName : made.error });
      }
    } else {
      steps.push({ step: "Storage room", done: "already there", detail: existingRooms.join(", ") });
    }

    // 2) Items -------------------------------------------------------------
    // Each entry is "Item name|category to match|unit|unit weight|weight unit".
    // Repeatable, so the set can be tuned from the URL as the product range changes.
    //
    // 2026-09-06 — the last two parts are new. Metrc requires a UNIT WEIGHT and its
    // unit of measure for some item categories and refuses the create without them:
    //   The Unit's Weight is required for Item Category "Vape Cart", but it is a
    //   negative number or was not specified.
    //   The Unit Weight Unit of Measure is required for Item Category "Vape Cart".
    // Which categories demand it is decided by Metrc per state, so rather than keep
    // a list here that would drift, both parts are simply optional and passed
    // through when given. Categories that don't want them are unaffected — the
    // short "name|category|unit" form still works exactly as before.
    //
    //   ...morning-reset?item=CannaQMS Vape Cart 1g|Vape|Each|1|Grams
    const rawItems = req.query["item"];
    const itemSpecs = (Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : []).map(String);
    if (itemSpecs.length > 0) {
      const existing = await getActiveItems(licenseNumber);
      const have = new Set((existing.ok ? houseNames(existing.data) : []).map((n) => n.toLowerCase()));
      const cats = await getItemCategories(licenseNumber);
      const catNames = cats.ok ? houseNames(cats.data) : [];
      for (const spec of itemSpecs) {
        const [nameRaw, catRaw, uomRaw, unitWeightRaw, weightUomRaw] = spec.split("|");
        const name = (nameRaw ?? "").trim();
        if (!name) continue;
        if (have.has(name.toLowerCase())) { steps.push({ step: `Item "${name}"`, done: "already there" }); continue; }
        const want = (catRaw ?? "").trim();
        const category = want
          ? (catNames.find((c) => c.toLowerCase() === want.toLowerCase()) ?? catNames.find((c) => c.toLowerCase().includes(want.toLowerCase())))
          : undefined;
        if (!category) {
          steps.push({ step: `Item "${name}"`, done: "FAILED", detail: `No category matches "${want}". This facility allows: ${catNames.join(", ") || "(none returned)"}` });
          continue;
        }
        // Unit weight is sent ONLY when a usable positive number was given. A blank
        // or unparseable value is left off entirely rather than defaulted to 0 —
        // Metrc rejects a zero/negative weight with the same message as a missing
        // one, and a silent 0 would be a wrong fact about the product besides.
        const unitWeight = Number((unitWeightRaw ?? "").trim());
        const hasUnitWeight = Number.isFinite(unitWeight) && unitWeight > 0;
        const weightUom = (weightUomRaw ?? "").trim();
        const payload: Record<string, unknown> = {
          Name: name,
          ItemCategory: category,
          UnitOfMeasure: (uomRaw ?? "Each").trim(),
          ...(hasUnitWeight ? { UnitWeight: unitWeight } : {}),
          ...(hasUnitWeight && weightUom ? { UnitWeightUnitOfMeasure: weightUom } : {}),
        };
        const made = await createItems([payload], licenseNumber);
        steps.push({
          step: `Item "${name}"`,
          done: made.ok ? "created" : "FAILED",
          detail: made.ok
            ? `category ${category}${hasUnitWeight ? `, ${unitWeight} ${weightUom || "(no weight unit given)"}` : ""}`
            : made.error,
        });
      }
    }

    // 3) Opening-balance packages -----------------------------------------
    const pkgCount = Math.max(1, Math.min(20, Number(str(req.query["packages"]) ?? "10") || 10));
    const vHeaders = { "x-metrc-key": cfg.vendorKey, Accept: "application/json", "Content-Type": "application/json" };
    const pkgUrl = new URL(cfg.baseUrl + "/sandbox/v2/packages/create");
    if (licenseNumber) pkgUrl.searchParams.set("licenseNumber", licenseNumber);
    const before = await metrcGet<{ TotalRecords?: number }>(MetrcPaths.packagesActive, { query: { licenseNumber } });
    const hadPackages = before.ok ? Number(before.data?.TotalRecords ?? 0) : 0;
    if (hadPackages > 0) {
      steps.push({ step: "Source packages", done: "already there", detail: `${hadPackages} active package(s) — not reseeding.` });
    } else {
      try {
        const r = await fetch(pkgUrl, { method: "POST", headers: vHeaders, body: JSON.stringify({ Count: pkgCount }) });
        const body = (await r.text()).slice(0, 400);
        steps.push({ step: "Source packages", done: r.ok ? "created" : "FAILED", detail: body });
      } catch (err) {
        steps.push({ step: "Source packages", done: "FAILED", detail: err instanceof Error ? err.message : String(err) });
      }
    }

    const after = await metrcGet<{ TotalRecords?: number }>(MetrcPaths.packagesActive, { query: { licenseNumber } });
    res.json({
      ok: steps.every((s) => s.done !== "FAILED"),
      steps,
      activePackagesNow: after.ok ? Number(after.data?.TotalRecords ?? 0) : null,
      nextStep: "Open Inventory and click \"Sync from Metrc\" to refresh the lots against these packages.",
    });
  }),
);

export default router;
