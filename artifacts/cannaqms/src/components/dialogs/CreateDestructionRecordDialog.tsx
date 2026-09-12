import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Flame, ScanLine, Trash2, Plus } from "lucide-react";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

const DESTRUCTION_REASONS = [
  "Failed Test", "Expired", "Low Potency", "Damaged", "Processing Scrap", "Recall", "Return", "Other",
] as const;
const UOM_OPTIONS = ["ea", "g", "oz", "lb", "kg", "mg"] as const; // "ea" = Each (individual). Scanned tags lock to METRC's own unit.
const METRC_ADJUSTMENT_REASONS = ["Waste", "Spoilage"] as const;
const DISPOSAL_ROUTES = ["On-site denature to landfill", "Licensed hauler (off-site)", "On-site incineration", "Compost / bio-digest", "Other"] as const;
const HAULER_ROUTE = "Licensed hauler (off-site)";

// Session 49 / 2026-08-05 — Create a METRC destruction record.
//
// destruction_records is an off-spec route (not in the OpenAPI surface yet),
// so this uses raw fetch with credentials rather than an orval hook.
//
// A destruction record is one destruction SESSION (header: date, method,
// witness, render-unusable, disposal, camera, Part 11 sig, DEFAULT reason) that
// lists MANY package tags being destroyed — each a scanned METRC number. Per
// Michigan CRA the full tag of each destroyed package must be logged. For a
// PACKAGED item the amount + unit are pulled from METRC / Finished Goods on
// scan (the operator shouldn't have to count); bulk waste is entered by hand.
// Each line can override the header's default reason.

export type CreatedDestructionRecord = { id: number; metrcTag: string };

// Fields the operator can carry from one destruction record to the next (a full
// waste session often produces several records back-to-back with the same
// witness, method, surveillance, and default reason). Held at module scope so it
// survives the dialog's per-open reset; cleared when the operator unchecks it.
type DestructionCarryOver = {
  reason: string;
  witnessName: string;
  method: string;
  surveillanceConfirmed: boolean;
  surveillanceCameraRef: string;
};
let destructionCarryOver: DestructionCarryOver | null = null;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (record: CreatedDestructionRecord) => void | Promise<void>;
  // When opened from a complaint, seed the first line's tag.
  initialSourceLot?: string;
  // When opened from a field action, seed one line per affected METRC tag.
  initialTags?: string[];
  // Optional compliance banner shown at the top of the dialog (e.g. the CRA
  // admin-hold / recall approval reminder passed in from a field action).
  noticeText?: string;
};

type Line = {
  id: number;
  metrcTag: string;
  itemName: string | null;
  amount: string;
  uom: string;
  reason: string;
  note: string;
  fromMetrc: boolean;
};

type MetrcPkg = { qty: number | null; uom: string | null; item: string | null };

