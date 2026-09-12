import { Router, type Request, type Response } from "express";
import multer from "multer";
import mammoth from "mammoth";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db } from "@workspace/db";
import { documentsTable, documentRevisionsTable, auditLogTable, usersTable, documentSectionsTable, SECTION_KINDS, recipesTable, recipeProcessStepsTable, documentFavoritesTable, trainingRecordsTable } from "@workspace/db";
import { and, asc, desc, eq, inArray, isNull, like, ne, sql } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { autoAssignFromPriorRevision } from "./training";
import { lockDocumentPrimaryAttachments } from "./attachments";
import { supersedePriorRevisions, recordEffectiveRevision } from "../lib/documentRevisions";
import { getActingFacilityId } from "../middlewares/facilityContext";
import { facilityPrefix, companyPrefix, nextForPrefix, numbersInUseEverywhere } from "../lib/recordNumber";
import { liveChangeRequestsFor, markerFor } from "./document_change_requests";
import { suggestAssociatedDocumentLinks, LINK_MATCH_AI_MODEL } from "../lib/aiClient";
import { facilityDateStr } from "../lib/facilityDate";

const router = Router();

// Statuses that make a document a valid link target / candidate (exclude retired ones).
const LINKABLE_STATUSES = new Set(["Draft", "Under Review", "Approved", "Effective"]);
// Free-text section that the importer drops unmatched associated-doc references into.
const IMPORTED_LINKS_TITLE_PREFIX = "Associated Documents";
// Management roles that oversee ALL document impacts (owners see only their own).
const MGMT_ROLES = new Set(["Manager", "Quality", "Admin"]);

const TYPE_PREFIXES: Record<string, string> = {
  SOP: "SOP",
  "Work Instruction": "WI",
  Form: "FORM",
  Policy: "POL",
  Manual: "MAN",
  Specification: "SPEC",
  Protocol: "PROT",
  Report: "RPT",
  Other: "DOC",
};

const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);
// Administrative record movement (2026-08-27). Quality and Admin only — narrower
// than APPROVER_ROLES: a Supervisor may approve, but may not undo an approval.
const ADMIN_MOVE_ROLES = new Set(["Quality", "Admin"]);

// A rejected declared effective date, distinguishable from "not supplied".
const INVALID_DATE = Symbol("invalid-date");

/**
 * Validate a declared effective date off the request body. Returns the date, or
 * undefined when none was supplied, or INVALID_DATE having already answered the
 * request. A date in the past is refused: a document cannot come into force
 * before the signature that put it there.
 */
function normalizePlannedEffectiveDate(
  value: unknown,
  res: Response,
): string | undefined | typeof INVALID_DATE {
  if (value === undefined || value === null || value === "") return undefined;
  const str = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    res.status(400).json({ error: "The effective date must be a calendar date (YYYY-MM-DD)." });
    return INVALID_DATE;
  }
  if (str < facilityDateStr()) {
    res.status(400).json({ error: "The effective date cannot be in the past — a document cannot come into force before it was signed." });
    return INVALID_DATE;
  }
  return str;
}

// Fields that PATCH /documents/:id may modify. Lifecycle/signature/role-assignment
// fields are intentionally excluded — they may only change via dedicated workflow
// endpoints that capture Part 11 e-signatures.
const PATCH_ALLOWED_FIELDS = new Set([
  "title",
  "description",
  "scope",
  "department",
  "departments",
  "ownerName",
  "documentType",
  "summaryOfChanges",
  "reviewIntervalYears",
  // Starter library: the readable on-screen body (markdown). Editable while the
  // document is pre-Approved (PATCH already blocks Approved/Obsolete/cancelled).
  "bodyMarkdown",
  // Session 60 — hybrid bridge: the recipe that backs this document (nullable).
  // Editable while the doc is pre-Approved (PATCH already blocks Approved/Obsolete).
  "recipeId",
  // 2026-07-31 — retraining method for a Major change. Editable while the doc is in
  // Draft (PATCH already blocks Approved/Under Review is allowed? no — see below).
  "retrainingMethod",
]);

// Retraining method is only meaningful for a Major change. The author may change it
// while the document is still in Draft; once it leaves Draft the method locks.
const RETRAIN_METHODS = new Set(["Read & Understand", "Instructor-Led"]);

type Actor = { id: number; fullName: string; role: string; initials: string | null };

// Server-authoritative identity. Returns the DB user matched to the current
// Clerk session, or null + sends 401/404 if not authenticated/known.
async function getActor(req: Request, res: Parameters<Router["get"]>[1] extends never ? never : Parameters<typeof router.get>[1] extends (req: Request, res: infer R, ...rest: unknown[]) => unknown ? R : never): Promise<Actor | null> {
  const { userId: clerkUserId } = getAuth(req);
  if (!clerkUserId) {
    res.status(401).json({ error: "Authentication required for this action." });
    return null;
  }
  const [user] = await db
    .select({ id: usersTable.id, fullName: usersTable.fullName, role: usersTable.role, initials: usersTable.initials })
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, clerkUserId));
  if (!user) {
    res.status(403).json({ error: "Your account is not linked to a CannaQMS user. Visit /users/me to provision." });
    return null;
  }
  return user;
}

// Session 55.1 — next doc number from MAX of the parsed sequence of existing
// doc_number values for this prefix+year, NOT count(*). count(*) was both
// string-concatenating (node-postgres returns it as a string, so 1 -> "11")
// and collision-prone once the data held an out-of-order high number or after
// a delete. MAX+1 is year-scoped per prefix, monotonic, never reuses a number
// (Part 11). The unique constraint on doc_number is the backstop.
// A CORPORATE document keeps its plain number — SOP-26-0014 — because there is only
// one of it and every site works to that one. A document belonging to ONE plant
// carries that plant's code — WI-BA-26-0001 — which both says where it came from and
// is what stops two plants computing the same number while each sees only its own.
async function generateDocNumber(docType: string, facilityId: number | null): Promise<string> {
  const base = TYPE_PREFIXES[docType] ?? "DOC";
  const fullPrefix = facilityId ? facilityPrefix(base) : companyPrefix(base);
  // Checked across every site, not just this one. A document number is unique in the
  // whole database, so a number that looks free here can still be taken elsewhere —
  // which is exactly what happened at Bay City, where Detroit's WI-26-0001 was
  // invisible and got claimed a second time.
  const used = await numbersInUseEverywhere("documents", "doc_number", fullPrefix);
  return nextForPrefix(fullPrefix, used);
}

function addYears(d: Date, years: number): Date {
  const r = new Date(d);
  r.setFullYear(r.getFullYear() + years);
  return r;
}

async function logAudit(
  rowId: number,
  operation: string,
  actor: Actor | { id?: number; fullName: string },
  before: unknown,
  after: unknown,
) {
  await db.insert(auditLogTable).values({
    tableName: "documents",
    rowId,
    operation,
    changedBy: "id" in actor && typeof actor.id === "number" ? actor.id : undefined,
    changedByName: actor.fullName,
    beforeState: before as never,
    afterState: after as never,
  });
}

// 21 CFR Part 11 identity check — the signed initials must match the signer's account
// initials. Sends a 400 and returns false on mismatch; callers MUST `return` when false.
// Every document e-signature point (review sign, approve, obsolete, cancel, uncancel)
// enforces this so a signature is always attributable to the individual.
function initialsMatch(actor: Actor, initials: unknown, res: Response): boolean {
  if ((actor.initials ?? "").toUpperCase() !== String(initials ?? "").trim().toUpperCase()) {
    res.status(400).json({
      error: `Initials must match your account initials ("${actor.initials ?? ""}"). This is a 21 CFR Part 11 identity check.`,
    });
    return false;
  }
  return true;
}

router.get("/documents", async (req, res) => {
  try {
    const rows = await db.select().from(documentsTable).orderBy(desc(documentsTable.updatedAt));
    const { status, type } = req.query;
    let filtered = rows;
    // Session 52.1 — exclude cancelled by default; ?cancelled=true returns only
    // cancelled documents (the Cancelled view). Cancel is the no-hard-delete pattern.
    const cancelled = req.query.cancelled === "true";
    filtered = cancelled ? filtered.filter((r) => r.cancelledAt) : filtered.filter((r) => !r.cancelledAt);
    if (status) filtered = filtered.filter((r) => r.status === status);
    if (type) filtered = filtered.filter((r) => r.documentType === type);

    // Per-user favorites (star). Annotate each row with isFavorite for the
    // current user so the client can show a filled star and pin them to the top.
    // Best-effort: an unauthenticated / unprovisioned caller just sees no stars.
    let favIds = new Set<number>();
    const { userId: clerkUserId } = getAuth(req);
    if (clerkUserId) {
      const favs = await db
        .select({ documentId: documentFavoritesTable.documentId })
        .from(documentFavoritesTable)
        .where(eq(documentFavoritesTable.clerkUserId, clerkUserId));
      favIds = new Set(favs.map((row) => row.documentId));
    }
    // Phase 3 (2026-08-28): the change-request MARKER, derived rather than stored.
    // A document with a request against it keeps its real status — Effective stays
    // Effective — and shows the marker beside it, so a supervisor about to print and
    // laminate a controlled copy can see a change is already coming.
    const live = await liveChangeRequestsFor(filtered.map((r) => r.id));
    res.json(
      filtered.map((r) => ({
        ...r,
        isFavorite: favIds.has(r.id),
        changeRequestMarker: markerFor(live.get(r.id)?.status),
      })),
    );
  } catch (err) {
    req.log.error({ err }, "Failed to list documents");
    res.status(500).json({ error: "Failed to list documents" });
  }
});

// ── Per-user document favorites (star to pin to the top of the list) ──────────
// Idempotent: starring an already-starred doc is a no-op, un-starring one that
// isn't starred is a no-op. Keyed on the Clerk user id so stars are private.
router.post("/documents/:id/favorite", async (req, res) => {
  try {
    const { userId: clerkUserId } = getAuth(req);
    if (!clerkUserId) { res.status(401).json({ error: "Authentication required." }); return; }
    const documentId = parseInt(req.params.id);
    if (Number.isNaN(documentId)) { res.status(400).json({ error: "Invalid document id." }); return; }
    await db.insert(documentFavoritesTable).values({ clerkUserId, documentId }).onConflictDoNothing();
    res.json({ ok: true, isFavorite: true });
  } catch (err) {
    req.log.error({ err }, "Failed to favorite document");
    res.status(500).json({ error: "Failed to favorite document" });
  }
});

router.delete("/documents/:id/favorite", async (req, res) => {
  try {
    const { userId: clerkUserId } = getAuth(req);
    if (!clerkUserId) { res.status(401).json({ error: "Authentication required." }); return; }
    const documentId = parseInt(req.params.id);
    if (Number.isNaN(documentId)) { res.status(400).json({ error: "Invalid document id." }); return; }
    await db.delete(documentFavoritesTable).where(
      and(eq(documentFavoritesTable.clerkUserId, clerkUserId), eq(documentFavoritesTable.documentId, documentId)),
    );
    res.json({ ok: true, isFavorite: false });
  } catch (err) {
    req.log.error({ err }, "Failed to unfavorite document");
    res.status(500).json({ error: "Failed to unfavorite document" });
  }
});

// ── Corporate document or facility document? (multi-facility Phase 3, 2026-08-28)
//
// His ruling, 08-27: "Corporate documents go to each state." An SOP is written once
// for the company and every site works to the same one. A Work Instruction is how
// ONE plant does the job, and two plants doing the same job differently is normal.
//
// In the data that difference is simply whether the document carries a facility:
// no facility means corporate, and the database lets every site see it (which is
// exactly why documents were left out of the rule that makes a facility compulsory).
//
// The author chooses on the New Document form. This is only the PRE-PICK for when
// they do not, and it is deliberately biased towards corporate: a document everyone
// can see is a smaller problem than one a plant cannot find.
const FACILITY_LOCAL_DOC_TYPES = new Set(["Work Instruction", "Report"]);

function resolveDocumentFacility(documentType: unknown, appliesTo: unknown): number | null {
  const acting = getActingFacilityId();
  if (appliesTo === "corporate") return null;
  if (appliesTo === "facility") return acting;
  return FACILITY_LOCAL_DOC_TYPES.has(String(documentType ?? "")) ? acting : null;
}

router.post("/documents", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    // The facility has to be decided BEFORE the number, because it is what decides
    // whether the number carries a site code.
    const plannedFacilityId = resolveDocumentFacility(req.body?.documentType, req.body?.appliesTo);
    const docNumber = await generateDocNumber(req.body.documentType ?? "Other", plannedFacilityId);
    // Force createdByName to actor; ignore client-supplied workflow/signature fields
    const { status: _s, assignedReviewerId: _ari, assignedApproverId: _aai,
      reviewerSignedAt: _rs, approverSignedAt: _as, approvedByName: _ab,
      approvalDate: _ad, effectiveDate: _ed, nextReviewDate: _nrd,
      // appliesTo is the author's choice on the form, not a column: it decides
      // whether this document carries a facility or none. facilityId is never taken
      // from the client — a person cannot file a document into another site.
      appliesTo, facilityId: _fid,
      ...safe } = req.body ?? {};
    const facilityId = plannedFacilityId;
    // Keep the legacy single `department` in sync with the first of `departments`.
    const deptSync = Array.isArray(safe.departments) && safe.departments.length
      ? { department: String(safe.departments[0]) }
      : {};
    const [doc] = await db
      .insert(documentsTable)
      .values({ ...safe, ...deptSync, docNumber, facilityId, status: "Draft", createdByName: actor.fullName, createdByUserId: actor.id })
      .returning();

    await db.insert(documentRevisionsTable).values({
      documentId: doc.id,
      revision: doc.revision,
      status: doc.status,
      summaryOfChanges: "Initial draft",
      authorName: doc.createdByName,
      createdAt: new Date(),
    });

    await logAudit(doc.id, "CREATE", actor, null, { docNumber: doc.docNumber, title: doc.title });
    res.status(201).json(doc);
  } catch (err) {
    req.log.error({ err }, "Failed to create document");
    res.status(500).json({ error: "Failed to create document" });
  }
});

