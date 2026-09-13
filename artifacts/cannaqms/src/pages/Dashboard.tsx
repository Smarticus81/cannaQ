import { useState, useEffect, useMemo } from "react";
import { SetupChecklist } from "@/components/setup/SetupChecklist";
import {
  useDashboardLayout,
  DashboardLayoutProvider,
  DashboardEditBar,
  Sec,
  LicenseRenewalsCard,
  ComplianceCard,
  OpenInspectionsCard,
} from "@/components/dashboard/DashboardLayout";
import {
  useGetDashboardSummary,
  useGetBatchStatusBreakdown,
  useGetRecentActivity,
  useGetOpenItems,
  useListSuppliers,
  useGetCurrentUser,
  useListIncomingInspections,
  useListCapas,
  useListNonConformances,
  useListCapaActionItems,
  useListBatchRecords,
  useListInventoryItems,
  useGetDashboardTestingMetrics,
} from "@workspace/api-client-react";
// Session 37 — Operations dashboard visualizations. Recharts is already used
// elsewhere in the app (SupplierDetail risk trend); we use the same set of
// primitives (ResponsiveContainer + Bar/Line/Pie chart families) so the look
// and feel stays consistent.
import {
  ResponsiveContainer,
  BarChart, Bar,
  LineChart, Line,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { useQuery } from "@tanstack/react-query";
import { toneFromAccent, accentClass, toneText, batchStateLabel } from "@/lib/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { format, formatDistanceToNow } from "date-fns";
import { formatDateOnly } from "@/lib/utils";
import {
  Factory,
  AlertTriangle,
  MessageSquareWarning,
  ShieldAlert,
  Package,
  ClipboardCheck,
  RefreshCw,
  CheckCircle2,
  Clock,
  TrendingUp,
  Activity,
  ClipboardList,
  Flame,
  GraduationCap,
  ShieldCheck,
  FileText,
  FlaskConical,
  Truck,
  Inbox,
  UserCheck,
  ShieldQuestion,
  Scale,
  Wrench,
  Link2,
} from "lucide-react";
import { differenceInDays, isPast, parseISO } from "date-fns";

// ── My Queue helpers (Session 17 / extended in Session 18) ──────────────────
// Slim shape of a CAPA row returned by GET /api/capas. We avoid importing the
// Capa type because the API spec for capas is not yet regenerated (carryover
// from Session 16) and CAPAs.tsx already uses raw fetch for the same reason.
type CapaRow = {
  id: number;
  capaNumber: string;
  title: string;
  stage?: string | null;
  status: string;
  originatorName?: string | null;
  openedByName?: string | null;
  effectivenessOwnerName?: string | null;
  gate1ApprovedAt?: string | null;
  gate1Approver1Name?: string | null;
  gate1Approver2Name?: string | null;
  gate2ApproverName?: string | null;
  gate2Outcome?: string | null;
  closedAt?: string | null;
  department?: string | null;
};

// Slim shape of an NC row — full row from GET /api/non-conformances.
type NcRow = {
  id: number;
  ncNumber: string;
  title: string;
  severity: string;
  status: string;
  // Disposition is initially null/empty for a newly created NC; a Supervisor+
  // sets it. Major / Critical NCs surface in the "Awaiting disposition" My
  // Queue tile (Session 24) when this is null.
  disposition?: string | null;
  mgmtAcknowledgedAt?: string | null;
  // Session 37 — the Operations 'Open NCs trend' widget aggregates by week
  // using createdAt + closedAt. The list endpoint already returns both.
  createdAt?: string | null;
  closedAt?: string | null;
  department?: string | null;
};

// Slim shape of an aggregate CAPA action item from
// GET /api/capa-action-items (Session 18 endpoint).
type CapaActionItemRow = {
  id: number;
  capaId: number;
  sequenceNumber: number;
  actionDescription: string;
  assignedToName?: string | null;
  dueDate?: string | null;
  status: string;
};

// NC-2 — shape returned by GET /api/my/nc-corrections (the current user's open
// correction tasks, joined to their parent NC).
type MyNcCorrectionRow = {
  id: number;
  ncId: number;
  description: string;
  dueDate?: string | null;
  ncNumber: string;
  ncTitle: string;
};

// Session 62.2 — same shape for complaint correction tasks. Complaint
// corrections became assignable tasks alongside NC ones, so their owners need
// the same "here is your work" surface on login.
type MyComplaintCorrectionRow = {
  id: number;
  complaintId: number;
  description: string;
  dueDate?: string | null;
  complaintNumber: string;
  complaintTitle: string;
};

// Shape from GET /api/documents/my/pending-signatures — a document Under Review
// that is waiting on THIS person to sign, either as the assigned Reviewer or, once
// the review is signed, as the assigned Approver.
type PendingSignatureRow = {
  id: number;
  docNumber: string;
  title: string;
  revision: string;
  documentType: string;
  action: "review" | "approve";
  reviewerName: string | null;
  approverName: string | null;
};

// Impact mgmt step 3 — shape from GET /api/documents/my/review-recommendations. An
// Approved document that references a document approved more recently (review recommended).
type ReviewRecRow = {
  myDoc: { id: number; docNumber: string; title: string; status: string; ownerName: string | null };
  owned: boolean;
  triggers: { id: number; docNumber: string; title: string; revision: string; approvalDate: string | null }[];
};

// Slim shape of an incoming inspection used by the Inspection-rationale
// queue tile (Session 26). The full IncomingInspection type from the orval
// client carries more columns; this picks just what the tile reads.
type InspectionRow = {
  id: number;
  inspectionNumber: string;
  result: string;
  supplierName?: string | null;
};

// Roles permitted to act as Supervisor+ for Gate 1, Gate 2, and Use-As-Is sign-off.
// Mirrors the segregation logic captured in CAPADetail / NonConformanceDetail.
// Finished-goods on hand = released + finished-goods batches (matches the
// Finished Goods page). Strain type badges use the app's S/I/H colours.
const FG_ONHAND_STATUSES = new Set(["released_to_inventory", "finished_goods"]);
function strainBadge(t: string | null): { label: string; cls: string } | null {
  if (!t || !t.trim()) return null;
  const s = t.trim().toLowerCase();
  if (s.startsWith("sat")) return { label: "S", cls: "bg-orange-100 text-orange-800 border-orange-200" };
  if (s.startsWith("ind")) return { label: "I", cls: "bg-purple-100 text-purple-800 border-purple-300" };
  if (s.startsWith("hyb")) return { label: "H", cls: "bg-red-100 text-red-800 border-red-200" };
  return { label: t.trim(), cls: "bg-slate-100 text-slate-700 border-slate-200" };
}

const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);
const CLOSURE_ROLES = new Set(["Manager", "Quality", "Admin"]);
// Roles permitted to sign management-acknowledgement on Major/Critical NCs.
// (NC mgmt ack is required server-side before close; see non_conformances.ts.)
const MGMT_ACK_ROLES = CLOSURE_ROLES;

const REFETCH_MS = 30_000;

