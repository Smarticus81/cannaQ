import { useState, useMemo } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SiteName, useFacilities } from "@/components/FacilitySite";
import { useListComplaints } from "@workspace/api-client-react";
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
import { Link } from "wouter";
import { format, differenceInCalendarDays, parseISO } from "date-fns";
import { CreateComplaintDialog } from "@/components/dialogs/CreateComplaintDialog";
import { ComplaintsCharts } from "@/components/complaints/ComplaintsCharts";
import { StatusBadge } from "@/components/ui/status-badge";
import { accentClass, toneComplaintSeverity, toneComplaintStatus } from "@/lib/status";
import {
  Search,
  AlertTriangle,
  ShieldAlert,
} from "lucide-react";

const STATUSES = [
  "All",
  "Open",
  "Under Investigation",
  "Pending Corrections",
  "Closed - CAPA Created",
  "Closed",
] as const;
type StatusFilter = (typeof STATUSES)[number];

const STATUS_STYLES: Record<string, string> = {
  Open: "bg-red-50 text-red-700 border-red-200",
  "Under Investigation": "bg-yellow-50 text-yellow-700 border-yellow-200",
  "Pending Corrections": "bg-orange-50 text-orange-700 border-orange-200",
  "Closed - CAPA Created": "bg-slate-100 text-slate-600 border-slate-300",
  Closed: "bg-slate-100 text-slate-600 border-slate-300",
};


function deadlineDays(severity: string, type: string): number {
  if (type === "Adverse Event" || severity === "Critical") return 3;
  if (severity === "High") return 30;
  return 90;
}

const isClosedStatus = (st?: string): boolean =>
  st === "Closed" || st === "Closed - CAPA Created";

