import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getListSuppliersQueryKey } from "@workspace/api-client-react";

// Session 33 (Tier 2 #9) — riskTierRationale is required at supplier add.
// The server enforces this too; the client validation is for fast feedback.
const schema = z.object({
  supplierName: z.string().min(1, "Required"),
  supplierType: z.string().min(1, "Required"),
  contactPerson: z.string().optional(),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().optional(),
  licenseNumber: z.string().optional(),
  status: z.string().default("Pending Review"),
  riskTier: z.string().default("Medium"),
  riskTierRationale: z.string().min(1, "Rationale required — document why you chose this tier."),
});

type FormValues = z.infer<typeof schema>;

export function CreateSupplierDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { supplierName: "", supplierType: "", contactPerson: "", email: "", phone: "", licenseNumber: "", status: "Pending Review", riskTier: "Medium", riskTierRationale: "" },
  });

  async function onSubmit(values: FormValues) {
    setError(null);
    const body = { ...values, email: values.email || undefined };
    const res = await fetch("/api/suppliers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
      setOpen(false);
      form.reset();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to create supplier");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { form.reset(); setError(null); } }}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="h-4 w-4 mr-1" />New Supplier</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Supplier</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="supplierName" render={({ field }) => (
              <FormItem>
                <FormLabel>Supplier Name *</FormLabel>
                <FormControl><Input placeholder="Green Valley Cannabis Co." {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="supplierType" render={({ field }) => (
              <FormItem>
                <FormLabel>Type *</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl><SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="Cannabis Cultivator">Cannabis Cultivator</SelectItem>
                    <SelectItem value="Cannabis Processor">Cannabis Processor</SelectItem>
                    <SelectItem value="Packaging Supplier">Packaging Supplier</SelectItem>
                    <SelectItem value="Testing Laboratory">Testing Laboratory</SelectItem>
                    <SelectItem value="Equipment Supplier">Equipment Supplier</SelectItem>
                    <SelectItem value="Raw Material Supplier">Raw Material Supplier</SelectItem>
                    {/* Feedback 07-05 (SUP-1) — pest control, HVAC repair, cleaning, etc. */}
                    <SelectItem value="Service Supplier">Service Supplier</SelectItem>
                    <SelectItem value="Other">Other</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="contactPerson" render={({ field }) => (
                <FormItem>
                  <FormLabel>Contact Person</FormLabel>
                  <FormControl><Input placeholder="Jane Smith" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="status" render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="Approved">Approved</SelectItem>
                      <SelectItem value="Pending Review">Pending Review</SelectItem>
                      <SelectItem value="License Pending">License Pending</SelectItem>
                      <SelectItem value="Conditional">Conditional</SelectItem>
                      <SelectItem value="Disqualified">Disqualified</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <FormField control={form.control} name="riskTier" render={({ field }) => (
              <FormItem>
                <FormLabel>Risk Tier *</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="Low">Low — established, FDA-listed / known good</SelectItem>
                    <SelectItem value="Medium">Medium — standard food/packaging vendor</SelectItem>
                    <SelectItem value="High">High — new or limited history</SelectItem>
                    <SelectItem value="Critical">Critical — direct contact with cannabis input</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">Operator-set. Cannabis isn't ISO 13485-bound, so the system honors your selection rather than auto-flagging unqualified vendors as Medium.</p>
                <FormMessage />
              </FormItem>
            )} />
            {/* Session 33 (Tier 2 #9) — rationale documents *why* this tier
                was chosen. Feeds the Track C Risk Memory rationale corpus and
                is required by the server on every tier change too. */}
            <FormField control={form.control} name="riskTierRationale" render={({ field }) => (
              <FormItem>
                <FormLabel>Risk Tier rationale *</FormLabel>
                <FormControl>
                  <Textarea
                    rows={2}
                    placeholder="Why this tier? e.g. 'New supplier, no Michigan track record yet — High until first qualification cycle completes.'"
                    {...field}
                  />
                </FormControl>
                <p className="text-xs text-muted-foreground mt-1">Required for every new supplier and every later tier change. Captured to the audit trail.</p>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="email" render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl><Input type="email" placeholder="contact@supplier.com" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="phone" render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone</FormLabel>
                  <FormControl><Input placeholder="(555) 000-0000" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <FormField control={form.control} name="licenseNumber" render={({ field }) => (
              <FormItem>
                <FormLabel>License Number <span className="text-muted-foreground font-normal">(for cannabis suppliers only)</span></FormLabel>
                <FormControl><Input placeholder="MICL-000000" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Creating..." : "Create Supplier"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
