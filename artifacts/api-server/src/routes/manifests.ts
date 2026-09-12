import { Router } from "express";
import { db } from "@workspace/db";
import {
  batchManifestsTable,
  batchManifestPackagesTable,
  transferRecipientsTable,
  transporterPresetsTable,
  batchRecordsTable,
  batchMetrcTagsTable,
  batchTestingTable,
  auditLogTable,
} from "@workspace/db";
import { and, eq, sql, asc, desc } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";
import { logger } from "../lib/logger";
import { getTrackingProviderForFacility } from "../lib/trackingProvider";
import { buildTemplateOutgoingPayload, getOutgoingTransfers, getManifestPdf, type TemplateOutgoingInput } from "../lib/metrcTransfers";
import { getMetrcConfigStatus } from "../lib/metrcClient";
import { MetrcPaths } from "../lib/metrcEndpoints";
import { labSampleQuarantineBlock } from "../lib/labSampleQuarantine";
import { getPackage as metrcGetPackage } from "../lib/metrcCatalog";

// ---------------------------------------------------------------------------
// Outbound manifest — Phases 1 + 2. Phase 1: recipient directory + transporter
// presets, the batch manifest draft, and the pre-flight compliance gate
// (CannaQMS system of record). Phase 2: the guarded Metrc template push below
// (dry-run → confirm, Part 11 sign-off, METRC_WRITE_ENABLED switch).
// ---------------------------------------------------------------------------

const router = Router();

// Config/approver acts (managing the directory + presets, finalizing). Mirrors
// the local set in routes/batches.ts (not exported there).
const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);
// A batch in one of these states cannot ship.
const BLOCKED_BATCH_STATES = new Set(["on_hold", "failed", "destroyed"]);

const strOrNull = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};
// numeric columns round-trip as strings in drizzle.
const numStrOrNull = (v: unknown): string | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : null;
};
const toDateOrNull = (v: unknown): Date | null => {
  if (v == null || v === "") return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
};
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function audit(opts: {
  tableName?: string; rowId: number; operation: string;
  changedById?: number | null; changedByName?: string | null;
  beforeState?: Record<string, unknown> | null; afterState?: Record<string, unknown> | null;
}) {
  try {
    await db.insert(auditLogTable).values({
      tableName: opts.tableName ?? "batch_manifests",
      rowId: opts.rowId,
      operation: opts.operation,
      changedBy: opts.changedById ?? null,
      changedByName: opts.changedByName ?? null,
      beforeState: opts.beforeState ?? null,
      afterState: opts.afterState ?? null,
    });
  } catch (err) {
    logger.error({ err, operation: opts.operation, rowId: opts.rowId }, "manifest audit insert failed");
  }
}

// ---- Recipient directory ---------------------------------------------------

router.get("/manifest-recipients", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const includeInactive = String(req.query["includeInactive"] ?? "") === "true";
    const rows = await db.select().from(transferRecipientsTable)
      .where(includeInactive ? undefined : eq(transferRecipientsTable.active, true))
      .orderBy(asc(transferRecipientsTable.name));
    res.json(rows);
  } catch (err) {
    logger.error({ err }, "Failed to list recipients");
    res.status(500).json({ error: `Failed to list recipients: ${msg(err)}` });
  }
});

