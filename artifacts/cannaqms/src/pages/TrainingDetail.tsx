import { useState, useEffect } from "react";
import {
  useGetTrainingRecord,
  useUpdateTrainingRecord,
  useGetCurrentUser,
  getGetTrainingRecordQueryKey,
} from "@workspace/api-client-react";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { format, parseISO, isPast } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  AlertTriangle,
  Clock,
  XCircle,
  GraduationCap,
  FileText,
  User,
  Calendar,
  Printer,
} from "lucide-react";

const STATUS_STYLES: Record<string, string> = {
  Assigned: "bg-blue-50 text-blue-700 border-blue-200",
  "In Progress": "bg-yellow-50 text-yellow-700 border-yellow-200",
  Completed: "bg-green-50 text-green-700 border-green-200",
  Overdue: "bg-red-50 text-red-700 border-red-200",
  Waived: "bg-slate-100 text-slate-600 border-slate-300",
};

function statusBadge(status: string) {
  return (
    <span
      className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border ${STATUS_STYLES[status] ?? "bg-gray-100 text-gray-600"}`}
    >
      {status}
    </span>
  );
}

export default function TrainingDetail(props: { params?: { id: string } }) {
  const id = parseInt(props.params?.id ?? "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: record, isLoading } = useGetTrainingRecord(id);
  const { data: currentUser } = useGetCurrentUser();
  const updateRecord = useUpdateTrainingRecord();
  const [signOpen, setSignOpen] = useState(false);
  const [signing, setSigning] = useState(false);
  const [scoreForSig, setScoreForSig] = useState<string>("");
  const [trainerSignOpen, setTrainerSignOpen] = useState(false);
  const [trainerSigning, setTrainerSigning] = useState(false);

  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);

  // The attachments of the document being trained on — surfaced as one-click links so
  // an auditor doesn't have to go hunt for them.
  const [docAttachments, setDocAttachments] = useState<{ id: number; fileName: string; objectPath: string; status: string }[]>([]);
  useEffect(() => {
    const docId = record?.documentId;
    if (!docId) { setDocAttachments([]); return; }
    let cancelled = false;
    const base = (import.meta.env.BASE_URL ?? "/") as string;
    fetch(`${base}api/attachments?parentTable=documents&parentId=${docId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        if (cancelled) return;
        setDocAttachments((Array.isArray(list) ? list : []).filter((a) => a.status === "Active"));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [record?.documentId]);


  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getGetTrainingRecordQueryKey(id) });

  const isCompleted = record?.status === "Completed";
  const isWaived = record?.status === "Waived";
  const isOverdue =
    record?.status === "Overdue" ||
    (record?.dueDate &&
      !isCompleted &&
      !isWaived &&
      isPast(parseISO(record.dueDate)));

  const saveNotes = async () => {
    setSavingNotes(true);
    try {
      await updateRecord.mutateAsync({ id, data: { notes: notesDraft } });
      invalidate();
      setEditingNotes(false);
      toast({ title: "Saved", description: "Notes updated." });
    } catch {
      toast({ title: "Error", description: "Failed to save.", variant: "destructive" });
    } finally {
      setSavingNotes(false);
    }
  };

  const acknowledgeWithSignature = async (initials: string, meaning: string) => {
    setSigning(true);
    try {
      const score = scoreForSig ? parseInt(scoreForSig) : undefined;
      const res = await fetch(`/api/training/${id}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          initials,
          meaning,
          ...(score !== undefined && !Number.isNaN(score) ? { score } : {}),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to acknowledge");
      }
      invalidate();
      toast({
        title: "Training Acknowledged",
        description: "Your Part 11 signature has been recorded.",
      });
    } catch (e) {
      toast({
        title: "Acknowledgment failed",
        description: e instanceof Error ? e.message : "Unable to record signature.",
        variant: "destructive",
      });
      throw e; // keep dialog open
    } finally {
      setSigning(false);
    }
  };

  const trainerSignWithSignature = async (initials: string, meaning: string) => {
    setTrainerSigning(true);
    try {
      const res = await fetch(`/api/training/${id}/trainer-sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initials, meaning }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to record trainer sign-off");
      }
      invalidate();
      toast({
        title: "Trainer co-sign recorded",
        description: "Your Part 11 signature has been recorded.",
      });
    } catch (e) {
      toast({
        title: "Trainer sign-off failed",
        description: e instanceof Error ? e.message : "Unable to record signature.",
        variant: "destructive",
      });
      throw e; // keep dialog open
    } finally {
      setTrainerSigning(false);
    }
  };

  const passed =
    record?.score !== null &&
    record?.score !== undefined &&
    record?.passingScore !== null &&
    record?.passingScore !== undefined
      ? record.score >= record.passingScore
      : null;

  return (
    <>
      <div className="space-y-6 max-w-4xl mx-auto pb-12 print:max-w-none">
        {/* Print-only header */}
        <div className="hidden print:block border-b-2 border-black pb-4 mb-6">
          <div className="cq-page-heading flex items-start justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">CannaQ · Training Record</p>
              <h1 className="text-2xl font-bold font-mono">{record?.recordNumber}</h1>
              <p className="text-base text-gray-600">{record?.topic}</p>
            </div>
            <div className="text-right text-xs text-gray-500 space-y-1">
              <p>Employee: <strong>{record?.employeeName}</strong></p>
              <p>Status: <strong>{record?.status}</strong></p>
              <p>Printed: {format(new Date(), "MMMM d, yyyy")}</p>
            </div>
          </div>
        </div>

        {/* Screen-only header */}
        <div className="print:hidden">
          <Link href="/training" className="text-sm text-primary hover:underline mb-2 block">
            ← Back to Training Records
          </Link>
          <div className="cq-page-heading flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                {isLoading ? <Skeleton className="h-8 w-40" /> : record?.recordNumber}
              </h1>
              <p className="text-muted-foreground text-sm mt-0.5">
                {isLoading ? <Skeleton className="h-4 w-48" /> : record?.topic}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-1.5">
                <Printer className="h-4 w-4" /> Print
              </Button>
              {record && statusBadge(isOverdue ? "Overdue" : record.status)}
            </div>
          </div>
        </div>

        {/* Overdue banner */}
        {!isLoading && isOverdue && !isCompleted && (
          <div className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-red-600" />
            <div>
              <p className="font-semibold text-sm">Training Past Due</p>
              <p className="text-xs mt-0.5">
                Due date {record?.dueDate ? format(parseISO(record.dueDate), "MMMM d, yyyy") : ""} has passed.
                Mark as complete or waive with documented justification.
              </p>
            </div>
          </div>
        )}

        {/* Compliance summary bar */}
        {record && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg border p-3 text-center bg-muted/30">
              <div className="flex items-center justify-center gap-1 mb-1">
                <User className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Employee
                </span>
              </div>
              <p className="text-sm font-bold truncate">{record.employeeName}</p>
              {record.department && (
                <p className="text-xs text-muted-foreground">{record.department}</p>
              )}
            </div>

            <div className="rounded-lg border p-3 text-center bg-muted/30">
              <div className="flex items-center justify-center gap-1 mb-1">
                <GraduationCap className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Type
                </span>
              </div>
              <p className="text-sm font-bold">{record.trainingType}</p>
            </div>

            <div
              className={`rounded-lg border p-3 text-center ${
                isCompleted
                  ? "bg-green-50 border-green-200"
                  : isOverdue
                    ? "bg-red-50 border-red-200"
                    : "bg-muted/30"
              }`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Due
                </span>
              </div>
              <p className={`text-sm font-bold ${isOverdue ? "text-red-700" : ""}`}>
                {record.dueDate
                  ? format(parseISO(record.dueDate), "MMM d, yyyy")
                  : "No deadline"}
              </p>
            </div>

            <div
              className={`rounded-lg border p-3 text-center ${
                passed === true
                  ? "bg-green-50 border-green-200"
                  : passed === false
                    ? "bg-red-50 border-red-200"
                    : "bg-muted/30"
              }`}
            >
              <div className="flex items-center justify-center gap-1 mb-1">
                {passed === true ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                ) : passed === false ? (
                  <XCircle className="h-3.5 w-3.5 text-red-600" />
                ) : (
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Score
                </span>
              </div>
              <p
                className={`text-sm font-bold ${
                  passed === true
                    ? "text-green-700"
                    : passed === false
                      ? "text-red-700"
                      : ""
                }`}
              >
                {record.score !== null && record.score !== undefined
                  ? `${record.score}%`
                  : "—"}
                {record.passingScore !== null &&
                  record.passingScore !== undefined && (
                    <span className="text-xs font-normal text-muted-foreground ml-0.5">
                      /{record.passingScore}%
                    </span>
                  )}
              </p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Left: main content */}
          <div className="md:col-span-2 space-y-6">
            {/* Description */}
            {(isLoading || record?.description) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Purpose</CardTitle>
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-3/4" />
                    </div>
                  ) : (
                    <p className="text-sm bg-muted/30 p-3 rounded-md whitespace-pre-wrap">
                      {record?.description}
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Notes */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base">Notes</CardTitle>
                {!isCompleted && !editingNotes && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="print:hidden"
                    onClick={() => {
                      setNotesDraft(record?.notes ?? "");
                      setEditingNotes(true);
                    }}
                  >
                    {record?.notes ? "Edit" : "Add Notes"}
                  </Button>
                )}
              </CardHeader>
              <CardContent className="pt-2">
                {editingNotes ? (
                  <div className="space-y-2">
                    <Textarea
                      rows={5}
                      value={notesDraft}
                      onChange={(e) => setNotesDraft(e.target.value)}
                      placeholder="Add training notes, assessment observations, competency confirmation…"
                      className="text-sm"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveNotes} disabled={savingNotes}>
                        {savingNotes ? "Saving…" : "Save"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingNotes(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : record?.notes ? (
                  <p className="text-sm bg-muted/30 p-3 rounded-md whitespace-pre-wrap">
                    {record.notes}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground italic">No notes yet.</p>
                )}
              </CardContent>
            </Card>

            {/* Acknowledge panel — Part 11 e-signature */}
            {!isCompleted && !isWaived && record && (() => {
              const isAssignee = currentUser?.id === record.assignedToUserId;
              const isApprover =
                currentUser?.role &&
                ["Supervisor", "Manager", "Quality", "Admin"].includes(currentUser.role);
              const requiresTrainer = (record.trainingType ?? "").includes("Direct / Indirect Supervision");
              const operatorSigned = !!record.signedByUserId;
              const trainerSigned = !!(record as any).trainerSignedByUserId;
              const canAck = (isAssignee || isApprover) && !operatorSigned;
              const canTrainerSign =
                !!isApprover &&
                !trainerSigned &&
                currentUser?.id !== record.assignedToUserId &&
                currentUser?.id !== record.signedByUserId;
              return (
                <Card className="border-green-200 bg-green-50/30 print:hidden">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-green-800 flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4" />
                      Acknowledge Training (Part 11 e-signature)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 pt-0">
                    {record.acknowledgmentText && (
                      <div className="text-sm bg-white border rounded-md p-3 italic">
                        “{record.acknowledgmentText}”
                      </div>
                    )}
                    {record.documentReference && (
                      <p className="text-xs text-muted-foreground">
                        Reviewing document <span className="font-mono font-semibold">{record.documentReference}</span>
                        {record.documentRevisionSnapshot && ` rev ${record.documentRevisionSnapshot}`}.
                        {record.documentId && (
                          <>
                            {" "}
                            <Link href={`/documents/${record.documentId}`} className="text-primary hover:underline">
                              Open document →
                            </Link>
                          </>
                        )}
                        {docAttachments.length > 0 && (
                          <span className="block mt-1">
                            Attachments:{" "}
                            {docAttachments.map((a, i) => (
                              <span key={a.id}>
                                {i > 0 && ", "}
                                <a
                                  href={`${(import.meta.env.BASE_URL ?? "/") as string}api/storage${a.objectPath}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline"
                                >
                                  {a.fileName}
                                </a>
                              </span>
                            ))}
                          </span>
                        )}
                      </p>
                    )}
                    {requiresTrainer && (
                      <div className="text-xs bg-white border rounded-md p-3 space-y-1">
                        <p className="text-muted-foreground">
                          This supervised training closes only when <strong>both</strong> the operator and a trainer sign (two different people).
                        </p>
                        <p>
                          Operator: {operatorSigned ? <span className="text-green-700 font-medium">✓ signed</span> : <span className="text-amber-700">awaiting</span>}
                          {"  ·  "}
                          Trainer: {trainerSigned ? <span className="text-green-700 font-medium">✓ signed</span> : <span className="text-amber-700">awaiting</span>}
                        </p>
                      </div>
                    )}
                    {record.passingScore !== null && record.passingScore !== undefined && !operatorSigned && (
                      <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1">
                          Score (%) — passing: {record.passingScore}
                        </label>
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          placeholder={`Must be ≥ ${record.passingScore}`}
                          value={scoreForSig}
                          onChange={(e) => setScoreForSig(e.target.value)}
                          className="text-sm w-32"
                          data-testid="input-score-for-sig"
                        />
                      </div>
                    )}
                    {!canAck && !operatorSigned && (
                      <p className="text-xs text-amber-700">
                        Only the assigned trainee or a Supervisor+ can acknowledge this record.
                      </p>
                    )}
                    <div className="flex gap-2 flex-wrap">
                      <Button
                        size="sm"
                        className="bg-green-700 hover:bg-green-800 text-white"
                        onClick={() => setSignOpen(true)}
                        disabled={!canAck || signing}
                        data-testid="button-open-acknowledge"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                        {operatorSigned ? "Operator acknowledged ✓" : "Sign & Acknowledge"}
                      </Button>
                      {requiresTrainer && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-green-300 text-green-800 hover:bg-green-100"
                          onClick={() => setTrainerSignOpen(true)}
                          disabled={!canTrainerSign || trainerSigning}
                        >
                          <ShieldCheckIcon />
                          <span className="ml-1">{trainerSigned ? "Trainer signed ✓" : "Trainer sign-off"}</span>
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })()}

            {/* Signature evidence (after completion) */}
            {isCompleted && record?.signedInitials && (
              <Card className="border-green-200 bg-green-50/40 print:bg-white">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base text-green-800 flex items-center gap-2">
                    <ShieldCheckIcon /> Part 11 Signature on Record
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm space-y-1">
                  <p>
                    <span className="text-muted-foreground">{(record as any).trainerSignedInitials ? "Operator:" : "Signed by:"}</span>{" "}
                    <strong>{record.signedInitials}</strong>
                  </p>
                  <p>
                    <span className="text-muted-foreground">Meaning:</span> {record.signedMeaning}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {record.signedAt && format(new Date(record.signedAt), "MMM d, yyyy 'at' h:mm a")}
                  </p>
                  {(record as any).trainerSignedInitials && (
                    <div className="pt-2 mt-2 border-t space-y-1">
                      <p>
                        <span className="text-muted-foreground">Trainer:</span>{" "}
                        <strong>{(record as any).trainerSignedInitials}</strong>
                      </p>
                      <p>
                        <span className="text-muted-foreground">Meaning:</span> {(record as any).trainerSignedMeaning}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {(record as any).trainerSignedAt && format(new Date((record as any).trainerSignedAt), "MMM d, yyyy 'at' h:mm a")}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Part11SignatureDialog
              open={signOpen}
              onOpenChange={setSignOpen}
              title="Acknowledge Training"
              description={
                record?.acknowledgmentText ??
                "By signing, you confirm that you have completed this training and understand its requirements."
              }
              isPending={signing}
              onSign={acknowledgeWithSignature}
            />

            <Part11SignatureDialog
              open={trainerSignOpen}
              onOpenChange={setTrainerSignOpen}
              title="Trainer Competency Sign-off"
              description="By signing, you attest as the trainer that this operator has performed the required tasks under supervision and is competent to perform them per the referenced procedure."
              isPending={trainerSigning}
              onSign={trainerSignWithSignature}
            />
          </div>

          {/* Right sidebar: record details */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Record Details</CardTitle>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="space-y-3">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <Skeleton key={i} className="h-4 w-full" />
                    ))}
                  </div>
                ) : (
                  <dl className="space-y-3">
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Record #</dt>
                      <dd className="mt-0.5 text-sm font-mono font-semibold">
                        {record?.recordNumber}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Employee</dt>
                      <dd className="mt-0.5 text-sm">{record?.employeeName}</dd>
                      {record?.employeeId && (
                        <dd className="text-xs text-muted-foreground font-mono">
                          {record.employeeId}
                        </dd>
                      )}
                    </div>
                    {record?.department && (
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Department
                        </dt>
                        <dd className="mt-0.5 text-sm">{record.department}</dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">
                        Training Type
                      </dt>
                      <dd className="mt-0.5 text-sm">{record?.trainingType}</dd>
                    </div>
                    {record?.documentReference && (
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Document Reference
                        </dt>
                        <dd className="mt-0.5 text-sm font-mono text-primary">
                          {record.documentReference}
                        </dd>
                      </div>
                    )}
                    {record?.trainerName && (
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Trainer / Assessor
                        </dt>
                        <dd className="mt-0.5 text-sm">{record.trainerName}</dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">
                        Assigned Date
                      </dt>
                      <dd className="mt-0.5 text-sm">
                        {record?.assignedDate
                          ? format(parseISO(record.assignedDate), "MMM d, yyyy")
                          : "—"}
                      </dd>
                    </div>
                    {record?.dueDate && (
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Due Date
                        </dt>
                        <dd
                          className={`mt-0.5 text-sm font-medium ${
                            isOverdue ? "text-red-700" : ""
                          }`}
                        >
                          {format(parseISO(record.dueDate), "MMM d, yyyy")}
                        </dd>
                      </div>
                    )}
                    {record?.completedDate && (
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">
                          Completed Date
                        </dt>
                        <dd className="mt-0.5 text-sm text-green-700 font-medium">
                          {format(parseISO(record.completedDate), "MMM d, yyyy")}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">
                        Created
                      </dt>
                      <dd className="mt-0.5 text-sm text-muted-foreground">
                        {record?.createdAt
                          ? format(new Date(record.createdAt), "MMM d, yyyy")
                          : "—"}
                      </dd>
                    </div>
                  </dl>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}

function ShieldCheckIcon() {
  return <CheckCircle2 className="h-4 w-4" />;
}
