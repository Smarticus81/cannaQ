import { useState, useEffect } from "react";
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
import { getListInventoryItemsQueryKey } from "@workspace/api-client-react";
import { defaultUnitForItemType, dimensionOf, isCloneItemType, ITEM_TYPES, parseItemNameOptions, UNIT_OPTIONS } from "@/lib/units";

const schema = z.object({
  itemName: z.string().min(1, "Required"),
  itemType: z.string().min(1, "Required"),
  unitOfMeasure: z.string().min(1, "Required"),
  lotNumber: z.string().optional(),
  quantity: z.coerce.number().min(0, "Must be 0 or more").default(0),
  reorderPoint: z.coerce.number().min(0).optional().or(z.literal("")),
  notes: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

export function CreateInventoryItemDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Existing item names, to type-ahead away from near-duplicates ("Mouthpiece"
  // vs "Mouthpieces"). Reuses the same canonical name list the receiving form
  // uses (inventory_items + prior-inspection names).
  const [nameOptions, setNameOptions] = useState<string[]>([]);
  // name (lowercased) → the type that name is already set up as.
  const [typeByName, setTypeByName] = useState<Map<string, string>>(new Map());
  // name (lowercased) → the unit that name is already stocked in. Preferred over
  // the type's default: it is this item's own setup, not a category guess.
  const [uomByName, setUomByName] = useState<Map<string, string>>(new Map());
  const [typeWasAutoFilled, setTypeWasAutoFilled] = useState(false);
  // Same ownership question for the unit: one derived from the type is not the
  // operator's choice, so a later type change may replace or clear it.
  const [uomWasAutoFilled, setUomWasAutoFilled] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) return;
    fetch("/api/incoming-inspections/item-name-options", { credentials: "include" })
      .then((r) => r.json())
      .then((payload) => {
        const { names, typeByName: map, uomByName: uoms } = parseItemNameOptions(payload);
        setNameOptions(names);
        setTypeByName(map);
        setUomByName(uoms);
      })
      .catch(() => {});
  }, [open]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { itemName: "", itemType: "", unitOfMeasure: "", lotNumber: "", quantity: 0, notes: "" },
  });

  async function onSubmit(values: FormValues) {
    setError(null);
    const body = { ...values, reorderPoint: values.reorderPoint === "" ? undefined : values.reorderPoint };
    const res = await fetch("/api/inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: getListInventoryItemsQueryKey() });
      setOpen(false);
      form.reset();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to create inventory item");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { form.reset(); setError(null); setTypeWasAutoFilled(false); setUomWasAutoFilled(false); } }}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="h-4 w-4 mr-1" />New Item</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Inventory Item</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="itemName" render={({ field }) => (
              <FormItem>
                <FormLabel>Item Name *</FormLabel>
                {/* A name already in the catalog fills Item Type from how that
                    item is set up — a lookup of what the facility recorded, not
                    a guess. A type the operator picked is never touched; one
                    this fill placed is replaced (or cleared) when the name
                    changes, so correcting a name can't strand the old type. */}
                <FormControl>
                  <Input
                    list="inventory-item-names"
                    placeholder="CO2 Cannabis Extract — Blue Dream"
                    {...field}
                    onChange={(e) => {
                      const name = e.target.value;
                      field.onChange(name);
                      const looked = typeByName.get(name.trim().toLowerCase()) ?? null;
                      const mayReplace = !form.getValues("itemType") || typeWasAutoFilled;
                      if (!mayReplace) return;
                      // The item's own stocked unit wins over the type default:
                      // the catalog says how THIS item is bought, the type only
                      // says what its category usually is.
                      const fill = uomByName.get(name.trim().toLowerCase())
                        ?? (looked ? defaultUnitForItemType(looked) : null);
                      const mayReplaceUom = !form.getValues("unitOfMeasure") || uomWasAutoFilled;
                      form.setValue("itemType", looked ?? "", { shouldValidate: true });
                      if (mayReplaceUom) {
                        // A derived unit is dropped when the new name has no unit
                        // of its own — it belonged to the old item, not this one.
                        if (fill) form.setValue("unitOfMeasure", fill);
                        else if (uomWasAutoFilled) form.setValue("unitOfMeasure", "");
                      }
                      setTypeWasAutoFilled(!!looked);
                      setUomWasAutoFilled(mayReplaceUom && !!fill);
                    }}
                  />
                </FormControl>
                <datalist id="inventory-item-names">
                  {nameOptions.map((n) => <option key={n} value={n} />)}
                </datalist>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="itemType" render={({ field }) => (
                <FormItem>
                  <FormLabel>Item Type *</FormLabel>
                  {/* Session 111 — picking a cannabis type defaults the unit to
                      grams (cannabis is weighed). It fills a unit the operator
                      hasn't chosen, or one this form derived from a previous
                      type, so a deliberate mL never gets stomped. Clones are the
                      exception and default to "each" — see defaultUnitForItemType.
                      The option list is ITEM_TYPES in lib/units, shared with the
                      receiving screen so the two vocabularies cannot drift apart
                      again. */}
                  <Select
                    onValueChange={(v) => {
                      setTypeWasAutoFilled(false);
                      field.onChange(v);
                      const def = defaultUnitForItemType(v);
                      const mayReplaceUom = !form.getValues("unitOfMeasure") || uomWasAutoFilled;
                      if (mayReplaceUom) {
                        if (def) form.setValue("unitOfMeasure", def);
                        else if (uomWasAutoFilled) form.setValue("unitOfMeasure", "");
                      }
                      setUomWasAutoFilled(mayReplaceUom && !!def);
                    }}
                    value={field.value}
                  >
                    <FormControl><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {ITEM_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {typeWasAutoFilled && (
                    <p className="text-xs text-muted-foreground mt-1">Filled from the existing item.</p>
                  )}
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="unitOfMeasure" render={({ field }) => (
                <FormItem>
                  <FormLabel>Unit *</FormLabel>
                  <Select onValueChange={(v) => { setUomWasAutoFilled(false); field.onChange(v); }} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {UNIT_OPTIONS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {/* Clones are counted. defaultUnitForItemType already fills
                      "each", so this only fires when someone deliberately picks
                      a weight or volume — which is the case worth flagging. */}
                  {isCloneItemType(form.watch("itemType")) &&
                    !!form.watch("unitOfMeasure") &&
                    dimensionOf(form.watch("unitOfMeasure")) !== "count" && (
                      <p className="text-xs text-amber-600 mt-1">
                        Clones are counted, not weighed — set the unit to “each”.
                      </p>
                    )}
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="lotNumber" render={({ field }) => (
                <FormItem>
                  <FormLabel>Lot Number</FormLabel>
                  <FormControl><Input placeholder="LOT-2025-001" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="quantity" render={({ field }) => (
                <FormItem>
                  <FormLabel>Initial Quantity</FormLabel>
                  <FormControl><Input type="number" step="0.01" placeholder="0" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <FormField control={form.control} name="reorderPoint" render={({ field }) => (
              <FormItem>
                <FormLabel>Reorder Point</FormLabel>
                <FormControl><Input type="number" step="0.01" placeholder="100" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="notes" render={({ field }) => (
              <FormItem>
                <FormLabel>Notes</FormLabel>
                <FormControl><Textarea placeholder="Storage conditions, special handling..." rows={2} {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Creating..." : "Add Item"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