router.post("/manifest-recipients", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Managing the recipient directory requires Supervisor, Manager, Quality, or Admin. Your role is "${actor.role}".` }); return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = strOrNull(b.name);
    const licenseNumber = strOrNull(b.licenseNumber);
    if (!name || !licenseNumber) { res.status(400).json({ error: "name and licenseNumber are required." }); return; }
    const [row] = await db.insert(transferRecipientsTable).values({
      name, licenseNumber,
      licenseType: strOrNull(b.licenseType) ?? "Retailer",
      address1: strOrNull(b.address1),
      addressCity: strOrNull(b.addressCity),
      addressState: strOrNull(b.addressState),
      addressPostalCode: strOrNull(b.addressPostalCode),
      mainPhone: strOrNull(b.mainPhone),
      notes: strOrNull(b.notes),
    }).returning();
    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to create recipient");
    res.status(500).json({ error: `Failed to create recipient: ${msg(err)}` });
  }
});

router.put("/manifest-recipients/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Managing the recipient directory requires an approver role." }); return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    // Required fields update only when a non-empty value is supplied.
    if ("name" in b) { const v = strOrNull(b.name); if (v) patch.name = v; }
    if ("licenseNumber" in b) { const v = strOrNull(b.licenseNumber); if (v) patch.licenseNumber = v; }
    for (const k of ["licenseType", "address1", "addressCity", "addressState", "addressPostalCode", "mainPhone", "notes"] as const) {
      if (k in b) patch[k] = strOrNull(b[k]);
    }
    if ("active" in b) patch.active = !!b.active;
    const [row] = await db.update(transferRecipientsTable).set(patch).where(eq(transferRecipientsTable.id, id)).returning();
    if (!row) { res.status(404).json({ error: "Recipient not found." }); return; }
    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to update recipient");
    res.status(500).json({ error: `Failed to update recipient: ${msg(err)}` });
  }
});

// ---- Transporter presets ---------------------------------------------------

router.get("/transporter-presets", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const includeInactive = String(req.query["includeInactive"] ?? "") === "true";
    const rows = await db.select().from(transporterPresetsTable)
      .where(includeInactive ? undefined : eq(transporterPresetsTable.active, true))
      .orderBy(asc(transporterPresetsTable.label));
    res.json(rows);
  } catch (err) {
    logger.error({ err }, "Failed to list transporter presets");
    res.status(500).json({ error: `Failed to list transporter presets: ${msg(err)}` });
  }
});

router.post("/transporter-presets", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Managing transporter presets requires Supervisor, Manager, Quality, or Admin. Your role is "${actor.role}".` }); return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const label = strOrNull(b.label);
    const transporterFacilityLicenseNumber = strOrNull(b.transporterFacilityLicenseNumber);
    if (!label || !transporterFacilityLicenseNumber) {
      res.status(400).json({ error: "label and transporterFacilityLicenseNumber are required." }); return;
    }
    const [row] = await db.insert(transporterPresetsTable).values({
      label, transporterFacilityLicenseNumber,
      driverName: strOrNull(b.driverName),
      driverOccupationalLicenseNumber: strOrNull(b.driverOccupationalLicenseNumber),
      driverLicenseNumber: strOrNull(b.driverLicenseNumber),
      phoneNumberForQuestions: strOrNull(b.phoneNumberForQuestions),
      vehicleMake: strOrNull(b.vehicleMake),
      vehicleModel: strOrNull(b.vehicleModel),
      vehicleLicensePlateNumber: strOrNull(b.vehicleLicensePlateNumber),
    }).returning();
    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to create transporter preset");
    res.status(500).json({ error: `Failed to create transporter preset: ${msg(err)}` });
  }
});

router.put("/transporter-presets/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Managing transporter presets requires an approver role." }); return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if ("label" in b) { const v = strOrNull(b.label); if (v) patch.label = v; }
    if ("transporterFacilityLicenseNumber" in b) { const v = strOrNull(b.transporterFacilityLicenseNumber); if (v) patch.transporterFacilityLicenseNumber = v; }
    for (const k of ["driverName", "driverOccupationalLicenseNumber", "driverLicenseNumber", "phoneNumberForQuestions", "vehicleMake", "vehicleModel", "vehicleLicensePlateNumber"] as const) {
      if (k in b) patch[k] = strOrNull(b[k]);
    }
    if ("active" in b) patch.active = !!b.active;
    const [row] = await db.update(transporterPresetsTable).set(patch).where(eq(transporterPresetsTable.id, id)).returning();
    if (!row) { res.status(404).json({ error: "Transporter preset not found." }); return; }
    res.json(row);
  } catch (err) {
    logger.error({ err }, "Failed to update transporter preset");
    res.status(500).json({ error: `Failed to update transporter preset: ${msg(err)}` });
  }
});

// ---- Batch manifest (draft record) -----------------------------------------

