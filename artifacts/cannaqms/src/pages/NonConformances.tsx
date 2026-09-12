import { useState, useMemo, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SiteName, useFacilities } from "@/components/FacilitySite";
import { useListNonConformances } from "@workspace/api-client-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TermTip } from "@/components/ui/TermTip";
import { Link } from "wouter";
import { CreateNonConformanceDialog } from "@/components/dialogs/CreateNonConformanceDialog";
import { StatusBadge } from "@/components/ui/status-badge";
import { accentClass, toneNcSeverity, toneNcStatus } from "@/lib/status";
import { format, differenceInCalendarDays, parseISO } from "date-fns";
import { AlertTriangle, Search } from "lucide-react";
import { NCCharts } from "@/components/non-conformances/NCCharts";

// Session 21 — filter tabs refreshed to match the Session 11 locked status set.
// "CAPA Required" is no longer canonical but is recognised when it appears on
// pre-Session-11 rows (see NC_STATUS_STYLES below).
const NC_STATUSES = [
  "All",
  "Open",
  "In Progress",
  "Awaiting Mgt Acknowledgement",
  "Under Review",
  "Closed",
] as const;
type NcStatusFilter = (typeof NC_STATUSES)[number];

const NC_STATUS_STYLES: Record<string, string> = {
  Open: "bg-red-50 text-red-700 border-red-200",
  "In Progress": "bg-blue-50 text-blue-700 border-blue-200",
  "Awaiting Mgt Acknowledgement": "bg-rose-50 text-rose-700 border-rose-200",
  "Under Review": "bg-yellow-50 text-yellow-700 border-yellow-200",
  Closed: "bg-slate-100 text-slate-600 border-slate-300",
  // Back-compat — pre-Session-11 status (no longer written by new flows).
  "CAPA Required": "bg-orange-50 text-orange-700 border-orange-200",
};

// Queue presets understood by the ?queue= URL param (Session 18; extended Session 24).
const NC_QUEUE_LABELS: Record<string, string> = {
  mgmt_ack: "Major / Critical NCs awaiting management acknowledgement",
  needs_disposition: "Major / Critical NCs awaiting disposition decision",
};

