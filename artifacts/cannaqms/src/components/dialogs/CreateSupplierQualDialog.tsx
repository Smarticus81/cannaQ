import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, FileCheck2, ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getListSupplierQualificationsQueryKey, useListSuppliers } from "@workspace/api-client-react";

const schema = z.object({
  supplierId: z.coerce.number().min(1, "Required"),
  // SQ-Certificates — a record is either a lightweight "Certificate" on file or
  // a full "Audit" assessment. Default Certificate; the audit fields only show
  // (and only send) when the user picks Audit.
  recordType: z.enum(["Certificate", "Audit"]),
  qualificationType: z.string().min(1, "Required"),
  riskLevel: z.string().optional(),
  assessorName: z.string().optional(),
  assessmentDate: z.string().optional(),
  expiryDate: z.string().optional(),
  // Session 97 (certificates / #11) — optional cert metadata.
  issuer: z.string().optional(),
  certificateNumber: z.string().optional(),
  notes: z.string().optional(),
  createdByName: z.string().optional(),
}).superRefine((val, ctx) => {
  // Certificate expiry required (2026-08-06) — a certificate exists to track its
  // expiry; without one the supplier stays flagged. Audits may be open-ended.
  if (val.recordType === "Certificate" && !val.expiryDate?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiryDate"], message: "Certificate expiry date is required." });
  }
});
type FormValues = z.infer<typeof schema>;

// Certificate "types" — what kind of document is on file. Used as
// qualificationType when the record is a Certificate.
const CERT_TYPES = [
  "License",
  "GMP / Manufacturing Certificate",
  "Certificate of Analysis (CoA)",
  "FDA Registration",
  "Organic / Food-Safety Certificate",
  "Certificate of Insurance",
  "Other",
];

// Audit "types" — the assessment cadence. Used as qualificationType when the
// record is an Audit.
const AUDIT_TYPES = [
  "Initial Qualification",
  "Annual Re-qualification",
  "For-Cause Review",
  "Renewal",
  "Desk Audit",
  "On-Site Audit",
];

const RISK_LEVELS = ["Low", "Medium", "High", "Critical"];

