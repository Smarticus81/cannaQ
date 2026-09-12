import { useState, useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getListNonConformancesQueryKey, useGetCurrentUser, useListUsers } from "@workspace/api-client-react";
import { NcSeverityGuide } from "@/components/nc/NcSeverityGuide";

const schema = z.object({
  title: z.string().min(1, "Required"),
  description: z.string().min(1, "Required"),
  severity: z.string().min(1, "Required"),
  source: z.string().min(1, "Required"),
  disposition: z.string().optional(),
  // Session 60 — what the NC is ABOUT, as first observed. Required: it decides
  // which "affected" picker the form shows, and it is the axis the metrics use.
  ncTypeAsFound: z.string().min(1, "Required"),
  // Real references to whatever is affected, carried as strings in the form and
  // coerced to ints on submit (same pattern as reportedByUserId).
  affectedInventoryItemId: z.string().optional(),
  affectedLotId: z.string().optional(),
  affectedDocumentId: z.string().optional(),
  productType: z.string().optional(),
  productName: z.string().optional(),
  lotNumber: z.string().optional(),
  department: z.string().optional(),
  // Session 48.5 — bring standalone NC creation to parity with the in-batch
  // LogNonConformanceDialog. reportedByName auto-fills from currentUser but
  // is fully editable so the QMS owner can record an NC on behalf of another
  // employee. identifiedAt defaults to today; severityRationale optional.
  reportedByName: z.string().optional(),
  // Session 54 — id of the reporting app user (decision B: always internal).
  reportedByUserId: z.string().optional(),
  identifiedAt: z.string().optional(),
  severityRationale: z.string().optional(),
});

const DEPARTMENTS = ["Cultivation", "Processing", "Kitchen", "Extraction", "Packaging", "QA/QC", "Warehouse", "Other"];
import { PRODUCT_TYPES_WITH_OTHER as PRODUCT_TYPES } from "@/lib/productTypes";

// Radix Select refuses an item whose value is the empty string — it reserves ""
// for "nothing selected" — so clearing the field needs a stand-in value that is
// mapped back to "" on the way into the form.
const PRODUCT_TYPE_NONE = "__none__";

// Session 97 (cross-linking Slice 3) — reuse the Complaint dialog's source-batch
// typeahead (/api/metrc-tags/lookup) so an NC can link to a REAL batch (stores the
// batch_id FK the route already allowlists) instead of a free-typed lot number.
// NC carries a single batch_id (not the Complaint's multi-candidate list), so this
// is a single-select link with a free-text fallback for external / third-party lots.
type Candidate = {
  batchId: number; batchNumber: string; productName: string | null;
  strainName: string | null; status: string | null; productionDate: string | null;
  matchKind: string; matchedOn: string[];
};
const matchLabel = (k: string) => (k === "exact" ? "exact tag" : k === "partial" ? "partial tag" : "product match");

// Session 97 (Slice 4) — when Source is a system record, pick the SPECIFIC origin
// (mirrors Field Actions). Stored as source_inspection_id / source_complaint_id FKs.
type InspectionOpt = { id: number; inspectionNumber: string; supplierName: string | null; poManifestNumber: string | null };
// Session 60 — option lists for "what is affected".
type CatalogOpt = { id: number; itemName: string; itemType: string | null; unitOfMeasure: string | null };
type LotOpt = { id: number; lotNumber: string | null; inventoryItemId: number | null; status: string | null };
type DocumentOpt = { id: number; documentNumber?: string | null; title: string; type?: string | null };
type ComplaintOpt = { id: number; complaintNumber: string; description: string | null };

type FormValues = z.infer<typeof schema>;

// Session 76 — the four quality-event create dialogs are now openable from the
// global "New Quality Event" front door, not just their own list-page trigger.
// When `open`/`onOpenChange` are supplied the dialog is controlled by the
// parent and its built-in trigger is hidden; with no props it behaves exactly
// as before (self-managed state + visible "New NC" button). Backward compatible.
type DialogControl = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
};

