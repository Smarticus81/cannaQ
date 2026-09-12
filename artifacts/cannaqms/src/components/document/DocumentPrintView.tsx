import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";

// Formal, paper-style rendering of a controlled document, shown ONLY when printing
// (`hidden print:block`). It replaces the on-screen editor layout in the print
// output so the result reads like a real SOP — a bordered header block, numbered
// sections in strict template order, and an approvals table — with no editors,
// cards, or scrollbars. `doc` is passed in as a loose object because the print view
// reads several workflow/signature fields not in the generated document type.
type AnyDoc = Record<string, any>;
type Section = {
  id: number;
  sortOrder: number;
  kind: string;
  title: string;
  bodyMarkdown: string | null;
  data: {
    docs?: { documentId: number; note?: string; snapshotDocNumber?: string; snapshotTitle?: string }[];
    items?: { name: string; note?: string }[];
    roles?: { role: string; responsibility: string }[];
  } | null;
};
type DocOption = { id: number; docNumber: string; title: string };

// A retained copy of a past revision (document_revisions.content_snapshot). When one
// is supplied this component renders IT instead of the live document, so the same
// layout prints history and current alike — see RetainedRevisionDialog.
export type RetainedSnapshot = {
  header: AnyDoc;
  sections: Section[];
  process: {
    recipeId: number | null;
    recipeName: string | null;
    recipeVersion: number | null;
    steps: Array<{ id: number; stepNumber: number; description: string; template: string | null }>;
  } | null;
};

const SOP_ORDER = ["definitions", "associated_documents", "materials_equipment", "safety", "responsibilities", "procedure", "free_text"];
const KIND_TITLE: Record<string, string> = {
  definitions: "Definitions",
  associated_documents: "Associated Documents",
  materials_equipment: "Materials / Equipment",
  safety: "Safety",
  responsibilities: "Roles & Responsibilities",
  procedure: "Procedure",
  free_text: "Additional Information",
};

// Work Instructions and Specifications do not use the SOP template above. Their
// Document Body tab authors "Spec Sections" — the approved BATCH RECORD template
// (see DocumentSectionsPanel / BatchRecordSpecSections). Printing the document
// itself therefore prints the approved FORM, not filled data: the auto kinds carry
// no content until a batch executes against them, so they print their heading plus
// a marker. The procedure is the exception — it is read live from the linked
// recipe, because the recipe's steps ARE this document's steps (single source of
// truth; revising the recipe is a change to this controlled document).
const SPEC_KIND_TITLE: Record<string, string> = {
  header: "Batch Record Header",
  ingredients: "Ingredients & Materials",
  packaging: "Packaging & Labels",
  in_process_checks: "In-Process Checks",
  tests: "Tests",
  yield: "Yield",
  signoffs: "Sign-offs",
  process_steps: "Process Steps",
  room_environmental: "Room / Environmental",
  equipment: "Equipment",
  free_text: "Additional Information",
};
// Kinds whose content comes from the batch at execution — nothing to print here.
const SPEC_AUTO_KINDS = new Set(["header", "ingredients", "packaging", "in_process_checks", "tests", "yield", "signoffs"]);
const SPEC_TYPES = new Set(["Work Instruction", "Specification"]);

type ProcSteps = {
  recipeId: number | null;
  recipe: { id: number; productName: string; productType: string; version: number } | null;
  steps: Array<{ id: number; stepNumber: number; description: string; template: string | null }>;
};

function fmt(d: string | null | undefined): string {
  if (!d) return "—";
  try {
    return format(new Date(d.length === 10 ? d + "T00:00:00" : d), "MMM d, yyyy");
  } catch {
    return String(d);
  }
}

// Revision label for print, matching the on-screen scheme (major.minor):
//   released → `${major}.0`; in a change cycle (Draft / Under Review) → the draft
//   number `${major-1}.${reviewRound|1}` (stored revision holds the next major, so
//   the current draft's major is stored − 1).
function printRevision(doc: AnyDoc): string {
  const stored = Math.floor(parseFloat(String(doc?.revision ?? "1")) || 1);
  const reviewRound = Number(doc?.reviewRound ?? 0) || 0;
  const inCycle = doc?.status === "Draft" || doc?.status === "Under Review";
  if (inCycle) return `${Math.max(stored - 1, 0)}.${Math.max(reviewRound, 1)}`;
  return `${stored}.0`;
}

