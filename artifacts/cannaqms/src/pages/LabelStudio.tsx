import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, ShieldCheck, Star } from "lucide-react";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { PRODUCT_TYPES, type ProductType } from "@/lib/productTypes";

// A PRODUCT in Label Studio is a recipe lineage — see routes/label_templates.ts.
type StudioProduct = {
  lineageId: number;
  recipeId: number;
  productName: string;
  subtype: string | null;
  version: number;
  isActive: boolean;
};

// 2026-09-06 — Label Studio used to keep its own SIX product types here
// ("Flower", "Pre-Roll", "Edible", "Concentrate", "Vape", "Topical") while the
// rest of the app used the canonical ten in lib/productTypes. The lists disagreed
// on the one type that matters most: a label was a "Vape", a recipe was a
// "Vape Cartridge", and /label-studio/products matches product_type EXACTLY — so
// picking products for a vape label always answered "No products of this type
// yet", and the label could never be approved. Four types (Infused Pre-Roll,
// Dual Chamber Vape Cartridge, Tincture, Capsule) had no label templates at all.
// Same disease as the item-type vocabulary split; same cure: ONE list, imported.
// ⛔ Do not reintroduce a local list here.

const REGION_KINDS = [
  "brand-header", "product-info", "strain", "thc-cbd", "net-weight",
  "dates", "batch-metrc", "static-block", "divider", "spacer",
] as const;
type RegionKind = typeof REGION_KINDS[number];

interface RegionConfig {
  id: string;
  kind: RegionKind;
  enabled: boolean;
  order: number;
  fontSize?: number;
  fontWeight?: "normal" | "bold";
  align?: "left" | "center" | "right";
  staticBlockId?: number;
  customText?: string;
  label?: string;
}

interface StaticBlock {
  id: number;
  productType: string;
  name: string;
  body: string;
  regulationRef: string | null;
  version: number;
  approvedById: number | null;
  approvedByName: string | null;
  approvalDate: string | null;
  isActive: boolean;
}

type LabelTemplateStatus = "draft" | "regulatory_approved" | "marketing_approved" | "approved" | "retired";

interface LabelTemplate {
  id: number;
  productType: string;
  name: string;
  widthIn: number;
  heightIn: number;
  version: number;
  regions: RegionConfig[];
  isDefault: boolean;
  // Session 39 — lifecycle fields. The legacy `approvedById` / `approvedByName`
  // / `approvalDate` triple is still set when Marketing signs the second
  // approval, so the PDF renderer's draft-watermark logic keeps working
  // unchanged; the UI uses `status` to decide which action button to show.
  status: LabelTemplateStatus;
  createdById: number | null;
  createdByName: string | null;
  regulatoryApproverId: number | null;
  regulatoryApproverName: string | null;
  regulatoryApprovedAt: string | null;
  marketingApproverId: number | null;
  marketingApproverName: string | null;
  marketingApprovedAt: string | null;
  retiredByName: string | null;
  retiredAt: string | null;
  retireReason: string | null;
  approvedById: number | null;
  approvedByName: string | null;
  approvalDate: string | null;
  // 2026-07-22 — bring-your-own-label model: recorded format lock + the set of
  // variable fields this template carries (see LABEL_VARIABLE_FIELDS).
  formatSpec: { fontFamily?: string; fontSizes?: string; layoutNotes?: string } | null;
  fieldList: string[] | null;
  // 2026-08-31 — the recipe LINEAGES this label is for. Empty = any product of
  // this type.
  productLineageIds: number[] | null;
  // 2026-08-31 — step 4. The requirement keys this sticker carries. Frozen once
  // the template is approved.
  coverageKeys: string[] | null;
  // 2026-09-02 — declared to carry no state requirement: a logo or strain
  // sticker beside the compliance label. The only way to sign an empty Fixed Content.
  brandOnly?: boolean;
  // 2026-09-02 — set only when this label was signed before its product's
  // packaging was approved. Server-set; never editable from here.
  packagingOrderOverrideReason?: string | null;
  packagingOrderOverrideByName?: string | null;
  packagingOrderOverrideAt?: string | null;
  // 2026-09-01 — whether a proof PDF is attached, so Preview can be honest
  // before it is clicked. Computed by the list endpoint, not a column.
  hasProof?: boolean;
}

// The standard VARIABLE fields CannaQMS can supply per package (a subset of the
// label-data export columns). A template records WHICH of these its approved
// design carries, so a batch's data file maps cleanly onto it.
const LABEL_VARIABLE_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["metrc_package_tag", "METRC package tag"],
  ["product_name", "Product name"],
  ["strain", "Strain"],
  ["net_weight", "Net weight"],
  ["thc_value", "THC value"],
  ["cbd_value", "CBD value"],
  ["total_cannabinoids_value", "Total cannabinoids"],
  ["potency_variance_statement", "10% variance statement"],
  ["testing_lab", "Testing lab"],
  ["test_analysis_date", "Test / analysis date"],
  ["date_produced", "Date produced"],
  ["date_tested", "Date tested"],
  ["expiration_date", "Expiration date"],
  ["batch_number", "Batch number"],
  ["producer_name", "Producer name"],
  ["producer_license", "Producer license"],
  ["packager_name", "Packager name"],
  ["packager_license", "Packager license"],
  ["ingredients", "Ingredients"],
];

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? (null as unknown as T) : res.json();
}

