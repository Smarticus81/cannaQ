import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus } from "lucide-react";
import { useCreateCapa, useGetCurrentUser } from "@workspace/api-client-react";

// Session 76 — extracted out of CAPAs.tsx into its own file so the global
// "New Quality Event" front door can open it the same way as the other three
// quality-event dialogs. Behaviour is identical to the previous inline version.
// With no open/onOpenChange the dialog self-manages and shows its own "New CAPA"
// trigger button; supplying them makes it parent-controlled and (with
// hideTrigger) trigger-less. Backward compatible — CAPAs.tsx imports it and
// passes only onCreated.

// Session 34 (Tier 2 #10) — initial Risk classification fields for the create
// dialog. The five boolean prompts are guidance, not auto-compute inputs;
// operator picks Risk based on their judgment and these structured answers
// feed the Track C Risk Memory agent later.
type RiskBooleanKey =
  | "riskReleased"
  | "riskCustomerAffected"
  | "riskLabelingImpact"
  | "riskInHouseOnly"
  | "riskPreBulk";
const RISK_PROMPTS: { key: RiskBooleanKey; label: string }[] = [
  { key: "riskReleased",         label: "Released to customer?" },
  { key: "riskCustomerAffected", label: "Customer affected?" },
  { key: "riskLabelingImpact",   label: "Labeling impact?" },
  { key: "riskInHouseOnly",      label: "In-house only?" },
  { key: "riskPreBulk",          label: "Caught pre-bulk?" },
];

const DEPARTMENTS = ["Cultivation", "Processing", "Kitchen", "Extraction", "Packaging", "QA/QC", "Warehouse", "Other"];
import { PRODUCT_TYPES_WITH_OTHER as PRODUCT_TYPES } from "@/lib/productTypes";

// Radix reserves "" for nothing-selected and refuses it as an item value, so
// clearing the field needs a stand-in that is mapped back to "".
const PRODUCT_TYPE_NONE = "__none__";

// Session 97 (cross-linking Slice 2) — mirror the Field Actions "Linked Source"
// picker so a standalone CAPA can be tied to the NC or Complaint that drove it,
// instead of being an island. Stores the same nullable FKs the backend already
// accepts (source_nc_id / source_complaint_id).
const SOURCE_KINDS = ["None", "Non-Conformance", "Complaint"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];
type NcOption = { id: number; ncNumber: string; title: string; description: string; status: string };
type ComplaintOption = { id: number; complaintNumber: string; description: string; status: string };

type CreateCAPADialogProps = {
  onCreated: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
};

