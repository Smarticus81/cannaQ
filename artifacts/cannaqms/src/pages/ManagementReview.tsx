import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { ReviewCharts, type TrendRow } from "@/components/management-review/ReviewCharts";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { RefreshCw, AlertTriangle, ShieldCheck, ClipboardList, Factory, Package, Flame, GraduationCap, Radar, PenLine } from "lucide-react";
import { format, parseISO } from "date-fns";
import type { ReactNode } from "react";

// ── Types (mirror /api/management-review data payload) ────────────────────────
type OpenClose = { open: number; openedInWindow: number; closedInWindow: number };
type MRData = {
  periodStart: string;
  periodEnd: string;
  quality: { nonConformances: OpenClose; capas: OpenClose; complaints: OpenClose; fieldActions: OpenClose };
  operations: { productionYieldPct: number | null; batchesReleasedInWindow: number; testFirstPassRatePct: number | null; testPass: number; testFail: number; testPending: number };
  suppliers: { total: number; licenseRequired: number; licenseCurrent: number; licenseMissing: number; licenseExpired: number; needsAttention: number; riskTier: Record<string, number> };
  inventory: { materialLots: number; finishedGoodsLots: number; expiringSoon: number; expired: number };
  destruction: { recordsInWindow: number; weightByUom: Record<string, number> };
  metrcReconciliation: { checksCompletedInWindow: number; varianceLinesInWindow: number };
  training: { total: number; completed: number; overdue: number; compliancePct: number | null };
  documents: { active: number; overdueReview: number; dueSoon: number };
  regulatory: { bulletinsInWindow: number; openUnreviewed: number };
  compliance: { craReportableTotal: number; craReportableOpen: number };
};
type MRSnapshot = { generatedAt: string; trigger: string; periodStart: string; periodEnd: string; data: MRData };

type Tone = "neutral" | "good" | "warn" | "bad";
const toneClass: Record<Tone, string> = {
  neutral: "text-foreground",
  good: "text-green-700",
  warn: "text-amber-600",
  bad: "text-red-600",
};

function Stat({ label, value, tone = "neutral", suffix }: { label: string; value: string | number | null | undefined; tone?: Tone; suffix?: string }) {
  const shown = value === null || value === undefined ? "—" : `${value}${suffix ?? ""}`;
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <div className={`text-xl font-semibold tabular-nums ${toneClass[tone]}`}>{shown}</div>
      <div className="text-xs text-muted-foreground mt-0.5 leading-tight">{label}</div>
    </div>
  );
}

function Section({ title, icon: Icon, href, children }: { title: string; icon: typeof ShieldCheck; href?: string; children: ReactNode }) {
  const heading = (
    <div className="flex items-center gap-2 mb-2">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
    </div>
  );
  return (
    <section className="rounded-xl border bg-muted/20 p-4">
      {href ? <Link href={href} className="hover:underline">{heading}</Link> : heading}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">{children}</div>
    </section>
  );
}

