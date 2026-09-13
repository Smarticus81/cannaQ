import { displayLotNumber } from "@/lib/lotDisplay";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useListInventoryItems, useGetCurrentUser, getListInventoryItemsQueryKey, type InventoryItem } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CreateInventoryItemDialog } from "@/components/dialogs/CreateInventoryItemDialog";
import { RenameMergeItemDialog, type ItemGroupRef } from "@/components/dialogs/RenameMergeItemDialog";
import { ReorderPointsDialog } from "@/components/dialogs/ReorderPointsDialog";
import { InventoryCharts } from "@/components/inventory/InventoryCharts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Layers, List, ChevronRight, ChevronDown, RefreshCw, GitBranch, MoreHorizontal, Settings2 } from "lucide-react";
import { Link } from "wouter";

// Full lot ledger (all statuses/origins), read straight from /api/lots for the
// "Lot Traceability" view. This is the superset the standalone Lots page used
// to show — folded in here so Inventory is the single home for on-hand stock
// AND end-to-end lot traceability (each lot links to its detail/lineage).
type TraceLot = {
  id: number;
  lotNumber: string;
  itemName: string;
  itemType: string;
  unitOfMeasure: string;
  originalQuantity: number;
  currentQuantity: number;
  origin: string;
  status: string;
  isCannabis?: boolean;
  expirationDate: string | null;
  createdAt: string;
};

const LOT_STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Active: "default",
  Quarantined: "secondary",
  Consumed: "outline",
  Recalled: "destructive",
  Expired: "secondary",
};

// Session 33 (Tier 2 #7) — grouped rows now carry the underlying lot rows so
// the operator can drill in directly from the rollup without switching to the
// All Lots view. Previously two Distillate lots produced two visible rows
// (or one rollup with an opaque "2" lot count); the new model is one row per
// item with an inline expand that reveals individual lots and quantities.
type GroupedItem = {
  itemName: string;
  itemType: string;
  unitOfMeasure: string;
  totalQuantity: number;
  reorderPoint: number | null;
  hasLowStock: boolean;
  // True when any underlying lot is an in-house intermediate released as an
  // ingredient (origin = 'produced'), so the row can be marked distinct from a
  // received raw material — follow-up #2.
  hasIntermediate: boolean;
  lots: InventoryItem[];
};

// The inventory view returns each lot's origin; the generated InventoryItem
// type predates it (S79 was off-spec), so read it through a narrow cast.
function isIntermediate(it: InventoryItem): boolean {
  return (it as { origin?: string }).origin === "produced";
}

// --- Potency (2026-09-06) ---------------------------------------------------
// THC/CBD belongs to a LOT, not to a SKU: two deliveries of distillate assay
// differently, and picking the wrong one is how a batch misses its target. So
// the number is shown per lot, and a rolled-up SKU row shows the RANGE across
// its lots rather than one number that would be true of neither.
//
// Non-cannabis material has no potency at all — it shows "—", never 0%, because
// zero is a real assay result and would read as "tested, came back empty".
type PotencyRow = {
  isCannabis?: boolean;
  thcPct?: number | null;
  cbdPct?: number | null;
  potencySource?: string | null;
};

// The rows come through as the generated `InventoryItem`, whose type does not
// declare the potency columns even though the API returns them. Reading them via
// a narrowing cast (the pattern already used for origin/expirationDate in this
// file) keeps the helpers callable with a plain row. Taking `unknown` rather than
// PotencyRow is deliberate: an all-optional parameter type triggers TypeScript's
// weak-type check against InventoryItem, which shares none of its property names.
const potencyOf = (row: unknown): PotencyRow => (row ?? {}) as PotencyRow;

const pctText = (n: number) => `${Number(n.toFixed(2))}%`;

/** One lot's potency, e.g. "82.4% THC · 0.5% CBD". Null when there is nothing to show. */
function lotPotencyText(row: unknown): string | null {
  const p = potencyOf(row);
  if (!p.isCannabis) return null;
  const parts: string[] = [];
  if (p.thcPct != null) parts.push(`${pctText(p.thcPct)} THC`);
  if (p.cbdPct != null) parts.push(`${pctText(p.cbdPct)} CBD`);
  return parts.length ? parts.join(" · ") : null;
}

/** Where a lot's numbers came from ('manual' | 'metrc' | 'batch'), for the marker. */
function potencySourceOf(row: unknown): string | null {
  return potencyOf(row).potencySource ?? null;
}

