import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { FIELD_ACTION_TYPES } from "@/lib/fieldActionTypes";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getListFieldActionsQueryKey } from "@workspace/api-client-react";

const SOURCE_KINDS = ["None", "Non-Conformance", "Complaint"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

const DEPARTMENTS = ["Cultivation", "Processing", "Kitchen", "Extraction", "Packaging", "QA/QC", "Warehouse", "Other"];
import { PRODUCT_TYPES_WITH_OTHER as PRODUCT_TYPES } from "@/lib/productTypes";

// Radix reserves "" for nothing-selected and refuses it as an item value, so
// clearing the field needs a stand-in that is mapped back to "".
const PRODUCT_TYPE_NONE = "__none__";

const schema = z.object({
  title: z.string().min(1, "Required"),
  actionType: z.string().min(1, "Required"),
  initiationReason: z.string().min(1, "Required"),
  affectedBatches: z.string().optional(),
  scopeDescription: z.string().optional(),
  productType: z.string().optional(),
  productName: z.string().optional(),
  lotNumber: z.string().optional(),
  department: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

type NcOption = { id: number; ncNumber: string; title: string; description: string; status: string };
type ComplaintOption = { id: number; complaintNumber: string; description: string; status: string };
type CapaOption = { id: number; capaNumber: string; title: string; status: string; stage?: string | null };

// Session 76 — controllable from the global "New Quality Event" front door, and
// dual-mode:
//   • mode="create"  (default) — approver flow, posts /api/field-actions and
//     opens the FA directly (auto-CAPA rule unchanged).
//   • mode="request" — Operator flow. A Field Action may not be opened by an
//     Operator; instead they submit a REQUEST that posts /api/field-actions/request
//     and sits in "Requested" until Quality/Manager approve it (the CAPA is
//     created at approval time). The Linked-CAPA section and auto-CAPA confirm
//     are hidden in request mode.
// With no open/onOpenChange the dialog self-manages and shows its own trigger
// (unchanged). Backward compatible.
type CreateFieldActionDialogProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  mode?: "create" | "request";
};

export function CreateFieldActionDialog({ open: openProp, onOpenChange, hideTrigger, mode = "create" }: CreateFieldActionDialogProps = {}) {
  const isRequest = mode === "request";
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => { if (onOpenChange) onOpenChange(v); else setOpenState(v); };
  const [error, setError] = useState<string | null>(null);
  // Session 75 — when the user initiates an FA with no CAPA linked, confirm that
  // one will be auto-created before we create anything.
  const [confirmCapaOpen, setConfirmCapaOpen] = useState(false);
  const [pendingValues, setPendingValues] = useState<FormValues | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const queryClient = useQueryClient();
  // Session 63.3 — route to the record just created instead of leaving the
  // operator on the module's list page with nothing open to fill in.
  const [, setLocation] = useLocation();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { title: "", actionType: "", initiationReason: "", affectedBatches: "", scopeDescription: "", productType: "", productName: "", lotNumber: "", department: "" },
  });

  // ── Linked source / CAPA state (managed outside the zod schema because they
  // are nullable foreign keys rather than form-validated strings) ─────────────
  const [sourceKind, setSourceKind] = useState<SourceKind>("None");
  const [sourceNcId, setSourceNcId] = useState<string>("");
  const [sourceComplaintId, setSourceComplaintId] = useState<string>("");
  const [linkedCapaId, setLinkedCapaId] = useState<string>("");

  const [ncs, setNcs] = useState<NcOption[]>([]);
  const [complaints, setComplaints] = useState<ComplaintOption[]>([]);
  const [capas, setCapas] = useState<CapaOption[]>([]);
  const [reasonOverridden, setReasonOverridden] = useState(false);

  // Load picker options only when the dialog opens, to avoid hammering the
  // list endpoints on every page render.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [ncR, cR, kR] = await Promise.all([
          fetch("/api/non-conformances"),
          fetch("/api/complaints"),
          fetch("/api/capas"),
        ]);
        if (cancelled) return;
        if (ncR.ok) setNcs((await ncR.json()) as NcOption[]);
        if (cR.ok) setComplaints((await cR.json()) as ComplaintOption[]);
        if (kR.ok) setCapas((await kR.json()) as CapaOption[]);
      } catch {
        /* picker lists are best-effort */
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Auto-prefill the initiationReason from the selected source — but never
  // clobber a manually edited value. The user can re-pick a source to
  // refresh, or type their own narrative.
  useEffect(() => {
    if (reasonOverridden) return;
    let next = "";
    if (sourceKind === "Non-Conformance" && sourceNcId) {
      const nc = ncs.find((n) => String(n.id) === sourceNcId);
      if (nc) next = `[From ${nc.ncNumber}] ${nc.description}`;
    } else if (sourceKind === "Complaint" && sourceComplaintId) {
      const c = complaints.find((x) => String(x.id) === sourceComplaintId);
      if (c) next = `[From ${c.complaintNumber}] ${c.description}`;
    }
    if (next) form.setValue("initiationReason", next, { shouldValidate: true });
  }, [sourceKind, sourceNcId, sourceComplaintId, ncs, complaints, reasonOverridden, form]);

  function resetAll() {
    form.reset();
    setSourceKind("None");
    setSourceNcId("");
    setSourceComplaintId("");
    setLinkedCapaId("");
    setReasonOverridden(false);
    setError(null);
    setConfirmCapaOpen(false);
    setPendingValues(null);
  }

  // Submit gate: if no CAPA is linked, surface a confirmation that one will be
  // created automatically (a Field Action can't exist without a CAPA) before we
  // create anything. If a CAPA is linked, create straight away.
  async function onSubmit(values: FormValues) {
    setError(null);
    // Operator request flow: no CAPA is linked or created at request time (the
    // CAPA is opened when an approver approves), so skip the auto-CAPA confirm.
    if (isRequest) {
      await doSubmit(values);
      return;
    }
    if (!linkedCapaId) {
      setPendingValues(values);
      setConfirmCapaOpen(true);
      return;
    }
    await doSubmit(values);
  }

  async function doSubmit(values: FormValues) {
    setSubmitting(true);
    setError(null);
    const payload: Record<string, unknown> = { ...values };
    for (const k of ["affectedBatches", "scopeDescription", "productType", "productName", "lotNumber", "department"]) {
      if (payload[k] === "") payload[k] = null;
    }
    if (sourceKind === "Non-Conformance" && sourceNcId) payload.sourceNcId = parseInt(sourceNcId);
    if (sourceKind === "Complaint" && sourceComplaintId) payload.sourceComplaintId = parseInt(sourceComplaintId);
    // CAPA is only linked in approver create-mode; an Operator request never
    // carries a CAPA (one is created at approval).
    if (!isRequest && linkedCapaId) payload.linkedCapaId = parseInt(linkedCapaId);

    try {
      const res = await fetch(isRequest ? "/api/field-actions/request" : "/api/field-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const created = (await res.json().catch(() => null)) as { id?: number } | null;
        await queryClient.invalidateQueries({ queryKey: getListFieldActionsQueryKey() });
        setConfirmCapaOpen(false);
        setOpen(false);
        resetAll();
        // A REQUEST is deliberately not routed: its detail page hides every
        // workflow control until an approver opens it, so the requester would
        // land somewhere with nothing to do.
        if (!isRequest && created?.id) setLocation(`/field-actions/${created.id}`);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? (isRequest ? "Failed to submit field action request" : "Failed to create field action"));
        setConfirmCapaOpen(false);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetAll(); }}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button size="sm" variant="destructive"><Plus className="h-4 w-4 mr-1" />New Field Action</Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isRequest ? "Request a Field Action" : "New Field Action"}</DialogTitle>
        </DialogHeader>
        {isRequest && (
          <p className="text-xs text-muted-foreground -mt-2">
            A Field Action can't be opened directly by an Operator. This submits a request for Quality / Manager review — they approve it before the Field Action (and its required CAPA) is opened.
          </p>
        )}
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="title" render={({ field }) => (
              <FormItem>
                <FormLabel>Title *</FormLabel>
                <FormControl><Input placeholder="Voluntary recall of lot BTH-25-0008 — pesticide exceedance" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="actionType" render={({ field }) => (
              <FormItem>
                <FormLabel>Action Type *</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl><SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger></FormControl>
                  <SelectContent>
                    {/* One list — lib/fieldActionTypes. Never inline these again. */}
                    {FIELD_ACTION_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />

            {/* ── Linked source — auto-prefills initiationReason ─────────── */}
            <div className="rounded-md border bg-muted/30 p-3 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Linked source (optional)</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Source type</Label>
                  <Select value={sourceKind} onValueChange={(v) => { setSourceKind(v as SourceKind); setSourceNcId(""); setSourceComplaintId(""); setReasonOverridden(false); }}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SOURCE_KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                {sourceKind === "Non-Conformance" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">NC</Label>
                    <Select value={sourceNcId} onValueChange={(v) => { setSourceNcId(v); setReasonOverridden(false); }}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select NC" /></SelectTrigger>
                      <SelectContent>
                        {ncs.map((n) => (
                          <SelectItem key={n.id} value={String(n.id)}>{n.ncNumber} — {n.title}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {sourceKind === "Complaint" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Complaint</Label>
                    <Select value={sourceComplaintId} onValueChange={(v) => { setSourceComplaintId(v); setReasonOverridden(false); }}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select complaint" /></SelectTrigger>
                      <SelectContent>
                        {complaints.map((c) => (
                          <SelectItem key={c.id} value={String(c.id)}>{c.complaintNumber}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Selecting a source pre-fills the reason below from its description. You can edit before saving.
              </p>
            </div>

            <FormField control={form.control} name="initiationReason" render={({ field }) => (
              <FormItem>
                <FormLabel>Reason for Initiation *</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Describe why this field action is being initiated..."
                    rows={3}
                    {...field}
                    onChange={(e) => { field.onChange(e); setReasonOverridden(true); }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="affectedBatches" render={({ field }) => (
              <FormItem>
                <FormLabel>Affected Batches</FormLabel>
                <FormControl><Input placeholder="BTH-25-0008, BTH-25-0009" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            {/* ── Product context — same pattern as NC / CAPA ─────────────── */}
            <div className="rounded-md border bg-muted/30 p-3 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Finished product context (optional)</p>
                <p className="text-xs text-muted-foreground -mt-2">
                  Finished goods only. Leave blank for components, consumables, packaging and
                  other materials that are not something you sell.
                </p>
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="productType" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Product Type</FormLabel>
                    <Select
                      onValueChange={(v) => field.onChange(v === PRODUCT_TYPE_NONE ? "" : v)}
                      value={field.value || PRODUCT_TYPE_NONE}
                    >
                      <FormControl><SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value={PRODUCT_TYPE_NONE}><span className="text-muted-foreground">None</span></SelectItem>
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
                    <FormControl><Input className="h-8 text-sm" placeholder="e.g. BTH-25-0012 or METRC tag" {...field} /></FormControl>
                  </FormItem>
                )} />
              </div>
            </div>

            {/* ── Linked CAPA — every Field Action must have one (Session 75).
                Hidden in request mode: the CAPA is opened at approval time. ── */}
            {!isRequest && (
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Linked CAPA</p>
                <Select value={linkedCapaId} onValueChange={setLinkedCapaId}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="None — a CAPA will be opened automatically" /></SelectTrigger>
                  <SelectContent>
                    {capas.map((k) => (
                      <SelectItem key={k.id} value={String(k.id)}>{k.capaNumber} — {k.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  A Field Action never exists without a CAPA. Link an existing one here, or leave this blank and a CAPA will be opened and linked automatically.
                </p>
              </div>
            )}

            <FormField control={form.control} name="scopeDescription" render={({ field }) => (
              <FormItem>
                <FormLabel>Scope Description</FormLabel>
                <FormControl><Textarea placeholder="Describe the scope of distribution and affected customers..." rows={2} {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" variant="destructive" disabled={submitting || form.formState.isSubmitting}>
                {submitting ? (isRequest ? "Submitting..." : "Creating...") : (isRequest ? "Submit Request" : "Initiate Field Action")}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>

    {/* Session 75 — auto-CAPA confirmation (shown when no CAPA was linked) */}
    <Dialog open={confirmCapaOpen} onOpenChange={(v) => { if (!v && !submitting) setConfirmCapaOpen(false); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>A CAPA will be created automatically</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-2 text-sm text-muted-foreground">
          <p>
            You didn't link an existing CAPA. A Field Action can't exist without one, so a new CAPA will be <strong>opened and linked automatically</strong> when this Field Action is created.
          </p>
          <p className="text-xs">
            Want to use a CAPA that already exists instead? Cancel and pick one in the "Linked CAPA" field.
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" disabled={submitting} onClick={() => setConfirmCapaOpen(false)}>Back</Button>
          <Button type="button" variant="destructive" disabled={submitting} onClick={() => { if (pendingValues) void doSubmit(pendingValues); }}>
            {submitting ? "Creating…" : "Create Field Action + CAPA"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
