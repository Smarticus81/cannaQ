import { useState, useEffect, useCallback, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  useGetPackagingDesign,
  useUpdatePackagingDesign,
  useListAuditLog,
  useGetCurrentUser,
  getGetPackagingDesignQueryKey,
} from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "wouter";
import { format } from "date-fns";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { AuditDiff } from "@/components/audit/AuditDiff";
import {
  CheckCircle2,
  AlertCircle,
  Clock,
  ShieldCheck,
  Printer,
  ExternalLink,
  XCircle,
  RotateCcw,
  ChevronRight,
} from "lucide-react";

// ── Michigan R 420.401 / R 420.402 label compliance checklist ─────────────────
// ⛔ The hardcoded CHECKLIST_SECTIONS that stood here until 2026-08-30 cited
// R 420.401(1), (5), (6) and (7). R 420.401 is *Definitions*. Same fault as the
// label checklist and the label warning text — a fabricated citation on a record
// somebody signs. It is gone; this tab now renders the requirements the STATE
// imposes, fetched per DESIGN from /api/packaging-designs/:id/requirements.
//
// A requirement is identified by its stable key, so the ticks recorded here stay
// meaningful when a list is rebuilt. ⚠️ Ticks made against the OLD ids (facility_name,
// thc_per_serving, ...) no longer match anything and will read as unchecked — they
// were ticks against questions citing the wrong rule, so re-ticking them against
// the real ones is the correct outcome, not data loss to be worked around.
type ChecklistItemId = string;

type LabelRequirement = {
  key: string;
  itemText: string;
  regulationRef: string;
  /**
   * "Packaging" — fixed artwork, verifiable once here.
   * "Labeling"  — changes with the batch, so it can never be discharged here.
   */
  control: string | null;
  required: boolean;
  /** Which of this design's states impose it. */
  states: string[];
  target: string;
  /** Why it was marked not applicable. Optional — never required. */
  note: string | null;
};