export function CreateDestructionRecordDialog({ open, onOpenChange, onCreated, initialSourceLot, initialTags, noticeText }: Props) {
  const { toast } = useToast();
  const { data: currentUser } = useGetCurrentUser();

  const [destroyedAt, setDestroyedAt] = useState("");
  const [destroyedByName, setDestroyedByName] = useState("");
  const [witnessName, setWitnessName] = useState("");
  const [reason, setReason] = useState(""); // header DEFAULT reason
  const [method, setMethod] = useState("");
  const [mixtureConfirmed, setMixtureConfirmed] = useState(false);
  const [notes, setNotes] = useState("");
  const [metrcReason, setMetrcReason] = useState("Waste");
  const [disposalRoute, setDisposalRoute] = useState("");
  const [haulerName, setHaulerName] = useState("");
  const [manifestNumber, setManifestNumber] = useState("");
  const [surveillanceConfirmed, setSurveillanceConfirmed] = useState(false);
  const [surveillanceCameraRef, setSurveillanceCameraRef] = useState("");
  const [carryOver, setCarryOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Lines (scanned tags) + the live METRC package map used to auto-fill them.
  const [lines, setLines] = useState<Line[]>([]);
  const [scanValue, setScanValue] = useState("");
  const [metrcMap, setMetrcMap] = useState<Map<string, MetrcPkg>>(new Map());
  const [metrcLoading, setMetrcLoading] = useState(false);
  const [metrcConfigured, setMetrcConfigured] = useState(true);
  const idRef = useRef(0);
  const scanRef = useRef<HTMLInputElement>(null);

  // (Part 11 signature moved to Close & Sign on the detail page — records open unsigned.)
  const initialTagsKey = (initialTags ?? []).join("|");

  // datetime-local wants "YYYY-MM-DDTHH:mm" in local time.
  const localNow = () => {
    const d = new Date();
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
  };

  const makeLine = (tag: string, map: Map<string, MetrcPkg>, defaultReason: string): Line => {
    const t = tag.trim();
    const m = map.get(t);
    return {
      id: ++idRef.current,
      metrcTag: t,
      itemName: m?.item ?? null,
      amount: m && m.qty != null ? String(m.qty) : "",
      uom: m?.uom ?? "",
      reason: defaultReason,
      note: "",
      fromMetrc: !!m,
    };
  };

  useEffect(() => {
    if (!open) return;
    // Reset everything for a fresh record.
    setDestroyedAt(localNow());
    setDestroyedByName(currentUser?.fullName ?? "");
    const co = destructionCarryOver;
    setWitnessName(co?.witnessName ?? "");
    setReason(co?.reason ?? "");
    setMethod(co?.method ?? "");
    setMixtureConfirmed(false);
    setNotes("");
    setMetrcReason("Waste");
    setDisposalRoute("");
    setHaulerName("");
    setManifestNumber("");
    setSurveillanceConfirmed(co?.surveillanceConfirmed ?? false);
    setSurveillanceCameraRef(co?.surveillanceCameraRef ?? "");
    setCarryOver(!!co);
    setError(null);
    setLines([]);
    setScanValue("");
    setMetrcConfigured(true);

    // Pull live METRC active packages once so scanning a packaged tag auto-fills
    // its quantity + unit (operator doesn't count packaged product).
    let cancelled = false;
    setMetrcLoading(true);
    (async () => {
      const map = new Map<string, MetrcPkg>();
      try {
        const r = await fetch("/api/metrc/packages/active", { credentials: "include" });
        const data = await r.json().catch(() => null);
        const pkgs = data?.data?.Data;
        if (data && data.ok === false && (data.kind === "not_configured" || data.config?.configured === false)) {
          if (!cancelled) setMetrcConfigured(false);
        }
        if (Array.isArray(pkgs)) {
          for (const p of pkgs) {
            if (p?.Label) {
              map.set(String(p.Label), {
                qty: typeof p.Quantity === "number" ? p.Quantity : (p.Quantity != null ? Number(p.Quantity) : null),
                uom: p.UnitOfMeasureName ?? null,
                item: p.Item?.Name ?? p.ProductName ?? p.ItemName ?? null,
              });
            }
          }
        }
      } catch { /* METRC unreachable — manual entry still works */ }
      if (cancelled) return;
      setMetrcMap(map);
      setMetrcLoading(false);
      // Seed lines from the caller: a field action passes one tag per affected
      // package/batch; a complaint passes a single source lot.
      if (initialTags && initialTags.length) {
        const seeded = initialTags
          .map((t) => (t ?? "").trim())
          .filter((t, i, arr) => t !== "" && arr.indexOf(t) === i)
          .map((t) => makeLine(t, map, ""));
        if (seeded.length) setLines(seeded);
      } else if (initialSourceLot && initialSourceLot.trim()) {
        setLines([makeLine(initialSourceLot, map, "")]);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentUser?.fullName, initialSourceLot, initialTagsKey]);

  const addScannedTag = (tag: string) => {
    const t = tag.trim();
    if (!t) return;
    setLines((prev) => [...prev, makeLine(t, metrcMap, reason)]);
    setScanValue("");
    // keep focus on the scan box for the next scan
    setTimeout(() => scanRef.current?.focus(), 0);
  };

  const updateLine = (id: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const removeLine = (id: number) => setLines((prev) => prev.filter((l) => l.id !== id));

  const handleSubmit = async () => {
    setError(null);
    if (lines.length === 0) { setError("Scan or add at least one METRC tag being destroyed."); return; }
    if (!destroyedAt) { setError("Date destroyed is required."); return; }
    if (!destroyedByName.trim()) { setError("Destroyed by is required."); return; }
    if (!reason) { setError("A default reason is required."); return; }
    if (disposalRoute === HAULER_ROUTE && (!haulerName.trim() || !manifestNumber.trim())) {
      setError("Off-site hauling requires the hauler name and manifest number."); return;
    }
    for (const l of lines) {
      if (l.amount.trim() && Number.isNaN(Number(l.amount))) {
        setError(`Amount for ${l.metrcTag} must be a number.`); return;
      }
    }

    setSubmitting(true);
    try {
      const r = await fetch(`/api/destruction-records`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destroyedAt: new Date(destroyedAt).toISOString(),
          destroyedByName: destroyedByName.trim(),
          witnessName: witnessName.trim() || null,
          reason, // header default reason
          method: method.trim() || null,
          nonCannabisMaterial: null,
          mixtureConfirmed,
          disposalRoute: disposalRoute || null,
          haulerName: haulerName.trim() || null,
          manifestNumber: manifestNumber.trim() || null,
          surveillanceConfirmed,
          surveillanceCameraRef: surveillanceCameraRef.trim() || null,
          notes: notes.trim() || null,
          metrcAdjustmentReason: metrcReason,
          lines: lines.map((l) => ({
            metrcTag: l.metrcTag,
            itemName: l.itemName,
            amount: l.amount.trim() === "" ? null : Number(l.amount),
            uom: l.uom || null,
            reason: l.reason || null,
            note: l.note.trim() || null,
          })),
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error ?? "Failed to create destruction record.");
      }
      const record = await r.json() as CreatedDestructionRecord;
      if (onCreated) await onCreated(record);
      // Remember (or clear) the carry-over header fields for the next record.
      destructionCarryOver = carryOver
        ? { reason, witnessName, method, surveillanceConfirmed, surveillanceCameraRef }
        : null;
      toast({ title: "Destruction Record Opened", description: `${lines.length} package${lines.length === 1 ? "" : "s"} recorded. Add more, then Close & Sign when done.` });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create destruction record.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Flame className="h-4 w-4 text-red-500" />
            Open Destruction Record
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {noticeText && (
            <p className="text-xs rounded-md border border-amber-300 bg-amber-50 text-amber-900 p-2.5">
              {noticeText}
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}

          {/* ── Items being destroyed (scanned METRC tags) ── */}
          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium flex items-center gap-1.5">
                <ScanLine className="h-3.5 w-3.5" /> Packages being adjusted
                <span className="text-muted-foreground font-normal">({lines.length})</span>
              </p>
              {metrcLoading && <span className="text-[10px] text-muted-foreground">Loading METRC inventory…</span>}
            </div>

            <div className="flex gap-2">
              <Input
                ref={scanRef}
                autoFocus
                className="font-mono text-sm"
                placeholder="Scan or type a METRC tag, then Enter"
                value={scanValue}
                onChange={(e) => setScanValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); addScannedTag(scanValue); }
                }}
              />
              <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => addScannedTag(scanValue)}>
                <Plus className="h-4 w-4 mr-1" /> Add
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Packaged product pulls its quantity &amp; unit from METRC / Finished Goods on scan — no counting.
              Bulk waste: add the tag, then type the amount.
              {!metrcConfigured && " (METRC isn't connected, so amounts are manual.)"}
            </p>

            {lines.length === 0 ? (
              <p className="text-sm text-muted-foreground italic py-2 text-center">No packages added yet.</p>
            ) : (
              <div className="space-y-1.5">
                {lines.map((l) => (
                  <div key={l.id} className="rounded border bg-muted/20 p-2 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-medium truncate flex-1">{l.metrcTag}</span>
                      {l.fromMetrc && <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 shrink-0">METRC</span>}
                      <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => removeLine(l.id)}>
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                    {l.itemName && <p className="text-[11px] text-muted-foreground truncate">{l.itemName}</p>}
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Amount</Label>
                        <Input
                          className="h-8 text-sm"
                          type="number"
                          step="any"
                          value={l.amount}
                          onChange={(e) => updateLine(l.id, { amount: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Unit</Label>
                        {l.fromMetrc ? (
                          <div className="h-8 flex items-center px-2 rounded-md border bg-muted/40 text-sm" title="Unit is set by METRC for this tag — you're adjusting that many of METRC's own unit, not converting to eaches.">
                            {l.uom || "—"}
                          </div>
                        ) : (
                          <Select value={l.uom} onValueChange={(v) => updateLine(l.id, { uom: v })}>
                            <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="unit" /></SelectTrigger>
                            <SelectContent>
                              {UOM_OPTIONS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Reason</Label>
                        <Select value={l.reason} onValueChange={(v) => updateLine(l.id, { reason: v })}>
                          <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="reason" /></SelectTrigger>
                          <SelectContent>
                            {DESTRUCTION_REASONS.map((rn) => <SelectItem key={rn} value={rn}>{rn}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <Input
                      className="h-8 text-xs"
                      placeholder="Detail (optional) — e.g. wrong size/color, not meeting internal spec"
                      value={l.note}
                      onChange={(e) => updateLine(l.id, { note: e.target.value })}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Default reason (applies to new scans) ── */}
          <div>
            <Label className="text-xs">Default reason for destruction <span className="text-destructive">*</span></Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Applied to each package (override per line above)" /></SelectTrigger>
              <SelectContent>
                {DESTRUCTION_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground mt-0.5">New scans use this reason; change any line above to mix reasons in one session.</p>
          </div>

          {/* ── METRC adjustment reason (Waste / Spoilage) ── */}
          <div>
            <Label className="text-xs">METRC adjustment reason <span className="text-destructive">*</span></Label>
            <Select value={metrcReason} onValueChange={setMetrcReason}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Waste or Spoilage" /></SelectTrigger>
              <SelectContent>
                {METRC_ADJUSTMENT_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground mt-0.5">What METRC records when these packages are adjusted to 0. Waste covers most destruction (incl. recalls &amp; scrap); Spoilage is for expired/spoiled edibles.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Date Destroyed <span className="text-destructive">*</span></Label>
              <Input type="datetime-local" className="mt-1" value={destroyedAt} max={localNow()} onChange={(e) => setDestroyedAt(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Destroyed By <span className="text-destructive">*</span></Label>
              <Input className="mt-1" placeholder="Employee name" value={destroyedByName} onChange={(e) => setDestroyedByName(e.target.value)} />
            </div>
          </div>

          <div>
            <Label className="text-xs">Witness</Label>
            <Input className="mt-1" placeholder="Witness name (Michigan CRA generally requires one)" value={witnessName} onChange={(e) => setWitnessName(e.target.value)} />
          </div>

          <div>
            <Label className="text-xs">Method (incl. any non-cannabis material mixed in)</Label>
            <Input className="mt-1" placeholder="e.g. Ground and denatured with kitty litter + soap; incinerated via licensed waste co" value={method} onChange={(e) => setMethod(e.target.value)} />
          </div>

          <div className="rounded-md border p-3 space-y-2 bg-muted/30">
            <p className="text-xs font-medium">Disposal route &amp; manifest (R 420.211)</p>
            <div>
              <Label className="text-xs">Disposal route</Label>
              <Select value={disposalRoute} onValueChange={setDisposalRoute}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="How the waste left the facility" /></SelectTrigger>
                <SelectContent>
                  {DISPOSAL_ROUTES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {disposalRoute === HAULER_ROUTE && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Waste hauler <span className="text-destructive">*</span></Label>
                  <Input className="mt-1" placeholder="Licensed waste company" value={haulerName} onChange={(e) => setHaulerName(e.target.value)} />
                </div>
                <div>
                  <Label className="text-xs">Manifest # <span className="text-destructive">*</span></Label>
                  <Input className="mt-1 font-mono" placeholder="Hauler manifest / BOL" value={manifestNumber} onChange={(e) => setManifestNumber(e.target.value)} />
                </div>
              </div>
            )}
          </div>

          <div className="rounded-md border p-3 space-y-2 bg-muted/30">
            <p className="text-xs font-medium">Rendered unusable (R 420.211)</p>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <Checkbox checked={mixtureConfirmed} onCheckedChange={(c) => setMixtureConfirmed(c === true)} className="mt-0.5" />
              <span>Product was ground/rendered unrecognizable and mixed so the resulting waste is at least 50% non-marijuana.</span>
            </label>
          </div>

          <div className="rounded-md border p-3 space-y-2 bg-muted/30">
            <p className="text-xs font-medium">Video surveillance</p>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <Checkbox checked={surveillanceConfirmed} onCheckedChange={(c) => setSurveillanceConfirmed(c === true)} className="mt-0.5" />
              <span>Destruction was performed within view of the facility&apos;s video surveillance system and the footage is retained per CRA retention rules.</span>
            </label>
            <div>
              <Label className="text-xs">Camera / location reference</Label>
              <Input className="mt-1" placeholder="e.g. Cam 7 — waste room" value={surveillanceCameraRef} onChange={(e) => setSurveillanceCameraRef(e.target.value)} />
            </div>
          </div>

          <div>
            <Label className="text-xs">Notes</Label>
            <Textarea className="mt-1 text-sm" rows={2} placeholder="Any additional detail about the destruction event." value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <label className="flex items-start gap-2 text-xs cursor-pointer rounded-md border border-dashed p-2.5">
            <Checkbox
              checked={carryOver}
              onCheckedChange={(c) => { const v = c === true; setCarryOver(v); if (!v) destructionCarryOver = null; }}
              className="mt-0.5"
            />
            <span>Carry the default reason, witness, method, and video-surveillance details over to the next destruction record (stays on until you uncheck it).</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Opening…" : "Open Record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
