import { useState, useEffect } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getListComplaintsQueryKey } from "@workspace/api-client-react";
import { ComplaintSeverityGuide } from "@/components/complaints/ComplaintSeverityGuide";
import { ReportabilityTriage, deriveReportability, type TriageAnswers } from "@/components/complaints/ReportabilityTriage";

// Session 38 (Tier 4 #20) — MVP-expanded complaint intake. Tier 5's FDA x
// ISO 13485 x food-reg cross-walk is the deeper research effort; this round
// just closes the obvious gaps (reporter contact, lot identification,
// severity rationale, regulatory notification flags).
const schema = z.object({
  receivedDate: z.string().min(1, "Required"),
  complaintType: z.string().min(1, "Required"),
  severity: z.string().min(1, "Required"),
  description: z.string().min(1, "Required"),
  customerName: z.string().min(1, "Customer / Dispensary is required"),
  productName: z.string().optional(),
  // Session 38 — reporter contact (separate from customerName because the
  // reporter is often a dispensary staffer or family member, not the
  // affected consumer).
  reporterName: z.string().optional(),
  reporterEmail: z.string().email("Invalid email").optional().or(z.literal("")),
  reporterPhone: z.string().optional(),
  // Session 38 — lot identification + severity rationale.
  lotNumber: z.string().optional(),
  severityRationale: z.string().optional(),
})
  // Session 101 — product identity required: a Product name OR a METRC / lot
  // number, so every complaint is traceable to a specific item.
  .superRefine((v, ctx) => {
    if (!v.productName?.trim() && !v.lotNumber?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["productName"], message: "Enter the Product name, or a METRC / lot number below." });
    }
  });

type FormValues = z.infer<typeof schema>;

// Session 74 — candidate source-batch lookup (METRC tag lineage Phase 2). The
// Lot/Batch field doubles as a traceability search: as the user types whatever
// the complainant could give us (full tag, torn partial, or just the product /
// strain), we surface candidate batches to link. Linking is optional and may be
// multiple (two lots of the same strain) — the investigation narrows it later.
type Candidate = {
  batchId: number; batchNumber: string; productName: string | null;
  strainName: string | null; status: string | null; productionDate: string | null;
  matchKind: string; matchedOn: string[];
};
type Attached = { batchId: number; batchNumber: string; productName: string | null; matchBasis: string; enteredValue: string };

const matchLabel = (k: string) => (k === "exact" ? "exact tag" : k === "partial" ? "partial tag" : "product match");
const basisFor = (k: string) => (k === "exact" ? "tag_exact" : k === "partial" ? "tag_partial" : "product");

// Session 76 — controllable from the global "New Quality Event" front door.
// With no props the dialog manages its own state and shows its "New Complaint"
// trigger (unchanged); with open/onOpenChange it is parent-controlled and the
// trigger is hidden. Backward compatible.
type DialogControl = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
};

