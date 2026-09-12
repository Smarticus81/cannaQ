import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, Phone, Mail, User, Store, Sparkles, Info } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

// #4 (2026-08-05) — a store the affected lots shipped to, derived server-side
// from CannaQMS manifests + shipment records. The operator one-click adds these
// into Response Actions (still fully editable afterwards).
type StoreSuggestion = {
  storeName: string;
  storeLicenseNumber: string | null;
  unitsAffected: number | null;
  hasUnverifiedQty: boolean;
  sources: string[];
  lotNumbers: string[];
  alreadyAdded: boolean;
};

// Mirrors lib/db/src/schema/fa_response_actions.ts. Kept as a structural
// type rather than imported to avoid pulling drizzle types into the client.
type ResponseAction = {
  id: number;
  fieldActionId: number;
  storeName: string;
  storeLicenseNumber: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  notificationDate: string | null;
  method: string | null;
  confirmationReference: string | null;
  unitsAffected: number | null;
  unitsReturned: number | null;
  productReturned: boolean;
  productDestroyed: boolean;
  responseFormReceived: boolean;
  responseFormReceivedDate: string | null;
  allItemsAccounted: boolean;
  notes: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
};

const METHODS = ["Phone", "Email", "In-Person", "Certified Mail", "Other"] as const;

type DraftForm = {
  storeName: string;
  storeLicenseNumber: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  notificationDate: string;
  method: string;
  confirmationReference: string;
  unitsAffected: string;
  unitsReturned: string;
  productReturned: boolean;
  productDestroyed: boolean;
  responseFormReceived: boolean;
  responseFormReceivedDate: string;
  allItemsAccounted: boolean;
  notes: string;
};

const EMPTY_DRAFT: DraftForm = {
  storeName: "",
  storeLicenseNumber: "",
  contactName: "",
  contactPhone: "",
  contactEmail: "",
  notificationDate: "",
  method: "",
  confirmationReference: "",
  unitsAffected: "",
  unitsReturned: "",
  productReturned: false,
  productDestroyed: false,
  responseFormReceived: false,
  responseFormReceivedDate: "",
  allItemsAccounted: false,
  notes: "",
};

function rowToDraft(r: ResponseAction): DraftForm {
  return {
    storeName: r.storeName ?? "",
    storeLicenseNumber: r.storeLicenseNumber ?? "",
    contactName: r.contactName ?? "",
    contactPhone: r.contactPhone ?? "",
    contactEmail: r.contactEmail ?? "",
    notificationDate: r.notificationDate ?? "",
    method: r.method ?? "",
    confirmationReference: r.confirmationReference ?? "",
    unitsAffected: r.unitsAffected != null ? String(r.unitsAffected) : "",
    unitsReturned: r.unitsReturned != null ? String(r.unitsReturned) : "",
    productReturned: !!r.productReturned,
    productDestroyed: !!r.productDestroyed,
    responseFormReceived: !!r.responseFormReceived,
    responseFormReceivedDate: r.responseFormReceivedDate ?? "",
    allItemsAccounted: !!r.allItemsAccounted,
    notes: r.notes ?? "",
  };
}

function draftToPayload(d: DraftForm, currentUserName?: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {
    storeName: d.storeName.trim(),
    storeLicenseNumber: d.storeLicenseNumber.trim() || null,
    contactName: d.contactName.trim() || null,
    contactPhone: d.contactPhone.trim() || null,
    contactEmail: d.contactEmail.trim() || null,
    notificationDate: d.notificationDate || null,
    method: d.method || null,
    confirmationReference: d.confirmationReference.trim() || null,
    unitsAffected: d.unitsAffected === "" ? null : parseInt(d.unitsAffected, 10),
    unitsReturned: d.unitsReturned === "" ? null : parseInt(d.unitsReturned, 10),
    productReturned: d.productReturned,
    productDestroyed: d.productDestroyed,
    responseFormReceived: d.responseFormReceived,
    responseFormReceivedDate: d.responseFormReceivedDate || null,
    allItemsAccounted: d.allItemsAccounted,
    notes: d.notes.trim() || null,
  };
  if (currentUserName) out.createdByName = currentUserName;
  return out;
}

