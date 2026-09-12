import { AppLayout } from "@/components/layout/AppLayout";
import { useListSuppliers, useGetCompanyProfile } from "@workspace/api-client-react";
import { accentClass, toneRiskTier, toneReviewStatus, type StatusTone } from "@/lib/status";
import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { CreateSupplierDialog } from "@/components/dialogs/CreateSupplierDialog";
import {
  AlertTriangle, Clock, CheckCircle2, HelpCircle, FileText,
  ShieldAlert, ShieldCheck, Shield,
  ChevronsUpDown, ChevronUp, ChevronDown,
  X,
} from "lucide-react";
import { format } from "date-fns";
import { useState, useMemo } from "react";

// Queue presets understood by the ?queue= URL param (Session 26).
const SUPPLIER_QUEUE_LABELS: Record<string, string> = {
  requal_needed: "Suppliers overdue or due for re-qualification",
  license_alert: "Suppliers missing or with an expired required license/certificate",
};

// ── Review badge ──────────────────────────────────────────────────────────────

function ReviewBadge({ status, nextReviewDue, reviewDriver }: { status: string | null | undefined; nextReviewDue: string | null | undefined; reviewDriver?: string | null }) {
  // A cert-driven date is an EXPIRY, not a periodic review — say "Expires"/"Expired"
  // instead of "Due"/"Overdue" so it reads as a license/certificate date.
  const certDriven = !!reviewDriver && reviewDriver.toLowerCase().includes("certificate");
  if (!status || status === "never-qualified") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <HelpCircle className="h-3.5 w-3.5" />
        Never Qualified
      </span>
    );
  }
  if (status === "overdue") {
    const dueDate = nextReviewDue ? new Date(nextReviewDue + "T00:00:00") : null;
    const daysOverdue = dueDate ? Math.ceil((new Date().getTime() - dueDate.getTime()) / 86_400_000) : null;
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-700 border border-red-300 px-2 py-0.5 text-xs font-semibold">
        <AlertTriangle className="h-3 w-3" />
        {certDriven ? "Expired" : "Overdue"}{daysOverdue != null ? ` (${daysOverdue}d)` : ""}
      </span>
    );
  }
  if (status === "due-soon") {
    const dueFmt = nextReviewDue ? format(new Date(nextReviewDue + "T00:00:00"), "MMM d, yyyy") : "";
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 border border-amber-300 px-2 py-0.5 text-xs font-semibold">
        <Clock className="h-3 w-3" />
        {certDriven ? "Expires" : "Due"} {dueFmt}
      </span>
    );
  }
  const dueFmt = nextReviewDue ? format(new Date(nextReviewDue + "T00:00:00"), "MMM d, yyyy") : "";
  return (
    <span className="inline-flex items-center gap-1 text-xs text-green-700">
      <CheckCircle2 className="h-3.5 w-3.5" />
      {certDriven ? "Expires" : "Due"} {dueFmt}
    </span>
  );
}

// ── Risk badge ────────────────────────────────────────────────────────────────

function RiskBadge({ tier, score, scoringEnabled = true }: { tier: string | null | undefined; score: number | null | undefined; scoringEnabled?: boolean }) {
  // Session 97 (#15) — when scoring alarms are off, show the score neutrally
  // (grey, no tier word/color/icon) so it's information, not an alarm.
  if (!scoringEnabled) {
    if (score == null) return <span className="text-xs text-muted-foreground">—</span>;
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-slate-50 text-slate-600 border-slate-200">
        <Shield className="h-3 w-3 opacity-60" />
        Score {score}
      </span>
    );
  }
  if (!tier) return null;
  const styles: Record<string, string> = {
    Low:      "bg-green-50 text-green-700 border-green-200",
    Medium:   "bg-amber-50 text-amber-700 border-amber-200",
    High:     "bg-orange-50 text-orange-700 border-orange-200",
    Critical: "bg-red-50 text-red-700 border-red-200",
  };
  const Icon = tier === "Critical" || tier === "High" ? ShieldAlert : tier === "Medium" ? Shield : ShieldCheck;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${styles[tier] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}>
      <Icon className="h-3 w-3" />
      {tier}
      {score != null && <span className="opacity-70">· {score}</span>}
    </span>
  );
}

// ── Sorting ───────────────────────────────────────────────────────────────────