export function CreateSupplierQualDialog({ initialSupplierId }: { initialSupplierId?: number }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: suppliers = [] } = useListSuppliers();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      supplierId: initialSupplierId ?? 0,
      recordType: "Certificate",
      qualificationType: "",
      riskLevel: "Medium",
      assessorName: "",
      assessmentDate: "",
      expiryDate: "",
      issuer: "",
      certificateNumber: "",
      notes: "",
      createdByName: "",
    },
  });

  const recordType = form.watch("recordType");
  const isAudit = recordType === "Audit";

  useEffect(() => {
    if (initialSupplierId) form.setValue("supplierId", initialSupplierId);
  }, [initialSupplierId, form]);

  // Switching record type clears the "type" dropdown so a value from the other
  // list (e.g. "On-Site Audit" left over when switching to Certificate) can't
  // silently persist and mislabel the record.
  function switchRecordType(next: "Certificate" | "Audit") {
    form.setValue("recordType", next);
    form.setValue("qualificationType", "");
  }

  async function onSubmit(values: FormValues) {
    setError(null);
    // Session 76.1 — drop empty-string optional fields rather than sending them.
    // assessment_date / expiry_date are real DATE columns; an empty string ""
    // is invalid date syntax and made the insert 500. Omit blanks so they store
    // as NULL.
    // SQ-Certificates — for a Certificate record we also drop the audit-only
    // fields entirely (risk / assessor / assessment date) so the record stays
    // clean; risk falls back to the DB default and never shows in the cert UI.
    const AUDIT_ONLY = new Set(["riskLevel", "assessorName", "assessmentDate"]);
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v == null) continue;
      if (values.recordType !== "Audit" && AUDIT_ONLY.has(k)) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      payload[k] = typeof v === "string" ? v.trim() : v;
    }
    const res = await fetch("/api/supplier-qualifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: getListSupplierQualificationsQueryKey() });
      setOpen(false);
      form.reset();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to create record");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { form.reset(); setError(null); } }}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4 mr-1" />
          Add Record
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Supplier Record</DialogTitle>
          <p className="text-xs text-muted-foreground pt-1">
            {isAudit
              ? "Record a supplier audit or assessment — risk, findings, and a Pass/Fail outcome."
              : "File a supplier certificate — license, GMP/FDA certificate, or CoA — with its issuer and expiry."}
          </p>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Record type toggle — Certificate (simple) vs Audit (full).
                NOTE: plain div/label, NOT FormItem/FormLabel — this toggle is
                driven by buttons, not a registered field, so it must NOT sit
                inside the shadcn Form field context. FormLabel calls
                useFormField() and, with no wrapping FormField, crashes the page
                ("useFormField should be used within <FormField>"). */}
            <div className="space-y-2">
              <label className="text-sm font-medium leading-none">Record Type</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => switchRecordType("Certificate")}
                  className={`flex items-start gap-2 rounded-md border p-3 text-left transition-colors ${
                    !isAudit ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-muted"
                  }`}
                >
                  <FileCheck2 className={`h-4 w-4 mt-0.5 shrink-0 ${!isAudit ? "text-primary" : "text-muted-foreground"}`} />
                  <span>
                    <span className="block text-sm font-medium">Certificate on file</span>
                    <span className="block text-[11px] text-muted-foreground leading-tight mt-0.5">License, GMP/FDA cert, CoA, insurance</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => switchRecordType("Audit")}
                  className={`flex items-start gap-2 rounded-md border p-3 text-left transition-colors ${
                    isAudit ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-muted"
                  }`}
                >
                  <ClipboardCheck className={`h-4 w-4 mt-0.5 shrink-0 ${isAudit ? "text-primary" : "text-muted-foreground"}`} />
                  <span>
                    <span className="block text-sm font-medium">Audit / Assessment</span>
                    <span className="block text-[11px] text-muted-foreground leading-tight mt-0.5">Risk, findings, Pass/Fail outcome</span>
                  </span>
                </button>
              </div>
            </div>

            <FormField control={form.control} name="supplierId" render={({ field }) => (
              <FormItem>
                <FormLabel>Supplier *</FormLabel>
                <Select onValueChange={(v) => field.onChange(parseInt(v))} value={field.value ? String(field.value) : ""}>
                  <FormControl><SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger></FormControl>
                  <SelectContent>
                    {suppliers.map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>{s.supplierName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />

            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="qualificationType" render={({ field }) => (
                <FormItem>
                  <FormLabel>{isAudit ? "Audit Type *" : "Certificate Type *"}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder={isAudit ? "Select audit type" : "Select certificate"} /></SelectTrigger></FormControl>
                    <SelectContent>
                      {(isAudit ? AUDIT_TYPES : CERT_TYPES).map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              {/* Risk level is an audit concept only. */}
              {isAudit && (
                <FormField control={form.control} name="riskLevel" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Risk Level</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {RISK_LEVELS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              )}
            </div>

            {/* Certificate metadata — the heart of a Certificate record. Shown
                for both types (an audit can attach a resulting certificate too),
                but leads the form in Certificate mode. */}
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="issuer" render={({ field }) => (
                <FormItem>
                  <FormLabel>{isAudit ? "Issuer" : "Issuer *"}</FormLabel>
                  <FormControl><Input placeholder="e.g. Michigan CRA, FDA, ISO registrar, lab" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="certificateNumber" render={({ field }) => (
                <FormItem>
                  <FormLabel>Certificate / License #</FormLabel>
                  <FormControl><Input placeholder="e.g. AU-P-000123" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            {isAudit && (
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="assessorName" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Lead Assessor</FormLabel>
                    <FormControl><Input placeholder="Quality Manager" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="assessmentDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Assessment Date</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
            )}

            <FormField control={form.control} name="expiryDate" render={({ field }) => (
              <FormItem>
                <FormLabel>{isAudit ? "Qualification Expiry Date" : "Certificate Expiry Date *"}</FormLabel>
                <FormControl><Input type="date" {...field} className="max-w-[200px]" /></FormControl>
                <p className="text-[10px] text-muted-foreground mt-1">Drives this supplier's next re-check — the earliest expiry across their current certificates wins.</p>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="notes" render={({ field }) => (
              <FormItem>
                <FormLabel>Notes</FormLabel>
                <FormControl><Textarea placeholder={isAudit ? "Scope, criteria, context…" : "Scope of the certificate, coverage, context…"} rows={3} {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <p className="text-[11px] text-muted-foreground">
              {isAudit
                ? "After saving, record findings and the Pass/Fail outcome on the record, and attach audit evidence."
                : "After saving, attach the actual certificate file (PDF/scan) on the record."}
            </p>

            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Saving…" : "Add Record"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
