import { useState } from "react";
import {
  ResponsiveContainer,
  BarChart, Bar, Cell,
  PieChart, Pie, Legend,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ArrowUpDown } from "lucide-react";

// CAPA overview charts (configurable). Open-work metrics (phase, due-in-30d) are
// bars in pipeline / time order; cumulative shares (source, type) are donuts;
// root-cause categories are a cumulative bar (a CAPA can carry several). Due
// buckets ramp red -> blue as they get further out.
const SINGLE = "#3b82f6";
const NEUTRAL = "#94a3b8";
const DUE_FILL: Record<string, string> = { "Overdue": "#dc2626", "Due ≤7d": "#f59e0b", "Due 8–30d": "#3b82f6" };
const SRC_FILL: Record<string, string> = { "Non-Conformance": "#3b82f6", "Complaint": "#f59e0b", "Direct": NEUTRAL };
const TYPE_FILL: Record<string, string> = { Corrective: "#3b82f6", Preventive: "#16a34a", Other: NEUTRAL };
const STAGES = ["Initiation", "Investigation", "Planning", "Action Execution", "EC Execution"];
const DUE_ORDER = ["Overdue", "Due ≤7d", "Due 8–30d"];

type CapaLite = {
  stage?: string | null;
  status?: string | null;
  type?: string | null;
  cancelledAt?: string | null;
  sourceNcId?: number | null;
  sourceComplaintId?: number | null;
  rootCauses?: string[] | null;
  investigationDueDate?: string | null;
  actionPlanningDueDate?: string | null;
  ecPlanningDueDate?: string | null;
  correctionPaClosureDueDate?: string | null;
  ecCheckClosureDueDate?: string | null;
  effectivenessCheckDue?: string | null;
};

const isCancelled = (c: CapaLite): boolean => !!c.cancelledAt;
const isOpen = (c: CapaLite): boolean => (c.stage ?? "") !== "Closed" && !isCancelled(c);
const daysUntil = (s: string): number => Math.ceil((new Date(s + "T00:00:00").getTime() - Date.now()) / 86400000);

function nextDue(c: CapaLite): string | null {
  const st = c.stage ?? "";
  if (st === "Initiation" || st === "Investigation") return c.investigationDueDate ?? null;
  if (st === "Planning") return c.actionPlanningDueDate ?? c.ecPlanningDueDate ?? null;
  if (st === "Action Execution") return c.correctionPaClosureDueDate ?? null;
  if (st === "EC Execution") return c.ecCheckClosureDueDate ?? c.effectivenessCheckDue ?? null;
  return null;
}

type Row = { name: string; value: number; fill: string };
type MetricKey = "openByPhase" | "dueSoon" | "rootCauseCategories" | "bySource" | "byType";
const METRICS: { key: MetricKey; label: string; chart: "pie" | "bar" }[] = [
  { key: "openByPhase", label: "Open by phase", chart: "bar" },
  { key: "dueSoon", label: "Due within 30 days", chart: "bar" },
  { key: "rootCauseCategories", label: "Root cause categories", chart: "bar" },
  { key: "bySource", label: "By source", chart: "pie" },
  { key: "byType", label: "By type", chart: "pie" },
];

