import { useState } from "react";
import type { ComponentType } from "react";
import {
  ResponsiveContainer,
  BarChart, Bar, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Factory, PackageCheck, Percent, Sprout, ArrowUpDown } from "lucide-react";

// Batches overview charts (configurable, like Finished Goods / Inventory).
// Strain colors match the rest of the app and live only in the strain chart.
// Yield = actual outputQuantity / scheduled (planned) output; % of plan, with a
// 100% reference line (green at/above plan, amber a bit under, red well under).
const SINGLE = "#3b82f6";
const NEUTRAL = "#94a3b8";
const OK = "#16a34a";
const NEAR = "#f59e0b";
const LOW = "#dc2626";
const STRAIN_FILL: Record<string, string> = {
  Sativa: "#d97706",
  Indica: "#7c3aed",
  Hybrid: "#dc2626",
  Unclassified: NEUTRAL,
};

type BatchLite = {
  status: string;
  batchNumber?: string | null;
  productType?: string | null;
  strainName?: string | null;
  strainType?: string | null;
  scheduledOutputQuantity?: number | null;
  outputQuantity?: number | null;
};

const IN_PROD = "in_production";
const STATUS_LABEL: Record<string, string> = {
  in_production: "In production",
  released_to_inventory: "Released",
  finished_goods: "Finished goods",
  on_hold: "On hold",
  quarantine: "Quarantine",
  failed: "Failed",
  destroyed: "Destroyed",
  cancelled: "Cancelled",
};

type Row = { name: string; value: number; fill: string };
type MetricKey = "strainType" | "strain" | "productType" | "status" | "yield";

const METRICS: { key: MetricKey; label: string; isPct?: boolean }[] = [
  { key: "strainType", label: "In production by strain type" },
  { key: "strain", label: "In production by strain" },
  { key: "productType", label: "In production by product type" },
  { key: "status", label: "All batches by status" },
  { key: "yield", label: "Production yield by batch", isPct: true },
];

function yieldRows(batches: BatchLite[]): Row[] {
  return batches
    .filter((b) => (b.scheduledOutputQuantity ?? 0) > 0 && b.outputQuantity != null)
    .map((b, i) => {
      const pct = Math.round((((b.outputQuantity as number) / (b.scheduledOutputQuantity as number)) * 100));
      return { name: b.batchNumber ?? `Batch ${i + 1}`, value: pct, fill: pct >= 100 ? OK : pct >= 85 ? NEAR : LOW };
    });
}