// ── Helpers ───────────────────────────────────────────────────────────────────
function tableLabel(t: string) {
  const map: Record<string, string> = {
    batch_records: "Batch Record",
    batch_testing: "Batch Testing",
    batch_labeling: "Batch Labeling",
    batch_ingredients: "Batch Ingredients",
    non_conformances: "Non-Conformance",
    complaints: "Complaint",
    field_actions: "Field Action",
    packaging_designs: "Packaging Design",
    incoming_inspections: "Inspection",
    inventory: "Inventory",
    suppliers: "Supplier",
    users: "User",
    company_profile: "Company Profile",
  };
  return map[t] ?? t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function severityColor(s: string) {
  if (s === "Critical") return "bg-red-100 text-red-800 border-red-200";
  if (s === "Major" || s === "High") return "bg-orange-100 text-orange-800 border-orange-200";
  if (s === "Minor" || s === "Medium") return "bg-yellow-100 text-yellow-800 border-yellow-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

// NC status chip color. Session 21 — refreshed to match the Session 11 locked
// 5-value set (Open / In Progress / Awaiting Mgt Acknowledgement / Under
// Review / Closed). The legacy "CAPA Required" label is dropped from the
// canonical set but kept here as a back-compat mapping so historical rows
// don't render as unknown.
function ncStatusColor(s: string) {
  if (s === "Open") return "bg-red-50 text-red-700 border-red-200";
  if (s === "In Progress") return "bg-blue-50 text-blue-700 border-blue-200";
  if (s === "Awaiting Mgt Acknowledgement") return "bg-rose-50 text-rose-700 border-rose-200";
  if (s === "Under Review") return "bg-yellow-50 text-yellow-700 border-yellow-200";
  if (s === "Closed") return "bg-green-50 text-green-700 border-green-200";
  // Back-compat — pre-Session-11 statuses.
  if (s === "CAPA Required") return "bg-orange-50 text-orange-700 border-orange-200";
  return "bg-slate-100 text-slate-600 border-slate-200";
}

function faStatusColor(s: string) {
  if (s === "Initiated") return "bg-red-50 text-red-700 border-red-200";
  if (s === "Response Active") return "bg-orange-50 text-orange-700 border-orange-200";
  if (s === "Due Diligence") return "bg-yellow-50 text-yellow-700 border-yellow-200";
  if (s === "Scope Defined") return "bg-blue-50 text-blue-700 border-blue-200";
  if (s === "Closed") return "bg-green-50 text-green-700 border-green-200";
  return "bg-slate-100 text-slate-600";
}

// FA action-type chip color (Session 21 — was 3-way before, now handles all 5
// Session-15 normalized values plus the 3 legacy labels for back-compat).
function faActionTypeColor(t: string) {
  switch (t) {
    case "Voluntary Recall":
    case "Recall": // legacy
      return "bg-red-100 text-red-800 border-red-200";
    case "Regulatory Recall":
      return "bg-red-200 text-red-900 border-red-400";
    case "Stop Sale":
      return "bg-purple-100 text-purple-800 border-purple-300";
    case "Market Withdrawal":
    case "Withdrawal": // legacy
      return "bg-orange-100 text-orange-800 border-orange-200";
    case "Safety Alert":
    case "Advisory Notice": // legacy
      return "bg-yellow-100 text-yellow-800 border-yellow-200";
    // Informational only — the product is fine, so it must not wear a hazard colour.
    case "Notification Only":
      return "bg-sky-100 text-sky-800 border-sky-200";
    default:
      return "bg-slate-100 text-slate-700 border-slate-200";
  }
}

// CAPA chip color. Session 21 — extended to recognise the Session-4 stage
// values directly so detail rows that render `stage` (not the legacy linear
// `status` mirror) don't fall through to the gray default. Each stage maps to
// the same palette as its legacy-status counterpart per STAGE_TO_LEGACY_STATUS
// in artifacts/api-server/src/routes/capas.ts.
function capaStatusColor(s: string) {
  switch (s) {
    // Legacy linear statuses.
    case "Open": return "bg-slate-100 text-slate-700 border-slate-300";
    case "Root Cause Analysis": return "bg-purple-50 text-purple-700 border-purple-200";
    case "Action Planning": return "bg-blue-50 text-blue-700 border-blue-200";
    case "Implementation": return "bg-amber-50 text-amber-700 border-amber-200";
    case "Effectiveness Check": return "bg-indigo-50 text-indigo-700 border-indigo-200";
    case "Closed": return "bg-green-50 text-green-700 border-green-200";
    // Session 4 stage values. Session 35 — "Planning" replaces the two
    // prior "Action Planning"/"EC Planning" stages; "EC Planning" stays as a
    // case for grandfathered display in case the migration hasn't run yet.
    case "Initiation": return "bg-slate-100 text-slate-700 border-slate-300";
    case "Investigation": return "bg-purple-50 text-purple-700 border-purple-200";
    case "Planning": return "bg-blue-50 text-blue-700 border-blue-200";
    case "EC Planning": return "bg-blue-50 text-blue-700 border-blue-200";
    case "Action Execution": return "bg-amber-50 text-amber-700 border-amber-200";
    case "EC Execution": return "bg-indigo-50 text-indigo-700 border-indigo-200";
    default: return "bg-slate-100 text-slate-600 border-slate-200";
  }
}

// 2026-09-08 — this was a THIRD copy of the batch status labels and it had
// drifted (still "Released to Inventory" / "Finished Goods" after both were
// renamed). One shared map now, in lib/status.ts.
function batchStatusLabel(s: string) {
  const label = batchStateLabel(s);
  return label === s ? s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : label;
}

function batchStatusColor(s: string) {
  if (s === "in_production") return "bg-blue-100 text-blue-800";
  if (s === "testing_in_progress" || s === "in_inventory_untested") return "bg-indigo-100 text-indigo-800";
  if (s === "passed_awaiting_packaging") return "bg-amber-100 text-amber-800";
  if (s === "released_to_inventory" || s === "finished_goods") return "bg-green-100 text-green-800";
  if (s === "on_hold") return "bg-orange-100 text-orange-800";
  if (s === "failed" || s === "destroyed") return "bg-red-100 text-red-800";
  return "bg-slate-100 text-slate-700";
}

// ── KPI Tile ──────────────────────────────────────────────────────────────────
function KpiTile({
  label,
  value,
  sub,
  subAlert,
  icon: Icon,
  href,
  loading,
  accent,
  onClick,
}: {
  label: string;
  value: number | undefined;
  sub?: string;
  subAlert?: boolean;
  icon: React.ElementType;
  href: string;
  loading: boolean;
  accent?: "red" | "orange" | "amber" | "blue" | "green" | "slate";
  onClick?: () => void;
}) {
  // Session 97 (#6) — traffic-light accent LINE on a plain surface, not a filled
  // tile. Neutral tones (in-production, informational) get no line.
  const tone = toneFromAccent(accent);
  const toneTextClass = tone === "neutral" ? "" : toneText[tone];

  const card = (
    <Card
      className={`cursor-pointer hover:shadow-md transition-shadow ${accentClass(tone)}`}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1">
        <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
        <Icon
          className={`h-4 w-4 ${toneTextClass || "text-muted-foreground"}`}
        />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-12" />
        ) : (
          <>
            <div className={`text-3xl font-bold tabular-nums ${toneTextClass}`}>
              {value ?? 0}
            </div>
            {sub && (
              <p
                className={`text-xs mt-1 ${subAlert ? "text-status-urgent font-semibold" : "text-muted-foreground"}`}
              >
                {sub}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );

  if (onClick) {
    return <div onClick={onClick}>{card}</div>;
  }
  return <Link href={href}>{card}</Link>;
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
export default function Dashboard() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ri = { query: { refetchInterval: REFETCH_MS } } as any;

  const {
    data: summary,
    isLoading: summaryLoading,
    dataUpdatedAt,
    refetch: refetchSummary,
  } = useGetDashboardSummary(ri);

  const { data: batchBreakdown = [], isLoading: batchLoading } =
    useGetBatchStatusBreakdown(ri);

  const { data: recentActivity = [], isLoading: activityLoading } =
    useGetRecentActivity({ limit: 20 }, ri);
  // Collapse consecutive edits to the SAME record into one row with a count
  // ("Jar Label ×15"), so a burst of saves doesn't bury the rest of the feed.
  // Display-only — the underlying audit-trail rows are untouched (21 CFR Part 11).
  const collapsedActivity = useMemo(() => {
    const out: Array<(typeof recentActivity)[number] & { collapsedCount: number }> = [];
    for (const e of recentActivity) {
      const prev = out[out.length - 1];
      if (prev && prev.operation === e.operation && prev.tableName === e.tableName && prev.rowId === e.rowId) {
        prev.collapsedCount += 1;
      } else {
        out.push({ ...e, collapsedCount: 1 });
      }
    }
    return out;
  }, [recentActivity]);

  const { data: openItems, isLoading: openItemsLoading } =
    useGetOpenItems(ri);

  const { data: allSuppliers = [], isLoading: suppliersLoading } =
    useListSuppliers(ri);

  // Session 26 — inspections used by the Inspection-rationale queue tile.
  // The orval-typed list includes the columns we read on the tile (id,
  // inspectionNumber, result, supplierName); cast to a slim shape to keep
  // the useMemo deps narrow.
  const { data: allInspections = [], isLoading: inspectionsLoading } =
    useListIncomingInspections(ri);

  // Session 37 (Tier 3 #15) — Operations dashboard queries.
  //
  // Pulled at the top of the component so the widgets render off the same
  // refetch interval as the rest of the dashboard. Heavy lists go through
  // the existing typed hooks; the testing-metrics aggregate is a new
  // server endpoint pulled via raw fetch (the typed useGetDashboardTestingMetrics
  // lands in Session 37.1 alongside the orval regen).
  const { data: allBatches = [], isLoading: batchesLoading } = useListBatchRecords(ri);
  const { data: allInventory = [], isLoading: inventoryLoading } = useListInventoryItems(ri);
  // Session 37.1 — swapped the raw useQuery + fetch for the orval-typed
  // hook now that /dashboard/testing-metrics is in the spec.
  // Session 42 — cast options to any (matches the `ri` pattern at line 342)
  // because orval-generated UseQueryOptions now requires `queryKey` explicitly.
  const { data: testingMetrics, isLoading: testingMetricsLoading } =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useGetDashboardTestingMetrics({ days: 90 }, { query: { refetchInterval: REFETCH_MS } } as any);

  // Session 42 — hoisted from the My Queue section below so the ncTrend chart's
  // useMemo (which deps on allNcs) doesn't reference a block-scoped variable
  // before its declaration. ncsData / allNcs are still re-used in My Queue.
  const { data: ncsData = [], isLoading: ncsLoading } = useListNonConformances(ri);
  const allNcs = ncsData as unknown as NcRow[];

  // Session 37 — client-side aggregations for the Operations widgets. Kept
  // in useMemo so the heavy filtering doesn't re-run on every render. Each
  // aggregator is dependency-narrow so re-renders fire only when the
  // underlying list actually changes.

  // Low-stock callouts: an inventory row is low when quantity <= reorderPoint
  // (and reorderPoint is set). Returns the top 5 by deepest deficit so the
  // tile surfaces the worst-offenders first.
  const lowStockItems = useMemo(() => {
    const out: Array<{ id: number; itemName: string; quantity: number; reorderPoint: number; unitOfMeasure: string }> = [];
    for (const it of allInventory) {
      if (it.reorderPoint != null && (it.quantity ?? 0) <= it.reorderPoint) {
        out.push({
          id: it.id,
          itemName: it.itemName,
          quantity: it.quantity ?? 0,
          reorderPoint: it.reorderPoint,
          unitOfMeasure: it.unitOfMeasure,
        });
      }
    }
    out.sort((a, b) => (a.quantity - a.reorderPoint) - (b.quantity - b.reorderPoint));
    return out;
  }, [allInventory]);

  // Dashboard redesign (2026-08-11) — Operator (receiving + fulfillment) widgets.
  // Inventory On Hand: every catalog item with its on-hand qty, worst-stocked
  // first so an Operator sees what to escalate for reorder. Finished Goods On
  // Hand: released/finished batches with qty, production + expiration dates and
  // Sativa/Indica/Hybrid type — sortable, default soonest-expiry first (FEFO).
  // Buffer band (2026-08-11): an item is "approaching" reorder when on-hand is
  // still ABOVE the reorder point but within 25% of it — an amber early warning
  // before it crosses into the red "Reorder" zone (at/below the point). Days-on-
  // hand (consumption-rate based) is deferred to a release with production numbers.
  const INVENTORY_BUFFER = 1.25;
  const inventoryOnHand = useMemo(() => {
    const rows = allInventory.map((it) => {
      const quantity = it.quantity ?? 0;
      const reorderPoint = it.reorderPoint ?? null;
      const low = reorderPoint != null && quantity <= reorderPoint;
      const approaching = !low && reorderPoint != null && quantity <= reorderPoint * INVENTORY_BUFFER;
      return { id: it.id, itemName: it.itemName, quantity, reorderPoint, unit: it.unitOfMeasure, low, approaching };
    });
    const rank = (r: { low: boolean; approaching: boolean }) => (r.low ? 0 : r.approaching ? 1 : 2);
    rows.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;                       // reorder → low soon → ok
      if (ra < 2 && a.reorderPoint != null && b.reorderPoint != null) {
        return (a.quantity - a.reorderPoint) - (b.quantity - b.reorderPoint); // most urgent first
      }
      return a.itemName.localeCompare(b.itemName);
    });
    return rows;
  }, [allInventory]);
  const lowStockCount = useMemo(() => inventoryOnHand.filter((r) => r.low).length, [inventoryOnHand]);
  const approachingCount = useMemo(() => inventoryOnHand.filter((r) => r.approaching).length, [inventoryOnHand]);

  const finishedGoodsOnHand = useMemo(() => {
    return allBatches
      .filter((b) => FG_ONHAND_STATUSES.has(b.status))
      .map((b) => {
        const x = b as unknown as { expirationDate?: string | null; strainType?: string | null };
        return {
          id: b.id,
          product: b.productName || b.strainName || `Batch #${b.id}`,
          strainName: b.strainName ?? null,
          strainType: x.strainType ?? null,
          quantity: b.outputQuantity ?? null,
          produced: b.productionDate ?? null,
          expires: x.expirationDate ?? null,
        };
      });
  }, [allBatches]);

  const [fgSort, setFgSort] = useState<{ key: "product" | "strain" | "qty" | "produced" | "expires"; dir: "asc" | "desc" }>({ key: "expires", dir: "asc" });
  const finishedGoodsSorted = useMemo(() => {
    const rows = finishedGoodsOnHand.slice();
    const { key, dir } = fgSort;
    const mul = dir === "asc" ? 1 : -1;
    const cmpStr = (a: string | null, b: string | null) => {
      if (!a && !b) return 0;
      if (!a) return 1;            // blanks always sink to the bottom
      if (!b) return -1;
      return a.localeCompare(b) * mul;
    };
    const cmpNum = (a: number | null, b: number | null) => {
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return (a - b) * mul;
    };
    rows.sort((a, b) => {
      switch (key) {
        case "product": return cmpStr(a.product, b.product);
        case "strain": return cmpStr(a.strainType, b.strainType);
        case "qty": return cmpNum(a.quantity, b.quantity);
        case "produced": return cmpStr(a.produced, b.produced);
        default: return cmpStr(a.expires, b.expires);
      }
    });
    return rows;
  }, [finishedGoodsOnHand, fgSort]);

  // Production output trend: last 10 batches that have an outputQuantity,
  // sorted oldest → newest so the chart reads left-to-right chronologically.
  // We don't filter by status here — operators want to see all completed
  // production runs, including remediation and rework batches.
  //
  // Session 38 (Tier 4 #19) — the chart now overlays scheduled (planned)
  // alongside actual output when the operator captured a scheduledOutputQuantity
  // at batch open. Variance reads at a glance.
  const recentBatchOutputs = useMemo(() => {
    const withOutput = allBatches
      .filter((b) => b.outputQuantity != null && b.outputQuantity > 0)
      .sort((a, b) => {
        const ad = a.productionDate ?? a.createdAt;
        const bd = b.productionDate ?? b.createdAt;
        return bd.localeCompare(ad);
      })
      .slice(0, 10);
    // Reverse so older batches sit on the left of the chart.
    return withOutput.reverse().map((b) => ({
      batch: b.batchNumber,
      scheduled: b.scheduledOutputQuantity ?? null,
      output: b.outputQuantity ?? 0,
      uom: b.unitOfMeasure ?? "",
    }));
  }, [allBatches]);

  // Open NCs trend (last 13 weeks ≈ 90 days). Bucket NCs into the ISO week
  // they were opened (createdAt) or closed (closedAt). The chart renders
  // two series so the operator can eyeball whether the team is closing
  // faster than they're opening.
  const ncTrend = useMemo(() => {
    const bucketCount = 13;
    const buckets: Array<{ weekStart: string; opened: number; closed: number }> = [];
    const now = new Date();
    // Anchor on Monday so week labels align with typical operator schedules.
    const dayOfWeek = now.getUTCDay() === 0 ? 6 : now.getUTCDay() - 1;
    const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayOfWeek));
    for (let i = bucketCount - 1; i >= 0; i--) {
      const wk = new Date(thisMonday);
      wk.setUTCDate(wk.getUTCDate() - i * 7);
      buckets.push({ weekStart: wk.toISOString().slice(0, 10), opened: 0, closed: 0 });
    }
    const bucketIndex = (iso: string): number => {
      const t = new Date(iso).getTime();
      for (let i = buckets.length - 1; i >= 0; i--) {
        if (t >= new Date(buckets[i].weekStart + "T00:00:00").getTime()) return i;
      }
      return -1;
    };
    for (const nc of allNcs) {
      if (nc.createdAt) {
        const i = bucketIndex(nc.createdAt);
        if (i >= 0) buckets[i].opened += 1;
      }
      if (nc.closedAt) {
        const i = bucketIndex(nc.closedAt);
        if (i >= 0) buckets[i].closed += 1;
      }
    }
    return buckets;
  }, [allNcs]);

  // Pending CoAs derive from the existing batch status breakdown that the
  // QMS section already renders — saves an extra fetch.
  const pendingCoasCount = useMemo(() => {
    const row = batchBreakdown.find((r) => r.status === "testing_in_progress");
    return row?.count ?? 0;
  }, [batchBreakdown]);
  // Quality — batches awaiting a test (untested), the front of the testing queue.
  const untestedCount = useMemo(
    () => batchBreakdown.find((r) => r.status === "in_inventory_untested")?.count ?? 0,
    [batchBreakdown],
  );

  // ── My Queue (Sessions 17 + 18; Session 28 — typed hooks) ─────────────────
  // CAPA, NC, and CAPA-action-item lists used to be raw fetches because the
  // OpenAPI spec lagged the implementation. With Sessions 18/19/20/25 the
  // spec caught up and Session 27.1 committed the orval regen output, so the
  // Dashboard My Queue plumbing now goes through the same typed hooks
  // everything else uses. The slim local row types (CapaRow / NcRow /
  // CapaActionItemRow) stay — they pick just the fields the queue filters
  // read, which keeps the useMemo deps narrow and avoids over-rendering
  // when unrelated columns change.
  const { data: currentUser } = useGetCurrentUser();
  const meName = currentUser?.fullName ?? "";
  const meRole = currentUser?.role ?? "";

  const { data: capasData = [], isLoading: capasLoading } = useListCapas(ri);
  const allCapas = capasData as unknown as CapaRow[];

  // Supervisor — Production Pipeline: bulk batches moving through the floor,
  // grouped by in-flight stage (coming through / waiting for testing / waiting
  // to be packaged), with on-hold + failed batches called out for attention.
  const productionPipeline = useMemo(() => {
    const STAGES: { key: string; label: string }[] = [
      { key: "in_production", label: "In Production" },
      { key: "in_inventory_untested", label: "Untested" },
      { key: "testing_in_progress", label: "Testing" },
      { key: "passed_awaiting_packaging", label: "Awaiting Packaging" },
    ];
    const counts: Record<string, number> = {};
    for (const st of STAGES) counts[st.key] = 0;
    const attention: { id: number; batchNumber: string; product: string; label: string; tone: "red" | "amber" }[] = [];
    for (const b of allBatches) {
      if (counts[b.status] != null) counts[b.status] += 1;
      if (b.status === "failed" || b.status === "on_hold") {
        attention.push({
          id: b.id,
          batchNumber: b.batchNumber,
          product: b.productName || b.strainName || `Batch ${b.id}`,
          label: b.status === "failed" ? "Failed" : "On Hold",
          tone: b.status === "failed" ? "red" : "amber",
        });
      }
    }
    const stages = STAGES.map((st) => ({ ...st, count: counts[st.key] }));
    const inFlight = stages.reduce((sum, st) => sum + st.count, 0);
    return { stages, attention, inFlight };
  }, [allBatches]);

  // Supervisor — Team Actions: open CAPAs + NCs coming to the supervisor's
  // department(s). If the user has no departments set, show all (unscoped).
  const teamActions = useMemo(() => {
    const depts = (currentUser as unknown as { departments?: string[] } | undefined)?.departments ?? [];
    const inDept = (d?: string | null) => depts.length === 0 || (!!d && depts.includes(d));
    const openCapas = allCapas.filter(
      (c) => (c.stage ?? "") !== "Closed" && c.status !== "Closed" && inDept(c.department),
    );
    const openNcs = allNcs.filter((n) => n.status !== "Closed" && !n.closedAt && inDept(n.department));
    return { depts, openCapas, openNcs };
  }, [allCapas, allNcs, currentUser]);
  // Session 42 — ncsData / allNcs are declared higher up (near the other
  // dashboard fetches) so the ncTrend chart's useMemo can dep on allNcs
  // without hitting "used before declaration".

  // The action-items aggregate is only meaningful once the current user is
  // known. `enabled: !!meName` defers the first fetch until we have a name to
  // filter on, mirroring the previous useEffect's `if (!meName) return` guard.
  const { data: actionItemsData = [], isLoading: actionItemsLoading } =
    useListCapaActionItems(
      { assignedToName: meName, open: "1" },
      // Session 42 — cast options to any (matches the `ri` pattern at line 342)
      // because orval-generated UseQueryOptions now requires `queryKey` explicitly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {
        query: {
          refetchInterval: REFETCH_MS,
          enabled: !!meName,
        },
      } as any,
    );
  const myActionItems = actionItemsData as unknown as CapaActionItemRow[];

  // NC-2 (2026-07-12) — the current user's open NC correction tasks, surfaced as
  // a My Queue tile (mirrors "My action items" for CAPA). New endpoint, so this
  // uses a raw fetch via useQuery; deferred until we know the user's name.
  const { data: myNcCorrectionsData = [] } = useQuery<MyNcCorrectionRow[]>({
    queryKey: ["my-nc-corrections", meName],
    queryFn: async () => {
      const r = await fetch("/api/my/nc-corrections", { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!meName,
    refetchInterval: REFETCH_MS,
  });
  const myNcCorrections = myNcCorrectionsData;

  // Session 62.2 — the current user's open complaint correction tasks.
  const { data: myComplaintCorrectionsData = [] } = useQuery<MyComplaintCorrectionRow[]>({
    queryKey: ["my-complaint-corrections", meName],
    queryFn: async () => {
      const r = await fetch("/api/my/complaint-corrections", { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!meName,
    refetchInterval: REFETCH_MS,
  });
  const myComplaintCorrections = myComplaintCorrectionsData;

  // 2026-08-25 — documents waiting on MY signature. This tile used to be fed by
  // /documents/my/impacts, which answered "which of my documents reference
  // something being revised" — so a reviewer with three documents to sign saw a
  // zero. It now asks the question its name implies.
  const { data: myPendingSignaturesData = [] } = useQuery<PendingSignatureRow[]>({
    queryKey: ["my-pending-signatures", meName],
    queryFn: async () => {
      const r = await fetch("/api/documents/my/pending-signatures", { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!meName,
    refetchInterval: REFETCH_MS,
  });
  const myPendingSignatures = myPendingSignaturesData;

  // Impact mgmt step 3 — Approved documents (mine, or all for management) that
  // reference a document approved more recently → a review is recommended.
  const { data: myReviewRecsData = [] } = useQuery<ReviewRecRow[]>({
    queryKey: ["my-review-recommendations", meName],
    queryFn: async () => {
      const r = await fetch("/api/documents/my/review-recommendations", { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!meName,
    refetchInterval: REFETCH_MS,
  });
  const myReviewRecs = myReviewRecsData;

  // Batch 6 — documents that became Effective in the last 14 days, so Manager/
  // Quality/Admin know to reprint controlled copies. Backend returns [] for
  // non-management; we also gate the fetch on role to skip the call entirely.
  const { data: recentlyEffective = [] } = useQuery<{ id: number; docNumber: string; title: string; revision: string; effectiveDate: string | null; ownerName: string | null }[]>({
    queryKey: ["documents-recently-effective", meName],
    queryFn: async () => {
      const r = await fetch("/api/documents/mgmt/recently-effective?days=14", { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!meName && MGMT_ACK_ROLES.has(meRole),
    refetchInterval: REFETCH_MS,
  });

  // Batch 5 — the current user's OWN training, for the personal "My Training"
  // dashboard tile. Same endpoint as the Training page inbox (/api/training/my,
  // already Overdue-derived server-side). We count overdue + coming-due (within
  // 30 days) so clicking the tile lands the person on exactly their at-risk items.
  const { data: myTrainingData = [] } = useQuery<{ status: string; dueDate?: string | null }[]>({
    queryKey: ["my-training", meName],
    queryFn: async () => {
      const r = await fetch("/api/training/my", { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!meName,
    refetchInterval: REFETCH_MS,
  });
  const myTraining = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const soonStr = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // The total counts every OPEN assignment. It used to be overdue + due-within-30-
    // days, so an assignment with no due date (or one further out) counted as zero --
    // a person with training waiting on them read the tile as "nothing assigned".
    // Overdue and due-soon are still tracked, but as the breakdown, not the total.
    let open = 0;
    let overdue = 0;
    let comingDue = 0;
    for (const r of myTrainingData) {
      if (r.status === "Completed" || r.status === "Waived") continue;
      open += 1;
      if (r.status === "Overdue") { overdue += 1; continue; }
      if (r.dueDate && r.dueDate >= todayStr && r.dueDate <= soonStr) comingDue += 1;
    }
    return { overdue, comingDue, total: open };
  }, [myTrainingData]);

  // Dashboard redesign (2026-08-11) — "My Week / My Month" personal to-do strip.
  // Buckets the current user's OWN assigned, dated work — CAPA action items, NC
  // corrections, and training — into Overdue / This week / This month off each
  // item's own due date. Personal + live per item (NOT an org snapshot), so it
  // can't drift from the source pages. Undated items are omitted, except training
  // that the server already flags "Overdue" (which lands in Overdue regardless).
  const myDeadlines = useMemo(() => {
    // Local-midnight date keys (YYYY-MM-DD) so bucketing matches the user's own
    // timezone — never UTC (off-by-one in Eastern). Matches the app-wide date
    // convention. Dates are compared as plain "YYYY-MM-DD" strings.
    const ymd = (d: Date) => d.toLocaleDateString("en-CA");
    const today = new Date();
    const todayStr = ymd(today);
    // Week ends on the upcoming Sunday (local); if today is Sunday, that's today.
    const daysToSun = (7 - today.getDay()) % 7;
    const endOfWeekStr = ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysToSun));
    const endOfMonthStr = ymd(new Date(today.getFullYear(), today.getMonth() + 1, 0));

    type Todo = { key: string; label: string; sub?: string; due?: string; href: string };
    const overdue: Todo[] = [];
    const thisWeek: Todo[] = [];
    const thisMonth: Todo[] = [];
    const place = (due: string | null | undefined, item: Todo, forceOverdue = false) => {
      const d = due ? due.slice(0, 10) : "";
      if (forceOverdue || (d && d < todayStr)) { overdue.push({ ...item, due: d || undefined }); return; }
      if (!d) return;                       // undated + not force-overdue → can't time-bucket
      if (d <= endOfWeekStr) thisWeek.push({ ...item, due: d });
      else if (d <= endOfMonthStr) thisMonth.push({ ...item, due: d });
      // beyond this month → intentionally not shown in the strip
    };

    for (const a of myActionItems) {
      if (a.status === "Completed" || a.status === "Closed") continue;
      place(a.dueDate, { key: `capa-${a.id}`, label: a.actionDescription || "CAPA action", sub: `CAPA #${a.capaId}`, href: `/capas/${a.capaId}` });
    }
    for (const c of myNcCorrections) {
      place(c.dueDate, { key: `nc-${c.id}`, label: c.description || "NC correction", sub: c.ncNumber, href: `/non-conformances/${c.ncId}` });
    }
    for (const c of myComplaintCorrections) {
      place(c.dueDate, { key: `cmp-${c.id}`, label: c.description || "Complaint correction", sub: c.complaintNumber, href: `/complaints/${c.complaintId}` });
    }
    for (let i = 0; i < myTrainingData.length; i++) {
      const t = myTrainingData[i];
      if (t.status === "Completed" || t.status === "Waived") continue;
      place(t.dueDate, { key: `trn-${i}`, label: "Training due", href: "/training" }, t.status === "Overdue");
    }

    const byDue = (a: Todo, b: Todo) => (a.due ?? "9999-99-99").localeCompare(b.due ?? "9999-99-99");
    overdue.sort(byDue); thisWeek.sort(byDue); thisMonth.sort(byDue);
    return { overdue, thisWeek, thisMonth };
  }, [myActionItems, myNcCorrections, myComplaintCorrections, myTrainingData]);

  const myQueue = useMemo(() => {
    const canApprove = APPROVER_ROLES.has(meRole);
    const canMgmtAck = MGMT_ACK_ROLES.has(meRole);
    // NC-9 (2026-07-12) — Quality (and Admin) should be aware of ANY quality
    // event, not just items assigned to them — including ones others handled
    // (e.g. an NC opened by one person and closed by another). Surface recent NC
    // activity (created or closed in the last 7 days) to the Quality role.
    const canQuality = meRole === "Quality" || meRole === "Admin";
    const isMe = (n?: string | null) => !!n && n === meName;

    // Originator queue: CAPAs I opened that are not yet closed.
    const mineAsOriginator = allCapas.filter((c) =>
      (isMe(c.originatorName) || isMe(c.openedByName)) &&
      c.stage !== "Closed" &&
      c.status !== "Closed",
    );

    // EC Owner queue: CAPAs where I'm Effectiveness-Check Owner and we are
    // in (or past Gate 1, leading up to) the EC phases.
    const mineAsEcOwner = allCapas.filter((c) =>
      isMe(c.effectivenessOwnerName) &&
      ["Planning", "Action Execution", "EC Execution"].includes(c.stage ?? "") &&
      c.status !== "Closed",
    );

    // Approver queue: only Supervisors+ see this.
    //
    // Session 23 — also exclude CAPAs where the current user is an action
    // item owner. Server-side Part 11 segregation rejects the approval at
    // /gate1-approve / /gate2-approve when the approver is on the action list
    // (see capas.ts lines 287-289, 718-720); the tile previously surfaced
    // those CAPAs anyway, producing false positives that vanished only after
    // the user clicked through and tried to sign.
    const actionAssigneeCapaIds = new Set(myActionItems.map((i) => i.capaId));
    const awaitingMyApproval = canApprove
      ? allCapas.filter((c) => {
          if (isMe(c.originatorName) || isMe(c.openedByName) || isMe(c.effectivenessOwnerName)) return false;
          if (actionAssigneeCapaIds.has(c.id)) return false;
          const inGate1 = c.stage === "Planning" && !c.gate1ApprovedAt;
          const inGate2 = c.stage === "EC Execution" && !c.gate2Outcome;
          if (!inGate1 && !inGate2) return false;
          if (inGate1 && (isMe(c.gate1Approver1Name) || isMe(c.gate1Approver2Name))) return false;
          return true;
        })
      : [];

    // Awaiting disposition queue (Session 24): Supervisor+ only. Surfaces
    // Major / Critical NCs that are open and don't yet have a disposition
    // set. Disposition decisions (Use As Is, Rework, Reject, etc.) require
    // Supervisor+ role server-side; the Use-As-Is transition additionally
    // requires Part 11 sign-off in line. Note: we do NOT exclude the
    // originator — a solo Supervisor+ is often both creator and decider, and
    // server enforces its own segregation on the Use-As-Is path.
    const awaitingDisposition = canApprove
      ? allNcs.filter((nc) =>
          (nc.severity === "Major" || nc.severity === "Critical") &&
          nc.status !== "Closed" &&
          !((nc.disposition ?? "").trim()),
        )
      : [];

    // NC management-acknowledgement queue (Session 18): Manager+ only.
    // Server enforces that Major / Critical NCs cannot be closed until
    // mgmtAcknowledgedAt is set; surface those NCs here so management knows
    // to act.
    // NC-7 (2026-07-12) — the count previously keyed ONLY off severity
    // (Major/Critical), so an NC explicitly set to status "Awaiting Mgt
    // Acknowledgement" but Minor severity showed 0 on this tile. Count an NC as
    // awaiting ack when it is unacked, not closed, AND either explicitly in that
    // status OR Major/Critical (the severity the close-gate enforces ack for).
    // NC-8 — status is event-derived, so it reads "Awaiting Mgt Acknowledgement"
    // exactly when all work gates are met and only the manager's sign-off remains.
    // Count that state directly instead of early-surfacing every open Major/Critical
    // NC, so the tile's number matches its label and the NC's own badge.
    const ncMgmtAckQueue = canMgmtAck
      ? allNcs.filter((nc) => nc.status === "Awaiting Mgt Acknowledgement")
      : [];

    // Inspection rationale queue (Session 26): Supervisor+ only. Surfaces
    // incoming inspections in the "Conditional" state — these are the rows
    // explicitly flagged by an operator as needing a Supervisor+ decision
    // (either an approved Pass with rationale, a Fail with rationale, or a
    // continued hold). Pass-with-failed-items sign-off is enforced inline
    // by the inspections.ts route at transition time, so we don't try to
    // surface that pre-transaction state separately — Conditional is the
    // canonical resting place when an inspection needs the Supervisor's eye.
    const inspectionsNeedingRationale: InspectionRow[] = canApprove
      ? (allInspections as unknown as InspectionRow[]).filter(
          (i) => i.result === "Conditional",
        )
      : [];

    // NC-9 — recent quality events for the Quality role (NCs created or closed
    // within the last 7 days), regardless of who they're assigned to.
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentQualityEvents = canQuality
      ? allNcs.filter((nc) => {
          const created = nc.createdAt ? new Date(nc.createdAt).getTime() : 0;
          const closed = nc.closedAt ? new Date(nc.closedAt).getTime() : 0;
          return created >= cutoff || closed >= cutoff;
        })
      : [];

    return {
      mineAsOriginator,
      mineAsEcOwner,
      awaitingMyApproval,
      awaitingDisposition,
      ncMgmtAckQueue,
      inspectionsNeedingRationale,
      recentQualityEvents,
      canApprove,
      canMgmtAck,
      canQuality,
      meName,
      meRole,
    };
  }, [allCapas, allNcs, allInspections, myActionItems, meName, meRole]);

  const [refreshing, setRefreshing] = useState(false);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    await refetchSummary();
    setRefreshing(false);
  };

  const lastUpdated = dataUpdatedAt
    ? formatDistanceToNow(new Date(dataUpdatedAt), { addSuffix: true })
    : null;

  const ncCount = summary?.openNonConformances ?? 0;
  const critNcCount = summary?.criticalNCs ?? 0;
  const complaintCount = summary?.openComplaints ?? 0;
  const critComplaintCount = summary?.criticalComplaints ?? 0;
  const faCount = summary?.openFieldActions ?? 0;
  const capaCount = summary?.openCAPAs ?? 0;
  const overdueCapaItems = summary?.overdueCapaActionItems ?? 0;
  const newAdverseEvents = summary?.newAdverseEventsThisWeek ?? 0;
  const newNCs = summary?.newNCsThisWeek ?? 0;
  const newThisWeek = newAdverseEvents + newNCs;
  const approvedSupplierQuals = summary?.approvedSupplierQuals ?? 0;
  const expiredSupplierQuals = summary?.expiredSupplierQuals ?? 0;
  const documentsUnderReview = summary?.documentsUnderReview ?? 0;
  const approvedDocuments = summary?.approvedDocuments ?? 0;
  const capaEffectivenessOverdue = summary?.capaEffectivenessOverdue ?? 0;
  const capaEffectivenessApproaching = summary?.capaEffectivenessApproaching ?? 0;

  const { suppliersOverdue, suppliersDueSoon } = useMemo(() => {
    const today = new Date();
    const overdue = allSuppliers.filter(
      (s) => s.reviewStatus === "overdue" || s.reviewStatus === "never-qualified"
    ).sort((a, b) => {
      const dA = a.nextReviewDue ? differenceInDays(today, parseISO(a.nextReviewDue)) : 9999;
      const dB = b.nextReviewDue ? differenceInDays(today, parseISO(b.nextReviewDue)) : 9999;
      return dB - dA;
    });
    const dueSoon = allSuppliers.filter(
      (s) => s.reviewStatus === "due-soon"
    ).sort((a, b) => {
      const dA = a.nextReviewDue ? differenceInDays(parseISO(a.nextReviewDue), today) : 9999;
      const dB = b.nextReviewDue ? differenceInDays(parseISO(b.nextReviewDue), today) : 9999;
      return dA - dB;
    });
    return { suppliersOverdue: overdue, suppliersDueSoon: dueSoon };
  }, [allSuppliers]);

  const openNCs = openItems?.nonConformances ?? [];
  const openComplaints = openItems?.complaints ?? [];
  const openFAs = openItems?.fieldActions ?? [];
  const openCapas = openItems?.capas ?? [];
  const newAdverseEventItems = openItems?.newAdverseEvents ?? [];
  const newNCItems = openItems?.newNCs ?? [];

  const [activeTab, setActiveTab] = useState("ncs");
  useEffect(() => {
    if (newThisWeek > 0) setActiveTab("new");
  }, [newThisWeek]);

  // Session 97 (#3 management analytics) — monthly trend series for the Operations
  // section. Raw fetch via useQuery (endpoint isn't in the orval client yet).
  const [trendMonths, setTrendMonths] = useState(6);
  // NC-10 — analytics view toggle. Quality/Admin default to the quality-focused
  // "Overall Quality" view; everyone can switch (a Quality Mgr can still see
  // Operations, and vice versa). null = follow the role default until toggled.
  const [analyticsView, setAnalyticsView] = useState<"operations" | "quality" | null>(null);
  const effectiveAnalyticsView: "operations" | "quality" =
    analyticsView ?? (myQueue.canQuality ? "quality" : "operations");
  // NC-10 — incoming-inspection outcomes for the Overall Quality view.
  const inspectionOutcomes = (allInspections as unknown as { result?: string }[]).reduce(
    (acc, i) => {
      const r = (i.result ?? "").toLowerCase();
      if (r === "pass") acc.pass += 1;
      else if (r === "fail") acc.fail += 1;
      else if (r === "conditional") acc.conditional += 1;
      return acc;
    },
    { pass: 0, fail: 0, conditional: 0 },
  );
  const inspectionDecided = inspectionOutcomes.pass + inspectionOutcomes.fail + inspectionOutcomes.conditional;
  type MgmtTrendPoint = { month: string; qualityOpened: number; qualityClosed: number; batchesMade: number; batchesReleased: number; yieldPct: number | null; consumedByUnit: Record<string, number> };
  type MgmtTrends = { months: number; units: string[]; producedReleasedThisPeriod: number; trend: MgmtTrendPoint[] };
  const { data: mgmt } = useQuery<MgmtTrends>({
    queryKey: ["management-trends", trendMonths],
    queryFn: async () => {
      const r = await fetch(`/api/dashboard/management-trends?months=${trendMonths}`);
      if (!r.ok) throw new Error("Failed to load management trends");
      return r.json();
    },
    refetchInterval: REFETCH_MS,
  });
  // SRS-1 Part 2 — supplier rating changes awaiting Manager/Quality review.
  const canReviewRatings = MGMT_ACK_ROLES.has(meRole);
  const { data: pendingRatingChanges = [] } = useQuery<{ id: number }[]>({
    queryKey: ["supplier-risk-changes", "pending"],
    queryFn: async () => {
      const r = await fetch(`/api/supplier-risk-changes/pending`);
      if (!r.ok) throw new Error("Failed to load pending rating changes");
      return r.json();
    },
    enabled: canReviewRatings,
    refetchInterval: REFETCH_MS,
  });
  // Short "MMM" month label for the axes.
  const mLabel = (m: string) => { const [y, mo] = m.split("-").map(Number); return format(new Date(Date.UTC(y, mo - 1, 1)), "MMM"); };
  const primaryUnit = mgmt?.units?.[0];
  const mgmtData = (mgmt?.trend ?? []).map((p) => ({ ...p, label: mLabel(p.month), consumedPrimary: primaryUnit ? (p.consumedByUnit[primaryUnit] ?? 0) : 0 }));
  const avgYield = (() => {
    const vals = (mgmt?.trend ?? []).map((p) => p.yieldPct).filter((v): v is number => v != null);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  })();

  const {
    ctx: layoutCtx,
    editMode,
    setEditMode,
    save: saveLayout,
    reset: resetLayout,
    cancel: cancelLayout,
    saving: layoutSaving,
  } = useDashboardLayout(meRole);

  return (
    <>
      <DashboardLayoutProvider value={layoutCtx}>
      <div className="flex flex-col gap-6 pb-12">

        {/* ── Header ── */}
        {(() => {
          // Session 22 — time-of-day greeting. Pulls the first token of
          // currentUser.fullName so "Jonathan Schultz" greets as "Jonathan"
          // without exposing the last name unnecessarily.
          const hour = new Date().getHours();
          const partOfDay = hour < 5
            ? "evening"
            : hour < 12
              ? "morning"
              : hour < 17
                ? "afternoon"
                : "evening";
          const firstName = (currentUser?.fullName ?? "").trim().split(/\s+/)[0] ?? "";
          const greeting = firstName
            ? `Good ${partOfDay}, ${firstName}`
            : `Good ${partOfDay}`;
          const today = format(new Date(), "EEEE, MMMM d");
          return (
            <div className="cq-page-heading flex items-start justify-between gap-4">
              <div>
                <span className="cq-eyebrow">YOUR WORKING DAY, IN FOCUS</span>
                <h1 className="cq-dashboard-greeting">{greeting}.</h1>
                <div className="text-muted-foreground text-sm mt-0.5">
                  {today}
                  {lastUpdated && (
                    <span className="ml-2 text-xs">
                      · Updated {lastUpdated}
                    </span>
                  )}
                </div>
              </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleManualRefresh}
            disabled={refreshing}
          >
            <RefreshCw
              className={`h-4 w-4 mr-1.5 ${refreshing ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
          );
        })()}

        {/* ── First-run setup checklist (Session 71, PR 2) — self-hides when
              complete or dismissed ── */}
        <SetupChecklist />

        {/* ── Configurable dashboard controls (2026-07-21) ── */}
        <DashboardEditBar
          editMode={editMode}
          setEditMode={setEditMode}
          save={saveLayout}
          reset={resetLayout}
          cancel={cancelLayout}
          saving={layoutSaving}
          role={meRole}
        />

        {/* ── My Queue (Session 17 — role-based view) ── */}
        <Sec id="my-queue">
        {currentUser && (
          <Card className="border-primary/20 bg-primary/[0.03]">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Inbox className="h-4 w-4 text-primary" />
                My Queue
                <span className="text-xs font-normal text-muted-foreground ml-1">
                  — {myQueue.meName}{myQueue.meRole ? ` · ${myQueue.meRole}` : ""}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {/* Dashboard redesign 2026-08-11 — My Week / My Month: the user's own
                  dated to-dos bucketed by deadline, live per item (see myDeadlines). */}
              <div className="mb-3 grid gap-3 sm:grid-cols-3">
                {[
                  { title: "Overdue", empty: "Nothing overdue.", items: myDeadlines.overdue, Icon: AlertTriangle, tone: "red" as const },
                  { title: "Due this week", empty: "Nothing due this week.", items: myDeadlines.thisWeek, Icon: Clock, tone: "amber" as const },
                  { title: "Due this month", empty: "Nothing due this month.", items: myDeadlines.thisMonth, Icon: ClipboardList, tone: "slate" as const },
                ].map(({ title, empty, items, Icon, tone }) => {
                  const active = items.length > 0;
                  const ring = !active ? "" : tone === "red" ? "border-red-500/70 bg-red-500/10" : tone === "amber" ? "border-amber-500/70 bg-amber-500/10" : "border-slate-500/60 bg-slate-500/10";
                  const numCls = !active ? "" : tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-700" : "text-slate-700";
                  const iconCls = !active ? "text-muted-foreground" : tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : "text-slate-600";
                  return (
                    <div key={title} className={`rounded-lg border bg-card p-3 ${ring}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
                        <Icon className={`h-4 w-4 ${iconCls}`} />
                      </div>
                      <div className={`text-2xl font-bold tabular-nums ${numCls}`}>{items.length}</div>
                      {items.length === 0 ? (
                        <p className="text-xs text-muted-foreground mt-0.5">{empty}</p>
                      ) : (
                        <ul className="mt-1.5 space-y-1">
                          {items.slice(0, 3).map((it) => (
                            <li key={it.key}>
                              <Link href={it.href}>
                                <div className="flex items-center justify-between gap-2 text-xs cursor-pointer hover:underline">
                                  <span className="truncate">{it.label}{it.sub ? ` · ${it.sub}` : ""}</span>
                                  {it.due && <span className="shrink-0 tabular-nums text-muted-foreground">{formatDateOnly(it.due)}</span>}
                                </div>
                              </Link>
                            </li>
                          ))}
                          {items.length > 3 && (
                            <li className="text-xs text-muted-foreground">+{items.length - 3} more</li>
                          )}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">

                {/* Awaiting my approval — Supervisor+ only */}
                {myQueue.canApprove && (
                  <Link href="/capas?queue=awaiting_approval">
                    <div className={`rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer ${myQueue.awaitingMyApproval.length > 0 ? "border-amber-500/70 bg-amber-500/10" : ""}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Awaiting my approval
                        </span>
                        <ShieldQuestion className={`h-4 w-4 ${myQueue.awaitingMyApproval.length > 0 ? "text-amber-600" : "text-muted-foreground"}`} />
                      </div>
                      {capasLoading ? (
                        <Skeleton className="h-7 w-10" />
                      ) : (
                        <div className={`text-2xl font-bold tabular-nums ${myQueue.awaitingMyApproval.length > 0 ? "text-amber-700" : ""}`}>
                          {myQueue.awaitingMyApproval.length}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {myQueue.awaitingMyApproval.length === 0
                          ? "No CAPAs awaiting your sign-off."
                          : `Gate 1 / Gate 2 sign-off needed${CLOSURE_ROLES.has(myQueue.meRole) ? " (incl. closures)" : ""}.`}
                      </p>
                    </div>
                  </Link>
                )}

                {/* My CAPAs as originator */}
                <Link href="/capas?queue=mine">
                  <div className={`rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer ${myQueue.mineAsOriginator.length > 0 ? "border-blue-500/70 bg-blue-500/10" : ""}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        My CAPAs (originator)
                      </span>
                      <ClipboardList className={`h-4 w-4 ${myQueue.mineAsOriginator.length > 0 ? "text-blue-600" : "text-muted-foreground"}`} />
                    </div>
                    {capasLoading ? (
                      <Skeleton className="h-7 w-10" />
                    ) : (
                      <div className={`text-2xl font-bold tabular-nums ${myQueue.mineAsOriginator.length > 0 ? "text-blue-700" : ""}`}>
                        {myQueue.mineAsOriginator.length}
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {myQueue.mineAsOriginator.length === 0
                        ? "No open CAPAs where you're the originator."
                        : "Open CAPAs you opened — track their progress."}
                    </p>
                  </div>
                </Link>

                {/* CAPAs where I'm EC Owner */}
                <Link href="/capas?queue=ec_owner">
                  <div className={`rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer ${myQueue.mineAsEcOwner.length > 0 ? "border-indigo-500/70 bg-indigo-500/10" : ""}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        EC Owner duties
                      </span>
                      <UserCheck className={`h-4 w-4 ${myQueue.mineAsEcOwner.length > 0 ? "text-indigo-600" : "text-muted-foreground"}`} />
                    </div>
                    {capasLoading ? (
                      <Skeleton className="h-7 w-10" />
                    ) : (
                      <div className={`text-2xl font-bold tabular-nums ${myQueue.mineAsEcOwner.length > 0 ? "text-indigo-700" : ""}`}>
                        {myQueue.mineAsEcOwner.length}
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {myQueue.mineAsEcOwner.length === 0
                        ? "No CAPAs awaiting your EC plan or results."
                        : "CAPAs where you own the effectiveness check."}
                    </p>
                  </div>
                </Link>

                {/* My action items (Session 18) */}
                <Link href="/capas?queue=action_assignee">
                  <div className={`rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer ${myActionItems.length > 0 ? "border-purple-500/70 bg-purple-500/10" : ""}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        My action items
                      </span>
                      <ClipboardCheck className={`h-4 w-4 ${myActionItems.length > 0 ? "text-purple-600" : "text-muted-foreground"}`} />
                    </div>
                    {actionItemsLoading ? (
                      <Skeleton className="h-7 w-10" />
                    ) : (
                      <div className={`text-2xl font-bold tabular-nums ${myActionItems.length > 0 ? "text-purple-700" : ""}`}>
                        {myActionItems.length}
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {myActionItems.length === 0
                        ? "No open CAPA action items assigned to you."
                        : "Open CAPA actions where you're the assignee."}
                    </p>
                  </div>
                </Link>

                {/* NC-2 — NC correction tasks assigned to me (owner). Mirrors the
                    CAPA "My action items" tile so NC correction owners see their
                    work on login. */}
                <Link href="/non-conformances">
                  <div className={`rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer ${myNcCorrections.length > 0 ? "border-teal-500/70 bg-teal-500/10" : ""}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        My NC corrections
                      </span>
                      <Wrench className={`h-4 w-4 ${myNcCorrections.length > 0 ? "text-teal-600" : "text-muted-foreground"}`} />
                    </div>
                    <div className={`text-2xl font-bold tabular-nums ${myNcCorrections.length > 0 ? "text-teal-700" : ""}`}>
                      {myNcCorrections.length}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {myNcCorrections.length === 0
                        ? "No open NC correction tasks assigned to you."
                        : "Open NC correction tasks where you're the owner."}
                    </p>
                  </div>
                </Link>

                {/* Session 62.2 — complaint correction tasks assigned to me.
                    Same tile as NC corrections, different parent record. */}
                <Link href="/complaints">
                  <div className={`rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer ${myComplaintCorrections.length > 0 ? "border-teal-500/70 bg-teal-500/10" : ""}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        My complaint corrections
                      </span>
                      <Wrench className={`h-4 w-4 ${myComplaintCorrections.length > 0 ? "text-teal-600" : "text-muted-foreground"}`} />
                    </div>
                    <div className={`text-2xl font-bold tabular-nums ${myComplaintCorrections.length > 0 ? "text-teal-700" : ""}`}>
                      {myComplaintCorrections.length}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {myComplaintCorrections.length === 0
                        ? "No open complaint correction tasks assigned to you."
                        : "Open complaint correction tasks where you're the owner."}
                    </p>
                  </div>
                </Link>

                {/* Documents waiting on MY signature — as assigned Reviewer, or as
                    assigned Approver once the review is signed. */}
                <Link href="/documents">
                  <div className={`rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer ${myPendingSignatures.length > 0 ? "border-purple-500/70 bg-purple-500/10" : ""}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Documents to review
                      </span>
                      <Link2 className={`h-4 w-4 ${myPendingSignatures.length > 0 ? "text-purple-600" : "text-muted-foreground"}`} />
                    </div>
                    <div className={`text-2xl font-bold tabular-nums ${myPendingSignatures.length > 0 ? "text-purple-700" : ""}`}>
                      {myPendingSignatures.length}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {myPendingSignatures.length === 0
                        ? "Nothing waiting on your signature."
                        : (() => {
                            const toReview = myPendingSignatures.filter((d) => d.action === "review").length;
                            const toApprove = myPendingSignatures.length - toReview;
                            const parts: string[] = [];
                            if (toReview) parts.push(`${toReview} to review`);
                            if (toApprove) parts.push(`${toApprove} to approve`);
                            return `${parts.join(", ")} — awaiting your signature.`;
                          })()}
                    </p>
                  </div>
                </Link>

                {/* Impact mgmt step 3 — Approved docs that reference a document
                    approved more recently; a review is recommended. */}
                <Link href="/documents">
                  <div className={`rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer ${myReviewRecs.length > 0 ? "border-purple-500/70 bg-purple-500/10" : ""}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Reviews recommended
                      </span>
                      <Link2 className={`h-4 w-4 ${myReviewRecs.length > 0 ? "text-purple-600" : "text-muted-foreground"}`} />
                    </div>
                    <div className={`text-2xl font-bold tabular-nums ${myReviewRecs.length > 0 ? "text-purple-700" : ""}`}>
                      {myReviewRecs.length}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {myReviewRecs.length === 0
                        ? "No documents need review from a referenced change."
                        : "A referenced document was revised after this one — review it."}
                    </p>
                  </div>
                </Link>

                {/* Awaiting disposition (Session 24) — Supervisor+ only.
                    Major / Critical NCs that are open and don't yet have a
                    disposition. Comes before mgmt ack in the QMS workflow:
                    disposition decision → mgmt ack → close. */}
                {myQueue.canApprove && (
                  <Link href="/non-conformances?queue=needs_disposition">
                    <div className={`rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer ${myQueue.awaitingDisposition.length > 0 ? "border-orange-500/70 bg-orange-500/10" : ""}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Awaiting disposition
                        </span>
                        <Scale className={`h-4 w-4 ${myQueue.awaitingDisposition.length > 0 ? "text-orange-600" : "text-muted-foreground"}`} />
                      </div>
                      {ncsLoading ? (
                        <Skeleton className="h-7 w-10" />
                      ) : (
                        <div className={`text-2xl font-bold tabular-nums ${myQueue.awaitingDisposition.length > 0 ? "text-orange-700" : ""}`}>
                          {myQueue.awaitingDisposition.length}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {myQueue.awaitingDisposition.length === 0
                          ? "All Major / Critical NCs have a disposition."
                          : "Major / Critical NCs awaiting your disposition call."}
                      </p>
                    </div>
                  </Link>
                )}

                {/* Inspection rationale (Session 26) — Supervisor+ only.
                    Incoming inspections in "Conditional" state needing a
                    Supervisor+ judgment call: approve a Pass with rationale,
                    confirm a Fail, or hold longer. Server enforces Part 11
                    sign-off at the Pass-with-failures transition itself. */}
                {myQueue.canApprove && (
                  <Link href="/inspections?queue=needs_rationale">
                    <div className={`rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer ${myQueue.inspectionsNeedingRationale.length > 0 ? "border-yellow-500/70 bg-yellow-500/10" : ""}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Inspection rationale
                        </span>
                        <FlaskConical className={`h-4 w-4 ${myQueue.inspectionsNeedingRationale.length > 0 ? "text-yellow-600" : "text-muted-foreground"}`} />
                      </div>
                      {inspectionsLoading ? (
                        <Skeleton className="h-7 w-10" />
                      ) : (
                        <div className={`text-2xl font-bold tabular-nums ${myQueue.inspectionsNeedingRationale.length > 0 ? "text-yellow-700" : ""}`}>
                          {myQueue.inspectionsNeedingRationale.length}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {myQueue.inspectionsNeedingRationale.length === 0
                          ? "No Conditional inspections awaiting review."
                          : "Conditional inspections awaiting your sign-off."}
                      </p>
                    </div>
                  </Link>
                )}

                {/* NC mgmt-acknowledgement queue (Session 18) — Manager+ only */}
                {myQueue.canMgmtAck && (
                  <Link href="/non-conformances?queue=mgmt_ack">
                    <div className={`rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer ${myQueue.ncMgmtAckQueue.length > 0 ? "border-rose-500/70 bg-rose-500/10" : ""}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          NCs awaiting mgmt ack
                        </span>
                        <AlertTriangle className={`h-4 w-4 ${myQueue.ncMgmtAckQueue.length > 0 ? "text-rose-600" : "text-muted-foreground"}`} />
                      </div>
                      {ncsLoading ? (
                        <Skeleton className="h-7 w-10" />
                      ) : (
                        <div className={`text-2xl font-bold tabular-nums ${myQueue.ncMgmtAckQueue.length > 0 ? "text-rose-700" : ""}`}>
                          {myQueue.ncMgmtAckQueue.length}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {myQueue.ncMgmtAckQueue.length === 0
                          ? "All Major / Critical NCs are acknowledged."
                          : "Major / Critical NCs blocking closure."}
                      </p>
                    </div>
                  </Link>
                )}

                {/* SRS-1 Part 2 — supplier rating changes awaiting review. */}
                {canReviewRatings && (
                  <Link href="/suppliers">
                    <div className={`rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer ${pendingRatingChanges.length > 0 ? "border-violet-500/70 bg-violet-500/10" : ""}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Supplier rating changes
                        </span>
                        <ShieldAlert className={`h-4 w-4 ${pendingRatingChanges.length > 0 ? "text-violet-600" : "text-muted-foreground"}`} />
                      </div>
                      <div className={`text-2xl font-bold tabular-nums ${pendingRatingChanges.length > 0 ? "text-violet-700" : ""}`}>
                        {pendingRatingChanges.length}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {pendingRatingChanges.length === 0
                          ? "No rating changes awaiting review."
                          : "Awaiting Manager / Quality review."}
                      </p>
                    </div>
                  </Link>
                )}

                {/* NC-9 — Quality awareness. Quality (and Admin) see recent NC
                    activity (created or closed in the last 7 days), including
                    events others handled, so nothing slips by unnoticed. */}
                {myQueue.canQuality && (
                  <Link href="/non-conformances">
                    <div className={`rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer ${myQueue.recentQualityEvents.length > 0 ? "border-sky-500/70 bg-sky-500/10" : ""}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Quality events (7d)
                        </span>
                        <Activity className={`h-4 w-4 ${myQueue.recentQualityEvents.length > 0 ? "text-sky-600" : "text-muted-foreground"}`} />
                      </div>
                      {ncsLoading ? (
                        <Skeleton className="h-7 w-10" />
                      ) : (
                        <div className={`text-2xl font-bold tabular-nums ${myQueue.recentQualityEvents.length > 0 ? "text-sky-700" : ""}`}>
                          {myQueue.recentQualityEvents.length}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {myQueue.recentQualityEvents.length === 0
                          ? "No NCs opened or closed in the last 7 days."
                          : "NCs opened or closed in the last 7 days (all owners)."}
                      </p>
                    </div>
                  </Link>
                )}

                {/* Supplier re-qualification (Session 26) — Supervisor+ only.
                    Aggregates the overdue + due-soon counts already computed
                    above for the standalone widget so the Supervisor sees the
                    backlog count at a glance from My Queue. Deep-links to a
                    pre-filtered /suppliers list. */}
                {myQueue.canApprove && (() => {
                  const totalBacklog = suppliersOverdue.length + suppliersDueSoon.length;
                  const hasOverdue = suppliersOverdue.length > 0;
                  return (
                    <Link href="/suppliers?queue=requal_needed">
                      <div className={`rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer ${hasOverdue ? "border-red-500/70 bg-red-500/10" : totalBacklog > 0 ? "border-amber-500/70 bg-amber-500/10" : ""}`}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Supplier re-qual
                          </span>
                          <Truck className={`h-4 w-4 ${hasOverdue ? "text-red-600" : totalBacklog > 0 ? "text-amber-600" : "text-muted-foreground"}`} />
                        </div>
                        {suppliersLoading ? (
                          <Skeleton className="h-7 w-10" />
                        ) : (
                          <div className={`text-2xl font-bold tabular-nums ${hasOverdue ? "text-red-700" : totalBacklog > 0 ? "text-amber-700" : ""}`}>
                            {totalBacklog}
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {totalBacklog === 0
                            ? "All suppliers within their review window."
                            : hasOverdue
                            ? `${suppliersOverdue.length} overdue${suppliersDueSoon.length > 0 ? ` · ${suppliersDueSoon.length} due soon` : ""}.`
                            : `${suppliersDueSoon.length} due within 90 days.`}
                        </p>
                      </div>
                    </Link>
                  );
                })()}
                {myQueue.canApprove && (() => {
                  const licenseFlagged = allSuppliers.filter((s) => {
                    const lc = (s as { licenseCompliance?: string | null }).licenseCompliance;
                    return lc === "missing" || lc === "expired";
                  });
                  if (licenseFlagged.length === 0) return null;
                  return (
                    <Link href="/suppliers?queue=license_alert">
                      <div className="rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer border-red-500/70 bg-red-500/10">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Supplier licenses
                          </span>
                          <Truck className="h-4 w-4 text-red-600" />
                        </div>
                        {suppliersLoading ? (
                          <Skeleton className="h-7 w-10" />
                        ) : (
                          <div className="text-2xl font-bold tabular-nums text-red-700">
                            {licenseFlagged.length}
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Missing or expired required license/certificate.
                        </p>
                      </div>
                    </Link>
                  );
                })()}
                {MGMT_ACK_ROLES.has(meRole) && recentlyEffective.length > 0 && (
                  <Link href="/documents?status=Effective">
                    <div className="rounded-lg border bg-card p-3 hover:shadow-md transition-shadow cursor-pointer border-emerald-500/70 bg-emerald-500/10">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Recently effective
                        </span>
                        <FileText className="h-4 w-4 text-emerald-600" />
                      </div>
                      <div className="text-2xl font-bold tabular-nums text-emerald-700">
                        {recentlyEffective.length}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Became effective in the last 14 days — reprint controlled copies.
                      </p>
                    </div>
                  </Link>
                )}
              </div>

              {/* Approver-only inline list */}
              {myQueue.canApprove && myQueue.awaitingMyApproval.length > 0 && (
                <div className="mt-3 rounded-md border bg-card">
                  <div className="px-3 py-1.5 border-b bg-muted/40">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Next up for your sign-off
                    </p>
                  </div>
                  <div className="divide-y">
                    {myQueue.awaitingMyApproval.slice(0, 5).map((c) => (
                      <Link key={c.id} href={`/capas/${c.id}`}>
                        <div className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 transition-colors cursor-pointer text-sm">
                          <span className="text-xs font-mono font-semibold text-primary">{c.capaNumber}</span>
                          <span className="truncate flex-1 text-muted-foreground">{c.title}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${capaStatusColor(c.stage ?? c.status)}`}>
                            {c.stage === "Planning" ? "Gate 1" : c.stage === "EC Execution" ? "Gate 2" : c.stage ?? c.status}
                          </span>
                        </div>
                      </Link>
                    ))}
                    {myQueue.awaitingMyApproval.length > 5 && (
                      <div className="px-3 py-1.5 text-xs text-muted-foreground">
                        +{myQueue.awaitingMyApproval.length - 5} more on the CAPAs page.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {!myQueue.canApprove && (
                <p className="text-xs text-muted-foreground mt-3 italic">
                  Operator role — approval queues are not shown. Promote to Supervisor+ in Settings to see CAPAs awaiting sign-off.
                </p>
              )}
            </CardContent>
          </Card>
        )}
        </Sec>

        {/* ── KPI tiles, grouped into labeled sections (Session 97, #3 Phase A).
            Was two flat unlabeled grids; now Production / Quality / Supplier &
            Compliance so each role finds its metrics at a glance. Same tiles,
            same data — regrouped only. ── */}

        {/* Production */}
        {/* QMS Health strip removed 2026-08-11 — it duplicated the live Quality
            tiles and its snapshot-sourced counts drifted from them. Its unique
            cross-domain signals (licenses, expiring inventory, training, docs,
            regulatory) return as live per-page widgets in the dashboard redesign. */}

        <Sec id="production-pipeline">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Factory className="h-4 w-4 text-primary" /> Production Pipeline
                <span className="ml-1 text-xs font-normal text-muted-foreground">— {productionPipeline.inFlight} in flight</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {batchesLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {productionPipeline.stages.map((st) => (
                      <Link key={st.key} href="/batches">
                        <div className={`rounded-lg border bg-card p-3 text-center transition-shadow hover:shadow-md cursor-pointer ${st.count > 0 ? "" : "opacity-70"}`}>
                          <div className="text-2xl font-bold tabular-nums">{st.count}</div>
                          <div className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">{st.label}</div>
                        </div>
                      </Link>
                    ))}
                  </div>
                  {productionPipeline.attention.length > 0 && (
                    <div className="mt-3 space-y-1">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Needs attention</p>
                      {productionPipeline.attention.map((b) => (
                        <Link key={b.id} href={`/batches/${b.id}`}>
                          <div className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-sm hover:bg-muted/40 cursor-pointer">
                            <span className="truncate"><span className="font-mono text-xs">{b.batchNumber}</span> · {b.product}</span>
                            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-semibold ${b.tone === "red" ? "border-red-300 bg-red-100 text-red-800" : "border-amber-300 bg-amber-100 text-amber-800"}`}>{b.label}</span>
                          </div>
                        </Link>
                      ))}
                    </div>
                  )}
                  <Link href="/batches" className="mt-3 inline-block text-xs text-primary hover:underline">Open Batches →</Link>
                </>
              )}
            </CardContent>
          </Card>
        </Sec>

        <Sec id="team-actions">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-primary" /> Team Actions
                <span className="ml-1 text-xs font-normal text-muted-foreground">— {teamActions.depts.length > 0 ? teamActions.depts.join(", ") : "all departments"}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {capasLoading || ncsLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Open CAPAs</span>
                      <span className="text-lg font-bold tabular-nums">{teamActions.openCapas.length}</span>
                    </div>
                    {teamActions.openCapas.length === 0 ? (
                      <p className="text-xs text-muted-foreground">None open for your team.</p>
                    ) : (
                      <ul className="space-y-1">
                        {teamActions.openCapas.slice(0, 5).map((c) => (
                          <li key={c.id}>
                            <Link href={`/capas/${c.id}`}>
                              <div className="flex items-center gap-2 text-xs hover:underline cursor-pointer">
                                <span className="shrink-0 font-mono text-primary">{c.capaNumber}</span>
                                <span className="truncate text-muted-foreground">{c.title}</span>
                              </div>
                            </Link>
                          </li>
                        ))}
                        {teamActions.openCapas.length > 5 && <li className="text-xs text-muted-foreground">+{teamActions.openCapas.length - 5} more</li>}
                      </ul>
                    )}
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Open NCs</span>
                      <span className="text-lg font-bold tabular-nums">{teamActions.openNcs.length}</span>
                    </div>
                    {teamActions.openNcs.length === 0 ? (
                      <p className="text-xs text-muted-foreground">None open for your team.</p>
                    ) : (
                      <ul className="space-y-1">
                        {teamActions.openNcs.slice(0, 5).map((n) => (
                          <li key={n.id}>
                            <Link href={`/non-conformances/${n.id}`}>
                              <div className="flex items-center gap-2 text-xs hover:underline cursor-pointer">
                                <span className="shrink-0 font-mono text-primary">{n.ncNumber}</span>
                                <span className="truncate text-muted-foreground">{n.title}</span>
                              </div>
                            </Link>
                          </li>
                        ))}
                        {teamActions.openNcs.length > 5 && <li className="text-xs text-muted-foreground">+{teamActions.openNcs.length - 5} more</li>}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </Sec>

        <Sec id="inventory-on-hand">
          <Card className={inventoryLoading ? "" : lowStockCount > 0 ? "border-red-200 bg-red-50/20" : approachingCount > 0 ? "border-amber-200 bg-amber-50/20" : ""}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Package className="h-4 w-4 text-primary" /> Inventory On Hand
                {lowStockCount > 0 && (
                  <span className="ml-1 rounded-full border border-red-200 bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">{lowStockCount} to reorder</span>
                )}
                {approachingCount > 0 && (
                  <span className="ml-1 rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">{approachingCount} low soon</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {inventoryLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : inventoryOnHand.length === 0 ? (
                <p className="text-sm text-muted-foreground">No inventory items yet.</p>
              ) : (
                <>
                  <div className="divide-y">
                    {inventoryOnHand.slice(0, 8).map((it) => (
                      <div key={it.id} className="flex items-center justify-between gap-3 py-1.5">
                        <span className="truncate text-sm">{it.itemName}</span>
                        <div className="flex shrink-0 items-center gap-2 text-sm">
                          <span className={`tabular-nums ${it.low ? "font-semibold text-red-700" : it.approaching ? "font-semibold text-amber-700" : ""}`}>{it.quantity}{it.unit ? ` ${it.unit}` : ""}</span>
                          <span className="tabular-nums text-[11px] text-muted-foreground">reorder {it.reorderPoint != null ? it.reorderPoint : "—"}</span>
                          {it.low ? (
                            <span className="rounded border border-red-300 bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-800">Reorder</span>
                          ) : it.approaching ? (
                            <span className="rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">Low soon</span>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                  {inventoryOnHand.length > 8 && (
                    <p className="mt-2 text-xs text-muted-foreground">+{inventoryOnHand.length - 8} more items</p>
                  )}
                  <Link href="/inventory" className="mt-3 inline-block text-xs text-primary hover:underline">Open Inventory →</Link>
                </>
              )}
            </CardContent>
          </Card>
        </Sec>

        <Sec id="finished-goods">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Truck className="h-4 w-4 text-primary" /> Finished Goods On Hand
                <span className="ml-1 text-xs font-normal text-muted-foreground">— {finishedGoodsOnHand.length} lot{finishedGoodsOnHand.length === 1 ? "" : "s"}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {batchesLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : finishedGoodsSorted.length === 0 ? (
                <p className="text-sm text-muted-foreground">No released or finished-goods batches on hand.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                        {([
                          ["product", "Product / Strain", "text-left"],
                          ["strain", "Type", "text-center"],
                          ["qty", "Qty", "text-right"],
                          ["produced", "Produced", "text-right"],
                          ["expires", "Expires", "text-right"],
                        ] as const).map(([k, label, align]) => (
                          <th
                            key={k}
                            className={`cursor-pointer select-none px-2 py-1.5 font-semibold ${align} hover:text-foreground`}
                            onClick={() => setFgSort((prev) => ({ key: k, dir: prev.key === k && prev.dir === "asc" ? "desc" : "asc" }))}
                          >
                            {label}{fgSort.key === k ? (fgSort.dir === "asc" ? " ▲" : " ▼") : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {finishedGoodsSorted.slice(0, 12).map((r) => {
                        const sb = strainBadge(r.strainType);
                        return (
                          <tr key={r.id} className="border-t">
                            <td className="px-2 py-1.5">
                              <span className="font-medium">{r.strainName || r.product}</span>
                              {r.strainName && r.product !== r.strainName ? <span className="text-muted-foreground"> · {r.product}</span> : null}
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              {sb ? <span className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold ${sb.cls}`}>{sb.label}</span> : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{r.quantity ?? "—"}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.produced ? formatDateOnly(r.produced) : "—"}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{r.expires ? formatDateOnly(r.expires) : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {finishedGoodsSorted.length > 12 && (
                    <p className="mt-2 text-xs text-muted-foreground">+{finishedGoodsSorted.length - 12} more lots</p>
                  )}
                  <Link href="/finished-goods" className="mt-3 inline-block text-xs text-primary hover:underline">Open Finished Goods →</Link>
                </div>
              )}
            </CardContent>
          </Card>
        </Sec>

        <Sec id="kpi-production">
        <div className="space-y-3">
          <div className="flex items-baseline gap-3">
            <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
              <Factory className="h-4 w-4 text-blue-500" /> Production
            </h2>
            <p className="text-xs text-muted-foreground">Batches, testing, and packaging in flight.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile
              label="In Production"
              value={summary?.batchesInProduction}
              icon={Factory}
              href="/batches"
              loading={summaryLoading}
              accent="blue"
            />
            <KpiTile
              label="Testing / Awaiting Packaging"
              value={summary?.batchesPendingRelease}
              sub={
                (summary?.batchesPendingRelease ?? 0) > 0
                  ? "Pending QC release"
                  : undefined
              }
              icon={ClipboardCheck}
              href="/batches"
              loading={summaryLoading}
              accent={
                (summary?.batchesPendingRelease ?? 0) > 0 ? "amber" : "slate"
              }
            />
            <KpiTile
              label="Packaging for Review"
              value={summary?.packagingPendingReview}
              sub={
                (summary?.packagingPendingReview ?? 0) > 0
                  ? "Awaiting approval"
                  : undefined
              }
              icon={Package}
              href="/packaging"
              loading={summaryLoading}
              accent={
                (summary?.packagingPendingReview ?? 0) > 0 ? "amber" : "slate"
              }
            />
          </div>
        </div>
        </Sec>

        {/* Open Inspections (new, 2026-07-21) */}
        <Sec id="open-inspections"><OpenInspectionsCard /></Sec>

        {/* Quality */}
        <Sec id="testing-summary">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FlaskConical className="h-4 w-4 text-primary" /> Testing
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Link href="/batches?status=testing_in_progress">
                  <div className="rounded-lg border bg-card p-3 transition-shadow hover:shadow-md cursor-pointer">
                    <div className="text-2xl font-bold tabular-nums">{pendingCoasCount}</div>
                    <div className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">In testing</div>
                    <p className="text-[10px] text-muted-foreground">awaiting result</p>
                  </div>
                </Link>
                <Link href="/batches?status=in_inventory_untested">
                  <div className="rounded-lg border bg-card p-3 transition-shadow hover:shadow-md cursor-pointer">
                    <div className={`text-2xl font-bold tabular-nums ${untestedCount > 0 ? "text-amber-700" : ""}`}>{untestedCount}</div>
                    <div className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">Untested</div>
                    <p className="text-[10px] text-muted-foreground">awaiting test</p>
                  </div>
                </Link>
                <div className="rounded-lg border bg-card p-3">
                  <div className="text-2xl font-bold tabular-nums">{testingMetricsLoading ? "…" : testingMetrics?.avgTurnaroundDays != null ? `${testingMetrics.avgTurnaroundDays}d` : "—"}</div>
                  <div className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">Avg turnaround</div>
                  <p className="text-[10px] text-muted-foreground">pulled → result, 90d</p>
                </div>
                <div className="rounded-lg border bg-card p-3">
                  {(() => {
                    const pass = testingMetrics?.passCount ?? 0;
                    const fail = testingMetrics?.failCount ?? 0;
                    const total = pass + fail;
                    const pct = total > 0 ? Math.round((pass / total) * 100) : null;
                    return (
                      <>
                        <div className={`text-2xl font-bold tabular-nums ${pct != null && pct < 100 ? "text-amber-700" : ""}`}>{pct != null ? `${pct}%` : "—"}</div>
                        <div className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">Pass rate</div>
                        <p className="text-[10px] text-muted-foreground">{total > 0 ? `${pass} pass · ${fail} fail, 90d` : "no results, 90d"}</p>
                      </>
                    );
                  })()}
                </div>
              </div>
            </CardContent>
          </Card>
        </Sec>

        <Sec id="kpi-quality">
        <div className="space-y-3">
          <div className="flex items-baseline gap-3">
            <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-emerald-600" /> Quality
            </h2>
            <p className="text-xs text-muted-foreground">Non-conformances, complaints, CAPAs, training, and documents.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile
              label="Open Non-Conformances"
              value={ncCount}
              sub={
                critNcCount > 0
                  ? `${critNcCount} Critical`
                  : ncCount > 0
                    ? "No critical"
                    : undefined
              }
              subAlert={critNcCount > 0}
              icon={AlertTriangle}
              href="/non-conformances?status=open"
              loading={summaryLoading}
              accent={
                critNcCount > 0 ? "red" : ncCount > 0 ? "orange" : "slate"
              }
            />
            <KpiTile
              label="Open Complaints"
              value={complaintCount}
              sub={
                critComplaintCount > 0
                  ? `${critComplaintCount} Critical/High`
                  : complaintCount > 0
                    ? "No critical"
                    : undefined
              }
              subAlert={critComplaintCount > 0}
              icon={MessageSquareWarning}
              href="/complaints?status=open"
              loading={summaryLoading}
              accent={
                critComplaintCount > 0
                  ? "red"
                  : complaintCount > 0
                    ? "orange"
                    : "slate"
              }
            />
            <KpiTile
              label="Open CAPAs"
              value={capaCount}
              sub={
                overdueCapaItems > 0
                  ? `${overdueCapaItems} action${overdueCapaItems > 1 ? "s" : ""} overdue`
                  : capaCount > 0
                    ? "All actions on track"
                    : undefined
              }
              subAlert={overdueCapaItems > 0}
              icon={ClipboardList}
              href="/capas?status=open"
              loading={summaryLoading}
              accent={overdueCapaItems > 0 ? "red" : capaCount > 0 ? "amber" : "slate"}
            />
            <KpiTile
              label="New This Week"
              value={newThisWeek}
              sub={
                newAdverseEvents > 0
                  ? `${newAdverseEvents} adverse event${newAdverseEvents > 1 ? "s" : ""}${newNCs > 0 ? ` · ${newNCs} NC${newNCs > 1 ? "s" : ""}` : ""}`
                  : newNCs > 0
                    ? `${newNCs} NC${newNCs > 1 ? "s" : ""} opened`
                    : "No new items"
              }
              subAlert={newAdverseEvents > 0}
              icon={Flame}
              href="#"
              loading={summaryLoading}
              accent={newAdverseEvents > 0 ? "red" : newNCs > 0 ? "amber" : "slate"}
              onClick={() => setActiveTab("new")}
            />
            <KpiTile
              label="CAPA Effectiveness"
              value={capaEffectivenessOverdue}
              sub={
                capaEffectivenessOverdue > 0
                  ? `${capaEffectivenessOverdue} overdue · ${capaEffectivenessApproaching} due in 14 days`
                  : capaEffectivenessApproaching > 0
                    ? `${capaEffectivenessApproaching} due within 14 days`
                    : "No checks pending"
              }
              subAlert={capaEffectivenessOverdue > 0}
              icon={FlaskConical}
              href="/capas"
              loading={summaryLoading}
              accent={
                capaEffectivenessOverdue > 0
                  ? "red"
                  : capaEffectivenessApproaching > 0
                    ? "amber"
                    : "slate"
              }
            />
            <KpiTile
              label="My Training"
              value={myTraining.total}
              sub={
                myTraining.total === 0
                  ? "You're all caught up"
                  : myTraining.overdue > 0 && myTraining.comingDue > 0
                    ? `${myTraining.overdue} overdue · ${myTraining.comingDue} due soon`
                    : myTraining.overdue > 0
                      ? `${myTraining.overdue} overdue`
                      : myTraining.comingDue > 0
                        ? `${myTraining.comingDue} due within 30 days`
                        // Open, but neither overdue nor due soon — e.g. no due date set.
                        : `${myTraining.total} assigned`
              }
              subAlert={myTraining.overdue > 0}
              icon={GraduationCap}
              href="/training?scope=mine"
              loading={summaryLoading}
              accent={myTraining.overdue > 0 ? "red" : myTraining.comingDue > 0 ? "amber" : "green"}
            />
            <KpiTile
              label="Docs Under Review"
              value={documentsUnderReview}
              sub={
                documentsUnderReview > 0
                  ? `${approvedDocuments} approved in system`
                  : approvedDocuments > 0
                    ? `${approvedDocuments} approved — none pending`
                    : "No documents yet"
              }
              subAlert={false}
              icon={FileText}
              href="/documents?status=Under%20Review"
              loading={summaryLoading}
              accent={documentsUnderReview > 0 ? "amber" : approvedDocuments > 0 ? "green" : "slate"}
            />
          </div>
        </div>
        </Sec>

        {/* License Renewals (new, 2026-07-21) */}
        <Sec id="license-renewals"><LicenseRenewalsCard /></Sec>
        <Sec id="compliance"><ComplianceCard /></Sec>

        {/* Supplier & Compliance */}
        <Sec id="kpi-supplier-compliance">
        <div className="space-y-3">
          <div className="flex items-baseline gap-3">
            <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
              <Truck className="h-4 w-4 text-orange-500" /> Supplier &amp; Compliance
            </h2>
            <p className="text-xs text-muted-foreground">Field actions, supplier qualifications, and re-qualification status.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile
              label="Open Field Actions"
              value={faCount}
              sub={faCount > 0 ? "CRA notification may apply" : undefined}
              subAlert={faCount > 0}
              icon={ShieldAlert}
              href="/field-actions?status=open"
              loading={summaryLoading}
              accent={faCount > 0 ? "red" : "slate"}
            />
            <KpiTile
              label="Approved Supplier Quals"
              value={approvedSupplierQuals}
              sub={
                expiredSupplierQuals > 0
                  ? `${expiredSupplierQuals} expired — re-qualification needed`
                  : approvedSupplierQuals > 0
                    ? "All current — no expirations"
                    : "No qualifications recorded"
              }
              subAlert={expiredSupplierQuals > 0}
              icon={ShieldCheck}
              href="/supplier-qualification"
              loading={summaryLoading}
              accent={expiredSupplierQuals > 0 ? "orange" : approvedSupplierQuals > 0 ? "green" : "slate"}
            />
            <KpiTile
              label="Re-qual Overdue"
              value={suppliersOverdue.length}
              sub={
                suppliersOverdue.length > 0
                  ? "ISO 13485 §7.4 — action required"
                  : "All suppliers current"
              }
              subAlert={suppliersOverdue.length > 0}
              icon={Truck}
              href="/suppliers"
              loading={suppliersLoading}
              accent={suppliersOverdue.length > 0 ? "red" : "green"}
            />
            <KpiTile
              label="Re-qual Due (90 days)"
              value={suppliersDueSoon.length}
              sub={
                suppliersDueSoon.length > 0
                  ? `${suppliersDueSoon.length} review${suppliersDueSoon.length > 1 ? "s" : ""} approaching`
                  : "No upcoming reviews"
              }
              subAlert={false}
              icon={Truck}
              href="/suppliers"
              loading={suppliersLoading}
              accent={suppliersDueSoon.length > 0 ? "amber" : "slate"}
            />
          </div>
        </div>
        </Sec>

        {/* ── Middle row: Open Items + Batch Breakdown ── */}
        <Sec id="open-items">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Open Items — 2/3 width */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-orange-500" />
                  Open Items Requiring Attention
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Tabs value={activeTab} onValueChange={setActiveTab}>
                  <TabsList className="mx-4 mb-0 mt-0">
                    <TabsTrigger value="new" className="text-xs">
                      New This Week
                      {newThisWeek > 0 && (
                        <span className={`ml-1.5 rounded-full text-xs px-1.5 py-0.5 font-semibold ${newAdverseEvents > 0 ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                          {newThisWeek}
                        </span>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="ncs" className="text-xs">
                      Non-Conformances
                      {openNCs.length > 0 && (
                        <span className="ml-1.5 rounded-full bg-red-100 text-red-700 text-xs px-1.5 py-0.5 font-semibold">
                          {openNCs.length}
                        </span>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="complaints" className="text-xs">
                      Complaints
                      {openComplaints.length > 0 && (
                        <span className="ml-1.5 rounded-full bg-orange-100 text-orange-700 text-xs px-1.5 py-0.5 font-semibold">
                          {openComplaints.length}
                        </span>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="fas" className="text-xs">
                      Field Actions
                      {openFAs.length > 0 && (
                        <span className="ml-1.5 rounded-full bg-red-100 text-red-700 text-xs px-1.5 py-0.5 font-semibold">
                          {openFAs.length}
                        </span>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="capas" className="text-xs">
                      CAPAs
                      {openCapas.length > 0 && (
                        <span className="ml-1.5 rounded-full bg-amber-100 text-amber-700 text-xs px-1.5 py-0.5 font-semibold">
                          {openCapas.length}
                        </span>
                      )}
                    </TabsTrigger>
                  </TabsList>

                  {/* New This Week */}
                  <TabsContent value="new" className="mt-0">
                    {openItemsLoading ? (
                      <div className="p-4 space-y-3">
                        {[1, 2, 3].map((i) => (
                          <Skeleton key={i} className="h-12 w-full" />
                        ))}
                      </div>
                    ) : newThisWeek === 0 ? (
                      <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
                        <CheckCircle2 className="h-8 w-8 text-green-400" />
                        <p className="text-sm font-medium text-green-700">
                          No new adverse events or NCs this week
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Nothing opened in the past 7 days.
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y">
                        {newAdverseEventItems.map((c) => (
                          <Link key={c.id} href={`/complaints/${c.id}`}>
                            <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors cursor-pointer">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-xs font-mono font-semibold text-primary">
                                    {c.complaintNumber}
                                  </span>
                                  <span className="text-xs px-1.5 py-0.5 rounded border font-medium bg-red-50 text-red-700 border-red-200">
                                    Adverse Event
                                  </span>
                                  <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${severityColor(c.severity)}`}>
                                    {c.severity}
                                  </span>
                                </div>
                                <p className="text-sm mt-0.5 truncate text-muted-foreground">
                                  {c.description.slice(0, 80)}{c.description.length > 80 ? "…" : ""}
                                </p>
                              </div>
                              <div className="text-xs text-muted-foreground whitespace-nowrap font-mono shrink-0">
                                {formatDateOnly(c.receivedDate, "MMM d")}
                              </div>
                            </div>
                          </Link>
                        ))}
                        {newNCItems.map((nc) => (
                          <Link key={nc.id} href={`/non-conformances/${nc.id}`}>
                            <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors cursor-pointer">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-xs font-mono font-semibold text-primary">
                                    {nc.ncNumber}
                                  </span>
                                  <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${severityColor(nc.severity)}`}>
                                    {nc.severity}
                                  </span>
                                  <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${ncStatusColor(nc.status)}`}>
                                    {nc.status}
                                  </span>
                                </div>
                                <p className="text-sm mt-0.5 truncate text-muted-foreground">
                                  {nc.title}
                                </p>
                              </div>
                              <div className="text-xs text-muted-foreground whitespace-nowrap font-mono shrink-0">
                                {format(new Date(nc.createdAt), "MMM d")}
                              </div>
                            </div>
                          </Link>
                        ))}
                      </div>
                    )}
                  </TabsContent>

                  {/* Non-Conformances */}
                  <TabsContent value="ncs" className="mt-0">
                    {openItemsLoading ? (
                      <div className="p-4 space-y-3">
                        {[1, 2, 3].map((i) => (
                          <Skeleton key={i} className="h-12 w-full" />
                        ))}
                      </div>
                    ) : openNCs.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
                        <CheckCircle2 className="h-8 w-8 text-green-400" />
                        <p className="text-sm font-medium text-green-700">
                          No open non-conformances
                        </p>
                        <p className="text-xs text-muted-foreground">
                          All NCs are closed. Great work.
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y">
                        {openNCs.map((nc) => (
                          <Link
                            key={nc.id}
                            href={`/non-conformances/${nc.id}`}
                          >
                            <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors cursor-pointer">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-xs font-mono font-semibold text-primary">
                                    {nc.ncNumber}
                                  </span>
                                  <span
                                    className={`text-xs px-1.5 py-0.5 rounded border font-medium ${severityColor(nc.severity)}`}
                                  >
                                    {nc.severity}
                                  </span>
                                  <span
                                    className={`text-xs px-1.5 py-0.5 rounded border font-medium ${ncStatusColor(nc.status)}`}
                                  >
                                    {nc.status}
                                  </span>
                                </div>
                                <p className="text-sm mt-0.5 truncate text-muted-foreground">
                                  {nc.title}
                                </p>
                              </div>
                              <div className="text-xs text-muted-foreground whitespace-nowrap font-mono shrink-0">
                                {format(new Date(nc.createdAt), "MMM d")}
                              </div>
                            </div>
                          </Link>
                        ))}
                        <div className="px-4 py-2">
                          <Link
                            href="/non-conformances"
                            className="text-xs text-primary hover:underline"
                          >
                            View all non-conformances →
                          </Link>
                        </div>
                      </div>
                    )}
                  </TabsContent>

                  {/* Complaints */}
                  <TabsContent value="complaints" className="mt-0">
                    {openItemsLoading ? (
                      <div className="p-4 space-y-3">
                        {[1, 2, 3].map((i) => (
                          <Skeleton key={i} className="h-12 w-full" />
                        ))}
                      </div>
                    ) : openComplaints.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
                        <CheckCircle2 className="h-8 w-8 text-green-400" />
                        <p className="text-sm font-medium text-green-700">
                          No open complaints
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y">
                        {openComplaints.map((c) => (
                          <Link
                            key={c.id}
                            href={`/complaints/${c.id}`}
                          >
                            <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors cursor-pointer">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-xs font-mono font-semibold text-primary">
                                    {c.complaintNumber}
                                  </span>
                                  <span
                                    className={`text-xs px-1.5 py-0.5 rounded border font-medium ${severityColor(c.severity)}`}
                                  >
                                    {c.severity}
                                  </span>
                                  <span className="text-xs px-1.5 py-0.5 rounded border bg-slate-50 text-slate-600 border-slate-200 font-medium">
                                    {c.complaintType}
                                  </span>
                                </div>
                                <p className="text-sm mt-0.5 truncate text-muted-foreground">
                                  {c.description.slice(0, 80)}
                                  {c.description.length > 80 ? "…" : ""}
                                </p>
                              </div>
                              <div className="text-xs text-muted-foreground whitespace-nowrap font-mono shrink-0">
                                {formatDateOnly(c.receivedDate, "MMM d")}
                              </div>
                            </div>
                          </Link>
                        ))}
                        <div className="px-4 py-2">
                          <Link
                            href="/complaints"
                            className="text-xs text-primary hover:underline"
                          >
                            View all complaints →
                          </Link>
                        </div>
                      </div>
                    )}
                  </TabsContent>

                  {/* Field Actions */}
                  <TabsContent value="fas" className="mt-0">
                    {openItemsLoading ? (
                      <div className="p-4 space-y-3">
                        {[1, 2, 3].map((i) => (
                          <Skeleton key={i} className="h-12 w-full" />
                        ))}
                      </div>
                    ) : openFAs.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
                        <CheckCircle2 className="h-8 w-8 text-green-400" />
                        <p className="text-sm font-medium text-green-700">
                          No open field actions
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y">
                        {openFAs.map((fa) => (
                          <Link
                            key={fa.id}
                            href={`/field-actions/${fa.id}`}
                          >
                            <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors cursor-pointer">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-xs font-mono font-semibold text-primary">
                                    {fa.faNumber}
                                  </span>
                                  <span
                                    className={`text-xs px-1.5 py-0.5 rounded border font-medium ${faActionTypeColor(fa.actionType)}`}
                                  >
                                    {fa.actionType}
                                  </span>
                                  <span
                                    className={`text-xs px-1.5 py-0.5 rounded border font-medium ${faStatusColor(fa.status)}`}
                                  >
                                    {fa.status}
                                  </span>
                                </div>
                                <p className="text-sm mt-0.5 truncate text-muted-foreground">
                                  {fa.title}
                                </p>
                              </div>
                              <div className="text-xs text-muted-foreground whitespace-nowrap font-mono shrink-0">
                                {format(new Date(fa.createdAt), "MMM d")}
                              </div>
                            </div>
                          </Link>
                        ))}
                        <div className="px-4 py-2">
                          <Link
                            href="/field-actions"
                            className="text-xs text-primary hover:underline"
                          >
                            View all field actions →
                          </Link>
                        </div>
                      </div>
                    )}
                  </TabsContent>

                  {/* CAPAs */}
                  <TabsContent value="capas" className="mt-0">
                    {openItemsLoading ? (
                      <div className="p-4 space-y-3">
                        {[1, 2, 3].map((i) => (
                          <Skeleton key={i} className="h-12 w-full" />
                        ))}
                      </div>
                    ) : openCapas.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
                        <CheckCircle2 className="h-8 w-8 text-green-400" />
                        <p className="text-sm font-medium text-green-700">
                          No open CAPAs
                        </p>
                        <p className="text-xs text-muted-foreground">
                          All corrective and preventive actions are closed.
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y">
                        {openCapas.map((c) => {
                          const effectivenessOverdue =
                            c.effectivenessCheckDue &&
                            isPast(parseISO(c.effectivenessCheckDue));
                          return (
                            <Link key={c.id} href={`/capas/${c.id}`}>
                              <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors cursor-pointer">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs font-mono font-semibold text-primary">
                                      {c.capaNumber}
                                    </span>
                                    <span className={`text-xs px-1.5 py-0.5 rounded-full border font-semibold ${
                                      c.type === "Corrective"
                                        ? "bg-orange-50 text-orange-700 border-orange-200"
                                        : "bg-teal-50 text-teal-700 border-teal-200"
                                    }`}>
                                      {c.type}
                                    </span>
                                    <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${capaStatusColor(c.status)}`}>
                                      {c.status}
                                    </span>
                                    {effectivenessOverdue && (
                                      <span className="text-xs px-1.5 py-0.5 rounded border font-medium bg-red-50 text-red-700 border-red-200">
                                        Effectiveness overdue
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-sm mt-0.5 truncate text-muted-foreground">
                                    {c.title}
                                  </p>
                                  {c.openActionItems > 0 && (
                                    <p className="text-xs mt-0.5 text-amber-600 font-medium">
                                      {c.openActionItems} open action{c.openActionItems > 1 ? "s" : ""} of {c.totalActionItems}
                                    </p>
                                  )}
                                </div>
                                <div className="text-xs text-muted-foreground whitespace-nowrap font-mono shrink-0">
                                  {format(new Date(c.createdAt), "MMM d")}
                                </div>
                              </div>
                            </Link>
                          );
                        })}
                        <div className="px-4 py-2">
                          <Link
                            href="/capas"
                            className="text-xs text-primary hover:underline"
                          >
                            View all CAPAs →
                          </Link>
                        </div>
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>

          {/* Right column: Batch + CAPA breakdowns stacked */}
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Factory className="h-4 w-4 text-blue-500" />
                  Batch Status Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent>
                {batchLoading ? (
                  <div className="space-y-2">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <Skeleton key={i} className="h-8 w-full" />
                    ))}
                  </div>
                ) : batchBreakdown.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">
                    No batches found.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {batchBreakdown
                      .sort((a, b) => b.count - a.count)
                      .map((row) => {
                        const total = batchBreakdown.reduce(
                          (s, r) => s + r.count,
                          0
                        );
                        const pct = total
                          ? Math.round((row.count / total) * 100)
                          : 0;
                        return (
                          <div key={row.status} className="space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span className="flex items-center gap-1.5">
                                <span
                                  className={`px-1.5 py-0.5 rounded text-xs font-medium ${batchStatusColor(row.status)}`}
                                >
                                  {batchStatusLabel(row.status)}
                                </span>
                              </span>
                              <span className="font-semibold tabular-nums text-muted-foreground">
                                {row.count}
                                <span className="ml-1 text-muted-foreground/60">
                                  ({pct}%)
                                </span>
                              </span>
                            </div>
                            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                              <div
                                className={`h-full rounded-full ${
                                  batchStatusColor(row.status).includes("blue")
                                    ? "bg-blue-400"
                                    : batchStatusColor(row.status).includes("green")
                                      ? "bg-green-500"
                                      : batchStatusColor(row.status).includes("amber")
                                        ? "bg-amber-400"
                                        : batchStatusColor(row.status).includes("red")
                                          ? "bg-red-400"
                                          : batchStatusColor(row.status).includes("orange")
                                            ? "bg-orange-400"
                                            : "bg-slate-400"
                                }`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    <div className="pt-2 border-t mt-3">
                      <Link
                        href="/batches"
                        className="text-xs text-primary hover:underline"
                      >
                        View all batches →
                      </Link>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* CAPA Status Breakdown */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <ClipboardList className="h-4 w-4 text-amber-500" />
                  CAPA Workflow Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent>
                {summaryLoading ? (
                  <div className="space-y-2">
                    {[1, 2, 3, 4].map((i) => (
                      <Skeleton key={i} className="h-8 w-full" />
                    ))}
                  </div>
                ) : !summary?.capaByStatus?.length ? (
                  <div className="flex flex-col items-center justify-center py-6 text-center gap-1.5">
                    <CheckCircle2 className="h-6 w-6 text-green-400" />
                    <p className="text-sm text-muted-foreground">
                      No open CAPAs
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(summary.capaByStatus as { status: string; count: number }[])
                      .slice()
                      .sort((a, b) => {
                        const order = [
                          "Open",
                          "Root Cause Analysis",
                          "Action Planning",
                          "Implementation",
                          "Effectiveness Check",
                          "Closed",
                        ];
                        return order.indexOf(a.status) - order.indexOf(b.status);
                      })
                      .map((row) => {
                        const total = (summary.capaByStatus as { status: string; count: number }[]).reduce(
                          (s, r) => s + r.count,
                          0
                        );
                        const pct = total
                          ? Math.round((row.count / total) * 100)
                          : 0;
                        const barColor =
                          row.status === "Open"
                            ? "bg-slate-400"
                            : row.status === "Root Cause Analysis"
                              ? "bg-purple-400"
                              : row.status === "Action Planning"
                                ? "bg-blue-400"
                                : row.status === "Implementation"
                                  ? "bg-amber-400"
                                  : row.status === "Effectiveness Check"
                                    ? "bg-indigo-400"
                                    : "bg-green-500";
                        return (
                          <div key={row.status} className="space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span
                                className={`px-1.5 py-0.5 rounded text-xs font-medium ${capaStatusColor(row.status)}`}
                              >
                                {row.status}
                              </span>
                              <span className="font-semibold tabular-nums text-muted-foreground">
                                {row.count}
                                <span className="ml-1 text-muted-foreground/60">
                                  ({pct}%)
                                </span>
                              </span>
                            </div>
                            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                              <div
                                className={`h-full rounded-full ${barColor}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    <div className="pt-2 border-t mt-3">
                      <Link
                        href="/capas"
                        className="text-xs text-primary hover:underline"
                      >
                        View all CAPAs →
                      </Link>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
        </Sec>

        {/* ── Session 37 (Tier 3 #15) — Operations dashboard section ──────────
            Five widgets focused on production rhythm: inventory health,
            testing throughput, testing pass/fail, output trend, and NC
            trend. The existing Batch Status Breakdown card above already
            covers the sixth widget from the priority list bundle (batches
            in production by status); we deep-link to it rather than
            duplicate. All trend windows are 90 days. Click-through to the
            filtered list page is wired on each tile. */}
        <Sec id="analytics">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-baseline gap-3">
              <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
                {effectiveAnalyticsView === "quality"
                  ? <><ShieldCheck className="h-4 w-4 text-emerald-600" /> Overall Quality</>
                  : <><Factory className="h-4 w-4 text-blue-500" /> Operations</>}
              </h2>
              <p className="text-xs text-muted-foreground">
                {effectiveAnalyticsView === "quality"
                  ? "Inspections, testing, non-conformances, CAPA, and supplier concerns."
                  : "Production rhythm, inventory health, and testing throughput. 90-day rolling windows."}
              </p>
            </div>
            {/* NC-10 — toggle available to everyone so Quality can see Operations and vice versa. */}
            <div className="flex gap-1 print:hidden">
              <Button size="sm" variant={effectiveAnalyticsView === "operations" ? "default" : "outline"} className="h-7 px-2.5 text-xs" onClick={() => setAnalyticsView("operations")}>Operations</Button>
              <Button size="sm" variant={effectiveAnalyticsView === "quality" ? "default" : "outline"} className="h-7 px-2.5 text-xs" onClick={() => setAnalyticsView("quality")}>Overall Quality</Button>
            </div>
          </div>

          {/* Management Overview — monthly trends (Session 97, #3). Quality events,
              batch output, consumption, and yield over a 3/6-month window. */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-baseline gap-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-blue-600" /> Management Overview
              </h3>
              <p className="text-xs text-muted-foreground">Events, output, consumption, and yield over the last {trendMonths} months.</p>
            </div>
            <div className="flex gap-1">
              {[3, 6].map((n) => (
                <Button key={n} size="sm" variant={trendMonths === n ? "default" : "outline"} className="h-7 px-2.5 text-xs" onClick={() => setTrendMonths(n)}>
                  {n}m
                </Button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Quality Events — opened vs closed */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-emerald-600" />
                  Quality Events — opened vs closed
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={mgmtData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="qualityOpened" stroke="#dc2626" strokeWidth={2} dot={{ r: 2 }} name="Opened" />
                    <Line type="monotone" dataKey="qualityClosed" stroke="#16a34a" strokeWidth={2} dot={{ r: 2 }} name="Closed" />
                  </LineChart>
                </ResponsiveContainer>
                <p className="text-[11px] text-muted-foreground mt-1">Non-conformances, CAPAs, complaints, and field actions combined.</p>
              </CardContent>
            </Card>

            {/* Batches — made vs released */}
            <Card className={effectiveAnalyticsView === "quality" ? "hidden" : ""}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Factory className="h-4 w-4 text-blue-600" />
                  Batches — made vs released
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={mgmtData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="batchesMade" name="Made" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="batchesReleased" name="Released" fill="#16a34a" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                <p className="text-[11px] text-muted-foreground mt-1"><strong>{mgmt?.producedReleasedThisPeriod ?? 0}</strong> finished-goods batches released in this window.</p>
              </CardContent>
            </Card>

            {/* Average yield — % of planned output */}
            <Card className={effectiveAnalyticsView === "quality" ? "hidden" : ""}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-indigo-600" />
                  Average Yield — % of planned output
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={mgmtData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} unit="%" domain={[0, (dataMax: number) => Math.max(100, Math.ceil(dataMax))]} />
                    <Tooltip formatter={(v: number) => (v == null ? "—" : `${v}%`)} />
                    <Line type="monotone" dataKey="yieldPct" stroke="#6366f1" strokeWidth={2} dot={{ r: 2 }} name="Avg yield" connectNulls />
                  </LineChart>
                </ResponsiveContainer>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {avgYield != null ? <>Window average <strong>{avgYield}%</strong> · actual ÷ scheduled output.</> : "No batches with planned + actual output in this window."}
                </p>
              </CardContent>
            </Card>

            {/* Inventory consumed */}
            <Card className={effectiveAnalyticsView === "quality" ? "hidden" : ""}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Package className="h-4 w-4 text-amber-600" />
                  Inventory Consumed{primaryUnit ? ` (${primaryUnit})` : ""}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {!primaryUnit ? (
                  <p className="text-xs text-muted-foreground py-8 text-center">No ingredient consumption recorded in this window.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={mgmtData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} />
                      <Tooltip formatter={(v: number) => `${v} ${primaryUnit}`} />
                      <Bar dataKey="consumedPrimary" name={primaryUnit} fill="#d97706" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
                <p className="text-[11px] text-muted-foreground mt-1">
                  Committed ingredient draw-downs per month{mgmt && mgmt.units.length > 1 ? ` — showing ${primaryUnit}; other units also consumed: ${mgmt.units.slice(1).join(", ")}` : ""}.
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

            {/* NC-10 — Incoming inspection outcomes (Overall Quality view only). */}
            {effectiveAnalyticsView === "quality" && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Inbox className="h-4 w-4 text-emerald-600" />
                    Incoming Inspections — outcomes
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {inspectionDecided === 0 ? (
                    <p className="text-xs text-muted-foreground py-8 text-center">No completed incoming inspections yet.</p>
                  ) : (
                    <>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div>
                          <p className="text-2xl font-bold tabular-nums text-emerald-700">{inspectionOutcomes.pass}</p>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Passed</p>
                        </div>
                        <div>
                          <p className="text-2xl font-bold tabular-nums text-red-700">{inspectionOutcomes.fail}</p>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Failed</p>
                        </div>
                        <div>
                          <p className="text-2xl font-bold tabular-nums text-amber-700">{inspectionOutcomes.conditional}</p>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Conditional</p>
                        </div>
                      </div>
                      <p className="text-[11px] text-muted-foreground text-center mt-2">
                        Fail rate {Math.round((inspectionOutcomes.fail / inspectionDecided) * 100)}% · {inspectionDecided} decided
                      </p>
                    </>
                  )}
                  <Link href="/inspections" className="text-xs text-primary hover:underline mt-3 inline-block">Open Inspections →</Link>
                </CardContent>
              </Card>
            )}

            {/* Inventory Levels — low-stock callouts */}
            <Card className={`${lowStockItems.length > 0 ? "border-amber-200 bg-amber-50/30" : ""} ${effectiveAnalyticsView === "quality" ? "hidden" : ""}`}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Package className="h-4 w-4 text-amber-600" />
                  Inventory Levels
                  {lowStockItems.length > 0 && (
                    <span className="ml-auto text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                      {lowStockItems.length} low
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {inventoryLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : lowStockItems.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2">All items at or above reorder point.</p>
                ) : (
                  <ul className="space-y-1.5 text-xs">
                    {lowStockItems.slice(0, 5).map((it) => (
                      <li key={it.id} className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{it.itemName}</span>
                        <span className="tabular-nums text-amber-700 shrink-0">
                          {it.quantity} / {it.reorderPoint} {it.unitOfMeasure}
                        </span>
                      </li>
                    ))}
                    {lowStockItems.length > 5 && (
                      <li className="text-[11px] text-muted-foreground italic pt-1">
                        + {lowStockItems.length - 5} more below reorder point
                      </li>
                    )}
                  </ul>
                )}
                <Link href="/inventory" className="text-xs text-primary hover:underline mt-3 inline-block">
                  Open Inventory →
                </Link>
              </CardContent>
            </Card>

            {/* Testing Throughput — pending CoAs + avg turnaround */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FlaskConical className="h-4 w-4 text-indigo-600" />
                  Testing Throughput
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Pending CoAs</p>
                    <Link href="/batches?status=testing_in_progress" className="block">
                      <p className="text-2xl font-bold tabular-nums hover:text-primary transition-colors">
                        {pendingCoasCount}
                      </p>
                    </Link>
                    <p className="text-[10px] text-muted-foreground">Batches in testing</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Avg Turnaround</p>
                    <p className="text-2xl font-bold tabular-nums">
                      {testingMetricsLoading
                        ? <Skeleton className="h-7 w-12 inline-block" />
                        : testingMetrics?.avgTurnaroundDays != null
                          ? `${testingMetrics.avgTurnaroundDays}d`
                          : "—"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">Sample pulled → result, 90d</p>
                  </div>
                </div>
                {testingMetrics && testingMetrics.pendingCount > 0 && (
                  <p className="text-[11px] text-muted-foreground border-t pt-2">
                    {testingMetrics.pendingCount} test rows still pending across all batches.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Testing Pass/Fail — donut, 90d */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-green-600" />
                  Pass / Fail (90d)
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {testingMetricsLoading ? (
                  <Skeleton className="h-32 w-full" />
                ) : (() => {
                  const pass = testingMetrics?.passCount ?? 0;
                  const fail = testingMetrics?.failCount ?? 0;
                  const total = pass + fail;
                  if (total === 0) {
                    return <p className="text-xs text-muted-foreground py-8 text-center">No completed tests in the last 90 days.</p>;
                  }
                  const data = [
                    { name: "Pass", value: pass, fill: "#16a34a" },
                    { name: "Fail", value: fail, fill: "#dc2626" },
                  ];
                  const passRate = Math.round((pass / total) * 100);
                  return (
                    <div className="relative">
                      <ResponsiveContainer width="100%" height={140}>
                        <PieChart>
                          <Pie data={data} dataKey="value" nameKey="name" innerRadius={40} outerRadius={62} paddingAngle={2}>
                            {data.map((d) => <Cell key={d.name} fill={d.fill} />)}
                          </Pie>
                          <Tooltip formatter={(v: number) => `${v} tests`} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                        <p className="text-2xl font-bold tabular-nums">{passRate}%</p>
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Pass</p>
                      </div>
                      <p className="text-[11px] text-muted-foreground text-center mt-1">
                        {pass} pass · {fail} fail · {total} total
                      </p>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>

            {/* Production Output Trend — last 10 batches */}
            <Card className={`lg:col-span-2 ${effectiveAnalyticsView === "quality" ? "hidden" : ""}`}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-blue-600" />
                  Production Output — last 10 batches
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {batchesLoading ? (
                  <Skeleton className="h-40 w-full" />
                ) : recentBatchOutputs.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-8 text-center">No completed batches with output recorded.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={recentBatchOutputs} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                      <XAxis dataKey="batch" tick={{ fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={50} />
                      <YAxis tick={{ fontSize: 10 }} />
                      <Tooltip formatter={(v: number, name, props) => [`${v} ${props?.payload?.uom ?? ""}`, name === "scheduled" ? "Scheduled" : "Actual"]} />
                      <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} />
                      {/* Session 38 (Tier 4 #19) — scheduled-vs-actual overlay.
                          The scheduled bar renders only when scheduledOutputQuantity
                          is non-null, so legacy batches without a planned figure
                          continue to show just the actual bar. */}
                      <Bar dataKey="scheduled" name="Scheduled" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="output" name="Actual" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
                <p className="text-[11px] text-muted-foreground mt-2">
                  Slate bars are the scheduled output; blue is actual. Variance % displayed per batch on the Batch Detail page.
                </p>
              </CardContent>
            </Card>

            {/* Open NCs Trend — 90 days weekly */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                  NC Trend — last 13 weeks
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {ncsLoading ? (
                  <Skeleton className="h-40 w-full" />
                ) : (() => {
                  const hasData = ncTrend.some((b) => b.opened > 0 || b.closed > 0);
                  if (!hasData) {
                    return <p className="text-xs text-muted-foreground py-8 text-center">No NCs in the last 90 days.</p>;
                  }
                  return (
                    <ResponsiveContainer width="100%" height={180}>
                      <LineChart data={ncTrend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                        <XAxis
                          dataKey="weekStart"
                          tick={{ fontSize: 9 }}
                          interval={1}
                          tickFormatter={(v) => format(new Date(v + "T00:00:00"), "M/d")}
                        />
                        <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                        <Tooltip
                          labelFormatter={(v) => `Week of ${format(new Date(v + "T00:00:00"), "MMM d, yyyy")}`}
                        />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Line type="monotone" dataKey="opened" stroke="#dc2626" strokeWidth={2} dot={{ r: 2 }} name="Opened" />
                        <Line type="monotone" dataKey="closed" stroke="#16a34a" strokeWidth={2} dot={{ r: 2 }} name="Closed" />
                      </LineChart>
                    </ResponsiveContainer>
                  );
                })()}
                <Link href="/non-conformances" className="text-xs text-primary hover:underline mt-2 inline-block">
                  Open NC list →
                </Link>
              </CardContent>
            </Card>

          </div>
        </div>
        </Sec>

        {/* ── Supplier Re-qualification Widget ── */}
        <Sec id="supplier-requal">
        {(suppliersOverdue.length > 0 || suppliersDueSoon.length > 0 || suppliersLoading) && (
          <Card className={suppliersOverdue.length > 0 ? "border-red-200 bg-red-50/20" : "border-amber-200 bg-amber-50/20"}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Truck className={`h-4 w-4 ${suppliersOverdue.length > 0 ? "text-red-500" : "text-amber-500"}`} />
                Supplier Re-qualification Reviews
                <span className="text-xs font-normal text-muted-foreground ml-1">
                  — ISO 13485:2016 §7.4
                </span>
                {suppliersOverdue.length > 0 && (
                  <span className="ml-auto text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                    {suppliersOverdue.length} overdue
                  </span>
                )}
                {suppliersDueSoon.length > 0 && (
                  <span className={`${suppliersOverdue.length > 0 ? "" : "ml-auto"} text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700`}>
                    {suppliersDueSoon.length} due within 90 days
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {suppliersLoading ? (
                <div className="p-4 space-y-3">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
                </div>
              ) : (
                <div>
                  {/* Overdue suppliers */}
                  {suppliersOverdue.length > 0 && (
                    <div>
                      <div className="px-4 py-1.5 bg-red-50 border-y border-red-100">
                        <p className="text-xs font-semibold text-red-700 uppercase tracking-wide">
                          Overdue — Schedule immediately
                        </p>
                      </div>
                      <div className="divide-y divide-red-50">
                        {suppliersOverdue.slice(0, 5).map((s) => {
                          const daysOverdue = s.nextReviewDue
                            ? differenceInDays(new Date(), parseISO(s.nextReviewDue))
                            : null;
                          return (
                            <Link key={s.id} href={`/suppliers/${s.id}`}>
                              <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-red-50/60 transition-colors cursor-pointer">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-sm font-semibold text-slate-900">{s.supplierName}</span>
                                    <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                                      {s.supplierType}
                                    </span>
                                  </div>
                                  <p className="text-xs text-muted-foreground mt-0.5">
                                    {s.reviewStatus === "never-qualified"
                                      ? "No qualification on record"
                                      : `Was due ${s.nextReviewDue ? format(parseISO(s.nextReviewDue), "MMM d, yyyy") : "—"}`}
                                    {" · "}Every {s.requalificationIntervalYears} yr{s.requalificationIntervalYears > 1 ? "s" : ""}
                                  </p>
                                </div>
                                <div className="text-right shrink-0">
                                  <span className="text-xs font-bold text-red-700">
                                    {s.reviewStatus === "never-qualified"
                                      ? "Never qualified"
                                      : daysOverdue !== null
                                        ? `${daysOverdue}d overdue`
                                        : "Overdue"}
                                  </span>
                                </div>
                              </div>
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Due Soon suppliers */}
                  {suppliersDueSoon.length > 0 && (
                    <div>
                      <div className={`px-4 py-1.5 border-y border-amber-100 ${suppliersOverdue.length > 0 ? "bg-amber-50 border-t border-t-red-100" : "bg-amber-50"}`}>
                        <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide">
                          Due within 90 days — Plan ahead
                        </p>
                      </div>
                      <div className="divide-y divide-amber-50">
                        {suppliersDueSoon.slice(0, 5).map((s) => {
                          const daysUntil = s.nextReviewDue
                            ? differenceInDays(parseISO(s.nextReviewDue), new Date())
                            : null;
                          return (
                            <Link key={s.id} href={`/suppliers/${s.id}`}>
                              <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-amber-50/60 transition-colors cursor-pointer">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-sm font-semibold text-slate-900">{s.supplierName}</span>
                                    <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                                      {s.supplierType}
                                    </span>
                                  </div>
                                  <p className="text-xs text-muted-foreground mt-0.5">
                                    Due {s.nextReviewDue ? format(parseISO(s.nextReviewDue), "MMM d, yyyy") : "—"}
                                    {" · "}Every {s.requalificationIntervalYears} yr{s.requalificationIntervalYears > 1 ? "s" : ""}
                                  </p>
                                </div>
                                <div className="text-right shrink-0">
                                  <span className="text-xs font-bold text-amber-700">
                                    {daysUntil !== null ? `${daysUntil}d left` : "Due soon"}
                                  </span>
                                </div>
                              </div>
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="px-4 py-2 border-t">
                    <Link href="/suppliers" className="text-xs text-primary hover:underline">
                      View all suppliers →
                    </Link>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
        </Sec>

        {/* ── Recent Activity Feed ── */}
        <Sec id="recent-activity">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4 text-slate-500" />
              Recent Activity
              <span className="text-xs font-normal text-muted-foreground ml-1">
                — live audit trail, auto-refreshes every 30 s
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {activityLoading ? (
              <div className="p-4 space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : recentActivity.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2">
                <Clock className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  No activity recorded yet.
                </p>
              </div>
            ) : (
              <div className="divide-y text-sm">
                {collapsedActivity.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-start gap-4 px-4 py-2.5 hover:bg-muted/30 transition-colors"
                  >
                    {/* Timestamp */}
                    <div className="w-32 shrink-0 text-xs text-muted-foreground font-mono pt-0.5">
                      {entry.changedAt
                        ? format(
                            new Date(entry.changedAt),
                            "MMM d, HH:mm"
                          )
                        : "—"}
                    </div>

                    {/* Operation badge */}
                    <div className="w-16 shrink-0">
                      <Badge
                        variant={
                          entry.operation === "INSERT"
                            ? "default"
                            : entry.operation === "DELETE"
                              ? "destructive"
                              : "secondary"
                        }
                        className="text-xs"
                      >
                        {entry.operation === "INSERT"
                          ? "Created"
                          : entry.operation === "DELETE"
                            ? "Deleted"
                            : "Updated"}
                      </Badge>
                    </div>

                    {/* Table / record */}
                    <div className="flex-1 min-w-0">
                      <span className="font-medium">
                        {tableLabel(entry.tableName)}
                      </span>
                      {entry.afterState &&
                        typeof entry.afterState === "object" && (
                          <span className="ml-1 text-muted-foreground">
                            {" — "}
                            {String(
                              (entry.afterState as Record<string, unknown>)
                                .ncNumber ??
                              (entry.afterState as Record<string, unknown>)
                                .complaintNumber ??
                              (entry.afterState as Record<string, unknown>)
                                .faNumber ??
                              (entry.afterState as Record<string, unknown>)
                                .batchNumber ??
                              (entry.afterState as Record<string, unknown>)
                                .designName ??
                              `#${entry.rowId}`
                            )}
                          </span>
                        )}
                      {entry.collapsedCount > 1 && (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">×{entry.collapsedCount}</span>
                      )}
                    </div>

                    {/* User */}
                    <div className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                      {entry.changedByName ?? "System"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        </Sec>
      </div>
      </DashboardLayoutProvider>
    </>
  );
}
