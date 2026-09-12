import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getListIncomingInspectionsQueryKey, useGetCurrentUser, useListUsers, useListSuppliers } from "@workspace/api-client-react";

const schema = z.object({
  inspectionDate: z.string().min(1, "Required"),
  poManifestNumber: z.string().min(1, "PO / Manifest # is required"),
  result: z.string().optional(),
  // Session 97 (cross-linking Slice 1) — supplier is now stored as a real FK.
  // supplierId carries the suppliers.id (string in the form, coerced to int on
  // submit); supplierName mirrors it for display + the risk-score name fallback,
  // exactly like inspectedBy / inspectedByName.
  supplierId: z.string().optional(),
  supplierName: z.string().optional(),
  // Session 58 — Inspector is now a strict user-id picker (mirrors S54 NC
  // "Reported By"). inspectedBy carries the user id (as a string in the form,
  // coerced to int on submit); inspectedByName mirrors it for display and for
  // the close gate's name fallback.
  inspectedBy: z.string().optional(),
  inspectedByName: z.string().optional(),
  inspectionNotes: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

// Feedback 07-05 (SUP-2) — Incoming Inspections are for materials that directly
// impact the product (cannabis inputs, raw materials, product-contact
// packaging). Equipment / Service / Lab / Other vendors are excluded so users
// don't open inspections for HVAC, pest control, ovens, spatulas, etc. Mirrors
// PRODUCT_MATERIAL_SUPPLIER_TYPES on the server (suppliers.ts), which also
// enforces this on create.
const PRODUCT_MATERIAL_SUPPLIER_TYPES = new Set([
  "Cannabis Cultivator",
  "Cannabis Processor",
  "Raw Material Supplier",
  "Packaging Supplier",
]);

export function CreateInspectionDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  // Local YYYY-MM-DD. Was new Date().toISOString() (UTC), which pre-filled
  // TOMORROW's date in the evening (Eastern) — the date-only off-by-one.
  const today = new Date().toLocaleDateString("en-CA");
  // Session 58 — default the Inspector to the signed-in user, and offer the
  // full active-user list as the picker source.
  const { data: currentUser } = useGetCurrentUser();
  const { data: usersData = [] } = useListUsers();
  // Supplier is now a strict picker from APPROVED suppliers (not free text), so
  // an inspection is tied to a real qualified vendor and its results can feed
  // that supplier's risk score / history. (Full FK link is a follow-up.)
  const { data: suppliersData = [] } = useListSuppliers();
  // Feedback 07-05 (SUP-2) — only approved suppliers that provide product-
  // impacting materials appear here; equipment/service/lab/other vendors are
  // excluded (server enforces the same rule on create).
  const approvedSuppliers = suppliersData.filter(
    (s) => s.status === "Approved" && PRODUCT_MATERIAL_SUPPLIER_TYPES.has(s.supplierType ?? ""),
  );
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { inspectionDate: today, result: "Pending", supplierId: "", supplierName: "", poManifestNumber: "", inspectedBy: "", inspectedByName: "", inspectionNotes: "" },
  });

  // Seed the Inspector with the current user each time the dialog opens.
  useEffect(() => {
    if (open) {
      form.setValue("inspectedBy", currentUser?.id != null ? String(currentUser.id) : "");
      form.setValue("inspectedByName", currentUser?.fullName ?? "");
    }
  }, [open, currentUser?.id, currentUser?.fullName, form]);

  async function onSubmit(values: FormValues) {
    setError(null);
    // Default new inspections to Pending so the Operator can finish line items
    // later and advance state from the detail page.
    const payload: Record<string, unknown> = { ...values, result: values.result || "Pending" };
    // Session 58 — inspectedBy is carried as a string in the form; the route +
    // column expect an integer. Coerce here (drop if not numeric).
    if (typeof payload.inspectedBy === "string") {
      const n = Number(payload.inspectedBy);
      if (payload.inspectedBy.trim() !== "" && Number.isFinite(n)) payload.inspectedBy = n;
      else delete payload.inspectedBy;
    }
    // Session 97 (Slice 1) — same coercion for the supplier FK; drop it if the
    // user left the picker empty so the column stays null rather than NaN.
    if (typeof payload.supplierId === "string") {
      const n = Number(payload.supplierId);
      if (payload.supplierId.trim() !== "" && Number.isFinite(n)) payload.supplierId = n;
      else delete payload.supplierId;
    }
    const res = await fetch("/api/incoming-inspections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const created = await res.json().catch(() => ({} as { id?: number }));
      await queryClient.invalidateQueries({ queryKey: getListIncomingInspectionsQueryKey() });
      setOpen(false);
      form.reset();
      // Go straight to the new inspection with the add-line-item dialog open —
      // the next thing a user always does is add the received items.
      if (created?.id) setLocation(`/inspections/${created.id}?addItem=1`);
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to create inspection");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { form.reset(); setError(null); } }}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="h-4 w-4 mr-1" />New Inspection</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Incoming Inspection</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="poManifestNumber" render={({ field }) => (
                <FormItem>
                  <FormLabel>PO / Manifest # *</FormLabel>
                  <FormControl><Input placeholder="MAN-2025-0041" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="inspectionDate" render={({ field }) => (
                <FormItem>
                  <FormLabel>Inspection Date *</FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <p className="text-xs text-muted-foreground">
              Inspection will be created in <strong>Pending</strong> state — you can fill in line items and advance to Pass / Fail from the detail screen.
            </p>
            <FormField control={form.control} name="supplierId" render={({ field }) => (
              <FormItem>
                <FormLabel>Supplier</FormLabel>
                <Select
                  value={field.value ?? ""}
                  onValueChange={(v) => {
                    field.onChange(v);
                    form.setValue("supplierName", approvedSuppliers.find((s) => String(s.id) === v)?.supplierName ?? "");
                  }}
                >
                  <FormControl>
                    <SelectTrigger><SelectValue placeholder="Select an approved supplier…" /></SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {approvedSuppliers.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">No approved material suppliers yet — add a cannabis, raw material, or packaging supplier under Suppliers.</div>
                    ) : (
                      approvedSuppliers.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          {s.supplierName}{s.supplierType ? ` · ${s.supplierType}` : ""}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground mt-0.5">Only approved suppliers of product-impacting materials (cannabis inputs, raw materials, packaging) appear here — equipment &amp; service vendors are excluded.</p>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="inspectedBy" render={({ field }) => (
              <FormItem>
                <FormLabel>Inspector</FormLabel>
                <Select
                  value={field.value ?? ""}
                  onValueChange={(v) => {
                    field.onChange(v);
                    form.setValue("inspectedByName", usersData.find((u) => String(u.id) === v)?.fullName ?? "");
                  }}
                >
                  <FormControl>
                    <SelectTrigger><SelectValue placeholder="Select inspector…" /></SelectTrigger>
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
                <p className="text-[10px] text-muted-foreground mt-0.5">Only this person can close the inspection (21 CFR Part 11).</p>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="inspectionNotes" render={({ field }) => (
              <FormItem>
                <FormLabel>Inspection Notes</FormLabel>
                <FormControl><Textarea placeholder="Describe materials received, any observations..." rows={3} {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Creating..." : "Create Inspection"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
