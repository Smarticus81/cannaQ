import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "wouter";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { CancelRecordDialog } from "@/components/dialogs/CancelRecordDialog";
import { ClipboardCheck, RefreshCw, CheckCircle2, Ban, AlertTriangle } from "lucide-react";

type Line = {
  id: number;
  metrcTag: string;
  itemName?: string | null;
  category?: string | null;
  uom?: string | null;
  systemQty?: number | null;
  countedQty?: number | null;
  variance?: number | null;
  counted: boolean;
  reason?: string | null;
};
type Check = {
  id: number;
  checkNumber: string;
  periodLabel?: string | null;
  status: string;
  countType: string;
  metrcSnapshotAt?: string | null;
  completedAt?: string | null;
  countedByName?: string | null;
  signedByName?: string | null;
  signedByInitials?: string | null;
  signedMeaning?: string | null;
  signedAt?: string | null;
  cancelledAt?: string | null;
  cancelledReason?: string | null;
  cancelledByName?: string | null;
  cancelledByInitials?: string | null;
  notes?: string | null;
  lines?: Line[];
};

type RowEdit = { id: number; countedQty: string; reason: string };

async function fetchCheck(id: number): Promise<Check> {
  const r = await fetch(`/api/inventory-checks/${id}`, { credentials: "include" });
  if (!r.ok) throw new Error("Failed to load inventory check");
  return r.json();
}

