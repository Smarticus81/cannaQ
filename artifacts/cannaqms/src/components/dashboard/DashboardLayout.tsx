// Configurable, role-aware dashboard layout (2026-07-21).
//
// Turns the dashboard's fixed top-to-bottom sections into show/hide/reorderable
// "widgets" with two role-based default layouts (Quality and Production) that each
// user can customise and save to their own login. Implemented WITHOUT relocating any
// existing dashboard JSX: each section is wrapped in <Sec id="…">, and ordering is
// done purely with CSS flex `order`, so the source order of the sections never has to
// change. Visibility + order come from a small context the page provides once.
//
// Persistence uses the endpoints added the same day:
//   GET/PUT/DELETE /api/dashboard/preferences  (per-user layout)
// A user with no saved layout falls back to their role's default template.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Scale,
  ShieldCheck,
  RefreshCw,
  FileText,
  Inbox,
  Eye,
  EyeOff,
  ArrowUp,
  ArrowDown,
  Pencil,
  Check,
  RotateCcw,
  X,
} from "lucide-react";

// ── Widget catalogue ────────────────────────────────────────────────────────
// The id must match the <Sec id="…"> used on the dashboard page. Order within a
// template array is the on-screen order; `visible:false` = present-but-off (still
// addable from the edit bar).
export const WIDGET_TITLES: Record<string, string> = {
  "my-queue": "My Queue",
  "kpi-production": "Production KPIs",
  "open-inspections": "Open Inspections",
  "kpi-quality": "Quality KPIs",
  "license-renewals": "License Renewals",
  "kpi-supplier-compliance": "Supplier & Compliance KPIs",
  "open-items": "Open Items & Breakdowns",
  analytics: "Analytics & Charts",
  "supplier-requal": "Supplier Re-Qualification",
  "recent-activity": "Recent Activity",
  "inventory-on-hand": "Inventory On Hand",
  "finished-goods": "Finished Goods On Hand",
  "production-pipeline": "Production Pipeline",
  "team-actions": "Team Actions",
  "testing-summary": "Testing",
  compliance: "Compliance",
};

export type WidgetId = keyof typeof WIDGET_TITLES;
export type LayoutEntry = { id: string; visible: boolean };

const ALL_IDS = Object.keys(WIDGET_TITLES);

// Quality-role default: quality metrics + license renewals + supplier compliance
// first; production-only tiles present but hidden (addable).
const QUALITY_DEFAULT: LayoutEntry[] = [
  // Reordered 2026-08-11: lead with the QA essentials — NC/CAPA/complaint KPIs,
  // then Testing, open items, and inspection/supplier audit findings. License
  // renewals pushed off by default (addable). Unlisted widgets auto-hide.
  { id: "my-queue", visible: true },
  { id: "kpi-quality", visible: true },
  { id: "testing-summary", visible: true },
  { id: "compliance", visible: true },
  { id: "open-items", visible: true },
  { id: "open-inspections", visible: true },
  { id: "analytics", visible: true },
  { id: "kpi-supplier-compliance", visible: true },
  { id: "supplier-requal", visible: true },
  { id: "recent-activity", visible: true },
  { id: "license-renewals", visible: false },
];

// Production-role default (Supervisor / Manager / Operator / Admin): production,
// inspections, inventory & batch status first; supplier/licensing hidden.
const PRODUCTION_DEFAULT: LayoutEntry[] = [
  { id: "my-queue", visible: true },
  { id: "kpi-production", visible: true },
  { id: "open-inspections", visible: true },
  { id: "open-items", visible: true },
  { id: "kpi-quality", visible: true },
  { id: "analytics", visible: true },
  { id: "recent-activity", visible: true },
  { id: "kpi-supplier-compliance", visible: false },
  { id: "license-renewals", visible: false },
  { id: "supplier-requal", visible: false },
  { id: "inventory-on-hand", visible: false },
  { id: "finished-goods", visible: false },
];