export function CreateCAPADialog({ onCreated, open: openProp, onOpenChange, hideTrigger }: CreateCAPADialogProps) {
  const { toast } = useToast();
  // Session 63.3 — route to the record just created instead of leaving the
  // operator on the module's list page with nothing open to fill in.
  const [, setLocation] = useLocation();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => { if (onOpenChange) onOpenChange(v); else setOpenState(v); };
  const [form, setForm] = useState({
    type: "Corrective",
    title: "",
    description: "",
    productType: "",
    productName: "",
    lotNumber: "",
    department: "",
    investigationDueDate: "",
    actionPlanningDueDate: "",
    ecPlanningDueDate: "",
    // Session 34 (Tier 2 #10)
    riskLevel: "",
    riskRationale: "",
    riskReleased: false,
    riskCustomerAffected: false,
    riskLabelingImpact: false,
    riskInHouseOnly: false,
    riskPreBulk: false,
  });

  // Session 28 — useCreateCapa replaces the raw POST. The mutation's
  // `isPending` flag drives the "Creating…" button label.
  const createCapa = useCreateCapa();

  // Session 97 (Slice 2) — current user (for the read-only "Opened by" display;
  // the server authoritatively stamps openedBy from the session, so a free-text
  // field there was misleading) + Linked Source picker state (nullable FKs kept
  // outside the form object, mirroring CreateFieldActionDialog).
  const { data: currentUser } = useGetCurrentUser();
  const [sourceKind, setSourceKind] = useState<SourceKind>("None");
  const [sourceNcId, setSourceNcId] = useState("");
  const [sourceComplaintId, setSourceComplaintId] = useState("");
  const [ncs, setNcs] = useState<NcOption[]>([]);
  const [complaints, setComplaints] = useState<ComplaintOption[]>([]);
  const [descriptionOverridden, setDescriptionOverridden] = useState(false);

  // Load the picker options only when the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [ncR, cR] = await Promise.all([fetch("/api/non-conformances"), fetch("/api/complaints")]);
        if (cancelled) return;
        if (ncR.ok) setNcs((await ncR.json()) as NcOption[]);
        if (cR.ok) setComplaints((await cR.json()) as ComplaintOption[]);
      } catch {
        /* picker lists are best-effort */
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Auto-prefill Description from the picked source (never clobber a manual edit).
  useEffect(() => {
    if (descriptionOverridden) return;
    let next = "";
    if (sourceKind === "Non-Conformance" && sourceNcId) {
      const nc = ncs.find((n) => String(n.id) === sourceNcId);
      if (nc) next = `[From ${nc.ncNumber}] ${nc.description}`;
    } else if (sourceKind === "Complaint" && sourceComplaintId) {
      const c = complaints.find((x) => String(x.id) === sourceComplaintId);
      if (c) next = `[From ${c.complaintNumber}] ${c.description}`;
    }
    if (next) setForm((f) => ({ ...f, description: next }));
  }, [sourceKind, sourceNcId, sourceComplaintId, ncs, complaints, descriptionOverridden]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.description.trim()) return;
    // Session 34 (Tier 2 #10) — client-side risk gate matches the server.
    if (!form.riskLevel) {
      toast({ title: "Pick a Risk Level before creating the CAPA.", variant: "destructive" });
      return;
    }
    if (!form.riskRationale.trim()) {
      toast({ title: "Risk rationale is required.", variant: "destructive" });
      return;
    }
    try {
      const payload: Record<string, unknown> = { ...form };
      for (const k of ["productType", "productName", "lotNumber", "department", "investigationDueDate", "actionPlanningDueDate", "ecPlanningDueDate"]) {
        if (payload[k] === "") delete payload[k];
      }
      // Session 97 (Slice 2) — attach the Linked Source FK when one was picked
      // (backend already allowlists source_nc_id / source_complaint_id on create).
      if (sourceKind === "Non-Conformance" && sourceNcId) payload.sourceNcId = parseInt(sourceNcId);
      if (sourceKind === "Complaint" && sourceComplaintId) payload.sourceComplaintId = parseInt(sourceComplaintId);
      const created = (await createCapa.mutateAsync({ data: payload as never })) as { id?: number } | undefined;
      toast({ title: "CAPA created" });
      setOpen(false);
      setForm({
        type: "Corrective", title: "", description: "",
        productType: "", productName: "", lotNumber: "", department: "",
        investigationDueDate: "", actionPlanningDueDate: "", ecPlanningDueDate: "",
        riskLevel: "", riskRationale: "",
        riskReleased: false, riskCustomerAffected: false, riskLabelingImpact: false,
        riskInHouseOnly: false, riskPreBulk: false,
      });
      setSourceKind("None");
      setSourceNcId("");
      setSourceComplaintId("");
      setDescriptionOverridden(false);
      onCreated();
      if (created?.id) setLocation(`/capas/${created.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create CAPA";
      toast({ title: msg, variant: "destructive" });
    }
  };

  return (
    <>
      {!hideTrigger && (
        <Button onClick={() => setOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" /> New CAPA
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        {/* Session 42 (25 May feedback fix): dialog overflowed viewport so the
            Create CAPA button + risk/product/date blocks were unreachable.
            Cap height to viewport and make the content area scroll while the
            header + footer stay pinned. */}
        <DialogContent className="sm:max-w-lg max-h-[90vh] flex flex-col p-0">
          <form onSubmit={handleSubmit} className="flex flex-col min-h-0 flex-1">
            <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
              <DialogTitle>Open New CAPA</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4 px-6 overflow-y-auto flex-1 min-h-0">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Corrective">Corrective — fix existing problem</SelectItem>
                    <SelectItem value="Preventive">Preventive — prevent potential problem</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Title *</Label>
                <Input placeholder="Brief descriptive title" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required />
              </div>
              {/* Session 97 (Slice 2) — Linked Source picker (mirrors Field Actions).
                  Picking an NC / Complaint stores the FK and pre-fills Description. */}
              <div className="rounded-md border bg-muted/30 p-3 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Linked source (optional)</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Source type</Label>
                    <Select value={sourceKind} onValueChange={(v) => { setSourceKind(v as SourceKind); setSourceNcId(""); setSourceComplaintId(""); setDescriptionOverridden(false); }}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {SOURCE_KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {sourceKind === "Non-Conformance" && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">NC</Label>
                      <Select value={sourceNcId} onValueChange={(v) => { setSourceNcId(v); setDescriptionOverridden(false); }}>
                        <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select NC" /></SelectTrigger>
                        <SelectContent>
                          {ncs.map((n) => <SelectItem key={n.id} value={String(n.id)}>{n.ncNumber} — {n.title}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {sourceKind === "Complaint" && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Complaint</Label>
                      <Select value={sourceComplaintId} onValueChange={(v) => { setSourceComplaintId(v); setDescriptionOverridden(false); }}>
                        <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select complaint" /></SelectTrigger>
                        <SelectContent>
                          {complaints.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.complaintNumber}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">Link the NC or Complaint that drove this CAPA. Selecting one pre-fills the description below — you can edit it before saving.</p>
              </div>

              <div className="space-y-1.5">
                <Label>Description *</Label>
                <Textarea rows={3} placeholder="Describe the problem or risk being addressed" value={form.description} onChange={(e) => { setForm((f) => ({ ...f, description: e.target.value })); setDescriptionOverridden(true); }} required />
              </div>
              <div className="space-y-1.5">
                <Label>Opened by</Label>
                <Input value={currentUser?.fullName ?? "Current user"} readOnly disabled className="bg-muted/50" />
                <p className="text-[10px] text-muted-foreground mt-0.5">Recorded automatically as the signed-in user (21 CFR Part 11).</p>
              </div>

              {/* Session 34 (Tier 2 #10) — Risk classification is required at open. */}
              <div className="rounded-md border border-amber-200 bg-amber-50/40 p-3 space-y-3">
                <div className="flex items-baseline justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">Risk classification *</p>
                  <p className="text-[11px] text-muted-foreground">Required at open. Can be revised during Investigation.</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Risk level *</Label>
                  <Select value={form.riskLevel} onValueChange={(v) => setForm((f) => ({ ...f, riskLevel: v }))}>
                    <SelectTrigger><SelectValue placeholder="Select Risk Level" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Critical">Critical — safety-of-life / regulatory exposure</SelectItem>
                      <SelectItem value="High">High — released material or customer-facing impact</SelectItem>
                      <SelectItem value="Medium">Medium — contained internal issue</SelectItem>
                      <SelectItem value="Low">Low — pre-bulk, easily corrected</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Guiding prompts (check all that apply)</Label>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                    {RISK_PROMPTS.map((p) => (
                      <label key={p.key} className="flex items-center gap-2 text-sm cursor-pointer">
                        <Checkbox
                          checked={form[p.key]}
                          onCheckedChange={(v) => setForm((f) => ({ ...f, [p.key]: v === true }))}
                        />
                        <span>{p.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Rationale *</Label>
                  <Textarea
                    rows={2}
                    placeholder="Why this risk level? e.g. 'Lot already released to two dispensaries; labeling claims THC within spec but COA shows out-of-tolerance.'"
                    value={form.riskRationale}
                    onChange={(e) => setForm((f) => ({ ...f, riskRationale: e.target.value }))}
                  />
                </div>
              </div>

              <div className="rounded-md border bg-muted/30 p-3 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Finished product context (optional)</p>
                <p className="text-xs text-muted-foreground -mt-2">
                  Finished goods only. Leave blank for components, consumables, packaging and
                  other materials that are not something you sell.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Product Type</Label>
                    <Select
                      value={form.productType || PRODUCT_TYPE_NONE}
                      onValueChange={(v) => setForm((f) => ({ ...f, productType: v === PRODUCT_TYPE_NONE ? "" : v }))}
                    >
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={PRODUCT_TYPE_NONE}><span className="text-muted-foreground">None</span></SelectItem>
                        {PRODUCT_TYPES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Department</Label>
                    <Select value={form.department} onValueChange={(v) => setForm((f) => ({ ...f, department: v }))}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent>
                        {DEPARTMENTS.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Product Name</Label>
                    <Input className="h-8 text-sm" placeholder="e.g. Blue Dream Pre-Roll" value={form.productName} onChange={(e) => setForm((f) => ({ ...f, productName: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Lot Number</Label>
                    <Input className="h-8 text-sm" placeholder="e.g. BTH-25-0012 or METRC tag" value={form.lotNumber} onChange={(e) => setForm((f) => ({ ...f, lotNumber: e.target.value }))} />
                  </div>
                </div>
              </div>

              <div className="rounded-md border bg-muted/30 p-3 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Per-phase due dates (optional)</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Investigation</Label>
                    <Input type="date" className="h-8 text-sm" value={form.investigationDueDate} onChange={(e) => setForm((f) => ({ ...f, investigationDueDate: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Action / EC Planning</Label>
                    <Input type="date" className="h-8 text-sm" value={form.actionPlanningDueDate} onChange={(e) => setForm((f) => ({ ...f, actionPlanningDueDate: e.target.value }))} />
                  </div>
                </div>
              </div>
            </div>
            <DialogFooter className="px-6 py-4 shrink-0 border-t bg-background">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={createCapa.isPending}>{createCapa.isPending ? "Creating…" : "Create CAPA"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
