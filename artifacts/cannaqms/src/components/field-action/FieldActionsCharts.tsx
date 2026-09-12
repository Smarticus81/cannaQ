import { useState } from "react";
import {
  ResponsiveContainer,
  BarChart, Bar, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ArrowUpDown } from "lucide-react";

// Field Action overview charts (configurable). MI field actions are response-
// driven, so recovery % per FA = accounted units (returned + destroyed, from the
// store response confirmations) / affected units. Store-response status is a
// funnel of notified -> form received -> returned/destroyed.
const SINGLE = "#3b82f6";
const NEUTRAL = "#94a3b8";
const GREEN = "#16a34a";
const AMBER = "#f59e0b";
const RED = "#dc2626";
const INDIGO = "#6366f1";

type ResponseSummary = {
  stores: number; notified: number; formReceived: number; destroyed: number; returned: number;
  unitsAffected: number; unitsAccounted: number; batches: number; lots: number; recoveryPct: number | null;
};
type FaLite = {
  actionType?: string | null;
  status?: string | null;
  faNumber?: string | null;
  responseSummary?: ResponseSummary | null;
};
const EMPTY_RS: ResponseSummary = { stores: 0, notified: 0, formReceived: 0, destroyed: 0, returned: 0, unitsAffected: 0, unitsAccounted: 0, batches: 0, lots: 0, recoveryPct: null };
const rs = (f: FaLite): ResponseSummary => f.responseSummary ?? EMPTY_RS;

type Row = { name: string; value: number; fill: string };
type MetricKey = "openByType" | "recoveryPerFA" | "responseStatus" | "reachPerFA" | "byStatus";
const METRICS: { key: MetricKey; label: string; isPct?: boolean }[] = [
  { key: "openByType", label: "Open by type" },
  { key: "recoveryPerFA", label: "Recovery % per field action", isPct: true },
  { key: "responseStatus", label: "Store response status" },
  { key: "reachPerFA", label: "Reach (stores) per field action" },
  { key: "byStatus", label: "By status" },
];

const isOpen = (f: FaLite): boolean => (f.status ?? "") !== "Closed";

function compute(metric: MetricKey, fas: FaLite[]): { rows: Row[]; isPct: boolean } {
  const open = fas.filter(isOpen);
  if (metric === "openByType") {
    const m: Record<string, number> = {};
    for (const f of open) { const t = (f.actionType ?? "").trim() || "Other"; m[t] = (m[t] ?? 0) + 1; }
    return { rows: Object.entries(m).map(([name, value]) => ({ name, value, fill: SINGLE })).sort((a, b) => b.value - a.value), isPct: false };
  }
  if (metric === "byStatus") {
    const m: Record<string, number> = {};
    for (const f of fas) { const st = (f.status ?? "").trim() || "Unknown"; m[st] = (m[st] ?? 0) + 1; }
    return { rows: Object.entries(m).map(([name, value]) => ({ name, value, fill: NEUTRAL })).sort((a, b) => b.value - a.value), isPct: false };
  }
  if (metric === "recoveryPerFA") {
    const rows = open
      .filter((f) => rs(f).recoveryPct != null)
      .map((f) => { const p = rs(f).recoveryPct as number; return { name: f.faNumber ?? "FA", value: p, fill: p >= 100 ? GREEN : p >= 50 ? AMBER : RED }; })
      .sort((a, b) => a.value - b.value);
    return { rows, isPct: true };
  }
  if (metric === "reachPerFA") {
    const rows = open
      .map((f) => ({ name: f.faNumber ?? "FA", value: rs(f).stores, fill: SINGLE }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);
    return { rows, isPct: false };
  }
  // responseStatus — funnel across open FAs.
  let pending = 0, notified = 0, form = 0, returned = 0, destroyed = 0;
  for (const f of open) { const a = rs(f); pending += Math.max(0, a.stores - a.notified); notified += a.notified; form += a.formReceived; returned += a.returned; destroyed += a.destroyed; }
  return {
    rows: [
      { name: "Pending", value: pending, fill: NEUTRAL },
      { name: "Notified", value: notified, fill: SINGLE },
      { name: "Form received", value: form, fill: INDIGO },
      { name: "Returned", value: returned, fill: AMBER },
      { name: "Destroyed", value: destroyed, fill: GREEN },
    ],
    isPct: false,
  };
}

const EMPTY = (m: string) => <p className="h-[220px] flex items-center justify-center text-center text-sm text-muted-foreground px-4">{m}</p>;

function ConfigurableChart({ fas, defaultMetric }: { fas: FaLite[]; defaultMetric: MetricKey }) {
  const [metric, setMetric] = useState<MetricKey>(defaultMetric);
  const [byName, setByName] = useState(false);
  const { rows, isPct } = compute(metric, fas);
  const data = byName ? [...rows].sort((a, b) => a.name.localeCompare(b.name)) : rows;
  const allZero = data.length > 0 && data.every((r) => r.value === 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <Select value={metric} onValueChange={(v) => setMetric(v as MetricKey)}>
            <SelectTrigger className="h-8 text-xs w-[210px]"><SelectValue /></SelectTrigger>
            <SelectContent>{METRICS.map((m) => <SelectItem key={m.key} value={m.key} className="text-xs">{m.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs gap-1 shrink-0" onClick={() => setByName((v) => !v)} title="Toggle sort order">
            <ArrowUpDown className="h-3.5 w-3.5" />{byName ? "A–Z" : "Value"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {data.length === 0 || allZero ? EMPTY(isPct ? "No affected-unit totals recorded yet." : "No data for this view yet.") : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 55 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="name" fontSize={10} tickLine={false} axisLine={false} interval={0} angle={-25} textAnchor="end" height={62} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} unit={isPct ? "%" : undefined} allowDecimals={false} />
              <Tooltip formatter={(v: number) => isPct ? [`${v}% accounted for`, "Recovery"] : [`${v}`, "Count"]} />
              {isPct && <ReferenceLine y={100} stroke="#16a34a" strokeDasharray="4 2" />}
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

export function FieldActionsCharts({ fieldActions }: { fieldActions: FaLite[] }) {
  // One larger, sortable chart — pick the metric + sort from its controls
  // (was four fixed charts; Jonathan 2026-08-13, matching Inventory / Finished Goods).
  return <ConfigurableChart fas={fieldActions} defaultMetric="openByType" />;
}