export default function LabelStudio() {
  const [productType, setProductType] = useState<ProductType>("Flower");

  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto py-6 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Label Studio</h1>
            {/* ⛔ 2026-09-01 — say what this screen IS. It used to describe its own
                furniture ("static text blocks and per-product label templates"),
                which tells you nothing if you do not already know the model. */}
            <p className="text-muted-foreground max-w-3xl">
              A record of the label you print on each product. You design and print the label in your
              own software; here you say which products use it, which state requirements it prints,
              and attach the approved PDF. Signing it off is what lets a batch stop checking those
              requirements before every print.
            </p>
          </div>
          <div className="w-56">
            <Label className="text-xs">Product Type</Label>
            <Select value={productType} onValueChange={(v) => setProductType(v as ProductType)}>
              <SelectTrigger data-testid="select-product-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PRODUCT_TYPES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Tabs defaultValue="templates">
          <TabsList>
            <TabsTrigger value="templates" data-testid="tab-templates">Templates</TabsTrigger>
            <TabsTrigger value="blocks" data-testid="tab-blocks">Static Blocks</TabsTrigger>
          </TabsList>

          <TabsContent value="templates" className="mt-6">
            <TemplatesPane productType={productType} />
          </TabsContent>

          <TabsContent value="blocks" className="mt-6">
            <BlocksPane productType={productType} />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}

// ── Static Blocks pane ───────────────────────────────────────────────────────

