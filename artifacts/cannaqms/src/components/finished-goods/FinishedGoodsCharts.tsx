import { useState } from "react";
import type { ComponentType } from "react";
import {
  ResponsiveContainer,
  BarChart, Bar, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Factory, PackageCheck, CheckCircle2, Boxes, ArrowUpDown } from "lucide-react";

// Finished Goods charts — configurable ("pick metric + sort", Jonathan 08-09).
// Each card lets an Ops Mgr choose what it measures and how it's sorted.
// Soft palette approved 2026-08-12. Strain colors stay CVD-safe but move into
// the brand categorical set (Sativa=gold, Indica=violet, Hybrid=teal) — Hybrid
// is no longer red so it can't be mistaken for a status alert. GOOD/WARN keep
// the direct status green/amber; magnitude uses the soft teal.
const MAGNITUDE = "hsl(var(--chart-3))";
const NEUTRAL = "hsl(var(--muted-foreground))";
const SINGLE = "hsl(var(--chart-1))";
const GOOD = "hsl(var(--status-good))";
const WARN = "hsl(var(--status-caution))";
const STRAIN_FILL: Record<string, string> = {
  Sativa: "hsl(var(--chart-2))",
  Indica: "hsl(var(--chart-4))",
  Hybrid: "hsl(var(--chart-3))",
  Unclassified: NEUTRAL,
};

type BatchLite = { status: string; strainType?: string | null; productName?: string | null; productType?: string | null };
type PackageLite = { Quantity?: number; UnitOfMeasureName?: string; Item?: { Name?: string } | null; [k: string]: unknown };

const IN_HOUSE = new Set(["in_production", "released_to_inventory", "finished_goods", "on_hold", "quarantine"]);
const STATUS_LABEL: Record<string, string> = {
  in_production: "In production",
  released_to_inventory: "Released",
  finished_goods: "Finished goods",
  on_hold: "On hold",
  quarantine: "Quarantine",
  cancelled: "Cancelled",
  destroyed: "Destroyed",
};

function pkgItemName(p: PackageLite): string {
  return p.Item?.Name ?? (p["ProductName"] as string | undefined) ?? (p["ItemName"] as string | undefined) ?? "—";
}

type Row = { name: string; value: number; fill: string };
type MetricKey = "onHandProduct" | "strain" | "status" | "productType" | "reconciliation";

const METRIC_OPTIONS: { key: MetricKey; label: string }[] = [
  { key: "onHandProduct", label: "On hand by product (METRC)" },
  { key: "strain", label: "Batches by strain type" },
  { key: "status", label: "Batches by status" },
  { key: "productType", label: "Batches by product type" },
  { key: "reconciliation", label: "METRC reconciliation" },
];

type MetricInput = {
  batches: BatchLite[];
  packages: PackageLite[];
  reconciledInMetrc: number | null;
  releasedCount: number;
};

function computeMetric(key: MetricKey, i: MetricInput): Row[] {
  if (key === "strain") {
    const counts: Record<string, number> = { Sativa: 0, Indica: 0, Hybrid: 0, Unclassified: 0 };
    for (const b of i.batches) {
      if (!IN_HOUSE.has(b.status)) continue;
      const s = (b.strainType ?? "").trim();
      const k = s === "Sativa" || s === "Indica" || s === "Hybrid" ? s : "Unclassified";
      counts[k] += 1;
    }
    return ["Sativa", "Indica", "Hybrid", "Unclassified"]
      .map((s) => ({ name: s, value: counts[s] ?? 0, fill: STRAIN_FILL[s] }))
      .filter((r) => r.value > 0);
  }
  if (key === "status") {
    const m: Record<string, number> = {};
    for (const b of i.batches) { const l = STATUS_LABEL[b.status] ?? b.status; m[l] = (m[l] ?? 0) + 1; }
    return Object.entries(m).map(([name, value]) => ({ name, value, fill: SINGLE }));
  }
  if (key === "productType") {
    const m: Record<string, number> = {};
    for (const b of i.batches) { if (!IN_HOUSE.has(b.status)) continue; const t = b.productType ?? "Unknown"; m[t] = (m[t] ?? 0) + 1; }
    return Object.entries(m).map(([name, value]) => ({ name, value, fill: SINGLE }));
  }
  if (key === "reconciliation") {
    if (i.reconciledInMetrc == null) return [];
    const reconciled = i.reconciledInMetrc;
    const needs = Math.max(0, i.releasedCount - reconciled);
    return [
      { name: "Reconciled", value: reconciled, fill: GOOD },
      { name: "Needs attention", value: needs, fill: WARN },
    ].filter((r) => r.value > 0);
  }
  // onHandProduct
  const m: Record<string, number> = {};
  for (const p of i.packages) { const n = pkgItemName(p); m[n] = (m[n] ?? 0) + (p.Quantity ?? 0); }
  return Object.entries(m).map(([name, value]) => ({ name, value: Math.round(value * 100) / 100, fill: MAGNITUDE }));
}