export function CreateNonConformanceDialog({ open: openProp, onOpenChange, hideTrigger }: DialogControl = {}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => { if (onOpenChange) onOpenChange(v); else setOpenState(v); };
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  // Session 63.3 — route to the record just created instead of leaving the
  // operator on the module's list page with nothing open to fill in.
  const [, setLocation] = useLocation();
  // Session 48.5 — auto-fill reportedByName from the signed-in user.
  const { data: currentUser } = useGetCurrentUser();
  // Session 54 — Reported By is a strict user picker (decision B). Defaults to
  // the signed-in user; saves reportedByUserId + the matching name.
  const { data: usersData = [] } = useListUsers();
  // Session 97 (Slice 3) — source-batch link state.
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [linkedBatch, setLinkedBatch] = useState<{ batchId: number; batchNumber: string; productName: string | null } | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  // Session 97 (Slice 4) — specific source-record link state + option lists.
  const [inspections, setInspections] = useState<InspectionOpt[]>([]);
  const [complaintOpts, setComplaintOpts] = useState<ComplaintOpt[]>([]);
  // Session 60 — affected-scope option lists.
  const [catalogOpts, setCatalogOpts] = useState<CatalogOpt[]>([]);
  const [lotOpts, setLotOpts] = useState<LotOpt[]>([]);
  const [documentOpts, setDocumentOpts] = useState<DocumentOpt[]>([]);
  const [sourceInspectionId, setSourceInspectionId] = useState("");
  const [sourceComplaintId, setSourceComplaintId] = useState("");

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { title: "", description: "", severity: "", source: "", disposition: "", ncTypeAsFound: "", affectedInventoryItemId: "", affectedLotId: "", affectedDocumentId: "", productType: "", productName: "", lotNumber: "", department: "", reportedByName: "", reportedByUserId: "", identifiedAt: "", severityRationale: "" },
  });

  // Session 48.5 — every time the dialog opens, reset to defaults with
  // today's date and the current user's name pre-filled. Reset on close
  // (in onOpenChange) wipes everything; this effect re-seeds the sensible
  // defaults on open.
  useEffect(() => {
    if (open) {
      form.setValue("identifiedAt", new Date().toISOString().slice(0, 10));
      form.setValue("reportedByName", currentUser?.fullName ?? "");
      form.setValue("reportedByUserId", currentUser?.id != null ? String(currentUser.id) : "");
    }
  }, [open, currentUser?.fullName, form]);

  // Session 97 (Slice 3) — debounced source-batch lookup, fired from the Lot or
  // Product field (whichever the operator fills), at >=3 chars. Mirrors the
  // Complaint dialog's typeahead so the two forms behave identically.
  const lotValue = form.watch("lotNumber");
  const productValue = form.watch("productName");
  const searchTerm = ((lotValue ?? "").trim() || (productValue ?? "").trim());
  useEffect(() => {
    // Stop searching once a batch is linked (until it's unlinked).
    if (linkedBatch) { setCandidates([]); setLookupLoading(false); return; }
    const term = searchTerm;
    if (term.length < 3) { setCandidates([]); setLookupLoading(false); return; }
    setLookupLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/metrc-tags/lookup?q=${encodeURIComponent(term)}`);
        const data = r.ok ? await r.json() : [];
        setCandidates(Array.isArray(data) ? data : []);
      } catch {
        setCandidates([]);
      } finally {
        setLookupLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [searchTerm, linkedBatch]);

  const linkBatch = (c: Candidate) => {
    setLinkedBatch({ batchId: c.batchId, batchNumber: c.batchNumber, productName: c.productName });
    form.setValue("lotNumber", c.batchNumber);
    if (c.productName) form.setValue("productName", c.productName);
    setCandidates([]);
  };

  // Session 97 (Slice 4) — load the inspection + complaint option lists when the
  // dialog opens, so the "specific source" picker can resolve to a real record.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [iR, cR, catR, lotR, docR] = await Promise.all([
          fetch("/api/incoming-inspections"),
          fetch("/api/complaints"),
          // Session 60 — the catalog is the authoritative item list (it includes
          // starter items that have never been received, which the receiving
          // autocomplete's name-only endpoint cannot identify by id).
          fetch("/api/inventory/catalog", { credentials: "include" }),
          fetch("/api/lots", { credentials: "include" }),
          fetch("/api/documents", { credentials: "include" }),
        ]);
        if (cancelled) return;
        if (iR.ok) setInspections((await iR.json()) as InspectionOpt[]);
        if (cR.ok) setComplaintOpts((await cR.json()) as ComplaintOpt[]);
        if (catR.ok) setCatalogOpts((await catR.json()) as CatalogOpt[]);
        if (lotR.ok) setLotOpts((await lotR.json()) as LotOpt[]);
        if (docR.ok) setDocumentOpts((await docR.json()) as DocumentOpt[]);
      } catch {
        /* option lists are best-effort */
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Clear the specific-source pick whenever the Source category changes, so a
  // stale inspection/complaint id can't ride along under a different source.
  const sourceValue = form.watch("source");
  // Session 60 — drive the affected-scope pickers.
  const ncTypeAsFound = form.watch("ncTypeAsFound");
  const affectedItemId = form.watch("affectedInventoryItemId");
  // Lots are filtered to the chosen item so the operator picks from that item's
  // receipts rather than every lot in the facility. Active lots first: an NC is
  // usually raised on stock still on hand, but a consumed lot must stay pickable
  // because the problem is often found after the material was used.
  const lotsForItem = useMemo(() => {
    if (!affectedItemId) return [] as LotOpt[];
    const id = Number(affectedItemId);
    return lotOpts
      .filter((l) => l.inventoryItemId === id)
      .sort((a, b) => Number(b.status === "Active") - Number(a.status === "Active"));
  }, [affectedItemId, lotOpts]);
  useEffect(() => {
    setSourceInspectionId("");
    setSourceComplaintId("");
  }, [sourceValue]);

  async function onSubmit(values: FormValues) {
    setError(null);
    // Session 32 — drop empty-string optional fields entirely rather than
    // submitting them as null. Some downstream schemas treat the two
    // differently and the old "null for empty" handling was a candidate
    // source of the silent Create NC failure (Tier 1 #1). We also catch
    // network errors so a failed fetch surfaces to the user instead of
    // hanging in the submit-pending state.
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v == null) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      payload[k] = typeof v === "string" ? v.trim() : v;
    }
    // Session 54 — reportedByUserId is carried as a string in the form; the
    // route + column expect an integer. Coerce here (drop if not numeric).
    if (typeof payload.reportedByUserId === "string") {
      const n = Number(payload.reportedByUserId);
      if (Number.isFinite(n)) payload.reportedByUserId = n;
      else delete payload.reportedByUserId;
    }
    // Session 97 (Slice 3) — attach the real batch FK when one was linked; the
    // free-text lotNumber/productName still submit as the human-readable fallback.
    // Session 60 — the affected-scope references travel as strings in the form.
    // Coerce to ints, and drop the branch that the chosen type does not use so a
    // stale pick can't ride along after switching Product <-> Process.
    for (const k of ["affectedInventoryItemId", "affectedLotId", "affectedDocumentId"] as const) {
      const raw = payload[k];
      if (typeof raw !== "string" || !raw) { delete payload[k]; continue; }
      const n = Number(raw);
      if (Number.isFinite(n)) payload[k] = n; else delete payload[k];
    }
    if (values.ncTypeAsFound !== "Product") {
      delete payload.affectedInventoryItemId;
      delete payload.affectedLotId;
    }
    if (values.ncTypeAsFound !== "Process") delete payload.affectedDocumentId;
    if (linkedBatch) payload.batchId = linkedBatch.batchId;
    // Session 97 (Slice 4) — attach the specific source-record FK matching the
    // chosen Source category (guarded so a stale id never rides a different source).
    if (values.source === "Incoming Inspection" && sourceInspectionId) payload.sourceInspectionId = parseInt(sourceInspectionId);
    if (values.source === "Customer Complaint" && sourceComplaintId) payload.sourceComplaintId = parseInt(sourceComplaintId);
    try {
      const res = await fetch("/api/non-conformances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const created = (await res.json().catch(() => null)) as { id?: number } | null;
        await queryClient.invalidateQueries({ queryKey: getListNonConformancesQueryKey() });
        setOpen(false);
        form.reset();
        setLinkedBatch(null);
        setCandidates([]);
        setSourceInspectionId("");
        setSourceComplaintId("");
        if (created?.id) setLocation(`/non-conformances/${created.id}`);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Failed to create non-conformance (HTTP ${res.status})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — could not reach the server.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { form.reset(); setError(null); setLinkedBatch(null); setCandidates([]); setSourceInspectionId(""); setSourceComplaintId(""); } }}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button size="sm"><Plus className="h-4 w-4 mr-1" />New NC</Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Non-Conformance</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="title" render={({ field }) => (
              <FormItem>
                <FormLabel>Title *</FormLabel>
                <FormControl><Input placeholder="Out-of-spec potency result on batch BTH-25-0012" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="severity" render={({ field }) => (
                <FormItem>
                  <FormLabel>Severity *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="Critical">Critical</SelectItem>
                      <SelectItem value="Major">Major</SelectItem>
                      <SelectItem value="Minor">Minor</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="source" render={({ field }) => (
                <FormItem>
                  <FormLabel>Source *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="Incoming Inspection">Incoming Inspection</SelectItem>
                      <SelectItem value="In-Process">In-Process</SelectItem>
                      <SelectItem value="Testing">Testing</SelectItem>
                      <SelectItem value="Customer Complaint">Customer Complaint</SelectItem>
                      <SelectItem value="Audit">Audit</SelectItem>
                      <SelectItem value="Environmental Monitoring">Environmental Monitoring</SelectItem>
                      <SelectItem value="Other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <NcSeverityGuide />

            {/* Session 97 (Slice 4) — when Source is a system record, pick the
                specific origin so the NC links to the real inspection / complaint. */}
            {sourceValue === "Incoming Inspection" && (
              <div className="space-y-1.5">
                <Label className="text-xs">Which inspection?</Label>
                <Select value={sourceInspectionId} onValueChange={setSourceInspectionId}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="Link the specific inspection…" /></SelectTrigger>
                  <SelectContent>
                    {inspections.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">No inspections found.</div>
                    ) : (
                      inspections.map((i) => (
                        <SelectItem key={i.id} value={String(i.id)}>
                          {i.inspectionNumber}{i.supplierName ? ` · ${i.supplierName}` : ""}{i.poManifestNumber ? ` · ${i.poManifestNumber}` : ""}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">Ties this NC to the receiving inspection it came from.</p>
              </div>
            )}
            {sourceValue === "Customer Complaint" && (
              <div className="space-y-1.5">
                <Label className="text-xs">Which complaint?</Label>
                <Select value={sourceComplaintId} onValueChange={setSourceComplaintId}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="Link the specific complaint…" /></SelectTrigger>
                  <SelectContent>
                    {complaintOpts.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">No complaints found.</div>
                    ) : (
                      complaintOpts.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.complaintNumber}{c.description ? ` · ${c.description.slice(0, 40)}` : ""}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">Ties this NC to the complaint that raised it.</p>
              </div>
            )}

            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem>
                <FormLabel>Description *</FormLabel>
                <FormControl><Textarea placeholder="Describe the non-conformance in detail..." rows={3} {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            {/* Session 48.5 — Identification fields (Date NC Identified,
                Reported By, Severity Rationale). Reported By auto-fills
                from the signed-in user but is fully editable so the QMS
                owner can log an NC on behalf of another employee. Date
                NC Identified defaults to today; backdate allowed. */}
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="identifiedAt" render={({ field }) => (
                <FormItem>
                  <FormLabel>Date NC Identified</FormLabel>
                  <FormControl>
                    <Input type="date" max={new Date().toISOString().slice(0, 10)} {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="reportedByUserId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Reported By</FormLabel>
                  <Select
                    value={field.value ?? ""}
                    onValueChange={(v) => {
                      field.onChange(v);
                      form.setValue("reportedByName", usersData.find((u) => String(u.id) === v)?.fullName ?? "");
                    }}
                  >
                    <FormControl>
                      <SelectTrigger data-testid="select-create-nc-reported-by">
                        <SelectValue placeholder="Select user…" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {usersData.filter((u) => u.active || String(u.id) === field.value).length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">No users.</div>
                      ) : (
                        usersData
                          .filter((u) => u.active || String(u.id) === field.value)
                          .map((u) => (
                            <SelectItem key={u.id} value={String(u.id)}>
                              {u.fullName}{u.role ? ` · ${u.role}` : ""}
                            </SelectItem>
                          ))
                      )}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <FormField control={form.control} name="severityRationale" render={({ field }) => (
              <FormItem>
                <FormLabel>Severity Rationale</FormLabel>
                <FormControl>
                  <Textarea placeholder="Why is this severity correct? (e.g. customer-facing impact, regulatory citation, batch loss size)" rows={2} {...field} value={field.value ?? ""} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />

            {/* -- Session 60: what the NC is about, and what it affects --------
                Type is a SECOND axis, orthogonal to Source above: Source is where
                the issue was CAUGHT, Type is what it concerns. Asked here because
                it decides which "affected" picker to show. */}
            <div className="rounded-md border bg-muted/30 p-3 space-y-3">
              <FormField control={form.control} name="ncTypeAsFound" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs font-semibold uppercase tracking-wide">NC Type - as found *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="Product">Product - a material or finished good is affected</SelectItem>
                      <SelectItem value="Process">Process - a procedure or work instruction is at fault</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    How it looks now. If the investigation lands somewhere else - a product
                    problem caused by a bad procedure - set the confirmed type on the NC
                    later; this field keeps how it came in.
                  </p>
                  <FormMessage />
                </FormItem>
              )} />

              {ncTypeAsFound === "Product" && (
                <div className="grid grid-cols-2 gap-3">
                  <FormField control={form.control} name="affectedInventoryItemId" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Affected Material</FormLabel>
                      <Select
                        onValueChange={(v) => {
                          field.onChange(v);
                          // The lot belongs to the item; changing the item invalidates it.
                          form.setValue("affectedLotId", "");
                        }}
                        value={field.value ?? ""}
                      >
                        <FormControl><SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select item" /></SelectTrigger></FormControl>
                        <SelectContent>
                          {catalogOpts.map((c) => (
                            <SelectItem key={c.id} value={String(c.id)}>
                              {c.itemName}{c.itemType ? ` - ${c.itemType}` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="affectedLotId" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Affected Lot</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? ""} disabled={!affectedItemId}>
                        <FormControl>
                          <SelectTrigger className="h-8 text-sm">
                            <SelectValue placeholder={!affectedItemId ? "Pick a material first" : (lotsForItem.length ? "Select lot" : "No lots on record")} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {lotsForItem.map((l) => (
                            <SelectItem key={l.id} value={String(l.id)}>
                              {l.lotNumber || `(lot #${l.id})`}{l.status ? ` - ${l.status}` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Only if the material carries a lot number. The lot is also what ties
                        the NC back to the supplier who shipped it.
                      </p>
                    </FormItem>
                  )} />
                </div>
              )}

              {ncTypeAsFound === "Process" && (
                <FormField control={form.control} name="affectedDocumentId" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Affected SOP / Work Instruction</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value ?? ""}>
                      <FormControl><SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select document" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {documentOpts.map((d) => (
                          <SelectItem key={d.id} value={String(d.id)}>
                            {d.documentNumber ? `${d.documentNumber} - ` : ""}{d.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
              )}
            </div>

            <div className="rounded-md border bg-muted/30 p-3 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Finished product context (optional)</p>
              <p className="text-xs text-muted-foreground -mt-2">
                Finished goods only. Leave blank for components, consumables, packaging and
                other materials that are not something you sell — name those under Affected
                Material above.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="productType" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Product Type</FormLabel>
                    {/* Product context is optional, so the operator has to be able
                        to take it back OFF — an NC raised on a received component or
                        a consumable has no finished-goods type, and leaving the field
                        empty is the correct answer rather than forcing "Other".
                        Radix rejects an empty-string item value, hence the sentinel. */}
                    <Select
                      onValueChange={(v) => field.onChange(v === PRODUCT_TYPE_NONE ? "" : v)}
                      value={field.value || PRODUCT_TYPE_NONE}
                    >
                      <FormControl><SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value={PRODUCT_TYPE_NONE}>
                          <span className="text-muted-foreground">None</span>
                        </SelectItem>
                        {PRODUCT_TYPES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
                <FormField control={form.control} name="department" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Department</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value ?? ""}>
                      <FormControl><SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {DEPARTMENTS.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="productName" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Product Name</FormLabel>
                    <FormControl><Input className="h-8 text-sm" placeholder="e.g. Blue Dream Pre-Roll" {...field} /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="lotNumber" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Lot Number</FormLabel>
                    <FormControl><Input className="h-8 text-sm font-mono" placeholder="e.g. BTH-25-0012 or METRC tag" {...field} /></FormControl>
                  </FormItem>
                )} />
              </div>

              {/* Session 97 (Slice 3) — source-batch link (reuses the Complaint
                  typeahead). Links the NC to a real batch (batch_id FK); the
                  free-text lot/product above stay as the fallback. */}
              {linkedBatch ? (
                <div className="flex items-center justify-between rounded border bg-muted/40 px-2 py-1.5 text-xs">
                  <span>Linked batch: <span className="font-mono">{linkedBatch.batchNumber}</span>{linkedBatch.productName ? <span className="text-muted-foreground"> · {linkedBatch.productName}</span> : null}</span>
                  <button type="button" className="text-destructive hover:underline" onClick={() => setLinkedBatch(null)}>Unlink</button>
                </div>
              ) : (
                <>
                  <p className="text-[10px] text-muted-foreground">Type a METRC tag, batch number, or product / strain above to link a real batch — keeps NC→batch traceable. Stored as text too, so external lots still work.</p>
                  {lookupLoading && <p className="text-[10px] text-muted-foreground">Searching batches…</p>}
                  {candidates.length > 0 && (
                    <div className="rounded border divide-y">
                      {candidates.map((c) => (
                        <div key={c.batchId} className="flex items-center justify-between px-2 py-1.5 text-xs">
                          <div className="min-w-0">
                            <span className="font-mono">{c.batchNumber}</span>
                            {c.productName ? <span className="text-muted-foreground"> · {c.productName}</span> : null}
                            {c.strainName ? <span className="text-muted-foreground"> · {c.strainName}</span> : null}
                            <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[9px] uppercase text-muted-foreground">{matchLabel(c.matchKind)}</span>
                          </div>
                          <button type="button" className="text-primary hover:underline shrink-0 ml-2" onClick={() => linkBatch(c)}>Link</button>
                        </div>
                      ))}
                    </div>
                  )}
                  {!lookupLoading && searchTerm.length >= 3 && candidates.length === 0 && (
                    <p className="text-[10px] text-muted-foreground">No matching batches — leave as a free-text lot, or link a batch later from the NC.</p>
                  )}
                </>
              )}
            </div>

            <FormField control={form.control} name="disposition" render={({ field }) => (
              <FormItem>
                <FormLabel>Proposed Disposition</FormLabel>
                <Select onValueChange={field.onChange} value={field.value ?? ""}>
                  <FormControl><SelectTrigger><SelectValue placeholder="Select disposition" /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="Use As Is">Use As Is</SelectItem>
                    <SelectItem value="Rework">Rework</SelectItem>
                    <SelectItem value="Retest">Retest</SelectItem>
                    <SelectItem value="Destroy">Destroy</SelectItem>
                    <SelectItem value="Return to Supplier">Return to Supplier</SelectItem>
                    <SelectItem value="Pending Investigation">Pending Investigation</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Creating..." : "Create NC"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