function BlocksPane({ productType }: { productType: ProductType }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const blocksQuery = useQuery({
    queryKey: ["label-static-blocks", productType],
    queryFn: () => fetchJSON<StaticBlock[]>(`/api/label-static-blocks?productType=${encodeURIComponent(productType)}`),
  });

  const [editing, setEditing] = useState<StaticBlock | null>(null);
  const [creating, setCreating] = useState(false);

  const blocks = (blocksQuery.data ?? []).filter((b) => b.isActive);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)} data-testid="button-new-block"><Plus className="h-4 w-4 mr-1" /> New Block</Button>
      </div>
      <div className="grid gap-3">
        {blocks.length === 0 && <p className="text-sm text-muted-foreground">No static blocks for this product type.</p>}
        {blocks.map((b) => (
          <Card key={b.id} className="p-4" data-testid={`card-block-${b.id}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold">{b.name}</h3>
                  <Badge variant="outline">v{b.version}</Badge>
                  {b.approvalDate
                    ? <Badge className="bg-emerald-100 text-emerald-700 border-emerald-300"><ShieldCheck className="h-3 w-3 mr-1" />Approved by {b.approvedByName}</Badge>
                    : <Badge variant="secondary">Draft — needs approval</Badge>}
                </div>
                {b.regulationRef && <p className="text-xs text-muted-foreground mt-1">Ref: {b.regulationRef}</p>}
                <p className="text-sm mt-2 whitespace-pre-wrap">{b.body}</p>
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                <Button size="sm" variant="outline" onClick={() => setEditing(b)} data-testid={`button-edit-block-${b.id}`}>Edit</Button>
                {!b.approvalDate && (
                  <Button size="sm" variant="default" onClick={async () => {
                    try {
                      await fetchJSON(`/api/label-static-blocks/${b.id}/approve`, { method: "POST" });
                      qc.invalidateQueries({ queryKey: ["label-static-blocks"] });
                      toast({ title: "Block approved" });
                    } catch (e) { toast({ title: "Failed to approve", description: String(e), variant: "destructive" }); }
                  }} data-testid={`button-approve-block-${b.id}`}>Approve</Button>
                )}
                <Button size="sm" variant="ghost" onClick={async () => {
                  if (!confirm(`Retire "${b.name}"?`)) return;
                  try {
                    await fetchJSON(`/api/label-static-blocks/${b.id}`, { method: "DELETE" });
                    qc.invalidateQueries({ queryKey: ["label-static-blocks"] });
                    toast({ title: "Block retired" });
                  } catch (e) { toast({ title: "Failed", description: String(e), variant: "destructive" }); }
                }}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <BlockEditor
        open={creating || editing !== null}
        productType={productType}
        block={editing}
        onClose={() => { setEditing(null); setCreating(false); }}
        onSaved={() => qc.invalidateQueries({ queryKey: ["label-static-blocks"] })}
      />
    </div>
  );
}

function BlockEditor({ open, productType, block, onClose, onSaved }: {
  open: boolean; productType: ProductType; block: StaticBlock | null; onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(block?.name ?? "");
  const [body, setBody] = useState(block?.body ?? "");
  const [regRef, setRegRef] = useState(block?.regulationRef ?? "");

  // ⛔ 2026-09-04 — useEffect, NOT useMemo. A useMemo runs DURING render and React
  // is free to re-run one whenever it likes, so hydrating state from a prop here
  // reset the form mid-edit every time `block` changed identity — a background
  // refetch is enough — and the next Save wrote the reset values back with no
  // error. Keyed on the dialog opening plus the block id so a refetch of the same
  // block cannot stomp edits in progress. See TemplateEditor below for the case
  // that actually lost data.
  useEffect(() => {
    if (!open) return;
    setName(block?.name ?? "");
    setBody(block?.body ?? "");
    setRegRef(block?.regulationRef ?? "");
  }, [open, block?.id]);

  const save = useMutation({
    mutationFn: async () => {
      if (block) {
        return fetchJSON(`/api/label-static-blocks/${block.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, body, regulationRef: regRef || null }),
        });
      }
      return fetchJSON(`/api/label-static-blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productType, name, body, regulationRef: regRef || null }),
      });
    },
    onSuccess: () => { onSaved(); onClose(); toast({ title: block ? "Block updated" : "Block created" }); },
    onError: (e) => toast({ title: "Save failed", description: String(e), variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{block ? `Edit Block: ${block.name}` : `New Static Block · ${productType}`}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-block-name" />
          </div>
          <div>
            <Label>Regulation Ref</Label>
            <Input value={regRef} onChange={(e) => setRegRef(e.target.value)} placeholder="MI MRA R 420.504" data-testid="input-block-regref" />
          </div>
          <div>
            <Label>Body</Label>
            <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} data-testid="input-block-body" />
          </div>
          {block && (
            <p className="text-xs text-muted-foreground">Editing this block bumps it to v{(block.version ?? 1) + 1} and clears the previous approval.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || !body.trim() || save.isPending} data-testid="button-save-block">
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Which products a label is for ────────────────────────────────────────────
//
// Naming the products a template is used for changes nothing that gets printed,
// so it has its own endpoint: the generic PATCH treats every write as a layout
// edit and knocks the template back to draft, clearing both approvals.
function LinkProductsDialog({ template, products, onClose, onSaved, onError }: {
  template: LabelTemplate | null;
  products: StudioProduct[];
  onClose: () => void;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setPicked(new Set(template?.productLineageIds ?? []));
  }, [template]);

  const save = async () => {
    if (!template) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/label-templates/${template.id}/products`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ productLineageIds: [...picked] }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={template !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Products using {template?.name}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          Tick every product this label is used for. A label must name at least one product
          before it can be approved — a label for a whole product type is no longer allowed.
        </p>
        <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
          {products.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No {template?.productType} products yet — a product is a recipe, so add a
              {" "}{template?.productType} recipe under Recipes and it will appear here.
            </p>
          )}
          {products.map((p) => (
            <label key={p.lineageId} className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={picked.has(p.lineageId)}
                data-testid={`link-product-${p.lineageId}`}
                onCheckedChange={() => {
                  const next = new Set(picked);
                  if (next.has(p.lineageId)) next.delete(p.lineageId); else next.add(p.lineageId);
                  setPicked(next);
                }}
              />
              <span>{p.productName}</span>
              {p.subtype && <span className="text-xs text-muted-foreground">{p.subtype}</span>}
              {!p.isActive && <Badge variant="outline" className="text-xs">Inactive</Badge>}
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving} data-testid="button-save-products">
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── What the sticker carries ─────────────────────────────────────────────────
//
// Label-control step 4. The panel Jonathan already knows from a packaging
// design's Packaging Compliance tab, with one difference: a template has no
// target to choose. It is the end of the chain, so a requirement is either
// printed on the sticker or it is not.
//
// ⛔ Only the FIXED requirements are tickable. A value that changes with the
// batch cannot be verified once — a THC field is not this batch's THC number —
// so those are shown greyed, with the reason, rather than hidden. Hiding them
// would read as "this label has nothing to do with them".

type TemplateRequirement = {
  key: string;
  itemText: string;
  regulationRef: string;
  control: string | null;
  required: boolean;
  carried: boolean;
  claimable: boolean;
  // 2026-09-02 — the approved packaging already answers this one, so it is not
  // the label's to tick. Packaging is approved first, by his ruling.
  answeredByPackaging?: boolean;
};

function CoverageDialog({ template, onClose, onSaved, onError }: {
  template: LabelTemplate | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [brandOnly, setBrandOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const cov = useQuery({
    queryKey: ["label-template-coverage", template?.id],
    enabled: template !== null,
    queryFn: () => fetchJSON<{
      productType: string;
      locked: boolean;
      configured: boolean;
      brandOnly: boolean;
      requirements: TemplateRequirement[];
      packagingDesigns: { id: number; designName: string; version: string }[];
    }>(`/api/label-templates/${template!.id}/coverage`),
  });
  useEffect(() => {
    setPicked(new Set(template?.coverageKeys ?? []));
    setBrandOnly(template?.brandOnly === true);
  }, [template]);

  const locked = cov.data?.locked ?? true;
  const requirements = cov.data?.requirements ?? [];
  // Three groups, and the middle one is the point: what the pouch already
  // answers is not the label's to tick.
  const fixed = requirements.filter((r) => r.claimable && !r.answeredByPackaging);
  const byPackaging = requirements.filter((r) => r.claimable && r.answeredByPackaging);
  const perBatch = requirements.filter((r) => !r.claimable);
  const packagingDesigns = cov.data?.packagingDesigns ?? [];

  const save = async () => {
    if (!template) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/label-templates/${template.id}/coverage`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ keys: brandOnly ? [] : [...picked], brandOnly }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={template !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Fixed content on {template?.name}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          Tick every requirement this label prints for itself. Each one is then verified once,
          when the label is approved, instead of being asked again before every print — and
          what the approved packaging already carries is subtracted before this.
        </p>
        <p className="text-xs text-amber-700">
          Not the same as <span className="font-medium">Design &amp; Variable Fields</span>. That is
          what the label has room for; this is what it is trusted to have got right.
        </p>
        {cov.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {cov.data && !cov.data.configured && (
          <p className="text-sm text-amber-700" data-testid="coverage-no-ruleset">
            This facility's state has no label rule set loaded, so there is nothing to claim
            against yet.
          </p>
        )}
        {locked && cov.data?.configured && (
          <p className="text-xs text-amber-700" data-testid="coverage-locked">
            {template?.status === "retired"
              ? "This template is retired."
              : "Approved — the fixed content is frozen under the signature that approved it. Open Design & Variable Fields to raise a new version."}
          </p>
        )}
        <div className="max-h-80 overflow-y-auto space-y-3 pr-1">
          {fixed.length > 0 && (
            <div className="space-y-2">
              {fixed.map((r) => (
                <label key={r.key} className="flex items-start gap-2 text-sm cursor-pointer">
                  <Checkbox
                    className="mt-0.5"
                    disabled={locked || brandOnly}
                    checked={!brandOnly && picked.has(r.key)}
                    data-testid={`coverage-${r.key}`}
                    onCheckedChange={() => {
                      const next = new Set(picked);
                      if (next.has(r.key)) next.delete(r.key); else next.add(r.key);
                      setPicked(next);
                    }}
                  />
                  <span>
                    {r.itemText}
                    <span className="text-xs text-muted-foreground"> · {r.regulationRef}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {byPackaging.length > 0 && (
            <div className="space-y-1 border-t pt-3">
              <p className="text-xs font-medium text-green-800">
                Already answered by the approved packaging — not the label's to carry
              </p>
              {byPackaging.map((r) => (
                <p key={r.key} className="text-xs text-green-900/80 pl-1">
                  <span className="line-through">{r.itemText}</span>
                  <span className="text-green-900/60"> · {r.regulationRef}</span>
                </p>
              ))}
              {packagingDesigns.length > 0 && (
                <p className="text-[10px] text-green-900/70 pl-1 pt-0.5">
                  From {packagingDesigns.map((d) => `${d.designName} v${d.version}`).join(", ")}
                  {packagingDesigns.length > 1 && " — and only where every one of them says the same"}
                </p>
              )}
            </div>
          )}
          {perBatch.length > 0 && (
            <div className="space-y-1 border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground">
                Checked before every print — these change with the batch, so printing a field
                for them is not verifying them.
              </p>
              {perBatch.map((r) => (
                <p key={r.key} className="text-xs text-muted-foreground/80 pl-1">
                  {r.itemText}
                  <span className="text-muted-foreground/60"> · {r.regulationRef}</span>
                </p>
              ))}
            </div>
          )}
        </div>
        {/* ⛔ 2026-09-02 — the ONE way to sign a label that carries nothing.
            His question: "Why would we ever allow that?" The honest case is a
            logo or strain sticker beside the compliance label. Everything else
            is somebody about to freeze an empty list under a signature. */}
        {cov.data?.configured && (
          <div className="border-t pt-3 space-y-2">
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <Checkbox
                className="mt-0.5"
                disabled={locked}
                checked={brandOnly}
                data-testid="coverage-brand-only"
                onCheckedChange={(v) => setBrandOnly(v === true)}
              />
              <span>
                This is a brand-only sticker — it carries no state requirement.
                <span className="block text-xs text-muted-foreground">
                  A logo or strain name that sits beside the compliance label. Everything
                  above stays on the per-print check.
                </span>
              </span>
            </label>
            {!locked && !brandOnly && picked.size === 0 && fixed.length > 0 && (
              <p className="text-xs text-amber-700" data-testid="coverage-empty-warning">
                Nothing is ticked. This label cannot be signed until you tick what it prints,
                or tick the box above.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{locked ? "Close" : "Cancel"}</Button>
          {!locked && (
            <Button onClick={save} disabled={saving || !cov.data?.configured} data-testid="button-save-coverage">
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Save As ──────────────────────────────────────────────────────────────────
//
// 2026-09-01. The only fully-formed labels in the system are the seeded defaults,
// and a new template starts empty — so making a product its own label meant
// laying out twelve regions by hand. This takes a copy: artwork comes across,
// every signed claim stays behind (see the route for the list and the reason).

function SaveAsDialog({ template, onClose, onSaved, onError }: {
  template: LabelTemplate | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setName(template ? `${template.name} (copy)` : ""); }, [template]);

  const save = async () => {
    if (!template) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/label-templates/${template.id}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed");
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={template !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Save {template?.name} as a new label</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <Label className="text-xs">Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-saveas-name" />
        </div>
        <p className="text-xs text-muted-foreground">
          The copy is a Draft. It brings the size, the regions, the format lock and the variable
          fields. It does not bring the products, the fixed content, the approvals or the
          proof file — those were signed for on the original and have to be decided again here.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving || !name.trim()} data-testid="button-save-as">
            {saving ? "Copying…" : "Save As"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Templates pane ───────────────────────────────────────────────────────────

function TemplatesPane({ productType }: { productType: ProductType }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const tplQuery = useQuery({
    queryKey: ["label-templates", productType],
    queryFn: () => fetchJSON<LabelTemplate[]>(`/api/label-templates?productType=${encodeURIComponent(productType)}`),
  });
  const [editing, setEditing] = useState<LabelTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  // Signature dialog state — shared by regulatory/marketing approvals so the
  // initials + meaning are gathered in one place (CAPA Gate 1 UX pattern).
  const [signing, setSigning] = useState<{
    template: LabelTemplate;
    stage: "regulatory" | "marketing" | "meets";
  } | null>(null);
  const [retiring, setRetiring] = useState<LabelTemplate | null>(null);

  // Filter retired templates out of the default view; show them when toggled.
  // ⛔ His ruling 2026-08-31: retired, obsolete and superseded things stay in the
  // system and are found only when someone goes looking. The same switch now
  // covers retired PRODUCTS, so the two halves of the screen agree.
  const [showRetired, setShowRetired] = useState(false);
  const templates = (tplQuery.data ?? []).filter((t) => showRetired ? true : t.status !== "retired");
  const [linking, setLinking] = useState<LabelTemplate | null>(null);
  const [covering, setCovering] = useState<LabelTemplate | null>(null);
  const [savingAs, setSavingAs] = useState<LabelTemplate | null>(null);

  // The PRODUCTS of this type — a product is a recipe lineage.
  const prodQuery = useQuery({
    queryKey: ["label-studio-products", productType, showRetired],
    queryFn: () => fetchJSON<{ products: StudioProduct[] }>(
      `/api/label-studio/products?productType=${encodeURIComponent(productType)}${showRetired ? "&includeInactive=1" : ""}`,
    ),
  });
  const products = prodQuery.data?.products ?? [];
  const nameByLineage = new Map(products.map((p) => [p.lineageId, p.productName]));

  // Group by product, with the generic templates last. A product with no label
  // still gets a row — that gap is invisible today until somebody tries to print.
  const groups: Array<{ key: string; label: string; sub?: string | null; templates: LabelTemplate[] }> = [
    ...products.map((p) => ({
      key: `p-${p.lineageId}`,
      label: p.productName,
      sub: p.subtype,
      templates: templates.filter((t) => (t.productLineageIds ?? []).includes(p.lineageId)),
    })),
    {
      key: "generic",
      label: `Any ${productType} product`,
      templates: templates.filter((t) => (t.productLineageIds ?? []).length === 0),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={showRetired} onCheckedChange={setShowRetired} data-testid="switch-show-retired" />
          Show retired
        </label>
        <Button size="sm" onClick={() => setCreating(true)} data-testid="button-new-template"><Plus className="h-4 w-4 mr-1" /> New Template</Button>
      </div>
      {groups.map((group) => (
      <div key={group.key} className="space-y-2">
        <div className="flex items-baseline gap-2 pt-1">
          <h3 className="text-sm font-semibold">{group.label}</h3>
          {group.sub && <span className="text-xs text-muted-foreground">{group.sub}</span>}
        </div>
        {group.templates.length === 0 && (
          <p className="text-xs text-muted-foreground pl-1" data-testid={`empty-${group.key}`}>
            No label. Batches of this product will be asked every requirement before every print.
          </p>
        )}
      <div className="grid gap-3">
        {group.templates.map((t) => (
          <Card key={t.id} className={`p-4 ${t.status === "retired" ? "opacity-60" : ""}`} data-testid={`card-template-${t.id}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold">{t.name}</h3>
                  {t.isDefault && <Badge className="bg-amber-100 text-amber-800 border-amber-300"><Star className="h-3 w-3 mr-1" />Default</Badge>}
                  <Badge variant="outline">v{t.version}</Badge>
                  <Badge variant="outline">{t.widthIn}″ × {t.heightIn}″</Badge>
                  <TemplateStatusBadge template={t} />
                </div>
                {(() => {
                  const step = nextStepFor(t, (t.productLineageIds ?? []).map((l) => nameByLineage.get(l) ?? `#${l}`));
                  return (
                    <p
                      className={`text-xs mt-1 ${step.tone === "todo" ? "font-medium text-amber-800" : "text-muted-foreground"}`}
                      data-testid={`nextstep-${t.id}`}
                    >
                      {step.text}
                    </p>
                  );
                })()}
                {/* ⛔ Say when a label is shared BEFORE somebody edits it for one
                    product and changes another product's label by accident. */}
                {(t.productLineageIds ?? []).length > 1 && (
                  <p className="text-xs text-amber-700 mt-0.5" data-testid={`shared-${t.id}`}>
                    Shared by {(t.productLineageIds ?? []).map((l) => nameByLineage.get(l) ?? `#${l}`).join(", ")} — an edit here changes all of them.
                  </p>
                )}
                {(t.coverageKeys ?? []).length > 0 && (
                  <p className="text-xs text-green-800 mt-0.5" data-testid={`carries-${t.id}`}>
                    Prints {(t.coverageKeys ?? []).length} fixed requirement{(t.coverageKeys ?? []).length === 1 ? "" : "s"} — not asked again before each print.
                  </p>
                )}
                {t.brandOnly === true && (t.coverageKeys ?? []).length === 0 && (
                  <p className="text-xs text-muted-foreground mt-0.5" data-testid={`brand-only-${t.id}`}>
                    Brand-only sticker — carries no state requirement. Everything stays on the per-print check.
                  </p>
                )}
                <TemplateApprovalLine template={t} />
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                {/* ⛔ 2026-09-01 — Preview opens the UPLOADED PROOF, not a picture
                    the app draws from stacked text bands. The proof is the label
                    that was actually approved; the drawing never was one. */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={t.hasProof === false}
                  onClick={() => window.open(`/api/label-templates/${t.id}/proof`, "_blank")}
                  data-testid={`button-preview-template-${t.id}`}
                  title={t.hasProof === false
                    ? "No label uploaded yet. Open Design & Variable Fields and attach the PDF of the approved label."
                    : "Open the approved label PDF in a new tab"}
                >
                  Preview
                </Button>
                {t.status !== "retired" && (
                  <Button size="sm" variant="outline" onClick={() => setEditing(t)} data-testid={`button-edit-template-${t.id}`} title="The size, the locked format, the approved PDF proof, and the per-batch values the artwork has room for. Not the same as Fixed Content.">Design &amp; Variable Fields</Button>
                )}
                {t.status !== "retired" && (
                  <Button size="sm" variant="outline" onClick={() => setLinking(t)} data-testid={`button-products-${t.id}`}>Products</Button>
                )}
                <Button size="sm" variant="outline" onClick={() => setCovering(t)} data-testid={`button-coverage-${t.id}`} title="What this label is trusted to have got right — the fixed state requirements it prints, verified once when it is signed instead of before every print. Not the same as the variable field list under Design &amp; Variable Fields.">
                  Fixed Content
                </Button>
                <Button size="sm" variant="outline" onClick={() => setSavingAs(t)} data-testid={`button-saveas-${t.id}`} title="Copy this label's artwork into a new draft you can make product-specific">
                  Save As
                </Button>
                {t.status === "draft" && (
                  <Button size="sm" onClick={() => setSigning({ template: t, stage: "meets" })} data-testid={`button-meets-requirements-${t.id}`}>
                    Meets Requirements
                  </Button>
                )}
                {t.status !== "retired" && (
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRetiring(t)} data-testid={`button-retire-template-${t.id}`}>
                    Retire
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
      </div>
      ))}

      <LinkProductsDialog
        template={linking}
        products={products}
        onClose={() => setLinking(null)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["label-templates"] });
          setLinking(null);
        }}
        onError={(e) => toast({ title: "Could not set the products", description: String(e), variant: "destructive" })}
      />

      <SaveAsDialog
        template={savingAs}
        onClose={() => setSavingAs(null)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["label-templates"] });
          toast({ title: "Copied", description: "The new label is a Draft. Link its products, tick its Fixed Content, then sign it." });
          setSavingAs(null);
        }}
        onError={(e) => toast({ title: "Could not copy this template", description: String(e), variant: "destructive" })}
      />

      <CoverageDialog
        template={covering}
        onClose={() => setCovering(null)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["label-templates"] });
          qc.invalidateQueries({ queryKey: ["label-template-coverage"] });
          setCovering(null);
        }}
        onError={(e) => toast({ title: "Could not record this label's fixed content", description: String(e), variant: "destructive" })}
      />

      <TemplateEditor
        open={creating || editing !== null}
        productType={productType}
        template={editing}
        onClose={() => { setEditing(null); setCreating(false); }}
        onSaved={() => qc.invalidateQueries({ queryKey: ["label-templates"] })}
      />

      <SignApprovalDialog
        open={signing !== null}
        signing={signing}
        onClose={() => setSigning(null)}
        onSigned={() => {
          qc.invalidateQueries({ queryKey: ["label-templates"] });
          if (signing) {
            toast({
              title: signing.stage === "regulatory" ? "Regulatory approval recorded" : "Marketing approval recorded — template fully approved",
            });
          }
          setSigning(null);
        }}
        onError={(e) => toast({ title: "Approval failed", description: String(e), variant: "destructive" })}
      />

      <RetireTemplateDialog
        open={retiring !== null}
        template={retiring}
        onClose={() => setRetiring(null)}
        onRetired={() => {
          qc.invalidateQueries({ queryKey: ["label-templates"] });
          toast({ title: "Template retired" });
          setRetiring(null);
        }}
        onError={(e) => toast({ title: "Retire failed", description: String(e), variant: "destructive" })}
      />
    </div>
  );
}

