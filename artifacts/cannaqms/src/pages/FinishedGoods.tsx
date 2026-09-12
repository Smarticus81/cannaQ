import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PackageCheck, RefreshCw, AlertTriangle, Info, CheckCircle2, Factory } from "lucide-react";
import { format, parseISO } from "date-fns";
import { Link } from "wouter";
import { useListBatchRecords } from "@workspace/api-client-react";
import { TermTip } from "@/components/ui/TermTip";
import { batchStateLabel } from "@/lib/status";
import { FinishedGoodsCharts } from "@/components/finished-goods/FinishedGoodsCharts";

// FG-1 (Feedback 07-05) — a batch Released in CannaQMS is finished goods and
// must appear here, even before it's reconciled against METRC. The page below
// leads with locally-Released batches, then shows METRC's live active packages
// underneath for reconciliation. (FG-2 will add per-batch METRC match/variance.)
const FINISHED_GOODS_STATUSES = new Set(["released_to_inventory", "finished_goods"]);
// 2026-09-08 — was a local copy that drifted after both statuses were
// renamed; reads the shared map in lib/status.ts now.
const batchStatusLabel = (s: string) => batchStateLabel(s, true);

// Session 97 — Finished-goods on hand, read LIVE from Metrc's active packages.
// Read-only, no local finished-goods model; a manager reconciles this against
// physical counts during inventory checks. The route returns the house
// diagnostic-200 shape: { ok, data: { Data: [...] }, config, kind?, error? }.
type MetrcPackage = {
  Id: number;
  Label: string;
  Quantity: number;
  UnitOfMeasureName: string;
  PackagedDate: string;
  IsFinished: boolean;
  Item?: { Name?: string } | null;
  [k: string]: unknown;
};
type MetrcActiveResp = {
  ok: boolean;
  metrcStatus?: number;
  kind?: string;
  error?: string;
  config?: { configured?: boolean; [k: string]: unknown };
  data?: { Data?: MetrcPackage[] } | null;
};

const itemName = (p: MetrcPackage): string =>
  p.Item?.Name ??
  (p["ProductName"] as string | undefined) ??
  (p["ItemName"] as string | undefined) ??
  "—";

const fmtDate = (v: string | undefined): string => {
  if (!v) return "—";
  try { return format(parseISO(v), "MMM d, yyyy"); } catch { return v; }
};

// Expiration is stored/locked on the batch at release. Read loosely since the
// generated batch type may not include the new column yet.
const expOf = (b: object): string | null => (b as { expirationDate?: string | null }).expirationDate ?? null;
const daysUntil = (iso: string): number => Math.ceil((parseISO(iso).getTime() - Date.now()) / 86400000);

