import { useState, useEffect } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PRODUCT_TYPES_WITH_OTHER } from "@/lib/productTypes";
import { BOM_KINDS, BOM_KIND_LABELS } from "@/lib/units";
import { getListBatchRecordsQueryKey } from "@workspace/api-client-react";

// Session 36 — process_type discriminator. Drives which fields the Batch UI
// surfaces and which regulatory rules apply (cultivation REI/PHI vs kitchen
// allergen carryover vs inhalant solvent residue etc.). Full per-type field
// sets are deferred to Tier 7 C2/C3; this dialog only captures the
// discriminator so downstream code can branch on it.
const PROCESS_TYPES = ["Cultivation", "Kitchen", "Inhalants", "Pre-roll"] as const;

// Session 63 — recipe drives the batch's process_type. Recipes carry a
// productType (the Recipes page list); map it onto the batch process_type
// discriminator so a Concentrate/Vape recipe doesn't open under the Kitchen
// default. Operator can still override the dropdown afterward. Anything not
// listed (Tincture/Topical/Capsule/Other) is processed work → Kitchen GMP.
const PRODUCT_TYPE_TO_PROCESS_TYPE: Record<string, (typeof PROCESS_TYPES)[number]> = {
  "Flower": "Cultivation",
  "Concentrate": "Inhalants",
  "Vape Cartridge": "Inhalants",
  "Dual Chamber Vape Cartridge": "Inhalants",
  "Pre-Roll": "Pre-roll",
  // Session 82 — infused pre-rolls assemble like pre-rolls but are concentrates
  // for testing/labeling (routed by productType); process_type stays Pre-roll.
  "Infused Pre-Roll": "Pre-roll",
};
function processTypeForProductType(productType: string | undefined): (typeof PROCESS_TYPES)[number] {
  return PRODUCT_TYPE_TO_PROCESS_TYPE[(productType ?? "").trim()] ?? "Kitchen";
}

// Session 45 — inline planned-ingredient row. Operator can list a bill of
// materials at batch open when no recipe is selected. Rows with a blank
// ingredient name are filtered out before POST (the server also drops them
// defensively in normalizePlannedIngredients).
const ingredientRowSchema = z.object({
  ingredientName: z.string().optional(),
  plannedQuantity: z.coerce.number().positive("Must be > 0").optional().or(z.literal("")),
  unitOfMeasure: z.string().default("g"),
  kind: z.enum(BOM_KINDS).default("Ingredient"),
});

const schema = z.object({
  productName: z.string().min(1, "Required"),
  productType: z.string().min(1, "Required"),
  batchType: z.string().min(1, "Required"),
  processType: z.enum(PROCESS_TYPES, { errorMap: () => ({ message: "Required" }) }),
  // Distribution channel — drives the labeling control set (consumer label vs
  // bulk/wholesale transfer label). Defaults Retail.
  saleType: z.string().default("Retail"),
  strainName: z.string().optional(),
  strainType: z.string().optional(),
  // Session 38 (Tier 4 #19) — scheduled output at batch open. Drives the
  // Production Output chart's planned-vs-actual variance overlay on the
  // Dashboard Operations section and the variance % display on BatchDetail.
  scheduledOutputQuantity: z.coerce.number().positive("Must be positive").optional().or(z.literal("")),
  outputQuantity: z.coerce.number().int("Whole number only").positive("Must be positive").optional().or(z.literal("")),
  unitOfMeasure: z.string().optional(),
  productionDate: z.string().optional(),
  notes: z.string().optional(),
  recipeId: z.string().optional(),
  plannedIngredients: z.array(ingredientRowSchema).optional(),
});

type FormValues = z.infer<typeof schema>;

type RecipeOption = {
  id: number; productName: string; productType: string; version: number; isActive: boolean;
  // 2026-09-07 — recipe release control. `released` is derived server-side from
  // the linked work instruction being Effective; `releaseBlockedReason` says why
  // not, in words meant for the operator.
  released?: boolean;
  releaseBlockedReason?: string | null;
};

// Session 76.3 (OQ DEV-3) — openable from the recipe page's "Start Batch"
// button: controllable (open/onOpenChange/hideTrigger) and pre-fillable with a
// recipe (initialRecipeId). With no props it behaves exactly as before.
type CreateBatchDialogProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  initialRecipeId?: number;
};

