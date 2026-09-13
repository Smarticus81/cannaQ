import { displayLotNumber, isBlankLotNumber } from "@/lib/lotDisplay";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { GitBranch, Truck, AlertOctagon, FlaskConical } from "lucide-react";

type Lot = {
  id: number; lotNumber: string; itemName: string; itemType: string;
  unitOfMeasure: string; originalQuantity: number; currentQuantity: number;
  origin: string; status: string; expirationDate: string | null;
  parentLotId: number | null; sourceBatchId: number | null;
  availableAsIngredient?: boolean;
  notes: string | null; createdByName: string | null; createdAt: string;
};

type LotEvent = {
  id: number; eventType: string; quantityDelta: number; resultingQuantity: number;
  reason: string | null; performedByName: string | null;
  signedInitials: string | null; signedMeaning: string | null; signedAt: string | null;
  createdAt: string;
};

type LineageNode = { type: "lot"; lot: Lot; viaBatch?: { id: number; batchNumber: string; productName: string } | null; children: Array<LineageNode | { type: "shipment"; data: { id: number; customerName: string; shippedQuantity: number; unitOfMeasure: string; manifestNumber: string | null; shippedDate: string } }>; parents?: LineageNode[] };

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  Active: "default", Quarantined: "secondary", Consumed: "outline", Recalled: "destructive", Expired: "secondary",
};

