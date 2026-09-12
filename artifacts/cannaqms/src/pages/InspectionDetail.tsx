import { useEffect, useState, useRef } from "react";
import { useParams, Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { accentClass, toneInspectionResult } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Pencil, CheckCircle2, XCircle, Lock, Ban, RotateCcw, Printer } from "lucide-react";
import { format } from "date-fns";
import { formatDateOnly } from "@/lib/utils";
import { defaultUnitForItemType, dimensionOf, isCloneItemType, ITEM_TYPES, parseItemNameOptions, UNIT_OPTIONS } from "@/lib/units";
import { useToast } from "@/hooks/use-toast";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { CancelRecordDialog } from "@/components/dialogs/CancelRecordDialog";
import { CreateDestructionRecordDialog } from "@/components/dialogs/CreateDestructionRecordDialog";

// Roles permitted to Cancel (mirror server CANCEL_ROLES). Re-open is Admin-only.
const CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);
// Session 59 — roles permitted to delete a line item (mirror server
// ITEM_DELETE_ROLES). Deleting a line erases a receiving record and pulls any
// stock it created back out of inventory, so Supervisor is deliberately NOT
// included even though a Supervisor may sign off a Pass. The button is hidden
// rather than disabled: it is a permission this user will never have, not a
// state they can get out of. The server enforces it regardless.
const ITEM_DELETE_ROLES = new Set(["Manager", "Quality", "Admin"]);

type Inspection = {
  id: number; inspectionNumber: string; supplierName: string | null;
  poManifestNumber: string | null; inspectionDate: string;
  inspectedByName: string | null; result: string; inspectionNotes: string | null;
  stateRationale?: string | null;
  stateRationaleByName?: string | null;
  stateRationaleAt?: string | null;
  passApproverName?: string | null;
  passApproverInitials?: string | null;
  passApproverMeaning?: string | null;
  passApprovedAt?: string | null;
};

type Item = {
  id: number; inspectionId: number; itemName: string;
  materialType: string | null;
  supplierItemCode: string | null; lotNumber: string | null;
  expiryDate: string | null; quantityReceived: number | null;
  quantityUom: string | null; result: string; notes: string | null;
  disposition?: string | null; dispositionNotes?: string | null;
  metrcTag?: string | null;
  strainType?: string | null;
  // Potency off the COA (2026-09-06) — cannabis lines only. Carried onto the lot
  // when the line is accepted, so Inventory can show what a lot assays at.
  thcPct?: number | null;
  cbdPct?: number | null;
  potencySource?: string | null;
  potencyTestedAt?: string | null;
};

// NC-1 — shape returned by GET /incoming-inspections/:id/non-conformances.
type RelatedNC = {
  id: number; ncNumber: string; title: string;
  severity: string; status: string; createdAt: string;
};

// Material Type drives the cannabis overlay on the lot created at Pass: any
// "Cannabis – …" value tags the lot as cannabis (shows on Lot Traceability) and
// becomes its item type; the rest are non-cannabis materials.
//
// The vocabulary itself is ITEM_TYPES in lib/units — shared with the inventory
// catalog. It used to be a separate list here, which drifted from the catalog's
// ("Packaging" vs "Packaging Material", a single "Ingredient / Other" bucket
// covering ingredients, hardware, solvents and terpenes alike), so a type
// chosen at receiving did not match the catalog it fed.

const RESULT_OPTIONS = ["Pass", "Fail", "Conditional"] as const;
const DISPOSITION_OPTIONS = ["Return to Vendor", "Scrap", "Use As Is", "Rework"] as const;
function emptyItem(): Partial<Item> {
  return { itemName: "", materialType: "", supplierItemCode: "", lotNumber: "", expiryDate: "", quantityReceived: undefined, quantityUom: "", result: "Pass", notes: "" };
}

