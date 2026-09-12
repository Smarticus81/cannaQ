import { Router } from "express";
import { db } from "@workspace/db";
import {
  regulatoryUpdatesTable,
  documentsTable,
  labelTemplatesTable,
  REGULATORY_STATUSES,
} from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";
import { analyzeRegulatoryBulletin } from "../lib/aiClient";
import { getOrProvisionCurrentUser } from "../lib/currentUser";

const router = Router();

// E5 Regulatory Intelligence Agent (Session 66). Manual ingest first: a bulletin
// arrives as pasted text, or a URL the server fetches once. Claude summarizes it,
// assigns severity, and maps impact against the facility's Approved/Effective
// documents and label templates. The agent proposes; a human reviewer disposes.

// Fetch a URL once. Many regulatory bulletins (esp. Michigan CRA) are PDFs, so
// we sniff the bytes: a real PDF is returned as base64 for Claude to read as a
// native document; anything else is treated as HTML and crudely stripped to
// text. Never throws — returns empty fields on any failure so ingest degrades.
async function fetchUrl(url: string): Promise<{ text: string; pdfBase64: string }> {
  const EMPTY = { text: "", pdfBase64: "" };
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return EMPTY;
    const resp = await fetch(u.toString(), { redirect: "follow" });
    if (!resp.ok) return EMPTY;
    const buf = Buffer.from(await resp.arrayBuffer());
    // Cap: base64-inlined PDFs must stay within the model's document limits and
    // keep the request reasonable. Bulletins are small; bail on anything huge.
    if (buf.length > 18 * 1024 * 1024) return EMPTY;
    // Magic-byte sniff — reliable regardless of the server's content-type header.
    const isPdf = buf.subarray(0, 5).toString("latin1") === "%PDF-";
    if (isPdf) return { text: "", pdfBase64: buf.toString("base64") };
    const text = buf
      .toString("utf8")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .split(String.fromCharCode(0)).join("") // strip NUL bytes (Postgres text rejects them)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20000);
    return { text, pdfBase64: "" };
  } catch {
    return EMPTY;
  }
}

// POST /regulatory-updates/analyze — ingest + run the agent, persist as "New".
router.post("/regulatory-updates/analyze", async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      source?: string;
      title?: string;
      sourceUrl?: string;
      publishedDate?: string;
      text?: string;
    };
    const source = (body.source ?? "").trim();
    const title = (body.title ?? "").trim();
    if (!source || !title) {
      res.status(400).json({ error: "source and title are required." });
      return;
    }

    // Resolve the bulletin: pasted text wins; otherwise fetch the URL once. The
    // fetch may return HTML-stripped text OR a base64 PDF (many CRA bulletins are
    // PDFs) — in the PDF case Claude reads the document natively.
    let text = (body.text ?? "").trim();
    let pdfBase64 = "";
    const sourceUrl = (body.sourceUrl ?? "").trim() || null;
    if (!text && sourceUrl) {
      const fetched = await fetchUrl(sourceUrl);
      text = fetched.text;
      pdfBase64 = fetched.pdfBase64;
    }
    if (!text && !pdfBase64) {
      res.status(400).json({ error: "Provide bulletin text, or a fetchable URL pointing to a readable page or PDF." });
      return;
    }

    // Map impact only against live controlled items (Approved/Effective docs,
    // approved/effective label templates) — the things a change would force a revision of.
    const docs = await db
      .select()
      .from(documentsTable)
      .where(inArray(documentsTable.status, ["Approved", "Effective"]));
    const templates = await db
      .select()
      .from(labelTemplatesTable)
      .where(inArray(labelTemplatesTable.status, ["approved", "effective", "Approved", "Effective"]));

    const analysis = await analyzeRegulatoryBulletin({
      source,
      title,
      text,
      pdfBase64,
      documents: docs.map((d) => ({
        docId: d.id,
        docNumber: d.docNumber,
        title: d.title,
        documentType: d.documentType,
        scope: d.scope,
      })),
      labelTemplates: templates.map((t) => ({ templateId: t.id, name: t.name, productType: t.productType })),
    });

    const [row] = await db
      .insert(regulatoryUpdatesTable)
      .values({
        source,
        title,
        sourceUrl,
        publishedDate: body.publishedDate?.trim() || null,
        rawText: (text || "[PDF bulletin — analyzed natively from the source document]").slice(0, 20000),
        aiSummary: analysis.summary || null,
        severity: analysis.severity,
        impactedDocuments: analysis.impactedDocuments,
        impactedLabelTemplates: analysis.impactedLabelTemplates,
        suggestedActions: analysis.suggestedActions,
        aiModel: analysis.aiModel,
        status: "New",
      })
      .returning();

    // When the Claude call failed (e.g. missing API key on this environment) the
    // bulletin is still saved, but tell the client so it doesn't look like the
    // agent simply found nothing.
    res.status(201).json({ ...row, aiUnavailable: analysis.failed === true });
  } catch (err) {
    req.log.error({ err }, "Failed to analyze regulatory bulletin");
    res.status(500).json({ error: "Failed to analyze regulatory bulletin" });
  }
});

// GET /regulatory-updates — list, newest first (optional ?status= filter).
router.get("/regulatory-updates", async (req, res) => {
  try {
    const status = typeof req.query["status"] === "string" ? (req.query["status"] as string) : null;
    const rows = status
      ? await db.select().from(regulatoryUpdatesTable)
          .where(eq(regulatoryUpdatesTable.status, status))
          .orderBy(desc(regulatoryUpdatesTable.createdAt))
      : await db.select().from(regulatoryUpdatesTable).orderBy(desc(regulatoryUpdatesTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list regulatory updates");
    res.status(500).json({ error: "Failed to list regulatory updates" });
  }
});

// GET /regulatory-updates/:id
router.get("/regulatory-updates/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [row] = await db.select().from(regulatoryUpdatesTable).where(eq(regulatoryUpdatesTable.id, id));
    if (!row) { res.status(404).json({ error: "Regulatory update not found" }); return; }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to get regulatory update");
    res.status(500).json({ error: "Failed to get regulatory update" });
  }
});

// PATCH /regulatory-updates/:id — human disposition (Reviewed / Dismissed /
// Actioned). Records who and when so the agent's suggestion is human-owned.
router.patch("/regulatory-updates/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const body = (req.body ?? {}) as { status?: string; reviewNotes?: string; linkedActions?: unknown };
    const status = (body.status ?? "").trim();
    if (status && !(REGULATORY_STATUSES as readonly string[]).includes(status)) {
      res.status(400).json({ error: `status must be one of ${REGULATORY_STATUSES.join(", ")}.` });
      return;
    }
    const actor = await getOrProvisionCurrentUser(req).catch(() => null);
    const [existing] = await db.select().from(regulatoryUpdatesTable).where(eq(regulatoryUpdatesTable.id, id));
    if (!existing) { res.status(404).json({ error: "Regulatory update not found" }); return; }

    const isDisposition = status && status !== "New";
    const [row] = await db
      .update(regulatoryUpdatesTable)
      .set({
        ...(status ? { status } : {}),
        ...(body.reviewNotes !== undefined ? { reviewNotes: body.reviewNotes } : {}),
        ...(body.linkedActions !== undefined ? { linkedActions: body.linkedActions } : {}),
        ...(isDisposition
          ? { reviewedByName: actor?.fullName ?? "Unknown", reviewedAt: new Date() }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(regulatoryUpdatesTable.id, id))
      .returning();
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to update regulatory update");
    res.status(500).json({ error: "Failed to update regulatory update" });
  }
});

export default router;