// ── What to do next ──────────────────────────────────────────────────────────
//
// ⛔ 2026-09-01. His words after two hours in this screen: "I have 0 idea what to
// do when in the Label Studio section." The buttons are Products, Fixed Content,
// Design & Variable Fields and Meets Requirements, in no stated order — and the
// order matters, because approving with nothing ticked in Fixed Content freezes
// it empty for good.
//
// ⛔ 2026-09-03 — those two buttons were "Carries" and "Edit" until he said the
// NAMES were the confusion itself: "Carries / Edit ... regardless, the names need
// to change. That is what is confusing me." Fixed vs Variable is the axis he
// asked for. Wording only — no behaviour, no testids, no schema.
//
// So the card says the ONE next thing, in the state it is in. Nothing here is a
// rule or a gate; it is the screen telling you what it wants.

function nextStepFor(t: LabelTemplate, productNames: string[]): { text: string; tone: "todo" | "done" } {
  if (t.status === "retired") {
    return { text: "Retired. Nothing prints this. Save As to start a new label from it.", tone: "done" };
  }
  if (t.status === "approved") {
    const who = productNames.length > 0 ? productNames.join(", ") : `any ${t.productType} product`;
    return { text: `In use. Batches of ${who} print this.`, tone: "done" };
  }
  // Draft, in the order the work actually has to happen.
  if ((t.productLineageIds ?? []).length === 0) {
    return { text: "Not usable yet. Next: choose the products this label is for.", tone: "todo" };
  }
  if ((t.coverageKeys ?? []).length === 0 && t.brandOnly !== true) {
    return { text: "Next: tick what the label prints, under Fixed Content. It cannot be signed empty, and it is frozen once approved.", tone: "todo" };
  }
  if (t.hasProof === false) {
    return { text: "Next: attach the PDF of the approved label, under Design & Variable Fields.", tone: "todo" };
  }
  return { text: "Ready. Next: sign it with Meets Requirements.", tone: "todo" };
}