// ---- AI-assisted import ------------------------------------------------------
// Upload a Word/PDF SOP that follows the controlled-document template; the AI
// extracts each template section, and we create a pre-filled DRAFT the author
// reviews/edits before routing for approval. PDFs are read natively by the model;
// Word (.docx) is converted to text with mammoth first.
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === "application/pdf" ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      /\.(pdf|docx)$/i.test(file.originalname);
    if (ok) cb(null, true);
    else cb(new Error("Only PDF or Word (.docx) files are supported."));
  },
});

const IMPORT_DOC_TYPES = ["SOP", "Policy", "Manual", "Work Instruction", "Form", "Protocol", "Specification", "Report", "Other"];

const SOP_IMPORT_PROMPT = `You are extracting a controlled Standard Operating Procedure from a document for a cannabis Quality Management System. The document follows a template with headed sections (e.g. PURPOSE, SCOPE, DEFINITIONS, ASSOCIATED DOCUMENTS, MATERIALS NEEDED / EQUIPMENT, SAFETY, PROCEDURE).

Return ONE valid JSON object and NOTHING else (no markdown fences), with this exact shape:
{
  "title": string | null,
  "documentType": ${JSON.stringify(IMPORT_DOC_TYPES)} value | null,
  "ownerName": string | null,
  "purpose": string | null,
  "scope": string | null,
  "definitions": string | null,
  "safety": string | null,
  "procedure": string | null,
  "materials": [ { "name": string, "note": string | null } ],
  "associatedDocuments": [ { "reference": string } ],
  "confidence": "high" | "medium" | "low",
  "extractionNotes": string
}

Rules:
- Return ONLY the JSON object.
- "title" is the procedure's title, NOT its document number.
- Copy each section's wording faithfully — DO NOT summarize, rewrite, or invent content.
- Use null for any section not present. Treat a section whose only content is "N/A" as null (or [] for lists).
- For "procedure", keep the numbered/bulleted steps and line breaks as plain text.
- "materials" and "associatedDocuments" must be [] when none are present.`;

router.post("/documents/import", importUpload.single("file"), async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!req.file) { res.status(400).json({ error: "No file uploaded." }); return; }

    const { mimetype, buffer, originalname } = req.file;
    const isPdf = mimetype === "application/pdf" || /\.pdf$/i.test(originalname);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any[] = [];
    if (isPdf) {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") },
      });
    } else {
      const { value: text } = await mammoth.extractRawText({ buffer });
      if (!text?.trim()) { res.status(422).json({ error: "Could not read any text from that Word file." }); return; }
      content.push({ type: "text", text: `Document contents:\n\n${text}` });
    }
    content.push({ type: "text", text: SOP_IMPORT_PROMPT });

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{ role: "user", content }],
    });
    const block = message.content[0];
    if (!block || block.type !== "text") { res.status(502).json({ error: "Unexpected response from the AI." }); return; }

    let x: {
      title?: string | null; documentType?: string | null; ownerName?: string | null;
      purpose?: string | null; scope?: string | null; definitions?: string | null;
      safety?: string | null; procedure?: string | null;
      materials?: { name: string; note?: string | null }[];
      associatedDocuments?: { reference: string }[];
      confidence?: string; extractionNotes?: string;
    };
    try {
      const raw = block.text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "");
      x = JSON.parse(raw);
    } catch {
      req.log.error({ rawText: block.text }, "SOP import: failed to parse AI JSON");
      res.status(422).json({ error: "The AI could not extract structured sections from that file." });
      return;
    }

    const documentType = IMPORT_DOC_TYPES.includes(String(x.documentType)) ? String(x.documentType) : "SOP";
    const title = (x.title ?? "").trim() || originalname.replace(/\.(pdf|docx)$/i, "");
    // The imported document's site decides whether its number carries a site code, the
    // same as one typed in by hand. An imported Work Instruction belongs to the plant
    // importing it; an imported SOP is the company's.
    const importFacilityId = resolveDocumentFacility(documentType, req.body?.appliesTo);
    const docNumber = await generateDocNumber(documentType, importFacilityId);

    // Optional metadata the user set in the import dialog (override the AI extraction).
    const userOwner = String(req.body?.ownerName ?? "").trim();
    const userInterval = parseInt(String(req.body?.reviewIntervalYears ?? ""), 10);
    let userDepartments: string[] = [];
    try {
      const raw = req.body?.departments;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) userDepartments = parsed.map((d) => String(d)).filter(Boolean);
    } catch { /* ignore malformed departments */ }

    const [doc] = await db
      .insert(documentsTable)
      .values({
        docNumber,
        title,
        documentType,
        // The same site the number was built from — otherwise an imported work
        // instruction would be numbered WI-BA-… while quietly filed as the company's.
        facilityId: importFacilityId,
        status: "Draft",
        ownerName: userOwner || (x.ownerName ?? "").trim() || null,
        reviewIntervalYears: Number.isInteger(userInterval) && userInterval > 0 ? userInterval : 3,
        departments: userDepartments.length ? userDepartments : null,
        department: userDepartments.length ? userDepartments[0] : null,
        description: (x.purpose ?? "").trim() || null,
        scope: (x.scope ?? "").trim() || null,
        createdByName: actor.fullName,
        createdByUserId: actor.id,
      })
      .returning();

    await db.insert(documentRevisionsTable).values({
      documentId: doc.id,
      revision: doc.revision,
      status: doc.status,
      summaryOfChanges: `Imported from ${originalname}`,
      authorName: doc.createdByName,
      createdAt: new Date(),
    });

    // Create template sections that came back with content, in template order.
    const specs: { kind: string; title: string; order: number; bodyMarkdown?: string | null; data?: unknown }[] = [];
    if ((x.definitions ?? "").trim()) specs.push({ kind: "definitions", title: "Definitions", order: 0, bodyMarkdown: x.definitions!.trim() });
    if (Array.isArray(x.associatedDocuments) && x.associatedDocuments.length) {
      // References arrive as text (the referenced docs may not exist in-system yet),
      // so store them as a free-text section; the author can convert to real links.
      const refs = x.associatedDocuments.map((d) => `- ${d.reference}`).join("\n");
      specs.push({ kind: "free_text", title: "Associated Documents (imported — link manually)", order: 1, bodyMarkdown: refs });
    }
    if (Array.isArray(x.materials) && x.materials.length) {
      const items = x.materials.map((m) => ({ name: String(m.name ?? "").trim(), note: (m.note ?? undefined) || undefined })).filter((m) => m.name);
      if (items.length) specs.push({ kind: "materials_equipment", title: "Materials / Equipment", order: 2, data: { items } });
    }
    if ((x.safety ?? "").trim()) specs.push({ kind: "safety", title: "Safety", order: 3, bodyMarkdown: x.safety!.trim() });
    if ((x.procedure ?? "").trim()) specs.push({ kind: "procedure", title: "Procedure", order: 4, bodyMarkdown: x.procedure!.trim() });

    for (const s of specs) {
      await db.insert(documentSectionsTable).values({
        documentId: doc.id,
        sortOrder: s.order * 10,
        kind: s.kind,
        title: s.title,
        bodyMarkdown: s.bodyMarkdown ?? null,
        data: (s.data ?? null) as never,
      });
    }

    await logAudit(doc.id, "IMPORT", actor, null, {
      docNumber: doc.docNumber, title: doc.title, source: originalname, confidence: x.confidence ?? null,
    });
    res.status(201).json({
      id: doc.id,
      docNumber: doc.docNumber,
      confidence: x.confidence ?? null,
      extractionNotes: x.extractionNotes ?? null,
      sections: specs.length,
    });
  } catch (err) {
    req.log.error({ err }, "SOP import failed");
    res.status(500).json({ error: "Failed to import the document." });
  }
});

router.get("/documents/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const revisions = await db
      .select()
      .from(documentRevisionsTable)
      .where(eq(documentRevisionsTable.documentId, id))
      .orderBy(desc(documentRevisionsTable.createdAt));
    const live = (await liveChangeRequestsFor([id])).get(id) ?? null;
    res.json({ ...doc, revisions, changeRequest: live, changeRequestMarker: markerFor(live?.status) });
  } catch (err) {
    req.log.error({ err }, "Failed to get document");
    res.status(500).json({ error: "Failed to get document" });
  }
});

// PATCH is restricted to safe metadata only. Lifecycle transitions and signatures
// require the dedicated workflow endpoints below so Part 11 controls cannot be bypassed.
router.patch("/documents/:id", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);

    const [existing] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Document not found" }); return; }
    // Session 52.1.1 — a cancelled document is read-only (Re-open via /uncancel first).
    if (existing.cancelledAt) {
      res.status(409).json({ error: "This document is cancelled and read-only. Re-open it first (Admin)." }); return;
    }
    if (existing.status === "Obsolete" || existing.status === "Superseded") {
      res.status(400).json({ error: "This revision is read-only and cannot be edited." });
      return;
    }
    if (existing.status === "Approved" || existing.status === "Effective") {
      res.status(400).json({ error: `${existing.status} documents cannot be edited. Start a new revision first.` });
      return;
    }

    // Session 52.1 — the cancelled_* fields are managed only by /cancel +
    // /uncancel; never by a field edit. Strip them before the allowlist check
    // so a client echoing the full doc doesn't trip the rejected-fields 400.
    const {
      cancelledAt: _ca, cancelledReason: _cr, cancelledByName: _cbn,
      cancelledByInitials: _cbi, cancelledMeaning: _cm,
      ...patchBody
    } = (req.body ?? {}) as Record<string, unknown>;

    const filtered: Record<string, unknown> = {};
    const rejected: string[] = [];
    for (const [k, v] of Object.entries(patchBody)) {
      if (k === "appliesTo") continue; // handled below; it maps to facilityId, not a column
      if (PATCH_ALLOWED_FIELDS.has(k)) filtered[k] = v;
      else rejected.push(k);
    }
    if (rejected.length > 0) {
      res.status(400).json({
        error: `These fields cannot be updated via PATCH (use the workflow endpoints): ${rejected.join(", ")}`,
      });
      return;
    }
    // Whether the document is corporate or belongs to this site. Changeable only
    // while it is still a Draft — once people have reviewed and trained against it,
    // moving it between the company and a plant is a different document, not an edit.
    if ("appliesTo" in patchBody) {
      if (existing.status !== "Draft") {
        res.status(400).json({ error: "Corporate or facility can only be changed while the document is in Draft." });
        return;
      }
      const choice = patchBody.appliesTo;
      if (choice !== "corporate" && choice !== "facility") {
        res.status(400).json({ error: 'appliesTo must be "corporate" or "facility".' });
        return;
      }
      filtered.facilityId = choice === "corporate" ? null : getActingFacilityId();
    }

    // Retraining method: only changeable while in Draft, and only to a known value.
    if ("retrainingMethod" in filtered) {
      if (existing.status !== "Draft") {
        res.status(400).json({ error: "The retraining method can only be changed while the document is in Draft." });
        return;
      }
      const m = filtered.retrainingMethod;
      if (m !== null && !RETRAIN_METHODS.has(String(m))) {
        res.status(400).json({ error: 'retrainingMethod must be "Read & Understand" or "Instructor-Led".' });
        return;
      }
    }
    // Keep the legacy single `department` in sync with the first of `departments`.
    if (Array.isArray(filtered.departments)) {
      filtered.department = filtered.departments.length ? String(filtered.departments[0]) : null;
    }
    filtered.updatedAt = new Date();

    const [doc] = await db.update(documentsTable).set(filtered).where(eq(documentsTable.id, id)).returning();
    await logAudit(id, "UPDATE", actor, existing, doc);
    res.json(doc);
  } catch (err) {
    req.log.error({ err }, "Failed to update document");
    res.status(500).json({ error: "Failed to update document" });
  }
});

// Freeze a document's content as it stands right now. Called by /approve inside the
// approval transaction (the signature is what makes the content controlled) and by the
// one-time backfill for revisions approved before this existed.
//
type SnapshotHeader = Record<string, unknown>;
async function buildContentSnapshot(
  doc: typeof documentsTable.$inferSelect,
): Promise<{
  header: SnapshotHeader;
  sections: Array<{ id: number; sortOrder: number; kind: string; title: string; bodyMarkdown: string | null; data: unknown }>;
  process: { recipeId: number | null; recipeName: string | null; recipeVersion: number | null; steps: Array<{ id: number; stepNumber: number; description: string; template: string | null }> } | null;
}> {
  const sections = await db
    .select()
    .from(documentSectionsTable)
    .where(eq(documentSectionsTable.documentId, doc.id))
    .orderBy(asc(documentSectionsTable.sortOrder), asc(documentSectionsTable.id));

  // The procedure of a recipe-backed Work Instruction is read live from the recipe,
  // so it has to be frozen here too or the retained revision would still drift.
  let process: Awaited<ReturnType<typeof buildContentSnapshot>>["process"] = null;
  if (doc.recipeId != null) {
    const [recipe] = await db.select().from(recipesTable).where(eq(recipesTable.id, doc.recipeId));
    const steps = await db
      .select()
      .from(recipeProcessStepsTable)
      .where(eq(recipeProcessStepsTable.recipeId, doc.recipeId))
      .orderBy(asc(recipeProcessStepsTable.sortOrder), asc(recipeProcessStepsTable.stepNumber), asc(recipeProcessStepsTable.id));
    process = {
      recipeId: doc.recipeId,
      recipeName: recipe?.productName ?? null,
      recipeVersion: recipe?.version ?? null,
      steps: steps.map((st) => ({
        id: st.id, stepNumber: st.stepNumber, description: st.description, template: st.template,
      })),
    };
  }

  return {
    header: {
      id: doc.id,
      docNumber: doc.docNumber,
      title: doc.title,
      documentType: doc.documentType,
      revision: doc.revision,
      status: doc.status,
      reviewRound: doc.reviewRound,
      description: doc.description,
      scope: doc.scope,
      ownerName: doc.ownerName,
      department: doc.department,
      effectiveDate: doc.effectiveDate,
      nextReviewDate: doc.nextReviewDate,
      reviewDate: doc.reviewDate,
      reviewIntervalYears: doc.reviewIntervalYears,
      createdByName: doc.createdByName,
      approvedByName: doc.approvedByName,
      approvalDate: doc.approvalDate,
      reviewerSignedName: doc.reviewerSignedName,
      reviewerSignedInitials: doc.reviewerSignedInitials,
      reviewerSignedMeaning: doc.reviewerSignedMeaning,
      reviewerSignedAt: doc.reviewerSignedAt,
      approverSignedInitials: doc.approverSignedInitials,
      approverSignedMeaning: doc.approverSignedMeaning,
      summaryOfChanges: doc.summaryOfChanges,
      changeSeverity: doc.changeSeverity,
    },
    sections: sections.map((sec) => ({
      id: sec.id,
      sortOrder: sec.sortOrder,
      kind: sec.kind,
      title: sec.title,
      bodyMarkdown: sec.bodyMarkdown,
      data: sec.data ?? null,
    })),
    process,
  };
}

