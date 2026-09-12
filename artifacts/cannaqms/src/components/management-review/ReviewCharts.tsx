import type { ReactNode } from "react";
import {
  ResponsiveContainer,
  BarChart, Bar,
  LineChart, Line,
  PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Snapshot subset this component needs (mirrors /api/management-review data).
// New fields are optional so callers typed against the older snapshot still pass.
export type ReviewChartData = {
  quality: {
    nonConformances: { openedInWindow: number; closedInWindow: number };
    capas: { openedInWindow: number; closedInWindow: number };
    complaints: { openedInWindow: number; closedInWindow: number };
    fieldActions: { openedInWindow: number; closedInWindow: number };
  };
  operations: { testPass: number; testFail: number; testPending: number; productionYieldPct?: number | null; testFirstPassRatePct?: number | null };
  suppliers: { licenseCurrent: number; licenseMissing: number; licenseExpired: number; riskTier: Record<string, number> };
  inventory: { materialLots: number; finishedGoodsLots: number; expiringSoon: number; expired: number; byCategory?: { ingredients: number; materials: number; finishedGoods: number } };
  documents?: { overdueReview: number; withReview?: number; dueByMonth?: { month: string; count: number }[] };
};

export type TrendRow = { month: string; qualityOpened: number; qualityClosed: number; batchesMade?: number; batchesReleased?: number };

// Palette matches Dashboard.tsx so charts read as one system. Status colors are
// reserved (good=green, bad=red, neutral=gray); categorical hues in fixed order.
const OPENED = "#dc2626";
const CLOSED = "#16a34a";
const GREEN = "#16a34a";
const RED = "#dc2626";
const GRAY = "#94a3b8";
const AMBER = "#f59e0b";
const BLUE = "#3b82f6";
const INDIGO = "#6366f1";

function ChartCard({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <Card className={wide ? "md:col-span-2" : ""}>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function PieCard({ data }: { data: { name: string; value: number; fill: string }[] }) {
  const shown = data.filter((d) => d.value > 0);
  if (!shown.length) return <p className="h-[220px] flex items-center justify-center text-sm text-muted-foreground">No data in this window.</p>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie data={shown} dataKey="value" nameKey="name" innerRadius={45} outerRadius={80} paddingAngle={2}>
          {shown.map((d, i) => <Cell key={i} fill={d.fill} stroke="var(--background)" strokeWidth={2} />)}
        </Pie>
        <Tooltip />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}

function BarCard({ data }: { data: { name: string; value: number; fill: string }[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
        <XAxis dataKey="name" fontSize={11} tickLine={false} axisLine={false} interval={0} />
        <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip />
        <Bar dataKey="value" name="Count" radius={[4, 4, 0, 0]}>
          {data.map((r, i) => <Cell key={i} fill={r.fill} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function monthLabel(m: string): string {
  try { return new Date(m + "-01T00:00:00").toLocaleDateString(undefined, { month: "short", year: "2-digit" }); }
  catch { return m; }
}

export function ReviewCharts({ data, trend }: { data: ReviewChartData; trend?: TrendRow[] }) {
  const quality = [
    { name: "NCs", Opened: data.quality.nonConformances.openedInWindow, Closed: data.quality.nonConformances.closedInWindow },
    { name: "CAPAs", Opened: data.quality.capas.openedInWindow, Closed: data.quality.capas.closedInWindow },
    { name: "Complaints", Opened: data.quality.complaints.openedInWindow, Closed: data.quality.complaints.closedInWindow },
    { name: "Field actions", Opened: data.quality.fieldActions.openedInWindow, Closed: data.quality.fieldActions.closedInWindow },
  ];
  const tests = [
    { name: "Pass", value: data.operations.testPass, fill: GREEN },
    { name: "Fail", value: data.operations.testFail, fill: RED },
    { name: "Pending", value: data.operations.testPending, fill: GRAY },
  ];
  const risk = [
    { name: "Critical", value: data.suppliers.riskTier.Critical ?? 0, fill: RED },
    { name: "High", value: data.suppliers.riskTier.High ?? 0, fill: AMBER },
    { name: "Medium", value: data.suppliers.riskTier.Medium ?? 0, fill: BLUE },
    { name: "Low", value: data.suppliers.riskTier.Low ?? 0, fill: GREEN },
  ];
  const licenses = [
    { name: "Current", value: data.suppliers.licenseCurrent, fill: GREEN },
    { name: "Missing", value: data.suppliers.licenseMissing, fill: GRAY },
    { name: "Expired", value: data.suppliers.licenseExpired, fill: RED },
  ];
  const invStatus = [
    { name: "Material lots", value: data.inventory.materialLots, fill: BLUE },
    { name: "Finished lots", value: data.inventory.finishedGoodsLots, fill: INDIGO },
    { name: "Expiring soon", value: data.inventory.expiringSoon, fill: AMBER },
    { name: "Expired", value: data.inventory.expired, fill: RED },
  ];

  const cat = data.inventory.byCategory;
  const invByCategory = cat ? [
    { name: "Ingredients", value: cat.ingredients, fill: GREEN },
    { name: "Materials", value: cat.materials, fill: BLUE },
    { name: "Finished Goods", value: cat.finishedGoods, fill: INDIGO },
  ] : null;

  const ops = data.operations;
  const opsKpi = (ops.productionYieldPct != null || ops.testFirstPassRatePct != null) ? [
    { name: "Production Yield", value: ops.productionYieldPct ?? 0, fill: INDIGO },
    { name: "Test First-Pass", value: ops.testFirstPassRatePct ?? 0, fill: BLUE },
  ] : null;

  const dueByMonth = data.documents?.dueByMonth?.map((r) => ({ name: monthLabel(r.month), value: r.count, fill: BLUE })) ?? null;
  const withReview = data.documents?.withReview;
  const overdue = data.documents?.overdueReview;
  const docTimeliness = (withReview != null && overdue != null) ? [
    { name: "Reviewed on time", value: Math.max(0, withReview - overdue), fill: GREEN },
    { name: "Overdue", value: overdue, fill: RED },
  ] : null;

  const showBatchesTrend = Array.isArray(trend) && trend.some((t) => t.batchesMade != null || t.batchesReleased != null);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {Array.isArray(trend) && trend.length > 0 && (
        <ChartCard title="Quality events — opened vs closed by month" wide>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="month" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="qualityOpened" name="Opened" stroke={OPENED} strokeWidth={2} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="qualityClosed" name="Closed" stroke={CLOSED} strokeWidth={2} dot={{ r: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {showBatchesTrend && (
        <ChartCard title="Batches — made vs released by month" wide>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="month" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="batchesMade" name="Made" stroke={BLUE} strokeWidth={2} dot={{ r: 2 }} />
              <Line type="monotone" dataKey="batchesReleased" name="Released" stroke={GREEN} strokeWidth={2} dot={{ r: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {opsKpi && (
        <ChartCard title="Operations KPIs (%)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={opsKpi} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis dataKey="name" fontSize={11} tickLine={false} axisLine={false} interval={0} />
              <YAxis fontSize={11} tickLine={false} axisLine={false} domain={[0, 100]} unit="%" />
              <Tooltip />
              <Bar dataKey="value" name="Percent" radius={[4, 4, 0, 0]}>
                {opsKpi.map((r, i) => <Cell key={i} fill={r.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      <ChartCard title="Lab test results (12 mo)"><PieCard data={tests} /></ChartCard>

      <ChartCard title="Quality events — opened vs closed (12 mo)">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={quality} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
            <XAxis dataKey="name" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Bar dataKey="Opened" fill={OPENED} radius={[4, 4, 0, 0]} />
            <Bar dataKey="Closed" fill={CLOSED} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Supplier risk tiers"><BarCard data={risk} /></ChartCard>
      <ChartCard title="Supplier licenses"><PieCard data={licenses} /></ChartCard>

      {invByCategory && <ChartCard title="Inventory volume — by category"><PieCard data={invByCategory} /></ChartCard>}
      <ChartCard title="Inventory & materials"><BarCard data={invStatus} /></ChartCard>

      {dueByMonth && <ChartCard title="Documents due for review — next 3 months"><BarCard data={dueByMonth} /></ChartCard>}
      {docTimeliness && <ChartCard title="Document review timeliness"><PieCard data={docTimeliness} /></ChartCard>}
    </div>
  );
}