type SortKey = "supplierName" | "supplierType" | "status" | "contactPerson" | "licenseNumber" | "riskScore" | "reviewStatus";
type SortDir = "asc" | "desc";

const REVIEW_STATUS_RANK: Record<string, number> = {
  overdue:          0,
  "due-soon":       1,
  "never-qualified": 2,
  current:          3,
};

const RISK_TIER_RANK: Record<string, number> = {
  Critical: 0,
  High:     1,
  Medium:   2,
  Low:      3,
};

type SupplierRow = {
  id: number;
  supplierName: string;
  supplierType: string;
  status: string;
  contactPerson?: string | null;
  licenseNumber?: string | null;
  riskScore?: number | null;
  riskTier?: string | null;
  reviewStatus?: string | null;
  nextReviewDue?: string | null;
  reviewDriver?: string | null;
  // License-record requirement (2026-08-06). "not-required" | "missing" |
  // "expired" | "current"; licenseExpiry is the furthest-out current expiry.
  licenseRequired?: boolean;
  licenseCompliance?: string | null;
  licenseExpiry?: string | null;
};

// ── License badge ───────────────────────────────────────────────────────────────
// Only flags problems — a compliant or not-required supplier shows nothing here.
function LicenseBadge({ compliance }: { compliance?: string | null }) {
  if (compliance !== "missing" && compliance !== "expired") return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-700 border border-red-300 px-2 py-0.5 text-xs font-semibold">
      <AlertTriangle className="h-3 w-3" />
      {compliance === "expired" ? "License expired" : "License required"}
    </span>
  );
}

function sortSuppliers(rows: SupplierRow[], key: SortKey, dir: SortDir): SupplierRow[] {
  const mul = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp = 0;
    if (key === "supplierName") {
      cmp = a.supplierName.localeCompare(b.supplierName);
    } else if (key === "supplierType") {
      cmp = a.supplierType.localeCompare(b.supplierType);
    } else if (key === "status") {
      cmp = a.status.localeCompare(b.status);
    } else if (key === "contactPerson") {
      cmp = (a.contactPerson ?? "").localeCompare(b.contactPerson ?? "");
    } else if (key === "licenseNumber") {
      cmp = (a.licenseNumber ?? "").localeCompare(b.licenseNumber ?? "");
    } else if (key === "riskScore") {
      const ra = RISK_TIER_RANK[a.riskTier ?? ""] ?? 99;
      const rb = RISK_TIER_RANK[b.riskTier ?? ""] ?? 99;
      cmp = ra !== rb ? ra - rb : (a.riskScore ?? 0) - (b.riskScore ?? 0);
    } else if (key === "reviewStatus") {
      const ra = REVIEW_STATUS_RANK[a.reviewStatus ?? ""] ?? 99;
      const rb = REVIEW_STATUS_RANK[b.reviewStatus ?? ""] ?? 99;
      cmp = ra - rb;
    }
    return cmp * mul;
  });
}

