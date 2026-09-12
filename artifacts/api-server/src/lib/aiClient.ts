import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";

/**
 * Suggest 3–5 effectiveness checks for a CAPA, given its action items.
 * Suggestions are advisory only — a human Quality reviewer must accept/edit
 * before the CAPA's effectiveness criteria is signed (Part 11).
 *
 * Returns an empty array on any error so the UI degrades gracefully.
 */
export async function suggestEffectivenessChecks(
  actionDescriptions: string[],
): Promise<string[]> {
  const cleaned = actionDescriptions.map((s) => s?.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];

  const prompt = `You are assisting a Quality Manager at a Michigan cannabis processing facility (FDA 21 CFR Part 11, ISO 13485:2016).

Given the following CAPA corrective/preventive action items, propose 3 to 5 short, measurable EFFECTIVENESS CHECKS that could be used 7–90 days after implementation to verify the actions actually eliminated or reduced the root cause from recurring.

Each suggestion MUST:
- Be a single sentence (under 25 words).
- Name a concrete, observable metric (e.g. number of NCs, audit pass rate, retention quiz score, batch yield, label defect ppm).
- Specify a timeframe (e.g. "over the next 30 days").
- Avoid vague language like "improve quality" or "ensure compliance".

Action items:
${cleaned.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Respond with ONLY a JSON array of strings, e.g.:
["Audit 10 batches over the next 30 days; zero label defects.", "Quiz all 5 trained operators after 7 days; minimum 80% score."]

No prose, no markdown, just the JSON array.`;

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    // Strip optional ```json fences just in case.
    const cleanedText = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(cleanedText);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .slice(0, 5);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// E5 Regulatory Intelligence Agent (Session 66)
// ---------------------------------------------------------------------------

export const REGULATORY_AI_MODEL = "claude-sonnet-4-6";

export type RegDocContext = {
  docId: number;
  docNumber: string;
  title: string;
  documentType: string;
  scope?: string | null;
};
export type RegLabelContext = {
  templateId: number;
  name: string;
  productType: string;
};
export type RegulatoryAnalysis = {
  summary: string;
  severity: "Informational" | "Advisory" | "Action Required";
  impactedDocuments: Array<{ docId: number; docNumber: string; title: string; reason: string }>;
  impactedLabelTemplates: Array<{ templateId: number; name: string; reason: string }>;
  suggestedActions: string[];
  aiModel: string;
  // True when the Claude call itself failed (e.g. missing API key) — lets the
  // caller distinguish "AI unavailable" from "AI ran and found nothing".
  failed?: boolean;
};

const EMPTY_ANALYSIS = (): RegulatoryAnalysis => ({
  summary: "",
  severity: "Informational",
  impactedDocuments: [],
  impactedLabelTemplates: [],
  suggestedActions: [],
  aiModel: REGULATORY_AI_MODEL,
});

/**
 * Analyze a regulatory bulletin against the facility's live controlled documents
 * and label templates. The agent PROPOSES — a human reviewer always disposes
 * (Tier 6 design rule). Returns a safe empty analysis on any error so ingestion
 * never hard-fails. The model is told to only reference ids from the supplied
 * lists; the caller additionally validates ids against those lists.
 */
export async function analyzeRegulatoryBulletin(input: {
  source: string;
  title: string;
  text?: string;
  pdfBase64?: string;
  documents: RegDocContext[];
  labelTemplates: RegLabelContext[];
}): Promise<RegulatoryAnalysis> {
  const bulletin = (input.text ?? "").trim();
  const pdfBase64 = (input.pdfBase64 ?? "").trim();
  if (!bulletin && !pdfBase64) return EMPTY_ANALYSIS();

  const docList = input.documents
    .map((d) => `  - id ${d.docId} | ${d.docNumber} | ${d.documentType} | ${d.title}${d.scope ? ` | scope: ${d.scope}` : ""}`)
    .join("\n") || "  (none)";
  const labelList = input.labelTemplates
    .map((l) => `  - id ${l.templateId} | ${l.name} (${l.productType})`)
    .join("\n") || "  (none)";

  const prompt = `You are a Regulatory Intelligence analyst for a Michigan cannabis processing facility operating under a Quality Management System (FDA 21 CFR Part 11, FDA food cGMP 21 CFR Part 117, ISO 13485 as guidance) and Michigan CRA / MDARD rules.

A regulatory bulletin has been received. Analyze it and map its impact ONLY onto the facility's existing controlled documents and label templates listed below. Do not invent ids — reference only ids that appear in the lists. If nothing is impacted, return empty arrays.

BULLETIN SOURCE: ${input.source}
BULLETIN TITLE: ${input.title}
${pdfBase64 ? "BULLETIN: provided as the attached PDF document — read it in full." : `BULLETIN TEXT:\n"""\n${bulletin.slice(0, 12000)}\n"""`}

FACILITY CONTROLLED DOCUMENTS (id | number | type | title):
${docList}

FACILITY LABEL TEMPLATES (id | name | product type):
${labelList}

Produce a JSON object with EXACTLY these keys:
- "summary": 2-4 sentence plain-language summary of what changed and why it matters to this facility.
- "severity": one of "Informational" (no action needed), "Advisory" (review recommended), "Action Required" (a document or label likely must change).
- "impactedDocuments": array of { "docId": number, "reason": string (one sentence, why this doc is impacted) } — only for documents genuinely affected.
- "impactedLabelTemplates": array of { "templateId": number, "reason": string } — only for templates genuinely affected.
- "suggestedActions": array of 1-5 short imperative actions a Quality Manager could take (e.g. "Review and revise WI-26-0004 for the new testing requirement").

Respond with ONLY the JSON object, no prose, no markdown fences.`;

  // When a PDF is supplied, send it to Claude as a native document block (same
  // pattern as AI batch import) so the model reads the actual bulletin; otherwise
  // the bulletin text is already inlined in the prompt above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: any[] = [];
  if (pdfBase64) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
    });
  }
  content.push({ type: "text", text: prompt });

  try {
    // ⛔ 2026-09-03 — was 1500, and that silently broke the whole feature. The
    // prompt asks for a summary, a REASON PER impacted document, a reason per
    // impacted label template, and up to five actions. Against a facility with
    // ~15 Approved/Effective SOPs that runs well past 1500 tokens, so the reply
    // was cut off mid-JSON, JSON.parse threw, the catch below returned
    // EMPTY_ANALYSIS — and the record stored "Informational, nothing impacted".
    // Jonathan paid for a 71-page PDF to be read twice and got a blank all-clear
    // both times. The input is what costs money; capping the OUTPUT this tightly
    // saved nothing and threw the answer away after paying for it.
    const resp = await anthropic.messages.create({
      model: REGULATORY_AI_MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content }],
    });
    const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const docById = new Map(input.documents.map((d) => [d.docId, d]));
    const labelById = new Map(input.labelTemplates.map((l) => [l.templateId, l]));

    const severityRaw = String(parsed["severity"] ?? "Informational");
    const severity: RegulatoryAnalysis["severity"] =
      severityRaw === "Action Required" || severityRaw === "Advisory" ? severityRaw : "Informational";

    const impactedDocuments = Array.isArray(parsed["impactedDocuments"])
      ? (parsed["impactedDocuments"] as Array<Record<string, unknown>>)
          .map((r) => {
            const id = typeof r["docId"] === "number" ? r["docId"] : Number(r["docId"]);
            const d = docById.get(id);
            if (!d) return null; // drop hallucinated/unknown ids
            return { docId: d.docId, docNumber: d.docNumber, title: d.title, reason: String(r["reason"] ?? "").trim() };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
      : [];

    const impactedLabelTemplates = Array.isArray(parsed["impactedLabelTemplates"])
      ? (parsed["impactedLabelTemplates"] as Array<Record<string, unknown>>)
          .map((r) => {
            const id = typeof r["templateId"] === "number" ? r["templateId"] : Number(r["templateId"]);
            const l = labelById.get(id);
            if (!l) return null;
            return { templateId: l.templateId, name: l.name, reason: String(r["reason"] ?? "").trim() };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
      : [];

    const suggestedActions = Array.isArray(parsed["suggestedActions"])
      ? (parsed["suggestedActions"] as unknown[])
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .slice(0, 5)
      : [];

    return {
      summary: String(parsed["summary"] ?? "").trim(),
      severity,
      impactedDocuments,
      impactedLabelTemplates,
      suggestedActions,
      aiModel: REGULATORY_AI_MODEL,
    };
  } catch (err) {
    // Surface the real cause in the server logs (commonly a missing
    // AI_INTEGRATIONS_ANTHROPIC_API_KEY / _BASE_URL on the environment).
    logger.error({ err }, "analyzeRegulatoryBulletin failed");
    return { ...EMPTY_ANALYSIS(), failed: true };
  }
}

// ---------------------------------------------------------------------------
// Help Assist (Session 71, PR 3) — the "?" popover "Ask a question" box.
// ---------------------------------------------------------------------------

export const HELP_AI_MODEL = "claude-haiku-4-5";

export type HelpAnswer = {
  answer: string;
  // True when the Claude call itself failed (missing key, no credit, etc.) so
  // the caller can show "AI help is off" rather than a blank answer.
  failed?: boolean;
};

/**
 * Answer a user's in-app help question, grounded in the help content for the
 * page they're on (passed from the client — the help registry lives on the
 * frontend). Advisory only: the assistant explains how to use CannaQ and points
 * the user to the right screen; it never claims to have taken an action. Uses
 * the cheap/fast Haiku model and a tight token budget so each question costs a
 * fraction of a cent. Returns { failed: true } on any error so the UI degrades
 * to the "turns on at launch" state instead of erroring.
 */
export async function answerHelpQuestion(input: {
  route: string;
  question: string;
  pageTitle?: string;
  pageContext?: string; // the current help topic text (what-it-is, common tasks…)
}): Promise<HelpAnswer> {
  const question = (input.question ?? "").trim();
  if (!question) return { answer: "" };

  const context = (input.pageContext ?? "").trim() || "(no page-specific help text was provided)";

  const prompt = `You are the in-app help assistant for CannaQ, a Quality Management System for a Michigan cannabis processing facility (FDA 21 CFR Part 11, FDA food cGMP 21 CFR Part 117, Michigan CRA / MDARD rules; ISO 13485 used as guidance).

You help operators understand and use the software. You explain what a screen is for and how to complete tasks. You do NOT take actions, change data, or claim to have done so — you only guide the human, who does the work themselves.

The user is currently on the "${input.pageTitle ?? input.route}" page (route ${input.route}). Reference help content for this page:
"""
${context.slice(0, 4000)}
"""

User question:
"""
${question.slice(0, 1000)}
"""

Answer in 1–4 short sentences, plain language, specific to CannaQ where possible. If the answer isn't covered by the page context and you are not confident, say so briefly and suggest they check the relevant screen or ask their system administrator — do not invent regulatory citations, field names, or features. Respond with plain text only (no markdown headings or bullet syntax).`;

  try {
    const resp = await anthropic.messages.create({
      model: HELP_AI_MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    if (!text) return { answer: "", failed: true };
    return { answer: text };
  } catch (err) {
    logger.error({ err }, "answerHelpQuestion failed");
    return { answer: "", failed: true };
  }
}

// ---------------------------------------------------------------------------

export const LINK_MATCH_AI_MODEL = "claude-haiku-4-5";

export type LinkSuggestion = {
  reference: string;
  documentId: number | null;
  confidence: "high" | "medium" | "low" | "none";
  reasoning?: string;
};

/**
 * Match free-text "associated document" references (e.g. imported from a Word/PDF
 * SOP) to the controlled documents that already exist in the system. ADVISORY ONLY:
 * a human confirms each match before any real link is created (Part 11 / ISO 42001 —
 * AI suggests, human decides). Deterministic exact doc-number matches should be done
 * by the caller; this handles the fuzzy title/description matches.
 *
 * Returns one entry per input reference; documentId is null when no candidate is a
 * confident match. Returns every reference as unmatched on any error (graceful).
 */
export async function suggestAssociatedDocumentLinks(
  references: string[],
  candidates: { id: number; docNumber: string; title: string }[],
): Promise<LinkSuggestion[]> {
  const refs = references.map((r) => (r ?? "").trim()).filter(Boolean);
  if (refs.length === 0) return [];
  if (candidates.length === 0) return refs.map((reference) => ({ reference, documentId: null, confidence: "none" as const }));

  const prompt = `You are assisting a Quality Manager at a Michigan cannabis facility linking a controlled document's "Associated Documents" references to the documents that actually exist in their Quality Management System.

Each REFERENCE below is free text (it may be a document number, a title, or a loose description). Match it to the single best CANDIDATE document, or to none if no candidate is a plausible match. Do NOT force a match — an unrelated reference should be documentId null.

CANDIDATE DOCUMENTS (the only valid documentId values):
${candidates.map((c) => `- id ${c.id}: ${c.docNumber} — ${c.title}`).join("\n")}

REFERENCES to match:
${refs.map((r, i) => `${i + 1}. ${r}`).join("\n")}

Respond with ONLY a JSON array, one object per reference in the same order:
[{"reference": "<the reference text>", "documentId": <candidate id or null>, "confidence": "high|medium|low|none", "reasoning": "<short why>"}]

Rules:
- documentId MUST be one of the candidate ids above, or null.
- Use "high" only for an unambiguous doc-number or near-exact title match; "medium"/"low" for looser title/topic matches; "none" when documentId is null.
- No prose, no markdown — just the JSON array.`;

  try {
    const resp = await anthropic.messages.create({
      model: LINK_MATCH_AI_MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) return refs.map((reference) => ({ reference, documentId: null, confidence: "none" as const }));
    const validIds = new Set(candidates.map((c) => c.id));
    return refs.map((reference, i) => {
      const row = parsed[i] as { documentId?: unknown; confidence?: unknown; reasoning?: unknown } | undefined;
      const docId = typeof row?.documentId === "number" && validIds.has(row.documentId) ? row.documentId : null;
      const conf = docId === null ? "none" : (["high", "medium", "low"].includes(String(row?.confidence)) ? String(row?.confidence) : "low");
      return {
        reference,
        documentId: docId,
        confidence: conf as LinkSuggestion["confidence"],
        reasoning: typeof row?.reasoning === "string" ? row.reasoning : undefined,
      };
    });
  } catch (err) {
    logger.error({ err }, "suggestAssociatedDocumentLinks failed");
    return refs.map((reference) => ({ reference, documentId: null, confidence: "none" as const }));
  }
}
