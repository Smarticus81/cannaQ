import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";

type Section = {
  id: number;
  sortOrder: number;
  kind: string;
  title: string;
  bodyMarkdown: string | null;
};
type ProcessStepSnap = {
  id: number;
  stepNumber: number;
  sortOrder: number;
  description: string;
  template: string | null;
};
type SpecSnapshot = {
  spec: {
    id: number;
    docNumber: string;
    title: string;
    revision: string;
    approvedByName: string | null;
    approvalDate: string | null;
  } | null;
  sections: Section[];
  // Session 61 — snapshotted recipe process steps when the linked doc is a WI
  // backed by a recipe (the "ran against revision X" procedure provenance).
  processSteps: ProcessStepSnap[];
  revisionAtLink: string | null;
  linkedAt: string | null;
};
type Batch = {
  id: number;
  batchNumber: string;
  productName: string;
  productType: string;
  strainName: string | null;
  outputQuantity: number | null;
  unitOfMeasure: string | null;
  metrcPackageId: string | null;
  productionDate: string | null;
  approvalName: string | null;
  approvalInitials: string | null;
  approvalDate: string | null;
};
type Ingredient = {
  id: number;
  ingredientName: string;
  plannedQuantity: number | null;
  actualQuantity: number | null;
  unitOfMeasure: string;
  lotNumber: string | null;
  kind: string;
  /** Catalog item type (joined from inventory_items) — "Label" routes the line to Packaging. */
  itemType?: string | null;
};

// Session 112 (2026-08-17) — the printed batch record splits its material lines
// the same way the batch screen's tabs do, so the record reads in the order the
// work happens: food and production materials are weighed out up front, while
// packaging and the compliance label are consumed at the packaging stage.
//
// Compliance labels ride in the Packaging section. That holds for Michigan,
// where one label lot covers the run. A state that can change label lot partway
// through a batch (e.g. Illinois) needs a per-unit-range model, not a single
// line — revisit when that state is in scope.
const isPackagingLine = (i: Ingredient): boolean =>
  i.kind === "Packaging" || /label/i.test(String(i.itemType ?? ""));

/** Shared line table for the Ingredients and Packaging sections — same columns,
 *  different slice of the batch's lines, so the two read as one record. */