// Operator-role default (2026-08-11): receiving + fulfillment focus. Inventory
// on hand and finished goods first, plus incoming inspections and batches in
// flight. Quality metrics, management analytics, and supplier/licensing are
// present-but-off (an Operator can still add them from the edit bar).
const OPERATOR_DEFAULT: LayoutEntry[] = [
  { id: "my-queue", visible: true },
  { id: "inventory-on-hand", visible: true },
  { id: "finished-goods", visible: true },
  { id: "open-inspections", visible: true },
  { id: "kpi-production", visible: true },
  { id: "recent-activity", visible: true },
  { id: "open-items", visible: false },
  { id: "kpi-quality", visible: false },
  { id: "analytics", visible: false },
  { id: "kpi-supplier-compliance", visible: false },
  { id: "license-renewals", visible: false },
  { id: "supplier-requal", visible: false },
];

// Supervisor-role default (2026-08-11): production oversight — what's moving
// through the floor (Production Pipeline), what's in finished goods (so they
// know what to make next) and inventory, plus their team's open actions
// (dept-scoped CAPAs/NCs). Only the visible sections are listed; any widget not
// named here is auto-added hidden (addable from the edit bar) by defaultLayout.
const SUPERVISOR_DEFAULT: LayoutEntry[] = [
  { id: "my-queue", visible: true },
  { id: "production-pipeline", visible: true },
  { id: "finished-goods", visible: true },
  { id: "inventory-on-hand", visible: true },
  { id: "team-actions", visible: true },
  { id: "open-inspections", visible: true },
  { id: "recent-activity", visible: true },
];

// Manager/Admin default (2026-08-11): a curated EXECUTIVE ROLLUP, not the kitchen
// sink. Cross-area KPI counts (quality, production, supplier & compliance) plus
// the Management Overview trend charts. The detailed operational widgets
// (production pipeline, inventory, finished goods, testing, inspections, open
// items, licenses, re-qual) are present-but-off and addable from the edit bar.
// NO QMS-health strip (Jonathan removed it; do not rebuild).
const MANAGER_DEFAULT: LayoutEntry[] = [
  { id: "my-queue", visible: true },
  { id: "kpi-quality", visible: true },
  { id: "kpi-production", visible: true },
  { id: "kpi-supplier-compliance", visible: true },
  { id: "analytics", visible: true },
  { id: "recent-activity", visible: true },
];

export type TemplateName = "Quality" | "Production" | "Operator" | "Supervisor" | "Manager";

export function templateForRole(role: string | undefined): TemplateName {
  if (role === "Quality") return "Quality";
  if (role === "Operator") return "Operator";
  if (role === "Supervisor") return "Supervisor";
  if (role === "Manager" || role === "Admin") return "Manager";
  return "Production";
}

function defaultLayout(role: string | undefined): LayoutEntry[] {
  const t = templateForRole(role);
  const base =
    t === "Quality" ? QUALITY_DEFAULT :
    t === "Operator" ? OPERATOR_DEFAULT :
    t === "Supervisor" ? SUPERVISOR_DEFAULT :
    t === "Manager" ? MANAGER_DEFAULT :
    PRODUCTION_DEFAULT;
  const out = base.map((e) => ({ ...e }));
  // Any widget a template does not explicitly list is present-but-off, so newly
  // added sections ship hidden (addable) rather than missing on every role.
  const seen = new Set(out.map((e) => e.id));
  for (const id of ALL_IDS) if (!seen.has(id)) out.push({ id, visible: false });
  return out;
}

// Normalise a saved layout: keep the user's order/visibility, drop any unknown ids,
// and append any widget added since they last saved (hidden, so nothing is lost).
function normalise(saved: LayoutEntry[] | null | undefined, role: string | undefined): LayoutEntry[] {
  if (!Array.isArray(saved) || saved.length === 0) return defaultLayout(role);
  const seen = new Set<string>();
  const out: LayoutEntry[] = [];
  for (const e of saved) {
    if (e && typeof e.id === "string" && WIDGET_TITLES[e.id] && !seen.has(e.id)) {
      out.push({ id: e.id, visible: e.visible !== false });
      seen.add(e.id);
    }
  }
  for (const id of ALL_IDS) if (!seen.has(id)) out.push({ id, visible: false });
  return out;
}

// ── Layout context ──────────────────────────────────────────────────────────
type LayoutCtx = {
  orderOf: (id: string) => number;
  visibleOf: (id: string) => boolean;
  known: (id: string) => boolean;
  editMode: boolean;
  toggle: (id: string) => void;
  move: (id: string, dir: -1 | 1) => void;
};

const Ctx = createContext<LayoutCtx | null>(null);

