import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { CancelRecordDialog } from "@/components/dialogs/CancelRecordDialog";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { Flame, ArchiveRestore, Archive, Ban, RotateCcw, ExternalLink, Pencil, Trash2 } from "lucide-react";

// Roles permitted to Cancel / Uncancel (mirrors server CANCEL_ROLES). Narrower
// than the approver set elsewhere — no Supervisor.
const CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);

// Session 50 — destruction record detail page. Off-spec route, so raw fetch
// via react-query. The GET returns the record plus linkedNcs.

type LinkedNc = { id: number; ncNumber: string; title: string; status: string; severity: string };
type DestructionLine = {
  id: number;
  metrcTag: string;
  itemName?: string | null;
  amount?: number | null;
  uom?: string | null;
  reason?: string | null;
  note?: string | null;
  metrcSynced?: boolean | null;
  metrcSyncError?: string | null;
  metrcSyncedAt?: string | null;
};
type DestructionRecord = {
  id: number;
  metrcTag: string;
  destroyedAt: string;
  destroyedByName: string;
  witnessName?: string | null;
  reason?: string | null;
  weight?: number | null;
  weightUom?: string | null;
  method?: string | null;
  nonCannabisMaterial?: string | null;
  mixtureConfirmed?: boolean | null;
  signedByName?: string | null;
  signedByInitials?: string | null;
  signedMeaning?: string | null;
  signedAt?: string | null;
  disposalRoute?: string | null;
  haulerName?: string | null;
  manifestNumber?: string | null;
  sourceBatchId?: number | null;
  sourceLotNumber?: string | null;
  surveillanceConfirmed?: boolean | null;
  surveillanceCameraRef?: string | null;
  notes?: string | null;
  status?: string | null;
  metrcAdjustmentReason?: string | null;
  archivedAt?: string | null;
  cancelledAt?: string | null;
  cancelledReason?: string | null;
  cancelledByName?: string | null;
  cancelledByInitials?: string | null;
  cancelledMeaning?: string | null;
  linkedNcs?: LinkedNc[];
  lines?: DestructionLine[];
};

// The internal destruction record number IS the "Record of Evidence" reference
// logged on the CRA waste/destruction log.
const evidenceRef = (id: number) => `DR-${String(id).padStart(4, "0")}`;
const LINE_REASONS = ["Failed Test", "Expired", "Low Potency", "Damaged", "Processing Scrap", "Recall", "Return", "Other"] as const;
const LINE_UOMS = ["ea", "g", "oz", "lb", "kg", "mg"] as const; // "ea" = Each; must match the tag's METRC unit.

async function fetchRecord(id: number): Promise<DestructionRecord> {
  const r = await fetch(`/api/destruction-records/${id}`, { credentials: "include" });
  if (!r.ok) throw new Error("Failed to load destruction record");
  return r.json();
}

const NC_SEVERITY_PILL: Record<string, string> = {
  Critical: "bg-red-50 text-red-700 border-red-200",
  Major: "bg-orange-50 text-orange-700 border-orange-200",
  Minor: "bg-yellow-50 text-yellow-700 border-yellow-200",
};