function MaterialLinesTable({ rows }: { rows: Ingredient[] }) {
  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="border-b">
          <th className="text-left py-1 pr-2">Name</th>
          <th className="text-left py-1 pr-2">Type</th>
          <th className="text-right py-1 pr-2">Planned</th>
          <th className="text-right py-1 pr-2">Actual</th>
          <th className="text-left py-1 pr-2">UoM</th>
          <th className="text-left py-1">Lot #</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((i) => (
          <tr key={i.id} className="border-b">
            <td className="py-1 pr-2">{i.ingredientName}</td>
            <td className="py-1 pr-2">{/label/i.test(String(i.itemType ?? "")) ? "Label" : i.kind}</td>
            <td className="py-1 pr-2 text-right">{i.plannedQuantity ?? "—"}</td>
            <td className="py-1 pr-2 text-right">{i.actualQuantity ?? "—"}</td>
            <td className="py-1 pr-2">{i.unitOfMeasure}</td>
            <td className="py-1">{i.lotNumber ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
type TestResult = {
  id: number;
  testingAgency: string;
  testResult: string;
  thcPct: number | null;
  cbdPct: number | null;
  totalCannabinoids: number | null;
  microbialsPass: boolean | null;
  pesticidesPass: boolean | null;
  heavyMetalsPass: boolean | null;
  residualSolventsPass: boolean | null;
  resultDate: string | null;
};
type ChecklistResp = {
  id: number;
  checklistItemId: number;
  response: string;
  notes: string | null;
  respondedByName: string | null;
};
type ChecklistItem = { id: number; itemNumber: number; itemText: string; regulationRef: string };

/**
 * Renders the linked Specification's structured sections in the print view.
 * Auto-kind sections pull live data from the batch; free-text / environmental /
 * equipment kinds render the spec's bodyMarkdown verbatim. Hidden on screen
 * (`hidden print:block`) — only appears in the printed Batch Record output.
 */
export function BatchRecordSpecSections({
  batch,
  ingredients,
  testResults,
}: {
  batch: Batch;
  ingredients: Ingredient[] | undefined;
  testResults: TestResult[] | undefined;
}) {
  const { data: snapshot } = useQuery<SpecSnapshot>({
    queryKey: [`/api/batch-records/${batch.id}/spec-snapshot`],
    queryFn: async () => (await fetch(`/api/batch-records/${batch.id}/spec-snapshot`)).json(),
  });

  if (!snapshot?.spec || (snapshot.sections ?? []).length === 0) return null;

  return (
    <div className="hidden print:block mt-8 space-y-6">
      <div className="border-b pb-2">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Per Specification</p>
        <p className="text-sm font-semibold">
          {snapshot.spec.docNumber} — {snapshot.spec.title} (Rev {snapshot.revisionAtLink ?? snapshot.spec.revision})
        </p>
      </div>
      {snapshot.sections.map((s) => (
        <SpecSectionRender
          key={s.id}
          section={s}
          batch={batch}
          ingredients={ingredients}
          testResults={testResults}
          processSteps={snapshot.processSteps ?? []}
          spec={snapshot.spec!}
        />
      ))}
    </div>
  );
}

function SpecSectionRender({
  section, batch, ingredients, testResults, processSteps, spec,
}: {
  section: Section;
  batch: Batch;
  ingredients: Ingredient[] | undefined;
  testResults: TestResult[] | undefined;
  processSteps: ProcessStepSnap[];
  spec: NonNullable<SpecSnapshot["spec"]>;
}) {
  return (
    <section className="page-break-inside-avoid space-y-2">
      <h2 className="text-base font-bold border-b pb-1">{section.title}</h2>
      {renderKindContent(section.kind, batch, ingredients, testResults, processSteps, spec)}
      {section.bodyMarkdown && (
        <div className="text-sm whitespace-pre-wrap pt-2">{section.bodyMarkdown}</div>
      )}
    </section>
  );
}

function fmtDate(d: string | null | undefined) {
  if (!d) return "—";
  try { return format(new Date(d.length === 10 ? d + "T00:00:00" : d), "PP"); } catch { return d; }
}

function passLabel(v: boolean | null | undefined) {
  if (v === true) return "Pass";
  if (v === false) return "FAIL";
  return "—";
}

function renderKindContent(
  kind: string,
  batch: Batch,
  ingredients: Ingredient[] | undefined,
  testResults: TestResult[] | undefined,
  processSteps: ProcessStepSnap[],
  spec: NonNullable<SpecSnapshot["spec"]>,
) {
  switch (kind) {
    case "header":
      return (
        <table className="w-full text-sm">
          <tbody>
            <tr><td className="font-semibold pr-3 py-0.5 w-1/3">Batch No.</td><td>{batch.batchNumber}</td></tr>
            <tr><td className="font-semibold pr-3 py-0.5">Product</td><td>{batch.productName}</td></tr>
            <tr><td className="font-semibold pr-3 py-0.5">Type</td><td>{batch.productType}</td></tr>
            <tr><td className="font-semibold pr-3 py-0.5">Strain / Flavor</td><td>{batch.strainName || "—"}</td></tr>
            <tr><td className="font-semibold pr-3 py-0.5">Production Date</td><td>{fmtDate(batch.productionDate)}</td></tr>
            <tr><td className="font-semibold pr-3 py-0.5">METRC Package</td><td>{batch.metrcPackageId || "—"}</td></tr>
            <tr><td className="font-semibold pr-3 py-0.5">Specification</td><td>{spec.docNumber} (Rev {spec.revision}) — snapshot at link</td></tr>
          </tbody>
        </table>
      );
    // Ingredients + Materials — what's weighed out and consumed during
    // manufacturing. Mirrors the batch screen's Ingredients tab.
    case "ingredients": {
      const rows = (ingredients ?? []).filter((i) => !isPackagingLine(i));
      if (rows.length === 0) return <p className="text-sm text-muted-foreground">No ingredients recorded.</p>;
      return <MaterialLinesTable rows={rows} />;
    }
    // Session 112 — Packaging (and the compliance label) — consumed at the
    // packaging stage, not at weigh-out. Mirrors the Packaging tab.
    case "packaging": {
      const rows = (ingredients ?? []).filter(isPackagingLine);
      if (rows.length === 0) return <p className="text-sm text-muted-foreground">No packaging or label lots recorded.</p>;
      return <MaterialLinesTable rows={rows} />;
    }
    case "in_process_checks":
      return <ChecklistContent batchId={batch.id} />;
    case "tests": {
      if (!testResults || testResults.length === 0) return <p className="text-sm text-muted-foreground">No test results recorded.</p>;
      return (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b">
              <th className="text-left py-1 pr-2">Lab</th>
              <th className="text-left py-1 pr-2">Result</th>
              <th className="text-right py-1 pr-2">THC %</th>
              <th className="text-right py-1 pr-2">CBD %</th>
              <th className="text-left py-1 pr-2">Microbials</th>
              <th className="text-left py-1 pr-2">Pesticides</th>
              <th className="text-left py-1 pr-2">Heavy Metals</th>
              <th className="text-left py-1 pr-2">Solvents</th>
              <th className="text-left py-1">Date</th>
            </tr>
          </thead>
          <tbody>
            {testResults.map((t) => (
              <tr key={t.id} className="border-b">
                <td className="py-1 pr-2">{t.testingAgency}</td>
                <td className="py-1 pr-2 font-semibold">{t.testResult}</td>
                <td className="py-1 pr-2 text-right">{t.thcPct ?? "—"}</td>
                <td className="py-1 pr-2 text-right">{t.cbdPct ?? "—"}</td>
                <td className="py-1 pr-2">{passLabel(t.microbialsPass)}</td>
                <td className="py-1 pr-2">{passLabel(t.pesticidesPass)}</td>
                <td className="py-1 pr-2">{passLabel(t.heavyMetalsPass)}</td>
                <td className="py-1 pr-2">{passLabel(t.residualSolventsPass)}</td>
                <td className="py-1">{fmtDate(t.resultDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "yield": {
      const planned = ingredients?.reduce((sum, i) => sum + (i.plannedQuantity ?? 0), 0) ?? 0;
      const actual  = ingredients?.reduce((sum, i) => sum + (i.actualQuantity  ?? 0), 0) ?? 0;
      const out = batch.outputQuantity ?? 0;
      const yieldPct = actual > 0 ? ((out / actual) * 100).toFixed(1) : "—";
      return (
        <table className="w-full text-sm">
          <tbody>
            <tr><td className="font-semibold pr-3 py-0.5 w-1/3">Total Planned Input</td><td>{planned || "—"}</td></tr>
            <tr><td className="font-semibold pr-3 py-0.5">Total Actual Input</td><td>{actual || "—"}</td></tr>
            <tr><td className="font-semibold pr-3 py-0.5">Output Quantity</td><td>{out || "—"} {batch.unitOfMeasure ?? ""}</td></tr>
            <tr><td className="font-semibold pr-3 py-0.5">Yield (output / actual)</td><td>{yieldPct === "—" ? "—" : `${yieldPct}%`}</td></tr>
          </tbody>
        </table>
      );
    }
    case "signoffs":
      return (
        <table className="w-full text-sm">
          <tbody>
            <tr>
              <td className="font-semibold pr-3 py-0.5 w-1/3">Spec Approved By</td>
              <td>{spec.approvedByName ?? "—"} {spec.approvalDate ? `(${fmtDate(spec.approvalDate)})` : ""}</td>
            </tr>
            <tr>
              <td className="font-semibold pr-3 py-0.5">Batch Released By</td>
              <td>
                {batch.approvalName ?? "—"}
                {batch.approvalInitials ? ` [${batch.approvalInitials}]` : ""}
                {batch.approvalDate ? ` on ${fmtDate(batch.approvalDate)}` : ""}
              </td>
            </tr>
          </tbody>
        </table>
      );
    case "process_steps": {
      // Session 61 — the snapshotted procedure (recipe process steps) the batch
      // ran against, frozen at link time (Part 11 provenance).
      if (!processSteps || processSteps.length === 0)
        return <p className="text-sm text-muted-foreground">No process steps in the linked procedure.</p>;
      return (
        <ol className="list-decimal pl-5 space-y-1 text-sm">
          {processSteps.map((s) => (
            <li key={s.id}>
              <span className="font-semibold">{s.description}</span>
              {s.template ? <span> — {s.template}</span> : null}
            </li>
          ))}
        </ol>
      );
    }
    case "room_environmental":
    case "equipment":
    case "free_text":
      // bodyMarkdown rendered by parent — nothing to add here.
      return null;
    default:
      return null;
  }
}

function ChecklistContent({ batchId }: { batchId: number }) {
  const { data } = useQuery<{ items: ChecklistItem[]; responses: ChecklistResp[] }>({
    queryKey: [`/api/batch-records/${batchId}/checklist-detail`],
    queryFn: async () => {
      const res = await fetch(`/api/batch-records/${batchId}/checklist-detail`);
      if (!res.ok) return { items: [], responses: [] };
      return res.json();
    },
  });
  const items = data?.items ?? [];
  const responses = data?.responses ?? [];
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No in-process checklist for this batch.</p>;
  const respMap = new Map(responses.map(r => [r.checklistItemId, r]));
  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="border-b">
          <th className="text-left py-1 pr-2 w-10">#</th>
          <th className="text-left py-1 pr-2">Check</th>
          <th className="text-left py-1 pr-2">Reg</th>
          <th className="text-left py-1 pr-2">Response</th>
          <th className="text-left py-1">By</th>
        </tr>
      </thead>
      <tbody>
        {items.map(it => {
          const r = respMap.get(it.id);
          return (
            <tr key={it.id} className="border-b align-top">
              <td className="py-1 pr-2">{it.itemNumber}</td>
              <td className="py-1 pr-2">{it.itemText}</td>
              <td className="py-1 pr-2 text-xs">{it.regulationRef}</td>
              <td className="py-1 pr-2">{r?.response ?? "—"}{r?.notes ? ` — ${r.notes}` : ""}</td>
              <td className="py-1">{r?.respondedByName ?? "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