async function loadManifest(batchId: number) {
  const [manifest] = await db.select().from(batchManifestsTable)
    .where(eq(batchManifestsTable.batchId, batchId))
    .orderBy(desc(batchManifestsTable.id)).limit(1);
  if (!manifest) return { manifest: null, packages: [] as unknown[] };
  const packages = await db.select().from(batchManifestPackagesTable)
    .where(eq(batchManifestPackagesTable.manifestId, manifest.id))
    .orderBy(asc(batchManifestPackagesTable.id));
  return { manifest, packages };
}

router.get("/batch-records/:id/manifest", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    res.json(await loadManifest(id));
  } catch (err) {
    logger.error({ err }, "Failed to load manifest");
    res.status(500).json({ error: `Failed to load manifest: ${msg(err)}` });
  }
});

type PackageInput = {
  packageLabel?: string; itemName?: string; quantity?: unknown; uom?: string;
  grossWeight?: unknown; grossUnitOfWeightName?: string; wholesalePrice?: unknown; sourceTagRunId?: unknown;
};

// Create or update the batch's draft manifest header + replace its line items.
// Only allowed while the manifest is still draft / preflight_passed (never after push).
router.post("/batch-records/:id/manifest", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }

    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!batch) { res.status(404).json({ error: "Batch not found." }); return; }

    const b = (req.body ?? {}) as Record<string, unknown>;
    const header = {
      transferTypeName: strOrNull(b.transferTypeName),
      recipientId: b.recipientId != null && String(b.recipientId) !== "" ? parseInt(String(b.recipientId)) : null,
      recipientLicenseNumber: strOrNull(b.recipientLicenseNumber),
      recipientName: strOrNull(b.recipientName),
      plannedRoute: strOrNull(b.plannedRoute),
      estimatedDepartureDateTime: toDateOrNull(b.estimatedDepartureDateTime),
      estimatedArrivalDateTime: toDateOrNull(b.estimatedArrivalDateTime),
      transporterFacilityLicenseNumber: strOrNull(b.transporterFacilityLicenseNumber),
      driverName: strOrNull(b.driverName),
      driverOccupationalLicenseNumber: strOrNull(b.driverOccupationalLicenseNumber),
      driverLicenseNumber: strOrNull(b.driverLicenseNumber),
      vehicleMake: strOrNull(b.vehicleMake),
      vehicleModel: strOrNull(b.vehicleModel),
      vehicleLicensePlateNumber: strOrNull(b.vehicleLicensePlateNumber),
      phoneNumberForQuestions: strOrNull(b.phoneNumberForQuestions),
      grossWeight: numStrOrNull(b.grossWeight),
      grossUnitOfWeightName: strOrNull(b.grossUnitOfWeightName),
      updatedAt: new Date(),
    };
    const pkgs = Array.isArray(b.packages) ? (b.packages as PackageInput[]) : [];

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(batchManifestsTable)
        .where(eq(batchManifestsTable.batchId, id)).orderBy(desc(batchManifestsTable.id)).limit(1);
      if (existing && (existing.status === "pushed" || existing.status === "accepted")) {
        throw new Error("This manifest has already been pushed to Metrc and can no longer be edited.");
      }
      let manifestId: number;
      if (existing) {
        // Editing resets a prior preflight pass back to draft (content changed).
        await tx.update(batchManifestsTable).set({ ...header, status: "draft" }).where(eq(batchManifestsTable.id, existing.id));
        manifestId = existing.id;
      } else {
        const [created] = await tx.insert(batchManifestsTable).values({
          batchId: id, status: "draft", ...header,
          createdByUserId: actor.id, createdByName: actor.fullName,
        }).returning();
        if (!created) throw new Error("Failed to create manifest row.");
        manifestId = created.id;
      }
      // Replace line items.
      await tx.delete(batchManifestPackagesTable).where(eq(batchManifestPackagesTable.manifestId, manifestId));
      if (pkgs.length > 0) {
        await tx.insert(batchManifestPackagesTable).values(pkgs
          .filter((p) => strOrNull(p.packageLabel))
          .map((p) => ({
            manifestId,
            packageLabel: String(p.packageLabel).trim(),
            itemName: strOrNull(p.itemName),
            quantity: numStrOrNull(p.quantity),
            uom: strOrNull(p.uom),
            grossWeight: numStrOrNull(p.grossWeight),
            grossUnitOfWeightName: strOrNull(p.grossUnitOfWeightName),
            wholesalePrice: numStrOrNull(p.wholesalePrice),
            sourceTagRunId: p.sourceTagRunId != null && String(p.sourceTagRunId) !== "" ? parseInt(String(p.sourceTagRunId)) : null,
          })));
      }
      return manifestId;
    });

    void audit({ rowId: id, operation: "MANIFEST_SAVE_DRAFT", changedById: actor.id, changedByName: actor.fullName, afterState: { manifestId: result, packageCount: pkgs.length } });
    res.json(await loadManifest(id));
  } catch (err) {
    logger.error({ err }, "Failed to save manifest");
    res.status(500).json({ error: `Failed to save manifest: ${msg(err)}` });
  }
});