export default function LotDetail() {
  const { id } = useParams<{ id: string }>();
  const lotId = Number(id);
  const [lot, setLot] = useState<Lot | null>(null);
  const [events, setEvents] = useState<LotEvent[]>([]);
  const [forward, setForward] = useState<LineageNode | null>(null);
  const [backward, setBackward] = useState<LineageNode | null>(null);
  const { data: currentUser } = useGetCurrentUser();
  const canAssignLot = !!currentUser?.role && ["Manager", "Quality", "Admin"].includes(currentUser.role);
  const [assigning, setAssigning] = useState(false);
  const [newLot, setNewLot] = useState("");
  const [assignErr, setAssignErr] = useState<string | null>(null);
  const [assignBusy, setAssignBusy] = useState(false);

  async function reload() {
    const [lotRes, evRes, fwdRes, bwdRes] = await Promise.all([
      fetch(`/api/lots/${lotId}`).then((r) => r.json()),
      fetch(`/api/lots/${lotId}/events`).then((r) => r.json()),
      fetch(`/api/lots/${lotId}/lineage/forward`).then((r) => r.json()),
      fetch(`/api/lots/${lotId}/lineage/backward`).then((r) => r.json()),
    ]);
    setLot(lotRes); setEvents(evRes); setForward(fwdRes); setBackward(bwdRes);
  }
  useEffect(() => { void reload(); }, [lotId]);

  async function assignLotNumber() {
    if (!newLot.trim()) { setAssignErr("Enter a lot number."); return; }
    setAssignBusy(true); setAssignErr(null);
    try {
      const res = await fetch(`/api/lots/${lotId}/assign-lot-number`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lotNumber: newLot.trim() }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({} as { error?: string })); setAssignErr(b.error ?? "Failed to assign lot number."); return; }
      setAssigning(false); setNewLot("");
      await reload();
    } finally { setAssignBusy(false); }
  }

  if (!lot) return <><Skeleton className="h-32 w-full" /></>;

  return (
    <>
      <div className="space-y-6">
        <div className="cq-page-heading flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight font-mono">{displayLotNumber(lot.lotNumber)}</h1>
              {canAssignLot && isBlankLotNumber(lot.lotNumber) && (
                <>
                  {assigning ? (
                    <span className="flex items-center gap-1">
                      <Input autoFocus value={newLot} onChange={(e) => setNewLot(e.target.value)} placeholder="Internal lot # (FIFO)" className="h-8 w-48 font-mono text-sm" onKeyDown={(e) => { if (e.key === "Enter") void assignLotNumber(); if (e.key === "Escape") { setAssigning(false); setAssignErr(null); } }} />
                      <Button size="sm" onClick={() => void assignLotNumber()} disabled={assignBusy}>{assignBusy ? "Saving…" : "Save"}</Button>
                      <Button size="sm" variant="ghost" onClick={() => { setAssigning(false); setNewLot(""); setAssignErr(null); }}>Cancel</Button>
                    </span>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => { setAssigning(true); setNewLot(""); setAssignErr(null); }}>Set lot #</Button>
                  )}
                  {assignErr && <span className="text-xs text-destructive">{assignErr}</span>}
                </>
              )}
              <Badge variant={STATUS_VARIANT[lot.status] ?? "outline"} data-testid="badge-status">{lot.status}</Badge>
              <Badge variant="outline">{lot.origin}</Badge>
              {lot.availableAsIngredient && (
                <Badge variant="secondary" className="gap-1" data-testid="badge-available-ingredient">
                  <FlaskConical className="h-3 w-3" /> Available as ingredient
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground mt-1">{lot.itemName} — {lot.itemType}</p>
          </div>
          <div className="flex gap-2">
            {lot.origin === "produced" && <PromoteIngredientDialog lot={lot} onDone={reload} />}
            <SplitDialog lot={lot} onDone={reload} />
            <ShipDialog lot={lot} onDone={reload} />
            <RecallDialog lot={lot} onDone={reload} />
          </div>
        </div>

        <div className="grid grid-cols-5 gap-4">
          <StatCard label="Remaining" value={`${lot.currentQuantity} ${lot.unitOfMeasure}`} />
          <StatCard label="Original" value={`${lot.originalQuantity} ${lot.unitOfMeasure}`} />
          <StatCard label="Received" value={lot.createdAt ? new Date(lot.createdAt).toLocaleDateString() : "—"} />
          <StatCard label="Expires" value={lot.expirationDate ? new Date(lot.expirationDate + "T00:00:00").toLocaleDateString() : "—"} />
          <StatCard label="Created By" value={lot.createdByName ?? "—"} />
        </div>

        <Tabs defaultValue="forward">
          <TabsList>
            <TabsTrigger value="forward" data-testid="tab-forward">Forward Lineage</TabsTrigger>
            <TabsTrigger value="backward" data-testid="tab-backward">Backward Lineage</TabsTrigger>
            <TabsTrigger value="events" data-testid="tab-events">Event Ledger</TabsTrigger>
          </TabsList>

          <TabsContent value="forward">
            <Card>
              <CardHeader><CardTitle>Where this lot ended up</CardTitle></CardHeader>
              <CardContent>
                {forward ? <ForwardTree node={forward} depth={0} /> : <Skeleton className="h-20 w-full" />}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="backward">
            <Card>
              <CardHeader><CardTitle>What this lot was made from</CardTitle></CardHeader>
              <CardContent>
                {backward ? <BackwardTree node={backward} depth={0} /> : <Skeleton className="h-20 w-full" />}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="events">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead className="text-right">Δ Qty</TableHead>
                      <TableHead className="text-right">Resulting</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>By</TableHead>
                      <TableHead>E-Sig</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map((e) => (
                      <TableRow key={e.id} data-testid={`row-event-${e.id}`}>
                        <TableCell className="text-xs">{new Date(e.createdAt).toLocaleString()}</TableCell>
                        <TableCell><Badge variant="outline">{e.eventType}</Badge></TableCell>
                        <TableCell className="text-right tabular-nums">
                          {e.quantityDelta > 0 ? "+" : ""}{e.quantityDelta}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{e.resultingQuantity}</TableCell>
                        <TableCell className="text-xs">{e.reason ?? "—"}</TableCell>
                        <TableCell className="text-xs">{e.performedByName ?? "—"}</TableCell>
                        <TableCell className="text-xs">
                          {e.signedInitials ? `${e.signedInitials} — ${e.signedMeaning}` : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card><CardContent className="pt-6">
      <div className="text-xs text-muted-foreground uppercase">{label}</div>
      <div className="text-lg font-semibold mt-1">{value}</div>
    </CardContent></Card>
  );
}

function ForwardTree({ node, depth }: { node: LineageNode; depth: number }) {
  return (
    <div style={{ marginLeft: depth * 16 }} className="border-l-2 pl-3 py-1">
      <div className="flex items-center gap-2">
        <Link href={`/lots/${node.lot.id}`} className="font-mono text-primary hover:underline">{displayLotNumber(node.lot.lotNumber)}</Link>
        <span className="text-sm text-muted-foreground">{node.lot.itemName}</span>
        <Badge variant={STATUS_VARIANT[node.lot.status] ?? "outline"}>{node.lot.status}</Badge>
        {node.viaBatch && (
          <span className="text-xs text-muted-foreground">
            via batch <Link href={`/batches/${node.viaBatch.id}`} className="text-primary hover:underline">{node.viaBatch.batchNumber}</Link>
          </span>
        )}
      </div>
      {node.children.map((c, i) => c.type === "lot" ? (
        <ForwardTree key={`l-${c.lot.id}-${i}`} node={c} depth={depth + 1} />
      ) : (
        <div key={`s-${c.data.id}`} style={{ marginLeft: (depth + 1) * 16 }} className="border-l-2 pl-3 py-1 text-sm">
          <Truck className="inline h-3 w-3 mr-1" />
          Shipped {c.data.shippedQuantity} {c.data.unitOfMeasure} to <strong>{c.data.customerName}</strong> on {c.data.shippedDate}
          {c.data.manifestNumber && <span className="text-muted-foreground"> (manifest {c.data.manifestNumber})</span>}
        </div>
      ))}
    </div>
  );
}

function BackwardTree({ node, depth }: { node: LineageNode; depth: number }) {
  return (
    <div style={{ marginLeft: depth * 16 }} className="border-l-2 pl-3 py-1">
      <div className="flex items-center gap-2">
        <Link href={`/lots/${node.lot.id}`} className="font-mono text-primary hover:underline">{displayLotNumber(node.lot.lotNumber)}</Link>
        <span className="text-sm text-muted-foreground">{node.lot.itemName}</span>
        <Badge variant={STATUS_VARIANT[node.lot.status] ?? "outline"}>{node.lot.status}</Badge>
      </div>
      {(node.parents ?? []).map((p) => <BackwardTree key={p.lot.id} node={p} depth={depth + 1} />)}
    </div>
  );
}

function SignFields({ initials, meaning, setInitials, setMeaning }:
  { initials: string; meaning: string; setInitials: (s: string) => void; setMeaning: (s: string) => void }) {
  return (
    <>
      <div><Label>Your initials</Label>
        <Input value={initials} onChange={(e) => setInitials(e.target.value)} data-testid="input-sig-initials" /></div>
      <div><Label>Meaning of signature</Label>
        <Input value={meaning} onChange={(e) => setMeaning(e.target.value)} data-testid="input-sig-meaning" /></div>
    </>
  );
}

// Follow-up #2 (post-Session 79) — release an in-house intermediate (cannabutter,
// distillate, etc.) for downstream use as an ingredient. Only shown for produced
// lots. Flipping the flag puts the lot on the Inventory rollup + the ingredient
// lot-picker (both read the shared inventory view) so it can be consumed like a
// raw material. Supervisor+ e-signature (Part 11), same SignFields pattern as
// Split/Recall.
function PromoteIngredientDialog({ lot, onDone }: { lot: Lot; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [initials, setInitials] = useState("");
  const [meaning, setMeaning] = useState("Released as ingredient — passed testing");
  const [err, setErr] = useState<string | null>(null);
  const alreadyPromoted = !!lot.availableAsIngredient;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" disabled={lot.status !== "Active" || alreadyPromoted} data-testid="button-promote-ingredient">
          <FlaskConical className="h-4 w-4 mr-1" /> {alreadyPromoted ? "Released as Ingredient" : "Release as Ingredient"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Release {lot.lotNumber} as Ingredient</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This in-house lot ({lot.itemName}) will be added to raw-material Inventory and the
            ingredient lot-picker so it can be consumed in downstream batches. Use after the lot
            has passed testing. Requires Supervisor+ e-signature (Part 11).
          </p>
          <SignFields initials={initials} meaning={meaning} setInitials={setInitials} setMeaning={setMeaning} />
          {err && <p className="text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button disabled={!initials || !meaning}
            data-testid="button-confirm-promote"
            onClick={async () => {
              const res = await fetch(`/api/lots/${lot.id}/promote-ingredient`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ initials, meaning }),
              });
              if (!res.ok) { setErr((await res.json()).error ?? "Failed"); return; }
              setOpen(false); onDone();
            }}>Sign &amp; Release</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SplitDialog({ lot, onDone }: { lot: Lot; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [parts, setParts] = useState([{ quantity: "", notes: "" }, { quantity: "", notes: "" }]);
  const [initials, setInitials] = useState(""); const [meaning, setMeaning] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const total = parts.reduce((s, p) => s + Number(p.quantity || 0), 0);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" disabled={lot.status !== "Active"} data-testid="button-split">
          <GitBranch className="h-4 w-4 mr-1" /> Split
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Split Lot {lot.lotNumber}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Available: {lot.currentQuantity} {lot.unitOfMeasure}. Splits require Manager+ e-signature (Part 11).
          </p>
          {parts.map((p, i) => (
            <div key={i} className="grid grid-cols-2 gap-2">
              <div><Label>Part {i + 1} qty</Label>
                <Input type="number" step="0.01" value={p.quantity}
                  onChange={(e) => { const np = [...parts]; np[i] = { ...np[i]!, quantity: e.target.value }; setParts(np); }} /></div>
              <div><Label>Notes</Label>
                <Input value={p.notes}
                  onChange={(e) => { const np = [...parts]; np[i] = { ...np[i]!, notes: e.target.value }; setParts(np); }} /></div>
            </div>
          ))}
          <div className="flex justify-between text-sm">
            <Button variant="ghost" size="sm" onClick={() => setParts([...parts, { quantity: "", notes: "" }])}>+ Add part</Button>
            <span className={total > lot.currentQuantity ? "text-destructive" : "text-muted-foreground"}>
              Total: {total} / {lot.currentQuantity}
            </span>
          </div>
          <SignFields initials={initials} meaning={meaning} setInitials={setInitials} setMeaning={setMeaning} />
          {err && <p className="text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button disabled={!initials || !meaning || total <= 0 || total > lot.currentQuantity}
            data-testid="button-confirm-split"
            onClick={async () => {
              const res = await fetch(`/api/lots/${lot.id}/split`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parts: parts.map((p) => ({ quantity: Number(p.quantity), notes: p.notes || undefined })), initials, meaning }),
              });
              if (!res.ok) { setErr((await res.json()).error ?? "Failed"); return; }
              setOpen(false); onDone();
            }}>Sign &amp; Split</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShipDialog({ lot, onDone }: { lot: Lot; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ customerName: "", customerLicense: "", shippedQuantity: "", manifestNumber: "", shippedDate: new Date().toISOString().slice(0, 10), notes: "" });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" disabled={lot.status !== "Active"} data-testid="button-ship">
          <Truck className="h-4 w-4 mr-1" /> Ship
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Record Shipment from {lot.lotNumber}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Customer Name</Label>
            <Input value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} data-testid="input-customer-name" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>License #</Label>
              <Input value={form.customerLicense} onChange={(e) => setForm({ ...form, customerLicense: e.target.value })} /></div>
            <div><Label>Manifest #</Label>
              <Input value={form.manifestNumber} onChange={(e) => setForm({ ...form, manifestNumber: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Quantity ({lot.unitOfMeasure})</Label>
              <Input type="number" step="0.01" value={form.shippedQuantity}
                onChange={(e) => setForm({ ...form, shippedQuantity: e.target.value })}
                data-testid="input-ship-qty" /></div>
            <div><Label>Shipped Date</Label>
              <Input type="date" value={form.shippedDate} onChange={(e) => setForm({ ...form, shippedDate: e.target.value })} /></div>
          </div>
          <div><Label>Notes</Label><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          {err && <p className="text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button disabled={!form.customerName || !form.shippedQuantity}
            data-testid="button-confirm-ship"
            onClick={async () => {
              const res = await fetch(`/api/lots/${lot.id}/ship`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...form, shippedQuantity: Number(form.shippedQuantity) }),
              });
              if (!res.ok) { setErr((await res.json()).error ?? "Failed"); return; }
              setOpen(false); onDone();
            }}>Record Shipment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecallDialog({ lot, onDone }: { lot: Lot; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(""); const [initials, setInitials] = useState(""); const [meaning, setMeaning] = useState("Recall authorization");
  const [report, setReport] = useState<{ totalDownstreamLots: number; totalShipments: number; customers: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open && !report) {
      fetch(`/api/lots/${lot.id}/recall-report`).then((r) => r.json()).then(setReport).catch(() => {});
    }
  }, [open, lot.id, report]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" disabled={lot.status === "Recalled"} data-testid="button-recall">
          <AlertOctagon className="h-4 w-4 mr-1" /> Recall
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Recall {lot.lotNumber}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {report && (
            <div className="rounded border p-3 bg-destructive/5">
              <div className="text-sm font-semibold mb-1">Recall scope (downstream of this lot):</div>
              <ul className="text-sm space-y-1">
                <li>• {report.totalDownstreamLots} lot(s) will be marked Recalled</li>
                <li>• {report.totalShipments} shipment(s) affected</li>
                <li>• Customers to notify: {report.customers.length === 0 ? "none recorded" : report.customers.join(", ")}</li>
              </ul>
            </div>
          )}
          <div><Label>Reason</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} data-testid="input-recall-reason" /></div>
          <SignFields initials={initials} meaning={meaning} setInitials={setInitials} setMeaning={setMeaning} />
          {err && <p className="text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="destructive" disabled={!reason || !initials || !meaning}
            data-testid="button-confirm-recall"
            onClick={async () => {
              const res = await fetch(`/api/lots/${lot.id}/recall`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reason, initials, meaning }),
              });
              if (!res.ok) { setErr((await res.json()).error ?? "Failed"); return; }
              setOpen(false); onDone();
            }}>Sign &amp; Recall</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