export default function FinishedGoods() {
  const { data, isLoading, isFetching, refetch } = useQuery<MetrcActiveResp>({
    queryKey: ["metrc-active-packages"],
    queryFn: async () => {
      const r = await fetch("/api/metrc/packages/active");
      return r.json();
    },
  });

  const packages = data?.data?.Data ?? [];
  const notConfigured = data && !data.ok && (data.kind === "not_configured" || data.config?.configured === false);
  const errored = data && !data.ok && !notConfigured;

  // Session 97 — reconcile the live Metrc tags against what CannaQMS has on record
  // (a batch single tag, its process-start tag, or a recorded tag range). Lets a
  // manager see which packages trace to a batch here vs. which are unrecorded.
  const labels = packages.map((p) => p.Label).filter((l): l is string => !!l);
  type ReconResult = { tag: string; recorded: boolean; matchKind?: string; batchId?: number; batchNumber?: string };
  const { data: reconcile } = useQuery<{ results: ReconResult[] }>({
    queryKey: ["metrc-tag-reconcile", labels],
    enabled: labels.length > 0,
    queryFn: async () => {
      const r = await fetch("/api/metrc-tags/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: labels }),
      });
      return r.json();
    },
  });
  const recByTag = new Map((reconcile?.results ?? []).map((r) => [r.tag, r]));
  const recordedCount = (reconcile?.results ?? []).filter((r) => r.recorded).length;

  // Per-unit totals for the summary line.
  const totalsByUnit = packages.reduce<Record<string, number>>((acc, p) => {
    const u = (p.UnitOfMeasureName ?? "ea").trim() || "ea";
    acc[u] = (acc[u] ?? 0) + (p.Quantity ?? 0);
    return acc;
  }, {});
  const totalsLabel = Object.entries(totalsByUnit)
    .map(([u, q]) => `${Math.round(q * 100) / 100} ${u}`)
    .join(" · ");

  // FG-1 — locally-Released batches are finished goods. Pull them from CannaQMS
  // (independent of METRC) so a Released batch always appears here.
  const { data: batches, isLoading: batchesLoading } = useListBatchRecords();
  const releasedBatches = (batches ?? [])
    .filter((b) => FINISHED_GOODS_STATUSES.has(b.status))
    // FIFO — soonest expiry first; undated batches fall to the bottom by recency.
    .sort((a, b) => {
      const ea = expOf(a), eb = expOf(b);
      if (ea && eb) return ea.localeCompare(eb);
      if (ea) return -1;
      if (eb) return 1;
      return (b.approvalDate ?? b.productionDate ?? "").localeCompare(a.approvalDate ?? a.productionDate ?? "");
    });

  // FG-2 — reconcile each Released batch against METRC. Aggregate the live active
  // packages back to their batch via the reconcile map (handles single tag,
  // batch-number root, and recorded RANGE — i.e. many sellable units per batch),
  // then compare METRC's on-hand quantity to the batch's recorded output.
  type MetrcAgg = { count: number; qty: number };
  const metrcByBatchId = new Map<number, MetrcAgg>();
  for (const p of packages) {
    const rec = recByTag.get(p.Label);
    if (rec?.recorded && rec.batchId != null) {
      const agg = metrcByBatchId.get(rec.batchId) ?? { count: 0, qty: 0 };
      agg.count += 1;
      agg.qty += p.Quantity ?? 0;
      metrcByBatchId.set(rec.batchId, agg);
    }
  }
  // We can only report reconciliation once METRC answered ok AND (there were no
  // packages to reconcile, or the reconcile call has returned). Otherwise show "—".
  const metrcReady = data?.ok === true && (packages.length === 0 || reconcile !== undefined);
  // FG-4 — live METRC on-hand for a batch (null when we can't compare yet).
  const metrcQtyFor = (b: (typeof releasedBatches)[number]): number | null => {
    if (!metrcReady) return null;
    const a = metrcByBatchId.get(b.id);
    return a && a.count > 0 ? Math.round(a.qty * 100) / 100 : null;
  };
  // FG-4 — "reconciled" now means present in METRC and NOT over-produced (a
  // shortfall is expected: those units were sold/transferred). Only MORE on hand
  // than produced is unexplained.
  const reconciledInMetrc = metrcReady
    ? releasedBatches.filter((b) => {
        const a = metrcByBatchId.get(b.id);
        return !!a && a.count > 0 && (b.outputQuantity == null || a.qty <= b.outputQuantity + 0.001);
      }).length
    : null;

  const renderMetrcRecon = (b: (typeof releasedBatches)[number]) => {
    if (!metrcReady) return <span className="text-xs text-muted-foreground">—</span>;
    const agg = metrcByBatchId.get(b.id);
    if (!agg || agg.count === 0) {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5" />Not in METRC
        </span>
      );
    }
    const pkgLabel = `${agg.count} pkg${agg.count === 1 ? "" : "s"}`;
    const out = b.outputQuantity ?? null;
    const diff = out == null ? 0 : Math.round((agg.qty - out) * 100) / 100;
    if (out == null || Math.abs(diff) < 0.001) {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" />All on hand · {pkgLabel}
        </span>
      );
    }
    if (diff < 0) {
      // FG-4 — METRC on-hand is LESS than produced: the difference left inventory
      // (sold / transferred). Expected, not an error — read it as such.
      const sold = Math.round((out - agg.qty) * 100) / 100;
      return (
        <span className="inline-flex items-center gap-1 text-xs text-sky-700" title={`Produced ${out}, ${agg.qty} on hand in METRC — ${sold} accounted for as sold/shipped`}>
          <Info className="h-3.5 w-3.5" />{sold} {b.unitOfMeasure ?? ""} sold/shipped
        </span>
      );
    }
    // diff > 0 — MORE on hand than the batch produced. Genuinely unexplained.
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-700" title={`METRC on-hand ${agg.qty} exceeds recorded output ${out}`}>
        <AlertTriangle className="h-3.5 w-3.5" />
        Off by +{diff} (more than produced)
      </span>
    );
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <PackageCheck className="h-6 w-6 text-emerald-600" />
              Finished Goods
            </h1>
            <p className="text-muted-foreground">Batches released in CannaQMS, plus on-hand packages read live from METRC for reconciliation against physical counts.</p>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            Refresh from METRC
          </Button>
        </div>

        <FinishedGoodsCharts
          batches={batches ?? []}
          packages={packages}
          packagesReady={data?.ok === true}
          reconciledInMetrc={reconciledInMetrc}
          releasedCount={releasedBatches.length}
        />

        {/* FG-1 — Released batches from CannaQMS (source of truth for "produced & released"). */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Factory className="h-4 w-4 text-emerald-600" />
              Released in CannaQMS
              {!batchesLoading && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  — {releasedBatches.length} batch{releasedBatches.length === 1 ? "" : "es"}
                  {reconciledInMetrc !== null ? ` · ${reconciledInMetrc}/${releasedBatches.length} reconciled with METRC` : ""}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {batchesLoading ? (
              <div className="p-4 space-y-3">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : releasedBatches.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                <PackageCheck className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No released batches yet. Release a batch from its record and it will appear here.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Original Qty</TableHead>
                    <TableHead className="text-right">METRC Active Qty</TableHead>
                    <TableHead>Unit</TableHead>
                    <TableHead>Released</TableHead>
                    <TableHead>Expiration</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Source Tag</TableHead>
                    <TableHead>METRC Check</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {releasedBatches.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="font-mono text-xs">
                        <Link href={`/batches/${b.id}`} className="text-emerald-700 hover:underline">{b.batchNumber}</Link>
                      </TableCell>
                      <TableCell className="font-medium">{b.productName}</TableCell>
                      <TableCell className="text-right tabular-nums">{b.outputQuantity ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {(() => {
                          const q = metrcQtyFor(b);
                          return q != null ? q : <span className="text-muted-foreground">—</span>;
                        })()}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{b.unitOfMeasure ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{fmtDate(b.approvalDate ?? b.productionDate ?? undefined)}</TableCell>
                      <TableCell>
                        {(() => {
                          const exp = expOf(b);
                          if (!exp) return <span className="text-muted-foreground">—</span>;
                          const d = daysUntil(exp);
                          if (d < 0) return <span className="inline-flex items-center gap-1 text-xs text-red-700 font-medium"><AlertTriangle className="h-3.5 w-3.5" />Expired {fmtDate(exp)}</span>;
                          if (d <= 90) return <span className="inline-flex items-center gap-1 text-xs text-amber-700" title={`${d} day${d === 1 ? "" : "s"} left`}><AlertTriangle className="h-3.5 w-3.5" />{fmtDate(exp)} · {d}d</span>;
                          return <span className="text-muted-foreground">{fmtDate(exp)}</span>;
                        })()}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          <TermTip term={b.status === "finished_goods" ? "finishedGoods" : "released"}>
                            {batchStatusLabel(b.status)}
                          </TermTip>
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {b.metrcPackageId
                          ? b.metrcPackageId
                          : <span className="text-muted-foreground font-sans">—</span>}
                      </TableCell>
                      <TableCell>{renderMetrcRecon(b)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Reconciliation note */}
        <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            <strong>Original Qty</strong> is what the batch produced; <strong>METRC Active Qty</strong> is what's currently on hand, read live from METRC.
            A shortfall between them is normal — those units were <strong>sold or transferred</strong>, so METRC Check reads them as "sold/shipped," and flags only the unexplained case (more on hand than was produced).
            CannaQMS does not maintain a separate finished-goods count; compare this list against your physical shelf during inventory checks.
          </span>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <PackageCheck className="h-4 w-4 text-emerald-600" />
              Active Packages in METRC
              {!isLoading && data?.ok && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  — {packages.length} package{packages.length === 1 ? "" : "s"}{totalsLabel ? ` · ${totalsLabel} on hand` : ""}
                  {reconcile ? ` · ${recordedCount}/${packages.length} traced to a batch here` : ""}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-3">
                {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : notConfigured ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                <Info className="h-8 w-8 text-muted-foreground/50" />
                <p className="text-sm font-medium">METRC isn't connected yet</p>
                <p className="text-xs text-muted-foreground max-w-md">
                  Set the facility's METRC keys on the server (vendor + user key) to pull live finished-goods inventory. Until then, this page has nothing to show.
                </p>
              </div>
            ) : errored ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                <AlertTriangle className="h-8 w-8 text-amber-500" />
                <p className="text-sm font-medium">Couldn't read active packages from METRC</p>
                <p className="text-xs text-muted-foreground max-w-md">
                  {data?.error ?? "The request failed."}{data?.kind ? ` (${data.kind})` : ""}
                </p>
              </div>
            ) : packages.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                <PackageCheck className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No active packages in METRC for this license.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>METRC Tag</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead>Unit</TableHead>
                    <TableHead>Packaged</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>In CannaQMS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {packages.map((p) => (
                    <TableRow key={p.Id ?? p.Label}>
                      <TableCell className="font-mono text-xs">{p.Label}</TableCell>
                      <TableCell className="font-medium">{itemName(p)}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.Quantity}</TableCell>
                      <TableCell className="text-muted-foreground">{p.UnitOfMeasureName}</TableCell>
                      <TableCell className="text-muted-foreground">{fmtDate(p.PackagedDate)}</TableCell>
                      <TableCell>
                        <Badge variant={p.IsFinished ? "secondary" : "default"}>
                          {p.IsFinished ? "Finished" : "Active"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const rec = recByTag.get(p.Label);
                          if (!rec) return <span className="text-xs text-muted-foreground">—</span>;
                          return rec.recorded ? (
                            <Link href={`/batches/${rec.batchId}`} className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              {rec.batchNumber ?? "Recorded"}
                            </Link>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-amber-700">
                              <AlertTriangle className="h-3.5 w-3.5" />
                              Not recorded
                            </span>
                          );
                        })()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
