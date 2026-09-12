import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { getListInventoryItemsQueryKey } from "@workspace/api-client-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ITEM_TYPES } from "@/lib/units";

// Manage reorder points for every CATALOG item, including starter items that
// have no lot yet (those never show on the lot-based Inventory screen). Reorder
// point + quantity live on inventory_items; a low-stock alert fires once an
// item's total on-hand (summed across its Active lots) drops to/below the point.
type CatalogItem = {
  id: number;
  itemName: string;
  itemType: string;
  unitOfMeasure: string;
  reorderPoint: number | null;
  reorderQuantity: number | null;
  onHand: number;
};

type Draft = { reorderPoint: string; reorderQuantity: string };

export function ReorderPointsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  // Session 63.1 — the type is editable here, not only from the Inventory row's
  // ⋯ menu. That menu is driven by the lot-based list, so an item with no lots —
  // a starter item never received, or one whose stock is gone — has no row to
  // click and its type was uncorrectable. This panel already lists EVERY catalog
  // item, which is exactly the set that needs reaching.
  const [typingId, setTypingId] = useState<number | null>(null);

  async function changeType(it: CatalogItem, newType: string) {
    setTypingId(it.id);
    try {
      const r = await fetch("/api/inventory/change-type", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemName: it.itemName,
          itemType: it.itemType,
          unitOfMeasure: it.unitOfMeasure,
          newType,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; lotsUpdated?: number };
      if (!r.ok) {
        toast({ title: "Could not change type", description: j.error, variant: "destructive" });
        return;
      }
      toast({ title: "Item type changed", description: `“${it.itemName}”: ${it.itemType} → ${newType}.` });
      await load();
      await qc.invalidateQueries({ queryKey: getListInventoryItemsQueryKey() });
    } catch {
      toast({ title: "Could not change type", variant: "destructive" });
    } finally {
      setTypingId(null);
    }
  }

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/inventory/catalog", { credentials: "include" });
      const data = await res.json();
      if (Array.isArray(data)) {
        setItems(data as CatalogItem[]);
        const d: Record<number, Draft> = {};
        for (const it of data as CatalogItem[]) {
          d[it.id] = {
            reorderPoint: it.reorderPoint == null ? "" : String(it.reorderPoint),
            reorderQuantity: it.reorderQuantity == null ? "" : String(it.reorderQuantity),
          };
        }
        setDrafts(d);
      }
    } catch {
      toast({ title: "Failed to load catalog", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (open) void load(); }, [open]);

  async function save(it: CatalogItem) {
    const d = drafts[it.id] ?? { reorderPoint: "", reorderQuantity: "" };
    const rp = d.reorderPoint.trim() === "" ? null : Number(d.reorderPoint);
    const rq = d.reorderQuantity.trim() === "" ? null : Number(d.reorderQuantity);
    if ((rp != null && !Number.isFinite(rp)) || (rq != null && !Number.isFinite(rq))) {
      toast({ title: "Enter valid numbers", variant: "destructive" });
      return;
    }
    setSavingId(it.id);
    try {
      const res = await fetch(`/api/inventory/${it.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reorderPoint: rp, reorderQuantity: rq }),
      });
      if (!res.ok) throw new Error("save failed");
      toast({ title: `Saved — ${it.itemName}` });
      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, reorderPoint: rp, reorderQuantity: rq } : x)));
      void qc.invalidateQueries({ queryKey: getListInventoryItemsQueryKey() });
    } catch {
      toast({ title: "Save failed", variant: "destructive" });
    } finally {
      setSavingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Reorder Points</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Set a reorder point (and optional reorder quantity) for any catalog item — including starter items you have not received yet. A low-stock alert fires when an item&apos;s total on-hand drops to or below its reorder point.
        </p>
        {loading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="max-h-[60vh] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  <TableHead className="w-28">Reorder point</TableHead>
                  <TableHead className="w-28">Reorder qty</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No catalog items yet.</TableCell></TableRow>
                ) : (
                  items.map((it) => {
                    const d = drafts[it.id] ?? { reorderPoint: "", reorderQuantity: "" };
                    const dirty =
                      String(it.reorderPoint ?? "") !== d.reorderPoint.trim() ||
                      String(it.reorderQuantity ?? "") !== d.reorderQuantity.trim();
                    return (
                      <TableRow key={it.id}>
                        <TableCell className="font-medium">{it.itemName}</TableCell>
                        <TableCell>
                          <Select
                            value={ITEM_TYPES.includes(it.itemType as (typeof ITEM_TYPES)[number]) ? it.itemType : ""}
                            onValueChange={(v) => void changeType(it, v)}
                            disabled={typingId === it.id}
                          >
                            <SelectTrigger className="h-8 text-xs w-44">
                              {/* A legacy value ("Received Material", "Cultivation Input") is
                                  not in ITEM_TYPES, so it cannot be the Select's value without
                                  rendering blank — show it as the placeholder instead. */}
                              <SelectValue placeholder={it.itemType} />
                            </SelectTrigger>
                            <SelectContent>
                              {ITEM_TYPES.map((t) => (
                                <SelectItem key={t} value={t}>{t}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="text-right">{it.onHand} {it.unitOfMeasure}</TableCell>
                        <TableCell>
                          <Input type="number" step="0.01" value={d.reorderPoint} onChange={(e) => setDrafts((p) => ({ ...p, [it.id]: { ...d, reorderPoint: e.target.value } }))} placeholder="—" />
                        </TableCell>
                        <TableCell>
                          <Input type="number" step="0.01" value={d.reorderQuantity} onChange={(e) => setDrafts((p) => ({ ...p, [it.id]: { ...d, reorderQuantity: e.target.value } }))} placeholder="—" />
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="outline" disabled={!dirty || savingId === it.id} onClick={() => void save(it)}>
                            {savingId === it.id ? "…" : "Save"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
