import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SiteBadge } from "@/components/FacilitySite";
import {
  useGetNonConformance,
  useApproveNonConformance,
  useGetCurrentUser,
  useListUsers,
  useListAuditLog,
  useGetBatchRecord,
  getGetNonConformanceQueryKey,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { accentClass, toneNcSeverity, toneNcStatus } from "@/lib/status";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Link, useLocation } from "wouter";
import { format, parseISO, differenceInCalendarDays } from "date-fns";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { CancelRecordDialog } from "@/components/dialogs/CancelRecordDialog";
import { NcCorrectionsAndAckPanel } from "@/components/nc/NcCorrectionsAndAckPanel";
import { DestructionRecordPanel } from "@/components/nc/DestructionRecordPanel";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { AuditDiff } from "@/components/audit/AuditDiff";
import {
  CheckCircle2,
  AlertCircle,
  Clock,
  FileText,
  Printer,
  AlertTriangle,
  ShieldCheck,
  ExternalLink,
  Ban,
  RotateCcw,
} from "lucide-react";

const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);
// Roles permitted to Cancel (mirror server CANCEL_ROLES). Narrower than the
// approver set — no Supervisor. Re-open is Admin-only.
const CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);

type LinkedCapa = { id: number; capaNumber: string; title: string; status: string; type: string };

const SEVERITY_COLORS: Record<string, string> = {
  Critical: "bg-red-50 border-red-200 text-red-800",
  Major: "bg-orange-50 border-orange-200 text-orange-800",
  Minor: "bg-yellow-50 border-yellow-200 text-yellow-800",
};

// Locked NC status enum (Session 11) and their definitions for hover help.
const NC_STATUS_FLOW = [
  { value: "Open",                          desc: "Description section has been completed." },
  { value: "In Progress",                   desc: "Corrections and/or Root Cause Analysis are ongoing." },
  { value: "Awaiting Mgt Acknowledgement",  desc: "Corrections, root cause and disposition are done and a CAPA is linked; awaiting a manager's acknowledgement (Major/Critical only)." },
  { value: "Under Review",                  desc: "All steps complete; NC is ready to be closed." },
] as const;

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