function SortableHead({
  label,
  sortKey,
  current,
  dir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const active = current === sortKey;
  const Icon = active ? (dir === "asc" ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <TableHead
      className="cursor-pointer select-none whitespace-nowrap group"
      onClick={() => onSort(sortKey)}
    >
      <span className={`inline-flex items-center gap-1 ${active ? "text-foreground font-semibold" : "text-muted-foreground"} group-hover:text-foreground transition-colors`}>
        {label}
        <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? "opacity-100" : "opacity-40 group-hover:opacity-70"}`} />
      </span>
    </TableHead>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Suppliers() {
  const { data: suppliers, isLoading } = useListSuppliers();
  // Session 97 (#15) — risk-tier ALARM framing (Critical/High chips, coloring, row
  // tints) is suppressed until the facility opts into scoring. The numeric score
  // still shows, neutrally. Re-qualification alerts (overdue/due-soon) are NOT
  // scoring — they stay on regardless.
  const { data: companyProfile } = useGetCompanyProfile();
  const scoringEnabled = !!(companyProfile as { supplierScoringEnabled?: boolean } | undefined)?.supplierScoringEnabled;
  // Session 52.2 — Active / Cancelled view. Active list excludes cancelled
  // server-side; the Cancelled view raw-fetches ?cancelled=true (off-spec param).
  const [view, setView] = useState<"active" | "cancelled">("active");
  const { data: cancelledSuppliers = [], isLoading: cancelledLoading } = useQuery({
    queryKey: ["suppliers", "cancelled"],
    queryFn: async () => {
      const r = await fetch("/api/suppliers?cancelled=true", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load cancelled suppliers");
      return r.json() as Promise<NonNullable<typeof suppliers>>;
    },
    enabled: view === "cancelled",
  });

  // Session 26 — read the ?queue= URL param once at mount and derive the
  // initial sort from it (overdue suppliers should surface first when the
  // requal queue is active). Reading it BEFORE the sortKey state declaration
  // keeps both initializers pure and avoids cross-state writes during the
  // first render.
  const initialQueueParam = (() => {
    if (typeof window === "undefined") return null;
    const q = new URLSearchParams(window.location.search).get("queue");
    return q && SUPPLIER_QUEUE_LABELS[q] ? q : null;
  })();

  const [sortKey, setSortKey] = useState<SortKey>(
    initialQueueParam === "requal_needed" ? "reviewStatus" : "supplierName",
  );
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [queueParam, setQueueParam] = useState<string | null>(initialQueueParam);
  const clearQueueFilter = () => {
    setQueueParam(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("queue");
      window.history.replaceState({}, "", url.toString());
    }
  };

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "riskScore" || key === "reviewStatus" ? "asc" : "asc");
    }
  }

  // Apply queue filter first, then sort. The queue predicate mirrors the
  // Dashboard tile: overdue + due-soon + never-qualified all flow through.
  const queueFiltered = useMemo(() => {
    if (view === "cancelled") return (cancelledSuppliers ?? []) as SupplierRow[];
    if (!suppliers) return [];
    const list = suppliers as SupplierRow[];
    if (!queueParam) return list;
    switch (queueParam) {
      case "requal_needed":
        return list.filter(
          (s) =>
            s.reviewStatus === "overdue" ||
            s.reviewStatus === "due-soon" ||
            s.reviewStatus === "never-qualified",
        );
      case "license_alert":
        return list.filter(
          (s) => s.licenseCompliance === "missing" || s.licenseCompliance === "expired",
        );
      default:
        return list;
    }
  }, [view, cancelledSuppliers, suppliers, queueParam]);

  const tableLoading = view === "cancelled" ? cancelledLoading : isLoading;

  const sorted = useMemo(
    () => sortSuppliers(queueFiltered, sortKey, sortDir),
    [queueFiltered, sortKey, sortDir],
  );

  const overdueCount  = suppliers?.filter((s) => s.reviewStatus === "overdue").length ?? 0;
  const dueSoonCount  = suppliers?.filter((s) => s.reviewStatus === "due-soon").length ?? 0;
  // License-record requirement (2026-08-06) — suppliers flagged for a missing or
  // expired required license/certificate.
  const licenseFlagCount = (suppliers as SupplierRow[] | undefined)?.filter(
    (s) => s.licenseCompliance === "missing" || s.licenseCompliance === "expired",
  ).length ?? 0;
  const criticalCount = suppliers?.filter((s) => s.riskTier === "Critical").length ?? 0;
  const highCount     = suppliers?.filter((s) => s.riskTier === "High").length ?? 0;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Suppliers</h1>
            <p className="text-muted-foreground">Approved supplier list and quality ratings.</p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/audit-log/supplier-requal">
              <Button variant="outline" size="sm" className="gap-1.5">
                <FileText className="h-4 w-4" />
                Re-qual Audit Trail
              </Button>
            </Link>
            <CreateSupplierDialog />
          </div>
        </div>

        {/* Session 52.2 — Active / Cancelled view toggle. */}
        <div className="flex gap-1">
          <Button variant={view === "active" ? "default" : "outline"} size="sm" className="h-8" onClick={() => setView("active")}>
            Active
          </Button>
          <Button variant={view === "cancelled" ? "default" : "outline"} size="sm" className="h-8" onClick={() => setView("cancelled")}>
            Cancelled
          </Button>
        </div>

        {/* Active queue filter banner (Session 26) — mirrors the pattern from
            CAPAs.tsx / NonConformances.tsx / Inspections.tsx so deep-links
            from the Dashboard land on a clearly-filtered view. */}
        {queueParam && SUPPLIER_QUEUE_LABELS[queueParam] && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/[0.05] px-3 py-2 text-sm">
            <span>
              Showing: <span className="font-medium">{SUPPLIER_QUEUE_LABELS[queueParam]}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={clearQueueFilter} className="h-7 gap-1">
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          </div>
        )}

        {/* Alert banners. Session 97 (#15) — the risk-tier chips only appear once
            the facility has opted into scoring; the re-qual chips always show. */}
        {view === "active" && ((scoringEnabled && (criticalCount > 0 || highCount > 0)) || overdueCount > 0 || dueSoonCount > 0) && (
          <div className="flex flex-wrap gap-3">
            {scoringEnabled && criticalCount > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                <ShieldAlert className="h-4 w-4 text-red-600 shrink-0" />
                <span><strong>{criticalCount}</strong> supplier{criticalCount > 1 ? "s" : ""} at Critical risk</span>
              </div>
            )}
            {scoringEnabled && highCount > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-800">
                <ShieldAlert className="h-4 w-4 text-orange-600 shrink-0" />
                <span><strong>{highCount}</strong> supplier{highCount > 1 ? "s" : ""} at High risk</span>
              </div>
            )}
            {overdueCount > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
                <span><strong>{overdueCount}</strong> supplier{overdueCount > 1 ? "s" : ""} past re-qualification due date</span>
              </div>
            )}
            {dueSoonCount > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <Clock className="h-4 w-4 text-amber-600 shrink-0" />
                <span><strong>{dueSoonCount}</strong> supplier{dueSoonCount > 1 ? "s" : ""} due for re-qualification within 90 days</span>
              </div>
            )}
          </div>
        )}

        {/* License-record requirement (2026-08-06) — flag suppliers that need a
            license/certificate on file but have none current. Always shown in the
            active view (independent of the risk-scoring opt-in). */}
        {view === "active" && licenseFlagCount > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
            <span><strong>{licenseFlagCount}</strong> supplier{licenseFlagCount > 1 ? "s" : ""} missing a required license/certificate — or with an expired one</span>
          </div>
        )}

        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead label="Supplier Name"          sortKey="supplierName"  current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortableHead label="Type"                   sortKey="supplierType"  current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortableHead label="Status"                 sortKey="status"        current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortableHead label="Contact"                sortKey="contactPerson" current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortableHead label="License"                sortKey="licenseNumber" current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortableHead label="Risk Score"             sortKey="riskScore"     current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortableHead label="Re-qualification Review" sortKey="reviewStatus" current={sortKey} dir={sortDir} onSort={handleSort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tableLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-[100px]" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : sorted.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center h-24 text-muted-foreground">
                    {view === "cancelled" ? "No cancelled suppliers." : "No suppliers found. Add your first supplier to get started."}
                  </TableCell>
                </TableRow>
              ) : (
                sorted.map((supplier) => {
                  // Session 97 (#6) — row accent line by the supplier's worst active
                  // signal: risk tier (only when scoring is enabled) or re-qual review
                  // status. Only urgent/caution show a line; good/neutral stay calm.
                  const order: Record<StatusTone, number> = { neutral: 0, good: 1, caution: 2, urgent: 3 };
                  const riskTone = scoringEnabled ? toneRiskTier(supplier.riskTier) : "neutral";
                  const reviewTone = toneReviewStatus(supplier.reviewStatus);
                  const worst = order[riskTone] >= order[reviewTone] ? riskTone : reviewTone;
                  const rowTone: StatusTone = worst === "urgent" || worst === "caution" ? worst : "neutral";
                  return (
                  <TableRow
                    key={supplier.id}
                    className={accentClass(rowTone)}
                  >
                    <TableCell className="font-medium">
                      <Link href={`/suppliers/${supplier.id}`} className="hover:underline text-primary">
                        {supplier.supplierName}
                      </Link>
                    </TableCell>
                    <TableCell>{supplier.supplierType}</TableCell>
                    <TableCell>
                      <Badge variant={supplier.status === "Approved" ? "default" : "secondary"}>
                        {supplier.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{supplier.contactPerson}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <span>{supplier.licenseNumber || <span className="text-muted-foreground">—</span>}</span>
                        <LicenseBadge compliance={supplier.licenseCompliance} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <RiskBadge tier={supplier.riskTier} score={supplier.riskScore} scoringEnabled={scoringEnabled} />
                    </TableCell>
                    <TableCell>
                      <ReviewBadge status={supplier.reviewStatus} nextReviewDue={supplier.nextReviewDue} reviewDriver={supplier.reviewDriver} />
                    </TableCell>
                  </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </AppLayout>
  );
}