export function DocumentPrintView({
  doc: liveDoc,
  snapshot,
  supersededOn,
  supersededByRevision,
  capturedFrom,
  showOnScreen,
}: {
  doc: AnyDoc;
  /** Render this retained revision instead of the live document. */
  snapshot?: RetainedSnapshot;
  /** Date this revision stopped being in force, if it has been replaced. */
  supersededOn?: string | null;
  supersededByRevision?: string | null;
  /** "approval" (frozen by the signature) or "backfill" (captured later). */
  capturedFrom?: string | null;
  /** Render on screen as well as on paper. The document screen keeps this off — the
   *  formal layout is for printing there — but the retained-revision page IS the
   *  document, so it shows. */
  showOnScreen?: boolean;
}) {
  // Every field below reads from `doc`. Pointing that at the snapshot's header when
  // one is supplied means the whole layout renders history with no second code path.
  const doc: AnyDoc = (snapshot?.header as AnyDoc) ?? liveDoc;
  const docId = liveDoc?.id as number;
  const isSpec = SPEC_TYPES.has(String(doc?.documentType ?? ""));
  const { data: sections } = useQuery<Section[]>({
    queryKey: [`/api/documents/${docId}/sections`],
    queryFn: async () => (await fetch(`/api/documents/${docId}/sections`)).json(),
    enabled: !!docId && !snapshot,
  });
  const { data: allDocs } = useQuery<DocOption[]>({
    queryKey: ["/api/documents"],
    queryFn: async () => (await fetch("/api/documents")).json(),
    enabled: !snapshot,
  });
  // Live, not snapshotted — see the SPEC_KIND_TITLE note above.
  const { data: liveProc } = useQuery<ProcSteps>({
    queryKey: [`/api/documents/${docId}/process-steps`],
    queryFn: async () => (await fetch(`/api/documents/${docId}/process-steps`)).json(),
    enabled: !!docId && isSpec && !snapshot,
  });
  // A retained revision carries its own frozen steps; the live recipe may have moved on.
  const proc: ProcSteps | undefined = snapshot
    ? snapshot.process
      ? {
          recipeId: snapshot.process.recipeId,
          recipe: snapshot.process.recipeName
            ? {
                id: snapshot.process.recipeId ?? 0,
                productName: snapshot.process.recipeName,
                productType: "",
                version: snapshot.process.recipeVersion ?? 0,
              }
            : null,
          steps: snapshot.process.steps,
        }
      : { recipeId: null, recipe: null, steps: [] }
    : liveProc;

  const docsById = new Map((allDocs ?? []).map((d) => [d.id, d]));
  // Associated-document labels in a retained copy come from the snapshot the
  // approval froze, which is why the live document list is not needed here.
  const allSections: Section[] = snapshot ? snapshot.sections : (sections ?? []);
  const sops = allSections
    .filter((s) => SOP_ORDER.includes(s.kind))
    .sort((a, b) => SOP_ORDER.indexOf(a.kind) - SOP_ORDER.indexOf(b.kind) || a.id - b.id);
  // Spec sections have no canonical template order — they print in the order the
  // author arranged them on the Document Body tab.
  const specs = allSections.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  // Section numbering: Purpose = 1, Scope = 2, then each present SOP section.
  let n = 2;

  return (
    <div className={showOnScreen ? "block text-black" : "hidden print:block text-black"}>
      {/* Header block */}
      <div className="border-2 border-black">
        <div className="flex">
          <div className="flex-1 p-2 border-r-2 border-black">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-600">CannaQMS · Controlled Document</p>
            <p className="text-lg font-bold leading-tight mt-0.5">{doc.title}</p>
          </div>
          <table className="text-[10px] w-56">
            <tbody>
              <tr className="border-b border-black">
                <td className="px-2 py-0.5 font-semibold border-r border-black">Document #</td>
                <td className="px-2 py-0.5 font-mono">{doc.docNumber}</td>
              </tr>
              <tr className="border-b border-black">
                <td className="px-2 py-0.5 font-semibold border-r border-black">Type</td>
                <td className="px-2 py-0.5">{doc.documentType}</td>
              </tr>
              <tr className="border-b border-black">
                <td className="px-2 py-0.5 font-semibold border-r border-black">Revision</td>
                <td className="px-2 py-0.5 font-mono">{printRevision(doc)}</td>
              </tr>
              <tr>
                <td className="px-2 py-0.5 font-semibold border-r border-black">Status</td>
                <td className="px-2 py-0.5">{doc.status}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="flex border-t-2 border-black text-[10px]">
          <div className="flex-1 px-2 py-1 border-r border-black">
            <span className="font-semibold">Owner: </span>
            {doc.ownerName || "—"}
          </div>
          <div className="flex-1 px-2 py-1 border-r border-black">
            <span className="font-semibold">Effective: </span>
            {fmt(doc.effectiveDate)}
          </div>
          <div className="flex-1 px-2 py-1 border-r border-black">
            <span className="font-semibold">Next Review: </span>
            {fmt(doc.nextReviewDate ?? doc.reviewDate)}
          </div>
          <div className="flex-1 px-2 py-1">
            <span className="font-semibold">Printed: </span>
            {format(new Date(), "MMM d, yyyy")}
          </div>
        </div>
        {/* Procedure provenance — which process this document's steps are read from. */}
        {isSpec && (
          <div className="flex border-t border-black text-[10px]">
            <div className="flex-1 px-2 py-1">
              <span className="font-semibold">Linked Process: </span>
              {proc?.recipe ? `${proc.recipe.productName} (v${proc.recipe.version})` : "None linked"}
            </div>
          </div>
        )}
      </div>

      {/* Retained copy of a past revision. A printed history that looks like a live
          controlled document is worse than not printing one at all, so this band is
          not optional and carries the date the revision stopped being in force. */}
      {snapshot && (
        <div className="border-2 border-t-0 border-black px-2 py-1 text-center text-[10px] font-bold uppercase tracking-widest">
          {supersededOn
            ? `Superseded — for reference only · Rev ${doc.revision} was in force until ${fmt(supersededOn)}`
            : `Retained copy — Rev ${doc.revision} as approved`}
          {supersededByRevision ? ` · Replaced by Rev ${supersededByRevision}` : ""}
          {capturedFrom === "backfill" ? " · Captured at backfill, not at signature" : ""}
        </div>
      )}

      {/* Draft notice — a printed draft must never be mistaken for the effective version. */}
      {!snapshot && (doc.status === "Draft" || doc.status === "Under Review") && (() => {
        const stored = Math.floor(parseFloat(String(doc?.revision ?? "1")) || 1);
        const prior = stored >= 2 ? `${stored - 1}.0` : null;
        return (
          <div className="border-2 border-t-0 border-black px-2 py-1 text-center text-[10px] font-bold uppercase tracking-widest">
            Draft — Revision {printRevision(doc)} in progress · Not yet effective
            {prior ? ` · Supersedes approved Rev ${prior}` : ""}
          </div>
        );
      })()}

      {/* Body */}
      <div className="mt-4 space-y-3 text-[11pt] leading-relaxed">
        <PrintSection number={1} title="Purpose" text={doc.description} />
        <PrintSection number={2} title="Scope" text={doc.scope} />

        {!isSpec && sops.map((s) => {
          n += 1;
          if (s.kind === "associated_documents") {
            const links = s.data?.docs ?? [];
            return (
              <SectionShell key={s.id} number={n} title={KIND_TITLE[s.kind]}>
                {links.length ? (
                  <ul className="list-disc pl-6">
                    {links.map((l) => {
                      const o = docsById.get(l.documentId);
                      // Step 4 — the approved/printed record shows the referenced doc's
                      // number+title FROZEN as of this document's approval (the snapshot),
                      // falling back to the live values if none was captured.
                      const label = l.snapshotTitle
                        ? `${l.snapshotDocNumber ?? o?.docNumber ?? ""} — ${l.snapshotTitle}`
                        : o
                          ? `${o.docNumber} — ${o.title}`
                          : `Document #${l.documentId}`;
                      return (
                        <li key={l.documentId}>
                          {label}
                          {l.note ? ` (${l.note})` : ""}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-gray-500">None.</p>
                )}
              </SectionShell>
            );
          }
          if (s.kind === "responsibilities") {
            // Blank rows exist because the editor always shows at least two; they
            // are padding, not content, so they never reach the printed record.
            const roles = (s.data?.roles ?? []).filter((r) => r.role.trim() || r.responsibility.trim());
            return (
              <SectionShell key={s.id} number={n} title={KIND_TITLE[s.kind]}>
                {roles.length ? (
                  <table className="w-full text-[10pt] border border-black border-collapse">
                    <thead>
                      <tr className="border-b border-black bg-gray-100">
                        <th className="text-left px-2 py-1 border-r border-black w-1/3">Role</th>
                        <th className="text-left px-2 py-1">Responsibility</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roles.map((r, i) => (
                        <tr key={i} className={i === roles.length - 1 ? "" : "border-b border-black"}>
                          <td className="px-2 py-1 border-r border-black align-top">{r.role || "—"}</td>
                          <td className="px-2 py-1 align-top whitespace-pre-wrap">{r.responsibility || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-gray-500">None.</p>
                )}
              </SectionShell>
            );
          }
          if (s.kind === "materials_equipment") {
            const items = s.data?.items ?? [];
            return (
              <SectionShell key={s.id} number={n} title={KIND_TITLE[s.kind]}>
                {items.length ? (
                  <ul className="list-disc pl-6">
                    {items.map((it, i) => (
                      <li key={i}>
                        {it.name}
                        {it.note ? ` — ${it.note}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-gray-500">None.</p>
                )}
              </SectionShell>
            );
          }
          return <PrintSection key={s.id} number={n} title={s.title || KIND_TITLE[s.kind]} text={s.bodyMarkdown} />;
        })}

        {isSpec &&
          specs.map((s) => {
            n += 1;
            const title = s.title || SPEC_KIND_TITLE[s.kind] || s.kind;
            const notes =
              s.bodyMarkdown && s.bodyMarkdown.trim() ? (
                <p className="whitespace-pre-wrap mt-1">{s.bodyMarkdown}</p>
              ) : null;

            if (s.kind === "process_steps") {
              const steps = proc?.steps ?? [];
              return (
                <SectionShell key={s.id} number={n} title={title}>
                  {steps.length ? (
                    <ol className="list-decimal pl-6 space-y-0.5">
                      {steps.map((st) => (
                        <li key={st.id}>
                          <span className="font-semibold">{st.description}</span>
                          {st.template ? <span> — {st.template}</span> : null}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-gray-500">
                      {proc?.recipeId
                        ? "The linked process has no steps."
                        : "No linked process — no procedure to print."}
                    </p>
                  )}
                  {notes}
                </SectionShell>
              );
            }

            if (SPEC_AUTO_KINDS.has(s.kind)) {
              return (
                <SectionShell key={s.id} number={n} title={title}>
                  <p className="italic text-gray-600">Completed at execution — recorded on the batch record.</p>
                  {notes}
                </SectionShell>
              );
            }

            return <PrintSection key={s.id} number={n} title={title} text={s.bodyMarkdown} />;
          })}
      </div>

      {/* Approvals */}
      <div className="mt-6 break-inside-avoid">
        <p className="text-[12pt] font-bold border-b border-black pb-1 mb-2">Approvals</p>
        <table className="w-full text-[10pt] border border-black border-collapse">
          <thead>
            <tr className="border-b border-black bg-gray-100">
              <th className="text-left px-2 py-1 border-r border-black">Role</th>
              <th className="text-left px-2 py-1 border-r border-black">Name / Initials</th>
              <th className="text-left px-2 py-1 border-r border-black">Meaning</th>
              <th className="text-left px-2 py-1">Date</th>
            </tr>
          </thead>
          <tbody>
            <ApprovalRow role="Author" name={doc.createdByName} meaning="Authored" date={undefined} />
            <ApprovalRow
              role="Reviewer"
              name={doc.reviewerSignedName || doc.reviewerSignedInitials}
              meaning={doc.reviewerSignedMeaning}
              date={doc.reviewerSignedAt}
            />
            <ApprovalRow
              role="Approver"
              name={doc.approvedByName || doc.approverSignedInitials}
              meaning={doc.approverSignedMeaning}
              date={doc.approvalDate}
              last
            />
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SectionShell({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <div className="break-inside-avoid">
      <p className="text-[12pt] font-bold border-b border-black pb-0.5 mb-1">
        {number}. {title}
      </p>
      {children}
    </div>
  );
}

function PrintSection({ number, title, text }: { number: number; title: string; text: string | null | undefined }) {
  return (
    <SectionShell number={number} title={title}>
      {text && text.trim() ? (
        <p className="whitespace-pre-wrap">{text}</p>
      ) : (
        <p className="text-gray-500">—</p>
      )}
    </SectionShell>
  );
}

function ApprovalRow({
  role,
  name,
  meaning,
  date,
  last,
}: {
  role: string;
  name?: string | null;
  meaning?: string | null;
  date?: string | null;
  last?: boolean;
}) {
  return (
    <tr className={last ? "" : "border-b border-black"}>
      <td className="px-2 py-1 border-r border-black font-semibold align-top">{role}</td>
      <td className="px-2 py-1 border-r border-black align-top">{name || "—"}</td>
      <td className="px-2 py-1 border-r border-black align-top">{meaning || "—"}</td>
      <td className="px-2 py-1 align-top">{date ? fmt(date) : "—"}</td>
    </tr>
  );
}
