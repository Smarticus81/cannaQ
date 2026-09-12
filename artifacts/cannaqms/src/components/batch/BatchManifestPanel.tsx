import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Truck, CheckCircle2, XCircle, Printer, Plus, ClipboardCheck, Send, Loader2, FlaskConical } from "lucide-react";

// Phases 1c + 2 — outbound manifest builder + guarded Metrc push. Pick the
// batch's LABELED packages, a recipient (any licensed counterparty), a transfer
// type (live Metrc list), a transporter (preset + override) and logistics, save
// the draft, run the pre-flight compliance gate, print the manifest — then push
// it to Metrc as an outgoing transfer TEMPLATE (dry-run preview → Part 11
// sign-off → confirmed write; server-gated by METRC_WRITE_ENABLED).

type LabeledRun = {
  id: number; stageLabel: string; kind: string; metrcTag: string | null;
  rangeStart: string | null; rangeEnd: string | null; quantity: string | null; uom: string | null;
  labelStatus?: string | null;
};
type Recipient = { id: number; name: string; licenseNumber: string; licenseType: string };
type Preset = {
  id: number; label: string; transporterFacilityLicenseNumber: string;
  driverName: string | null; driverOccupationalLicenseNumber: string | null; driverLicenseNumber: string | null;
  phoneNumberForQuestions: string | null; vehicleMake: string | null; vehicleModel: string | null; vehicleLicensePlateNumber: string | null;
};
type TransferType = { Name: string; ForLicensedShipments: boolean; RequiresDestinationGrossWeight?: boolean };
type PreflightCheck = { key: string; label: string; pass: boolean; detail?: string };
type PreflightResult = { allPass: boolean; status: string; checks: PreflightCheck[]; packages: { packageLabel: string; hasTag: boolean; labeled: boolean }[] };

const j = async (url: string) => { const r = await fetch(url, { credentials: "include" }); if (!r.ok) return null; return r.json().catch(() => null); };
const tagOf = (r: LabeledRun) => r.kind === "range" ? `${r.rangeStart ?? ""}${r.rangeEnd ? ` – ${r.rangeEnd}` : ""}` : (r.metrcTag ?? "");
const labelTag = (r: LabeledRun) => (r.kind === "range" ? r.rangeStart : r.metrcTag) ?? "";

// Expand a METRC tag range (start..end) into its individual package tag labels.
function expandRange(startRaw: string, endRaw: string): string[] {
  const S = (startRaw ?? "").trim().toUpperCase();
  const E = (endRaw ?? "").trim().toUpperCase();
  const m1 = S.match(/^(.*?)(\d+)$/); const m2 = E.match(/^(.*?)(\d+)$/);
  if (!m1 || !m2 || m1[1] !== m2[1]) return S ? [S] : [];
  let a = parseInt(m1[2], 10), b = parseInt(m2[2], 10);
  if (a > b) { const t = a; a = b; b = t; }
  const width = m1[2].length; const out: string[] = [];
  for (let i = a; i <= b && out.length < 1000; i++) out.push(m1[1] + String(i).padStart(width, "0"));
  return out;
}
// Distribute a run's total quantity across n packages: floor each, spread the
// remainder onto the first packages (e.g. 99 across 5 → 20,20,20,20,19). A
// DEFAULT only — each package quantity stays editable. (2026-08-12)
function distribute(total: number, n: number): number[] {
  if (!(n > 0)) return [];
  if (!Number.isFinite(total) || total <= 0) return Array(n).fill(0);
  const base = Math.floor(total / n); let rem = total - base * n;
  return Array.from({ length: n }, () => { const q = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--; return q; });
}
// One shippable METRC package (one tag) expanded from a labeled run.
type PkgUnit = { key: string; runId: number; tag: string; itemName: string; uom: string | null; defaultQty: number };