export default function NonConformanceDetail(props: {
  params?: { id: string };
}) {
  const id = parseInt(props.params?.id ?? "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: nc, isLoading } = useGetNonConformance(id);
  const { data: currentUser } = useGetCurrentUser();
  // Session 54 — "Reported By" is a strict user picker (decision B: an NC is
  // always reported by an internal user). Keep the currently-recorded reporter
  // in the list even if inactive so an existing assignment still renders.
  const { data: usersData = [] } = useListUsers();
  const { data: auditLog = [] } = useListAuditLog({
    tableName: "non_conformances",
    rowId: id,
    limit: 50,
  });
  const { data: linkedBatch } = useGetBatchRecord(nc?.batchId ?? 0);

  const approveNC = useApproveNonConformance();

  const [signatureOpen, setSignatureOpen] = useState(false);

  // Description inline editing (editable until NC is Closed)
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [savingDescription, setSavingDescription] = useState(false);

  // Root cause inline editing
  const [editingRootCause, setEditingRootCause] = useState(false);
  const [rootCauseDraft, setRootCauseDraft] = useState("");
  const [savingRootCause, setSavingRootCause] = useState(false);

  // Disposition inline editing
  const [editingDisposition, setEditingDisposition] = useState(false);
  const [dispositionDraft, setDispositionDraft] = useState("");
  // Part 11 sign-off dialog for Use-As-Is disposition (Session 11).
  const [useAsIsOpen, setUseAsIsOpen] = useState(false);
  const [useAsIsBusy, setUseAsIsBusy] = useState(false);
  // Session 101 (#3) — Use-As-Is rationale draft (why nonconforming product is
  // acceptable to release). Sent with the Part 11 sign-off.
  const [useAsIsRationaleDraft, setUseAsIsRationaleDraft] = useState("");
  // Multi-select root-cause picks (separate from the narrative rootCause).
  const [rootCausesDraft, setRootCausesDraft] = useState<string[]>([]);
  const [savingRootCauses, setSavingRootCauses] = useState(false);
  const [savingDisposition, setSavingDisposition] = useState(false);

  // Session 52 — Cancel / Re-open (Part 11). Cancel = soft, recoverable, e-signed
  // (no hard delete). Re-open is Admin-only.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [uncancelOpen, setUncancelOpen] = useState(false);
  const [uncancelPending, setUncancelPending] = useState(false);

  // Session 48 — Identification details inline editing (Date NC Identified +
  // Severity Rationale + Reported By).
  // Session 48.5 — Reported By moved from read-only to editable per
  // Jonathan's feedback. The QMS owner may need to correct a typo or
  // record the actual reporter when the original capture missed it.
  const [editingDetails, setEditingDetails] = useState(false);
  const [detailsDraft, setDetailsDraft] = useState({ identifiedAt: "", severity: "", severityRationale: "", reportedByName: "", reportedByUserId: "", ownerUserId: "" });
  const [savingDetails, setSavingDetails] = useState(false);

  // Session 48 — Skip CAPA Rationale. Required at closure when severity is
  // Major/Critical AND no linked CAPA. Server enforces; this UI surfaces it
  // proactively so the operator can fill it before they hit the close-gate.
  const [editingSkipCapa, setEditingSkipCapa] = useState(false);
  const [skipCapaDraft, setSkipCapaDraft] = useState("");
  const [savingSkipCapa, setSavingSkipCapa] = useState(false);

  // Promote NC → CAPA
  const [, navigate] = useLocation();
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoting, setPromoting] = useState(false);
  // When the user checks "also close this NC" in the promote dialog we defer
  // navigation to the new CAPA until after the close-signature is captured.
  const [closeAfterPromote, setCloseAfterPromote] = useState(false);
  const [pendingNavCapa, setPendingNavCapa] = useState<{ id: number; capaNumber: string } | null>(null);
  // Session 75 — escalate this NC to a Field Action (which auto-opens a CAPA).
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [escalating, setEscalating] = useState(false);

  // Linked CAPAs come back on the NC GET payload
  const linkedCapas: LinkedCapa[] = ((nc as unknown as { linkedCapas?: LinkedCapa[] })?.linkedCapas) ?? [];
  const allLinkedCapasClosed = linkedCapas.length > 0 && linkedCapas.every((c) => c.status === "Closed");
  const canPromote = !!currentUser?.role && APPROVER_ROLES.has(currentUser.role);

  const handlePromoteToCapa = async () => {
    setPromoting(true);
    try {
      const BASE = import.meta.env.BASE_URL ?? "/";
      const r = await fetch(`${BASE}api/non-conformances/${id}/promote-to-capa`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "Corrective" }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? "Promote failed");
      }
      const data = await r.json() as { id: number; capaNumber: string };
      toast({ title: "CAPA created", description: `${data.capaNumber} opened from this NC.` });
      setPromoteOpen(false);
      // If the user opted to also close this NC, capture the new CAPA so we
      // can navigate to it after the Part 11 close-signature is recorded.
      // Otherwise jump straight to the new CAPA detail page.
      if (closeAfterPromote) {
        setPendingNavCapa(data);
        invalidateNC();
        setSignatureOpen(true);
      } else {
        navigate(`/capas/${data.id}`);
      }
    } catch (e) {
      toast({ title: "Failed to open CAPA", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setPromoting(false);
    }
  };

  // Session 75 — related complaints + escalated field actions come back on the
  // NC GET payload (off-spec enrichment, same pattern as linkedCapas).
  type LinkedComplaint = { id: number; complaintNumber: string; complaintType: string | null; severity: string | null; status: string | null; receivedDate: string | null };
  type EscalatedFa = { id: number; faNumber: string; actionType: string | null; status: string | null; linkedCapaId: number | null };
  const linkedComplaints: LinkedComplaint[] = ((nc as unknown as { linkedComplaints?: LinkedComplaint[] })?.linkedComplaints) ?? [];
  const escalatedFieldActions: EscalatedFa[] = ((nc as unknown as { escalatedFieldActions?: EscalatedFa[] })?.escalatedFieldActions) ?? [];
  // Session 97 (cross-linking follow-up) — the specific source record this NC was
  // opened from (Slice 4), resolved by the NC GET. Null unless Source was a system
  // record (Incoming Inspection / Customer Complaint) with a record picked.
  const sourceInspection = (nc as unknown as { sourceInspection?: { id: number; inspectionNumber: string; supplierName: string | null; poManifestNumber: string | null } | null })?.sourceInspection ?? null;
  const sourceComplaint = (nc as unknown as { sourceComplaint?: { id: number; complaintNumber: string; complaintType: string | null; status: string | null } | null })?.sourceComplaint ?? null;

  const handleEscalateToFieldAction = async () => {
    setEscalating(true);
    try {
      const BASE = import.meta.env.BASE_URL ?? "/";
      const r = await fetch(`${BASE}api/non-conformances/${id}/promote-to-field-action`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? "Escalation failed");
      }
      const data = await r.json() as { fieldAction: { id: number; faNumber: string }; capa: { id: number; capaNumber: string } };
      toast({ title: "Field Action opened", description: `${data.fieldAction.faNumber} created with linked CAPA ${data.capa.capaNumber}.` });
      setEscalateOpen(false);
      navigate(`/field-actions/${data.fieldAction.id}`);
    } catch (e) {
      toast({ title: "Failed to escalate", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setEscalating(false);
    }
  };

  // Derived compliance indicators
  const hasRootCause = !!nc?.rootCause?.trim();
  const hasDisposition = !!nc?.disposition?.trim();
  // CAPA progress now reflects the LINKED CAPAs (the real CAPA process), not
  // the on-NC corrective_actions tab — removed Session 52 (NC = Corrections
  // only; CA/PA live in the linked CAPA).
  const linkedCapaTotal = linkedCapas.length;
  const linkedCapaClosed = linkedCapas.filter((c) => c.status === "Closed").length;
  // Indicator only (compliance bar + cancel warning). NC close no longer
  // requires linked CAPAs to be Closed — the CAPA carries the ongoing work.
  const allLinkedCapasDone = linkedCapaTotal === 0 || linkedCapaClosed === linkedCapaTotal;
  const daysOpen = nc
    ? nc.status === "Closed" && nc.closedAt
      ? differenceInCalendarDays(new Date(nc.closedAt), new Date(nc.createdAt))
      : differenceInCalendarDays(new Date(), new Date(nc.createdAt))
    : 0;
  const isClosed = nc?.status === "Closed";
  const isCancelled = !!(nc as { cancelledAt?: string | null } | undefined)?.cancelledAt;
  // Session 98 (#6) — header accent line = the NC's urgency (open severity;
  // closed reads calm/neutral), matching the list-row traffic-light language.
  const headerTone = nc ? (isClosed ? "neutral" : toneNcSeverity(nc.severity)) : "neutral";
  const headerAccent = accentClass(headerTone);
  const canCancel = !!currentUser?.role && CANCEL_ROLES.has(currentUser.role);
  // Re-open is Admin-only (Session 52 decision), narrower than Cancel.
  const canReopen = currentUser?.role === "Admin";
  const hasSig = !!nc?.approvalDate;

  const invalidateNC = () => {
    queryClient.invalidateQueries({ queryKey: getGetNonConformanceQueryKey(id) });
  };

  // ── Session 52 — Cancel / Re-open (off-spec endpoints; raw fetch) ────────────
  // Throw on failure so the dialogs surface the server message inline.
  const handleCancel = async (reason: string, initials: string, meaning: string) => {
    setCancelPending(true);
    try {
      const r = await fetch(`/api/non-conformances/${id}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, initials, signatureMeaning: meaning }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to cancel NC.");
      }
      invalidateNC();
      toast({ title: "NC cancelled", description: "Retained and recoverable; removed from active use." });
    } finally {
      setCancelPending(false);
    }
  };

  const handleUncancel = async (initials: string, meaning: string) => {
    setUncancelPending(true);
    try {
      const r = await fetch(`/api/non-conformances/${id}/uncancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initials, signatureMeaning: meaning }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to re-open NC.");
      }
      invalidateNC();
      toast({ title: "NC re-opened", description: "Record returned to active use." });
    } finally {
      setUncancelPending(false);
    }
  };

  // ── Close NC (Part 11 signature) ────────────────────────────────────────────
  const handleSign = async (initials: string, meaning: string) => {
    const userId = currentUser?.id ?? 0;
    try {
      await approveNC.mutateAsync({
        id,
        data: { initials, signatureMeaning: meaning, userId },
      });
    } catch (err: unknown) {
      // Session 48.4 — re-throw with the server's actual error message so
      // Part11SignatureDialog can display it inline. The orval mutator
      // doesn't always surface server JSON bodies in err.message, so we
      // extract from multiple shapes here as a guarantee.
      const e = err as { response?: { data?: { error?: string } }; data?: { error?: string }; message?: string };
      const serverMsg = e?.response?.data?.error ?? e?.data?.error;
      const fallback = typeof e?.message === "string" && e.message && !e.message.toLowerCase().startsWith("request failed")
        ? e.message
        : null;
      throw new Error(serverMsg ?? fallback ?? "Failed to close NC. Please try again.");
    }
    invalidateNC();
    toast({ title: "NC Closed", description: "Non-Conformance has been closed and signed." });
    setSignatureOpen(false);
    // If close-after-promote was selected, navigate to the new CAPA now.
    if (pendingNavCapa) {
      const target = pendingNavCapa;
      setPendingNavCapa(null);
      setCloseAfterPromote(false);
      navigate(`/capas/${target.id}`);
    }
  };

  // ── Save description ────────────────────────────────────────────────────────
  // Description remains editable until the NC is Closed. Any edits made after
  // the initial creation are captured in the audit log (audit triggers fire on
  // every UPDATE to non_conformances). This satisfies Part 11 — the original
  // value is preserved in audit history, while users can still correct typos
  // or expand the description as more information surfaces.
  const saveDescription = async () => {
    if (!descriptionDraft.trim()) {
      toast({ title: "Description cannot be empty", variant: "destructive" });
      return;
    }
    setSavingDescription(true);
    try {
      await fetch(`/api/non-conformances/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: descriptionDraft.trim() }),
      });
      invalidateNC();
      setEditingDescription(false);
      toast({ title: "Saved", description: "Description updated." });
    } catch {
      toast({ title: "Error", description: "Failed to save description.", variant: "destructive" });
    } finally {
      setSavingDescription(false);
    }
  };

  // Session 48 — Save Identification Details (Date NC Identified + Severity
  // Rationale). Both fields are nullable, so empty string is treated as null.
  const saveDetails = async () => {
    setSavingDetails(true);
    // Session 54 — resolve the picked reporter to id + matching name so the
    // two never drift. Empty selection clears both (legacy rows may be blank).
    const pickedReporter = detailsDraft.reportedByUserId
      ? usersData.find((u) => String(u.id) === detailsDraft.reportedByUserId)
      : null;
    const pickedOwner = detailsDraft.ownerUserId
      ? usersData.find((u) => String(u.id) === detailsDraft.ownerUserId)
      : null;
    try {
      const res = await fetch(`/api/non-conformances/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifiedAt: detailsDraft.identifiedAt || null,
          // NC-6 — severity is Supervisor+-gated server-side; unchanged value is a
          // no-op, so it's safe to always send.
          severity: detailsDraft.severity || undefined,
          severityRationale: detailsDraft.severityRationale.trim() || null,
          reportedByUserId: pickedReporter?.id ?? null,
          reportedByName: pickedReporter?.fullName ?? null,
          ownerUserId: pickedOwner?.id ?? null,
          ownerName: pickedOwner?.fullName ?? null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        toast({ title: j.error ?? "Failed to save identification details.", variant: "destructive" });
        return;
      }
      invalidateNC();
      setEditingDetails(false);
      toast({ title: "Saved", description: "Identification details updated." });
    } catch {
      toast({ title: "Error", description: "Failed to save identification details.", variant: "destructive" });
    } finally {
      setSavingDetails(false);
    }
  };

  // Session 48 — Save Skip CAPA Rationale. Server enforces presence at close
  // when severity is Major/Critical AND no linked CAPA, so we let an empty
  // string clear the field if the operator changes their mind.
  const saveSkipCapaRationale = async () => {
    setSavingSkipCapa(true);
    try {
      await fetch(`/api/non-conformances/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipCapaRationale: skipCapaDraft.trim() || null }),
      });
      invalidateNC();
      setEditingSkipCapa(false);
      toast({ title: "Saved", description: "Skip-CAPA rationale updated." });
    } catch {
      toast({ title: "Error", description: "Failed to save rationale.", variant: "destructive" });
    } finally {
      setSavingSkipCapa(false);
    }
  };

  // ── Save root cause ─────────────────────────────────────────────────────────
  const saveRootCause = async () => {
    setSavingRootCause(true);
    try {
      await fetch(`/api/non-conformances/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootCause: rootCauseDraft }),
      });
      invalidateNC();
      setEditingRootCause(false);
      toast({ title: "Saved", description: "Root cause updated." });
    } catch {
      toast({ title: "Error", description: "Failed to save root cause.", variant: "destructive" });
    } finally {
      setSavingRootCause(false);
    }
  };

  // ── Save disposition ────────────────────────────────────────────────────────
  // Use-As-Is requires Supervisor+ Part 11 sign-off (Session 11).
  const saveDisposition = async () => {
    const prev = nc?.disposition ?? null;
    if (dispositionDraft === "Use As Is" && prev !== "Use As Is") {
      if (!useAsIsRationaleDraft.trim()) {
        toast({ title: "Rationale required", description: "Enter the Use-As-Is rationale before signing.", variant: "destructive" });
        return;
      }
      setUseAsIsOpen(true);
      return;
    }
    setSavingDisposition(true);
    try {
      const res = await fetch(`/api/non-conformances/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disposition: dispositionDraft }),
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({} as { error?: string }));
        toast({ title: msg?.error ?? "Failed to save disposition", variant: "destructive" });
        return;
      }
      invalidateNC();
      setEditingDisposition(false);
      toast({ title: "Saved", description: "Disposition updated." });
    } catch {
      toast({ title: "Error", description: "Failed to save disposition.", variant: "destructive" });
    } finally {
      setSavingDisposition(false);
    }
  };

  const confirmUseAsIs = async (initials: string, meaning: string) => {
    setUseAsIsBusy(true);
    try {
      const res = await fetch(`/api/non-conformances/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disposition: "Use As Is", approverInitials: initials, approverMeaning: meaning, useAsIsRationale: useAsIsRationaleDraft.trim() }),
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({} as { error?: string }));
        toast({ title: msg?.error ?? "Use-As-Is approval failed", variant: "destructive" });
        throw new Error("use-as-is failed");
      }
      invalidateNC();
      setUseAsIsOpen(false);
      setEditingDisposition(false);
      toast({ title: "Use-As-Is approved", description: "Disposition recorded with Part 11 signature." });
    } finally {
      setUseAsIsBusy(false);
    }
  };

  // ── Save root causes (multi-select picks) ───────────────────────────────────
  const saveRootCauses = async (next: string[]) => {
    setSavingRootCauses(true);
    try {
      const res = await fetch(`/api/non-conformances/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootCauses: next }),
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({} as { error?: string }));
        toast({ title: msg?.error ?? "Failed to save root causes", variant: "destructive" });
        return;
      }
      setRootCausesDraft(next);
      invalidateNC();
    } finally {
      setSavingRootCauses(false);
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6 max-w-5xl mx-auto pb-12 print:max-w-none">
        {/* ── Header ── */}
        <div className={headerAccent ? `pl-3 ${headerAccent}` : undefined}>
          <Link
            href="/non-conformances"
            className="text-sm text-primary hover:underline mb-2 block print:hidden"
          >
            &larr; Back to Non-Conformances
          </Link>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                {isLoading ? (
                  <Skeleton className="h-8 w-[150px]" />
                ) : (
                  nc?.ncNumber
                )}
              </h1>
              <div className="text-muted-foreground mt-0.5 text-sm">
                {isLoading ? <Skeleton className="h-4 w-[300px]" /> : nc?.title}
              </div>
              {/* Which plant raised this. A quality event belongs to the company, so
                  anyone can open it — and the first thing they need to know is where
                  it happened (2026-08-28). Renders nothing with a single site. */}
              <SiteBadge facilityId={(nc as { facilityId?: number | null } | undefined)?.facilityId} />
            </div>
            <div className="flex items-center gap-2 print:hidden">
              {!isClosed && !isCancelled && canPromote && nc && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setPromoteOpen(true)}
                  data-testid="button-promote-to-capa"
                  className="gap-1.5"
                >
                  <ShieldCheck className="h-4 w-4" />
                  Open CAPA from this NC
                </Button>
              )}
              {!isClosed && !isCancelled && canPromote && nc && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEscalateOpen(true)}
                  data-testid="button-escalate-to-field-action"
                  className="gap-1.5"
                >
                  <AlertTriangle className="h-4 w-4" />
                  Escalate to Field Action
                </Button>
              )}
              {nc && !isClosed && !isCancelled && canCancel && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCancelOpen(true)}
                  className="gap-1.5 text-destructive hover:text-destructive"
                  data-testid="button-cancel-nc"
                >
                  <Ban className="h-4 w-4" />
                  Cancel
                </Button>
              )}
              {nc && isCancelled && canReopen && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setUncancelOpen(true)}
                  disabled={uncancelPending}
                  className="gap-1.5"
                  data-testid="button-reopen-nc"
                >
                  <RotateCcw className="h-4 w-4" />
                  Re-open
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.print()}
              >
                <Printer className="h-4 w-4 mr-1" />
                Print
              </Button>
              {nc && <StatusBadge tone={toneNcStatus(nc.status)} label={nc.status} />}
            </div>
          </div>
        </div>

        {/* Session 52 — Cancelled banner (Part 11 record of who/why). */}
        {isCancelled && nc && (
          <div className="rounded-lg border-2 border-red-200 bg-red-50 px-4 py-3 print:hidden" data-testid="banner-nc-cancelled">
            <p className="text-sm font-semibold text-red-900 flex items-center gap-2">
              <Ban className="h-4 w-4" /> This non-conformance has been cancelled
            </p>
            <p className="text-xs text-red-800 mt-1">
              {(nc as { cancelledByName?: string | null }).cancelledByName}
              {(nc as { cancelledByInitials?: string | null }).cancelledByInitials ? ` (${(nc as { cancelledByInitials?: string | null }).cancelledByInitials})` : ""}
              {(nc as { cancelledAt?: string | null }).cancelledAt ? ` · ${format(new Date((nc as { cancelledAt?: string | null }).cancelledAt as string), "MMM d, yyyy h:mm a")}` : ""}
            </p>
            {(nc as { cancelledReason?: string | null }).cancelledReason && (
              <p className="text-sm text-red-900 mt-1.5 whitespace-pre-wrap">
                <span className="font-medium">Reason:</span> {(nc as { cancelledReason?: string | null }).cancelledReason}
              </p>
            )}
            <p className="text-[11px] text-red-700 mt-1 italic">Retained for compliance; can be re-opened by an Admin only.</p>
          </div>
        )}

        {/* Linked CAPAs banner — when all closed, prompt to close NC */}
        {nc && !isClosed && !isCancelled && allLinkedCapasClosed && (
          <div className="rounded-lg border-2 border-green-200 bg-green-50 px-4 py-3 flex items-center justify-between gap-3 print:hidden" data-testid="banner-all-capas-closed">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-green-900">
                  All linked CAPAs are closed.
                </p>
                <p className="text-xs text-green-700">
                  {linkedCapas.length} corrective action{linkedCapas.length !== 1 ? "s" : ""} verified. Close this NC to complete the chain.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => setSignatureOpen(true)}
              disabled={!hasRootCause || !hasDisposition}
              data-testid="button-close-nc-from-banner"
            >
              Close This NC
            </Button>
          </div>
        )}

        {/* Linked CAPAs panel */}
        {linkedCapas.length > 0 && (
          <div className="rounded-lg border bg-card print:hidden" data-testid="panel-linked-capas">
            <div className="px-4 py-2.5 border-b flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-primary" />
                Linked CAPAs ({linkedCapas.length})
              </h2>
              <span className="text-xs text-muted-foreground">
                {linkedCapas.filter((c) => c.status === "Closed").length} of {linkedCapas.length} closed
              </span>
            </div>
            <div className="divide-y">
              {linkedCapas.map((c) => (
                <Link key={c.id} href={`/capas/${c.id}`}>
                  <div className="flex items-center justify-between px-4 py-2.5 hover:bg-muted/40 cursor-pointer" data-testid={`linked-capa-${c.id}`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-mono text-sm font-semibold text-primary shrink-0">{c.capaNumber}</span>
                      <span className="text-sm text-foreground truncate">{c.title}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${
                        c.status === "Closed"
                          ? "bg-green-50 text-green-700 border-green-200"
                          : "bg-blue-50 text-blue-700 border-blue-200"
                      }`}>
                        {c.status}
                      </span>
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Session 75 — Related Complaints (reverse link: complaints whose nc_id = this NC) */}
        {linkedComplaints.length > 0 && (
          <div className="rounded-lg border bg-card print:hidden" data-testid="panel-related-complaints">
            <div className="px-4 py-2.5 border-b">
              <h2 className="text-sm font-semibold">Related Complaints ({linkedComplaints.length})</h2>
            </div>
            <div className="divide-y">
              {linkedComplaints.map((c) => (
                <Link key={c.id} href={`/complaints/${c.id}`}>
                  <div className="flex items-center justify-between px-4 py-2.5 hover:bg-muted/40 cursor-pointer">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-mono text-sm font-semibold text-primary shrink-0">{c.complaintNumber}</span>
                      <span className="text-sm text-foreground truncate">{c.complaintType}{c.severity ? ` · ${c.severity}` : ""}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border bg-slate-50 text-slate-600 border-slate-200">{c.status}</span>
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Session 75 — Field Actions escalated from this NC (each carries a CAPA) */}
        {escalatedFieldActions.length > 0 && (
          <div className="rounded-lg border bg-card print:hidden" data-testid="panel-escalated-field-actions">
            <div className="px-4 py-2.5 border-b">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-orange-600" />
                Escalated Field Actions ({escalatedFieldActions.length})
              </h2>
            </div>
            <div className="divide-y">
              {escalatedFieldActions.map((fa) => (
                <div key={fa.id} className="flex items-center justify-between px-4 py-2.5">
                  <Link href={`/field-actions/${fa.id}`}>
                    <div className="flex items-center gap-3 min-w-0 hover:underline cursor-pointer">
                      <span className="font-mono text-sm font-semibold text-primary shrink-0">{fa.faNumber}</span>
                      <span className="text-sm text-foreground truncate">{fa.actionType}</span>
                    </div>
                  </Link>
                  <div className="flex items-center gap-2 shrink-0">
                    {fa.linkedCapaId && (
                      <Link href={`/capas/${fa.linkedCapaId}`}>
                        <span className="text-xs text-primary hover:underline cursor-pointer">CAPA linked</span>
                      </Link>
                    )}
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border bg-orange-50 text-orange-700 border-orange-200">{fa.status}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Compliance summary bar ── */}
        {nc && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {/* Severity */}
            <div
              className={`rounded-lg border p-3 text-center ${SEVERITY_COLORS[nc.severity] ?? "bg-gray-50 border-gray-200"}`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="text-xs font-semibold uppercase tracking-wide">
                  Severity
                </span>
              </div>
              <p className="text-sm font-bold">{nc.severity}</p>
            </div>

            {/* Root Cause */}
            <div
              className={`rounded-lg border p-3 text-center ${
                hasRootCause
                  ? "bg-green-50 border-green-200 text-green-800"
                  : linkedCapaTotal > 0
                    ? "bg-amber-50 border-amber-200 text-amber-800"
                    : "bg-red-50 border-red-200 text-red-800"
              }`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                {hasRootCause || linkedCapaTotal > 0 ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wide">
                  Investigation
                </span>
              </div>
              <p className="text-sm font-bold">
                {hasRootCause ? "Entered" : linkedCapaTotal > 0 ? "Via CAPA" : "Missing"}
              </p>
            </div>

            {/* Disposition */}
            <div
              className={`rounded-lg border p-3 text-center ${hasDisposition ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-800"}`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                {hasDisposition ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wide">
                  Disposition
                </span>
              </div>
              <p className="text-sm font-bold">
                {hasDisposition ? nc.disposition : "Missing"}
              </p>
            </div>

            {/* CAPA Progress — reflects LINKED CAPAs (closed / total). */}
            <div
              className={`rounded-lg border p-3 text-center ${
                linkedCapaTotal === 0
                  ? "bg-slate-50 border-slate-200 text-slate-600"
                  : allLinkedCapasDone
                    ? "bg-green-50 border-green-200 text-green-800"
                    : "bg-orange-50 border-orange-200 text-orange-800"
              }`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                <FileText className="h-3.5 w-3.5" />
                <span className="text-xs font-semibold uppercase tracking-wide">
                  CAPA
                </span>
              </div>
              <p className="text-sm font-bold">
                {linkedCapaTotal === 0 ? "None" : `${linkedCapaClosed} / ${linkedCapaTotal}`}
              </p>
            </div>

            {/* Signature */}
            <div
              className={`rounded-lg border p-3 text-center ${hasSig ? "bg-green-50 border-green-200 text-green-800" : "bg-slate-50 border-slate-200 text-slate-600"}`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                {hasSig ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <Clock className="h-3.5 w-3.5" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wide">
                  Signature
                </span>
              </div>
              <p className="text-sm font-bold">{hasSig ? "Signed" : "Pending"}</p>
            </div>
          </div>
        )}

        {/* ── Main tabs ── */}
        <Tabs defaultValue="overview">
          <TabsList className="print:hidden">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="audit">Audit Log</TabsTrigger>
          </TabsList>

          {/* ── OVERVIEW TAB ── */}
          <TabsContent value="overview" className="mt-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Left: main fields */}
              <div className="md:col-span-2 space-y-6">
                {/* Session 48 — Identification Details. Date NC Identified
                    (distinct from createdAt), Severity Rationale (justifies
                    the severity classification), Reported By (who opened
                    the NC — read-only historical fact). All inline-editable
                    via a single Edit/Save/Cancel pattern matching the rest
                    of the page. */}
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-base">Identification Details</CardTitle>
                    {!isClosed && !isCancelled && !editingDetails && !isLoading && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          // Cast once into a permissive shape — Session 48
                          // fields haven't propagated to the generated
                          // NonConformance type yet (route is off-spec). See
                          // memory: project-label-templates-off-spec for the
                          // pattern. Future codegen pass will tighten this.
                          const ncExt = nc as ({ identifiedAt?: string | null; severityRationale?: string | null; reportedByName?: string | null; reportedByUserId?: number | null; ownerUserId?: number | null }) | undefined;
                          setDetailsDraft({
                            identifiedAt: ncExt?.identifiedAt ? String(ncExt.identifiedAt).slice(0, 10) : "",
                            severity: nc?.severity ?? "",
                            severityRationale: ncExt?.severityRationale ?? "",
                            reportedByName: ncExt?.reportedByName ?? "",
                            reportedByUserId: ncExt?.reportedByUserId != null ? String(ncExt.reportedByUserId) : "",
                            ownerUserId: ncExt?.ownerUserId != null ? String(ncExt.ownerUserId) : "",
                          });
                          setEditingDetails(true);
                        }}
                      >
                        Edit
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent className="pt-2">
                    {isLoading ? (
                      <Skeleton className="h-20 w-full" />
                    ) : editingDetails ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs">Date NC Identified</Label>
                            <Input
                              type="date"
                              className="mt-1"
                              value={detailsDraft.identifiedAt}
                              max={new Date().toISOString().slice(0, 10)}
                              onChange={(e) => setDetailsDraft((v) => ({ ...v, identifiedAt: e.target.value }))}
                            />
                            <p className="text-[10px] text-muted-foreground mt-0.5">When the issue was actually spotted (may differ from when this record was created).</p>
                          </div>
                          <div>
                            <Label className="text-xs">Reported By</Label>
                            <Select
                              value={detailsDraft.reportedByUserId}
                              onValueChange={(v) => setDetailsDraft((d) => ({ ...d, reportedByUserId: v }))}
                            >
                              <SelectTrigger className="mt-1 text-sm" data-testid="select-nc-reported-by">
                                <SelectValue placeholder="Select user…" />
                              </SelectTrigger>
                              <SelectContent>
                                {usersData.filter((u) => u.active || String(u.id) === detailsDraft.reportedByUserId).length === 0 ? (
                                  <div className="px-2 py-1.5 text-xs text-muted-foreground">No users.</div>
                                ) : (
                                  usersData
                                    .filter((u) => u.active || String(u.id) === detailsDraft.reportedByUserId)
                                    .map((u) => (
                                      <SelectItem key={u.id} value={String(u.id)}>
                                        {u.fullName}{u.role ? ` · ${u.role}` : ""}
                                      </SelectItem>
                                    ))
                                )}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-xs">Owner</Label>
                            <Select
                              value={detailsDraft.ownerUserId}
                              onValueChange={(v) => setDetailsDraft((d) => ({ ...d, ownerUserId: v }))}
                            >
                              <SelectTrigger className="mt-1 text-sm" data-testid="select-nc-owner">
                                <SelectValue placeholder="Select owner…" />
                              </SelectTrigger>
                              <SelectContent>
                                {usersData.filter((u) => u.active || String(u.id) === detailsDraft.ownerUserId).length === 0 ? (
                                  <div className="px-2 py-1.5 text-xs text-muted-foreground">No users.</div>
                                ) : (
                                  usersData
                                    .filter((u) => u.active || String(u.id) === detailsDraft.ownerUserId)
                                    .map((u) => (
                                      <SelectItem key={u.id} value={String(u.id)}>
                                        {u.fullName}{u.role ? ` · ${u.role}` : ""}
                                      </SelectItem>
                                    ))
                                )}
                              </SelectContent>
                            </Select>
                            <p className="text-[10px] text-muted-foreground mt-0.5">Accountable for driving this NC to closure.</p>
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs">Severity</Label>
                          {canPromote ? (
                            <Select value={detailsDraft.severity} onValueChange={(v) => setDetailsDraft((d) => ({ ...d, severity: v }))}>
                              <SelectTrigger className="mt-1 text-sm" data-testid="select-nc-severity"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {["Minor", "Major", "Critical"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          ) : (
                            <p className="mt-1 text-sm font-medium">{detailsDraft.severity} <span className="text-[10px] font-normal text-muted-foreground">— only a Supervisor can change severity</span></p>
                          )}
                          <p className="text-[10px] text-muted-foreground mt-0.5">Major / Critical NCs require management acknowledgement and a linked CAPA before they can be closed. Explain any change in the rationale below.</p>
                        </div>
                        <div>
                          <Label className="text-xs">Severity Rationale</Label>
                          <Textarea
                            className="mt-1 text-sm"
                            rows={3}
                            placeholder="Why is this severity correct? (e.g. customer-facing impact, regulatory citation, batch loss size)"
                            value={detailsDraft.severityRationale}
                            onChange={(e) => setDetailsDraft((v) => ({ ...v, severityRationale: e.target.value }))}
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={saveDetails} disabled={savingDetails}>
                            {savingDetails ? "Saving…" : "Save"}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingDetails(false)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                        <div>
                          <dt className="text-xs text-muted-foreground">Date NC Identified</dt>
                          <dd className="mt-0.5 font-medium">
                            {(() => {
                              const v = (nc as { identifiedAt?: string | null } | undefined)?.identifiedAt;
                              return v
                                ? format(parseISO(String(v)), "MMM d, yyyy")
                                : <span className="text-muted-foreground italic">Not recorded</span>;
                            })()}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">Reported By</dt>
                          <dd className="mt-0.5 font-medium">
                            {(nc as { reportedByName?: string | null } | undefined)?.reportedByName
                              ?? <span className="text-muted-foreground italic">Not recorded</span>}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">Owner</dt>
                          <dd className="mt-0.5 font-medium">
                            {(nc as { ownerName?: string | null } | undefined)?.ownerName
                              ?? <span className="text-muted-foreground italic">Not assigned</span>}
                          </dd>
                        </div>
                        <div className="col-span-2">
                          <dt className="text-xs text-muted-foreground">Severity Rationale</dt>
                          <dd className="mt-0.5 text-sm whitespace-pre-wrap">
                            {(nc as { severityRationale?: string | null } | undefined)?.severityRationale
                              ?? <span className="text-muted-foreground italic">Not provided</span>}
                          </dd>
                        </div>
                      </dl>
                    )}
                  </CardContent>
                </Card>

                {/* Description — editable until NC is Closed */}
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-base">Description</CardTitle>
                    {!isClosed && !isCancelled && !editingDescription && !isLoading && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setDescriptionDraft(nc?.description ?? "");
                          setEditingDescription(true);
                        }}
                      >
                        Edit
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent className="pt-2">
                    {isLoading ? (
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-[80%]" />
                      </div>
                    ) : editingDescription ? (
                      <div className="space-y-2">
                        <Textarea
                          rows={5}
                          value={descriptionDraft}
                          onChange={(e) => setDescriptionDraft(e.target.value)}
                          placeholder="Describe what was observed, where, and why it is a non-conformance…"
                          className="text-sm"
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={saveDescription}
                            disabled={savingDescription}
                          >
                            {savingDescription ? "Saving…" : "Save"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingDescription(false)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm bg-muted/30 p-3 rounded-md whitespace-pre-wrap">
                        {nc?.description}
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* Corrections + Management Acknowledgement (Part 11) */}
                {nc && (
                  <NcCorrectionsAndAckPanel
                    nc={{
                      id: nc.id,
                      status: nc.status,
                      severity: nc.severity,
                      mgmtAcknowledgedAt: (nc as { mgmtAcknowledgedAt?: string | null }).mgmtAcknowledgedAt ?? null,
                      mgmtAcknowledgedName: (nc as { mgmtAcknowledgedName?: string | null }).mgmtAcknowledgedName ?? null,
                      mgmtAcknowledgedInitials: (nc as { mgmtAcknowledgedInitials?: string | null }).mgmtAcknowledgedInitials ?? null,
                      mgmtAcknowledgedNotes: (nc as { mgmtAcknowledgedNotes?: string | null }).mgmtAcknowledgedNotes ?? null,
                    }}
                    onAcknowledged={invalidateNC}
                    locked={isCancelled}
                  />
                )}

                {/* Session 48 — Skip CAPA Rationale.
                    Renders only when severity is Major/Critical AND no CAPA
                    is linked. Server enforces presence at closure; this card
                    surfaces it proactively (amber warning style) so the
                    operator can fill it before the close-gate fires. Once a
                    CAPA exists, the gate is satisfied and this card hides. */}
                {nc && (nc.severity === "Major" || nc.severity === "Critical") && linkedCapas.length === 0 && (
                  <Card className="border-amber-200 bg-amber-50/40 dark:bg-amber-950/20">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                        Skip-CAPA Rationale
                        <span className="text-xs font-normal text-muted-foreground ml-1">(required to close without a CAPA)</span>
                      </CardTitle>
                      {!isClosed && !isCancelled && !editingSkipCapa && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSkipCapaDraft((nc as { skipCapaRationale?: string | null }).skipCapaRationale ?? "");
                            setEditingSkipCapa(true);
                          }}
                        >
                          Edit
                        </Button>
                      )}
                    </CardHeader>
                    <CardContent className="pt-2 space-y-2">
                      <p className="text-xs text-amber-900 dark:text-amber-200">
                        This NC is {nc.severity}. Major/Critical NCs typically escalate to CAPA for root-cause investigation, corrective actions, and effectiveness check. If no CAPA is being opened (immediate corrections fully address the issue and no preventive action is warranted), record WHY here. The server will block closure of this NC until either a CAPA is linked or this rationale is provided.
                      </p>
                      {editingSkipCapa ? (
                        <div className="space-y-2">
                          <Textarea
                            rows={4}
                            value={skipCapaDraft}
                            onChange={(e) => setSkipCapaDraft(e.target.value)}
                            placeholder="Why is no CAPA being opened for this Major/Critical NC?"
                            className="text-sm"
                          />
                          <div className="flex gap-2">
                            <Button size="sm" onClick={saveSkipCapaRationale} disabled={savingSkipCapa}>
                              {savingSkipCapa ? "Saving…" : "Save"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditingSkipCapa(false)}>Cancel</Button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm bg-white/60 dark:bg-black/20 p-3 rounded-md whitespace-pre-wrap min-h-[2.5rem]">
                          {(nc as { skipCapaRationale?: string | null }).skipCapaRationale
                            ?? <span className="text-muted-foreground italic">Not provided. Either promote this NC to CAPA or enter a rationale here before attempting to close.</span>}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* Session 49 — Destruction Record panel. Renders only when the
                    disposition is Destroy, after the Skip-CAPA card so all
                    disposition-related sections cluster together. Lets the
                    operator link an existing METRC destruction record or create
                    a new one inline (M:1 — one tag can cover many batches). */}
                {nc && nc.disposition === "Destroy" && (
                  <DestructionRecordPanel
                    ncId={nc.id}
                    destructionRecordId={(nc as { destructionRecordId?: number | null }).destructionRecordId ?? null}
                    isClosed={isClosed || isCancelled}
                    onChanged={invalidateNC}
                  />
                )}

                {/* Root Cause — inline editable */}
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-base">Investigation Results</CardTitle>
                    {!isClosed && !isCancelled && !editingRootCause && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setRootCauseDraft(nc?.rootCause ?? "");
                          setEditingRootCause(true);
                        }}
                      >
                        Edit
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent className="pt-2">
                    {editingRootCause ? (
                      <div className="space-y-2">
                        <Textarea
                          rows={5}
                          value={rootCauseDraft}
                          onChange={(e) => setRootCauseDraft(e.target.value)}
                          placeholder="Summarize the investigation results — what was found and the root cause…"
                          className="text-sm"
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={saveRootCause}
                            disabled={savingRootCause}
                          >
                            {savingRootCause ? "Saving…" : "Save"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingRootCause(false)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : nc?.rootCause ? (
                      <p
                        className={`text-sm bg-muted/30 p-3 rounded-md whitespace-pre-wrap ${!isClosed && !isCancelled ? "cursor-text hover:bg-muted/50 transition-colors" : ""}`}
                        onClick={
                          !isClosed && !isCancelled
                            ? () => {
                                setRootCauseDraft(nc?.rootCause ?? "");
                                setEditingRootCause(true);
                              }
                            : undefined
                        }
                        title={!isClosed && !isCancelled ? "Click to edit" : undefined}
                      >
                        {nc.rootCause}
                      </p>
                    ) : (
                      <p
                        className={`text-sm text-muted-foreground italic ${!isClosed && !isCancelled ? "cursor-text hover:text-foreground transition-colors" : ""}`}
                        onClick={
                          !isClosed && !isCancelled
                            ? () => {
                                setRootCauseDraft("");
                                setEditingRootCause(true);
                              }
                            : undefined
                        }
                        title={!isClosed && !isCancelled ? "Click to add" : undefined}
                      >
                        No investigation results documented yet. Required before closing.
                      </p>
                    )}
                    {/* Multi-select root-cause picks for metrics (Session 11) */}
                    {(() => {
                      const current = ((nc as unknown as { rootCauses?: string[] | null })?.rootCauses ?? rootCausesDraft) ?? [];
                      const toggle = (label: string) => {
                        const next = current.includes(label)
                          ? current.filter((x: string) => x !== label)
                          : [...current, label];
                        void saveRootCauses(next);
                      };
                      return (
                        <div className="mt-3 pt-3 border-t">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                            Investigation Results Categories (for metrics)
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

                {/* Disposition — inline editable */}
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-base">Disposition</CardTitle>
                    {!isClosed && !isCancelled && !editingDisposition && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setDispositionDraft(nc?.disposition ?? "");
                          setUseAsIsRationaleDraft((nc as unknown as { useAsIsRationale?: string | null })?.useAsIsRationale ?? "");
                          setEditingDisposition(true);
                        }}
                      >
                        {nc?.disposition ? "Change" : "Set"}
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent className="pt-2">
                    {editingDisposition ? (
                      <div className="space-y-2">
                        <Select
                          value={dispositionDraft}
                          onValueChange={setDispositionDraft}
                        >
                          <SelectTrigger className="text-sm">
                            <SelectValue placeholder="Select disposition…" />
                          </SelectTrigger>
                          <SelectContent>
                            {[
                              "Rework",
                              "Retest",
                              "Destroy",
                              "Use As Is",
                              "Return to Supplier",
                              "N/A - Not Product Related",
                            ].map((d) => (
                              <SelectItem key={d} value={d}>
                                {d}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {dispositionDraft === "Use As Is" && (
                          <div className="space-y-1">
                            <Label className="text-xs font-medium">
                              Use-As-Is rationale <span className="text-destructive">*</span>
                            </Label>
                            <Textarea
                              rows={3}
                              value={useAsIsRationaleDraft}
                              onChange={(e) => setUseAsIsRationaleDraft(e.target.value)}
                              placeholder="Explain why this nonconforming material is acceptable to use/release (impact assessment, specs still met, customer approval, etc.)."
                              className="text-sm"
                            />
                            <p className="text-[10px] text-muted-foreground">
                              Required. Recorded with the Part 11 sign-off as the justification for releasing nonconforming product.
                            </p>
                          </div>
                        )}
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={saveDisposition}
                            disabled={savingDisposition || (dispositionDraft === "Use As Is" && !useAsIsRationaleDraft.trim())}
                          >
                            {savingDisposition ? "Saving…" : "Save"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingDisposition(false)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : nc?.disposition ? (
                      <>
                        {nc.disposition === "Use As Is" && (nc as unknown as { useAsIsApproverName?: string | null })?.useAsIsApproverName && (
                          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs mb-2">
                            <p className="font-semibold uppercase tracking-wide text-amber-800">
                              Use-As-Is approved (Part 11 sign-off)
                            </p>
                            <p className="mt-0.5">{(nc as unknown as { useAsIsApproverMeaning?: string | null })?.useAsIsApproverMeaning}</p>
                            {(nc as unknown as { useAsIsRationale?: string | null })?.useAsIsRationale && (
                              <p className="mt-1"><span className="font-semibold">Rationale:</span> {(nc as unknown as { useAsIsRationale?: string | null })?.useAsIsRationale}</p>
                            )}
                            <p className="text-amber-700 mt-0.5">
                              — {(nc as unknown as { useAsIsApproverName?: string | null })?.useAsIsApproverName}
                              {" ("}{(nc as unknown as { useAsIsApproverInitials?: string | null })?.useAsIsApproverInitials}{")"}
                              {(nc as unknown as { useAsIsApprovedAt?: string | null })?.useAsIsApprovedAt ? `, ${format(new Date(((nc as unknown as { useAsIsApprovedAt?: string | null }).useAsIsApprovedAt as string)), "MMM d, yyyy h:mm a")}` : ""}
                            </p>
                          </div>
                        )}
                      <p className="text-sm bg-muted/30 p-3 rounded-md">
                        {nc.disposition}
                      </p>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">
                        No disposition set. Required before closing.
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* Part 11 signature display */}
                {nc?.approvalDate && (
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
                            {nc.approvalName}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs font-medium text-muted-foreground">
                            Initials
                          </dt>
                          <dd className="mt-0.5 font-medium">
                            {nc.approvalInitials}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs font-medium text-muted-foreground">
                            Date &amp; Time
                          </dt>
                          <dd className="mt-0.5 font-medium">
                            {format(
                              new Date(nc.approvalDate),
                              "MMM d, yyyy h:mm a"
                            )}
                          </dd>
                        </div>
                      </dl>
                    </CardContent>
                  </Card>
                )}

                {/* Attachments — investigation evidence, photos, supporting
                    docs. non_conformances is allow-listed server-side. */}
                {nc && (
                  <AttachmentsPanel
                    parentTable="non_conformances"
                    parentId={nc.id}
                    allowSupplementary={!isClosed && !isCancelled}
                    currentUserId={currentUser?.id}
                    currentUserRole={currentUser?.role}
                    title="Attachments (evidence, photos, supporting docs)"
                  />
                )}
              </div>

              {/* Right: metadata + actions */}
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Details</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <dl className="space-y-4">
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Severity
                        </dt>
                        <dd className="mt-1">
                          <Badge
                            variant={
                              nc?.severity === "Critical"
                                ? "destructive"
                                : nc?.severity === "Major"
                                  ? "default"
                                  : "secondary"
                            }
                          >
                            {nc?.severity}
                          </Badge>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Source
                        </dt>
                        <dd className="mt-1 text-sm">{nc?.source}</dd>
                        {/* Session 97 (Slice 4) — the specific origin record, when linked. */}
                        {sourceInspection && (
                          <dd className="mt-1 text-sm">
                            <Link href={`/inspections/${sourceInspection.id}`} className="text-primary hover:underline font-medium">
                              {sourceInspection.inspectionNumber}
                            </Link>
                            <span className="text-muted-foreground">
                              {sourceInspection.supplierName ? ` · ${sourceInspection.supplierName}` : ""}
                              {sourceInspection.poManifestNumber ? ` · ${sourceInspection.poManifestNumber}` : ""}
                            </span>
                          </dd>
                        )}
                        {sourceComplaint && (
                          <dd className="mt-1 text-sm">
                            <Link href={`/complaints/${sourceComplaint.id}`} className="text-primary hover:underline font-medium">
                              {sourceComplaint.complaintNumber}
                            </Link>
                            <span className="text-muted-foreground">
                              {sourceComplaint.complaintType ? ` · ${sourceComplaint.complaintType}` : ""}
                            </span>
                          </dd>
                        )}
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Opened
                        </dt>
                        <dd className="mt-1 text-sm">
                          {nc?.createdAt
                            ? format(new Date(nc.createdAt), "MMM d, yyyy")
                            : "—"}
                        </dd>
                      </div>
                      {nc?.closedAt && (
                        <div>
                          <dt className="text-xs font-medium text-muted-foreground">
                            Closed
                          </dt>
                          <dd className="mt-1 text-sm">
                            {format(new Date(nc.closedAt), "MMM d, yyyy")}
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Days Open
                        </dt>
                        <dd className="mt-1 text-sm font-semibold">
                          {daysOpen}d
                          {nc?.status === "Closed" && (
                            <span className="ml-1 font-normal text-muted-foreground text-xs">
                              (closed)
                            </span>
                          )}
                        </dd>
                      </div>
                      {nc?.batchId && (
                        <div>
                          <dt className="text-xs font-medium text-muted-foreground">
                            Linked Batch
                          </dt>
                          <dd className="mt-1 text-sm">
                            <Link
                              href={`/batches/${nc.batchId}`}
                              className="text-primary hover:underline font-medium"
                            >
                              {linkedBatch?.batchNumber ?? `Batch #${nc.batchId}`}
                            </Link>
                          </dd>
                        </div>
                      )}
                    </dl>
                  </CardContent>
                </Card>

                {/* NC-8 — status is event-derived (see api lib/ncStatus). This is
                    a read-only stepper showing the current rung and what's still
                    needed to advance; there are no manual status buttons. */}
                {!isClosed && !isCancelled && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Status</CardTitle>
                      <p className="text-xs text-muted-foreground mt-1">
                        Advances automatically as the NC's work is completed — nothing to set by hand. Closing is done via the Close NC button below.
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {(() => {
                        const isHigh = nc?.severity === "Major" || nc?.severity === "Critical";
                        const ladder = isHigh
                          ? ["Open", "In Progress", "Awaiting Mgt Acknowledgement", "Under Review"]
                          : ["Open", "In Progress", "Under Review"];
                        const descOf = (s: string) => NC_STATUS_FLOW.find((f) => f.value === s)?.desc ?? "";
                        const curIdx = Math.max(0, ladder.indexOf(nc?.status ?? "Open"));
                        const blockers = (nc as unknown as { statusBlockers?: string[] })?.statusBlockers ?? [];
                        const atUnderReview = nc?.status === "Under Review";
                        return (
                          <>
                            <ol className="space-y-2">
                              {ladder.map((s, i) => {
                                const done = i < curIdx;
                                const current = i === curIdx;
                                return (
                                  <li key={s} className="flex items-start gap-2">
                                    <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${current ? "bg-primary ring-2 ring-primary/30" : done ? "bg-emerald-500" : "bg-muted-foreground/25"}`} />
                                    <div className="min-w-0">
                                      <div className={`text-sm ${current ? "font-semibold" : done ? "text-muted-foreground" : "text-muted-foreground/70"}`}>{s}</div>
                                      {current && <div className="text-[11px] text-muted-foreground leading-relaxed">{descOf(s)}</div>}
                                    </div>
                                  </li>
                                );
                              })}
                            </ol>
                            {atUnderReview ? (
                              <div className="rounded-md border border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20 p-2.5 text-xs text-emerald-800 dark:text-emerald-200">
                                All steps complete — ready to close via the Close NC button below.
                              </div>
                            ) : blockers.length > 0 ? (
                              <div className="rounded-md border bg-muted/30 p-2.5">
                                <p className="text-xs font-medium mb-1">Still needed to advance:</p>
                                <ul className="list-disc pl-4 space-y-0.5 text-xs text-muted-foreground">
                                  {blockers.map((b) => <li key={b}>{b}</li>)}
                                </ul>
                              </div>
                            ) : null}
                          </>
                        );
                      })()}
                    </CardContent>
                  </Card>
                )}

                {/* Close action */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Closure</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {isClosed ? (
                      <p className="text-sm text-muted-foreground">
                        This NC was closed on{" "}
                        {nc.closedAt
                          ? format(new Date(nc.closedAt), "MMM d, yyyy")
                          : "—"}
                        .
                      </p>
                    ) : isCancelled ? (
                      <p className="text-sm text-muted-foreground">
                        This NC is cancelled and removed from active use. An Admin can re-open it, or open a new NC.
                      </p>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground">
                          Closing requires investigation results, disposition, and an
                          electronic signature (21 CFR Part 11). A linked CAPA may remain
                          open — it carries the ongoing investigation and corrective actions.
                        </p>
                        <Button
                          className="w-full"
                          disabled={(!hasRootCause && linkedCapaTotal === 0) || !hasDisposition}
                          onClick={() => setSignatureOpen(true)}
                        >
                          Close Non-Conformance
                        </Button>
                        {((!hasRootCause && linkedCapaTotal === 0) || !hasDisposition) && (
                          <p className="text-xs text-destructive space-y-0.5">
                            {!hasRootCause && linkedCapaTotal === 0 && <span className="block">Investigation results required (or link a CAPA to investigate).</span>}
                            {!hasDisposition && <span className="block">Disposition required.</span>}
                          </p>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
              </div>
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

      {/* Promote NC → CAPA confirmation */}
      <Dialog open={promoteOpen} onOpenChange={(v) => { setPromoteOpen(v); if (!v) setCloseAfterPromote(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Open CAPA from this NC</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <p className="text-muted-foreground">
              This will create a new Corrective Action linked to <strong>{nc?.ncNumber}</strong>.
              The title, description, and root cause will be copied. Any supplementary attachments on this NC will be re-referenced on the new CAPA.
            </p>
            <p className="text-xs text-muted-foreground italic">
              You can edit all of these fields after the CAPA is created.
            </p>
            {/*
              Optional close-this-NC checkbox. Per QMS best practice we should
              not keep two quality records open for the same issue once a CAPA
              has been opened. Checking this box still requires a Part 11
              binding signature on the close — we do not skip that step.
            */}
            <label className="flex items-start gap-2 pt-2 border-t cursor-pointer select-none">
              <input
                type="checkbox"
                checked={closeAfterPromote}
                onChange={(e) => setCloseAfterPromote(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-input"
                data-testid="checkbox-close-after-promote"
              />
              <span className="text-sm">
                <span className="font-medium">Also close this NC after creating the CAPA.</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  You'll be prompted to sign with your initials (21 CFR Part 11). The CAPA carries the root-cause and preventive-action follow-up.
                </span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPromoteOpen(false)} disabled={promoting}>Cancel</Button>
            <Button onClick={handlePromoteToCapa} disabled={promoting} data-testid="button-confirm-promote">
              {promoting ? "Creating…" : closeAfterPromote ? "Create CAPA & Close NC…" : "Create CAPA"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Session 75 — Escalate NC → Field Action (auto-opens a linked CAPA) */}
      <Dialog open={escalateOpen} onOpenChange={setEscalateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Escalate to Field Action</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <p className="text-muted-foreground">
              This determines a Field Action is required for <strong>{nc?.ncNumber}</strong>. It will open a new Field Action <em>and automatically open a linked CAPA</em> — a Field Action never exists without a CAPA behind it.
            </p>
            <p className="text-xs text-muted-foreground">
              Both records are pre-filled from this NC (product, lot, description). You'll set the Field Action type and scope on the next screen.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEscalateOpen(false)} disabled={escalating}>Cancel</Button>
            <Button onClick={handleEscalateToFieldAction} disabled={escalating} data-testid="button-confirm-escalate">
              {escalating ? "Opening…" : "Open Field Action & CAPA"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Part11SignatureDialog
        open={signatureOpen}
        onOpenChange={setSignatureOpen}
        title="Close Non-Conformance"
        description="By signing, you confirm that root cause has been identified, disposition is approved, and all required corrective actions are complete. This action is irreversible (21 CFR Part 11)."
        onSign={handleSign}
        isPending={approveNC.isPending}
      />

      <Part11SignatureDialog
        open={useAsIsOpen}
        onOpenChange={setUseAsIsOpen}
        title="Use-As-Is approval"
        description="Use-As-Is requires Supervisor / Manager / Quality / Admin sign-off (Part 11). By signing, you confirm the disposition has been reviewed and the affected material is acceptable for release under documented justification."
        onSign={confirmUseAsIs}
        isPending={useAsIsBusy || savingDisposition}
      />

      {/* Session 52 — Cancel (rationale + Part 11 e-signature). */}
      <CancelRecordDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        entityLabel="Non-Conformance"
        warning={linkedCapaTotal > 0 && !allLinkedCapasDone
          ? `${linkedCapaTotal - linkedCapaClosed} linked CAPA(s) are still open. Consider closing or cancelling those separately.`
          : null}
        isPending={cancelPending}
        onConfirm={handleCancel}
      />

      {/* Session 52 — Re-open (Admin-only; Part 11 e-signature). */}
      <Part11SignatureDialog
        open={uncancelOpen}
        onOpenChange={setUncancelOpen}
        title="Re-open Non-Conformance"
        description="Re-open this cancelled NC and return it to active use. Restricted to Admin; requires an Admin signature."
        isPending={uncancelPending}
        onSign={handleUncancel}
      />
    </AppLayout>
  );
}
