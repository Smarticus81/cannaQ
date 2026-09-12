import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { Trash2, Factory } from "lucide-react";
import { batchStateLabel } from "@/lib/status";
import { useToast } from "@/hooks/use-toast";

// #4 (2026-08-05) — a field action records the affected finished-goods BATCH(es).
// Record-only: attaching a batch does NOT quarantine anything (quarantine of
// in-house product is handled separately, e.g. via a CAPA). The attached batches
// power the "Suggest stores from manifests" action in Response Actions.

type Batch = {
  id: number;
  batchNumber: string;
  productName: string;
  status: string;
  outputQuantity: number | null;
  unitOfMeasure: string | null;
  metrcPackageId: string | null;
};

type FABatch = {
  id: number;
  fieldActionId: number;
  batchId: number;
  notes: string | null;
  batch: Batch;
};

// Released / finished-goods batches are the usual recall targets — surface them
// first in the picker. Others (in_production, on_hold, failed) stay selectable.
const FINISHED_FIRST = new Set(["released_to_inventory", "finished_goods"]);
// 2026-09-08 — this panel used to carry its OWN copy of the status labels,
// which drifted (it still said "Released" and "Finished Goods" after both were
// renamed). It now reads the one shared map in lib/status.ts.
const statusLabel = (s: string) => batchStateLabel(s, true);

export function AffectedBatchesPanel({
  fieldActionId,
  currentUserName,
  faClosed,
}: {
  fieldActionId: number;
  currentUserName?: string | null;
  faClosed?: boolean;
}) {
  const { toast } = useToast();
  const [links, setLinks] = useState<FABatch[]>([]);
  const [allBatches, setAllBatches] = useState<Batch[]>([]);
  const [open, setOpen] = useState(false);
  const [selectedBatchId, setSelectedBatchId] = useState<string>("");
  const [saving, setSaving] = useState(false);

  async function reload() {
    const [linksRes, batchesRes] = await Promise.all([
      fetch(`/api/field-actions/${fieldActionId}/batches`, { credentials: "include" }),
      fetch(`/api/batch-records`, { credentials: "include" }),
    ]);
    if (linksRes.ok) setLinks(await linksRes.json());
    if (batchesRes.ok) setAllBatches(await batchesRes.json());
  }
  useEffect(() => { void reload(); }, [fieldActionId]);

  const linkedIds = new Set(links.map((l) => l.batchId));
  const availableBatches = allBatches
    .filter((b) => !linkedIds.has(b.id))
    .sort((a, b) => {
      const af = FINISHED_FIRST.has(a.status) ? 0 : 1;
      const bf = FINISHED_FIRST.has(b.status) ? 0 : 1;
      return af - bf || b.id - a.id;
    });

  async function handleAttach() {
    const batchId = Number(selectedBatchId);
    if (!batchId) { toast({ title: "Pick a batch first", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/field-actions/${fieldActionId}/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ batchId, createdByName: currentUserName ?? null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast({ title: "Failed", description: err.error ?? "Could not attach batch", variant: "destructive" });
        return;
      }
      toast({ title: "Batch attached" });
      setOpen(false); setSelectedBatchId("");
      void reload();
    } finally {
      setSaving(false);
    }
  }

  async function handleDetach(batchId: number, batchNumber: string) {
    if (!confirm(`Remove batch ${batchNumber} from this field action?`)) return;
    const res = await fetch(`/api/field-actions/${fieldActionId}/batches/${batchId}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ performedByName: currentUserName ?? null }),
    });
    if (!res.ok) { toast({ title: "Detach failed", variant: "destructive" }); return; }
    toast({ title: "Batch removed" });
    void reload();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Factory className="h-4 w-4 text-emerald-600" />
            Affected Batches / Finished Goods ({links.length})
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Record the finished-goods batch(es) this recall covers. This does not quarantine anything —
            it identifies the product and lets CannaQMS suggest which stores it shipped to.
          </p>
        </div>
        {!faClosed && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">Attach Batch</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md overflow-hidden">
              <DialogHeader><DialogTitle>Attach Batch to Field Action</DialogTitle></DialogHeader>
              <div className="space-y-4 py-2 min-w-0">
                <div className="min-w-0">
                  <Label>Batch / Finished Good</Label>
                  <Select value={selectedBatchId} onValueChange={setSelectedBatchId}>
                    <SelectTrigger className="w-full min-w-0 [&>span]:truncate [&>span]:block">
                      <SelectValue placeholder="Select a batch…" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableBatches.length === 0 ? (
                        <div className="px-2 py-1 text-sm text-muted-foreground">No more batches to attach.</div>
                      ) : availableBatches.map((b) => (
                        <SelectItem key={b.id} value={String(b.id)}>
                          {b.batchNumber} — {b.productName} ({statusLabel(b.status)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Released / finished-goods batches are listed first — those are the usual recall targets.
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={handleAttach} disabled={saving || !selectedBatchId}>
                  {saving ? "Attaching…" : "Attach"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </CardHeader>
      <CardContent className="pt-2">
        {links.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center">
            No batches attached. Use "Attach Batch" to record the affected finished-goods batch(es).
          </div>
        ) : (
          <div className="space-y-2">
            {links.map((link) => (
              <div key={link.id} className="flex items-center justify-between border rounded-md p-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link href={`/batches/${link.batch.id}`} className="font-mono font-medium text-primary hover:underline">
                      {link.batch.batchNumber}
                    </Link>
                    <Badge variant="secondary">{statusLabel(link.batch.status)}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {link.batch.productName}
                    {link.batch.outputQuantity != null && (
                      <> · {link.batch.outputQuantity} {link.batch.unitOfMeasure ?? ""}</>
                    )}
                  </div>
                </div>
                {!faClosed && (
                  <Button size="icon" variant="ghost" onClick={() => handleDetach(link.batch.id, link.batch.batchNumber)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