function TemplateStatusBadge({ template }: { template: LabelTemplate }) {
  switch (template.status) {
    case "approved":
      return <Badge className="bg-emerald-100 text-emerald-700 border-emerald-300"><ShieldCheck className="h-3 w-3 mr-1" />Approved</Badge>;
    case "regulatory_approved":
      return <Badge className="bg-sky-100 text-sky-700 border-sky-300">Regulatory approved · awaiting Marketing</Badge>;
    case "marketing_approved":
      return <Badge className="bg-sky-100 text-sky-700 border-sky-300">Marketing approved</Badge>;
    case "retired":
      return <Badge variant="outline" className="text-muted-foreground">Retired</Badge>;
    case "draft":
    default:
      return <Badge variant="secondary">Draft</Badge>;
  }
}

function TemplateApprovalLine({ template }: { template: LabelTemplate }) {
  if (template.status === "retired") {
    return (
      <p className="text-xs text-muted-foreground mt-1">
        Retired by {template.retiredByName ?? "—"}
        {template.retiredAt ? ` on ${new Date(template.retiredAt).toLocaleDateString()}` : ""}
        {template.retireReason ? ` — ${template.retireReason}` : ""}
      </p>
    );
  }
  // ⛔ An override is shown ON THE RECORD, not just in the audit log — the same
  // rule the CAPA segregation override lives under. A reason nobody sees is not
  // a control.
  const override = template.packagingOrderOverrideReason
    ? (
      <p className="text-xs text-amber-700 mt-1" data-testid={`packaging-override-${template.id}`}>
        Signed before its packaging was approved — {template.packagingOrderOverrideReason}
        {template.packagingOrderOverrideByName ? ` (${template.packagingOrderOverrideByName}` : ""}
        {template.packagingOrderOverrideByName && template.packagingOrderOverrideAt
          ? `, ${new Date(template.packagingOrderOverrideAt).toLocaleDateString()})`
          : template.packagingOrderOverrideByName ? ")" : ""}
      </p>
    )
    : null;
  const parts: string[] = [];
  if (template.regulatoryApproverName) parts.push(`Reg: ${template.regulatoryApproverName}`);
  if (template.marketingApproverName) parts.push(`Mktg: ${template.marketingApproverName}`);
  if (parts.length === 0) return override;
  return (
    <>
      <p className="text-xs text-muted-foreground mt-1">{parts.join(" · ")}</p>
      {override}
    </>
  );
}