export default function ManagementReview() {
  const queryClient = useQueryClient();
  const { data: snap, isLoading } = useQuery<MRSnapshot>({
    queryKey: ["management-review"],
    queryFn: async () => {
      const r = await fetch("/api/management-review", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load management review");
      return r.json();
    },
  });

  const refresh = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/management-review/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({}) });
      if (!r.ok) throw new Error("Refresh failed");
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["management-review"] }),
  });

  const [, navigate] = useLocation();
  const { data: currentUser } = useGetCurrentUser();
  const { toast } = useToast();
  const canManage = ["Manager", "Quality", "Admin"].includes(currentUser?.role ?? "");
  const [creating, setCreating] = useState(false);
  const reviews = useQuery<Array<{ id: number; reviewDate: string | null; status: string; periodStart: string | null; periodEnd: string | null; signedByName: string | null }>>({
    queryKey: ["management-review", "reviews"],
    queryFn: async () => { const r = await fetch("/api/management-review/reviews", { credentials: "include" }); return r.ok ? r.json() : []; },
  });
  const trends = useQuery<TrendRow[]>({
    queryKey: ["management-review", "trends"],
    queryFn: async () => { const r = await fetch("/api/dashboard/management-trends?months=12", { credentials: "include" }); if (!r.ok) return []; const j = await r.json(); return Array.isArray(j) ? j : (j.trend ?? []); },
  });
  async function conduct() {
    setCreating(true);
    try {
      const r = await fetch("/api/management-review/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: "{}" });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error ?? "Could not start a review");
      navigate(`/management-review/reviews/${b.id}`);
    } catch (e) { toast({ title: "Failed to start review", description: e instanceof Error ? e.message : String(e), variant: "destructive" }); setCreating(false); }
  }
  const d = snap?.data;
  const asOf = snap?.periodEnd ? format(parseISO(snap.periodEnd), "MMM d, yyyy") : "";
  const periodStart = snap?.periodStart ? format(parseISO(snap.periodStart), "MMM d, yyyy") : "";

  return (
    <AppLayout>
      <div className="space-y-6 max-w-6xl mx-auto pb-12">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Management Review</h1>
            <p className="text-muted-foreground">
              Standard quality-system health across the facility.
              {asOf && <> Snapshot as of <strong>{asOf}</strong> (12 months from {periodStart}).</>}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">Refreshes automatically each quarter. Use Update for an on-demand snapshot.</p>
          </div>
          <div className="flex gap-2 shrink-0">
            {canManage && (
              <Button size="sm" onClick={conduct} disabled={creating} className="gap-1.5">
                <PenLine className="h-4 w-4" />{creating ? "Starting…" : "Conduct review"}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => refresh.mutate()} disabled={refresh.isPending} className="gap-1.5">
              <RefreshCw className={`h-4 w-4 ${refresh.isPending ? "animate-spin" : ""}`} />
              {refresh.isPending ? "Updating…" : "Update"}
            </Button>
          </div>
        </div>

        {(reviews.data?.length ?? 0) > 0 && (
          <div className="rounded-xl border p-4">
            <p className="text-sm font-semibold mb-2">Recorded reviews</p>
            <div className="divide-y">
              {reviews.data!.slice(0, 8).map((rv) => (
                <Link key={rv.id} href={`/management-review/reviews/${rv.id}`} className="flex items-center justify-between py-2 text-sm hover:bg-muted/40 px-1 -mx-1 rounded">
                  <span>Review {rv.reviewDate ?? `#${rv.id}`}{rv.periodStart && rv.periodEnd ? ` · ${rv.periodStart} → ${rv.periodEnd}` : ""}</span>
                  <span className={rv.status === "signed" ? "text-blue-700 font-medium" : "text-muted-foreground"}>{rv.status === "signed" ? `Signed${rv.signedByName ? ` · ${rv.signedByName}` : ""}` : "Draft"}</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {isLoading || !d ? (
          <div className="grid gap-4">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
          </div>
        ) : (
          <div className="grid gap-4">
            <ReviewCharts data={d} trend={trends.data} />
            <Section title="Quality System (12-month)" icon={ClipboardList} href="/non-conformances">
              <Stat label="Nonconformances open" value={d.quality.nonConformances.open} tone={d.quality.nonConformances.open > 0 ? "warn" : "good"} />
              <Stat label="CAPAs open" value={d.quality.capas.open} tone={d.quality.capas.open > 0 ? "warn" : "good"} />
              <Stat label="Complaints open" value={d.quality.complaints.open} tone={d.quality.complaints.open > 0 ? "warn" : "good"} />
              <Stat label="Field actions open" value={d.quality.fieldActions.open} tone={d.quality.fieldActions.open > 0 ? "bad" : "good"} />
              <Stat label="NCs opened / closed" value={`${d.quality.nonConformances.openedInWindow} / ${d.quality.nonConformances.closedInWindow}`} />
              <Stat label="CAPAs opened / closed" value={`${d.quality.capas.openedInWindow} / ${d.quality.capas.closedInWindow}`} />
              <Stat label="Complaints opened / closed" value={`${d.quality.complaints.openedInWindow} / ${d.quality.complaints.closedInWindow}`} />
              <Stat label="Field actions opened / closed" value={`${d.quality.fieldActions.openedInWindow} / ${d.quality.fieldActions.closedInWindow}`} />
            </Section>

            <Section title="Operations" icon={Factory} href="/batches">
              <Stat label="Production Yield (avg)" value={d.operations.productionYieldPct} suffix="%" tone={d.operations.productionYieldPct != null && d.operations.productionYieldPct < 90 ? "warn" : "good"} />
              <Stat label="Lab Test First-Pass Rate" value={d.operations.testFirstPassRatePct} suffix="%" tone={d.operations.testFirstPassRatePct != null && d.operations.testFirstPassRatePct < 80 ? "warn" : "good"} />
              <Stat label="Batches released" value={d.operations.batchesReleasedInWindow} />
              <Stat label="Tests pass / fail / pending" value={`${d.operations.testPass} / ${d.operations.testFail} / ${d.operations.testPending}`} />
            </Section>

            <Section title="Suppliers" icon={ShieldCheck} href="/suppliers">
              <Stat label="Suppliers (active)" value={d.suppliers.total} />
              <Stat label="License required" value={d.suppliers.licenseRequired} />
              <Stat label="License current" value={d.suppliers.licenseCurrent} tone="good" />
              <Stat label="Missing / expired license" value={d.suppliers.needsAttention} tone={d.suppliers.needsAttention > 0 ? "bad" : "good"} />
              <Stat label="Risk: Critical" value={d.suppliers.riskTier.Critical ?? 0} tone={(d.suppliers.riskTier.Critical ?? 0) > 0 ? "bad" : "good"} />
              <Stat label="Risk: High" value={d.suppliers.riskTier.High ?? 0} tone={(d.suppliers.riskTier.High ?? 0) > 0 ? "warn" : "good"} />
              <Stat label="Risk: Medium" value={d.suppliers.riskTier.Medium ?? 0} />
              <Stat label="Risk: Low" value={d.suppliers.riskTier.Low ?? 0} tone="good" />
            </Section>

            <Section title="Inventory & Materials" icon={Package} href="/inventory">
              <Stat label="Material lots on hand" value={d.inventory.materialLots} />
              <Stat label="Finished-goods lots" value={d.inventory.finishedGoodsLots} />
              <Stat label="Expiring soon (60d)" value={d.inventory.expiringSoon} tone={d.inventory.expiringSoon > 0 ? "warn" : "good"} />
              <Stat label="Expired on hand" value={d.inventory.expired} tone={d.inventory.expired > 0 ? "bad" : "good"} />
            </Section>

            <Section title="Destruction & METRC Reconciliation" icon={Flame} href="/inventory-checks">
              <Stat label="Destruction records (12mo)" value={d.destruction.recordsInWindow} />
              <Stat label="Inventory checks completed" value={d.metrcReconciliation.checksCompletedInWindow} />
              <Stat label="Reconciliation variances" value={d.metrcReconciliation.varianceLinesInWindow} tone={d.metrcReconciliation.varianceLinesInWindow > 0 ? "warn" : "good"} />
            </Section>

            <Section title="Training & Documents" icon={GraduationCap} href="/training">
              <Stat label="Training compliance" value={d.training.compliancePct} suffix="%" tone={d.training.compliancePct != null && d.training.compliancePct < 90 ? "warn" : "good"} />
              <Stat label="Training overdue" value={d.training.overdue} tone={d.training.overdue > 0 ? "warn" : "good"} />
              <Stat label="Documents active" value={d.documents.active} />
              <Stat label="Docs overdue for review" value={d.documents.overdueReview} tone={d.documents.overdueReview > 0 ? "warn" : "good"} />
            </Section>

            <Section title="Compliance & Regulatory" icon={Radar} href="/regulatory-intel">
              <Stat label="CRA-reportable (open)" value={d.compliance.craReportableOpen} tone={d.compliance.craReportableOpen > 0 ? "bad" : "good"} />
              <Stat label="CRA-reportable (total 12mo)" value={d.compliance.craReportableTotal} />
              <Stat label="Reg. bulletins (12mo)" value={d.regulatory.bulletinsInWindow} />
              <Stat label="Bulletins unreviewed" value={d.regulatory.openUnreviewed} tone={d.regulatory.openUnreviewed > 0 ? "warn" : "good"} />
            </Section>

            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3" />
              A signed, recordable Management Review (attendees, notes, action items, Part 11 sign-off) is planned for a later phase. This is the live standard view.
            </p>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
