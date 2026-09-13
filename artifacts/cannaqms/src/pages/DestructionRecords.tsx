import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "wouter";
import { format } from "date-fns";
import { CreateDestructionRecordDialog } from "@/components/dialogs/CreateDestructionRecordDialog";
import { Search, Flame, Plus } from "lucide-react";

// Session 50 — standalone destruction records list page.
//
// destruction_records is off-spec (not in OpenAPI), so this uses raw fetch via
// react-query rather than an orval hook. Active/Archived toggle maps to the
// server's ?archived=true param; search + date range are client-side over the
// fetched list.

type DestructionRecord = {
  id: number;
  metrcTag: string;
  destroyedAt: string;
  destroyedByName: string;
  witnessName?: string | null;
  weight?: number | null;
  weightUom?: string | null;
  method?: string | null;
  notes?: string | null;
  status?: string | null;
  createdAt?: string | null;
  signedAt?: string | null;
  packageTags?: string[] | null;
  archivedAt?: string | null;
};

type View = "active" | "archived" | "cancelled";

const drRef = (id: number) => "DR-" + String(id).padStart(4, "0");

async function fetchRecords(view: View): Promise<DestructionRecord[]> {
  const q = view === "archived" ? "?archived=true" : view === "cancelled" ? "?cancelled=true" : "";
  const r = await fetch(`/api/destruction-records${q}`, { credentials: "include" });
  if (!r.ok) throw new Error("Failed to load destruction records");
  return r.json();
}

export default function DestructionRecords() {
  const [view, setView] = useState<View>("active");
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const { data: records = [], isLoading, refetch } = useQuery({
    queryKey: ["destruction-records", view],
    queryFn: () => fetchRecords(view),
  });

  const filtered = useMemo(() => {
    let list = records;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (r) =>
          drRef(r.id).toLowerCase().includes(q) ||
          r.metrcTag.toLowerCase().includes(q) ||
          (r.packageTags ?? []).some((t) => t.toLowerCase().includes(q)) ||
          r.destroyedByName.toLowerCase().includes(q) ||
          (r.method ?? "").toLowerCase().includes(q),
      );
    }
    if (fromDate) {
      const from = new Date(fromDate).getTime();
      list = list.filter((r) => new Date(r.destroyedAt).getTime() >= from);
    }
    if (toDate) {
      // inclusive end-of-day
      const to = new Date(toDate).getTime() + 24 * 60 * 60 * 1000 - 1;
      list = list.filter((r) => new Date(r.destroyedAt).getTime() <= to);
    }
    return list;
  }, [records, search, fromDate, toDate]);

  return (
    <>
      <div className="space-y-6">
        {/* ── Header ── */}
        <div className="cq-page-heading flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Flame className="h-6 w-6 text-red-500" />
              Destruction Records
            </h1>
            <p className="text-muted-foreground text-sm">
              METRC destruction events. One tag can cover many destroyed batches; link records to NCs from the NC detail page.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" />
            New Destruction Record
          </Button>
        </div>

        {/* ── View toggle + search + date range ── */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex gap-1">
            <Button variant={view === "active" ? "default" : "outline"} size="sm" className="h-8" onClick={() => setView("active")}>
              Active
            </Button>
            <Button variant={view === "archived" ? "default" : "outline"} size="sm" className="h-8" onClick={() => setView("archived")}>
              Archived
            </Button>
            <Button variant={view === "cancelled" ? "default" : "outline"} size="sm" className="h-8" onClick={() => setView("cancelled")}>
              Cancelled
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">From</Label>
              <Input type="date" className="h-8 text-sm mt-0.5" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">To</Label>
              <Input type="date" className="h-8 text-sm mt-0.5" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search record #, METRC tag, person…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
          </div>
        </div>

        {/* ── Table ── */}
        <div className="border rounded-md overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30">
                <TableHead className="w-[220px]">Record Number</TableHead>
                <TableHead className="w-[180px]">Date Started</TableHead>
                <TableHead className="w-[180px]">Date Closed</TableHead>
                <TableHead className="w-[120px]">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 4 }).map((__, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center h-28 text-muted-foreground">
                    <Flame className="mx-auto h-7 w-7 mb-2 opacity-30" />
                    <p className="text-sm">
                      {view === "archived" ? "No archived destruction records." : view === "cancelled" ? "No cancelled destruction records." : "No destruction records match your filters."}
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((rec) => (
                  <TableRow key={rec.id} className="hover:bg-muted/20">
                    <TableCell className="font-medium">
                      <Link href={`/destruction-records/${rec.id}`} className="hover:underline text-primary font-mono">
                        {drRef(rec.id)}
                      </Link>
                      {rec.metrcTag && <div className="text-[11px] text-muted-foreground font-mono truncate max-w-[200px]" title={rec.metrcTag}>{rec.metrcTag}</div>}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {rec.createdAt ? format(new Date(rec.createdAt), "MMM d, yyyy h:mm a") : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {rec.signedAt ? format(new Date(rec.signedAt), "MMM d, yyyy h:mm a") : "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {rec.status === "Closed"
                        ? <span className="inline-flex items-center px-2 py-0.5 rounded text-xs border bg-slate-100 text-slate-700 border-slate-300">Closed</span>
                        : <span className="inline-flex items-center px-2 py-0.5 rounded text-xs border bg-amber-50 text-amber-800 border-amber-300">Open</span>}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <CreateDestructionRecordDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => { void refetch(); }}
      />
    </>
  );
}