export function CreateComplaintDialog({ open: openProp, onOpenChange, hideTrigger }: DialogControl = {}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => { if (onOpenChange) onOpenChange(v); else setOpenState(v); };
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [attached, setAttached] = useState<Attached[]>([]);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [triage, setTriage] = useState<TriageAnswers>({});
  const queryClient = useQueryClient();
  // Session 63.3 — route to the record just created instead of leaving the
  // operator on the module's list page with nothing open to fill in.
  const [, setLocation] = useLocation();

  const today = new Date().toLocaleDateString("en-CA");
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      receivedDate: today,
      complaintType: "",
      severity: "",
      description: "",
      customerName: "",
      productName: "",
      reporterName: "",
      reporterEmail: "",
      reporterPhone: "",
      lotNumber: "",
      severityRationale: "",
    },
  });

  // Debounced source-batch lookup. Fires from EITHER the Lot/Batch/METRC field
  // or the Product field (whichever the operator fills) — a torn tag fragment,
  // a batch number, or just the product/strain all surface candidate batches.
  // Runs at >=3 chars.
  const lotValue = form.watch("lotNumber");
  const productValue = form.watch("productName");
  const searchTerm = ((lotValue ?? "").trim() || (productValue ?? "").trim());
  useEffect(() => {
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
  }, [searchTerm]);

  const attach = (c: Candidate) => {
    setAttached((prev) => prev.some((a) => a.batchId === c.batchId) ? prev : [...prev, {
      batchId: c.batchId, batchNumber: c.batchNumber, productName: c.productName,
      matchBasis: basisFor(c.matchKind), enteredValue: searchTerm,
    }]);
  };

  function resetAll() {
    form.reset();
    setAttached([]);
    setCandidates([]);
    setTriage({});
    setError(null);
  }

  async function onSubmit(values: FormValues) {
    setError(null);
    const rep = deriveReportability(triage);
    const body = {
      ...values,
      mdrReportable: false,
      mdardReportable: false,
      craReportable: rep.cra,
      fdaReportable: rep.fda,
      reportabilityTriage: triage,
      reporterEmail: values.reporterEmail || undefined,
    };
    const res = await fetch("/api/complaints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      // Attach the chosen candidate batches as 'suspected' (best-effort — a
      // failed link must not lose the just-created complaint).
      const created = await res.json().catch(() => null);
      if (created?.id && attached.length) {
        await Promise.all(attached.map((a) =>
          fetch(`/api/complaints/${created.id}/candidate-batches`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ batchId: a.batchId, matchBasis: a.matchBasis, enteredValue: a.enteredValue }),
          }).catch(() => null)
        ));
      }
      await queryClient.invalidateQueries({ queryKey: getListComplaintsQueryKey() });
      setOpen(false);
      resetAll();
      if (created?.id) setLocation(`/complaints/${created.id}`);
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to create complaint");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { resetAll(); } }}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button size="sm"><Plus className="h-4 w-4 mr-1" />New Complaint</Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Complaint</DialogTitle>
          <p className="text-xs text-muted-foreground pt-1">
            Captures the ISO 13485 §8.2.2 + FDA QMSR §820.198 intake baseline. Full FDA × ISO × food-reg cross-walk arrives in a later expansion.
          </p>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">

            {/* ── Intake basics ────────────────────────────────────────── */}
            <div className="space-y-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Intake</p>
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="receivedDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date Received *</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="severity" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Severity *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="Critical">Critical</SelectItem>
                        <SelectItem value="High">High</SelectItem>
                        <SelectItem value="Medium">Medium</SelectItem>
                        <SelectItem value="Low">Low</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <ComplaintSeverityGuide />
              <FormField control={form.control} name="complaintType" render={({ field }) => (
                <FormItem>
                  <FormLabel>Complaint Type *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="Product Quality">Product Quality</SelectItem>
                      <SelectItem value="Adverse Event">Adverse Event</SelectItem>
                      <SelectItem value="Labeling / Packaging">Labeling / Packaging</SelectItem>
                      <SelectItem value="Foreign Material">Foreign Material</SelectItem>
                      <SelectItem value="Potency / Efficacy">Potency / Efficacy</SelectItem>
                      <SelectItem value="Contamination">Contamination</SelectItem>
                      <SelectItem value="Other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="severityRationale" render={({ field }) => (
                <FormItem>
                  <FormLabel>Why this severity?</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      placeholder="Document why you chose this severity — e.g. 'Foreign material reported in a released vape cart; consumer hospitalized.' Captured for audit defensibility."
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            {/* ── Reporter contact ────────────────────────────────────── */}
            <div className="space-y-4 border-t pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Reporter</p>
              <div className="grid grid-cols-3 gap-3">
                <FormField control={form.control} name="reporterName" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl><Input placeholder="Jane Smith" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="reporterEmail" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl><Input type="email" placeholder="jane@example.com" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="reporterPhone" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone</FormLabel>
                    <FormControl><Input placeholder="(555) 000-0000" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <p className="text-[10px] text-muted-foreground -mt-1">
                Reporter is the person who filed the complaint (e.g. dispensary staff, caregiver). Distinct from the affected customer below.
              </p>
            </div>

            {/* ── Product / lot identification ───────────────────────── */}
            <div className="space-y-4 border-t pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Product & Lot</p>
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="customerName" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Customer / Dispensary *</FormLabel>
                    <FormControl><Input placeholder="Greenleaf Dispensary" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="productName" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Product</FormLabel>
                    <FormControl><Input placeholder="Blue Dream Vape" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <p className="text-[10px] text-muted-foreground -mt-1">
                Provide the Product name, or a METRC / lot number below, so the complaint is traceable to a specific item.
              </p>
              <FormField control={form.control} name="lotNumber" render={({ field }) => (
                <FormItem>
                  <FormLabel>Lot / Batch / METRC Tag</FormLabel>
                  <FormControl><Input className="font-mono" placeholder="Full or partial METRC tag or batch number" {...field} /></FormControl>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    We search source batches as you type — a full or torn METRC tag or the batch number. Stored as text too, so external / third-party lots still work.
                  </p>
                  <FormMessage />
                </FormItem>
              )} />

              {/* ── Candidate source-batch lookup (Phase 2) ─────────────── */}
              {attached.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Possible source batches (linked)</p>
                  {attached.map((a) => (
                    <div key={a.batchId} className="flex items-center justify-between rounded border bg-muted/40 px-2 py-1.5 text-xs">
                      <span><span className="font-mono">{a.batchNumber}</span>{a.productName ? <span className="text-muted-foreground"> · {a.productName}</span> : null}</span>
                      <button type="button" className="text-destructive hover:underline" onClick={() => setAttached((prev) => prev.filter((x) => x.batchId !== a.batchId))}>Remove</button>
                    </div>
                  ))}
                  <p className="text-[10px] text-muted-foreground">Link every plausible lot — the investigation confirms which one (or rules them all out) later.</p>
                </div>
              )}
              {lookupLoading && <p className="text-[10px] text-muted-foreground">Searching batches…</p>}
              {candidates.filter((c) => !attached.some((a) => a.batchId === c.batchId)).length > 0 && (
                <div className="rounded border divide-y">
                  {candidates.filter((c) => !attached.some((a) => a.batchId === c.batchId)).map((c) => (
                    <div key={c.batchId} className="flex items-center justify-between px-2 py-1.5 text-xs">
                      <div className="min-w-0">
                        <span className="font-mono">{c.batchNumber}</span>
                        {c.productName ? <span className="text-muted-foreground"> · {c.productName}</span> : null}
                        {c.strainName ? <span className="text-muted-foreground"> · {c.strainName}</span> : null}
                        <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[9px] uppercase text-muted-foreground">{matchLabel(c.matchKind)}</span>
                      </div>
                      <button type="button" className="text-primary hover:underline shrink-0 ml-2" onClick={() => attach(c)}>Link</button>
                    </div>
                  ))}
                </div>
              )}
              {!lookupLoading && searchTerm.length >= 3 && candidates.length === 0 && (
                <p className="text-[10px] text-muted-foreground">No matching batches found — leave as a free-text lot, or link a batch later from the complaint.</p>
              )}
            </div>

            {/* ── Regulatory notification flags ──────────────────────── */}
            <div className="space-y-3 border-t pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Regulatory Reporting Triage</p>
              <p className="text-[11px] text-muted-foreground">
                Answer these so the system can flag whether a regulatory report is required — you don't need to know the rules. For a Michigan marihuana product, adverse reactions must be reported to the CRA within 1 business day and logged in METRC (R 420.214b).
              </p>
              <ReportabilityTriage value={triage} onChange={setTriage} />
            </div>

            {/* ── Description ────────────────────────────────────────── */}
            <div className="border-t pt-4">
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem>
                  <FormLabel>Description *</FormLabel>
                  <FormControl><Textarea placeholder="Describe the complaint in detail — what happened, when, how it was discovered, any photos / evidence references." rows={4} {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Creating..." : "Create Complaint"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
