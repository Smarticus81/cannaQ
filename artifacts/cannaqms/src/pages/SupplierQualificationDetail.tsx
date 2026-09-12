import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  useGetSupplierQualification,
  useUpdateSupplierQualification,
  getGetSupplierQualificationQueryKey,
  useGetCurrentUser,
} from "@workspace/api-client-react";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "wouter";
import { format, parseISO, isPast } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2, XCircle, AlertTriangle, ShieldCheck, Calendar, User, Printer,
  FileCheck2, Building2, Hash, Plus,
} from "lucide-react";

const STATUS_STYLES: Record<string, string> = {
  Open: "bg-blue-50 text-blue-700 border-blue-200",
  // Legacy statuses (Scheduled / In Progress / Pending Review) still render for
  // historical records; new records use the simplified Open → Passed/Failed set.
  Scheduled: "bg-blue-50 text-blue-700 border-blue-200",
  "In Progress": "bg-yellow-50 text-yellow-700 border-yellow-200",
  Passed: "bg-green-50 text-green-700 border-green-200",
  Failed: "bg-red-50 text-red-700 border-red-200",
  "Pending Review": "bg-orange-50 text-orange-700 border-orange-200",
  Expired: "bg-slate-100 text-slate-600 border-slate-300",
};

// SQ-1 — collapse every active/legacy pre-outcome status to a single "Open"
// label. Terminal outcomes (Passed/Failed) and Expired display as themselves.
const displayStatus = (s: string | null | undefined): string =>
  s === "Passed" || s === "Failed" || s === "Expired" ? s : "Open";

const RISK_STYLES: Record<string, string> = {
  Low: "bg-green-50 text-green-700 border-green-200",
  Medium: "bg-yellow-50 text-yellow-700 border-yellow-200",
  High: "bg-orange-50 text-orange-700 border-orange-200",
  Critical: "bg-red-50 text-red-700 border-red-200",
};

const RISK_LEVELS = ["Low", "Medium", "High", "Critical"];

// SQ-Certificates — a record's effective kind. New records carry recordType;
// legacy rows (recordType null) are inferred from audit signals so their history
// still renders with the full audit layout.
function effectiveRecordType(
  q?: {
    recordType?: string | null;
    score?: number | null;
    findings?: string | null;
    correctiveActionsRequired?: string | null;
    status?: string | null;
  } | null,
): "Certificate" | "Audit" {
  if (!q) return "Certificate";
  if (q.recordType === "Certificate" || q.recordType === "Audit") return q.recordType;
  if (
    q.score != null ||
    (q.findings && q.findings.trim()) ||
    (q.correctiveActionsRequired && q.correctiveActionsRequired.trim()) ||
    q.status === "Passed" ||
    q.status === "Failed"
  ) {
    return "Audit";
  }
  return "Certificate";
}

