import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { SiteBadge } from "@/components/FacilitySite";
import {
  useGetComplaint,
  useUpdateComplaint,
  useListAuditLog,
  useGetCurrentUser,
  useGetBatchRecord,
  useListUsers,
  getGetComplaintQueryKey,
} from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { accentClass, toneComplaintSeverity, toneComplaintStatus } from "@/lib/status";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "wouter";
import { format, differenceInCalendarDays, parseISO } from "date-fns";
import { cn, formatDateOnly } from "@/lib/utils";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { CancelRecordDialog } from "@/components/dialogs/CancelRecordDialog";
import { CreateDestructionRecordDialog } from "@/components/dialogs/CreateDestructionRecordDialog";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { CandidateBatchesCard } from "@/components/complaints/CandidateBatchesCard";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { AuditDiff } from "@/components/audit/AuditDiff";
import {
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  Clock,
  ShieldAlert,
  FileText,
  Printer,
  ExternalLink,
  Ban,
  RotateCcw,
  Trash2,
} from "lucide-react";

// Roles permitted to Cancel (mirror server CANCEL_ROLES). Re-open is Admin-only.
const CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);

function requiresCraNotification(
  complaintType?: string,
  severity?: string,
  craReportable?: boolean
): boolean {
  return (
    craReportable === true ||
    complaintType === "Adverse Event" ||
    severity === "Critical" ||
    severity === "High"
  );
}

const STATUS_ORDER = [
  "Open",
  "Under Investigation",
  "Pending Corrections",
  "Closed - CAPA Created",
  "Closed",
];

// Session 101 (#2) — same categories as Non-Conformances, so complaint
// root-cause data trends alongside NC/CAPA metrics.
const ROOT_CAUSE_OPTIONS = [
  "Operator Error",
  "Procedure / SOP Gap",
  "Training Gap",
  "Equipment Failure",
  "Material / Supplier Issue",
  "Environmental Conditions",
  "Specification Error",
  "Documentation Error",
  "Sanitation",
  "Other",
];

function severityColor(severity?: string) {
  if (severity === "Critical") return "bg-red-50 border-red-200 text-red-800";
  if (severity === "High") return "bg-orange-50 border-orange-200 text-orange-800";
  if (severity === "Medium") return "bg-yellow-50 border-yellow-200 text-yellow-800";
  return "bg-slate-50 border-slate-200 text-slate-700";
}