export default function InventoryCheckDetail(props: { params?: { id: string } }) {
  const id = parseInt(props.params?.id ?? "0");
  const { toast } = useToast();
  useGetCurrentUser();
  const { data: check, isLoading, refetch } = useQuery({ queryKey: ["inventory-check", id], queryFn: () => fetchCheck(id), enabled: id > 0 });

  const [rows, setRows] = useState<Record<number, RowEdit>>({});
  const [busy, setBusy] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [signPending, setSignPending] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);

  const lines = check?.lines ?? [];
  const editable = check?.status === "In Progress";

  useEffect(() => {
    const next: Record<number, RowEdit> = {};
    for (const l of lines) next[l.id] = { id: l.id, countedQty: l.countedQty != null ? String(l.countedQty) : "", reason: l.reason ?? "" };
    setRows(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check?.id, check?.metrcSnapshotAt, lines.length]);

  const snapshot = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/inventory-checks/${id}/snapshot`, { method: "POST", credentials: "include" });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error ?? "Snapshot failed");
      await refetch();
      toast({ title: "Snapshot captured", description: `${b.snapshot?.packages ?? 0} active METRC package(s): ${b.snapshot?.inserted ?? 0} added, ${b.snapshot?.updated ?? 0} refreshed.` });
    } catch (e) {
      toast({ title: "Could not snapshot METRC", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const saveLine = async (lineId: number, patch: { countedQty?: number | null; reason?: string | null }) => {
    try {
      const r = await fetch(`/api/inventory-checks/${id}/lines/${lineId}`, {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error ?? "Save failed"); }
      await refetch();
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const onCountBlur = (l: Line) => {
    const raw = rows[l.id]?.countedQty ?? "";
    const val = raw.trim() === "" ? null : Number(raw);
    if (val != null && Number.isNaN(val)) { toast({ title: "Count must be a number", variant: "destructive" }); return; }
    const prior = l.countedQty ?? null;
    if (val === prior) return;
    void saveLine(l.id, { countedQty: val });
  };
  const onReasonBlur = (l: Line) => {
    const val = (rows[l.id]?.reason ?? "").trim();
    if (val === (l.reason ?? "")) return;
    void saveLine(l.id, { reason: val || null });
  };

  const variance = (l: Line): number | null => {
    const raw = rows[l.id]?.countedQty ?? "";
    if (raw.trim() === "") return l.variance ?? null;
    const v = Number(raw);
    if (Number.isNaN(v)) return l.variance ?? null;
    return v - (l.systemQty ?? 0);
  };

  const total = lines.length;
  const counted = lines.filter((l) => l.counted).length;
  const varianceLines = lines.filter((l) => l.variance != null && l.variance !== 0);
  const unexplained = varianceLines.filter((l) => !(l.reason && l.reason.trim())).length;
  const netVariance = lines.reduce((s, l) => s + (l.variance ?? 0), 0);
  const canComplete = editable && total > 0 && counted === total && unexplained === 0;

  const handleComplete = async (initials: string, meaning: string) => {
    setSignPending(true);
    try {
      const r = await fetch(`/api/inventory-checks/${id}/complete`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initials, signatureMeaning: meaning }),
      });
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error ?? "Failed to complete"); }
      await refetch();
      toast({ title: "Inventory check completed", description: "Signed and locked." });
    } finally { setSignPending(false); }
  };

  const handleCancel = async (reason: string, initials: string, meaning: string) => {
    setCancelPending(true);
    try {
      const r = await fetch(`/api/inventory-checks/${id}/cancel`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, initials, signatureMeaning: meaning }),
      });
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error ?? "Failed to cancel"); }
      await refetch();
      toast({ title: "Inventory check cancelled" });
    } finally { setCancelPending(false); }
  };

  const fmtQty = (q?: number | null, uom?: string | null) => q == null ? "—" : `${q}${uom ? ` ${uom}` : ""}`;

  return (
    <>
      <div className="space-y-6 max-w-5xl mx-auto pb-12">
        <Link href="/inventory-checks" className="text-sm text-primary hover:underline block">&larr; Back to Inventory Checks</Link>

        <div className="cq-page-heading flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ClipboardCheck className="h-6 w-6 text-primary" />
              {isLoading ? <Skeleton className="h-8 w-[220px]" /> : <span className="font-mono">{check?.checkNumber}</span>}
            </h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {check?.periodLabel ? `${check.periodLabel} · ` : ""}{check?.countType} count
              {check?.metrcSnapshotAt ? ` · METRC snapshot ${format(new Date(check.metrcSnapshotAt), "MMM d, yyyy h:mm a")}` : ""}
              {check?.status === "Completed" && <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs border bg-emerald-50 text-emerald-700 border-emerald-200">Completed</span>}
              {check?.status === "Cancelled" && <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs border bg-slate-100 text-slate-500 border-slate-300">Cancelled</span>}
            </p>
          </div>
          {check && editable && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={snapshot} disabled={busy} className="gap-1.5"><RefreshCw className="h-4 w-4" /> {check.metrcSnapshotAt ? "Re-snapshot" : "Snapshot METRC"}</Button>
              <Button size="sm" onClick={() => setSignOpen(true)} disabled={!canComplete} className="gap-1.5"><CheckCircle2 className="h-4 w-4" /> Complete</Button>
              <Button variant="outline" size="sm" onClick={() => setCancelOpen(true)} className="gap-1.5 text-destructive hover:text-destructive"><Ban className="h-4 w-4" /> Cancel</Button>
            </div>
          )}
        </div>

        {check?.status === "Cancelled" && (
          <div className="rounded-lg border-2 border-slate-200 bg-slate-50 px-4 py-3 text-sm">
            <p className="font-semibold flex items-center gap-2"><Ban className="h-4 w-4" /> Cancelled</p>
            <p className="text-muted-foreground mt-1">{check.cancelledByName}{check.cancelledByInitials ? ` (${check.cancelledByInitials})` : ""}{check.cancelledAt ? ` · ${format(new Date(check.cancelledAt), "MMM d, yyyy h:mm a")}` : ""}</p>
            {check.cancelledReason && <p className="mt-1"><span className="font-medium">Reason:</span> {check.cancelledReason}</p>}
          </div>
        )}

        {/* Summary tiles */}
        {check && total > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card><CardContent className="py-3"><p className="text-xs text-muted-foreground">Packages</p><p className="text-xl font-semibold">{total}</p></CardContent></Card>
            <Card><CardContent className="py-3"><p className="text-xs text-muted-foreground">Counted</p><p className="text-xl font-semibold">{counted}/{total}</p></CardContent></Card>
            <Card className={varianceLines.length ? "border-amber-200" : ""}><CardContent className="py-3"><p className="text-xs text-muted-foreground">Variances</p><p className={`text-xl font-semibold ${varianceLines.length ? "text-amber-700" : ""}`}>{varianceLines.length}</p></CardContent></Card>
            <Card><CardContent className="py-3"><p className="text-xs text-muted-foreground">Net variance</p><p className={`text-xl font-semibold ${netVariance !== 0 ? "text-amber-700" : ""}`}>{netVariance > 0 ? "+" : ""}{Number(netVariance.toFixed(4))}</p></CardContent></Card>
          </div>
        )}

        {editable && unexplained > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {unexplained} variance line{unexplained === 1 ? "" : "s"} still need a written reason before you can complete this check.
          </div>
        )}

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Reconciliation ({total})</CardTitle></CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4"><Skeleton className="h-40 w-full" /></div>
            ) : total === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No lines yet. {editable ? <>Click <span className="font-medium">Snapshot METRC</span> to pull the facility's active packages and their expected quantities.</> : "No METRC snapshot was captured."}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>METRC Tag</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">METRC qty</TableHead>
                    <TableHead className="text-right">Counted</TableHead>
                    <TableHead className="text-right">Variance</TableHead>
                    <TableHead>Reason (if variance)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l) => {
                    const v = variance(l);
                    const hasVar = v != null && v !== 0;
                    const needReason = hasVar && !(rows[l.id]?.reason ?? "").trim();
                    return (
                      <TableRow key={l.id}>
                        <TableCell className="font-mono text-xs">{l.metrcTag}</TableCell>
                        <TableCell className="text-sm">{l.itemName || <span className="text-muted-foreground">—</span>}{l.category ? <span className="text-xs text-muted-foreground"> · {l.category}</span> : ""}</TableCell>
                        <TableCell className="text-right text-sm">{fmtQty(l.systemQty, l.uom)}</TableCell>
                        <TableCell className="text-right">
                          {editable ? (
                            <Input
                              className="h-8 w-24 ml-auto text-right"
                              type="number"
                              step="any"
                              value={rows[l.id]?.countedQty ?? ""}
                              onChange={(e) => setRows((s) => ({ ...s, [l.id]: { ...s[l.id], countedQty: e.target.value } }))}
                              onBlur={() => onCountBlur(l)}
                            />
                          ) : fmtQty(l.countedQty, l.uom)}
                        </TableCell>
                        <TableCell className={`text-right text-sm font-medium ${hasVar ? "text-amber-700" : l.counted ? "text-emerald-700" : "text-muted-foreground"}`}>
                          {v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v.toFixed(4))}`}
                        </TableCell>
                        <TableCell>
                          {editable ? (
                            <Input
                              className={`h-8 text-sm ${needReason ? "border-amber-400" : ""}`}
                              placeholder={hasVar ? "Required — explain the variance" : "—"}
                              value={rows[l.id]?.reason ?? ""}
                              onChange={(e) => setRows((s) => ({ ...s, [l.id]: { ...s[l.id], reason: e.target.value } }))}
                              onBlur={() => onReasonBlur(l)}
                            />
                          ) : (l.reason || <span className="text-muted-foreground text-sm">—</span>)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {check?.signedAt && (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Electronic signature (21 CFR Part 11)</CardTitle></CardHeader>
            <CardContent className="text-sm">
              <span className="font-medium">{check.signedByName}</span>{check.signedByInitials ? ` (${check.signedByInitials})` : ""}
              {" — "}{check.signedMeaning}
              <span className="text-muted-foreground"> · {new Date(check.signedAt).toLocaleString()}</span>
            </CardContent>
          </Card>
        )}
      </div>

      <Part11SignatureDialog
        open={signOpen}
        onOpenChange={setSignOpen}
        title="Complete Inventory Check"
        description="Attest that the physical counts above were performed and reconciled against METRC. This locks the check."
        isPending={signPending}
        onSign={handleComplete}
      />
      <CancelRecordDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        entityLabel="Inventory Check"
        warning={null}
        isPending={cancelPending}
        onConfirm={handleCancel}
      />
    </>
  );
}