// Pre-flight compliance gate. Pure reads; sets status to preflight_passed when
// every check passes so the Phase-2 push can require it. Returns per-check +
// per-package detail so the UI can show exactly what's blocking.
router.post("/batch-records/:id/manifest/preflight", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }

    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!batch) { res.status(404).json({ error: "Batch not found." }); return; }
    const { manifest, packages } = await loadManifest(id);
    if (!manifest) { res.status(409).json({ error: "No manifest to pre-flight. Save the manifest draft first." }); return; }

    // Labeled, non-cancelled tag runs for this batch (JIT commit 2).
    const labeledRuns = await db.select().from(batchMetrcTagsTable).where(and(
      eq(batchMetrcTagsTable.batchId, id),
      eq(batchMetrcTagsTable.labelStatus, "labeled"),
      sql`${batchMetrcTagsTable.cancelledAt} IS NULL`,
    ));
    const labeledRunIds = new Set(labeledRuns.map((r) => r.id));
    const labeledTags = new Set<string>();
    for (const r of labeledRuns) {
      if (r.metrcTag) labeledTags.add(r.metrcTag.trim().toUpperCase());
      if (r.rangeStart) labeledTags.add(r.rangeStart.trim().toUpperCase());
    }

    // Passing safety test on record (R 420.305).
    const passedTest = await db.select().from(batchTestingTable)
      .where(and(eq(batchTestingTable.batchId, id), eq(batchTestingTable.testResult, "Pass"))).limit(1);

    const pkgs = packages as { id: number; packageLabel: string; sourceTagRunId: number | null }[];

    // ---------------------------------------------------------------------------
    // METRC package state — must be TestPassed before a transfer can be pushed.
    // Check each tagged package individually so the UI can show exactly which
    // package is stuck (NotSubmitted, SubmittedForTesting, etc.) rather than a
    // generic "METRC rejected the push" message only visible after the full
    // form-fill. If METRC is unreachable, the check fails with a clear message
    // rather than silently passing and letting the push bounce later.
    // ---------------------------------------------------------------------------
    const metrcStateMap = new Map<string, string | null>(); // label (UPPER) → LabTestingState
    let metrcStateCheckError: string | null = null;
    const taggedLabels = pkgs.map((p) => String(p.packageLabel ?? "").trim()).filter(Boolean);
    if (taggedLabels.length > 0) {
      try {
        const settled = await Promise.allSettled(
          taggedLabels.map(async (label) => {
            const r = await metrcGetPackage(label);
            const state = r.ok
              ? (typeof (r.data as Record<string, unknown>)?.LabTestingState === "string"
                  ? String((r.data as Record<string, unknown>).LabTestingState)
                  : null)
              : null;
            return {
              label: label.toUpperCase(),
              state,
              ok: r.ok,
              error: r.ok ? undefined : (r.error ?? "METRC read failed"),
            };
          }),
        );
        for (const s of settled) {
          if (s.status === "fulfilled") {
            metrcStateMap.set(s.value.label, s.value.error ? `ERROR: ${s.value.error}` : s.value.state);
          } else {
            // One promise threw — surface the reason and mark the whole check failed.
            metrcStateCheckError = String((s as PromiseRejectedResult).reason);
          }
        }
      } catch (err) {
        metrcStateCheckError = msg(err);
      }
    }

    const pkgResults = pkgs.map((p) => {
      const labeled = (p.sourceTagRunId != null && labeledRunIds.has(p.sourceTagRunId))
        || labeledTags.has(String(p.packageLabel ?? "").trim().toUpperCase());
      const metrcState = metrcStateMap.get(String(p.packageLabel ?? "").trim().toUpperCase()) ?? null;
      return { packageLabel: p.packageLabel, hasTag: !!strOrNull(p.packageLabel), labeled, metrcState };
    });

    const taggedPkgResults = pkgResults.filter((p) => p.hasTag);
    // METRC_REQUIRE_TEST_STATE=true enforces this as a hard gate (production).
    // Default (unset / false): informational — shows the METRC state but never
    // blocks pre-flight, so sandbox and demo environments can walk the full
    // shipping flow without a licensed lab having filed results in METRC.
    const requireMetrcTestState =
      (process.env["METRC_REQUIRE_TEST_STATE"] ?? "").trim().toLowerCase() === "true";
    const metrcTestActuallyPassed =
      !metrcStateCheckError &&
      taggedPkgResults.length > 0 &&
      taggedPkgResults.every((p) => p.metrcState === "TestPassed");
    const metrcTestPassed = requireMetrcTestState ? metrcTestActuallyPassed : true;
    const metrcTestDetail = metrcStateCheckError
      ? `METRC unreachable — ${metrcStateCheckError}`
      : requireMetrcTestState
        ? taggedPkgResults.map((p) => `${p.packageLabel}: ${p.metrcState ?? "not found in METRC"}`).join("; ")
        : taggedPkgResults.map((p) => `${p.packageLabel}: ${p.metrcState ?? "not found in METRC"} (informational — set METRC_REQUIRE_TEST_STATE=true to enforce)`).join("; ");

    const checks = [
      { key: "has_packages", label: "At least one package on the manifest", pass: pkgs.length > 0, detail: `${pkgs.length} package(s)` },
      { key: "batch_not_held", label: "Batch not on hold / failed / destroyed (R 420.502)", pass: !BLOCKED_BATCH_STATES.has(batch.status), detail: `status: ${batch.status}` },
      { key: "tested_passed", label: "Passing safety tests on record (R 420.305)", pass: passedTest.length > 0 },
      // METRC state gate — surfaces before push so the user knows to contact the lab, not after
      // a METRC rejection that reveals nothing useful. State must be TestPassed; NotSubmitted or
      // SubmittedForTesting means the licensed lab has not yet filed results in METRC.
      { key: "metrc_test_state", label: "All packages passed lab testing in METRC (LabTestingState = TestPassed)", pass: metrcTestPassed, detail: metrcTestDetail },
      { key: "all_labeled", label: "Every package is labeled (R 420.504)", pass: pkgResults.length > 0 && pkgResults.every((p) => p.labeled) },
      { key: "all_have_tags", label: "Every package has a Metrc tag", pass: pkgResults.length > 0 && pkgResults.every((p) => p.hasTag) },
      { key: "recipient", label: "Recipient license present", pass: !!strOrNull(manifest.recipientLicenseNumber) },
      { key: "transfer_type", label: "Transfer type selected", pass: !!strOrNull(manifest.transferTypeName) },
      { key: "gross_weight", label: "Destination gross weight entered", pass: !!strOrNull(manifest.grossWeight) },
    ];
    const allPass = checks.every((c) => c.pass);

    // Reflect the result on the manifest so the Phase-2 push can require it.
    const nextStatus = allPass ? "preflight_passed" : "draft";
    if (manifest.status !== "pushed" && manifest.status !== "accepted" && manifest.status !== nextStatus) {
      await db.update(batchManifestsTable).set({ status: nextStatus, updatedAt: new Date() }).where(eq(batchManifestsTable.id, manifest.id));
    }
    void audit({ rowId: id, operation: "MANIFEST_PREFLIGHT", changedById: actor.id, changedByName: actor.fullName, afterState: { allPass, failed: checks.filter((c) => !c.pass).map((c) => c.key) } });

    res.json({ allPass, checks, packages: pkgResults, status: nextStatus });
  } catch (err) {
    logger.error({ err }, "Failed to pre-flight manifest");
    res.status(500).json({ error: `Failed to pre-flight manifest: ${msg(err)}` });
  }
});