export default function InspectionDetail() {
  const { id } = useParams<{ id: string }>();
  const inspectionId = Number(id);
  const { toast } = useToast();
  const { data: currentUser } = useGetCurrentUser();
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  // NC-1 — non-conformances raised from this inspection (reverse of the NC's
  // sourceInspectionId link), so the cross-reference is visible from both sides.
  const [relatedNCs, setRelatedNCs] = useState<RelatedNC[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [itemNameOptions, setItemNameOptions] = useState<string[]>([]);
  // name (lowercased) → the type that name is set up as, for the Material Type
  // auto-fill. Empty when the API is still on the older names-only response.
  const [itemTypeByName, setItemTypeByName] = useState<Map<string, string>>(new Map());
  // name (lowercased) → the unit that item is already stocked in, straight from
  // the catalog. Preferred over the type's default, which is null for every
  // non-cannabis type and so almost never filled anything.
  const [itemUomByName, setItemUomByName] = useState<Map<string, string>>(new Map());
  // True once the auto-fill has actually filled Material Type for the current
  // draft, so the form can say WHERE the value came from instead of it just
  // appearing on its own.
  const [typeWasAutoFilled, setTypeWasAutoFilled] = useState(false);
  // Same ownership question for the unit: a UoM this form derived from the type
  // is not the operator's choice, so a later type change may replace or clear
  // it. A unit picked from the dropdown is left alone.
  const [uomWasAutoFilled, setUomWasAutoFilled] = useState(false);
  const [draft, setDraft] = useState<Partial<Item>>(emptyItem());
  const [transitioning, setTransitioning] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [pullingPotency, setPullingPotency] = useState(false);
  // Rationale dialog for Fail / Conditional transitions.
  const [pendingState, setPendingState] = useState<"Fail" | "Conditional" | null>(null);
  const [rationaleText, setRationaleText] = useState("");
  // Supervisor sign-off dialog for Pass when one or more items are Fail.
  const [supervisorOpen, setSupervisorOpen] = useState(false);
  // Session 52.1 — Cancel / Re-open (Part 11). Cancel = soft, recoverable,
  // e-signed (no hard delete). Re-open is Admin-only.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [uncancelOpen, setUncancelOpen] = useState(false);
  const [uncancelPending, setUncancelPending] = useState(false);
  // Scrap disposition on a cannabis line -> open a METRC Destruction Record for it.
  const [destructionItem, setDestructionItem] = useState<Item | null>(null);

  const [error, setError] = useState<string | null>(null);
  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const [insRes, itemsRes, ncsRes] = await Promise.all([
        fetch(`/api/incoming-inspections/${inspectionId}`, { credentials: "include" }),
        fetch(`/api/incoming-inspections/${inspectionId}/items`, { credentials: "include" }),
        fetch(`/api/incoming-inspections/${inspectionId}/non-conformances`, { credentials: "include" }),
      ]);
      if (!insRes.ok) {
        setError(insRes.status === 404 ? "Inspection not found." : "Failed to load inspection.");
      } else {
        setInspection(await insRes.json());
      }
      if (itemsRes.ok) setItems(await itemsRes.json());
      if (ncsRes.ok) setRelatedNCs(await ncsRes.json());
    } catch {
      setError("Network error loading inspection.");
    } finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, [inspectionId]);
  // Item-name autocomplete source (existing names) — reuse canonical names,
  // avoid "Mouthpiece" vs "Mouthpieces" duplicates that split inventory. The
  // same response carries each name's TYPE, which drives the Material Type
  // auto-fill below.
  useEffect(() => {
    fetch("/api/incoming-inspections/item-name-options", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((payload) => {
        const { names, typeByName, uomByName } = parseItemNameOptions(payload);
        setItemNameOptions(names);
        setItemTypeByName(typeByName);
        setItemUomByName(uomByName);
      })
      .catch(() => {});
  }, []);

  // Fill Material Type from how the item is already set up.
  //
  // Deliberately a LOOKUP, not a guess: the value is whatever the facility
  // recorded for that item in the catalog (or, failing that, on the last
  // receiving line), so it can always be explained on a Part 11 record.
  //
  // A type the OPERATOR chose from the dropdown is never touched. A type this
  // auto-fill placed is not a choice, so a later name change replaces it — and
  // clears it when the new name is unknown. Without that, correcting a mistyped
  // item name left the previous item's type behind with nothing on screen
  // saying so, which on a cannabis value wrongly demands a METRC tag.
  //
  // Picking a type also carries its unit default across, mirroring the Select's
  // own handler, which is what gets clones to "each". The unit follows the SAME
  // ownership rule as the type: one this form derived is replaced or cleared
  // along with it, so a cannabis "g" can't be left behind on a box of cones.
  function applyItemName(name: string) {
    // Decided OUTSIDE the setDraft updater — an updater must stay pure, or a
    // StrictMode double-invoke fires the flags twice.
    const looked = itemTypeByName.get(name.trim().toLowerCase()) ?? null;
    const mayReplace = !(draft.materialType ?? "").trim() || typeWasAutoFilled;
    const mayReplaceUom = !(draft.quantityUom ?? "").trim() || uomWasAutoFilled;
    // The item's own stocked unit wins over the type default: the catalog says
    // how THIS item is bought, the type only says what its category usually is.
    const fill = itemUomByName.get(name.trim().toLowerCase())
      ?? (looked ? defaultUnitForItemType(looked) : null);
    setTypeWasAutoFilled(mayReplace && !!looked);
    setUomWasAutoFilled(mayReplace && mayReplaceUom && !!fill);
    setDraft((d) => {
      const next: Partial<Item> = { ...d, itemName: name };
      if (!mayReplace) return next;
      next.materialType = looked ?? "";
      if (mayReplaceUom) {
        // A derived unit is dropped when the new name has no unit of its own —
        // it belonged to the old item, not to this line.
        if (fill) next.quantityUom = fill;
        else if (uomWasAutoFilled) next.quantityUom = "";
      }
      return next;
    });
  }

  function openCreate() { setEditing(null); setDraft(emptyItem()); setTypeWasAutoFilled(false); setUomWasAutoFilled(false); setDialogOpen(true); }
  // Arriving from "create inspection" (?addItem=1) opens the add-line-item dialog
  // ONCE the inspection has loaded — and only if it isn't Closed/cancelled, so the
  // hand-off can't pop the add form on a finalized (locked) inspection.
  const autoAddFired = useRef(false);
  useEffect(() => {
    if (autoAddFired.current || !inspection) return;
    autoAddFired.current = true;
    const wantAdd = new URLSearchParams(window.location.search).get("addItem") === "1";
    const isLocked = inspection.result === "Closed" || !!(inspection as { cancelledAt?: string | null }).cancelledAt;
    if (wantAdd && !isLocked) openCreate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspection]);
  // Editing an existing line never auto-fills — the saved type is the record.
  function openEdit(item: Item) { setEditing(item); setDraft({ ...item }); setTypeWasAutoFilled(false); setUomWasAutoFilled(false); setDialogOpen(true); }

  // ── Header-level state transitions ────────────────────────────────────────
  // The inspection moves through Pending → (Pass | Fail | Conditional) → Closed.
  // Only "Closed" is treated as final; Quality / Manager / Admin can re-open
  // via the Settings menu (out of scope for this view).
  // Performs the actual PATCH. Body merges any extra fields (rationale,
  // approver signoff) the dialogs collected before this was called.
  async function performTransition(next: "Pass" | "Fail" | "Conditional" | "Closed", extra: Record<string, unknown> = {}) {
    setTransitioning(true);
    try {
      const res = await fetch(`/api/incoming-inspections/${inspectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ result: next, ...extra }),
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({} as { error?: string }));
        toast({ title: msg?.error ?? "State change failed", variant: "destructive" });
        return false;
      }
      const data = await res.json().catch(() => ({}));
      const added = typeof data.addedToInventory === "number" ? data.addedToInventory : 0;
      toast({
        title: `Inspection marked ${next}`,
        description: next === "Pass" && added > 0
          ? `${added} accepted item${added === 1 ? "" : "s"} added to Inventory.`
          : undefined,
      });
      void reload();
      return true;
    } finally {
      setTransitioning(false);
    }
  }

  // Entry point for state buttons — runs pre-flight, then either opens a
  // dialog (Fail/Conditional rationale, or Pass-with-fails supervisor) or
  // calls performTransition directly.
  async function transitionTo(next: "Pass" | "Fail" | "Conditional" | "Closed") {
    if (!inspection) return;
    if (inspection.result === next) return;
    if (next === "Pass" && items.length === 0) {
      toast({ title: "Add at least one line item before Pass.", variant: "destructive" });
      return;
    }
    if (next === "Pass" && items.some(it => it.result === "Pending")) {
      toast({ title: "Resolve all line-item results before Pass.", variant: "destructive" });
      return;
    }
    if (next === "Fail" || next === "Conditional") {
      setRationaleText("");
      setPendingState(next);
      return;
    }
    if (next === "Pass" && items.some(it => it.result === "Fail")) {
      setSupervisorOpen(true);
      return;
    }
    await performTransition(next);
  }

  async function confirmRationale() {
    if (!pendingState) return;
    const text = rationaleText.trim();
    if (!text) {
      toast({ title: "Rationale is required.", variant: "destructive" });
      return;
    }
    const ok = await performTransition(pendingState, { rationale: text });
    if (ok) {
      setPendingState(null);
      setRationaleText("");
    }
  }

  async function confirmSupervisorPass(initials: string, meaning: string) {
    const ok = await performTransition("Pass", { approverInitials: initials, approverMeaning: meaning });
    if (ok) setSupervisorOpen(false);
  }

  // ── Session 52.1 — Cancel / Re-open (off-spec endpoints; raw fetch) ──────────
  // Throw on failure so the dialogs surface the server message inline.
  async function handleCancel(reason: string, initials: string, meaning: string) {
    setCancelPending(true);
    try {
      const r = await fetch(`/api/incoming-inspections/${inspectionId}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, initials, signatureMeaning: meaning }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to cancel inspection.");
      }
      void reload();
      toast({ title: "Inspection cancelled", description: "Retained and recoverable; removed from active use." });
    } finally {
      setCancelPending(false);
    }
  }

  async function handleUncancel(initials: string, meaning: string) {
    setUncancelPending(true);
    try {
      const r = await fetch(`/api/incoming-inspections/${inspectionId}/uncancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initials, signatureMeaning: meaning }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to re-open inspection.");
      }
      void reload();
      toast({ title: "Inspection re-opened", description: "Record returned to active use." });
    } finally {
      setUncancelPending(false);
    }
  }



  async function resyncInventory() {
    if (!inspection) return;
    setResyncing(true);
    try {
      const res = await fetch(`/api/incoming-inspections/${inspectionId}/resync-inventory`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({} as { error?: string }));
        toast({ title: msg?.error ?? "Re-sync failed", variant: "destructive" });
        return;
      }
      const { addedToInventory } = (await res.json()) as { addedToInventory: number };
      toast({
        title: addedToInventory > 0
          ? `Re-synced — ${addedToInventory} item(s) added to Inventory.`
          : "Already in sync — no new items to add.",
      });
    } catch {
      toast({ title: "Network error during re-sync", variant: "destructive" });
    } finally {
      setResyncing(false);
    }
  }

  // Pull THC/CBD from the Metrc lab results attached to the incoming package
  // (2026-09-06). Michigan requires transferred cannabis to be tested, so the
  // numbers are usually already in Metrc and typing them off the paper COA is
  // just a chance to fat-finger a digit. Needs the package tag first, because
  // that is what identifies the package to Metrc.
  //
  // The route answers real HTTP codes, so a refusal is a refusal — we never
  // write a blank potency and mark it as state-confirmed.
  async function pullPotencyFromMetrc() {
    const tag = (draft.metrcTag ?? "").trim();
    if (!tag) {
      toast({ title: "Enter the METRC package tag first", description: "Metrc identifies lab results by the package tag.", variant: "destructive" });
      return;
    }
    setPullingPotency(true);
    try {
      const r = await fetch(`/api/metrc/packages/${encodeURIComponent(tag)}/potency`, { credentials: "include" });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; thcPct?: number | null; cbdPct?: number | null; testedAt?: string | null; labName?: string | null };
      if (!r.ok || j.ok === false) {
        toast({ title: "Couldn't pull potency from Metrc", description: j.error ?? "Metrc did not answer.", variant: "destructive" });
        return;
      }
      setDraft((d) => ({
        ...d,
        thcPct: j.thcPct ?? null,
        cbdPct: j.cbdPct ?? null,
        potencySource: "metrc",
        potencyTestedAt: j.testedAt ? String(j.testedAt).slice(0, 10) : null,
      }));
      toast({
        title: "Potency pulled from Metrc",
        description: [
          j.thcPct != null ? `${j.thcPct}% THC` : null,
          j.cbdPct != null ? `${j.cbdPct}% CBD` : null,
          j.labName ?? null,
        ].filter(Boolean).join(" · "),
      });
    } catch (e) {
      toast({ title: "Couldn't pull potency from Metrc", description: e instanceof Error ? e.message : "Network error.", variant: "destructive" });
    } finally {
      setPullingPotency(false);
    }
  }

  async function saveItem() {
    const isCannabisDraft = (draft.materialType ?? "").toLowerCase().startsWith("cannabis");
    if (!draft.itemName || !draft.itemName.trim()) {
      toast({ title: "Item name is required", variant: "destructive" });
      return;
    }
    if ((draft.materialType ?? "").toLowerCase().startsWith("cannabis") && !(draft.metrcTag ?? "").trim()) {
      toast({ title: "METRC package tag is required for cannabis materials", variant: "destructive" });
      return;
    }
    if (draft.result === "Fail" && !draft.disposition) {
      toast({ title: "Choose a disposition for the failed item", variant: "destructive" });
      return;
    }
    if (draft.result === "Fail" && draft.disposition === "Use As Is" && !(draft.dispositionNotes ?? "").trim()) {
      toast({ title: "Use As Is requires a justification", variant: "destructive" });
      return;
    }
    const payload = {
      itemName: draft.itemName.trim(),
      materialType: draft.materialType || null,
      supplierItemCode: draft.supplierItemCode || null,
      lotNumber: draft.lotNumber || null,
      metrcTag: (draft.materialType ?? "").toLowerCase().startsWith("cannabis") ? ((draft.metrcTag ?? "").trim() || null) : null,
      strainType: (draft.materialType ?? "").toLowerCase().startsWith("cannabis") ? (draft.strainType || null) : null,
      // Potency travels only on a cannabis line — a packaging or excipient line
      // has no THC/CBD, and sending 0 would read downstream as "tested, zero".
      thcPct: isCannabisDraft ? (draft.thcPct ?? null) : null,
      cbdPct: isCannabisDraft ? (draft.cbdPct ?? null) : null,
      potencySource: isCannabisDraft && (draft.thcPct != null || draft.cbdPct != null)
        ? (draft.potencySource ?? "manual")
        : null,
      potencyTestedAt: isCannabisDraft ? (draft.potencyTestedAt || null) : null,
      expiryDate: draft.expiryDate || null,
      quantityReceived: draft.quantityReceived === undefined || draft.quantityReceived === null || (draft.quantityReceived as unknown as string) === "" ? null : Number(draft.quantityReceived),
      quantityUom: draft.quantityUom || null,
      result: draft.result || "Pass",
      disposition: draft.result === "Fail" ? (draft.disposition || null) : null,
      dispositionNotes: draft.result === "Fail" ? (draft.dispositionNotes || null) : null,
      notes: draft.notes || null,
    };
    const url = editing
      ? `/api/incoming-inspections/${inspectionId}/items/${editing.id}`
      : `/api/incoming-inspections/${inspectionId}/items`;
    const res = await fetch(url, {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // Session 59 — show what the server actually said. Rejecting a line whose
      // lot a batch has already drawn on comes back as a 409 with a specific
      // explanation, and "Save failed" on its own leaves the operator with no
      // idea why the edit didn't take.
      const msg = await res.json().then((b) => (b?.error as string) || "").catch(() => "");
      toast({
        title: "Save failed",
        description: msg || undefined,
        variant: "destructive",
      });
      return;
    }
    toast({ title: editing ? "Item updated" : "Item added" });
    setDialogOpen(false); void reload();
  }

  async function deleteItem(itemId: number) {
    if (!confirm("Delete this line item?")) return;
    const res = await fetch(`/api/incoming-inspections/${inspectionId}/items/${itemId}`, {
      method: "DELETE", credentials: "include",
    });
    if (!res.ok) {
      // Same reason as the save handler: a delete refused because a batch has
      // already drawn from the lot comes back with a specific explanation.
      const msg = await res.json().then((b) => (b?.error as string) || "").catch(() => "");
      toast({ title: "Delete failed", description: msg || undefined, variant: "destructive" });
      return;
    }
    toast({ title: "Item deleted" }); void reload();
  }

  if (error) {
    return (
      <AppLayout>
        <div className="text-sm text-muted-foreground py-12 text-center space-y-2">
          <p>{error}</p>
          <Link href="/inspections" className="text-primary hover:underline">← Back to inspections</Link>
        </div>
      </AppLayout>
    );
  }
  if (loading || !inspection) {
    return <AppLayout><Skeleton className="h-32 w-full" /></AppLayout>;
  }

  const expiringSoon = (d: string | null) => {
    if (!d) return false;
    const ms = new Date(d).getTime() - Date.now();
    return ms > 0 && ms < 1000 * 60 * 60 * 24 * 30;
  };
  const expired = (d: string | null) => d && new Date(d).getTime() < Date.now();

  const isClosed = inspection.result === "Closed";
  const isCancelled = !!(inspection as { cancelledAt?: string | null }).cancelledAt;
  // Cancelled OR Closed → no further edits/transitions.
  const locked = isClosed || isCancelled;
  const canCancel = !!currentUser?.role && CANCEL_ROLES.has(currentUser.role);
  const canReopen = currentUser?.role === "Admin";
  const canDeleteItem = !!currentUser?.role && ITEM_DELETE_ROLES.has(currentUser.role);
  const passCount = items.filter(i => i.result === "Pass").length;
  const failCount = items.filter(i => i.result === "Fail").length;
  // Session 99 (#6) — header accent line = inspection result (fail → urgent;
  // conditional → caution); cancelled → urgent; closed/pass reads calm/neutral.
  const resultTone = toneInspectionResult(inspection.result);
  const headerTone = isCancelled ? "urgent" : (isClosed || resultTone === "good") ? "neutral" : resultTone;
  const headerAccent = accentClass(headerTone);

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className={`flex items-start justify-between ${headerAccent ? `pl-3 ${headerAccent}` : ""}`}>
          <div>
            <div className="text-sm text-muted-foreground">
              <Link href="/inspections" className="hover:underline">Incoming Inspections</Link> / {inspection.inspectionNumber}
            </div>
            <h1 className="text-2xl font-bold tracking-tight mt-1">{inspection.inspectionNumber}</h1>
            <p className="text-muted-foreground">
              {inspection.supplierName ?? "—"} · {formatDateOnly(inspection.inspectionDate)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-1.5 print:hidden" data-testid="button-print-inspection">
              <Printer className="h-4 w-4" />
              Print
            </Button>
            {!isClosed && !isCancelled && canCancel && (
              <Button variant="outline" size="sm" onClick={() => setCancelOpen(true)} className="gap-1.5 text-destructive hover:text-destructive print:hidden" data-testid="button-cancel-inspection">
                <Ban className="h-4 w-4" />
                Cancel
              </Button>
            )}
            {isCancelled && canReopen && (
              <Button variant="outline" size="sm" onClick={() => setUncancelOpen(true)} disabled={uncancelPending} className="gap-1.5 print:hidden" data-testid="button-reopen-inspection">
                <RotateCcw className="h-4 w-4" />
                Re-open
              </Button>
            )}
            <StatusBadge tone={isCancelled ? "urgent" : toneInspectionResult(inspection.result)} label={isCancelled ? "Cancelled" : inspection.result} className="text-sm" />
          </div>
        </div>

        {/* Session 52.1 — Cancelled banner (Part 11 record of who/why). */}
        {isCancelled && (
          <div className="rounded-lg border-2 border-red-200 bg-red-50 px-4 py-3" data-testid="banner-inspection-cancelled">
            <p className="text-sm font-semibold text-red-900 flex items-center gap-2">
              <Ban className="h-4 w-4" /> This inspection has been cancelled
            </p>
            <p className="text-xs text-red-800 mt-1">
              {(inspection as { cancelledByName?: string | null }).cancelledByName}
              {(inspection as { cancelledByInitials?: string | null }).cancelledByInitials ? ` (${(inspection as { cancelledByInitials?: string | null }).cancelledByInitials})` : ""}
              {(inspection as { cancelledAt?: string | null }).cancelledAt ? ` · ${format(new Date((inspection as { cancelledAt?: string | null }).cancelledAt as string), "MMM d, yyyy h:mm a")}` : ""}
            </p>
            {(inspection as { cancelledReason?: string | null }).cancelledReason && (
              <p className="text-sm text-red-900 mt-1.5 whitespace-pre-wrap">
                <span className="font-medium">Reason:</span> {(inspection as { cancelledReason?: string | null }).cancelledReason}
              </p>
            )}
            <p className="text-[11px] text-red-700 mt-1 italic">Retained for compliance; can be re-opened by an Admin only.</p>
          </div>
        )}

        {/* State transitions — Operator advances inspection through its workflow */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              Inspection State
              {isClosed && <Lock className="h-4 w-4 text-muted-foreground" aria-hidden />}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {isClosed
                ? "This inspection is closed. Records are preserved per Part 11 — to revise, open a new inspection."
                : "Set the Inspection State once line items are recorded. Fail and Conditional require a written rationale; Pass with any failed item requires Supervisor+ sign-off. Marking Pass adds accepted items to Inventory."}
            </p>
            <div className="flex flex-wrap gap-2 print:hidden">
              <Button
                size="sm"
                variant={inspection.result === "Pass" ? "default" : "outline"}
                disabled={locked || transitioning}
                onClick={() => transitionTo("Pass")}
                data-testid="button-inspection-pass"
              >
                <CheckCircle2 className="h-4 w-4 mr-1" />Pass
              </Button>
              <Button
                size="sm"
                variant={inspection.result === "Fail" ? "destructive" : "outline"}
                disabled={locked || transitioning}
                onClick={() => transitionTo("Fail")}
                data-testid="button-inspection-fail"
              >
                <XCircle className="h-4 w-4 mr-1" />Fail
              </Button>
              <Button
                size="sm"
                variant={inspection.result === "Conditional" ? "secondary" : "outline"}
                disabled={locked || transitioning}
                onClick={() => transitionTo("Conditional")}
              >
                Conditional
              </Button>
              <div className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                disabled={locked || transitioning || inspection.result === "Pending"}
                onClick={() => transitionTo("Closed")}
                title="Lock the inspection record (no further changes)"
              >
                <Lock className="h-4 w-4 mr-1" />Close Inspection
              </Button>
            </div>
            {items.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Line items: {passCount} pass · {failCount} fail · {items.length - passCount - failCount} other
              </p>
            )}
            {(inspection.stateRationale || inspection.passApproverName) && (
              <div className="pt-2 border-t space-y-2 text-xs">
                {inspection.stateRationale && (
                  <div className="rounded-md bg-muted/40 px-3 py-2">
                    <p className="font-semibold uppercase tracking-wide text-muted-foreground">
                      Rationale ({inspection.result})
                    </p>
                    <p className="whitespace-pre-wrap mt-0.5">{inspection.stateRationale}</p>
                    <p className="text-muted-foreground mt-0.5">
                      — {inspection.stateRationaleByName ?? "Unknown"}
                      {inspection.stateRationaleAt ? `, ${format(new Date(inspection.stateRationaleAt), "MMM d, yyyy h:mm a")}` : ""}
                    </p>
                  </div>
                )}
                {inspection.passApproverName && (
                  <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2">
                    <p className="font-semibold uppercase tracking-wide text-amber-800">
                      Pass approved with failed items (Part 11 sign-off)
                    </p>
                    <p className="mt-0.5">{inspection.passApproverMeaning}</p>
                    <p className="text-amber-700 mt-0.5">
                      — {inspection.passApproverName} ({inspection.passApproverInitials})
                      {inspection.passApprovedAt ? `, ${format(new Date(inspection.passApprovedAt), "MMM d, yyyy h:mm a")}` : ""}
                    </p>
                  </div>
                )}
              </div>
            )}
            {inspection.result === "Pass" && (
              <div className="pt-2 border-t flex items-center justify-between gap-3 print:hidden">
                <p className="text-xs text-muted-foreground">
                  Items not appearing in Inventory? Re-sync to push any accepted line items that were added or edited after Pass.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={resyncInventory}
                  disabled={resyncing || locked}
                  data-testid="button-resync-inventory"
                >
                  {resyncing ? "Re-syncing…" : "Re-sync to Inventory"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Inspection Details</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div><dt className="text-muted-foreground">Supplier</dt><dd>{inspection.supplierName ?? "—"}</dd></div>
              <div><dt className="text-muted-foreground">PO / Manifest</dt><dd>{inspection.poManifestNumber ?? "—"}</dd></div>
              <div><dt className="text-muted-foreground">Inspector</dt><dd>{inspection.inspectedByName ?? "—"}</dd></div>
              <div><dt className="text-muted-foreground">Date</dt><dd>{formatDateOnly(inspection.inspectionDate)}</dd></div>
              {inspection.inspectionNotes && (
                <div className="col-span-full"><dt className="text-muted-foreground">Notes</dt><dd className="whitespace-pre-wrap">{inspection.inspectionNotes}</dd></div>
              )}
            </dl>
          </CardContent>
        </Card>

        {/* NC-1 — Non-conformances raised from this inspection (reverse link). */}
        {relatedNCs.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Non-Conformances Raised From This Inspection ({relatedNCs.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y">
                {relatedNCs.map((nc) => (
                  <li key={nc.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <Link href={`/non-conformances/${nc.id}`} className="font-mono text-sm font-semibold text-primary hover:underline">
                        {nc.ncNumber}
                      </Link>
                      <span className="ml-2 text-sm">{nc.title}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="outline">{nc.severity}</Badge>
                      <Badge variant="outline">{nc.status}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Line Items ({items.length})</CardTitle>
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button onClick={openCreate} size="sm" disabled={locked} className="print:hidden">
                  <Plus className="h-4 w-4 mr-1" />Add Item
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader><DialogTitle>{editing ? "Edit Item" : "Add Inspection Item"}</DialogTitle></DialogHeader>
                <div className="space-y-3 py-2">
                  <div>
                    <Label>Item Name *</Label>
                    <Input list="inspection-item-names" value={draft.itemName ?? ""} onChange={(e) => applyItemName(e.target.value)} placeholder="e.g. Cartridge Hardware – CCELL TH2" />
                    <datalist id="inspection-item-names">
                      {itemNameOptions.map((n) => <option key={n} value={n} />)}
                    </datalist>
                    <p className="text-xs text-muted-foreground mt-1">Start typing to reuse an existing item name — a known name fills Material Type from how the item is set up.</p>
                  </div>
                  <div>
                    <Label>Material Type</Label>
                    {/* Session 111 — a "Cannabis – …" type defaults the UoM to
                        grams (cannabis is weighed onto a scale). It fills a unit
                        the operator hasn't chosen, or one this form derived from
                        a previous type, so a deliberate mL always stands. */}
                    <Select
                      value={draft.materialType ?? ""}
                      onValueChange={(v) => {
                        setTypeWasAutoFilled(false);
                        const def = defaultUnitForItemType(v);
                        const mayReplaceUom = !(draft.quantityUom ?? "").trim() || uomWasAutoFilled;
                        setUomWasAutoFilled(mayReplaceUom && !!def);
                        setDraft((d) => {
                          const next: Partial<Item> = { ...d, materialType: v };
                          if (mayReplaceUom) {
                            if (def) next.quantityUom = def;
                            else if (uomWasAutoFilled) next.quantityUom = "";
                          }
                          return next;
                        });
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="Select material type" /></SelectTrigger>
                      <SelectContent>
                        {ITEM_TYPES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {typeWasAutoFilled && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Filled from how “{draft.itemName}” is set up in inventory — change it if this delivery differs.
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      A “Cannabis – …” type tracks this on the Lots page with a METRC tag; others are inventory only.
                    </p>
                  </div>
                  {(draft.materialType ?? "").toLowerCase().startsWith("cannabis") && (
                    <div>
                      <Label>METRC Package Tag *</Label>
                      <Input value={draft.metrcTag ?? ""} onChange={(e) => setDraft({ ...draft, metrcTag: e.target.value })} placeholder="METRC package tag from the manifest (e.g. 1A4...)" />
                      <p className="text-xs text-muted-foreground mt-1">Required for cannabis. Identifies the package in CannaQMS and carries onto its lot when received.</p>
                    </div>
                  )}
                  {(draft.materialType ?? "").toLowerCase().startsWith("cannabis") && (
                    <div>
                      <Label>Strain Type</Label>
                      <Select value={draft.strainType ?? ""} onValueChange={(v) => setDraft({ ...draft, strainType: v })}>
                        <SelectTrigger><SelectValue placeholder="Sativa / Indica / Hybrid (optional)" /></SelectTrigger>
                        <SelectContent>
                          {["Sativa", "Indica", "Hybrid"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {/* Potency (2026-09-06). Michigan requires transferred cannabis to be
                      tested, so the delivery arrives with a COA. Capture it HERE, at
                      receiving, and it carries onto the lot — so an operator picking that
                      lot for a batch can see what it actually assays at. Either type the
                      values off the COA or pull them from Metrc, which already holds the
                      lab's released results for this package. */}
                  {(draft.materialType ?? "").toLowerCase().startsWith("cannabis") && (
                    <div className="rounded-md border bg-muted/30 p-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Potency (from COA)</Label>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={pullingPotency}
                          onClick={pullPotencyFromMetrc}
                        >
                          {pullingPotency ? "Pulling…" : "Pull from METRC"}
                        </Button>
                      </div>
                      <div className="grid grid-cols-3 gap-3 mt-2">
                        <div>
                          <Label className="text-xs">THC %</Label>
                          <Input
                            type="number"
                            step="0.01"
                            className="mt-1 h-9"
                            placeholder="e.g. 82.4"
                            value={draft.thcPct ?? ""}
                            onChange={(e) => setDraft({
                              ...draft,
                              thcPct: e.target.value === "" ? null : Number(e.target.value),
                              potencySource: "manual",
                            })}
                          />
                        </div>
                        <div>
                          <Label className="text-xs">CBD %</Label>
                          <Input
                            type="number"
                            step="0.01"
                            className="mt-1 h-9"
                            placeholder="e.g. 0.5"
                            value={draft.cbdPct ?? ""}
                            onChange={(e) => setDraft({
                              ...draft,
                              cbdPct: e.target.value === "" ? null : Number(e.target.value),
                              potencySource: "manual",
                            })}
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Tested on</Label>
                          <Input
                            type="date"
                            className="mt-1 h-9"
                            value={draft.potencyTestedAt ?? ""}
                            onChange={(e) => setDraft({ ...draft, potencyTestedAt: e.target.value })}
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">
                        {draft.potencySource === "metrc"
                          ? "Pulled from METRC lab results."
                          : "Leave blank if the COA is not in hand yet — blank means not recorded, not 0%."}
                      </p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Supplier Item Code</Label>
                      <Input value={draft.supplierItemCode ?? ""} onChange={(e) => setDraft({ ...draft, supplierItemCode: e.target.value })} />
                    </div>
                    <div>
                      <Label>Lot # (vendor or internal)</Label>
                      <Input value={draft.lotNumber ?? ""} onChange={(e) => setDraft({ ...draft, lotNumber: e.target.value })} placeholder="Optional — leave blank, or set an internal # for FIFO" />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label>Quantity</Label>
                      <Input type="number" value={draft.quantityReceived ?? ""} onChange={(e) => setDraft({ ...draft, quantityReceived: e.target.value === "" ? undefined : Number(e.target.value) })} />
                    </div>
                    <div>
                      <Label>UoM</Label>
                      {/* Session 58.2 — standardized unit dropdown (was free text, which
                          produced "each"/"eaches"/"units" drift on receiving). Renders the
                          shared UNIT_OPTIONS list so inspection→inventory units match; it
                          used to mirror the inventory dialog's set by hand, which is how
                          ITEM_TYPES drifted before it was unified.
                          A legacy free-text value is preserved as an option so editing an
                          older item never silently blanks its UoM. */}
                      <Select value={draft.quantityUom ?? ""} onValueChange={(v) => { setUomWasAutoFilled(false); setDraft({ ...draft, quantityUom: v }); }}>
                        <SelectTrigger><SelectValue placeholder="Select unit" /></SelectTrigger>
                        <SelectContent>
                          {(() => {
                            const opts: string[] = [...UNIT_OPTIONS];
                            const cur = (draft.quantityUom ?? "").trim();
                            const all = cur && !opts.includes(cur) ? [cur, ...opts] : opts;
                            return all.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>);
                          })()}
                        </SelectContent>
                      </Select>
                      {/* Clones are counted. defaultUnitForItemType already fills
                          "each" when the type is picked, so this only fires when
                          someone deliberately chooses a weight or volume. */}
                      {isCloneItemType(draft.materialType) &&
                        !!(draft.quantityUom ?? "").trim() &&
                        dimensionOf(draft.quantityUom) !== "count" && (
                          <p className="text-xs text-amber-600 mt-1">
                            Clones are counted, not weighed — set the unit to “each”.
                          </p>
                        )}
                    </div>
                    <div>
                      <Label>Expiry Date</Label>
                      <Input type="date" value={draft.expiryDate ?? ""} onChange={(e) => setDraft({ ...draft, expiryDate: e.target.value })} />
                    </div>
                  </div>
                  <div>
                    <Label>Result</Label>
                    <Select value={draft.result ?? "Pass"} onValueChange={(v) => setDraft({ ...draft, result: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {RESULT_OPTIONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {draft.result === "Fail" && (
                    <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                      <div>
                        <Label>Disposition *</Label>
                        <Select value={draft.disposition ?? ""} onValueChange={(v) => setDraft({ ...draft, disposition: v })}>
                          <SelectTrigger><SelectValue placeholder="What happens to the failed material?" /></SelectTrigger>
                          <SelectContent>
                            {DISPOSITION_OPTIONS.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground mt-1">RTV / Scrap / Rework don't enter inventory. Use As Is accepts the material into inventory under concession.</p>
                      </div>
                      {draft.disposition === "Use As Is" && (
                        <div>
                          <Label>Use-As-Is justification *</Label>
                          <Textarea value={draft.dispositionNotes ?? ""} onChange={(e) => setDraft({ ...draft, dispositionNotes: e.target.value })} rows={2} placeholder="Why is the nonconforming material acceptable to use? (Supervisor / Quality Part 11 sign-off still required at Pass.)" />
                        </div>
                      )}
                    </div>
                  )}
                  <div>
                    <Label>Notes</Label>
                    <Textarea value={draft.notes ?? ""} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={2} />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                  <Button onClick={saveItem}>{editing ? "Save" : "Add Item"}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent>
            {items.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center">
                No line items yet. Add each material received on this inspection.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Supplier Code</TableHead>
                    <TableHead>Lot #</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Disposition</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead className="w-20 print:hidden" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className="font-medium align-top">{it.itemName}</TableCell>
                      <TableCell className="text-muted-foreground align-top">{it.supplierItemCode ?? "—"}</TableCell>
                      <TableCell className="align-top">{it.lotNumber ?? "—"}{it.metrcTag ? <div className="text-[11px] text-muted-foreground font-mono">METRC: {it.metrcTag}</div> : null}</TableCell>
                      <TableCell className="align-top">{it.quantityReceived != null ? `${it.quantityReceived} ${it.quantityUom ?? ""}`.trim() : "—"}</TableCell>
                      <TableCell className="align-top">
                        {it.expiryDate ? (
                          <span className={expired(it.expiryDate) ? "text-destructive" : expiringSoon(it.expiryDate) ? "text-amber-600 dark:text-amber-400" : ""}>
                            {formatDateOnly(it.expiryDate)}
                            {expired(it.expiryDate) && " (expired)"}
                            {!expired(it.expiryDate) && expiringSoon(it.expiryDate) && " (soon)"}
                          </span>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge variant={it.result === "Pass" ? "default" : it.result === "Fail" ? "destructive" : "secondary"}>{it.result}</Badge>
                      </TableCell>
                      <TableCell className="align-top text-sm">
                        {it.result === "Fail" && it.disposition ? (
                          <div>
                            <span className="font-medium">{it.disposition}</span>
                            {it.disposition === "Use As Is" && it.dispositionNotes ? <p className="text-xs text-muted-foreground whitespace-pre-wrap">{it.dispositionNotes}</p> : null}
                            {it.disposition === "Scrap" && (it.materialType ?? "").toLowerCase().startsWith("cannabis") ? (
                              <Button variant="outline" size="sm" className="mt-1 h-7 text-xs" onClick={() => setDestructionItem(it)}>
                                <Trash2 className="h-3 w-3 mr-1" /> Create Destruction Record
                              </Button>
                            ) : null}
                          </div>
                        ) : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      {/* Notes now always visible (no edit-click needed), and stay legible once the inspection is closed. Failed-item notes are emphasized since they explain the failure. */}
                      <TableCell className="align-top max-w-[16rem] whitespace-pre-wrap text-sm">
                        {it.notes && it.notes.trim()
                          ? <span className={it.result === "Fail" ? "text-destructive font-medium" : ""}>{it.notes}</span>
                          : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="print:hidden">
                        <div className="flex gap-1">
                          <Button size="icon" variant="ghost" onClick={() => openEdit(it)} disabled={locked}><Pencil className="h-4 w-4" /></Button>
                          {canDeleteItem && (
                            <Button size="icon" variant="ghost" onClick={() => deleteItem(it.id)} disabled={locked}><Trash2 className="h-4 w-4" /></Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* CoA / CoC / Packing List / BOM — polymorphic attachments */}
        <div className="print:hidden">
          <AttachmentsPanel
            parentTable="incoming_inspections"
            parentId={inspection.id}
            showPrimarySlot={false}
            allowSupplementary={!locked}
            currentUserId={currentUser?.id}
            currentUserRole={currentUser?.role}
            title="Attachments (CoA, CoC, Packing List, BOM)"
          />
        </div>
      </div>

        {/* Rationale dialog for Fail / Conditional transitions */}
        <Dialog open={pendingState !== null} onOpenChange={(o) => { if (!o) setPendingState(null); }}>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle>Rationale required — {pendingState ?? ""}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {pendingState === "Fail"
                ? "Document why the entire shipment is being rejected (internal/regulatory non-compliance, quality concern, etc.)."
                : "Document why some items are accepted but held in quarantine (missing CoA, missing regulatory document, internal hold, etc.)."}
            </p>
            <Textarea
              autoFocus
              value={rationaleText}
              onChange={(e) => setRationaleText(e.target.value)}
              rows={4}
              placeholder="Required — at least one sentence."
            />
            <DialogFooter>
              <Button variant="ghost" onClick={() => setPendingState(null)} disabled={transitioning}>Cancel</Button>
              <Button onClick={() => void confirmRationale()} disabled={transitioning || !rationaleText.trim()}>
                {transitioning ? "Saving…" : `Mark ${pendingState ?? ""}`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Supervisor approval — required for Pass when any line item is Fail */}
        <Part11SignatureDialog
          open={supervisorOpen}
          onOpenChange={setSupervisorOpen}
          title="Supervisor approval — Pass with failed items"
          description={`One or more line items in this inspection failed. Mark Pass only if you (Supervisor / Manager / Quality / Admin) have reviewed the failed items and accept the disposition. Your initials and a signing statement are required per 21 CFR Part 11.`}
          onSign={confirmSupervisorPass}
          isPending={transitioning}
        />

        {/* Session 52.1 — Cancel (rationale + Part 11 e-signature). */}
        <CancelRecordDialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          entityLabel="Inspection"
          isPending={cancelPending}
          onConfirm={handleCancel}
        />

        {/* Session 52.1 — Re-open (Admin-only; Part 11 e-signature). */}
        <Part11SignatureDialog
          open={uncancelOpen}
          onOpenChange={setUncancelOpen}
          title="Re-open Inspection"
          description="Re-open this cancelled inspection and return it to active use. Restricted to Admin; requires an Admin signature."
          isPending={uncancelPending}
          onSign={handleUncancel}
        />

        {/* Scrap -> METRC Destruction Record. Incoming items carry no METRC tag,
            so the operator enters the package tag; item/qty/reason seed the notice. */}
        <CreateDestructionRecordDialog
          open={destructionItem !== null}
          onOpenChange={(o) => { if (!o) setDestructionItem(null); }}
          initialSourceLot={destructionItem?.lotNumber ?? undefined}
          initialTags={destructionItem?.metrcTag ? [destructionItem.metrcTag] : undefined}
          noticeText={destructionItem ? `Scrapping failed inspection item "${destructionItem.itemName}"${destructionItem.quantityReceived != null ? ` \u2014 ${destructionItem.quantityReceived} ${destructionItem.quantityUom ?? ""}`.trimEnd() : ""}. Michigan CRA requires every destroyed cannabis package to be logged with its full METRC tag \u2014 enter the package tag(s) below.${destructionItem.dispositionNotes ? ` Notes: ${destructionItem.dispositionNotes}` : ""}` : undefined}
          onCreated={() => { setDestructionItem(null); toast({ title: "Destruction record created", description: "Logged for the scrapped item." }); }}
        />
    </AppLayout>
  );
}
