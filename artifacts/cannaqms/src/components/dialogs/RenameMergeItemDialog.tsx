import { useMemo, useState } from "react";
import { ITEM_TYPES } from "@/lib/units";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

export interface ItemGroupRef {
  itemName: string;
  itemType: string;
  unitOfMeasure: string;
  totalQuantity: number;
}

const keyOf = (g: ItemGroupRef) => `${g.itemName}::${g.itemType}::${g.unitOfMeasure}`;

// Rename fixes a typo on one item group (its lots + catalog row); Merge folds the
// source group into another item measured in the SAME unit, combining on-hand so
// a split count ("Mouthpiece" 200 vs "Muthpieces" 10,000) stops false-firing the
// reorder alert. Both hit /api/inventory/{rename,merge} (Manager/Quality/Admin).
export function RenameMergeItemDialog({
  open,
  onOpenChange,
  source,
  groups,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  source: ItemGroupRef | null;
  groups: ItemGroupRef[];
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"rename" | "type" | "merge">("rename");
  const [newName, setNewName] = useState("");
  // Session 63 — the type was write-once until now, which left items stranded on
  // "Received Material" (the receiving fallback, not a type anyone chose) with no
  // way to correct them.
  const [newType, setNewType] = useState("");
  const [targetKey, setTargetKey] = useState("");
  const [busy, setBusy] = useState(false);

  const srcKey = source ? keyOf(source) : "";
  const targets = useMemo(
    () => (source ? groups.filter((g) => g.unitOfMeasure === source.unitOfMeasure && keyOf(g) !== srcKey) : []),
    [groups, source, srcKey],
  );
  const target = targets.find((t) => keyOf(t) === targetKey) ?? null;

  if (!source) return null;

  const reset = () => {
    setNewName("");
    setTargetKey("");
    setMode("rename");
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "rename") {
        const nn = newName.trim();
        if (!nn) { toast({ title: "Enter a new name", variant: "destructive" }); setBusy(false); return; }
        const r = await fetch("/api/inventory/rename", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemName: source.itemName, itemType: source.itemType, unitOfMeasure: source.unitOfMeasure, newName: nn }),
        });
        const j = (await r.json().catch(() => ({}))) as { error?: string; lotsUpdated?: number };
        if (!r.ok) throw new Error(j.error ?? `Rename failed (HTTP ${r.status})`);
        toast({ title: "Item renamed", description: `“${source.itemName}” → “${nn}” (${j.lotsUpdated ?? 0} lot(s) updated).` });
      } else if (mode === "type") {
        if (!newType) { toast({ title: "Pick a new type", variant: "destructive" }); setBusy(false); return; }
        const r = await fetch("/api/inventory/change-type", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemName: source.itemName, itemType: source.itemType, unitOfMeasure: source.unitOfMeasure, newType }),
        });
        const j = (await r.json().catch(() => ({}))) as { error?: string; lotsUpdated?: number };
        if (!r.ok) throw new Error(j.error ?? `Type change failed (HTTP ${r.status})`);
        toast({ title: "Item type changed", description: `“${source.itemName}”: ${source.itemType} → ${newType} (${j.lotsUpdated ?? 0} lot(s) updated).` });
      } else {
        if (!target) { toast({ title: "Pick an item to merge into", variant: "destructive" }); setBusy(false); return; }
        const r = await fetch("/api/inventory/merge", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromName: source.itemName, fromType: source.itemType, fromUnit: source.unitOfMeasure,
            intoName: target.itemName, intoType: target.itemType, intoUnit: target.unitOfMeasure,
          }),
        });
        const j = (await r.json().catch(() => ({}))) as { error?: string; movedLots?: number };
        if (!r.ok) throw new Error(j.error ?? `Merge failed (HTTP ${r.status})`);
        toast({ title: "Items merged", description: `“${source.itemName}” folded into “${target.itemName}” (${j.movedLots ?? 0} lot(s) moved).` });
      }
      onOpenChange(false);
      reset();
      onDone();
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename or merge item</DialogTitle>
          <DialogDescription>
            {source.itemName} · {source.itemType} · {source.totalQuantity} {source.unitOfMeasure} on hand
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Button type="button" size="sm" variant={mode === "rename" ? "default" : "outline"} onClick={() => setMode("rename")}>Rename</Button>
          <Button type="button" size="sm" variant={mode === "type" ? "default" : "outline"} onClick={() => setMode("type")}>Change type…</Button>
          <Button type="button" size="sm" variant={mode === "merge" ? "default" : "outline"} onClick={() => setMode("merge")}>Merge into…</Button>
        </div>

        {mode === "rename" ? (
          <div className="space-y-2">
            <Label>New name</Label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={source.itemName} />
            <p className="text-xs text-muted-foreground">Renames this item and all its lots. Fixes a typo without combining with another item.</p>
          </div>
        ) : mode === "type" ? (
          <div className="space-y-2">
            <Label>New type</Label>
            <Select value={newType} onValueChange={setNewType}>
              <SelectTrigger>
                <SelectValue placeholder={`Currently ${source.itemType}`} />
              </SelectTrigger>
              {/* Session 63.2 — the list is NOT filtered to exclude the type this
                  item already shows. This row's type comes from the LOT, and the
                  catalog row behind it can still hold "Received Material"; picking
                  the type already displayed is the only way to sweep that row, and
                  it is exactly what the Reorder Points panel already allows. The
                  server treats a same-type request as a reconcile and answers 409
                  only when nothing at all would change. */}
              <SelectContent>
                {ITEM_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{t === source.itemType ? `${t} (current)` : t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Retypes this item and all its lots. Use this on items stuck as <strong>Received Material</strong>,
              which is what receiving records when no type was chosen. Re-picking the type already shown is
              allowed on purpose: this list reads the lot, and the catalog row behind it can still say
              Received Material — re-applying reconciles the two. If the same name already exists under
              the new type, that is a merge rather than a retype and will be refused.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Label>Merge into</Label>
            <Select value={targetKey} onValueChange={setTargetKey}>
              <SelectTrigger>
                <SelectValue placeholder={targets.length ? "Choose the surviving item" : `No other items measured in ${source.unitOfMeasure}`} />
              </SelectTrigger>
              <SelectContent>
                {targets.map((t) => (
                  <SelectItem key={keyOf(t)} value={keyOf(t)}>{t.itemName} · {t.itemType} · {t.totalQuantity} {t.unitOfMeasure}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {target ? (
              <p className="text-xs text-muted-foreground">
                “{source.itemName}” ({source.totalQuantity}) folds into “{target.itemName}” ({target.totalQuantity}) → combined <strong>{source.totalQuantity + target.totalQuantity} {target.unitOfMeasure}</strong>. This can’t be undone.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Only items measured in <strong>{source.unitOfMeasure}</strong> can be merged in, so quantities stay valid.</p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Working…" : mode === "rename" ? "Rename" : mode === "type" ? "Change type" : "Merge"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
