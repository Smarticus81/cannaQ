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
import { Boxes, AlertTriangle, TrendingDown, Layers, ArrowUpDown } from "lucide-react";

// Inventory overview charts, fully configurable ("pick metric + sort", like
// Finished Goods). Units differ across items, so the reorder metrics are UNITLESS
// (% of each item's reorder point) and "On hand by item" is scoped to one Type
// (units line up there). Reorder bands use status colors (red at/below the point,
// amber near, green ok).
// Status = direct red/amber/green (--status-* tokens). Single-series magnitude =
// soft brand blue (chart-1). Token-driven so they swap in dark mode. 2026-08-12.
const LOW = "hsl(var(--status-urgent))";
const NEAR = "hsl(var(--status-caution))";
const OK = "hsl(var(--status-good))";
const SINGLE = "hsl(var(--chart-1))";
const NEUTRAL = "hsl(var(--muted-foreground))";

type GroupedItem = {
  itemName: string;
  itemType: string;
  unitOfMeasure: string;
  totalQuantity: number;
  reorderPoint: number | null;
  hasLowStock: boolean;
};

type Row = { name: string; value: number; fill: string };
type MetricKey = "closestReorder" | "lowStock" | "onHandByItem" | "onHandByType" | "itemsByType";

const METRICS: { key: MetricKey; label: string; needsType?: boolean; isPct?: boolean }[] = [
  { key: "closestReorder", label: "Closest to reorder point", isPct: true },
  { key: "lowStock", label: "Low / near-reorder only", isPct: true },
  { key: "onHandByItem", label: "On hand by item", needsType: true },
  { key: "onHandByType", label: "On hand by type" },
  { key: "itemsByType", label: "Items by type" },
];

function compute(metric: MetricKey, activeType: string, grouped: GroupedItem[]): { rows: Row[]; unit?: string; isPct: boolean } {
  if (metric === "closestReorder" || metric === "lowStock") {
    let rows: Row[] = grouped
      .filter((g) => g.reorderPoint != null && g.reorderPoint > 0)
      .map((g) => {
        const pct = Math.round((g.totalQuantity / (g.reorderPoint as number)) * 100);
        return { name: g.itemName, value: pct, fill: pct <= 100 ? LOW : pct <= 125 ? NEAR : OK };
      });
    if (metric === "lowStock") rows = rows.filter((r) => r.value <= 125);
    return { rows, isPct: true };
  }
  if (metric === "onHandByItem") {
    const rows: Row[] = grouped.filter((g) => g.itemType === activeType).map((g) => ({ name: g.itemName, value: g.totalQuantity, fill: SINGLE }));
    return { rows, unit: grouped.find((g) => g.itemType === activeType)?.unitOfMeasure ?? "", isPct: false };
  }
  if (metric === "onHandByType") {
    const m: Record<string, number> = {};
    for (const g of grouped) m[g.itemType] = (m[g.itemType] ?? 0) + g.totalQuantity;
    return { rows: Object.entries(m).map(([name, value]) => ({ name, value: Math.round(value * 100) / 100, fill: SINGLE })), isPct: false };
  }
  const m: Record<string, number> = {};
  for (const g of grouped) m[g.itemType] = (m[g.itemType] ?? 0) + 1;
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

function ConfigurableChart({ grouped, types, defaultType, defaultMetric }: { grouped: GroupedItem[]; types: string[]; defaultType: string; defaultMetric: MetricKey }) {
  const [metric, setMetric] = useState<MetricKey>(defaultMetric);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [byName, setByName] = useState(false);

  const meta = METRICS.find((m) => m.key === metric)!;
  const activeType = typeFilter || defaultType;
  const { rows, unit, isPct } = compute(metric, activeType, grouped);
  const data = [...rows]
    .sort((a, b) => (byName ? a.name.localeCompare(b.name) : isPct ? a.value - b.value : b.value - a.value))
    .slice(0, 12);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-1.5">
          <Select value={metric} onValueChange={(v) => setMetric(v as MetricKey)}>
            <SelectTrigger className="h-8 text-xs w-[168px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {METRICS.map((m) => <SelectItem key={m.key} value={m.key} className="text-xs">{m.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1 shrink-0">
            {meta.needsType && (
              <Select value={activeType} onValueChange={setTypeFilter}>
                <SelectTrigger className="h-8 text-xs w-[120px]"><SelectValue placeholder="Type" /></SelectTrigger>
                <SelectContent>{types.map((t) => <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>)}</SelectContent>
              </Select>
            )}
            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs gap-1" onClick={() => setByName((v) => !v)} title="Toggle sort order">
              <ArrowUpDown className="h-3.5 w-3.5" />{byName ? "A–Z" : "Value"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="h-[220px] flex items-center justify-center text-center text-sm text-muted-foreground px-4">
            {isPct ? "No reorder points set yet — set them via the Reorder Points button." : "No data yet."}
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 55 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
              <XAxis dataKey="name" fontSize={10} tickLine={false} axisLine={false} interval={0} angle={-30} textAnchor="end" height={62} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} unit={isPct ? "%" : undefined} allowDecimals={!isPct} />
              <Tooltip formatter={(val: number) => isPct ? [`${val}% of reorder point`, "On hand"] : [`${val}${unit ? ` ${unit}` : ""}`, "Value"]} />
              {isPct && <ReferenceLine y={100} stroke="hsl(var(--status-urgent))" strokeDasharray="4 2" />}
              <Bar dataKey="value" name={isPct ? "% of reorder" : unit ? `On hand (${unit})` : "Value"} radius={[4, 4, 0, 0]}>
                {data.map((r, idx) => <Cell key={idx} fill={r.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

export function InventoryCharts({ grouped }: { grouped: GroupedItem[] }) {
  const totalItems = grouped.length;
  const lowCount = grouped.filter((g) => g.hasLowStock).length;
  const nearCount = grouped.filter((g) => g.reorderPoint != null && g.reorderPoint > 0 && g.totalQuantity > g.reorderPoint && g.totalQuantity <= g.reorderPoint * 1.25).length;
  const typeCount = new Set(grouped.map((g) => g.itemType)).size;

  const types = Array.from(new Set(grouped.map((g) => g.itemType))).sort();
  const defaultType = [...types].sort((a, b) => grouped.filter((g) => g.itemType === b).length - grouped.filter((g) => g.itemType === a).length)[0] ?? "";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Items" value={totalItems} icon={Boxes} tone="text-indigo-600" sub="distinct item groups" />
        <StatTile label="Low Stock" value={lowCount} icon={TrendingDown} tone={lowCount > 0 ? "text-red-600" : "text-muted-foreground"} sub="at or below reorder" />
        <StatTile label="Near Reorder" value={nearCount} icon={AlertTriangle} tone={nearCount > 0 ? "text-amber-600" : "text-muted-foreground"} sub="within 25% of point" />
        <StatTile label="Item Types" value={typeCount} icon={Layers} tone="text-sky-600" sub="categories in stock" />
      </div>

      {/* One larger, sortable chart — pick the metric + sort from its controls
          (was three fixed tiles; Jonathan 2026-08-12). */}
      <ConfigurableChart grouped={grouped} types={types} defaultType={defaultType} defaultMetric="closestReorder" />
    </div>
  );
}
