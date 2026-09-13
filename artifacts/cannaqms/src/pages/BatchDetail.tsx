import { useState, useEffect, useMemo } from "react";
import {
  useGetBatchRecord,
  useUpdateBatchRecord,
  useListBatchIngredients,
  useCreateBatchIngredient,
  useUpdateBatchIngredient,
  useDeleteBatchIngredient,
  useListBatchTestResults,
  useCreateBatchTestResult,
  useUpdateBatchTestResult,
  useGetBatchLabeling,
  useApproveBatchLabeling,
  useReleaseBatch,
  useGetCurrentUser,
  useGetCompanyProfile,
  useListNonConformances,
  useListComplaints,
  useListSuppliers,
  useListAuditLog,
  useListInventoryItems,
  getGetBatchRecordQueryKey,
  getGetBatchLabelingQueryKey,
  getListBatchIngredientsQueryKey,
  getListBatchTestResultsQueryKey,
  getListInventoryItemsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { accentClass, toneBatchStatus, BATCH_STATE_LABELS, BATCH_STATE_LABELS_SHORT } from "@/lib/status";
import { convertQuantity, areCompatible, roundQty, BOM_KINDS, BOM_KIND_LABELS, isPackagingStageKind } from "@/lib/units";
import { panelSetFor, panelsForProduct, panelPass, resultValueKey, type ResolvedRules } from "@/lib/safetyPanels";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Link } from "wouter";
import { format } from "date-fns";
import { formatDateOnly } from "@/lib/utils";
import {
  Printer, CheckCircle2, XCircle, Clock, AlertTriangle,
  FlaskConical, Tag, ShieldCheck, FileText, ExternalLink,
  Plus, Trash2, Pencil, ArrowRight, PauseCircle, SkipForward,
  PackageCheck, PlayCircle, Ban, Paperclip, ChevronsUpDown, Check,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { LogNonConformanceDialog } from "@/components/dialogs/LogNonConformanceDialog";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { LabelDataPanel } from "@/components/batch/LabelDataPanel";
import { LinkedSpecPanel } from "@/components/batch/LinkedSpecPanel";
import { BatchManifestPanel } from "@/components/batch/BatchManifestPanel";
import { BatchRecordSpecSections } from "@/components/batch/BatchRecordSpecSections";
import { TermTip } from "@/components/ui/TermTip";
import { ConfirmFinishedGoodsDialog } from "@/components/batch/ConfirmFinishedGoodsDialog";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { changedFieldNames } from "@/components/audit/AuditDiff";

// 2026-09-07 — both maps moved to lib/status.ts. This page and the Batches list
// each kept their own and they had drifted: the same batch read "Released" on
// the list and "Final Form" here.
const STATE_LABELS = BATCH_STATE_LABELS;
const STATE_LABELS_SHORT = BATCH_STATE_LABELS_SHORT;

const LIFECYCLE: string[] = [
  "in_production",
  "testing_in_progress",
  "passed_awaiting_packaging",
  "released_to_inventory",
  "finished_goods",
];

const TERMINAL_STATES = new Set(["failed", "destroyed", "finished_goods"]);

interface TransitionDef {
  label: string;
  nextState: string;
  variant: "default" | "outline" | "destructive";
  icon: React.ReactNode;
  description: string;
}

const STATE_TRANSITIONS: Record<string, TransitionDef[]> = {
  in_production: [
    {
      label: "Send to Testing Lab",
      nextState: "testing_in_progress",
      variant: "default",
      icon: <FlaskConical className="h-4 w-4" />,
      description: "Samples have been pulled and submitted to a licensed Michigan laboratory.",
    },
    {
      label: "Place on Hold",
      nextState: "on_hold",
      variant: "outline",
      icon: <PauseCircle className="h-4 w-4" />,
      description: "Pause production pending investigation or corrective action.",
    },
  ],
  testing_in_progress: [
    {
      label: "Mark Test Passed",
      nextState: "passed_awaiting_packaging",
      variant: "default",
      icon: <CheckCircle2 className="h-4 w-4" />,
      description: "Test results meet all Michigan CRA R 420.305 requirements. Batch cleared for packaging.",
    },
    {
      label: "Mark Test Failed",
      nextState: "failed",
      variant: "destructive",
      icon: <XCircle className="h-4 w-4" />,
      description: "Test results did not meet requirements. A Non-Conformance record is recommended.",
    },
    {
      label: "Place on Hold",
      nextState: "on_hold",
      variant: "outline",
      icon: <PauseCircle className="h-4 w-4" />,
      description: "Pause pending re-test submission or investigation.",
    },
  ],
  passed_awaiting_packaging: [
    {
      label: "Place on Hold",
      nextState: "on_hold",
      variant: "outline",
      icon: <PauseCircle className="h-4 w-4" />,
      description: "Hold batch before packaging proceeds.",
    },
    {
      label: "Mark Failed",
      nextState: "failed",
      variant: "destructive",
      icon: <Ban className="h-4 w-4" />,
      description: "Reject batch after packaging inspection failure.",
    },
  ],
  on_hold: [
    {
      label: "Resume Production",
      nextState: "in_production",
      variant: "default",
      icon: <PlayCircle className="h-4 w-4" />,
      description: "Hold resolved — return batch to active production.",
    },
    {
      label: "Send to Testing",
      nextState: "testing_in_progress",
      variant: "outline",
      icon: <SkipForward className="h-4 w-4" />,
      description: "Hold resolved — proceed directly to lab testing.",
    },
    {
      label: "Mark Failed",
      nextState: "failed",
      variant: "destructive",
      icon: <XCircle className="h-4 w-4" />,
      description: "Permanently fail this batch.",
    },
    {
      label: "Destroy Batch",
      nextState: "destroyed",
      variant: "destructive",
      icon: <Trash2 className="h-4 w-4" />,
      description: "Record destruction per Michigan CRA R 420.208.",
    },
  ],
  released_to_inventory: [
    {
      label: "Group / Ship Units",
      nextState: "finished_goods",
      variant: "default",
      icon: <PackageCheck className="h-4 w-4" />,
      description: "Create METRC packages for units. Package a portion to keep selling (stays Bulk — Released), or finalize production to close the batch (In Fulfillment).",
    },
  ],
};

// R 420.304(2)(e) — how many UNITS a laboratory must take from a production
// batch of infused product. (2)(d) covers concentrate instead: increments of
// 0.25 g, 12 of them for a 1-2 lb batch rising to 29 above 10 lb. The lab does
// the taking; we show the number so the operator can check what left the floor.
function requiredSampleUnits(units: number | null | undefined): number | null {
  if (units == null || !Number.isFinite(units) || units <= 0) return null;
  if (units <= 100) return 2;
  if (units <= 500) return 4;
  if (units <= 1000) return 6;
  if (units <= 5000) return 8;
  if (units <= 10000) return 10;
  return 12;
}

// Session 82 — single source of truth for "does this product type follow
// CONCENTRATE testing rules." Drives the analyte panel on both the test DISPLAY
// and the test ENTRY form so they can't drift. MI classifies infused/compound
// pre-rolls as concentrates (bulletin 9/19/2022), so they match here even though
// their productType reads "...Pre-Roll". Bare "infused" is avoided so a future
// infused EDIBLE wouldn't accidentally qualify.
function isConcentrateType(productType: string | null | undefined): boolean {
  const t = String(productType ?? "").toLowerCase();
  return /concentrate|vape|cartridge|distillate|extract|rosin|resin/.test(t) || /infused\s*pre-?roll/.test(t);
}

// Session 97 — derive the unit count from a numeric METRC tag range. METRC tags
// are a fixed prefix + a numeric counter; the count is (endCounter − startCounter
// + 1). Returns "" when the bounds aren't a clean numeric range. Mirrors the
// server-side rangeContainment prefix logic.
function deriveTagCount(startRaw: string, endRaw: string): string {
  let S = (startRaw ?? "").trim().toUpperCase();
  let E = (endRaw ?? "").trim().toUpperCase();
  if (!S || !E) return "";
  if (S > E) { const t = S; S = E; E = t; }
  let p = 0;
  const maxP = Math.min(S.length, E.length);
  while (p < maxP && S[p] === E[p]) p++;
  const sSuf = S.slice(p), eSuf = E.slice(p);
  if (/^[0-9]+$/.test(sSuf) && /^[0-9]+$/.test(eSuf)) {
    const a = Number(sSuf), b = Number(eSuf);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return String(b - a + 1);
  }
  return "";
}
// Vape-only analytes (MCT oil / cutting agent).
function isVapeType(productType: string | null | undefined): boolean {
  return /vape|cartridge/.test(String(productType ?? "").toLowerCase());
}

const DUAL_CHAMBER_PRODUCT_TYPE = "Dual Chamber Vape Cartridge";

// A batch_testing row, narrowed to the fields the dual-chamber panel needs
// (including the new `chamber` column, which the generated client type predates).
type ChamberTestRow = {
  id: number;
  chamber: string | null;
  sequenceNumber: number;
  testResult: string;
  testingAgency: string | null;
  resultDate: string | null;
  sampleMetrcTag: string | null;
  verifiedAt: string | null;
};
type TestingLabOpt = { id: number; supplierName?: string; name?: string };

// Dual Chamber Vape Cartridge final-form testing (CRA MI_IB_0114). The recipe's
// chamber config decides how many test GROUPS this product needs:
//   same oil → 1 · two oils → 2 (A, B) · two oils + combined draw → 3 (adds C).
// Each group must pass; a group that ever FAILS needs TWO passing retests before
// it clears (bulletin remediation rule). All groups cleared → "Test Passed".
function DualChamberTestingPanel({
  batchId, recipeId, tests, testingLabs, isTerminal, onChanged,
}: {
  batchId: number;
  recipeId: number | null;
  tests: ChamberTestRow[];
  testingLabs: TestingLabOpt[];
  isTerminal: boolean;
  onChanged: () => void;
}) {
  const { data: recipeCfg } = useQuery<{ dualChamberTwoOils: boolean | null; dualChamberCombinedDraw: boolean | null } | null>({
    queryKey: [`/api/recipes/${recipeId}`, "dual-chamber-cfg"],
    queryFn: async () => {
      if (!recipeId) return null;
      const res = await fetch(`/api/recipes/${recipeId}`);
      if (!res.ok) return null;
      return res.json().catch(() => null);
    },
    enabled: !!recipeId,
  });

  const twoOils = recipeCfg?.dualChamberTwoOils === true;
  const combined = recipeCfg?.dualChamberCombinedDraw === true;
  const configKnown = !!recipeCfg && recipeCfg.dualChamberTwoOils != null;

  const chambers: Array<{ code: string; label: string }> = !configKnown
    ? [{ code: "A", label: "Chamber A" }, { code: "B", label: "Chamber B" }, { code: "C", label: "Combined draw (Chamber C)" }]
    : !twoOils
      ? [{ code: "A", label: "Single test (same oil in both chambers)" }]
      : combined
        ? [{ code: "A", label: "Chamber A" }, { code: "B", label: "Chamber B" }, { code: "C", label: "Combined draw (Chamber C)" }]
        : [{ code: "A", label: "Chamber A" }, { code: "B", label: "Chamber B" }];

  function statusFor(code: string): { state: "passed" | "failed" | "pending"; passes: number; required: number } {
    const rows = tests
      .filter((t) => (t.chamber ?? null) === code && (t.testResult === "Pass" || t.testResult === "Fail"));
    if (rows.length === 0) return { state: "pending", passes: 0, required: 1 };
    const lastFailSeq = rows.filter((r) => r.testResult === "Fail").reduce((m, r) => Math.max(m, r.sequenceNumber ?? 0), -1);
    const hasFailed = lastFailSeq >= 0;
    const passesSinceFail = rows.filter((r) => r.testResult === "Pass" && (r.sequenceNumber ?? 0) > lastFailSeq).length;
    const required = hasFailed ? 2 : 1;
    if (passesSinceFail >= required) return { state: "passed", passes: passesSinceFail, required };
    if (hasFailed) return { state: "failed", passes: passesSinceFail, required };
    return { state: "pending", passes: 0, required };
  }

  const statuses = chambers.map((c) => ({ ...c, ...statusFor(c.code) }));
  const allPassed = statuses.length > 0 && statuses.every((s) => s.state === "passed");
  const anyFailed = statuses.some((s) => s.state === "failed");
  const overall = allPassed ? "Test Passed" : anyFailed ? "Retesting required" : "Testing in progress";

  return (
    <Card className={allPassed ? "border-emerald-300" : anyFailed ? "border-destructive/40" : "border-violet-200"}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2"><FlaskConical className="h-4 w-4" /> Dual Chamber Testing</CardTitle>
          <Badge variant="outline" className={allPassed ? "border-emerald-300 text-emerald-700" : anyFailed ? "bg-destructive/10 text-destructive border-destructive/30" : "border-violet-300 text-violet-700"}>{overall}</Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          CRA MI_IB_0114 — each chamber is tested individually{combined ? ", plus the combined draw" : ""}. A chamber that fails needs two passing retests before it clears.
        </p>
        {!configKnown && (
          <p className="text-xs text-amber-600 mt-1">Set the chamber setup on this batch's recipe to define exactly which tests are required — showing all three for now.</p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {statuses.map((s) => (
          <DualChamberRow
            key={s.code}
            batchId={batchId}
            chamber={s}
            rows={tests.filter((t) => (t.chamber ?? null) === s.code)}
            testingLabs={testingLabs}
            isTerminal={isTerminal}
            onChanged={onChanged}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function DualChamberRow({ batchId, chamber, rows, testingLabs, isTerminal, onChanged }: {
  batchId: number;
  chamber: { code: string; label: string; state: "passed" | "failed" | "pending"; passes: number; required: number };
  rows: ChamberTestRow[];
  testingLabs: TestingLabOpt[];
  isTerminal: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState("Pass");
  const [agencyId, setAgencyId] = useState("");
  const [resultDate, setResultDate] = useState("");
  const [sampleTag, setSampleTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const badge = chamber.state === "passed"
    ? <Badge variant="outline" className="border-emerald-300 text-emerald-700">Passed</Badge>
    : chamber.state === "failed"
      ? <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30">Failed — {chamber.passes}/{chamber.required} passing retests</Badge>
      : <Badge variant="outline" className="text-muted-foreground">Pending</Badge>;

  async function add() {
    // The lab is required — the batch_testing.testing_agency column is NOT NULL,
    // and picking a lab is what fills it (server mirrors the supplier name).
    if (!agencyId) { setErr("Select a testing lab."); return; }
    setBusy(true); setErr("");
    try {
      const res = await fetch(`/api/batch-records/${batchId}/testing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          chamber: chamber.code,
          phase: "result",
          testResult: result,
          testingAgencyId: Number(agencyId),
          resultDate: resultDate || undefined,
          submittedDate: resultDate || undefined,
          sampleMetrcTag: sampleTag || undefined,
        }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? "Save failed");
      }
      setOpen(false); setResult("Pass"); setAgencyId(""); setResultDate(""); setSampleTag(""); setErr("");
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "Save failed"); }
    finally { setBusy(false); }
  }

  const sortedRows = rows.filter((r) => r.testResult === "Pass" || r.testResult === "Fail")
    .slice().sort((a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0));

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{chamber.label}</span>
          {badge}
        </div>
        {!isTerminal && (
          <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>{open ? "Cancel" : "Add result"}</Button>
        )}
      </div>

      {sortedRows.length > 0 && (
        <div className="mt-2 space-y-1">
          {sortedRows.map((r) => (
            <div key={r.id} className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
              <span className={r.testResult === "Fail" ? "text-destructive font-medium" : "text-emerald-700 font-medium"}>{r.testResult}</span>
              <span>· {r.testingAgency ?? "—"}</span>
              {r.resultDate && <span>· {r.resultDate}</span>}
              {r.verifiedAt && <span>· verified</span>}
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <Label className="text-xs text-muted-foreground">Result</Label>
            <Select value={result} onValueChange={setResult}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="Pass">Pass</SelectItem>
                <SelectItem value="Fail">Fail</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Testing lab *</Label>
            <Select value={agencyId} onValueChange={(v) => { setAgencyId(v); setErr(""); }}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {testingLabs.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.supplierName ?? l.name ?? `Lab ${l.id}`}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Result date</Label>
            <Input type="date" value={resultDate} onChange={(e) => setResultDate(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Sample Metrc tag (optional)</Label>
            <Input value={sampleTag} onChange={(e) => setSampleTag(e.target.value)} placeholder="1A4..." />
          </div>
          <div className="sm:col-span-2 flex items-center justify-end gap-3">
            {err && <span className="text-xs text-destructive">{err}</span>}
            <Button size="sm" onClick={add} disabled={busy || !agencyId}>{busy ? "Saving…" : "Save result"}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PassBadge({ pass, label }: { pass: boolean | null | undefined; label: string }) {
  if (pass === null || pass === undefined)
    return <span className="inline-flex items-center gap-1 text-sm text-muted-foreground"><Clock className="h-3.5 w-3.5" />Pending</span>;
  return pass
    ? <span className="inline-flex items-center gap-1 text-sm text-emerald-700 font-medium"><CheckCircle2 className="h-3.5 w-3.5" />{label} Pass</span>
    : <span className="inline-flex items-center gap-1 text-sm text-destructive font-medium"><XCircle className="h-3.5 w-3.5" />{label} FAIL</span>;
}

export default function BatchDetail(props: { params?: { id: string } }) {
  const id = parseInt(props.params?.id ?? "0");

  const { data: batch, isLoading } = useGetBatchRecord(id);
  const { data: ingredients } = useListBatchIngredients(id);
  const { data: testResults } = useListBatchTestResults(id);
  const { data: labeling } = useGetBatchLabeling(id);
  const { data: currentUser } = useGetCurrentUser();
  // Facility identity for the printed batch record header/footer. Pulled from
  // the company profile (Settings → Company) so each client's controlled
  // document shows THEIR facility + state license, never a hardcoded one.
  const { data: company } = useGetCompanyProfile();
  const facilityName = company?.companyName?.trim() || "—";
  const facilityLicense = company?.licenseNumber?.trim() || "";
  const { data: allNCs } = useListNonConformances();
  const { data: allComplaints } = useListComplaints();
  const { data: auditLog } = useListAuditLog({ tableName: "batch_records", rowId: id, limit: 25 });

  // Session 67 (Item 5) — R 420.504 labeling checklist, completed inline on the
  // Labeling tab. Approval is gated on every required item being Pass or N/A.
  type ChecklistItemRow = { id: number; itemNumber: number; itemText: string; regulationRef: string; required: string | boolean };
  type ChecklistRespRow = { checklistItemId: number; response: string | null; notes: string | null; respondedByName: string | null };
  const checklistDetailKey = [`/api/batch-records/${id}/checklist-detail`];
  // Phase 5 — WHICH safety panels this facility's state requires. The list used
  // to be typed into this file; it now comes from the state's own rule set.
  // panelSetFor() falls back to Michigan's original list if this never loads,
  // so the tab cannot render an empty safety section.
  const { data: resolvedRules } = useQuery<ResolvedRules>({
    queryKey: ["regulatory-config", "resolved"],
    queryFn: async () => {
      const r = await fetch("/api/regulatory-config/resolved", { credentials: "include" });
      if (!r.ok) return null;
      return r.json().catch(() => null);
    },
  });

  const { data: checklistDetail } = useQuery<{
    items: ChecklistItemRow[];
    responses: ChecklistRespRow[];
    // Label-control step 2 — what the approved packaging carries, so a shorter
    // checklist can be read as coverage rather than as a shorter rule.
    covered?: { key: string; itemText: string; regulationRef: string }[];
    notApplicable?: { key: string; itemText: string; regulationRef: string }[];
    coveringDesigns?: { id: number; designName: string; version: string }[];
    // Label-control step 4 — and what the product's one approved LABEL carries.
    // Reported apart from the packaging list so the record says WHICH artefact
    // discharges each requirement, not merely that something did.
    coveredByLabel?: { key: string; itemText: string; regulationRef: string }[];
    coveringTemplates?: { id: number; name: string; version: number }[];
    staleArtwork?: {
      kind: "packaging" | "label";
      id: number;
      name: string;
      version: string;
      keys: string[];
      recipeChangedAt: string;
      howToClear: string;
    }[];
  }>({
    queryKey: checklistDetailKey,
    queryFn: async () => {
      const r = await fetch(`/api/batch-records/${id}/checklist-detail`, { credentials: "include" });
      if (!r.ok) return { items: [], responses: [] };
      return r.json();
    },
  });
  const checklistItems = checklistDetail?.items ?? [];
  const coveredByPackaging = checklistDetail?.covered ?? [];
  const notApplicableByPackaging = checklistDetail?.notApplicable ?? [];
  const coveringDesigns = checklistDetail?.coveringDesigns ?? [];
  const coveredByLabel = checklistDetail?.coveredByLabel ?? [];
  const coveringTemplates = checklistDetail?.coveringTemplates ?? [];
  // ⛔ The ingredient tripwire (2026-09-02). Artwork printing the ingredients that
  // was approved BEFORE this recipe last changed. The export and the PDF both
  // refuse while this is non-empty, so it is said here BEFORE anyone clicks.
  const staleArtwork = checklistDetail?.staleArtwork ?? [];
  const checklistRespMap = new Map((checklistDetail?.responses ?? []).map((r) => [r.checklistItemId, r]));
  const requiredChecklistItems = checklistItems.filter((it) => String(it.required) === "true");
  // Session 68 — FAIL CLOSED: an empty checklist is NOT "complete". .every() on
  // an empty array returns true, which previously enabled Approve Labeling with
  // nothing to verify (vacuous pass). A batch with zero checklist items has no
  // seeded R 420.504 list for its product type, so approval stays disabled.
  const checklistComplete = checklistItems.length > 0 && requiredChecklistItems.every((it) => {
    const v = String(checklistRespMap.get(it.id)?.response ?? "");
    return v === "Pass" || v === "N/A";
  });
  const respondChecklist = async (itemId: number, response: string) => {
    await fetch(`/api/batch-records/${id}/checklist/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        checklistItemId: itemId,
        response,
        respondedBy: currentUser?.id,
        respondedByName: (currentUser as { fullName?: string } | undefined)?.fullName ?? "",
      }),
    });
    await queryClient.invalidateQueries({ queryKey: checklistDetailKey });
    await queryClient.invalidateQueries({ queryKey: getGetBatchLabelingQueryKey(id) });
  };
  // Session 42 — restored allInventory data source. Session 38 introduced the
  // in-stock-lots dropdown on the Add Ingredient dialog (line ~1539) but the
  // useListInventoryItems hook was never wired in this component, leaving
  // `allInventory` undefined and the cannaqms typecheck failing on Railway.
  const { data: allInventoryRaw } = useListInventoryItems();
  const allInventory = allInventoryRaw ?? [];

  // Session 59 — batch process steps (FDA GMP). Off-spec endpoint (not in
  // OpenAPI), so fetched/raw like the label-template routes.
  type ProcessStep = {
    id: number; batchId: number; stepNumber: number; description: string;
    template: string | null; instructions: string | null; sortOrder: number;
    completed: boolean; fieldValues: Record<string, string> | null; renderedText: string | null;
    performedByName: string | null; signedInitials: string | null;
    signedMeaning: string | null; performedAt: string | null;
    // Session 62 — competency co-sign. When set, an unqualified operator signed
    // this step and it stays pending until a Supervisor+ co-signs it.
    cosignRequired: boolean; supervisorName: string | null;
    supervisorInitials: string | null; supervisorSignedAt: string | null;
    supervisorMeaning: string | null;
  };
  const processStepsKey = [`/api/batch-records/${id}/process-steps`];
  const { data: processSteps } = useQuery<ProcessStep[]>({
    queryKey: processStepsKey,
    // Always resolve to an array: a 500 (e.g. migration not yet run) returns an
    // { error } object, and calling .map/.filter on that would crash the whole
    // page through the error boundary. Guard at the source.
    queryFn: async () => {
      try {
        const res = await fetch(`/api/batch-records/${id}/process-steps`, { credentials: "include" });
        if (!res.ok) return [];
        const data = await res.json().catch(() => []);
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    },
    enabled: id > 0,
  });

  // Session 62 — the operator's competency for this batch's recipe. When the
  // batch runs a recipe, an operator who is not yet "Qualified" signs steps that
  // stay pending a supervisor co-sign. We surface their status + supervised-batch
  // progress in the Process Steps tab.
  type OperatorQual = {
    id: number; operatorUserId: number; recipeId: number; status: string;
    requiredSupervisedBatches: number; supervisedCount: number; eligible: boolean;
    operatorName: string | null; operatorRole: string | null;
    qualifiedBySupervisorName: string | null; qualifiedAt: string | null;
  };
  const batchRecipeId = (batch as { recipeId?: number | null } | undefined)?.recipeId ?? null;
  const qualKey = [`/api/operator-qualifications`, batchRecipeId, currentUser?.id];
  const { data: myQual } = useQuery<OperatorQual | null>({
    queryKey: qualKey,
    queryFn: async () => {
      if (!batchRecipeId || !currentUser?.id) return null;
      try {
        const res = await fetch(`/api/operator-qualifications?operatorUserId=${currentUser.id}&recipeId=${batchRecipeId}`, { credentials: "include" });
        if (!res.ok) return null;
        const data = await res.json().catch(() => []);
        return Array.isArray(data) && data.length ? data[0] : null;
      } catch { return null; }
    },
    enabled: id > 0 && !!batchRecipeId && !!currentUser?.id,
  });

  // 2026-08-26 — is the signed-in operator's training on a document governing this
  // recipe still open? Shown BEFORE they sign, so someone with training Assigned is
  // told they need a supervisor rather than discovering it after the fact.
  type TrainingHold = {
    docNumber: string; docTitle: string; revision: string;
    trainingRecordId: number; dueDate: string | null; status: string;
  };
  const trainingHoldKey = [`/api/batch-records/${id}/my-training-hold`, currentUser?.id];
  const { data: myTrainingHold } = useQuery<TrainingHold | null>({
    queryKey: trainingHoldKey,
    queryFn: async () => {
      try {
        const res = await fetch(`/api/batch-records/${id}/my-training-hold`, { credentials: "include" });
        if (!res.ok) return null;
        const data = await res.json().catch(() => ({}));
        return data?.hold ?? null;
      } catch { return null; }
    },
    enabled: id > 0 && !!currentUser?.id,
  });

  // Session 62 — all operators' qualifications for this recipe, so a Supervisor+
  // can sign off an eligible operator from the batch (in lieu of a standalone
  // qualifications dashboard, which is parked).
  const recipeQualsKey = [`/api/operator-qualifications`, "recipe", batchRecipeId];
  const { data: recipeQuals } = useQuery<OperatorQual[]>({
    queryKey: recipeQualsKey,
    queryFn: async () => {
      if (!batchRecipeId) return [];
      try {
        const res = await fetch(`/api/operator-qualifications?recipeId=${batchRecipeId}`, { credentials: "include" });
        if (!res.ok) return [];
        const data = await res.json().catch(() => []);
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    },
    enabled: id > 0 && !!batchRecipeId,
  });

  // Session 111 — the recipe's default net weight per unit, for the Overview
  // display. The batch's own label_net_weight is an OVERRIDE, not a copy: when
  // it's null the label builder already falls back to the recipe's value, so a
  // blank field on Overview was showing "—" for a batch that will in fact print
  // a net weight. We inherit for DISPLAY only and write nothing to the batch —
  // that keeps the screen honest about what prints, and keeps a later recipe
  // correction flowing through instead of silently diverging.
  type RecipeNetWeight = { netWeight: number | null; netWeightUnit: string | null };
  const { data: recipeDefaults } = useQuery<RecipeNetWeight | null>({
    queryKey: [`/api/recipes/${batchRecipeId}`, "net-weight"],
    queryFn: async () => {
      if (!batchRecipeId) return null;
      try {
        const res = await fetch(`/api/recipes/${batchRecipeId}`, { credentials: "include" });
        if (!res.ok) return null;
        const r = await res.json().catch(() => null);
        return r ? { netWeight: r.netWeight ?? null, netWeightUnit: r.netWeightUnit ?? null } : null;
      } catch { return null; }
    },
    enabled: id > 0 && !!batchRecipeId,
  });

  // Effective net weight per unit = batch override, else recipe default. The
  // `source` drives the "from recipe" tag so an operator can tell at a glance
  // whether this run was packed off the recipe's standard size.
  const effectiveNetWeight = (() => {
    const bw = (batch as unknown as { labelNetWeight?: number | null })?.labelNetWeight;
    const bu = (batch as unknown as { labelNetWeightUnit?: string | null })?.labelNetWeightUnit;
    if (bw != null) return { value: bw, unit: bu ?? recipeDefaults?.netWeightUnit ?? "", source: "batch" as const };
    if (recipeDefaults?.netWeight != null) {
      return { value: recipeDefaults.netWeight, unit: recipeDefaults.netWeightUnit ?? "", source: "recipe" as const };
    }
    return null;
  })();

  // Session 111 — source tags already recorded on this batch, for the process-step
  // signing dialog. A step template like "{baker} selected released/staged biomass
  // package {source_tag}" was making the operator RE-TYPE a METRC tag the batch
  // already knows: the lot was picked on the Ingredients tab, and for a
  // METRC-synced lot the lot number IS the package tag. Re-typing a 24-character
  // tag from memory is exactly how a batch record ends up pointing at the wrong
  // package. We offer what the batch actually consumed and still let the operator
  // type something else (a tag consumed but not recorded as an ingredient line).
  //
  // A lot missing from allInventory (drawn to zero, so it drops off the on-hand
  // view) is still offered — it was consumed by THIS batch, which is precisely
  // when it belongs on the record. Only a lot we can positively identify as
  // non-cannabis is filtered out.
  const batchSourceTags = (() => {
    const rows = (ingredients ?? []) as unknown as Array<{ lotNumber: string | null; ingredientName: string; kind?: string | null }>;
    const out: Array<{ tag: string; label: string }> = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const ln = (r.lotNumber ?? "").trim();
      if (!ln || seen.has(ln)) continue;
      const lot = allInventory.find((i) => i.lotNumber === ln);
      // isCannabis is on the runtime inventory-view row but not on the generated
      // InventoryItem shape — same narrow cast this file uses for strainType etc.
      if (lot && (lot as unknown as { isCannabis?: boolean }).isCannabis === false) continue;
      seen.add(ln);
      out.push({ tag: ln, label: `${r.ingredientName} — ${ln}` });
    }
    return out;
  })();

  // Session 73 — METRC Tag History (tag lineage). Off-spec/raw-fetch like the
  // process-steps + label-template routes. A batch carries a TREE of METRC tags
  // it accrues as product changes form and is repackaged; the root is the
  // process-start tag (= the Batch Number, frozen), each node references its
  // Source/parent tag, and a node is either a single new tag or a first–last
  // range of sequential child tags (a split can record several non-contiguous
  // ranges as sibling rows).
  type MetrcTag = {
    id: number; batchId: number; sourceTag: string | null; stageLabel: string;
    kind: "single" | "range"; metrcTag: string | null;
    rangeStart: string | null; rangeEnd: string | null; rangeCount: number | null;
    quantity: string | null; uom: string | null;
    recordedByName: string | null; recordedAt: string | null;
    // JIT commit 2 (label-later) — packaged runs start 'unlabeled' when packaged
    // "label later"; the Label & Finalize step flips them to 'labeled'.
    labelStatus?: string | null; dispensaryName?: string | null;
    labeledByName?: string | null; labeledAt?: string | null;
    // METRC write-back sync marker (create-package): stamped when this node's
    // package was created in METRC; metrcSyncError = last plain-language failure.
    metrcPackageCreatedAt?: string | null; metrcSyncError?: string | null;
    // A cancelled node stays in the history for traceability but is no longer a
    // live package, so it must not count toward 'is this batch packaged yet'.
    cancelledAt?: string | null;
  };
  const metrcTagsKey = [`/api/batch-records/${id}/metrc-tags`];
  const { data: metrcTags } = useQuery<MetrcTag[]>({
    queryKey: metrcTagsKey,
    queryFn: async () => {
      try {
        const res = await fetch(`/api/batch-records/${id}/metrc-tags`, { credentials: "include" });
        if (!res.ok) return [];
        const data = await res.json().catch(() => []);
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    },
    enabled: id > 0,
  });

  const updateBatch       = useUpdateBatchRecord();
  const createIngredient  = useCreateBatchIngredient();
  const updateIngredient  = useUpdateBatchIngredient();
  const deleteIngredient  = useDeleteBatchIngredient();
  const createTestResult  = useCreateBatchTestResult();
  const updateTestResult  = useUpdateBatchTestResult();
  const approveLabeling   = useApproveBatchLabeling();
  const releaseBatch      = useReleaseBatch();
  const queryClient       = useQueryClient();
  const { toast }         = useToast();

  // Session 79 (Step 3) — single Part 11 e-signature at the end of the ingredient
  // list that removes the signed quantities from on-hand inventory (the lots).
  const [ingCommitOpen, setIngCommitOpen]   = useState(false);
  const [ingCommitPending, setIngCommitPending] = useState(false);
  // Throws on failure so the signature dialog stays open with the server message.
  // 2026-09-08 — a lot that cannot cover the line now REFUSES the whole draw
  // (nothing commits half-way). The screen keeps the shortfall so Management or
  // Quality can authorise running short, with a reason, without retyping.
  const [shortfall, setShortfall] = useState<{ lines: Array<{ ingredientName: string; lotNumber: string | null; have: number; want: number; uom: string }>; message: string } | null>(null);
  const [shortReason, setShortReason] = useState("");
  const canAuthoriseShort = ["Manager", "Quality"].includes(((currentUser as { role?: string } | undefined)?.role) ?? "");

  const handleCommitIngredients = async (initials: string, meaning: string, opts?: { allowShortDraw?: boolean; shortDrawReason?: string }) => {
    setIngCommitPending(true);
    try {
      const res = await fetch(`/api/batch-records/${id}/ingredients/commit`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initials, signingMeaning: meaning, ...(opts ?? {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data?.needsShortDrawApproval) {
        setShortfall({ lines: data.shortfalls ?? [], message: data.error ?? "A lot does not hold enough for this batch." });
        throw new Error(data.error ?? "Not enough material in the lot.");
      }
      if (!res.ok) throw new Error(data.error ?? "Failed to remove ingredients from inventory");
      setShortfall(null);
      setShortReason("");
      await queryClient.invalidateQueries({ queryKey: getListBatchIngredientsQueryKey(id) });
      await queryClient.invalidateQueries({ queryKey: getListInventoryItemsQueryKey() });
      setIngCommitOpen(false);
      const moved = (data.committed ?? 0) + (data.refunded ?? 0);
      toast({
        title: "Inventory updated",
        description: moved > 0
          ? `${data.committed ?? 0} item(s) drawn from inventory${data.refunded ? `, ${data.refunded} adjusted` : ""}${data.skipped ? `, ${data.skipped} skipped (no matching lot)` : ""}.`
          : data.skipped
            ? `Nothing drawn — ${data.skipped} line(s) have no lot to draw from. They stay recorded on the batch record.`
            : "Nothing to remove — quantities already match the lots.",
      });
    } finally {
      setIngCommitPending(false);
    }
  };

  // The shortfall banner is rendered on the Ingredients tab (see below); this
  // helper re-runs the commit WITH the authorisation attached.
  const [shortDrawSigning, setShortDrawSigning] = useState(false);
  const authoriseShortDraw = async (initials: string, meaning: string) => {
    await handleCommitIngredients(initials, meaning, { allowShortDraw: true, shortDrawReason: shortReason });
    setShortDrawSigning(false);
  };

  // Session 59 — process-step signing + ad-hoc add.
  const [signingStep, setSigningStep]       = useState<ProcessStep | null>(null);
  const [stepSignPending, setStepSignPending] = useState(false);
  // Session 62 — supervisor co-sign of a pending step.
  const [cosigningStep, setCosigningStep]   = useState<ProcessStep | null>(null);
  // Session 62 — supervisor qualification sign-off for an operator on this recipe.
  const [qualifyingRow, setQualifyingRow]   = useState<OperatorQual | null>(null);
  const [newStepDesc, setNewStepDesc]       = useState("");
  const [newStepTemplate, setNewStepTemplate] = useState("");
  const refreshSteps = () => queryClient.invalidateQueries({ queryKey: processStepsKey });

  // Session 73 — METRC Tag History: record a form-change / repackage node and
  // cancel a node (universal Cancel pattern). Cancel is Manager/Quality/Admin.
  const CANCEL_ROLES_CLIENT = ["Manager", "Quality", "Admin"];
  const canCancelTag = CANCEL_ROLES_CLIENT.includes(currentUser?.role ?? "");
  const refreshTags = () => queryClient.invalidateQueries({ queryKey: metrcTagsKey });

  type TagRange = { rangeStart: string; rangeEnd: string; rangeCount: string };
  const blankTagForm = () => ({
    sourceTag: "",
    stageLabel: "",
    mode: "single" as "single" | "range",
    metrcTag: "",
    ranges: [{ rangeStart: "", rangeEnd: "", rangeCount: "" }] as TagRange[],
    quantity: "",
    uom: "g",
    // Amount drawn FROM the source package + its unit. Real manufacturing pulls a
    // WEIGHT (e.g. grams of distillate) to make a COUNT output (e.g. 100 cartridges),
    // so the source draw is a DIFFERENT quantity+unit than the finished package.
    // Auto-filled from the item's unit weight (count × per-unit weight); sourceQtyManual
    // flips true once the user edits it, which stops the auto-fill from overwriting.
    sourceQuantity: "",
    sourceUom: "",
    sourceQtyManual: false,
    // Form-change auto-create: the METRC Item for the new production-batch package,
    // and whether to create it in METRC on Record (single mode only). Item sets UoM.
    item: "",
    // METRC storage location (facility room/area) for the new package — METRC
    // requires it on create ("Location was not specified" otherwise).
    location: "",
    createInMetrc: true,
  });
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [tagForm, setTagForm] = useState(blankTagForm());
  const [tagError, setTagError] = useState<string | null>(null);
  const [tagPending, setTagPending] = useState(false);
  // Cancel-a-node flow (reason + Part 11 e-sig in one dialog).
  const [cancelTag, setCancelTag] = useState<MetrcTag | null>(null);
  const [cancelTagForm, setCancelTagForm] = useState({ reason: "", initials: "", meaning: "" });
  const [cancelTagError, setCancelTagError] = useState<string | null>(null);
  const [cancelTagPending, setCancelTagPending] = useState(false);

  // Form-change auto-create — METRC Item catalog (drives the Item picker + UoM) and
  // available (unused) tags (to flag a mis-scanned tag). Loaded read-only when the
  // record dialog opens; mirrors the finished-goods packaging dialog.
  // UnitWeight + UnitWeightUnitOfMeasureName are the item's PER-UNIT weight (e.g.
  // a 1 g cartridge). They drive the auto-filled source draw so the operator never
  // hand-keeps a weight notebook: draw = count × UnitWeight, in UnitWeightUoM.
  type MetrcItemOpt = { Name?: string; UnitOfMeasureName?: string; UnitWeight?: number; UnitWeightUnitOfMeasureName?: string };
  const [metrcItems, setMetrcItems] = useState<MetrcItemOpt[]>([]);
  const [metrcAvailTags, setMetrcAvailTags] = useState<Set<string> | null>(null);
  // Facility storage locations (for the Location picker). METRC requires a
  // Location on package create, so we offer the real facility rooms.
  const [metrcLocations, setMetrcLocations] = useState<string[]>([]);
  const [tagPreview, setTagPreview] = useState<unknown | null>(null);
  useEffect(() => {
    if (!tagDialogOpen) return;
    setTagPreview(null);
    // Normalize the METRC proxy payload to an array — handles the { Data: [...] }
    // wrapper, a bare array, and the object-with-numeric-keys shape the sandbox
    // returns ({ "0": {...} }). See ConfirmFinishedGoodsDialog for the full note.
    const houseData = <T,>(j: { data?: unknown } | null): T[] => {
      const d = j?.data as unknown;
      if (Array.isArray(d)) return d as T[];
      if (d && typeof d === "object") {
        const inner = (d as { Data?: unknown }).Data;
        if (Array.isArray(inner)) return inner as T[];
        return Object.values(d as Record<string, unknown>).filter((v) => v && typeof v === "object") as T[];
      }
      return [];
    };
    void (async () => {
      try {
        const [itemsRes, tagsRes, locsRes] = await Promise.all([
          fetch("/api/metrc/packages/items", { credentials: "include" }).then((r) => r.json()).catch(() => null),
          fetch("/api/metrc/packages/available-tags", { credentials: "include" }).then((r) => r.json()).catch(() => null),
          fetch("/api/metrc/packages/locations", { credentials: "include" }).then((r) => r.json()).catch(() => null),
        ]);
        setMetrcItems(houseData<MetrcItemOpt>(itemsRes).filter((it) => (it.Name ?? "").trim() !== ""));
        setMetrcAvailTags(tagsRes?.ok
          ? new Set(houseData<{ Label?: string; Tag?: string }>(tagsRes).map((t) => (t.Label ?? t.Tag ?? "").trim().toUpperCase()).filter(Boolean))
          : null);
        setMetrcLocations(houseData<{ Name?: string }>(locsRes).map((l) => (l.Name ?? "").trim()).filter(Boolean));
      } catch { setMetrcAvailTags(null); }
    })();
  }, [tagDialogOpen]);

  // The current leaf tag = the most recently recorded node's tag (range → first
  // tag of its span). This is what prints on labels; the Batch Number (process-
  // start tag) never changes. Used to prefill the Source field of a new node.
  const currentLeafTag = (() => {
    const list = metrcTags ?? [];
    if (!list.length) return batch?.batchNumber ?? "";
    const last = list[list.length - 1];
    return last.kind === "range" ? (last.rangeStart ?? batch?.batchNumber ?? "") : (last.metrcTag ?? batch?.batchNumber ?? "");
  })();

  const openTagDialog = () => {
    const f = blankTagForm();
    f.sourceTag = currentLeafTag;
    setTagForm(f);
    setTagError(null);
    setTagDialogOpen(true);
  };
  const addTagRange = () =>
    setTagForm((f) => ({ ...f, ranges: [...f.ranges, { rangeStart: "", rangeEnd: "", rangeCount: "" }] }));
  const removeTagRange = (i: number) =>
    setTagForm((f) => ({ ...f, ranges: f.ranges.filter((_, idx) => idx !== i) }));
  const updateTagRange = (i: number, patch: Partial<TagRange>) =>
    setTagForm((f) => ({
      ...f,
      ranges: f.ranges.map((r, idx) => {
        if (idx !== i) return r;
        const merged = { ...r, ...patch };
        // Session 97 — auto-derive the unit count from numeric tag bounds (fixed
        // prefix + numeric counter) so the operator doesn't hand-count 200 packs.
        // Only fills when the count is still blank, so a manual override sticks.
        if ("rangeStart" in patch || "rangeEnd" in patch) {
          const derived = deriveTagCount(merged.rangeStart, merged.rangeEnd);
          if (derived && !merged.rangeCount.trim()) merged.rangeCount = derived;
        }
        return merged;
      }),
    }));

  // A count unit (Each and its synonyms). A count package drawn from a weight
  // source needs an explicit weight draw — used both to guard and to auto-fill.
  const isCountUom = (u: string) => /^(each|ea|unit|count)s?$/i.test((u ?? "").trim());

  // Auto-fill the source draw from the item's per-unit weight: draw = count ×
  // UnitWeight, expressed in the item's UnitWeightUnitOfMeasureName. Returns null
  // when the item has no unit weight or the count isn't a positive number (e.g. a
  // same-unit repackage, where the draw simply equals the package quantity).
  const computeSourceDraw = (item: MetrcItemOpt | undefined, count: string): { qty: string; uom: string } | null => {
    const n = Number(count);
    const w = Number(item?.UnitWeight);
    if (!item || !(w > 0) || !(n > 0)) return null;
    const qty = Math.round(n * w * 10000) / 10000; // trim FP dust
    return { qty: String(qty), uom: (item.UnitWeightUnitOfMeasureName ?? "").trim() };
  };

  // Build the METRC create-package (production batch) body for the single-tag
  // form-change case, from the current form + batch. confirm=false → dry-run preview.
  // The finished package uses (quantity, uom); the amount PULLED from the source
  // uses (sourceQuantity, sourceUom) — sent explicitly so a count output can draw a
  // weight (the backend defaults them to the package qty/uom when we omit them).
  const buildTagCreateBody = (confirm: boolean) => {
    const drawQty = Number(tagForm.sourceQuantity);
    const drawUom = tagForm.sourceUom.trim();
    return {
      [confirm ? "confirm" : "dryRun"]: true,
      sourcePackageLabel: tagForm.sourceTag.trim(),
      item: tagForm.item,
      unitOfMeasure: tagForm.uom.trim(),
      sourceUnitOfMeasure: drawUom || tagForm.uom.trim(),
      location: tagForm.location.trim(),
      packagedDate: new Date().toLocaleDateString("en-CA"),
      isProductionBatch: true,
      productionBatchNumber: batch?.batchNumber ?? String(id),
      packages: [{
        tag: tagForm.metrcTag.trim(),
        quantity: Number(tagForm.quantity),
        ...(drawQty > 0 ? { sourceQuantity: drawQty } : {}),
      }],
    };
  };

  // Read-only: preview the exact METRC payload for the create (no write).
  const runTagPreview = async () => {
    setTagError(null); setTagPreview(null);
    try {
      const r = await fetch("/api/metrc/packages/create-finished-goods", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify(buildTagCreateBody(false)),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setTagError(j.error ?? "Preview failed."); return; }
      setTagPreview(j.wouldSend ?? j);
    } catch (e) { setTagError(e instanceof Error ? e.message : "Preview failed."); }
  };

  const handleRecordTagNode = async () => {
    if (!tagForm.stageLabel.trim()) { setTagError("A stage label is required."); return; }
    const createInMetrc = tagForm.mode === "single" && tagForm.createInMetrc;
    let body: Record<string, unknown>;
    if (tagForm.mode === "single") {
      if (!tagForm.metrcTag.trim()) { setTagError("A METRC tag is required."); return; }
      body = { kind: "single", metrcTag: tagForm.metrcTag.trim() };
    } else {
      const ranges = tagForm.ranges
        .map((r) => ({ rangeStart: r.rangeStart.trim(), rangeEnd: r.rangeEnd.trim(), rangeCount: r.rangeCount.trim() || null }))
        .filter((r) => r.rangeStart && r.rangeEnd);
      if (!ranges.length) { setTagError("Each range needs a first and last tag."); return; }
      body = { kind: "range", ranges };
    }
    body.sourceTag = tagForm.sourceTag.trim() || null;
    body.stageLabel = tagForm.stageLabel.trim();
    body.quantity = tagForm.quantity.trim() || null;
    body.uom = tagForm.uom.trim() || null;

    // When creating in METRC (single form-change), require the fields the create
    // needs, then do the same two-step the finished-goods flow uses: create the
    // production-batch package in METRC first; on a refusal, surface it and do NOT
    // record, so CannaQMS and METRC never silently diverge; on success record the
    // node with metrcCreated:true so it's stamped "In METRC".
    if (createInMetrc) {
      if (!tagForm.item) { setTagError("Pick the METRC item for the new package (needed to create it in METRC)."); return; }
      if (!tagForm.sourceTag.trim()) { setTagError("A source (parent) tag is required to create the package in METRC."); return; }
      if (!tagForm.location.trim()) { setTagError("Pick the METRC location (facility room) for the new package — METRC requires it."); return; }
      if (!(Number(tagForm.quantity) > 0)) { setTagError("Enter the quantity for the new package (needed to create it in METRC)."); return; }
      // A count output (Each) MUST carry an explicit weight draw, or Metrc rejects
      // it ("Quantity … cannot be 'Each' … not compatible with 'Ounces'"). Auto-fill
      // normally sets this; guard the case where it couldn't (item lacks a unit weight).
      if (isCountUom(tagForm.uom) && !(Number(tagForm.sourceQuantity) > 0)) {
        setTagError("Enter the amount drawn from the source package (e.g. grams). A count package (Each) can't pull a matching count from a weight source — set the source draw and its unit below.");
        return;
      }
    }
    setTagPending(true);
    setTagError(null);
    try {
      if (createInMetrc) {
        const w = await fetch("/api/metrc/packages/create-finished-goods?confirm=true", {
          method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
          body: JSON.stringify(buildTagCreateBody(true)),
        });
        const wj = await w.json().catch(() => ({}));
        if (!w.ok) {
          setTagError(wj.writeEnabled === false
            ? "METRC write-back is disabled on the server (METRC_WRITE_ENABLED). Use Preview to see the payload; enabling the write is an admin step."
            : (wj.error ?? "METRC package create failed."));
          return;
        }
        if (wj.ok === false) { setTagError(wj.error ?? "METRC rejected the package create."); return; }
        body.metrcCreated = true;
      }
      const res = await fetch(`/api/batch-records/${id}/metrc-tags`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? "Failed to record tag node"); }
      refreshTags();
      setTagDialogOpen(false);
      toast({ title: createInMetrc ? "Package created in METRC" : "Tag recorded", description: createInMetrc ? "Created in METRC and recorded on the lineage." : "METRC tag node added to the lineage." });
    } catch (err) {
      setTagError(err instanceof Error ? err.message : "Failed to record tag node");
    } finally { setTagPending(false); }
  };

  const handleCancelTagNode = async () => {
    if (!cancelTag) return;
    if (!cancelTagForm.reason.trim()) { setCancelTagError("A cancellation rationale is required."); return; }
    if (cancelTagForm.initials.trim().length < 2) { setCancelTagError("Initials are required (21 CFR Part 11)."); return; }
    if (!cancelTagForm.meaning.trim()) { setCancelTagError("A signing statement is required."); return; }
    setCancelTagPending(true);
    setCancelTagError(null);
    try {
      const res = await fetch(`/api/batch-metrc-tags/${cancelTag.id}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ reason: cancelTagForm.reason.trim(), initials: cancelTagForm.initials.trim(), signatureMeaning: cancelTagForm.meaning.trim() }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? "Failed to cancel tag"); }
      refreshTags();
      setCancelTag(null);
      setCancelTagForm({ reason: "", initials: "", meaning: "" });
      toast({ title: "Tag node cancelled", description: "Hidden from the lineage but recoverable (audited)." });
    } catch (err) {
      setCancelTagError(err instanceof Error ? err.message : "Failed to cancel tag");
    } finally { setCancelTagPending(false); }
  };

  // Throws on failure so the sign dialog stays open and shows the server
  // message; resolves on success. fieldValues carries the baker's filled-in
  // template blanks.
  const handleSignStep = async (initials: string, meaning: string, fieldValues: Record<string, string>) => {
    if (!signingStep) return;
    setStepSignPending(true);
    try {
      const res = await fetch(`/api/batch-process-steps/${signingStep.id}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ initials, signatureMeaning: meaning, fieldValues }),
      });
      const signed = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(signed.error ?? "Failed to sign step");
      }
      refreshSteps();
      // Session 63 — an unqualified operator's first sign on this recipe creates
      // the "In Training" qualification row server-side. Invalidate the competency
      // queries (as cosign/qualify/revoke already do) so the banner + qualifications
      // panel update immediately instead of lagging until a background refetch.
      queryClient.invalidateQueries({ queryKey: qualKey });
      queryClient.invalidateQueries({ queryKey: recipeQualsKey });
      setSigningStep(null);
      // The operator is told WHY their step is waiting, so an open training
      // assignment does not read as the app being broken.
      const hold = (signed as { trainingHold?: { docNumber: string; revision: string } | null }).trainingHold;
      if (hold) {
        toast({
          title: "Signed — waiting on a supervisor co-sign",
          description: `Your training on ${hold.docNumber} rev ${hold.revision} is still open, so this step needs a supervisor co-sign. Complete that training and later steps sign on their own.`,
        });
      } else if ((signed as { cosignRequired?: boolean }).cosignRequired) {
        toast({
          title: "Signed — waiting on a supervisor co-sign",
          description: "You are not yet qualified on this recipe, so a supervisor must co-sign this step.",
        });
      } else {
        toast({ title: "Step signed", description: "Operator e-signature recorded." });
      }
    } finally {
      setStepSignPending(false);
    }
  };
  const handleAddStep = async () => {
    if (!newStepDesc.trim()) return;
    const res = await fetch(`/api/batch-records/${id}/process-steps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ description: newStepDesc.trim(), template: newStepTemplate.trim() || null }),
    });
    if (res.ok) { setNewStepDesc(""); setNewStepTemplate(""); refreshSteps(); }
    else toast({ title: "Failed to add step", variant: "destructive" });
  };
  const handleRemoveStep = async (stepId: number) => {
    const res = await fetch(`/api/batch-process-steps/${stepId}`, { method: "DELETE", credentials: "include" });
    if (res.ok) refreshSteps();
    else { const d = await res.json().catch(() => ({})); toast({ title: d.error ?? "Failed to remove step", variant: "destructive" }); }
  };
  // Session 62 — supervisor co-signs a pending step, completing it and counting
  // it toward the operator's supervised-batch tally for the recipe.
  const handleCosignStep = async (initials: string, meaning: string) => {
    if (!cosigningStep) return;
    const res = await fetch(`/api/batch-process-steps/${cosigningStep.id}/cosign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ initials, signatureMeaning: meaning }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // Throw so the signature dialog stays open and shows the server message.
      throw new Error(data.error ?? "Failed to co-sign step");
    }
    refreshSteps();
    queryClient.invalidateQueries({ queryKey: qualKey });
    queryClient.invalidateQueries({ queryKey: recipeQualsKey });
    setCosigningStep(null);
    toast({ title: "Step co-signed", description: "Supervisor co-signature recorded (21 CFR Part 11)." });
  };
  // Session 62 — supervisor records the Part 11 qualification sign-off. Throws on
  // failure so the signature dialog stays open and shows the server message.
  const handleQualify = async (initials: string, meaning: string) => {
    if (!qualifyingRow) return;
    const res = await fetch(`/api/operator-qualifications/${qualifyingRow.id}/qualify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ initials, signatureMeaning: meaning }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? "Failed to qualify operator");
    }
    queryClient.invalidateQueries({ queryKey: recipeQualsKey });
    queryClient.invalidateQueries({ queryKey: qualKey });
    setQualifyingRow(null);
    toast({ title: "Operator qualified", description: "Qualification sign-off recorded (21 CFR Part 11)." });
  };
  const handleRevokeQual = async (qualId: number) => {
    const reason = window.prompt("Reason for revoking this qualification? (required)");
    if (!reason?.trim()) return;
    const res = await fetch(`/api/operator-qualifications/${qualId}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ reason: reason.trim() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast({ title: data.error ?? "Failed to revoke", variant: "destructive" });
      return;
    }
    queryClient.invalidateQueries({ queryKey: recipeQualsKey });
    queryClient.invalidateQueries({ queryKey: qualKey });
    toast({ title: "Qualification revoked" });
  };

  const [signatureOpen, setSignatureOpen]     = useState(false);
  const [signatureAction, setSignatureAction] = useState<"labeling" | "release" | "labelAndFinalize" | null>(null);
  // JIT commit 2 (label-later) — retail destination captured on the Label & Finalize step.
  const [dispensaryName, setDispensaryName] = useState("");
  // Session 67 (Item 5 follow-up) — explicitly start the labeling record so the
  // Approve Labeling + e-signature step is reachable (previously a labeling row
  // only appeared as a side effect of the print/checklist flow, leaving the
  // approval a dead end on a fresh batch).
  const [startingLabeling, setStartingLabeling] = useState(false);
  // Session 47 — in-batch NC capture dialog. Opens from the Related NCs card
  // on the Compliance Trail tab; pre-fills batch context so operators don't
  // re-type batchId / product / lot mid-production.
  const [logNcOpen, setLogNcOpen] = useState(false);

  const [confirmTransition, setConfirmTransition] = useState<TransitionDef | null>(null);
  const [actualOutputDraft, setActualOutputDraft] = useState<string | null>(null);
  // 2026-08-10 — cases/cartons captured alongside units on the Packaging tab.
  // FG-3 — the finished-goods transition opens the Create-Packages dialog instead
  // of a plain status flip (the generic flip is now blocked server-side).
  const [fgDialogOpen, setFgDialogOpen] = useState(false);

  const [editMode, setEditMode]   = useState(false);
  const [editValues, setEditValues] = useState({
    // Session 76.3 (OQ OBS-3) — product name / strain are correctable while the
    // batch is pre-test (status in_production), so a mistyped product no longer
    // forces a re-create. Gated by canEditIdentity below.
    productName:    "",
    strainName:     "",
    strainType:     "",
    outputQuantity: "",
    // Session 46 — scheduledOutputQuantity added to the overview edit form.
    // Role-gated below (Supervisor+); other fields stay editable for everyone.
    scheduledOutputQuantity: "",
    unitOfMeasure:  "",
    // Session 110 — net weight (per unit) moved here from the Label Data panel;
    // it's a product/overview attribute, not label-only. Prints on the consumer
    // label; blank falls back to the recipe default.
    labelNetWeight: "",
    labelNetWeightUnit: "",
    metrcPackageId: "",
    productionDate: "",
    notes:          "",
  });
  // Session 46 — per-row ingredient editing. When set, the Add Ingredient
  // dialog opens in "edit existing" mode populated from the row and PATCHes
  // that row on save instead of inserting a new one.
  const [editingIngredientId, setEditingIngredientId] = useState<number | null>(null);
  // Session 46 — role gate for editing scheduledOutputQuantity. Mirrors
  // server APPROVER_ROLES set in batches.ts. UI-only gate today; future
  // hardening can mirror this server-side in PATCH /batch-records.
  const APPROVER_ROLES_CLIENT = ["Supervisor", "Manager", "Quality", "Admin"];
  const canEditPlannedOutput = APPROVER_ROLES_CLIENT.includes(currentUser?.role ?? "");
  // Session 76.2 (OQ DEV-2) — label approval is an approver act; mirror the
  // server role gate so an Operator sees a disabled button, not a 403.
  const canApproveLabeling = APPROVER_ROLES_CLIENT.includes(currentUser?.role ?? "");
  // Session 76.3 (OQ OBS-3) — product name / strain are only correctable while
  // the batch is pre-test (in_production); once testing starts the identity is
  // locked. Avoids editing product identity on a tested/released record.
  const canEditIdentity = batch?.status === "in_production";
  // Session 62 — only Supervisor+ can co-sign a pending step (server enforces too).
  const canCosign = APPROVER_ROLES_CLIENT.includes(currentUser?.role ?? "");

  const [addIngOpen, setAddIngOpen]   = useState(false);
  // BR-1/BR-3 — expirationDate is optional so the many `setIngValues({…})` reset
  // literals don't each need it (an omitted key resets it to undefined = empty).
  const [ingValues, setIngValues]     = useState<{ selectedPlannedId: number | null; ingredientName: string; lotNumber: string; plannedQuantity: string; actualQuantity: string; unitOfMeasure: string; kind: string; supplierLotNumber: string; receivedAt: string; expirationDate?: string }>({ selectedPlannedId: null, ingredientName: "", lotNumber: "", plannedQuantity: "", actualQuantity: "", unitOfMeasure: "g", kind: "Ingredient", supplierLotNumber: "", receivedAt: "" });
  const [ingError, setIngError]       = useState<string | null>(null);
  // Session 38 (Tier 4 #18) — Lot Number is a filtered dropdown by default
  // (in-stock lots whose itemName matches the ingredient name) but can flip
  // to manual entry when the operator needs to record a lot that isn't yet
  // in inventory (e.g. a pre-inventory raw material captured retrospectively).
  const [ingLotManual, setIngLotManual] = useState(false);
  // Session 79.4 — searchable lot combobox open state.
  const [lotPickerOpen, setLotPickerOpen] = useState(false);
  // BR-5 (2026-07-12) — explicit acknowledgement when Actual Qty is far over
  // plan/on-hand. Reset on close and whenever the actual quantity changes so a
  // pre-checked box can't wave through a subsequently-bumped number.
  const [qtyAck, setQtyAck] = useState(false);

  // Session 79.2 — open the Add dialog from a blank slate, defaulting the Type to
  // the card that was clicked (Food → Ingredient, Materials → Material, Packaging
  // → Packaging). Closing via the submit handlers sets open=false directly, which
  // bypasses the reset in onOpenChange, so the next "Add" would otherwise reopen
  // pre-filled with the previous row. Reset on OPEN to guarantee a clean form.
  const openAddIngredient = (kind: string) => {
    setIngError(null);
    setEditingIngredientId(null);
    setIngLotManual(false);
    setIngValues({
      selectedPlannedId: null, ingredientName: "", lotNumber: "",
      plannedQuantity: "", actualQuantity: "",
      unitOfMeasure: kind === "Ingredient" ? "g" : "units",
      kind, supplierLotNumber: "", receivedAt: "",
    });
    setAddIngOpen(true);
  };

  const [addTestOpen, setAddTestOpen] = useState(false);
  // Session 101 (#A) — Metrc lab-results pull + Part 11 verify (per test row).
  const [sampleTagDrafts, setSampleTagDrafts] = useState<Record<number, string>>({});
  const [pullingTestId, setPullingTestId] = useState<number | null>(null);
  const [pullMsg, setPullMsg] = useState<Record<number, string>>({});
  const [verifyTestId, setVerifyTestId] = useState<number | null>(null);
  const refreshTests = () => queryClient.invalidateQueries({ queryKey: getListBatchTestResultsQueryKey(id) });
  const pullLabResults = async (testId: number, existingTag: string) => {
    setPullingTestId(testId);
    setPullMsg((m) => ({ ...m, [testId]: "" }));
    try {
      const tag = (sampleTagDrafts[testId] ?? existingTag ?? "").trim();
      const r = await fetch(`/api/batch-testing/${testId}/pull`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sampleTag: tag || undefined }),
      });
      const data = await r.json().catch(() => ({} as Record<string, unknown>));
      if (!r.ok) { setPullMsg((m) => ({ ...m, [testId]: (data.error as string) ?? "Pull failed" })); return; }
      if (data.status === "pending") setPullMsg((m) => ({ ...m, [testId]: (data.message as string) ?? "No released results yet." }));
      refreshTests();
    } catch (e) {
      setPullMsg((m) => ({ ...m, [testId]: e instanceof Error ? e.message : "Pull failed" }));
    } finally { setPullingTestId(null); }
  };
  const verifyLabResults = async (initials: string, meaning: string) => {
    if (verifyTestId == null) return;
    const r = await fetch(`/api/batch-testing/${verifyTestId}/verify`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initials, signatureMeaning: meaning }),
    });
    if (!r.ok) { const b = await r.json().catch(() => ({} as { error?: string })); throw new Error(b.error ?? "Verify failed"); }
    refreshTests();
    setVerifyTestId(null);
  };
  // Session 69 — the Add Test dialog doubles as Edit. editTestId === null means
  // "add a new result"; a number means "patch that existing test row".
  const [editTestId, setEditTestId] = useState<number | null>(null);
  const [attachmentsForTestId, setAttachmentsForTestId] = useState<number | null>(null);
  // Session 36 — Testing form now captures phase + pre-test fields + agency
  // FK alongside the legacy result columns. The new resultValues jsonb is
  // built from the legacy column inputs at submit time so the canonical
  // store gets populated even though the UI still uses hardcoded analyte
  // inputs (Michigan THC/CBD). Per-state dynamic analyte UI is deferred.
  const [testValues, setTestValues]   = useState({
    phase: "result" as "pre_test" | "result",
    // Pre-test row (Session 36)
    sampleWeight: "", sampleUom: "g", samplePulledAt: "", samplePulledByName: "",
    // Lab sample collection (R 420.304(2), 2026-09-08)
    sourcePackageTag: "", sampleCollectedAt: "", sampleTransferredAt: "", sampleMetrcTag: "",
    labCollectorName: "", observerName: "", sourceRemainingQty: "", sourceRemainingUom: "",
    cocMetrcIdentified: false, cocObservedThroughout: false, cocNoAssist: false,
    cocSignedByInitials: "", cocSignedMeaning: "",
    // Result row
    testingAgencyId: "" as string, testingAgency: "",
    submittedDate: "", resultDate: "", testResult: "Pending",
    thcPct: "", cbdPct: "", totalCannabinoids: "", vitaminEAcetate: "",
    microbialsPass: "pending", pesticidesPass: "pending", heavyMetalsPass: "pending", residualSolventsPass: "pending", mctOilPass: "pending",
    notes: "",
  });
  const [testError, setTestError] = useState<string | null>(null);
  // 2026-09-08 — create the lab TEST SAMPLE package in METRC. R 420.304(2)(j)
  // puts that entry on us, not the lab, and it is also what deducts the sampled
  // amount from our bulk there. The operator supplies the source tag and the
  // amount; METRC supplies the item, the room and an unused tag.
  const [creatingSample, setCreatingSample] = useState(false);
  const createSampleInMetrc = async () => {
    setTestError(null);
    const src = testValues.sourcePackageTag.trim();
    const qty = parseFloat(testValues.sampleWeight);
    if (!src) { setTestError("Scan the source package tag first — the package the lab sampled from."); return; }
    if (!Number.isFinite(qty) || qty <= 0) { setTestError("Enter the amount the lab took before creating the sample package."); return; }
    // — The laboratory tags the sample with ITS OWN tag. We never assign one.
    if (!testValues.sampleMetrcTag.trim()) { setTestError("Scan the tag the lab put on the sample first."); return; }
    setCreatingSample(true);
    try {
      const r = await fetch(`/api/metrc/packages/create-testing-sample?confirm=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          sourcePackageLabel: src,
          quantity: qty,
          unitOfMeasure: testValues.sampleUom || undefined,
          tag: testValues.sampleMetrcTag.trim() || undefined,
          // A7 — the server resolves the METRC testing panel from this and
          // refuses if the product type does not determine one. An infused
          // pre-roll goes in as an Inhalable Compound Concentrate, a vape cart
          // as a Vape Concentrate, and so on.
          productType: batch?.productType ?? undefined,
        }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || d?.ok === false) throw new Error(d?.error || "METRC refused to create the sample package.");
      setTestValues(v => ({ ...v, sampleMetrcTag: String(d?.tag ?? v.sampleMetrcTag) }));
      const panel = Array.isArray(d?.labTestBatches) ? d.labTestBatches.join(", ") : null;
      toast({
        title: "Sample package created in METRC",
        description: `Tag ${d?.tag}. The amount was deducted from ${src}.` + (panel ? ` Testing panel: ${panel}.` : ""),
      });
    } catch (e) {
      setTestError(e instanceof Error ? e.message : "Failed to create the sample package.");
    } finally {
      setCreatingSample(false);
    }
  };

  // Session 36 — query for Approved Testing Laboratories to populate the
  // Agency Select. Server enforces the same filter on POST/PATCH.
  const { data: testingLabs } = useListSuppliers({ type: "Testing Laboratory", status: "Approved" });

  const relatedNCs        = allNCs?.filter((nc) => nc.batchId === id) ?? [];
  const relatedComplaints = allComplaints?.filter((c) => c.batchId === id) ?? [];

  const latestTest    = testResults && testResults.length > 0 ? testResults[testResults.length - 1] : null;
  const testingStatus = !latestTest ? "none"
    : latestTest.testResult === "Pass" ? "pass"
    : latestTest.testResult === "Fail" ? "fail"
    : "pending";

  // Dual Chamber Vape Cartridge (CRA MI_IB_0114) gets a chamber-grouped testing
  // panel (Chamber A / B / combined C) instead of the single generic result flow.
  const isDualChamber = batch?.productType === DUAL_CHAMBER_PRODUCT_TYPE;

  // Session 58 (06-04 compliance) — edibles report cannabinoid potency in
  // mg per serving, not % by weight. Kitchen is the edible process type. When
  // edible, the cannabinoid inputs/labels switch to mg/serving and the values
  // are stored under mg-per-serving keys in result_values (the % legacy
  // columns are left null so they never render a wrong "%" figure).
  const isEdible = (batch?.processType ?? "").toLowerCase() === "kitchen";
  const potencyUnit = isEdible ? "mg/serving" : "%";

  const labelingApproved = !!labeling?.approvalDate;
  const batchReleased    = batch?.status === "released_to_inventory" || batch?.status === "finished_goods";
  // 2026-08-10 — finished output. cases/cartons are new columns not yet in the
  // generated client type; read via cast. `hasOutput` gates release.
  const hasOutput = batch?.outputQuantity != null && batch.outputQuantity > 0;
  // JIT commit 2 (label-later) — packaged-but-unlabeled runs awaiting the
  // order-time Label & Finalize step. The metrc-tags feed already excludes
  // cancelled rows, so a plain label-status filter is sufficient. Pre-existing
  // runs (no label_status) default to 'labeled', so they never show here.
  const unlabeledRuns    = (metrcTags ?? []).filter((t) => (t.labelStatus ?? "labeled") === "unlabeled");
  const isTerminal       = TERMINAL_STATES.has(batch?.status ?? "");
  // Controlled so the next-action bar can send the operator straight to the tab
  // that owns the step, instead of expecting them to remember which one it is.
  const [activeTab, setActiveTab] = useState("overview");
  const isOnHold         = batch?.status === "on_hold";
  // Session 99 (#6) — header accent line = batch attention level (failed/destroyed
  // → urgent; on-hold/untested → caution); healthy/released reads calm/neutral.
  const batchHeaderRaw   = isOnHold ? ("caution" as const) : toneBatchStatus(batch?.status);
  const headerTone       = batchHeaderRaw === "good" ? "neutral" : batchHeaderRaw;
  const headerAccent     = accentClass(headerTone);

  const transitions = STATE_TRANSITIONS[batch?.status ?? ""] ?? [];

  // The ONE correct next step for this batch, derived live. Packaging is judged
  // by whether a package actually exists in METRC (metrcPackageCreatedAt), not by
  // whether a tag row exists — a hand-typed tag is not a package, and treating it
  // as one is what let an unpackaged batch read as "labeled for sale".
  const liveTags = (metrcTags ?? []).filter((t) => !t.cancelledAt);
  const packagedInMetrc = liveTags.filter((t) => !!t.metrcPackageCreatedAt);
  const labeledInMetrc = packagedInMetrc.filter((t) => (t.labelStatus ?? "labeled") === "labeled");
  const nextAction = useMemo((): { title: string; why: string; cta: string; go: () => void } | null => {
    switch (batch?.status) {
      case "in_production":
        return { title: "record the process steps", why: "Each step is signed as it is completed. The batch cannot go to testing until they are done.", cta: "Go to Process Steps", go: () => setActiveTab("process-steps") };
      case "testing_in_progress":
        return { title: "enter the lab results", why: "Results from a licensed Michigan laboratory are required before this batch can be packaged (R 420.305).", cta: "Go to Testing", go: () => setActiveTab("testing") };
      case "passed_awaiting_packaging":
        return { title: "release this batch to inventory", why: "Testing passed. Releasing draws the ingredients down from inventory and puts the batch in Bulk — Released, ready to package.", cta: "Go to Overview", go: () => setActiveTab("overview") };
      case "released_to_inventory":
        if (packagedInMetrc.length === 0) {
          return { title: "package this batch", why: "It is in Bulk — Released with no packages in METRC yet. Nothing can be labeled or shipped until the units exist there — this creates them and records the tags for you.", cta: "Go to Fulfillment", go: () => setActiveTab("shipping") };
        }
        if (labeledInMetrc.length === 0) {
          return { title: "label the packages", why: `${packagedInMetrc.length} package${packagedInMetrc.length === 1 ? "" : "s"} exist in METRC but are not labeled yet. A package must be labeled before it can go on a manifest (R 420.504).`, cta: "Go to Labeling", go: () => setActiveTab("labeling") };
        }
        return { title: "build the outbound manifest", why: `${labeledInMetrc.length} labeled package${labeledInMetrc.length === 1 ? " is" : "s are"} ready to ship. Pick the packages, the recipient and the transporter, then run pre-flight.`, cta: "Go to Fulfillment", go: () => setActiveTab("shipping") };
      default:
        return null;
    }
  }, [batch?.status, packagedInMetrc.length, labeledInMetrc.length]);

  const currentStepIndex = LIFECYCLE.indexOf(batch?.status ?? "");
  const progressPct = (isTerminal && batch?.status !== "finished_goods") || isOnHold
    ? 0
    : currentStepIndex >= 0
    ? Math.round(((currentStepIndex + 1) / LIFECYCLE.length) * 100)
    : 0;

  const printedAt = format(new Date(), "PPP 'at' HH:mm");

  const handleTransitionConfirm = async () => {
    if (!confirmTransition) return;
    try {
      await updateBatch.mutateAsync({ id, data: { status: confirmTransition.nextState } });
      queryClient.invalidateQueries({ queryKey: getGetBatchRecordQueryKey(id) });
      toast({ title: "Status Updated", description: `Batch moved to: ${STATE_LABELS[confirmTransition.nextState]}` });
    } catch (err: unknown) {
      // Session 66 (D3/D4) — surface the server's actual reason instead of a
      // generic toast. The "Send to Testing" guard (empty Ingredients, etc.) and
      // other transition gates return specific messages the user must see to act.
      // Extract across the shapes orval mutators / fetch wrappers use.
      const e = err as { response?: { data?: { error?: string } }; data?: { error?: string }; message?: string };
      const serverMsg = e?.response?.data?.error ?? e?.data?.error;
      const fallback = typeof e?.message === "string" && e.message && !e.message.toLowerCase().startsWith("request failed")
        ? e.message : null;
      toast({ title: "Error", description: serverMsg ?? fallback ?? "Failed to update batch status.", variant: "destructive" });
    } finally {
      setConfirmTransition(null);
    }
  };

  const handleSign = async (initials: string, meaning: string) => {
    const userId = currentUser?.id ?? 0;
    // Session 67 fix: do NOT wrap in a try/finally that force-closes the dialog.
    // On a rejected signature (e.g. initials don't match the account → 400) the
    // error must PROPAGATE to Part11SignatureDialog so it keeps the dialog open
    // and shows the reason. Previously the finally closed the dialog before the
    // error surfaced, so a bad signature looked accepted. On success the dialog
    // closes itself (onOpenChange(false)); here we only reset the pending action.
    if (signatureAction === "labeling") {
      await approveLabeling.mutateAsync({ id, data: { initials, signatureMeaning: meaning, userId } });
      queryClient.invalidateQueries({ queryKey: getGetBatchLabelingQueryKey(id) });
      toast({ title: "Labeling Approved", description: "Labeling approval recorded with electronic signature." });
    } else if (signatureAction === "release") {
      await releaseBatch.mutateAsync({ id, data: { initials, signingMeaning: meaning, userId } as never });
      queryClient.invalidateQueries({ queryKey: getGetBatchRecordQueryKey(id) });
      toast({ title: "Batch Released", description: "Batch released to inventory with electronic signature." });
    } else if (signatureAction === "labelAndFinalize") {
      // 2026-09-09 — records that the compliance label was applied to the
      // packaged runs. It does NOT close the batch: the rest of the bulk is still
      // in production. Raw fetch so the error PROPAGATES to the
      // signature dialog (keeps it open with the server reason) like the pattern
      // above; the route enforces the R 420.504 checklist gate + Part 11.
      const res = await fetch(`/api/batch-records/${id}/label-and-finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ initials, signingMeaning: meaning, dispensaryName: dispensaryName.trim() || undefined }),
      });
      if (!res.ok) {
        const msg = await res.json().then((d) => d?.error).catch(() => null);
        throw new Error(msg || "Failed to label & finalize.");
      }
      await queryClient.invalidateQueries({ queryKey: getGetBatchRecordQueryKey(id) });
      await queryClient.invalidateQueries({ queryKey: metrcTagsKey });
      queryClient.invalidateQueries({ queryKey: getGetBatchLabelingQueryKey(id) });
      setDispensaryName("");
      toast({ title: "Labels applied", description: "Units labeled per R 420.504. The batch stays open until the remaining bulk is packaged." });
    }
    // Refresh the batch audit log so the new LABELING_APPROVE / RELEASE entry
    // appears without a manual page reload.
    queryClient.invalidateQueries({ predicate: (q) => JSON.stringify(q.queryKey).toLowerCase().includes("audit") });
    setSignatureAction(null);
  };

  // Session 67 (Item 5 follow-up) — start labeling approval. Uses the
  // auto-populate route so it creates the batch_labeling record AND seeds the
  // CRA R 420.504 checklist items for the batch's product type (the plain create
  // route left the checklist empty). Idempotent server-side.
  const handleStartLabeling = async () => {
    if (!batch) return;
    setStartingLabeling(true);
    try {
      const resp = await fetch(`/api/batch-records/${id}/labeling/auto-populate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({})))?.error ?? "Failed to start labeling");
      const data = (await resp.json().catch(() => ({}))) as { seededCount?: number };
      await queryClient.invalidateQueries({ queryKey: getGetBatchLabelingQueryKey(id) });
      // Refresh the checklist list(s) regardless of their exact query key.
      await queryClient.invalidateQueries({ predicate: (q) => JSON.stringify(q.queryKey).includes("checklist") });
      toast({
        title: "Labeling started",
        description: data.seededCount
          ? `Checklist ready (${data.seededCount} items). Complete it, then approve labeling.`
          : "Complete the checklist, then approve labeling with your electronic signature.",
      });
    } catch (e: unknown) {
      toast({ title: "Could not start labeling", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    } finally {
      setStartingLabeling(false);
    }
  };

  // Follow-up (06-24) — change the batch's Sale type (Retail-ready vs
  // Bulk/Wholesale), which selects the labeling control set. After saving we
  // re-run auto-populate so an existing checklist is reseeded to the new control
  // set — the server only reseeds when no responses have been recorded yet, so a
  // mid-verification switch never silently wipes answered items.
  const handleChangeSaleType = async (value: string) => {
    if (!batch) return;
    try {
      await updateBatch.mutateAsync({ id, data: { saleType: value } as never });
      queryClient.invalidateQueries({ queryKey: getGetBatchRecordQueryKey(id) });
      if (labeling) {
        await fetch(`/api/batch-records/${id}/labeling/auto-populate`, {
          method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
          body: JSON.stringify({}),
        });
        await queryClient.invalidateQueries({ queryKey: getGetBatchLabelingQueryKey(id) });
        await queryClient.invalidateQueries({ predicate: (q) => JSON.stringify(q.queryKey).includes("checklist") });
      }
      toast({ title: "Sale type updated", description: value === "Bulk" ? "Bulk/Wholesale — transfer (manifest) label checklist applies." : "Retail-ready — consumer label checklist applies." });
    } catch {
      toast({ title: "Error", description: "Failed to update sale type.", variant: "destructive" });
    }
  };

  const openEdit = () => {
    setEditValues({
      productName:    batch?.productName ?? "",
      strainName:     batch?.strainName ?? "",
      strainType:     ((batch as unknown as { strainType?: string | null })?.strainType) ?? "",
      outputQuantity: batch?.outputQuantity?.toString() ?? "",
      scheduledOutputQuantity: batch?.scheduledOutputQuantity?.toString() ?? "",
      unitOfMeasure:  batch?.unitOfMeasure ?? "",
      labelNetWeight: ((batch as unknown as { labelNetWeight?: number | null })?.labelNetWeight)?.toString() ?? "",
      labelNetWeightUnit: ((batch as unknown as { labelNetWeightUnit?: string | null })?.labelNetWeightUnit) ?? "",
      metrcPackageId: batch?.metrcPackageId ?? "",
      productionDate: batch?.productionDate ?? "",
      notes:          batch?.notes ?? "",
    });
    setEditMode(true);
  };

  const handleSaveOverview = async () => {
    try {
      // Session 46 — scheduledOutputQuantity only included when the user is
      // approver-level. Server PATCH currently accepts the field without role
      // check; future hardening should mirror this gate server-side.
      const data: Record<string, unknown> = {
        outputQuantity: editValues.outputQuantity ? parseInt(editValues.outputQuantity, 10) : null,
        unitOfMeasure:  editValues.unitOfMeasure  || null,
        labelNetWeight: editValues.labelNetWeight.trim() === "" ? null : Number(editValues.labelNetWeight),
        labelNetWeightUnit: editValues.labelNetWeightUnit.trim() || null,
        // 2026-09-06 — metrcPackageId is deliberately NOT sent from this form any
        // more. It is set by signing the form-change process step (which creates
        // the package in METRC first), and the server now refuses it here anyway.
        productionDate: editValues.productionDate || null,
        notes:          editValues.notes          || null,
      };
      // Session 76.3 (OQ OBS-3) — only send identity fields while pre-test, and
      // never blank out the name.
      if (canEditIdentity && editValues.productName.trim()) {
        data.productName = editValues.productName.trim();
        data.strainName  = editValues.strainName.trim() || null;
        data.strainType  = editValues.strainType.trim() || null;
      }
      if (canEditPlannedOutput) {
        data.scheduledOutputQuantity = editValues.scheduledOutputQuantity
          ? parseFloat(editValues.scheduledOutputQuantity)
          : null;
      }
      await updateBatch.mutateAsync({ id, data: data as never });
      queryClient.invalidateQueries({ queryKey: getGetBatchRecordQueryKey(id) });
      setEditMode(false);
      toast({ title: "Batch Updated", description: "Batch record saved." });
    } catch {
      toast({ title: "Error", description: "Failed to save changes.", variant: "destructive" });
    }
  };

  // Session 46 — explicit per-row Edit entry point. Populates the Add
  // Ingredient dialog from an existing row, sets editingIngredientId so
  // handleAddIngredient PATCHes that row instead of inserting.
  // 2026-09-08 — ⛔ ONE LOT PER LINE, for now. Jonathan's call, and his
  // reasoning is the real constraint, not the plumbing: mixing lots changes the
  // potency number, so anything mixed has to be re-tested and re-labelled, and
  // two strains of flower means two harvest dates on one package. Splitting a
  // line across tags is therefore a deliberate, tested act — not something an
  // operator does to paper over a short lot. Short lots are handled by the
  // refusal below plus a Manager/Quality authorisation to run short.
  const startEditIngredient = (ing: unknown) => {
    const row = ing as {
      id: number;
      ingredientName: string;
      lotNumber: string | null;
      plannedQuantity: number | null;
      actualQuantity: number | null;
      unitOfMeasure: string;
      kind: string | null;
      supplierLotNumber: string | null;
      receivedAt: string | Date | null;
      expirationDate: string | null;
    };
    setEditingIngredientId(row.id);
    setIngValues({
      selectedPlannedId: null,
      ingredientName: row.ingredientName,
      lotNumber: row.lotNumber ?? "",
      plannedQuantity: row.plannedQuantity != null ? String(row.plannedQuantity) : "",
      actualQuantity: row.actualQuantity != null ? String(row.actualQuantity) : "",
      unitOfMeasure: row.unitOfMeasure || "g",
      kind: row.kind || "Ingredient",
      supplierLotNumber: row.supplierLotNumber ?? "",
      receivedAt: row.receivedAt
        ? (typeof row.receivedAt === "string" ? row.receivedAt.slice(0, 10) : new Date(row.receivedAt).toISOString().slice(0, 10))
        : "",
      expirationDate: row.expirationDate ? row.expirationDate.slice(0, 10) : "",
    });
    setIngError(null);
    setAddIngOpen(true);
  };

  const handleAddIngredient = async () => {
    setIngError(null);
    if (!ingValues.ingredientName) { setIngError("Ingredient name is required."); return; }
    if (!ingValues.unitOfMeasure)  { setIngError("Unit of measure is required."); return; }
    // Session 97 (cross-linking Slice 6) — resolve the picked lot number to its
    // real ledger FKs so the ingredient row links to the lot by id, not just the
    // lot-number string. Lot numbers are UNIQUE in the ledger, so this is
    // unambiguous. A hand-typed lot that matches no ledger row leaves the FKs
    // null (the free-text fallback). Populating lotId activates the FK-based lot
    // decrement/refund the commit route already prefers ("explicit lotId, else
    // the unique lot_number").
    const pickedLot = ingValues.lotNumber
      ? allInventory.find((i) => !!i.lotNumber && i.lotNumber === ingValues.lotNumber)
      : undefined;
    const lotId = pickedLot ? pickedLot.id : null;
    const inventoryItemId = pickedLot ? ((pickedLot as { inventoryItemId?: number | null }).inventoryItemId ?? null) : null;
    // Session 46 — explicit Edit path. When editingIngredientId is set the
    // operator clicked Edit on an existing row; PATCH the full editable
    // field set rather than insert a new row. Recipe-locked PATCH path
    // (selectedPlannedId) is unchanged.
    if (editingIngredientId !== null) {
      try {
        await updateIngredient.mutateAsync({
          id: editingIngredientId,
          data: {
            ingredientName: ingValues.ingredientName,
            lotNumber: ingValues.lotNumber || null,
            lotId,
            inventoryItemId,
            plannedQuantity: ingValues.plannedQuantity ? parseFloat(ingValues.plannedQuantity) : null,
            actualQuantity: ingValues.actualQuantity ? parseFloat(ingValues.actualQuantity) : null,
            unitOfMeasure: ingValues.unitOfMeasure,
            kind: ingValues.kind,
            supplierLotNumber: ingValues.supplierLotNumber || null,
            receivedAt: ingValues.receivedAt ? new Date(ingValues.receivedAt).toISOString() : null,
            expirationDate: ingValues.expirationDate || null,
          } as never,
        });
        queryClient.invalidateQueries({ queryKey: getListBatchIngredientsQueryKey(id) });
        setEditingIngredientId(null);
        setIngValues({ selectedPlannedId: null, ingredientName: "", lotNumber: "", plannedQuantity: "", actualQuantity: "", unitOfMeasure: "g", kind: "Ingredient", supplierLotNumber: "", receivedAt: "" });
        setAddIngOpen(false);
        toast({ title: "Ingredient Updated", description: `${ingValues.ingredientName} saved. If it was already drawn from inventory, click "Confirm ingredients & remove from inventory" to apply the change.` });
      } catch (e: unknown) {
        setIngError(e instanceof Error ? e.message : "Failed to update ingredient");
      }
      return;
    }
    // Recipe-driven mode: PATCH the existing planned row instead of inserting
    // a duplicate. Operator only contributed Lot + Actual; planned/type/unit
    // come from the recipe and are locked.
    if (ingValues.selectedPlannedId) {
      try {
        await updateIngredient.mutateAsync({
          id: ingValues.selectedPlannedId,
          data: {
            lotNumber:      ingValues.lotNumber || null,
            lotId,
            inventoryItemId,
            actualQuantity: ingValues.actualQuantity ? parseFloat(ingValues.actualQuantity) : null,
          } as never,
        });
        queryClient.invalidateQueries({ queryKey: getListBatchIngredientsQueryKey(id) });
        setIngValues({ selectedPlannedId: null, ingredientName: "", lotNumber: "", plannedQuantity: "", actualQuantity: "", unitOfMeasure: "g", kind: "Ingredient", supplierLotNumber: "", receivedAt: "" });
        setAddIngOpen(false);
        toast({ title: "Ingredient Recorded", description: `${ingValues.ingredientName} actual usage saved. Click "Confirm ingredients & remove from inventory" to update inventory.` });
      } catch (e: unknown) {
        setIngError(e instanceof Error ? e.message : "Failed to record ingredient");
      }
      return;
    }
    try {
      // `kind` is sent through the typed mutator via cast — server accepts it
      // (the route spreads req.body and the column is in the schema). Adding
      // it to the OpenAPI spec is a future codegen-touching cleanup.
      await createIngredient.mutateAsync({
        id,
        data: {
          ingredientName:  ingValues.ingredientName,
          lotNumber:       ingValues.lotNumber  || null,
          lotId,
          inventoryItemId,
          plannedQuantity: ingValues.plannedQuantity ? parseFloat(ingValues.plannedQuantity) : null,
          actualQuantity:  ingValues.actualQuantity  ? parseFloat(ingValues.actualQuantity)  : null,
          unitOfMeasure:   ingValues.unitOfMeasure,
          kind:            ingValues.kind,
          // Session 40 (Tier 3 #12e) — packaging-materials lot capture. The
          // server enforces presence on kind="Material"; we send both fields
          // unconditionally so an Ingredient → Material toggle on PATCH
          // keeps existing values rather than wiping them.
          supplierLotNumber: ingValues.supplierLotNumber || null,
          receivedAt:        ingValues.receivedAt ? new Date(ingValues.receivedAt).toISOString() : null,
          expirationDate:    ingValues.expirationDate || null,
        } as never,
      });
      queryClient.invalidateQueries({ queryKey: getListBatchIngredientsQueryKey(id) });
      setIngValues({ selectedPlannedId: null, ingredientName: "", lotNumber: "", plannedQuantity: "", actualQuantity: "", unitOfMeasure: "g", kind: "Ingredient", supplierLotNumber: "", receivedAt: "" });
      setAddIngOpen(false);
      toast({ title: "Ingredient Added", description: `${ingValues.ingredientName} added to bill of materials.` });
    } catch {
      setIngError("Failed to add ingredient.");
    }
  };

  // Session 79.5 — removing an ingredient that's already been drawn from inventory
  // (lotCommittedQty > 0) reverses a signed action: Admin-only, behind a Part 11
  // reason + e-signature, and it refunds the lot. Un-committed rows delete freely.
  const isAdmin = currentUser?.role === "Admin";
  const [committedDeleteIng, setCommittedDeleteIng] = useState<{ id: number; name: string } | null>(null);
  const [committedDeletePending, setCommittedDeletePending] = useState(false);

  const handleDeleteIngredient = async (ing: { id: number; ingredientName: string; lotCommittedQty?: number | null }) => {
    const committed = (ing.lotCommittedQty ?? 0) > 0;
    if (committed) {
      if (!isAdmin) {
        toast({ title: "Admin required", description: "Only an Admin can remove an ingredient that's already been drawn from inventory.", variant: "destructive" });
        return;
      }
      setCommittedDeleteIng({ id: ing.id, name: ing.ingredientName });
      return;
    }
    try {
      await deleteIngredient.mutateAsync({ id: ing.id });
      queryClient.invalidateQueries({ queryKey: getListBatchIngredientsQueryKey(id) });
      toast({ title: "Ingredient Removed", description: `${ing.ingredientName} removed from bill of materials.` });
    } catch {
      toast({ title: "Error", description: "Failed to remove ingredient.", variant: "destructive" });
    }
  };

  // Admin signed-delete of a committed ingredient. Throws on failure so the
  // signature dialog stays open and shows the server message.
  const handleConfirmCommittedDelete = async (initials: string, meaning: string) => {
    if (!committedDeleteIng) return;
    setCommittedDeletePending(true);
    try {
      const res = await fetch(`/api/batch-ingredients/${committedDeleteIng.id}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initials, signingMeaning: meaning }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to remove ingredient");
      }
      await queryClient.invalidateQueries({ queryKey: getListBatchIngredientsQueryKey(id) });
      await queryClient.invalidateQueries({ queryKey: getListInventoryItemsQueryKey() });
      const name = committedDeleteIng.name;
      setCommittedDeleteIng(null);
      toast({ title: "Ingredient removed", description: `${name} removed; its quantity was returned to inventory.` });
    } finally {
      setCommittedDeletePending(false);
    }
  };

  // 2026-09-08 (Jonathan) — "Please add some sort of save button in there.
  // Could be the split between Samples and Results". The one save button sat
  // BELOW the results half, so a collection with no results yet did not look
  // saveable at all. `sampleOnly` saves the row with the outcome forced to
  // Pending, which is exactly a collected sample awaiting the lab.
  const handleAddTestResult = async (opts?: { sampleOnly?: boolean }) => {
    const sampleOnly = opts?.sampleOnly === true;
    setTestError(null);
    // 2026-09-08 — phase is DERIVED, not picked. A row is a collected sample
    // until an outcome is recorded on it; the moment it is not Pending it is a
    // result and the lab becomes mandatory (the server enforces this too).
    const effectiveResult = sampleOnly ? "Pending" : testValues.testResult;
    const derivedPhase: "pre_test" | "result" = effectiveResult === "Pending" ? "pre_test" : "result";
    if (derivedPhase === "result" && !testValues.testingAgencyId && !testValues.testingAgency) {
      setTestError("Testing agency is required when recording a result.");
      return;
    }
    // "pending" sentinel → null in payload. Used instead of "" because Radix
    // Select cannot render SelectItem value="" (blank-screen crash).
    const boolOrNull = (v: string) => (v === "" || v === "pending") ? null : v === "true";
    const numOrNull = (v: string) => v ? parseFloat(v) : null;
    // Session 36 — build the state-variable result_values jsonb from the
    // structured analyte inputs. New code reads from here; the legacy columns
    // remain populated for back-compat display. Pass/fail analytes ride on
    // result_values too as booleans.
    const resultValues: Record<string, unknown> = {};
    // Session 58 — edibles store potency under mg-per-serving keys; everything
    // else keeps the % keys. record the basis so the value is unambiguous on
    // read-back and in the audit trail (Part 11).
    if (isEdible) {
      resultValues.potency_basis = "mg_per_serving";
      if (testValues.thcPct)            resultValues.thc_mg_per_serving           = parseFloat(testValues.thcPct);
      if (testValues.cbdPct)            resultValues.cbd_mg_per_serving           = parseFloat(testValues.cbdPct);
      if (testValues.totalCannabinoids) resultValues.total_cannabinoids_mg_per_serving = parseFloat(testValues.totalCannabinoids);
    } else {
      resultValues.potency_basis = "percent";
      if (testValues.thcPct)            resultValues.thc_pct           = parseFloat(testValues.thcPct);
      if (testValues.cbdPct)            resultValues.cbd_pct           = parseFloat(testValues.cbdPct);
      if (testValues.totalCannabinoids) resultValues.total_cannabinoids = parseFloat(testValues.totalCannabinoids);
    }
    if (testValues.vitaminEAcetate)   resultValues.vitamin_e_acetate = parseFloat(testValues.vitaminEAcetate);
    // Phase 5 — write whichever panels the STATE requires, not a fixed five.
    // Previously each of Michigan's five had its own line here, so a panel added
    // to a state's rule set would render an input and then silently drop the
    // value on save. Michigan's five still land in the same result_values keys
    // they always did (resultValueKey is just camelCase to snake_case), and the
    // legacy columns are still populated from testValues further down.
    for (const p of panelsForProduct(panelSetFor(resolvedRules), {
      isConcentrate: batchIsConcentrate, isVape: isVapeType(batch?.productType), isEdible, isFlower,
    })) {
      const v = boolOrNull((testValues as unknown as Record<string, string>)[p.key] ?? "pending");
      if (v !== null) resultValues[resultValueKey(p.key)] = v;
    }

    // Resolve the agency name from the dropdown selection for legacy display.
    const agencyIdNum = testValues.testingAgencyId ? parseInt(testValues.testingAgencyId, 10) : null;
    const selectedLab = agencyIdNum ? testingLabs?.find((s) => s.id === agencyIdNum) : null;
    const agencyName = selectedLab?.supplierName ?? testValues.testingAgency;

    // Session 69 — shared payload for create AND edit. Identical field shape;
    // only the endpoint (POST vs PATCH) differs by mode.
    const payload = {
      phase:                derivedPhase,
      sampleWeight:         numOrNull(testValues.sampleWeight),
      sampleUom:            testValues.sampleUom || null,
      samplePulledAt:       testValues.samplePulledAt || null,
      samplePulledByName:   testValues.samplePulledByName || null,
      // Lab sample collection (R 420.304(2)). Date-times go up as ISO instants;
      // the input is local wall-clock, which is what the operator observed.
      sourcePackageTag:     testValues.sourcePackageTag.trim() || null,
      sampleCollectedAt:    testValues.sampleCollectedAt ? new Date(testValues.sampleCollectedAt).toISOString() : null,
      sampleTransferredAt:  testValues.sampleTransferredAt ? new Date(testValues.sampleTransferredAt).toISOString() : null,
      sampleMetrcTag:       testValues.sampleMetrcTag.trim() || null,
      // 2026-09-08 — the LAB is the party of record, not one of its staff.
      // The field is gone from the form; the column stays for rows already written.
      labCollectorName:     null,
      observerName:         testValues.observerName.trim() || null,
      sourceRemainingQty:   numOrNull(testValues.sourceRemainingQty),
      sourceRemainingUom:   testValues.sourceRemainingUom.trim() || null,
      cocMetrcIdentified:   testValues.cocMetrcIdentified,
      cocObservedThroughout: testValues.cocObservedThroughout,
      cocNoAssist:          testValues.cocNoAssist,
      cocSignedByInitials:  testValues.cocSignedByInitials.trim() || null,
      cocSignedMeaning:     testValues.cocSignedMeaning.trim() || null,
      testingAgencyId:      agencyIdNum,
      testingAgency:        agencyName || "",
      submittedDate:        testValues.submittedDate       || null,
      resultDate:           testValues.resultDate          || null,
      testResult:           effectiveResult,
      resultValues:         Object.keys(resultValues).length ? resultValues : null,
      // For edibles the entered numbers are mg/serving and live in
      // result_values; leave the legacy "_pct" columns null so no % display
      // ever shows a mg figure.
      thcPct:               isEdible ? null : numOrNull(testValues.thcPct),
      cbdPct:               isEdible ? null : numOrNull(testValues.cbdPct),
      totalCannabinoids:    isEdible ? null : numOrNull(testValues.totalCannabinoids),
      vitaminEAcetate:      numOrNull(testValues.vitaminEAcetate),
      // The five legacy COLUMNS are still written, straight from the form state.
      // They pre-date result_values and existing rows carry values in them, so
      // dropping them would orphan every test recorded before Session 36. A
      // panel a state adds beyond these five has no column and lives only in
      // result_values above — that is expected, not a gap.
      microbialsPass:       boolOrNull(testValues.microbialsPass),
      pesticidesPass:       boolOrNull(testValues.pesticidesPass),
      heavyMetalsPass:      boolOrNull(testValues.heavyMetalsPass),
      residualSolventsPass: boolOrNull(testValues.residualSolventsPass),
      mctOilPass:           boolOrNull(testValues.mctOilPass),
      notes:                testValues.notes               || null,
    };
    const isEditing = editTestId != null;
    try {
      if (isEditing) {
        await updateTestResult.mutateAsync({ id: editTestId as number, data: payload as never });
      } else {
        await createTestResult.mutateAsync({ id, data: payload as never });
      }
      queryClient.invalidateQueries({ queryKey: getListBatchTestResultsQueryKey(id) });
      resetTestForm();
      setAddTestOpen(false);
      toast({
        title: isEditing ? "Test sample updated" : (derivedPhase === "pre_test" ? "Test sample recorded" : "Test result added"),
        description: isEditing
          ? "Your changes were saved."
          : derivedPhase === "pre_test"
            ? "Sample collection recorded. Open this row again when the lab reports, or pull the results from METRC."
            : "Test result recorded for this batch.",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : `Failed to ${isEditing ? "update" : "add"} test result.`;
      setTestError(msg);
    }
  };

  // Session 69 — reset the dialog back to a clean "add" state.
  const resetTestForm = () => {
    setEditTestId(null);
    setTestError(null);
    setTestValues({
      phase: "result",
      sampleWeight: "", sampleUom: "g", samplePulledAt: "", samplePulledByName: "",
      sourcePackageTag: "", sampleCollectedAt: "", sampleTransferredAt: "", sampleMetrcTag: "",
      labCollectorName: "", observerName: "", sourceRemainingQty: "", sourceRemainingUom: "",
      cocMetrcIdentified: false, cocObservedThroughout: false, cocNoAssist: false,
      cocSignedByInitials: "", cocSignedMeaning: "",
      testingAgencyId: "", testingAgency: "",
      submittedDate: "", resultDate: "", testResult: "Pending",
      thcPct: "", cbdPct: "", totalCannabinoids: "", vitaminEAcetate: "",
      microbialsPass: "pending", pesticidesPass: "pending", heavyMetalsPass: "pending", residualSolventsPass: "pending", mctOilPass: "pending",
      notes: "",
    });
  };

  // Session 69 — populate the dialog from an existing test row and open it in
  // edit mode. Maps the stored shape back into the form's string state: potency
  // is read from result_values honoring the stored basis (mg/serving for
  // edibles, % otherwise) with a fallback to the legacy columns; dates are
  // trimmed to yyyy-MM-dd for the native date inputs; pass panels become the
  // "true"/"false"/"pending" sentinels the Selects use.
  const openEditTest = (test: Record<string, unknown>) => {
    const rv = (test.resultValues ?? {}) as Record<string, unknown>;
    const isMg = rv.potency_basis === "mg_per_serving";
    const numStr = (v: unknown) => (v === null || v === undefined || v === "") ? "" : String(v);
    const passStr = (v: unknown) => v === true ? "true" : v === false ? "false" : "pending";
    const dateStr = (v: unknown) => {
      if (!v) return "";
      const d = new Date(v as string);
      return Number.isNaN(d.getTime()) ? "" : format(d, "yyyy-MM-dd");
    };
    // datetime-local wants "yyyy-MM-ddTHH:mm" in LOCAL time. format() is local,
    // so this never goes through toISOString() (which is UTC and lands a day
    // early after 8pm Eastern — see lib/facilityDate.ts on the server).
    const dtLocal = (v: unknown) => {
      if (!v) return "";
      const d = new Date(v as string);
      return Number.isNaN(d.getTime()) ? "" : format(d, "yyyy-MM-dd'T'HH:mm");
    };
    const thc   = isMg ? rv.thc_mg_per_serving           : (rv.thc_pct           ?? test.thcPct);
    const cbd   = isMg ? rv.cbd_mg_per_serving           : (rv.cbd_pct           ?? test.cbdPct);
    const total = isMg ? rv.total_cannabinoids_mg_per_serving : (rv.total_cannabinoids ?? test.totalCannabinoids);
    setEditTestId(test.id as number);
    setTestError(null);
    setTestValues({
      phase: (test.phase as "pre_test" | "result") ?? "result",
      sampleWeight: numStr(test.sampleWeight),
      sampleUom: (test.sampleUom as string) || "g",
      samplePulledAt: dateStr(test.samplePulledAt),
      samplePulledByName: (test.samplePulledByName as string) || "",
      sourcePackageTag: (test.sourcePackageTag as string) || "",
      sampleCollectedAt: dtLocal(test.sampleCollectedAt),
      sampleTransferredAt: dtLocal(test.sampleTransferredAt),
      sampleMetrcTag: (test.sampleMetrcTag as string) || "",
      labCollectorName: (test.labCollectorName as string) || "",
      observerName: (test.observerName as string) || "",
      sourceRemainingQty: numStr(test.sourceRemainingQty),
      sourceRemainingUom: (test.sourceRemainingUom as string) || "",
      cocMetrcIdentified: test.cocMetrcIdentified === true,
      cocObservedThroughout: test.cocObservedThroughout === true,
      cocNoAssist: test.cocNoAssist === true,
      // A signature is never re-sent from an edit — it is signed once, on the row.
      cocSignedByInitials: "", cocSignedMeaning: "",
      testingAgencyId: test.testingAgencyId != null ? String(test.testingAgencyId) : "",
      testingAgency: (test.testingAgency as string) || "",
      submittedDate: dateStr(test.submittedDate),
      resultDate: dateStr(test.resultDate),
      testResult: (test.testResult as string) || "Pending",
      thcPct: numStr(thc),
      cbdPct: numStr(cbd),
      totalCannabinoids: numStr(total),
      vitaminEAcetate: numStr(rv.vitamin_e_acetate ?? test.vitaminEAcetate),
      microbialsPass: passStr(rv.microbials_pass ?? test.microbialsPass),
      pesticidesPass: passStr(rv.pesticides_pass ?? test.pesticidesPass),
      heavyMetalsPass: passStr(rv.heavy_metals_pass ?? test.heavyMetalsPass),
      residualSolventsPass: passStr(rv.residual_solvents_pass ?? test.residualSolventsPass),
      mctOilPass: passStr(rv.mct_oil_pass ?? test.mctOilPass),
      notes: (test.notes as string) || "",
    });
    setAddTestOpen(true);
  };

  if (isLoading) {
    return (
      <>
        <div className="max-w-6xl mx-auto space-y-6 py-6">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </>
    );
  }

  // Session 58 (06-04) — Bill of Materials split by `kind`. The operator asked
  // to separate food ingredients from materials and to give packaging/labeling
  // its own tab. One reusable card renders a kind group; "Food Ingredients"
  // also catches legacy rows that have no kind (default "Ingredient").
  type IngRow = NonNullable<typeof ingredients>[number];
  const renderIngredientCard = (title: string, desc: string, list: IngRow[], withAdd: boolean, addKind: string = "Ingredient") => (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">{title}{list.length > 0 && <span className="ml-2 text-xs bg-muted rounded-full px-1.5 py-0.5">{list.length}</span>}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
          </div>
          {/* Session 82 follow-up — Add line moved to the card FOOTER (below) so
              it reads as "add a row," not an action on the whole section. */}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {list.length === 0 ? (
          <div className="p-4"><p className="text-sm text-muted-foreground">None recorded.</p></div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Lot Number</TableHead>
                <TableHead>Expiration</TableHead>
                <TableHead className="text-right">Planned Qty</TableHead>
                <TableHead className="text-right">Actual Qty</TableHead>
                <TableHead>UoM</TableHead>
                <TableHead>Variance</TableHead>
                <TableHead className="print:hidden w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((ing, i) => {
                const variance = ing.plannedQuantity && ing.actualQuantity
                  ? ((ing.actualQuantity - ing.plannedQuantity) / ing.plannedQuantity * 100).toFixed(1)
                  : null;
                // Session 79.6 — per-row inventory-commit status so it's obvious
                // which rows are drawn from inventory vs entered/edited and still
                // pending the signed "Confirm ingredients" step.
                const rowActual = ing.actualQuantity ?? 0;
                const rowCommitted = (ing as { lotCommittedQty?: number | null }).lotCommittedQty ?? 0;
                const inInventory = rowCommitted > 0 && Math.abs(rowCommitted - rowActual) < 1e-9;
                const editedPending = rowCommitted > 0 && Math.abs(rowCommitted - rowActual) >= 1e-9;
                return (
                  <TableRow key={ing.id}>
                    <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="font-medium">
                      {ing.ingredientName}
                      {rowActual > 0 && (
                        inInventory ? (
                          <span className="mt-0.5 flex items-center gap-1 text-[10px] font-normal text-emerald-700"><CheckCircle2 className="h-3 w-3" />In inventory</span>
                        ) : editedPending ? (
                          <span className="mt-0.5 block text-[10px] font-normal text-amber-600">Edited · re-confirm to update inventory</span>
                        ) : (
                          <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">Not yet in inventory</span>
                        )
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {ing.lotNumber ?? "—"}
                      {(ing as { supplierLotNumber?: string | null }).supplierLotNumber && (
                        <div className="text-[10px] text-muted-foreground mt-0.5">supplier: {(ing as { supplierLotNumber?: string | null }).supplierLotNumber}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {(() => {
                        // BR-1/BR-3 — surface the line's expiry on the record + print,
                        // flagging expired (red) and expiring-soon within 30d (amber).
                        const exp = (ing as { expirationDate?: string | null }).expirationDate;
                        if (!exp) return <span className="text-muted-foreground">—</span>;
                        // Parse the date-only value at local midnight so it doesn't
                        // shift a day in negative-UTC timezones.
                        const d = new Date(`${String(exp).slice(0, 10)}T00:00:00`);
                        if (Number.isNaN(d.getTime())) return <span className="text-muted-foreground">—</span>;
                        const days = (d.getTime() - Date.now()) / 86400000;
                        const tone = days < 0 ? "text-destructive font-medium" : days <= 30 ? "text-amber-600 dark:text-amber-400" : "";
                        return <span className={tone}>{format(d, "MMM d, yyyy")}{days < 0 ? " (expired)" : ""}</span>;
                      })()}
                    </TableCell>
                    <TableCell className="text-right">{ing.plannedQuantity?.toString() ?? "—"}</TableCell>
                    <TableCell className="text-right font-semibold">{ing.actualQuantity?.toString() ?? "—"}</TableCell>
                    <TableCell>{ing.unitOfMeasure}</TableCell>
                    <TableCell>
                      {variance !== null ? (
                        <span className={`text-xs font-medium ${Math.abs(parseFloat(variance)) > 2 ? "text-amber-600" : "text-muted-foreground"}`}>
                          {parseFloat(variance) > 0 ? "+" : ""}{variance}%
                        </span>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="print:hidden">
                      {!isTerminal && (
                        <div className="flex items-center gap-0.5 justify-end">
                          {/* Session 82 (#2) — explicit, labeled per-row action so the
                              edit path is obvious. A preset recipe row still awaiting its
                              actual reads "Record"; an already-recorded row reads "Edit". */}
                          <Button variant="outline" size="sm" className="h-7 px-2 gap-1" onClick={() => startEditIngredient(ing)} aria-label={ing.actualQuantity == null ? "Record actual usage" : "Edit item"} title={ing.actualQuantity == null ? "Record actual usage" : "Edit item"}>
                            <Pencil className="h-3.5 w-3.5" />
                            {ing.actualQuantity == null ? "Record" : "Edit"}
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => handleDeleteIngredient(ing)} aria-label="Delete item" title="Delete item">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {withAdd && !isTerminal && (
          <div className="border-t p-2 print:hidden">
            <Button variant="ghost" size="sm" className="w-full justify-center gap-1 h-8 text-xs text-muted-foreground hover:text-foreground" onClick={() => openAddIngredient(addKind)}>
              <Plus className="h-3.5 w-3.5" />
              Add line
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
  // Compliance labels are inventory items (their own lot numbers) applied per unit
  // at the LABELING stage — they are not consumed as a food ingredient, material,
  // or packaging component, so they don't belong on the BOM cards. Keep them off
  // Ingredients/Packaging and surface them on the Labeling tab (labelItems below)
  // for lot traceability. Matched by itemType so it's independent of which BOM
  // "kind" the line happened to be added as.
  const isLabelItem = (ing: unknown) => /label/i.test(String((ing as { itemType?: string }).itemType ?? ""));
  // 2026-09-07 — a line is a LABEL line when its catalog item type says so OR
  // when the BOM kind is "Labeling". Without the second half a Labeling-kind row
  // whose catalog item is not typed Label would match no card at all and be
  // invisible on every tab.
  const isLabelRow = (ing: unknown) => isLabelItem(ing) || (ing as { kind?: string }).kind === "Labeling";
  const foodIngredients = (ingredients ?? []).filter((ing) => ((ing as { kind?: string }).kind ?? "Ingredient") === "Ingredient" && !isLabelRow(ing));
  const materialItems   = (ingredients ?? []).filter((ing) => (ing as { kind?: string }).kind === "Material" && !isLabelRow(ing));
  const packagingItems  = (ingredients ?? []).filter((ing) => (ing as { kind?: string }).kind === "Packaging" && !isLabelRow(ing));
  const labelItems      = (ingredients ?? []).filter((ing) => isLabelRow(ing));
  // Session 108 — MI classifies infused/compound pre-rolls as CONCENTRATES for
  // testing (bulletin 9/19/2022). A pre-roll is "infused" when its bill of
  // materials consumes a concentrate input (distillate, kief, rosin, etc.), so
  // its testing panel should follow the concentrate rules even if the product
  // TYPE string just reads "Pre-Roll" (i.e. someone didn't name it exactly
  // "Infused Pre-Roll"). Scoped to pre-rolls on purpose: an EDIBLE also consumes
  // distillate but must keep edible testing rules, so it must NOT flip here.
  const isPreRollType = /pre-?roll/.test(String(batch?.productType ?? "").toLowerCase());
  const bomHasConcentrate = (ingredients ?? []).some((ing) => {
    const n = String((ing as { ingredientName?: string }).ingredientName ?? "").toLowerCase();
    return /distillate|kief|rosin|resin|shatter|diamond|hash|badder|budder|\bwax\b|isolate|extract|concentrate/.test(n);
  });
  const batchIsConcentrate = isConcentrateType(batch?.productType) || (isPreRollType && bomHasConcentrate);

  // Phase 5 — the FLOWER gate, needed by states that test moisture and water
  // activity on raw flower. Michigan has no such panel, so nothing today uses
  // this; New York does (9 NYCRR 130.22). A pre-roll counts as flower ONLY when
  // it is not infused — an infused pre-roll is already handled as a concentrate
  // above (MI bulletin 9/19/2022), and it should not be asked for both.
  const isFlower = /flower/.test(String(batch?.productType ?? "").toLowerCase())
    || (isPreRollType && !batchIsConcentrate);
  // Session 79 (Step 3) — lot-commit status. A row is "pending" when its actual
  // quantity differs from what's already been drawn from its lot (lotCommittedQty).
  // 2026-09-07 — a row can only be DRAWN from inventory if it has a lot to draw
  // from. The commit route skips a row it cannot resolve to a lot, so a no-lot
  // packaging line (cartons, closures, compliance labels — materials that
  // legitimately carry no lot number) could never have its lotCommittedQty
  // satisfied. Counting it as pending meant a banner that never cleared, a
  // signature that reported "nothing to remove", and — the real damage — a
  // Release button disabled forever, since release is gated on hasPendingCommit.
  // Such a row is recorded on the batch record; there is simply no lot ledger to
  // move, which is exactly what "no lot" means.
  const isDrawableRow = (r: unknown) => {
    const row = r as { lotNumber?: string | null; lotId?: number | null };
    return !!(row.lotNumber ?? "").trim() || row.lotId != null;
  };
  const committableRows = (ingredients ?? []).filter((r) => ((r as { actualQuantity?: number | null }).actualQuantity ?? 0) > 0 && isDrawableRow(r));
  const pendingCommitRows = committableRows.filter((r) => ((r as { lotCommittedQty?: number | null }).lotCommittedQty ?? 0) !== ((r as { actualQuantity?: number | null }).actualQuantity ?? 0));
  const hasPendingCommit = pendingCommitRows.length > 0;

  // BR-5 (2026-07-12) — guard against gross Actual Qty slips (e.g. 10,000 g of
  // flower instead of 1,000). Warn + require an explicit acknowledgement when the
  // entered actual is far over the planned amount, or (for a fresh add) exceeds
  // the selected lot's on-hand quantity. Editing an existing row skips the
  // on-hand check because that lot may already be decremented by the same row.
  const ingActualNum = parseFloat(ingValues.actualQuantity);
  const ingPlannedNum = parseFloat(ingValues.plannedQuantity);
  const ingLotOnHand = editingIngredientId === null && ingValues.lotNumber
    ? (allInventory.find((i) => !!i.lotNumber && i.lotNumber === ingValues.lotNumber)?.quantity ?? null)
    : null;
  // BR-1/BR-3 — the inventory lot currently picked in the dialog (matched by the
  // unique lot number). When set, it IS the material's vendor lot (so the separate
  // "Supplier Lot #" entry is demoted) and its expiry drives the auto-fill hint.
  const pickedInvLot = ingValues.lotNumber
    ? (allInventory.find((i) => !!i.lotNumber && i.lotNumber === ingValues.lotNumber) ?? null)
    : null;
  const pickedLotExpiry = (pickedInvLot as { expirationDate?: string | null } | null)?.expirationDate ?? null;
  // Unit conversion (imperial/metric). The entered actual is in the row's unit;
  // the picked lot's on-hand is in the LOT's unit. Convert the draw into the lot's
  // unit so the on-hand check compares like-for-like (e.g. 25,000 g against a 50 lb
  // bag), matching the server's unit-aware deduction. Helpers from @/lib/units.
  const pickedLotUnit = (pickedInvLot as { unitOfMeasure?: string | null } | null)?.unitOfMeasure ?? null;
  const rowUnit = ingValues.unitOfMeasure;
  const unitsDiffer = !!pickedLotUnit && !!rowUnit && rowUnit.trim().toLowerCase() !== pickedLotUnit.trim().toLowerCase();
  // Incompatible = different KINDS of measure (count vs weight vs volume): the
  // server can't deduct, so we block the add and explain rather than let it fail.
  const unitsIncompatible = !!pickedInvLot && !!rowUnit && !!pickedLotUnit && !areCompatible(rowUnit, pickedLotUnit);

  // BOM INTEGRITY HARD STOP (2026-09-06, Jonathan's ruling: "I do not want them
  // adding 5kg of salt when 5kg of flour is required").
  //
  // When the line's item is FIXED — locked from a recipe row, or editing an
  // existing line that already names its item — the operator may only draw from
  // lots of THAT item. Previously the picker restricted itself only when matching
  // lots existed; with none it fell open to the entire in-stock list AND offered
  // free-text lot entry, which is exactly how a wrong material gets recorded
  // against a recipe line. There is no substitution path: a different material is
  // never a valid answer, so with no matching stock the add is refused outright
  // and the operator has to receive the right material first.
  //
  // Duplicated deliberately from the picker's own matching (which needs the full
  // candidate lists to render): this is the same rule stated where the Add button
  // can see it. Keep the two canon() definitions in step.
  // 2026-09-07 (Jonathan) — PACKAGING AND LABELING LINES DO NOT REQUIRE A LOT.
  // His 08-12 ruling: cartons, closures and compliance labels often carry no lot
  // number at all, so one was never made mandatory to record them. The lot
  // PICKER disagreed — it only ever offered rows that had a lot — so a
  // recipe-locked carton line with real on-hand stock and no lot number matched
  // nothing, the Add button stayed disabled, and there was no way forward. The
  // BOM-integrity rule is untouched: still only this line's own item, never a
  // substitute. Only the lot requirement is lifted, and only for the two kinds
  // that are consumed at packaging.
  const ingIsPackagingStage = isPackagingStageKind(ingValues.kind);
  const bomCanon = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/s$/, "");
  const bomItemFixed = !!ingValues.ingredientName.trim() && (!!ingValues.selectedPlannedId || editingIngredientId !== null);
  const bomHasMatchingStock = (() => {
    const want = bomCanon(ingValues.ingredientName);
    if (!want) return false;
    return allInventory.some((i) => {
      if ((i.quantity ?? 0) <= 0) return false;
      if (!i.lotNumber && !ingIsPackagingStage) return false;
      if (bomCanon(i.itemName) === want) return true;
      const t = bomCanon((i as { itemType?: string }).itemType ?? "");
      return t.length > 0 && (want.includes(t) || t.includes(want));
    });
  })();
  // True when a recipe-locked line has NO stock of its own item: block the add.
  const bomNoMatchingStock = bomItemFixed && !bomHasMatchingStock;
  const drawConv = (Number.isFinite(ingActualNum) && pickedLotUnit)
    ? convertQuantity(ingActualNum, rowUnit, pickedLotUnit)
    : null;
  const drawInLotUnit = drawConv && drawConv.ok ? drawConv.value : null; // entered actual, in the lot's unit
  const ingOverPlanned = Number.isFinite(ingPlannedNum) && ingPlannedNum > 0 && Number.isFinite(ingActualNum) && ingActualNum >= ingPlannedNum * 3;
  const ingOverLot = ingLotOnHand != null && drawInLotUnit != null && drawInLotUnit > ingLotOnHand;
  const ingQtyWarn = Number.isFinite(ingActualNum) && ingActualNum > 0 && (ingOverPlanned || ingOverLot);

  // BR-4 (2026-07-13) — the "Confirm ingredients & remove from inventory" control
  // draws down ALL recorded batch rows (ingredients, materials, AND packaging),
  // so it's rendered at the bottom of BOTH the Ingredients and Packaging tabs.
  // Previously it lived only on Ingredients, forcing users to tab back there to
  // commit packaging additions.
  function renderInventoryCommitBlock() {
    if (isTerminal || committableRows.length === 0) return null;
    return (
      <>
      {/* 2026-09-08 — the lot could not cover the line. Nothing was drawn.
          Fix it by adding another lot for the remainder, or — Manager/Quality
          only — authorise running the line short, which draws what is really
          there and records THAT as the actual. */}
      {shortfall && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50/70 px-4 py-3 space-y-2 print:hidden">
          <p className="text-sm font-medium text-amber-900">Not enough material — nothing was drawn</p>
          <ul className="text-xs text-amber-900 list-disc pl-5 space-y-0.5">
            {shortfall.lines.map((f, i) => (
              <li key={i}>
                <span className="font-medium">{f.ingredientName}</span> — lot {f.lotNumber ?? "?"} holds {f.have} {f.uom}, the batch asks for {f.want} {f.uom}
              </li>
            ))}
          </ul>
          <p className="text-xs text-amber-800">
            Lower the recorded amount to what the lot holds, or pick a lot that can cover it{canAuthoriseShort ? ", or authorise running short below." : ". Running short must be authorised by Manager or Quality."}
          </p>
          {canAuthoriseShort && (
            <div className="flex flex-wrap items-end gap-2 pt-1">
              <div className="flex-1 min-w-[220px]">
                <Label className="text-xs">Reason for running short</Label>
                <Input className="mt-1 h-8 text-xs" value={shortReason} onChange={(e) => setShortReason(e.target.value)} placeholder="e.g. remaining stock committed to another batch" />
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!shortReason.trim() || ingCommitPending}
                onClick={() => { setShortDrawSigning(true); setIngCommitOpen(true); }}
              >
                Authorise running short
              </Button>
            </div>
          )}
        </div>
      )}
      <div className="mt-4 rounded-md border bg-muted/20 px-4 py-3 flex items-center justify-between gap-3 print:hidden">
        <div className="text-sm">
          {hasPendingCommit ? (
            <span className="text-muted-foreground">
              {pendingCommitRows.length} item(s) entered or edited but not yet reflected in inventory. Sign to draw the new quantities down from their lots.
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="h-4 w-4" /> All recorded items have been removed from inventory.
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant={hasPendingCommit ? "default" : "outline"}
          disabled={!hasPendingCommit}
          onClick={() => setIngCommitOpen(true)}
        >
          <ShieldCheck className="h-4 w-4 mr-1.5" />
          Confirm ingredients &amp; remove from inventory
        </Button>
      </div>
      </>
    );
  }

  return (
    <>
      <div className="space-y-6 max-w-6xl mx-auto pb-16">

        {/* ── Print-only document header ── */}
        <div className="hidden print:block border-b-2 pb-4 mb-4">
          <div className="cq-page-heading flex justify-between items-start">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Batch Production Record</p>
              <h1 className="text-2xl font-bold mt-1">{batch?.batchNumber} — {batch?.productName}</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                {facilityName}{facilityLicense ? ` · License ${facilityLicense}` : ""}
              </p>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <p className="font-semibold">CONTROLLED DOCUMENT</p>
              <p>Printed: {printedAt}</p>
              <p>Status: {STATE_LABELS[batch?.status ?? ""] ?? batch?.status}</p>
            </div>
          </div>
        </div>

        {/* ── Print-only running footer ── repeats on every printed page (Chrome
            renders position:fixed print elements once per page) so a controlled
            document stays traceable to the batch + facility even if pages are
            separated. The page number sits in the @page bottom-right margin box
            (see index.css) where the print engine supports counters. */}
        <div className="hidden print:block print-running-footer">
          {facilityName}{facilityLicense ? ` · ${facilityLicense}` : ""} · Batch {batch?.batchNumber} · Controlled Document · Printed {printedAt}
        </div>

        {/* ── Screen header ── */}
        <div className={`print:hidden ${headerAccent ? `pl-3 ${headerAccent}` : ""}`}>
          <Link href="/batches" className="text-sm text-primary hover:underline mb-3 block">
            ← Back to Batch Records
          </Link>
          <div className="cq-page-heading flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                {batch?.batchNumber ?? <Skeleton className="h-8 w-[200px]" />}
              </h1>
              <p className="text-muted-foreground">{batch?.productName}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              {isOnHold ? (
                <StatusBadge tone="caution" label="On Hold" />
              ) : (batch?.status === "released_to_inventory" || batch?.status === "finished_goods") ? (
                // FG-1 follow-up — clarify Bulk — Released vs In Fulfillment on hover (users found the two confusing).
                <TermTip term={batch?.status === "finished_goods" ? "finishedGoods" : "released"} showGlyph={false}>
                  <StatusBadge tone={toneBatchStatus(batch?.status)} label={STATE_LABELS[batch?.status ?? ""] ?? batch?.status ?? ""} />
                </TermTip>
              ) : (
                <StatusBadge tone={toneBatchStatus(batch?.status)} label={STATE_LABELS[batch?.status ?? ""] ?? batch?.status ?? ""} />
              )}
              <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-1.5">
                <Printer className="h-4 w-4" />
                Print Record
              </Button>
            </div>
          </div>
        </div>

        {/* Linked Specification — drives Print Batch Record content */}
        {batch && <LinkedSpecPanel batch={batch as never} />}

        {/* Spec-driven sections (print-only output) */}
        {batch && (
          <BatchRecordSpecSections
            batch={batch as never}
            ingredients={ingredients as never}
            testResults={testResults as never}
          />
        )}

        {/* ── Compliance Summary Bar ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 print:hidden">
          <Card className={`p-3 ${testingStatus === "pass" ? "border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20" : testingStatus === "fail" ? "border-destructive/30 bg-destructive/5" : ""}`}>
            <div className="flex items-center gap-2">
              <FlaskConical className={`h-5 w-5 ${testingStatus === "pass" ? "text-emerald-600" : testingStatus === "fail" ? "text-destructive" : "text-muted-foreground"}`} />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground font-medium">Testing</p>
                <p className={`text-sm font-semibold ${testingStatus === "pass" ? "text-emerald-700" : testingStatus === "fail" ? "text-destructive" : "text-muted-foreground"}`}>
                  {testingStatus === "pass" ? "All Pass" : testingStatus === "fail" ? "FAILED" : testingStatus === "pending" ? "Pending" : "No Results"}
                </p>
              </div>
            </div>
          </Card>
          <Card className={`p-3 ${labelingApproved ? "border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20" : ""}`}>
            <div className="flex items-center gap-2">
              <Tag className={`h-5 w-5 ${labelingApproved ? "text-emerald-600" : "text-muted-foreground"}`} />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground font-medium">Labeling</p>
                <p className={`text-sm font-semibold ${labelingApproved ? "text-emerald-700" : "text-muted-foreground"}`}>
                  {labelingApproved ? "Approved" : labeling ? "Pending" : "Not Started"}
                </p>
              </div>
            </div>
          </Card>
          <Card className={`p-3 ${batchReleased ? "border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20" : ""}`}>
            <div className="flex items-center gap-2">
              <ShieldCheck className={`h-5 w-5 ${batchReleased ? "text-emerald-600" : "text-muted-foreground"}`} />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground font-medium">Release</p>
                <p className={`text-sm font-semibold ${batchReleased ? "text-emerald-700" : "text-muted-foreground"}`}>
                  {batchReleased ? "Released" : isTerminal ? STATE_LABELS[batch?.status ?? ""] : "Unreleased"}
                </p>
              </div>
            </div>
          </Card>
          <Card className={`p-3 ${batch?.metrcPackageId ? "border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20" : ""}`}>
            <div className="flex items-center gap-2">
              <FileText className={`h-5 w-5 ${batch?.metrcPackageId ? "text-emerald-600" : "text-muted-foreground"}`} />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground font-medium">METRC</p>
                <p className={`text-sm font-semibold truncate ${batch?.metrcPackageId ? "text-emerald-700" : "text-muted-foreground"}`}>
                  {batch?.metrcPackageId ? `…${batch.metrcPackageId.slice(-8)}` : "Not Linked"}
                </p>
              </div>
            </div>
          </Card>
          <Card className={`p-3 ${relatedNCs.filter(n => n.status !== "Closed").length > 0 || relatedComplaints.filter(c => c.status !== "Closed").length > 0 ? "border-amber-200 bg-amber-50/50" : "border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20"}`}>
            <div className="flex items-center gap-2">
              <AlertTriangle className={`h-5 w-5 ${relatedNCs.filter(n => n.status !== "Closed").length > 0 ? "text-amber-500" : "text-emerald-600"}`} />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground font-medium">Open Issues</p>
                <p className="text-sm font-semibold">
                  {relatedNCs.filter(n => n.status !== "Closed").length + relatedComplaints.filter(c => c.status !== "Closed").length === 0
                    ? <span className="text-emerald-700">None</span>
                    : <span className="text-amber-600">{relatedNCs.filter(n => n.status !== "Closed").length} NC · {relatedComplaints.filter(c => c.status !== "Closed").length}</span>
                  }
                </p>
              </div>
            </div>
          </Card>
        </div>

        {/* ── Lifecycle Progress ── */}
        <Card className="print:hidden">
          <CardContent className="pt-4 pb-4">
            {(isTerminal && batch?.status !== "finished_goods") || isOnHold ? (
              <div className="flex items-center gap-3">
                <Badge variant={batch?.status === "failed" || batch?.status === "destroyed" ? "destructive" : "secondary"} className="text-sm px-3 py-1">
                  {STATE_LABELS[batch?.status ?? ""]}
                </Badge>
                <p className="text-sm text-muted-foreground">
                  {isOnHold ? "Batch is currently on hold. Use the workflow actions below to resume or close." : "This batch has reached a terminal state."}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="font-medium">{STATE_LABELS[batch?.status ?? ""] ?? "Unknown"}</span>
                  <span>{progressPct}% complete</span>
                </div>
                <Progress value={progressPct} className="h-2" />
                <div className="flex justify-between">
                  {LIFECYCLE.map((state) => {
                    const idx     = LIFECYCLE.indexOf(state);
                    const current = LIFECYCLE.indexOf(batch?.status ?? "");
                    const done    = idx < current;
                    const active  = idx === current;
                    return (
                      <div key={state} className="flex flex-col items-center gap-1 flex-1">
                        <div className={`h-2.5 w-2.5 rounded-full border-2 ${done || active ? "bg-primary border-primary" : "bg-background border-muted-foreground/30"}`} />
                        <span className={`text-[10px] text-center leading-tight max-w-[60px] ${active ? "text-primary font-semibold" : done ? "text-muted-foreground" : "text-muted-foreground/50"}`}>
                          {STATE_LABELS_SHORT[state]}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Other actions (Session 114) ──────────────────────────────────
            Demoted. This card used to say "choose the next step", which is the
            job the next-action bar now does — and having both meant the primary
            step appeared twice, in two different wordings. What is left here is
            the exceptions: holds, failures, approvals and admin corrections. The
            transition that duplicates the bar's own button is filtered out
            below rather than rendered twice. ─────────────────────────────── */}
        {(transitions.length > 0 || (batch?.status === "finished_goods" && currentUser?.role === "Admin")) && (
          <Card className="print:hidden border-dashed">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start gap-4 flex-wrap">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium mb-0.5">Other actions</p>
                  <p className="text-xs text-muted-foreground">
                    Current state: <strong>{STATE_LABELS[batch?.status ?? ""]}</strong>. Holds, corrections and approvals — the next step for this batch is in the bar above.
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Part 11 release if in passed_awaiting_packaging */}
                  {batch?.status === "passed_awaiting_packaging" && (
                    <Button
                      variant="default"
                      size="sm"
                      className="gap-1.5"
                      disabled={!hasOutput || hasPendingCommit}
                      title={!hasOutput ? "Record the units produced on the Packaging tab before releasing." : hasPendingCommit ? "Confirm ingredients (draw them from inventory) on the Ingredients tab before releasing." : undefined}
                      onClick={() => { setSignatureAction("release"); setSignatureOpen(true); }}
                    >
                      <ShieldCheck className="h-4 w-4" />
                      Release Batch
                      <span className="text-xs opacity-70">(Requires Signature)</span>
                    </Button>
                  )}
                  {batch?.status === "passed_awaiting_packaging" && !hasOutput && (
                    <p className="w-full text-xs text-amber-700 flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      Record the units produced on the Packaging tab before this batch can be released.
                    </p>
                  )}
                  {batch?.status === "passed_awaiting_packaging" && hasOutput && hasPendingCommit && (
                    <p className="w-full text-xs text-amber-700 flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      Confirm ingredients on the Ingredients tab (this draws them from inventory) before this batch can be released.
                    </p>
                  )}
                  {/* Labeling approval if labeling exists and not yet approved.
                      Gated on the R 420.504 checklist being complete (Session 67). */}
                  {labeling && !labelingApproved && !batchReleased && !isTerminal && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      disabled={!checklistComplete || !canApproveLabeling}
                      title={!canApproveLabeling ? "Label approval requires Supervisor / Manager / Quality / Admin" : (!checklistComplete ? "Complete the labeling verification checklist first" : undefined)}
                      onClick={() => { setSignatureAction("labeling"); setSignatureOpen(true); }}
                    >
                      <Tag className="h-4 w-4" />
                      Approve Labeling
                    </Button>
                  )}
                  {batch?.status === "finished_goods" && currentUser?.role === "Admin" && (
                    <Button variant="outline" size="sm" className="gap-1.5"
                      onClick={() => setConfirmTransition({ label: "Reopen to Bulk — Released", nextState: "released_to_inventory", variant: "outline", icon: <PlayCircle className="h-4 w-4" />, description: "Reopen this batch back to Bulk — Released so more units can be packaged and fulfilled." })}>
                      <PlayCircle className="h-4 w-4" /> Reopen to Bulk — Released
                    </Button>
                  )}
                  {/* 2026-09-08 (Jonathan) — packaging is NOT offered up here any
                      more. He kept seeing "Group / Ship Units" as the next
                      step and never chose it, because a choice at the top of the
                      page is not where that work happens: "To put a selection
                      there now is confusing." It lives on the Fulfillment tab,
                      in the order the work is actually done. */}
                  {transitions.filter((t) => !(t.nextState === "finished_goods" && batch?.status === "released_to_inventory")).map((t) => (
                    <Button
                      key={t.nextState}
                      variant={t.variant}
                      size="sm"
                      className="gap-1.5"
                      onClick={() => t.nextState === "finished_goods" ? setFgDialogOpen(true) : setConfirmTransition(t)}
                    >
                      {t.icon}
                      {t.label}
                    </Button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* FG-3 — Create finished-goods packages in METRC + record tags (Confirm as Finished Goods). */}
        {batch && (
          <ConfirmFinishedGoodsDialog
            batchId={id}
            batchNumber={batch.batchNumber}
            sourceTagDefault={batch.metrcPackageId ?? null}
            open={fgDialogOpen}
            onOpenChange={setFgDialogOpen}
            onConfirmed={() => {
              queryClient.invalidateQueries({ queryKey: getGetBatchRecordQueryKey(id) });
              queryClient.invalidateQueries({ queryKey: metrcTagsKey });
              toast({ title: "Units confirmed", description: `${batch.batchNumber} packaged to METRC and closed — In Fulfillment.` });
            }}
          />
        )}

        {/* ── Next action (Session 114) ────────────────────────────────────
            A batch always has exactly ONE correct next step, and until now the
            screen never said which — it showed every tab and every button at
            once and left the operator to infer it. That is how a form-change
            note got entered for what was actually a packaging run, twice. This
            states the stage, names the single next action, and takes you there.
            Derived from live state (status + whether packages exist in METRC +
            whether they are labeled), never from a stored field, so it cannot
            drift from reality. ─────────────────────────────────────────────── */}
        {batch && !isTerminal && !isOnHold && nextAction && (
          <div className="rounded-lg border border-sky-300 bg-sky-50/60 dark:bg-sky-950/20 p-3 flex flex-wrap items-center gap-3 print:hidden">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Next: {nextAction.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{nextAction.why}</p>
            </div>
            <Button size="sm" className="shrink-0" onClick={nextAction.go}>
              {nextAction.cta} <ArrowRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        )}

        {/* ── Tabs ── */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="print:hidden">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="ingredients">
              Ingredients
              {foodIngredients.length + materialItems.length > 0 && (
                <span className="ml-1.5 text-xs bg-muted rounded-full px-1.5 py-0.5">{foodIngredients.length + materialItems.length}</span>
              )}
            </TabsTrigger>
            {/* Session 108 — tab order: Overview · Ingredients · Process Steps ·
                Testing · Packaging · Labeling · Compliance. Packaging moved to
                after Testing (feedback #6) so the tabs follow the real workflow;
                Compliance Trail stays last. */}
            <TabsTrigger value="process-steps">
              Process Steps
              {(processSteps?.length ?? 0) > 0 && (
                <span className="ml-1.5 text-xs bg-muted rounded-full px-1.5 py-0.5">
                  {(processSteps ?? []).filter((s) => s.completed).length}/{processSteps?.length ?? 0}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="testing">
              Testing
              {testingStatus === "fail" && <span className="ml-1.5 h-2 w-2 rounded-full bg-destructive inline-block" />}
              {testingStatus === "pass" && <span className="ml-1.5 h-2 w-2 rounded-full bg-emerald-500 inline-block" />}
            </TabsTrigger>
            <TabsTrigger value="packaging">
              Packaging
              {packagingItems.length > 0 && (
                <span className="ml-1.5 text-xs bg-muted rounded-full px-1.5 py-0.5">{packagingItems.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="labeling">Labeling</TabsTrigger>
            {/* Session 110 — Shipping split out of Labeling: holds METRC Tag
                History + the Outbound Manifest / Transfer. Order is now
                Packaging · Labeling · Shipping · Compliance so the tabs follow
                package → label → ship. */}
            <TabsTrigger value="shipping">Fulfillment</TabsTrigger>
            <TabsTrigger value="compliance">
              Compliance Trail
              {relatedNCs.length + relatedComplaints.length > 0 && (
                <span className="ml-1.5 text-xs bg-amber-100 text-amber-700 rounded-full px-1.5 py-0.5">
                  {relatedNCs.length + relatedComplaints.length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          {/* ─── Overview Tab ─── */}
          <TabsContent value="overview" forceMount>
            <div className="print:mt-6">
              <h2 className="hidden print:block text-lg font-bold mb-3 border-b pb-1">Section 1: Batch Overview</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Batch Information</CardTitle>
                    {!isTerminal && !editMode && (
                      <Button variant="ghost" size="sm" className="gap-1.5 h-7 print:hidden" onClick={openEdit}>
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {editMode ? (
                    <div className="space-y-3">
                      {/* Session 76.3 (OQ OBS-3) — correct a mistyped product
                          while the batch is pre-test. Locked once testing starts. */}
                      {canEditIdentity && (
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs">Product Name</Label>
                            <Input
                              className="h-8 mt-1"
                              value={editValues.productName}
                              onChange={(e) => setEditValues(v => ({ ...v, productName: e.target.value }))}
                            />
                          </div>
                          <div>
                            <Label className="text-xs">Strain / Flavor</Label>
                            <Input
                              className="h-8 mt-1"
                              value={editValues.strainName}
                              onChange={(e) => setEditValues(v => ({ ...v, strainName: e.target.value }))}
                            />
                          </div>
                          <div>
                            <Label className="text-xs">Strain Type</Label>
                            <Select value={editValues.strainType || "__none"} onValueChange={(v) => setEditValues(vv => ({ ...vv, strainType: v === "__none" ? "" : v }))}>
                              <SelectTrigger className="h-8 mt-1"><SelectValue placeholder="—" /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none">—</SelectItem>
                                {["Sativa", "Indica", "Hybrid"].map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label className="text-xs">Output Quantity (whole)</Label>
                          <Input
                            type="number"
                            step={1}
                            min={0}
                            className="h-8 mt-1"
                            value={editValues.outputQuantity}
                            onChange={(e) => setEditValues(v => ({ ...v, outputQuantity: e.target.value.replace(/[^0-9-]/g, "") }))}
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Unit of Measure</Label>
                          <Input
                            className="h-8 mt-1"
                            placeholder="g, mL, units…"
                            value={editValues.unitOfMeasure}
                            onChange={(e) => setEditValues(v => ({ ...v, unitOfMeasure: e.target.value }))}
                          />
                        </div>
                      </div>
                      {/* Session 110 — net weight per unit (moved from Label Data).
                          Prints on the consumer label; blank = recipe default. */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label className="text-xs">Net Weight (per unit)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            min={0}
                            className="h-8 mt-1"
                            /* Session 111 — the placeholder IS the recipe's
                               value, so an empty box reads as "inheriting 1 g"
                               rather than "nothing set". Typing overrides. */
                            placeholder={recipeDefaults?.netWeight != null
                              ? `${recipeDefaults.netWeight}${recipeDefaults.netWeightUnit ? ` ${recipeDefaults.netWeightUnit}` : ""} (recipe)`
                              : "e.g. 1"}
                            value={editValues.labelNetWeight}
                            onChange={(e) => setEditValues(v => ({ ...v, labelNetWeight: e.target.value }))}
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Net Weight Unit</Label>
                          <Input
                            className="h-8 mt-1"
                            placeholder={recipeDefaults?.netWeightUnit || "g"}
                            value={editValues.labelNetWeightUnit}
                            onChange={(e) => setEditValues(v => ({ ...v, labelNetWeightUnit: e.target.value }))}
                          />
                        </div>
                      </div>
                      {/* Session 111 — was 10px and easy to miss; bumped to the
                          same size as every other helper line on this panel. */}
                      <p className="text-xs text-muted-foreground -mt-1">
                        Net weight of a single unit — prints on the consumer label.
                        {recipeDefaults?.netWeight != null
                          ? ` Leave blank to use the recipe default (${recipeDefaults.netWeight}${recipeDefaults.netWeightUnit ? ` ${recipeDefaults.netWeightUnit}` : ""}).`
                          : " Leave blank to use the recipe default."}
                      </p>
                      {/* Session 46 — scheduled (planned) output. Role-gated:
                          only Supervisor/Manager/Quality/Admin see this input.
                          Other roles can still edit the rest of the overview. */}
                      {canEditPlannedOutput ? (
                        <div>
                          <Label className="text-xs">Scheduled (Planned) Output</Label>
                          <Input
                            type="number"
                            step={0.01}
                            min={0}
                            className="h-8 mt-1"
                            value={editValues.scheduledOutputQuantity}
                            onChange={(e) => setEditValues(v => ({ ...v, scheduledOutputQuantity: e.target.value }))}
                          />
                          <p className="text-[10px] text-muted-foreground mt-0.5">Supervisor and above only. Drives variance % on Dashboard and BatchDetail.</p>
                        </div>
                      ) : (
                        <p className="text-[10px] text-muted-foreground italic">Scheduled output is editable by Supervisor and above.</p>
                      )}
                      {/* 2026-09-06 — the METRC Package ID is NO LONGER hand-typed here.
                          The tag is recorded on the process step where the cannabis
                          changes form: signing that step creates the package in METRC and
                          writes the tag back onto the batch (and, first time, onto the
                          batch number). Typing it here recorded a tag METRC had never
                          issued, which then blocked the very step that would have created
                          it — batches 28 and 29 both died that way. The tag is still shown
                          on this tab, read-only, in the status card above and the detail
                          list below; it is just no longer editable. An IMPORTED batch
                          still supplies its existing tag at batch CREATION, which is a
                          different path and is unaffected. */}
                      <div>
                        <Label className="text-xs">Production Date</Label>
                        <Input
                          type="date"
                          className="h-8 mt-1"
                          value={editValues.productionDate}
                          onChange={(e) => setEditValues(v => ({ ...v, productionDate: e.target.value }))}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Notes</Label>
                        <Textarea
                          className="mt-1 text-sm"
                          rows={3}
                          value={editValues.notes}
                          onChange={(e) => setEditValues(v => ({ ...v, notes: e.target.value }))}
                        />
                      </div>
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" onClick={handleSaveOverview} disabled={updateBatch.isPending}>
                          {updateBatch.isPending ? "Saving…" : "Save Changes"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditMode(false)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
                      <div>
                        <dt className="font-medium text-muted-foreground">Batch Number</dt>
                        <dd className="mt-1 font-mono font-semibold">
                          {batch?.batchNumber}
                          {/^(IMPORT|PENDING)-\d+$/i.test(batch?.batchNumber ?? "") && (
                            <span className="ml-2 align-middle rounded bg-amber-100 dark:bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                              provisional — enter the process-start METRC tag
                            </span>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-medium text-muted-foreground">Status</dt>
                        <dd className="mt-1">{STATE_LABELS[batch?.status ?? ""] ?? batch?.status}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-muted-foreground">Product Type</dt>
                        <dd className="mt-1">{batch?.productType}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-muted-foreground">Batch Type</dt>
                        <dd className="mt-1">{batch?.batchType}</dd>
                      </div>
                      <div>
                        {/* Session 36 — process_type discriminator. Drives
                            which fields the Batch UI surfaces and which
                            regulatory rules apply. Field landed on the
                            orval-generated BatchRecord shape in Session 36.1. */}
                        <dt className="font-medium text-muted-foreground">Process Type</dt>
                        <dd className="mt-1">
                          <Badge variant="secondary">{batch?.processType ?? "Kitchen"}</Badge>
                        </dd>
                      </div>
                      <div>
                        <dt className="font-medium text-muted-foreground">Strain Name / Flavor</dt>
                        <dd className="mt-1">{batch?.strainName ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-muted-foreground">Strain Type</dt>
                        <dd className="mt-1">{((batch as unknown as { strainType?: string | null })?.strainType) ?? "—"}</dd>
                      </div>
                      <div>
                        {/* Session 110 — net weight per unit (moved from Label Data).
                            Session 111 — falls back to the recipe's net weight
                            instead of "—", tagged so the inherited value is
                            never mistaken for a value entered on this batch. */}
                        <dt className="font-medium text-muted-foreground">Net Weight (per unit)</dt>
                        <dd className="mt-1">
                          {effectiveNetWeight ? (
                            <>
                              {effectiveNetWeight.value}{effectiveNetWeight.unit ? ` ${effectiveNetWeight.unit}` : ""}
                              {effectiveNetWeight.source === "recipe" && (
                                <span className="ml-1.5 text-xs text-muted-foreground">from recipe</span>
                              )}
                            </>
                          ) : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-medium text-muted-foreground">Production Date</dt>
                        <dd className="mt-1">
                          {batch?.productionDate ? format(new Date(batch.productionDate + "T00:00:00"), "MMM d, yyyy") : "—"}
                        </dd>
                      </div>
                      <div>
                        {/* Session 38 (Tier 4 #19) — scheduled vs actual.
                            Variance % = (actual - scheduled) / scheduled.
                            Negative variance is under-yield; flagged red.
                            Field landed on the orval Batch shape in 38.1. */}
                        <dt className="font-medium text-muted-foreground">Output</dt>
                        <dd className="mt-1 space-y-0.5">
                          {(() => {
                            const scheduled = batch?.scheduledOutputQuantity ?? null;
                            const actual = batch?.outputQuantity ?? null;
                            const variancePct = (scheduled != null && scheduled > 0 && actual != null)
                              ? Math.round(((actual - scheduled) / scheduled) * 1000) / 10
                              : null;
                            return (
                              <>
                                <p className="text-sm">
                                  Scheduled: <span className="font-semibold tabular-nums">{scheduled != null ? scheduled : "—"}</span>
                                  <span className="mx-1.5 text-muted-foreground">/</span>
                                  Actual: <span className="font-semibold tabular-nums">{actual != null ? Math.round(actual) : "—"}</span>
                                  {batch?.unitOfMeasure && <span className="text-muted-foreground ml-1">{batch.unitOfMeasure}</span>}
                                </p>
                                {variancePct != null && (
                                  <p className={`text-xs ${variancePct < 0 ? "text-red-600" : variancePct > 0 ? "text-green-700" : "text-muted-foreground"}`}>
                                    Variance: {variancePct >= 0 ? "+" : ""}{variancePct.toFixed(1)}%
                                  </p>
                                )}
                              </>
                            );
                          })()}
                        </dd>
                      </div>
                      <div>
                        <dt className="font-medium text-muted-foreground">METRC Package ID</dt>
                        <dd className="mt-1 font-mono text-xs break-all">{batch?.metrcPackageId ?? "—"}</dd>
                      </div>
                      {batch?.notes && (
                        <div className="col-span-2">
                          <dt className="font-medium text-muted-foreground">Notes</dt>
                          <dd className="mt-1 leading-relaxed">{batch.notes}</dd>
                        </div>
                      )}
                    </dl>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-base">Electronic Signatures</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  {batch?.approvalDate ? (
                    <div className="flex items-start gap-3 p-3 rounded-md bg-emerald-50 border border-emerald-200 dark:bg-emerald-950/20">
                      <ShieldCheck className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
                      <div>
                        <p className="font-semibold text-emerald-800 dark:text-emerald-400">Batch Released</p>
                        <p className="text-muted-foreground text-xs mt-0.5">
                          Signed by <strong>{batch.approvalName}</strong> · Initials: <strong>{batch.approvalInitials}</strong>
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {format(new Date(batch.approvalDate), "PPP 'at' HH:mm zzz")}
                        </p>
                        {/* Session 66 (OQ-11) — Part 11 meaning of the release signature.
                            Field is off the generated schema, so read via a narrow cast. */}
                        {(batch as { approvalMeaning?: string | null }).approvalMeaning && (
                          <p className="text-muted-foreground text-xs italic">
                            Meaning: {(batch as { approvalMeaning?: string | null }).approvalMeaning}
                          </p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 p-3 rounded-md bg-muted/50 border text-muted-foreground">
                      <Clock className="h-5 w-5 shrink-0" />
                      <p className="text-xs">Batch release signature not yet recorded.</p>
                    </div>
                  )}

                  {labeling?.approvalDate ? (
                    <div className="flex items-start gap-3 p-3 rounded-md bg-emerald-50 border border-emerald-200 dark:bg-emerald-950/20">
                      <Tag className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
                      <div>
                        <p className="font-semibold text-emerald-800 dark:text-emerald-400">Labeling Approved</p>
                        <p className="text-muted-foreground text-xs mt-0.5">
                          Signed by <strong>{labeling.approvalName}</strong> · Initials: <strong>{labeling.approvalInitials}</strong>
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {format(new Date(labeling.approvalDate), "PPP 'at' HH:mm zzz")}
                        </p>
                        {/* Session 67 (Item 5) — Part 11 meaning of signature, mirroring steps + release. */}
                        {(labeling as { approvalMeaning?: string | null }).approvalMeaning && (
                          <p className="text-muted-foreground text-xs italic">
                            Meaning: {(labeling as { approvalMeaning?: string | null }).approvalMeaning}
                          </p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 p-3 rounded-md bg-muted/50 border text-muted-foreground">
                      <Clock className="h-5 w-5 shrink-0" />
                      <p className="text-xs">Labeling approval signature not yet recorded.</p>
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground pt-1">
                    Electronic signatures comply with 21 CFR Part 11 — no paper signature required.
                  </p>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ─── Ingredients Tab ─── */}
          <TabsContent value="ingredients" forceMount>
            <div className="print:mt-6">
              <h2 className="hidden print:block text-lg font-bold mb-3 border-b pb-1">Section 2: Ingredient &amp; Material Traceability</h2>
            </div>
            <p className="text-xs text-muted-foreground mb-3">Bill of Materials with lot-number traceability per 21 CFR Part 211.188. Packaging &amp; labeling lots live on the <strong>Packaging</strong> tab.</p>
            {/* Session 67 (Item 4) — first-run speed-bump guidance. Demo recipes carry
                process steps but no bill of materials, so a brand-new batch starts with
                zero ingredients and is blocked at "Send to Testing" by the server guard.
                Surface that requirement here, up front, instead of only at the failed
                transition, so a new user knows to add a line before advancing. */}
            {(ingredients ?? []).length === 0 && !isTerminal && !batchReleased && (
              <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300 print:hidden">
                <strong>No ingredients recorded yet.</strong> Record at least one ingredient (with its lot number) before this batch can move to <strong>Testing</strong> — a batch record with an empty Bill of Materials isn&apos;t traceable. Use <strong>Add line</strong> on a card below to enter your first line.
              </div>
            )}
            <div className="space-y-4">
              {renderIngredientCard("Food Ingredients", "Consumable food inputs — distillate, terpenes, flavorings, sweeteners, etc.", foodIngredients, true, "Ingredient")}
              {renderIngredientCard("Materials", "Non-packaging components — mouthpieces, pre-roll cones, hardware, etc.", materialItems, true, "Material")}
            </div>
            {/* Session 79 (Step 3) — sign once to remove recorded quantities from
                on-hand inventory. BR-4: shared block, also on the Packaging tab. */}
            {renderInventoryCommitBlock()}
          </TabsContent>

          {/* ─── Packaging Tab (Session 58) ─── */}
          <TabsContent value="packaging" forceMount>
            <div className="print:mt-6">
              <h2 className="hidden print:block text-lg font-bold mb-3 border-b pb-1">Section 2b: Packaging &amp; Labeling Traceability</h2>
            </div>
            {/* Session 112 (2026-08-17) — packaging lot selection moved to the TOP
                of this tab. It's the first thing done at the packaging stage and
                the only part of the tab that's always available; the finished-output
                and child-package panels below only appear once the batch reaches
                packaging, so leading with them buried the actual entry point. */}
            <p className="text-xs text-muted-foreground mb-3">Pouches, child-resistant containers, cartons and other packaging lots used at the packaging stage. Add an item here and set its Type to <strong>Packaging</strong>. Compliance labels are not a packaging material — set their Type to <strong>Labeling</strong> and they move to the Labeling stage, where they carry their own lot numbers and are applied per unit.</p>
            {renderIngredientCard("Packaging", "Pouches, child-resistant containers, cartons, etc. (compliance labels belong on the Labeling stage).", packagingItems, true, "Packaging")}
            {/* BR-4 — same inventory-commit control as the Ingredients tab, so
                packaging additions can be confirmed without switching tabs. */}
            {renderInventoryCommitBlock()}

            {/* 2026-08-10 — Finished output. The department lead records how many
                units were manufactured and are in Finished Goods, plus the case /
                carton aggregation. Units is REQUIRED before the batch can be
                released (server-enforced); cases/cartons are informational. */}
            {["passed_awaiting_packaging","released_to_inventory","finished_goods"].includes(batch?.status ?? "") && (
              <Card className="mb-4 print:hidden border-primary/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Finished output — units in Finished Goods</CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">How many units were manufactured and are sitting in Finished Goods. Units is the Metrc finished-package count{batch?.scheduledOutputQuantity != null ? ` (planned: ${batch.scheduledOutputQuantity})` : ""} and is required before release. The box breakdown is captured in the child METRC packages below.</p>
                </CardHeader>
                <CardContent>
                  <div className="flex items-end gap-3 flex-wrap">
                    <div className="w-32">
                      <Label className="text-xs">Units produced{!hasOutput ? " *" : ""}</Label>
                      <Input type="number" className="mt-1 h-9"
                        value={actualOutputDraft ?? (batch?.outputQuantity != null ? String(batch.outputQuantity) : "")}
                        onChange={(e) => setActualOutputDraft(e.target.value)}
                        disabled={isTerminal} />
                    </div>
                    {!isTerminal && (
                      <Button size="sm" disabled={updateBatch.isPending}
                        onClick={async () => {
                          const toIntOrNull = (s: string) => (s.trim() === "" ? null : parseInt(s, 10));
                          const uRaw = actualOutputDraft ?? (batch?.outputQuantity != null ? String(batch.outputQuantity) : "");
                          await updateBatch.mutateAsync({ id, data: { outputQuantity: toIntOrNull(uRaw) } as never });
                          queryClient.invalidateQueries({ queryKey: getGetBatchRecordQueryKey(id) });
                          toast({ title: "Saved", description: "Finished output recorded." });
                          setActualOutputDraft(null);
                        }}>Save</Button>
                    )}
                    {(() => {
                      const a = batch?.outputQuantity, p = batch?.scheduledOutputQuantity;
                      if (a == null || p == null) return null;
                      const v = a - p;
                      return <span className="text-xs text-muted-foreground pb-2">Variance vs planned: {v > 0 ? `+${v}` : v}</span>;
                    })()}
                  </div>
                </CardContent>
              </Card>
            )}
            {/* Session 113 — the "record child METRC packages" card was REMOVED
                here. It only stored the tag strings an operator typed and marked
                them labeled, so a package that was never created in METRC looked
                identical to a real one and sailed through pre-flight, failing only
                at the transfer. Packages now come into existence exactly one way:
                Group / Ship Units, which writes to METRC first and records the
                tags only after that write succeeds. */}
          </TabsContent>

          {/* ─── Process Steps Tab (Session 59 — FDA GMP + baker e-sig) ─── */}
          <TabsContent value="process-steps" forceMount>
            <div className="print:mt-6">
              <h2 className="hidden print:block text-lg font-bold mb-3 border-b pb-1">Section 2c: Manufacturing Process Steps</h2>
            </div>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Approved Process Steps</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  FDA food GMP — the approved manufacturing instructions carried from the recipe. The baker fills in each blank and e-signs (21 CFR Part 11); the completed sentence prints on the batch record. Steps without a recipe can be added below.
                </p>
              </CardHeader>
              <CardContent className="p-0">
                {/* Session 62 — operator competency banner for this recipe.
                    Supervisor+ are exempt from the gate (sign solo), so the
                    personal pending banner is only shown to non-approver roles;
                    supervisors manage qualifications via the panel below. */}
                {batchRecipeId && myQual && !canCosign && (
                  myQual.status === "Qualified" ? (
                    <div className="m-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 print:hidden">
                      You are <strong>Qualified</strong> to run this recipe — your step sign-offs are final.
                    </div>
                  ) : (
                    <div className="m-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 print:hidden">
                      You are <strong>{myQual.status}</strong> on this recipe — your sign-offs stay pending until a supervisor co-signs.{" "}
                      <strong>{myQual.supervisedCount}</strong> of <strong>{myQual.requiredSupervisedBatches}</strong> supervised batches completed
                      {myQual.eligible ? " — eligible for qualification sign-off." : "."}
                    </div>
                  )
                )}
                {/* 2026-08-26 — training on the controlled document, shown before the
                    operator signs. Separate from the competency banner above: one is
                    "can you run this recipe", this is "have you read the revision in
                    force". Supervisor+ never see it (the server returns no hold). */}
                {myTrainingHold && (
                  <div className="m-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 print:hidden" data-testid="banner-training-hold">
                    Your training on <strong>{myTrainingHold.docNumber} rev {myTrainingHold.revision}</strong>
                    {myTrainingHold.docTitle ? ` — ${myTrainingHold.docTitle}` : ""} is still open
                    {myTrainingHold.dueDate ? ` (due ${myTrainingHold.dueDate})` : ""}. You may work this batch under
                    supervision: your step sign-offs stay pending until a supervisor co-signs them.{" "}
                    <Link href={`/training/${myTrainingHold.trainingRecordId}`} className="underline font-medium">
                      Complete the training
                    </Link>{" "}
                    and later steps sign on their own.
                  </div>
                )}
                {(!processSteps || processSteps.length === 0) ? (
                  <div className="p-4 space-y-1">
                    <p className="text-sm text-muted-foreground">No process steps on this batch.</p>
                    <p className="text-xs text-muted-foreground">Define approved steps on the <strong>Recipe</strong> so they copy onto every batch, or add a step below.</p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>Instruction</TableHead>
                        <TableHead className="w-60">Operator Sign-off</TableHead>
                        <TableHead className="print:hidden w-10" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {processSteps.map((s, i) => (
                        <TableRow key={s.id}>
                          <TableCell className="text-muted-foreground align-top">{i + 1}</TableCell>
                          <TableCell className="align-top">
                            <div className="font-medium">{s.description}</div>
                            {(s.completed ? s.renderedText : s.template) && (
                              <div className="text-sm text-muted-foreground mt-0.5 whitespace-pre-wrap">
                                {s.completed ? s.renderedText : s.template}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            {s.completed ? (
                              <div className="text-xs">
                                <Badge variant="outline" className="border-emerald-300 text-emerald-700">Signed</Badge>
                                <div className="text-muted-foreground mt-0.5">
                                  {s.performedByName} ({s.signedInitials}){s.performedAt ? ` · ${format(new Date(s.performedAt), "MMM d, yyyy h:mm a")}` : ""}
                                </div>
                                {/* Session 66 (OQ-11) — show the Part 11 meaning of signature. */}
                                {s.signedMeaning && (
                                  <div className="text-muted-foreground mt-0.5 italic">Meaning: {s.signedMeaning}</div>
                                )}
                                {/* Session 62 — show the supervisor co-signature when present. */}
                                {s.supervisorName && (
                                  <div className="text-muted-foreground mt-0.5">
                                    Co-signed: {s.supervisorName} ({s.supervisorInitials}){s.supervisorSignedAt ? ` · ${format(new Date(s.supervisorSignedAt), "MMM d, yyyy h:mm a")}` : ""}
                                  </div>
                                )}
                                {s.supervisorName && s.supervisorMeaning && (
                                  <div className="text-muted-foreground mt-0.5 italic">Co-sign meaning: {s.supervisorMeaning}</div>
                                )}
                              </div>
                            ) : s.cosignRequired ? (
                              /* Session 62 — operator signed but not yet Qualified: awaiting a supervisor co-sign. */
                              <div className="text-xs space-y-1">
                                <Badge variant="outline" className="border-amber-300 text-amber-700">Pending co-sign</Badge>
                                <div className="text-muted-foreground">
                                  Signed by {s.performedByName} ({s.signedInitials}){s.performedAt ? ` · ${format(new Date(s.performedAt), "MMM d, yyyy h:mm a")}` : ""}
                                </div>
                                {/* Session 66 (OQ-11) — Part 11 meaning of signature. */}
                                {s.signedMeaning && (
                                  <div className="text-muted-foreground italic">Meaning: {s.signedMeaning}</div>
                                )}
                                {!isTerminal && canCosign && s.performedByName !== currentUser?.fullName && (
                                  <Button size="sm" variant="outline" className="h-7 print:hidden" onClick={() => setCosigningStep(s)}>
                                    Co-sign (Supervisor)
                                  </Button>
                                )}
                              </div>
                            ) : (
                              !isTerminal && (
                                <Button size="sm" variant="outline" className="h-7" onClick={() => setSigningStep(s)}>
                                  Sign as Operator
                                </Button>
                              )
                            )}
                          </TableCell>
                          <TableCell className="print:hidden align-top">
                            {!s.completed && !s.cosignRequired && !isTerminal && (
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => handleRemoveStep(s.id)} aria-label="Delete step" title="Delete step">
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                {!isTerminal && (
                  <div className="border-t p-3 print:hidden space-y-2">
                    <div>
                      <Label className="text-xs">Add a step — title</Label>
                      <Input className="mt-1 h-9" value={newStepDesc} onChange={(e) => setNewStepDesc(e.target.value)} placeholder="Bake cookies" />
                    </div>
                    <div>
                      <Label className="text-xs">Instruction (use {"{blanks}"} the baker fills in)</Label>
                      <textarea
                        className="mt-1 w-full min-h-[56px] rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={newStepTemplate}
                        onChange={(e) => setNewStepTemplate(e.target.value)}
                        placeholder="Once mixed, {baker} baked at 350 degrees F for {time} minutes (SOP target 30 min)."
                      />
                    </div>
                    <div className="flex justify-end">
                      <Button size="sm" onClick={handleAddStep} disabled={!newStepDesc.trim()}>
                        <Plus className="h-4 w-4 mr-1" /> Add Step
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Session 62 — Operator Qualifications for this recipe (Supervisor+
                only). Lets a supervisor sign off an eligible operator without a
                standalone dashboard. */}
            {batchRecipeId && canCosign && (recipeQuals?.length ?? 0) > 0 && (
              <Card className="mt-4 print:hidden">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Operator Qualifications — this recipe</CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Sign off an operator once they've completed the required supervised batches. Qualified operators sign this recipe's steps solo.
                  </p>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Operator</TableHead>
                        <TableHead className="w-28">Status</TableHead>
                        <TableHead className="w-32">Supervised</TableHead>
                        <TableHead className="w-44 text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recipeQuals!.map((q) => (
                        <TableRow key={q.id}>
                          <TableCell className="align-top">
                            <div className="font-medium">{q.operatorName ?? `User #${q.operatorUserId}`}</div>
                            {q.status === "Qualified" && q.qualifiedBySupervisorName && (
                              <div className="text-xs text-muted-foreground mt-0.5">
                                Signed off by {q.qualifiedBySupervisorName}{q.qualifiedAt ? ` · ${format(new Date(q.qualifiedAt), "MMM d, yyyy")}` : ""}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            {q.status === "Qualified" ? (
                              <Badge variant="outline" className="border-emerald-300 text-emerald-700">Qualified</Badge>
                            ) : q.status === "Revoked" ? (
                              <Badge variant="outline" className="border-destructive/40 text-destructive">Revoked</Badge>
                            ) : (
                              <Badge variant="outline" className="border-amber-300 text-amber-700">{q.status}</Badge>
                            )}
                          </TableCell>
                          <TableCell className="align-top text-sm">
                            {q.supervisedCount}/{q.requiredSupervisedBatches}
                            {q.eligible && q.status !== "Qualified" && <span className="text-emerald-700"> · eligible</span>}
                          </TableCell>
                          <TableCell className="align-top text-right">
                            {q.status === "Qualified" ? (
                              <Button size="sm" variant="ghost" className="h-7 text-muted-foreground hover:text-destructive" onClick={() => handleRevokeQual(q.id)}>
                                Revoke
                              </Button>
                            ) : q.operatorUserId === currentUser?.id ? (
                              <span className="text-xs text-muted-foreground">Can't self-qualify</span>
                            ) : (
                              <Button size="sm" variant="outline" className="h-7" disabled={!q.eligible} onClick={() => setQualifyingRow(q)}>
                                Qualify
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ─── Testing Tab ─── */}
          <TabsContent value="testing" forceMount>
            <div className="print:mt-6">
              <h2 className="hidden print:block text-lg font-bold mb-3 border-b pb-1">Section 3: Third-Party Test Results</h2>
            </div>
            <div className="space-y-4">
              <div className="flex items-center justify-between print:hidden">
                <p className="text-sm text-muted-foreground">
                  Michigan CRA R 420.305 — licensed third-party lab results
                </p>
                {!isTerminal && !isDualChamber && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAddTestOpen(true)}>
                    <Plus className="h-4 w-4" />
                    Record Test Sample
                  </Button>
                )}
              </div>

              {/* R 420.304(2)(k) — say WHY the batch is frozen, on the tab that
                  can unfreeze it. A collected sample with no Pass = quarantine. */}
              {(testResults ?? []).some((t) => { const r = t as unknown as Record<string, unknown>; return r.sampleCollectedAt && r.testResult !== "Pass"; }) && (
                <div className="rounded-md border border-amber-300 bg-amber-50/60 p-3 print:hidden">
                  <p className="text-sm font-medium text-amber-900">Quarantined — a lab sample is out</p>
                  <p className="text-xs text-amber-800 mt-0.5">
                    R 420.304(2)(k): sampled product may not be packaged, transferred or sold until passing results are recorded.
                    Record the lab's result on the sample below to release the hold.
                  </p>
                </div>
              )}

              {isDualChamber && (
                <DualChamberTestingPanel
                  batchId={id}
                  recipeId={batchRecipeId}
                  tests={(testResults ?? []) as unknown as ChamberTestRow[]}
                  testingLabs={(testingLabs ?? []) as unknown as TestingLabOpt[]}
                  isTerminal={isTerminal}
                  onChanged={refreshTests}
                />
              )}

              {!testResults || testResults.length === 0 ? (
                <Card>
                  <CardContent className="pt-6 pb-4">
                    <p className="text-sm text-muted-foreground">No test samples recorded for this batch. Click "Record Test Sample" when the lab collects its sample; the results land on that same row later. CoAs and supporting lab files attach per row via the Documents button.</p>
                  </CardContent>
                </Card>
              ) : (
                testResults.map((test, idx) => (
                  <Card key={test.id} className={test.testResult === "Fail" ? "border-destructive/40" : test.testResult === "Pass" ? "border-emerald-200" : ""}>
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <CardTitle className="text-base flex items-center gap-2">
                            <FlaskConical className="h-4 w-4" />
                            Test #{idx + 1} — {test.testingAgency}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-xs ml-1"
                              onClick={() => setAttachmentsForTestId(test.id)}
                            >
                              <Paperclip className="h-3 w-3 mr-1" />
                              Documents
                            </Button>
                            {/* Session 69 — per-row Edit so a mistake can be
                                corrected. Hidden on terminal batches (record
                                locked) and when printing. */}
                            {!isTerminal && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs print:hidden"
                                onClick={() => openEditTest(test as never)}
                              >
                                <Pencil className="h-3 w-3 mr-1" />
                                Edit
                              </Button>
                            )}
                          </CardTitle>
                          <p className="text-xs text-muted-foreground mt-1">
                            Collected: {(test as unknown as Record<string, unknown>).sampleCollectedAt ? format(new Date((test as unknown as Record<string, unknown>).sampleCollectedAt as string), "MMM d, yyyy HH:mm") : (test.submittedDate ? format(new Date(test.submittedDate + "T00:00:00"), "MMM d, yyyy") : "—")}
                            {" · "}
                            Result: {test.resultDate ? format(new Date(test.resultDate + "T00:00:00"), "MMM d, yyyy") : "Pending"}
                          </p>
                        </div>
                        <Badge variant={test.testResult === "Pass" ? "default" : test.testResult === "Fail" ? "destructive" : "secondary"} className="text-sm px-3">
                          {test.testResult}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {/* Session 101 (#A) — pull lab results from Metrc + Part 11 verify */}
                      {!isTerminal && (() => {
                        const t = test as unknown as { id: number; sampleMetrcTag?: string | null; pulledAt?: string | null; verifiedAt?: string | null; verifiedByName?: string | null; potencyWithinTolerance?: boolean | null };
                        return (
                          <div className="mb-4 rounded-md border bg-muted/30 p-3 print:hidden">
                            <div className="flex items-center justify-between gap-2 mb-2">
                              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lab Results — Metrc</span>
                              {t.verifiedAt ? (
                                <span className="text-xs text-emerald-600 font-medium">✓ Verified{t.verifiedByName ? ` · ${t.verifiedByName}` : ""}</span>
                              ) : t.pulledAt ? (
                                <Button size="sm" variant="outline" className="h-7" onClick={() => setVerifyTestId(t.id)}>Verify results</Button>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-2">
                              <Input
                                className="h-8 font-mono text-xs"
                                placeholder="Test-sample Metrc tag"
                                value={sampleTagDrafts[t.id] ?? t.sampleMetrcTag ?? ""}
                                onChange={(e) => setSampleTagDrafts((m) => ({ ...m, [t.id]: e.target.value }))}
                              />
                              <Button size="sm" className="h-8 whitespace-nowrap" disabled={pullingTestId === t.id} onClick={() => pullLabResults(t.id, t.sampleMetrcTag ?? "")}>
                                {pullingTestId === t.id ? "Pulling…" : "Pull from Metrc"}
                              </Button>
                            </div>
                            {t.potencyWithinTolerance != null && (
                              <p className={`text-xs mt-2 ${t.potencyWithinTolerance ? "text-emerald-600" : "text-destructive font-medium"}`}>
                                Potency {t.potencyWithinTolerance ? "within" : "OUT OF"} label-claim tolerance.
                              </p>
                            )}
                            {pullMsg[t.id] && <p className="text-xs text-muted-foreground mt-2">{pullMsg[t.id]}</p>}
                          </div>
                        );
                      })()}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                        {(() => {
                          // Session 58 — read potency from result_values, honoring the
                          // stored basis (mg/serving for edibles, % otherwise), and
                          // fall back to the legacy "_pct" columns for older rows.
                          const rv = (test.resultValues ?? {}) as Record<string, number | string | undefined>;
                          const mg = rv.potency_basis === "mg_per_serving";
                          const unit = mg ? " mg/serving" : "%";
                          const thc = mg ? rv.thc_mg_per_serving : (rv.thc_pct ?? test.thcPct ?? undefined);
                          const cbd = mg ? rv.cbd_mg_per_serving : (rv.cbd_pct ?? test.cbdPct ?? undefined);
                          const total = mg ? rv.total_cannabinoids_mg_per_serving : (rv.total_cannabinoids ?? test.totalCannabinoids ?? undefined);
                          return [
                            { label: "THC", value: thc != null ? `${thc}${unit}` : "—" },
                            { label: "CBD", value: cbd != null ? `${cbd}${unit}` : "—" },
                            { label: "Total Cannabinoids", value: total != null ? `${total}${unit}` : "—" },
                            { label: "Vit. E Acetate", value: test.vitaminEAcetate != null ? `${test.vitaminEAcetate} ppm` : "ND" },
                          ];
                        })().map(({ label, value }) => (
                          <div key={label} className="bg-muted/40 rounded-lg p-3 text-center">
                            <p className="text-xs text-muted-foreground font-medium">{label}</p>
                            <p className="text-2xl font-bold mt-1">{value}</p>
                          </div>
                        ))}
                      </div>
                      <div className="border rounded-md overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Analyte Panel</TableHead>
                              <TableHead>Result</TableHead>
                              <TableHead>Michigan CRA Rule</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(() => {
                              // Session 82 (#6) — the required analyte panel is
                              // product-type-specific under MI R 420.305 (safety testing;
                              // sampling per R 420.304). Microbials,
                              // Pesticides, and Heavy Metals apply to every product
                              // form. Residual Solvents apply only to solvent-processed
                              // forms (concentrate / vape / distillate), and the MCT-oil
                              // check is required for ALL vape products (eff. 2024-10-01 per
                              // CRA Best Practices; enabling authority R 420.305(3)(i) target
                              // analytes — the rule text does not name MCT). Showing
                              // those two on a pre-roll/flower was both confusing and a
                              // compliance-accuracy issue. (Jonathan to confirm final MI
                              // panel per product type.)
                              const isConcentrate = batchIsConcentrate; // Session 108 — type OR concentrate-consuming pre-roll
                              const isVape = isVapeType(batch?.productType);
                              // Phase 5 — the panels, their citations and the product-form
                              // gate now come from the state's rule set. The gate itself is
                              // unchanged; only where the list lives has moved.
                              return panelsForProduct(panelSetFor(resolvedRules), { isConcentrate, isVape, isEdible, isFlower })
                                .map((p) => ({
                                  name: p.label,
                                  pass: panelPass(test, p.key),
                                  rule: p.citation ?? "",
                                }));
                            })().map(({ name, pass, rule }) => (
                              <TableRow key={name} className={pass === false ? "bg-destructive/5" : ""}>
                                <TableCell className="font-medium">{name}</TableCell>
                                <TableCell><PassBadge pass={pass} label={name} /></TableCell>
                                <TableCell className="text-xs text-muted-foreground">{rule}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      {test.notes && (
                        <p className="text-xs text-muted-foreground mt-3 leading-relaxed border-t pt-3">
                          <span className="font-medium">Lab Notes: </span>{test.notes}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
            {/* 2026-09-09 (Jonathan) — moved to PACKAGING. His model:
                packaging, COMPLIANCE labelling (every unit of the lot labelled the
                same) and the RETAIL label (the store's own, applied by the store)
                are three different processes. Once product is In Fulfillment it is
                packaged and carries the lot-specific compliance label, so that step
                belongs on this tab, after grouping and before the manifest.
                — He wants this panel REVISED, not kept: it is still one button doing
                  labelling, a checklist and the batch close. Moved as-is for now. */}
            {/* JIT commit 2 (label-later) — Fulfillment: units packaged now
                ("package a portion — label later") wait here as UNLABELED runs.
                Label & Finalize applies the R 420.504 consumer label to them
                (gated on the checklist below) and closes the production batch
                (In Fulfillment). Hidden once nothing is unlabeled. */}
            {unlabeledRuns.length > 0 && (
              <Card className="border-amber-300">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Tag className="h-4 w-4" /> Apply Compliance Labels
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {unlabeledRuns.length} packaged run{unlabeledRuns.length === 1 ? "" : "s"} awaiting labels. This records that the Michigan CRA R 420.504 consumer label was applied to these units. It does NOT close the batch — the rest of the bulk stays in production until it is packaged and labelled too.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="rounded-md border divide-y">
                    {unlabeledRuns.map((t) => (
                      <div key={t.id} className="flex items-center justify-between gap-3 p-2 text-sm">
                        <div className="min-w-0">
                          <p className="font-medium">{t.stageLabel}</p>
                          <p className="font-mono text-xs text-muted-foreground break-all">
                            {t.kind === "range" ? `${t.rangeStart} – ${t.rangeEnd}` : t.metrcTag}
                            {t.quantity ? ` · ${t.quantity}${t.uom ? ` ${t.uom}` : ""}` : ""}
                          </p>
                        </div>
                        <Badge variant="secondary" className="shrink-0">Unlabeled</Badge>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-1.5 print:hidden">
                    <label className="text-sm font-medium">Retail destination (dispensary)</label>
                    <Input
                      value={dispensaryName}
                      onChange={(e) => setDispensaryName(e.target.value)}
                      placeholder="e.g. Green Cross — Ann Arbor"
                      className="max-w-sm"
                    />
                    <p className="text-[11px] text-muted-foreground">Recorded on the fulfillment label event for traceability. Optional — the R 420.504 label-content requirements are verified on the checklist below.</p>
                  </div>
                  <div className="print:hidden space-y-1">
                    <Button
                      disabled={!canApproveLabeling || !(labelingApproved || checklistComplete)}
                      title={!canApproveLabeling ? "Applying labels requires Supervisor / Manager / Quality / Admin" : (!(labelingApproved || checklistComplete) ? "Complete the R 420.504 checklist below first" : undefined)}
                      onClick={() => { setSignatureAction("labelAndFinalize"); setSignatureOpen(true); }}
                    >
                      <ShieldCheck className="h-4 w-4 mr-2" />
                      Apply Labels ({unlabeledRuns.length}) — Electronic Signature
                    </Button>
                    {canApproveLabeling && !(labelingApproved || checklistComplete) && (
                      <p className="text-xs text-muted-foreground">Complete the R 420.504 verification checklist on the Labeling tab to enable this.</p>
                    )}
                    {!canApproveLabeling && (
                      <p className="text-xs text-muted-foreground">Applying labels requires Supervisor / Manager / Quality / Admin.</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ─── Labeling Tab ─── */}
          <TabsContent value="labeling" className="space-y-4" forceMount>
            <div className="print:mt-6">
              <h2 className="hidden print:block text-lg font-bold mb-3 border-b pb-1">Section 4: Labeling Approval</h2>
            </div>
            <LabelDataPanel batchId={id} />
            {/* Compliance-label lot traceability — moved here off the Ingredients
                tab (a label is applied at Labeling, not consumed as an ingredient).
                Read-only; the label material + lot stays on the batch record for
                21 CFR 211.188 traceability. Add/manage the lot on the Packaging tab. */}
            {labelItems.length > 0 && (
              <Card className="mt-4">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-1.5">
                    <Tag className="h-4 w-4" /> Compliance Label — Lot Traceability
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">The compliance label(s) applied to this batch's units and the lot each was drawn from (Michigan CRA R 420.504 label; 21 CFR 211.188 traceability).</p>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Label</TableHead>
                        <TableHead>Lot Number</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead>UoM</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {labelItems.map((l) => (
                        <TableRow key={l.id}>
                          <TableCell className="font-medium">{l.ingredientName}</TableCell>
                          <TableCell className="font-mono text-xs">{l.lotNumber ?? "—"}</TableCell>
                          <TableCell className="text-right">{l.actualQuantity ?? l.plannedQuantity ?? "—"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{(l as { unitOfMeasure?: string | null }).unitOfMeasure ?? "units"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}


            <Card>
              <CardHeader>
                <CardTitle className="text-base">Packaging & Labeling Record</CardTitle>
                <p className="text-xs text-muted-foreground">Michigan CRA R 420.504 — required label elements review</p>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Follow-up (06-24) — Sale type drives which label checklist
                    applies: retail-ready consumer label vs bulk/wholesale
                    transfer (manifest) label. Set this before building the
                    checklist. */}
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 print:hidden">
                  <div>
                    <p className="text-sm font-medium">Sale type</p>
                    <p className="text-xs text-muted-foreground">
                      {((batch as { saleType?: string } | undefined)?.saleType === "Bulk")
                        ? "Bulk / Wholesale — transfer (manifest) label checklist."
                        : "Retail-ready — consumer label checklist for this product type."}
                    </p>
                  </div>
                  <Select
                    value={(batch as { saleType?: string } | undefined)?.saleType ?? "Retail"}
                    onValueChange={handleChangeSaleType}
                    disabled={labelingApproved || isTerminal || batchReleased}
                  >
                    <SelectTrigger className="w-56 h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Retail">Retail-ready (consumer)</SelectItem>
                      <SelectItem value="Bulk">Bulk / Wholesale (transfer)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {!labeling ? (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">No labeling record exists for this batch yet. Start the labeling approval to record the label version, run the CRA R 420.504 checklist, and capture the Part 11 approval signature.</p>
                    {!isTerminal && !batchReleased && (
                      <Button onClick={handleStartLabeling} disabled={startingLabeling} className="print:hidden gap-1.5">
                        <Tag className="h-4 w-4" />
                        {startingLabeling ? "Starting…" : "Start Labeling Approval"}
                      </Button>
                    )}
                  </div>
                ) : (
                  <>
                    <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <dt className="font-medium text-muted-foreground">Label Version</dt>
                        <dd className="mt-1 font-mono">{labeling.labelVersion ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-muted-foreground">METRC Tag</dt>
                        <dd className="mt-1 font-mono text-xs break-all">{labeling.metrcTagNumber ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-muted-foreground">Checklist</dt>
                        <dd className="mt-1">
                          <div className="flex items-center gap-2">
                            <Progress value={labeling.checklistCompletePct ?? 0} className="h-2 w-20" />
                            <span className="font-semibold">{labeling.checklistCompletePct ?? 0}%</span>
                          </div>
                        </dd>
                      </div>
                      <div>
                        <dt className="font-medium text-muted-foreground">Approval</dt>
                        <dd className="mt-1">
                          <Badge variant={labelingApproved ? "default" : "secondary"}>
                            {labelingApproved ? "Approved" : "Pending"}
                          </Badge>
                        </dd>
                      </div>
                    </dl>

                    {labeling.labelNotes && (
                      <div className="text-sm">
                        <p className="font-medium text-muted-foreground mb-1">Label Notes</p>
                        <p className="leading-relaxed">{labeling.labelNotes}</p>
                      </div>
                    )}

                    {/* Session 67 (Item 5) — inline R 420.504 verification checklist. Every
                        required item must be Pass or N/A before Approve Labeling enables. */}
                    {checklistItems.length > 0 && (
                      <div className="print:hidden space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium">Label Verification Checklist (Michigan CRA R 420.504)</p>
                          <span className="text-xs text-muted-foreground">
                            {requiredChecklistItems.filter((it) => { const v = String(checklistRespMap.get(it.id)?.response ?? ""); return v === "Pass" || v === "N/A"; }).length} / {requiredChecklistItems.length} required complete
                          </span>
                        </div>
                        <div className="rounded-md border divide-y">
                          {checklistItems.map((it) => {
                            const resp = String(checklistRespMap.get(it.id)?.response ?? "");
                            return (
                              <div key={it.id} className="flex items-start gap-3 p-2 text-sm">
                                <span className="text-muted-foreground w-5 shrink-0">{it.itemNumber}</span>
                                <div className="flex-1 min-w-0">
                                  <p>{it.itemText}{String(it.required) !== "true" && <span className="text-muted-foreground"> (optional)</span>}</p>
                                  <p className="text-[11px] text-muted-foreground">{it.regulationRef}</p>
                                </div>
                                <div className="flex gap-1 shrink-0">
                                  {["Pass", "N/A", "Fail"].map((opt) => (
                                    <Button
                                      key={opt}
                                      type="button"
                                      size="sm"
                                      variant={resp === opt ? (opt === "Fail" ? "destructive" : "default") : "outline"}
                                      className="h-7 px-2 text-xs"
                                      disabled={labelingApproved}
                                      onClick={() => respondChecklist(it.id, opt)}
                                    >
                                      {opt}
                                    </Button>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {!checklistComplete && (
                          <p className="text-xs text-amber-700">Mark every required item Pass or N/A to enable Approve Labeling.</p>
                        )}
                      </div>
                    )}

                    {/* ⛔ THE INGREDIENT TRIPWIRE — his ruling 2026-09-02.
                        Artwork that prints the ingredients was checked against the
                        recipe as it stood the day it was signed. Change the recipe
                        and that artwork is now a false statement on a package, so
                        printing stops until somebody looks and signs again. The
                        RECIPE edit was never blocked — only the printing. */}
                    {staleArtwork.length > 0 && (
                      <div className="print:hidden rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                        <p className="text-sm font-semibold text-destructive">
                          Printing is blocked — the recipe changed after this artwork was approved
                        </p>
                        {staleArtwork.map((sa) => (
                          <div key={`${sa.kind}-${sa.id}`} className="space-y-0.5">
                            <p className="text-xs font-medium text-destructive/90">
                              {sa.kind === "packaging" ? "Packaging design" : "Label"}: {sa.name} v{sa.version}
                            </p>
                            <p className="text-xs text-destructive/90 leading-relaxed">
                              It prints the ingredients, and this product's recipe was changed on{" "}
                              {new Date(sa.recipeChangedAt).toLocaleDateString()}, after it was approved.
                            </p>
                            <p className="text-xs text-destructive/90 leading-relaxed">{sa.howToClear}</p>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Label-control step 2 — WHY the list is shorter. A requirement
                        the approved packaging carries was verified once, when that
                        design was approved, and is not asked again before every print.
                        Naming it here keeps a shorter checklist from reading as a
                        shorter rule. */}
                    {(coveredByPackaging.length > 0 || notApplicableByPackaging.length > 0) && (
                      <div className="print:hidden rounded-md border border-green-200 bg-green-50/50 p-3 space-y-2">
                        {coveredByPackaging.length > 0 && (
                          <p className="text-sm font-medium text-green-900">
                            {coveredByPackaging.length} requirement{coveredByPackaging.length === 1 ? "" : "s"} carried by the approved packaging
                          </p>
                        )}
                        <ul className="space-y-1">
                          {coveredByPackaging.map((c) => (
                            <li key={c.key} className="text-xs text-green-900/90 leading-relaxed">
                              <span className="line-through">{c.itemText}</span>
                              <span className="text-green-800/70"> · {c.regulationRef}</span>
                            </li>
                          ))}
                        </ul>
                        {notApplicableByPackaging.length > 0 && (
                          <>
                            <p className="text-sm font-medium text-green-900 pt-1">
                              {notApplicableByPackaging.length} not applicable to this product
                            </p>
                            <ul className="space-y-1">
                              {notApplicableByPackaging.map((c) => (
                                <li key={c.key} className="text-xs text-green-900/90 leading-relaxed">
                                  <span className="line-through">{c.itemText}</span>
                                  <span className="text-green-800/70"> · {c.regulationRef}</span>
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        <p className="text-xs text-green-800/80 leading-relaxed">
                          Answered once on{" "}
                          {coveringDesigns.map((d) => `${d.designName} v${d.version}`).join(", ")}
                          {coveringDesigns.length > 1 && " — and only where every one of them says the same"}
                          , when the packaging was approved, so it is not asked again before each
                          print. Everything that changes with the batch stays on the list above.
                        </p>
                      </div>
                    )}

                    {/* Label-control step 4 — what the approved LABEL carries.
                        Its own panel, not folded into the packaging one: the record
                        has to say WHICH artefact discharges a requirement, and the
                        label is the one that gets re-drawn. The batch pulls its
                        product's one approved template — there is no picker, for the
                        same reason there is none for packaging. */}
                    {coveredByLabel.length > 0 && (
                      <div className="print:hidden rounded-md border border-green-200 bg-green-50/50 p-3 space-y-2">
                        <p className="text-sm font-medium text-green-900">
                          {coveredByLabel.length} requirement{coveredByLabel.length === 1 ? "" : "s"} carried by the approved label
                        </p>
                        <ul className="space-y-1">
                          {coveredByLabel.map((c) => (
                            <li key={c.key} className="text-xs text-green-900/90 leading-relaxed">
                              <span className="line-through">{c.itemText}</span>
                              <span className="text-green-800/70"> · {c.regulationRef}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="text-xs text-green-800/80 leading-relaxed">
                          Printed by{" "}
                          {coveringTemplates.map((t) => `${t.name} v${t.version}`).join(", ")}
                          {coveringTemplates.length > 1 && " — and only where every one of them says the same"}
                          , verified when that label was approved. Everything that changes with the
                          batch stays on the list above.
                        </p>
                      </div>
                    )}

                    {/* Session 68 — empty-checklist state. A labeling record can exist
                        with zero checklist items (a product type created before its
                        template existed, or a still-unmapped type). Approval is blocked
                        (fail-closed); offer a one-click idempotent re-seed. */}
                    {checklistItems.length === 0 && (
                      <div className="print:hidden rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
                        <p className="text-sm font-medium text-amber-800">No verification checklist for this batch</p>
                        <p className="text-xs text-amber-700">
                          The R 420.504 checklist for product type "{labeling.productType}" hasn't been seeded, so labeling approval is blocked
                          until it is. Seed it now, or correct the batch's product type if it's wrong.
                        </p>
                        <Button size="sm" variant="outline" onClick={handleStartLabeling} disabled={startingLabeling} className="gap-1.5">
                          {startingLabeling ? "Seeding…" : "Seed / Refresh Checklist"}
                        </Button>
                      </div>
                    )}

                    <Separator />

                    {labeling.approvalDate ? (
                      <div className="flex items-start gap-3 p-4 rounded-lg bg-emerald-50 border border-emerald-200 dark:bg-emerald-950/20">
                        <ShieldCheck className="h-6 w-6 text-emerald-600 mt-0.5 shrink-0" />
                        <div className="space-y-1">
                          <p className="font-semibold text-emerald-800 dark:text-emerald-400">
                            Labeling Approved — Electronic Signature (21 CFR Part 11)
                          </p>
                          <p className="text-sm">Signed by: <strong>{labeling.approvalName}</strong></p>
                          <p className="text-sm">
                            Initials: <strong className="font-mono">{labeling.approvalInitials}</strong>
                            {" · "}
                            Date: <strong>{format(new Date(labeling.approvalDate), "PPP 'at' HH:mm zzz")}</strong>
                          </p>
                          {/* Session 67 (Item 5) — Part 11 meaning of signature on the auditor-facing record. */}
                          {(labeling as { approvalMeaning?: string | null }).approvalMeaning && (
                            <p className="text-sm">Meaning: <strong>{(labeling as { approvalMeaning?: string | null }).approvalMeaning}</strong></p>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="print:hidden space-y-1">
                        <Button
                          variant="outline"
                          disabled={!checklistComplete || !canApproveLabeling}
                          title={!canApproveLabeling ? "Label approval requires Supervisor / Manager / Quality / Admin" : undefined}
                          onClick={() => { setSignatureAction("labeling"); setSignatureOpen(true); }}
                        >
                          <Tag className="h-4 w-4 mr-2" />
                          Approve Labeling (Electronic Signature)
                        </Button>
                        {!canApproveLabeling && (
                          <p className="text-xs text-muted-foreground">Label approval requires Supervisor / Manager / Quality / Admin.</p>
                        )}
                        {canApproveLabeling && !checklistComplete && (
                          <p className="text-xs text-muted-foreground">Complete the verification checklist above to enable approval.</p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

          </TabsContent>

          {/* ─── Shipping Tab (Session 110) — METRC Tag History + the Outbound
              Manifest / Transfer, split out of the Labeling tab so the flow is
              Packaging → Labeling → Shipping. ─── */}
          {/* 2026-09-08 (Jonathan) — "Once batches have reached Bulk — Released
              that is when the batch record would end." So the printed record runs
              Overview through Labeling; fulfillment is what happens to the product
              AFTER the record closes, and it prints on the manifest instead. */}
          <TabsContent value="shipping" className="space-y-4 print:hidden" forceMount>
            <div className="print:mt-6">
              <h2 className="hidden print:block text-lg font-bold mb-3 border-b pb-1">Section 4b: Fulfillment — Tag History &amp; Outbound Manifest</h2>
            </div>

            {/* The first thing that happens on this tab: turn the released bulk
                into tagged unit packages in METRC. Everything below (labels,
                tag history, the manifest) depends on those packages existing. */}
            {batch?.status === "released_to_inventory" && !isTerminal && (
              <Card className="mt-4 border-blue-300 print:hidden">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-1.5">
                    <PackageCheck className="h-4 w-4" /> Group / Ship Units
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Creates the sellable unit packages in METRC from this batch's bulk package and records their tags.
                    Package a portion to keep the batch open, or finalize production to close it.
                  </p>
                </CardHeader>
                <CardContent>
                  <Button size="sm" onClick={() => setFgDialogOpen(true)} className="gap-1.5">
                    <PackageCheck className="h-4 w-4" /> Group / Ship Units
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* ─── Session 73 — METRC Tag History (tag lineage) ─── */}
            <Card className="mt-4">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base flex items-center gap-1.5">
                      <Tag className="h-4 w-4" /> METRC Tag History
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      The chain of METRC tags this batch carries as product changes form and is repackaged. The root is the Batch Number (process-start tag, frozen); each node lists its <strong>Source</strong> (parent) tag. A node is a single new tag or a first–last <strong>range</strong> of child tags. The latest leaf tag prints on labels.
                    </p>
                  </div>
                  {/* Session 114 — NOT offered in Bulk — Released. Turning bulk into
                      sellable packages is a packaging run, and Package / Fulfill
                      Units already creates those tags in METRC and writes them
                      into this history. Offering a note-only version of the same
                      event here meant the same act got entered twice, with only
                      the note reaching the record. This dialog is now only for a
                      form change that creates NO new METRC package. */}
                  {!isTerminal && batch?.status !== "released_to_inventory" && (
                    <Button size="sm" variant="outline" className="h-8 shrink-0 print:hidden" onClick={openTagDialog}>
                      <Plus className="h-4 w-4 mr-1" /> Note a form change (no METRC package created)
                    </Button>
                  )}
                  {!isTerminal && batch?.status === "released_to_inventory" && (
                    <p className="text-[11px] text-muted-foreground shrink-0 max-w-[16rem] text-right print:hidden">
                      This history is written by <strong>Group / Ship Units</strong> — repackaging bulk into sellable units is a packaging run, not a note.
                    </p>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {/* Root = the Batch Number (process-start tag). */}
                <div className="px-4 pt-3 pb-2 border-b">
                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant="outline" className="border-sky-300 text-sky-700">Batch Number · root</Badge>
                    <span className="font-mono">{batch?.batchNumber ?? "—"}</span>
                    <span className="text-xs text-muted-foreground">process-start tag (frozen)</span>
                  </div>
                </div>
                {(!metrcTags || metrcTags.length === 0) ? (
                  <div className="p-4">
                    <p className="text-sm text-muted-foreground">No downstream tags recorded yet.</p>
                    <p className="text-xs text-muted-foreground mt-0.5">When product changes form (e.g. dough → baked bulk) or is repackaged into final units, record the new tag or tag range with <strong>Record form change / repackage</strong>.</p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>Stage</TableHead>
                        <TableHead>Source (parent)</TableHead>
                        <TableHead>Tag / range</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead>Recorded</TableHead>
                        <TableHead className="print:hidden w-10" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {metrcTags.map((t, i) => {
                        const isLeaf = i === metrcTags.length - 1;
                        const fromRoot = (t.sourceTag ?? "") === (batch?.batchNumber ?? "");
                        return (
                          <TableRow key={t.id}>
                            <TableCell className="text-muted-foreground align-top">{i + 1}</TableCell>
                            <TableCell className="align-top">
                              <div className="font-medium">{t.stageLabel}</div>
                              {isLeaf && <Badge variant="outline" className="mt-0.5 border-emerald-300 text-emerald-700">Current · prints on label</Badge>}
                            </TableCell>
                            <TableCell className="align-top font-mono text-xs">
                              {t.sourceTag ?? "—"}
                              {fromRoot && <div className="text-[10px] text-sky-700 font-sans">from Batch Number</div>}
                            </TableCell>
                            <TableCell className="align-top font-mono text-xs">
                              {t.kind === "range" ? (
                                <div>
                                  <Badge variant="outline" className="mr-1 font-sans">range</Badge>
                                  {t.rangeStart} – {t.rangeEnd}
                                  {t.rangeCount != null && <span className="text-muted-foreground font-sans"> · {t.rangeCount} units</span>}
                                </div>
                              ) : (
                                t.metrcTag ?? "—"
                              )}
                              {t.metrcPackageCreatedAt ? (
                                <div className="mt-0.5"><Badge variant="outline" className="border-emerald-300 text-emerald-700 font-sans text-[10px]">In METRC ✓</Badge></div>
                              ) : t.metrcSyncError ? (
                                <div className="mt-0.5 text-[10px] text-amber-700 font-sans">Not in METRC: {t.metrcSyncError}</div>
                              ) : null}
                            </TableCell>
                            <TableCell className="align-top text-right text-sm">
                              {t.quantity != null ? `${t.quantity}${t.uom ? ` ${t.uom}` : ""}` : "—"}
                            </TableCell>
                            <TableCell className="align-top text-xs text-muted-foreground">
                              {t.recordedByName ?? "—"}{t.recordedAt ? <div>{format(new Date(t.recordedAt), "MMM d, yyyy h:mm a")}</div> : null}
                            </TableCell>
                            <TableCell className="print:hidden align-top">
                              {!isTerminal && canCancelTag && (
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => { setCancelTag(t); setCancelTagForm({ reason: "", initials: "", meaning: "" }); setCancelTagError(null); }} aria-label="Cancel tag node" title="Cancel (recoverable)">
                                  <Ban className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
            {/* Phase 1c — outbound manifest builder (ships labeled packages to a
                licensed recipient; CannaQMS record + pre-flight, Metrc push later). */}
            <BatchManifestPanel batchId={id} batchNumber={batch?.batchNumber} productType={batch?.productType} />
          </TabsContent>

          {/* ─── Compliance Trail Tab ─── */}
          <TabsContent value="compliance" forceMount>
            <div className="print:mt-6">
              <h2 className="hidden print:block text-lg font-bold mb-3 border-b pb-1">Section 5: Compliance Trail</h2>
            </div>
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4" />
                      Related Non-Conformances ({relatedNCs.length})
                    </CardTitle>
                    {/* Session 47 — in-batch NC capture. Hidden after the
                        batch reaches a terminal state since a closed/failed
                        batch shouldn't accept new NCs through this fast
                        path. The standalone NC creation flow remains
                        available for late-discovered issues. */}
                    {!isTerminal && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 print:hidden"
                        onClick={() => setLogNcOpen(true)}
                      >
                        <Plus className="h-4 w-4" />
                        Log NC
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  {relatedNCs.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-4 flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      No non-conformances linked to this batch.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>NC Number</TableHead>
                          <TableHead>Title</TableHead>
                          <TableHead>Severity</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Disposition</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {relatedNCs.map((nc) => (
                          <TableRow key={nc.id}>
                            <TableCell className="font-mono">
                              <Link href={`/non-conformances/${nc.id}`} className="text-primary hover:underline print:no-underline">
                                {nc.ncNumber}
                              </Link>
                            </TableCell>
                            <TableCell className="max-w-xs">{nc.title}</TableCell>
                            <TableCell>
                              <Badge variant={nc.severity === "Critical" ? "destructive" : nc.severity === "Major" ? "default" : "secondary"}>
                                {nc.severity}
                              </Badge>
                            </TableCell>
                            <TableCell><Badge variant="outline">{nc.status}</Badge></TableCell>
                            <TableCell className="text-sm text-muted-foreground">{nc.disposition ?? "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Related Complaints ({relatedComplaints.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {relatedComplaints.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-4 flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      No complaints linked to this batch.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Complaint #</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Severity</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Customer</TableHead>
                          <TableHead>Date</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {relatedComplaints.map((c) => (
                          <TableRow key={c.id}>
                            <TableCell className="font-mono">
                              <Link href={`/complaints/${c.id}`} className="text-primary hover:underline print:no-underline">
                                {c.complaintNumber}
                              </Link>
                            </TableCell>
                            <TableCell>{c.complaintType}</TableCell>
                            <TableCell>
                              <Badge variant={c.severity === "Critical" || c.severity === "High" ? "destructive" : "outline"}>
                                {c.severity}
                              </Badge>
                            </TableCell>
                            <TableCell><Badge variant="outline">{c.status}</Badge></TableCell>
                            <TableCell>{c.customerName ?? "—"}</TableCell>
                            <TableCell className="text-sm">
                              {formatDateOnly(c.receivedDate)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Audit Log — Change History</CardTitle>
                  <p className="text-xs text-muted-foreground">Tamper-evident record of all changes per 21 CFR Part 11 §11.10(e)</p>
                </CardHeader>
                <CardContent className="p-0">
                  {!auditLog || auditLog.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-4">No audit log entries found for this batch.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Timestamp</TableHead>
                          <TableHead>Operation</TableHead>
                          <TableHead>Changed By</TableHead>
                          <TableHead>Fields</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {auditLog.map((entry) => (
                          <TableRow key={entry.id}>
                            <TableCell className="text-xs font-mono whitespace-nowrap">
                              {entry.changedAt ? format(new Date(entry.changedAt), "MMM d, yyyy HH:mm") : "—"}
                            </TableCell>
                            <TableCell>
                              <Badge variant={entry.operation === "INSERT" ? "default" : entry.operation === "DELETE" ? "destructive" : "secondary"} className="text-xs">
                                {entry.operation}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm">{entry.changedByName ?? "System"}</TableCell>
                            {/* This log is a TABLE, so the full before/after diff
                                cannot live in the cell. Listing the CHANGED field
                                names is the honest version: the old code listed
                                every column on every save, because the whole row
                                is what gets stored. */}
                            <TableCell className="text-xs text-muted-foreground max-w-xs truncate">
                              {changedFieldNames(entry.beforeState, entry.afterState, entry.operation ?? "UPDATE").join(", ") || "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>

        {/* ── Dialogs ── */}

        {/* State transition confirmation */}
        <AlertDialog open={!!confirmTransition} onOpenChange={(o) => { if (!o) setConfirmTransition(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                {confirmTransition?.icon}
                {confirmTransition?.label}
              </AlertDialogTitle>
              <AlertDialogDescription className="space-y-2">
                <span>{confirmTransition?.description}</span>
                <span className="block pt-1">
                  Batch <strong>{batch?.batchNumber}</strong> will be moved from{" "}
                  <strong>{STATE_LABELS[batch?.status ?? ""]}</strong> to{" "}
                  <strong>{STATE_LABELS[confirmTransition?.nextState ?? ""]}</strong>.
                  This change will be recorded in the Audit Log.
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleTransitionConfirm}
                className={confirmTransition?.variant === "destructive" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
              >
                {confirmTransition?.label}
                <ArrowRight className="h-4 w-4 ml-1.5" />
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Add Ingredient dialog — BR-2: widened to max-w-lg and x-overflow
            hidden so the 3-column field grids no longer force a sideways scroll. */}
        <Dialog open={addIngOpen} onOpenChange={(o) => { setAddIngOpen(o); if (!o) { setIngError(null); setIngValues({ selectedPlannedId: null, ingredientName: "", lotNumber: "", plannedQuantity: "", actualQuantity: "", unitOfMeasure: "g", kind: "Ingredient", supplierLotNumber: "", receivedAt: "" }); setEditingIngredientId(null); setQtyAck(false); } }}>
          <DialogContent className="max-w-lg overflow-x-hidden">
            <DialogHeader>
              <DialogTitle>
                {editingIngredientId !== null
                  ? "Edit Ingredient / Material"
                  : ingValues.selectedPlannedId
                    ? "Record Recipe Ingredient"
                    : "Add Ingredient / Material"}
              </DialogTitle>
            </DialogHeader>
            {(() => {
              // Session 100 (feedback items 4–6) — scope the recipe-item picker to
              // the KIND of the card the operator clicked (Food Ingredient / Material
              // / Packaging). Previously pendingPlanned included every un-recorded
              // planned row regardless of kind, so clicking "Add line" on Materials or
              // Packaging only offered the recipe's food ingredient. Filtering by kind
              // means a card with no planned rows of that kind drops to off-recipe
              // mode (full in-stock catalog) instead of mis-offering another kind.
              const pendingPlanned = ((ingredients ?? []) as unknown as Array<{ id: number; actualQuantity: number | null; ingredientName: string; plannedQuantity: number | null; unitOfMeasure: string; kind: string }>).filter((i) => i.actualQuantity == null && (i.plannedQuantity ?? 0) > 0 && (i.kind ?? "Ingredient") === ingValues.kind);
              // Session 82 follow-up — only offer the recipe-item picker when
              // ADDING (editingIngredientId === null). When the operator clicks
              // Record/Edit on a specific row, the dialog must stay locked to THAT
              // row's item; previously it still listed the other pending planned
              // items (e.g. Northern Lights Flower showing while editing Filter
              // Tips), and selecting one overwrote the row — corrupting the BOM.
              const recipeMode = pendingPlanned.length > 0 && editingIngredientId === null;
              const lockedFromRecipe = !!ingValues.selectedPlannedId;
              return (
                <div className="space-y-3 py-2">
                  {ingError && <p className="text-sm text-destructive">{ingError}</p>}
                  {recipeMode && !lockedFromRecipe && (
                    <p className="text-xs rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950/30 text-blue-900 dark:text-blue-200 px-3 py-2">
                      This batch was created from a recipe. Pick an item from the Bill of Materials below to record its actual usage — Planned Qty, Type, and Unit are pulled from the recipe and locked.
                    </p>
                  )}
                  {recipeMode && (
                    <div>
                      <Label className="text-xs">Recipe Item {!lockedFromRecipe && <span className="text-destructive">*</span>}</Label>
                      <Select
                        value={ingValues.selectedPlannedId ? String(ingValues.selectedPlannedId) : ""}
                        onValueChange={(v) => {
                          if (v === "__custom__") {
                            setIngValues({ selectedPlannedId: null, ingredientName: "", lotNumber: "", plannedQuantity: "", actualQuantity: "", unitOfMeasure: "g", kind: "Ingredient", supplierLotNumber: "", receivedAt: "" });
                            return;
                          }
                          const row = pendingPlanned.find((p) => String(p.id) === v);
                          if (row) {
                            // Session 42 — added supplierLotNumber/receivedAt to match the
                            // full ingValues shape declared at line 237. Without these two
                            // fields the call was a TS2345 (missing required state keys).
                            setIngValues({
                              selectedPlannedId: row.id,
                              ingredientName: row.ingredientName,
                              lotNumber: "",
                              plannedQuantity: String(row.plannedQuantity ?? ""),
                              actualQuantity: "",
                              unitOfMeasure: row.unitOfMeasure,
                              kind: row.kind,
                              supplierLotNumber: "",
                              receivedAt: "",
                            });
                          }
                        }}
                      >
                        <SelectTrigger className="mt-1 h-9"><SelectValue placeholder="Select planned ingredient…" /></SelectTrigger>
                        <SelectContent>
                          {pendingPlanned.map((p) => (
                            <SelectItem key={p.id} value={String(p.id)}>
                              {p.ingredientName} — {p.plannedQuantity} {p.unitOfMeasure} ({p.kind})
                            </SelectItem>
                          ))}
                          <SelectItem value="__custom__">+ Add custom (off-recipe)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {lockedFromRecipe && (
                    <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
                      <div className="font-medium">{ingValues.ingredientName}</div>
                      <div className="text-muted-foreground mt-0.5">Planned {ingValues.plannedQuantity} {ingValues.unitOfMeasure} • Type: {ingValues.kind} <span className="ml-1">(locked from recipe)</span></div>
                    </div>
                  )}
                  {/* Session 79.4 — Lot Number FIRST (picking it auto-fills the name
                      + unit) and a SEARCHABLE combobox over ALL in-stock lots, not
                      just recipe matches, so large catalogs stay findable. Matching
                      lots float to the top; "Enter manually" covers pre-inventory. */}
                  {(() => {
                    // Session 82 follow-up — match item names CANONICALLY so a BOM
                    // line still pairs with its inventory item across trivial spelling
                    // differences: case, punctuation/spacing ("Cannabis – Flower" vs
                    // "Cannabis Flower"), and simple singular/plural ("Filter Tips" line
                    // vs the "Filter Tip" inventory item). Exact-string matching was
                    // hiding the real lot. Still strict enough that genuinely different
                    // items (Blue Dream Flower vs Filter Tip) never collide. Heuristic
                    // only handles +s plurals; the proper long-term fix is to match on
                    // inventoryItemId once recipe/BOM rows carry it.
                    const canon = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/s$/, "");
                    const ingName = ingValues.ingredientName.trim().toLowerCase();
                    const ingCanon = canon(ingValues.ingredientName);
                    const inStock = allInventory.filter((i) => (i.quantity ?? 0) > 0 && (i.lotNumber || ingIsPackagingStage));
                    // Session 97 (#23) — match candidate lots by NAME first, then by
                    // item TYPE/category, so a generic BOM line ("Cannabis Flower
                    // (ground)") also surfaces real strain lots ("Blue Dream Flower",
                    // itemType "Cannabis Flower") instead of dead-ending at "no in-stock
                    // lots" + free-text entry (which orphans the batch↔lot link, breaking
                    // auto-decrement + forward lineage). The type match fires only when the
                    // canonical itemType is contained in (or contains) the canonical
                    // ingredient name, so it stays category-scoped — a "Filter Tip" line
                    // never pulls flower lots. Name matches still rank first; "Enter
                    // manually" remains the explicit fallback. Long-term fix is still an
                    // inventoryItemId FK on recipe/BOM rows.
                    const nameMatch = ingCanon ? inStock.filter((i) => canon(i.itemName) === ingCanon) : [];
                    const nameIds = new Set(nameMatch.map((m) => m.id));
                    const typeMatch = ingCanon
                      ? inStock.filter((i) => {
                          if (nameIds.has(i.id)) return false;
                          const t = canon((i as { itemType?: string }).itemType ?? "");
                          return t.length > 0 && (ingCanon.includes(t) || t.includes(ingCanon));
                        })
                      : [];
                    const matching = [...nameMatch, ...typeMatch];
                    const matchIds = new Set(matching.map((m) => m.id));
                    // Session 82 (#3) — BOM integrity: when the line's item is fixed
                    // (locked from a recipe row, or editing an existing line that
                    // already names its item) the lot picker must offer ONLY lots of
                    // that same item. Previously it appended every other in-stock lot,
                    // which let a Filter Tips line select Blue Dream Flower. Off-recipe
                    // / custom adds still search the full catalog.
                    const itemFixed = !!ingName && (lockedFromRecipe || editingIngredientId !== null);
                    // 2026-09-06 — a FIXED line offers ONLY lots of its own item, full
                    // stop. It used to fall back to the entire in-stock list whenever the
                    // recipe name matched nothing, on the reasoning that a data mismatch
                    // shouldn't dead-end the operator. That reasoning was wrong: it made a
                    // data problem look like a picking choice, and let a wrong material be
                    // recorded against a recipe line. With no matching stock the list is
                    // now empty and the add is refused (bomNoMatchingStock) — the operator
                    // receives the right material, or the recipe line gets corrected.
                    // Off-recipe / custom adds still search the full catalog.
                    const options = itemFixed ? matching : [...matching, ...inStock.filter((i) => !matchIds.has(i.id))];
                    const selected = options.find((o) => (o.lotNumber ?? "") === ingValues.lotNumber);
                    // Session 111 — an established line KEEPS its own item name and
                    // unit of measure when a lot is picked. The line's unit is the
                    // unit the operator RECORDS IN (it comes from the recipe, e.g.
                    // 500 g of sugar); the lot's unit is only how that material is
                    // STOCKED (a 25 kg sack). Those are allowed to differ — the
                    // dialog already converts the draw into the lot's unit for the
                    // on-hand check and the server deducts unit-aware. Overwriting
                    // the line's "g" with the lot's "kg" left the QUANTITY untouched,
                    // silently turning 500 g into 500 kg. Off-recipe NEW lines still
                    // inherit name + unit from the lot, which is the useful case.
                    const lineUnitsFixed = lockedFromRecipe || editingIngredientId !== null;
                    const pickLot = (o: (typeof options)[number]) => {
                      setIngValues((prev) => ({
                        ...prev,
                        lotNumber: o.lotNumber ?? "",
                        // BR-1/BR-3 — auto-fill Expiration Date from the picked lot.
                        expirationDate: (o as { expirationDate?: string | null }).expirationDate
                          ? String((o as { expirationDate?: string | null }).expirationDate).slice(0, 10)
                          : "",
                        ...(lineUnitsFixed ? {} : { ingredientName: o.itemName, unitOfMeasure: o.unitOfMeasure ?? prev.unitOfMeasure }),
                      }));
                      setLotPickerOpen(false);
                    };
                    return (
                      <div>
                        <div className="flex items-center justify-between">
                          <Label className="text-xs">Lot Number{ingIsPackagingStage ? <span className="ml-1 font-normal text-muted-foreground">(optional)</span> : <span className="text-destructive"> *</span>}</Label>
                          {/* Free-text lot entry is the other way a wrong material got
                              recorded against a fixed line, so it is withdrawn in exactly
                              the case the picker now blocks. Off-recipe lines keep it. */}
                          {!bomNoMatchingStock && (
                            <button
                              type="button"
                              onClick={() => setIngLotManual((v) => !v)}
                              className="text-[10px] text-primary hover:underline"
                            >
                              {ingLotManual ? "← Pick from inventory" : "Enter manually →"}
                            </button>
                          )}
                        </div>
                        {bomNoMatchingStock ? null : ingLotManual || options.length === 0 ? (
                          <Input
                            className="mt-1 font-mono"
                            placeholder="e.g. NLEC-2025-BD-041"
                            value={ingValues.lotNumber}
                            onChange={(e) => setIngValues((v) => ({ ...v, lotNumber: e.target.value }))}
                          />
                        ) : (
                          <Popover open={lotPickerOpen} onOpenChange={setLotPickerOpen}>
                            <PopoverTrigger asChild>
                              <Button variant="outline" role="combobox" className="mt-1 w-full justify-between font-normal h-9">
                                {selected ? (
                                  <span className="truncate text-left">
                                    <span className="font-medium">{selected.itemName}</span>
                                    <span className="ml-2 font-mono text-xs text-muted-foreground">{selected.lotNumber}</span>
                                  </span>
                                ) : ingValues.lotNumber ? (
                                  <span className="truncate font-mono text-xs">{ingValues.lotNumber}</span>
                                ) : (
                                  <span className="text-muted-foreground">Select a lot…</span>
                                )}
                                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="p-0 w-[--radix-popover-trigger-width]" align="start">
                              <Command>
                                <CommandInput placeholder="Search product, lot #, or type…" />
                                <CommandList>
                                  <CommandEmpty>No in-stock lots found.</CommandEmpty>
                                  <CommandGroup>
                                    {options.map((o) => (
                                      <CommandItem
                                        key={o.id}
                                        value={`${o.itemName} ${o.lotNumber} ${(o as { itemType?: string }).itemType ?? ""}`}
                                        onSelect={() => pickLot(o)}
                                      >
                                        <Check className={`mr-2 h-4 w-4 ${ingValues.lotNumber === (o.lotNumber ?? "") ? "opacity-100" : "opacity-0"}`} />
                                        <span className="flex-1 truncate">
                                          <span className="font-medium">{o.itemName}</span>
                                          <span className="ml-2 font-mono text-xs text-muted-foreground">{o.lotNumber ?? <span className="italic">no lot</span>}</span>
                                          <span className="ml-2 text-muted-foreground">· {o.quantity} {o.unitOfMeasure}</span>
                                        </span>
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                        )}
                        {bomNoMatchingStock ? (
                          <p className="text-[11px] text-destructive mt-1">
                            No {ingValues.ingredientName} in stock. This line can only be filled with{" "}
                            {ingValues.ingredientName} — receive it into inventory first, or correct the
                            recipe line if it names the wrong material.
                          </p>
                        ) : !ingLotManual && options.length === 0 ? (
                          <p className="text-[10px] text-muted-foreground mt-1">
                            No in-stock lots — type the lot number directly.
                          </p>
                        ) : null}
                      </div>
                    );
                  })()}
                  {(!recipeMode || !lockedFromRecipe) && (
                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-2">
                        <Label className="text-xs">Ingredient / Material Name <span className="text-destructive">*</span></Label>
                        <Input
                          className="mt-1"
                          placeholder="Auto-fills when you pick a lot above; or type a custom name"
                          value={ingValues.ingredientName}
                          onChange={(e) => setIngValues(v => ({ ...v, ingredientName: e.target.value }))}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Type</Label>
                        <Select value={ingValues.kind} onValueChange={(v) => setIngValues(prev => ({ ...prev, kind: v }))}>
                          <SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {/* 2026-09-07 — Packaging and Labeling are now
                                distinct. "Packaging / Labeling" as one choice
                                made a compliance label indistinguishable from a
                                carton, and the recipe BOM could not offer either. */}
                            {BOM_KINDS.map((k) => <SelectItem key={k} value={k}>{BOM_KIND_LABELS[k]}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-xs">Planned Qty</Label>
                      <Input type="number" className="mt-1" disabled={lockedFromRecipe} value={ingValues.plannedQuantity} onChange={(e) => setIngValues(v => ({ ...v, plannedQuantity: e.target.value }))} />
                    </div>
                    <div>
                      <Label className="text-xs">Actual Qty <span className="text-destructive">*</span></Label>
                      <Input type="number" className="mt-1" autoFocus={lockedFromRecipe} value={ingValues.actualQuantity} onChange={(e) => { setIngValues(v => ({ ...v, actualQuantity: e.target.value })); setQtyAck(false); }} />
                      {/* 2026-09-08 — say it HERE, while it can still be fixed. The
                          draw used to clamp silently at zero, so 100 g out of a 94 g
                          lot looked fine and the lot vanished off Inventory. */}
                      {(() => {
                        const lot = ingValues.lotNumber ? allInventory.find((i) => i.lotNumber === ingValues.lotNumber) : null;
                        const want = parseFloat(ingValues.actualQuantity);
                        if (!lot || !Number.isFinite(want) || want <= 0) return null;
                        const have = Number(lot.quantity ?? 0);
                        const sameUnit = (lot.unitOfMeasure ?? "").trim().toLowerCase() === (ingValues.unitOfMeasure ?? "").trim().toLowerCase();
                        if (!sameUnit || want <= have) return null;
                        return (
                          <p className="text-[11px] text-amber-700 mt-1">
                            Lot {lot.lotNumber} holds {have} {lot.unitOfMeasure} — {(want - have).toFixed(2)} {lot.unitOfMeasure} short.
                            Lower the amount, pick a lot that covers it, or Management/Quality can authorise running short.
                          </p>
                        );
                      })()}
                    </div>
                    <div>
                      <Label className="text-xs">Unit <span className="text-destructive">*</span></Label>
                      <Input className="mt-1" placeholder="g, mL…" disabled={lockedFromRecipe} value={ingValues.unitOfMeasure} onChange={(e) => setIngValues(v => ({ ...v, unitOfMeasure: e.target.value }))} />
                    </div>
                  </div>
                  {/* Imperial/metric conversion preview + guard. When the line's
                      unit differs from the picked lot's unit, show what will actually
                      be drawn from the lot (and whether it's short). If the units are
                      incompatible kinds (count vs weight), the server can't deduct —
                      block the add and say why. */}
                  {unitsIncompatible ? (
                    <div className="rounded-md border-2 border-red-300 bg-red-50 dark:bg-red-950/30 p-3">
                      <p className="flex items-start gap-2 text-sm font-semibold text-red-800 dark:text-red-200">
                        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                        This lot is measured in {pickedLotUnit}, which can't be converted to {rowUnit}.
                      </p>
                      <p className="text-xs text-red-700 dark:text-red-300 mt-1">
                        {pickedLotUnit} and {rowUnit} are different kinds of measure (e.g. a count vs a weight), so on-hand inventory can't be drawn down automatically. Pick a lot in a compatible unit, or change this line's unit to match the lot.
                      </p>
                    </div>
                  ) : (unitsDiffer && drawInLotUnit != null && Number.isFinite(ingActualNum) && ingActualNum > 0) ? (
                    <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
                      This lot is tracked in <span className="font-medium">{pickedLotUnit}</span>. Removing{" "}
                      <span className="font-medium">{ingActualNum.toLocaleString()} {rowUnit}</span> ={" "}
                      <span className="font-medium">{roundQty(drawInLotUnit, 4).toLocaleString()} {pickedLotUnit}</span>
                      {ingLotOnHand != null ? (
                        <>
                          {" "}from <span className="font-medium">{ingLotOnHand.toLocaleString()} {pickedLotUnit}</span> on hand
                          {drawInLotUnit > ingLotOnHand ? (
                            <> — <span className="font-medium text-red-600 dark:text-red-400">short by {roundQty(drawInLotUnit - ingLotOnHand, 4).toLocaleString()} {pickedLotUnit}</span>.</>
                          ) : (
                            <> — <span className="font-medium">{roundQty(ingLotOnHand - drawInLotUnit, 4).toLocaleString()} {pickedLotUnit}</span> will remain.</>
                          )}
                        </>
                      ) : (
                        <>.</>
                      )}
                    </div>
                  ) : unitsDiffer ? (
                    /* Session 111 — units differ but no actual quantity entered
                       yet, so there's nothing to convert. Say so up front, or the
                       operator reads the mismatch as an error and "fixes" the
                       line's unit to match the lot — which is what silently
                       rescales the recipe quantity. */
                    <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
                      This lot is stocked in <span className="font-medium">{pickedLotUnit}</span>; this line records in{" "}
                      <span className="font-medium">{rowUnit}</span>. That's fine — the conversion is automatic when the
                      quantity is drawn from inventory. Leave the unit as {rowUnit} unless you actually weighed in {pickedLotUnit}.
                    </div>
                  ) : null}
                  {/* BR-1/BR-3 — Expiration Date. Auto-populated from the picked
                      inventory lot (editable), or entered by hand for an un-lotted
                      material. Shown for every line so the batch record carries the
                      expiry of what was actually consumed. */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Expiration Date</Label>
                      <Input
                        type="date"
                        className="mt-1"
                        value={ingValues.expirationDate ?? ""}
                        onChange={(e) => setIngValues(v => ({ ...v, expirationDate: e.target.value }))}
                      />
                      {pickedLotExpiry && (
                        <p className="text-[10px] text-muted-foreground mt-1">
                          Auto-filled from lot <span className="font-mono">{pickedInvLot?.lotNumber}</span> — edit if this unit differs.
                        </p>
                      )}
                    </div>
                  </div>
                  {/* BR-5 — loud guard against a gross Actual Qty slip (e.g. a
                      10× over-entry). Shows why the value looks wrong and blocks
                      submit until the operator explicitly confirms it. */}
                  {ingQtyWarn && (
                    <div className="rounded-md border-2 border-red-300 bg-red-50 dark:bg-red-950/30 p-3 space-y-2">
                      <p className="flex items-start gap-2 text-sm font-semibold text-red-800 dark:text-red-200">
                        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                        Double-check this quantity — it looks unusually high.
                      </p>
                      <ul className="list-disc pl-5 space-y-0.5 text-xs text-red-700 dark:text-red-300">
                        {ingOverPlanned && (
                          <li>You entered <strong>{ingActualNum.toLocaleString()} {ingValues.unitOfMeasure}</strong>, which is {(ingActualNum / ingPlannedNum).toFixed(1)}× the planned {ingPlannedNum.toLocaleString()} {ingValues.unitOfMeasure}.</li>
                        )}
                        {ingOverLot && ingLotOnHand != null && (
                          <li>That draws <strong>{roundQty(drawInLotUnit ?? ingActualNum, 4).toLocaleString()} {pickedLotUnit ?? ingValues.unitOfMeasure}</strong> — more than the <strong>{ingLotOnHand.toLocaleString()} {pickedLotUnit ?? ingValues.unitOfMeasure}</strong> on hand for this lot.</li>
                        )}
                      </ul>
                      <label className="flex items-center gap-2 text-xs font-medium text-red-800 dark:text-red-200 cursor-pointer">
                        <Checkbox checked={qtyAck} onCheckedChange={(v) => setQtyAck(v === true)} />
                        I've double-checked — this quantity is correct.
                      </label>
                    </div>
                  )}
                  {/* Session 40 (Tier 3 #12e) — Material lot capture. Required
                      on the server when kind="Material" so we surface the
                      fields with required indicators and a one-line rationale.
                      Hidden for Ingredient rows. */}
                  {/* BR-3 — Material lot capture. When the material is drawn from
                      an inventory lot, that picked lot IS the vendor lot, so the
                      redundant separate "Supplier Lot #" entry is demoted to a
                      read-only confirmation. The manual field returns only for an
                      un-lotted material (nothing picked from inventory). */}
                  {ingValues.kind === "Material" && (
                    <div className="rounded-md border border-amber-200 bg-amber-50/40 dark:bg-amber-950/20 p-3">
                      {pickedInvLot ? (
                        <p className="text-xs text-amber-900 dark:text-amber-200">
                          Vendor lot <span className="font-mono font-medium">{pickedInvLot.lotNumber}</span> (from the selected inventory lot) is recorded as this material's supplier lot — no separate entry needed.
                        </p>
                      ) : (
                        <>
                          <p className="text-xs text-amber-900 dark:text-amber-200 mb-2">
                            This material isn't drawn from an inventory lot. Enter the supplier's own lot number so it stays traceable on a recall.
                          </p>
                          <div>
                            <Label className="text-xs">Supplier Lot #</Label>
                            <Input
                              className="mt-1 font-mono"
                              placeholder="e.g. KUSH-CRT-25-04812"
                              value={ingValues.supplierLotNumber}
                              onChange={(e) => setIngValues((v) => ({ ...v, supplierLotNumber: e.target.value }))}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setAddIngOpen(false)}>Cancel</Button>
              <Button onClick={handleAddIngredient} disabled={createIngredient.isPending || updateIngredient.isPending || (ingQtyWarn && !qtyAck) || unitsIncompatible || bomNoMatchingStock}>
                {(createIngredient.isPending || updateIngredient.isPending)
                  ? "Saving…"
                  : editingIngredientId !== null
                    ? "Save Changes"
                    : ingValues.selectedPlannedId
                      ? "Record Actual"
                      : "Add Ingredient"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Record Test Sample dialog — collection on top, lab results below. */}
        <Dialog open={addTestOpen} onOpenChange={(o) => { setAddTestOpen(o); if (!o) resetTestForm(); }}>
          <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editTestId != null ? "Edit Test Sample" : "Record Test Sample"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              {testError && <p className="text-sm text-destructive">{testError}</p>}

              {/* 2026-09-08 (Jonathan) — the Phase picker is gone. A test row is
                  ONE thing that happens twice: the lab picks the sample up, and
                  the results come back against that same sample tag. Asking the
                  operator to choose "pre_test" or "result" up front made them
                  classify a form instead of doing the job. The row is a sample
                  until a result is recorded on it; `phase` is derived at submit
                  from whether the outcome is still Pending. */}

              {/* Lab sample collection (R 420.304(2)) — 2026-09-08. Replaces the
                  four-field "Sample Pull" box. Michigan does not treat this as a
                  note: the LAB collects, one of OUR people watches without
                  touching anything, both sign a chain-of-custody form, and WE
                  enter the sample in METRC with the date AND TIME it was
                  collected and transferred. Signing here freezes the batch
                  (no packaging, no manifest, no release) until a Pass is
                  recorded — rule (k). */}
              <div className="rounded-md border bg-muted/30 p-3 space-y-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lab sample collection</p>
                    <p className="text-[11px] text-muted-foreground">
                      Michigan R 420.304(2). The laboratory takes the sample; your employee observes and may not assist.
                      {requiredSampleUnits(batch?.outputQuantity) != null && (
                        <> This batch is {batch?.outputQuantity} units, so the lab must take <span className="font-medium">{requiredSampleUnits(batch?.outputQuantity)} units</span>.</>
                      )}
                    </p>
                  </div>

                  {/* 2026-09-08 (Jonathan) — "Testing Lab should probably be the
                      first thing chosen in the screen." It is: the lab is who
                      collects, so nothing else on this form means anything until
                      it is picked. It used to sit in the results half. */}
                  <div>
                    <Label className="text-xs">Testing Lab {testValues.testResult !== "Pending" && <span className="text-destructive">*</span>}</Label>
                    <Select value={testValues.testingAgencyId} onValueChange={(v) => setTestValues(prev => ({ ...prev, testingAgencyId: v }))}>
                      <SelectTrigger className="mt-1 h-9"><SelectValue placeholder={(testingLabs?.length ?? 0) === 0 ? "No approved labs on file" : "Select the lab collecting this sample"} /></SelectTrigger>
                      <SelectContent>
                        {(testingLabs ?? []).map((s) => (
                          <SelectItem key={s.id} value={String(s.id)}>{s.supplierName}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {(testingLabs?.length ?? 0) === 0 && (
                      <p className="text-[10px] text-muted-foreground mt-1">
                        No Approved Testing Laboratory suppliers. Add one in Suppliers first.
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Source package tag (scan)</Label>
                      <Input className="mt-1 h-9 font-mono text-xs" placeholder="the package sampled from" value={testValues.sourcePackageTag} onChange={(e) => setTestValues(v => ({ ...v, sourcePackageTag: e.target.value }))} />
                    </div>
                    <div>
                      <Label className="text-xs">Sample package tag (scan)</Label>
                      <Input className="mt-1 h-9 font-mono text-xs" placeholder="the lab's sample tag" value={testValues.sampleMetrcTag} onChange={(e) => setTestValues(v => ({ ...v, sampleMetrcTag: e.target.value }))} />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-1.5 h-7 text-xs"
                        disabled={creatingSample}
                        onClick={createSampleInMetrc}
                      >
                        {creatingSample ? "Creating…" : "Create in METRC"}
                      </Button>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Scan the tag the lab put on the sample. This records that package off the source tag and deducts the amount there.
                      </p>
                    </div>
                    <div>
                      <Label className="text-xs">Amount taken</Label>
                      <Input type="number" step="0.01" className="mt-1 h-9" value={testValues.sampleWeight} onChange={(e) => setTestValues(v => ({ ...v, sampleWeight: e.target.value }))} />
                    </div>
                    <div>
                      <Label className="text-xs">Unit</Label>
                      <Input className="mt-1 h-9" placeholder="Each, g, mL…" value={testValues.sampleUom} onChange={(e) => setTestValues(v => ({ ...v, sampleUom: e.target.value }))} />
                    </div>
                    <div>
                      <Label className="text-xs">Collected (date &amp; time)</Label>
                      <Input type="datetime-local" className="mt-1 h-9" value={testValues.sampleCollectedAt} onChange={(e) => setTestValues(v => ({ ...v, sampleCollectedAt: e.target.value }))} />
                    </div>
                    <div>
                      <Label className="text-xs">Transferred to lab (date &amp; time)</Label>
                      <Input type="datetime-local" className="mt-1 h-9" value={testValues.sampleTransferredAt} onChange={(e) => setTestValues(v => ({ ...v, sampleTransferredAt: e.target.value }))} />
                    </div>
                    <div>
                      <Label className="text-xs">Our employee who observed</Label>
                      <Input className="mt-1 h-9" placeholder="Name" value={testValues.observerName} onChange={(e) => setTestValues(v => ({ ...v, observerName: e.target.value }))} />
                    </div>
                    <div>
                      <Label className="text-xs">Remaining in the package</Label>
                      <Input type="number" step="0.01" className="mt-1 h-9" value={testValues.sourceRemainingQty} onChange={(e) => setTestValues(v => ({ ...v, sourceRemainingQty: e.target.value }))} />
                    </div>
                    <div>
                      <Label className="text-xs">Remaining unit</Label>
                      <Input className="mt-1 h-9" placeholder="Each, g…" value={testValues.sourceRemainingUom} onChange={(e) => setTestValues(v => ({ ...v, sourceRemainingUom: e.target.value }))} />
                    </div>
                  </div>

                  <div className="rounded-md border bg-background p-3 space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Chain of custody</p>
                    <label className="flex items-start gap-2 text-xs">
                      <Checkbox checked={testValues.cocMetrcIdentified} onCheckedChange={(c) => setTestValues(v => ({ ...v, cocMetrcIdentified: c === true }))} />
                      <span>The product and the sample are correctly identified in METRC, and the product name and weight on the form are correct.</span>
                    </label>
                    <label className="flex items-start gap-2 text-xs">
                      <Checkbox checked={testValues.cocObservedThroughout} onCheckedChange={(c) => setTestValues(v => ({ ...v, cocObservedThroughout: c === true }))} />
                      <span>Our employee was present and saw the increments taken from throughout the batch.</span>
                    </label>
                    <label className="flex items-start gap-2 text-xs">
                      <Checkbox checked={testValues.cocNoAssist} onCheckedChange={(c) => setTestValues(v => ({ ...v, cocNoAssist: c === true }))} />
                      <span>Our employee did not assist the lab employee or touch the product or the sampling equipment.</span>
                    </label>
                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <div>
                        <Label className="text-xs">Your initials</Label>
                        <Input className="mt-1 h-9" placeholder="e.g. JS" value={testValues.cocSignedByInitials} onChange={(e) => setTestValues(v => ({ ...v, cocSignedByInitials: e.target.value }))} />
                      </div>
                      <div>
                        <Label className="text-xs">Signing meaning</Label>
                        <Input className="mt-1 h-9" placeholder="e.g. Observed sample collection" value={testValues.cocSignedMeaning} onChange={(e) => setTestValues(v => ({ ...v, cocSignedMeaning: e.target.value }))} />
                      </div>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Signing records the collection and quarantines this batch: no packaging, no manifest and no release until a passing result is recorded against it.
                    </p>
                  </div>
              </div>

              {/* The seam between the two halves. Saving here records the
                  collection and leaves the batch waiting on the lab. */}
              <div className="flex items-center justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={createTestResult.isPending || updateTestResult.isPending}
                  onClick={() => handleAddTestResult({ sampleOnly: true })}
                >
                  {(createTestResult.isPending || updateTestResult.isPending) ? "Saving…" : "Save sample — results not back yet"}
                </Button>
              </div>

              <Separator />

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lab results</p>
                <p className="text-[11px] text-muted-foreground">
                  Leave the outcome on Pending until the lab reports. Results can be typed from the CoA, or pulled from METRC against the sample tag above using the Pull from Metrc button on the row.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Overall Result</Label>
                  <Select value={testValues.testResult} onValueChange={(v) => setTestValues(prev => ({ ...prev, testResult: v }))}>
                    <SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Pending">Pending</SelectItem>
                      <SelectItem value="Pass">Pass</SelectItem>
                      <SelectItem value="Fail">Fail</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {/* 2026-09-08 (Jonathan) — Submitted Date is gone: the sample
                    section above records when the lab COLLECTED and when it was
                    TRANSFERRED, to the minute. A second, vaguer date for the same
                    event is one more box to fill and one more thing to disagree. */}
                <div>
                  <Label className="text-xs">Result Date</Label>
                  <Input type="date" className="mt-1 h-9" value={testValues.resultDate} onChange={(e) => setTestValues(v => ({ ...v, resultDate: e.target.value }))} />
                </div>
              </div>

              <Separator />
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Cannabinoid Profile <span className="normal-case text-muted-foreground/80">({isEdible ? "mg per serving — edible" : "% by weight"})</span>
              </p>
              <div className="grid grid-cols-4 gap-2">
                {[
                  { key: "thcPct",            label: `THC (${potencyUnit})` },
                  { key: "cbdPct",            label: `CBD (${potencyUnit})` },
                  { key: "totalCannabinoids", label: `Total Cannabinoids (${potencyUnit})` },
                  { key: "vitaminEAcetate",   label: "Vit. E Acetate (ppm)" },
                ].map(({ key, label }) => (
                  <div key={key}>
                    <Label className="text-xs">{label}</Label>
                    <Input
                      type="number"
                      step="0.01"
                      className="mt-1 h-8"
                      value={(testValues as unknown as Record<string, string>)[key]}
                      onChange={(e) => setTestValues(v => ({ ...v, [key]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>

              <Separator />
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {panelSetFor(resolvedRules).heading
                  ? `Safety Panels (${panelSetFor(resolvedRules).heading})`
                  : "Safety Panels"}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {(() => {
                  // Session 82 follow-up — match the analyte DISPLAY gate so the
                  // entry form doesn't collect tests the product type doesn't
                  // require. Only solvent-processed forms record Residual Solvents;
                  // only vapes record the MCT-oil/cutting-agent check. Hidden on
                  // flower/pre-roll.
                  const isConc = batchIsConcentrate; // Session 108 — type OR concentrate-consuming pre-roll
                  const isVapeP = isVapeType(batch?.productType);
                  return panelsForProduct(panelSetFor(resolvedRules), { isConcentrate: isConc, isVape: isVapeP, isEdible, isFlower })
                    .map((p) => ({ key: p.key, label: p.formLabel ?? p.label }));
                })().map(({ key, label }) => (
                  <div key={key}>
                    <Label className="text-xs">{label}</Label>
                    <Select
                      value={(testValues as unknown as Record<string, string>)[key] ?? "pending"}
                      onValueChange={(v) => setTestValues(prev => ({ ...prev, [key]: v }))}
                    >
                      <SelectTrigger className="mt-1 h-8"><SelectValue placeholder="—" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="true">Pass</SelectItem>
                        <SelectItem value="false">Fail</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>

              <Separator />
              <div>
                <Label className="text-xs">Lab Notes</Label>
                <Textarea className="mt-1 text-sm" rows={2} value={testValues.notes} onChange={(e) => setTestValues(v => ({ ...v, notes: e.target.value }))} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setAddTestOpen(false)}>Cancel</Button>
              <Button onClick={() => handleAddTestResult()} disabled={createTestResult.isPending || updateTestResult.isPending}>
                {(createTestResult.isPending || updateTestResult.isPending)
                  ? "Saving…"
                  : editTestId != null ? "Save Changes" : "Record Test Sample"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Session 79.5 — Admin signed-delete of a committed ingredient (refunds the lot). */}
        {/* Session 101 (#A) — verify pulled lab results (Part 11) */}
        <Part11SignatureDialog
          open={verifyTestId != null}
          onOpenChange={(o) => { if (!o) setVerifyTestId(null); }}
          title="Verify Lab Results"
          description={`I have reviewed the lab results pulled for batch ${batch?.batchNumber} and confirm they are complete and meet requirements. Verification is required before results may drive a printed compliance label.`}
          onSign={(initials, meaning) => verifyLabResults(initials, meaning)}
          isPending={false}
        />

        <Part11SignatureDialog
          open={committedDeleteIng !== null}
          onOpenChange={(o) => { if (!o) setCommittedDeleteIng(null); }}
          title="Remove Signed Ingredient (Admin)"
          description={committedDeleteIng ? `I am removing "${committedDeleteIng.name}" from batch ${batch?.batchNumber}. Its quantity has already been drawn from inventory; removing it returns that quantity to the lot. State your reason in the signing statement.` : ""}
          onSign={(initials, meaning) => handleConfirmCommittedDelete(initials, meaning)}
          isPending={committedDeletePending}
        />

        {/* Session 79 (Step 3) — confirm ingredients & remove from inventory (Part 11). */}
        <Part11SignatureDialog
          open={ingCommitOpen}
          onOpenChange={setIngCommitOpen}
          title={shortDrawSigning ? "Authorise Running Short" : "Confirm Ingredients & Remove From Inventory"}
          description={shortDrawSigning
            ? `I authorise batch ${batch?.batchNumber} to run short: the lots do not hold the planned amounts, only what is actually on hand will be drawn, and the recorded actuals will be corrected down to match. Reason: ${shortReason}`
            : `I confirm that all ingredients listed for batch ${batch?.batchNumber} have been added in the recorded amounts and are within acceptable variance. On signing, these quantities are removed from on-hand inventory.`}
          onSign={(initials, meaning) => shortDrawSigning ? authoriseShortDraw(initials, meaning) : handleCommitIngredients(initials, meaning)}
          isPending={ingCommitPending}
        />

        {/* Part 11 Signature */}
        <Part11SignatureDialog
          open={signatureOpen}
          onOpenChange={setSignatureOpen}
          title={signatureAction === "labeling" ? "Approve Batch Labeling" : signatureAction === "labelAndFinalize" ? "Apply Compliance Labels" : "Release Batch to Market"}
          description={
            signatureAction === "labeling"
              ? `I confirm that the labeling for batch ${batch?.batchNumber} has been reviewed and meets all Michigan CRA R 420.504 requirements.`
              : signatureAction === "labelAndFinalize"
                ? `I confirm the ${unlabeledRuns.length} packaged unit run${unlabeledRuns.length === 1 ? "" : "s"} for batch ${batch?.batchNumber} have been labeled per Michigan CRA R 420.504. The batch stays open; any bulk not yet packaged remains in production.`
                : `I confirm that batch ${batch?.batchNumber} has passed all required quality checks and is authorized for release to licensed provisioning centers per Michigan CRA R 420.201.`
          }
          onSign={handleSign}
          isPending={approveLabeling.isPending || releaseBatch.isPending}
        />

        {/* Session 62 — supervisor co-sign of a pending process step (Part 11). */}
        <Part11SignatureDialog
          open={cosigningStep !== null}
          onOpenChange={(o) => { if (!o) setCosigningStep(null); }}
          title="Co-sign Process Step (Supervisor)"
          description={
            cosigningStep
              ? `I verify that ${cosigningStep.performedByName ?? "the operator"} performed step "${cosigningStep.description}" correctly under my supervision.`
              : ""
          }
          onSign={handleCosignStep}
          isPending={false}
        />

        {/* Session 62 — supervisor qualification sign-off for an operator (Part 11). */}
        <Part11SignatureDialog
          open={qualifyingRow !== null}
          onOpenChange={(o) => { if (!o) setQualifyingRow(null); }}
          title="Qualify Operator"
          description={
            qualifyingRow
              ? `I attest that ${qualifyingRow.operatorName ?? "this operator"} has demonstrated competency over ${qualifyingRow.supervisedCount} supervised batches and is qualified to run this recipe independently.`
              : ""
          }
          onSign={handleQualify}
          isPending={false}
        />

        {/* Session 59.1 — baker fill-in-the-blank e-signature for a process step.
            Keyed so each step opens a fresh dialog with empty blanks. */}
        {signingStep && (
          <BatchStepSignDialog
            key={signingStep.id}
            step={signingStep}
            currentUserName={currentUser?.fullName ?? ""}
            pending={stepSignPending}
            sourceTagOptions={batchSourceTags}
            onClose={() => setSigningStep(null)}
            onSign={handleSignStep}
          />
        )}

        {/* Session 73 — Record a METRC form-change / repackage node. Single new
            tag, or one or more (non-contiguous) ranges of child tags. */}
        <Dialog open={tagDialogOpen} onOpenChange={(o) => { setTagDialogOpen(o); if (!o) setTagError(null); }}>
          <DialogContent className="sm:max-w-[520px] max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Record form change / repackage</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-1">
              <p className="text-xs text-muted-foreground">
                Adds a node to this batch's METRC tag lineage. The <strong>Source</strong> is the parent tag this derived from (prefilled with the current leaf). Use <strong>Range</strong> when a split produced sequential child tags; add another range if a tag package ran out mid-run.
              </p>
              <div>
                <Label className="text-xs">Source (parent) tag</Label>
                <Input className="mt-1 h-9 font-mono" value={tagForm.sourceTag} onChange={(e) => setTagForm((f) => ({ ...f, sourceTag: e.target.value }))} placeholder={batch?.batchNumber ?? "Batch Number"} />
              </div>
              <div>
                <Label className="text-xs">Stage label <span className="text-destructive">*</span></Label>
                <Input className="mt-1 h-9" value={tagForm.stageLabel} onChange={(e) => setTagForm((f) => ({ ...f, stageLabel: e.target.value }))} placeholder="Bulk — baked / Final packaging" />
              </div>
              <div>
                <Label className="text-xs">Mode</Label>
                <Select value={tagForm.mode} onValueChange={(v) => setTagForm((f) => ({ ...f, mode: v as "single" | "range" }))}>
                  <SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single">Single new tag</SelectItem>
                    <SelectItem value="range">Range of child tags</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {tagForm.mode === "single" ? (
                <>
                  <div>
                    <Label className="text-xs">New METRC tag <span className="text-destructive">*</span></Label>
                    <Input className="mt-1 h-9 font-mono" value={tagForm.metrcTag} onChange={(e) => setTagForm((f) => ({ ...f, metrcTag: e.target.value }))} placeholder="1A4FF..." />
                    {tagForm.createInMetrc && tagForm.metrcTag.trim() && metrcAvailTags && !metrcAvailTags.has(tagForm.metrcTag.trim().toUpperCase()) && (
                      <p className="mt-1 text-[10px] text-amber-700">This tag isn't in your available METRC tags — double-check the scan.</p>
                    )}
                  </div>
                  <div className="rounded-md border p-2 space-y-2">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={tagForm.createInMetrc} onCheckedChange={(v) => setTagForm((f) => ({ ...f, createInMetrc: v === true }))} />
                      Create this package in METRC (production batch)
                    </label>
                    {tagForm.createInMetrc && (
                      <>
                      <div>
                        <Label className="text-xs">METRC item <span className="text-destructive">*</span></Label>
                        {metrcItems.length > 0 ? (
                          <Select value={tagForm.item} onValueChange={(v) => { const it = metrcItems.find((i) => i.Name === v); setTagForm((f) => { const draw = computeSourceDraw(it, f.quantity); return { ...f, item: v, uom: it?.UnitOfMeasureName ?? f.uom, sourceUom: f.sourceQtyManual ? f.sourceUom : (draw?.uom || it?.UnitWeightUnitOfMeasureName || f.sourceUom), sourceQuantity: f.sourceQtyManual ? f.sourceQuantity : (draw?.qty ?? f.sourceQuantity) }; }); }}>
                            <SelectTrigger className="mt-1 h-9"><SelectValue placeholder="Select METRC item…" /></SelectTrigger>
                            <SelectContent>
                              {metrcItems.map((it) => (<SelectItem key={it.Name} value={it.Name ?? ""}>{it.Name}{it.UnitOfMeasureName ? ` · ${it.UnitOfMeasureName}` : ""}</SelectItem>))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input className="mt-1 h-9" value={tagForm.item} onChange={(e) => setTagForm((f) => ({ ...f, item: e.target.value }))} placeholder="Exact METRC item name" />
                        )}
                        <p className="mt-1 text-[10px] text-muted-foreground">Created from the Source tag as a production batch, pulling the quantity below.</p>
                      </div>
                      <div>
                        <Label className="text-xs">METRC location <span className="text-destructive">*</span></Label>
                        {metrcLocations.length > 0 ? (
                          <Select value={tagForm.location} onValueChange={(v) => setTagForm((f) => ({ ...f, location: v }))}>
                            <SelectTrigger className="mt-1 h-9"><SelectValue placeholder="Select facility location…" /></SelectTrigger>
                            <SelectContent>
                              {metrcLocations.map((loc) => (<SelectItem key={loc} value={loc}>{loc}</SelectItem>))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input className="mt-1 h-9" value={tagForm.location} onChange={(e) => setTagForm((f) => ({ ...f, location: e.target.value }))} placeholder="Exact METRC location name" />
                        )}
                        <p className="mt-1 text-[10px] text-muted-foreground">The facility room/area the new package is stored in — METRC requires it.</p>
                      </div>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div className="space-y-2">
                  {tagForm.ranges.map((r, i) => (
                    <div key={i} className="rounded-md border p-2 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">Range {i + 1}</span>
                        {tagForm.ranges.length > 1 && (
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => removeTagRange(i)} aria-label="Remove range">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs">First tag <span className="text-destructive">*</span></Label>
                          <Input className="mt-1 h-9 font-mono" value={r.rangeStart} onChange={(e) => updateTagRange(i, { rangeStart: e.target.value })} />
                        </div>
                        <div>
                          <Label className="text-xs">Last tag <span className="text-destructive">*</span></Label>
                          <Input className="mt-1 h-9 font-mono" value={r.rangeEnd} onChange={(e) => updateTagRange(i, { rangeEnd: e.target.value })} />
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs">Count (optional)</Label>
                        <Input type="number" className="mt-1 h-9" value={r.rangeCount} onChange={(e) => updateTagRange(i, { rangeCount: e.target.value })} placeholder="units in this range" />
                      </div>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" className="h-8" onClick={addTagRange}>
                    <Plus className="h-4 w-4 mr-1" /> Add another range
                  </Button>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">
                    {tagForm.mode === "single" && tagForm.createInMetrc
                      ? <>Package quantity (count) <span className="text-destructive">*</span></>
                      : "Quantity at this stage (optional)"}
                  </Label>
                  <Input type="number" step="0.01" className="mt-1 h-9" value={tagForm.quantity} onChange={(e) => { const q = e.target.value; setTagForm((f) => { const it = metrcItems.find((i) => i.Name === f.item); const draw = computeSourceDraw(it, q); return { ...f, quantity: q, sourceQuantity: f.sourceQtyManual ? f.sourceQuantity : (draw?.qty ?? f.sourceQuantity), sourceUom: f.sourceQtyManual ? f.sourceUom : (draw?.uom || f.sourceUom) }; }); }} />
                </div>
                <div>
                  <Label className="text-xs">{tagForm.mode === "single" && tagForm.createInMetrc ? "Package UoM" : "UoM"}</Label>
                  <Input className="mt-1 h-9" value={tagForm.uom} onChange={(e) => setTagForm((f) => ({ ...f, uom: e.target.value }))} placeholder="g" />
                </div>
              </div>
              {tagForm.mode === "single" && tagForm.createInMetrc && (
                <div className="rounded-md border border-dashed p-2 space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium">Amount drawn from source</Label>
                    {tagForm.sourceQtyManual
                      ? <button type="button" className="text-[10px] underline text-muted-foreground" onClick={() => setTagForm((f) => { const it = metrcItems.find((i) => i.Name === f.item); const draw = computeSourceDraw(it, f.quantity); return { ...f, sourceQtyManual: false, sourceQuantity: draw?.qty ?? f.sourceQuantity, sourceUom: draw?.uom || f.sourceUom }; })}>Reset to auto</button>
                      : (tagForm.sourceQuantity ? <span className="text-[10px] text-muted-foreground">auto from item weight</span> : null)}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Draw quantity</Label>
                      <Input type="number" step="0.0001" className="mt-1 h-9" value={tagForm.sourceQuantity} onChange={(e) => setTagForm((f) => ({ ...f, sourceQuantity: e.target.value, sourceQtyManual: true }))} placeholder="e.g. 100" />
                    </div>
                    <div>
                      <Label className="text-xs">Draw UoM</Label>
                      <Input className="mt-1 h-9" value={tagForm.sourceUom} onChange={(e) => setTagForm((f) => ({ ...f, sourceUom: e.target.value, sourceQtyManual: true }))} placeholder="Grams" />
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    How much is pulled from the source package — a weight for a count output (e.g. 100 cartridges × 1&nbsp;g = 100 Grams). Auto-filled from the item's unit weight; edit to override.
                  </p>
                </div>
              )}
              {tagPreview != null && <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-[10px]">{JSON.stringify(tagPreview, null, 2)}</pre>}
              {tagError && <p className="text-xs text-destructive">{tagError}</p>}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setTagDialogOpen(false)}>Cancel</Button>
              {tagForm.mode === "single" && tagForm.createInMetrc && (
                <Button variant="outline" onClick={runTagPreview} disabled={tagPending}>Preview payload</Button>
              )}
              <Button onClick={handleRecordTagNode} disabled={tagPending}>{tagPending ? "Saving…" : (tagForm.mode === "single" && tagForm.createInMetrc ? "Create in METRC & record" : "Record")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Session 73 — Cancel a tag node (universal Cancel pattern: reason +
            Manager/Quality/Admin + Part 11 e-sig; recoverable, audited). */}
        <Dialog open={cancelTag !== null} onOpenChange={(o) => { if (!o) { setCancelTag(null); setCancelTagError(null); } }}>
          <DialogContent className="sm:max-w-[440px]">
            <DialogHeader>
              <DialogTitle>Cancel tag node</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-1">
              <p className="text-xs text-muted-foreground">
                Hides this node from the lineage. It is <strong>recoverable</strong> (Admin can re-instate) and the action is audited — records are never hard-deleted (21 CFR Part 11).
              </p>
              {cancelTag && (
                <div className="rounded-md bg-muted px-3 py-2 text-xs font-mono">
                  {cancelTag.stageLabel}: {cancelTag.kind === "range" ? `${cancelTag.rangeStart} – ${cancelTag.rangeEnd}` : cancelTag.metrcTag}
                </div>
              )}
              <div>
                <Label className="text-xs">Reason <span className="text-destructive">*</span></Label>
                <Textarea className="mt-1" value={cancelTagForm.reason} onChange={(e) => setCancelTagForm((f) => ({ ...f, reason: e.target.value }))} placeholder="Why is this node being cancelled?" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Initials <span className="text-destructive">*</span></Label>
                  <Input className="mt-1 h-9" value={cancelTagForm.initials} onChange={(e) => setCancelTagForm((f) => ({ ...f, initials: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs">Signing statement <span className="text-destructive">*</span></Label>
                  <Input className="mt-1 h-9" value={cancelTagForm.meaning} onChange={(e) => setCancelTagForm((f) => ({ ...f, meaning: e.target.value }))} placeholder="Cancelling — entered in error" />
                </div>
              </div>
              <p className="text-[10px] font-semibold text-destructive">21 CFR Part 11 Electronic Signature</p>
              {cancelTagError && <p className="text-xs text-destructive">{cancelTagError}</p>}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setCancelTag(null)}>Back</Button>
              <Button variant="destructive" onClick={handleCancelTagNode} disabled={cancelTagPending}>{cancelTagPending ? "Cancelling…" : "Cancel node"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>


        {/* Session 47 — in-batch NC capture. Batch context (id, product,
            batch number) is passed in so the dialog pre-fills the new NC
            without the operator re-typing. */}
        <LogNonConformanceDialog
          open={logNcOpen}
          onOpenChange={setLogNcOpen}
          batch={batch ? {
            id: batch.id,
            productType: batch.productType,
            productName: batch.productName,
            batchNumber: batch.batchNumber,
          } : null}
        />

        {/* Per-test-result attachments. Locked once the batch reaches a terminal state. */}
        <Dialog open={attachmentsForTestId !== null} onOpenChange={(o) => { if (!o) setAttachmentsForTestId(null); }}>
          <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Test Result Documents</DialogTitle>
            </DialogHeader>
            {attachmentsForTestId !== null && (
              <AttachmentsPanel
                parentTable="batch_testing"
                parentId={attachmentsForTestId}
                showPrimarySlot={false}
                allowSupplementary={!isTerminal}
                currentUserId={currentUser?.id}
                currentUserRole={currentUser?.role}
                title="CoAs, Lab Letters & Supporting Files"
              />
            )}
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}

// Session 59.1 — extract the {token} blanks from a step template (the baker
// fills these in). {baker} is excluded — it auto-fills from the signer.
function parseTemplateBlanks(template: string | null | undefined): string[] {
  if (!template) return [];
  const found = template.match(/\{([^}]+)\}/g) ?? [];
  const keys = found.map((t) => t.slice(1, -1).trim()).filter((k) => k.length > 0);
  return Array.from(new Set(keys));
}

// Baker fill-in-the-blank Part 11 signature dialog. Renders one input per
// template blank, a live preview of the completed sentence, and the e-signature
// fields. onSign throws on failure (keeps the dialog open with the message).
function BatchStepSignDialog({
  step, currentUserName, pending, sourceTagOptions, onClose, onSign,
}: {
  step: { id: number; description: string; template: string | null };
  currentUserName: string;
  pending: boolean;
  /** Session 111 — lots this batch consumed, offered for {source_tag}-style blanks. */
  sourceTagOptions: Array<{ tag: string; label: string }>;
  onClose: () => void;
  onSign: (initials: string, meaning: string, fieldValues: Record<string, string>) => Promise<void>;
}) {
  const blanks = parseTemplateBlanks(step.template).filter((b) => b.toLowerCase() !== "baker");
  // Session 111 — which blanks mean "a METRC tag this batch drew from". Template
  // authors write {source_tag}; normalize so "Source Tag" / "source-tag" /
  // {metrc_tag} all match rather than silently falling through to a bare input.
  const isSourceTagBlank = (key: string): boolean => {
    const k = key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    return k === "source_tag" || k === "metrc_tag" || k === "input_tag";
  };
  const [values, setValues] = useState<Record<string, string>>(() => {
    // Prefill only when there's exactly ONE candidate — with several consumed
    // lots the operator must say which one this step used; guessing would put an
    // unverified tag on a Part 11 signed record.
    if (sourceTagOptions.length !== 1) return {};
    const init: Record<string, string> = {};
    for (const b of blanks) if (isSourceTagBlank(b)) init[b] = sourceTagOptions[0].tag;
    return init;
  });
  const [initials, setInitials] = useState("");
  // Session 59.3 — the signing meaning is a preset dropdown, not free text, so a
  // baker on the floor never types a sentence. Defaults to the common case.
  const [meaning, setMeaning] = useState("Performed per procedure");
  const [error, setError] = useState("");

  const preview = (step.template ?? "").replace(/\{([^}]+)\}/g, (_m, raw) => {
    const k = String(raw).trim();
    if (k.toLowerCase() === "baker") return currentUserName || "____";
    return values[k]?.trim() ? values[k] : "____";
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (initials.trim().length < 2 || initials.trim().length > 4) { setError("Initials must be 2–4 characters."); return; }
    if (!meaning.trim()) { setError("Signing meaning is required."); return; }
    try {
      await onSign(initials.trim(), meaning.trim(), values);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign step.");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Sign Process Step as Operator</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-3">
            <p className="text-sm font-medium">{step.description}</p>
            {blanks.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {blanks.map((b) => {
                  // Session 111 — a source-tag blank offers the lots recorded on
                  // the Ingredients tab via a datalist: pick in one click, or
                  // still type a tag that wasn't recorded as an ingredient line.
                  const isTag = isSourceTagBlank(b) && sourceTagOptions.length > 0;
                  const listId = isTag ? `steptag-${step.id}-${b.replace(/[^a-zA-Z0-9]/g, "")}` : undefined;
                  return (
                    <div key={b} className={isTag ? "col-span-2" : undefined}>
                      <Label className="text-xs">{b}</Label>
                      <Input
                        className={`mt-1 h-9${isTag ? " font-mono text-xs" : ""}`}
                        list={listId}
                        value={values[b] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [b]: e.target.value }))}
                        placeholder={isTag ? "Pick a lot from this batch, or type a tag" : b}
                      />
                      {isTag && (
                        <>
                          <datalist id={listId}>
                            {sourceTagOptions.map((o) => <option key={o.tag} value={o.tag}>{o.label}</option>)}
                          </datalist>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            {sourceTagOptions.length === 1
                              ? `Filled from the Ingredients tab — ${sourceTagOptions[0].label}. Edit if this step used a different package.`
                              : `${sourceTagOptions.length} lots recorded on this batch — choose the one this step used.`}
                          </p>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {step.template && (
              <div className="rounded-md bg-muted/40 p-2 text-sm">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Batch record line</div>
                {preview}
              </div>
            )}
            <div className="border-t pt-3 grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Initials</Label>
                <Input className="mt-1 h-9" value={initials} onChange={(e) => setInitials(e.target.value.toUpperCase())} maxLength={4} placeholder="JD" />
              </div>
              <div>
                <Label className="text-xs">Meaning of signature</Label>
                <Select value={meaning} onValueChange={setMeaning}>
                  <SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Performed per procedure">Performed per procedure</SelectItem>
                    <SelectItem value="Completed as written">Completed as written</SelectItem>
                    <SelectItem value="Performed and verified">Performed and verified</SelectItem>
                    <SelectItem value="Performed with deviation (see notes)">Performed with deviation (see notes)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-[10px] font-semibold text-destructive">21 CFR Part 11 Electronic Signature · {"{baker}"} = {currentUserName || "you"}</p>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Signing…" : "Sign & Submit"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
