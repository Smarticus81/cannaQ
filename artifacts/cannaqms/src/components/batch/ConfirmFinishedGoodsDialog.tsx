import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, CheckCircle2, Trash2, PackageCheck } from "lucide-react";

// FG-3 (2026-07-06) — Confirm as Finished Goods. The packaging supervisor turns
// a batch's source package into N sellable units by scanning each METRC package
// tag (or entering a sequential range), picks the METRC Item (which drives the
// unit of measure), previews the exact payload, then confirms — which POSTs the
// createPackages write to METRC and records the tags on the batch. Write-back is
// guarded server-side (Supervisor+ · METRC_WRITE_ENABLED · dry-run/confirm), so
// Preview always works and Confirm returns a clear message when writes are off.

type MetrcItem = { Name?: string; UnitOfMeasureName?: string; [k: string]: unknown };
type MetrcTag = { Label?: string; Tag?: string; [k: string]: unknown };
// Normalizes the METRC proxy's list payload to an array. The response `data`
// can arrive in several shapes: a `{ Data: [...] }` wrapper, a bare array, or —
// as the sandbox returns it — an array serialized to an object with numeric
// keys ({ "0": {...}, "1": {...} }). The old `j.data.Data` path silently
// returned [] for that last shape, which left the item list empty and marked
// every real available tag "not in your available METRC tags" (Fix 2026-08-12).
const houseData = <T,>(j: { data?: unknown } | null | undefined): T[] => {
  const d = j?.data as unknown;
  if (Array.isArray(d)) return d as T[];
  if (d && typeof d === "object") {
    const inner = (d as { Data?: unknown }).Data;
    if (Array.isArray(inner)) return inner as T[];
    return Object.values(d as Record<string, unknown>).filter((v) => v && typeof v === "object") as T[];
  }
  return [];
};
const tagValue = (t: MetrcTag): string => (t.Label ?? t.Tag ?? "").trim();

// METRC reports a rejected write as a JSON array of per-row messages, e.g.
// [{"row":0,"message":"Package X does not exist in the current Facility."}].
// Rendered raw that is unreadable, and the operator needs to act on it, so it is
// unpacked into plain numbered lines. Anything that is not that shape is passed
// through untouched.
function formatMetrcError(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const msgs = parsed
        .map((r) => (r && typeof r === "object" ? String((r as { message?: unknown }).message ?? "") : String(r)))
        .map((m) => m.trim())
        .filter(Boolean);
      if (msgs.length) {
        return msgs.length === 1
          ? `METRC rejected this: ${msgs[0]}`
          : `METRC rejected this for ${msgs.length} reasons:\n` + msgs.map((m, i) => `${i + 1}. ${m}`).join("\n");
      }
    }
  } catch {
    /* not JSON — fall through to the raw string */
  }
  return raw;
}

/** Expand a sequential tag range by incrementing the trailing number, preserving width. */
function expandTagRange(start: string, end: string, cap = 2000): { tags: string[]; error?: string } {
  const m1 = /^(.*?)(\d+)$/.exec(start.trim());
  const m2 = /^(.*?)(\d+)$/.exec(end.trim());
  if (!m1 || !m2) return { tags: [], error: "Both tags must end in a number to expand a range." };
  if (m1[1] !== m2[1]) return { tags: [], error: "Start and end tags must share the same prefix." };
  const a = BigInt(m1[2]); const b = BigInt(m2[2]);
  if (b < a) return { tags: [], error: "End tag must be greater than or equal to the start tag." };
  const count = Number(b - a) + 1;
  if (count > cap) return { tags: [], error: `Range is too large (${count} tags; max ${cap}). Split it up.` };
  const width = m1[2].length;
  const tags: string[] = [];
  for (let i = a; i <= b; i++) tags.push(m1[1] + i.toString().padStart(width, "0"));
  return { tags };
}

interface Props {
  batchId: number;
  batchNumber: string;
  sourceTagDefault?: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirmed: () => void;
}