// POST /documents/:id/assign-review
//
// Saves WHO will review and approve, without moving the document. Assignment and
// submission used to be one call, so picking two names shot a Draft straight into
// Under Review with no way back — the author could no longer edit the body, and
// nothing could reassign it. Splitting them lets the assignment be set, corrected
// and re-corrected while the document is still a Draft; /request-review is the
// deliberate submit.
//
// Both ids are optional so one can be set at a time, and either may be null to
// clear it. Eligibility and the author-cannot-approve rule are enforced here as
// well as at submit, so an ineligible name can never be parked on the record.
router.post("/documents/:id/assign-review", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    const [existing] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Document not found" }); return; }
    if (existing.cancelledAt) { res.status(409).json({ error: "This document is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (existing.status !== "Draft") {
      res.status(409).json({ error: "The Reviewer and Approver can only be changed while the document is in Draft." });
      return;
    }

    const body = req.body ?? {};
    const hasReviewer = "reviewerId" in body;
    const hasApprover = "approverId" in body;
    if (!hasReviewer && !hasApprover) {
      res.status(400).json({ error: "Provide a reviewerId and/or an approverId." });
      return;
    }
    const reviewerId = hasReviewer ? (body.reviewerId ?? null) : existing.assignedReviewerId;
    const approverId = hasApprover ? (body.approverId ?? null) : existing.assignedApproverId;

    if (approverId != null && existing.createdByUserId != null && existing.createdByUserId === approverId) {
      res.status(400).json({ error: "The document's author cannot be the Approver." });
      return;
    }

    const wantedIds = [...new Set([reviewerId, approverId].filter((v): v is number => typeof v === "number"))];
    const userRows = wantedIds.length
      ? await db.select().from(usersTable).where(inArray(usersTable.id, wantedIds))
      : [];
    if (userRows.length !== wantedIds.length) {
      res.status(400).json({ error: "Reviewer or Approver not found." });
      return;
    }
    for (const u of userRows) {
      if (!APPROVER_ROLES.has(u.role)) {
        res.status(400).json({ error: `${u.fullName} (${u.role}) is not eligible to review or approve documents.` });
        return;
      }
    }
    const reviewer = userRows.find((u) => u.id === reviewerId) ?? null;
    const approver = userRows.find((u) => u.id === approverId) ?? null;

    const [doc] = await db.update(documentsTable).set({
      assignedReviewerId: reviewer?.id ?? null,
      assignedReviewerName: reviewer?.fullName ?? null,
      assignedApproverId: approver?.id ?? null,
      assignedApproverName: approver?.fullName ?? null,
      updatedAt: new Date(),
    }).where(and(eq(documentsTable.id, id), eq(documentsTable.status, "Draft"))).returning();

    if (!doc) {
      res.status(409).json({ error: "Document is no longer in Draft state. Refresh and try again." });
      return;
    }

    await logAudit(id, "ASSIGN_REVIEW", actor,
      { reviewer: existing.assignedReviewerName, approver: existing.assignedApproverName },
      { reviewer: doc.assignedReviewerName, approver: doc.assignedApproverName });

    res.json(doc);
  } catch (err) {
    req.log.error({ err }, "Failed to assign reviewer / approver");
    res.status(500).json({ error: "Failed to assign reviewer / approver" });
  }
});

// POST /documents/:id/return-to-draft
//
// Sends a document under review BACK to its author for editing. Until this
// existed, Under Review was a one-way door: the Reviewer's only action was to
// sign, /request-review only transitions FROM Draft so nobody could reassign, and
// nothing anywhere wrote the status back to Draft — a review sent to the wrong
// person stranded the revision. A reviewer returning a document with comments is
// the normal case, so the assigned Reviewer and Approver can both do it, plus an
// Admin for the times neither is available.
//
// The review round is deliberately NOT rolled back. The round already happened;
// the next submission reads .2 and the history shows a round that was returned
// rather than one that silently restarted.
router.post("/documents/:id/return-to-draft", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    const reason = String((req.body ?? {}).reason ?? "").trim();
    if (!reason) {
      res.status(400).json({ error: "A reason is required — the author needs to know what to change." });
      return;
    }
    const [existing] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Document not found" }); return; }
    if (existing.cancelledAt) { res.status(409).json({ error: "This document is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (existing.status !== "Under Review") {
      res.status(400).json({ error: "Only a document that is Under Review can be returned to Draft." });
      return;
    }
    const permitted =
      actor.role === "Admin" ||
      existing.assignedReviewerId === actor.id ||
      existing.assignedApproverId === actor.id;
    if (!permitted) {
      res.status(403).json({ error: "Only the assigned Reviewer, the assigned Approver, or an Admin can return this document to Draft." });
      return;
    }

    const [doc] = await db.update(documentsTable).set({
      status: "Draft",
      // The assignment and any signature collected this round are cleared: the
      // document is going back to be changed, so neither can still stand.
      assignedReviewerId: null,
      assignedReviewerName: null,
      assignedApproverId: null,
      assignedApproverName: null,
      reviewerSignedAt: null,
      reviewerSignedName: null,
      reviewerSignedInitials: null,
      reviewerSignedMeaning: null,
      approverSignedAt: null,
      approverSignedInitials: null,
      approverSignedMeaning: null,
      updatedAt: new Date(),
    }).where(and(eq(documentsTable.id, id), eq(documentsTable.status, "Under Review"))).returning();

    if (!doc) {
      res.status(409).json({ error: "Document state changed. Refresh and try again." });
      return;
    }

    await logAudit(id, "RETURN_TO_DRAFT", actor,
      { status: "Under Review", reviewer: existing.assignedReviewerName, approver: existing.assignedApproverName },
      { status: "Draft", reason, returnedBy: actor.fullName });

    res.json(doc);
  } catch (err) {
    req.log.error({ err }, "Failed to return document to draft");
    res.status(500).json({ error: "Failed to return document to draft" });
  }
});

// POST /documents/:id/request-review
router.post("/documents/:id/request-review", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    // Session 52.2.1 — a cancelled document is read-only.
    const [rrExisting] = await db.select({
      cancelledAt: documentsTable.cancelledAt,
      createdByUserId: documentsTable.createdByUserId,
      assignedReviewerId: documentsTable.assignedReviewerId,
      assignedApproverId: documentsTable.assignedApproverId,
    }).from(documentsTable).where(eq(documentsTable.id, id));
    if (rrExisting?.cancelledAt) { res.status(409).json({ error: "This document is cancelled and read-only. Re-open it first (Admin)." }); return; }
    // 2026-08-25 — assignment and submission are now two steps. /assign-review saves
    // who will review and approve while the document stays in Draft; this route is
    // the SUBMIT, and falls back to that saved assignment when the client sends no
    // ids. Explicit ids still win, so the older one-shot call keeps working.
    const reviewerId = (req.body ?? {}).reviewerId ?? rrExisting?.assignedReviewerId ?? null;
    const approverId = (req.body ?? {}).approverId ?? rrExisting?.assignedApproverId ?? null;

    if (!reviewerId || !approverId) {
      res.status(400).json({ error: "Assign a Reviewer and an Approver before submitting for review." });
      return;
    }
    // Segregation of duties (small-facility rule): the author MAY also be the
    // Reviewer, and the Reviewer MAY also be the Approver. The one hard block is
    // that the document's author can never be the Approver. The final gate is
    // re-checked at /approve when the Approver signs.
    if (rrExisting?.createdByUserId != null && rrExisting.createdByUserId === approverId) {
      res.status(400).json({ error: "The document's author cannot be the Approver." });
      return;
    }

    // Reviewer and Approver MAY be the same person (small-facility rule), so
    // look up the DISTINCT ids and expect that many rows back.
    const distinctIds = [...new Set([reviewerId, approverId])];
    const userRows = await db.select().from(usersTable).where(inArray(usersTable.id, distinctIds));
    if (userRows.length !== distinctIds.length) {
      res.status(400).json({ error: "Reviewer or Approver not found." });
      return;
    }
    for (const u of userRows) {
      if (!APPROVER_ROLES.has(u.role)) {
        res.status(400).json({ error: `${u.fullName} (${u.role}) is not eligible to review or approve documents.` });
        return;
      }
    }
    const reviewer = userRows.find((u) => u.id === reviewerId)!;
    const approver = userRows.find((u) => u.id === approverId)!;

    // Conditional update: only transitions from Draft.
    const [doc] = await db.update(documentsTable).set({
      status: "Under Review",
      reviewRound: sql`coalesce(${documentsTable.reviewRound}, 0) + 1`,
      assignedReviewerId: reviewer.id,
      assignedReviewerName: reviewer.fullName,
      assignedApproverId: approver.id,
      assignedApproverName: approver.fullName,
      reviewerSignedAt: null,
      reviewerSignedName: null,
      reviewerSignedInitials: null,
      reviewerSignedMeaning: null,
      approverSignedAt: null,
      approverSignedInitials: null,
      approverSignedMeaning: null,
      updatedAt: new Date(),
    }).where(and(eq(documentsTable.id, id), eq(documentsTable.status, "Draft"))).returning();

    if (!doc) {
      res.status(409).json({ error: "Document is not in Draft state. Refresh and try again." });
      return;
    }

    await logAudit(id, "REQUEST_REVIEW", actor,
      { status: "Draft" }, { status: "Under Review", reviewer: reviewer.fullName, approver: approver.fullName });

    res.json(doc);
  } catch (err) {
    req.log.error({ err }, "Failed to request review");
    res.status(500).json({ error: "Failed to request review" });
  }
});

// POST /documents/:id/sign-review
// POST /documents/:id/planned-effective-date — set the day this revision goes into
// force, while it is Under Review.
//
// Jonathan, 2026-08-27: "When the document is waiting for the Approver to sign, there
// should be a calendar date selection field with a Date Effective title… That field
// can then be used to show when training is due." It lives on the approval card, not
// inside the signature dialog, so anyone looking at the document while it waits can
// see when it goes live and by when people have to be trained.
//
// Saved on its own rather than with the signature: it is a fact about the document,
// agreed between the reviewer and the approver before either signs, and it should be
// visible to both. The approver still has final say — /approve accepts a date too.
router.post("/documents/:id/planned-effective-date", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid document id." }); return; }

    const planned = normalizePlannedEffectiveDate(req.body?.plannedEffectiveDate, res);
    if (planned === INVALID_DATE) return;

    const [existing] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Document not found." }); return; }
    if (existing.cancelledAt) { res.status(409).json({ error: "This document is cancelled and read-only." }); return; }
    if (existing.status !== "Under Review") {
      res.status(409).json({ error: "The effective date is set while the document is Under Review, before it is approved." });
      return;
    }
    // The two people who have to agree on it, plus Admin. Not the whole roster —
    // this date commits everyone to a training deadline.
    const permitted =
      actor.role === "Admin" ||
      existing.assignedReviewerId === actor.id ||
      existing.assignedApproverId === actor.id;
    if (!permitted) {
      res.status(403).json({ error: "Only the assigned Reviewer, the assigned Approver, or an Admin can set the effective date." });
      return;
    }

    const [doc] = await db.update(documentsTable)
      .set({ plannedEffectiveDate: planned ?? null, updatedAt: new Date() })
      .where(eq(documentsTable.id, id))
      .returning();

    await logAudit(id, "UPDATE", actor,
      { plannedEffectiveDate: existing.plannedEffectiveDate },
      { plannedEffectiveDate: planned ?? null, reason: "Effective date set before approval" });

    res.json(doc);
  } catch (err) {
    req.log.error({ err }, "Failed to set the effective date");
    res.status(500).json({ error: "Failed to set the effective date." });
  }
});