export default function DestructionRecordDetail(props: { params?: { id: string } }) {
  const id = parseInt(props.params?.id ?? "0");
  const { toast } = useToast();
  const { data: currentUser } = useGetCurrentUser();

  const { data: record, isLoading, refetch } = useQuery({
    queryKey: ["destruction-record", id],
    queryFn: () => fetchRecord(id),
    enabled: id > 0,
  });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    destroyedByName: "", witnessName: "", weight: "", weightUom: "", method: "", notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [uncancelOpen, setUncancelOpen] = useState(false);
  const [uncancelPending, setUncancelPending] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closePending, setClosePending] = useState(false);
  const [addingPkg, setAddingPkg] = useState(false);
  const [savingPkg, setSavingPkg] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newUom, setNewUom] = useState("");
  const [newReason, setNewReason] = useState("");
  const [newNote, setNewNote] = useState("");
  const [editingLineId, setEditingLineId] = useState<number | null>(null);
  const [lineDraft, setLineDraft] = useState({ amount: "", uom: "", reason: "", note: "" });
  const [lineBusy, setLineBusy] = useState(false);

  const isArchived = !!record?.archivedAt;
  const isCancelled = !!record?.cancelledAt;
  const isClosed = record?.status === "Closed";
  const isOpen = !!record && !isClosed && !isCancelled;
  const isAdmin = currentUser?.role === "Admin";
  const canCancel = !!currentUser?.role && CANCEL_ROLES.has(currentUser.role);
  // Re-open is Admin-only (Session 52 decision), narrower than Cancel.
  const canReopen = currentUser?.role === "Admin";
  const linkedNcs = record?.linkedNcs ?? [];
  const openNcCount = linkedNcs.filter((nc) => nc.status !== "Closed").length;

  // Header "Reason" should never contradict the per-package reasons: show a
  // single reason only when every destroyed package shares it, otherwise say so.
  const drLines = record?.lines ?? [];
  const distinctLineReasons = Array.from(new Set(drLines.map((l) => l.reason).filter((r): r is string => !!r)));
  const reasonDisplay = drLines.length > 0
    ? (distinctLineReasons.length <= 1 ? (distinctLineReasons[0] ?? record?.reason ?? null) : "Multiple — see Packages Destroyed")
    : (record?.reason ?? null);

  const startEdit = () => {
    if (!record) return;
    setDraft({
      destroyedByName: record.destroyedByName ?? "",
      witnessName: record.witnessName ?? "",
      weight: record.weight != null ? String(record.weight) : "",
      weightUom: record.weightUom ?? "",
      method: record.method ?? "",
      notes: record.notes ?? "",
    });
    setEditing(true);
  };

  const save = async () => {
    const weightNum = draft.weight.trim() ? Number(draft.weight) : null;
    if (draft.weight.trim() && (weightNum === null || Number.isNaN(weightNum))) {
      toast({ title: "Weight must be a number", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/destruction-records/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destroyedByName: draft.destroyedByName.trim(),
          witnessName: draft.witnessName.trim() || null,
          weight: weightNum,
          weightUom: draft.weightUom.trim() || null,
          method: draft.method.trim() || null,
          notes: draft.notes.trim() || null,
        }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Save failed");
      }
      await refetch();
      setEditing(false);
      toast({ title: "Saved", description: "Destruction record updated." });
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async () => {
    setBusy(true);
    try {
      const action = isArchived ? "unarchive" : "archive";
      const r = await fetch(`/api/destruction-records/${id}/${action}`, { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      await refetch();
      toast({ title: isArchived ? "Unarchived" : "Archived" });
    } catch {
      toast({ title: "Error", description: "Failed to change archive state.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  // Cancel = soft, recoverable, Part 11 e-signed (no hard delete). Throws on
  // failure so CancelRecordDialog surfaces the server message inline.
  const handleCancel = async (reason: string, initials: string, meaning: string) => {
    setCancelPending(true);
    try {
      const r = await fetch(`/api/destruction-records/${id}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, initials, signatureMeaning: meaning }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to cancel record.");
      }
      await refetch();
      toast({ title: "Record cancelled", description: "Retained and recoverable; removed from active use." });
    } finally {
      setCancelPending(false);
    }
  };

  const handleUncancel = async (initials: string, meaning: string) => {
    setUncancelPending(true);
    try {
      const r = await fetch(`/api/destruction-records/${id}/uncancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initials, signatureMeaning: meaning }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to reverse cancellation.");
      }
      await refetch();
      toast({ title: "Record re-opened", description: "Record returned to active use." });
    } finally {
      setUncancelPending(false);
    }
  };

  // Close & Sign — Part 11 signature; locks the record. (Phase 2 will also push
  // the METRC adjust-to-0 + finish here.)
  const handleClose = async (initials: string, meaning: string) => {
    setClosePending(true);
    try {
      const r = await fetch(`/api/destruction-records/${id}/close`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initials, signatureMeaning: meaning }),
      });
      const body = await r.json().catch(() => ({} as { error?: string; metrcResults?: { ok: boolean; error?: string }[] }));
      if (!r.ok) { throw new Error((body as { error?: string }).error ?? "Failed to close record."); }
      await refetch();
      const results = (body as { metrcResults?: { ok: boolean; error?: string }[] }).metrcResults ?? [];
      const okCount = results.filter((x) => x.ok).length;
      const failCount = results.length - okCount;
      toast({
        title: "Record closed",
        description: results.length === 0
          ? "Signed and locked."
          : failCount === 0
            ? `Signed and locked. ${okCount} package${okCount === 1 ? "" : "s"} adjusted in METRC.`
            : `Signed and locked. METRC: ${okCount} ok, ${failCount} flagged — see the packages below.`,
      });
    } finally { setClosePending(false); }
  };

  const addPackage = async () => {
    if (!newTag.trim()) { toast({ title: "METRC tag required" }); return; }
    if (newAmount.trim() && Number.isNaN(Number(newAmount))) { toast({ title: "Amount must be a number" }); return; }
    setSavingPkg(true);
    try {
      const r = await fetch(`/api/destruction-records/${id}/lines`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metrcTag: newTag.trim(),
          amount: newAmount.trim() === "" ? null : Number(newAmount),
          uom: newUom || null, reason: newReason || null, note: newNote.trim() || null,
        }),
      });
      if (!r.ok) { const b = await r.json().catch(() => ({} as { error?: string })); toast({ title: b.error ?? "Failed to add package." }); return; }
      await refetch();
      setNewTag(""); setNewAmount(""); setNewUom(""); setNewReason(""); setNewNote(""); setAddingPkg(false);
      toast({ title: "Package added" });
    } finally { setSavingPkg(false); }
  };

  const startLineEdit = (l: DestructionLine) => {
    setEditingLineId(l.id);
    setLineDraft({ amount: l.amount != null ? String(l.amount) : "", uom: l.uom ?? "", reason: l.reason ?? "", note: l.note ?? "" });
  };
  const saveLine = async (lineId: number) => {
    if (lineDraft.amount.trim() && Number.isNaN(Number(lineDraft.amount))) { toast({ title: "Amount must be a number" }); return; }
    setLineBusy(true);
    try {
      const r = await fetch(`/api/destruction-records/${id}/lines/${lineId}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: lineDraft.amount.trim() === "" ? null : Number(lineDraft.amount),
          uom: lineDraft.uom || null, reason: lineDraft.reason || null, note: lineDraft.note.trim() || null,
        }),
      });
      if (!r.ok) { const b = await r.json().catch(() => ({} as { error?: string })); toast({ title: b.error ?? "Failed to edit package." }); return; }
      await refetch();
      setEditingLineId(null);
      toast({ title: "Package updated" });
    } finally { setLineBusy(false); }
  };
  const removeLine = async (lineId: number) => {
    if (!confirm("Remove this package from the record?")) return;
    setLineBusy(true);
    try {
      const r = await fetch(`/api/destruction-records/${id}/lines/${lineId}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) { const b = await r.json().catch(() => ({} as { error?: string })); toast({ title: b.error ?? "Failed to remove package." }); return; }
      await refetch();
      toast({ title: "Package removed" });
    } finally { setLineBusy(false); }
  };

  return (
    <>
      <div className="space-y-6 max-w-4xl mx-auto pb-12">
        <Link href="/destruction-records" className="text-sm text-primary hover:underline block">
          &larr; Back to Destruction Records
        </Link>

        <div className="cq-page-heading flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Flame className="h-6 w-6 text-red-500" />
              {isLoading ? <Skeleton className="h-8 w-[260px]" /> : <span className="font-mono">{record?.metrcTag}</span>}
            </h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {record ? <><span className="font-mono font-medium text-foreground" title="Record of Evidence reference">{evidenceRef(record.id)}</span>{" · "}</> : null}
              {record?.destroyedAt ? `Destroyed ${format(new Date(record.destroyedAt), "MMM d, yyyy h:mm a")}` : ""}
              {record && !isCancelled && (isClosed
                ? <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs border bg-slate-100 text-slate-700 border-slate-300">Closed</span>
                : <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs border bg-amber-50 text-amber-800 border-amber-300">Open</span>)}
              {isArchived && <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs border bg-slate-100 text-slate-600 border-slate-300">Archived</span>}
              {isCancelled && <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs border bg-red-50 text-red-700 border-red-200">Cancelled</span>}
            </p>
          </div>
          {record && (
            <div className="flex items-center gap-2">
              {isOpen && (
                <Button size="sm" onClick={() => setCloseOpen(true)} disabled={busy} className="gap-1.5">
                  <Flame className="h-4 w-4" />
                  Close &amp; Sign
                </Button>
              )}
              {!isCancelled && (
                <Button variant="outline" size="sm" onClick={toggleArchive} disabled={busy} className="gap-1.5">
                  {isArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                  {isArchived ? "Unarchive" : "Archive"}
                </Button>
              )}
              {!isCancelled && canCancel && (
                <Button variant="outline" size="sm" onClick={() => setCancelOpen(true)} disabled={busy} className="gap-1.5 text-destructive hover:text-destructive">
                  <Ban className="h-4 w-4" />
                  Cancel
                </Button>
              )}
              {isCancelled && canReopen && (
                <Button variant="outline" size="sm" onClick={() => setUncancelOpen(true)} disabled={uncancelPending} className="gap-1.5">
                  <RotateCcw className="h-4 w-4" />
                  Re-open
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Cancelled banner — Part 11 record of who/why. */}
        {isCancelled && record && (
          <div className="rounded-lg border-2 border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm font-semibold text-red-900 flex items-center gap-2">
              <Ban className="h-4 w-4" /> This record has been cancelled
            </p>
            <p className="text-xs text-red-800 mt-1">
              {record.cancelledByName}{record.cancelledByInitials ? ` (${record.cancelledByInitials})` : ""}
              {record.cancelledAt ? ` · ${format(new Date(record.cancelledAt), "MMM d, yyyy h:mm a")}` : ""}
            </p>
            {record.cancelledReason && (
              <p className="text-sm text-red-900 mt-1.5 whitespace-pre-wrap">
                <span className="font-medium">Reason:</span> {record.cancelledReason}
              </p>
            )}
            <p className="text-[11px] text-red-700 mt-1 italic">Retained for compliance; can be re-opened by an Admin only.</p>
          </div>
        )}

        {/* Fields */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-base">Record Details</CardTitle>
            {!editing && !isLoading && isOpen && (
              <Button variant="outline" size="sm" onClick={startEdit}>Edit</Button>
            )}
          </CardHeader>
          <CardContent className="pt-2">
            {isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : editing ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Destroyed By</Label>
                    <Input className="mt-1" value={draft.destroyedByName} onChange={(e) => setDraft((v) => ({ ...v, destroyedByName: e.target.value }))} />
                  </div>
                  <div>
                    <Label className="text-xs">Witness</Label>
                    <Input className="mt-1" value={draft.witnessName} onChange={(e) => setDraft((v) => ({ ...v, witnessName: e.target.value }))} />
                  </div>
                  <div>
                    <Label className="text-xs">Weight</Label>
                    <Input className="mt-1" type="number" step="any" value={draft.weight} onChange={(e) => setDraft((v) => ({ ...v, weight: e.target.value }))} />
                  </div>
                  <div>
                    <Label className="text-xs">Unit</Label>
                    <Input className="mt-1" placeholder="g / oz / lb / units" value={draft.weightUom} onChange={(e) => setDraft((v) => ({ ...v, weightUom: e.target.value }))} />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Method</Label>
                  <Input className="mt-1" value={draft.method} onChange={(e) => setDraft((v) => ({ ...v, method: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs">Notes</Label>
                  <Textarea className="mt-1 text-sm" rows={2} value={draft.notes} onChange={(e) => setDraft((v) => ({ ...v, notes: e.target.value }))} />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Destroyed By</dt>
                  <dd className="mt-0.5 font-medium">{record?.destroyedByName}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Witness</dt>
                  <dd className="mt-0.5 font-medium">{record?.witnessName || <span className="text-muted-foreground italic">—</span>}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Weight</dt>
                  <dd className="mt-0.5 font-medium">{record?.weight != null ? `${record.weight}${record.weightUom ? ` ${record.weightUom}` : ""}` : <span className="text-muted-foreground italic">—</span>}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Method</dt>
                  <dd className="mt-0.5 font-medium">{record?.method || <span className="text-muted-foreground italic">—</span>}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Reason</dt>
                  <dd className="mt-0.5 font-medium">{reasonDisplay || <span className="text-muted-foreground italic">—</span>}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Rendered unusable (R 420.211)</dt>
                  <dd className="mt-0.5 font-medium">
                    {record?.mixtureConfirmed
                      ? <span className="text-emerald-700">Confirmed ≥50% non-marijuana{record?.nonCannabisMaterial ? ` · ${record.nonCannabisMaterial}` : ""}</span>
                      : record?.nonCannabisMaterial
                        ? record.nonCannabisMaterial
                        : <span className="text-muted-foreground italic">Not confirmed</span>}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Disposal route</dt>
                  <dd className="mt-0.5 font-medium">{record?.disposalRoute || <span className="text-muted-foreground italic">—</span>}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Waste hauler / manifest</dt>
                  <dd className="mt-0.5 font-medium">
                    {record?.haulerName || record?.manifestNumber
                      ? <>{record?.haulerName || ""}{record?.manifestNumber ? <span className="font-mono">{record?.haulerName ? " · " : ""}{record.manifestNumber}</span> : ""}</>
                      : <span className="text-muted-foreground italic">—</span>}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Source batch / lot</dt>
                  <dd className="mt-0.5 font-medium">
                    {record?.sourceBatchId
                      ? <Link href={`/batches/${record.sourceBatchId}`} className="text-primary hover:underline font-mono">{record?.sourceLotNumber || `Batch #${record.sourceBatchId}`}</Link>
                      : record?.sourceLotNumber
                        ? <span className="font-mono">{record.sourceLotNumber}</span>
                        : <span className="text-muted-foreground italic">—</span>}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Video surveillance</dt>
                  <dd className="mt-0.5 font-medium">
                    {record?.surveillanceConfirmed
                      ? <span className="text-emerald-700">Confirmed on camera{record?.surveillanceCameraRef ? ` · ${record.surveillanceCameraRef}` : ""}</span>
                      : <span className="text-muted-foreground italic">Not attested</span>}
                  </dd>
                </div>
                {record?.signedAt && (
                  <div className="col-span-2">
                    <dt className="text-xs text-muted-foreground">Electronic signature (21 CFR Part 11)</dt>
                    <dd className="mt-0.5">
                      <span className="font-medium">{record.signedByName}</span>
                      {record.signedByInitials ? ` (${record.signedByInitials})` : ""}
                      {" — "}{record.signedMeaning}
                      <span className="text-muted-foreground"> · {new Date(record.signedAt).toLocaleString()}</span>
                    </dd>
                  </div>
                )}
                {record?.notes && (
                  <div className="col-span-2">
                    <dt className="text-xs text-muted-foreground">Notes</dt>
                    <dd className="mt-0.5 whitespace-pre-wrap">{record.notes}</dd>
                  </div>
                )}
              </dl>
            )}
          </CardContent>
        </Card>

        {/* Packages to adjust — the METRC tags logged under this record. */}
        {record && (
          <Card>
            <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">
                Packages to Adjust ({(record.lines?.length ?? 0) || (record.metrcTag ? 1 : 0)})
              </CardTitle>
              {isOpen && !addingPkg && (
                <Button size="sm" variant="outline" onClick={() => setAddingPkg(true)}>Add Package</Button>
              )}
            </CardHeader>
            <CardContent className="pt-2 space-y-2">
              {isOpen && addingPkg && (
                <div className="rounded-md border p-3 space-y-2 bg-muted/20">
                  <Input className="font-mono text-sm" placeholder="Scan or type a METRC tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} />
                  <div className="grid grid-cols-3 gap-2">
                    <Input placeholder="Amount" value={newAmount} onChange={(e) => setNewAmount(e.target.value)} />
                    <Select value={newUom} onValueChange={setNewUom}>
                      <SelectTrigger><SelectValue placeholder="Unit" /></SelectTrigger>
                      <SelectContent>{LINE_UOMS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                    </Select>
                    <Select value={newReason} onValueChange={setNewReason}>
                      <SelectTrigger><SelectValue placeholder="Reason" /></SelectTrigger>
                      <SelectContent>{LINE_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <Input placeholder="Note (optional)" value={newNote} onChange={(e) => setNewNote(e.target.value)} />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => { setAddingPkg(false); setNewTag(""); setNewAmount(""); setNewUom(""); setNewReason(""); setNewNote(""); }}>Cancel</Button>
                    <Button size="sm" onClick={() => void addPackage()} disabled={savingPkg}>{savingPkg ? "Adding…" : "Add"}</Button>
                  </div>
                </div>
              )}
              {record.lines && record.lines.length > 0 ? (
                <div className="divide-y border rounded-md">
                  {record.lines.map((l) => (
                    <div key={l.id} className="px-3 py-2">
                      {editingLineId === l.id ? (
                        <div className="space-y-2">
                          <div className="font-mono text-xs font-medium truncate">{l.metrcTag}</div>
                          <div className="grid grid-cols-3 gap-2">
                            <Input placeholder="Amount" value={lineDraft.amount} onChange={(e) => setLineDraft((v) => ({ ...v, amount: e.target.value }))} />
                            <Select value={lineDraft.uom} onValueChange={(val) => setLineDraft((v) => ({ ...v, uom: val }))}>
                              <SelectTrigger><SelectValue placeholder="Unit" /></SelectTrigger>
                              <SelectContent>{LINE_UOMS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                            </Select>
                            <Select value={lineDraft.reason} onValueChange={(val) => setLineDraft((v) => ({ ...v, reason: val }))}>
                              <SelectTrigger><SelectValue placeholder="Reason" /></SelectTrigger>
                              <SelectContent>{LINE_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                            </Select>
                          </div>
                          <Input placeholder="Note" value={lineDraft.note} onChange={(e) => setLineDraft((v) => ({ ...v, note: e.target.value }))} />
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="ghost" onClick={() => setEditingLineId(null)}>Cancel</Button>
                            <Button size="sm" onClick={() => void saveLine(l.id)} disabled={lineBusy}>Save</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-mono text-sm font-medium truncate">{l.metrcTag}</div>
                            {l.itemName && <div className="text-xs text-muted-foreground truncate">{l.itemName}</div>}
                            {l.note && <div className="text-xs text-muted-foreground mt-0.5">{l.note}</div>}
                          </div>
                          <div className="flex items-center gap-3 shrink-0 text-sm pt-0.5">
                            <span>{l.amount != null ? `${l.amount}${l.uom ? ` ${l.uom}` : ""}` : <span className="text-muted-foreground">—</span>}</span>
                            {l.reason && <Badge variant="secondary">{l.reason}</Badge>}
                            {l.metrcSynced && <Badge variant="outline" className="text-emerald-700 border-emerald-300">In METRC</Badge>}
                            {!l.metrcSynced && l.metrcSyncError && <Badge variant="outline" className="text-amber-700 border-amber-300" title={l.metrcSyncError}>METRC failed</Badge>}
                            {isOpen && isAdmin && (
                              <span className="flex items-center gap-1">
                                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => startLineEdit(l)} disabled={lineBusy}><Pencil className="h-3.5 w-3.5" /></Button>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => void removeLine(l.id)} disabled={lineBusy}><Trash2 className="h-3.5 w-3.5" /></Button>
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                // Legacy single-tag record (created before per-package lines).
                <div className="flex items-center justify-between gap-3 px-3 py-2 border rounded-md">
                  <span className="font-mono text-sm font-medium truncate">{record.metrcTag}</span>
                  <div className="flex items-center gap-3 shrink-0 text-sm">
                    <span>{record.weight != null ? `${record.weight}${record.weightUom ? ` ${record.weightUom}` : ""}` : <span className="text-muted-foreground">—</span>}</span>
                    {record.reason && <Badge variant="secondary">{record.reason}</Badge>}
                  </div>
                </div>
              )}
              {isOpen && isAdmin && <p className="text-[11px] text-muted-foreground">As an Admin you can edit or remove packages while this record is Open. Others can add packages.</p>}
            </CardContent>
          </Card>
        )}

        {/* Linked NCs */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Linked Non-Conformances ({linkedNcs.length})</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            {linkedNcs.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No NCs reference this record yet. NCs link from their detail page when dispositioned Destroy.</p>
            ) : (
              <div className="divide-y border rounded-md">
                {linkedNcs.map((nc) => (
                  <Link key={nc.id} href={`/non-conformances/${nc.id}`}>
                    <div className="flex items-center justify-between px-3 py-2 hover:bg-muted/40 cursor-pointer">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="font-mono text-sm font-semibold text-primary shrink-0">{nc.ncNumber}</span>
                        <span className="text-sm truncate">{nc.title}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${NC_SEVERITY_PILL[nc.severity] ?? "bg-gray-100 text-gray-600"}`}>
                          {nc.severity}
                        </span>
                        <Badge variant="secondary">{nc.status}</Badge>
                        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Attachments — destruction certificates, photos. Uses the existing
            attachments system; "destruction_records" was added to the server
            ALLOWED_PARENT_TABLES this session. */}
        {record && (
          <AttachmentsPanel
            parentTable="destruction_records"
            parentId={record.id}
            currentUserId={currentUser?.id}
            currentUserRole={currentUser?.role}
            title="Attachments (destruction certificates, photos)"
          />
        )}
      </div>

      {/* Cancel (Part 11) — rationale + e-signature. */}
      <CancelRecordDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        entityLabel="Destruction Record"
        warning={openNcCount > 0
          ? `${openNcCount} open NC${openNcCount === 1 ? "" : "s"} reference this record. Cancellation will be refused until ${openNcCount === 1 ? "it is" : "they are"} closed.`
          : null}
        isPending={cancelPending}
        onConfirm={handleCancel}
      />

      {/* Uncancel — Part 11 e-signature only (no new rationale). */}
      <Part11SignatureDialog
        open={uncancelOpen}
        onOpenChange={setUncancelOpen}
        title="Re-open Record"
        description="Re-open this cancelled destruction record and return it to active use. Restricted to Admin; requires an Admin signature."
        isPending={uncancelPending}
        onSign={handleUncancel}
      />

      {/* Close & Sign — Part 11 e-signature; locks the record. */}
      <Part11SignatureDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        title="Close & Sign Destruction Record"
        description={`By signing you confirm the destruction is complete and these packages were rendered unusable. This locks the record — no packages can be added or edited afterward. If METRC write-back is enabled, closing adjusts each package down to 0 in METRC with reason "${record?.metrcAdjustmentReason ?? "Waste"}" and finishes it; any package METRC rejects is flagged on the record. If write-back is off, make those METRC adjustments yourself.`}
        isPending={closePending}
        onSign={handleClose}
      />
    </>
  );
}