export default function NonConformances() {
  // The site column only exists for a company with more than one site.
  const { multiSite } = useFacilities();
  const { data: ncs = [], isLoading } = useListNonConformances();
  const [statusFilter, setStatusFilter] = useState<NcStatusFilter>("All");
  const [search, setSearch] = useState("");
  // Session 100 — tiles deep-link with ?status=open to show only not-closed
  // NCs (matches the Dashboard "Open Non-Conformances" count). Cleared the
  // moment the user clicks any status pill.
  const [openOnly, setOpenOnly] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("status") === "open";
  });
  // Session 52 — Active / Cancelled view. The active list already excludes
  // cancelled server-side; the Cancelled view fetches ?cancelled=true (off-spec
  // param, so raw fetch rather than an orval hook).
  const [view, setView] = useState<"active" | "cancelled">("active");
  const { data: cancelledNcs = [], isLoading: cancelledLoading } = useQuery({
    queryKey: ["non-conformances", "cancelled"],
    queryFn: async () => {
      const r = await fetch("/api/non-conformances?cancelled=true", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load cancelled NCs");
      return r.json() as Promise<typeof ncs>;
    },
    enabled: view === "cancelled",
  });

  // Session 18 — ?queue= deep-link from Dashboard My Queue tile.
  const [queueParam, setQueueParam] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const q = new URLSearchParams(window.location.search).get("queue");
    return q && NC_QUEUE_LABELS[q] ? q : null;
  });
  const clearQueueFilter = () => {
    setQueueParam(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("queue");
      window.history.replaceState({}, "", url.toString());
    }
  };

  // Apply queue filter first; status/search layer on after.
  // mgmtAcknowledgedAt and disposition aren't always in the orval-typed shape
  // yet (carryover from Session 16's regen scope), so we read them via a
  // structural cast.
  const queueFiltered = useMemo(() => {
    if (!queueParam) return ncs;
    switch (queueParam) {
      case "mgmt_ack":
        // NC-8 — status is event-derived; an NC reads "Awaiting Mgt
        // Acknowledgement" exactly when all work gates are met and only the
        // manager's sign-off remains. Match that state directly so this queue
        // agrees with the Dashboard tile and each NC's badge.
        return ncs.filter((nc) => nc.status === "Awaiting Mgt Acknowledgement");
      case "needs_disposition":
        // Session 24 — mirror the Dashboard "Awaiting disposition" tile.
        // Major / Critical NCs that are open and don't yet have a disposition.
        // Note: no originator exclusion — server enforces its own segregation
        // on the Use-As-Is transition; for other disposition choices the
        // originator (if Supervisor+) is allowed to be the decider.
        return ncs.filter((nc) => {
          const ext = nc as unknown as { disposition?: string | null };
          return (nc.severity === "Major" || nc.severity === "Critical") &&
                 nc.status !== "Closed" &&
                 !((ext.disposition ?? "").trim());
        });
      default:
        return ncs;
    }
  }, [ncs, queueParam]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {
      All: openOnly ? queueFiltered.filter((nc) => nc.status !== "Closed").length : queueFiltered.length,
    };
    for (const nc of queueFiltered) {
      map[nc.status] = (map[nc.status] ?? 0) + 1;
    }
    return map;
  }, [queueFiltered, openOnly]);

  const filtered = useMemo(() => {
    let list = view === "cancelled" ? cancelledNcs : queueFiltered;
    if (view === "active" && openOnly && statusFilter === "All") list = list.filter((nc) => nc.status !== "Closed");
    if (view === "active" && statusFilter !== "All") list = list.filter((nc) => nc.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (nc) =>
          nc.ncNumber.toLowerCase().includes(q) ||
          nc.title.toLowerCase().includes(q) ||
          nc.source.toLowerCase().includes(q) ||
          nc.severity.toLowerCase().includes(q)
      );
    }
    return list;
  }, [view, cancelledNcs, queueFiltered, statusFilter, search, openOnly]);

  const tableLoading = view === "cancelled" ? cancelledLoading : isLoading;

  // Quiet the linter for the unused setter — kept available for future
  // server-pushed queue switches (e.g. a real-time alert that updates the
  // current queue param mid-session).
  void setQueueParam;
  useEffect(() => { /* no-op — placeholder for future URL sync hooks */ }, [queueParam]);

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* ── Header ── */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              <TermTip term="nc">Non-Conformances</TermTip>
            </h1>
            <p className="text-muted-foreground text-sm">NC identification, root cause, CAPA, and Part 11 closure.</p>
          </div>
          <CreateNonConformanceDialog />
        </div>

        {/* ── Summary cards ── */}
        {/* Session 42 — summary cards now use the canonical Session 11 status set
            (Open, In Progress, Awaiting Mgt Acknowledgement, Under Review, Closed)
            instead of the legacy ["Open","Under Review","CAPA Required","Closed"]
            array. The old "CAPA Required" literal was no longer in NcStatusFilter
            and broke the cannaqms typecheck on Railway. */}
        {view === "active" && !isLoading && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {NC_STATUSES.filter((s): s is Exclude<NcStatusFilter, "All"> => s !== "All").map((s) => {
              const count = counts[s] ?? 0;
              const style = NC_STATUS_STYLES[s];
              return (
                <button
                  key={s}
                  onClick={() => { setOpenOnly(false); setStatusFilter(statusFilter === s ? "All" : s); }}
                  className={`rounded-lg border p-3 text-left transition-all hover:shadow-sm ${
                    statusFilter === s
                      ? style + " ring-2 ring-offset-1 ring-current"
                      : "bg-white border-border hover:border-muted-foreground/30"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {s}
                    </span>
                    <span className="text-2xl font-bold">{count}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {view === "active" && !isLoading && <NCCharts ncs={ncs} />}

        {/* ── Active queue banner (Session 18) ── */}
        {queueParam && NC_QUEUE_LABELS[queueParam] && (
          <div className="flex items-center gap-3 rounded-md border border-rose-300 bg-rose-50/50 px-3 py-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-rose-600" />
            <div className="flex-1">
              <span className="font-medium">{NC_QUEUE_LABELS[queueParam]}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                Showing {filtered.length} of {ncs.length} NCs
              </span>
            </div>
            <button
              type="button"
              onClick={clearQueueFilter}
              className="text-xs text-rose-700 hover:underline"
            >
              Clear filter ×
            </button>
          </div>
        )}

        {/* ── Active / Cancelled view toggle (Session 52) ── */}
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
              {NC_STATUSES.map((s) => (
                <Button
                  key={s}
                  variant={statusFilter === s ? "default" : "outline"}
                  size="sm"
                  className="h-8"
                  onClick={() => { setOpenOnly(false); setStatusFilter(s); }}
                >
                  {s}
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
              Cancelled NCs are retained for compliance (never deleted) and can be re-opened by an Admin.
            </p>
          )}
          <div className="relative flex-1 max-w-xs sm:ml-auto">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search NC number, title, source…"
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
                <TableHead className="w-[110px]">NC Number</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="w-[90px]">Severity</TableHead>
                <TableHead className="w-[130px]">Status</TableHead>
                {multiSite && <TableHead className="w-[130px]">Site</TableHead>}
                <TableHead className="w-[120px]">Source</TableHead>
                <TableHead className="w-[90px]">Opened</TableHead>
                <TableHead className="w-[80px] text-right">Days Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tableLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: multiSite ? 8 : 7 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={multiSite ? 8 : 7}
                    className="text-center h-28 text-muted-foreground"
                  >
                    <AlertTriangle className="mx-auto h-7 w-7 mb-2 opacity-30" />
                    <p className="text-sm">{view === "cancelled" ? "No cancelled non-conformances." : "No non-conformances match your filters."}</p>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((nc) => {
                  // Session 97 (#6) — row accent = the NC's urgency (open severity);
                  // closed rows stay calm (neutral, no line).
                  const rowTone = nc.status === "Closed" ? "neutral" : toneNcSeverity(nc.severity);
                  const daysOpen =
                    nc.status === "Closed" && nc.closedAt
                      ? differenceInCalendarDays(
                          new Date(nc.closedAt),
                          new Date(nc.createdAt)
                        )
                      : differenceInCalendarDays(new Date(), new Date(nc.createdAt));
                  const isOverdueSeverity =
                    nc.status !== "Closed" &&
                    ((nc.severity === "Critical" && daysOpen > 3) ||
                      (nc.severity === "Major" && daysOpen > 14) ||
                      (nc.severity === "Minor" && daysOpen > 30));

                  return (
                    <TableRow key={nc.id} className={`hover:bg-muted/20 ${accentClass(rowTone)}`}>
                      <TableCell className="font-mono font-medium">
                        <Link
                          href={`/non-conformances/${nc.id}`}
                          className="hover:underline text-primary"
                        >
                          {nc.ncNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/non-conformances/${nc.id}`}
                          className="hover:underline text-sm"
                        >
                          {nc.title}
                        </Link>
                        {nc.batchId && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            · Batch #{nc.batchId}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={toneNcSeverity(nc.severity)} label={nc.severity} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={toneNcStatus(nc.status)} label={nc.status} />
                      </TableCell>
                      {multiSite && (
                        <TableCell>
                          <SiteName facilityId={(nc as { facilityId?: number | null }).facilityId} />
                        </TableCell>
                      )}
                      <TableCell className="text-sm text-muted-foreground">
                        {nc.source}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format(new Date(nc.createdAt), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={`text-sm font-medium ${
                            isOverdueSeverity
                              ? "text-red-600"
                              : nc.status === "Closed"
                                ? "text-muted-foreground"
                                : daysOpen > 7
                                  ? "text-orange-600"
                                  : "text-foreground"
                          }`}
                        >
                          {daysOpen}d
                          {nc.status === "Closed" && (
                            <span className="ml-1 text-xs text-muted-foreground font-normal">
                              (closed)
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

        {/* ── Severity legend ── */}
        {!isLoading && filtered.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Days Open thresholds: Critical &gt; 3 days · Major &gt; 14 days · Minor &gt; 30 days (highlighted in red)
          </p>
        )}
      </div>
    </AppLayout>
  );
}