function loadChecklist(designId: number): Set<ChecklistItemId> {
  try {
    const raw = localStorage.getItem(`cannaqms-pkg-checklist-${designId}`);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as ChecklistItemId[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

// ── Status helpers ─────────────────────────────────────────────────────────────
function statusBadge(status: string) {
  const map: Record<string, string> = {
    Draft: "bg-slate-100 text-slate-700 border-slate-300",
    "Under Review": "bg-blue-50 text-blue-700 border-blue-200",
    "In Review": "bg-blue-50 text-blue-700 border-blue-200",
    "Partially Approved": "bg-indigo-50 text-indigo-700 border-indigo-200",
    Approved: "bg-green-50 text-green-700 border-green-200",
    Rejected: "bg-red-50 text-red-800 border-red-200",
    Superseded: "bg-amber-50 text-amber-700 border-amber-200",
  };
  return (
    <span
      className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border ${map[status] ?? "bg-gray-100 text-gray-600"}`}
    >
      {status}
    </span>
  );
}

export default function PackagingDetail(props: { params?: { id: string } }) {
  const id = parseInt(props.params?.id ?? "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: design, isLoading } = useGetPackagingDesign(id);
  const { data: currentUser } = useGetCurrentUser();
  const { data: auditLog = [] } = useListAuditLog({
    tableName: "packaging_designs",
    rowId: id,
    limit: 50,
  });

  const updateDesign = useUpdatePackagingDesign();

  const [signatureOpen, setSignatureOpen] = useState(false);
  const [signSlot, setSignSlot] = useState<"quality" | "manager" | null>(null);
  const [rejectConfirm, setRejectConfirm] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [editingField, setEditingField] = useState<
    "artworkUrl" | "notes" | "version" | null
  >(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // The requirements the DESIGN's states impose on ITS product type, and where
  // this operator meets each one.
  // ⛔ Per DESIGN, not per facility. Coverage belongs to the artefact that does
  // the carrying; /api/label-requirements and the facility-level table behind it
  // were removed 2026-08-31.
  const { data: reqData, refetch: refetchRequirements } = useQuery<{
    states: string[];
    availableStates: string[];
    targets: string[];
    stateStatus: { state: string; configured: boolean; itemCount: number }[];
    requirements: LabelRequirement[];
  }>({
    queryKey: ["packaging-design-requirements", id],
    enabled: !!id,
    queryFn: async () => {
      const r = await fetch(`/api/packaging-designs/${id}/requirements`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load the requirements for this design");
      return r.json();
    },
  });
  const requirements = reqData?.requirements ?? [];
  const targets = reqData?.targets ?? ["Packaging", "Labeling", "NotApplicable"];
  const designStates = reqData?.states ?? [];
  const availableStates = reqData?.availableStates ?? [];
  const stateStatus = reqData?.stateStatus ?? [];
  const missingRuleSets = stateStatus.filter((st) => !st.configured).map((st) => st.state);
  const packagingReqs = requirements.filter((r) => r.target === "Packaging");

  // The server owns the percentage now, so every writer below re-reads the design.
  const refreshAll = useCallback(async () => {
    await refetchRequirements();
    await queryClient.invalidateQueries({ queryKey: getGetPackagingDesignQueryKey(id) });
  }, [refetchRequirements, queryClient, id]);

  const setDesignStates = useCallback(async (states: string[]) => {
    const r = await fetch(`/api/packaging-designs/${id}/states`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ states }),
    });
    if (!r.ok) {
      const msg = await r.json().catch(() => ({}));
      toast({ title: "Could not change the states", description: msg?.error ?? "Please try again.", variant: "destructive" });
      return;
    }
    await refreshAll();
  }, [id, toast, refreshAll]);

  // ── WHICH PRODUCTS this design is for — 2026-09-02 ────────────────────────
  // His ruling 09-01: an edible pouch is specific to the edible and its flavour,
  // because it prints the ingredients; cartridges share one pouch across every
  // strain. Empty means every product of this type, which is what every design
  // written before today is.
  const designProducts = (((design ?? {}) as unknown) as { productLineageIds?: number[] | null })
    .productLineageIds ?? [];
  const { data: productData } = useQuery<{
    products: { lineageId: number; productName: string; subtype: string | null }[];
  }>({
    queryKey: ["packaging-design-products", design?.productType],
    enabled: !!design?.productType,
    queryFn: async () => {
      const r = await fetch(
        `/api/packaging-designs/products?productType=${encodeURIComponent(design!.productType)}`,
        { credentials: "include" },
      );
      if (!r.ok) throw new Error("Failed to load the products for this type");
      return r.json();
    },
  });
  const availableProducts = productData?.products ?? [];

  const setDesignProducts = useCallback(async (lineageIds: number[]) => {
    const r = await fetch(`/api/packaging-designs/${id}/products`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ productLineageIds: lineageIds }),
    });
    if (!r.ok) {
      const msg = await r.json().catch(() => ({}));
      toast({ title: "Could not change the products", description: msg?.error ?? "Please try again.", variant: "destructive" });
      return;
    }
    await refreshAll();
  }, [id, toast, refreshAll]);

  const setRequirementTarget = useCallback(async (key: string, target: string, note?: string) => {
    const r = await fetch(`/api/packaging-designs/${id}/requirements/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(note === undefined ? { target } : { target, note }),
    });
    if (!r.ok) {
      const msg = await r.json().catch(() => ({}));
      toast({ title: "Could not move that requirement", description: msg?.error ?? "Please try again.", variant: "destructive" });
      return;
    }
    await refreshAll();
  }, [id, toast, refreshAll]);
  const [proofFileCount, setProofFileCount] = useState(0);

  // Checklist state — server-backed (checklist_items column); localStorage is a
  // fallback for designs created before the column existed. Depend on a JSON key
  // (not the array ref) so the effect only reseeds when the contents change.
  const [checked, setChecked] = useState<Set<ChecklistItemId>>(new Set());
  const serverChecklistKey = JSON.stringify(
    ((design ?? {}) as { checklistItems?: string[] | null }).checklistItems ?? null
  );
  useEffect(() => {
    if (!id) return;
    const arr = JSON.parse(serverChecklistKey) as string[] | null;
    if (Array.isArray(arr)) setChecked(new Set(arr as ChecklistItemId[]));
    else setChecked(loadChecklist(id));
  }, [id, serverChecklistKey]);

  const invalidate = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: getGetPackagingDesignQueryKey(id),
      }),
    [queryClient, id]
  );

  // A tick is a record, so it is written to the design and the SERVER computes
  // the percentage from the requirements this packaging actually claims. The
  // browser no longer owns the denominator.
  const checkedRef = useRef<Set<ChecklistItemId>>(new Set());
  checkedRef.current = checked;
  const toggleItem = useCallback(
    async (itemId: ChecklistItemId) => {
      const verified = !checkedRef.current.has(itemId);
      const r = await fetch(`/api/packaging-designs/${id}/checklist/${encodeURIComponent(itemId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ verified }),
      });
      if (!r.ok) {
        const msg = await r.json().catch(() => ({}));
        toast({ title: "Could not record that", description: msg?.error ?? "Please try again.", variant: "destructive" });
        return;
      }
      await refreshAll();
    },
    [id, toast, refreshAll]
  );

  // Derived from what this design CLAIMS to carry. Nothing claimed reads as 100%
  // — the design has discharged nothing, so there is nothing here to verify and
  // every requirement is still asked before each print. The server computes the
  // same number and gates the signatures on it.
  const checklistPct = packagingReqs.length === 0
    ? 100
    : Math.round((checked.size / packagingReqs.length) * 100);

  // ⛔ A signature covers what this design claims, so it must not be obtainable
  // while the claim is unverified — or unanswerable because no state is named or
  // its rules are not loaded. The server refuses on the same three grounds.
  const canSign =
    designStates.length > 0 && missingRuleSets.length === 0 && checklistPct === 100;

  const isApproved = design?.status === "Approved";
  const isRejected = design?.status === "Rejected";
  const isSuperseded = design?.status === "Superseded";
  const isPartiallyApproved = design?.status === "Partially Approved";
  const inSigningPhase =
    design?.status === "Under Review" ||
    design?.status === "In Review" ||
    isPartiallyApproved;
  const isLocked = isApproved || isSuperseded;

  // Two-signer approval fields added to packaging_designs 2026-07-22. The
  // generated client type predates these columns, so read them via a narrow cast.
  const appr = ((design ?? {}) as unknown) as {
    qualityApproverName?: string | null;
    qualityApproverInitials?: string | null;
    qualityApproverMeaning?: string | null;
    qualityApprovedAt?: string | null;
    managerApproverName?: string | null;
    managerApproverInitials?: string | null;
    managerApproverMeaning?: string | null;
    managerApprovedAt?: string | null;
  };
  const qualitySigned = !!appr.qualityApprovedAt;
  const managerSigned = !!appr.managerApprovedAt;

  const startEdit = (field: "artworkUrl" | "notes" | "version") => {
    const val =
      field === "artworkUrl"
        ? design?.artworkUrl
        : field === "notes"
          ? design?.notes
          : design?.version;
    setDraft(val ?? "");
    setEditingField(field);
  };

  const saveEdit = async () => {
    if (!editingField) return;
    setSaving(true);
    try {
      await updateDesign.mutateAsync({ id, data: { [editingField]: draft } });
      invalidate();
      setEditingField(null);
      toast({ title: "Saved" });
    } catch {
      toast({
        title: "Error",
        description: "Failed to save.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (
    newStatus: "Under Review" | "Rejected" | "Superseded" | "Draft"
  ) => {
    try {
      // The reason is written WITH the rejection, and cleared on any move out of
      // it — a design that has been fixed and re-submitted must not still carry
      // the note explaining why the previous version was turned back.
      const data: Record<string, unknown> = { status: newStatus };
      if (newStatus === "Rejected") data.rejectionReason = rejectReason.trim();
      else data.rejectionReason = null;
      await updateDesign.mutateAsync({ id, data: data as never });
      invalidate();
      toast({
        title: "Status updated",
        description: `Design is now "${newStatus}".`,
      });
      setRejectConfirm(false);
      setRejectReason("");
    } catch {
      toast({
        title: "Error",
        description: "Failed to update status.",
        variant: "destructive",
      });
    }
  };

  const handleSign = async (initials: string, meaning: string) => {
    if (!signSlot) return;
    const resp = await fetch(`/api/packaging-designs/${id}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ slot: signSlot, initials, signatureMeaning: meaning }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({} as { error?: string }));
      toast({
        title: "Sign-off failed",
        description: err?.error ?? "Unknown error",
        variant: "destructive",
      });
      throw new Error(err?.error ?? "sign failed");
    }
    invalidate();
    toast({
      title: `${signSlot === "quality" ? "Quality" : "Manager"} sign-off recorded`,
      description: "Recorded per 21 CFR Part 11.",
    });
    setSignatureOpen(false);
    setSignSlot(null);
  };

  const proofIsArtwork = !!((design ?? {}) as { proofIsArtwork?: boolean }).proofIsArtwork;
  const hasUrl = !!design?.artworkUrl?.trim();
  const artworkPresent = hasUrl || (proofIsArtwork && proofFileCount > 0);

  const toggleProofIsArtwork = async (v: boolean) => {
    try {
      await updateDesign.mutateAsync({ id, data: { proofIsArtwork: v } as never });
      invalidate();
    } catch {
      toast({ title: "Error", description: "Failed to update.", variant: "destructive" });
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6 max-w-5xl mx-auto pb-12 print:max-w-none">

        {/* ── Header ── */}
        <div>
          <Link
            href="/packaging"
            className="text-sm text-primary hover:underline mb-2 block print:hidden"
          >
            &larr; Back to Packaging
          </Link>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                {isLoading ? (
                  <Skeleton className="h-8 w-[220px]" />
                ) : (
                  design?.designName
                )}
              </h1>
              <div className="text-muted-foreground mt-0.5 text-sm">
                {isLoading ? (
                  <Skeleton className="h-4 w-[140px]" />
                ) : (
                  <>
                    {design?.productType} &mdash; Version {design?.version}
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 print:hidden">
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.print()}
              >
                <Printer className="h-4 w-4 mr-1" />
                Print
              </Button>
              {design && statusBadge(design.status)}
            </div>
          </div>
        </div>

        {/* ── Status notice banner ── */}
        {design && isApproved && (
          <div className="flex items-start gap-3 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-green-900">
            <ShieldCheck className="h-5 w-5 shrink-0 mt-0.5 text-green-600" />
            <div>
              <p className="font-semibold text-sm">
                Approved — Cleared for Production Use
              </p>
              <p className="text-xs mt-0.5 opacity-90">
                Approved by {appr.qualityApproverName} ({appr.qualityApproverInitials}, Quality)
                {appr.qualityApprovedAt ? ` on ${format(new Date(appr.qualityApprovedAt), "MMM d, yyyy")}` : ""}
                {" and "}{appr.managerApproverName} ({appr.managerApproverInitials}, Manager)
                {appr.managerApprovedAt ? ` on ${format(new Date(appr.managerApprovedAt), "MMM d, yyyy")}` : ""}
                . Any changes to artwork or label copy require a new version and
                re-approval under 21 CFR Part 11.
              </p>
            </div>
          </div>
        )}

        {design && isRejected && (
          <div className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">
            <XCircle className="h-5 w-5 shrink-0 mt-0.5 text-red-600" />
            <div>
              <p className="font-semibold text-sm">
                Rejected — Revision Required Before Re-Submission
              </p>
              {((design ?? {}) as { rejectionReason?: string | null }).rejectionReason && (
                <p className="text-sm mt-1" data-testid="text-rejection-reason">
                  {((design ?? {}) as { rejectionReason?: string | null }).rejectionReason}
                </p>
              )}
              <p className="text-xs mt-0.5 opacity-90">
                Address all deficiencies noted in the review comments, update
                the version number, and re-submit for review.
              </p>
            </div>
          </div>
        )}

        {design && isSuperseded && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
            <AlertCircle className="h-5 w-5 shrink-0 mt-0.5 text-amber-600" />
            <div>
              <p className="font-semibold text-sm">
                Superseded — Do Not Use for Production
              </p>
              <p className="text-xs mt-0.5 opacity-90">
                This version has been superseded by a newer approved design.
                Retain for records; do not use artwork for new production runs.
              </p>
            </div>
          </div>
        )}

        {/* ── Compliance summary bar ── */}
        {design && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {/* Status */}
            <div
              className={`rounded-lg border p-3 text-center ${
                isApproved
                  ? "bg-green-50 border-green-200 text-green-800"
                  : isRejected
                    ? "bg-red-50 border-red-200 text-red-800"
                    : isSuperseded
                      ? "bg-amber-50 border-amber-200 text-amber-800"
                      : design.status === "Under Review"
                        ? "bg-blue-50 border-blue-200 text-blue-800"
                        : "bg-slate-50 border-slate-200 text-slate-600"
              }`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                {isApproved ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : isRejected ? (
                  <XCircle className="h-3.5 w-3.5" />
                ) : (
                  <Clock className="h-3.5 w-3.5" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wide">
                  Status
                </span>
              </div>
              <p className="text-sm font-bold">{design.status}</p>
            </div>

            {/* Artwork */}
            <div
              className={`rounded-lg border p-3 text-center ${
                artworkPresent
                  ? "bg-green-50 border-green-200 text-green-800"
                  : "bg-red-50 border-red-200 text-red-800"
              }`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                {artworkPresent ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wide">
                  Artwork
                </span>
              </div>
              <p className="text-sm font-bold">
                {hasUrl ? "Linked" : artworkPresent ? "Proof on file" : "Missing"}
              </p>
            </div>

            {/* Label compliance */}
            <div
              className={`rounded-lg border p-3 text-center ${
                checklistPct === 100
                  ? "bg-green-50 border-green-200 text-green-800"
                  : checklistPct >= 75
                    ? "bg-yellow-50 border-yellow-200 text-yellow-800"
                    : "bg-red-50 border-red-200 text-red-800"
              }`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                {checklistPct === 100 ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wide">
                  Label Check
                </span>
              </div>
              <p className="text-sm font-bold">{checklistPct}%</p>
            </div>

            {/* Approval */}
            <div
              className={`rounded-lg border p-3 text-center ${
                isApproved
                  ? "bg-green-50 border-green-200 text-green-800"
                  : "bg-slate-50 border-slate-200 text-slate-600"
              }`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                {isApproved ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <Clock className="h-3.5 w-3.5" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wide">
                  Approval
                </span>
              </div>
              <p className="text-sm font-bold">
                {isApproved
                  ? design.approvalDate
                    ? format(new Date(design.approvalDate + "T00:00:00"), "MMM d")
                    : "Signed"
                  : "Pending"}
              </p>
            </div>
          </div>
        )}

        {/* ── Tabs ── */}
        <Tabs defaultValue="design">
          <TabsList className="print:hidden">
            <TabsTrigger value="design">Design</TabsTrigger>
            <TabsTrigger value="verified">
              Where Verified
              {missingRuleSets.length > 0 && (
                <span className="ml-1.5 text-xs font-bold text-destructive">!</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="checklist">
              Packaging Compliance
              {checklistPct > 0 && checklistPct < 100 && (
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {checklistPct}%
                </span>
              )}
              {checklistPct === 100 && (
                <CheckCircle2 className="ml-1.5 h-3.5 w-3.5 text-green-600" />
              )}
            </TabsTrigger>
            <TabsTrigger value="audit">Audit Log</TabsTrigger>
          </TabsList>

          {/* ── DESIGN TAB ── */}
          <TabsContent value="design" className="mt-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="md:col-span-2 space-y-6">

                {/* Artwork URL */}
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-base">
                      Artwork File / URL
                      {!artworkPresent && (
                        <span className="ml-2 text-xs font-normal text-destructive">
                          required for approval
                        </span>
                      )}
                    </CardTitle>
                    {!isLocked && editingField !== "artworkUrl" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => startEdit("artworkUrl")}
                      >
                        {artworkPresent ? "Edit" : "Add"}
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent className="pt-2">
                    {editingField === "artworkUrl" ? (
                      <div className="space-y-2">
                        <Input
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          placeholder="https://drive.google.com/… or shared storage path"
                          className="text-sm font-mono"
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={saveEdit}
                            disabled={saving}
                          >
                            {saving ? "Saving…" : "Save"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingField(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : design?.artworkUrl ? (
                      <a
                        href={design.artworkUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline font-mono break-all"
                      >
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                        {design.artworkUrl}
                      </a>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">
                        No artwork URL provided. Required before approval.
                      </p>
                    )}
                    {/* 2026-08-09 — uploaded proof can serve as the artwork of record */}
                    <div className="mt-3 flex items-start gap-2 border-t pt-3">
                      <Checkbox
                        id="proof-is-artwork"
                        className="mt-0.5"
                        checked={proofIsArtwork}
                        disabled={isLocked || proofFileCount === 0}
                        onCheckedChange={(v) => toggleProofIsArtwork(!!v)}
                      />
                      <label
                        htmlFor="proof-is-artwork"
                        className="text-sm leading-snug cursor-pointer"
                      >
                        <span className="font-medium">
                          Use uploaded proof as the artwork of record
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {proofFileCount === 0
                            ? "Attach a proof file below to enable this."
                            : "Counts the attached proof as artwork — no URL required."}
                        </span>
                      </label>
                    </div>
                  </CardContent>
                </Card>

                {/* Version */}
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-base">Version</CardTitle>
                    {!isLocked && editingField !== "version" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => startEdit("version")}
                      >
                        Edit
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent className="pt-2">
                    {editingField === "version" ? (
                      <div className="space-y-2">
                        <Input
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          placeholder="e.g. 1.0, 2.3, Rev-A"
                          className="text-sm w-40"
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={saveEdit}
                            disabled={saving}
                          >
                            {saving ? "Saving…" : "Save"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingField(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm font-medium">
                        {design?.version ?? "—"}
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* Review notes */}
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-base">Review Notes</CardTitle>
                    {!isLocked && editingField !== "notes" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => startEdit("notes")}
                      >
                        {design?.notes ? "Edit" : "Add"}
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent className="pt-2">
                    {editingField === "notes" ? (
                      <div className="space-y-2">
                        <Textarea
                          rows={5}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          placeholder="Design review comments, change history, rejection reasons, regulatory correspondence…"
                          className="text-sm"
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={saveEdit}
                            disabled={saving}
                          >
                            {saving ? "Saving…" : "Save"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingField(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : design?.notes ? (
                      <p className="text-sm bg-muted/30 p-3 rounded-md whitespace-pre-wrap">
                        {design.notes}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">
                        No review notes yet.
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* Two-signer approval signatures (21 CFR Part 11).
                    2026-09-01 — this used to appear only once SOMEBODY had signed,
                    so a design sitting in review showed nothing at all about what
                    it was waiting for. It now appears as soon as the design leaves
                    Draft, and names the role each outstanding signature needs.
                    ⛔ Naming the ROLE, not a person: packaging has no assignment
                    step and is not getting one ("we don't need to assign reviews
                    of labels" — 2026-09-01). Any Quality or Manager may sign. */}
                {(qualitySigned || managerSigned || design?.status !== "Draft") && (
                  <Card className={(qualitySigned || managerSigned) ? "border-green-200 bg-green-50/50" : ""}>
                    <CardHeader className="pb-2">
                      <CardTitle className={`text-base flex items-center gap-2 ${(qualitySigned || managerSigned) ? "text-green-800" : ""}`}>
                        <CheckCircle2 className="h-4 w-4" />
                        Electronic Approval Signatures (21 CFR Part 11)
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {([
                        { label: "Quality", name: appr.qualityApproverName, initials: appr.qualityApproverInitials, meaning: appr.qualityApproverMeaning, at: appr.qualityApprovedAt },
                        { label: "Manager", name: appr.managerApproverName, initials: appr.managerApproverInitials, meaning: appr.managerApproverMeaning, at: appr.managerApprovedAt },
                      ]).map((s) => (
                        <div key={s.label}>
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                            {s.label} approval
                          </p>
                          {s.at ? (
                            <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                              <div>
                                <dt className="text-xs font-medium text-muted-foreground">Signed By</dt>
                                <dd className="mt-0.5 font-medium">{s.name}</dd>
                              </div>
                              <div>
                                <dt className="text-xs font-medium text-muted-foreground">Initials</dt>
                                <dd className="mt-0.5 font-medium">{s.initials}</dd>
                              </div>
                              <div>
                                <dt className="text-xs font-medium text-muted-foreground">Meaning</dt>
                                <dd className="mt-0.5 font-medium">{s.meaning}</dd>
                              </div>
                              <div>
                                <dt className="text-xs font-medium text-muted-foreground">Date &amp; Time</dt>
                                <dd className="mt-0.5 font-medium">{format(new Date(s.at), "MMM d, yyyy h:mm a")}</dd>
                              </div>
                            </dl>
                          ) : (
                            <p className="text-sm text-muted-foreground italic" data-testid={`pending-${s.label.toLowerCase()}`}>
                              Awaiting {s.label} sign-off — any {s.label} (or Admin) user can sign it.
                            </p>
                          )}
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}

                {/* Approved label / packaging proof (bring-your-own-label model) */}
                <AttachmentsPanel
                  parentTable="packaging_designs"
                  parentId={id}
                  allowSupplementary={!isLocked}
                  currentUserId={currentUser?.id}
                  currentUserRole={currentUser?.role}
                  title="Approved Packaging Proof (artwork)"
                  onActiveCountChange={setProofFileCount}
                />
              </div>

              {/* ── Right sidebar ── */}
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Details</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <dl className="space-y-4">
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Product Type
                        </dt>
                        <dd className="mt-1 text-sm font-medium">
                          {design?.productType ?? "—"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Version
                        </dt>
                        <dd className="mt-1 text-sm">{design?.version ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Status
                        </dt>
                        <dd className="mt-1">
                          {design && statusBadge(design.status)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Created
                        </dt>
                        <dd className="mt-1 text-sm">
                          {design?.createdAt
                            ? format(new Date(design.createdAt), "MMM d, yyyy")
                            : "—"}
                        </dd>
                      </div>
                      {design?.approvalDate && (
                        <div>
                          <dt className="text-xs font-medium text-muted-foreground">
                            Approved
                          </dt>
                          <dd className="mt-1 text-sm">
                            {format(
                              new Date(design.approvalDate + "T00:00:00"),
                              "MMM d, yyyy"
                            )}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </CardContent>
                </Card>

                {/* Workflow actions */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Review Workflow</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {design?.status === "Draft" && (
                      <>
                        <p className="text-xs text-muted-foreground">
                          Complete the label compliance checklist and add artwork
                          before submitting for review.
                        </p>
                        <Button
                          className="w-full"
                          variant="outline"
                          size="sm"
                          disabled={!artworkPresent}
                          onClick={() => handleStatusChange("Under Review")}
                        >
                          <ChevronRight className="h-4 w-4 mr-1" />
                          Submit for Review
                        </Button>
                        {!artworkPresent && (
                          <p className="text-xs text-destructive">
                            Add an artwork URL, or attach a proof file and check
                            "Use uploaded proof as the artwork of record".
                          </p>
                        )}
                      </>
                    )}

                    {inSigningPhase && (
                      <>
                        <p className="text-xs text-muted-foreground">
                          Retail packaging needs two sign-offs — Quality (meets
                          state requirements) and a Manager — by two different
                          people. Approved once both are signed (21 CFR Part 11).
                        </p>
                        <Button
                          className="w-full"
                          size="sm"
                          variant={qualitySigned ? "outline" : "default"}
                          disabled={qualitySigned || !canSign}
                          onClick={() => { setSignSlot("quality"); setSignatureOpen(true); }}
                        >
                          <CheckCircle2 className="h-4 w-4 mr-1" />
                          {qualitySigned ? "Quality Signed" : "Quality Sign-off"}
                        </Button>
                        <Button
                          className="w-full"
                          size="sm"
                          variant={managerSigned ? "outline" : "default"}
                          disabled={managerSigned || !canSign}
                          onClick={() => { setSignSlot("manager"); setSignatureOpen(true); }}
                        >
                          <CheckCircle2 className="h-4 w-4 mr-1" />
                          {managerSigned ? "Manager Signed" : "Manager Sign-off"}
                        </Button>
                        {!canSign && (
                          <p className="text-xs text-destructive">
                            {designStates.length === 0
                              ? "Tick the states this design is approved for on Where Verified."
                              : missingRuleSets.length > 0
                                ? `No rules are loaded for ${missingRuleSets.join(", ")}.`
                                : `Packaging Compliance ${checklistPct}% — verify the rest.`}
                          </p>
                        )}
                        {!rejectConfirm ? (
                          <Button
                            className="w-full"
                            variant="outline"
                            size="sm"
                            onClick={() => setRejectConfirm(true)}
                          >
                            <XCircle className="h-4 w-4 mr-1" />
                            Reject Design
                          </Button>
                        ) : (
                          <div className="rounded border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                            <p className="text-xs text-destructive font-medium">
                              Why is this design being rejected? The reason is
                              recorded on the design and shown to whoever picks
                              it back up.
                            </p>
                            <Textarea
                              rows={3}
                              value={rejectReason}
                              onChange={(e) => setRejectReason(e.target.value)}
                              placeholder="e.g. Universal symbol is under the minimum size, and the net weight is missing from the back panel."
                              data-testid="input-reject-reason"
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={!rejectReason.trim()}
                                onClick={() => handleStatusChange("Rejected")}
                                data-testid="button-confirm-reject"
                              >
                                Confirm Reject
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => { setRejectConfirm(false); setRejectReason(""); }}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {isRejected && (
                      <>
                        <p className="text-xs text-muted-foreground">
                          Address deficiencies, update version, and re-submit.
                        </p>
                        <Button
                          className="w-full"
                          variant="outline"
                          size="sm"
                          onClick={() => handleStatusChange("Draft")}
                        >
                          <RotateCcw className="h-4 w-4 mr-1" />
                          Return to Draft
                        </Button>
                      </>
                    )}

                    {isApproved && (
                      <>
                        <p className="text-xs text-muted-foreground">
                          If a new version supersedes this design, mark it
                          accordingly to prevent use of old artwork.
                        </p>
                        <Button
                          className="w-full"
                          variant="outline"
                          size="sm"
                          onClick={() => handleStatusChange("Superseded")}
                        >
                          Mark as Superseded
                        </Button>
                      </>
                    )}

                    {isSuperseded && (
                      <p className="text-xs text-muted-foreground text-center py-1">
                        This version is superseded and read-only.
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          </TabsContent>

          {/* ── LABEL COMPLIANCE TAB ── */}
          {/* ── WHERE VERIFIED TAB ──
              Which states this design is approved for, and for each of their
              requirements ONE question: does this packaging carry it — yes / no /
              not applicable. ⛔ 2026-09-01, his ruling: a fourth answer ("the
              label template carries it") was removed. It stated something only the
              label can state, the label states it too, and nothing reconciled the
              two — so the same requirement was being answered in three places.
              A packaging design now speaks only about the packaging.
              ⛔ Deciding and verifying are still two different acts by two
              different people at two different times, so the tick lives on the
              next tab, not on this row. */}
          <TabsContent value="verified" className="mt-4">
            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">States this design is approved for</CardTitle>
                </CardHeader>
                <CardContent className="pb-4">
                  {availableStates.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No state rule sets are loaded. An administrator adds one in Settings &rarr; Regulatory.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-x-6 gap-y-3">
                      {availableStates.map((st) => {
                        const on = designStates.includes(st);
                        return (
                          <label key={st} className={`flex items-center gap-2 text-sm ${isLocked ? "cursor-default" : "cursor-pointer"}`}>
                            <Checkbox
                              checked={on}
                              disabled={isLocked}
                              data-testid={`state-${st}`}
                              onCheckedChange={() =>
                                setDesignStates(on ? designStates.filter((x) => x !== st) : [...designStates, st])
                              }
                            />
                            <span className="capitalize">{st.toLowerCase()}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
                    One state for a single-site operator; several for an MSO, in which case the list
                    below is every requirement any of them impose &mdash; which is the conversation to
                    have before ordering a million pouches.
                  </p>
                </CardContent>
              </Card>

              {/* ── PRODUCTS THIS DESIGN IS FOR — 2026-09-02 ──
                  His domain fact, which settled it: an edible pouch is specific
                  to the edible AND its flavour, because the pouch prints the
                  ingredients, while cartridges share one pouch across every
                  strain and every H/I/S. Empty = the whole product type, which is
                  what every design written before today is, so nothing changes
                  for anyone who does not touch this. */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Products this design is for</CardTitle>
                </CardHeader>
                <CardContent className="pb-4">
                  {availableProducts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No active {design?.productType ?? "product"} recipes to choose from.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-x-6 gap-y-3">
                      {availableProducts.map((prod) => {
                        const on = designProducts.includes(prod.lineageId);
                        return (
                          <label key={prod.lineageId} className={`flex items-center gap-2 text-sm ${isLocked ? "cursor-default" : "cursor-pointer"}`}>
                            <Checkbox
                              checked={on}
                              disabled={isLocked}
                              data-testid={`design-product-${prod.lineageId}`}
                              onCheckedChange={() =>
                                setDesignProducts(
                                  on
                                    ? designProducts.filter((x) => x !== prod.lineageId)
                                    : [...designProducts, prod.lineageId],
                                )
                              }
                            />
                            <span>
                              {prod.productName}
                              {prod.subtype ? <span className="text-muted-foreground"> · {prod.subtype}</span> : null}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
                    {designProducts.length === 0
                      ? `Nothing ticked, so this design covers every ${design?.productType ?? "product"} — right for a pouch that prints no ingredients, like a cartridge pouch shared across strains. Tick products when the artwork is specific to them, as an edible pouch printing its ingredients is.`
                      : "Only the products ticked above stop being asked this design's requirements before every print. Everything else of this type falls back to the designs that name no products."}
                  </p>
                  {isLocked && (
                    <p className="text-xs text-amber-700 mt-2">
                      Approved, so this cannot change &mdash; the two signatures verified these
                      requirements against these products. Raise a new version.
                    </p>
                  )}
                </CardContent>
              </Card>

              {missingRuleSets.length > 0 && (
                <Card className="border-destructive/40 bg-destructive/5">
                  <CardContent className="pt-4 pb-4">
                    <p className="text-sm font-semibold text-destructive mb-1">
                      No rules loaded for {missingRuleSets.join(", ")}
                    </p>
                    <p className="text-xs text-destructive/90 leading-relaxed">
                      A state with legal cannabis has packaging requirements, so this is a rule set that
                      has not been loaded &mdash; not a state with nothing to meet. Nothing below covers
                      it, and this design cannot be approved until it is loaded.
                    </p>
                  </CardContent>
                </Card>
              )}

              {designStates.length === 0 ? (
                <Card>
                  <CardContent className="pt-5 pb-5">
                    <p className="text-sm text-muted-foreground">
                      Tick the states this design is approved for and their requirements appear here.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Does this packaging carry it?</CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">
                      One question per requirement. <strong>Yes</strong> means this artwork prints
                      it, and it is verified once on the next tab instead of before every print.
                      <strong> No</strong> means it is checked before each print, unless the
                      product&rsquo;s approved label lists it under Fixed Content — that is the
                      label&rsquo;s own statement, made in Label Studio, not here.
                    </p>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <ul className="divide-y">
                      {requirements.map((req) => {
                        const fixed = req.control === "Packaging";
                        // 2026-09-06 — N/A used to be locked out on every per-batch
                        // item, on the reasoning that whether it applies is a question
                        // for the print in front of you. That is right for an item the
                        // rules ALWAYS demand, and wrong for a CONDITIONAL one: the MI
                        // list carries "Date of harvest, only on products that include
                        // flower" as not-required for concentrates, and on a vape cart
                        // it does not apply to any print, ever — yet the only answer
                        // available was "No — On Label", which promises a harvest date
                        // that will never be printed. So a conditional item may be
                        // marked N/A here (with the optional reason already beside it);
                        // an item the rules require still cannot be answered away.
                        const canMarkNA = fixed || !req.required;
                        return (
                          <li key={req.key} className="py-3 flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm leading-snug">{req.itemText}</p>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {req.regulationRef}
                                {designStates.length > 1 && ` · ${req.states.map((x) => x.toLowerCase()).join(", ")}`}
                                {!fixed && " · changes per batch"}
                              </p>
                              {req.target === "NotApplicable" && (
                                <Input
                                  className="mt-2 h-7 text-xs"
                                  placeholder="Why it does not apply (optional)"
                                  defaultValue={req.note ?? ""}
                                  disabled={isLocked}
                                  data-testid={`note-${req.key}`}
                                  onBlur={(e) => {
                                    const v = e.target.value.trim();
                                    if (v !== (req.note ?? "")) setRequirementTarget(req.key, "NotApplicable", v);
                                  }}
                                />
                              )}
                            </div>
                            <div className="w-44 shrink-0">
                              <Select
                                value={req.target}
                                disabled={isLocked}
                                onValueChange={(v) => setRequirementTarget(req.key, v)}
                              >
                                <SelectTrigger className="h-8 text-xs" data-testid={`target-${req.key}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {targets.map((t) => (
                                    <SelectItem
                                      key={t}
                                      value={t}
                                      className="text-xs"
                                      // "Yes — this packaging" still needs a value the
                                      // packaging itself carries. N/A additionally opens
                                      // up for a CONDITIONAL requirement (see canMarkNA).
                                      disabled={t === "Packaging" ? !fixed : t === "NotApplicable" ? !canMarkNA : false}
                                    >
                                      {/* 2026-09-01 — one question, three answers.
                                          "Label template" was a fourth, and it said
                                          something only the label itself can say. */}
                                      {t === "Packaging"
                                        ? "Yes — this packaging"
                                        : t === "NotApplicable"
                                          ? "N/A — doesn't apply"
                                          : "No — On Label"}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </CardContent>
                </Card>
              )}

              <Card className="border-blue-100 bg-blue-50/30">
                <CardContent className="pt-4 pb-4">
                  <p className="text-xs text-blue-900 font-medium mb-1">Where these come from</p>
                  <p className="text-xs text-blue-800 leading-relaxed">
                    Every requirement above is read from the rules of the states ticked, with the rule
                    it comes from beside it. Moving one to this packaging means it is verified ONCE, on
                    the next tab, when the design is approved &mdash; and it stops being asked before
                    every print. Anything left on batch labeling is asked every time, which is the safe
                    default; a requirement that changes with the batch can only ever live there.
                  </p>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ── PACKAGING COMPLIANCE TAB ──
              The review: exactly what Where Verified says this packaging carries,
              and nothing else. Derived, never typed twice. */}
          <TabsContent value="checklist" className="mt-4">
            <div className="space-y-4">
              <Card>
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-sm font-semibold">
                      Verified on this artwork
                    </p>
                    <span className={`text-sm font-bold ${checklistPct === 100 ? "text-green-600" : "text-amber-600"}`}>
                      {checked.size} / {packagingReqs.length} — {checklistPct}%
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Both signatures cover these ticks, so they freeze when the design is approved.
                  </p>
                </CardContent>
              </Card>

              {packagingReqs.length === 0 ? (
                <Card>
                  <CardContent className="pt-5 pb-5">
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      This design does not claim to carry any requirement, so there is nothing to verify
                      here. That is a valid answer: everything stays on the check that runs before every
                      print. Move a requirement to <span className="font-medium">This packaging</span> on
                      Where Verified and it appears here.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="pt-4">
                    <ul className="divide-y">
                      {packagingReqs.map((req) => {
                        const isChecked = checked.has(req.key);
                        return (
                          <li key={req.key} className="py-3 flex items-start gap-3">
                            <div className="w-5 pt-0.5">
                              <Checkbox
                                id={req.key}
                                checked={isChecked}
                                disabled={isLocked}
                                onCheckedChange={() => toggleItem(req.key)}
                                data-testid={`check-${req.key}`}
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <label
                                htmlFor={req.key}
                                className={`text-sm leading-snug ${
                                  isChecked ? "text-muted-foreground line-through" : "text-foreground"
                                } ${isLocked ? "cursor-default" : "cursor-pointer"} select-none`}
                              >
                                {req.itemText}
                              </label>
                              <p className="text-xs text-muted-foreground mt-0.5">{req.regulationRef}</p>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          {/* ── AUDIT LOG TAB ── */}
          <TabsContent value="audit" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Audit Trail</CardTitle>
              </CardHeader>
              <CardContent>
                {auditLog.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No audit entries found.
                  </p>
                ) : (
                  <div className="divide-y text-sm">
                    {auditLog.map((entry) => (
                      <div
                        key={entry.id}
                        className="py-3 flex items-start gap-4"
                      >
                        <div className="w-36 shrink-0 text-xs text-muted-foreground pt-0.5 font-mono">
                          {entry.changedAt
                            ? format(
                                new Date(entry.changedAt),
                                "MMM d, yyyy HH:mm"
                              )
                            : "—"}
                        </div>
                        <div className="flex-1 space-y-1">
                          <div className="flex items-center gap-2">
                            <Badge
                              variant={
                                entry.operation === "INSERT"
                                  ? "default"
                                  : entry.operation === "DELETE"
                                    ? "destructive"
                                    : "secondary"
                              }
                              className="text-xs"
                            >
                              {entry.operation}
                            </Badge>
                            <span className="font-medium text-sm">
                              {entry.changedByName ?? "System"}
                            </span>
                          </div>
                          {/* Shared renderer — was Object.keys(afterState), the
                              field NAMES only, and since the whole row is stored
                              that listed every column on every save. */}
                          <AuditDiff
                            before={entry.beforeState}
                            after={entry.afterState}
                            operation={entry.operation ?? "UPDATE"}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <Part11SignatureDialog
        open={signatureOpen}
        onOpenChange={(o) => { setSignatureOpen(o); if (!o) setSignSlot(null); }}
        title={signSlot === "manager" ? "Manager Sign-off — Packaging" : "Quality Sign-off — Packaging"}
        description={signSlot === "manager"
          ? "By signing, you provide the Manager approval that this retail packaging is approved for the initial production order. Must be a different person than the Quality signer (21 CFR Part 11)."
          : "By signing, you confirm this retail packaging meets Michigan R 420.401/420.402 label requirements and all checklist items are verified (Quality approval, 21 CFR Part 11)."}
        onSign={handleSign}
        isPending={false}
      />
    </AppLayout>
  );
}
