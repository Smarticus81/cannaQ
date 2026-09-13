import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Trash2, Pencil, ArrowLeft, Factory, GitBranch, Lock, FileText, AlertTriangle } from "lucide-react";
import { Link, useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
// Session 76.3 (OQ DEV-3) — start a batch directly from a recipe.
import { CreateBatchDialog } from "@/components/dialogs/CreateBatchDialog";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { BOM_KINDS, BOM_KIND_LABELS, type BomKind } from "@/lib/units";

type Recipe = {
  id: number;
  productName: string;
  productType: string;
  subtype: string | null;
  version: number;
  isActive: boolean;
  notes: string | null;
  netWeight: number | null;
  netWeightUnit: string | null;
  servingSize: string | null;
  servingStrengthMg: number | null;
  servingsPerPackage: number | null;
  dualChamberTwoOils: boolean | null;
  dualChamberCombinedDraw: boolean | null;
  lineageId: number | null;
  supersededByRecipeId: number | null;
};
// Controlled documents pinned to this recipe (2026-08-25). A work instruction
// reads its procedure live from this recipe, so an approved / effective WI locks
// the recipe's items and process steps — see the change-control card below.
type LinkedDoc = {
  id: number;
  docNumber: string;
  title: string;
  documentType: string;
  status: string;
  revision: string;
  recipeUpdateFlagged: boolean;
};
type LinkedDocs = { documents: LinkedDoc[]; locked: boolean; lockedBy: LinkedDoc[] };

type ProductSubtype = {
  id: number;
  productType: string;
  name: string;
  defaultNetWeight: number | null;
  defaultNetWeightUnit: string | null;
  active: boolean;
  sortOrder: number;
};

const DUAL_CHAMBER_TYPE = "Dual Chamber Vape Cartridge";
type RecipeItem = {
  id: number;
  recipeId: number;
  ingredientName: string;
  plannedQuantity: number | null;
  unitOfMeasure: string;
  kind: BomKind;
  notes: string | null;
  sortOrder: number;
};
type RecipeProcessStep = {
  id: number;
  recipeId: number;
  stepNumber: number;
  description: string;
  template: string | null;
  instructions: string | null;
  sortOrder: number;
};

const UOMS = ["g", "mg", "units", "mL", "oz"];

/** Badge tint per BOM kind, so the four are distinguishable at a glance. */
const BOM_KIND_BADGE: Partial<Record<BomKind, string>> = {
  Material: "border-blue-300 text-blue-700",
  Packaging: "border-amber-300 text-amber-700",
  Labeling: "border-violet-300 text-violet-700",
};

export default function RecipeDetail() {
  const [, params] = useRoute("/recipes/:id");
  const id = params?.id ? parseInt(params.id) : null;
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const [startBatchOpen, setStartBatchOpen] = useState(false);
  const [newVerOpen, setNewVerOpen] = useState(false);

  const { data: recipe, isLoading } = useQuery<Recipe>({
    queryKey: [`/api/recipes/${id}`],
    queryFn: async () => (await fetch(`/api/recipes/${id}`)).json(),
    enabled: !!id,
  });
  // All versions in this recipe's lineage (for the version switcher + freeze state).
  const { data: versions } = useQuery<Recipe[]>({
    queryKey: [`/api/recipes/${id}/versions`],
    queryFn: async () => {
      try {
        const res = await fetch(`/api/recipes/${id}/versions`);
        if (!res.ok) return [];
        const data = await res.json().catch(() => []);
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    },
    enabled: !!id,
  });
  // Controlled documents pinned to this recipe, and whether they lock its
  // content. Guarded to a safe empty shape so an older server (or a 500 before
  // the migration runs) leaves the page usable rather than locking everything.
  const { data: linkedDocs } = useQuery<LinkedDocs>({
    queryKey: [`/api/recipes/${id}/linked-documents`],
    queryFn: async () => {
      const empty: LinkedDocs = { documents: [], locked: false, lockedBy: [] };
      try {
        const res = await fetch(`/api/recipes/${id}/linked-documents`);
        if (!res.ok) return empty;
        const data = await res.json().catch(() => null);
        if (!data || !Array.isArray(data.documents)) return empty;
        return { documents: data.documents, locked: !!data.locked, lockedBy: data.lockedBy ?? [] };
      } catch { return empty; }
    },
    enabled: !!id,
  });
  const { data: items } = useQuery<RecipeItem[]>({
    queryKey: [`/api/recipes/${id}/items`],
    queryFn: async () => (await fetch(`/api/recipes/${id}/items`)).json(),
    enabled: !!id,
  });
  const { data: steps } = useQuery<RecipeProcessStep[]>({
    queryKey: [`/api/recipes/${id}/process-steps`],
    // Guard to an array so a 500 (e.g. migration not yet run) can't crash the page.
    queryFn: async () => {
      try {
        const res = await fetch(`/api/recipes/${id}/process-steps`);
        if (!res.ok) return [];
        const data = await res.json().catch(() => []);
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    },
    enabled: !!id,
  });

  const { data: currentUser } = useGetCurrentUser();
  const canToggleActive = ["Admin", "Manager"].includes(currentUser?.role ?? "");
  const { toast } = useToast();
  // The server's 409s carry the reason and the way forward (a frozen version, or
  // a linked approved work instruction and what to do about it). Surface that
  // text verbatim instead of a generic "Failed to …" that tells nobody anything.
  async function serverError(res: globalThis.Response, fallback: string): Promise<Error> {
    const body = await res.json().catch(() => null);
    return new Error((body as { error?: string } | null)?.error || fallback);
  }
  function showError(e: unknown) {
    toast({
      title: "Change blocked",
      description: e instanceof Error ? e.message : "Something went wrong.",
      variant: "destructive",
    });
  }
  const updateRecipe = useMutation({
    mutationFn: async (patch: Partial<Recipe>) => {
      const res = await fetch(`/api/recipes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Failed to update recipe");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/recipes/${id}`] }),
  });

  // Change control — freeze this version and open an editable v+1 clone.
  const createNewVersion = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/recipes/${id}/new-version`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to create new version");
      return res.json() as Promise<Recipe>;
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["/api/recipes"] });
      setLocation(`/recipes/${created.id}`);
    },
  });

  const addItem = useMutation({
    mutationFn: async (body: Partial<RecipeItem>) => {
      const res = await fetch(`/api/recipes/${id}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await serverError(res, "Failed to add item");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/recipes/${id}/items`] }),
    onError: showError,
  });

  const removeItem = useMutation({
    mutationFn: async (itemId: number) => {
      const res = await fetch(`/api/recipe-items/${itemId}`, { method: "DELETE" });
      if (!res.ok) throw await serverError(res, "Failed to remove item");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/recipes/${id}/items`] }),
    onError: showError,
  });

  const addStep = useMutation({
    mutationFn: async (body: Partial<RecipeProcessStep>) => {
      const res = await fetch(`/api/recipes/${id}/process-steps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await serverError(res, "Failed to add step");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/recipes/${id}/process-steps`] }),
    onError: showError,
  });
  const removeStep = useMutation({
    mutationFn: async (stepId: number) => {
      const res = await fetch(`/api/recipe-process-steps/${stepId}`, { method: "DELETE" });
      if (!res.ok) throw await serverError(res, "Failed to remove step");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/recipes/${id}/process-steps`] }),
    onError: showError,
  });
  // Session 112 (2026-08-17) — edit an existing process step. The server route
  // (PATCH /api/recipe-process-steps/:id, with the same frozen-version guard as
  // add/delete) already existed but was never wired to the UI, so the only way
  // to reword a step was delete-and-retype it. Process steps are authored by the
  // facility, so editing one has to be a first-class action.
  const updateStep = useMutation({
    mutationFn: async ({ stepId, body }: { stepId: number; body: Partial<RecipeProcessStep> }) => {
      const res = await fetch(`/api/recipe-process-steps/${stepId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await serverError(res, "Failed to update step");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/recipes/${id}/process-steps`] }),
    onError: showError,
  });

  if (isLoading || !recipe) {
    return <><Skeleton className="h-40 w-full" /></>;
  }

  // Change-control derived state. A frozen version (supersededByRecipeId set) is
  // read-only; the "head" is the current version (supersededByRecipeId null).
  const isFrozen = recipe.supersededByRecipeId != null;
  const readOnly = isFrozen;
  // Content lock (2026-08-25). The BOM and the process steps ARE the procedure of
  // any work instruction pinned to this recipe, so they are locked while such a
  // document is Approved or Effective. Label attributes and the active flag are
  // NOT part of the printed procedure and stay editable — which is why this is a
  // separate flag from `readOnly` rather than folded into it.
  const linkedLocked = linkedDocs?.locked ?? false;
  const contentLocked = isFrozen || linkedLocked;
  const flaggedDocs = (linkedDocs?.documents ?? []).filter((d) => d.recipeUpdateFlagged);
  const allVersions = (versions ?? []).slice().sort((a, b) => a.version - b.version);
  const head = allVersions.find((v) => v.supersededByRecipeId == null) ?? null;
  const hasHistory = allVersions.length > 1;

  return (
    <>
      <div className="space-y-4">
        <Link href="/recipes" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back to Recipes
        </Link>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle>{recipe.productName}</CardTitle>
              <div className="flex items-center gap-2 mt-2 text-sm text-muted-foreground">
                <Badge variant="outline">{recipe.productType}</Badge>
                {recipe.subtype && <Badge variant="outline" className="border-blue-300 text-blue-700">{recipe.subtype}</Badge>}
                <span>v{recipe.version}</span>
                {isFrozen
                  ? <Badge variant="outline" className="border-amber-300 text-amber-700"><Lock className="h-3 w-3 mr-1" />Frozen</Badge>
                  : recipe.isActive
                    ? <Badge variant="outline" className="border-green-300 text-green-700">Active</Badge>
                    : <Badge variant="outline" className="text-muted-foreground">Inactive</Badge>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Version switcher — jump to any version in this recipe's lineage. */}
              {hasHistory && (
                <Select value={String(recipe.id)} onValueChange={(v) => setLocation(`/recipes/${v}`)}>
                  <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {allVersions.map((v) => (
                      <SelectItem key={v.id} value={String(v.id)}>
                        v{v.version}{v.supersededByRecipeId == null ? " · current" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {/* New Version — freeze this (current) version and open an editable
                  v+1 clone. Only on the current version; Admin/Manager only. */}
              {canToggleActive && !isFrozen && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={createNewVersion.isPending}
                  onClick={() => setNewVerOpen(true)}
                >
                  <GitBranch className="h-4 w-4 mr-1" /> {createNewVersion.isPending ? "Creating…" : "New Version"}
                </Button>
              )}
              {/* Session 76.3 (OQ DEV-3) — open the New Batch dialog pre-filled
                  with this recipe. Disabled on an inactive recipe. */}
              <Button
                size="sm"
                disabled={!recipe.isActive}
                title={!recipe.isActive ? "Reactivate this recipe to start a batch" : undefined}
                onClick={() => setStartBatchOpen(true)}
              >
                <Factory className="h-4 w-4 mr-1" /> Start Batch
              </Button>
              <span className="text-sm text-muted-foreground">Active</span>
              <Switch
                checked={recipe.isActive}
                disabled={!canToggleActive || isFrozen}
                title={isFrozen ? "Frozen versions can't be reactivated — the current version is live." : !canToggleActive ? "Only an Admin or Manager can activate or deactivate a recipe." : undefined}
                onCheckedChange={(checked) => { if (canToggleActive && !isFrozen) updateRecipe.mutate({ isActive: checked }); }}
              />
            </div>
          </CardHeader>
          {recipe.notes && (
            <CardContent>
              <p className="text-sm whitespace-pre-wrap">{recipe.notes}</p>
            </CardContent>
          )}
        </Card>

        {/* Frozen banner — a newer version superseded this one. */}
        {isFrozen && head && (
          <Card className="border-amber-300 bg-amber-50">
            <CardContent className="py-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-amber-800 flex items-center gap-2">
                <Lock className="h-4 w-4" />
                This is v{recipe.version} — frozen and read-only. v{head.version} is the current version.
              </p>
              <Button size="sm" variant="outline" onClick={() => setLocation(`/recipes/${head.id}`)}>
                Go to current (v{head.version})
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Document control — this recipe is the procedure of the work
            instructions pinned to it, so an approved / effective WI locks its
            items and process steps. Two ways forward, both audited: revise the
            document, or create a new recipe version. */}
        {linkedLocked && (
          <Card className="border-red-300 bg-red-50" data-testid="card-recipe-locked">
            <CardContent className="py-3 space-y-2">
              <p className="text-sm text-red-900 flex items-center gap-2 font-semibold">
                <Lock className="h-4 w-4" />
                Items and process steps are locked by document control
              </p>
              <p className="text-xs text-red-900">
                This recipe is the approved procedure for the document{(linkedDocs?.lockedBy.length ?? 0) > 1 ? "s" : ""} below.
                Changing its items or steps would change that document, so it is locked until either the document is under
                revision or this recipe gets a new version.
              </p>
              <ul className="space-y-1">
                {(linkedDocs?.lockedBy ?? []).map((d) => (
                  <li key={d.id} className="text-xs">
                    <Link href={`/documents/${d.id}`} className="text-red-900 underline underline-offset-2 hover:no-underline">
                      {d.docNumber} — {d.title}
                    </Link>
                    <span className="text-red-800"> (Rev {d.revision}, {d.status})</span>
                  </li>
                ))}
              </ul>
              <div className="text-xs text-red-900">
                <p className="font-semibold">To change the procedure:</p>
                <ol className="list-decimal pl-5 mt-0.5 space-y-0.5">
                  <li>Start a revision on the work instruction — the recipe unlocks while it is in Draft, and the approver re-confirms the recipe before it goes effective; or</li>
                  <li>Create a new version of this recipe — the approved document stays on the frozen version and flags for re-review.</li>
                </ol>
              </div>
            </CardContent>
          </Card>
        )}

        {/* The other direction — an author revising a linked document answered
            "yes, this needs a recipe update" when they started the revision. */}
        {flaggedDocs.length > 0 && (
          <Card className="border-blue-300 bg-blue-50" data-testid="card-recipe-update-flagged">
            <CardContent className="py-3 space-y-1">
              <p className="text-sm text-blue-900 flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-4 w-4" />
                Recipe update requested
              </p>
              <ul className="space-y-0.5">
                {flaggedDocs.map((d) => (
                  <li key={d.id} className="text-xs text-blue-900">
                    <Link href={`/documents/${d.id}`} className="underline underline-offset-2 hover:no-underline">
                      {d.docNumber} — {d.title}
                    </Link>{" "}
                    (Rev {d.revision}, {d.status}) is in revision and flags this recipe for update.
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* Linked documents, when nothing is locked or flagged — so it is always
            visible which controlled documents this recipe carries. */}
        {!linkedLocked && flaggedDocs.length === 0 && (linkedDocs?.documents.length ?? 0) > 0 && (
          <Card data-testid="card-recipe-linked-docs">
            <CardContent className="py-3 space-y-1">
              <p className="text-sm font-semibold flex items-center gap-2">
                <FileText className="h-4 w-4" /> Linked controlled documents
              </p>
              <ul className="space-y-0.5">
                {(linkedDocs?.documents ?? []).map((d) => (
                  <li key={d.id} className="text-xs text-muted-foreground">
                    <Link href={`/documents/${d.id}`} className="underline underline-offset-2 hover:no-underline">
                      {d.docNumber} — {d.title}
                    </Link>{" "}
                    (Rev {d.revision}, {d.status})
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground">
                These read their procedure from this recipe. Items and steps lock once one of them is approved.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Session 76.3 (OQ DEV-3) — New Batch dialog, pre-filled with this
            recipe, opened by the Start Batch button above. */}
        <LabelAttributesCard recipe={recipe} readOnly={readOnly} onSave={(patch) => updateRecipe.mutate(patch)} />

        {recipe.productType === DUAL_CHAMBER_TYPE && (
          <DualChamberSetupCard recipe={recipe} readOnly={readOnly} onSave={(patch) => updateRecipe.mutate(patch)} />
        )}

        <CreateBatchDialog
          hideTrigger
          open={startBatchOpen}
          onOpenChange={setStartBatchOpen}
          initialRecipeId={id ?? undefined}
        />

        <RecipeItemsCard
          items={items ?? []}
          readOnly={contentLocked}
          onAdd={(body) => addItem.mutate(body)}
          onRemove={(itemId) => removeItem.mutate(itemId)}
        />

        <RecipeProcessStepsCard
          steps={steps ?? []}
          readOnly={contentLocked}
          onAdd={(body) => addStep.mutate(body)}
          onRemove={(stepId) => removeStep.mutate(stepId)}
          onUpdate={(stepId, body) => updateStep.mutate({ stepId, body })}
          updating={updateStep.isPending}
        />

        {/* New Version confirmation. */}
        <Dialog open={newVerOpen} onOpenChange={setNewVerOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Create version {recipe.version + 1}?</DialogTitle></DialogHeader>
            <div className="space-y-3 text-sm">
              <p>
                This copies the current recipe (items, process steps, and label attributes) into a
                new, editable <strong>v{recipe.version + 1}</strong>. The current <strong>v{recipe.version}</strong> is
                then frozen (read-only) and deactivated, so it stays viewable but can't be changed or used for new batches.
              </p>
              <p className="text-muted-foreground">
                Any work instruction approved against v{recipe.version} will flag for re-review.
              </p>
              {createNewVersion.isError && (
                <p className="text-destructive">{(createNewVersion.error as Error).message}</p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" onClick={() => setNewVerOpen(false)}>Cancel</Button>
                <Button
                  disabled={createNewVersion.isPending}
                  onClick={() => createNewVersion.mutate(undefined, { onSuccess: () => setNewVerOpen(false) })}
                >
                  {createNewVersion.isPending ? "Creating…" : `Create v${recipe.version + 1}`}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}

function LabelAttributesCard({
  recipe, onSave, readOnly = false,
}: {
  recipe: Recipe;
  onSave: (patch: Partial<Recipe>) => void;
  readOnly?: boolean;
}) {
  const [subtype, setSubtype] = useState(recipe.subtype ?? "");
  const [netWeight, setNetWeight] = useState(recipe.netWeight?.toString() ?? "");
  const [netWeightUnit, setNetWeightUnit] = useState(recipe.netWeightUnit ?? "");
  const [servingSize, setServingSize] = useState(recipe.servingSize ?? "");
  const [servingStrengthMg, setServingStrengthMg] = useState(recipe.servingStrengthMg?.toString() ?? "");
  const [servingsPerPackage, setServingsPerPackage] = useState(recipe.servingsPerPackage?.toString() ?? "");

  // Facility-defined subtypes for this product type. The Subtype field only shows
  // when at least one active subtype exists for the type.
  const { data: subtypes } = useQuery<ProductSubtype[]>({
    queryKey: [`/api/product-subtypes?productType=${recipe.productType}`],
    queryFn: async () => {
      try {
        const res = await fetch(`/api/product-subtypes?productType=${encodeURIComponent(recipe.productType)}`);
        if (!res.ok) return [];
        const data = await res.json().catch(() => []);
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    },
  });
  const activeSubtypes = (subtypes ?? []).filter((s) => s.active);

  // Picking a size-style subtype pre-fills net weight (still editable before Save).
  function pickSubtype(name: string) {
    setSubtype(name);
    const s = activeSubtypes.find((x) => x.name === name);
    if (s?.defaultNetWeight != null) {
      setNetWeight(String(s.defaultNetWeight));
      if (s.defaultNetWeightUnit) setNetWeightUnit(s.defaultNetWeightUnit);
    }
  }

  const numOrNull = (v: string): number | null => (v.trim() === "" ? null : Number(v));
  function save() {
    onSave({
      subtype: subtype.trim() || null,
      netWeight: numOrNull(netWeight),
      netWeightUnit: netWeightUnit.trim() || null,
      servingSize: servingSize.trim() || null,
      servingStrengthMg: numOrNull(servingStrengthMg),
      servingsPerPackage: numOrNull(servingsPerPackage),
    });
  }
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Label Attributes</CardTitle>
        {!readOnly && <Button size="sm" onClick={save}>Save</Button>}
      </CardHeader>
      <CardContent>
        <fieldset disabled={readOnly} className="disabled:opacity-70">
        <p className="text-xs text-muted-foreground mb-3">
          Product-specific values that flow onto this product's batch label data. Net weight is a default
          the actual METRC package quantity overrides. Serving fields apply mainly to edibles (MI R 420.401).
        </p>
        {activeSubtypes.length > 0 && (
          <div className="mb-4 max-w-xs">
            <label className="text-xs text-muted-foreground">Subtype</label>
            <Select value={subtype} onValueChange={pickSubtype}>
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                {activeSubtypes.map((s) => (
                  <SelectItem key={s.id} value={s.name}>
                    {s.name}
                    {s.defaultNetWeight != null ? ` · ${s.defaultNetWeight}${s.defaultNetWeightUnit ?? ""}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label className="text-xs text-muted-foreground">Net weight</label>
            <Input type="number" step="0.01" value={netWeight} onChange={(e) => setNetWeight(e.target.value)} placeholder="e.g. 1" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Net weight unit</label>
            <Input value={netWeightUnit} onChange={(e) => setNetWeightUnit(e.target.value)} placeholder="g, mg, each" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Servings per package</label>
            <Input type="number" value={servingsPerPackage} onChange={(e) => setServingsPerPackage(e.target.value)} placeholder="e.g. 10" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Serving size</label>
            <Input value={servingSize} onChange={(e) => setServingSize(e.target.value)} placeholder="e.g. 1 gummy" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Serving strength (mg THC)</label>
            <Input type="number" step="0.1" value={servingStrengthMg} onChange={(e) => setServingStrengthMg(e.target.value)} placeholder="e.g. 10" />
          </div>
        </div>
        </fieldset>
      </CardContent>
    </Card>
  );
}

function DualChamberSetupCard({
  recipe, onSave, readOnly = false,
}: {
  recipe: Recipe;
  onSave: (patch: Partial<Recipe>) => void;
  readOnly?: boolean;
}) {
  // "" = not set yet · "same" = one oil in both chambers · "two" = two different oils.
  const [oilConfig, setOilConfig] = useState<string>(
    recipe.dualChamberTwoOils == null ? "" : recipe.dualChamberTwoOils ? "two" : "same"
  );
  const [combinedDraw, setCombinedDraw] = useState<boolean>(recipe.dualChamberCombinedDraw ?? false);

  const twoOils = oilConfig === "two";
  // Combined draw only matters with two different oils.
  const effectiveCombined = twoOils && combinedDraw;
  // CRA MI_IB_0114: same oil → 1 test; two oils → 2 (A+B); + combined draw → 3 (adds C).
  const testGroups = oilConfig === "" ? null : (!twoOils ? 1 : effectiveCombined ? 3 : 2);

  function save() {
    onSave({
      dualChamberTwoOils: oilConfig === "" ? null : twoOils,
      dualChamberCombinedDraw: oilConfig === "" ? null : (twoOils ? combinedDraw : false),
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Dual Chamber Setup</CardTitle>
        {!readOnly && <Button size="sm" onClick={save}>Save</Button>}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          CRA MI_IB_0114. These two answers set how many final-form lab tests this product needs. Each
          chamber's oil is its own production batch (Metrc tag), recorded in this batch's ingredients.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-muted-foreground">Chamber setup</label>
            <Select value={oilConfig} onValueChange={setOilConfig} disabled={readOnly}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="same">Same oil in both chambers</SelectItem>
                <SelectItem value="two">Two different oils</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col justify-start">
            <label className="text-xs text-muted-foreground mb-2">Combined draw</label>
            <div className="flex items-center gap-2">
              <Switch checked={effectiveCombined} disabled={!twoOils || readOnly} onCheckedChange={setCombinedDraw} />
              <span className="text-sm text-muted-foreground">Both chambers can be used together (blended)</span>
            </div>
            {!twoOils && oilConfig !== "" && (
              <p className="text-[11px] text-muted-foreground mt-1">Only applies with two different oils.</p>
            )}
          </div>
        </div>
        {testGroups != null && (
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <span className="font-medium">Testing: {testGroups} lab {testGroups === 1 ? "test" : "tests"} required</span>
            {" — "}
            {testGroups === 1 && "one full panel (both chambers hold the same oil)."}
            {testGroups === 2 && "a full panel on Chamber A and Chamber B."}
            {testGroups === 3 && "a full panel on Chamber A, Chamber B, and the combined draw (Chamber C)."}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecipeProcessStepsCard({
  steps, onAdd, onRemove, onUpdate, updating = false, readOnly = false,
}: {
  steps: RecipeProcessStep[];
  onAdd: (body: Partial<RecipeProcessStep>) => void;
  onRemove: (id: number) => void;
  /** Session 112 — save a reworded step in place instead of delete-and-retype. */
  onUpdate: (id: number, body: Partial<RecipeProcessStep>) => void;
  updating?: boolean;
  readOnly?: boolean;
}) {
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState("");
  // Session 112 — the step currently open in the edit dialog, plus its working
  // copy. Held separately from the add-form fields so opening the editor never
  // clobbers a half-typed new step.
  const [editing, setEditing] = useState<RecipeProcessStep | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editTemplate, setEditTemplate] = useState("");

  function openEdit(s: RecipeProcessStep) {
    setEditing(s);
    setEditDesc(s.description);
    setEditTemplate(s.template ?? "");
  }

  function saveEdit() {
    if (!editing || !editDesc.trim()) return;
    onUpdate(editing.id, {
      description: editDesc.trim(),
      template: editTemplate.trim() || null,
    });
    setEditing(null);
  }

  function submit() {
    if (!description.trim()) return;
    onAdd({
      description: description.trim(),
      template: template.trim() || null,
    });
    setDescription(""); setTemplate("");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Approved Process Steps</CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          FDA food GMP — the approved manufacturing instructions, copied onto every batch where the baker fills the blanks and e-signs.
          Put values <strong>fixed by your procedure</strong> (like oven temperature) right in the sentence. Wrap only what the operator
          records at run time in <code className="px-1 bg-muted rounded">{"{curly braces}"}</code> — typically the actual {"{time}"} and {"{baker}"}
          (which auto-fills from the signer). e.g. <em>&ldquo;…baked at 350°F for {"{time}"} minutes (SOP target 30 min).&rdquo;</em>
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!readOnly && (
        <div className="space-y-2">
          <div>
            <label className="text-xs text-muted-foreground">Step title</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Bake cookies" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Instruction (use {"{blanks}"} for fill-ins)</label>
            <textarea
              className="mt-1 w-full min-h-[64px] rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder="Once ingredients are mixed, {baker} placed 2 inch round spoons of cookie dough onto the tray and baked at 350 degrees F for {time} minutes (SOP target 30 min)."
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={submit} disabled={!description.trim()}>
              <Plus className="h-4 w-4 mr-1" /> Add Step
            </Button>
          </div>
        </div>
        )}

        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No process steps yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Step</TableHead>
                <TableHead>Instruction</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {steps.map((s, i) => (
                <TableRow key={s.id}>
                  <TableCell className="text-muted-foreground align-top">{i + 1}</TableCell>
                  <TableCell className="font-medium align-top">{s.description}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{s.template ?? "—"}</TableCell>
                  <TableCell className="align-top">
                    {!readOnly && (
                      <div className="flex items-center gap-0.5">
                        <Button variant="ghost" size="icon" title="Edit this step" onClick={() => openEdit(s)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" title="Delete this step" onClick={() => onRemove(s.id)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* Session 112 — edit an existing step in place. Same two fields as the
            add form, so the rules an author already learned (fixed values in the
            sentence, {blanks} only for what's recorded at run time) still hold. */}
        <Dialog open={editing != null} onOpenChange={(o) => { if (!o) setEditing(null); }}>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>Edit process step</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground">Step title</label>
                <Input className="mt-1" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Instruction (use {"{blanks}"} for fill-ins)</label>
                <textarea
                  className="mt-1 w-full min-h-[120px] rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={editTemplate}
                  onChange={(e) => setEditTemplate(e.target.value)}
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Editing a step changes it for <strong>new</strong> batches only. Batches already open keep the
                  wording they were started with, so a signed batch record never changes after the fact.
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                <Button onClick={saveEdit} disabled={!editDesc.trim() || updating}>
                  {updating ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function RecipeItemsCard({
  items, onAdd, onRemove, readOnly = false,
}: {
  items: RecipeItem[];
  onAdd: (body: Partial<RecipeItem>) => void;
  onRemove: (id: number) => void;
  readOnly?: boolean;
}) {
  const [name, setName] = useState("");
  const [qty, setQty] = useState("");
  const [uom, setUom] = useState("g");
  const [kind, setKind] = useState<BomKind>("Ingredient");

  function submit() {
    if (!name.trim()) return;
    onAdd({
      ingredientName: name.trim(),
      plannedQuantity: qty ? parseFloat(qty) : null,
      unitOfMeasure: uom,
      kind,
    });
    setName(""); setQty("");
  }

  return (
    <Card>
      <CardHeader><CardTitle>Items (BOM)</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {!readOnly && (
        <div className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-4">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Blue Dream Distillate" />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground">Planned Qty</label>
            <Input type="number" step="0.01" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground">UoM</label>
            <Select value={uom} onValueChange={setUom}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{UOMS.map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground">Type</label>
            {/* 2026-09-07 — Packaging and Labeling added. Tubes, cartons and
                compliance labels belong on the recipe like any other component;
                until now the only choices were Ingredient and Material, so no
                recipe line could ever be typed as packaging and nothing routed
                to the Packaging/Labeling tabs on a batch. */}
            <Select value={kind} onValueChange={(v) => setKind(v as BomKind)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {BOM_KINDS.map((k) => <SelectItem key={k} value={k}>{BOM_KIND_LABELS[k]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2">
            <Button className="w-full" onClick={submit} disabled={!name.trim()}>
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </div>
        </div>
        )}

        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No items yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Planned Qty</TableHead>
                <TableHead>UoM</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map(it => (
                <TableRow key={it.id}>
                  <TableCell className="font-medium">{it.ingredientName}</TableCell>
                  <TableCell>
                    {/* 2026-09-07 — print the row's ACTUAL kind. This used to
                        read `kind === "Material" ? "Material" : "Ingredient"`,
                        so the moment Packaging and Labeling became choosable
                        every one of them displayed as "Ingredient" — the row was
                        stored correctly and the table was lying about it. */}
                    <Badge variant="outline" className={BOM_KIND_BADGE[it.kind] ?? ""}>
                      {BOM_KIND_LABELS[it.kind] ?? it.kind}
                    </Badge>
                  </TableCell>
                  <TableCell>{it.plannedQuantity ?? "—"}</TableCell>
                  <TableCell>{it.unitOfMeasure}</TableCell>
                  <TableCell>
                    {!readOnly && (
                      <Button variant="ghost" size="icon" onClick={() => onRemove(it.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