// ---------------------------------------------------------------------------
// Phase 2 — the guarded Metrc push. Files the manifest as a Metrc OUTGOING
// TRANSFER TEMPLATE (Metrc v2 has no direct outgoing-transfer create; the
// template is the API-side manifest — a licensed user confirms it into the live
// manifest in the Metrc UI, which Phase 3 will watch for). Gates, in order:
//   1. A signed-in user of ANY role (2026-09-08: shipping is an operator task).
//   2. Manifest status must be preflight_passed (the R 420.3xx/50x gate).
//   3. dryRun=true previews the exact Metrc payload with NO write and no
//      further gates — safe even with the write switch off.
//   4. A real write requires METRC_WRITE_ENABLED=true (env switch, off by
//      default) AND confirm=true AND a Part 11 sign-off (initials + meaning).
// Metrc-side outcomes use the house diagnostic-200 shape ({ ok:false, kind,
// error }); a non-2xx from US means our own gate refused, nothing was sent.
// ---------------------------------------------------------------------------

function metrcWriteEnabled(): boolean {
  return (process.env["METRC_WRITE_ENABLED"] ?? "").trim().toLowerCase() === "true";
}

router.post("/batch-records/:id/manifest/push", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    // 2026-09-08 (Jonathan) — "An operator should be able to push the
    // manifest to metrc." Shipping is an operator task, so the role gate is gone;
    // authentication, METRC_WRITE_ENABLED and the preview/confirm handshake still
    // apply, and the push is still audit-logged with the actor.

    const [batch] = await db.select().from(batchRecordsTable).where(eq(batchRecordsTable.id, id));
    if (!batch) { res.status(404).json({ error: "Batch not found." }); return; }
    // R 420.304(2)(k) — quarantined product may not be transferred.
    {
      const blocked = await labSampleQuarantineBlock(id, "shipped");
      if (blocked) { res.status(409).json({ error: blocked }); return; }
    }
    const { manifest, packages } = await loadManifest(id);
    if (!manifest) { res.status(409).json({ error: "No manifest on this batch. Save a draft and run pre-flight first." }); return; }
    if (manifest.status === "pushed" || manifest.status === "accepted") {
      res.status(409).json({ error: "This manifest has already been pushed to Metrc.", metrcTemplateId: manifest.metrcTemplateId }); return;
    }
    if (manifest.status !== "preflight_passed") {
      res.status(409).json({ error: "Pre-flight has not passed for the current draft. Run pre-flight (and resolve any blocks) before pushing." }); return;
    }

    // Belt-and-braces: preflight guarantees these, but never build a bad payload.
    const recipientLicense = strOrNull(manifest.recipientLicenseNumber);
    const transferType = strOrNull(manifest.transferTypeName);
    const grossWeight = manifest.grossWeight != null ? Number(manifest.grossWeight) : NaN;
    if (!recipientLicense || !transferType || !Number.isFinite(grossWeight)) {
      res.status(409).json({ error: "Manifest is missing recipient license, transfer type, or gross weight. Re-run pre-flight." }); return;
    }

    const pkgs = packages as { packageLabel: string; wholesalePrice: string | null }[];
    const transporterLicense = strOrNull(manifest.transporterFacilityLicenseNumber);
    const input: TemplateOutgoingInput = {
      // The template's display name in Metrc — traceable back to this batch + manifest row.
      name: `CQMS ${batch.batchNumber ?? id} M${manifest.id}`,
      recipientLicenseNumber: recipientLicense,
      transferTypeName: transferType,
      plannedRoute: strOrNull(manifest.plannedRoute) ?? undefined,
      estimatedDepartureDateTime: manifest.estimatedDepartureDateTime?.toISOString(),
      estimatedArrivalDateTime: manifest.estimatedArrivalDateTime?.toISOString(),
      grossWeight,
      grossUnitOfWeightName: strOrNull(manifest.grossUnitOfWeightName) ?? "Grams",
      transporters: transporterLicense ? [{
        transporterFacilityLicenseNumber: transporterLicense,
        driverName: strOrNull(manifest.driverName) ?? undefined,
        driverOccupationalLicenseNumber: strOrNull(manifest.driverOccupationalLicenseNumber) ?? undefined,
        driverLicenseNumber: strOrNull(manifest.driverLicenseNumber) ?? undefined,
        phoneNumberForQuestions: strOrNull(manifest.phoneNumberForQuestions) ?? undefined,
        vehicleMake: strOrNull(manifest.vehicleMake) ?? undefined,
        vehicleModel: strOrNull(manifest.vehicleModel) ?? undefined,
        vehicleLicensePlateNumber: strOrNull(manifest.vehicleLicensePlateNumber) ?? undefined,
      }] : [],
      packages: pkgs.map((p) => ({
        packageLabel: p.packageLabel,
        wholesalePrice: p.wholesalePrice != null ? Number(p.wholesalePrice) : null,
      })),
    };

    const b = (req.body ?? {}) as Record<string, unknown>;
    const dry = b.dryRun === true || String(req.query["dryRun"] ?? "") === "true";

    if (dry) {
      // Preview only — no Metrc call, no status change, allowed with role alone.
      res.json({
        ok: true, dryRun: true,
        wouldSend: { method: "POST", path: MetrcPaths.templatesOutgoing, body: buildTemplateOutgoingPayload(input) },
        writeEnabled: metrcWriteEnabled(),
        config: getMetrcConfigStatus(),
      });
      return;
    }

    if (!metrcWriteEnabled()) {
      res.status(403).json({
        error: "Metrc write-back is disabled. Set METRC_WRITE_ENABLED=true to enable it. (Use dryRun=true to preview the payload without writing.)",
        writeEnabled: false,
      });
      return;
    }
    if (b.confirm !== true && String(req.query["confirm"] ?? "") !== "true") {
      res.status(428).json({ error: "Confirmation required. Preview with dryRun=true first, then resend with confirm=true.", needsConfirmation: true });
      return;
    }
    const initials = strOrNull(b.initials);
    const signingMeaning = strOrNull(b.signingMeaning);
    if (!initials || !signingMeaning) {
      res.status(400).json({ error: "Initials and signing meaning are required to push a manifest (21 CFR Part 11)." });
      return;
    }

    logger.info({ actorId: actor.id, batchId: id, manifestId: manifest.id, sandbox: getMetrcConfigStatus().isSandbox }, "Manifest push executing (confirmed)");
    // Through the state-tracking provider (the "conduit") — Metrc today,
    // BioTrack later by config, no route or UI change.
    const provider = await getTrackingProviderForFacility();
    const result = await provider.createOutgoingTemplate(input);

    if (!result.ok) {
      // Metrc refused — status stays preflight_passed so the user can fix + retry.
      void audit({ rowId: id, operation: "MANIFEST_PUSH_FAILED", changedById: actor.id, changedByName: actor.fullName, afterState: { manifestId: manifest.id, metrcStatus: result.status, error: result.error } });
      res.json({ ok: false, metrcStatus: result.status, kind: result.kind, error: result.error, config: getMetrcConfigStatus() });
      return;
    }

    const ids = result.data?.Ids;
    const templateId = Array.isArray(ids) && ids.length > 0 ? ids[0] : null;
    const now = new Date();
    await db.update(batchManifestsTable).set({
      status: "pushed",
      metrcTemplateId: templateId,
      pushedAt: now,
      signedByUserId: actor.id,
      signedByName: actor.fullName,
      signedInitials: initials,
      signedMeaning: signingMeaning,
      signedAt: now,
      updatedAt: now,
    }).where(eq(batchManifestsTable.id, manifest.id));

    void audit({ rowId: id, operation: "MANIFEST_PUSH", changedById: actor.id, changedByName: actor.fullName, afterState: { manifestId: manifest.id, metrcTemplateId: templateId, templateName: input.name, packageCount: input.packages?.length ?? 0 } });
    res.json({ ok: true, metrcStatus: result.status, metrcTemplateId: templateId, templateName: input.name, ...(await loadManifest(id)) });
  } catch (err) {
    logger.error({ err }, "Failed to push manifest to Metrc");
    res.status(500).json({ error: `Failed to push manifest to Metrc: ${msg(err)}` });
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — capture the live Metrc manifest number after the user registers the
// pushed template as a live transfer in the Metrc UI (Metrc exposes no API to
// finalize a template). POST { manifestNumber } records the user-confirmed
// number; POST with no number returns recent OUTGOING transfers as candidates
// (best match by recipient + package count flagged `suggested`).
// ---------------------------------------------------------------------------
router.post("/batch-records/:id/manifest/capture", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    // 2026-09-08 — same ruling as the push above: the operator who ships is the
    // one who reads the manifest number back off Metrc, so no role gate here either.
    const { manifest, packages } = await loadManifest(id);
    if (!manifest) { res.status(409).json({ error: "No manifest on this batch." }); return; }
    if (manifest.status !== "pushed" && manifest.status !== "manifested" && manifest.status !== "accepted") {
      res.status(409).json({ error: "Push the manifest template to Metrc before capturing its manifest number." }); return;
    }

    const chosen = strOrNull((req.body ?? {}).manifestNumber);
    if (chosen) {
      const now = new Date();
      await db.update(batchManifestsTable).set({ metrcManifestNumber: chosen, status: "manifested", updatedAt: now }).where(eq(batchManifestsTable.id, manifest.id));
      void audit({ rowId: id, operation: "MANIFEST_CAPTURED", changedById: actor.id, changedByName: actor.fullName, afterState: { manifestId: manifest.id, metrcManifestNumber: chosen } });
      res.json({ ok: true, ...(await loadManifest(id)) });
      return;
    }

    const result = await getOutgoingTransfers();
    if (!result.ok) { res.json({ ok: false, candidates: [], metrcStatus: result.status, error: result.error }); return; }
    const rows = (result.data?.Data ?? []) as unknown as Array<Record<string, unknown>>;
    const recipLic = strOrNull(manifest.recipientLicenseNumber);
    const pkgCount = (packages as unknown[]).length;
    const candidates = rows.map((t) => {
      const recip = (t["RecipientFacilityLicenseNumber"] ?? null) as string | null;
      const count = Number(t["PackageCount"] ?? 0);
      const suggested = !!recipLic && recip === recipLic && (pkgCount === 0 || count === pkgCount);
      return {
        manifestNumber: String(t["ManifestNumber"] ?? ""),
        recipientLicenseNumber: recip,
        recipientName: (t["RecipientFacilityName"] ?? null) as string | null,
        packageCount: count,
        estimatedDeparture: (t["EstimatedDepartureDateTime"] ?? null) as string | null,
        suggested,
      };
    }).filter((c) => c.manifestNumber);
    candidates.sort((a, b) => Number(b.suggested) - Number(a.suggested));
    res.json({ ok: true, candidates });
  } catch (err) {
    logger.error({ err }, "Failed to capture manifest number");
    res.status(500).json({ error: `Failed to capture manifest number: ${msg(err)}` });
  }
});

// Stream the OFFICIAL Metrc manifest PDF for this batch's manifest, once a
// ManifestNumber has been captured. GET so it opens in a new tab / prints.
router.get("/batch-records/:id/manifest/pdf", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Authentication required." }); return; }
    const { manifest } = await loadManifest(id);
    if (!manifest) { res.status(404).json({ error: "No manifest on this batch." }); return; }
    const number = strOrNull(manifest.metrcManifestNumber);
    if (!number) { res.status(409).json({ error: "No Metrc manifest number captured yet. Register the transfer in Metrc, then capture its number." }); return; }
    const pdf = await getManifestPdf(number);
    if (!pdf.ok) { res.status(502).json({ error: `Metrc did not return the manifest PDF: ${pdf.error}`, metrcStatus: pdf.status }); return; }
    res.setHeader("Content-Type", pdf.contentType);
    res.setHeader("Content-Disposition", `inline; filename="metrc-manifest-${number}.pdf"`);
    res.send(pdf.data);
  } catch (err) {
    logger.error({ err }, "Failed to fetch manifest PDF");
    res.status(500).json({ error: `Failed to fetch manifest PDF: ${msg(err)}` });
  }
});

export default router;
