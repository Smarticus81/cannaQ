import { useState, useMemo, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useListTraining, useGetTrainingStats, useGetCurrentUser } from "@workspace/api-client-react";
import type { TrainingRecord } from "@workspace/api-client-react";
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
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "wouter";
import { format, parseISO } from "date-fns";
import { CreateTrainingDialog } from "@/components/dialogs/CreateTrainingDialog";
import { AssignTrainingDialog } from "@/components/training/AssignTrainingDialog";
import { RecordGroupTrainingDialog } from "@/components/training/RecordGroupTrainingDialog";
import {
  Search,
  CheckCircle2,
  Clock,
  AlertTriangle,
  XCircle,
  Ban,
  GraduationCap,
} from "lucide-react";

// "Cancelled" (2026-08-27) — an assignment voided because the approval that issued
// it was rescinded. The record is kept, never deleted, so the trail shows it existed
// and why it stopped; it needs a tab of its own or the counts stop adding up.
const STATUSES = ["All", "Assigned", "In Progress", "Completed", "Overdue", "Waived", "Cancelled"] as const;
type StatusFilter = (typeof STATUSES)[number];

const STATUS_STYLES: Record<string, string> = {
  Assigned: "bg-blue-50 text-blue-700 border-blue-200",
  "In Progress": "bg-yellow-50 text-yellow-700 border-yellow-200",
  Completed: "bg-green-50 text-green-700 border-green-200",
  Overdue: "bg-red-50 text-red-700 border-red-200",
  Waived: "bg-slate-100 text-slate-600 border-slate-300",
  Cancelled: "bg-slate-100 text-slate-500 border-slate-300 line-through",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  Assigned: <Clock className="h-3 w-3" />,
  "In Progress": <Clock className="h-3 w-3" />,
  Completed: <CheckCircle2 className="h-3 w-3" />,
  Overdue: <AlertTriangle className="h-3 w-3" />,
  Waived: <XCircle className="h-3 w-3" />,
  Cancelled: <Ban className="h-3 w-3" />,
};