export function BatchManifestPanel({ batchId, batchNumber, productType }: { batchId: number; batchNumber?: string; productType?: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: runs } = useQuery<LabeledRun[]>({
    queryKey: [`/api/batch-records/${batchId}/metrc-tags`, "labeled"],
    queryFn: async () => { const d = await j(`/api/batch-records/${batchId}/metrc-tags`); return Array.isArray(d) ? d.filter((t: LabeledRun) => (t.labelStatus ?? "labeled") === "labeled") : []; },
    enabled: batchId > 0,
  });
  const { data: manifestData } = useQuery<{ manifest: Record<string, unknown> | null; packages: Record<string, unknown>[] }>({
    queryKey: [`/api/batch-records/${batchId}/manifest`],
    queryFn: async () => (await j(`/api/batch-records/${batchId}/manifest`)) ?? { manifest: null, packages: [] },
    enabled: batchId > 0,
  });
  const { data: recipients } = useQuery<Recipient[]>({
    queryKey: ["/api/manifest-recipients"],
    queryFn: async () => (await j(`/api/manifest-recipients`)) ?? [],
  });
  const { data: presets } = useQuery<Preset[]>({
    queryKey: ["/api/transporter-presets"],
    queryFn: async () => (await j(`/api/transporter-presets`)) ?? [],
  });
  // 2026-09-08 — this used the shared j() helper, which turns ANY failed
  // response into null and then into an empty list, so a 403 or a Metrc outage
  // looked exactly like "this facility has no transfer types": an empty dropdown
  // and no message. It now throws so the form can say what went wrong.
  const { data: transferTypes, isError: typesFailed, error: typesError } = useQuery<TransferType[]>({
    queryKey: ["/api/metrc/transfers/types", "licensed"],
    retry: false,
    queryFn: async () => {
      const r = await fetch(`/api/metrc/transfers/types`, { credentials: "include" });
      if (!r.ok) {
        throw new Error(r.status === 403
          ? "You are not permitted to read Metrc transfer types."
          : `Could not load transfer types from Metrc (HTTP ${r.status}).`);
      }
      const d = await r.json().catch(() => null);
      const arr = d?.data?.Data ?? d?.Data ?? [];
      return Array.isArray(arr) ? arr.filter((t: TransferType) => t.ForLicensedShipments) : [];
    },
  });

  const [form, setForm] = useState({
    recipientId: "", transferTypeName: "", transporterFacilityLicenseNumber: "", driverName: "",
    driverOccupationalLicenseNumber: "", driverLicenseNumber: "", vehicleMake: "", vehicleModel: "",
    vehicleLicensePlateNumber: "", phoneNumberForQuestions: "", plannedRoute: "",
    estimatedDepartureDateTime: "", estimatedArrivalDateTime: "", grossWeight: "", grossUnitOfWeightName: "Grams",
  });
  const set = (k: keyof typeof form, v: string) => { setDirty(true); setForm((f) => ({ ...f, [k]: v })); };
  // Per-PACKAGE selection, keyed by METRC tag. Each labeled run expands into its
  // individual package tags so a single package can be shipped. (2026-08-12)
  // Session 110 — a package is only selected once its `scan` value exactly
  // matches its tag (hard gate): you must scan/type the METRC number of the
  // package you're shipping, so you can't click one and ship another.
  const [selPkg, setSelPkg] = useState<Record<string, { on: boolean; quantity: string; grossWeight: string; wholesalePrice: string; scan: string }>>({});
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  // 2026-09-09 (Jonathan) — an edit made after the last save used to be dropped
  // in silence: Push posts only the signature and the SERVER ships the stored
  // draft, so a corrected phone number never left the browser. Any change now
  // marks the form dirty, which withdraws a passed pre-flight until it is run
  // again — nothing can be pushed to Metrc that was not checked as it stands.
  const [dirty, setDirty] = useState(false);
  const [sandboxLabPassing, setSandboxLabPassing] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetLabel, setPresetLabel] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);

  // Hydrate from an existing draft once loaded.
  useEffect(() => {
    const m = manifestData?.manifest;
    if (!m) return;
    // 2026-09-09 (Jonathan) — "transporter info is in there upon opening. Should
    // be blank." The transporter, driver and vehicle belong to ONE shipment, not
    // to the batch, so a DRAFT no longer carries the last run's crew forward and
    // deleting the package rows does not clear them either (they live on the
    // manifest row, not on the packages). Use a saved preset to fill them in.
    // A manifest already pushed is a RECORD and must still show what was sent,
    // so that one hydrates in full.
    const isRecord = ["pushed", "accepted", "manifested"].includes(String(m.status ?? ""));
    const crew = (v: unknown): string => (isRecord ? ((v as string | null) ?? "") : "");
    setForm((f) => ({
      ...f,
      recipientId: m.recipientId != null ? String(m.recipientId) : f.recipientId,
      transferTypeName: (m.transferTypeName as string) ?? f.transferTypeName,
      transporterFacilityLicenseNumber: crew(m.transporterFacilityLicenseNumber),
      driverName: crew(m.driverName),
      driverOccupationalLicenseNumber: crew(m.driverOccupationalLicenseNumber),
      driverLicenseNumber: crew(m.driverLicenseNumber),
      vehicleMake: crew(m.vehicleMake),
      vehicleModel: crew(m.vehicleModel),
      vehicleLicensePlateNumber: crew(m.vehicleLicensePlateNumber),
      phoneNumberForQuestions: crew(m.phoneNumberForQuestions),
      plannedRoute: (m.plannedRoute as string) ?? "",
      grossWeight: m.grossWeight != null ? String(m.grossWeight) : "",
      grossUnitOfWeightName: (m.grossUnitOfWeightName as string) ?? "Grams",
    }));
    const byTag: Record<string, { on: boolean; quantity: string; grossWeight: string; wholesalePrice: string; scan: string }> = {};
    for (const p of (manifestData?.packages ?? [])) {
      const label = String((p.packageLabel as string) ?? "").trim().toUpperCase();
      // scan is pre-filled with the saved tag so an already-committed package
      // shows verified on reload (it was scan-confirmed when first added).
      if (label) byTag[label] = { on: true, quantity: p.quantity != null ? String(p.quantity) : "", grossWeight: p.grossWeight != null ? String(p.grossWeight) : "", wholesalePrice: p.wholesalePrice != null ? String(p.wholesalePrice) : "", scan: label };
    }
    if (Object.keys(byTag).length) setSelPkg((prev) => ({ ...byTag, ...prev }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestData?.manifest?.id]);

  const selectedType = (transferTypes ?? []).find((t) => t.Name === form.transferTypeName);
  const isPriced = /wholesale/i.test(form.transferTypeName);
  const status = (manifestData?.manifest?.status as string) ?? "none";
  const pushed = status === "pushed" || status === "accepted" || status === "manifested";

  const applyPreset = (id: string) => {
    const p = (presets ?? []).find((x) => String(x.id) === id);
    if (!p) return;
    setForm((f) => ({
      ...f,
      transporterFacilityLicenseNumber: p.transporterFacilityLicenseNumber ?? "",
      driverName: p.driverName ?? "", driverOccupationalLicenseNumber: p.driverOccupationalLicenseNumber ?? "",
      driverLicenseNumber: p.driverLicenseNumber ?? "", phoneNumberForQuestions: p.phoneNumberForQuestions ?? "",
      vehicleMake: p.vehicleMake ?? "", vehicleModel: p.vehicleModel ?? "", vehicleLicensePlateNumber: p.vehicleLicensePlateNumber ?? "",
    }));
  };

  // 2026-09-09 (Jonathan) — POST/PUT /transporter-presets existed from the day
  // presets were built, but no button ever called them, so the only presets that
  // could exist were rows put in by hand. This is that button.
  const savePreset = async () => {
    const label = presetLabel.trim();
    if (!label) {
      toast({ title: "Name the preset", description: "Give it a name you will recognise later.", variant: "destructive" });
      return;
    }
    if (!form.transporterFacilityLicenseNumber.trim()) {
      toast({ title: "Transporter licence required", description: "Fill in the transporter facility licence number before saving a preset.", variant: "destructive" });
      return;
    }
    setSavingPreset(true);
    try {
      const res = await fetch(`/api/transporter-presets`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          label,
          transporterFacilityLicenseNumber: form.transporterFacilityLicenseNumber,
          driverName: form.driverName || null,
          driverOccupationalLicenseNumber: form.driverOccupationalLicenseNumber || null,
          driverLicenseNumber: form.driverLicenseNumber || null,
          phoneNumberForQuestions: form.phoneNumberForQuestions || null,
          vehicleMake: form.vehicleMake || null,
          vehicleModel: form.vehicleModel || null,
          vehicleLicensePlateNumber: form.vehicleLicensePlateNumber || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to save the preset.");
      setPresetOpen(false);
      setPresetLabel("");
      await qc.invalidateQueries({ queryKey: ["/api/transporter-presets"] });
      toast({ title: "Preset saved", description: `"${label}" can now be applied to any manifest.` });
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setSavingPreset(false);
    }
  };

  // Expand every labeled run into its individual package tags (one shippable
  // METRC package each), with a default quantity distributed from the run total.
  // Explicitly-recorded single tags (the child packages entered on the Packaging
  // tab) are authoritative and carry their exact quantity; a range's child tag is
  // skipped when a single already covers it, so the manual per-box quantities win
  // over the range estimate. (Session 110)
  const expandedUnits = useMemo<PkgUnit[]>(() => {
    const singleKeys = new Set<string>();
    const singles: PkgUnit[] = [];
    for (const r of (runs ?? [])) {
      if (r.kind !== "range" && (r.metrcTag ?? "").trim()) {
        const tag = (r.metrcTag ?? "").trim();
        const key = tag.toUpperCase();
        if (singleKeys.has(key)) continue;
        singleKeys.add(key);
        singles.push({ key, runId: r.id, tag, itemName: r.stageLabel, uom: r.uom, defaultQty: Number(r.quantity ?? 0) });
      }
    }
    const ranges: PkgUnit[] = [];
    for (const r of (runs ?? [])) {
      if (r.kind === "range" && r.rangeStart) {
        const tags = expandRange(r.rangeStart, r.rangeEnd ?? r.rangeStart);
        const qtys = distribute(Number(r.quantity ?? 0), tags.length || 1);
        tags.forEach((tag, i) => {
          const key = tag.toUpperCase();
          if (singleKeys.has(key)) return; // an explicit single overrides this range child
          ranges.push({ key, runId: r.id, tag, itemName: r.stageLabel, uom: r.uom, defaultQty: qtys[i] ?? 0 });
        });
      }
    }
    return [...singles, ...ranges];
  }, [runs]);

  const norm = (v: string): string => (v ?? "").trim().toUpperCase();
  const unitQty = (u: PkgUnit): number => {
    const raw = selPkg[u.key]?.quantity;
    const v = raw !== undefined && raw !== "" ? Number(raw) : u.defaultQty;
    return Number.isFinite(v) ? v : NaN;
  };
  // Hard gate — a package counts as selected only when its scanned/typed value
  // exactly matches its own METRC tag. No bulk "select all": every package must
  // be scan-confirmed individually.
  const isVerified = (u: PkgUnit): boolean => { const sc = norm(selPkg[u.key]?.scan ?? ""); return sc !== "" && sc === norm(u.tag); };
  const selectedUnits = expandedUnits.filter((u) => isVerified(u));
  const selectedTotal = selectedUnits.reduce((s, u) => { const q = unitQty(u); return s + (q > 0 ? q : 0); }, 0);

  // Group shippable packages by item/stage for display — the child packages
  // recorded from one bulk package share a single header. (Session 110)
  const packageGroups = useMemo<Array<[string, PkgUnit[]]>>(() => {
    const m = new Map<string, PkgUnit[]>();
    for (const u of expandedUnits) {
      const k = u.itemName || "Packages";
      const arr = m.get(k); if (arr) arr.push(u); else m.set(k, [u]);
    }
    return Array.from(m.entries());
  }, [expandedUnits]);

  const buildPackages = () => selectedUnits.map((u) => ({
    packageLabel: u.tag, itemName: u.itemName, quantity: String(unitQty(u)), uom: u.uom,
    grossWeight: selPkg[u.key]?.grossWeight || null, grossUnitOfWeightName: form.grossUnitOfWeightName,
    wholesalePrice: isPriced ? (selPkg[u.key]?.wholesalePrice || null) : null, sourceTagRunId: u.runId,
  }));

  const recipient = (recipients ?? []).find((x) => String(x.id) === form.recipientId);

  const saveDraft = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/batch-records/${batchId}/manifest`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          transferTypeName: form.transferTypeName || null,
          recipientId: form.recipientId || null,
          recipientLicenseNumber: recipient?.licenseNumber ?? null,
          recipientName: recipient?.name ?? null,
          plannedRoute: form.plannedRoute || null,
          estimatedDepartureDateTime: form.estimatedDepartureDateTime || null,
          estimatedArrivalDateTime: form.estimatedArrivalDateTime || null,
          transporterFacilityLicenseNumber: form.transporterFacilityLicenseNumber || null,
          driverName: form.driverName || null, driverOccupationalLicenseNumber: form.driverOccupationalLicenseNumber || null,
          driverLicenseNumber: form.driverLicenseNumber || null, vehicleMake: form.vehicleMake || null,
          vehicleModel: form.vehicleModel || null, vehicleLicensePlateNumber: form.vehicleLicensePlateNumber || null,
          phoneNumberForQuestions: form.phoneNumberForQuestions || null,
          grossWeight: form.grossWeight || null, grossUnitOfWeightName: form.grossUnitOfWeightName || null,
          packages: buildPackages(),
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to save manifest.");
      setDirty(false);
      setPreflight(null);
      await qc.invalidateQueries({ queryKey: [`/api/batch-records/${batchId}/manifest`] });
      toast({ title: "Manifest saved", description: "Draft manifest saved. Run pre-flight before shipping." });
    } catch (e) { toast({ title: "Save failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
    finally { setSaving(false); }
  };

  const runPreflight = async () => {
    setChecking(true);
    try {
      await saveDraft();
      const res = await fetch(`/api/batch-records/${batchId}/manifest/preflight`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: "{}" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Pre-flight failed.");
      setPreflight(data as PreflightResult);
      await qc.invalidateQueries({ queryKey: [`/api/batch-records/${batchId}/manifest`] });
    } catch (e) { toast({ title: "Pre-flight failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
    finally { setChecking(false); }
  };

  const sandboxLabPass = async () => {
    const tags = selectedUnits.map((u) => u.tag);
    if (tags.length === 0) {
      toast({ title: "No packages selected", description: "Scan and verify at least one package before filing a sandbox lab pass.", variant: "destructive" });
      return;
    }
    setSandboxLabPassing(true);
    try {
      const params = new URLSearchParams({ labels: tags.join(","), confirm: "true" });
      const res = await fetch(`/api/metrc/sandbox/lab-pass?${params}`, { credentials: "include" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Sandbox lab pass failed (HTTP ${res.status}).`);
      toast({ title: "Sandbox lab pass filed", description: `${tags.length} package${tags.length === 1 ? "" : "s"} marked TestPassed in METRC. Running pre-flight…` });
      await runPreflight();
    } catch (e) {
      toast({ title: "Sandbox lab pass failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setSandboxLabPassing(false);
    }
  };

  const printManifest = () => {
    const rows = selectedUnits.map((u) => `<tr><td>${u.tag}</td><td>${u.itemName}</td><td>${unitQty(u)} ${u.uom ?? ""}</td><td>${selPkg[u.key]?.grossWeight ?? ""} ${form.grossUnitOfWeightName}</td><td>${isPriced ? (selPkg[u.key]?.wholesalePrice ?? "") : "—"}</td></tr>`).join("");
    const html = `<!doctype html><html><head><title>Manifest — ${batchNumber ?? batchId}</title>
      <style>body{font:13px system-ui,Arial;margin:28px;color:#111} h1{font-size:18px} h2{font-size:13px;margin:16px 0 4px;text-transform:uppercase;color:#555;border-bottom:1px solid #ccc;padding-bottom:2px} table{width:100%;border-collapse:collapse;margin-top:6px} td,th{border:1px solid #bbb;padding:4px 6px;text-align:left;font-size:12px} .g{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px} .k{color:#666}</style></head><body>
      <h1>Outbound Transfer Manifest (DRAFT)</h1>
      <div class="k">Batch ${batchNumber ?? batchId}${productType ? ` — ${productType}` : ""} · Transfer type: ${form.transferTypeName || "—"}</div>
      <h2>Recipient</h2><div class="g"><div><span class="k">Name:</span> ${recipient?.name ?? "—"}</div><div><span class="k">License:</span> ${recipient?.licenseNumber ?? "—"}</div></div>
      <h2>Transport</h2><div class="g">
        <div><span class="k">Transporter license:</span> ${form.transporterFacilityLicenseNumber || "—"}</div>
        <div><span class="k">Driver:</span> ${form.driverName || "—"}</div>
        <div><span class="k">Driver license #:</span> ${form.driverLicenseNumber || "—"}</div>
        <div><span class="k">Occupational license #:</span> ${form.driverOccupationalLicenseNumber || "—"}</div>
        <div><span class="k">Vehicle:</span> ${[form.vehicleMake, form.vehicleModel].filter(Boolean).join(" ") || "—"}</div>
        <div><span class="k">Plate:</span> ${form.vehicleLicensePlateNumber || "—"}</div>
        <div><span class="k">Departure:</span> ${form.estimatedDepartureDateTime || "—"}</div>
        <div><span class="k">Arrival:</span> ${form.estimatedArrivalDateTime || "—"}</div>
        <div><span class="k">Planned route:</span> ${form.plannedRoute || "—"}</div>
        <div><span class="k">Destination gross weight:</span> ${form.grossWeight || "—"} ${form.grossUnitOfWeightName}</div>
      </div>
      <h2>Packages (${selectedUnits.length})</h2>
      <table><thead><tr><th>Metrc tag</th><th>Item</th><th>Qty</th><th>Gross wt</th><th>Wholesale $</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No packages selected</td></tr>'}</tbody></table>
      <p class="k" style="margin-top:18px">Michigan CRA R 420.504 label + R 420.502 tracking. Printed copy must accompany the shipment. This is a CannaQMS draft; the Metrc manifest is created on push.</p>
      </body></html>`;
    const w = window.open("", "_blank");
    if (!w) { toast({ title: "Popup blocked", description: "Allow popups to print the manifest.", variant: "destructive" }); return; }
    w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
  };

  const statusBadge = useMemo(() => {
    if (status === "preflight_passed") return <Badge className="bg-emerald-600">Pre-flight passed</Badge>;
    if (status === "manifested") return <Badge className="bg-blue-700">Manifest registered</Badge>;
    if (pushed) return <Badge className="bg-blue-600">Pushed to Metrc</Badge>;
    if (status === "draft") return <Badge variant="secondary">Draft</Badge>;
    return <Badge variant="outline">Not started</Badge>;
  }, [status, pushed]);

  return (
    <Card className="mt-4">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-1.5"><Truck className="h-4 w-4" /> Outbound Manifest / Transfer</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">Ship labeled packages to a licensed recipient (retailer or processor). Save → pre-flight → push to Metrc as a transfer template.</p>
          </div>
          {statusBadge}
        </div>
      </CardHeader>
      <CardContent className="space-y-5 print:hidden">
        {/* Packages — scan-gated (Session 110). A package is only added to the
            shipment once its METRC number is scanned/typed and matches the row's
            tag, so the wrong package can't be shipped. */}
        <div>
          <p className="text-sm font-medium mb-1">Packages to ship</p>
          <p className="text-xs text-muted-foreground mb-2">Scan or type each package's METRC number to confirm it. A package is only added once its scan exactly matches its tag — you can't select one number and ship a different one.</p>
          {expandedUnits.length === 0 ? (
            <p className="text-sm text-muted-foreground">No packages on this batch yet. Record the child packages on the <strong>Packaging</strong> tab (or label units via Label &amp; Finalize).</p>
          ) : (
            <div className="rounded-md border divide-y">
              {packageGroups.map(([label, units]) => {
                if (units.length === 0) return null;
                const groupTotal = units.reduce((sum, u) => { const q = unitQty(u); return sum + (q > 0 ? q : 0); }, 0);
                return (
                  <div key={label} className="p-2 space-y-1.5">
                    <p className="text-xs font-medium truncate">
                      {label}
                      <span className="text-muted-foreground font-normal">{` · ${groupTotal} ${units[0]?.uom ?? "units"} across ${units.length} package${units.length === 1 ? "" : "s"}`}</span>
                    </p>
                    <div className="space-y-1.5">
                      {units.map((u, i) => {
                        const st = selPkg[u.key];
                        const scanVal = st?.scan ?? "";
                        const verified = isVerified(u);
                        const mismatch = norm(scanVal) !== "" && !verified;
                        return (
                          <div key={u.key} className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="text-[10px] text-muted-foreground w-11 shrink-0">Pkg {i + 1}</span>
                            <span className="font-mono text-[11px] w-40 shrink-0 truncate" title={u.tag}>{u.tag}</span>
                            <Input
                              className={`h-8 w-48 text-xs font-mono ${verified ? "border-emerald-500 focus-visible:ring-emerald-500" : mismatch ? "border-destructive focus-visible:ring-destructive" : ""}`}
                              placeholder="Scan / type tag to confirm"
                              disabled={pushed}
                              value={scanVal}
                              onChange={(e) => { setDirty(true); setSelPkg((s) => ({ ...s, [u.key]: { on: false, quantity: s[u.key]?.quantity ?? String(u.defaultQty), grossWeight: s[u.key]?.grossWeight ?? "", wholesalePrice: s[u.key]?.wholesalePrice ?? "", scan: e.target.value } })); }}
                            />
                            {verified ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" /> : mismatch ? <XCircle className="h-4 w-4 text-destructive shrink-0" /> : <span className="w-4 shrink-0" />}
                            <Input
                              type="number" min="0" step="any"
                              className="h-8 w-20 text-xs"
                              placeholder="Qty"
                              disabled={pushed || !verified}
                              value={st?.quantity ?? String(u.defaultQty)}
                              onChange={(e) => { setDirty(true); setSelPkg((s) => ({ ...s, [u.key]: { on: s[u.key]?.on ?? false, quantity: e.target.value, grossWeight: s[u.key]?.grossWeight ?? "", wholesalePrice: s[u.key]?.wholesalePrice ?? "", scan: s[u.key]?.scan ?? "" } })); }}
                            />
                            <span className="text-[10px] text-muted-foreground w-10 shrink-0">{u.uom || "units"}</span>
                            {isPriced && verified && (
                              <Input className="h-8 w-24 text-xs" placeholder="Wholesale $" disabled={pushed} value={st?.wholesalePrice ?? ""} onChange={(e) => { setDirty(true); setSelPkg((s) => ({ ...s, [u.key]: { on: s[u.key]?.on ?? false, quantity: s[u.key]?.quantity ?? String(u.defaultQty), grossWeight: s[u.key]?.grossWeight ?? "", wholesalePrice: e.target.value, scan: s[u.key]?.scan ?? "" } })); }} />
                            )}
                            {mismatch && <span className="text-[10px] text-destructive basis-full pl-11">That number doesn't match this package's tag.</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              <div className="p-2 text-[11px] text-muted-foreground">
                Selected: <span className="font-medium text-foreground">{selectedUnits.length}</span> scan-verified package{selectedUnits.length === 1 ? "" : "s"} · {selectedTotal} units
              </div>
            </div>
          )}
        </div>

        {/* Recipient + transfer type */}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Recipient (licensed)</Label>
            <div className="flex gap-2">
              <Select value={form.recipientId} onValueChange={(v) => set("recipientId", v)} disabled={pushed}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select a recipient…" /></SelectTrigger>
                <SelectContent>
                  {(recipients ?? []).map((r) => <SelectItem key={r.id} value={String(r.id)}>{r.name} — {r.licenseNumber} ({r.licenseType})</SelectItem>)}
                </SelectContent>
              </Select>
              <AddRecipientDialog onadded={(id) => { qc.invalidateQueries({ queryKey: ["/api/manifest-recipients"] }); set("recipientId", String(id)); }} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Transfer type</Label>
            <Select value={form.transferTypeName} onValueChange={(v) => set("transferTypeName", v)} disabled={pushed}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select transfer type…" /></SelectTrigger>
              <SelectContent>
                {(transferTypes ?? []).map((t) => <SelectItem key={t.Name} value={t.Name}>{t.Name}</SelectItem>)}
              </SelectContent>
            </Select>
            {typesFailed && (
              <p className="text-[11px] text-destructive">
                {(typesError as Error)?.message ?? "Could not load transfer types from Metrc."}
              </p>
            )}
            {!typesFailed && (transferTypes?.length ?? 0) === 0 && (
              <p className="text-[11px] text-amber-700">Metrc returned no licensed transfer types for this facility.</p>
            )}
            {selectedType?.RequiresDestinationGrossWeight && <p className="text-[11px] text-muted-foreground">This type requires a destination gross weight.</p>}
          </div>
        </div>

        {/* Transporter */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm font-medium">Transporter, driver &amp; vehicle</p>
            <div className="flex items-center gap-2">
              {(presets ?? []).length > 0 && (
                <Select onValueChange={applyPreset} disabled={pushed}>
                  <SelectTrigger className="h-8 w-56 text-xs"><SelectValue placeholder="Apply a saved preset…" /></SelectTrigger>
                  <SelectContent>{(presets ?? []).map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.label}</SelectItem>)}</SelectContent>
                </Select>
              )}
              <Dialog open={presetOpen} onOpenChange={setPresetOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline" className="h-8 text-xs" disabled={pushed}>
                    <Plus className="h-3.5 w-3.5 mr-1" />Save as preset
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader><DialogTitle>Save this transporter as a preset</DialogTitle></DialogHeader>
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Saves the transporter licence, driver and vehicle exactly as typed above so they can be applied to a later manifest.
                      Requires Supervisor, Manager, Quality or Admin.
                    </p>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Preset name</Label>
                      <Input className="h-9" value={presetLabel} onChange={(e) => setPresetLabel(e.target.value)} placeholder="e.g. Green Line Transport — Dave" />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => setPresetOpen(false)}>Cancel</Button>
                      <Button onClick={savePreset} disabled={savingPreset}>
                        {savingPreset ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</> : "Save preset"}
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Transporter facility license #" v={form.transporterFacilityLicenseNumber} on={(x) => set("transporterFacilityLicenseNumber", x)} disabled={pushed} />
            <Field label="Driver name" v={form.driverName} on={(x) => set("driverName", x)} disabled={pushed} />
            <Field label="Driver license #" v={form.driverLicenseNumber} on={(x) => set("driverLicenseNumber", x)} disabled={pushed} />
            <Field label="Occupational license #" v={form.driverOccupationalLicenseNumber} on={(x) => set("driverOccupationalLicenseNumber", x)} disabled={pushed} />
            <Field label="Vehicle make" v={form.vehicleMake} on={(x) => set("vehicleMake", x)} disabled={pushed} />
            <Field label="Vehicle model" v={form.vehicleModel} on={(x) => set("vehicleModel", x)} disabled={pushed} />
            <Field label="License plate" v={form.vehicleLicensePlateNumber} on={(x) => set("vehicleLicensePlateNumber", x)} disabled={pushed} />
            <Field label="Phone for questions" v={form.phoneNumberForQuestions} on={(x) => set("phoneNumberForQuestions", x)} disabled={pushed} />
          </div>
        </div>

        {/* Logistics */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Est. departure" type="datetime-local" v={form.estimatedDepartureDateTime} on={(x) => set("estimatedDepartureDateTime", x)} disabled={pushed} />
          <Field label="Est. arrival" type="datetime-local" v={form.estimatedArrivalDateTime} on={(x) => set("estimatedArrivalDateTime", x)} disabled={pushed} />
          <div className="space-y-1.5">
            <Label className="text-xs">Destination gross weight</Label>
            <div className="flex gap-2">
              <Input className="h-9" value={form.grossWeight} onChange={(e) => set("grossWeight", e.target.value)} disabled={pushed} />
              <Input className="h-9 w-24" value={form.grossUnitOfWeightName} onChange={(e) => set("grossUnitOfWeightName", e.target.value)} disabled={pushed} />
            </div>
          </div>
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label className="text-xs">Planned route</Label>
            <Textarea rows={2} value={form.plannedRoute} onChange={(e) => set("plannedRoute", e.target.value)} disabled={pushed} />
          </div>
        </div>

        <Separator />

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <Button onClick={saveDraft} disabled={saving || pushed} variant="outline"><ClipboardCheck className="h-4 w-4 mr-2" />{saving ? "Saving…" : "Save draft"}</Button>
          <Button onClick={runPreflight} disabled={checking || pushed}><CheckCircle2 className="h-4 w-4 mr-2" />{checking ? "Checking…" : "Save & run pre-flight"}</Button>
          <Button onClick={printManifest} variant="outline"><Printer className="h-4 w-4 mr-2" />Print manifest</Button>
          <Button onClick={sandboxLabPass} disabled={sandboxLabPassing || pushed || selectedUnits.length === 0} variant="outline" title="SANDBOX ONLY — files passing lab results in METRC so packages advance to TestPassed. Remove before production.">{sandboxLabPassing ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Filing…</> : <><FlaskConical className="h-4 w-4 mr-2" />Sandbox: File lab pass</>}</Button>
          {status === "preflight_passed" && !pushed && !dirty && (
            <PushToMetrcDialog
              batchId={batchId}
              summary={{
                recipientName: recipient?.name ?? (manifestData?.manifest?.recipientName as string | undefined),
                recipientLicense: recipient?.licenseNumber ?? (manifestData?.manifest?.recipientLicenseNumber as string | undefined),
                transferType: form.transferTypeName,
                packageCount: selectedUnits.length,
                grossWeight: `${form.grossWeight || "—"} ${form.grossUnitOfWeightName}`,
              }}
              onPushed={async () => {
                setPreflight(null);
                await qc.invalidateQueries({ queryKey: [`/api/batch-records/${batchId}/manifest`] });
              }}
            />
          )}
          {dirty && !pushed && (
            <p className="text-xs text-amber-700 self-center">
              Changed since the last check — run "Save &amp; run pre-flight" again before pushing.
            </p>
          )}
        </div>

        {/* Pushed record */}
        {pushed && (
          <div className="rounded-md border border-blue-300 bg-blue-50/50 p-3 text-sm space-y-0.5">
            <p className="font-medium flex items-center gap-1.5"><Send className="h-4 w-4 text-blue-600" /> Pushed to Metrc as an outgoing transfer template.</p>
            <p className="text-muted-foreground">
              {manifestData?.manifest?.metrcTemplateId != null && <>Metrc template #{String(manifestData.manifest.metrcTemplateId)} · </>}
              {manifestData?.manifest?.pushedAt != null && <>{new Date(String(manifestData.manifest.pushedAt)).toLocaleString()} · </>}
              {manifestData?.manifest?.signedByName != null && <>signed by {String(manifestData.manifest.signedByName)} ({String(manifestData.manifest.signedInitials ?? "")})</>}
            </p>
            {manifestData?.manifest?.metrcManifestNumber ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="font-medium">METRC manifest #{String(manifestData.manifest.metrcManifestNumber)}</span>
                <Button size="sm" onClick={() => window.open(`/api/batch-records/${batchId}/manifest/pdf`, "_blank")}>
                  <Printer className="h-4 w-4 mr-2" />Print METRC manifest
                </Button>
              </div>
            ) : (
              <div className="space-y-1.5 pt-1">
                <p className="text-xs text-muted-foreground">Final step in METRC: open Transfers → Templates, review this template, and register the transfer. Then capture its manifest number here to print the official METRC manifest.</p>
                <CaptureManifestDialog batchId={batchId} onCaptured={async () => { await qc.invalidateQueries({ queryKey: [`/api/batch-records/${batchId}/manifest`] }); }} />
              </div>
            )}
          </div>
        )}

        {/* Pre-flight results */}
        {preflight && (
          <div className={`rounded-md border p-3 space-y-2 ${preflight.allPass ? "border-emerald-300 bg-emerald-50/50" : "border-amber-300 bg-amber-50/40"}`}>
            <p className="text-sm font-medium flex items-center gap-1.5">
              {preflight.allPass ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-amber-600" />}
              {preflight.allPass ? "Pre-flight passed — ready to push to Metrc (button above)." : "Pre-flight blocked — resolve the items below."}
            </p>
            <ul className="space-y-1">
              {preflight.checks.map((c) => (
                <li key={c.key} className="flex items-start gap-2 text-sm">
                  {c.pass ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 mt-0.5 shrink-0" /> : <XCircle className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />}
                  <span className={c.pass ? "text-muted-foreground" : "font-medium"}>{c.label}{c.detail ? ` — ${c.detail}` : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, v, on, disabled, type }: { label: string; v: string; on: (x: string) => void; disabled?: boolean; type?: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Input className="h-9" type={type} value={v} onChange={(e) => on(e.target.value)} disabled={disabled} />
    </div>
  );
}

// Phase 2 — the guarded push. Opens with a server-built DRY-RUN preview of the
// exact Metrc payload (no write), then requires Part 11 initials + meaning and
// an explicit confirm. The server enforces the same gates again plus
// METRC_WRITE_ENABLED, so this dialog can never fire a write by accident.
function CaptureManifestDialog({ batchId, onCaptured }: { batchId: number; onCaptured: () => Promise<void> | void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [candidates, setCandidates] = useState<Array<{ manifestNumber: string; recipientName: string | null; packageCount: number; suggested: boolean }>>([]);
  const [chosen, setChosen] = useState("");
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadCandidates = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/batch-records/${batchId}/manifest/capture`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: "{}" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) { setError(d.error ?? "Could not reach METRC — you can still enter the manifest number by hand."); setCandidates([]); return; }
      setCandidates(d.candidates ?? []);
      const sug = (d.candidates ?? []).find((c: { suggested: boolean }) => c.suggested);
      if (sug) setChosen(sug.manifestNumber);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  };

  const confirm = async () => {
    const num = (manual.trim() || chosen).trim();
    if (!num) { toast({ title: "Pick or enter a manifest number", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const r = await fetch(`/api/batch-records/${batchId}/manifest/capture`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ manifestNumber: num }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `Capture failed (HTTP ${r.status})`);
      toast({ title: "Manifest number captured", description: `METRC manifest #${num}.` });
      setOpen(false);
      await onCaptured();
    } catch (e) {
      toast({ title: "Capture failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) { setManual(""); setChosen(""); void loadCandidates(); } }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline"><Send className="h-4 w-4 mr-2" />Capture METRC manifest #</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Capture the METRC manifest number</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">After you register the transfer in METRC, pick it below (or type the manifest number). CannaQMS records it so you can print the official METRC manifest here.</p>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading outgoing transfers from METRC…</p>
        ) : (
          <>
            {error && <p className="text-xs text-amber-600">{error}</p>}
            {candidates.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium">Recent outgoing transfers</p>
                <Select value={chosen} onValueChange={setChosen}>
                  <SelectTrigger><SelectValue placeholder="Choose the manifest" /></SelectTrigger>
                  <SelectContent>
                    {candidates.map((c) => (
                      <SelectItem key={c.manifestNumber} value={c.manifestNumber}>
                        #{c.manifestNumber}{c.recipientName ? ` · ${c.recipientName}` : ""} · {c.packageCount} pkg{c.suggested ? " · best match" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <p className="text-xs font-medium">Or enter the manifest number</p>
              <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="e.g. 0000123456" />
            </div>
          </>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={confirm} disabled={saving || loading}>{saving ? "Saving…" : "Capture"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PushToMetrcDialog({ batchId, summary, onPushed }: {
  batchId: number;
  summary: { recipientName?: string; recipientLicense?: string; transferType?: string; packageCount: number; grossWeight?: string };
  onPushed: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [preview, setPreview] = useState<{ wouldSend?: { body?: unknown }; writeEnabled?: boolean } | null>(null);
  const [showPayload, setShowPayload] = useState(false);
  const [initials, setInitials] = useState("");
  const [meaning, setMeaning] = useState("I authorize filing this outbound transfer with Metrc.");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setInitials(""); // Part 11 — the signer types their own initials; never pre-filled.
    setError(null); setPreview(null); setShowPayload(false); setLoading(true);
    fetch(`/api/batch-records/${batchId}/manifest/push`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ dryRun: true }),
    })
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error || "Failed to build the Metrc preview.");
        setPreview(d);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open, batchId]);

  const push = async () => {
    if (!initials.trim() || !meaning.trim()) { setError("Initials and signing meaning are required (21 CFR Part 11)."); return; }
    setPushing(true); setError(null);
    try {
      const r = await fetch(`/api/batch-records/${batchId}/manifest/push`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ confirm: true, initials: initials.trim(), signingMeaning: meaning.trim() }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || "Push failed.");
      if (d?.ok === false) throw new Error(d?.error || "Metrc rejected the template.");
      toast({ title: "Pushed to Metrc", description: d?.metrcTemplateId != null ? `Outgoing transfer template #${d.metrcTemplateId} created.` : "Outgoing transfer template created." });
      setOpen(false);
      await onPushed();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPushing(false); }
  };

  const writeEnabled = preview?.writeEnabled === true;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-blue-600 hover:bg-blue-700"><Send className="h-4 w-4 mr-2" />Push to Metrc</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Push manifest to Metrc</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            This files the manifest in Metrc as an <span className="font-medium">outgoing transfer template</span>.
            The final registration (and manifest number) is completed in the Metrc UI.
          </p>
          <div className="rounded-md border p-3 grid grid-cols-2 gap-x-4 gap-y-1">
            <span className="text-muted-foreground">Recipient</span><span>{summary.recipientName ?? "—"}</span>
            <span className="text-muted-foreground">License</span><span className="font-mono text-xs">{summary.recipientLicense ?? "—"}</span>
            <span className="text-muted-foreground">Transfer type</span><span>{summary.transferType || "—"}</span>
            <span className="text-muted-foreground">Packages</span><span>{summary.packageCount}</span>
            <span className="text-muted-foreground">Dest. gross weight</span><span>{summary.grossWeight ?? "—"}</span>
          </div>

          {loading && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Building Metrc preview…</p>}

          {preview && (
            <>
              {!writeEnabled && (
                <div className="rounded-md border border-amber-300 bg-amber-50/60 p-2.5 text-xs">
                  The Metrc write switch is <span className="font-medium">off</span> (METRC_WRITE_ENABLED). You can review the
                  preview, but the push button stays disabled until the switch is turned on for this environment.
                </div>
              )}
              <Button variant="outline" size="sm" onClick={() => setShowPayload((s) => !s)}>
                {showPayload ? "Hide" : "Show"} exact Metrc payload
              </Button>
              {showPayload && (
                <pre className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 text-[11px] leading-snug">
                  {JSON.stringify(preview.wouldSend?.body ?? preview.wouldSend, null, 2)}
                </pre>
              )}
              <Separator />
              <div className="grid grid-cols-[6rem_1fr] items-center gap-2">
                <Label className="text-xs">Your initials</Label>
                <Input className="h-9" value={initials} onChange={(e) => setInitials(e.target.value)} placeholder="e.g. JS" />
                <Label className="text-xs">Meaning</Label>
                <Input className="h-9" value={meaning} onChange={(e) => setMeaning(e.target.value)} />
              </div>
            </>
          )}

          {error && <p className="text-destructive text-xs whitespace-pre-wrap">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pushing}>Cancel</Button>
            <Button className="bg-blue-600 hover:bg-blue-700" onClick={push} disabled={pushing || loading || !preview || !writeEnabled || !initials.trim() || !meaning.trim()}>
              {pushing ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Pushing…</> : <><Send className="h-4 w-4 mr-2" />Confirm & push</>}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddRecipientDialog({ onadded }: { onadded: (id: number) => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({ name: "", licenseNumber: "", licenseType: "Retailer" });
  const save = async () => {
    if (!f.name.trim() || !f.licenseNumber.trim()) { toast({ title: "Name and license required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/manifest-recipients", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(f) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Failed to add recipient.");
      onadded(data.id); setOpen(false); setF({ name: "", licenseNumber: "", licenseType: "Retailer" });
      toast({ title: "Recipient added" });
    } catch (e) { toast({ title: "Failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline" size="icon" className="h-9 w-9 shrink-0" title="Add recipient"><Plus className="h-4 w-4" /></Button></DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add a licensed recipient</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label className="text-xs">Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="space-y-1.5"><Label className="text-xs">License number</Label><Input value={f.licenseNumber} onChange={(e) => setF({ ...f, licenseNumber: e.target.value })} /></div>
          <div className="space-y-1.5">
            <Label className="text-xs">Type</Label>
            <Select value={f.licenseType} onValueChange={(v) => setF({ ...f, licenseType: v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["Retailer", "Processor", "Grower", "Safety Compliance Facility", "Other"].map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? "Adding…" : "Add"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
