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
import { getListTrainingQueryKey } from "@workspace/api-client-react";
import { TrainingTypePicker } from "@/components/training/TrainingTypePicker";
import { SUPERVISION_TYPE } from "@/lib/trainingTypes";

const schema = z.object({
  employeeName: z.string().min(1, "Required"),
  employeeId: z.string().optional(),
  department: z.string().optional(),
  trainingType: z.string().min(1, "Required"),
  topic: z.string().min(1, "Required"),
  description: z.string().optional(),
  documentReference: z.string().optional(),
  trainerName: z.string().optional(),
  assignedDate: z.string().min(1, "Required"),
  dueDate: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

const DEPARTMENTS = [
  "Production",
  "Quality",
  "Compliance",
  "Packaging",
  "Lab / Testing",
  "Inventory",
  "Management",
  "Other",
];

export function CreateTrainingDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supervisedTaskQty, setSupervisedTaskQty] = useState("");
  const queryClient = useQueryClient();

  const today = new Date().toLocaleDateString("en-CA");
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      employeeName: "",
      employeeId: "",
      department: "",
      trainingType: "",
      topic: "",
      description: "",
      documentReference: "",
      trainerName: "",
      assignedDate: today,
      dueDate: "",
    },
  });

  const showQty = (form.watch("trainingType") ?? "").split(", ").includes(SUPERVISION_TYPE);

  async function onSubmit(values: FormValues) {
    setError(null);
    const res = await fetch("/api/training", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...values,
        supervisedTaskQty: showQty && supervisedTaskQty !== "" ? Number(supervisedTaskQty) : undefined,
      }),
    });
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: getListTrainingQueryKey() });
      setOpen(false);
      setSupervisedTaskQty("");
      form.reset({ assignedDate: today });
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to create training record");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          form.reset({ assignedDate: today });
          setSupervisedTaskQty("");
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="h-4 w-4 mr-1" />
          Record Individual Training
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record Individual Training</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="employeeName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Employee Name *</FormLabel>
                    <FormControl>
                      <Input placeholder="Jane Smith" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="employeeId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Employee ID</FormLabel>
                    <FormControl>
                      <Input placeholder="EMP-001" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="department"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Department</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {DEPARTMENTS.map((d) => (
                        <SelectItem key={d} value={d}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="trainingType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Training Type *</FormLabel>
                  <FormControl>
                    <TrainingTypePicker
                      value={field.value ? field.value.split(", ").filter(Boolean) : []}
                      onChange={(next) => field.onChange(next.join(", "))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {showQty && (
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none">Tasks observed (quantity)</label>
                <Input
                  type="number"
                  min={0}
                  value={supervisedTaskQty}
                  onChange={(e) => setSupervisedTaskQty(e.target.value)}
                  placeholder="e.g. 3"
                />
              </div>
            )}

            <FormField
              control={form.control}
              name="topic"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Training Topic *</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. SOP-012 Pesticide Testing Procedure" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="documentReference"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Document Reference</FormLabel>
                    <FormControl>
                      <Input placeholder="SOP-012 Rev 3" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="trainerName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Trainer / Assessor</FormLabel>
                    <FormControl>
                      <Input placeholder="John Doe" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="assignedDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Assigned Date *</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="dueDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Due Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Purpose</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="What will be covered, learning objectives…"
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Creating…" : "Create Record"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