function badge(label: string, cls: string) {
  return <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border ${cls}`}>{label}</span>;
}

// 2026-08-10 — a correction is a tracked open-action: text + a supplier-committed
// date + a completion date. No completion date = still OPEN, which blocks Pass
// and a Closure date. Legacy rows stored plain strings; normalize handles both.
type Correction = { text: string; committedDate?: string | null; completedDate?: string | null };

function normalizeCorrections(raw: unknown): Correction[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c): Correction => {
      if (typeof c === "string") return { text: c, committedDate: null, completedDate: null };
      if (c && typeof c === "object") {
        const o = c as Record<string, unknown>;
        return {
          text: typeof o.text === "string" ? o.text : "",
          committedDate: typeof o.committedDate === "string" && o.committedDate ? o.committedDate : null,
          completedDate: typeof o.completedDate === "string" && o.completedDate ? o.completedDate : null,
        };
      }
      return { text: "", committedDate: null, completedDate: null };
    })
    .filter((c) => c.text.trim() !== "");
}
const isCorrectionOpen = (c: Correction): boolean => !c.completedDate;
// Local YYYY-MM-DD (date-only convention) for overdue/late comparisons by string.
const todayISO = (): string => new Date().toLocaleDateString("en-CA");

// Best-effort extraction of an API error message from the thrown error, whatever
// its shape (fetch body, axios-style response.data, or a plain Error) — used to
// surface the server-side open-corrections gate message to the user.
function serverError(e: unknown): string | undefined {
  if (!e || typeof e !== "object") return typeof e === "string" ? e : undefined;
  const anyE = e as {
    response?: { data?: { error?: unknown } };
    data?: { error?: unknown };
    error?: unknown;
    message?: unknown;
  };
  const candidates = [anyE.response?.data?.error, anyE.data?.error, anyE.error, anyE.message];
  for (const c of candidates) if (typeof c === "string" && c.trim()) return c;
  return undefined;
}

export default function SupplierQualificationDetail(props: { params?: { id: string } }) {
  const id = parseInt(props.params?.id ?? "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: qual, isLoading } = useGetSupplierQualification(id);
  const updateQual = useUpdateSupplierQualification();
  const { data: currentUser } = useGetCurrentUser();

  // Audit Observations (stored in `findings`).
  const [editingFindings, setEditingFindings] = useState(false);
  const [findingsDraft, setFindingsDraft] = useState("");
  const [savingFindings, setSavingFindings] = useState(false);

  // Outcome sign-off (Quality + Manager awareness).
  const [signingSlot, setSigningSlot] = useState<"quality" | "manager" | null>(null);
  const [signInitials, setSignInitials] = useState("");
  const [savingSign, setSavingSign] = useState(false);

  // Assessment Details: date, assessor, reason for audit.
  const [editingAssessment, setEditingAssessment] = useState(false);
  const [assessmentDate, setAssessmentDate] = useState("");
  const [assessorDraft, setAssessorDraft] = useState("");
  const [auditReasonDraft, setAuditReasonDraft] = useState("");
  const [savingAssessment, setSavingAssessment] = useState(false);

  // Corrections: individual open-actions (text + committed + completed dates),
  // or a rationale when none are required.
  const [editingCorrections, setEditingCorrections] = useState(false);
  const [correctionsDraft, setCorrectionsDraft] = useState<Correction[]>([]);
  const [correctionsRationaleDraft, setCorrectionsRationaleDraft] = useState("");
  const [savingCorrections, setSavingCorrections] = useState(false);

  // Closure: verification note (may include score rationale), score, dates.
  const [editingClosure, setEditingClosure] = useState(false);
  const [closureVerificationDraft, setClosureVerificationDraft] = useState("");
  const [scoreInput, setScoreInput] = useState("");
  const [closureDate, setClosureDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [savingClosure, setSavingClosure] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getGetSupplierQualificationQueryKey(id) });

  const setStatus = async (status: string) => {
    try {
      const extra =
        status === "Passed"
          ? { approvalDate: new Date().toLocaleDateString("en-CA"), approvedByName: (currentUser as { fullName?: string } | undefined)?.fullName ?? undefined }
          : {};
      await updateQual.mutateAsync({ id, data: { status, ...extra } as never });
      invalidate();
      toast({ title: "Outcome recorded", description: `Marked ${status}.` });
    } catch (e) {
      // Surface the server's message (e.g. the open-corrections gate) when present.
      toast({ title: "Couldn't record outcome", description: serverError(e) ?? "Failed to update.", variant: "destructive" });
    }
  };

  const submitSign = async () => {
    if (!signingSlot || !signInitials.trim()) return;
    setSavingSign(true);
    try {
      const resp = await fetch(`/api/supplier-qualifications/${id}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ slot: signingSlot, initials: signInitials.trim() }),
      });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({})))?.error ?? "Sign-off failed");
      invalidate();
      setSigningSlot(null);
      setSignInitials("");
      toast({ title: "Signed", description: "Outcome sign-off recorded." });
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed", variant: "destructive" });
    } finally { setSavingSign(false); }
  };

  const saveFindings = async () => {
    setSavingFindings(true);
    try {
      await updateQual.mutateAsync({ id, data: { findings: findingsDraft } as never });
      invalidate();
      setEditingFindings(false);
      toast({ title: "Saved", description: "Audit observations updated." });
    } catch {
      toast({ title: "Error", variant: "destructive" });
    } finally { setSavingFindings(false); }
  };

  const saveAssessment = async () => {
    setSavingAssessment(true);
    try {
      await updateQual.mutateAsync({
        id,
        data: {
          assessmentDate: assessmentDate || undefined,
          assessorName: assessorDraft || undefined,
          auditReason: auditReasonDraft || undefined,
        } as never,
      });
      invalidate();
      setEditingAssessment(false);
      toast({ title: "Saved", description: "Assessment details updated." });
    } catch {
      toast({ title: "Error", variant: "destructive" });
    } finally { setSavingAssessment(false); }
  };

  const saveCorrections = async () => {
    setSavingCorrections(true);
    try {
      // Keep only rows with text; trim text and blank dates to null.
      const cleaned: Correction[] = correctionsDraft
        .map((c) => ({
          text: c.text.trim(),
          committedDate: c.committedDate || null,
          completedDate: c.completedDate || null,
        }))
        .filter((c) => c.text !== "");
      const wasPassed = qual?.status === "Passed";
      const result = await updateQual.mutateAsync({
        id,
        data: {
          corrections: cleaned,
          correctionsRationale: cleaned.length === 0 ? (correctionsRationaleDraft || null) : null,
        } as never,
      });
      invalidate();
      setEditingCorrections(false);
      // If saving reopened an action on a Passed audit, the server auto-reverts
      // it to Open and clears the Pass — say so rather than a bland "Saved".
      const reverted = wasPassed && (result as { status?: string } | undefined)?.status === "Open";
      if (reverted) {
        toast({ title: "Audit reopened", description: "A correction was reopened, so this audit returned to Open and the Pass was cleared. Complete the correction and record Pass again." });
      } else {
        toast({ title: "Saved", description: "Corrections updated." });
      }
    } catch (e) {
      toast({ title: "Error", description: serverError(e) ?? "Failed to save corrections.", variant: "destructive" });
    } finally { setSavingCorrections(false); }
  };

  const saveClosure = async () => {
    setSavingClosure(true);
    try {
      // Don't set a closure date while any correction is still open (backstops
      // the disabled input; server enforces this too).
      const openNow = normalizeCorrections((qual as { corrections?: unknown } | undefined)?.corrections).some(isCorrectionOpen);
      await updateQual.mutateAsync({
        id,
        data: {
          closureVerification: closureVerificationDraft || undefined,
          score: scoreInput ? parseInt(scoreInput) : undefined,
          closureDate: openNow ? undefined : (closureDate || undefined),
          expiryDate: expiryDate || undefined,
        } as never,
      });
      invalidate();
      setEditingClosure(false);
      toast({ title: "Saved", description: "Closure details updated." });
    } catch (e) {
      toast({ title: "Couldn't save closure", description: serverError(e) ?? "Failed to save closure details.", variant: "destructive" });
    } finally { setSavingClosure(false); }
  };

  const expired =
    qual?.expiryDate && qual.status !== "Failed" && isPast(parseISO(qual.expiryDate));

  // Audit-flow fields not yet in the generated client type.
  const qx = (qual ?? {}) as {
    auditReason?: string | null;
    corrections?: unknown;
    correctionsRationale?: string | null;
    closureVerification?: string | null;
    closureDate?: string | null;
    qualitySignedName?: string | null;
    qualitySignedInitials?: string | null;
    qualitySignedAt?: string | null;
    managerSignedName?: string | null;
    managerSignedInitials?: string | null;
    managerSignedAt?: string | null;
  };
  const myRole = currentUser?.role ?? "";
  const canSignQuality = myRole === "Quality" || myRole === "Admin";
  const canSignManager = myRole === "Manager" || myRole === "Admin";

  // Corrections as tracked open-actions. An open correction (no completion date)
  // blocks recording Pass and setting a Closure date.
  const correctionsList = normalizeCorrections(qx.corrections);
  const openCorrections = correctionsList.filter(isCorrectionOpen);
  const hasOpenCorrections = openCorrections.length > 0;
  const openCorrectionsMsg = `${openCorrections.length} correction${openCorrections.length === 1 ? " is" : "s are"} still open — add a Date Completed to ${openCorrections.length === 1 ? "it" : "each"} before recording Pass or setting a closure date.`;

  // SQ-Certificates — a Certificate record hides all audit machinery (Pass/Fail,
  // score, findings, corrective actions, risk) and reads as a document on file.
  const recordType = effectiveRecordType(qual);
  const isCertificate = recordType === "Certificate";
  const certIssuer = (qual as { issuer?: string | null } | undefined)?.issuer ?? null;
  const certNumber = (qual as { certificateNumber?: string | null } | undefined)?.certificateNumber ?? null;
  // A certificate isn't Passed/Failed — its standing is Active until it expires.
  const certStatusLabel = expired ? "Expired" : "Active";
  const certStatusCls = expired
    ? "bg-red-50 text-red-700 border-red-200"
    : "bg-green-50 text-green-700 border-green-200";

  return (
    <AppLayout>
      <div className="space-y-6 max-w-4xl mx-auto pb-12 print:max-w-none">
        {/* Print-only header */}
        <div className="hidden print:block border-b-2 border-black pb-4 mb-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">CannaQ · Supplier {isCertificate ? "Certificate" : "Qualification"}</p>
              <h1 className="text-2xl font-bold font-mono">{qual?.qualNumber}</h1>
              <p className="text-base text-gray-600">{qual?.supplierName} — {qual?.qualificationType}</p>
            </div>
            <div className="text-right text-xs text-gray-500 space-y-1">
              <p>Status: <strong>{isCertificate ? certStatusLabel : displayStatus(qual?.status)}</strong></p>
              {isCertificate ? (
                certIssuer && <p>Issuer: <strong>{certIssuer}</strong></p>
              ) : (
                <p>Risk: <strong>{qual?.riskLevel}</strong></p>
              )}
              <p>Printed: {format(new Date(), "MMMM d, yyyy")}</p>
            </div>
          </div>
        </div>

        {/* Screen-only header */}
        <div className="print:hidden">
          <Link href="/supplier-qualification" className="text-sm text-primary hover:underline mb-2 block">
            ← Back to Supplier Qualification
          </Link>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight font-mono">
                {isLoading ? <Skeleton className="h-8 w-36" /> : qual?.qualNumber}
              </h1>
              <p className="text-muted-foreground text-sm mt-0.5">
                {isLoading ? <Skeleton className="h-4 w-48" /> : (
                  <><span className="font-medium text-foreground">{qual?.supplierName}</span>{" — "}{qual?.qualificationType}</>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-1.5">
                <Printer className="h-4 w-4" /> Print
              </Button>
              {qual && (isCertificate
                ? badge(certStatusLabel, certStatusCls)
                : badge(displayStatus(qual.status), STATUS_STYLES[displayStatus(qual.status)] ?? "bg-gray-100 text-gray-600 border-gray-200"))}
            </div>
          </div>
        </div>

        {/* Expiry banner */}
        {!isLoading && expired && (
          <div className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-red-600" />
            <div>
              <p className="font-semibold text-sm">Qualification Expired</p>
              <p className="text-xs mt-0.5">
                This qualification expired {qual?.expiryDate ? format(parseISO(qual.expiryDate), "MMMM d, yyyy") : ""}. Schedule a re-qualification to maintain approved supplier status.
              </p>
            </div>
          </div>
        )}

        {/* Summary bar */}
        {qual && (isCertificate ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg border p-3 text-center bg-muted/30">
              <div className="flex items-center justify-center gap-1 mb-1">
                <FileCheck2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Type</span>
              </div>
              <p className="text-sm font-bold truncate">{qual.qualificationType}</p>
            </div>
            <div className="rounded-lg border p-3 text-center bg-muted/30">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Issuer</span>
              </div>
              <p className="text-sm font-bold truncate">{certIssuer ?? "—"}</p>
            </div>
            <div className="rounded-lg border p-3 text-center bg-muted/30">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cert / License #</span>
              </div>
              <p className="text-sm font-bold font-mono truncate">{certNumber ?? "—"}</p>
            </div>
            <div className={`rounded-lg border p-3 text-center ${expired ? "bg-red-50 border-red-200" : "bg-muted/30"}`}>
              <div className="flex items-center justify-center gap-1 mb-1">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Expiry</span>
              </div>
              <p className={`text-sm font-bold ${expired ? "text-red-700" : ""}`}>
                {qual.expiryDate ? format(parseISO(qual.expiryDate), "MMM d, yyyy") : "—"}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg border p-3 text-center bg-muted/30">
              <div className="flex items-center justify-center gap-1 mb-1">
                <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Risk</span>
              </div>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold border ${RISK_STYLES[qual.riskLevel] ?? ""}`}>
                {qual.riskLevel}
              </span>
            </div>
            <div className="rounded-lg border p-3 text-center bg-muted/30">
              <div className="flex items-center justify-center gap-1 mb-1">
                <User className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Assessor</span>
              </div>
              <p className="text-sm font-bold truncate">{qual.assessorName ?? "—"}</p>
            </div>
            <div className="rounded-lg border p-3 text-center bg-muted/30">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Assessed</span>
              </div>
              <p className="text-sm font-bold">
                {qual.assessmentDate ? format(parseISO(qual.assessmentDate), "MMM d, yyyy") : "—"}
              </p>
            </div>
            <div className={`rounded-lg border p-3 text-center ${expired ? "bg-red-50 border-red-200" : qual.status === "Passed" ? "bg-green-50 border-green-200" : "bg-muted/30"}`}>
              <div className="flex items-center justify-center gap-1 mb-1">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Expiry</span>
              </div>
              <p className={`text-sm font-bold ${expired ? "text-red-700" : ""}`}>
                {qual.expiryDate ? format(parseISO(qual.expiryDate), "MMM d, yyyy") : "—"}
              </p>
            </div>
          </div>
        ))}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Left */}
          <div className="md:col-span-2 space-y-6">
            {/* Status workflow — audit records only. A Certificate isn't
                Passed/Failed, so it has no outcome step. */}
            {!isCertificate && qual && qual.status !== "Passed" && qual.status !== "Failed" && (
              <Card className="border-primary/20 bg-primary/5 print:hidden">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Record Outcome</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Complete the sections below, then mark the outcome.
                  </p>
                  {/* SQ-2 — lighter outline styling (was solid default/destructive)
                      so the Pass/Fail actions read clearly by color without the dark
                      fills that "invited pressing." The card itself only appears while
                      the qual is open and disappears once an outcome is recorded, so
                      "which was pressed" is already unambiguous (SQ-1). */}
                  <div className="flex gap-2 flex-wrap">
                    <Button size="sm" variant="outline" disabled={hasOpenCorrections} className="border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50" onClick={() => setStatus("Passed")}>
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                      Record Pass
                    </Button>
                    <Button size="sm" variant="outline" className="border-red-300 text-red-700 hover:bg-red-50" onClick={() => setStatus("Failed")}>
                      <XCircle className="h-3.5 w-3.5 mr-1" />
                      Record Fail
                    </Button>
                  </div>
                  {hasOpenCorrections && (
                    <p className="flex items-start gap-1.5 text-xs text-amber-700">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      {openCorrectionsMsg}
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Certificate details — certificate records only. Read-only view of
                the document metadata; a renewal is a new record, not an edit. */}
            {isCertificate && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Certificate Details</CardTitle>
                </CardHeader>
                <CardContent className="pt-2">
                  <dl className="grid grid-cols-2 gap-4">
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Certificate Type</dt>
                      <dd className="mt-0.5 text-sm">{qual?.qualificationType ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Issuer</dt>
                      <dd className="mt-0.5 text-sm">{certIssuer ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Certificate / License #</dt>
                      <dd className="mt-0.5 text-sm font-mono">{certNumber ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Expiry Date</dt>
                      <dd className={`mt-0.5 text-sm ${expired ? "text-red-700 font-semibold" : ""}`}>
                        {qual?.expiryDate ? format(parseISO(qual.expiryDate), "MMM d, yyyy") : "—"}
                      </dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            )}

            {/* Assessment Details — audit records only: date, assessor, reason. */}
            {!isCertificate && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base">Assessment Details</CardTitle>
                {!editingAssessment && (
                  <Button variant="outline" size="sm" className="print:hidden" onClick={() => {
                    setAssessmentDate(qual?.assessmentDate ?? "");
                    setAssessorDraft(qual?.assessorName ?? "");
                    setAuditReasonDraft(qx.auditReason ?? "");
                    setEditingAssessment(true);
                  }}>Edit</Button>
                )}
              </CardHeader>
              <CardContent className="pt-2">
                {editingAssessment ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Date</label>
                        <Input type="date" value={assessmentDate} onChange={(e) => setAssessmentDate(e.target.value)} className="text-sm" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Assessor</label>
                        <Input value={assessorDraft} onChange={(e) => setAssessorDraft(e.target.value)} className="text-sm" placeholder="Lead assessor" />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Reason for audit</label>
                      <Textarea value={auditReasonDraft} onChange={(e) => setAuditReasonDraft(e.target.value)} rows={2} className="text-sm" placeholder="Why this audit is being conducted (scheduled requalification, for-cause, new supplier approval…)" />
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveAssessment} disabled={savingAssessment}>{savingAssessment ? "Saving…" : "Save"}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingAssessment(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <dl className="space-y-3">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Date</dt>
                        <dd className="mt-0.5 text-sm">{qual?.assessmentDate ? format(parseISO(qual.assessmentDate), "MMM d, yyyy") : "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Assessor</dt>
                        <dd className="mt-0.5 text-sm">{qual?.assessorName ?? "—"}</dd>
                      </div>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Reason for audit</dt>
                      <dd className="mt-0.5 text-sm whitespace-pre-wrap">{qx.auditReason ? qx.auditReason : "—"}</dd>
                    </div>
                  </dl>
                )}
              </CardContent>
            </Card>
            )}

            {/* Audit Observations — audit records only (stored in `findings`). */}
            {!isCertificate && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base">Audit Observations</CardTitle>
                {!editingFindings && (
                  <Button variant="outline" size="sm" className="print:hidden" onClick={() => {
                    setFindingsDraft(qual?.findings ?? "");
                    setEditingFindings(true);
                  }}>
                    {qual?.findings ? "Edit" : "Add Observations"}
                  </Button>
                )}
              </CardHeader>
              <CardContent className="pt-2 space-y-3">
                <p className="text-xs text-muted-foreground">
                  Document what products / processes have been reviewed, and found conforming and non-conforming.
                </p>
                {editingFindings ? (
                  <div className="space-y-3">
                    <Textarea value={findingsDraft} onChange={(e) => setFindingsDraft(e.target.value)} rows={5} className="text-sm" placeholder="Products / processes reviewed; what was found conforming and non-conforming…" />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveFindings} disabled={savingFindings}>{savingFindings ? "Saving…" : "Save"}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingFindings(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  qual?.findings ? (
                    <p className="text-sm bg-muted/30 p-3 rounded-md whitespace-pre-wrap">{qual.findings}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">No observations recorded yet.</p>
                  )
                )}
              </CardContent>
            </Card>
            )}

            {/* Corrections — audit records only. Minor fixes listed individually,
                or a rationale when none are required. Corrective actions (CAPAs)
                are the supplier's, tracked on their side. */}
            {!isCertificate && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base">Corrections</CardTitle>
                {!editingCorrections && (
                  <Button variant="outline" size="sm" className="print:hidden" onClick={() => {
                    setCorrectionsDraft(correctionsList.length > 0 ? correctionsList.map((c) => ({ ...c })) : [{ text: "", committedDate: null, completedDate: null }]);
                    setCorrectionsRationaleDraft(qx.correctionsRationale ?? "");
                    setEditingCorrections(true);
                  }}>Edit</Button>
                )}
              </CardHeader>
              <CardContent className="pt-2 space-y-3">
                <p className="text-xs text-muted-foreground">
                  List any corrections individually, with the date the supplier committed to and the date each was completed. A correction with no completion date stays open and blocks Pass / closure. If no corrective action is required, record a short rationale instead — corrective actions (CAPAs) are owned by the supplier.
                </p>
                {editingCorrections ? (
                  <div className="space-y-3">
                    <div className="space-y-3">
                      {correctionsDraft.map((c, i) => (
                        <div key={i} className="flex items-start gap-2 rounded-md border p-2">
                          <span className="text-xs text-muted-foreground w-5 text-right mt-2">{i + 1}.</span>
                          <div className="flex-1 space-y-2">
                            <Input value={c.text} onChange={(e) => setCorrectionsDraft((prev) => prev.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} className="text-sm" placeholder="Correction…" />
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground block mb-0.5">Committed date</label>
                                <Input type="date" value={c.committedDate ?? ""} onChange={(e) => setCorrectionsDraft((prev) => prev.map((x, j) => (j === i ? { ...x, committedDate: e.target.value || null } : x)))} className="text-sm" />
                              </div>
                              <div>
                                <label className="text-[11px] font-medium text-muted-foreground block mb-0.5">Date completed</label>
                                <Input type="date" value={c.completedDate ?? ""} onChange={(e) => setCorrectionsDraft((prev) => prev.map((x, j) => (j === i ? { ...x, completedDate: e.target.value || null } : x)))} className="text-sm" />
                              </div>
                            </div>
                          </div>
                          <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => setCorrectionsDraft((prev) => prev.filter((_, j) => j !== i))}>
                            <XCircle className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </div>
                      ))}
                      <Button size="sm" variant="outline" className="h-7" onClick={() => setCorrectionsDraft((prev) => [...prev, { text: "", committedDate: null, completedDate: null }])}>
                        <Plus className="h-3.5 w-3.5 mr-1" /> Add correction
                      </Button>
                    </div>
                    {correctionsDraft.filter((c) => c.text.trim()).length === 0 && (
                      <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1">No corrections required — rationale</label>
                        <Textarea value={correctionsRationaleDraft} onChange={(e) => setCorrectionsRationaleDraft(e.target.value)} rows={2} className="text-sm" placeholder="Why no corrections are required…" />
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveCorrections} disabled={savingCorrections}>{savingCorrections ? "Saving…" : "Save"}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingCorrections(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  correctionsList.length > 0 ? (
                    <ol className="text-sm space-y-1.5">
                      {correctionsList.map((c, i) => {
                        const open = isCorrectionOpen(c);
                        const overdue = open && !!c.committedDate && c.committedDate < todayISO();
                        const late = !open && !!c.committedDate && !!c.completedDate && c.completedDate > c.committedDate;
                        return (
                          <li key={i} className="bg-muted/30 px-3 py-2 rounded-md">
                            <div className="flex items-start justify-between gap-3">
                              <span className="flex-1"><span className="text-muted-foreground mr-1">{i + 1}.</span>{c.text}</span>
                              {open ? (
                                <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${overdue ? "bg-red-50 text-red-700 border-red-200" : "bg-amber-50 text-amber-700 border-amber-200"}`}>
                                  {overdue ? "Overdue" : "Open"}
                                </span>
                              ) : (
                                <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${late ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"}`}>
                                  <CheckCircle2 className="h-3 w-3" />{late ? "Completed late" : "Completed"}
                                </span>
                              )}
                            </div>
                            {(c.committedDate || c.completedDate) && (
                              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
                                {c.committedDate && <span>Committed: {format(parseISO(c.committedDate), "MMM d, yyyy")}</span>}
                                {c.completedDate && <span>Completed: {format(parseISO(c.completedDate), "MMM d, yyyy")}</span>}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  ) : qx.correctionsRationale ? (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">No corrections required</p>
                      <p className="text-sm bg-muted/30 p-3 rounded-md whitespace-pre-wrap">{qx.correctionsRationale}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">No corrections recorded yet.</p>
                  )
                )}
              </CardContent>
            </Card>
            )}

            {/* Closure — audit records only: completion verification, score, dates. */}
            {!isCertificate && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base">Closure</CardTitle>
                {!editingClosure && (
                  <Button variant="outline" size="sm" className="print:hidden" onClick={() => {
                    setClosureVerificationDraft(qx.closureVerification ?? "");
                    setScoreInput(qual?.score !== null && qual?.score !== undefined ? String(qual.score) : "");
                    setClosureDate(qx.closureDate ?? "");
                    setExpiryDate(qual?.expiryDate ?? "");
                    setEditingClosure(true);
                  }}>Edit</Button>
                )}
              </CardHeader>
              <CardContent className="pt-2">
                {editingClosure ? (
                  <div className="space-y-3">
                    {hasOpenCorrections && (
                      <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        {openCorrectionsMsg} You can still record the verification note and score.
                      </p>
                    )}
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Closure verification</label>
                      <Textarea value={closureVerificationDraft} onChange={(e) => setClosureVerificationDraft(e.target.value)} rows={3} className="text-sm" placeholder="Confirm corrections were completed and verified; you can include the score rationale here…" />
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Score (%)</label>
                        <Input type="number" min={0} max={100} value={scoreInput} onChange={(e) => setScoreInput(e.target.value)} className="text-sm" placeholder="e.g. 87" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Closure date</label>
                        <Input type="date" value={closureDate} disabled={hasOpenCorrections} onChange={(e) => setClosureDate(e.target.value)} className="text-sm disabled:opacity-50" />
                        {hasOpenCorrections && <p className="text-[11px] text-amber-700 mt-0.5">Locked until corrections are completed.</p>}
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Valid until (expiry)</label>
                        <Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} className="text-sm" />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveClosure} disabled={savingClosure}>{savingClosure ? "Saving…" : "Save"}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingClosure(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <dl className="space-y-3">
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Closure verification</dt>
                      <dd className="mt-0.5 text-sm whitespace-pre-wrap">{qx.closureVerification ? qx.closureVerification : <span className="italic text-muted-foreground">Not verified yet.</span>}</dd>
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Score</dt>
                        <dd className="mt-0.5 text-sm font-semibold">{qual?.score !== null && qual?.score !== undefined ? `${qual.score}%` : "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Closure date</dt>
                        <dd className="mt-0.5 text-sm">{qx.closureDate ? format(parseISO(qx.closureDate), "MMM d, yyyy") : "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Valid until</dt>
                        <dd className={`mt-0.5 text-sm ${expired ? "text-red-700 font-semibold" : ""}`}>{qual?.expiryDate ? format(parseISO(qual.expiryDate), "MMM d, yyyy") : "—"}</dd>
                      </div>
                    </div>
                  </dl>
                )}
              </CardContent>
            </Card>
            )}

            {/* Outcome sign-off — Quality + Manager confirm awareness of the
                audit outcome. Lightweight, role-gated per slot. */}
            {!isCertificate && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Outcome Sign-off</CardTitle>
              </CardHeader>
              <CardContent className="pt-2 space-y-3">
                <p className="text-xs text-muted-foreground">
                  Quality and Manager confirm they are aware of the audit outcome.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Quality</p>
                    {qx.qualitySignedAt ? (
                      <p className="text-sm">
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-medium"><CheckCircle2 className="h-3.5 w-3.5" />{qx.qualitySignedName}</span>
                        {qx.qualitySignedInitials ? <span className="text-muted-foreground"> · {qx.qualitySignedInitials}</span> : null}
                        <span className="block text-xs text-muted-foreground">{format(new Date(qx.qualitySignedAt), "MMM d, yyyy h:mm a")}</span>
                      </p>
                    ) : signingSlot === "quality" ? (
                      <div className="space-y-2">
                        <Input value={signInitials} onChange={(e) => setSignInitials(e.target.value)} placeholder="Your initials" className="text-sm h-8" />
                        <div className="flex gap-2">
                          <Button size="sm" className="h-7" onClick={submitSign} disabled={savingSign || !signInitials.trim()}>{savingSign ? "…" : "Confirm"}</Button>
                          <Button size="sm" variant="ghost" className="h-7" onClick={() => { setSigningSlot(null); setSignInitials(""); }}>Cancel</Button>
                        </div>
                      </div>
                    ) : canSignQuality ? (
                      <Button size="sm" variant="outline" className="h-7" onClick={() => { setSigningSlot("quality"); setSignInitials(""); }}>
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Sign as Quality
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">Awaiting Quality sign-off.</p>
                    )}
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Manager</p>
                    {qx.managerSignedAt ? (
                      <p className="text-sm">
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-medium"><CheckCircle2 className="h-3.5 w-3.5" />{qx.managerSignedName}</span>
                        {qx.managerSignedInitials ? <span className="text-muted-foreground"> · {qx.managerSignedInitials}</span> : null}
                        <span className="block text-xs text-muted-foreground">{format(new Date(qx.managerSignedAt), "MMM d, yyyy h:mm a")}</span>
                      </p>
                    ) : signingSlot === "manager" ? (
                      <div className="space-y-2">
                        <Input value={signInitials} onChange={(e) => setSignInitials(e.target.value)} placeholder="Your initials" className="text-sm h-8" />
                        <div className="flex gap-2">
                          <Button size="sm" className="h-7" onClick={submitSign} disabled={savingSign || !signInitials.trim()}>{savingSign ? "…" : "Confirm"}</Button>
                          <Button size="sm" variant="ghost" className="h-7" onClick={() => { setSigningSlot(null); setSignInitials(""); }}>Cancel</Button>
                        </div>
                      </div>
                    ) : canSignManager ? (
                      <Button size="sm" variant="outline" className="h-7" onClick={() => { setSigningSlot("manager"); setSignInitials(""); }}>
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Sign as Manager
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">Awaiting Manager sign-off.</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
            )}

            {/* Attachments — polymorphic. For a certificate this is the actual
                certificate file (always attachable). For an audit it's the audit
                evidence, locked once the qual reaches a terminal state. */}
            {qual && (
              <AttachmentsPanel
                parentTable="supplier_qualifications"
                parentId={qual.id}
                showPrimarySlot={false}
                allowSupplementary={isCertificate || (qual.status !== "Passed" && qual.status !== "Failed")}
                currentUserId={currentUser?.id}
                currentUserRole={currentUser?.role}
                title={isCertificate ? "Certificate File" : "Audit Evidence & Certifications"}
              />
            )}
          </div>

          {/* Right sidebar */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Record Details</CardTitle>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="space-y-3">{Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-4 w-full" />)}</div>
                ) : (
                  <dl className="space-y-3">
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Qual #</dt>
                      <dd className="mt-0.5 text-sm font-mono font-semibold">{qual?.qualNumber}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Supplier</dt>
                      <dd className="mt-0.5 text-sm font-medium">
                        <Link href={`/suppliers/${qual?.supplierId}`} className="text-primary hover:underline">
                          {qual?.supplierName}
                        </Link>
                      </dd>
                      <dd className="text-xs text-muted-foreground">{qual?.supplierType}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Record Type</dt>
                      <dd className="mt-0.5 text-sm">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${isCertificate ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-purple-50 text-purple-700 border-purple-200"}`}>
                          {isCertificate ? <FileCheck2 className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
                          {isCertificate ? "Certificate" : "Audit"}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">{isCertificate ? "Certificate Type" : "Qualification Type"}</dt>
                      <dd className="mt-0.5 text-sm">{qual?.qualificationType}</dd>
                    </div>
                    {/* Session 97 (#11) — certificate metadata, shown when captured. */}
                    {(qual as { issuer?: string | null })?.issuer && (
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Issuer</dt>
                        <dd className="mt-0.5 text-sm">{(qual as { issuer?: string | null }).issuer}</dd>
                      </div>
                    )}
                    {(qual as { certificateNumber?: string | null })?.certificateNumber && (
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Certificate / License #</dt>
                        <dd className="mt-0.5 text-sm font-mono">{(qual as { certificateNumber?: string | null }).certificateNumber}</dd>
                      </div>
                    )}
                    {!isCertificate && (
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Risk Level</dt>
                        <dd className="mt-0.5">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${RISK_STYLES[qual?.riskLevel ?? ""] ?? ""}`}>
                            {qual?.riskLevel}
                          </span>
                        </dd>
                      </div>
                    )}
                    {qual?.approvedByName && (
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Approved By</dt>
                        <dd className="mt-0.5 text-sm">{qual.approvedByName}</dd>
                        {qual.approvalDate && (
                          <dd className="text-xs text-muted-foreground">
                            {format(parseISO(qual.approvalDate), "MMM d, yyyy")}
                          </dd>
                        )}
                      </div>
                    )}
                    {qual?.notes && (
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Notes</dt>
                        <dd className="mt-0.5 text-sm text-muted-foreground">{qual.notes}</dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Created</dt>
                      <dd className="mt-0.5 text-sm text-muted-foreground">
                        {qual?.createdAt ? format(new Date(qual.createdAt), "MMM d, yyyy") : "—"}
                      </dd>
                    </div>
                  </dl>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
