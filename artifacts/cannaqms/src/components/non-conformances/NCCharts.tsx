import { useState } from "react";
import {
  ResponsiveContainer,
  BarChart, Bar, Cell,
  LineChart, Line,
  PieChart, Pie, Legend,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ArrowUpDown } from "lucide-react";

// Non-conformance overview charts (configurable). Form follows the data: share-of
// -a-whole metrics (severity, resolution-time buckets, status) render as DONUTS;
// rankings (source) and AVERAGES (avg age / days-to-close) render as BARS — a pie
// of averages would mislead since averages don't sum to a whole. Severity uses
// reserved status colors (Minor=blue, Major=amber, Critical=red); closure buckets
// ramp green -> red as they slow.
const SINGLE = "#3b82f6";
const NEUTRAL = "#94a3b8";
const SEV_ORDER = ["Minor", "Major", "Critical", "Other"];
const SEV_FILL: Record<string, string> = { Minor: "#3b82f6", Major: "#f59e0b", Critical: "#dc2626", Other: NEUTRAL };
const BUCKET_ORDER = ["<30d", "30–60d", "60–90d", "90+ d"];
const BUCKET_FILL: Record<string, string> = { "<30d": "#16a34a", "30–60d": "#f59e0b", "60–90d": "#d97706", "90+ d": "#dc2626" };

type NcLite = {
  status: string;
  severity?: string | null;
  source?: string | null;
  createdAt?: string | null;
  closedAt?: string | null;
  // 2026-09-02 — the TYPE of the non-conformance. Confirmed wins over as-found:
  // as-found is what the reporter thought it was, confirmed is what it turned
  // out to be, and the metric should count the truth.
  ncTypeConfirmed?: string | null;
  ncTypeAsFound?: string | null;
};

/** `count` is only set where the average hides a sample size worth showing. */
type Row = { name: string; value: number; fill: string; count?: number };
type MetricKey = "openBySeverity" | "openByType" | "bySource" | "closureBuckets" | "avgAgeBySeverity" | "avgCloseBySeverity" | "avgCloseByMonth" | "byStatus";

const METRICS: { key: MetricKey; label: string; unit?: string; chart: "pie" | "bar" | "line" }[] = [
  { key: "openBySeverity", label: "Open NCs by severity", chart: "pie" },
  { key: "openByType", label: "Open NCs by type", chart: "bar" },
  { key: "bySource", label: "NCs by source", chart: "bar" },
  { key: "closureBuckets", label: "Closed by resolution time", chart: "pie" },
  { key: "avgAgeBySeverity", label: "Avg age of open, by severity", unit: "d", chart: "bar" },
  { key: "avgCloseBySeverity", label: "Avg days to close, by severity", unit: "d", chart: "bar" },
  { key: "avgCloseByMonth", label: "Avg days to close, by month", unit: "d", chart: "line" },
  { key: "byStatus", label: "NCs by status", chart: "bar" },
];

const sevKey = (s: string | null | undefined): string => {
  const v = (s ?? "").trim();
  return v === "Minor" || v === "Major" || v === "Critical" ? v : "Other";
};
/** Which type to count an NC as. Confirmed is the truth; as-found is the guess. */
const typeKey = (n: NcLite): string =>
  ((n.ncTypeConfirmed ?? "").trim() || (n.ncTypeAsFound ?? "").trim() || "Unspecified");
const days = (a: string, b: string): number => Math.max(0, Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000));
const ageDays = (a: string): number => Math.max(0, Math.floor((Date.now() - new Date(a).getTime()) / 86400000));