function ConfigurableChart({ input, defaultMetric }: { input: MetricInput; defaultMetric: MetricKey }) {
  const [metric, setMetric] = useState<MetricKey>(defaultMetric);
  const [sortByName, setSortByName] = useState(false);

  let data = computeMetric(metric, input);
  data = [...data].sort((a, b) => (sortByName ? a.name.localeCompare(b.name) : b.value - a.value));
  if (data.length > 8) {
    const top = data.slice(0, 8);
    const rest = data.slice(8);
    top.push({ name: "Other", value: Math.round(rest.reduce((s, r) => s + r.value, 0) * 100) / 100, fill: NEUTRAL });
    data = top;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <Select value={metric} onValueChange={(v) => setMetric(v as MetricKey)}>
            <SelectTrigger className="h-8 text-xs w-[188px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {METRIC_OPTIONS.map((o) => <SelectItem key={o.key} value={o.key} className="text-xs">{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs gap-1 shrink-0" onClick={() => setSortByName((v) => !v)} title="Toggle sort order">
            <ArrowUpDown className="h-3.5 w-3.5" />
            {sortByName ? "A–Z" : "Count"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">No data yet.</p>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="name" fontSize={10} tickLine={false} axisLine={false} interval={0} angle={-30} textAnchor="end" height={50} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="value" name="Value" radius={[4, 4, 0, 0]}>
                {data.map((r, idx) => <Cell key={idx} fill={r.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

function StatTile({ label, value, sub, icon: Icon, tone }: { label: string; value: string | number; sub?: string; icon: ComponentType<{ className?: string }>; tone?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
          <Icon className={`h-4 w-4 ${tone ?? "text-muted-foreground"}`} />
        </div>
        <p className="text-3xl font-bold tabular-nums mt-1">{value}</p>
        {sub ? <p className="text-xs text-muted-foreground mt-0.5">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

export function FinishedGoodsCharts({
  batches,
  packages,
  packagesReady,
  reconciledInMetrc,
  releasedCount,
}: {
  batches: BatchLite[];
  packages: PackageLite[];
  packagesReady: boolean;
  reconciledInMetrc: number | null;
  releasedCount: number;
}) {
  const inProduction = batches.filter((b) => b.status === "in_production").length;
  const onHandTotal = Math.round(packages.reduce((s, p) => s + (p.Quantity ?? 0), 0) * 100) / 100;
  const input: MetricInput = { batches, packages, reconciledInMetrc, releasedCount };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="In Production" value={inProduction} icon={Factory} tone="text-sky-600" sub="batches being made" />
        <StatTile label="Released" value={releasedCount} icon={PackageCheck} tone="text-emerald-600" sub="finished-goods batches" />
        <StatTile label="On Hand (METRC)" value={packagesReady ? onHandTotal : "—"} icon={Boxes} tone="text-indigo-600" sub={`${packages.length} package${packages.length === 1 ? "" : "s"}`} />
        <StatTile label="Reconciled" value={reconciledInMetrc == null ? "—" : `${reconciledInMetrc}/${releasedCount}`} icon={CheckCircle2} tone="text-emerald-600" sub="released batches matched" />
      </div>

      {/* One larger, sortable chart — pick the metric + sort from its controls
          (was three fixed tiles; Jonathan 2026-08-12). */}
      <ConfigurableChart input={input} defaultMetric="onHandProduct" />
    </div>
  );
}