function compute(metric: MetricKey, batches: BatchLite[]): { rows: Row[]; isPct: boolean } {
  if (metric === "yield") return { rows: yieldRows(batches), isPct: true };
  const inProd = batches.filter((b) => b.status === IN_PROD);
  if (metric === "strainType") {
    const counts: Record<string, number> = { Sativa: 0, Indica: 0, Hybrid: 0, Unclassified: 0 };
    for (const b of inProd) {
      const s = (b.strainType ?? "").trim();
      counts[s === "Sativa" || s === "Indica" || s === "Hybrid" ? s : "Unclassified"] += 1;
    }
    return { rows: ["Sativa", "Indica", "Hybrid", "Unclassified"].map((s) => ({ name: s, value: counts[s] ?? 0, fill: STRAIN_FILL[s] })).filter((r) => r.value > 0), isPct: false };
  }
  if (metric === "strain") {
    const m: Record<string, number> = {};
    for (const b of inProd) { const n = (b.strainName ?? "").trim() || "Unspecified"; m[n] = (m[n] ?? 0) + 1; }
    return { rows: Object.entries(m).map(([name, value]) => ({ name, value, fill: SINGLE })), isPct: false };
  }
  if (metric === "productType") {
    const m: Record<string, number> = {};
    for (const b of inProd) { const t = b.productType ?? "Unknown"; m[t] = (m[t] ?? 0) + 1; }
    return { rows: Object.entries(m).map(([name, value]) => ({ name, value, fill: SINGLE })), isPct: false };
  }
  const m: Record<string, number> = {};
  for (const b of batches) { const l = STATUS_LABEL[b.status] ?? b.status; m[l] = (m[l] ?? 0) + 1; }
  return { rows: Object.entries(m).map(([name, value]) => ({ name, value, fill: NEUTRAL })), isPct: false };
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

function ConfigurableChart({ batches, defaultMetric }: { batches: BatchLite[]; defaultMetric: MetricKey }) {
  const [metric, setMetric] = useState<MetricKey>(defaultMetric);
  const [byName, setByName] = useState(false);
  const { rows, isPct } = compute(metric, batches);
  const data = [...rows]
    .sort((a, b) => (byName ? a.name.localeCompare(b.name) : b.value - a.value))
    .slice(0, 12);
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <Select value={metric} onValueChange={(v) => setMetric(v as MetricKey)}>
            <SelectTrigger className="h-8 text-xs w-[184px]"><SelectValue /></SelectTrigger>
            <SelectContent>{METRICS.map((m) => <SelectItem key={m.key} value={m.key} className="text-xs">{m.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs gap-1 shrink-0" onClick={() => setByName((v) => !v)} title="Toggle sort order">
            <ArrowUpDown className="h-3.5 w-3.5" />{byName ? "A–Z" : "Value"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="h-[220px] flex items-center justify-center text-center text-sm text-muted-foreground px-4">
            {isPct ? "No completed batches with a planned vs actual output yet." : "Nothing in production yet."}
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 55 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="name" fontSize={10} tickLine={false} axisLine={false} interval={0} angle={-30} textAnchor="end" height={62} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} unit={isPct ? "%" : undefined} allowDecimals={!isPct} />
              <Tooltip formatter={(v: number) => isPct ? [`${v}% of plan`, "Yield"] : [`${v}`, "Batches"]} />
              {isPct && <ReferenceLine y={100} stroke="#16a34a" strokeDasharray="4 2" />}
              <Bar dataKey="value" name={isPct ? "% of plan" : "Batches"} radius={[4, 4, 0, 0]}>
                {data.map((r, idx) => <Cell key={idx} fill={r.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

export function BatchesCharts({ batches }: { batches: BatchLite[] }) {
  const inProd = batches.filter((b) => b.status === IN_PROD).length;
  // Released tile counts ONLY released_to_inventory so the number matches the
  // "Released" filter chip on the list. Finished-goods batches have moved past
  // this milestone and are reached via the Finished Goods chip (and the
  // Finished Goods screen). (2026-08-10)
  const released = batches.filter((b) => b.status === "released_to_inventory").length;
  const yields = yieldRows(batches);
  const avgYield = yields.length ? Math.round(yields.reduce((s, r) => s + r.value, 0) / yields.length) : null;
  const strainsInProd = new Set(batches.filter((b) => b.status === IN_PROD && (b.strainName ?? "").trim()).map((b) => (b.strainName as string).trim())).size;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="In Production" value={inProd} icon={Factory} tone="text-sky-600" sub="batches being made" />
        <StatTile label="Bulk — Released" value={released} icon={PackageCheck} tone="text-emerald-600" sub="tested and released, not yet packaged" />
        <StatTile label="Avg Yield" value={avgYield == null ? "—" : `${avgYield}%`} icon={Percent} tone={avgYield != null && avgYield < 90 ? "text-amber-600" : "text-muted-foreground"} sub="actual vs planned output" />
        <StatTile label="Strains In Prod" value={strainsInProd} icon={Sprout} tone="text-indigo-600" sub="distinct cultivars" />
      </div>

      {/* One larger, sortable chart — pick the metric + sort from its controls
          (was three fixed charts; Jonathan 2026-08-13, matching Inventory /
          Finished Goods). */}
      <ConfigurableChart batches={batches} defaultMetric="strainType" />
    </div>
  );
}