function compute(metric: MetricKey, ncs: NcLite[]): { rows: Row[]; unit: string } {
  if (metric === "openBySeverity") {
    const c: Record<string, number> = {};
    for (const n of ncs) if (n.status !== "Closed") { const k = sevKey(n.severity); c[k] = (c[k] ?? 0) + 1; }
    return { rows: SEV_ORDER.map((s) => ({ name: s, value: c[s] ?? 0, fill: SEV_FILL[s] })).filter((r) => r.value > 0), unit: "" };
  }
  if (metric === "openByType") {
    // ⛔ OPEN only, like its severity twin — what is on the floor now, not a
    // history. Everything unclassified lands in one honest bucket rather than
    // being dropped, or the bars would quietly under-count.
    const m: Record<string, number> = {};
    for (const n of ncs) if (n.status !== "Closed") { const k = typeKey(n); m[k] = (m[k] ?? 0) + 1; }
    return { rows: Object.entries(m).map(([name, value]) => ({ name, value, fill: SINGLE })).sort((a, b) => b.value - a.value), unit: "" };
  }
  if (metric === "avgCloseByMonth") {
    // A RUNNING figure, his ask 2026-09-02: how long NCs took to close, month by
    // month, so the trend is visible rather than one number for all time.
    // Counted in the month each NC CLOSED, over the last 12 months.
    //
    // ⛔ A month with no closures is SKIPPED, not plotted as zero. Zero days to
    // close is a claim; "nothing closed" is the truth, and drawing it as zero
    // would show a month of perfect performance that never happened.
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth() - 11, 1).getTime();
    const sums: Record<string, number> = {}, cnts: Record<string, number> = {}, order: string[] = [];
    for (const n of ncs) {
      if (n.status !== "Closed" || !n.closedAt || !n.createdAt) continue;
      const closed = new Date(n.closedAt);
      if (closed.getTime() < cutoff) continue;
      // Local getters on purpose: closedAt is a full timestamp, not a date-only
      // value, so there is no UTC midnight to fall off the front of.
      const k = `${closed.getFullYear()}-${String(closed.getMonth() + 1).padStart(2, "0")}`;
      if (!(k in sums)) { sums[k] = 0; cnts[k] = 0; order.push(k); }
      sums[k] += days(n.createdAt, n.closedAt);
      cnts[k] += 1;
    }
    const rows = order.sort().map((k) => {
      const [y, mo] = k.split("-");
      const label = new Date(Number(y), Number(mo) - 1, 1)
        .toLocaleString(undefined, { month: "short" }) + " " + y.slice(2);
      return { name: label, value: Math.round(sums[k] / cnts[k]), fill: SINGLE, count: cnts[k] };
    });
    return { rows, unit: "d" };
  }
  if (metric === "bySource") {
    const m: Record<string, number> = {};
    for (const n of ncs) { const s = (n.source ?? "").trim() || "Unspecified"; m[s] = (m[s] ?? 0) + 1; }
    return { rows: Object.entries(m).map(([name, value]) => ({ name, value, fill: SINGLE })).sort((a, b) => b.value - a.value), unit: "" };
  }
  if (metric === "closureBuckets") {
    const c: Record<string, number> = { "<30d": 0, "30–60d": 0, "60–90d": 0, "90+ d": 0 };
    for (const n of ncs) {
      if (n.status !== "Closed" || !n.closedAt || !n.createdAt) continue;
      const d = days(n.createdAt, n.closedAt);
      c[d < 30 ? "<30d" : d < 60 ? "30–60d" : d < 90 ? "60–90d" : "90+ d"] += 1;
    }
    return { rows: BUCKET_ORDER.map((b) => ({ name: b, value: c[b], fill: BUCKET_FILL[b] })), unit: "" };
  }
  if (metric === "avgAgeBySeverity" || metric === "avgCloseBySeverity") {
    const sums: Record<string, number> = {}, cnts: Record<string, number> = {};
    for (const n of ncs) {
      if (metric === "avgAgeBySeverity") {
        if (n.status === "Closed" || !n.createdAt) continue;
        const k = sevKey(n.severity); sums[k] = (sums[k] ?? 0) + ageDays(n.createdAt); cnts[k] = (cnts[k] ?? 0) + 1;
      } else {
        if (n.status !== "Closed" || !n.closedAt || !n.createdAt) continue;
        const k = sevKey(n.severity); sums[k] = (sums[k] ?? 0) + days(n.createdAt, n.closedAt); cnts[k] = (cnts[k] ?? 0) + 1;
      }
    }
    return { rows: SEV_ORDER.filter((s) => cnts[s]).map((s) => ({ name: s, value: Math.round(sums[s] / cnts[s]), fill: SEV_FILL[s] })), unit: "d" };
  }
  const m: Record<string, number> = {};
  for (const n of ncs) m[n.status] = (m[n.status] ?? 0) + 1;
  return { rows: Object.entries(m).map(([name, value]) => ({ name, value, fill: NEUTRAL })).sort((a, b) => b.value - a.value), unit: "" };
}