function MyTrainingInbox() {
  const [items, setItems] = useState<TrainingRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/training/my")
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
        return r.json();
      })
      .then((data) => { if (!cancelled) setItems(data); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : "Failed"); });
    return () => { cancelled = true; };
  }, []);

  if (err) return null; // not signed in or no link — silently hide
  if (!items || items.length === 0) return null;

  const pending = items.filter((r) => r.status !== "Completed" && r.status !== "Waived" && r.status !== "Cancelled");
  if (pending.length === 0) return null;

  return (
    <Card className="border-blue-200 bg-blue-50/40">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-blue-700" />
            <h2 className="text-sm font-semibold text-blue-900">
              My Pending Training ({pending.length})
            </h2>
          </div>
        </div>
        <div className="space-y-2">
          {pending.slice(0, 6).map((r) => {
            const isOverdue = r.status === "Overdue";
            return (
              <Link key={r.id} href={`/training/${r.id}`}>
                <div className="flex items-center justify-between gap-3 p-2 rounded-md bg-white border hover:border-blue-400 cursor-pointer">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{r.topic}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-mono">{r.recordNumber}</span>
                      {r.dueDate && (
                        <>
                          {" · Due "}
                          <span className={isOverdue ? "text-red-700 font-semibold" : ""}>
                            {format(parseISO(r.dueDate), "MMM d, yyyy")}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS_STYLES[r.status] ?? "bg-slate-100 text-slate-600"}`}
                  >
                    {r.status}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Training() {
  const { data: records = [], isLoading } = useListTraining();
  const { data: stats } = useGetTrainingStats();
  // Batch 5 — honor a ?status= deep link (dashboard tiles pass e.g.
  // ?status=Overdue / ?status=Under%20Review) so the tile lands here
  // pre-filtered. Unknown/absent param falls back to the "All" view.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    if (typeof window === "undefined") return "All";
    const q = new URLSearchParams(window.location.search).get("status");
    return q && (STATUSES as readonly string[]).includes(q) ? (q as StatusFilter) : "All";
  });
  const [search, setSearch] = useState("");
  const { data: currentUser } = useGetCurrentUser();
  // Batch 5 — personal deep-link from the dashboard "My Training" tile:
  // /training?scope=mine&due=soon. scopeMine → only my own records (by user id);
  // dueSoon → overdue OR due within 30 days. Both are dismissible (active pill below).
  const [scopeMine, setScopeMine] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("scope") === "mine";
  });
  const [dueSoon, setDueSoon] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("due") === "soon";
  });

  const counts = useMemo(() => {
    const map: Record<string, number> = { All: records.length };
    for (const r of records) {
      map[r.status] = (map[r.status] ?? 0) + 1;
    }
    return map;
  }, [records]);

  const filtered = useMemo(() => {
    let list = records;
    if (scopeMine) {
      const uid = currentUser?.id;
      list = list.filter((r) => r.assignedToUserId != null && r.assignedToUserId === uid);
    }
    if (dueSoon) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const soonStr = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      list = list.filter(
        (r) =>
          r.status === "Overdue" ||
          (r.status !== "Completed" &&
            r.status !== "Waived" &&
            r.status !== "Cancelled" &&
            !!r.dueDate &&
            r.dueDate >= todayStr &&
            r.dueDate <= soonStr),
      );
    }
    if (statusFilter !== "All") list = list.filter((r) => r.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (r) =>
          r.employeeName.toLowerCase().includes(q) ||
          r.topic.toLowerCase().includes(q) ||
          r.recordNumber.toLowerCase().includes(q) ||
          (r.documentReference ?? "").toLowerCase().includes(q) ||
          (r.department ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [records, statusFilter, search, scopeMine, dueSoon, currentUser?.id]);

  // Cancelled assignments are out of the denominator — nobody owes them, so counting
  // them as "not completed" would report a lower rate every time an approval is rescinded.
  const completionRate = (() => {
    if (!stats) return 0;
    const active = stats.total - (stats.cancelled ?? 0);
    return active > 0 ? Math.round((stats.completed / active) * 100) : 0;
  })();

  // 2026-08-27 — ON-TIME TRAINING. The measure that gives the effective date teeth:
  // a document goes into force on its declared date whether or not everyone trained,
  // and this is what records who was late. Null, not 0%, when no dated training has
  // been completed yet — a site with nothing measured has no score, not a bad one.
  const onTimeRate = (() => {
    const denom = stats?.completedWithDeadline ?? 0;
    if (!denom) return null;
    return Math.round(((stats?.onTimeCompleted ?? 0) / denom) * 100);
  })();

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Training Records</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Employee training assignments and completion tracking
            </p>
          </div>
          <div className="flex items-center gap-2">
            <AssignTrainingDialog />
            <RecordGroupTrainingDialog />
            <CreateTrainingDialog />
          </div>
        </div>

        <MyTrainingInbox />

        {/* Stats bar */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-bold tabular-nums">{stats?.total ?? 0}</p>
              <p className="text-xs text-muted-foreground mt-1">Total Records</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-bold tabular-nums text-green-700">
                {stats?.completed ?? 0}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Completed</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className={`text-2xl font-bold tabular-nums ${(stats?.overdue ?? 0) > 0 ? "text-red-700" : ""}`}>
                {stats?.overdue ?? 0}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Overdue</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className={`text-2xl font-bold tabular-nums ${onTimeRate === null ? "text-muted-foreground" : onTimeRate >= 90 ? "text-green-700" : onTimeRate >= 75 ? "text-yellow-700" : "text-red-700"}`}>
                {onTimeRate === null ? "—" : `${onTimeRate}%`}
              </p>
              <p className="text-xs text-muted-foreground mt-1">On-Time Training</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {onTimeRate === null
                  ? "no dated training completed yet"
                  : `${stats?.onTimeCompleted ?? 0} of ${stats?.completedWithDeadline ?? 0} by the due date`}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-bold tabular-nums text-primary">
                {completionRate}%
              </p>
              <p className="text-xs text-muted-foreground mt-1">Completion Rate</p>
            </CardContent>
          </Card>
        </div>

        {(scopeMine || dueSoon) && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">Showing:</span>
            {scopeMine && (
              <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                My training
              </span>
            )}
            {dueSoon && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                Overdue or due within 30 days
              </span>
            )}
            <button
              onClick={() => { setScopeMine(false); setDueSoon(false); }}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              Clear
            </button>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex gap-1 flex-wrap">
            {STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                  statusFilter === s
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {s}
                {counts[s] !== undefined && (
                  <span className="ml-1.5 text-xs opacity-75">({counts[s]})</span>
                )}
              </button>
            ))}
          </div>
          <div className="relative sm:ml-auto">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search employee, topic…"
              className="pl-8 w-full sm:w-64"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Table */}
        <div className="rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Record #</TableHead>
                <TableHead>Employee</TableHead>
                <TableHead>Topic</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Due Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Score</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-12 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <GraduationCap className="h-8 w-8" />
                      <p className="text-sm font-medium">No training records found</p>
                      {search || statusFilter !== "All" ? (
                        <p className="text-xs">Try adjusting your filters</p>
                      ) : (
                        <p className="text-xs">Create a training record to get started</p>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((r) => (
                  <TableRow key={r.id} className="cursor-pointer hover:bg-muted/40">
                    <TableCell>
                      <Link href={`/training/${r.id}`}>
                        <span className="font-mono text-sm font-semibold text-primary hover:underline">
                          {r.recordNumber}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/training/${r.id}`}>
                        <div>
                          <p className="text-sm font-medium">{r.employeeName}</p>
                          {r.department && (
                            <p className="text-xs text-muted-foreground">{r.department}</p>
                          )}
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/training/${r.id}`}>
                        <div>
                          <p className="text-sm line-clamp-1">{r.topic}</p>
                          {r.documentReference && (
                            <p className="text-xs text-muted-foreground font-mono">
                              {r.documentReference}
                            </p>
                          )}
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground">{r.trainingType}</span>
                    </TableCell>
                    <TableCell>
                      <span className={`text-sm ${r.status === "Overdue" ? "text-red-700 font-semibold" : "text-muted-foreground"}`}>
                        {r.dueDate ? format(parseISO(r.dueDate), "MMM d, yyyy") : "—"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_STYLES[r.status] ?? "bg-slate-100 text-slate-600"}`}
                      >
                        {STATUS_ICONS[r.status]}
                        {r.status}
                      </span>
                    </TableCell>
                    <TableCell>
                      {r.score !== null && r.score !== undefined ? (
                        <span
                          className={`text-sm font-semibold ${
                            r.passingScore && r.score >= r.passingScore
                              ? "text-green-700"
                              : r.passingScore
                                ? "text-red-700"
                                : "text-foreground"
                          }`}
                        >
                          {r.score}%
                          {r.passingScore && (
                            <span className="text-muted-foreground font-normal">
                              /{r.passingScore}%
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </AppLayout>
  );
}
