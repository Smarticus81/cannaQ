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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getListDocumentsQueryKey } from "@workspace/api-client-react";
import { DepartmentPicker } from "@/components/DepartmentPicker";

const schema = z.object({
  title: z.string().min(1, "Required"),
  documentType: z.string().min(1, "Required"),
  appliesTo: z.enum(["corporate", "facility"]),
  departments: z.array(z.string()).optional(),
  ownerName: z.string().optional(),
  description: z.string().optional(),
  scope: z.string().optional(),
  reviewIntervalYears: z.string().optional(),
  createdByName: z.string().optional(),
});

const REVIEW_INTERVALS = [1, 2, 3];

type FormValues = z.infer<typeof schema>;

// Which document types belong to ONE plant rather than the whole company. His
// ruling 08-27: "Corporate documents go to each state" — an SOP is written once and
// every site works to it, while a Work Instruction is how this plant does the job.
// Only a PRE-PICK; the author can change it. Biased towards corporate on purpose:
// a document everyone can see beats one a plant cannot find.
const FACILITY_LOCAL_TYPES = new Set(["Work Instruction", "Report"]);

const DOC_TYPES = [
  "SOP",
  "Work Instruction",
  "Form",
  "Policy",
  "Specification",
  "Protocol",
  "Report",
  "Other",
];

export function CreateDocumentDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: "",
      documentType: "",
      appliesTo: "corporate",
      departments: [],
      ownerName: "",
      description: "",
      scope: "",
      reviewIntervalYears: "3",
      createdByName: "",
    },
  });

  async function onSubmit(values: FormValues) {
    setError(null);
    const payload = {
      ...values,
      reviewIntervalYears: Math.max(1, parseInt(values.reviewIntervalYears || "3", 10) || 3),
    };
    const res = await fetch("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
      setOpen(false);
      form.reset();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to create document");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) { form.reset(); setError(null); }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4 mr-1" />
          New Document
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Controlled Document</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="title" render={({ field }) => (
              <FormItem>
                <FormLabel>Document Title *</FormLabel>
                <FormControl><Input placeholder="e.g. Pesticide Testing Procedure" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="documentType" render={({ field }) => (
                <FormItem>
                  <FormLabel>Document Type *</FormLabel>
                  <Select
                    onValueChange={(v) => {
                      field.onChange(v);
                      // Move the corporate/facility pick to match the type the author
                      // just chose. It stays editable — this only saves them a click
                      // in the ordinary case.
                      form.setValue("appliesTo", FACILITY_LOCAL_TYPES.has(v) ? "facility" : "corporate");
                    }}
                    value={field.value}
                  >
                    <FormControl><SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {DOC_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />

              {/* Corporate or local. A corporate document is written once and every
                  site works to it; a facility document belongs to this plant only.
                  Kept as a plain choice rather than derived from the type, because
                  the type is a guess and this is a decision. */}
              <FormField control={form.control} name="appliesTo" render={({ field }) => (
                <FormItem>
                  <FormLabel>Applies To *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="corporate">The whole company — every facility works to this</SelectItem>
                      <SelectItem value="facility">This facility only</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="reviewIntervalYears" render={({ field }) => (
                <FormItem>
                  <FormLabel>Periodic Review Timeframe</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {REVIEW_INTERVALS.map((y) => (
                        <SelectItem key={y} value={String(y)}>{y} {y === 1 ? "year" : "years"}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <FormField control={form.control} name="departments" render={({ field }) => (
              <FormItem>
                <FormLabel>Department(s)</FormLabel>
                <FormControl>
                  <DepartmentPicker value={field.value ?? []} onChange={field.onChange} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="ownerName" render={({ field }) => (
              <FormItem>
                <FormLabel>Document Owner</FormLabel>
                <FormControl><Input placeholder="Quality Manager" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="scope" render={({ field }) => (
              <FormItem>
                <FormLabel>Scope</FormLabel>
                <FormControl><Input placeholder="e.g. Applies to all extraction and testing staff" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem>
                <FormLabel>Purpose</FormLabel>
                <FormControl><Textarea placeholder="Briefly describe this document's purpose…" rows={3} {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Creating…" : "Create Document"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
