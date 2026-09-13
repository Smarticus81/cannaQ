import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link, useLocation } from "wouter";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { ClipboardCheck, Plus, AlertTriangle, CalendarClock } from "lucide-react";

// Inventory Checks — periodic physical-count reconciliation against METRC.
// Off-spec route (raw fetch via react-query), same convention as destruction records.

type CheckRow = {
  id: number;
  checkNumber: string;
  periodLabel?: string | null;
  status: string;
  countType: string;
  metrcSnapshotAt?: string | null;
  completedAt?: string | null;
  lineCount: number;
  countedCount: number;
  varianceCount: number;
};
type Schedule = {
  cadence: string;
  graceDays: number;
  lastCompletedAt: string | null;
  nextDueAt: string | null;
  overdue: boolean;
  neverRun: boolean;
};
type ListResp = { schedule: Schedule; checks: CheckRow[] };

async function fetchChecks(): Promise<ListResp> {
  const r = await fetch("/api/inventory-checks", { credentials: "include" });
  if (!r.ok) throw new Error("Failed to load inventory checks");
  return r.json();
}

function currentQuarterLabel(): string {
  const d = new Date();
  return `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}`;
}

const STATUS_PILL: Record<string, string> = {
  "In Progress": "bg-amber-50 text-amber-700 border-amber-200",
  Completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Cancelled: "bg-slate-100 text-slate-500 border-slate-300",
};

export default function InventoryChecks() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { data, isLoading, refetch } = useQuery({ queryKey: ["inventory-checks"], queryFn: fetchChecks });

  const [open, setOpen] = useState(false);
  const [periodLabel, setPeriodLabel] = useState("");
  const [countType, setCountType] = useState("Full");
  const [creating, setCreating] = useState(false);

  const openDialog = () => { setPeriodLabel(currentQuarterLabel()); setCountType("Full"); setOpen(true); };

  const create = async () => {
    setCreating(true);
    try {
      const r = await fetch("/api/inventory-checks", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodLabel: periodLabel.trim() || null, countType }),
      });
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error ?? "Failed to create check"); }
      const rec = await r.json() as { id: number; checkNumber: string };
      toast({ title: "Inventory check created", description: `${rec.checkNumber} — snapshot from METRC to begin.` });
      setOpen(false);
      navigate(`/inventory-checks/${rec.id}`);
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const schedule = data?.schedule;
  const checks = data?.checks ?? [];

  return (
    <>
      <div className="space-y-6">
        <div className="cq-page-heading flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ClipboardCheck className="h-6 w-6 text-primary" />
              Inventory Checks
            </h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              Periodic physical counts reconciled against METRC. Variances require a written reason and a Part 11 sign-off.
            </p>
          </div>
          <Button onClick={openDialog} className="gap-1.5"><Plus className="h-4 w-4" /> New Check</Button>
        </div>

        {/* Schedule status */}
        {schedule && schedule.cadence !== "None" && (
          <Card className={schedule.overdue ? "border-red-200" : ""}>
            <CardContent className="py-3 flex items-center gap-3 text-sm">
              {schedule.overdue
                ? <AlertTriangle className="h-4 w-4 text-red-500 shrink-0" />
                : <CalendarClock className="h-4 w-4 text-muted-foreground shrink-0" />}
              <div>
                <span className="font-medium">{schedule.cadence} cadence.</span>{" "}
                {schedule.neverRun
                  ? <span className="text-muted-foreground">No completed check yet — run your first one.</span>
                  : schedule.overdue
                    ? <span className="text-red-700">Overdue — next check was due {schedule.nextDueAt ? format(new Date(schedule.nextDueAt), "MMM d, yyyy") : "—"}.</span>
                    : <span className="text-muted-foreground">Next check due {schedule.nextDueAt ? format(new Date(schedule.nextDueAt), "MMM d, yyyy") : "—"}.</span>}
                <span className="text-muted-foreground"> Change the cadence in Settings.</span>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4"><Skeleton className="h-40 w-full" /></div>
            ) : checks.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">
                No inventory checks yet. Click <span className="font-medium">New Check</span> to start one.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Check #</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Progress</TableHead>
                    <TableHead>Variances</TableHead>
                    <TableHead>Completed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {checks.map((c) => (
                    <TableRow key={c.id} className="cursor-pointer" onClick={() => navigate(`/inventory-checks/${c.id}`)}>
                      <TableCell><Link href={`/inventory-checks/${c.id}`} className="font-mono font-semibold text-primary">{c.checkNumber}</Link></TableCell>
                      <TableCell>{c.periodLabel || <span className="text-muted-foreground">—</span>} <span className="text-xs text-muted-foreground">· {c.countType}</span></TableCell>
                      <TableCell><span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${STATUS_PILL[c.status] ?? "bg-gray-100 text-gray-600"}`}>{c.status}</span></TableCell>
                      <TableCell className="text-sm">{c.lineCount === 0 ? <span className="text-muted-foreground">No snapshot</span> : `${c.countedCount}/${c.lineCount} counted`}</TableCell>
                      <TableCell>{c.varianceCount > 0 ? <Badge variant="destructive">{c.varianceCount}</Badge> : <span className="text-muted-foreground text-sm">{c.lineCount ? "0" : "—"}</span>}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.completedAt ? format(new Date(c.completedAt), "MMM d, yyyy") : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><ClipboardCheck className="h-4 w-4 text-primary" /> New Inventory Check</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-xs">Period (optional)</Label>
              <Input className="mt-1" placeholder="e.g. 2026 Q3" value={periodLabel} onChange={(e) => setPeriodLabel(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Count type</Label>
              <Select value={countType} onValueChange={setCountType}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Full">Full — whole-facility count</SelectItem>
                  <SelectItem value="Partial">Partial — cycle count / subset</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">You'll snapshot the live METRC package quantities on the next screen, then enter physical counts.</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={creating}>{creating ? "Creating…" : "Create & open"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
