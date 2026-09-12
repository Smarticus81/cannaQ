import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SiteBadge } from "@/components/FacilitySite";
import {
  useGetFieldAction,
  useUpdateFieldAction,
  useCloseFieldAction,
  useListAuditLog,
  useGetCurrentUser,
  getGetFieldActionQueryKey,
} from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { accentClass, toneFieldActionType, toneFieldActionStatus } from "@/lib/status";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "wouter";
import { format } from "date-fns";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { AffectedLotsPanel } from "@/components/field-action/AffectedLotsPanel";
import { AffectedBatchesPanel } from "@/components/field-action/AffectedBatchesPanel";
import { ResponseActionsPanel } from "@/components/field-action/ResponseActionsPanel";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { CreateDestructionRecordDialog } from "@/components/dialogs/CreateDestructionRecordDialog";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { AuditDiff } from "@/components/audit/AuditDiff";
import { FieldActionGateCard } from "@/components/field-action/FieldActionGateCard";
import {
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  Clock,
  ShieldAlert,
  Printer,
  ChevronRight,
  ExternalLink,
} from "lucide-react";

// ── Status workflow ───────────────────────────────────────────────────────────
const STATUS_STEPS = [
  "Initiated",
  "Scope Defined",
  "Response Active",
  "Due Diligence",
  "Closed",
] as const;

type FAStatus = (typeof STATUS_STEPS)[number];

function stepIndex(status: string): number {
  return STATUS_STEPS.indexOf(status as FAStatus);
}

// ── Action type styles (Session 15 — all 5 dialog values now covered) ────────
const ACTION_TYPE_STYLES: Record<
  string,
  { bar: string; badge: string; icon: string }
> = {
  "Voluntary Recall": {
    bar: "border-red-300 bg-red-50 text-red-900",
    badge: "bg-red-100 text-red-800 border-red-300",
    icon: "text-red-600",
  },
  "Regulatory Recall": {
    bar: "border-red-400 bg-red-100 text-red-950",
    badge: "bg-red-200 text-red-900 border-red-400",
    icon: "text-red-700",
  },
  "Stop Sale": {
    bar: "border-purple-300 bg-purple-50 text-purple-900",
    badge: "bg-purple-100 text-purple-800 border-purple-300",
    icon: "text-purple-600",
  },
  "Market Withdrawal": {
    bar: "border-orange-300 bg-orange-50 text-orange-900",
    badge: "bg-orange-100 text-orange-800 border-orange-300",
    icon: "text-orange-600",
  },
  "Safety Alert": {
    bar: "border-yellow-300 bg-yellow-50 text-yellow-900",
    badge: "bg-yellow-100 text-yellow-800 border-yellow-300",
    icon: "text-yellow-600",
  },
  // Informational only — deliberately blue, not a warning colour. The product is
  // safe and stays saleable; dressing this in yellow would read as a hazard.
  "Notification Only": {
    bar: "border-sky-300 bg-sky-50 text-sky-900",
    badge: "bg-sky-100 text-sky-800 border-sky-300",
    icon: "text-sky-600",
  },
  // Back-compat for any rows created before Session 15. The DB never
  // restricted action_type values, so historical rows may still carry these.
  Recall: {
    bar: "border-red-300 bg-red-50 text-red-900",
    badge: "bg-red-100 text-red-800 border-red-300",
    icon: "text-red-600",
  },
  Withdrawal: {
    bar: "border-orange-300 bg-orange-50 text-orange-900",
    badge: "bg-orange-100 text-orange-800 border-orange-300",
    icon: "text-orange-600",
  },
  "Advisory Notice": {
    bar: "border-yellow-300 bg-yellow-50 text-yellow-900",
    badge: "bg-yellow-100 text-yellow-800 border-yellow-300",
    icon: "text-yellow-600",
  },
};

// ── Urgency banner copy (Session 15) ─────────────────────────────────────────
// Headline + subtext per action type. Falls back to a generic message for any
// unrecognised type so the banner never disappears silently.
const ACTION_TYPE_BANNER: Record<string, { headline: string; subtext: string }> = {
  "Voluntary Recall": {
    headline: "Voluntary Recall — Immediate Michigan CRA Notification Required",
    subtext: "Under R 420.209, notify the CRA immediately and quarantine all affected METRC packages. See the Regulatory tab for the full required workflow.",
  },
  "Regulatory Recall": {
    headline: "Regulatory Recall — Mandatory CRA-Directed Action",
    subtext: "The CRA has directed this recall. Comply with all instructions in the directive, quarantine all affected METRC packages immediately, and document each step under Response Actions.",
  },
  "Stop Sale": {
    headline: "Stop Sale — Immediate Hold on All Affected Inventory",
    subtext: "Halt sale at every dispensary holding affected packages and place METRC administrative holds. Document each stop-sale notice in Response Actions; escalate to Recall if a health risk is confirmed.",
  },
  "Market Withdrawal": {
    headline: "Market Withdrawal — Michigan CRA Notification Required",
    subtext: "Notify the CRA within 3 business days and quarantine affected packages in METRC. Document each retailer contact in Response Actions.",
  },
  "Safety Alert": {
    headline: "Safety Alert — Customer Notification Required",
    subtext: "Document all customer / dispensary notification dates and confirmation receipts in Response Actions. Escalate to Recall or Stop Sale immediately if a confirmed health risk emerges.",
  },
  "Notification Only": {
    headline: "Notification Only — No Sale Restriction",
    subtext: "The product is unaffected and remains saleable and safe to consume. This records an informational notice to each downstream licensee holding it — retailer, distributor, or product still in transport. Record each notice and its confirmation in Response Actions. If a safety concern emerges, change the action type and escalate.",
  },
  // Legacy back-compat (pre-Session 15)
  Recall: {
    headline: "Voluntary Recall — Immediate Michigan CRA Notification Required",
    subtext: "Under R 420.209, notify the CRA immediately and quarantine all affected METRC packages.",
  },
  Withdrawal: {
    headline: "Market Withdrawal — Michigan CRA Notification Required",
    subtext: "Notify the CRA within 3 business days and quarantine affected packages in METRC.",
  },
  "Advisory Notice": {
    headline: "Advisory Notice — Document All Customer Notifications",
    subtext: "Document all customer notification dates and confirmation receipts in Response Actions below.",
  },
};