function SignApprovalDialog({
  open, signing, onClose, onSigned, onError,
}: {
  open: boolean;
  signing: { template: LabelTemplate; stage: "regulatory" | "marketing" | "meets" } | null;
  onClose: () => void;
  onSigned: () => void;
  onError: (e: unknown) => void;
}) {
  const [initials, setInitials] = useState("");
  const [meaning, setMeaning] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // ⛔ PACKAGE FIRST, THEN LABEL, half-refused (his ruling 2026-09-02). The
  // server refuses the signature when a product has no approved packaging and
  // no reason was given, and names the products. The reason box only appears
  // once that has happened — asking for it up front would train people to fill
  // it in every time, which is how an override stops meaning anything.
  const [needsOverride, setNeedsOverride] = useState<string[] | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  // Reset fields when the dialog re-opens for a different signing.
  // ⛔ 2026-09-04 — useEffect, not useMemo: state hydration is an effect, and a
  // useMemo doing it runs during render and may re-run at any time. The deps here
  // are already primitives so this one was not losing data, but it is the same
  // anti-pattern and is fixed with its two siblings.
  useEffect(() => {
    setInitials(""); setMeaning(""); setNeedsOverride(null); setOverrideReason("");
  }, [signing?.template.id, signing?.stage]);

  const stageLabel = signing?.stage === "meets" ? "Meets Requirements" : signing?.stage === "regulatory" ? "Regulatory" : "Marketing";

  const submit = async () => {
    if (!signing) return;
    if (!initials.trim() || !meaning.trim()) return;
    setSubmitting(true);
    try {
      const path = signing.stage === "meets" ? "meets-requirements" : signing.stage === "regulatory" ? "regulatory-approve" : "marketing-approve";
      const r = await fetch(`/api/label-templates/${signing.template.id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          initials: initials.trim(),
          signatureMeaning: meaning.trim(),
          ...(overrideReason.trim() ? { packagingOrderOverrideReason: overrideReason.trim() } : {}),
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as {
          error?: string; requiresPackagingOverride?: boolean; products?: string[];
        };
        // Not an error — the server is asking for the reason, so the dialog
        // stays open and grows a box rather than throwing the signature away.
        if (body.requiresPackagingOverride) {
          setNeedsOverride(body.products ?? []);
          setSubmitting(false);
          return;
        }
        throw new Error(body.error ?? "Failed to sign this approval.");
      }
      onSigned();
    } catch (e) {
      onError(e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{stageLabel} Approval · {signing?.template.name ?? ""}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {signing?.stage === "meets"
              ? "Quality confirms this label template MEETS STATE REQUIREMENTS — the approved proof carries all required content and the format (size, font, layout) is locked. Requires a proof attached and the field list recorded; the originator may not sign."
              : signing?.stage === "regulatory"
              ? "Regulatory review confirms the template's required state and federal warnings, regulation references, and content compliance. The originator may not sign."
              : "Marketing review confirms brand voice, layout fit, and final visual presentation. Must be signed by a different approver from the Regulatory signer; the originator may not sign."}
          </p>
          <div>
            <Label>Your initials</Label>
            <Input value={initials} onChange={(e) => setInitials(e.target.value)} placeholder="e.g. JS" data-testid="input-approval-initials" />
          </div>
          <div>
            <Label>Signature meaning</Label>
            <Textarea rows={3} value={meaning} onChange={(e) => setMeaning(e.target.value)} placeholder={signing?.stage === "meets" ? "Meets state requirements — approved proof + locked format verified." : signing?.stage === "regulatory" ? "Regulatory review complete — content meets MI MRA labeling requirements." : "Marketing review complete — final visual layout approved." } data-testid="input-approval-meaning" />
          </div>
          {needsOverride !== null && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
              <p className="text-sm font-semibold text-amber-900">
                Signing this label before its packaging
              </p>
              <p className="text-xs text-amber-900/90 leading-relaxed">
                {needsOverride.length > 0
                  ? `${needsOverride.join(", ")} has no approved packaging design yet.`
                  : "This product has no approved packaging design yet."}
                {" "}
                The packaging is normally approved first, because what the pouch carries decides
                what is left for the label. You can sign anyway — write down why.
              </p>
              <div>
                <Label>Reason for signing the label first</Label>
                <Textarea
                  rows={2}
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="e.g. Pouch artwork is still with the supplier; the label carries every requirement on its own."
                  data-testid="input-packaging-override-reason"
                />
              </div>
              <p className="text-[10px] text-amber-900/80">
                Kept on the label and in the audit trail, with your name and the date.
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={!initials.trim() || !meaning.trim() || submitting || (needsOverride !== null && !overrideReason.trim())}
            data-testid="button-confirm-approval"
          >
            {submitting ? "Signing…" : needsOverride !== null ? `Sign ${stageLabel} Approval anyway` : `Sign ${stageLabel} Approval`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RetireTemplateDialog({
  open, template, onClose, onRetired, onError,
}: {
  open: boolean;
  template: LabelTemplate | null;
  onClose: () => void;
  onRetired: () => void;
  onError: (e: unknown) => void;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // ⛔ 2026-09-04 — useEffect, not useMemo (see TemplateEditor below). Primitive
  // dep, so this one was not losing data, but the anti-pattern goes with its siblings.
  useEffect(() => { setReason(""); }, [template?.id]);

  const submit = async () => {
    if (!template || !reason.trim()) return;
    setSubmitting(true);
    try {
      await fetchJSON(`/api/label-templates/${template.id}/retire`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      onRetired();
    } catch (e) {
      onError(e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Retire Template · {template?.name ?? ""}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Retiring a template is terminal — it cannot be edited or signed again. The row is preserved (with the existing approval audit trail) so any historical label PDFs that reference it remain auditable.
          </p>
          <div>
            <Label>Reason</Label>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Replaced by template v2 with new MI regulation reference." data-testid="input-retire-reason" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={!reason.trim() || submitting} data-testid="button-confirm-retire">
            {submitting ? "Retiring…" : "Retire Template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemplateEditor({ open, productType, template, onClose, onSaved }: {
  open: boolean; productType: ProductType; template: LabelTemplate | null; onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useToast();

  const [name, setName] = useState(template?.name ?? "");
  const [widthIn, setWidthIn] = useState(template?.widthIn ?? 2.0);
  const [heightIn, setHeightIn] = useState(template?.heightIn ?? 4.0);
  const [isDefault, setIsDefault] = useState(template?.isDefault ?? false);
  // ⛔ Carried, not edited. The designer came out 2026-09-01; the value still
  // rides through PATCH so a save cannot silently blank a template the PDF
  // renderer still draws from.
  const [regions, setRegions] = useState<RegionConfig[]>(template?.regions ?? []);
  const [fontFamily, setFontFamily] = useState(template?.formatSpec?.fontFamily ?? "");
  const [fontSizes, setFontSizes] = useState(template?.formatSpec?.fontSizes ?? "");
  const [layoutNotes, setLayoutNotes] = useState(template?.formatSpec?.layoutNotes ?? "");
  const [fieldSet, setFieldSet] = useState<Set<string>>(new Set(template?.fieldList ?? []));
  const currentUser = useGetCurrentUser().data;

  // ⛔ 2026-09-04 — THIS IS THE ONE THAT LOST DATA. It was a useMemo keyed on the
  // whole `template` object. useMemo runs DURING render and React may re-run it
  // even when the deps look unchanged, so every time the templates query refetched
  // — saving Fixed Content, uploading a proof — the still-open dialog was handed a
  // new `template` object and silently reset EVERY field here back to the server
  // copy: name, size, format lock, and the variable-field ticks. Save then
  // serialised the reset values with no error and reported success. Audit trail on
  // template 12 shows fieldList written null -> [] -> [], never once non-empty.
  //
  // Now an effect, keyed on the dialog opening plus the template identity and
  // VERSION. A refetch that returns the same version cannot stomp edits in
  // progress; a genuinely different template, or a reopen, still hydrates.
  useEffect(() => {
    if (!open) return;
    setName(template?.name ?? "");
    setWidthIn(template?.widthIn ?? 2.0);
    setHeightIn(template?.heightIn ?? 4.0);
    setIsDefault(template?.isDefault ?? false);
    setRegions(template?.regions ?? []);
    setFontFamily(template?.formatSpec?.fontFamily ?? "");
    setFontSizes(template?.formatSpec?.fontSizes ?? "");
    setLayoutNotes(template?.formatSpec?.layoutNotes ?? "");
    setFieldSet(new Set(template?.fieldList ?? []));
  }, [open, template?.id, template?.version]);

  const save = useMutation({
    mutationFn: async () => {
      const payload = { name, widthIn, heightIn, isDefault, regions, productType, formatSpec: { fontFamily, fontSizes, layoutNotes }, fieldList: Array.from(fieldSet) };
      if (template) {
        return fetchJSON(`/api/label-templates/${template.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      return fetchJSON(`/api/label-templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => { onSaved(); onClose(); toast({ title: template ? "Template updated" : "Template created" }); },
    onError: (e) => toast({ title: "Save failed", description: String(e), variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{template ? `Design & Variable Fields: ${template.name}` : `New Template · ${productType}`}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-3">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-template-name" />
            </div>
            <div>
              <Label>Width (in)</Label>
              <Input type="number" step="0.1" value={widthIn} onChange={(e) => setWidthIn(parseFloat(e.target.value) || 0)} data-testid="input-template-width" />
            </div>
            <div>
              <Label>Height (in)</Label>
              <Input type="number" step="0.1" value={heightIn} onChange={(e) => setHeightIn(parseFloat(e.target.value) || 0)} data-testid="input-template-height" />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2">
                <Switch checked={isDefault} onCheckedChange={setIsDefault} data-testid="switch-default" />
                <span className="text-sm">Default for {productType}</span>
              </label>
            </div>
          </div>

          {template && currentUser && (
            <AttachmentsPanel
              parentTable="label_templates"
              parentId={template.id}
              allowSupplementary={template.status !== "retired"}
              currentUserId={currentUser.id}
              currentUserRole={currentUser.role}
              title="Approved Label Proof (the facility's approved label)"
            />
          )}

          <div className="rounded-lg border p-3 space-y-3">
            <Label className="text-sm font-semibold">Format lock (recorded, not rendered)</Label>
            <p className="text-xs text-muted-foreground">Physical size is set above (width × height). Record the rest of the locked format so print-time review can confirm the facility printed on-spec.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Font family</Label>
                <Input value={fontFamily} onChange={(e) => setFontFamily(e.target.value)} placeholder="e.g. Helvetica" data-testid="input-format-font-family" />
              </div>
              <div>
                <Label className="text-xs">Font sizes</Label>
                <Input value={fontSizes} onChange={(e) => setFontSizes(e.target.value)} placeholder="e.g. body 8pt, warnings 6pt" data-testid="input-format-font-sizes" />
              </div>
            </div>
            <div>
              <Label className="text-xs">Layout notes</Label>
              <Textarea rows={2} value={layoutNotes} onChange={(e) => setLayoutNotes(e.target.value)} placeholder="e.g. universal symbol top-right; pregnancy warning boxed at bottom." data-testid="input-format-layout-notes" />
            </div>
          </div>

          <div className="rounded-lg border p-3">
            <Label className="text-sm font-semibold">Variable fields the label has room for</Label>
            <p className="text-xs text-muted-foreground">
              Tick the per-batch values the approved artwork has a slot for — the METRC tag, the THC
              number, the batch number. These change with every batch, so CannaQMS puts them in the
              data file, and they stay on the check before every print.
            </p>
            <p className="text-xs text-amber-700 mb-2">
              Not the same as <span className="font-medium">Fixed Content</span>. This is what the
              label has room for. Fixed Content is what it is trusted to have got right — a slot for
              the THC number is not that number being right on this batch.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {LABEL_VARIABLE_FIELDS.map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={fieldSet.has(key)}
                    onChange={(e) => setFieldSet((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(key); else next.delete(key);
                      return next;
                    })}
                    data-testid={`checkbox-field-${key}`}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {/* ⛔ 2026-09-01 — THE REGION DESIGNER IS GONE FROM THE EDITOR.
              His ruling: "they are just templates. They can create and format
              their own labels." Under the bring-your-own-proof model the artwork
              is the operator's own PDF; this stack-of-bands builder could not lay
              a real label out — no margins, no columns, no images, spacing only
              via a spacer region's font size — and its presence taught people the
              app designed their label, which is the misunderstanding that cost a
              whole afternoon.
              ⚠️ The `regions` VALUE is still carried untouched on save below, and
              the PDF renderer still draws from it. That is deliberate and staged:
              stop offering the editor first, confirm nobody prints from the
              output, remove the renderer second. Deleting both at once would take
              away a print path with nothing in its place. */}

          {template && (
            <p className="text-xs text-muted-foreground">Saving bumps the template to v{(template.version ?? 1) + 1} and clears the previous approval.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending} data-testid="button-save-template">
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
