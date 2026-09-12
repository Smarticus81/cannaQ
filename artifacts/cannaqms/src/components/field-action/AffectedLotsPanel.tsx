import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { Trash2, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";

type Lot = {
  id: number; lotNumber: string; itemName: string; status: string;
  currentQuantity: number; unitOfMeasure: string;
};

type FALot = {
  id: number; fieldActionId: number; lotId: number;
  quarantinedAt: string | null; notes: string | null;
  lot: Lot;
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Active: "default", Quarantined: "secondary", Recalled: "destructive",
  Consumed: "outline", Expired: "secondary",
};

export function AffectedLotsPanel({
  fieldActionId,
  faNumber,
  faTitle,
  currentUserName,
  currentUserId,
  faClosed,
}: {
  fieldActionId: number;
  faNumber: string;
  faTitle: string;
  currentUserName?: string | null;
  currentUserId?: number | null;
  faClosed?: boolean;
}) {
  const { toast } = useToast();
  const [links, setLinks] = useState<FALot[]>([]);
  const [allLots, setAllLots] = useState<Lot[]>([]);
  const [open, setOpen] = useState(false);
  const [selectedLotId, setSelectedLotId] = useState<string>("");
  const [shouldQuarantine, setShouldQuarantine] = useState(true);
  const [sigOpen, setSigOpen] = useState(false);
  const [pendingLot, setPendingLot] = useState<Lot | null>(null);

  async function reload() {
    const [linksRes, lotsRes] = await Promise.all([
      fetch(`/api/field-actions/${fieldActionId}/lots`, { credentials: "include" }),
      fetch(`/api/lots`, { credentials: "include" }),
    ]);
    if (linksRes.ok) setLinks(await linksRes.json());
    if (lotsRes.ok) setAllLots(await lotsRes.json());
  }
  useEffect(() => { void reload(); }, [fieldActionId]);

  function handleAttach() {
    const lotId = Number(selectedLotId);
    if (!lotId) { toast({ title: "Pick a lot first", variant: "destructive" }); return; }
    const lot = allLots.find((l) => l.id === lotId);
    if (!lot) return;
    if (shouldQuarantine && lot.status !== "Active") {
      toast({
        title: "Cannot quarantine",
        description: `Lot is already ${lot.status}. Attaching as reference only — no signature required.`,
      });
      void doAttach(lot, false);
      return;
    }
    if (shouldQuarantine && lot.status === "Active") {
      setPendingLot(lot); setSigOpen(true);
    } else {
      void doAttach(lot, false);
    }
  }

  async function doAttach(lot: Lot, withSig: boolean, initials?: string, meaning?: string) {
    const res = await fetch(`/api/field-actions/${fieldActionId}/lots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        lotId: lot.id,
        autoQuarantine: withSig,
        performedByName: currentUserName ?? null,
        performedBy: currentUserId ?? null,
        initials, signatureMeaning: meaning,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast({ title: "Failed", description: err.error ?? "Could not attach lot", variant: "destructive" });
      return;
    }
    toast({ title: withSig ? `Lot ${lot.lotNumber} quarantined` : `Lot ${lot.lotNumber} attached` });
    setOpen(false); setSelectedLotId(""); setShouldQuarantine(true); setPendingLot(null);
    void reload();
  }

  async function handleDetach(lotId: number, lotNumber: string) {
    if (!confirm(`Remove lot ${lotNumber} from this field action?`)) return;
    const res = await fetch(`/api/field-actions/${fieldActionId}/lots/${lotId}`, {
      method: "DELETE", credentials: "include",
    });
    if (!res.ok) { toast({ title: "Detach failed", variant: "destructive" }); return; }
    toast({ title: "Lot removed" });
    void reload();
  }

  const linkedIds = new Set(links.map((l) => l.lotId));
  const availableLots = allLots.filter((l) => !linkedIds.has(l.id));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-orange-600" />
          Affected Lots ({links.length})
        </CardTitle>
        {!faClosed && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">Attach Lot</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Attach Lot to Field Action</DialogTitle></DialogHeader>
              <div className="space-y-4 py-2">
                <div>
                  <Label>Lot</Label>
                  <Select value={selectedLotId} onValueChange={setSelectedLotId}>
                    <SelectTrigger><SelectValue placeholder="Select a lot…" /></SelectTrigger>
                    <SelectContent>
                      {availableLots.length === 0 ? (
                        <div className="px-2 py-1 text-sm text-muted-foreground">No more lots to attach.</div>
                      ) : availableLots.map((l) => (
                        <SelectItem key={l.id} value={String(l.id)}>
                          {l.lotNumber} — {l.itemName} ({l.status}, {l.currentQuantity} {l.unitOfMeasure})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={shouldQuarantine}
                    onChange={(e) => setShouldQuarantine(e.target.checked)}
                  />
                  <span>
                    <strong>Auto-quarantine this lot</strong>
                    <span className="block text-muted-foreground text-xs">
                      Flips status to Quarantined and writes a signed lot event referencing {faNumber}. Requires e-signature.
                    </span>
                  </span>
                </label>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={handleAttach}>{shouldQuarantine ? "Attach & Sign" : "Attach"}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </CardHeader>
      <CardContent>
        {links.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center">
            No lots attached. Use "Attach Lot" to link affected inventory and (optionally) auto-quarantine it.
          </div>
        ) : (
          <div className="space-y-2">
            {links.map((link) => (
              <div key={link.id} className="flex items-center justify-between border rounded-md p-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Link href={`/lots/${link.lot.id}`} className="font-mono font-medium text-primary hover:underline">
                      {link.lot.lotNumber}
                    </Link>
                    <Badge variant={STATUS_VARIANT[link.lot.status] ?? "outline"}>{link.lot.status}</Badge>
                    {link.quarantinedAt && (
                      <span className="text-xs text-muted-foreground">
                        quarantined {new Date(link.quarantinedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {link.lot.itemName} · {link.lot.currentQuantity} {link.lot.unitOfMeasure}
                  </div>
                </div>
                {!faClosed && (
                  <Button size="icon" variant="ghost" onClick={() => handleDetach(link.lot.id, link.lot.lotNumber)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
      {pendingLot && (
        <Part11SignatureDialog
          open={sigOpen}
          onOpenChange={(v) => { setSigOpen(v); if (!v) setPendingLot(null); }}
          title={`Quarantine ${pendingLot.lotNumber}`}
          description={`This will flip lot ${pendingLot.lotNumber} (${pendingLot.itemName}) to Quarantined status and write a signed lot event referencing field action ${faNumber}: ${faTitle}.`}
          isPending={false}
          onSign={async (initials, meaning) => {
            await doAttach(pendingLot, true, initials, meaning);
          }}
        />
      )}
    </Card>
  );
}
