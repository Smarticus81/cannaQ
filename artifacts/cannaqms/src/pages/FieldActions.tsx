import { useState, useMemo } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useListFieldActions, useGetCurrentUser } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { format, differenceInCalendarDays } from "date-fns";
import { CreateFieldActionDialog } from "@/components/dialogs/CreateFieldActionDialog";
import { FieldActionsCharts } from "@/components/field-action/FieldActionsCharts";
import { ShieldAlert, AlertTriangle, CheckCircle2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { TermTip } from "@/components/ui/TermTip";
import { StatusBadge } from "@/components/ui/status-badge";
import { accentClass, toneFieldActionType, toneFieldActionStatus } from "@/lib/status";

// ── Helpers ──────────────────────────────────────────────────────────────────

// CRA notification deadline: recalls = immediate (1d), withdrawals = 3d, others = 30d
function deadlineDays(actionType: string): number {
  const t = actionType.toLowerCase();
  if (t.includes("recall")) return 1;
  if (t.includes("withdrawal")) return 3;
  return 30;
}

// ── Component ─────────────────────────────────────────────────────────────────

const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);

export default function FieldActions() {
  const { data: fieldActions = [], isLoading } = useListFieldActions();
  const { data: currentUser } = useGetCurrentUser();
  const isApprover = APPROVER_ROLES.has(currentUser?.role ?? "");
  const pendingRequests = useMemo(
    () => fieldActions.filter((fa) => fa.status === "Requested").length,
    [fieldActions],
  );
  const [tab, setTab] = useState<"All" | "Active" | "Closed">(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("status") === "open") return "Active";
    return "All";
  });
  const [search, setSearch] = useState("");

  const counts = useMemo(() => ({
    all: fieldActions.length,
    active: fieldActions.filter((fa) => fa.status !== "Closed").length,
    responseActive: fieldActions.filter((fa) => fa.status === "Response Active").length,
    closed: fieldActions.filter((fa) => fa.status === "Closed").length,
  }), [fieldActions]);

  const urgentCount = useMemo(
    () =>
      fieldActions.filter((fa) => {
        if (fa.status === "Closed") return false;
        const days = differenceInCalendarDays(new Date(), new Date(fa.createdAt));
        return days > deadlineDays(fa.actionType);
      }).length,
    [fieldActions],
  );

  const filtered = useMemo(() => {
    let rows = fieldActions;
    if (tab === "Active") rows = rows.filter((fa) => fa.status !== "Closed");
    if (tab === "Closed") rows = rows.filter((fa) => fa.status === "Closed");
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (fa) =>
          fa.faNumber.toLowerCase().includes(q) ||
          fa.title.toLowerCase().includes(q) ||
          fa.actionType.toLowerCase().includes(q) ||
          (fa.affectedBatches ?? "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [fieldActions, tab, search]);

  const tabs = [
    { label: "All" as const, count: counts.all },
    { label: "Active" as const, count: counts.active },
    { label: "Closed" as const, count: counts.closed },
  ];

  return (
    <AppLayout>
      <div className="space-y-6 max-w-6xl mx-auto">

        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              <TermTip term="fieldAction">Field Actions</TermTip>
            </h1>
            <p className="text-muted-foreground text-sm">
              Recalls, stop sales, market withdrawals, and safety alerts — Michigan CRA R 420.209.
            </p>
          </div>
          {/* Session 76 — Operators can't open an FA directly; their button
              submits a request for Quality/Manager approval instead. */}
          <CreateFieldActionDialog mode={isApprover ? "create" : "request"} />
        </div>

        {/* Session 76 — pending-request nudge for approvers. */}
        {isApprover && pendingRequests > 0 && (
          <div className="flex items-start gap-3 rounded-lg border border-violet-300 bg-violet-50 px-4 py-3 text-violet-900">
            <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5 text-violet-600" />
            <p className="text-sm">
              <span className="font-semibold">
                {pendingRequests === 1
                  ? "1 Field Action request is awaiting your approval"
                  : `${pendingRequests} Field Action requests are awaiting your approval`}
              </span>
              {" — open a Requested item below to approve or reject it."}
            </p>
          </div>
        )}

        {/* ── CRA urgency banner ── */}
        {urgentCount > 0 && (
          <div className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">
            <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5 text-red-600" />
            <div>
              <p className="font-semibold text-sm">
                {urgentCount === 1
                  ? "1 field action has exceeded its CRA notification deadline"
                  : `${urgentCount} field actions have exceeded their CRA notification deadlines`}
              </p>
              <p className="text-xs mt-0.5">
                Recalls require immediate CRA notification; market withdrawals within 3 business
                days under R 420.209. Document all regulatory communications in Response Actions.
              </p>
            </div>
          </div>
        )}

        {/* ── Summary cards ── */}
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border bg-card p-4 text-center">
            <p className="text-xs font-semibold tracking-widest text-muted-foreground">ACTIVE</p>
            <p className={`text-3xl font-bold mt-1 ${counts.active > 0 ? "text-orange-600" : ""}`}>
              {counts.active}
            </p>
          </div>
          <div className="rounded-lg border bg-card p-4 text-center">
            <p className="text-xs font-semibold tracking-widest text-muted-foreground">RESPONSE ACTIVE</p>
            <p className={`text-3xl font-bold mt-1 ${counts.responseActive > 0 ? "text-red-600" : ""}`}>
              {counts.responseActive}
            </p>
          </div>
          <div className="rounded-lg border bg-card p-4 text-center">
            <p className="text-xs font-semibold tracking-widest text-muted-foreground">CLOSED</p>
            <p className="text-3xl font-bold mt-1 text-green-600">{counts.closed}</p>
          </div>
        </div>

        {/* ── Overview charts ── */}
        {!isLoading && fieldActions.length > 0 && (
          <FieldActionsCharts fieldActions={fieldActions} />
        )}

        {/* ── Filters + search ── */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1 border rounded-lg p-1 bg-muted/30">
            {tabs.map(({ label, count }) => (
              <button
                key={label}
                onClick={() => setTab(label)}
                className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                  tab === label
                    ? "bg-background shadow text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
                <span
                  className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs ${
                    tab === label
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {count}
                </span>
              </button>
            ))}
          </div>
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search FA#, title, batch..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm"
            />
          </div>
        </div>

        {/* ── Table ── */}
        <div className="border rounded-lg overflow-hidden bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">FA #</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Type</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Title / Batches</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Opened</th>
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Days Open</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 6 }).map((_, j) => (
                        <td key={j} className="px-4 py-3">
                          <Skeleton className="h-4 w-full" />
                        </td>
                      ))}
                    </tr>
                  ))
                : filtered.length === 0
                  ? (
                      <tr>
                        <td colSpan={6} className="text-center py-16 text-muted-foreground">
                          {search
                            ? "No field actions match your search."
                            : "No field actions found."}
                        </td>
                      </tr>
                    )
                  : filtered.map((fa) => {
                      const isClosed = fa.status === "Closed";
                      // Session 99 (#6) — row accent = field-action urgency by type
                      // (recall→urgent; stop-sale/withdrawal/safety→caution); closed = calm.
                      const rowTone = isClosed ? "neutral" : toneFieldActionType(fa.actionType);
                      const daysOpen = isClosed && fa.closedAt
                        ? differenceInCalendarDays(
                            new Date(fa.closedAt),
                            new Date(fa.createdAt),
                          )
                        : differenceInCalendarDays(new Date(), new Date(fa.createdAt));
                      const limit = deadlineDays(fa.actionType);
                      const isPast = !isClosed && daysOpen > limit;
                      const isNear = !isClosed && !isPast && daysOpen >= limit - 1;

                      return (
                        <tr key={fa.id} className={`hover:bg-muted/20 transition-colors ${accentClass(rowTone)}`}>
                          <td className="px-4 py-3 font-mono font-semibold">
                            <Link
                              href={`/field-actions/${fa.id}`}
                              className="text-primary hover:underline"
                            >
                              {fa.faNumber}
                            </Link>
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge tone={toneFieldActionType(fa.actionType)} label={fa.actionType} />
                          </td>
                          <td className="px-4 py-3 max-w-sm">
                            <Link
                              href={`/field-actions/${fa.id}`}
                              className="hover:underline font-medium leading-snug block"
                            >
                              {fa.title}
                            </Link>
                            {fa.affectedBatches && (
                              <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                                {fa.affectedBatches}
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-3"><StatusBadge tone={toneFieldActionStatus(fa.status)} label={fa.status} /></td>
                          <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                            {format(new Date(fa.createdAt), "MMM d, yyyy")}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            {isPast ? (
                              <span className="inline-flex items-center justify-end gap-1 text-red-600 font-semibold">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                {daysOpen}d
                                <span className="text-xs font-normal text-red-500 ml-0.5">
                                  past {limit}d limit
                                </span>
                              </span>
                            ) : isNear ? (
                              <span className="text-orange-600 font-semibold">
                                {daysOpen}d
                                <span className="text-xs font-normal text-orange-500 ml-1">
                                  / {limit}d
                                </span>
                              </span>
                            ) : isClosed ? (
                              <span className="inline-flex items-center justify-end gap-1 text-muted-foreground">
                                <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                                {daysOpen}d
                                <span className="text-xs ml-0.5">(closed)</span>
                              </span>
                            ) : (
                              <span className="text-muted-foreground">
                                {daysOpen}d
                                <span className="text-xs ml-1 text-muted-foreground/60">
                                  / {limit}d
                                </span>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground">
          CRA deadlines (from initiation): Recalls — immediate · Market Withdrawals — 3 days ·
          Other — 30 days (R 420.209)
        </p>
      </div>
    </AppLayout>
  );
}