// Hook the page uses to drive the provider + edit bar.
export function useDashboardLayout(role: string | undefined) {
  const qc = useQueryClient();
  const { data } = useQuery<{ role: string; preferences: { layout: LayoutEntry[] } | null }>({
    queryKey: ["dashboard-preferences"],
    queryFn: async () => {
      const r = await fetch("/api/dashboard/preferences", { credentials: "include" });
      if (!r.ok) return { role: role ?? "", preferences: null };
      return r.json();
    },
  });

  const savedLayout = data?.preferences?.layout ?? null;
  const hasSaved = Array.isArray(savedLayout) && savedLayout.length > 0;

  const [layout, setLayout] = useState<LayoutEntry[]>(() => defaultLayout(role));
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);

  // Sync from server / role once loaded, but never stomp an in-progress edit.
  useEffect(() => {
    if (editMode) return;
    setLayout(normalise(savedLayout, role));
  }, [savedLayout, role, editMode]);

  const orderIndex = useMemo(() => {
    const m: Record<string, number> = {};
    layout.forEach((e, i) => (m[e.id] = i));
    return m;
  }, [layout]);
  const visibleIndex = useMemo(() => {
    const m: Record<string, boolean> = {};
    layout.forEach((e) => (m[e.id] = e.visible));
    return m;
  }, [layout]);

  const toggle = (id: string) =>
    setLayout((prev) => prev.map((e) => (e.id === id ? { ...e, visible: !e.visible } : e)));
  const move = (id: string, dir: -1 | 1) =>
    setLayout((prev) => {
      const i = prev.findIndex((e) => e.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      await fetch("/api/dashboard/preferences", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout, baseTemplate: templateForRole(role) }),
      });
      await qc.invalidateQueries({ queryKey: ["dashboard-preferences"] });
      setEditMode(false);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      await fetch("/api/dashboard/preferences", { method: "DELETE", credentials: "include" });
      await qc.invalidateQueries({ queryKey: ["dashboard-preferences"] });
      setLayout(defaultLayout(role));
      setEditMode(false);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setLayout(normalise(savedLayout, role));
    setEditMode(false);
  };

  const ctx: LayoutCtx = {
    orderOf: (id) => orderIndex[id] ?? 999,
    visibleOf: (id) => visibleIndex[id] ?? false,
    known: (id) => id in orderIndex,
    editMode,
    toggle,
    move,
  };

  return { ctx, layout, editMode, setEditMode, save, reset, cancel, saving, hasSaved };
}

