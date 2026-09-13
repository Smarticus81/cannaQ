import { useListIncomingInspections } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { accentClass, toneInspectionResult } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { formatDateOnly } from "@/lib/utils";
import { useMemo, useState } from "react";
import { X, Clock, AlertTriangle, CheckCircle2, ClipboardList } from "lucide-react";
import { differenceInCalendarDays, parseISO } from "date-fns";
import { CreateInspectionDialog } from "@/components/dialogs/CreateInspectionDialog";

// The in-process inspection states. Pending = not yet decided; Conditional =
// accepted pending a certificate/CoA + Supervisor+ sign-off. Pass/Fail/Closed
// are resolved and drop off the open summary. (Jonathan, 2026-08-10.)
const OPEN_INSPECTION_RESULTS = ["Pending", "Conditional"];

// Queue presets understood by the ?queue= URL param (Session 26).
const INSPECTION_QUEUE_LABELS: Record<string, string> = {
  needs_rationale: "Conditional inspections awaiting Supervisor+ sign-off",
};

export default function Inspections() {
  const { data: inspections, isLoading } = useListIncomingInspections();
  // Session 52.1 — Active / Cancelled view. Active list excludes cancelled
  // server-side; the Cancelled view raw-fetches ?cancelled=true (off-spec param).
  const [view, setView] = useState<"active" | "cancelled">("active");
  const { data: cancelledInspections = [], isLoading: cancelledLoading } = useQuery({
    queryKey: ["incoming-inspections", "cancelled"],
    queryFn: async () => {
      const r = await fetch("/api/incoming-inspections?cancelled=true", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load cancelled inspections");
      return r.json() as Promise<NonNullable<typeof inspections>>;
    },
    enabled: view === "cancelled",
  });

  // Session 26 — ?queue= deep-link from the Dashboard My Queue tile.
  const [queueParam, setQueueParam] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const q = new URLSearchParams(window.location.search).get("queue");
    return q && INSPECTION_QUEUE_LABELS[q] ? q : null;
  });
  const clearQueueFilter = () => {
    setQueueParam(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("queue");
      window.history.replaceState({}, "", url.toString());
    }
  };

  // Mirrors the Dashboard tile predicate: result === "Conditional" is the
  // canonical "needs Supervisor+ judgment" resting state. See Dashboard.tsx
  // inspectionsNeedingRationale comment for rationale.
  const visibleInspections = useMemo(() => {
    if (view === "cancelled") return cancelledInspections;
    if (!queueParam || !inspections) return inspections ?? [];
    switch (queueParam) {
      case "needs_rationale":
        return inspections.filter((i) => i.result === "Conditional");
      default:
        return inspections;
    }
  }, [view, cancelledInspections, inspections, queueParam]);

  const tableLoading = view === "cancelled" ? cancelledLoading : isLoading;

  // Open (in-process) inspections for the top-of-screen summary — oldest first,
  // so anything lingering (e.g. Conditional waiting on a certificate) surfaces.
  const openInspections = useMemo(
    () =>
      (inspections ?? [])
        .filter((i) => OPEN_INSPECTION_RESULTS.includes(i.result))
        .sort((a, b) => a.inspectionDate.localeCompare(b.inspectionDate)),
    [inspections],
  );

  return (
    <>
      <div className="space-y-6">
        <div className="cq-page-heading flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Incoming Inspections</h1>
            <p className="text-muted-foreground">Log of material receipts and quality checks.</p>
          </div>
          <CreateInspectionDialog />
        </div>

        {/* Open-inspections summary (2026-08-10) — surfaces in-process receipts
            (Pending / Conditional) and how long they've been open, so anything
            waiting on a certificate/sign-off past a day is visible up front.
            Active view only; the Cancelled view has no "open" concept. */}
        {view === "active" && (
          <div className="rounded-lg border bg-card">
            <div className="flex items-center gap-2 border-b px-4 py-2.5">
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Open inspections</h2>
              {!isLoading && (
                <span className="ml-1 inline-flex items-center justify-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {openInspections.length}
                </span>
              )}
            </div>
            <div className="px-4 py-2.5">
              {isLoading ? (
                <Skeleton className="h-5 w-64" />
              ) : openInspections.length === 0 ? (
                <p className="flex items-center gap-1.5 py-1 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  No open inspections — all receipts are resolved.
                </p>
              ) : (
                <ul className="divide-y">
                  {openInspections.map((i) => {
                    const days = differenceInCalendarDays(new Date(), parseISO(i.inspectionDate));
                    const aging = days > 1;
                    return (
                      <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                        <StatusBadge tone={toneInspectionResult(i.result)} label={i.result} />
                        <Link href={`/inspections/${i.id}`} className="font-medium text-primary hover:underline">
                          {i.inspectionNumber}
                        </Link>
                        {i.supplierName && <span className="text-muted-foreground">{i.supplierName}</span>}
                        {i.poManifestNumber && <span className="text-xs text-muted-foreground">· {i.poManifestNumber}</span>}
                        <span
                          className={`ml-auto inline-flex items-center gap-1 text-xs ${aging ? "font-medium text-amber-700" : "text-muted-foreground"}`}
                          title={`Opened ${formatDateOnly(i.inspectionDate)}`}
                        >
                          {aging ? <AlertTriangle className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
                          {days === 0 ? "Opened today" : `Open ${days} day${days === 1 ? "" : "s"}`}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* Session 52.1 — Active / Cancelled view toggle. */}
        <div className="flex gap-1">
          <Button variant={view === "active" ? "default" : "outline"} size="sm" className="h-8" onClick={() => setView("active")}>
            Active
          </Button>
          <Button variant={view === "cancelled" ? "default" : "outline"} size="sm" className="h-8" onClick={() => setView("cancelled")}>
            Cancelled
          </Button>
        </div>

        {/* Active queue filter banner (Session 26) — mirrors the pattern from
            CAPAs.tsx and NonConformances.tsx so deep-links from the Dashboard
            land on a clearly-filtered view that the user can dismiss. */}
        {queueParam && INSPECTION_QUEUE_LABELS[queueParam] && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/[0.05] px-3 py-2 text-sm">
            <span>
              Showing: <span className="font-medium">{INSPECTION_QUEUE_LABELS[queueParam]}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={clearQueueFilter} className="h-7 gap-1">
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          </div>
        )}

        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Inspection #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>PO/Manifest</TableHead>
                <TableHead>Inspection State</TableHead>
                <TableHead>Inspector</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tableLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-[100px]" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-[100px]" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-[150px]" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-[100px]" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-[80px]" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-[120px]" /></TableCell>
                  </TableRow>
                ))
              ) : visibleInspections?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center h-24 text-muted-foreground">
                    {view === "cancelled"
                      ? "No cancelled inspections."
                      : queueParam
                        ? "No inspections match the current queue filter."
                        : "No inspections found. Log your first incoming inspection."}
                  </TableCell>
                </TableRow>
              ) : (
                visibleInspections?.map((inspection) => {
                  // Session 99 (#6) — row accent flags only Fail (urgent) /
                  // Conditional (caution); Pass and other states stay calm.
                  const t = toneInspectionResult(inspection.result);
                  const rowTone = t === "urgent" || t === "caution" ? t : "neutral";
                  return (
                  <TableRow key={inspection.id} className={accentClass(rowTone) || undefined}>
                    <TableCell className="font-medium">
                      <Link href={`/inspections/${inspection.id}`} className="hover:underline text-primary">
                        {inspection.inspectionNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{formatDateOnly(inspection.inspectionDate)}</TableCell>
                    <TableCell>{inspection.supplierName}</TableCell>
                    <TableCell>{inspection.poManifestNumber}</TableCell>
                    <TableCell>
                      <StatusBadge tone={toneInspectionResult(inspection.result)} label={inspection.result} />
                    </TableCell>
                    <TableCell>{inspection.inspectedByName}</TableCell>
                  </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </>
  );
}
