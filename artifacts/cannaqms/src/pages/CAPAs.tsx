import { useState, useEffect, useMemo } from "react";
import { Link } from "wouter";
import { TermTip } from "@/components/ui/TermTip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { accentClass, toneCapaStatus } from "@/lib/status";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertTriangle, Clock, Search, ShieldCheck,
  AlertCircle, ClipboardList,
} from "lucide-react";
import { format, isPast, parseISO } from "date-fns";
// Session 28 — swap raw fetch() for the Session-20/27.1 typed hooks. The
// generated `Capa` shape covers every field the page reads (status, stage,
// gate1*, gate2*, effectivenessOwnerName, etc.).
import {
  useGetCurrentUser,
  useListCapas,
  getListCapasQueryKey,
  type Capa,
} from "@workspace/api-client-react";
// Session 76 — CreateCAPADialog moved to its own file so the global
// "New Quality Event" front door can reuse it. Same component, imported here.
import { CreateCAPADialog } from "@/components/dialogs/CreateCAPADialog";
import { CAPAsCharts } from "@/components/capas/CAPAsCharts";
import { useQueryClient, useQuery } from "@tanstack/react-query";

// ── Types ─────────────────────────────────────────────────────────────────────

// The server-side `/api/capas` list response actually enriches each row with
// action-item aggregates (matches the CapaDashboardItem shape rather than the
// bare `Capa` the spec declares). Layer those two fields on top of the orval
// type until the spec is corrected to return CapaDashboardItem[].
type CapaListRow = Capa & {
  openActionItems?: number;
  actionItemCount?: number;
};

// Queues understood by the ?queue= URL param (Session 18).
const QUEUE_LABELS: Record<string, string> = {
  mine: "My CAPAs (originator)",
  ec_owner: "EC Owner duties",
  awaiting_approval: "Awaiting my approval",
  action_assignee: "Action items assigned to me",
};

const BASE = import.meta.env.BASE_URL ?? "/";

const STATUSES = ["All", "Open", "Root Cause Analysis", "Action Planning", "Implementation", "Effectiveness Check", "Closed"] as const;
type StatusFilter = typeof STATUSES[number];