export function DashboardLayoutProvider({ value, children }: { value: LayoutCtx; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ── <Sec> — wraps one dashboard section so it can be ordered / hidden ──────────
export function Sec({ id, children }: { id: string; children: ReactNode }) {
  const ctx = useContext(Ctx);
  // If the page isn't inside a provider (or the id is unknown), render as-is.
  if (!ctx || !ctx.known(id)) return <>{children}</>;
  const visible = ctx.visibleOf(id);
  if (!visible && !ctx.editMode) return null;
  return (
    <div style={{ order: ctx.orderOf(id) }} className={visible ? undefined : "opacity-50"}>
      {ctx.editMode && (
        <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium">{WIDGET_TITLES[id]}</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-muted"
            onClick={() => ctx.toggle(id)}
          >
            {visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            {visible ? "Shown" : "Hidden"}
          </button>
          <button
            type="button"
            className="inline-flex items-center rounded border px-1 py-0.5 hover:bg-muted"
            onClick={() => ctx.move(id, -1)}
            aria-label="Move up"
          >
            <ArrowUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            className="inline-flex items-center rounded border px-1 py-0.5 hover:bg-muted"
            onClick={() => ctx.move(id, 1)}
            aria-label="Move down"
          >
            <ArrowDown className="h-3 w-3" />
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

// ── Edit bar ──────────────────────────────────────────────────────────────────
export function DashboardEditBar({
  editMode,
  setEditMode,
  save,
  reset,
  cancel,
  saving,
  role,
}: {
  editMode: boolean;
  setEditMode: (v: boolean) => void;
  save: () => void;
  reset: () => void;
  cancel: () => void;
  saving: boolean;
  role: string | undefined;
}) {
  if (!editMode) {
    return (
      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" onClick={() => setEditMode(true)}>
          <Pencil className="h-4 w-4 mr-1.5" />
          Edit dashboard
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2">
      <p className="text-xs text-muted-foreground">
        Editing your dashboard — show/hide and reorder the sections below, then save. Defaults come
        from the <span className="font-medium">{templateForRole(role)}</span> template.
      </p>
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={reset} disabled={saving} title="Reset to role default">
          <RotateCcw className="h-4 w-4 mr-1.5" />
          Reset
        </Button>
        <Button variant="ghost" size="sm" onClick={cancel} disabled={saving}>
          <X className="h-4 w-4 mr-1.5" />
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={saving}>
          <Check className="h-4 w-4 mr-1.5" />
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ── New tiles ───────────────────────────────────────────────────────────────
// License renewals — expired / due-soon count off the new /api/licenses register.
export function LicenseRenewalsCard() {
  const { data } = useQuery<{
    overdueCount: number;
    dueSoonCount: number;
    licenses: { id: number; name: string; licenseType: string; expiryDate: string | null; overdue: boolean; daysUntil: number }[];
  }>({
    queryKey: ["license-renewals", 90],
    queryFn: async () => {
      const r = await fetch("/api/licenses/renewals?days=90", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load license renewals");
      return r.json();
    },
  });
  const overdue = data?.overdueCount ?? 0;
  const dueSoon = data?.dueSoonCount ?? 0;
  const rows = (data?.licenses ?? []).slice(0, 5);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Scale className="h-4 w-4 text-amber-600" />
          Licenses Needing Renewal
        </CardTitle>
        <Link href="/licenses" className="text-xs text-muted-foreground hover:underline">
          Manage
        </Link>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4 mb-3">
          <div>
            <div className={`text-3xl font-bold tabular-nums ${overdue > 0 ? "text-status-urgent" : ""}`}>
              {overdue}
            </div>
            <div className="text-xs text-muted-foreground">Overdue</div>
          </div>
          <div>
            <div className={`text-3xl font-bold tabular-nums ${dueSoon > 0 ? "text-status-caution" : ""}`}>
              {dueSoon}
            </div>
            <div className="text-xs text-muted-foreground">Due within 90 days</div>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No licenses due for renewal. Add licenses from Manage.</p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((l) => (
              <li key={l.id} className="flex items-center justify-between text-sm">
                <span className="truncate mr-2">
                  {l.name}
                  <span className="text-xs text-muted-foreground ml-1">· {l.licenseType}</span>
                </span>
                <Badge variant={l.overdue ? "destructive" : "secondary"} className="shrink-0">
                  {l.overdue ? `${Math.abs(l.daysUntil)}d overdue` : `${l.daysUntil}d`}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// Compliance (2026-08-11) — the QA/Compliance person's compliance home. Three
// blocks: license & cert renewals on a 4-MONTH lead (government renewals are
// slow), METRC reconciliation on its facility cadence (default Quarterly), and
// regulatory bulletins still awaiting review. Destruction intentionally omitted
// (Jonathan 08-11). Each block reads live from its own source. NOTE: the license
// "Manage" link points at /licenses to match LicenseRenewalsCard; that page route
// may not exist yet (licenses have an API register but no dedicated page).
export function ComplianceCard() {
  const { data: lic } = useQuery<{
    overdueCount: number;
    dueSoonCount: number;
    licenses: { id: number; name: string; licenseType: string; expiryDate: string | null; overdue: boolean; daysUntil: number }[];
  }>({
    queryKey: ["license-renewals", 120],
    queryFn: async () => {
      const r = await fetch("/api/licenses/renewals?days=120", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load license renewals");
      return r.json();
    },
  });
  const { data: recon } = useQuery<{
    schedule: { cadence: string; nextDueAt: string | null; overdue: boolean; neverRun: boolean; lastCompletedAt: string | null };
  }>({
    queryKey: ["recon-schedule"],
    queryFn: async () => {
      const r = await fetch("/api/inventory-checks", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load reconciliation schedule");
      return r.json();
    },
  });
  const { data: bulletins } = useQuery<{ id: number; title: string; source?: string | null }[]>({
    queryKey: ["reg-updates", "New"],
    queryFn: async () => {
      const r = await fetch("/api/regulatory-updates?status=New", { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
  });

  const licOverdue = lic?.overdueCount ?? 0;
  const licDueSoon = lic?.dueSoonCount ?? 0;
  const licRows = (lic?.licenses ?? []).slice(0, 4);
  const sched = recon?.schedule;
  const bull = bulletins ?? [];
  const fmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" /> Compliance
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Scale className="h-3.5 w-3.5" /> Licenses & Certs</span>
            <Link href="/licenses" className="text-[11px] text-muted-foreground hover:underline">Manage</Link>
          </div>
          <div className="mb-1.5 flex items-center gap-4">
            <div><span className={`text-2xl font-bold tabular-nums ${licOverdue > 0 ? "text-red-700" : ""}`}>{licOverdue}</span> <span className="text-[11px] text-muted-foreground">overdue</span></div>
            <div><span className={`text-2xl font-bold tabular-nums ${licDueSoon > 0 ? "text-amber-700" : ""}`}>{licDueSoon}</span> <span className="text-[11px] text-muted-foreground">due within 4 months</span></div>
          </div>
          {licRows.length === 0 ? (
            <p className="text-xs text-muted-foreground">No licenses or certs due within 4 months.</p>
          ) : (
            <ul className="space-y-1">
              {licRows.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">{l.name}<span className="text-muted-foreground"> · {l.licenseType}</span></span>
                  <span className={`shrink-0 tabular-nums ${l.overdue ? "font-semibold text-red-700" : "text-amber-700"}`}>{l.overdue ? "expired" : `${l.daysUntil}d`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t pt-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><RefreshCw className="h-3.5 w-3.5" /> METRC Reconciliation</span>
            <Link href="/inventory-checks" className="text-[11px] text-muted-foreground hover:underline">Open</Link>
          </div>
          {!sched || sched.cadence === "None" ? (
            <p className="text-xs text-muted-foreground">Reconciliation cadence not set.</p>
          ) : sched.neverRun ? (
            <p className="text-xs"><span className="font-semibold text-amber-700">No reconciliation on record</span> · {sched.cadence} cadence</p>
          ) : sched.overdue ? (
            <p className="text-xs"><span className="font-semibold text-red-700">Overdue</span> — was due {fmt(sched.nextDueAt)} · {sched.cadence}</p>
          ) : (
            <p className="text-xs">Next due <span className="font-semibold tabular-nums">{fmt(sched.nextDueAt)}</span> · {sched.cadence}</p>
          )}
        </div>

        <div className="border-t pt-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><FileText className="h-3.5 w-3.5" /> Bulletins to Review</span>
            <Link href="/regulatory-intel" className="text-[11px] text-muted-foreground hover:underline">Open</Link>
          </div>
          {bull.length === 0 ? (
            <p className="text-xs text-muted-foreground">No new regulatory updates to review.</p>
          ) : (
            <ul className="space-y-1">
              {bull.slice(0, 3).map((b) => (
                <li key={b.id}>
                  <Link href="/regulatory-intel" className="flex items-center gap-2 text-xs hover:underline">
                    <span className="shrink-0 rounded-full border border-sky-200 bg-sky-100 px-1.5 text-[10px] font-semibold text-sky-700">NEW</span>
                    <span className="truncate">{b.title}</span>
                  </Link>
                </li>
              ))}
              {bull.length > 3 && <li className="text-[11px] text-muted-foreground">+{bull.length - 3} more</li>}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Open inspections — count of incoming inspections still awaiting a result.
export function OpenInspectionsCard() {
  const { data } = useQuery<{ openInspections: number }>({
    queryKey: ["open-inspections"],
    queryFn: async () => {
      const r = await fetch("/api/dashboard/open-inspections", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load open inspections");
      return r.json();
    },
  });
  const n = data?.openInspections ?? 0;
  return (
    <Link href="/inspections">
      <Card className="cursor-pointer hover:shadow-md transition-shadow max-w-xs">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1">
          <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Open Inspections
          </CardTitle>
          <Inbox className={`h-4 w-4 ${n > 0 ? "text-status-caution" : "text-muted-foreground"}`} />
        </CardHeader>
        <CardContent>
          <div className={`text-3xl font-bold tabular-nums ${n > 0 ? "text-status-caution" : ""}`}>{n}</div>
          <p className="text-xs mt-1 text-muted-foreground">
            {n > 0 ? "Awaiting a result" : "All inspections resolved"}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
