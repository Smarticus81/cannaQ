import { useState } from "react";
import {
  ResponsiveContainer,
  BarChart, Bar, Cell,
  PieChart, Pie, Legend,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ArrowUpDown } from "lucide-react";

// Complaint overview charts. Severity uses reserved status colors; "open by type
// & severity" is a STACKED bar (both dimensions in one chart); averages render as
// bars (a pie of averages would mislead); shares render as donuts.
const SINGLE = "#3b82f6";
const NEUTRAL = "#94a3b8";
const SEV_ORDER = ["Critical", "High", "Medium", "Low"];
const SEV_FILL: Record<string, string> = { Critical: "#dc2626", High: "#f59e0b", Medium: "#3b82f6", Low: "#16a34a", Other: NEUTRAL };
const sevKey = (s: string | null | undefined): string => { const v = (s ?? "").trim(); return SEV_ORDER.includes(v) ? v : "Other"; };
const ageDays = (a: string): number => Math.max(0, Math.floor((Date.now() - new Date(a).getTime()) / 86400000));

type ComplaintLite = { status: string; complaintType?: string | null; severity?: string | null; createdAt?: string | null; closedAt?: string | null };

const EMPTY = (m: string) => <p className="h-[220px] flex items-center justify-center text-center text-sm text-muted-foreground px-4">{m}</p>;

// Card 1 — open complaints stacked by severity within each type (combines both).
function OpenByTypeSeverity({ complaints }: { complaints: ComplaintLite[] }) {
  const open = complaints.filter((c) => c.status !== "Closed");
  const sevKeys = [...SEV_ORDER, "Other"].filter((s) => open.some((c) => sevKey(c.severity) === s));
  const byType: Record<string, Record<string, number>> = {};
  for (const c of open) {
    const t = (c.complaintType ?? "").trim() || "Other";
    const s = sevKey(c.severity);
    (byType[t] ||= {});
    byType[t][s] = (byType[t][s] ?? 0) + 1;
  }
  const rows: Array<Record<string, string | number>> = Object.entries(byType)
    .map(([type, sevs]) => {
      const r: Record<string, string | number> = { name: type };
      for (const s of sevKeys) r[s] = sevs[s] ?? 0;
      return r;
    })
    .sort((a, b) => sevKeys.reduce((n, s) => n + (Number(b[s]) || 0), 0) - sevKeys.reduce((n, s) => n + (Number(a[s]) || 0), 0));

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">Open complaints by type &amp; severity</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? EMPTY("No open complaints.") : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 55 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="name" fontSize={10} tickLine={false} axisLine={false} interval={0} angle={-25} textAnchor="end" height={62} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip />
              <Legend />
              {sevKeys.map((s, i) => <Bar key={s} dataKey={s} stackId="a" name={s} fill={SEV_FILL[s]} radius={i === sevKeys.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} />)}
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// Card 2 — configurable single-series chart.
type Row = { name: string; value: number; fill: string };
type MetricKey = "avgDaysOpenBySeverity" | "openBySeverity" | "openByType" | "byStatus";
const METRICS: { key: MetricKey; label: string; unit?: string; chart: "pie" | "bar" }[] = [
  { key: "avgDaysOpenBySeverity", label: "Avg days open by severity", unit: "d", chart: "bar" },
  { key: "openBySeverity", label: "Open by severity", chart: "pie" },
  { key: "openByType", label: "Open by type", chart: "bar" },
  { key: "byStatus", label: "By status", chart: "bar" },
];

function compute(metric: MetricKey, complaints: ComplaintLite[]): { rows: Row[]; unit: string } {
  const open = complaints.filter((c) => c.status !== "Closed");
  if (metric === "avgDaysOpenBySeverity") {
    const sums: Record<string, number> = {}, cnts: Record<string, number> = {};
    for (const c of open) { if (!c.createdAt) continue; const k = sevKey(c.severity); sums[k] = (sums[k] ?? 0) + ageDays(c.createdAt); cnts[k] = (cnts[k] ?? 0) + 1; }
    return { rows: [...SEV_ORDER, "Other"].filter((s) => cnts[s]).map((s) => ({ name: s, value: Math.round(sums[s] / cnts[s]), fill: SEV_FILL[s] })), unit: "d" };
  }
  if (metric === "openBySeverity") {
    const c: Record<string, number> = {};
    for (const x of open) { const k = sevKey(x.severity); c[k] = (c[k] ?? 0) + 1; }
    return { rows: [...SEV_ORDER, "Other"].map((s) => ({ name: s, value: c[s] ?? 0, fill: SEV_FILL[s] })).filter((r) => r.value > 0), unit: "" };
  }
  if (metric === "openByType") {
    const m: Record<string, number> = {};
    for (const c of open) { const t = (c.complaintType ?? "").trim() || "Other"; m[t] = (m[t] ?? 0) + 1; }
    return { rows: Object.entries(m).map(([name, value]) => ({ name, value, fill: SINGLE })).sort((a, b) => b.value - a.value), unit: "" };
  }
  const m: Record<string, number> = {};
  for (const c of complaints) m[c.status] = (m[c.status] ?? 0) + 1;
  return { rows: Object.entries(m).map(([name, value]) => ({ name, value, fill: SINGLE })).sort((a, b) => b.value - a.value), unit: "" };
}

function ConfigurableChart({ complaints, defaultMetric }: { complaints: ComplaintLite[]; defaultMetric: MetricKey }) {
  const [metric, setMetric] = useState<MetricKey>(defaultMetric);
  const [byName, setByName] = useState(false);
  const meta = METRICS.find((m) => m.key === metric)!;
  const isPie = meta.chart === "pie";
  const { rows, unit } = compute(metric, complaints);
  const ordered = byName ? [...rows].sort((a, b) => a.name.localeCompare(b.name)) : rows;
  const data = isPie ? ordered.filter((r) => r.value > 0) : ordered;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <Select value={metric} onValueChange={(v) => setMetric(v as MetricKey)}>
            <SelectTrigger className="h-8 text-xs w-[200px]"><SelectValue /></SelectTrigger>
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
        {data.length === 0 ? EMPTY("No data for this view yet.") : isPie ? (
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={48} outerRadius={85} paddingAngle={2}>
                {data.map((r, idx) => <Cell key={idx} fill={r.fill} stroke="var(--background)" strokeWidth={2} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 55 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="name" fontSize={10} tickLine={false} axisLine={false} interval={0} angle={-25} textAnchor="end" height={62} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} unit={unit || undefined} allowDecimals={false} />
              <Tooltip formatter={(v: number) => [`${v}${unit === "d" ? " days" : ""}`, unit === "d" ? "Average" : "Complaints"]} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {data.map((r, idx) => <Cell key={idx} fill={r.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

export function ComplaintsCharts({ complaints }: { complaints: ComplaintLite[] }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <OpenByTypeSeverity complaints={complaints} />
      <ConfigurableChart complaints={complaints} defaultMetric="avgDaysOpenBySeverity" />
    </div>
  );
}