export function CreateBatchDialog({ open: openProp, onOpenChange, hideTrigger, initialRecipeId }: CreateBatchDialogProps = {}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => { if (onOpenChange) onOpenChange(v); else setOpenState(v); };
  const [error, setError] = useState<string | null>(null);
  // Strain auto-fills from the product name (recipe product name too) to avoid
  // double entry — but stop mirroring once the operator edits strain by hand.
  const [strainEdited, setStrainEdited] = useState(false);
  const queryClient = useQueryClient();

  const { data: recipes } = useQuery<RecipeOption[]>({
    queryKey: ["/api/recipes"],
    queryFn: async () => (await fetch("/api/recipes")).json(),
    enabled: open,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      productName: "",
      productType: "",
      batchType: "",
      processType: "Kitchen",
      saleType: "Retail",
      strainName: "",
      strainType: "",
      unitOfMeasure: "g",
      scheduledOutputQuantity: "",
      notes: "",
      recipeId: "",
      plannedIngredients: [],
    },
  });

  // Session 45 — inline BOM editor. useFieldArray drives the add/remove rows.
  // The section is hidden when a recipe is selected (recipe is the source of
  // truth in that flow; the server's POST handler ignores plannedIngredients
  // when recipeId is set, but the UI hides the section too to make the
  // mutual-exclusion obvious to the operator).
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "plannedIngredients" });
  const recipeId = form.watch("recipeId");
  const showBom = !recipeId;

  function applyRecipe(recipeId: string) {
    form.setValue("recipeId", recipeId);
    if (!recipeId) return;
    const r = recipes?.find(x => String(x.id) === recipeId);
    if (r) {
      if (!form.getValues("productName")) form.setValue("productName", r.productName);
      if (!form.getValues("productType")) form.setValue("productType", r.productType);
      // Mirror the recipe product name into strain unless the operator edited it.
      if (!strainEdited) form.setValue("strainName", r.productName);
      // Session 63 — recipe is the source of truth for the process type too.
      // Set it from the recipe's productType (e.g. Concentrate → Inhalants) so
      // concentrate batches stop defaulting to Kitchen. Still editable below.
      form.setValue("processType", processTypeForProductType(r.productType));
      // Clear any inline rows the operator entered before picking a recipe —
      // recipe is now the source of truth.
      form.setValue("plannedIngredients", []);
    }
  }

  // Session 76.3 (OQ DEV-3) — when launched from a recipe's "Start Batch"
  // button, pre-select and apply that recipe once the recipe list has loaded.
  const [appliedInitialRecipe, setAppliedInitialRecipe] = useState(false);
  useEffect(() => {
    if (!open) { setAppliedInitialRecipe(false); return; }
    if (initialRecipeId && recipes && recipes.length > 0 && !appliedInitialRecipe) {
      applyRecipe(String(initialRecipeId));
      setAppliedInitialRecipe(true);
    }
    // applyRecipe is stable enough for this one-shot prefill; deps kept minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recipes, initialRecipeId, appliedInitialRecipe]);

  async function onSubmit(values: FormValues) {
    setError(null);
    // Drop rows with no ingredient name. The server filters too but doing it
    // here keeps the payload clean and the operator's intent obvious in the
    // network tab.
    const cleanBom = (values.plannedIngredients ?? [])
      .filter((r) => (r.ingredientName ?? "").trim().length > 0)
      .map((r) => ({
        ingredientName: (r.ingredientName ?? "").trim(),
        plannedQuantity: r.plannedQuantity === "" ? null : r.plannedQuantity,
        unitOfMeasure: r.unitOfMeasure || "g",
        kind: r.kind || "Ingredient",
      }));
    const body = {
      ...values,
      outputQuantity: values.outputQuantity === "" ? undefined : values.outputQuantity,
      scheduledOutputQuantity: values.scheduledOutputQuantity === "" ? undefined : values.scheduledOutputQuantity,
      recipeId: values.recipeId ? parseInt(values.recipeId) : undefined,
      plannedIngredients: values.recipeId ? undefined : cleanBom,
    };
    const res = await fetch("/api/batch-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: getListBatchRecordsQueryKey() });
      setOpen(false);
      form.reset();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to create batch");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { form.reset(); setError(null); setStrainEdited(false); } }}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button size="sm"><Plus className="h-4 w-4 mr-1" />New Batch</Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Batch Record</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="recipeId" render={({ field }) => (
              <FormItem>
                <FormLabel>Recipe (optional — auto-fills planned ingredients)</FormLabel>
                <Select onValueChange={applyRecipe} value={field.value ?? ""}>
                  <FormControl><SelectTrigger><SelectValue placeholder="No recipe — enter ingredients manually" /></SelectTrigger></FormControl>
                  <SelectContent>
                    {/* 2026-09-07 — an unreleased recipe stays VISIBLE but is
                        disabled and says why. Hiding it would read as the recipe
                        having disappeared; the point of change control is that
                        the operator can see the procedure exists and is not yet
                        in force. */}
                    {(recipes ?? []).filter(r => r.isActive).map(r => {
                      const blocked = r.released === false;
                      return (
                        <SelectItem key={r.id} value={String(r.id)} disabled={blocked}>
                          {r.productName} (v{r.version}) — {r.productType}
                          {blocked && <span className="ml-1 text-muted-foreground">· not released</span>}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                {(recipes ?? []).some(r => r.isActive && r.released === false) && (
                  <p className="text-[11px] text-muted-foreground">
                    Greyed-out recipes are not released. A recipe comes into force when its linked work instruction becomes Effective.
                  </p>
                )}
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="productName" render={({ field }) => (
              <FormItem>
                <FormLabel>Product Name *</FormLabel>
                <FormControl><Input placeholder="Blue Dream Vape Cartridge" {...field} onChange={(e) => { field.onChange(e); if (!strainEdited) form.setValue("strainName", e.target.value); }} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="productType" render={({ field }) => (
                <FormItem>
                  <FormLabel>Product Type *</FormLabel>
                  {/* Session 76.1 — picking a product type also routes the
                      process type (Concentrate / Vape → Inhalants, Pre-Roll →
                      Pre-roll, else Kitchen) so a concentrate batch opened
                      WITHOUT a recipe no longer defaults to Kitchen. Mirrors the
                      recipe path in applyRecipe(). Operator can still override
                      the Process Type dropdown below. */}
                  <Select
                    onValueChange={(v) => { field.onChange(v); form.setValue("processType", processTypeForProductType(v)); }}
                    value={field.value}
                  >
                    <FormControl><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {PRODUCT_TYPES_WITH_OTHER.map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="batchType" render={({ field }) => (
                <FormItem>
                  <FormLabel>Batch Type *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="Production">Production</SelectItem>
                      <SelectItem value="Remediation">Remediation</SelectItem>
                      <SelectItem value="Rework">Rework</SelectItem>
                      <SelectItem value="Pilot">Pilot</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            {/* Session 36 — process_type discriminator. Defaults to Kitchen
                (most edibles/concentrate work). Picking Cultivation routes
                this batch into the cultivation-specific UI variant (lands in
                Tier 7 C2). */}
            <FormField control={form.control} name="processType" render={({ field }) => (
              <FormItem>
                <FormLabel>Process Type *</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="Cultivation">Cultivation — clones, veg/flower, harvest</SelectItem>
                    <SelectItem value="Kitchen">Kitchen — edibles, gummies, chocolates</SelectItem>
                    <SelectItem value="Inhalants">Inhalants — carts, concentrates</SelectItem>
                    <SelectItem value="Pre-roll">Pre-roll — flower, papers, tips</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">Drives which fields the Batch UI surfaces and which regulatory rules apply.</p>
                <FormMessage />
              </FormItem>
            )} />
            {/* Distribution channel — selects the labeling control set. A
                retail-ready batch gets the consumer label checklist for its
                product type; a bulk/wholesale batch gets the transfer/manifest
                checklist (source lot, total weight, license #s) instead. */}
            <FormField control={form.control} name="saleType" render={({ field }) => (
              <FormItem>
                <FormLabel>Sale Type *</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="Retail">Retail-ready — consumer product</SelectItem>
                    <SelectItem value="Bulk">Bulk / Wholesale — transfer to another licensee</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">Retail-ready uses the consumer label checklist; Bulk/Wholesale uses the transfer (manifest) label checklist.</p>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="strainName" render={({ field }) => (
              <FormItem>
                <FormLabel>Strain Name / Flavor</FormLabel>
                <FormControl><Input placeholder="Blue Dream / Berry" {...field} onChange={(e) => { setStrainEdited(true); field.onChange(e); }} /></FormControl>
                <p className="text-xs text-muted-foreground mt-1">Auto-filled from the product name — edit only if the strain differs. Prints on the label and drives recall (complaint) matching.</p>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="strainType" render={({ field }) => (
              <FormItem>
                <FormLabel>Strain Type</FormLabel>
                <Select value={field.value ?? ""} onValueChange={field.onChange}>
                  <FormControl><SelectTrigger><SelectValue placeholder="Sativa / Indica / Hybrid (optional)" /></SelectTrigger></FormControl>
                  <SelectContent>
                    {["Sativa", "Indica", "Hybrid"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            {/* 2026-08-19 — the METRC tag field was REMOVED from this dialog.
                It used to be typed here, unsigned, by whoever opened the batch,
                and was stored verbatim with nothing checking that METRC had ever
                issued it — which is how a batch reached Released carrying 100
                cartridges the state had never heard of. The tag now enters
                through the required "Assign METRC package" process step, where
                signing it creates the package in METRC and promotes the tag to
                the batch number. A batch opens on a provisional PENDING-######
                number, which is what lets a supervisor plan a week of production
                before any cannabis has been combined. */}
            <div className="grid grid-cols-3 gap-3">
              {/* Session 38 (Tier 4 #19) — scheduled output captured at batch
                  open so the Production Output chart can show planned vs.
                  actual once the actual is recorded. */}
              <FormField control={form.control} name="scheduledOutputQuantity" render={({ field }) => (
                <FormItem>
                  <FormLabel>Scheduled Output</FormLabel>
                  <FormControl><Input type="number" step="0.01" min="0" placeholder="250" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="outputQuantity" render={({ field }) => (
                <FormItem>
                  <FormLabel>Actual Output</FormLabel>
                  <FormControl><Input type="number" step="1" min="0" placeholder="(record at close)" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="unitOfMeasure" render={({ field }) => (
                <FormItem>
                  <FormLabel>Unit</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="g">g</SelectItem>
                      <SelectItem value="mg">mg</SelectItem>
                      <SelectItem value="units">units</SelectItem>
                      <SelectItem value="mL">mL</SelectItem>
                      <SelectItem value="oz">oz</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <FormField control={form.control} name="productionDate" render={({ field }) => (
              <FormItem>
                <FormLabel>Production Date</FormLabel>
                <FormControl>
                  <DatePicker value={field.value ?? ""} onChange={field.onChange} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />
            {/* Session 45 — inline BOM editor. Visible only when no recipe is
                selected. Operators can record planned ingredients (and packaging
                materials) at batch open instead of having to create the batch
                first and add rows one-by-one on the detail page. Server seeds
                these into batch_ingredients in the same transaction as the new
                batch insert. */}
            {showBom && (
              <div className="border rounded-md p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Planned Ingredients (BOM)</p>
                    <p className="text-xs text-muted-foreground">Optional — list planned ingredients now or add them on the batch detail page.</p>
                  </div>
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => append({ ingredientName: "", plannedQuantity: "", unitOfMeasure: "g", kind: "Ingredient" })}>
                    <Plus className="h-3 w-3 mr-1" />Add row
                  </Button>
                </div>
                {fields.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No rows. Click "Add row" or pick a recipe above.</p>
                ) : (
                  <div className="space-y-2">
                    {fields.map((field, idx) => (
                      <div key={field.id} className="grid grid-cols-[2fr_1fr_80px_1fr_auto] gap-2 items-start">
                        <FormField control={form.control} name={`plannedIngredients.${idx}.ingredientName`} render={({ field: f }) => (
                          <FormItem>
                            <FormControl><Input placeholder="Distillate" {...f} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <FormField control={form.control} name={`plannedIngredients.${idx}.plannedQuantity`} render={({ field: f }) => (
                          <FormItem>
                            <FormControl><Input type="number" step="0.01" min="0" placeholder="Qty" {...f} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <FormField control={form.control} name={`plannedIngredients.${idx}.unitOfMeasure`} render={({ field: f }) => (
                          <FormItem>
                            <Select onValueChange={f.onChange} value={f.value}>
                              <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                              <SelectContent>
                                <SelectItem value="g">g</SelectItem>
                                <SelectItem value="mg">mg</SelectItem>
                                <SelectItem value="units">units</SelectItem>
                                <SelectItem value="mL">mL</SelectItem>
                                <SelectItem value="oz">oz</SelectItem>
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )} />
                        <FormField control={form.control} name={`plannedIngredients.${idx}.kind`} render={({ field: f }) => (
                          <FormItem>
                            <Select onValueChange={f.onChange} value={f.value}>
                              <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                              <SelectContent>
                                {BOM_KINDS.map((k) => <SelectItem key={k} value={k}>{BOM_KIND_LABELS[k]}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )} />
                        <Button type="button" variant="ghost" size="icon" onClick={() => remove(idx)} aria-label="Remove row">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <FormField control={form.control} name="notes" render={({ field }) => (
              <FormItem>
                <FormLabel>Notes</FormLabel>
                <FormControl><Textarea placeholder="Any relevant notes..." rows={2} {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Creating..." : "Create Batch"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