function TypeBadge({ type }: { type: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
      type === "Corrective"
        ? "bg-orange-50 text-orange-700 border-orange-200"
        : "bg-teal-50 text-teal-700 border-teal-200"
    }`}>
      {type}
    </span>
  );
}

// ── Create CAPA dialog ────────────────────────────────────────────────────────
// Session 76 — moved to components/dialogs/CreateCAPADialog.tsx (imported above).


// ── Main page ─────────────────────────────────────────────────────────────────

export default function CAPAs() {
  // Session 28 — useListCapas replaces the previous useState+useEffect+fetch
  // pattern. The list response is enriched server-side with action-item
  // counts; the typed return shape gets widened to CapaListRow at the call
  // site for the two display fields that aren't in the bare orval `Capa`.
  const { data: capasData = [], isLoading: loading } = useListCapas();
  const capas = capasData as CapaListRow[];
  const queryClient = useQueryClient();
  const invalidateCapas = () =>
    queryClient.invalidateQueries({ queryKey: getListCapasQueryKey() });
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [search, setSearch] = useState("");
  // Session 100 — tiles deep-link with ?status=open to show only not-closed
  // CAPAs. Cleared the moment the user clicks any status pill.
  const [openOnly, setOpenOnly] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("status") === "open";
  });
  // Session 52.1 — Active / Cancelled view. The active list already excludes
  // cancelled server-side; the Cancelled view fetches ?cancelled=true (off-spec
  // param, so raw fetch rather than an orval hook).
  const [view, setView] = useState<"active" | "cancelled">("active");
  const { data: cancelledData = [], isLoading: cancelledLoading } = useQuery({
    queryKey: ["capas", "cancelled"],
    queryFn: async () => {
      const r = await fetch(`${BASE}api/capas?cancelled=true`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load cancelled CAPAs");
      return r.json() as Promise<CapaListRow[]>;
    },
    enabled: view === "cancelled",
  });

  // ── Session 18 — ?queue= deep-link filter ──────────────────────────────────
  // The Dashboard's My Queue tiles link here with ?queue=mine/ec_owner/
  // awaiting_approval/action_assignee. We parse on mount and provide a clear
  // button to remove the filter without losing other state.
  const [queueParam, setQueueParam] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const q = new URLSearchParams(window.location.search).get("queue");
    return q && QUEUE_LABELS[q] ? q : null;
  });
  const { data: currentUser } = useGetCurrentUser();
  const meName = currentUser?.fullName ?? "";

  // Action-item assignee set: which CAPAs contain action items assigned to the
  // current user. Loaded lazily — needed by both the action_assignee queue
  // (which uses it as the inclusion set) and the awaiting_approval queue
  // (which uses it as an exclusion set per Part 11 segregation; Session 23).
  const needsActionAssignees = queueParam === "action_assignee" || queueParam === "awaiting_approval";
  const [actionAssigneeCapaIds, setActionAssigneeCapaIds] = useState<Set<number> | null>(null);
  useEffect(() => {
    if (!needsActionAssignees || !meName) return;
    let cancelled = false;
    (async () => {
      try {
        const url = `${BASE}api/capa-action-items?assignedToName=${encodeURIComponent(meName)}&open=1`;
        const r = await fetch(url, { credentials: "include" });
        if (!cancelled && r.ok) {
          const items = (await r.json()) as Array<{ capaId: number }>;
          setActionAssigneeCapaIds(new Set(items.map((i) => i.capaId)));
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [needsActionAssignees, meName]);

  const clearQueueFilter = () => {
    setQueueParam(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("queue");
      window.history.replaceState({}, "", url.toString());
    }
  };

  // (Session 28) `fetchCapas` and its useEffect have been replaced by the
  // useListCapas() hook above. CAPA cache invalidation goes through
  // invalidateCapas() so the CreateCAPADialog can refresh the list after
  // adding a new row.

  // Apply the ?queue= predicate first, then status/search filters layer on.
  const queueFiltered = useMemo(() => {
    if (!queueParam || !meName) return capas;
    const isMe = (n?: string | null) => !!n && n === meName;
    switch (queueParam) {
      case "mine":
        return capas.filter((c) =>
          (isMe(c.originatorName) || isMe(c.openedByName)) &&
          c.stage !== "Closed" && c.status !== "Closed",
        );
      case "ec_owner":
        return capas.filter((c) =>
          isMe(c.effectivenessOwnerName) &&
          ["Planning", "Action Execution", "EC Execution"].includes(c.stage ?? "") &&
          c.status !== "Closed",
        );
      case "awaiting_approval":
        // Session 23 — also exclude CAPAs where the current user is an action
        // item owner. Mirrors the server-side Part 11 segregation enforced at
        // /gate1-approve / /gate2-approve (capas.ts lines 287-289, 718-720)
        // so the deep-link list view stays consistent with the Dashboard tile
        // count. Treat a null assignee set (still loading) as "no exclusion
        // yet" so the list doesn't flash empty before the fetch lands.
        return capas.filter((c) => {
          if (isMe(c.originatorName) || isMe(c.openedByName) || isMe(c.effectivenessOwnerName)) return false;
          if (actionAssigneeCapaIds?.has(c.id)) return false;
          const inGate1 = c.stage === "Planning" && !c.gate1ApprovedAt;
          const inGate2 = c.stage === "EC Execution" && !c.gate2Outcome;
          if (!inGate1 && !inGate2) return false;
          if (inGate1 && (isMe(c.gate1Approver1Name) || isMe(c.gate1Approver2Name))) return false;
          return true;
        });
      case "action_assignee":
        if (!actionAssigneeCapaIds) return [];
        return capas.filter((c) => actionAssigneeCapaIds.has(c.id));
      default:
        return capas;
    }
  }, [capas, queueParam, meName, actionAssigneeCapaIds]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {
      All: openOnly ? queueFiltered.filter((c) => c.status !== "Closed").length : queueFiltered.length,
    };
    for (const c of queueFiltered) m[c.status] = (m[c.status] ?? 0) + 1;
    return m;
  }, [queueFiltered, openOnly]);

  const filtered = useMemo(() => {
    let list = queueFiltered;
    if (openOnly && statusFilter === "All") list = list.filter((c) => c.status !== "Closed");
    if (statusFilter !== "All") list = list.filter((c) => c.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((c) => c.capaNumber.toLowerCase().includes(q) || c.title.toLowerCase().includes(q) || c.type.toLowerCase().includes(q));
    }
    return list;
  }, [queueFiltered, statusFilter, search, openOnly]);

  // Summary KPIs
  const open = capas.filter((c) => c.status !== "Closed" && c.status !== "Cancelled");
  const corrective = capas.filter((c) => c.type === "Corrective" && c.status !== "Closed");
  const preventive = capas.filter((c) => c.type === "Preventive" && c.status !== "Closed");
  const effectivenessOverdue = capas.filter((c) =>
    c.status !== "Closed" && c.effectivenessCheckDue && isPast(parseISO(c.effectivenessCheckDue))
  );

  return (
    <>
      <div className="space-y-6 max-w-6xl mx-auto pb-12">
        {/* Header */}
        <div className="cq-page-heading flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              <TermTip term="capa">CAPA</TermTip>
            </h1>
            <p className="text-muted-foreground text-sm">Corrective and Preventive Actions — ISO 13485 §8.5.2/8.5.3 · 21 CFR Part 11</p>
          </div>
          <CreateCAPADialog onCreated={invalidateCapas} />
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: "Open CAPAs", value: open.length, icon: <AlertCircle className="h-5 w-5 text-red-500" />, accent: "border-red-100" },
            { label: "Corrective", value: corrective.length, icon: <AlertTriangle className="h-5 w-5 text-orange-500" />, accent: "border-orange-100" },
            { label: "Preventive", value: preventive.length, icon: <ShieldCheck className="h-5 w-5 text-teal-500" />, accent: "border-teal-100" },
            { label: "Effectiveness Overdue", value: effectivenessOverdue.length, icon: <Clock className="h-5 w-5 text-amber-500" />, accent: effectivenessOverdue.length > 0 ? "border-amber-300 bg-amber-50" : "border-amber-100" },
          ].map((k) => (
            <div key={k.label} className={`rounded-lg border ${k.accent} bg-card p-4`}>
              <div className="flex items-center gap-2 mb-1">{k.icon}<span className="text-xs text-muted-foreground font-medium">{k.label}</span></div>
              <div className="text-3xl font-bold">{loading ? <Skeleton className="h-8 w-12" /> : k.value}</div>
            </div>
          ))}
        </div>

        {!loading && <CAPAsCharts capas={capas} />}

        {/* Active queue banner (Session 18 deep-link from Dashboard) */}
        {queueParam && QUEUE_LABELS[queueParam] && (
          <div className="flex items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
            <ClipboardList className="h-4 w-4 text-primary" />
            <div className="flex-1">
              <span className="font-medium">{QUEUE_LABELS[queueParam]}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                Showing {filtered.length} of {capas.length} CAPAs
              </span>
            </div>
            <button
              type="button"
              onClick={clearQueueFilter}
              className="text-xs text-primary hover:underline"
            >
              Clear filter ×
            </button>
          </div>
        )}

        {/* Filter tabs */}
        <div className="flex flex-wrap gap-2">
          {STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => { setOpenOnly(false); setStatusFilter(s); }}
              className={`px-3 py-1.5 text-sm rounded-full border font-medium transition-colors ${
                statusFilter === s
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card border-border text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {s} {counts[s] !== undefined ? `(${counts[s]})` : "(0)"}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search CAPA number, title…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        {/* Table */}
        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">CAPA #</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">Type</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">Title</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">Status</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">Action Items</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">Effectiveness Due</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">Opened</th>
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 3 }).map((_, i) => (
                    <tr key={i} className="border-b"><td colSpan={7} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td></tr>
                  ))
                : filtered.length === 0
                  ? (
                    <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground text-sm">No CAPAs match the current filter.</td></tr>
                  )
                  : filtered.map((c) => {
                    const overdue = c.effectivenessCheckDue && c.status !== "Closed" && isPast(parseISO(c.effectivenessCheckDue));
                    // Session 99 (#6) — row accent = CAPA urgency (overdue actions
                    // push it to urgent); closed reads calm/neutral.
                    const rowTone = c.status === "Closed" ? "neutral" : toneCapaStatus(c.status, !!overdue);
                    return (
                      <tr key={c.id} className={`border-b hover:bg-muted/30 transition-colors ${accentClass(rowTone)}`}>
                        <td className="px-4 py-3">
                          <Link href={`/capas/${c.id}`} className="font-mono text-primary hover:underline font-medium">{c.capaNumber}</Link>
                        </td>
                        <td className="px-4 py-3"><TypeBadge type={c.type} /></td>
                        <td className="px-4 py-3">
                          <Link href={`/capas/${c.id}`} className="hover:text-primary transition-colors">
                            <span className="font-medium text-foreground">{c.title}</span>
                          </Link>
                        </td>
                        <td className="px-4 py-3"><StatusBadge tone={toneCapaStatus(c.status, !!overdue)} label={c.status} /></td>
                        <td className="px-4 py-3">
                          <span className="text-xs">
                            {(c.openActionItems ?? 0) > 0
                              ? <span className="text-amber-600 font-semibold">{c.openActionItems} open</span>
                              : <span className="text-green-600">✓ All done</span>}
                            <span className="text-muted-foreground"> / {c.actionItemCount} total</span>
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {c.effectivenessCheckDue
                            ? <span className={overdue ? "text-red-600 font-semibold" : "text-foreground"}>
                                {overdue && "⚠ "}{format(parseISO(c.effectivenessCheckDue), "MMM d, yyyy")}
                              </span>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{format(new Date(c.createdAt), "MMM d, yyyy")}</td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