export function ResponseActionsPanel({
  fieldActionId,
  faClosed,
  currentUserName,
  legacyResponseActions,
  onCountChange,
  onFieldActionChanged,
  onOpenCountChange,
}: {
  fieldActionId: number;
  faClosed?: boolean;
  currentUserName?: string | null;
  legacyResponseActions?: string | null;
  /** Reports the current row count up to the parent so it can gate the
   *  closure button on at-least-one structured response action. */
  onCountChange?: (count: number) => void;
  /** Session 63.4 — a response-action write can move the FIELD ACTION itself:
   *  the server flips Response Active → Due Diligence once every row carries a
   *  notification date. This panel only ever reloaded its own list, so that
   *  advance was invisible until some unrelated edit refetched the record. */
  onFieldActionChanged?: () => void;
  /** Session 63.5 — how many stores still have product unaccounted for, so the
   *  closure card can explain itself without re-fetching this list. */
  onOpenCountChange?: (count: number) => void;
}) {
  const { toast } = useToast();
  const [rows, setRows] = useState<ResponseAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  // ── #4 store suggestions (from manifests / shipments) ──
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<StoreSuggestion[]>([]);
  const [suggestNote, setSuggestNote] = useState<string>("");
  const [affectedLotCount, setAffectedLotCount] = useState<number>(0);
  const [affectedBatchCount, setAffectedBatchCount] = useState<number>(0);
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const attachedCount = affectedLotCount + affectedBatchCount;

  const suggestionKey = (s: StoreSuggestion) =>
    s.storeLicenseNumber ? `L:${s.storeLicenseNumber.toUpperCase()}` : `N:${s.storeName.toLowerCase()}`;

  async function openSuggestions() {
    setSuggestOpen(true);
    setSuggestLoading(true);
    try {
      const r = await fetch(`/api/field-actions/${fieldActionId}/suggested-stores`, { credentials: "include" });
      if (!r.ok) throw new Error("fetch failed");
      const data = (await r.json()) as {
        suggestions: StoreSuggestion[];
        affectedLotCount: number;
        affectedBatchCount?: number;
        note: string;
      };
      setSuggestions(data.suggestions ?? []);
      setAffectedLotCount(data.affectedLotCount ?? 0);
      setAffectedBatchCount(data.affectedBatchCount ?? 0);
      setSuggestNote(data.note ?? "");
    } catch {
      toast({ title: "Couldn't load store suggestions", variant: "destructive" });
      setSuggestions([]);
    } finally {
      setSuggestLoading(false);
    }
  }

  async function addSuggestion(s: StoreSuggestion) {
    setAddingKey(suggestionKey(s));
    try {
      const noteParts = [];
      if (s.sources.length) noteParts.push(`Suggested from: ${s.sources.join("; ")}.`);
      if (s.hasUnverifiedQty) noteParts.push("Quantity not fully matched in CannaQMS — verify against METRC.");
      const payload: Record<string, unknown> = {
        storeName: s.storeName,
        storeLicenseNumber: s.storeLicenseNumber,
        unitsAffected: s.unitsAffected,
        notes: noteParts.join(" ") || null,
      };
      if (currentUserName) payload.createdByName = currentUserName;
      const res = await fetch(`/api/field-actions/${fieldActionId}/response-actions`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("add failed");
      // Mark this suggestion added in-place so the row disables without a refetch.
      setSuggestions((prev) =>
        prev.map((x) => (suggestionKey(x) === suggestionKey(s) ? { ...x, alreadyAdded: true } : x)),
      );
      toast({ title: `Added ${s.storeName}` });
      await reload();
      onFieldActionChanged?.();
    } catch {
      toast({ title: `Failed to add ${s.storeName}`, variant: "destructive" });
    } finally {
      setAddingKey(null);
    }
  }

  async function addAllSuggestions() {
    const pending = suggestions.filter((s) => !s.alreadyAdded);
    for (const s of pending) {
      // Sequential so the created-by attribution and audit order stay clean.
      await addSuggestion(s);
    }
  }

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch(`/api/field-actions/${fieldActionId}/response-actions`, { credentials: "include" });
      if (r.ok) {
        const list = (await r.json()) as ResponseAction[];
        setRows(list);
        onCountChange?.(list.length);
        onOpenCountChange?.(list.filter((r: ResponseAction) => !r.allItemsAccounted).length);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void reload(); }, [fieldActionId]);

  function openCreate() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setOpen(true);
  }

  function openEdit(r: ResponseAction) {
    setEditingId(r.id);
    setDraft(rowToDraft(r));
    setOpen(true);
  }

  async function handleSave() {
    if (!draft.storeName.trim()) {
      toast({ title: "Store name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = draftToPayload(draft, currentUserName);
      const url = editingId
        ? `/api/field-actions/${fieldActionId}/response-actions/${editingId}`
        : `/api/field-actions/${fieldActionId}/response-actions`;
      const method = editingId ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("save failed");
      toast({ title: editingId ? "Response action updated" : "Response action added" });
      setOpen(false);
      await reload();
      onFieldActionChanged?.();
    } catch {
      toast({ title: "Failed to save response action", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this response action? The audit log will retain the deletion record.")) return;
    try {
      const res = await fetch(`/api/field-actions/${fieldActionId}/response-actions/${id}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ performedByName: currentUserName ?? null }),
      });
      if (!res.ok) throw new Error("delete failed");
      toast({ title: "Response action deleted" });
      await reload();
      onFieldActionChanged?.();
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    }
  }

  const totalStores = rows.length;
  const totalAffected = rows.reduce((s, r) => s + (r.unitsAffected ?? 0), 0);
  const totalReturned = rows.reduce((s, r) => s + (r.unitsReturned ?? 0), 0);
  const returnedCount = rows.filter((r) => r.productReturned).length;
  const destroyedCount = rows.filter((r) => r.productDestroyed).length;
  const openCount = rows.filter((r) => !r.allItemsAccounted).length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-base">Response Actions</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Per-store notifications, returns, and destruction tracking. Required before closure.
          </p>
        </div>
        {!faClosed && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={openSuggestions}>
              <Sparkles className="h-4 w-4 mr-1" /> Suggest stores from manifests
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1" /> Add Store
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-2 space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            {faClosed
              ? "No store-level response actions were recorded."
              : "No response actions yet. Add an entry for each dispensary or retailer notified."}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-center text-xs">
              <div className="rounded bg-muted/50 px-2 py-1.5">
                <p className="text-muted-foreground">Stores</p>
                <p className="font-semibold text-sm">{totalStores}</p>
              </div>
              <div className={`rounded px-2 py-1.5 ${openCount > 0 ? "bg-destructive/10" : "bg-muted/50"}`}>
                <p className="text-muted-foreground">Unaccounted</p>
                <p className={`font-semibold text-sm ${openCount > 0 ? "text-destructive" : ""}`}>{openCount}</p>
              </div>
              <div className="rounded bg-muted/50 px-2 py-1.5">
                <p className="text-muted-foreground">Units affected</p>
                <p className="font-semibold text-sm">{totalAffected || "—"}</p>
              </div>
              <div className="rounded bg-muted/50 px-2 py-1.5">
                <p className="text-muted-foreground">Units Returned / Responses Received</p>
                <p className="font-semibold text-sm">{totalReturned || "—"}</p>
              </div>
              <div className="rounded bg-muted/50 px-2 py-1.5">
                <p className="text-muted-foreground">Returned</p>
                <p className="font-semibold text-sm">{returnedCount}</p>
              </div>
              <div className="rounded bg-muted/50 px-2 py-1.5">
                <p className="text-muted-foreground">Destroyed</p>
                <p className="font-semibold text-sm">{destroyedCount}</p>
              </div>
            </div>

            <div className="divide-y rounded-md border">
              {rows.map((r) => (
                <div key={r.id} className="p-3 space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Store className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="font-medium text-sm">{r.storeName}</span>
                        {r.storeLicenseNumber && (
                          <Badge variant="outline" className="font-mono text-[10px]">{r.storeLicenseNumber}</Badge>
                        )}
                        {r.responseFormReceived && <Badge variant="outline" className="text-[10px]">Form received</Badge>}
                        {r.productReturned && <Badge variant="secondary" className="text-[10px]">Returned</Badge>}
                        {r.productDestroyed && <Badge variant="destructive" className="text-[10px]">Destroyed</Badge>}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground mt-1">
                        {r.contactName && (
                          <span className="inline-flex items-center gap-1">
                            <User className="h-3 w-3" />{r.contactName}
                          </span>
                        )}
                        {r.contactPhone && (
                          <span className="inline-flex items-center gap-1">
                            <Phone className="h-3 w-3" />{r.contactPhone}
                          </span>
                        )}
                        {r.contactEmail && (
                          <span className="inline-flex items-center gap-1">
                            <Mail className="h-3 w-3" />{r.contactEmail}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground mt-0.5">
                        {r.notificationDate && (
                          <span>Notified {format(new Date(r.notificationDate + "T00:00:00"), "MMM d, yyyy")}{r.method ? ` via ${r.method}` : ""}</span>
                        )}
                        {r.confirmationReference && (
                          <span>Ref: <span className="font-mono">{r.confirmationReference}</span></span>
                        )}
                        {!r.allItemsAccounted && (
                          <span className="text-destructive font-medium">Items unaccounted for</span>
                        )}
                        {(r.unitsAffected != null || r.unitsReturned != null) && (
                          <span>
                            Units: {r.unitsReturned ?? 0} returned or received / {r.unitsAffected ?? "?"} affected
                          </span>
                        )}
                      </div>
                      {r.notes && (
                        <p className="text-xs whitespace-pre-wrap bg-muted/30 rounded px-2 py-1 mt-1.5">{r.notes}</p>
                      )}
                    </div>
                    {!faClosed && (
                      <div className="flex gap-1 shrink-0">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleDelete(r.id)}>
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {legacyResponseActions && legacyResponseActions.trim() && (
          <details className="rounded border bg-muted/20 px-3 py-2 text-sm">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Legacy notes (free-text Response Actions, pre-Session 13)
            </summary>
            <p className="mt-2 whitespace-pre-wrap text-sm">{legacyResponseActions}</p>
          </details>
        )}
      </CardContent>

      {/* ── Add / Edit dialog ─────────────────────────────────────────────── */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit response action" : "Add response action"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Store / Dispensary *</Label>
              <Input value={draft.storeName} onChange={(e) => setDraft({ ...draft, storeName: e.target.value })} placeholder="e.g. Green Leaf Provisioning Center" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">METRC / Licensee #</Label>
              <Input value={draft.storeLicenseNumber} onChange={(e) => setDraft({ ...draft, storeLicenseNumber: e.target.value })} placeholder="e.g. AU-R-000123" className="font-mono text-sm" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Contact name</Label>
                <Input value={draft.contactName} onChange={(e) => setDraft({ ...draft, contactName: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Phone</Label>
                <Input value={draft.contactPhone} onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Email</Label>
              <Input type="email" value={draft.contactEmail} onChange={(e) => setDraft({ ...draft, contactEmail: e.target.value })} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Notification date</Label>
                <Input type="date" value={draft.notificationDate} onChange={(e) => setDraft({ ...draft, notificationDate: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Method</Label>
                <Select value={draft.method} onValueChange={(v) => setDraft({ ...draft, method: v })}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    {METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Confirmation ref</Label>
                <Input value={draft.confirmationReference} onChange={(e) => setDraft({ ...draft, confirmationReference: e.target.value })} placeholder="e.g. CRA-2026-0042" className="font-mono text-sm" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Units affected</Label>
                <Input type="number" min={0} value={draft.unitsAffected} onChange={(e) => setDraft({ ...draft, unitsAffected: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Units Returned / Responses Received</Label>
                <Input type="number" min={0} value={draft.unitsReturned} onChange={(e) => setDraft({ ...draft, unitsReturned: e.target.value })} />
              </div>
            </div>
            <div className="space-y-2 rounded-md border bg-muted/30 px-3 py-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.responseFormReceived} onChange={(e) => setDraft({ ...draft, responseFormReceived: e.target.checked })} />
                Response form received (signed &amp; returned)
              </label>
              {draft.responseFormReceived && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Form received date</Label>
                  <Input type="date" value={draft.responseFormReceivedDate} onChange={(e) => setDraft({ ...draft, responseFormReceivedDate: e.target.value })} />
                </div>
              )}
              {/* Kept apart from the form checkbox above on purpose: a store can
                  answer for 20 of the 40 units it holds. The form came back; the
                  other 20 are still out there. */}
              <label className="flex items-start gap-2 text-sm border-t pt-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={draft.allItemsAccounted}
                  onChange={(e) => setDraft({ ...draft, allItemsAccounted: e.target.checked })}
                />
                <span>
                  All items accounted for from this customer
                  <span className="block text-xs text-muted-foreground">
                    Every unit this licensee held is returned, destroyed or otherwise reconciled.
                    The field action cannot be closed while this is unticked.
                  </span>
                </span>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.productReturned} onChange={(e) => setDraft({ ...draft, productReturned: e.target.checked })} />
                Product returned
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.productDestroyed} onChange={(e) => setDraft({ ...draft, productDestroyed: e.target.checked })} />
                Product destroyed
              </label>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Notes</Label>
              <Textarea rows={3} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Anything else worth recording on this store's response…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving || !draft.storeName.trim()}>
              {saving ? "Saving…" : editingId ? "Save changes" : "Add response action"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── #4 Suggest stores from manifests / shipments ─────────────────────── */}
      <Dialog open={suggestOpen} onOpenChange={setSuggestOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Stores these batches / lots shipped to
            </DialogTitle>
          </DialogHeader>

          {/* Verification caveat — always shown. */}
          {suggestNote && (
            <div className="flex items-start gap-2 rounded-md border bg-amber-50 border-amber-200 px-3 py-2 text-xs text-amber-900">
              <Info className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{suggestNote}</span>
            </div>
          )}

          <div className="space-y-2 py-1">
            {suggestLoading ? (
              <p className="text-sm text-muted-foreground py-6 text-center">Looking up manifests…</p>
            ) : attachedCount === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                Attach the affected batch(es) or lots first (in the Affected Batches / Affected Lots
                panels above), then I can suggest the stores they were shipped to.
              </p>
            ) : suggestions.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                No shipments or manifests for the affected lots were found in CannaQMS. If product
                left the facility, check the transfers directly in METRC and add the stores manually.
              </p>
            ) : (
              <div className="divide-y rounded-md border">
                {suggestions.map((s) => (
                  <div key={suggestionKey(s)} className="p-3 flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Store className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="font-medium text-sm">{s.storeName}</span>
                        {s.storeLicenseNumber && (
                          <Badge variant="outline" className="font-mono text-[10px]">{s.storeLicenseNumber}</Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {s.unitsAffected != null ? (
                          <span>{s.unitsAffected} unit{s.unitsAffected === 1 ? "" : "s"} affected</span>
                        ) : (
                          <span className="text-amber-700">Quantity not matched — verify in METRC</span>
                        )}
                        {s.lotNumbers.length > 0 && <span> · from: {s.lotNumbers.join(", ")}</span>}
                      </div>
                      {s.sources.length > 0 && (
                        <div className="text-[11px] text-muted-foreground mt-0.5">{s.sources.join(" · ")}</div>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant={s.alreadyAdded ? "ghost" : "outline"}
                      disabled={s.alreadyAdded || addingKey !== null}
                      onClick={() => addSuggestion(s)}
                      className="shrink-0"
                    >
                      {s.alreadyAdded
                        ? "Added"
                        : addingKey === suggestionKey(s)
                          ? "Adding…"
                          : "Add"}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSuggestOpen(false)}>Close</Button>
            {suggestions.some((s) => !s.alreadyAdded) && (
              <Button onClick={addAllSuggestions} disabled={addingKey !== null}>
                {addingKey !== null ? "Adding…" : "Add all"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
