import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Plus } from "lucide-react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";

type Recipe = {
  id: number;
  productName: string;
  productType: string;
  version: number;
  isActive: boolean;
  notes: string | null;
  updatedAt: string;
};

import { PRODUCT_TYPES_WITH_OTHER as PRODUCT_TYPES } from "@/lib/productTypes";

export default function Recipes() {
  const [search, setSearch] = useState("");
  // Session 63 — status filter. Defaults to Active so the list opens
  // decluttered (older/superseded recipes are deactivated, not deleted, and
  // drop out of here and the New Batch picker); switch to Inactive/All to manage.
  const [statusFilter, setStatusFilter] = useState<"active" | "inactive" | "all">("active");
  const { data: recipes, isLoading } = useQuery<Recipe[]>({
    queryKey: ["/api/recipes"],
    queryFn: async () => (await fetch("/api/recipes")).json(),
  });

  const filtered = useMemo(() => {
    if (!recipes) return [];
    const q = search.trim().toLowerCase();
    return recipes.filter(r => {
      if (statusFilter === "active" && !r.isActive) return false;
      if (statusFilter === "inactive" && r.isActive) return false;
      if (!q) return true;
      return r.productName.toLowerCase().includes(q) || r.productType.toLowerCase().includes(q);
    });
  }, [recipes, search, statusFilter]);

  const activeCount = useMemo(() => (recipes ?? []).filter(r => r.isActive).length, [recipes]);
  const inactiveCount = useMemo(() => (recipes ?? []).filter(r => !r.isActive).length, [recipes]);

  return (
    <AppLayout>
      <div className="space-y-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle>Recipes</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Reusable BOMs for production batches. Selecting a recipe on batch
                creation auto-populates planned ingredients.
              </p>
            </div>
            <NewRecipeDialog />
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <Input
                placeholder="Search by product name or type..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="max-w-sm"
              />
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as "active" | "inactive" | "all")}>
                <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active ({activeCount})</SelectItem>
                  <SelectItem value="inactive">Inactive ({inactiveCount})</SelectItem>
                  <SelectItem value="all">All ({activeCount + inactiveCount})</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {isLoading ? (
              <div className="space-y-2">{[0,1,2].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                {(recipes?.length ?? 0) === 0
                  ? "No recipes yet. Create one to standardize your BOMs."
                  : "No recipes match the current filter."}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(r => (
                    <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50">
                      <TableCell>
                        <Link href={`/recipes/${r.id}`} className="font-medium text-primary hover:underline">
                          {r.productName}
                        </Link>
                      </TableCell>
                      <TableCell>{r.productType}</TableCell>
                      <TableCell>v{r.version}</TableCell>
                      <TableCell>
                        {r.isActive
                          ? <Badge variant="outline" className="border-green-300 text-green-700">Active</Badge>
                          : <Badge variant="outline" className="text-muted-foreground">Inactive</Badge>}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

type ProductSubtype = {
  id: number;
  productType: string;
  name: string;
  defaultNetWeight: number | null;
  defaultNetWeightUnit: string | null;
  active: boolean;
  sortOrder: number;
};

function NewRecipeDialog() {
  const [open, setOpen] = useState(false);
  const [productName, setProductName] = useState("");
  const [productType, setProductType] = useState("");
  const [subtype, setSubtype] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  // Subtypes for the chosen product type. The Subtype field only appears when
  // this facility has defined subtypes for the selected type.
  const { data: subtypes } = useQuery<ProductSubtype[]>({
    queryKey: [`/api/product-subtypes?productType=${productType}`],
    queryFn: async () => {
      const res = await fetch(`/api/product-subtypes?productType=${encodeURIComponent(productType)}`);
      if (!res.ok) return [];
      const data = await res.json().catch(() => []);
      return Array.isArray(data) ? data : [];
    },
    enabled: !!productType,
  });
  const activeSubtypes = (subtypes ?? []).filter((s) => s.active);
  const selectedSubtype = activeSubtypes.find((s) => s.name === subtype) ?? null;

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/recipes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productName,
          productType,
          subtype: subtype || null,
          notes: notes || null,
          // A size-style subtype pre-fills the recipe's net weight; still editable
          // later under Label Attributes.
          netWeight: selectedSubtype?.defaultNetWeight ?? null,
          netWeightUnit: selectedSubtype?.defaultNetWeightUnit ?? null,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to create recipe");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/recipes"] });
      setOpen(false);
      setProductName(""); setProductType(""); setSubtype(""); setNotes(""); setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="h-4 w-4 mr-1" />New Recipe</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New Recipe</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Product Name *</label>
            <Input value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="Blue Dream Vape Cartridge" />
          </div>
          <div>
            <label className="text-sm font-medium">Product Type *</label>
            <Select value={productType} onValueChange={(v) => { setProductType(v); setSubtype(""); }}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {PRODUCT_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {activeSubtypes.length > 0 && (
            <div>
              <label className="text-sm font-medium">Subtype</label>
              <Select value={subtype} onValueChange={setSubtype}>
                <SelectTrigger><SelectValue placeholder="Select (optional)" /></SelectTrigger>
                <SelectContent>
                  {activeSubtypes.map((s) => (
                    <SelectItem key={s.id} value={s.name}>
                      {s.name}
                      {s.defaultNetWeight != null ? ` · ${s.defaultNetWeight}${s.defaultNetWeightUnit ?? ""}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedSubtype?.defaultNetWeight != null && (
                <p className="text-xs text-muted-foreground mt-1">
                  Net weight will be set to {selectedSubtype.defaultNetWeight}{selectedSubtype.defaultNetWeightUnit ?? ""} (editable later).
                </p>
              )}
            </div>
          )}
          <div>
            <label className="text-sm font-medium">Notes</label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              onClick={() => create.mutate()}
              disabled={!productName.trim() || !productType.trim() || create.isPending}>
              {create.isPending ? "Creating..." : "Create Recipe"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