export default function ComplaintDetail(props: { params?: { id: string } }) {
  const id = parseInt(props.params?.id ?? "0");
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: complaint, isLoading } = useGetComplaint(id);
  const { data: currentUser } = useGetCurrentUser();
  const { data: auditLog = [] } = useListAuditLog({
    tableName: "complaints",
    rowId: id,
    limit: 50,
  });
  const { data: linkedBatch } = useGetBatchRecord(complaint?.batchId ?? 0);

  const updateComplaint = useUpdateComplaint();

  const [signatureOpen, setSignatureOpen] = useState(false);

  const [editingInvestigation, setEditingInvestigation] = useState(false);
  const [investigationDraft, setInvestigationDraft] = useState("");
  const [savingInvestigation, setSavingInvestigation] = useState(false);

  const [noActionDraft, setNoActionDraft] = useState("");
  const [savingNoAction, setSavingNoAction] = useState(false);
  const [rootCausesDraft, setRootCausesDraft] = useState<string[]>([]);
  const [savingRootCauses, setSavingRootCauses] = useState(false);

  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [creatingNC, setCreatingNC] = useState(false);
  // Session 62 — corrections are assignable TASKS now (mirrors nc_corrections):
  // description + owner + due date, completed later with what was done and when.
  const [corrections, setCorrections] = useState<Array<{
    id: number; description: string; performedOn: string | null; performedByName: string | null;
    notes: string | null; createdAt: string;
    dueDate: string | null; taskOwnerName: string | null; taskOwnerUserId: number | null;
    completed: boolean; completedByName: string | null;
  }>>([]);
  const [correctionsRefresh, setCorrectionsRefresh] = useState(0);
  const [newCorrection, setNewCorrection] = useState("");
  // Renamed from newCorrectionDate: this is now the DUE date of a task, not the
  // date something was performed — which is why it is no longer capped at today.
  const [newCorrectionDue, setNewCorrectionDue] = useState("");
  // Session 62.1 — the owner is a real employee, picked from the user list the NC
  // correction panel already uses, rather than a typed name that can never be
  // matched back to a person. Held as the user id (a string, for the Select).
  const [newCorrectionOwnerId, setNewCorrectionOwnerId] = useState("");
  const [addingCorrection, setAddingCorrection] = useState(false);
  // Per-task completion drafts, keyed by correction id.
  const [completeDraft, setCompleteDraft] = useState<Record<number, { notes: string; performedOn: string }>>({});
  const [completingId, setCompletingId] = useState<number | null>(null);
  const { data: usersData = [] } = useListUsers();
  const correctionOwner = newCorrectionOwnerId
    ? usersData.find((u) => String(u.id) === newCorrectionOwnerId) ?? null
    : null;
  const [destructionOpen, setDestructionOpen] = useState(false);

  // Session 52.1 — Cancel / Re-open (Part 11). Cancel = soft, recoverable,
  // e-signed (no hard delete). Re-open is Admin-only.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [uncancelOpen, setUncancelOpen] = useState(false);
  const [uncancelPending, setUncancelPending] = useState(false);

  const isClosed = complaint?.status === "Closed" || complaint?.status === "Closed - CAPA Created";
  const isCancelled = !!(complaint as { cancelledAt?: string | null } | undefined)?.cancelledAt;
  // Session 98 (#6) — header accent line = the complaint's urgency (open
  // severity; closed reads calm/neutral), matching the list-row language.
  const headerTone = complaint ? (isClosed ? "neutral" : toneComplaintSeverity(complaint.severity)) : "neutral";
  const headerAccent = accentClass(headerTone);
  // Session 75 — the internal NC linked to this complaint (if any).
  const linkedCapa = (complaint as unknown as { linkedCapa?: { id: number; capaNumber: string; title: string | null; stage: string | null } | null } | undefined)?.linkedCapa ?? null;
  const linkedCapaId = linkedCapa?.id ?? (complaint as { capaId?: number | null } | undefined)?.capaId ?? null;
  const canCancel = !!currentUser?.role && CANCEL_ROLES.has(currentUser.role);
  // Re-open is Admin-only (Session 52 decision), narrower than Cancel.
  const canReopen = currentUser?.role === "Admin";
  const hasInvestigation = !!complaint?.investigation?.trim();
  // Escalated-to-CAPA complaints track the investigation and corrective
  // actions in the CAPA, so closing here no longer requires the complaint's
  // own notes/resolution — only the Part 11 signature.
  const noActionRequired = !!(complaint as { noActionRequired?: boolean | null } | undefined)?.noActionRequired;
  const noActionRationale = (complaint as { noActionRationale?: string | null } | undefined)?.noActionRationale ?? "";
  const hasCorrection = corrections.length > 0;
  const hasDisposition = hasCorrection || !!linkedCapaId || (noActionRequired && !!noActionRationale.trim());
  // Session 62.3 — corrections are assignable tasks now, so HAVING one is no
  // longer enough to close: every one has to be finished. The server refuses the
  // close either way; mirroring the rule here means the operator finds out before
  // signing rather than after, which is what the NC page already does.
  const openCorrections = corrections.filter((c) => !c.completed).length;
  const canClose = hasInvestigation && hasDisposition && openCorrections === 0;
  const needsCra = requiresCraNotification(
    complaint?.complaintType,
    complaint?.severity,
    (complaint as { craReportable?: boolean } | undefined)?.craReportable
  );

  const daysOpen = complaint
    ? isClosed && complaint.closedAt
      ? differenceInCalendarDays(new Date(complaint.closedAt), parseISO(complaint.receivedDate))
      : differenceInCalendarDays(new Date(), parseISO(complaint.receivedDate))
    : 0;
  const deadlineLimit =
    complaint?.complaintType === "Adverse Event" || complaint?.severity === "Critical"
      ? 3
      : complaint?.severity === "High"
        ? 30
        : 90;
  const isPastDeadline = !isClosed && daysOpen > deadlineLimit;
  const isNearDeadline = !isClosed && !isPastDeadline && daysOpen >= deadlineLimit - 2;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getGetComplaintQueryKey(id) });

  // ── Session 52.1 — Cancel / Re-open (off-spec endpoints; raw fetch) ──────────
  // Throw on failure so the dialogs surface the server message inline.
  const handleCancel = async (reason: string, initials: string, meaning: string) => {
    setCancelPending(true);
    try {
      const r = await fetch(`/api/complaints/${id}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, initials, signatureMeaning: meaning }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to cancel complaint.");
      }
      invalidate();
      toast({ title: "Complaint cancelled", description: "Retained and recoverable; removed from active use." });
    } finally {
      setCancelPending(false);
    }
  };

  const handleUncancel = async (initials: string, meaning: string) => {
    setUncancelPending(true);
    try {
      const r = await fetch(`/api/complaints/${id}/uncancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initials, signatureMeaning: meaning }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to re-open complaint.");
      }
      invalidate();
      toast({ title: "Complaint re-opened", description: "Record returned to active use." });
    } finally {
      setUncancelPending(false);
    }
  };

  const saveInvestigation = async () => {
    setSavingInvestigation(true);
    try {
      await updateComplaint.mutateAsync({
        id,
        data: { investigation: investigationDraft },
      });
      invalidate();
      setEditingInvestigation(false);
      toast({ title: "Saved", description: "Investigation notes updated." });
    } catch {
      toast({ title: "Error", description: "Failed to save.", variant: "destructive" });
    } finally {
      setSavingInvestigation(false);
    }
  };

  const saveRootCauses = async (next: string[]) => {
    setSavingRootCauses(true);
    setRootCausesDraft(next);
    try {
      const r = await fetch(`/api/complaints/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootCauses: next }),
      });
      if (!r.ok) throw new Error("save failed");
      invalidate();
    } catch {
      toast({ title: "Error", description: "Failed to save root causes.", variant: "destructive" });
    } finally {
      setSavingRootCauses(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch(`/api/complaints/${id}/corrections`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => { if (!cancelled) setCorrections(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setCorrections([]); });
    return () => { cancelled = true; };
  }, [id, correctionsRefresh]);

  // Session 62 — completing a task records what was done and the date it happened,
  // and is owner-only on the server. performedOn IS capped at today: unlike a due
  // date, you cannot have performed something in the future.
  const completeCorrection = async (correctionId: number) => {
    const draft = completeDraft[correctionId];
    if (!draft?.notes.trim() || !draft?.performedOn) return;
    setCompletingId(correctionId);
    try {
      const res = await fetch(`/api/complaint-corrections/${correctionId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ notes: draft.notes.trim(), performedOn: draft.performedOn }),
      });
      if (!res.ok) {
        const msg = await res.json().then((b) => (b?.error as string) || "").catch(() => "");
        toast({ title: "Could not complete", description: msg || undefined, variant: "destructive" });
        return;
      }
      setCompleteDraft((d) => { const next = { ...d }; delete next[correctionId]; return next; });
      setCorrectionsRefresh((n) => n + 1);
      toast({ title: "Correction completed" });
    } catch {
      toast({ title: "Could not complete", variant: "destructive" });
    } finally {
      setCompletingId(null);
    }
  };

  const takeCorrection = async (correctionId: number) => {
    try {
      const res = await fetch(`/api/complaint-corrections/${correctionId}/reassign-to-me`, {
        method: "POST", credentials: "include",
      });
      if (!res.ok) {
        const msg = await res.json().then((b) => (b?.error as string) || "").catch(() => "");
        toast({ title: "Could not reassign", description: msg || undefined, variant: "destructive" });
        return;
      }
      setCorrectionsRefresh((n) => n + 1);
      toast({ title: "Assigned to you" });
    } catch {
      toast({ title: "Could not reassign", variant: "destructive" });
    }
  };

  const addCorrection = async () => {
    if (!newCorrection.trim()) return;
    setAddingCorrection(true);
    try {
      const r = await fetch(`/api/complaints/${id}/corrections`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: newCorrection.trim(),
          dueDate: newCorrectionDue || undefined,
          taskOwnerName: correctionOwner?.fullName ?? undefined,
          taskOwnerUserId: correctionOwner?.id ?? undefined,
        }),
      });
      if (!r.ok) throw new Error("failed");
      setNewCorrection("");
      setNewCorrectionDue("");
      setNewCorrectionOwnerId("");
      setCorrectionsRefresh((n) => n + 1);
      toast({ title: "Correction assigned" });
    } catch {
      toast({ title: "Error", description: "Failed to log correction.", variant: "destructive" });
    } finally {
      setAddingCorrection(false);
    }
  };

  useEffect(() => {
    setNoActionDraft((complaint as { noActionRationale?: string | null } | undefined)?.noActionRationale ?? "");
  }, [complaint?.id]);

  const saveNoAction = async (required: boolean, rationale: string) => {
    setSavingNoAction(true);
    try {
      const r = await fetch(`/api/complaints/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noActionRequired: required, noActionRationale: required ? rationale : null }),
      });
      if (!r.ok) throw new Error("save failed");
      invalidate();
    } catch {
      toast({ title: "Error", description: "Failed to save.", variant: "destructive" });
    } finally {
      setSavingNoAction(false);
    }
  };

  const updateStatus = async (status: string) => {
    setUpdatingStatus(true);
    try {
      await updateComplaint.mutateAsync({ id, data: { status } });
      invalidate();
      toast({ title: "Status updated", description: `Moved to "${status}".` });
    } catch {
      toast({ title: "Error", description: "Failed to update status.", variant: "destructive" });
    } finally {
      setUpdatingStatus(false);
    }
  };

  const handleSign = async (initials: string, meaning: string) => {
    const signer = currentUser
      ? currentUser.fullName || currentUser.email
      : initials;
    const sigNote = `[Closed ${format(new Date(), "MMM d, yyyy HH:mm")} by ${signer} (${initials}): ${meaning}]`;
    try {
      await updateComplaint.mutateAsync({
        id,
        data: {
          status: linkedCapaId ? "Closed - CAPA Created" : "Closed",
          closedAt: new Date().toISOString(),
          resolution: complaint?.resolution
            ? `${complaint.resolution}\n\n${sigNote}`
            : sigNote,
        },
      });
    } catch (err) {
      // Session 62.2 — closing can now be refused (open corrections), and the
      // server says exactly why. Without this the signature dialog swallowed the
      // message and the operator saw a close that simply didn't happen.
      const msg = err instanceof Error ? err.message : "";
      toast({
        title: "Could not close complaint",
        description: msg || "The complaint could not be closed.",
        variant: "destructive",
      });
      throw err;
    }
    invalidate();
    toast({ title: "Complaint Closed", description: "Signed and closed." });
    setSignatureOpen(false);
  };

  // Session 101 — escalate this complaint DIRECTLY to a CAPA (no NC first) and
  // link it back (complaints.capa_id). The complaint moves to "Pending
  // Corrections"; the CAPA carries the root-cause investigation + CAPAs.
  const escalateToCapa = async () => {
    if (!complaint) return;
    setCreatingNC(true);
    try {
      const res = await fetch(`/api/complaints/${id}/promote-to-capa`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to escalate to CAPA.");
      }
      const capa = await res.json();
      toast({
        title: "CAPA Created",
        description: `${capa.capaNumber} created and linked to this complaint.`,
      });
      navigate(`/capas/${capa.id}`);
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed to escalate to CAPA.", variant: "destructive" });
    } finally {
      setCreatingNC(false);
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6 max-w-5xl mx-auto pb-12 print:max-w-none">

        {/* Header */}
        <div className={headerAccent ? `pl-3 ${headerAccent}` : undefined}>
          <Link
            href="/complaints"
            className="text-sm text-primary hover:underline mb-2 block print:hidden"
          >
            &larr; Back to Complaints
          </Link>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                {isLoading ? (
                  <Skeleton className="h-8 w-[160px]" />
                ) : (
                  complaint?.complaintNumber
                )}
              </h1>
              {/* Which plant raised this (2026-08-28). Hidden with a single site. */}
              <SiteBadge facilityId={(complaint as { facilityId?: number | null } | undefined)?.facilityId} />
              <div className="text-muted-foreground mt-0.5 text-sm">
                {isLoading ? (
                  <Skeleton className="h-4 w-[200px]" />
                ) : (
                  complaint?.complaintType
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 print:hidden">
              {complaint && !isClosed && !isCancelled && canCancel && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCancelOpen(true)}
                  className="gap-1.5 text-destructive hover:text-destructive"
                  data-testid="button-cancel-complaint"
                >
                  <Ban className="h-4 w-4" />
                  Cancel
                </Button>
              )}
              {complaint && isCancelled && canReopen && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setUncancelOpen(true)}
                  disabled={uncancelPending}
                  className="gap-1.5"
                  data-testid="button-reopen-complaint"
                >
                  <RotateCcw className="h-4 w-4" />
                  Re-open
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => window.print()}>
                <Printer className="h-4 w-4 mr-1" />
                Print
              </Button>
              {complaint && <StatusBadge tone={toneComplaintStatus(complaint.status)} label={complaint.status} />}
            </div>
          </div>
        </div>

        {/* Session 52.1 — Cancelled banner (Part 11 record of who/why). */}
        {isCancelled && complaint && (
          <div className="rounded-lg border-2 border-red-200 bg-red-50 px-4 py-3 print:hidden" data-testid="banner-complaint-cancelled">
            <p className="text-sm font-semibold text-red-900 flex items-center gap-2">
              <Ban className="h-4 w-4" /> This complaint has been cancelled
            </p>
            <p className="text-xs text-red-800 mt-1">
              {(complaint as { cancelledByName?: string | null }).cancelledByName}
              {(complaint as { cancelledByInitials?: string | null }).cancelledByInitials ? ` (${(complaint as { cancelledByInitials?: string | null }).cancelledByInitials})` : ""}
              {(complaint as { cancelledAt?: string | null }).cancelledAt ? ` · ${format(new Date((complaint as { cancelledAt?: string | null }).cancelledAt as string), "MMM d, yyyy h:mm a")}` : ""}
            </p>
            {(complaint as { cancelledReason?: string | null }).cancelledReason && (
              <p className="text-sm text-red-900 mt-1.5 whitespace-pre-wrap">
                <span className="font-medium">Reason:</span> {(complaint as { cancelledReason?: string | null }).cancelledReason}
              </p>
            )}
            <p className="text-[11px] text-red-700 mt-1 italic">Retained for compliance; can be re-opened by an Admin only.</p>
          </div>
        )}

        {/* 30-day / 3-day deadline warning banner */}
        {complaint && !isClosed && (isPastDeadline || isNearDeadline) && (
          <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${isPastDeadline ? "border-red-300 bg-red-50 text-red-900" : "border-yellow-300 bg-yellow-50 text-yellow-900"}`}>
            <AlertTriangle className={`h-5 w-5 shrink-0 mt-0.5 ${isPastDeadline ? "text-red-600" : "text-yellow-600"}`} />
            <div>
              <p className="font-semibold text-sm">
                {isPastDeadline
                  ? `Response deadline exceeded — ${daysOpen} days open (limit: ${deadlineLimit} days)`
                  : `Response deadline approaching — ${daysOpen} of ${deadlineLimit} days elapsed`}
              </p>
              <p className="text-xs mt-0.5">
                {complaint.complaintType === "Adverse Event" || complaint.severity === "Critical"
                  ? "Internal response target. If this is an adverse reaction, notify the CRA and log it in METRC within 1 business day (R 420.214b)."
                  : "Ensure investigation is documented and regulatory obligations are met."}
              </p>
            </div>
          </div>
        )}

        {/* Michigan CRA banner */}
        {complaint && needsCra && !isPastDeadline && !isNearDeadline && (
          <div className="flex items-start gap-3 rounded-lg border border-orange-300 bg-orange-50 px-4 py-3 text-orange-900">
            <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5 text-orange-600" />
            <div>
              <p className="font-semibold text-sm">
                Michigan CRA Regulatory Notification May Be Required
              </p>
              <p className="text-xs mt-0.5 text-orange-800">
                {complaint.complaintType === "Adverse Event"
                  ? "Adverse reactions must be reported to the Michigan CRA within 1 business day and logged in METRC (R 420.214b)."
                  : "Critical/High severity complaints may require CRA notification depending on scope and product impact."}
                {" "}Document all regulatory communications in the investigation notes.
              </p>
            </div>
          </div>
        )}

        {/* Compliance summary bar */}
        {complaint && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className={`rounded-lg border p-3 text-center ${severityColor(complaint.severity)}`}>
              <div className="flex items-center justify-center gap-1 mb-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="text-xs font-semibold uppercase tracking-wide">Severity</span>
              </div>
              <p className="text-sm font-bold">{complaint.severity}</p>
            </div>

            <div className={`rounded-lg border p-3 text-center ${hasInvestigation ? "bg-green-50 border-green-200 text-green-800" : linkedCapaId ? "bg-blue-50 border-blue-200 text-blue-800" : "bg-red-50 border-red-200 text-red-800"}`}>
              <div className="flex items-center justify-center gap-1 mb-1">
                {hasInvestigation || linkedCapaId ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
                <span className="text-xs font-semibold uppercase tracking-wide">Investigation</span>
              </div>
              <p className="text-sm font-bold">{hasInvestigation ? "Documented" : linkedCapaId ? "In CAPA" : "Missing"}</p>
            </div>

            <div className={`rounded-lg border p-3 text-center ${hasDisposition ? (linkedCapaId ? "bg-blue-50 border-blue-200 text-blue-800" : "bg-green-50 border-green-200 text-green-800") : "bg-red-50 border-red-200 text-red-800"}`}>
              <div className="flex items-center justify-center gap-1 mb-1">
                {hasDisposition ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
                <span className="text-xs font-semibold uppercase tracking-wide">Disposition</span>
              </div>
              <p className="text-sm font-bold">{linkedCapaId ? "In CAPA" : hasCorrection ? "Corrected" : noActionRequired ? "No action" : "Missing"}</p>
            </div>

            <div className={`rounded-lg border p-3 text-center ${needsCra ? "bg-orange-50 border-orange-200 text-orange-800" : "bg-slate-50 border-slate-200 text-slate-600"}`}>
              <div className="flex items-center justify-center gap-1 mb-1">
                <ShieldAlert className="h-3.5 w-3.5" />
                <span className="text-xs font-semibold uppercase tracking-wide">Regulatory</span>
              </div>
              <p className="text-sm font-bold">{needsCra ? "CRA Review" : "N/A"}</p>
            </div>

            <div className={`rounded-lg border p-3 text-center ${isClosed ? "bg-green-50 border-green-200 text-green-800" : "bg-slate-50 border-slate-200 text-slate-600"}`}>
              <div className="flex items-center justify-center gap-1 mb-1">
                {isClosed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
                <span className="text-xs font-semibold uppercase tracking-wide">Closure</span>
              </div>
              <p className="text-sm font-bold">
                {isClosed
                  ? complaint.closedAt
                    ? format(new Date(complaint.closedAt), "MMM d")
                    : "Closed"
                  : "Open"}
              </p>
            </div>
          </div>
        )}

        {/* Tabs */}
        <Tabs defaultValue="details">
          <TabsList className="print:hidden">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="actions">Actions</TabsTrigger>
            <TabsTrigger value="audit">Audit Log</TabsTrigger>
          </TabsList>

          {/* DETAILS TAB */}
          <TabsContent value="details" className="mt-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="md:col-span-2 space-y-6">

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Description</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {isLoading ? (
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-[80%]" />
                        <Skeleton className="h-4 w-[60%]" />
                      </div>
                    ) : (
                      <p className="text-sm bg-muted/30 p-3 rounded-md whitespace-pre-wrap">
                        {complaint?.description}
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* Investigation — inline editable */}
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-base">Investigation Notes</CardTitle>
                    {!isClosed && !isCancelled && !editingInvestigation && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setInvestigationDraft(complaint?.investigation ?? "");
                          setEditingInvestigation(true);
                        }}
                      >
                        {complaint?.investigation ? "Edit" : "Add Notes"}
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent className="pt-2">
                    {editingInvestigation ? (
                      <div className="space-y-2">
                        <Textarea
                          rows={6}
                          value={investigationDraft}
                          onChange={(e) => setInvestigationDraft(e.target.value)}
                          placeholder="Document findings, root cause analysis, CRA notification details, dates contacted…"
                          className="text-sm"
                        />
                        <div className="flex gap-2">
                          <Button size="sm" onClick={saveInvestigation} disabled={savingInvestigation}>
                            {savingInvestigation ? "Saving…" : "Save"}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingInvestigation(false)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : complaint?.investigation ? (
                      <p className="text-sm bg-muted/30 p-3 rounded-md whitespace-pre-wrap">
                        {complaint.investigation}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">
                        No investigation notes yet.
                        {needsCra && (
                          <span className="text-orange-700 ml-1 not-italic font-medium">
                            Required — CRA notification may apply.
                          </span>
                        )}
                      </p>
                    )}
                    {/* Structured root-cause categories (Session 101 #2) */}
                    {(() => {
                      const current = ((complaint as unknown as { rootCauses?: string[] | null })?.rootCauses ?? rootCausesDraft) ?? [];
                      const toggle = (label: string) => {
                        const next = current.includes(label) ? current.filter((x: string) => x !== label) : [...current, label];
                        void saveRootCauses(next);
                      };
                      return (
                        <div className="mt-3 pt-3 border-t">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                            Root Cause Categories (for metrics)
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {ROOT_CAUSE_OPTIONS.map((opt) => {
                              const active = current.includes(opt);
                              return (
                                <button
                                  key={opt}
                                  type="button"
                                  disabled={isClosed || isCancelled || savingRootCauses}
                                  onClick={() => toggle(opt)}
                                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                                    active
                                      ? "bg-primary text-primary-foreground border-primary"
                                      : "bg-background hover:bg-muted text-foreground border-border"
                                  } disabled:opacity-60 disabled:cursor-not-allowed`}
                                >
                                  {opt}
                                </button>
                              );
                            })}
                          </div>
                          {current.length === 0 && (
                            <p className="text-xs text-muted-foreground italic mt-2">
                              Pick one or more categories to support dashboards and trending.
                            </p>
                          )}
                        </div>
                      );
                    })()}
                  </CardContent>
                </Card>

                {/* Corrections (Session 101 #3) — immediate containment actions */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Corrections</CardTitle>
                    <p className="text-xs text-muted-foreground">
                      Immediate containment actions taken for this complaint. For a full root-cause investigation and corrective/preventive actions, use Escalate to CAPA.
                    </p>
                  </CardHeader>
                  <CardContent className="pt-2 space-y-3">
                    {/* No corrections or containment actions required (Session 101) */}
                    <div className="rounded-md border bg-muted/30 p-2.5 space-y-2">
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={noActionRequired}
                          disabled={isClosed || isCancelled || savingNoAction}
                          onChange={(e) => { const on = e.target.checked; void saveNoAction(on, on ? noActionDraft : ""); }}
                        />
                        <span className="text-sm font-medium">No corrections or containment actions required</span>
                      </label>
                      {noActionRequired && (
                        <div className="space-y-2">
                          <Textarea
                            rows={2}
                            value={noActionDraft}
                            onChange={(e) => setNoActionDraft(e.target.value)}
                            disabled={isClosed || isCancelled}
                            placeholder="Why no corrective action is needed — e.g. 'KPI metrics reviewed; process confirmed in control; isolated event.'"
                            className="text-sm"
                          />
                          {!isClosed && !isCancelled && (
                            <Button size="sm" variant="outline" disabled={savingNoAction || !noActionDraft.trim()} onClick={() => void saveNoAction(true, noActionDraft)}>
                              {savingNoAction ? "Saving…" : "Save rationale"}
                            </Button>
                          )}
                          {!noActionRationale.trim() && (
                            <p className="text-xs text-destructive">A rationale is required before closing.</p>
                          )}
                        </div>
                      )}
                    </div>
                    {corrections.length === 0 ? (
                      <p className="text-sm text-muted-foreground italic">No corrections assigned yet.</p>
                    ) : (
                      <ul className="space-y-2">
                        {corrections.map((c) => {
                          const draft = completeDraft[c.id] ?? { notes: "", performedOn: "" };
                          const overdue = !c.completed && !!c.dueDate && c.dueDate < new Date().toLocaleDateString("en-CA");
                          return (
                            <li key={c.id} className="rounded border bg-muted/30 p-2.5 text-sm">
                              <div className="flex items-start justify-between gap-2">
                                <p className="whitespace-pre-wrap">{c.description}</p>
                                <span className={cn(
                                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                                  c.completed ? "bg-green-100 text-green-800"
                                    : overdue ? "bg-destructive/10 text-destructive"
                                    : "bg-amber-100 text-amber-800",
                                )}>
                                  {c.completed ? "Done" : overdue ? "Overdue" : "Open"}
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground mt-1">
                                {c.taskOwnerName ? `Owner: ${c.taskOwnerName}` : "Unassigned"}
                                {c.dueDate ? ` · due ${formatDateOnly(c.dueDate)}` : ""}
                                {c.completed && c.performedOn ? ` · performed ${formatDateOnly(c.performedOn)}` : ""}
                                {c.completed && c.completedByName ? ` · completed by ${c.completedByName}` : ""}
                              </p>
                              {c.completed && c.notes && (
                                <p className="mt-1 text-xs whitespace-pre-wrap">{c.notes}</p>
                              )}
                              {!c.completed && !isClosed && !isCancelled && (
                                <div className="mt-2 space-y-2 border-t pt-2">
                                  <Textarea
                                    rows={2}
                                    value={draft.notes}
                                    onChange={(e) => setCompleteDraft((d) => ({ ...d, [c.id]: { ...draft, notes: e.target.value } }))}
                                    placeholder="What was actually done…"
                                    className="text-sm"
                                  />
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Input
                                      type="date"
                                      value={draft.performedOn}
                                      onChange={(e) => setCompleteDraft((d) => ({ ...d, [c.id]: { ...draft, performedOn: e.target.value } }))}
                                      className="h-8 w-auto text-sm"
                                      /* Capped at today: a due date may be in the
                                         future, but work cannot have been performed there. */
                                      max={new Date().toLocaleDateString("en-CA")}
                                    />
                                    <Button
                                      size="sm"
                                      disabled={completingId === c.id || !draft.notes.trim() || !draft.performedOn}
                                      onClick={() => void completeCorrection(c.id)}
                                    >
                                      {completingId === c.id ? "Completing…" : "Mark complete"}
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => void takeCorrection(c.id)}>
                                      Assign to me
                                    </Button>
                                  </div>
                                  <p className="text-[11px] text-muted-foreground">
                                    Only the assigned owner can complete a task — use "Assign to me" to take it over.
                                  </p>
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {!isClosed && !isCancelled && (
                      <div className="space-y-2 border-t pt-3">
                        <Textarea
                          rows={2}
                          value={newCorrection}
                          onChange={(e) => setNewCorrection(e.target.value)}
                          placeholder="Describe the correction to be taken (e.g. 'Quarantine remaining stock of the lot; notify dispensary')…"
                          className="text-sm"
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <Select value={newCorrectionOwnerId} onValueChange={setNewCorrectionOwnerId}>
                            <SelectTrigger className="h-9 w-52 text-sm" data-testid="select-complaint-correction-owner">
                              <SelectValue placeholder="Owner…" />
                            </SelectTrigger>
                            <SelectContent>
                              {/* Inactive users are filtered out, except one already
                                  selected, so an existing pick can never blank itself. */}
                              {usersData.filter((u) => u.active || String(u.id) === newCorrectionOwnerId).map((u) => (
                                <SelectItem key={u.id} value={String(u.id)}>
                                  {u.fullName}{u.role ? ` · ${u.role}` : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {/* Session 62 — this is a DUE date now, so it is
                              deliberately NOT capped at today. The old cap was
                              correct for a log of work already done and wrong for
                              a task you are assigning. The completion date on each
                              task keeps the cap. */}
                          <Input
                            type="date"
                            value={newCorrectionDue}
                            onChange={(e) => setNewCorrectionDue(e.target.value)}
                            className="h-9 w-auto text-sm"
                            title="Due date"
                          />
                          <Button size="sm" onClick={addCorrection} disabled={addingCorrection || !newCorrection.trim()}>
                            {addingCorrection ? "Adding…" : "Assign Correction"}
                          </Button>
                        </div>
                        <div className="pt-1">
                          <Button size="sm" variant="outline" onClick={() => setDestructionOpen(true)}>
                            <Trash2 className="h-4 w-4 mr-1.5" />
                            Create Destruction Record
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
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
                        <dt className="text-xs font-medium text-muted-foreground">Type</dt>
                        <dd className="mt-1 text-sm">{complaint?.complaintType}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Severity</dt>
                        <dd className="mt-1">
                          <Badge
                            variant={
                              complaint?.severity === "Critical" || complaint?.severity === "High"
                                ? "destructive"
                                : "secondary"
                            }
                          >
                            {complaint?.severity}
                          </Badge>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Customer</dt>
                        <dd className="mt-1 text-sm">
                          {complaint?.customerName ?? (
                            <span className="italic text-muted-foreground">Anonymous</span>
                          )}
                        </dd>
                      </div>
                      {complaint?.productName && (
                        <div>
                          <dt className="text-xs font-medium text-muted-foreground">Product</dt>
                          <dd className="mt-1 text-sm">{complaint.productName}</dd>
                        </div>
                      )}
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Date Received</dt>
                        <dd className="mt-1 text-sm">
                          {complaint?.receivedDate
                            ? formatDateOnly(complaint.receivedDate)
                            : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Opened</dt>
                        <dd className="mt-1 text-sm">
                          {complaint?.createdAt
                            ? format(new Date(complaint.createdAt), "MMM d, yyyy")
                            : "—"}
                        </dd>
                      </div>
                      {complaint?.closedAt && (
                        <div>
                          <dt className="text-xs font-medium text-muted-foreground">Closed</dt>
                          <dd className="mt-1 text-sm">
                            {format(new Date(complaint.closedAt), "MMM d, yyyy")}
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Days Open</dt>
                        <dd className={`mt-1 text-sm font-semibold ${isPastDeadline ? "text-red-600" : isNearDeadline ? "text-orange-600" : ""}`}>
                          {daysOpen}d
                          {isClosed && (
                            <span className="ml-1 font-normal text-muted-foreground text-xs">(closed)</span>
                          )}
                          {!isClosed && (
                            <span className="ml-1 font-normal text-muted-foreground text-xs">/ {deadlineLimit}d limit</span>
                          )}
                        </dd>
                      </div>
                      {complaint?.batchId && (
                        <div>
                          <dt className="text-xs font-medium text-muted-foreground">Linked Batch</dt>
                          <dd className="mt-1 text-sm">
                            <Link
                              href={`/batches/${complaint.batchId}`}
                              className="text-primary hover:underline font-medium"
                            >
                              {linkedBatch?.batchNumber ?? `Batch #${complaint.batchId}`}
                            </Link>
                          </dd>
                        </div>
                      )}
                      {complaint?.fieldActionId && (
                        <div>
                          <dt className="text-xs font-medium text-muted-foreground">Field Action</dt>
                          <dd className="mt-1 text-sm">
                            <Link
                              href={`/field-actions/${complaint.fieldActionId}`}
                              className="text-primary hover:underline inline-flex items-center gap-1"
                            >
                              FA-{complaint.fieldActionId}
                              <ExternalLink className="h-3 w-3" />
                            </Link>
                          </dd>
                        </div>
                      )}
                    </dl>
                  </CardContent>
                </Card>

                <CandidateBatchesCard
                  complaintId={id}
                  readOnly={isClosed || isCancelled}
                  onChanged={invalidate}
                />

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Closure</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {isClosed ? (
                      <div className="flex items-center gap-2 text-sm text-green-700">
                        <CheckCircle2 className="h-4 w-4" />
                        <span>
                          Closed{" "}
                          {complaint.closedAt
                            ? format(new Date(complaint.closedAt), "MMM d, yyyy")
                            : ""}
                        </span>
                      </div>
                    ) : isCancelled ? (
                      <p className="text-sm text-muted-foreground">
                        This complaint is cancelled and removed from active use. An Admin can re-open it, or open a new complaint.
                      </p>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground">
                          {linkedCapaId
                            ? "Escalated to a CAPA — investigation and corrective actions are tracked there. Closing requires only an electronic signature (21 CFR Part 11)."
                            : "Requires investigation notes, a disposition (a correction — completed — or 'no corrections or containment actions required'), and an electronic signature (21 CFR Part 11)."}
                        </p>
                        <Button
                          className="w-full"
                          disabled={!canClose}
                          onClick={() => setSignatureOpen(true)}
                        >
                          Close Complaint
                        </Button>
                        {!canClose && (
                          <p className="text-xs text-destructive">
                            {!hasInvestigation && "Investigation notes required. "}
                            {hasInvestigation && !hasDisposition && "Add a correction, escalate to a CAPA, or mark 'no corrections or containment actions required'."}
                            {hasInvestigation && hasDisposition && openCorrections > 0 &&
                              `${openCorrections} correction${openCorrections === 1 ? "" : "s"} still open — mark ${openCorrections === 1 ? "it" : "them"} complete before closing.`}
                          </p>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Attachments — complaint correspondence, photos, lab results.
                complaints is allow-listed server-side. */}
            {complaint && (
              <div className="mt-6">
                <AttachmentsPanel
                  parentTable="complaints"
                  parentId={complaint.id}
                  allowSupplementary={!isClosed && !isCancelled}
                  currentUserId={currentUser?.id}
                  currentUserRole={currentUser?.role}
                  title="Attachments (correspondence, photos, lab results)"
                />
              </div>
            )}
          </TabsContent>

          {/* ACTIONS TAB */}
          <TabsContent value="actions" className="mt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

              {/* Status workflow */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Status Workflow</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-xs text-muted-foreground mb-3">
                    Advance this complaint through the investigation pipeline.
                    Closure requires a signature on the Details tab.
                  </p>
                  {STATUS_ORDER.filter((s) => !s.startsWith("Closed")).map((s) => (
                    <Button
                      key={s}
                      variant={complaint?.status === s ? "default" : "outline"}
                      size="sm"
                      className="w-full justify-start"
                      disabled={
                        complaint?.status === s || isClosed || updatingStatus
                      }
                      onClick={() => updateStatus(s)}
                    >
                      {complaint?.status === s && "● "}
                      {s}
                    </Button>
                  ))}
                </CardContent>
              </Card>

              {/* Escalate to CAPA (Session 101) — a complaint can be escalated
                  directly to a CAPA (no NC first); the CAPA carries the
                  root-cause investigation and corrective/preventive actions. */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {linkedCapa ? "Linked CAPA" : "Escalate to CAPA"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {linkedCapa ? (
                    <>
                      <Link href={`/capas/${linkedCapa.id}`}>
                        <div className="flex items-center justify-between rounded border px-3 py-2 hover:bg-muted/40 cursor-pointer">
                          <div className="min-w-0">
                            <span className="font-mono text-sm font-semibold text-primary">{linkedCapa.capaNumber}</span>
                            {linkedCapa.title ? <span className="text-sm text-muted-foreground"> · {linkedCapa.title}</span> : null}
                          </div>
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border bg-slate-50 text-slate-600 border-slate-200 shrink-0 ml-2">{linkedCapa.stage}</span>
                        </div>
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        This complaint has been escalated to a CAPA. Root-cause investigation and corrective/preventive actions are tracked there.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-muted-foreground">
                        Escalate to a CAPA to complete a root cause investigation and/or implement and track corrective or preventive actions related to this complaint.
                      </p>
                      <ul className="text-xs text-muted-foreground space-y-1 pl-4 list-disc">
                        <li>Risk mapped automatically from complaint severity</li>
                        <li>Linked back to this complaint; complaint moves to "Pending Corrections"</li>
                        {complaint?.productName && <li>Product "{complaint.productName}" carried over</li>}
                      </ul>
                      <Button
                        className="w-full"
                        variant="outline"
                        disabled={!complaint || creatingNC || isClosed}
                        onClick={escalateToCapa}
                      >
                        <FileText className="h-4 w-4 mr-2" />
                        {creatingNC ? "Escalating…" : "Escalate to CAPA"}
                      </Button>
                      {isClosed && (
                        <p className="text-xs text-muted-foreground">
                          A CAPA cannot be raised from a closed complaint.
                        </p>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Regulatory guidance card — only for CRA-applicable complaints */}
              {needsCra && (
                <Card className="md:col-span-2 border-orange-200 bg-orange-50/40">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2 text-orange-900">
                      <ShieldAlert className="h-4 w-4" />
                      Michigan CRA Notification Guidance
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-orange-900 space-y-2">
                    <p>
                      Under Michigan Administrative Code{" "}
                      <strong>R 420.214b</strong>, licensees must notify the
                      Cannabis Regulatory Agency of any adverse reaction to a
                      marihuana product and enter it into METRC.
                    </p>
                    <ul className="pl-5 list-disc space-y-1 text-xs">
                      <li>
                        <strong>Adverse reactions</strong> — notify the CRA and
                        log in METRC within{" "}
                        <strong>1 business day</strong> of awareness (R 420.214b).
                      </li>
                      <li>
                        <strong>Recalls / Field Actions</strong> — immediate
                        notification required; use the Field Actions module.
                      </li>
                      <li>
                        <strong>Documentation required</strong> — record the
                        date, method of contact, CRA contact name, and any
                        reference numbers in the investigation notes.
                      </li>
                    </ul>
                    <p className="text-xs font-medium pt-1 border-t border-orange-200">
                      This system does not submit notifications directly to the
                      CRA. All regulatory filings must be completed through
                      the MRA/METRC portal or directly with the agency.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          {/* AUDIT LOG TAB */}
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
                      <div key={entry.id} className="py-3 flex items-start gap-4">
                        <div className="w-36 shrink-0 text-xs text-muted-foreground pt-0.5 font-mono">
                          {entry.changedAt
                            ? format(new Date(entry.changedAt), "MMM d, yyyy HH:mm")
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
        onOpenChange={setSignatureOpen}
        title="Close Complaint"
        description="By signing, you confirm the investigation is complete, the complaint is resolved, and any required Michigan CRA regulatory notifications have been made. This action is irreversible (21 CFR Part 11)."
        onSign={handleSign}
        isPending={updateComplaint.isPending}
      />

      <CreateDestructionRecordDialog
        open={destructionOpen}
        onOpenChange={setDestructionOpen}
        initialSourceLot={(complaint as { lotNumber?: string | null } | undefined)?.lotNumber ?? undefined}
        onCreated={() => { setDestructionOpen(false); toast({ title: "Destruction record created" }); }}
      />
    </AppLayout>
  );
}