export function ConfirmFinishedGoodsDialog({ batchId, batchNumber, sourceTagDefault, open, onOpenChange, onConfirmed }: Props) {
  const today = new Date().toLocaleDateString("en-CA");

  const [items, setItems] = useState<MetrcItem[]>([]);
  const [availableTags, setAvailableTags] = useState<Set<string> | null>(null); // null = not loaded / METRC off

  const [sourcePackage, setSourcePackage] = useState(sourceTagDefault ?? "");
  const [item, setItem] = useState("");
  const [uom, setUom] = useState("");
  const [packagedDate, setPackagedDate] = useState(today);
  // METRC requires a Location (room/area) on every package create. A facility
  // with none cannot package at all, so this is loaded and defaulted rather
  // than typed — a wrong room name is a rejected write.
  const [locations, setLocations] = useState<string[]>([]);
  const [location, setLocation] = useState("");
  const [isProductionBatch, setIsProductionBatch] = useState(true);
  const [qtyPer, setQtyPer] = useState("1");
  const [note, setNote] = useState("");
  // Repeatable packaging (JIT): finalize=true closes the batch to Finished Goods
  // (the original one-shot). finalize=false packages this portion but keeps the
  // batch open so more can be packaged later / per order and labeled then.
  const [finalize, setFinalize] = useState(false);

  const [tagMode, setTagMode] = useState<"scan" | "range">("scan");
  const [scanInput, setScanInput] = useState("");
  const [scannedTags, setScannedTags] = useState<string[]>([]);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  // Per-box quantity overrides (tag → quantity string). A box absent here uses
  // the "Default units per package" value, so the uniform case needs no per-box
  // entry; a partial box (e.g. the last one) just overrides its own count.
  // (2026-08-12 — Jonathan: partial boxes are typical; 5 boxes totaling 99.)
  const [tagQty, setTagQty] = useState<Record<string, string>>({});

  const [initials, setInitials] = useState("");
  const [signingMeaning, setSigningMeaning] = useState("");

  // 2026-09-09 (Jonathan) — RECOVERY for the desync found live 09-07: two
  // packaging runs succeeded in METRC on 09-06 and were recorded on neither
  // batch, and the error text told the operator to "re-run Confirm to record
  // without re-creating" — which was impossible, because Confirm always re-runs
  // the METRC create first and dies there (source drained, tags consumed). With
  // this ticked the METRC create is SKIPPED and only the batch record is
  // written, which is the recovery that advice always described.
  const [recordOnly, setRecordOnly] = useState(false);
  const [preview, setPreview] = useState<unknown | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Sticky success — a METRC write is significant, so we hold the result on
  // screen (created count + tags + METRC Ids) until the user dismisses it,
  // rather than relying on a toast that disappears.
  const [success, setSuccess] = useState<{ count: number; label: string; metrcIds?: number[]; recordedOnly?: boolean } | null>(null);

  // Load Metrc items + available tags when opened.
  useEffect(() => {
    if (!open) return;
    setInitials(""); // Part 11 — the signer types their own initials; never pre-filled.
    setSuccess(null); setError(null); setPreview(null); setTagQty({});
    (async () => {
      // The METRC sandbox items/available-tags endpoints are INTERMITTENT — a
      // call can return HTTP 200 with an EMPTY list even though ~2,100 tags and
      // several items exist, then return the full list on the next call
      // (throttling). So retry each a few times until a non-empty list comes
      // back. An empty result after retries is treated as "unverified" (null for
      // tags) so it warns softly rather than marking every entered tag invalid
      // and hard-blocking Confirm. (Fix 2026-08-12 — Jonathan: valid tags were
      // rejected as "not in your available METRC tags" on an empty load.)
      async function fetchList<T>(url: string): Promise<T[]> {
        for (let attempt = 0; attempt < 3; attempt++) {
          const res = await fetch(url).then((r) => r.json()).catch(() => null);
          const list = houseData<T>(res);
          if (list.length > 0) return list;
        }
        return [];
      }
      try {
        const [itemList, tagList, locList] = await Promise.all([
          fetchList<MetrcItem>("/api/metrc/packages/items"),
          fetchList<MetrcTag>("/api/metrc/packages/available-tags"),
          fetchList<{ Name?: string }>("/api/metrc/packages/locations"),
        ]);
        setItems(itemList);
        const locNames = locList.map((l) => (l?.Name ?? "").trim()).filter(Boolean);
        setLocations(locNames);
        // Default to the only room when there is exactly one, which is the
        // common case — nothing to decide, and the field can't be left blank.
        setLocation((prev) => (prev && locNames.includes(prev) ? prev : (locNames.length === 1 ? locNames[0]! : "")));
        const parsed = tagList.map((t) => tagValue(t).toUpperCase()).filter(Boolean);
        // Non-empty → validate against it. Empty (endpoint kept returning nothing)
        // → null = "couldn't verify", allow entry with a soft warning.
        setAvailableTags(parsed.length > 0 ? new Set(parsed) : null);
      } catch {
        setAvailableTags(null);
      }
    })();
  }, [open]);

  // The explicit list of tags being packaged (range mode expands to individuals).
  const rangeResult = useMemo(
    () => (tagMode === "range" && rangeStart && rangeEnd ? expandTagRange(rangeStart, rangeEnd) : { tags: [] as string[] }),
    [tagMode, rangeStart, rangeEnd],
  );
  const tags = tagMode === "scan" ? scannedTags : rangeResult.tags;
  const invalidTags = availableTags ? tags.filter((t) => !availableTags.has(t.toUpperCase())) : [];
  // Each box's quantity: its own override if set, otherwise the default per-package qty.
  const qtyForTag = (t: string): number => {
    const raw = tagQty[t];
    const v = raw !== undefined && raw !== "" ? Number(raw) : Number(qtyPer);
    return Number.isFinite(v) ? v : NaN;
  };
  const totalUnits = tags.reduce((s, t) => { const q = qtyForTag(t); return s + (q > 0 ? q : 0); }, 0);
  const allTagQtyValid = tags.length > 0 && tags.every((t) => qtyForTag(t) > 0);

  const canSubmit =
    sourcePackage.trim() !== "" && item !== "" && uom.trim() !== "" && packagedDate !== "" &&
    location.trim() !== "" &&
    allTagQtyValid && invalidTags.length === 0 &&
    !rangeResult.error;

  function addScan() {
    const v = scanInput.trim();
    if (!v) return;
    if (scannedTags.some((t) => t.toUpperCase() === v.toUpperCase())) { setScanInput(""); return; }
    setScannedTags((prev) => [...prev, v]);
    setScanInput("");
  }

  function chooseItem(name: string) {
    setItem(name);
    const it = items.find((i) => i.Name === name);
    if (it?.UnitOfMeasureName) setUom(it.UnitOfMeasureName);
  }

  function buildBody(flag: "dryRun" | "confirm") {
    return {
      [flag]: true,
      sourcePackageLabel: sourcePackage.trim(),
      item,
      unitOfMeasure: uom.trim(),
      location: location.trim() || null,
      packagedDate,
      isProductionBatch,
      productionBatchNumber: batchNumber,
      note: note.trim() || null,
      packages: tags.map((t) => ({ tag: t, quantity: qtyForTag(t) })),
    };
  }

  async function runPreview() {
    setBusy(true); setError(null); setInfo(null); setPreview(null);
    try {
      const r = await fetch("/api/metrc/packages/create-finished-goods", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildBody("dryRun")),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ?? "Preview failed."); return; }
      setPreview(j.wouldSend ?? j);
    } finally { setBusy(false); }
  }

  async function confirmWrite() {
    if (!initials.trim() || !signingMeaning.trim()) { setError("Initials and signing meaning are required (21 CFR Part 11)."); return; }
    setBusy(true); setError(null); setInfo(null);
    try {
      // 1) Write the packages to METRC (guarded) — unless METRC already has them.
      let wj: Record<string, unknown> = {};
      if (!recordOnly) {
        const w = await fetch("/api/metrc/packages/create-finished-goods?confirm=true", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildBody("confirm")),
        });
        wj = (await w.json().catch(() => ({}))) as Record<string, unknown>;
      // A METRC refusal must NEVER reach the recording step below. Checking the
      // HTTP status alone is not enough: the write route used to answer 200 with
      // the real failure inside the body, so a 400 from METRC read as a success
      // and four packages METRC had rejected were recorded as created. Both the
      // status AND the payload flag are checked now, so neither layer can lie on
      // its own.
        if (!w.ok || wj["ok"] === false) {
          setError(
            wj["writeEnabled"] === false
              ? "METRC write-back is disabled on the server (METRC_WRITE_ENABLED). Preview works; enabling the write is an admin/ops step."
              : formatMetrcError(wj["error"]) ?? "METRC create failed.",
          );
          return;
        }
      }
      // 2) Record the tags on the batch + advance to Finished Goods (Part 11).
      const total = totalUnits;
      const recBody = tagMode === "range"
        ? { initials: initials.trim(), signingMeaning: signingMeaning.trim(), sourceTag: sourcePackage.trim(), rangeStart: rangeStart.trim(), rangeEnd: rangeEnd.trim(), rangeCount: tags.length, quantity: total, uom: uom.trim(), finalize, metrcCreated: true }
        : { initials: initials.trim(), signingMeaning: signingMeaning.trim(), sourceTag: sourcePackage.trim(), tags, quantity: total, uom: uom.trim(), finalize, metrcCreated: true };
      const rec = await fetch(`/api/batch-records/${batchId}/confirm-finished-goods`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(recBody),
      });
      const rj = await rec.json().catch(() => ({}));
      if (!rec.ok) {
        // The packages now exist in METRC and not here. Arm the recovery for the
        // operator instead of describing one that cannot work.
        setRecordOnly(true);
        setError(`The packages were created in METRC, but recording them on this batch failed: ${rj.error ?? "unknown error"}. "METRC already has these packages" has been ticked below — confirm again to record them here without creating anything in METRC.`);
        return;
      }
      const ids = (wj["data"] as { Ids?: number[] } | undefined)?.Ids;
      const label = tagMode === "range"
        ? `${rangeStart.trim()} – ${rangeEnd.trim()}`
        : (tags.length <= 6 ? tags.join(", ") : `${tags[0]} … ${tags[tags.length - 1]}`);
      setSuccess({ count: tags.length, label, metrcIds: Array.isArray(ids) ? ids : undefined, recordedOnly: recordOnly });
      onConfirmed(); // refresh the batch behind the dialog; keep the panel up until the user closes.
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck className="h-5 w-5 text-emerald-600" />
            Group / Ship Units — {batchNumber}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Create the sellable-unit packages in METRC from this batch's source package, then record them here.
            Tags must be package tags METRC already issued your facility.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Source package (METRC tag)</Label>
              <Input value={sourcePackage} onChange={(e) => setSourcePackage(e.target.value)} placeholder="1A4FF…source" className="font-mono text-xs" />
            </div>
            <div className="space-y-1">
              <Label>Item</Label>
              {items.length > 0 ? (
                <Select value={item} onValueChange={chooseItem}>
                  <SelectTrigger><SelectValue placeholder="Select METRC item…" /></SelectTrigger>
                  <SelectContent>
                    {items.map((it) => (
                      <SelectItem key={it.Name} value={it.Name ?? ""}>{it.Name}{it.UnitOfMeasureName ? ` · ${it.UnitOfMeasureName}` : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <>
                  <Input value={item} onChange={(e) => setItem(e.target.value)} placeholder="Type the exact METRC item name" />
                  <p className="text-[10px] text-amber-700">No METRC items loaded — type the item name exactly as it appears in METRC. It must match an existing item or the create will be rejected.</p>
                </>
              )}
            </div>
            <div className="space-y-1">
              <Label>Unit of measure</Label>
              {items.length > 0 && item ? (
                <>
                  <div className="h-9 flex items-center rounded-md border bg-muted/40 px-3 text-sm">{uom || "—"}</div>
                  <p className="text-[10px] text-muted-foreground">From the METRC item — count-based and weight-based items can't be mixed, so this isn't editable.</p>
                </>
              ) : (
                <Input value={uom} onChange={(e) => setUom(e.target.value)} placeholder="Each / Grams…" />
              )}
            </div>
            <div className="space-y-1">
              <Label>Location</Label>
              {locations.length > 0 ? (
                <Select value={location} onValueChange={setLocation}>
                  <SelectTrigger><SelectValue placeholder="Select a room…" /></SelectTrigger>
                  <SelectContent>
                    {locations.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <>
                  <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Room / area name" />
                  <p className="text-[10px] text-amber-700">No METRC locations found for this facility. METRC requires a room on every package — create one in METRC (Admin → Locations) or the create will be rejected.</p>
                </>
              )}
            </div>
            <div className="space-y-1">
              <Label>Default units per package</Label>
              <Input type="number" min="0" step="any" value={qtyPer} onChange={(e) => setQtyPer(e.target.value)} />
              <p className="text-[10px] text-muted-foreground">Pre-fills each box; edit any box below for a partial fill.</p>
            </div>
            <div className="space-y-1">
              <Label>Packaged date</Label>
              <Input type="date" value={packagedDate} onChange={(e) => setPackagedDate(e.target.value)} />
            </div>
            <div className="flex items-center gap-2 pt-6">
              <Checkbox id="isPB" checked={isProductionBatch} onCheckedChange={(v) => setIsProductionBatch(v === true)} />
              <Label htmlFor="isPB" className="text-sm font-normal">Production batch</Label>
            </div>
          </div>

          {/* Tag entry */}
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Package tags</span>
              <div className="ml-auto flex gap-1">
                <Button type="button" size="sm" variant={tagMode === "scan" ? "default" : "outline"} onClick={() => setTagMode("scan")}>Scan</Button>
                <Button type="button" size="sm" variant={tagMode === "range" ? "default" : "outline"} onClick={() => setTagMode("range")}>Range</Button>
              </div>
            </div>

            {tagMode === "scan" ? (
              <>
                <div className="flex gap-2">
                  <Input
                    value={scanInput}
                    onChange={(e) => setScanInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addScan(); } }}
                    placeholder="Scan or type a tag, press Enter"
                    className="font-mono text-xs"
                  />
                  <Button type="button" variant="outline" onClick={addScan}>Add</Button>
                </div>
                {scannedTags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {scannedTags.map((t) => {
                      const bad = availableTags ? !availableTags.has(t.toUpperCase()) : false;
                      return (
                        <Badge key={t} variant={bad ? "destructive" : "secondary"} className="font-mono text-[10px] gap-1">
                          {t}
                          <Trash2 className="h-3 w-3 cursor-pointer" onClick={() => setScannedTags((prev) => prev.filter((x) => x !== t))} />
                        </Badge>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Start tag</Label>
                  <Input value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} className="font-mono text-xs" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">End tag</Label>
                  <Input value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} className="font-mono text-xs" />
                </div>
              </div>
            )}

            <div className="text-xs text-muted-foreground">
              {rangeResult.error ? <span className="text-destructive">{rangeResult.error}</span>
                : <>{tags.length} box{tags.length === 1 ? "" : "es"} · {totalUnits} {uom || "units"} total.</>}
              {availableTags === null && <span className="ml-1 text-amber-700">(couldn't verify tags against METRC — double-check them)</span>}
              {invalidTags.length > 0 && <span className="ml-1 text-destructive">{invalidTags.length} tag(s) not in your available METRC tags.</span>}
            </div>

            {/* Per-box quantities — each box defaults to "Default units per
                package"; edit any box for a partial fill (2026-08-12). */}
            {tags.length > 0 && !rangeResult.error && (
              <div className="mt-1 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Units per box</span>
                  <span className="text-[11px] text-muted-foreground">Total: {totalUnits} {uom || "units"} across {tags.length} box{tags.length === 1 ? "" : "es"}</span>
                </div>
                <div className="max-h-40 overflow-auto space-y-1 pr-1">
                  {tags.map((t, i) => {
                    const bad = availableTags ? !availableTags.has(t.toUpperCase()) : false;
                    const val = qtyForTag(t);
                    return (
                      <div key={t} className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground w-10 shrink-0">Box {i + 1}</span>
                        <span className={`font-mono text-[10px] flex-1 truncate ${bad ? "text-destructive" : ""}`}>{t}</span>
                        <Input
                          type="number" min="0" step="any"
                          className={`h-7 w-24 text-xs ${!(val > 0) ? "border-destructive" : ""}`}
                          value={tagQty[t] ?? qtyPer}
                          onChange={(e) => setTagQty((p) => ({ ...p, [t]: e.target.value }))}
                        />
                        <span className="text-[10px] text-muted-foreground w-10 shrink-0">{uom || "units"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Repeatable packaging (JIT) — finalize now, or package a portion and
              hold the batch open to label later (e.g. per order). */}
          <div className="space-y-2 rounded-md border p-3">
            <span className="text-sm font-medium">After creating these packages</span>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant={finalize ? "default" : "outline"} onClick={() => setFinalize(true)}>Finalize Production — Close batch (push to In Fulfillment)</Button>
              <Button type="button" size="sm" variant={!finalize ? "default" : "outline"} onClick={() => setFinalize(false)}>Package for an order — stays Bulk — Released</Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {finalize
                ? "Closes the production batch — no more units can be packaged from it. The units move to In Fulfillment."
                : "Keeps the batch in Bulk — Released so you can package more later (per order) and label these units when the order is placed. The packages are still created in METRC now."}
            </p>
          </div>

          {/* Part 11 signature */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Your initials</Label>
              <Input value={initials} onChange={(e) => setInitials(e.target.value)} placeholder="e.g. JS" />
            </div>
            <div className="space-y-1">
              <Label>Signing meaning</Label>
              <Input value={signingMeaning} onChange={(e) => setSigningMeaning(e.target.value)} placeholder="e.g. Confirmed finished goods" />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Note (optional)</Label>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          {success && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 space-y-1">
              <p className="flex items-center gap-2 text-sm font-medium text-emerald-800">
                <CheckCircle2 className="h-4 w-4" />
                {success.recordedOnly ? "Recorded" : "Created"} {success.count} package{success.count === 1 ? "" : "s"} {success.recordedOnly ? "on this batch (METRC already had them)" : "in METRC"} · {batchNumber} {finalize ? "closed — units In Fulfillment" : "packaged — awaiting labels"}.
              </p>
              <p className="text-xs text-emerald-700 font-mono break-all">Finished-goods tags: {success.label}</p>
              {success.metrcIds && success.metrcIds.length > 0 && (
                <p className="text-xs text-emerald-700">METRC package Ids: {success.metrcIds.join(", ")}</p>
              )}
              <p className="text-[11px] text-muted-foreground">Recorded on the batch's METRC tag history. Safe to close.</p>
            </div>
          )}
          {preview != null && !success && (
            <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-[10px]">{JSON.stringify(preview, null, 2)}</pre>
          )}
          {!success && (
            <div className={`flex items-start gap-2 rounded-md border p-2.5 ${recordOnly ? "border-amber-300 bg-amber-50/60" : "border-transparent"}`}>
              <Checkbox id="record-only" checked={recordOnly} onCheckedChange={(v) => setRecordOnly(v === true)} className="mt-0.5" />
              <div className="space-y-0.5">
                <Label htmlFor="record-only" className="text-sm font-normal">METRC already has these packages — record here only</Label>
                <p className="text-[11px] text-muted-foreground">
                  Use this when the packages exist in METRC but never reached this batch. Nothing is created or adjusted in METRC;
                  only the tag history and the batch status are written. Check the tags against METRC before confirming.
                </p>
              </div>
            </div>
          )}
          {error && <p className="flex items-start gap-1 text-sm text-destructive"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{error}</p>}
          {info && <p className="flex items-start gap-1 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />{info}</p>}
        </div>

        <DialogFooter className="gap-2">
          {success ? (
            <Button type="button" onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button type="button" variant="outline" onClick={runPreview} disabled={busy || !canSubmit}>Preview payload</Button>
              <Button type="button" onClick={confirmWrite} disabled={busy || !canSubmit || !initials.trim() || !signingMeaning.trim()}>
                {busy ? "Working…" : recordOnly ? (finalize ? "Finalize & record only" : "Package portion & record only") : (finalize ? "Finalize & push to METRC" : "Package portion & push to METRC")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