/** Rolled-up potency across a SKU's lots: one value if they agree, else a range. */
function groupPotencyText(lots: readonly unknown[]): string | null {
  const values = lots
    .map(potencyOf)
    .filter((l) => l.isCannabis && l.thcPct != null)
    .map((l) => l.thcPct as number);
  if (values.length === 0) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? `${pctText(lo)} THC` : `${pctText(lo)}–${pctText(hi)} THC`;
}

/** Renders a potency cell's contents, with a marker when Metrc supplied the number. */
function PotencyCell({ text, source }: { text: string | null; source?: string | null }) {
  if (!text) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="whitespace-nowrap tabular-nums">
      {text}
      {source === "metrc" && (
        <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground" title="Pulled from Metrc lab results">
          metrc
        </span>
      )}
    </span>
  );
}

export default function Inventory() {
  const { data: inventory, isLoading } = useListInventoryItems();
  const { data: currentUser } = useGetCurrentUser();
  // Group-by-name is the default view because the auto-Pass flow can produce
  // many per-line rows for the same SKU; the operator usually wants the rolled-up
  // total at a glance. They can still drop into "All lots" for the audit-style
  // per-row picture.
  const [view, setView] = useState<"grouped" | "all" | "traceability">("grouped");
  const [search, setSearch] = useState("");

  // Lot Traceability view (folds in the former standalone Lots page). Loads the
  // full lot ledger lazily the first time the operator opens the view.
  const [traceLots, setTraceLots] = useState<TraceLot[] | null>(null);
  const [traceLoaded, setTraceLoaded] = useState(false);
  const [lotStatusFilter, setLotStatusFilter] = useState<string>("All");
  useEffect(() => {
    if (view !== "traceability" || traceLoaded) return;
    setTraceLoaded(true);
    void (async () => {
      try {
        const res = await fetch("/api/lots", { credentials: "include" });
        setTraceLots(res.ok ? await res.json() : []);
      } catch {
        setTraceLots([]);
      }
    })();
  }, [view, traceLoaded]);

  const isAdmin = currentUser?.role === "Admin";
  const canManageItems = ["Admin", "Quality", "Manager"].includes(currentUser?.role ?? "");
  const [reorderOpen, setReorderOpen] = useState(false);
  const [mergeSource, setMergeSource] = useState<ItemGroupRef | null>(null);

  // Sync from Metrc — pull the facility's active cannabis packages into the lot
  // ledger so they appear here and become pickable as batch ingredients. Metrc is
  // the source of truth; re-running refreshes on-hand quantities. Admin-only.
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [syncing, setSyncing] = useState(false);
  const handleSyncMetrc = async () => {
    setSyncing(true);
    try {
      const r = await fetch("/api/inventory/sync-metrc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: "{}",
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; created?: number; updated?: number; unchanged?: number; total?: number;
      };
      if (!r.ok || j.ok === false) {
        toast({ title: "Metrc sync failed", description: j.error ?? "Could not sync Metrc packages.", variant: "destructive" });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: getListInventoryItemsQueryKey() });
      toast({
        title: "Synced from Metrc",
        description: `${j.created ?? 0} added, ${j.updated ?? 0} updated, ${j.unchanged ?? 0} unchanged (of ${j.total ?? 0} packages).`,
      });
    } catch (e) {
      toast({ title: "Metrc sync failed", description: e instanceof Error ? e.message : "Network error.", variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  const filtered = useMemo(() => {
    if (!inventory) return [];
    if (!search.trim()) return inventory;
    const q = search.trim().toLowerCase();
    return inventory.filter(i =>
      i.itemName.toLowerCase().includes(q) ||
      (i.lotNumber ?? "").toLowerCase().includes(q) ||
      (i.itemType ?? "").toLowerCase().includes(q)
    );
  }, [inventory, search]);

  const grouped = useMemo<GroupedItem[]>(() => {
    const map = new Map<string, GroupedItem>();
    for (const it of filtered) {
      const key = `${it.itemName}::${it.itemType}::${it.unitOfMeasure}`;
      const existing = map.get(key);
      if (existing) {
        existing.totalQuantity += it.quantity ?? 0;
        if (existing.reorderPoint == null && it.reorderPoint != null) existing.reorderPoint = it.reorderPoint;
        if (isIntermediate(it)) existing.hasIntermediate = true;
        existing.lots.push(it);
      } else {
        map.set(key, {
          itemName: it.itemName,
          itemType: it.itemType,
          unitOfMeasure: it.unitOfMeasure,
          totalQuantity: it.quantity ?? 0,
          reorderPoint: it.reorderPoint ?? null,
          hasLowStock: false,
          hasIntermediate: isIntermediate(it),
          lots: [it],
        });
      }
    }
    // Low stock is a rollup decision: compare the SKU's TOTAL on-hand (summed
    // across its lots) against the reorder point, not any single lot — a SKU
    // split across several small lots is not "low" if the total is healthy.
    for (const g of map.values()) {
      g.hasLowStock = g.reorderPoint != null && g.totalQuantity <= g.reorderPoint;
    }
    // Sort each item's lots so the most recently received lot appears first
    // (typical operator priority: pull the freshest receipt last, oldest first).
    for (const g of map.values()) {
      g.lots.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    }
    return Array.from(map.values()).sort((a, b) => a.itemType.localeCompare(b.itemType) || a.itemName.localeCompare(b.itemName));
  }, [filtered]);

  const groupRefs = useMemo<ItemGroupRef[]>(
    () => grouped.map((g) => ({ itemName: g.itemName, itemType: g.itemType, unitOfMeasure: g.unitOfMeasure, totalQuantity: g.totalQuantity })),
    [grouped],
  );

  // Session 33 (Tier 2 #7) — track expanded rows by item key so the operator
  // can hold multiple items open at once when reconciling against METRC.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  function toggleExpanded(key: string) {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <>
      <div className="space-y-6">
        <div className="cq-page-heading flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Inventory</h1>
            <p className="text-muted-foreground">
              Raw materials and ingredients on hand. Live quantities read from the shared lot ledger — added automatically when an Incoming Inspection passes.
            </p>
          </div>
          {/* Manual creation is reserved for Admins — front-line operators
              should be using the Incoming Inspection flow instead, which
              auto-creates inventory rows and preserves chain-of-custody.
              "Sync from Metrc" pulls the facility's active cannabis packages in
              as lots so they show here and become pickable batch ingredients. */}
          {canManageItems && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setReorderOpen(true)} data-testid="button-reorder-points">
                <Settings2 className="h-4 w-4 mr-1" /> Reorder Points
              </Button>
              {isAdmin && (
                <>
                  <Button variant="outline" size="sm" onClick={handleSyncMetrc} disabled={syncing} data-testid="button-sync-metrc">
                    <RefreshCw className={`h-4 w-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
                    {syncing ? "Syncing…" : "Sync from Metrc"}
                  </Button>
                  <CreateInventoryItemDialog />
                </>
              )}
            </div>
          )}
        </div>

        <InventoryCharts grouped={grouped} />

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex max-w-full flex-wrap rounded-md border bg-card p-0.5">
            <Button
              size="sm"
              variant={view === "grouped" ? "default" : "ghost"}
              className="h-8"
              onClick={() => setView("grouped")}
              data-testid="button-view-grouped"
            >
              <Layers className="h-4 w-4 mr-1" />By Item
            </Button>
            <Button
              size="sm"
              variant={view === "all" ? "default" : "ghost"}
              className="h-8"
              onClick={() => setView("all")}
              data-testid="button-view-all"
            >
              <List className="h-4 w-4 mr-1" />All Lots
            </Button>
            <Button
              size="sm"
              variant={view === "traceability" ? "default" : "ghost"}
              className="h-8"
              onClick={() => setView("traceability")}
              data-testid="button-view-traceability"
            >
              <GitBranch className="h-4 w-4 mr-1" />Lot Traceability
            </Button>
          </div>
          {view === "traceability" ? (
            // Traceability shows the full ledger (all statuses); a status filter
            // replaces the free-text search, matching the former Lots page.
            <Select value={lotStatusFilter} onValueChange={setLotStatusFilter}>
              <SelectTrigger className="w-44 h-8" data-testid="select-lot-status-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["All", "Active", "Quarantined", "Consumed", "Recalled", "Expired"].map((s) => (
                  <SelectItem key={s} value={s}>{s === "All" ? "All statuses" : s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              placeholder="Search by item name, lot, or type…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-sm h-8"
            />
          )}
        </div>

        <div className="border rounded-md">
          {view === "grouped" ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Item Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Total Quantity</TableHead>
                  <TableHead>UoM</TableHead>
                  <TableHead className="text-right">Lots</TableHead>
                  <TableHead>Potency</TableHead>
                  <TableHead>Stock Status</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={9}><Skeleton className="h-4 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : grouped.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center h-24 text-muted-foreground">
                      No inventory items yet. Pass an incoming inspection to populate{isAdmin ? ", or click “Sync from Metrc” to pull in your active cannabis packages" : ""}.
                    </TableCell>
                  </TableRow>
                ) : (
                  grouped.map((g, gi) => {
                    const key = `${g.itemName}-${g.itemType}-${g.unitOfMeasure}`;
                    const expanded = expandedKeys.has(key);
                    const multipleLots = g.lots.length > 1;
                    const showTypeHeader = gi === 0 || grouped[gi - 1].itemType !== g.itemType;
                    return (
                      <Fragment key={key}>
                        {showTypeHeader && (
                          <TableRow className="bg-muted/50 hover:bg-muted/50">
                            <TableCell colSpan={9} className="py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.itemType}</TableCell>
                          </TableRow>
                        )}
                        <TableRow
                          className={multipleLots ? "cursor-pointer hover:bg-muted/30" : ""}
                          onClick={multipleLots ? () => toggleExpanded(key) : undefined}
                          data-testid={`row-grouped-${g.itemName}`}
                        >
                          <TableCell className="w-8 text-muted-foreground">
                            {multipleLots ? (
                              expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />
                            ) : null}
                          </TableCell>
                          <TableCell className="font-medium">
                            {g.itemName}
                            {g.hasIntermediate && (
                              <Badge variant="outline" className="ml-2 text-[10px]" title="In-house intermediate released as an ingredient">Intermediate</Badge>
                            )}
                          </TableCell>
                          <TableCell>{g.itemType}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">{g.totalQuantity}</TableCell>
                          <TableCell>{g.unitOfMeasure}</TableCell>
                          <TableCell className="text-right">
                            {multipleLots ? (
                              // Multi-lot: keep the count; the individual lot
                              // numbers reveal on expand (row below).
                              <span className="text-sm font-medium text-primary">{g.lots.length} lots</span>
                            ) : g.lots[0] ? (
                              // Single-lot: show the source lot number inline (linked
                              // to full traceability) rather than an opaque "1 lot",
                              // so the Inventory screen surfaces the source lot number
                              // without a click. Full value on hover; mono for scanning.
                              <Link
                                href={`/lots/${g.lots[0].id}`}
                                className="font-mono text-xs text-primary hover:underline"
                                onClick={(e) => e.stopPropagation()}
                                title={g.lots[0].lotNumber ?? undefined}
                              >
                                {displayLotNumber(g.lots[0].lotNumber)}
                              </Link>
                            ) : (
                              <span className="text-sm text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            <PotencyCell text={groupPotencyText(g.lots)} />
                          </TableCell>
                          <TableCell>
                            {g.hasLowStock ? (
                              <Badge variant="destructive">Low Stock</Badge>
                            ) : (
                              <Badge variant="secondary">OK</Badge>
                            )}
                          </TableCell>
                          <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
                            {canManageItems ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Item actions">
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => setMergeSource({ itemName: g.itemName, itemType: g.itemType, unitOfMeasure: g.unitOfMeasure, totalQuantity: g.totalQuantity })}>
                                    Rename / Merge…
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : null}
                          </TableCell>
                        </TableRow>
                        {expanded && multipleLots && g.lots.map((lot) => {
                          const lotIsLow = lot.reorderPoint != null && (lot.quantity ?? 0) <= lot.reorderPoint;
                          return (
                            <TableRow key={`${key}-lot-${lot.id}`} className="bg-muted/30 text-sm">
                              <TableCell></TableCell>
                              <TableCell colSpan={2} className="font-mono text-xs">
                                <Link href={`/lots/${lot.id}`} className="text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
                                  Lot {displayLotNumber(lot.lotNumber)}
                                </Link>
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{lot.quantity ?? 0}</TableCell>
                              <TableCell>{lot.unitOfMeasure}</TableCell>
                              <TableCell className="text-right text-xs text-muted-foreground">
                                {lot.sourceInspectionItemId ? `from INS item #${lot.sourceInspectionItemId}` : "manual"}
                              </TableCell>
                              <TableCell className="text-xs">
                                <PotencyCell text={lotPotencyText(lot)} source={potencySourceOf(lot)} />
                              </TableCell>
                              <TableCell>
                                {lotIsLow ? <Badge variant="destructive" className="text-[10px]">Low</Badge> : null}
                              </TableCell>
                              <TableCell></TableCell>
                            </TableRow>
                          );
                        })}
                      </Fragment>
                    );
                  })
                )}
              </TableBody>
            </Table>
          ) : view === "all" ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Lot Number</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead>UoM</TableHead>
                  <TableHead>Potency</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Stock Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={9}><Skeleton className="h-4 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center h-24 text-muted-foreground">
                      No inventory rows match.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((item) => {
                    const isLow = item.reorderPoint != null && (item.quantity ?? 0) <= item.reorderPoint;
                    const rcv = (item as { createdAt?: string | null }).createdAt;
                    const exp = (item as { expirationDate?: string | null }).expirationDate;
                    return (
                      <TableRow key={item.id}>
                        <TableCell className="font-medium">
                          {item.itemName}
                          {isIntermediate(item) && (
                            <Badge variant="outline" className="ml-2 text-[10px]" title="In-house intermediate released as an ingredient">Intermediate</Badge>
                          )}
                        </TableCell>
                        <TableCell>{item.itemType}</TableCell>
                        <TableCell className="font-mono text-xs">
                          <Link href={`/lots/${item.id}`} className="text-primary hover:underline">
                            {displayLotNumber(item.lotNumber)}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{item.quantity?.toString()}</TableCell>
                        <TableCell>{item.unitOfMeasure}</TableCell>
                        <TableCell className="text-xs">
                          <PotencyCell text={lotPotencyText(item)} source={potencySourceOf(item)} />
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">{rcv ? new Date(rcv).toLocaleDateString() : "—"}</TableCell>
                        <TableCell className="text-muted-foreground text-xs">{exp ? new Date(exp + "T00:00:00").toLocaleDateString() : "—"}</TableCell>
                        <TableCell>
                          {isLow ? <Badge variant="destructive">Low Stock</Badge> : <Badge variant="secondary">OK</Badge>}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          ) : (
            /* Lot Traceability — the full lot ledger (all statuses/origins),
               folded in from the former standalone Lots page. Every lot links
               to its detail page for lineage, recall, split/merge, and history,
               so end-to-end traceability is preserved in the combined section. */
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lot #</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Origin</TableHead>
                  <TableHead className="text-right">Qty Remaining</TableHead>
                  <TableHead>UoM</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {traceLots === null ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={9}><Skeleton className="h-4 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : (() => {
                  const rows = traceLots.filter((l) => l.status !== "Archived" && (lotStatusFilter === "All" || l.status === lotStatusFilter));
                  if (rows.length === 0) {
                    return (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center h-24 text-muted-foreground">
                          {lotStatusFilter === "All" ? "No lots recorded yet." : `No lots with status “${lotStatusFilter}”.`}
                        </TableCell>
                      </TableRow>
                    );
                  }
                  return rows.map((l) => (
                    <TableRow key={l.id} data-testid={`row-lot-${l.id}`}>
                      <TableCell className="font-mono text-xs">
                        <Link href={`/lots/${l.id}`} className="text-primary hover:underline">{displayLotNumber(l.lotNumber)}</Link>
                      </TableCell>
                      <TableCell className="font-medium">{l.itemName}</TableCell>
                      <TableCell>{l.itemType}</TableCell>
                      <TableCell><Badge variant="outline">{l.origin}</Badge></TableCell>
                      <TableCell className="text-right tabular-nums">
                        {l.currentQuantity.toLocaleString()} / {l.originalQuantity.toLocaleString()}
                      </TableCell>
                      <TableCell>{l.unitOfMeasure}</TableCell>
                      <TableCell><Badge variant={LOT_STATUS_VARIANT[l.status] ?? "outline"}>{l.status}</Badge></TableCell>
                      <TableCell className="text-muted-foreground text-xs">{l.createdAt ? new Date(l.createdAt).toLocaleDateString() : "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{l.expirationDate ?? "—"}</TableCell>
                    </TableRow>
                  ));
                })()}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
      <RenameMergeItemDialog
        open={mergeSource != null}
        onOpenChange={(v) => { if (!v) setMergeSource(null); }}
        source={mergeSource}
        groups={groupRefs}
        onDone={() => { void queryClient.invalidateQueries({ queryKey: getListInventoryItemsQueryKey() }); }}
      />
      <ReorderPointsDialog open={reorderOpen} onOpenChange={setReorderOpen} />
    </>
  );
}