// ── Parse affected batch numbers into clickable links ─────────────────────────
function AffectedBatchLinks({ text }: { text: string }) {
  const BATCH_RE = /BTH-\d{2}-\d{4}/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = BATCH_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const batchNum = m[0];
    parts.push(
      <Link
        key={m.index}
        href={`/batches?q=${batchNum}`}
        className="text-primary hover:underline font-mono font-medium"
      >
        {batchNum}
      </Link>
    );
    last = m.index + batchNum.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

type EditableFieldKey =
  | "affectedBatches"
  | "scopeDescription"
  | "dueDiligenceNotes"
  | "closureNotes";

// ── Linked-record summaries (loaded separately so the FA payload stays slim) ──
type LinkedNc = { id: number; ncNumber: string; title: string; status: string };
type LinkedComplaint = { id: number; complaintNumber: string; status: string };
type LinkedCapa = { id: number; capaNumber: string; title: string; status: string };

export default function FieldActionDetail(props: { params?: { id: string } }) {
  const id = parseInt(props.params?.id ?? "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: fa, isLoading } = useGetFieldAction(id);
  const { data: currentUser } = useGetCurrentUser();
  const { data: auditLog = [] } = useListAuditLog({
    tableName: "field_actions",
    rowId: id,
    limit: 50,
  });

  const updateFA = useUpdateFieldAction();
  const closeFA = useCloseFieldAction();

  const [signatureOpen, setSignatureOpen] = useState(false);
  // Session 63.5 — stores whose product is still unaccounted for.
  const [openResponseCount, setOpenResponseCount] = useState(0);
  const [editing, setEditing] = useState<EditableFieldKey | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // ── Session 76 — request → approval ─────────────────────────────────────
  const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);
  const isApprover = APPROVER_ROLES.has(currentUser?.role ?? "");
  const isRequested = fa?.status === "Requested";
  // Pre-open = not yet a live Field Action (awaiting approval, or rejected).
  // The normal FA workflow controls (advance status, close, etc.) are hidden
  // until an approver opens it — advancing a Requested FA via the status button
  // would bypass approval and the mandatory-CAPA creation.
  const isPreOpen = isRequested || fa?.status === "Request Rejected";
  // Session 76 — the request/approval columns are off-spec (the orval-generated
  // FieldAction type predates them), consistent with the rest of the FA route.
  // Read them through a narrow cast rather than triggering a spec/codegen pass.
  const faApproval = fa as unknown as {
    requestedByName?: string | null;
    requestedAt?: string | Date | null;
    reviewedByName?: string | null;
    reviewedAt?: string | Date | null;
    rejectionReason?: string | null;
  } | undefined;
  const [reviewing, setReviewing] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  async function approveRequest() {
    setReviewing(true);
    try {
      const res = await fetch(`/api/field-actions/${id}/approve-request`, { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast({ title: d.error ?? "Failed to approve request", variant: "destructive" });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: getGetFieldActionQueryKey(id) });
      toast({ title: "Field Action approved — opened with its required CAPA." });
    } finally {
      setReviewing(false);
    }
  }

  async function rejectRequest() {
    if (!rejectReason.trim()) { toast({ title: "A rejection reason is required.", variant: "destructive" }); return; }
    setReviewing(true);
    try {
      const res = await fetch(`/api/field-actions/${id}/reject-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: rejectReason.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast({ title: d.error ?? "Failed to reject request", variant: "destructive" });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: getGetFieldActionQueryKey(id) });
      setRejectOpen(false);
      setRejectReason("");
      toast({ title: "Field Action request rejected." });
    } finally {
      setReviewing(false);
    }
  }

  // ── Linked-record state (Session 13) ───────────────────────────────────
  const [linkedNc, setLinkedNc] = useState<LinkedNc | null>(null);
  const [linkedComplaint, setLinkedComplaint] = useState<LinkedComplaint | null>(null);
  const [linkedCapa, setLinkedCapa] = useState<LinkedCapa | null>(null);
  const [capaOptions, setCapaOptions] = useState<LinkedCapa[]>([]);
  const [capaPickerOpen, setCapaPickerOpen] = useState(false);
  const [capaPickerValue, setCapaPickerValue] = useState<string>("");
  const [responseActionsCount, setResponseActionsCount] = useState<number>(0);
  const [destructionOpen, setDestructionOpen] = useState(false);
  const [destructionTags, setDestructionTags] = useState<string[]>([]);
  const [gatheringDestruction, setGatheringDestruction] = useState(false);

  // Fetch the linked source records once we know the FA's foreign keys.
  const faExt = fa as (typeof fa & {
    sourceNcId?: number | null;
    sourceComplaintId?: number | null;
    linkedCapaId?: number | null;
    productType?: string | null;
    productName?: string | null;
    lotNumber?: string | null;
    department?: string | null;
    // Session 63.4 gate columns. Cast rather than regenerated because the
    // API client is generated from the spec and this ships ahead of that run.
    gate0ApprovedAt?: string | null; gate0ApproverName?: string | null;
    gate0ApproverInitials?: string | null; gate0ApproverMeaning?: string | null;
    gate1ApprovedAt?: string | null; gate1ApproverName?: string | null;
    gate1ApproverInitials?: string | null; gate1ApproverMeaning?: string | null;
    gate2ApprovedAt?: string | null; gate2ApproverName?: string | null;
    gate2ApproverInitials?: string | null; gate2ApproverMeaning?: string | null;
    lastRejectionStage?: string | null; lastRejectionComment?: string | null;
    lastRejectionByName?: string | null; lastRejectionAt?: string | null;
  }) | undefined;

  // Gate reviews are the narrower Manager/Quality/Admin set, not the wider
  // approver set that may close records.
  const canSignGate = ["Manager", "Quality", "Admin"].includes(currentUser?.role ?? "");
  const gateRejection = {
    stage: faExt?.lastRejectionStage,
    comment: faExt?.lastRejectionComment,
    byName: faExt?.lastRejectionByName,
    at: faExt?.lastRejectionAt,
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (faExt?.sourceNcId) {
        const r = await fetch(`/api/non-conformances/${faExt.sourceNcId}`, { credentials: "include" });
        if (!cancelled && r.ok) setLinkedNc((await r.json()) as LinkedNc);
      } else if (!cancelled) {
        setLinkedNc(null);
      }
      if (faExt?.sourceComplaintId) {
        const r = await fetch(`/api/complaints/${faExt.sourceComplaintId}`, { credentials: "include" });
        if (!cancelled && r.ok) setLinkedComplaint((await r.json()) as LinkedComplaint);
      } else if (!cancelled) {
        setLinkedComplaint(null);
      }
      if (faExt?.linkedCapaId) {
        const r = await fetch(`/api/capas/${faExt.linkedCapaId}`, { credentials: "include" });
        if (!cancelled && r.ok) setLinkedCapa((await r.json()) as LinkedCapa);
      } else if (!cancelled) {
        setLinkedCapa(null);
      }
    })();
    return () => { cancelled = true; };
  }, [faExt?.sourceNcId, faExt?.sourceComplaintId, faExt?.linkedCapaId]);

  // Lazy-load the CAPA list only when the operator opens the picker.
  useEffect(() => {
    if (!capaPickerOpen || capaOptions.length > 0) return;
    let cancelled = false;
    (async () => {
      const r = await fetch("/api/capas", { credentials: "include" });
      if (!cancelled && r.ok) setCapaOptions((await r.json()) as LinkedCapa[]);
    })();
    return () => { cancelled = true; };
  }, [capaPickerOpen, capaOptions.length]);

  const isClosed = fa?.status === "Closed";

  // Gather the affected batch/lot METRC tags for this field action, then open the
  // destruction dialog with one seeded line per tag. Best-effort — the operator
  // can still scan or add tags manually.
  async function openDestructionForFieldAction() {
    if (!fa) return;
    setGatheringDestruction(true);
    const tags = new Set<string>();
    try {
      const [bRes, lRes] = await Promise.all([
        fetch(`/api/field-actions/${fa.id}/batches`, { credentials: "include" }),
        fetch(`/api/field-actions/${fa.id}/lots`, { credentials: "include" }),
      ]);
      if (bRes.ok) {
        const rows = await bRes.json().catch(() => []);
        for (const row of Array.isArray(rows) ? rows : []) {
          const tag = (row as { batch?: { batchNumber?: string | null } })?.batch?.batchNumber;
          if (tag) tags.add(String(tag));
        }
      }
      if (lRes.ok) {
        const rows = await lRes.json().catch(() => []);
        for (const row of Array.isArray(rows) ? rows : []) {
          const tag = (row as { lot?: { lotNumber?: string | null } })?.lot?.lotNumber;
          if (tag) tags.add(String(tag));
        }
      }
    } catch {
      /* prefill is best-effort */
    }
    setDestructionTags(Array.from(tags));
    setGatheringDestruction(false);
    setDestructionOpen(true);
  }
  // Session 99 (#6) — header accent line = field-action urgency by type
  // (recall→urgent; stop-sale/withdrawal/safety→caution); closed = calm.
  const headerTone = fa ? (isClosed ? "neutral" : toneFieldActionType(fa.actionType)) : "neutral";
  const headerAccent = accentClass(headerTone);
  const currentStep = stepIndex(fa?.status ?? "Initiated");
  const hasScope = !!fa?.scopeDescription?.trim();
  // Structured response actions (Session 13) are the new source of truth; the
  // legacy free-text column is treated as a fallback so historical FAs that
  // were closed pre-Session 13 still satisfy the gate.
  const hasResponse = responseActionsCount > 0 || !!fa?.responseActions?.trim();
  const hasDueDiligence = !!fa?.dueDiligenceNotes?.trim();
  const typeStyle =
    ACTION_TYPE_STYLES[fa?.actionType ?? ""] ??
    ACTION_TYPE_STYLES["Advisory Notice"];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getGetFieldActionQueryKey(id) });

  const fieldValues: Record<EditableFieldKey, string | null | undefined> = {
    affectedBatches: fa?.affectedBatches,
    scopeDescription: fa?.scopeDescription,
    dueDiligenceNotes: fa?.dueDiligenceNotes,
    closureNotes: fa?.closureNotes,
  };

  const startEdit = (field: EditableFieldKey) => {
    setDraft(fieldValues[field] ?? "");
    setEditing(field);
  };

  const saveEdit = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await updateFA.mutateAsync({ id, data: { [editing]: draft } });
      invalidate();
      setEditing(null);
      toast({ title: "Saved", description: "Field updated." });
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

  // Session 63.4 — advanceStatus() removed. The server now refuses a status set
  // through PATCH, because the gate reviews own the status. Left as a note so it
  // is obvious the removal was deliberate and not an accident.

  const handleSign = async (initials: string, meaning: string) => {
    const userId = currentUser?.id ?? 0;
    await closeFA.mutateAsync({
      id,
      data: { initials, signatureMeaning: meaning, userId },
    });
    invalidate();
    toast({
      title: "Field Action Closed",
      description: "Signed and closed per 21 CFR Part 11.",
    });
    setSignatureOpen(false);
  };

  // ── Reusable inline-editable prose field ─────────────────────────────────
  // NOTE: this is a plain render *function*, not a nested component rendered as
  // <EditableProseField/>. A nested component gets a brand-new identity on every
  // parent render, so React unmounts and remounts it on each keystroke — which
  // dropped focus out of the textarea after a single character. Calling it as a
  // function keeps the same DOM node across renders, so typing works normally.
  const renderProseField = ({
    field,
    label,
    placeholder,
    rows = 4,
    required = false,
    mono = false,
    helper,
  }: {
    field: EditableFieldKey;
    label: string;
    placeholder: string;
    rows?: number;
    required?: boolean;
    mono?: boolean;
    helper?: string;
  }) => {
    const value = fieldValues[field];
    const isEditingThis = editing === field;

    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-base">
            {label}
            {required && !value && (
              <span className="ml-2 text-xs font-normal text-destructive">
                required for closure
              </span>
            )}
          </CardTitle>
          {!isClosed && !isEditingThis && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => startEdit(field)}
            >
              {value ? "Edit" : "Add"}
            </Button>
          )}
        </CardHeader>
        <CardContent className="pt-2">
          {helper && (
            <p className="text-xs text-muted-foreground mb-2 leading-relaxed">
              {helper}
            </p>
          )}
          {isEditingThis ? (
            <div className="space-y-2">
              <Textarea
                rows={rows}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={placeholder}
                className={`text-sm ${mono ? "font-mono" : ""}`}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={saveEdit} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : value ? (
            <div
              className={`text-sm bg-muted/30 p-3 rounded-md whitespace-pre-wrap ${mono ? "font-mono" : ""}`}
            >
              {field === "affectedBatches" ? (
                <AffectedBatchLinks text={value} />
              ) : (
                value
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              {isClosed
                ? "None recorded."
                : `No ${label.toLowerCase()} yet.${required ? " Required before closing." : ""}`}
            </p>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <AppLayout>
      <div className="space-y-6 max-w-5xl mx-auto pb-12 print:max-w-none">

        {/* ── Header ── */}
        <div className={headerAccent ? `pl-3 ${headerAccent}` : undefined}>
          <Link
            href="/field-actions"
            className="text-sm text-primary hover:underline mb-2 block print:hidden"
          >
            &larr; Back to Field Actions
          </Link>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                {isLoading ? (
                  <Skeleton className="h-8 w-[150px]" />
                ) : (
                  fa?.faNumber
                )}
              </h1>
              {/* Which plant raised this (2026-08-28). Hidden with a single site. */}
              <SiteBadge facilityId={(fa as { facilityId?: number | null } | undefined)?.facilityId} />
              <div className="text-muted-foreground mt-0.5 text-sm">
                {isLoading ? (
                  <Skeleton className="h-4 w-[300px]" />
                ) : (
                  fa?.title
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
              {fa && (
                <>
                  <span
                    className={`inline-flex items-center px-2.5 py-1 rounded text-xs font-semibold border ${typeStyle.badge}`}
                  >
                    {fa.actionType}
                  </span>
                  <StatusBadge tone={toneFieldActionStatus(fa.status)} label={fa.status} />
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Session 76 — Field Action request approval ── */}
        {fa && isRequested && (
          <div className="rounded-lg border border-violet-300 bg-violet-50 px-4 py-3 print:hidden">
            <div className="flex items-start gap-3">
              <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5 text-violet-600" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm text-violet-900">Field Action request — pending approval</p>
                <p className="text-xs mt-0.5 text-violet-800">
                  Requested by {faApproval?.requestedByName ?? "an operator"}
                  {faApproval?.requestedAt ? ` on ${format(new Date(faApproval.requestedAt), "MMM d, yyyy 'at' h:mm a")}` : ""}.
                  {isApprover
                    ? " Approving opens the Field Action and automatically creates and links its required CAPA."
                    : " A Quality / Manager must approve this before the Field Action is opened."}
                </p>
                {isApprover && (
                  <div className="flex items-center gap-2 mt-3">
                    <Button size="sm" disabled={reviewing} onClick={() => void approveRequest()}>
                      <CheckCircle2 className="h-4 w-4 mr-1" />
                      {reviewing ? "Working…" : "Approve & open FA"}
                    </Button>
                    <Button size="sm" variant="outline" disabled={reviewing} onClick={() => setRejectOpen(true)}>
                      Reject
                    </Button>
                  </div>
                )}
                {isApprover && rejectOpen && (
                  <div className="mt-3 space-y-2 rounded-md border bg-background p-3">
                    <p className="text-xs font-medium">Reason for rejection (required)</p>
                    <Textarea
                      rows={2}
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="e.g. Not a market action — disposition this internally as an NC instead."
                    />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" disabled={reviewing} onClick={() => { setRejectOpen(false); setRejectReason(""); }}>Cancel</Button>
                      <Button size="sm" variant="destructive" disabled={reviewing} onClick={() => void rejectRequest()}>
                        {reviewing ? "Working…" : "Confirm rejection"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Session 76 — rejected request notice ── */}
        {fa && fa.status === "Request Rejected" && (
          <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3">
            <p className="font-semibold text-sm text-red-900">Field Action request rejected</p>
            <p className="text-xs mt-0.5 text-red-800">
              {faApproval?.reviewedByName ? `Rejected by ${faApproval.reviewedByName}` : "Rejected"}
              {faApproval?.reviewedAt ? ` on ${format(new Date(faApproval.reviewedAt), "MMM d, yyyy")}` : ""}.
              {faApproval?.rejectionReason ? ` Reason: ${faApproval.rejectionReason}` : ""}
            </p>
          </div>
        )}

        {/* ── Regulatory urgency banner ── */}
        {fa && !isRequested && fa.status !== "Request Rejected" && (
          <div
            className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${typeStyle.bar}`}
          >
            <ShieldAlert
              className={`h-5 w-5 shrink-0 mt-0.5 ${typeStyle.icon}`}
            />
            <div>
              {(() => {
                const banner = ACTION_TYPE_BANNER[fa.actionType] ?? {
                  headline: `${fa.actionType} — Document all required notifications`,
                  subtext: "Capture every notification, hold, and recovery step under Response Actions; consult the Regulatory tab if guidance is available.",
                };
                return (
                  <>
                    <p className="font-semibold text-sm">{banner.headline}</p>
                    <p className="text-xs mt-0.5 opacity-90">{banner.subtext}</p>
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {/* ── Status stepper ── */}
        {fa && !isPreOpen && (
          <div className="flex items-center print:hidden">
            {STATUS_STEPS.map((step, i) => {
              const done = i < currentStep;
              const active = i === currentStep;
              return (
                <div key={step} className="flex items-center flex-1 min-w-0">
                  <div className="flex flex-col items-center flex-1 min-w-0">
                    <div
                      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 shrink-0 ${
                        done
                          ? "bg-green-500 border-green-500 text-white"
                          : active
                            ? "bg-primary border-primary text-primary-foreground"
                            : "bg-background border-muted-foreground/30 text-muted-foreground"
                      }`}
                    >
                      {done ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : (
                        i + 1
                      )}
                    </div>
                    <span
                      className={`text-xs mt-1 text-center leading-tight max-w-[80px] ${
                        active
                          ? "font-semibold text-foreground"
                          : done
                            ? "text-green-700"
                            : "text-muted-foreground"
                      }`}
                    >
                      {step}
                    </span>
                  </div>
                  {i < STATUS_STEPS.length - 1 && (
                    <div
                      className={`h-0.5 flex-1 mx-1 rounded ${
                        i < currentStep
                          ? "bg-green-400"
                          : "bg-muted-foreground/20"
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Compliance summary bar ── */}
        {fa && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div
              className={`rounded-lg border p-3 text-center ${typeStyle.bar}`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="text-xs font-semibold uppercase tracking-wide">
                  Type
                </span>
              </div>
              <p className="text-sm font-bold">{fa.actionType}</p>
            </div>

            <div
              className={`rounded-lg border p-3 text-center ${
                hasScope
                  ? "bg-green-50 border-green-200 text-green-800"
                  : "bg-red-50 border-red-200 text-red-800"
              }`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                {hasScope ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wide">
                  Scope
                </span>
              </div>
              <p className="text-sm font-bold">
                {hasScope ? "Defined" : "Missing"}
              </p>
            </div>

            <div
              className={`rounded-lg border p-3 text-center ${
                hasResponse
                  ? "bg-green-50 border-green-200 text-green-800"
                  : "bg-red-50 border-red-200 text-red-800"
              }`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                {hasResponse ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wide">
                  Response
                </span>
              </div>
              <p className="text-sm font-bold">
                {hasResponse ? "Documented" : "Missing"}
              </p>
            </div>

            <div
              className={`rounded-lg border p-3 text-center ${
                hasDueDiligence
                  ? "bg-green-50 border-green-200 text-green-800"
                  : "bg-slate-50 border-slate-200 text-slate-600"
              }`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                {hasDueDiligence ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <Clock className="h-3.5 w-3.5" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wide">
                  Due Diligence
                </span>
              </div>
              <p className="text-sm font-bold">
                {hasDueDiligence ? "Done" : "Pending"}
              </p>
            </div>

            <div
              className={`rounded-lg border p-3 text-center ${
                isClosed
                  ? "bg-green-50 border-green-200 text-green-800"
                  : "bg-slate-50 border-slate-200 text-slate-600"
              }`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                {isClosed ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <Clock className="h-3.5 w-3.5" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wide">
                  Closure
                </span>
              </div>
              <p className="text-sm font-bold">
                {isClosed
                  ? fa.closedAt
                    ? format(new Date(fa.closedAt), "MMM d")
                    : "Closed"
                  : "Open"}
              </p>
            </div>
          </div>
        )}

        {/* ── Tabs ── */}
        <Tabs defaultValue="details">
          <TabsList className="print:hidden">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="regulatory">Regulatory</TabsTrigger>
            <TabsTrigger value="audit">Audit Log</TabsTrigger>
          </TabsList>

          {/* ── DETAILS TAB ── */}
          <TabsContent value="details" className="mt-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="md:col-span-2 space-y-6">

                {/* Initiation reason — read-only */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Initiation Reason
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {isLoading ? (
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-[80%]" />
                      </div>
                    ) : (
                      <p className="text-sm bg-muted/30 p-3 rounded-md whitespace-pre-wrap">
                        {fa?.initiationReason}
                      </p>
                    )}
                  </CardContent>
                </Card>

                {fa && !isPreOpen && (
                  <FieldActionGateCard
                    fieldActionId={fa.id}
                    gate={0}
                    title="Gate 0"
                    whatItApproves="Accepts that this field action is warranted and the initiation reason is sound."
                    requiresStatus="Initiated"
                    currentStatus={fa.status}
                    sectionFilled={!!fa.initiationReason?.trim()}
                    sectionLabel="Initiation Reason"
                    approvedAt={faExt?.gate0ApprovedAt}
                    approverName={faExt?.gate0ApproverName}
                    approverInitials={faExt?.gate0ApproverInitials}
                    approverMeaning={faExt?.gate0ApproverMeaning}
                    canSign={canSignGate}
                    rejection={gateRejection}
                    onDone={invalidate}
                  />
                )}

                {fa && (
                  <AffectedBatchesPanel
                    fieldActionId={fa.id}
                    currentUserName={currentUser?.fullName ?? null}
                    faClosed={isClosed}
                  />
                )}

                {fa && (
                  <AffectedLotsPanel
                    fieldActionId={fa.id}
                    faNumber={fa.faNumber}
                    faTitle={fa.title}
                    currentUserName={currentUser?.fullName ?? null}
                    currentUserId={currentUser?.id ?? null}
                    faClosed={fa.status === "Closed"}
                  />
                )}

                {fa && !isClosed && (
                  <div className="rounded-md border border-dashed p-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      Destroying recalled or returned product? Log each affected METRC tag on a destruction record.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={gatheringDestruction}
                      onClick={() => void openDestructionForFieldAction()}
                    >
                      {gatheringDestruction ? "Preparing…" : "Create Destruction Record"}
                    </Button>
                  </div>
                )}

                {renderProseField({
                  field: "scopeDescription",
                  label: "Scope Description",
                  helper:
                    "Define what products must be included in this recall and from where the products are being recalled. Include products affected, metrc numbers, distribution channels (are any in transit?), estimated quantities, and retail stores.",
                  placeholder:
                    "e.g. All Blue Dream 1g pre-rolls from lot BTH-25-0001 (METRC 1A4…0123); distributed to 6 retail stores; ~240 units, none in transit…",
                  rows: 5,
                  required: true,
                })}

                {fa && !isPreOpen && (
                  <FieldActionGateCard
                    fieldActionId={fa.id}
                    gate={1}
                    title="Gate 1"
                    whatItApproves="Approves the scope before anyone is notified — what is covered, where it went, how much."
                    requiresStatus="Scope Defined"
                    currentStatus={fa.status}
                    sectionFilled={!!fa.scopeDescription?.trim()}
                    sectionLabel="Scope Description"
                    approvedAt={faExt?.gate1ApprovedAt}
                    approverName={faExt?.gate1ApproverName}
                    approverInitials={faExt?.gate1ApproverInitials}
                    approverMeaning={faExt?.gate1ApproverMeaning}
                    canSign={canSignGate}
                    rejection={gateRejection}
                    onDone={invalidate}
                  />
                )}

                {fa && (
                  <ResponseActionsPanel
                    fieldActionId={fa.id}
                    faClosed={isClosed}
                    currentUserName={currentUser?.fullName ?? null}
                    legacyResponseActions={fa.responseActions}
                    onCountChange={setResponseActionsCount}
                    onOpenCountChange={setOpenResponseCount}
                    onFieldActionChanged={invalidate}
                  />
                )}

                {renderProseField({
                  field: "dueDiligenceNotes",
                  label: "Due Diligence Notes",
                  helper:
                    "Record how you verified the recall is complete: confirm every affected unit is accounted for (distributed vs. returned vs. destroyed), reconcile those numbers against METRC and the Response Actions above, note the final status of each notified store, and capture any CRA follow-up or acknowledgement.",
                  placeholder:
                    "e.g. All 240 units reconciled — 210 returned, 30 destroyed (manifest DR-2026-0042); METRC holds cleared; CRA acknowledged on 2026-08-04…",
                  rows: 5,
                })}

                {fa && !isPreOpen && (
                  <FieldActionGateCard
                    fieldActionId={fa.id}
                    gate={2}
                    title="Gate 2"
                    whatItApproves="Accepts the due-diligence reconciliation. Until this is signed the field action cannot be closed."
                    requiresStatus="Due Diligence"
                    currentStatus={fa.status}
                    sectionFilled={!!fa.dueDiligenceNotes?.trim()}
                    sectionLabel="Due Diligence Notes"
                    approvedAt={faExt?.gate2ApprovedAt}
                    approverName={faExt?.gate2ApproverName}
                    approverInitials={faExt?.gate2ApproverInitials}
                    approverMeaning={faExt?.gate2ApproverMeaning}
                    canSign={canSignGate}
                    rejection={gateRejection}
                    onDone={invalidate}
                  />
                )}

                {renderProseField({
                  field: "closureNotes",
                  label: "Closure Notes",
                  placeholder:
                    "Summarise the outcome — all product recovered/destroyed, CRA acknowledgement reference numbers, lessons learned, linked CAPA…",
                  rows: 4,
                })}

                {/* Attachments — customer letters, responses, notices, etc. */}
                {fa && (
                  <AttachmentsPanel
                    parentTable="field_actions"
                    parentId={fa.id}
                    allowSupplementary={!isClosed}
                    currentUserId={currentUser?.id}
                    currentUserRole={currentUser?.role}
                    title="Attachments (customer letters, responses, notices)"
                  />
                )}

                {/* Closure signature display */}
                {isClosed && fa?.closedAt && (
                  <Card className="border-green-200 bg-green-50/50">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base text-green-800 flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4" />
                        Electronic Closure Signature (21 CFR Part 11)
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                        <div>
                          <dt className="text-xs font-medium text-muted-foreground">
                            Signed By
                          </dt>
                          <dd className="mt-0.5 font-medium">
                            {fa.closedByName}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs font-medium text-muted-foreground">
                            Initials
                          </dt>
                          <dd className="mt-0.5 font-medium">
                            {fa.closedByInitials}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs font-medium text-muted-foreground">
                            Date &amp; Time
                          </dt>
                          <dd className="mt-0.5 font-medium">
                            {format(
                              new Date(fa.closedAt),
                              "MMM d, yyyy h:mm a"
                            )}
                          </dd>
                        </div>
                      </dl>
                    </CardContent>
                  </Card>
                )}
              </div>

              {/* Right sidebar */}
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Details</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <dl className="space-y-4">
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Action Type
                        </dt>
                        <dd className="mt-1">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${typeStyle.badge}`}
                          >
                            {fa?.actionType}
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Status
                        </dt>
                        <dd className="mt-1">
                          {fa && <StatusBadge tone={toneFieldActionStatus(fa.status)} label={fa.status} />}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Opened
                        </dt>
                        <dd className="mt-1 text-sm">
                          {fa?.createdAt
                            ? format(new Date(fa.createdAt), "MMM d, yyyy")
                            : "—"}
                        </dd>
                      </div>
                      {fa?.closedAt && (
                        <div>
                          <dt className="text-xs font-medium text-muted-foreground">
                            Closed
                          </dt>
                          <dd className="mt-1 text-sm">
                            {format(new Date(fa.closedAt), "MMM d, yyyy")}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </CardContent>
                </Card>

                {/* ── Linked source (Session 13) ── */}
                {(linkedNc || linkedComplaint) && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Linked Source</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {linkedNc && (
                        <Link
                          href={`/non-conformances/${linkedNc.id}`}
                          className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md border bg-muted/30 hover:bg-muted text-sm"
                        >
                          <Badge variant="outline" className="font-mono text-[10px]">NC</Badge>
                          <span className="font-mono">{linkedNc.ncNumber}</span>
                          <span className="truncate text-muted-foreground">{linkedNc.title}</span>
                          <ExternalLink className="h-3 w-3 ml-auto shrink-0" />
                        </Link>
                      )}
                      {linkedComplaint && (
                        <Link
                          href={`/complaints/${linkedComplaint.id}`}
                          className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md border bg-muted/30 hover:bg-muted text-sm"
                        >
                          <Badge variant="outline" className="font-mono text-[10px]">CMP</Badge>
                          <span className="font-mono">{linkedComplaint.complaintNumber}</span>
                          <ExternalLink className="h-3 w-3 ml-auto shrink-0" />
                        </Link>
                      )}
                      <p className="text-[11px] text-muted-foreground mt-2">
                        Initiation reason was seeded from this source's description.
                      </p>
                    </CardContent>
                  </Card>
                )}

                {/* ── Linked CAPA (Session 13) ── */}
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-base">Linked CAPA</CardTitle>
                    {!isClosed && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setCapaPickerValue(linkedCapa ? String(linkedCapa.id) : "");
                          setCapaPickerOpen(true);
                        }}
                      >
                        {linkedCapa ? "Change" : "Link"}
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent>
                    {linkedCapa ? (
                      <Link
                        href={`/capas/${linkedCapa.id}`}
                        className="inline-flex w-full items-center gap-2 px-2.5 py-1.5 rounded-md border bg-muted/30 hover:bg-muted text-sm"
                      >
                        <Badge variant="outline" className="font-mono text-[10px]">CAPA</Badge>
                        <span className="font-mono">{linkedCapa.capaNumber}</span>
                        <span className="truncate text-muted-foreground">{linkedCapa.title}</span>
                        <ExternalLink className="h-3 w-3 ml-auto shrink-0" />
                      </Link>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">
                        {isClosed
                          ? "No CAPA was linked."
                          : "No CAPA linked yet. Open a CAPA for root cause and corrective action, then link it here."}
                      </p>
                    )}
                    {capaPickerOpen && !isClosed && (
                      <div className="mt-3 space-y-2">
                        <Select value={capaPickerValue} onValueChange={setCapaPickerValue}>
                          <SelectTrigger className="h-8 text-sm">
                            <SelectValue placeholder="Select CAPA" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__clear__">— Unlink —</SelectItem>
                            {capaOptions.map((c) => (
                              <SelectItem key={c.id} value={String(c.id)}>
                                {c.capaNumber} — {c.title}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={async () => {
                              const next = capaPickerValue === "__clear__" ? null : capaPickerValue ? parseInt(capaPickerValue) : null;
                              try {
                                // Raw fetch — linkedCapaId is post-orval and
                                // the generated UpdateFieldActionBody type
                                // does not include it.
                                const res = await fetch(`/api/field-actions/${id}`, {
                                  method: "PATCH",
                                  credentials: "include",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ linkedCapaId: next }),
                                });
                                if (!res.ok) throw new Error("PATCH failed");
                                invalidate();
                                setCapaPickerOpen(false);
                                toast({ title: next ? "CAPA linked" : "CAPA unlinked" });
                              } catch {
                                toast({ title: "Failed to update link", variant: "destructive" });
                              }
                            }}
                          >
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setCapaPickerOpen(false)}>Cancel</Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* ── Product context (Session 13) ── */}
                {(faExt?.productType || faExt?.productName || faExt?.lotNumber || faExt?.department) && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Product Context</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <dl className="space-y-3 text-sm">
                        {faExt?.productType && (
                          <div>
                            <dt className="text-xs font-medium text-muted-foreground">Product Type</dt>
                            <dd className="mt-0.5">{faExt.productType}</dd>
                          </div>
                        )}
                        {faExt?.productName && (
                          <div>
                            <dt className="text-xs font-medium text-muted-foreground">Product Name</dt>
                            <dd className="mt-0.5">{faExt.productName}</dd>
                          </div>
                        )}
                        {faExt?.lotNumber && (
                          <div>
                            <dt className="text-xs font-medium text-muted-foreground">Lot Number</dt>
                            <dd className="mt-0.5 font-mono text-xs">{faExt.lotNumber}</dd>
                          </div>
                        )}
                        {faExt?.department && (
                          <div>
                            <dt className="text-xs font-medium text-muted-foreground">Department</dt>
                            <dd className="mt-0.5">{faExt.department}</dd>
                          </div>
                        )}
                      </dl>
                    </CardContent>
                  </Card>
                )}

                {/* Session 63.4 — the "Advance Status" card is gone. The status is
                    moved by the gate reviews on the Details tab and by nothing
                    else; a stage you can walk forward from a dropdown is not a
                    control. This card now only reports where the record is. */}
                {!isClosed && !isPreOpen && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Current Stage</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Current:{" "}
                        <span className="font-medium text-foreground">{fa?.status}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {fa?.status === "Response Active"
                          ? "This moves to Due Diligence on its own once every response action carries a notification date."
                          : "Sign the gate review below the section you have finished to move this forward."}
                      </p>
                    </CardContent>
                  </Card>
                )}

                {/* Closure — hidden until the FA is actually opened (Session 76) */}
                {!isPreOpen && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Gate 3 — Closure</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {isClosed ? (
                      <div className="flex items-center gap-2 text-sm text-green-700">
                        <CheckCircle2 className="h-4 w-4" />
                        <span>
                          Closed{" "}
                          {fa?.closedAt
                            ? format(new Date(fa.closedAt), "MMM d, yyyy")
                            : ""}
                        </span>
                      </div>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground">
                          The final gate. Requires scope definition, at least one
                          response action, every store's product accounted for, a
                          signed Gate 2, and an electronic signature
                          (21 CFR Part 11).
                        </p>
                        <Button
                          className="w-full"
                          disabled={!hasScope || !hasResponse || !faExt?.gate2ApprovedAt || openResponseCount > 0}
                          onClick={() => setSignatureOpen(true)}
                        >
                          Close Field Action
                        </Button>
                        {(!hasScope || !hasResponse || !faExt?.gate2ApprovedAt || openResponseCount > 0) && (
                          <p className="text-xs text-destructive">
                            {!hasScope && "Scope description required. "}
                            {!hasResponse && "At least one response action required. "}
                            {openResponseCount > 0 && `${openResponseCount} store${openResponseCount === 1 ? " has" : "s have"} product still unaccounted for. `}
                            {!faExt?.gate2ApprovedAt && "Gate 2 must be signed first."}
                          </p>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
                )}
              </div>
            </div>
          </TabsContent>

          {/* ── REGULATORY TAB ── */}
          <TabsContent value="regulatory" className="mt-4">
            <div className="space-y-6">

              {(fa?.actionType === "Voluntary Recall" || fa?.actionType === "Recall") && (
                <Card className="border-red-200 bg-red-50/40">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2 text-red-900">
                      <ShieldAlert className="h-4 w-4" />
                      Voluntary Recall — Michigan CRA Requirements (R 420.209)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-red-900 space-y-3">
                    <p>
                      A voluntary recall requires{" "}
                      <strong>immediate notification</strong> to the Michigan
                      Cannabis Regulatory Agency. Do not wait to begin corrective
                      action.
                    </p>
                    <p className="font-semibold text-xs uppercase tracking-wide">
                      Required Steps
                    </p>
                    <ol className="pl-5 list-decimal space-y-2 text-xs">
                      <li>
                        <strong>Notify CRA immediately</strong> — contact the CRA
                        Compliance Division by phone and follow with written notice
                        within 24 hours. Record contact name, date, and reference
                        number in Response Actions.
                      </li>
                      <li>
                        <strong>Quarantine in METRC</strong> — place administrative
                        holds on all affected packages; do not allow further sale
                        or transfer.
                      </li>
                      <li>
                        <strong>Notify all retailers / dispensaries</strong> —
                        contact every licensee that received affected product.
                        Instruct them to quarantine and return. Document each
                        contact with date and name in Response Actions.
                      </li>
                      <li>
                        <strong>Post consumer notice</strong> if directed by CRA —
                        the agency may require a public-facing recall notice.
                      </li>
                      <li>
                        <strong>Reconcile all units</strong> — account for every
                        unit distributed, returned, and destroyed. Record in Due
                        Diligence Notes.
                      </li>
                      <li>
                        <strong>Destruction or remediation</strong> — recalled
                        product must be destroyed under CRA witness or remediated
                        if permitted. Provide destruction manifest numbers in
                        Closure Notes.
                      </li>
                      <li>
                        <strong>Final recall report</strong> — submit a written
                        report to the CRA summarising scope, disposition of all
                        units, and corrective actions. Retain a copy in this record.
                      </li>
                    </ol>
                    <p className="text-xs font-medium border-t border-red-200 pt-2">
                      This system does not submit notices to the CRA. All
                      filings must be made directly through the MRA/METRC portal
                      or by contacting the CRA Compliance Division.
                    </p>
                  </CardContent>
                </Card>
              )}

              {(fa?.actionType === "Regulatory Recall") && (
                <Card className="border-red-300 bg-red-100/40">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2 text-red-950">
                      <ShieldAlert className="h-4 w-4" />
                      Regulatory Recall — CRA-Directed Mandatory Action (R 420.209)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-red-950 space-y-3">
                    <p>
                      A regulatory recall is initiated <strong>at the direction of the
                      Michigan CRA</strong>. Comply fully with every instruction in the
                      CRA directive. Document the directive reference number, date
                      received, and CRA contact in Response Actions on day one.
                    </p>
                    <p className="font-semibold text-xs uppercase tracking-wide">Required Steps</p>
                    <ol className="pl-5 list-decimal space-y-2 text-xs">
                      <li>
                        <strong>Record the CRA directive</strong> — directive ID,
                        issuing officer, date received, deadlines. Attach the directive
                        document to this field action (via the Documents button).
                      </li>
                      <li>
                        <strong>Quarantine in METRC immediately</strong> — place
                        administrative holds on every affected package. No partial
                        compliance; if the directive cites the lot, freeze the lot.
                      </li>
                      <li>
                        <strong>Notify all licensees</strong> — every dispensary /
                        retailer that received affected product. Cite the CRA
                        directive ID in your notice. Record each contact in Response
                        Actions.
                      </li>
                      <li>
                        <strong>Follow CRA-specified destruction or remediation</strong>
                        {" "}— regulatory recalls typically require destruction under
                        CRA witness; retain manifest numbers and witness identifiers in
                        Closure Notes.
                      </li>
                      <li>
                        <strong>Submit progress and final reports per directive</strong>
                        {" "}— file all required CRA reports on time. Retain copies in
                        this record.
                      </li>
                    </ol>
                    <p className="text-xs font-medium border-t border-red-300 pt-2">
                      This system does not submit filings to the CRA. All filings must
                      be made via the MRA/METRC portal or directly to the CRA.
                    </p>
                  </CardContent>
                </Card>
              )}

              {(fa?.actionType === "Stop Sale") && (
                <Card className="border-purple-200 bg-purple-50/40">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2 text-purple-900">
                      <ShieldAlert className="h-4 w-4" />
                      Stop Sale — Immediate Inventory Hold
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-purple-900 space-y-3">
                    <p>
                      A stop sale halts sale at every dispensary holding affected
                      product without (yet) requiring return or destruction. Use this
                      while investigating a suspected non-conformance that may not
                      rise to a recall.
                    </p>
                    <ol className="pl-5 list-decimal space-y-2 text-xs">
                      <li>
                        <strong>Place METRC administrative holds</strong> on every
                        affected package across all retailers.
                      </li>
                      <li>
                        <strong>Notify every retailer immediately</strong> —
                        phone or in-person preferred for speed; follow with written
                        confirmation. Record each contact in Response Actions.
                      </li>
                      <li>
                        <strong>Pause sale; preserve evidence</strong> — instruct
                        retailers not to destroy or return product until the
                        investigation determines disposition.
                      </li>
                      <li>
                        <strong>Investigate and decide</strong> — escalate to
                        Voluntary Recall or Regulatory Recall if a health risk is
                        confirmed; downgrade to Market Withdrawal or release the
                        hold if cleared. Document the disposition decision in Due
                        Diligence Notes.
                      </li>
                      <li>
                        <strong>If escalation occurs</strong>, notify the CRA per
                        the rules applicable to the new action type.
                      </li>
                    </ol>
                    <p className="text-xs font-medium border-t border-purple-200 pt-2">
                      CRA notification is not automatic for a stop sale, but is
                      required if the action is escalated to a recall.
                    </p>
                  </CardContent>
                </Card>
              )}

              {(fa?.actionType === "Market Withdrawal" || fa?.actionType === "Withdrawal") && (
                <Card className="border-orange-200 bg-orange-50/40">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2 text-orange-900">
                      <ShieldAlert className="h-4 w-4" />
                      Market Withdrawal — Michigan CRA Requirements
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-orange-900 space-y-3">
                    <p>
                      A market withdrawal removes product for reasons that do not
                      constitute a recall (e.g. labeling errors, minor
                      non-conformances). CRA notification is required under R
                      420.209 if any consumer health risk exists.
                    </p>
                    <ol className="pl-5 list-decimal space-y-2 text-xs">
                      <li>
                        <strong>Notify CRA within 3 business days</strong> if a
                        health risk is plausible. Record reference number in
                        Response Actions.
                      </li>
                      <li>
                        <strong>Identify all distribution points</strong> — pull
                        METRC transfer records for all affected packages.
                      </li>
                      <li>
                        <strong>Quarantine in METRC</strong> — place holds on all
                        affected packages to prevent further sale.
                      </li>
                      <li>
                        <strong>Reconcile and dispose</strong> — account for all
                        units; remediate or destroy as appropriate and document in
                        Due Diligence Notes.
                      </li>
                    </ol>
                    <p className="text-xs font-medium border-t border-orange-200 pt-2">
                      This system does not submit notices to the CRA.
                    </p>
                  </CardContent>
                </Card>
              )}

              {(fa?.actionType === "Safety Alert" || fa?.actionType === "Advisory Notice") && (
                <Card className="border-yellow-200 bg-yellow-50/40">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2 text-yellow-900">
                      <AlertTriangle className="h-4 w-4" />
                      {fa?.actionType === "Safety Alert" ? "Safety Alert" : "Advisory Notice"} — Customer Notification Requirements
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-yellow-900 space-y-3">
                    <p>
                      An advisory notice informs customers of a potential issue
                      without a full recall. Document all notifications thoroughly.
                    </p>
                    <ol className="pl-5 list-decimal space-y-2 text-xs">
                      <li>
                        <strong>Identify recipients</strong> from METRC transfer
                        records for affected lots.
                      </li>
                      <li>
                        <strong>Issue written notice</strong> describing the concern
                        and recommended action. Document each recipient, date, and
                        method in Response Actions.
                      </li>
                      <li>
                        <strong>Retain confirmations</strong> — email receipts,
                        delivery confirmations, or signed acknowledgements.
                      </li>
                      <li>
                        <strong>Monitor for escalation</strong> — if a safety
                        concern develops, escalate to Withdrawal or Recall and
                        notify CRA immediately.
                      </li>
                    </ol>
                  </CardContent>
                </Card>
              )}

              {fa?.actionType === "Notification Only" && (
                <Card className="border-sky-200 bg-sky-50/40">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2 text-sky-900">
                      <AlertTriangle className="h-4 w-4" />
                      Notification Only — Informational Notice
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-sky-900 space-y-3">
                    <p>
                      The product itself is unaffected. It remains saleable and
                      safe to consume, product already with a licensee is not
                      restricted, and no CRA recall notification is triggered by
                      this action type. Use this to record that every licensee
                      holding the product was told something they need to know —
                      a missing accessory, a packaging correction, revised
                      handling instructions. Stock still on site is a different
                      matter: quarantine it and correct the issue before it
                      ships, and log that under Affected Lots.
                    </p>
                    <ol className="pl-5 list-decimal space-y-2 text-xs">
                      <li>
                        <strong>Identify who is holding it</strong> from the METRC
                        transfer manifests for the affected lots. Not every
                        recipient is a retailer — stock may sit with a distributor
                        or still be in transport.
                      </li>
                      <li>
                        <strong>Issue the notice</strong> stating plainly that the
                        product is not restricted, what the issue is, and what (if
                        anything) the recipient should do.
                      </li>
                      <li>
                        <strong>Record each recipient</strong> with the date and
                        method in Response Actions, and log the reply under Units
                        Returned / Responses Received. A response here is normally
                        an acknowledgement, not returned product.
                      </li>
                      <li>
                        <strong>Escalate if that changes</strong> — if the issue
                        turns out to affect product safety or saleability, change
                        the action type to Stop Sale or a Recall and follow that
                        workflow instead.
                      </li>
                    </ol>
                  </CardContent>
                </Card>
              )}

              {/* METRC checklist — always visible */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    METRC &amp; Documentation Checklist
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2 text-sm">
                    {[
                      "Attach every affected lot in the Affected Lots panel above (and quarantine it in METRC)",
                      "Place administrative holds on affected packages in METRC",
                      "Pull transfer manifests to identify all distribution points",
                      "Record CRA notification date, contact name, and reference number in Response Actions",
                      "Document date and method of each retailer/dispensary notification",
                      "Reconcile total units distributed vs. returned/destroyed in Due Diligence Notes",
                      "Retain destruction manifests; enter reference numbers in Closure Notes",
                      "Create a linked Non-Conformance or CAPA for root cause corrective action",
                    ].map((item, i) => (
                      <li key={i} className="flex items-start gap-2.5">
                        <div className="h-5 w-5 rounded border border-muted-foreground/30 shrink-0 mt-0.5 flex items-center justify-center">
                          <span className="text-xs text-muted-foreground">
                            {i + 1}
                          </span>
                        </div>
                        <span className="text-muted-foreground">{item}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
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
                          {/* Was: Object.keys(afterState) — the field NAMES only,
                              and since the whole row is stored that listed every
                              column on every save. Shared renderer shows the
                              values that actually changed. */}
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
        onOpenChange={setSignatureOpen}
        title="Close Field Action"
        description="By signing, you confirm all affected product has been accounted for, all required Michigan CRA notifications have been made and documented, and this field action is fully resolved. This action is irreversible (21 CFR Part 11)."
        onSign={handleSign}
        isPending={closeFA.isPending}
      />

      <CreateDestructionRecordDialog
        open={destructionOpen}
        onOpenChange={setDestructionOpen}
        initialTags={destructionTags}
        noticeText="Recall or administrative-hold product must have CRA approval before destruction — notify CRA-Info@michigan.gov first (CRA Best Practice Guide). Each destroyed package must be logged with its full METRC tag."
        onCreated={() => { setDestructionOpen(false); toast({ title: "Destruction record created" }); }}
      />
    </AppLayout>
  );
}