router.post("/documents/:id/sign-review", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    const { initials, meaning } = req.body ?? {};
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and meaning are required for the e-signature." });
      return;
    }
    if (!initialsMatch(actor, initials, res)) return;

    const [existing] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Document not found" }); return; }
    if (existing.cancelledAt) { res.status(409).json({ error: "This document is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (existing.status !== "Under Review") {
      res.status(400).json({ error: "Document is not awaiting review." });
      return;
    }
    if (existing.assignedReviewerId !== actor.id) {
      res.status(403).json({ error: "Only the assigned Reviewer may sign the review." });
      return;
    }
    // Session 56 — defense-in-depth role check. The reviewer is constrained to
    // an approver role at assignment time, but re-verify here in case the role
    // was downgraded between assignment and signing (Part 11).
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Your role ("${actor.role}") is no longer permitted to review documents. Reassign the review.` });
      return;
    }

    // 2026-08-27 — the declared effective date, which the reviewer may set here and
    // the approver may set or change at approval. Jonathan: the two agree on it
    // between themselves before it is entered, and the approver has final say; the
    // system does not arbitrate between two people who can talk to each other.
    const plannedFromReviewer = normalizePlannedEffectiveDate(req.body?.plannedEffectiveDate, res);
    if (plannedFromReviewer === INVALID_DATE) return;

    const now = new Date();
    // Conditional update guards against double-signing under concurrency.
    const [doc] = await db.update(documentsTable).set({
      reviewerSignedAt: now,
      reviewerSignedName: actor.fullName,
      reviewerSignedInitials: initials,
      reviewerSignedMeaning: meaning,
      ...(plannedFromReviewer !== undefined ? { plannedEffectiveDate: plannedFromReviewer } : {}),
      updatedAt: now,
    }).where(and(
      eq(documentsTable.id, id),
      eq(documentsTable.status, "Under Review"),
      eq(documentsTable.assignedReviewerId, actor.id),
      isNull(documentsTable.reviewerSignedAt),
    )).returning();

    if (!doc) {
      res.status(409).json({ error: "Review has already been signed or state has changed." });
      return;
    }

    await logAudit(id, "SIGN_REVIEW", actor,
      { reviewerSignedAt: null }, { reviewerSignedAt: now.toISOString(), initials, meaning });

    res.json(doc);
  } catch (err) {
    req.log.error({ err }, "Failed to sign review");
    res.status(500).json({ error: "Failed to sign review" });
  }
});

// POST /documents/:id/approve
router.post("/documents/:id/approve", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    const { initials, meaning } = req.body ?? {};
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and meaning are required for the e-signature." });
      return;
    }
    if (!initialsMatch(actor, initials, res)) return;
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Your role is not permitted to approve documents." });
      return;
    }

    const [existing] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Document not found" }); return; }
    if (existing.cancelledAt) { res.status(409).json({ error: "This document is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (existing.status !== "Under Review") {
      res.status(400).json({ error: "Document must be Under Review to approve." });
      return;
    }
    if (!existing.reviewerSignedAt) {
      res.status(400).json({ error: "Reviewer must sign before the Approver can approve." });
      return;
    }
    if (existing.assignedApproverId !== actor.id) {
      res.status(403).json({ error: "Only the assigned Approver may approve this document." });
      return;
    }
    // Small-facility rule: the Reviewer MAY also be the Approver. The hard block
    // is that the document's author may never approve their own document.
    if (existing.createdByUserId != null && existing.createdByUserId === actor.id) {
      res.status(400).json({ error: "The document's author cannot approve their own document." });
      return;
    }

    // Recipe-backed work instructions: the approver must confirm the backing
    // recipe reflects this revision before release. A check, not a forced edit —
    // the recipe may legitimately be unchanged by this update.
    let recipeConfirmedVersion: number | null = null;
    if (existing.recipeId != null) {
      if ((req.body?.recipeConfirmed) !== true) {
        res.status(400).json({ error: "This work instruction is linked to a recipe. Confirm the linked recipe is current before approving." });
        return;
      }
      const [rec] = await db.select().from(recipesTable).where(eq(recipesTable.id, existing.recipeId));
      recipeConfirmedVersion = rec?.version ?? null;
    }

    // The approver has final say on the effective date. Left blank, whatever the
    // reviewer agreed stands.
    const plannedFromApprover = normalizePlannedEffectiveDate(req.body?.plannedEffectiveDate, res);
    if (plannedFromApprover === INVALID_DATE) return;
    const plannedEffective = plannedFromApprover ?? existing.plannedEffectiveDate ?? null;

    const now = new Date();
    const approvalDateStr = facilityDateStr(now);
    const interval = existing.reviewIntervalYears ?? 3;
    const nextReviewStr = facilityDateStr(addYears(now, interval));
    // Batch 6 — effectiveDate is stamped only when the doc becomes Effective (all
    // assigned training complete, or a manual mark). It is NOT set at approval.

    // Atomic approve+lock: doc state change, revision row, audit, and primary
    // attachment locking all live in the same transaction so an approved doc
    // can never have unlocked primary files.
    // Freeze what is being approved BEFORE the transaction writes it. Sections are
    // Draft-only edits and this document is Under Review, so nothing can move under
    // us; keeping the read outside the transaction keeps the write path short.
    const contentSnapshot = await buildContentSnapshot(existing);

    let { doc, lockedPrimaryFiles } = await db.transaction(async (tx) => {
      const [updated] = await tx.update(documentsTable).set({
        status: "Approved",
        approvedByName: actor.fullName,
        approvalDate: approvalDateStr,
        approverSignedAt: now,
        approverSignedInitials: initials,
        approverSignedMeaning: meaning,
        recipeConfirmedAt: existing.recipeId != null ? now : null,
        recipeConfirmedVersion,
        // The change cycle closed with the approver confirming the recipe above,
        // so the author's "needs a recipe update" flag has served its purpose.
        recipeUpdateFlagged: false,
        plannedEffectiveDate: plannedEffective,
        // The rescind notice has served its purpose the moment the document is
        // approved again. The RECORD of the rescind stays in revision history and
        // the audit log; only the banner clears.
        rescindedAt: null,
        rescindedReason: null,
        rescindedByName: null,
        rescindedToStatus: null,
        rescindedAction: null,
        nextReviewDate: nextReviewStr,
        reviewDate: nextReviewStr,
        updatedAt: now,
      }).where(and(
        eq(documentsTable.id, id),
        eq(documentsTable.status, "Under Review"),
        eq(documentsTable.assignedApproverId, actor.id),
      )).returning();

      if (!updated) return { doc: null, lockedPrimaryFiles: 0 };

      await tx.insert(documentRevisionsTable).values({
        documentId: id,
        revision: existing.revision,
        status: "Approved",
        // The retained copy of this revision. Everything else on this row says a
        // revision happened; this is the only thing that says what it was.
        contentSnapshot,
        contentSnapshotAt: now,
        contentSnapshotSource: "approval",
        summaryOfChanges: existing.summaryOfChanges,
        changeSeverity: existing.changeSeverity,
        retrainingMethod: existing.retrainingMethod,
        authorName: existing.createdByName ?? existing.ownerName,
        reviewerName: existing.reviewerSignedName,
        reviewerSignedAt: existing.reviewerSignedAt,
        approvedByName: actor.fullName,
        approvalDate: approvalDateStr,
        createdAt: now,
      });

      // The previous revision is NOT superseded here. Approval alone does not
      // replace anything — a revision waiting on training is not yet what the
      // floor works to. It is retired when this one goes Effective, in
      // supersedePriorRevisions(). Jonathan, 2026-08-26.

      await tx.insert(auditLogTable).values({
        tableName: "documents",
        rowId: id,
        operation: "APPROVE",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: { status: "Under Review" } as never,
        afterState: { status: "Approved", initials, meaning, nextReviewDate: nextReviewStr, recipeConfirmedVersion } as never,
      });

      const locked = await lockDocumentPrimaryAttachments(
        { documentId: id, revision: updated.revision, actor },
        tx,
      );
      return { doc: updated, lockedPrimaryFiles: locked };
    });

    if (!doc) {
      res.status(409).json({ error: "Document has already been approved or state has changed." });
      return;
    }

    // Auto-assign training for the new revision: everyone trained on the prior
    // revision retrains, and active members of the document's department(s) who
    // never trained on it are assigned too (2026-08-26 — a new employee must not
    // be left untrained on a procedure that governs their work).
    // Only fires for Major change severity; Minor changes (grammar, picture
    // swaps, formatting) skip retraining per the document's change-severity flag.
    let autoRetrained = 0;
    let autoNewTrainees = 0;
    let skippedRetrainReason: string | null = null;
    if (doc.changeSeverity === "Minor") {
      skippedRetrainReason = "Minor change — no retraining assigned.";
    } else {
      try {
        const [prior] = await db
          .select()
          .from(documentRevisionsTable)
          // Find the prior revision by REVISION NUMBER, not by status. It used to
          // look for a "Superseded" row, which only existed because /new-revision
          // wrote one early; now that supersession happens at approval this filter
          // would have silently stopped assigning retraining.
          .where(and(
            eq(documentRevisionsTable.documentId, id),
            ne(documentRevisionsTable.revision, doc.revision),
          ))
          .orderBy(desc(documentRevisionsTable.createdAt))
          .limit(1);
        if (prior && prior.revision !== doc.revision) {
          const counts = await autoAssignFromPriorRevision({
            documentId: id,
            newRevision: doc.revision,
            priorRevision: prior.revision,
            docNumber: doc.docNumber,
            docTitle: doc.title,
            docDescription: doc.description ?? null,
            docDepartments: doc.departments?.length ? doc.departments : doc.department ? [doc.department] : null,
            method: doc.retrainingMethod,
            // Approving again after an administrative rescind: the revision number
            // is unchanged, so without this nobody would be reissued.
            reissueAfterRescind: existing.rescindedAt != null,
            // Due by the day it goes live, not a window of its own.
            dueDate: doc.plannedEffectiveDate ?? null,
            actor,
          });
          autoRetrained = counts.retrained;
          autoNewTrainees = counts.initial;
          if (autoRetrained > 0 || autoNewTrainees > 0) {
            req.log.info({ documentId: id, autoRetrained, autoNewTrainees, priorRevision: prior.revision, newRevision: doc.revision },
              "Auto-assigned training on document revision");
          }
        }
      } catch (autoErr) {
        req.log.error({ err: autoErr, documentId: id }, "Auto-retrain assignment failed (approval still succeeded)");
      }
    }

    // Step 4 — freeze the referenced documents' numbers/titles as they are AT APPROVAL
    // into this document's Associated Documents section, so the approved & printed
    // record shows what was referenced then. The on-screen link keeps showing the live
    // title and flags a mismatch. Non-fatal: approval already succeeded.
    try {
      const adSections = await db
        .select()
        .from(documentSectionsTable)
        .where(and(eq(documentSectionsTable.documentId, id), eq(documentSectionsTable.kind, "associated_documents")));
      for (const sec of adSections) {
        const linkDocs = ((sec.data as { docs?: { documentId: number; note?: string }[] } | null)?.docs) ?? [];
        if (linkDocs.length === 0) continue;
        const refIds = linkDocs.map((d) => Number(d.documentId)).filter((n) => Number.isInteger(n));
        const refs = refIds.length
          ? await db.select({ id: documentsTable.id, docNumber: documentsTable.docNumber, title: documentsTable.title }).from(documentsTable).where(inArray(documentsTable.id, refIds))
          : [];
        const refById = new Map(refs.map((r) => [r.id, r]));
        const frozen = linkDocs.map((d) => {
          const r = refById.get(Number(d.documentId));
          return r ? { ...d, snapshotDocNumber: r.docNumber, snapshotTitle: r.title } : d;
        });
        await db
          .update(documentSectionsTable)
          .set({ data: { ...((sec.data as object) ?? {}), docs: frozen } as never })
          .where(eq(documentSectionsTable.id, sec.id));
      }
    } catch (snapErr) {
      req.log.error({ err: snapErr, documentId: id }, "Associated-doc title snapshot failed (approval still succeeded)");
    }

    // Step 5 — a revision nobody has to train on has nothing to wait for, so it
    // becomes Effective at approval rather than sitting at Approved forever. The
    // training-completion path only ever flips a document when the LAST assignment
    // is completed, so with no assignments it was never reached. Checks every
    // outstanding record on this revision, not just the ones auto-assigned above,
    // so a hand-assigned trainee still holds the document.
    // 2026-08-27 — with a DECLARED effective date the document goes into force on
    // that date and nothing else: if the date is today or already past it goes live
    // here, and if it is in the future the hourly scheduler releases it. Training no
    // longer decides — it is measured against the date instead of gating it.
    //
    // A document approved before declared dates existed carries no planned date, and
    // keeps the old behaviour of flipping once everyone assigned has trained.
    let autoEffective = false;
    try {
      const [fresh] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
      if (fresh?.status === "Approved" && fresh.plannedEffectiveDate) {
        if (fresh.plannedEffectiveDate <= facilityDateStr()) {
          const now2 = new Date();
          const [updated] = await db
            .update(documentsTable)
            .set({ status: "Effective", effectiveDate: fresh.plannedEffectiveDate, updatedAt: now2 })
            .where(and(eq(documentsTable.id, id), eq(documentsTable.status, "Approved")))
            .returning();
          if (updated) {
            autoEffective = true;
            doc = updated;
            await supersedePriorRevisions(id, fresh.revision);
            await recordEffectiveRevision({
              documentId: id,
              doc: updated,
              trigger: "Came into force on its declared effective date.",
            });
            await db.insert(auditLogTable).values({
              tableName: "documents",
              rowId: id,
              operation: "UPDATE",
              changedBy: actor.id,
              changedByName: actor.fullName,
              beforeState: { status: "Approved" } as never,
              afterState: {
                status: "Effective",
                trigger: "declared effective date reached at approval",
                effectiveDate: fresh.plannedEffectiveDate,
              } as never,
            });
          }
        }
      } else if (fresh?.status === "Approved") {
        const recs = await db
          .select()
          .from(trainingRecordsTable)
          .where(eq(trainingRecordsTable.documentId, id));
        const outstanding = recs.filter(
          (r) =>
            r.documentRevisionSnapshot === fresh.revision &&
            r.assignedToUserId != null &&
            r.status !== "Waived" &&
            !(r.status === "Completed" && r.signedAt !== null),
        );
        if (outstanding.length === 0) {
          const now = new Date();
          const [updated] = await db
            .update(documentsTable)
            .set({ status: "Effective", effectiveDate: facilityDateStr(now), updatedAt: now })
            .where(eq(documentsTable.id, id))
            .returning();
          if (updated) {
            autoEffective = true;
            doc = updated;
            // In force from this moment, so this is where the prior revision retires
            // and where the day it came into force is written down.
            await supersedePriorRevisions(id, fresh.revision);
            await recordEffectiveRevision({
              documentId: id,
              doc: updated,
              trigger: "Came into force on approval — no training required.",
            });
            await db.insert(auditLogTable).values({
              tableName: "documents",
              rowId: id,
              operation: "UPDATE",
              changedBy: actor.id,
              changedByName: actor.fullName,
              beforeState: { status: "Approved" } as never,
              afterState: {
                status: "Effective",
                trigger: "approval — no training required",
                effectiveDate: facilityDateStr(now),
              } as never,
            });
          }
        }
      }
    } catch (effErr) {
      req.log.error({ err: effErr, documentId: id }, "Auto-Effective check failed (approval still succeeded)");
    }

    res.json({ ...doc, autoRetrainedAssignments: autoRetrained, autoAssignedNewTrainees: autoNewTrainees, autoEffective, lockedPrimaryFiles, skippedRetrainReason });
  } catch (err) {
    req.log.error({ err }, "Failed to approve document");
    res.status(500).json({ error: "Failed to approve document" });
  }
});

// POST /documents/:id/rescind-approval — ADMINISTRATIVE RECORD MOVEMENT.
//
// Jonathan, 2026-08-27: an Admin/Quality user must be able to move a stuck record
// out of Approved without him being called to do it by hand. Two targets only —
// back to the approver (Under Review) or back to the author (Draft).
//
// HIS RULE, and the reason this route looks the way it does: "Any admin move that
// is completed needs to be documented. No overwrite or clearing of signatures."
// So this route clears NO signature field. The reviewer and approver signatures
// collected for the rescinded round stay exactly where they are; the rescind is a
// new document_revisions row that sits after the approval row, plus its own audit
// operation. History reads forward — signed, rescinded, signed again.
//
// Training: the incomplete assignments for this revision are CANCELLED (not
// deleted — his call) because they were issued by an approval that no longer
// stands. Completed records are untouched: they are the record of what happened.
// Re-approval reissues to everyone.
router.post("/documents/:id/rescind-approval", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid document id." }); return; }

    if (!ADMIN_MOVE_ROLES.has(actor.role)) {
      res.status(403).json({ error: `An administrative move requires Quality or Admin. Your role is "${actor.role}".` });
      return;
    }

    const { target, reason, initials, meaning } = (req.body ?? {}) as {
      target?: string; reason?: string; initials?: string; meaning?: string;
    };
    if (target !== "Under Review" && target !== "Draft") {
      res.status(400).json({ error: "Choose where the document goes back to: Under Review or Draft." });
      return;
    }
    const trimmedReason = String(reason ?? "").trim();
    if (!trimmedReason) {
      res.status(400).json({ error: "A reason is required — an administrative move has to say why." });
      return;
    }
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and a meaning of signature are required (21 CFR Part 11)." });
      return;
    }
    if (!initialsMatch(actor, initials, res)) return;

    const [existing] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Document not found." }); return; }
    if (existing.cancelledAt) { res.status(409).json({ error: "This document is cancelled and read-only." }); return; }
    if (existing.status !== "Approved") {
      res.status(409).json({
        error: existing.status === "Effective"
          ? "This document is in force. An Effective document is revised, not rescinded — start a new revision."
          : `Only an Approved document can have its approval rescinded. This one is ${existing.status}.`,
      });
      return;
    }

    const now = new Date();
    const rescindDateStr = facilityDateStr(now);

    const doc = await db.transaction(async (tx) => {
      const [updated] = await tx.update(documentsTable).set({
        status: target,
        // ⛔ NO signature field is touched. Not approverSignedAt, not the reviewer's,
        // not the assignment. The signature that was given was given, and the record
        // of the rescinded round has to keep showing who gave it.
        //
        // Cleared instead: the dates that assert this revision is approved and due
        // for review on a schedule. Those are claims about the document's standing,
        // not signatures, and leaving them would have the list assert an approval
        // that has been withdrawn.
        approvalDate: null,
        nextReviewDate: null,
        reviewDate: null,
        rescindedAt: now,
        rescindedReason: trimmedReason,
        rescindedByName: actor.fullName,
        rescindedToStatus: target,
        rescindedAction: "Approval rescinded",
        updatedAt: now,
      }).where(and(
        eq(documentsTable.id, id),
        eq(documentsTable.status, "Approved"),
      )).returning();

      if (!updated) return null;

      // The permanent record of the move. A NEW row — the approval row it follows
      // is left exactly as approval wrote it.
      await tx.insert(documentRevisionsTable).values({
        documentId: id,
        revision: existing.revision,
        status: target,
        adminAction: `Approval rescinded — returned to ${target}`,
        adminReason: trimmedReason,
        adminByName: actor.fullName,
        adminByInitials: initials.toUpperCase(),
        adminMeaning: meaning,
        // Carried onto this row so the history entry shows WHOSE approval was
        // withdrawn without anyone having to cross-reference the row above it.
        authorName: existing.createdByName ?? existing.ownerName,
        reviewerName: existing.reviewerSignedName,
        reviewerSignedAt: existing.reviewerSignedAt,
        approvedByName: existing.approvedByName,
        approvalDate: existing.approvalDate,
        createdAt: now,
      });

      await tx.insert(auditLogTable).values({
        tableName: "documents",
        rowId: id,
        operation: "RESCIND_APPROVAL",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: {
          status: "Approved",
          approvedByName: existing.approvedByName,
          approvalDate: existing.approvalDate,
        } as never,
        afterState: {
          status: target,
          administrativeOverride: true,
          reason: trimmedReason,
          rescindedBy: actor.fullName,
          rescindedOn: rescindDateStr,
          initials: initials.toUpperCase(),
          meaning,
          signaturesPreserved: true,
        } as never,
      });

      return updated;
    });

    if (!doc) {
      res.status(409).json({ error: "Document state changed. Refresh and try again." });
      return;
    }

    // Void the training this approval issued and has not been completed. Cancelled,
    // never deleted: "I don't want a bunch of random incomplete training records out
    // there" — but the row stays so the trail shows it existed and why it stopped.
    let cancelledTraining = 0;
    try {
      const open = await db
        .select()
        .from(trainingRecordsTable)
        .where(and(
          eq(trainingRecordsTable.documentId, id),
          eq(trainingRecordsTable.documentRevisionSnapshot, existing.revision),
        ));
      const toCancel = open.filter((r) => r.status !== "Completed" && r.status !== "Waived" && r.status !== "Cancelled");
      for (const rec of toCancel) {
        await db.update(trainingRecordsTable).set({
          status: "Cancelled",
          notes: [rec.notes, `Cancelled ${rescindDateStr} — approval of ${existing.docNumber} rev ${existing.revision} rescinded by ${actor.fullName}: ${trimmedReason}`]
            .filter(Boolean).join("\n"),
          updatedAt: now,
        } as never).where(eq(trainingRecordsTable.id, rec.id));
        await db.insert(auditLogTable).values({
          tableName: "training_records",
          rowId: rec.id,
          operation: "CANCEL",
          changedBy: actor.id,
          changedByName: actor.fullName,
          beforeState: { status: rec.status } as never,
          afterState: { status: "Cancelled", reason: `Approval of ${existing.docNumber} rescinded`, administrativeOverride: true } as never,
        });
      }
      cancelledTraining = toCancel.length;
    } catch (trainErr) {
      req.log.error({ err: trainErr, documentId: id }, "Rescind succeeded but cancelling open training failed");
    }

    res.json({ ...doc, cancelledTraining });
  } catch (err) {
    req.log.error({ err }, "Failed to rescind document approval");
    res.status(500).json({ error: "Failed to rescind the approval." });
  }
});

router.post("/documents/:id/obsolete", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    const { initials, meaning } = req.body ?? {};
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and meaning are required for the e-signature." });
      return;
    }
    if (!initialsMatch(actor, initials, res)) return;
    if (!APPROVER_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Only Supervisor, Manager, Quality, or Admin may mark documents obsolete." });
      return;
    }

    const [existing] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Document not found" }); return; }
    if (existing.cancelledAt) { res.status(409).json({ error: "This document is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (existing.status === "Obsolete" || existing.status === "Superseded") {
      res.status(400).json({ error: "Document is already retired." });
      return;
    }

    const now = new Date();
    const [doc] = await db.update(documentsTable).set({
      status: "Obsolete",
      obsoletedAt: now,
      obsoletedByName: actor.fullName,
      obsoletedMeaning: meaning,
      updatedAt: now,
    }).where(and(eq(documentsTable.id, id), eq(documentsTable.status, existing.status))).returning();

    if (!doc) {
      res.status(409).json({ error: "Document state changed during the request. Refresh and try again." });
      return;
    }

    await db.insert(documentRevisionsTable).values({
      documentId: id,
      revision: existing.revision,
      status: "Obsolete",
      summaryOfChanges: `Marked obsolete: ${meaning}`,
      authorName: existing.createdByName,
      approvedByName: existing.approvedByName,
      approvalDate: existing.approvalDate,
      effectiveDate: existing.effectiveDate,
      obsoletedAt: now,
      obsoletedByName: actor.fullName,
      createdAt: now,
    });

    await logAudit(id, "OBSOLETE", actor,
      { status: existing.status }, { status: "Obsolete", initials, meaning });

    res.json(doc);
  } catch (err) {
    req.log.error({ err }, "Failed to mark obsolete");
    res.status(500).json({ error: "Failed to mark obsolete" });
  }
});

// POST /documents/:id/reinstate-obsolete — ADMINISTRATIVE RECORD MOVEMENT.
//
// Jonathan, 2026-08-27: "If we want a process where obsolete comes back, it comes
// back to Draft. Not to Effective. So, we want to bring back an obsoleted document,
// we have to go through the process."
//
// That is the governing principle for every administrative move: it may push a
// record BACKWARD into the change process, never forward toward being in force.
// A reinstated document is a Draft with no standing whatsoever — it earns its way
// back through review and approval like any other change.
//
// Quality and Admin only, same as rescinding an approval.
router.post("/documents/:id/reinstate-obsolete", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid document id." }); return; }

    if (!ADMIN_MOVE_ROLES.has(actor.role)) {
      res.status(403).json({ error: `An administrative move requires Quality or Admin. Your role is "${actor.role}".` });
      return;
    }

    const { reason, changeSeverity, initials, meaning } = (req.body ?? {}) as {
      reason?: string; changeSeverity?: string; initials?: string; meaning?: string;
    };
    const trimmedReason = String(reason ?? "").trim();
    if (!trimmedReason) {
      res.status(400).json({ error: "A reason is required — an administrative move has to say why." });
      return;
    }
    // Asked the same way Start New Revision asks it, and for the same reason: the
    // document still carries the severity it was retired with, so without a fresh
    // answer a procedure nobody has read for months could return to force training
    // nobody. Major leaves retrainingMethod null, which reads as "Read & Understand".
    if (changeSeverity !== "Minor" && changeSeverity !== "Major") {
      res.status(400).json({ error: "Choose a change severity: Minor assigns no training, Major retrains on approval." });
      return;
    }
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and a meaning of signature are required (21 CFR Part 11)." });
      return;
    }
    if (!initialsMatch(actor, initials, res)) return;

    const [existing] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Document not found." }); return; }
    if (existing.cancelledAt) { res.status(409).json({ error: "This document is cancelled and read-only." }); return; }
    if (existing.status === "Superseded") {
      res.status(409).json({ error: "A superseded revision belongs to revision history and cannot be brought back. Revise the current revision instead." });
      return;
    }
    if (existing.status !== "Obsolete") {
      res.status(409).json({ error: `Only an Obsolete document can be brought back. This one is ${existing.status}.` });
      return;
    }

    // Blocked where a later revision has already taken over: bringing this one back
    // would put two revisions of the same document into the change process at once.
    const laterRevisions = await db
      .select()
      .from(documentRevisionsTable)
      .where(eq(documentRevisionsTable.documentId, id));
    const currentRev = parseFloat(String(existing.revision)) || 0;
    const hasLater = laterRevisions.some((r) => (parseFloat(String(r.revision)) || 0) > currentRev);
    if (hasLater) {
      res.status(409).json({ error: "A later revision of this document exists, so this one cannot be brought back. Start a new revision instead." });
      return;
    }

    const now = new Date();
    const reinstateDateStr = facilityDateStr(now);

    const doc = await db.transaction(async (tx) => {
      // Jonathan, 2026-08-27: "The obsolete version would be version 2.0, then 2.1
      // becomes the draft until effective as 3.0." So bringing a document back STARTS
      // A NEW REVISION, exactly as /new-revision does — bump the stored whole number
      // and reset the review round, and formatRevision renders the draft as 2.1 on its
      // way to 3.0. The retired 2.0 keeps its own history rows untouched.
      const nextRev = String(Math.floor(parseFloat(String(existing.revision)) || 1) + 1);
      const [updated] = await tx.update(documentsTable).set({
        status: "Draft",
        revision: nextRev,
        reviewRound: 0,
        changeSeverity,
        retrainingMethod: changeSeverity === "Major" ? "Read & Understand" : null,
        // ⛔ The obsolescence signature is NOT cleared. Someone signed to retire this
        // document and that act stands on the record; what changes is the document's
        // STATUS, not the history of who did what.
        //
        // The rev 2.0 REVIEW and APPROVAL signatures do come off the live row, and that
        // is not a contradiction. Jonathan, 2026-08-27: "Why should approvers be listed
        // if the document is not added by the person changing the document?" They signed
        // 2.0; this row is now 2.1 on its way to 3.0, and leaving them would have the
        // draft assert an approval nobody gave for it. Nothing is lost — the rev 2.0
        // history rows keep every signature, which is exactly how /new-revision behaves.
        effectiveDate: null,
        approvalDate: null,
        nextReviewDate: null,
        reviewDate: null,
        approvedByName: null,
        assignedReviewerId: null,
        assignedReviewerName: null,
        assignedApproverId: null,
        assignedApproverName: null,
        reviewerSignedAt: null,
        reviewerSignedName: null,
        reviewerSignedInitials: null,
        reviewerSignedMeaning: null,
        approverSignedAt: null,
        approverSignedInitials: null,
        approverSignedMeaning: null,
        recipeConfirmedAt: null,
        recipeConfirmedVersion: null,
        rescindedAt: now,
        rescindedReason: trimmedReason,
        rescindedByName: actor.fullName,
        rescindedToStatus: "Draft",
        rescindedAction: "Reinstated from Obsolete",
        updatedAt: now,
      }).where(and(
        eq(documentsTable.id, id),
        eq(documentsTable.status, "Obsolete"),
      )).returning();

      if (!updated) return null;

      await tx.insert(documentRevisionsTable).values({
        documentId: id,
        // The revision the document is NOW on, not the one it was retired at. The
        // history row then renders through the same formatter the Document Control
        // list uses and the two can never disagree; the Obsolete row directly below
        // it still names the version that was retired.
        revision: nextRev,
        status: "Draft",
        adminAction: "Reinstated from Obsolete — returned to Draft",
        changeSeverity,
        adminReason: trimmedReason,
        adminByName: actor.fullName,
        adminByInitials: initials.toUpperCase(),
        adminMeaning: meaning,
        authorName: existing.createdByName ?? existing.ownerName,
        reviewerName: existing.reviewerSignedName,
        reviewerSignedAt: existing.reviewerSignedAt,
        approvedByName: existing.approvedByName,
        approvalDate: existing.approvalDate,
        createdAt: now,
      });

      await tx.insert(auditLogTable).values({
        tableName: "documents",
        rowId: id,
        operation: "REINSTATE_OBSOLETE",
        changedBy: actor.id,
        changedByName: actor.fullName,
        beforeState: {
          status: "Obsolete",
          obsoletedByName: existing.obsoletedByName,
          obsoletedAt: existing.obsoletedAt,
          effectiveDate: existing.effectiveDate,
        } as never,
        afterState: {
          status: "Draft",
          administrativeOverride: true,
          reason: trimmedReason,
          reinstatedBy: actor.fullName,
          reinstatedOn: reinstateDateStr,
          initials: initials.toUpperCase(),
          meaning,
          signaturesPreserved: true,
          note: "Returns as a Draft with no standing — must go through review and approval again.",
        } as never,
      });

      return updated;
    });

    if (!doc) {
      res.status(409).json({ error: "Document state changed. Refresh and try again." });
      return;
    }

    res.json(doc);
  } catch (err) {
    req.log.error({ err }, "Failed to reinstate obsolete document");
    res.status(500).json({ error: "Failed to bring the document back." });
  }
});

// POST /documents/:id/new-revision
// GET /documents/:id/revisions — revision history for the History tab. Read-only
// view of the change process: each row is a revision with its change summary,
// severity, and the author/reviewer/approver captured when that change was
// signed off. Newest first. No manual entry — this is derived from the workflow.
router.get("/documents/:id/revisions", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid document id." }); return; }
    const rows = await db
      .select()
      .from(documentRevisionsTable)
      .where(eq(documentRevisionsTable.documentId, id))
      .orderBy(desc(documentRevisionsTable.createdAt));
    // The retained copy can be large, and the history list only needs to know
    // WHETHER there is one — the content is fetched per revision when opened.
    res.json(rows.map(({ contentSnapshot, ...rest }) => ({
      ...rest,
      retained: contentSnapshot != null,
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to load document revisions");
    res.status(500).json({ error: "Failed to load document revisions" });
  }
});

// POST /documents/:id/mark-effective — Manager/Quality/Admin release an Approved
// document into force. Jonathan, 2026-08-26: "If everyone is not trained by the 10
// days, then Quality or Manager can push the document to Effective and make sure
// training is completed for those not available in the 10 days (sick, vacation,
// etc.) but the training stays open so they train on it when first available."
//
// It therefore does NOT touch a single training record: everyone outstanding keeps
// their assignment and due date and goes Overdue on schedule, because the honest
// record is an open assignment with a real completion date, not a document that
// pretends everyone was trained. A Part 11 signature is required — the meaning of
// signature is the reason — and the audit entry names who was still untrained when
// it went into force.
router.post("/documents/:id/mark-effective", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid document id." }); return; }
    if (!MGMT_ROLES.has(actor.role)) {
      res.status(403).json({ error: "Only a Manager, Quality, or Admin can mark a document Effective." });
      return;
    }
    const { initials, meaning } = req.body ?? {};
    if (!initials || !meaning) {
      res.status(400).json({ error: "Initials and a meaning of signature are required to release a document." });
      return;
    }
    if (!initialsMatch(actor, initials, res)) return;
    const [existing] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Document not found." }); return; }
    if (existing.cancelledAt) { res.status(409).json({ error: "This document is cancelled and read-only." }); return; }
    if (existing.status === "Effective") { res.status(409).json({ error: "Document is already Effective." }); return; }
    if (existing.status !== "Approved") {
      res.status(400).json({ error: "Only an Approved document can be marked Effective." });
      return;
    }
    // Who is still untrained at the moment of release, recorded on the audit entry
    // so the record states plainly what was outstanding when it went into force.
    const recs = await db
      .select()
      .from(trainingRecordsTable)
      .where(eq(trainingRecordsTable.documentId, id));
    const outstanding = recs.filter(
      (r) =>
        r.documentRevisionSnapshot === existing.revision &&
        r.assignedToUserId != null &&
        r.status !== "Waived" &&
        !(r.status === "Completed" && r.signedAt !== null),
    );

    const now = new Date();
    const effectiveStr = facilityDateStr(now);
    const [doc] = await db.update(documentsTable).set({
      status: "Effective",
      effectiveDate: effectiveStr,
      updatedAt: now,
    }).where(and(eq(documentsTable.id, id), eq(documentsTable.status, "Approved"))).returning();
    if (!doc) { res.status(409).json({ error: "Document state changed. Refresh and try again." }); return; }
    // The document is in force from this moment — retire what it replaces.
    const supersededRevision = await supersedePriorRevisions(id, existing.revision);
    await recordEffectiveRevision({
      documentId: id,
      doc,
      trigger: outstanding.length
        ? `Released into force by ${actor.fullName} with ${outstanding.length} training assignment${outstanding.length === 1 ? "" : "s"} still open.`
        : `Released into force by ${actor.fullName}.`,
    });
    await logAudit(id, "EFFECTIVE", actor,
      { status: "Approved" },
      {
        status: "Effective",
        effectiveDate: effectiveStr,
        trigger: outstanding.length ? "manual release — training outstanding" : "manual",
        supersededRevision,
        outstandingTrainees: outstanding.length,
        outstandingNames: outstanding.map((r) => r.employeeName),
        initials,
        meaning,
      });
    res.json({ ...doc, outstandingTrainees: outstanding.length });
  } catch (err) {
    req.log.error({ err }, "Failed to mark document effective");
    res.status(500).json({ error: "Failed to mark document effective" });
  }
});

// GET /documents/mgmt/recently-effective — documents that became Effective within the
// last N days (default 14). Management-only; powers the Dashboard "Recently effective"
// tile so Quality/Manager know to reprint controlled copies. Derived on read.
router.get("/documents/mgmt/recently-effective", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!MGMT_ROLES.has(actor.role)) { res.json([]); return; }
    const days = Math.max(1, Math.min(90, parseInt(String(req.query.days ?? "14")) || 14));
    const cutoff = facilityDateStr(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    const rows = await db.select().from(documentsTable).where(eq(documentsTable.status, "Effective"));
    const recent = rows
      .filter((d) => (d.effectiveDate ?? "") >= cutoff)
      .map((d) => ({ id: d.id, docNumber: d.docNumber, title: d.title, revision: d.revision, effectiveDate: d.effectiveDate, ownerName: d.ownerName ?? null }))
      .sort((a, b) => (b.effectiveDate ?? "").localeCompare(a.effectiveDate ?? ""));
    res.json(recent);
  } catch (err) {
    req.log.error({ err }, "Failed to load recently-effective documents");
    res.status(500).json({ error: "Failed to load recently-effective documents" });
  }
});

router.post("/documents/:id/new-revision", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    const { summaryOfChanges, changeSeverity, retrainingMethod, recipeUpdateNeeded } = req.body ?? {};
    if (changeSeverity !== "Minor" && changeSeverity !== "Major") {
      res.status(400).json({
        error: "changeSeverity is required and must be 'Minor' or 'Major'. Major changes auto-assign retraining; Minor changes do not.",
      });
      return;
    }
    // Retraining method only applies to a Major change. Default to self-serve
    // "Read & Understand"; the author can switch to "Instructor-Led" now or later
    // (while the doc stays in Draft). Minor changes carry no method.
    let method: string | null = null;
    if (changeSeverity === "Major") {
      method = retrainingMethod ?? "Read & Understand";
      if (!RETRAIN_METHODS.has(String(method))) {
        res.status(400).json({ error: 'retrainingMethod must be "Read & Understand" or "Instructor-Led".' });
        return;
      }
    }

    const [existing] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Document not found" }); return; }
    if (existing.cancelledAt) { res.status(409).json({ error: "This document is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (existing.status !== "Approved" && existing.status !== "Effective") {
      res.status(400).json({ error: "Only Approved or Effective documents can be revised." });
      return;
    }

    // Whole-number revisions: the next approved version is prior whole number + 1.
    // The ".x" review-round counter resets to 0 for the new cycle.
    const nextRev = String(Math.floor(parseFloat(String(existing.revision)) || 1) + 1);

    const now = new Date();
    // Snapshot the outgoing revision with the status it ACTUALLY holds — Approved,
    // or Effective. It is NOT superseded yet: starting a draft supersedes nothing,
    // and until the new revision is approved the outgoing one is still the document
    // in force on the floor. This row used to be written as "Superseded" the moment
    // a draft opened, so the History tab retired the controlled document while
    // everyone was still working to it. The flip now happens in /approve, at the
    // moment something actually replaces it.
    // The change-severity is preserved either way so the trail keeps the historical decision.
    //
    // 2026-08-27 — skipped when that row already exists. Going into force now writes
    // its own Effective row at the moment it happens, so snapshotting an Effective
    // document here would record the same event twice and make the history read as
    // though the revision came into force twice.
    const [alreadyRecorded] = await db
      .select()
      .from(documentRevisionsTable)
      .where(and(
        eq(documentRevisionsTable.documentId, id),
        eq(documentRevisionsTable.revision, existing.revision),
        eq(documentRevisionsTable.status, existing.status),
      ))
      .limit(1);
    if (!alreadyRecorded) await db.insert(documentRevisionsTable).values({
      documentId: id,
      revision: existing.revision,
      status: existing.status,
      summaryOfChanges: existing.summaryOfChanges,
      changeSeverity: existing.changeSeverity,
      retrainingMethod: existing.retrainingMethod,
      authorName: existing.createdByName,
      reviewerName: existing.reviewerSignedName,
      reviewerSignedAt: existing.reviewerSignedAt,
      approvedByName: existing.approvedByName,
      approvalDate: existing.approvalDate,
      effectiveDate: existing.effectiveDate,
      createdAt: now,
    });

    const [doc] = await db.update(documentsTable).set({
      revision: nextRev,
      reviewRound: 0,
      status: "Draft",
      summaryOfChanges: summaryOfChanges ?? null,
      changeSeverity,
      retrainingMethod: method,
      approvedByName: null,
      approvalDate: null,
      effectiveDate: null,
      assignedReviewerId: null,
      assignedReviewerName: null,
      assignedApproverId: null,
      assignedApproverName: null,
      reviewerSignedAt: null,
      reviewerSignedName: null,
      reviewerSignedInitials: null,
      reviewerSignedMeaning: null,
      approverSignedAt: null,
      approverSignedInitials: null,
      approverSignedMeaning: null,
      recipeConfirmedAt: null,
      recipeConfirmedVersion: null,
      // 2026-08-25 - the author is asked at revision START whether this change
      // also needs the linked recipe updated. Advisory: many document changes
      // never touch the recipe, so this WARNS (a notice on the recipe) rather
      // than blocking. The reverse direction - editing the recipe under an
      // approved WI - IS blocked, in recipes.ts.
      recipeUpdateFlagged: recipeUpdateNeeded === true,
      nextReviewDate: null,
      reviewDate: null,
      createdByName: actor.fullName,
      updatedAt: now,
    }).where(and(eq(documentsTable.id, id), inArray(documentsTable.status, ["Approved", "Effective"]))).returning();

    if (!doc) {
      res.status(409).json({ error: "Document is no longer in Approved state. Refresh and try again." });
      return;
    }

    await logAudit(id, "NEW_REVISION", actor,
      { revision: existing.revision, status: existing.status },
      { revision: nextRev, status: "Draft", changeSeverity, recipeUpdateNeeded: recipeUpdateNeeded === true });

    res.json(doc);
  } catch (err) {
    req.log.error({ err }, "Failed to start new revision");
    res.status(500).json({ error: "Failed to start new revision" });
  }
});

// ── Document Sections (Specification structured body) ────────────────────────
//
// Sections drive the Print Batch Record output when a batch links to this
// document. Editable while the doc is in Draft; once Approved/Under Review
// the spec body is locked with the rest of the document. Free-text edits are
// allowed on Draft docs only.

// GET /documents/:id/revisions/:revisionRowId/content
//
// The retained copy of one past revision, for reading and printing it as it stood.
// Returns supersededOn so the viewer can stamp the printed copy with the date it
// stopped being in force — a historical print that looks current is worse than none.
router.get("/documents/:id/revisions/:revisionRowId/content", async (req, res) => {
  try {
    const docId = parseInt(req.params.id);
    const rowId = parseInt(req.params.revisionRowId);
    const [row] = await db
      .select()
      .from(documentRevisionsTable)
      .where(and(eq(documentRevisionsTable.id, rowId), eq(documentRevisionsTable.documentId, docId)));
    if (!row) { res.status(404).json({ error: "Revision record not found." }); return; }
    if (!row.contentSnapshot) {
      res.status(404).json({
        error: "No retained copy of this revision. It was approved before revision content was retained.",
        revision: row.revision,
        retained: false,
      });
      return;
    }
    // When this revision stopped being in force: the approval date of the next
    // revision approved after it, if there is one.
    const later = await db
      .select()
      .from(documentRevisionsTable)
      .where(and(
        eq(documentRevisionsTable.documentId, docId),
        eq(documentRevisionsTable.status, "Approved"),
      ))
      .orderBy(asc(documentRevisionsTable.createdAt));
    const idx = later.findIndex((r) => r.id === rowId);
    const next = idx >= 0 ? later[idx + 1] : undefined;
    res.json({
      retained: true,
      revision: row.revision,
      status: row.status,
      snapshot: row.contentSnapshot,
      capturedAt: row.contentSnapshotAt,
      capturedFrom: row.contentSnapshotSource,
      approvedByName: row.approvedByName,
      approvalDate: row.approvalDate,
      effectiveDate: row.effectiveDate,
      supersededOn: next?.approvalDate ?? null,
      supersededByRevision: next?.revision ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to load retained revision content");
    res.status(500).json({ error: "Failed to load retained revision content" });
  }
});

// POST /documents/admin/backfill-revision-content
//
// One-time sweep for revisions approved before retention existed. Captures each
// document's CURRENT content onto its current approved revision record, so the
// retained history starts today rather than one revision from now. Marked as
// "backfill" rather than "approval": a copy taken months after the signature is not
// the same evidence, and the record says so. Never overwrites an existing snapshot.
router.post("/documents/admin/backfill-revision-content", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (actor.role !== "Admin") {
      res.status(403).json({ error: "Only an Admin can backfill revision content." });
      return;
    }
    const docs = await db
      .select()
      .from(documentsTable)
      .where(inArray(documentsTable.status, ["Approved", "Effective"]));
    const now = new Date();
    let captured = 0;
    const skipped: { docNumber: string; reason: string }[] = [];

    for (const doc of docs) {
      if (doc.cancelledAt) { skipped.push({ docNumber: doc.docNumber, reason: "Cancelled" }); continue; }
      // The record for the revision currently in force.
      const rows = await db
        .select()
        .from(documentRevisionsTable)
        .where(and(
          eq(documentRevisionsTable.documentId, doc.id),
          eq(documentRevisionsTable.revision, doc.revision),
          eq(documentRevisionsTable.status, "Approved"),
        ))
        .orderBy(desc(documentRevisionsTable.createdAt))
        .limit(1);
      const target = rows[0];
      if (!target) { skipped.push({ docNumber: doc.docNumber, reason: "No approval record for the current revision" }); continue; }
      if (target.contentSnapshot) { skipped.push({ docNumber: doc.docNumber, reason: "Already retained" }); continue; }
      const snapshot = await buildContentSnapshot(doc);
      await db
        .update(documentRevisionsTable)
        .set({ contentSnapshot: snapshot, contentSnapshotAt: now, contentSnapshotSource: "backfill" })
        .where(eq(documentRevisionsTable.id, target.id));
      await logAudit(doc.id, "BACKFILL_REVISION_CONTENT", actor,
        { revision: doc.revision, retained: false },
        { revision: doc.revision, retained: true, capturedFrom: "backfill" });
      captured += 1;
    }
    res.json({ captured, skipped: skipped.length, skippedDetails: skipped, documents: docs.length });
  } catch (err) {
    req.log.error({ err }, "Failed to backfill revision content");
    res.status(500).json({ error: "Failed to backfill revision content" });
  }
});

// GET /documents/my/pending-signatures
//
// The documents waiting on THIS person's signature. Powers the "Documents to
// review" My Queue tile, which used to be fed by /my/impacts — a different
// question entirely (which of my documents reference something being revised),
// so a reviewer with three documents to sign saw a zero and reasonably concluded
// they had nothing to do.
//
// Only what the person can act on NOW is counted, so the number never overstates:
//   - assigned Reviewer, review not yet signed        → action "review"
//   - assigned Approver, and the Reviewer HAS signed  → action "approve"
// An approver on a document whose reviewer hasn't signed yet is waiting on the
// reviewer, not the other way round, so it is left out. One person who is both
// reviewer and approver sees the document once, under whichever step is live.
router.get("/documents/my/pending-signatures", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const rows = await db
      .select()
      .from(documentsTable)
      .where(and(
        eq(documentsTable.status, "Under Review"),
        isNull(documentsTable.cancelledAt),
      ));
    const mine = rows
      .map((d) => {
        const awaitingMyReview = d.assignedReviewerId === actor.id && d.reviewerSignedAt == null;
        const awaitingMyApproval = d.assignedApproverId === actor.id && d.reviewerSignedAt != null;
        if (!awaitingMyReview && !awaitingMyApproval) return null;
        return {
          id: d.id,
          docNumber: d.docNumber,
          title: d.title,
          revision: d.revision,
          documentType: d.documentType,
          // Review comes first: if somebody is both, the live step is the review.
          action: awaitingMyReview ? "review" : "approve",
          reviewerName: d.assignedReviewerName ?? null,
          approverName: d.assignedApproverName ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.docNumber.localeCompare(b.docNumber));
    res.json(mine);
  } catch (err) {
    req.log.error({ err }, "Failed to load documents pending my signature");
    res.status(500).json({ error: "Failed to load documents pending my signature" });
  }
});

// GET /documents/my/review-recommendations — the current user's Approved documents
// (or ALL for management) that reference a document approved MORE RECENTLY than them,
// i.e. a review is recommended. Same deterministic rule as /:id/review-recommendation,
// swept across the facility. Powers the Dashboard "Reviews recommended" tile.
router.get("/documents/my/review-recommendations", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const approved = await db.select().from(documentsTable).where(inArray(documentsTable.status, ["Approved", "Effective"]));
    if (approved.length === 0) { res.json([]); return; }
    const approvedById = new Map(approved.map((d) => [d.id, d]));
    const sections = await db
      .select()
      .from(documentSectionsTable)
      .where(and(eq(documentSectionsTable.kind, "associated_documents"), inArray(documentSectionsTable.documentId, approved.map((d) => d.id))));
    const isMgmt = MGMT_ROLES.has(actor.role);
    const result: unknown[] = [];
    for (const s of sections) {
      const parent = approvedById.get(s.documentId);
      if (!parent) continue;
      if (!isMgmt && (parent.ownerName ?? "") !== actor.fullName) continue;
      const myApproval = parent.approvalDate;
      const refIds = (((s.data as { docs?: { documentId: number }[] } | null)?.docs) ?? [])
        .map((d) => Number(d.documentId))
        .filter((n) => Number.isInteger(n));
      const triggers = refIds
        .map((rid) => approvedById.get(rid))
        .filter((r): r is NonNullable<typeof r> => !!r && !!r.approvalDate && (!myApproval || r.approvalDate > myApproval))
        .map((r) => ({ id: r.id, docNumber: r.docNumber, title: r.title, revision: r.revision, approvalDate: r.approvalDate }));
      if (triggers.length) {
        result.push({
          myDoc: { id: parent.id, docNumber: parent.docNumber, title: parent.title, status: parent.status, ownerName: parent.ownerName ?? null },
          owned: (parent.ownerName ?? "") === actor.fullName,
          triggers,
        });
      }
    }
    result.sort((a, b) => (a as { myDoc: { docNumber: string } }).myDoc.docNumber.localeCompare((b as { myDoc: { docNumber: string } }).myDoc.docNumber));
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to compute review recommendations");
    res.status(500).json({ error: "Failed to load review recommendations" });
  }
});

// GET /documents/:id/review-recommendation — is a review of THIS document recommended
// because a document it references was (re)approved more recently than this one was?
// Deterministic, read-only. Powers the "review recommended" banner + one-click
// "Start review revision" (step 3 — human triggers the draft; nothing is auto-edited).
router.get("/documents/:id/review-recommendation", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid document id." }); return; }
    const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!doc) { res.status(404).json({ error: "Document not found." }); return; }
    // Only meaningful for an Approved document (a Draft/Under Review is already being worked).
    if (doc.status !== "Approved" && doc.status !== "Effective") { res.json({ recommended: false, triggers: [] }); return; }
    const secs = await db
      .select()
      .from(documentSectionsTable)
      .where(and(eq(documentSectionsTable.documentId, id), eq(documentSectionsTable.kind, "associated_documents")));
    const refIds = secs
      .flatMap((s) => (((s.data as { docs?: { documentId: number }[] } | null)?.docs) ?? []).map((d) => Number(d.documentId)))
      .filter((n) => Number.isInteger(n));
    if (refIds.length === 0) { res.json({ recommended: false, triggers: [] }); return; }
    const refs = await db.select().from(documentsTable).where(inArray(documentsTable.id, Array.from(new Set(refIds))));
    const myApproval = doc.approvalDate; // "YYYY-MM-DD" (string compare is chronological) or null
    const triggers = refs
      .filter((r) => (r.status === "Approved" || r.status === "Effective") && r.approvalDate && (!myApproval || r.approvalDate > myApproval))
      .map((r) => ({ id: r.id, docNumber: r.docNumber, title: r.title, revision: r.revision, approvalDate: r.approvalDate }))
      .sort((a, b) => a.docNumber.localeCompare(b.docNumber));
    res.json({ recommended: triggers.length > 0, triggers });
  } catch (err) {
    req.log.error({ err }, "Failed to compute review recommendation");
    res.status(500).json({ error: "Failed to load review recommendation" });
  }
});

// GET /documents/:id/referenced-by — reverse link index: which OTHER documents list
// this one in their "Associated Documents" section. Deterministic scan of the
// associated-documents sections (no AI). Foundation for bidirectional navigation and,
// next, impact notifications when a referenced document is revised.
router.get("/documents/:id/referenced-by", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid document id." }); return; }
    const sections = await db
      .select()
      .from(documentSectionsTable)
      .where(eq(documentSectionsTable.kind, "associated_documents"));
    // parentDocId -> note (first note wins). Skip a document that references itself.
    const refs = new Map<number, string | null>();
    for (const s of sections) {
      if (s.documentId === id) continue;
      const docs = ((s.data as { docs?: { documentId: number; note?: string }[] } | null)?.docs) ?? [];
      const hit = docs.find((d) => Number(d.documentId) === id);
      if (hit && !refs.has(s.documentId)) refs.set(s.documentId, hit.note ?? null);
    }
    if (refs.size === 0) { res.json([]); return; }
    const parents = await db
      .select({
        id: documentsTable.id,
        docNumber: documentsTable.docNumber,
        title: documentsTable.title,
        status: documentsTable.status,
      })
      .from(documentsTable)
      .where(inArray(documentsTable.id, Array.from(refs.keys())));
    const result = parents
      .map((p) => ({ ...p, note: refs.get(p.id) ?? null }))
      .sort((a, b) => a.docNumber.localeCompare(b.docNumber));
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to compute referenced-by");
    res.status(500).json({ error: "Failed to load referencing documents" });
  }
});

// POST /documents/:id/suggest-associated-links — AI-assisted matching of imported
// free-text "Associated Documents" references to real controlled documents. ADVISORY
// and read-only: returns suggestions a human confirms before any link is created.
// Exact doc-number hits are matched deterministically; the rest go to the AI.
router.post("/documents/:id/suggest-associated-links", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid document id." }); return; }
    const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!doc) { res.status(404).json({ error: "Document not found." }); return; }

    // References: explicit body.references[], else parse the imported placeholder section.
    let references: string[] = Array.isArray(req.body?.references)
      ? (req.body.references as unknown[]).map((r) => String(r ?? "")).filter((r) => r.trim())
      : [];
    let placeholderSectionId: number | null = null;
    if (references.length === 0) {
      const secs = await db.select().from(documentSectionsTable).where(eq(documentSectionsTable.documentId, id));
      const placeholder = secs.find((s) => s.kind === "free_text" && (s.title ?? "").startsWith(IMPORTED_LINKS_TITLE_PREFIX));
      if (placeholder) {
        placeholderSectionId = placeholder.id;
        references = (placeholder.bodyMarkdown ?? "")
          .split("\n")
          .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
          .filter(Boolean);
      }
    }
    if (references.length === 0) { res.json({ suggestions: [], placeholderSectionId: null, aiModel: null }); return; }

    const all = await db
      .select({ id: documentsTable.id, docNumber: documentsTable.docNumber, title: documentsTable.title, status: documentsTable.status })
      .from(documentsTable);
    const candidates = all.filter((d) => d.id !== id && LINKABLE_STATUSES.has(d.status));

    // Deterministic pass: a reference containing an exact doc number is a high match.
    const deterministic = new Map<string, number>();
    const fuzzyRefs: string[] = [];
    for (const ref of references) {
      const upper = ref.toUpperCase();
      const hit = candidates.find((c) => upper.includes(c.docNumber.toUpperCase()));
      if (hit) deterministic.set(ref, hit.id);
      else fuzzyRefs.push(ref);
    }
    const aiSuggestions = fuzzyRefs.length
      ? await suggestAssociatedDocumentLinks(fuzzyRefs, candidates.map((c) => ({ id: c.id, docNumber: c.docNumber, title: c.title })))
      : [];
    const aiByRef = new Map(aiSuggestions.map((s) => [s.reference, s]));
    const docById = new Map(candidates.map((c) => [c.id, c]));

    const suggestions = references.map((ref) => {
      const detId = deterministic.get(ref);
      if (detId != null) {
        const d = docById.get(detId)!;
        return { reference: ref, documentId: detId, docNumber: d.docNumber, title: d.title, confidence: "high", method: "exact", reasoning: "Document number matched exactly." };
      }
      const ai = aiByRef.get(ref);
      const d = ai?.documentId != null ? docById.get(ai.documentId) : null;
      return { reference: ref, documentId: d ? d.id : null, docNumber: d?.docNumber ?? null, title: d?.title ?? null, confidence: ai?.confidence ?? "none", method: "ai", reasoning: ai?.reasoning ?? null };
    });

    res.json({ suggestions, placeholderSectionId, aiModel: LINK_MATCH_AI_MODEL });
  } catch (err) {
    req.log.error({ err }, "Failed to suggest associated links");
    res.status(500).json({ error: "Failed to suggest associated document links" });
  }
});

// POST /documents/:id/apply-associated-links — create the real Associated Documents
// links a human confirmed from the suggestions. Draft only (sections locked otherwise).
// Records that AI assisted, for the Part 11 / ISO 42001 audit trail.
router.post("/documents/:id/apply-associated-links", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid document id." }); return; }
    const { documentIds, removeSectionId, aiAssisted } = req.body as { documentIds?: number[]; removeSectionId?: number; aiAssisted?: boolean };
    const ids = Array.isArray(documentIds)
      ? Array.from(new Set(documentIds.map((n) => Number(n)).filter((n) => Number.isInteger(n))))
      : [];
    if (ids.length === 0) { res.status(400).json({ error: "Provide documentIds[] to link." }); return; }

    const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!doc) { res.status(404).json({ error: "Document not found." }); return; }
    if (doc.status !== "Draft") { res.status(400).json({ error: "Associated document links can only be edited while the document is in Draft." }); return; }

    const targets = await db.select({ id: documentsTable.id }).from(documentsTable).where(inArray(documentsTable.id, ids));
    const validIds = ids.filter((x) => x !== id && targets.some((t) => t.id === x));
    if (validIds.length === 0) { res.status(400).json({ error: "No valid target documents to link." }); return; }

    const secs = await db.select().from(documentSectionsTable).where(eq(documentSectionsTable.documentId, id));
    const existing = secs.find((s) => s.kind === "associated_documents");
    let sectionId: number;
    if (existing) {
      const current = ((existing.data as { docs?: { documentId: number; note?: string }[] } | null)?.docs) ?? [];
      const have = new Set(current.map((d) => d.documentId));
      const merged = [...current, ...validIds.filter((x) => !have.has(x)).map((x) => ({ documentId: x }))];
      const [row] = await db.update(documentSectionsTable).set({ data: { docs: merged } as never }).where(eq(documentSectionsTable.id, existing.id)).returning();
      sectionId = row.id;
    } else {
      const [row] = await db.insert(documentSectionsTable).values({
        documentId: id,
        sortOrder: 10,
        kind: "associated_documents",
        title: "Associated Documents",
        data: { docs: validIds.map((x) => ({ documentId: x })) } as never,
      }).returning();
      sectionId = row.id;
    }

    let removedPlaceholder = false;
    if (typeof removeSectionId === "number") {
      const ph = secs.find((s) => s.id === removeSectionId && s.kind === "free_text");
      if (ph) { await db.delete(documentSectionsTable).where(eq(documentSectionsTable.id, removeSectionId)); removedPlaceholder = true; }
    }

    await logAudit(id, "AI_LINK_APPLY", actor, null, {
      linked: validIds.length, documentIds: validIds, aiAssisted: !!aiAssisted,
      aiModel: aiAssisted ? LINK_MATCH_AI_MODEL : null, removedPlaceholder,
    });
    res.json({ ok: true, linked: validIds.length, sectionId, removedPlaceholder });
  } catch (err) {
    req.log.error({ err }, "Failed to apply associated links");
    res.status(500).json({ error: "Failed to apply associated document links" });
  }
});

router.get("/documents/:id/sections", async (req, res) => {
  try {
    const docId = parseInt(req.params.id);
    const rows = await db.select().from(documentSectionsTable)
      .where(eq(documentSectionsTable.documentId, docId))
      .orderBy(asc(documentSectionsTable.sortOrder), asc(documentSectionsTable.id));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list document sections");
    res.status(500).json({ error: "Failed to list document sections" });
  }
});

// Session 60 — hybrid doc<->process bridge: serve the linked recipe's process
// steps so a "process_steps" section renders the SAME steps the operator runs on
// a batch (single source of truth). Empty steps if the doc has no recipeId.
router.get("/documents/:id/process-steps", async (req, res) => {
  try {
    const docId = parseInt(req.params.id);
    const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, docId));
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }
    if (!doc.recipeId) { res.json({ recipeId: null, recipe: null, steps: [] }); return; }
    const [recipe] = await db.select().from(recipesTable).where(eq(recipesTable.id, doc.recipeId));
    const steps = await db.select().from(recipeProcessStepsTable)
      .where(eq(recipeProcessStepsTable.recipeId, doc.recipeId))
      .orderBy(asc(recipeProcessStepsTable.sortOrder), asc(recipeProcessStepsTable.stepNumber), asc(recipeProcessStepsTable.id));
    res.json({
      recipeId: doc.recipeId,
      recipe: recipe ? { id: recipe.id, productName: recipe.productName, productType: recipe.productType, version: recipe.version } : null,
      steps,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to load linked recipe process steps");
    res.status(500).json({ error: "Failed to load linked recipe process steps" });
  }
});

// Roles permitted to author Spec sections (parallels existing doc-edit roles).
const SECTION_EDITOR_ROLES = new Set(["Admin", "Manager", "Quality", "Supervisor"]);

router.post("/documents/:id/sections", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!SECTION_EDITOR_ROLES.has(actor.role ?? "")) {
      res.status(403).json({ error: "Only Admin / Manager / Quality / Supervisor may edit spec sections." });
      return;
    }
    const docId = parseInt(req.params.id);
    const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, docId));
    if (!doc) { res.status(404).json({ error: "Document not found" }); return; }
    if (doc.cancelledAt) { res.status(409).json({ error: "This document is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (doc.status !== "Draft") {
      res.status(409).json({ error: "Sections can only be edited while the document is in Draft." });
      return;
    }
    const body = req.body ?? {};
    const kind = String(body.kind ?? "free_text");
    if (!(SECTION_KINDS as readonly string[]).includes(kind)) {
      res.status(400).json({ error: `kind must be one of: ${SECTION_KINDS.join(", ")}` });
      return;
    }
    if (!body.title?.trim()) { res.status(400).json({ error: "title is required" }); return; }
    const [row] = await db.insert(documentSectionsTable).values({
      documentId: docId,
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
      kind,
      title: String(body.title).trim(),
      bodyMarkdown: body.bodyMarkdown ?? null,
      data: body.data ?? null,
    }).returning();
    await logAudit(docId, "SECTION_CREATE", actor, null, { sectionId: row.id, kind: row.kind, title: row.title });
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to create document section");
    res.status(500).json({ error: "Failed to create document section" });
  }
});

router.patch("/document-sections/:id", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!SECTION_EDITOR_ROLES.has(actor.role ?? "")) {
      res.status(403).json({ error: "Only Admin / Manager / Quality / Supervisor may edit spec sections." });
      return;
    }
    const id = parseInt(req.params.id);
    const [existing] = await db.select().from(documentSectionsTable).where(eq(documentSectionsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Section not found" }); return; }
    const [doc] = await db.select({ status: documentsTable.status, cancelledAt: documentsTable.cancelledAt }).from(documentsTable).where(eq(documentsTable.id, existing.documentId));
    if (doc?.cancelledAt) { res.status(409).json({ error: "This document is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (doc?.status !== "Draft") {
      res.status(409).json({ error: "Sections can only be edited while the document is in Draft." });
      return;
    }
    const patch = req.body ?? {};
    if (patch.kind && !(SECTION_KINDS as readonly string[]).includes(String(patch.kind))) {
      res.status(400).json({ error: `kind must be one of: ${SECTION_KINDS.join(", ")}` });
      return;
    }
    const [row] = await db.update(documentSectionsTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(documentSectionsTable.id, id))
      .returning();
    await logAudit(existing.documentId, "SECTION_UPDATE", actor,
      { sectionId: existing.id, kind: existing.kind, title: existing.title, bodyMarkdown: existing.bodyMarkdown, sortOrder: existing.sortOrder },
      { sectionId: row.id,      kind: row.kind,      title: row.title,      bodyMarkdown: row.bodyMarkdown,      sortOrder: row.sortOrder });
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to update document section");
    res.status(500).json({ error: "Failed to update document section" });
  }
});

router.delete("/document-sections/:id", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    if (!SECTION_EDITOR_ROLES.has(actor.role ?? "")) {
      res.status(403).json({ error: "Only Admin / Manager / Quality / Supervisor may edit spec sections." });
      return;
    }
    const id = parseInt(req.params.id);
    const [existing] = await db.select().from(documentSectionsTable).where(eq(documentSectionsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Section not found" }); return; }
    const [doc] = await db.select({ status: documentsTable.status, cancelledAt: documentsTable.cancelledAt }).from(documentsTable).where(eq(documentsTable.id, existing.documentId));
    if (doc?.cancelledAt) { res.status(409).json({ error: "This document is cancelled and read-only. Re-open it first (Admin)." }); return; }
    if (doc?.status !== "Draft") {
      res.status(409).json({ error: "Sections can only be deleted while the document is in Draft." });
      return;
    }
    await db.delete(documentSectionsTable).where(eq(documentSectionsTable.id, id));
    await logAudit(existing.documentId, "SECTION_DELETE", actor,
      { sectionId: existing.id, kind: existing.kind, title: existing.title }, null);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete document section");
    res.status(500).json({ error: "Failed to delete document section" });
  }
});

// ── Session 52.1 — soft Cancel / Re-open (Part 11) ───────────────────────────
//
// QMS records are never hard-deleted. Cancel retains the row, is recoverable
// (/uncancel, Admin-only), and requires a Manager/Quality/Admin actor + a
// rationale + a Part 11 e-signature (initials matching the signed-in user +
// meaning). Cancel is permitted ONLY while the document is pre-effective
// (Draft, Under Review, Approved); an Effective or Obsolete document cannot be
// cancelled (409). Mirrors the Non-Conformance reference implementation
// (Session 52). Actor resolution reuses getActor() (Clerk getAuth → usersTable),
// the same pattern as /approve and /sign-review.
const CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);
const CANCEL_TERMINAL_STATUSES = new Set(["Effective", "Obsolete"]);

router.post("/documents/:id/cancel", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    const { reason, initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as {
      reason?: string; initials?: string; signatureMeaning?: string; signingMeaning?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;

    if (!CANCEL_ROLES.has(actor.role)) {
      res.status(403).json({ error: `Cancelling a record requires Manager, Quality, or Admin. Your role is "${actor.role}".` });
      return;
    }
    if (!reason || !reason.trim()) { res.status(400).json({ error: "A cancellation rationale is required." }); return; }
    if (!initials || !meaning) { res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return; }
    if ((actor.initials ?? "").toUpperCase() !== initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }

    const [before] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!before) { res.status(404).json({ error: "Document not found" }); return; }
    if (before.cancelledAt) { res.status(409).json({ error: "This record is already cancelled." }); return; }
    if (CANCEL_TERMINAL_STATUSES.has(before.status)) {
      res.status(409).json({ error: `An ${before.status} document cannot be cancelled. Mark it Obsolete through the normal lifecycle instead.` });
      return;
    }

    const [doc] = await db.update(documentsTable).set({
      cancelledAt: new Date(),
      cancelledReason: reason.trim(),
      cancelledByName: actor.fullName,
      cancelledByInitials: initials.toUpperCase(),
      cancelledMeaning: meaning,
      updatedAt: new Date(),
    } as never).where(eq(documentsTable.id, id)).returning();
    await logAudit(id, "CANCEL", actor, before, doc);
    res.json(doc);
  } catch (err) {
    req.log.error({ err }, "Failed to cancel document");
    res.status(500).json({ error: "Failed to cancel document" });
  }
});

// POST /documents/:id/uncancel — reverse a Cancel. Admin-ONLY (Session 52
// decision — narrower than Cancel). Part 11 signature required. Clears the
// cancel fields and returns the document to active use.
router.post("/documents/:id/uncancel", async (req, res) => {
  try {
    const actor = await getActor(req, res);
    if (!actor) return;
    const id = parseInt(req.params.id);
    const { initials, signatureMeaning, signingMeaning } = (req.body ?? {}) as {
      initials?: string; signatureMeaning?: string; signingMeaning?: string;
    };
    const meaning = signatureMeaning ?? signingMeaning;

    if (actor.role !== "Admin") {
      res.status(403).json({ error: `Re-opening a record is restricted to Admin. Your role is "${actor.role}".` });
      return;
    }
    if (!initials || !meaning) { res.status(400).json({ error: "Initials and signing meaning required (21 CFR Part 11)." }); return; }
    if ((actor.initials ?? "").toUpperCase() !== initials.toUpperCase()) {
      res.status(400).json({ error: "Initials do not match the signed-in user." }); return;
    }

    const [before] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
    if (!before) { res.status(404).json({ error: "Document not found" }); return; }
    if (!before.cancelledAt) { res.status(409).json({ error: "This record is not cancelled." }); return; }

    const [doc] = await db.update(documentsTable).set({
      cancelledAt: null,
      cancelledReason: null,
      cancelledByName: null,
      cancelledByInitials: null,
      cancelledMeaning: null,
      updatedAt: new Date(),
    } as never).where(eq(documentsTable.id, id)).returning();
    await logAudit(id, "UNCANCEL", actor, before, doc);
    res.json(doc);
  } catch (err) {
    req.log.error({ err }, "Failed to uncancel document");
    res.status(500).json({ error: "Failed to uncancel document" });
  }
});

export default router;
