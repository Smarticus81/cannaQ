import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useListBatchRecords } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { CreateBatchDialog } from "@/components/dialogs/CreateBatchDialog";
import { ImportBatchDialog } from "@/components/dialogs/ImportBatchDialog";
import { BatchesCharts } from "@/components/batches/BatchesCharts";
import { Upload, Search, FlaskConical, PackageCheck, AlertTriangle, Clock, CheckCircle2, XCircle } from "lucide-react";
import { format } from "date-fns";
import { TermTip } from "@/components/ui/TermTip";
import { StatusBadge } from "@/components/ui/status-badge";
import { accentClass, toneBatchStatus, BATCH_STATE_LABELS_SHORT } from "@/lib/status";

// 2026-09-07 — one shared vocabulary with the batch detail page, which used to
// call the same status "Final Form" while this list called it "Released".
const STATUS_LABEL = BATCH_STATE_LABELS_SHORT;

// Lifecycle order. Untested (in_inventory_untested) and Finished Goods
// (finished_goods) were previously unreachable from the chips — a batch in
// either state only showed under "All". Added so every status is filterable
// and the chip counts reconcile with the stat tiles. (2026-08-10)
const FILTER_TABS = [
  { label: "All",               value: "all" },
  { label: "In Production",     value: "in_production" },
  { label: "Bulk — Untested",   value: "in_inventory_untested" },
  { label: "Testing",           value: "testing_in_progress" },
  { label: "Passed",            value: "passed_awaiting_packaging" },
  { label: "Bulk — Released",   value: "released_to_inventory" },
  { label: "In Fulfillment",    value: "finished_goods" },
  { label: "On Hold",           value: "on_hold" },
  { label: "Failed / Destroyed",value: "failed_destroyed" },
];

export default function Batches() {
  const { data: batches, isLoading } = useListBatchRecords();
  const [importOpen, setImportOpen]   = useState(false);
  const [activeFilter, setActiveFilter] = useState("all");
  const [search, setSearch]           = useState("");

  const filtered = (batches ?? []).filter((b) => {
    const matchesFilter =
      activeFilter === "all" ||
      (activeFilter === "failed_destroyed"
        ? b.status === "failed" || b.status === "destroyed"
        : b.status === activeFilter);
    const q = search.toLowerCase();
    const matchesSearch =
      q === "" ||
      b.batchNumber.toLowerCase().includes(q) ||
      b.productName.toLowerCase().includes(q) ||
      (b.strainName ?? "").toLowerCase().includes(q);
    return matchesFilter && matchesSearch;
  });

  const counts = (batches ?? []).reduce<Record<string, number>>((acc, b) => {
    acc[b.status] = (acc[b.status] ?? 0) + 1;
    return acc;
  }, {});
  const failedDestroyedCount = (counts["failed"] ?? 0) + (counts["destroyed"] ?? 0);

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              <TermTip term="batch">Batch</TermTip> Records
            </h1>
            <p className="text-muted-foreground">Production batch records and lifecycle tracking.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" />
              Import Paper Record
            </Button>
            <CreateBatchDialog />
          </div>
        </div>

        <BatchesCharts batches={batches ?? []} />

        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search batch number or product..."
              className="pl-8 h-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {FILTER_TABS.map((tab) => {
              const count =
                tab.value === "all"
                  ? (batches ?? []).length
                  : tab.value === "failed_destroyed"
                  ? failedDestroyedCount
                  : (counts[tab.value] ?? 0);
              return (
                <button
                  key={tab.value}
                  onClick={() => setActiveFilter(tab.value)}
                  className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                    activeFilter === tab.value
                      ? "bg-foreground text-background border-foreground"
                      : "bg-background text-muted-foreground border-border hover:border-foreground/40"
                  }`}
                >
                  {tab.label}
                  {count > 0 && <span className="ml-1.5 opacity-60">{count}</span>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Batch Number</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Output</TableHead>
                <TableHead>Production Date</TableHead>
                <TableHead>METRC</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center h-24 text-muted-foreground">
                    {search
                      ? "No batches match your search."
                      : "No batch records found. Create your first batch or import a paper record."}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((batch) => {
                  // Session 99 (#6) — row accent flags only active-attention states
                  // (failed/destroyed → urgent; on-hold/untested → caution); healthy
                  // and released batches stay calm.
                  const t = toneBatchStatus(batch.status);
                  const rowTone = t === "urgent" || t === "caution" ? t : "neutral";
                  return (
                  <TableRow key={batch.id} className={`cursor-pointer hover:bg-muted/40 ${accentClass(rowTone)}`}>
                    <TableCell className="font-medium">
                      <Link href={`/batches/${batch.id}`} className="hover:underline text-primary font-mono">
                        {batch.batchNumber}
                      </Link>
                      {/^(IMPORT|PENDING)-\d+$/i.test(batch.batchNumber ?? "") && (
                        <span className="ml-2 align-middle rounded bg-amber-100 dark:bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                          provisional — awaiting METRC tag
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="font-medium text-sm">{batch.productName}</p>
                        {batch.strainName && <p className="text-xs text-muted-foreground">{batch.strainName}</p>}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{batch.batchType}</TableCell>
                    <TableCell>
                      <StatusBadge tone={toneBatchStatus(batch.status)} label={STATUS_LABEL[batch.status] ?? batch.status} />
                    </TableCell>
                    <TableCell className="text-sm">
                      {batch.outputQuantity != null ? (
                        <span className="font-semibold">
                          {batch.outputQuantity.toLocaleString()}{" "}
                          <span className="text-muted-foreground font-normal">{batch.unitOfMeasure}</span>
                        </span>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {batch.productionDate ? format(new Date(batch.productionDate + "T00:00:00"), "MMM d, yyyy") : "—"}
                    </TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">
                      {batch.metrcPackageId ? (
                        <span className="text-emerald-700 dark:text-emerald-400">
                          {batch.metrcPackageId.length > 14
                            ? `${batch.metrcPackageId.slice(0, 12)}…`
                            : batch.metrcPackageId}
                        </span>
                      ) : "—"}
                    </TableCell>
                  </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        {!isLoading && (
          <p className="text-xs text-muted-foreground text-right">
            Showing {filtered.length} of {(batches ?? []).length} batch record{batches?.length !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      <ImportBatchDialog open={importOpen} onOpenChange={setImportOpen} />
    </AppLayout>
  );
}