function ConfigurableChart({ ncs, defaultMetric }: { ncs: NcLite[]; defaultMetric: MetricKey }) {
  const [metric, setMetric] = useState<MetricKey>(defaultMetric);
  const [byName, setByName] = useState(false);
  const meta = METRICS.find((m) => m.key === metric)!;
  const isPie = meta.chart === "pie";
  // ⛔ A time axis is never re-sorted. The months are already in order and A–Z
  // on "Apr, Aug, Dec" would be nonsense, so the toggle is hidden for the line.
  const isLine = meta.chart === "line";
  const { rows, unit } = compute(metric, ncs);
  const ordered = byName && !isLine ? [...rows].sort((a, b) => a.name.localeCompare(b.name)) : rows;
  const data = isPie ? ordered.filter((r) => r.value > 0) : ordered;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <Select value={metric} onValueChange={(v) => setMetric(v as MetricKey)}>
            <SelectTrigger className="h-8 text-xs w-[210px]"><SelectValue /></SelectTrigger>
            <SelectContent>{METRICS.map((m) => <SelectItem key={m.key} value={m.key} className="text-xs">{m.label}</SelectItem>)}</SelectContent>
          </Select>
          {!isPie && !isLine && (
            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs gap-1 shrink-0" onClick={() => setByName((v) => !v)} title="Toggle sort order">
              <ArrowUpDown className="h-3.5 w-3.5" />{byName ? "A–Z" : "Value"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="h-[220px] flex items-center justify-center text-center text-sm text-muted-foreground px-4">No data for this view yet.</p>
        ) : isPie ? (
          <ResponsiveContainer width="100%" height={320}>
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={45} outerRadius={80} paddingAngle={2}>
                {data.map((r, idx) => <Cell key={idx} fill={r.fill} stroke="var(--background)" strokeWidth={2} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        ) : isLine ? (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 45 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="name" fontSize={10} tickLine={false} axisLine={false} interval={0} angle={-25} textAnchor="end" height={52} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} unit={unit || undefined} allowDecimals={false} />
              <Tooltip
                formatter={(v: number, _n: string, p: { payload?: Row }) => {
                  const c = p?.payload?.count;
                  return [`${v} days${c ? ` (${c} closed)` : ""}`, "Average"];
                }}
              />
              <Line type="monotone" dataKey="value" stroke={SINGLE} strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 45 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="name" fontSize={10} tickLine={false} axisLine={false} interval={0} angle={-25} textAnchor="end" height={52} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} unit={unit || undefined} allowDecimals={false} />
              <Tooltip formatter={(v: number) => [`${v}${unit === "d" ? " days" : ""}`, unit === "d" ? "Average" : "NCs"]} />
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

export function NCCharts({ ncs }: { ncs: NcLite[] }) {
  // One larger, sortable chart — pick the metric + sort from its controls
  // (was four fixed charts; Jonathan 2026-08-13, matching Inventory / Finished Goods).
  return <ConfigurableChart ncs={ncs} defaultMetric="openBySeverity" />;
}