export default function Complaints() {
  // The site column only exists for a company with more than one site.
  const { multiSite } = useFacilities();
  const { data: complaints = [], isLoading } = useListComplaints();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [search, setSearch] = useState("");
  // Session 100 — tiles deep-link with ?status=open to show only not-closed
  // complaints. Cleared the moment the user clicks any status pill.
  const [openOnly, setOpenOnly] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("status") === "open";
  });
  // Session 52.1 — Active / Cancelled view. Active list excludes cancelled
  // server-side; the Cancelled view raw-fetches ?cancelled=true (off-spec param).
  const [view, setView] = useState<"active" | "cancelled">("active");
  const { data: cancelledComplaints = [], isLoading: cancelledLoading } = useQuery({
    queryKey: ["complaints", "cancelled"],
    queryFn: async () => {
      const r = await fetch("/api/complaints?cancelled=true", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load cancelled complaints");
      return r.json() as Promise<typeof complaints>;
    },
    enabled: view === "cancelled",
  });

  const counts = useMemo(() => {
    const map: Record<string, number> = {
      All: openOnly ? complaints.filter((c) => !isClosedStatus(c.status)).length : complaints.length,
    };
    for (const c of complaints) {
      map[c.status] = (map[c.status] ?? 0) + 1;
    }
    return map;
  }, [complaints, openOnly]);

  const filtered = useMemo(() => {
    let list = view === "cancelled" ? cancelledComplaints : complaints;
    if (view === "active" && openOnly && statusFilter === "All") list = list.filter((c) => !isClosedStatus(c.status));
    if (view === "active" && statusFilter !== "All") list = list.filter((c) => c.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (c) =>
          c.complaintNumber.toLowerCase().includes(q) ||
          c.complaintType.toLowerCase().includes(q) ||
          (c.customerName ?? "").toLowerCase().includes(q) ||
          (c.productName ?? "").toLowerCase().includes(q) ||
          c.severity.toLowerCase().includes(q)
      );
    }
    return list;
  }, [view, cancelledComplaints, complaints, statusFilter, search, openOnly]);

  const tableLoading = view === "cancelled" ? cancelledLoading : isLoading;

  const criticalOpen = useMemo(
    () =>
      complaints.filter(
        (c) =>
          !isClosedStatus(c.status) &&
          (c.severity === "Critical" || c.complaintType === "Adverse Event")
      ).length,
    [complaints]
  );

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* ── Header ── */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Complaints</h1>
            <p className="text-muted-foreground text-sm">
              Customer and patient complaints — Michigan CRA tracking (adverse reactions: R 420.214b).
            </p>
          </div>
          <CreateComplaintDialog />
        </div>

        {/* ── CRA alert if any critical/adverse are open ── */}
        {!isLoading && criticalOpen > 0 && (
          <div className="flex items-start gap-3 rounded-lg border border-orange-300 bg-orange-50 px-4 py-3 text-orange-900">
            <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5 text-orange-600" />
            <p className="text-sm">
              <span className="font-semibold">
                {criticalOpen} Critical / Adverse Event complaint
                {criticalOpen > 1 ? "s" : ""} open.
              </span>{" "}
              Report adverse reactions to the CRA and log in METRC within 1
              business day (R 420.214b).
            </p>
          </div>
        )}

        {/* ── Summary cards ── */}
        {view === "active" && !isLoading && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(
              [
                "Open",
                "Under Investigation",
                "Pending Corrections",
                "Closed",
              ] as const
            ).map((s) => {
              const count = counts[s] ?? 0;
              const style = STATUS_STYLES[s];
              return (
                <button
                  key={s}
                  onClick={() =>
                    { setOpenOnly(false); setStatusFilter(statusFilter === s ? "All" : s); }
                  }
                  className={`rounded-lg border p-3 text-left transition-all hover:shadow-sm ${
                    statusFilter === s
                      ? style + " ring-2 ring-offset-1 ring-current"
                      : "bg-white border-border hover:border-muted-foreground/30"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground truncate pr-2">
                      {s}
                    </span>
                    <span className="text-2xl font-bold shrink-0">{count}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {view === "active" && !isLoading && <ComplaintsCharts complaints={complaints} />}

        {/* ── Active / Cancelled view toggle (Session 52.1) ── */}
        <div className="flex gap-1">
          <Button variant={view === "active" ? "default" : "outline"} size="sm" className="h-8" onClick={() => setView("active")}>
            Active
          </Button>
          <Button variant={view === "cancelled" ? "default" : "outline"} size="sm" className="h-8" onClick={() => setView("cancelled")}>
            Cancelled
          </Button>
        </div>

        {/* ── Filter tabs + search ── */}
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          {view === "active" ? (
            <div className="flex gap-1 flex-wrap">
              {STATUSES.map((s) => (
                <Button
                  key={s}
                  variant={statusFilter === s ? "default" : "outline"}
                  size="sm"
                  className="h-8"
                  onClick={() => { setOpenOnly(false); setStatusFilter(s); }}
                >
                  {s === "Closed - CAPA Created" ? "Closed · CAPA" : s}
                  <span
                    className={`ml-1.5 text-xs rounded-full px-1.5 py-0.5 ${
                      statusFilter === s
                        ? "bg-white/20 text-white"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {counts[s] ?? 0}
                  </span>
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Cancelled complaints are retained for compliance (never deleted) and can be re-opened by an Admin.
            </p>
          )}
          <div className="relative flex-1 max-w-xs sm:ml-auto">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search complaint, customer, product…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm"
            />
          </div>
        </div>

        {/* ── Table ── */}
        <div className="border rounded-md overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30">
                <TableHead className="w-[120px]">Complaint #</TableHead>
                <TableHead>Type / Customer</TableHead>
                <TableHead className="w-[90px]">Severity</TableHead>
                <TableHead className="w-[175px]">Status</TableHead>
                {multiSite && <TableHead className="w-[130px]">Site</TableHead>}
                <TableHead className="w-[100px]">Received</TableHead>
                <TableHead className="w-[100px] text-right">Days Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tableLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: multiSite ? 7 : 6 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={multiSite ? 7 : 6}
                    className="text-center h-28 text-muted-foreground"
                  >
                    <AlertTriangle className="mx-auto h-7 w-7 mb-2 opacity-30" />
                    <p className="text-sm">{view === "cancelled" ? "No cancelled complaints." : "No complaints match your filters."}</p>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((complaint) => {
                  // Session 97 (#6) — row accent by urgency; closed rows stay calm.
                  const rowTone = isClosedStatus(complaint.status) ? "neutral" : toneComplaintSeverity(complaint.severity);
                  const receivedDate = parseISO(complaint.receivedDate);
                  const daysOpen =
                    isClosedStatus(complaint.status) && complaint.closedAt
                      ? differenceInCalendarDays(
                          new Date(complaint.closedAt),
                          receivedDate
                        )
                      : differenceInCalendarDays(new Date(), receivedDate);
                  const deadline = deadlineDays(
                    complaint.severity,
                    complaint.complaintType
                  );
                  const isPastDeadline =
                    !isClosedStatus(complaint.status) && daysOpen > deadline;
                  const isNearDeadline =
                    !isClosedStatus(complaint.status) &&
                    !isPastDeadline &&
                    daysOpen >= deadline - 2;
                  const isCraFlag =
                    complaint.complaintType === "Adverse Event" ||
                    complaint.severity === "Critical";

                  return (
                    <TableRow key={complaint.id} className={`hover:bg-muted/20 ${accentClass(rowTone)}`}>
                      <TableCell className="font-mono font-medium">
                        <div className="flex items-center gap-1.5">
                          {isCraFlag && (
                            <ShieldAlert className="h-3.5 w-3.5 text-orange-500 shrink-0" />
                          )}
                          <Link
                            href={`/complaints/${complaint.id}`}
                            className="hover:underline text-primary"
                          >
                            {complaint.complaintNumber}
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/complaints/${complaint.id}`}
                          className="hover:underline text-sm font-medium"
                        >
                          {complaint.complaintType}
                        </Link>
                        {complaint.customerName && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {complaint.customerName}
                          </p>
                        )}
                        {complaint.productName && (
                          <p className="text-xs text-muted-foreground">
                            {complaint.productName}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={toneComplaintSeverity(complaint.severity)} label={complaint.severity} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={toneComplaintStatus(complaint.status)} label={complaint.status} />
                      </TableCell>
                      {multiSite && (
                        <TableCell>
                          <SiteName facilityId={(complaint as { facilityId?: number | null }).facilityId} />
                        </TableCell>
                      )}
                      <TableCell className="text-sm text-muted-foreground">
                        {format(receivedDate, "MMM d, yyyy")}
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={`text-sm font-medium ${
                            isPastDeadline
                              ? "text-red-600"
                              : isNearDeadline
                                ? "text-orange-600"
                                : isClosedStatus(complaint.status)
                                  ? "text-muted-foreground"
                                  : "text-foreground"
                          }`}
                        >
                          {daysOpen}d
                          {isClosedStatus(complaint.status) && (
                            <span className="ml-1 text-xs text-muted-foreground font-normal">
                              (closed)
                            </span>
                          )}
                          {isPastDeadline && (
                            <span className="block text-xs font-normal">
                              ⚠ past {deadline}d limit
                            </span>
                          )}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        {!isLoading && filtered.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Internal response targets (from receipt): Adverse Event / Critical 3 days ·
            High 30 days · Medium / Low 90 days. Adverse reactions: notify the CRA and log in METRC within 1 business day (R 420.214b).
          </p>
        )}
      </div>
    </AppLayout>
  );
}