function compute(metric: MetricKey, capas: CapaLite[]): Row[] {
  const notCancelled = capas.filter((c) => !isCancelled(c));
  const open = capas.filter(isOpen);
  if (metric === "openByPhase") {
    const m: Record<string, number> = {};
    for (const c of open) { const s = c.stage ?? "Unknown"; m[s] = (m[s] ?? 0) + 1; }
    const rows = STAGES.filter((s) => m[s]).map((s) => ({ name: s, value: m[s], fill: SINGLE }));
    for (const [k, v] of Object.entries(m)) if (!STAGES.includes(k)) rows.push({ name: k, value: v, fill: NEUTRAL });
    return rows;
  }
  if (metric === "dueSoon") {
    const c2: Record<string, number> = { "Overdue": 0, "Due ≤7d": 0, "Due 8–30d": 0 };
    for (const c of open) { const du = nextDue(c); if (!du) continue; const d = daysUntil(du); if (d < 0) c2["Overdue"] += 1; else if (d <= 7) c2["Due ≤7d"] += 1; else if (d <= 30) c2["Due 8–30d"] += 1; }
    return DUE_ORDER.map((b) => ({ name: b, value: c2[b], fill: DUE_FILL[b] }));
  }
  if (metric === "rootCauseCategories") {
    const m: Record<string, number> = {};
    for (const c of notCancelled) for (const rc of c.rootCauses ?? []) { const k = (rc ?? "").trim(); if (k) m[k] = (m[k] ?? 0) + 1; }
    return Object.entries(m).map(([name, value]) => ({ name, value, fill: SINGLE })).sort((a, b) => b.value - a.value);
  }
  if (metric === "bySource") {
    const m: Record<string, number> = { "Non-Conformance": 0, "Complaint": 0, "Direct": 0 };
    for (const c of notCancelled) m[c.sourceNcId != null ? "Non-Conformance" : c.sourceComplaintId != null ? "Complaint" : "Direct"] += 1;
    return ["Non-Conformance", "Complaint", "Direct"].map((s) => ({ name: s, value: m[s], fill: SRC_FILL[s] })).filter((r) => r.value > 0);
  }
  const m: Record<string, number> = {};
  for (const c of open) { const t = c.type ?? "Other"; m[t] = (m[t] ?? 0) + 1; }
  return Object.entries(m).map(([name, value]) => ({ name, value, fill: TYPE_FILL[name] ?? NEUTRAL }));
}

const EMPTY = (m: string) => <p className="h-[220px] flex items-center justify-center text-center text-sm text-muted-foreground px-4">{m}</p>;

function ConfigurableChart({ capas, defaultMetric }: { capas: CapaLite[]; defaultMetric: MetricKey }) {
  const [metric, setMetric] = useState<MetricKey>(defaultMetric);
  const [byName, setByName] = useState(false);
  const meta = METRICS.find((m) => m.key === metric)!;
  const isPie = meta.chart === "pie";
  const rows = compute(metric, capas);
  const ordered = byName ? [...rows].sort((a, b) => a.name.localeCompare(b.name)) : rows;
  const data = isPie ? ordered.filter((r) => r.value > 0) : ordered;
  const allZero = data.length > 0 && data.every((r) => r.value === 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <Select value={metric} onValueChange={(v) => setMetric(v as MetricKey)}>
            <SelectTrigger className="h-8 text-xs w-[188px]"><SelectValue /></SelectTrigger>
            <SelectContent>{METRICS.map((m) => <SelectItem key={m.key} value={m.key} className="text-xs">{m.label}</SelectItem>)}</SelectContent>
          </Select>
          {!isPie && (
            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs gap-1 shrink-0" onClick={() => setByName((v) => !v)} title="Toggle sort order">
              <ArrowUpDown className="h-3.5 w-3.5" />{byName ? "A–Z" : "Value"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {data.length === 0 || allZero ? EMPTY("No data for this view yet.") : isPie ? (
          <ResponsiveContainer width="100%" height={320}>
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={46} outerRadius={82} paddingAngle={2}>
                {data.map((r, idx) => <Cell key={idx} fill={r.fill} stroke="var(--background)" strokeWidth={2} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 55 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="name" fontSize={10} tickLine={false} axisLine={false} interval={0} angle={-25} textAnchor="end" height={62} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="value" name="CAPAs" radius={[4, 4, 0, 0]}>
                {data.map((r, idx) => <Cell key={idx} fill={r.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

export function CAPAsCharts({ capas }: { capas: CapaLite[] }) {
  // One larger, sortable chart — pick the metric + sort from its controls
  // (was four fixed charts; Jonathan 2026-08-13, matching Inventory / Finished Goods).
  return <ConfigurableChart capas={capas} defaultMetric="openByPhase" />;
}
