import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  useGetDocument,
  useUpdateDocument,
  useRequestDocumentReview,
  useSignDocumentReview,
  useApproveDocument,
  useObsoleteDocument,
  useStartDocumentRevision,
  useListUsers,
  useGetCurrentUser,
  getGetDocumentQueryKey,
  getListDocumentsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { CancelRecordDialog } from "@/components/dialogs/CancelRecordDialog";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { DocumentSectionsPanel } from "@/components/document/DocumentSectionsPanel";
import { SopSectionsPanel } from "@/components/document/SopSectionsPanel";
import { DocumentPrintView } from "@/components/document/DocumentPrintView";
import { BackingRecipePanel } from "@/components/document/BackingRecipePanel";
import { ChangeRequestPanel } from "@/components/document/ChangeRequestPanel";
import { Link } from "wouter";
import { formatRevision, formatSignedAt } from "@/lib/status";
import { DepartmentPicker } from "@/components/DepartmentPicker";
import { format, parseISO, differenceInDays } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckCircle2, Clock, FileText, Archive, AlertTriangle, History, Printer,
  ShieldCheck, UserCheck, Lock, GraduationCap, Users, Ban, RotateCcw, Link2, GitBranch,
} from "lucide-react";

const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);
// Document types (mirrors the importer's list); editable while a document is in Draft.
const DOC_TYPES = ["SOP", "Policy", "Manual", "Work Instruction", "Form", "Protocol", "Specification", "Report", "Other"];
// Periodic review timeframe options (years) — the next review date is computed from
// the release date + this many years.
const REVIEW_INTERVALS = [1, 2, 3];
// Roles permitted to Cancel (mirror server CANCEL_ROLES). Narrower than the
// approver set — no Supervisor. Re-open is Admin-only.
const CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);
// Document statuses that block Cancel (terminal per the schema/route).
const CANCEL_TERMINAL_STATUSES = new Set(["Effective", "Obsolete"]);

const STATUS_STYLES: Record<string, string> = {
  Draft: "bg-slate-100 text-slate-700 border-slate-300",
  "Under Review": "bg-yellow-50 text-yellow-700 border-yellow-200",
  Approved: "bg-green-50 text-green-700 border-green-200",
  Effective: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Obsolete: "bg-red-50 text-red-600 border-red-200",
  Superseded: "bg-orange-50 text-orange-700 border-orange-200",
};

const TYPE_BADGE: Record<string, string> = {
  SOP: "bg-blue-50 text-blue-700 border-blue-200",
  "Work Instruction": "bg-teal-50 text-teal-700 border-teal-200",
  Form: "bg-purple-50 text-purple-700 border-purple-200",
  Policy: "bg-indigo-50 text-indigo-700 border-indigo-200",
  Manual: "bg-indigo-50 text-indigo-700 border-indigo-200",
  Specification: "bg-cyan-50 text-cyan-700 border-cyan-200",
  Protocol: "bg-violet-50 text-violet-700 border-violet-200",
  Report: "bg-slate-50 text-slate-700 border-slate-200",
  Other: "bg-gray-50 text-gray-600 border-gray-200",
};

// ── Lightweight, dependency-free markdown renderer for the document body ──────
// Handles the subset the seeded/authored bodies use: "## " headings, GFM pipe
// tables, "- " bullets, "1. " ordered items, "**bold**" (inline + whole-line
// sub-headings), and paragraphs. Not a general markdown engine — just enough to
// render controlled-document bodies cleanly and safely (no raw HTML).
function renderInline(text: string, keyBase: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((s) => s !== "");
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? (
      <strong key={`${keyBase}-b${i}`}>{p.slice(2, -2)}</strong>
    ) : (
      <span key={`${keyBase}-s${i}`}>{p}</span>
    ),
  );
}

function DocumentMarkdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactElement[] = [];
  let i = 0;
  let key = 0;
  const isTableSep = (s: string) => /^\|[\s:|-]+\|?$/.test(s.trim());

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === "") { i++; continue; }

    // Table: a line starting with "|" followed by a separator row.
    if (line.startsWith("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = line.split("|").slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(lines[i].trim().split("|").slice(1, -1).map((c) => c.trim()));
        i++;
      }
      blocks.push(
        <div key={`tbl${key++}`} className="overflow-x-auto my-2">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                {header.map((h, hi) => (
                  <th key={hi} className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold align-top">
                    {renderInline(h, `th${key}-${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} className="border border-border px-2 py-1 align-top">
                      {renderInline(c, `td${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Heading
    if (line.startsWith("## ")) {
      blocks.push(
        <h3 key={`h${key++}`} className="text-base font-semibold mt-4 mb-1">
          {line.slice(3).trim()}
        </h3>,
      );
      i++;
      continue;
    }

    // Unordered list
    if (/^- /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^- /.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^- /, ""));
        i++;
      }
      blocks.push(
        <ul key={`ul${key++}`} className="list-disc pl-5 space-y-1 text-sm my-1">
          {items.map((it, ii) => <li key={ii}>{renderInline(it, `ul${key}-${ii}`)}</li>)}
        </ul>,
      );
      continue;
    }

    // Ordered list ("1.  text") — preserve the authored numbers.
    if (/^\d+\.\s/.test(line)) {
      const items: { n: number; t: string }[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        const m = lines[i].trim().match(/^(\d+)\.\s+(.*)$/);
        if (m) items.push({ n: parseInt(m[1], 10), t: m[2] });
        i++;
      }
      blocks.push(
        <ol key={`ol${key++}`} className="pl-5 space-y-1 text-sm my-1">
          {items.map((it, ii) => (
            <li key={ii} className="list-none">
              <span className="font-medium mr-1">{it.n}.</span>
              {renderInline(it.t, `ol${key}-${ii}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // Whole-line bold → sub-heading
    if (/^\*\*.+\*\*$/.test(line)) {
      blocks.push(
        <p key={`sh${key++}`} className="text-sm font-semibold mt-2">
          {line.slice(2, -2)}
        </p>,
      );
      i++;
      continue;
    }

    // Paragraph
    blocks.push(
      <p key={`p${key++}`} className="text-sm my-1 leading-relaxed">
        {renderInline(line, `p${key}`)}
      </p>,
    );
    i++;
  }

  return <div className="space-y-1">{blocks}</div>;
}

function statusBadge(status: string) {
  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border ${STATUS_STYLES[status] ?? "bg-gray-100 text-gray-600"}`}>
      {status}
    </span>
  );
}

function reviewDateColor(daysUntil: number | null): string {
  if (daysUntil === null) return "bg-muted/30";
  if (daysUntil < 0) return "bg-red-50 border-red-200 text-red-700";
  if (daysUntil <= 90) return "bg-yellow-50 border-yellow-200 text-yellow-800";
  return "bg-green-50 border-green-200 text-green-800";
}

// formatRevision now lives in "@/lib/status" (single source of truth, shared with the
// document list). Imported above.

export default function DocumentDetail(props: { params?: { id: string } }) {
  const id = parseInt(props.params?.id ?? "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: doc, isLoading } = useGetDocument(id);
  // Backing recipe (for the pre-release "recipe is current" attestation).
  const docRecipeId = (doc as { recipeId?: number | null } | undefined)?.recipeId ?? null;
  const { data: recipesForConfirm } = useQuery<{ id: number; productName: string; version: number }[]>({
    queryKey: ["/api/recipes"],
    queryFn: async () => (await fetch("/api/recipes")).json(),
    enabled: docRecipeId != null,
  });
  const backingRecipe = (recipesForConfirm ?? []).find((r) => r.id === docRecipeId) ?? null;
  // Reverse change-control loop: if the linked recipe has advanced to a newer
  // version since this document was approved against it, the WI must be
  // re-reviewed. Compare the recipe lineage's current head version to the
  // version this document confirmed at approval.
  const { data: recipeVersions } = useQuery<
    { id: number; version: number; supersededByRecipeId: number | null; contentRevisedAt: string | null }[]
  >({
    queryKey: [`/api/recipes/${docRecipeId}/versions`],
    queryFn: async () => {
      try {
        const res = await fetch(`/api/recipes/${docRecipeId}/versions`);
        if (!res.ok) return [];
        const data = await res.json().catch(() => []);
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    },
    enabled: docRecipeId != null,
  });
  const recipeConfirmedVersion = (doc as { recipeConfirmedVersion?: number | null } | undefined)?.recipeConfirmedVersion ?? null;
  const recipeHeadVersion = (recipeVersions ?? []).reduce<number | null>(
    (max, v) => (v.version > (max ?? 0) ? v.version : max),
    null,
  );
  const recipeOutOfDate =
    recipeConfirmedVersion != null && recipeHeadVersion != null && recipeHeadVersion > recipeConfirmedVersion;
  // The other half of the reverse loop (2026-08-25). A recipe's items or process
  // steps can be edited IN PLACE without the version number moving, and this
  // document prints its procedure live from that recipe - so an in-place edit
  // silently changes an approved document. contentRevisedAt is stamped by every
  // recipe item / step mutation; compare it to when this document last confirmed
  // the recipe. (The server also BLOCKS such an edit while a linked WI is
  // Approved or Effective - this covers a doc that was approved after an edit,
  // and any row predating the block.)
  const pinnedRecipe = (recipeVersions ?? []).find((v) => v.id === docRecipeId) ?? null;
  const recipeConfirmedAt = (doc as { recipeConfirmedAt?: string | null } | undefined)?.recipeConfirmedAt ?? null;
  const recipeContentChanged =
    !!recipeConfirmedAt &&
    !!pinnedRecipe?.contentRevisedAt &&
    new Date(pinnedRecipe.contentRevisedAt).getTime() > new Date(recipeConfirmedAt).getTime();
  // Change-impact preview, shown when a revision is STARTED so the author sees
  // what else the change may touch. (Referencing documents already reach their
  // owners' review queue on a Major revision; this puts it in front of the
  // author at the moment of the decision.)
  const { data: revisionImpactDocs } = useQuery<{ id: number; docNumber: string; title: string; status: string }[]>({
    queryKey: [`/api/documents/${id}/referenced-by`],
    queryFn: async () => {
      try {
        const res = await fetch(`/api/documents/${id}/referenced-by`, { credentials: "include" });
        if (!res.ok) return [];
        const data = await res.json().catch(() => []);
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    },
  });
  const { data: usersData } = useListUsers();
  const { data: currentUser } = useGetCurrentUser();
  const updateDoc = useUpdateDocument();
  const requestReview = useRequestDocumentReview();
  const signReview = useSignDocumentReview();
  const approveDoc = useApproveDocument();
  const obsoleteDoc = useObsoleteDocument();
  const startRevision = useStartDocumentRevision();

  const eligibleUsers = useMemo(
    () => (usersData ?? []).filter((u) => u.active && APPROVER_ROLES.has(u.role)),
    [usersData],
  );

  const [descDraft, setDescDraft] = useState("");

  // Edit document metadata (owner / department / review interval) while in Draft.
  const [editingDetails, setEditingDetails] = useState(false);
  const [ownerDraft, setOwnerDraft] = useState("");
  const [deptsDraft, setDeptsDraft] = useState<string[]>([]);
  const [intervalDraft, setIntervalDraft] = useState("3");
  const [scopeDraft, setScopeDraft] = useState("");
  const [typeDraft, setTypeDraft] = useState("");
  const [savingDetails, setSavingDetails] = useState(false);
  const [trainedCount, setTrainedCount] = useState<number | null>(null);
  // Active members of the document's department(s) who are NOT currently trained on
  // it — assigned training when a Major revision is approved, so a new employee is
  // not left untrained on a procedure that governs their work.
  const [newTraineeCount, setNewTraineeCount] = useState<number | null>(null);

  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState("");
  const [savingBody, setSavingBody] = useState(false);

  // Request-review form. Assignment and submission are two separate steps, so the
  // pickers seed from whatever is already saved on the document.
  const [reviewerId, setReviewerId] = useState<string>("");
  const [approverId, setApproverId] = useState<string>("");
  const [requestErr, setRequestErr] = useState("");
  const [savingAssign, setSavingAssign] = useState(false);
  // Return-to-draft form (shown while Under Review).
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const [returning, setReturning] = useState(false);

  // New revision form
  const [newRevOpen, setNewRevOpen] = useState(false);
  // Author's answer to "does this revision also need a recipe update?" (null = not
  // answered). Advisory - it never blocks the revision.
  const [recipeUpdateNeeded, setRecipeUpdateNeeded] = useState<boolean | null>(null);
  const [newRevision, setNewRevision] = useState("");
  const [revSummary, setRevSummary] = useState("");
  const [changeSeverity, setChangeSeverity] = useState<"" | "Minor" | "Major">("");
  // Retraining method for a Major change: self-serve "Read & Understand" (default) or
  // trainer-run "Instructor-Led". Only sent/shown when the change is Major.
  const [retrainingMethod, setRetrainingMethod] = useState<"Read & Understand" | "Instructor-Led">("Read & Understand");
  const [savingMethod, setSavingMethod] = useState(false);
  const [savingNewRev, setSavingNewRev] = useState(false);

  // Controlled tabs so the "Start review revision" button can jump to the Approvals form.
  const [activeTab, setActiveTab] = useState("overview");
  // Step 3 — is a review of this document recommended (a referenced doc was revised
  // more recently than this one)? Read-only recommendation; the human starts the draft.
  const [reviewRec, setReviewRec] = useState<{ recommended: boolean; triggers: { id: number; docNumber: string; title: string; revision: string; approvalDate: string | null }[] }>({ recommended: false, triggers: [] });

  // Part 11 dialogs
  const [reviewSigOpen, setReviewSigOpen] = useState(false);
  const [approveSigOpen, setApproveSigOpen] = useState(false);
  const [recipeConfirmed, setRecipeConfirmed] = useState(false);
  const [obsoleteSigOpen, setObsoleteSigOpen] = useState(false);

  // Session 52.1 — Cancel / Re-open (Part 11). Cancel = soft, recoverable,
  // e-signed (no hard delete). Re-open is Admin-only.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [uncancelOpen, setUncancelOpen] = useState(false);
  const [uncancelPending, setUncancelPending] = useState(false);

  // Every status change on this page — approve, release, obsolete, return to draft
  // — also changes how the document reads in Document Control. Refreshing only this
  // document left the list serving its cached row, so a document could show
  // Effective here and Approved in the list until a hard refresh.
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: getGetDocumentQueryKey(id) });
    await queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
  };

  // Derived state
  const status = doc?.status ?? "Draft";
  // Session 52.1 — cancelled documents are read-only and removed from active
  // use, alongside the existing historical-revision lock.
  const isCancelled = !!(doc as { cancelledAt?: string | null } | undefined)?.cancelledAt;
  const isReadOnly = status === "Obsolete" || status === "Superseded" || isCancelled;
  const canCancel = !!currentUser?.role && CANCEL_ROLES.has(currentUser.role);
  // Batch 6 — Manager/Quality/Admin can manually mark an Approved doc Effective
  // (docs with no training to wait on, or to expedite the rollout).
  const canMarkEffective = !!currentUser?.role && CANCEL_ROLES.has(currentUser.role);
  // Re-open is Admin-only (Session 52 decision), narrower than Cancel.
  const canReopen = currentUser?.role === "Admin";
  // Administrative record movement (2026-08-27) — narrower than approval: a
  // Supervisor may approve a document but may not undo an approval.
  const canAdminMove = currentUser?.role === "Admin" || currentUser?.role === "Quality";
  const meId = currentUser?.id;
  // The generated document type does not include createdByUserId yet, so read it via a cast.
  const authorId = (doc as { createdByUserId?: number | null } | undefined)?.createdByUserId ?? null;
  const isAssignedReviewer = !!meId && doc?.assignedReviewerId === meId;
  const isAssignedApprover = !!meId && doc?.assignedApproverId === meId;
  const reviewerHasSigned = !!doc?.reviewerSignedAt;
  const isAdmin = currentUser?.role === "Admin";
  // Who may set the Date Effective: the two people who have to agree on it, plus
  // Admin. Everyone else sees it — the deadline is not a secret — but cannot move it.
  const canSetPlanned = isAssignedReviewer || isAssignedApprover || isAdmin;
  // A reviewer or approver returning a document with comments is the normal case;
  // Admin covers the times neither of them is available.
  const canReturnToDraft = isAssignedReviewer || isAssignedApprover || isAdmin;
  // Seed the pickers from the saved assignment so a Draft reopens showing who is
  // already down to review and approve, rather than two empty selects.
  const savedReviewerId = doc?.assignedReviewerId ?? null;
  const savedApproverId = doc?.assignedApproverId ?? null;
  useEffect(() => {
    setReviewerId(savedReviewerId != null ? String(savedReviewerId) : "");
    setApproverId(savedApproverId != null ? String(savedApproverId) : "");
  }, [savedReviewerId, savedApproverId]);
  const assignmentDirty =
    reviewerId !== (savedReviewerId != null ? String(savedReviewerId) : "") ||
    approverId !== (savedApproverId != null ? String(savedApproverId) : "");

  const daysUntilReview = doc?.nextReviewDate
    ? differenceInDays(parseISO(doc.nextReviewDate), new Date())
    : null;

  // How many people are currently trained on this document — shown so the
  // retraining impact of a Major change is visible up front.
  useEffect(() => {
    if (!doc?.id) { setTrainedCount(null); setNewTraineeCount(null); return; }
    let cancelled = false;
    fetch(`/api/training/document/${doc.id}/coverage`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const trained: number[] = data.currentlyTrainedUserIds ?? [];
        const audience: number[] = data.departmentAudienceUserIds ?? [];
        const trainedSet = new Set(trained);
        setTrainedCount(trained.length);
        setNewTraineeCount(audience.filter((id) => !trainedSet.has(id)).length);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [doc?.id]);

  // One phrase for every "who gets trained on approval" preview, so the three
  // places that warn about a Major change cannot drift apart.
  const trainingAudiencePhrase = useMemo(() => {
    if (trainedCount == null) {
      return "everyone currently trained on this document, plus active members of its department(s) who haven't trained on it";
    }
    const nNew = newTraineeCount ?? 0;
    const trainedPart = `${trainedCount} ${trainedCount === 1 ? "person" : "people"} currently trained on this document`;
    const newPart = `${nNew} department ${nNew === 1 ? "member" : "members"} new to it`;
    if (trainedCount > 0 && nNew > 0) return `about ${trainedCount + nNew} people — ${trainedPart}, plus ${newPart}`;
    if (trainedCount > 0) return `about ${trainedPart}`;
    if (nNew > 0) return `about ${newPart}`;
    return "no one yet — nobody is trained on this document and its departments have no untrained members, so it becomes Effective on approval";
  }, [trainedCount, newTraineeCount]);

  // Whether a review of this document is recommended (a referenced doc was revised
  // more recently). Only relevant on an Approved document.
  useEffect(() => {
    if (!doc?.id || (doc.status !== "Approved" && doc.status !== "Effective")) { setReviewRec({ recommended: false, triggers: [] }); return; }
    let cancelled = false;
    fetch(`/api/documents/${doc.id}/review-recommendation`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled && data) setReviewRec({ recommended: !!data.recommended, triggers: data.triggers ?? [] }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [doc?.id, doc?.status]);

  // Save WHO reviews and approves without moving the document out of Draft.
  const handleSaveAssignment = async () => {
    setRequestErr("");
    setSavingAssign(true);
    try {
      const res = await fetch(`/api/documents/${id}/assign-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          reviewerId: reviewerId ? parseInt(reviewerId) : null,
          approverId: approverId ? parseInt(approverId) : null,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to save the assignment.");
      await invalidate();
      toast({ title: "Assignment saved", description: "The document stays in Draft until you submit it for review." });
    } catch (err) {
      setRequestErr(err instanceof Error ? err.message : "Failed to save the assignment.");
    } finally {
      setSavingAssign(false);
    }
  };

  // Send a document under review back to its author for editing.
  const handleReturnToDraft = async () => {
    if (!returnReason.trim()) return;
    setReturning(true);
    try {
      const res = await fetch(`/api/documents/${id}/return-to-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reason: returnReason.trim() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to return the document to Draft.");
      await invalidate();
      setReturnOpen(false);
      setReturnReason("");
      toast({ title: "Returned to Draft", description: "The author can edit it again. The reason is recorded in the audit trail." });
    } catch (err) {
      toast({
        title: "Could not return to Draft",
        description: err instanceof Error ? err.message : "Something went wrong.",
        variant: "destructive",
      });
    } finally {
      setReturning(false);
    }
  };

  const handleRequestReview = async () => {
    setRequestErr("");
    if (!reviewerId || !approverId) {
      setRequestErr("Please choose both a Reviewer and an Approver.");
      return;
    }
    const reviewer = eligibleUsers.find((u) => u.id === parseInt(reviewerId));
    const approver = eligibleUsers.find((u) => u.id === parseInt(approverId));
    if (!reviewer || !approver) { setRequestErr("Invalid selection."); return; }

    try {
      await requestReview.mutateAsync({
        id,
        data: { reviewerId: reviewer.id, approverId: approver.id },
      });
      await invalidate();
      toast({ title: "Review requested", description: `${reviewer.fullName} will review, then ${approver.fullName} approves.` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Request failed.";
      setRequestErr(msg);
    }
  };

  // 2026-08-27 — the DECLARED effective date. Agreed between the reviewer and the
  // approver before it is entered; the approver has final say. Jonathan was explicit
  // that the system does not arbitrate between two people who can talk to each other.
  const [plannedEffective, setPlannedEffective] = useState("");
  const [savingPlanned, setSavingPlanned] = useState(false);

  // The earliest the picker allows. The browser's today, which is the reader's — good
  // enough to stop an obvious mistake; the server refuses a past date against the
  // FACILITY's calendar, which is the one that counts.
  const facilityToday = new Date().toLocaleDateString("en-CA");

  // Saved as it is set rather than with the signature: the date is a fact about the
  // document that both the reviewer and the approver need to see before either signs.
  const savePlannedEffective = async (value: string) => {
    setPlannedEffective(value);
    setSavingPlanned(true);
    try {
      const res = await fetch(`/api/documents/${id}/planned-effective-date`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plannedEffectiveDate: value || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: "Couldn't set the effective date", description: data?.error ?? "Please try again.", variant: "destructive" });
        return;
      }
      await invalidate();
    } finally {
      setSavingPlanned(false);
    }
  };

  const handleSignReview = async (initials: string, meaning: string) => {
    await signReview.mutateAsync({
      id,
      data: { initials, meaning, ...(plannedEffective ? { plannedEffectiveDate: plannedEffective } : {}) } as never,
    });
    await invalidate();
    toast({
      title: "Review signed",
      description: plannedEffective
        ? `Awaiting approver. Proposed effective date ${format(parseISO(plannedEffective), "MMM d, yyyy")}.`
        : "Awaiting approver.",
    });
  };

  const handleApprove = async (initials: string, meaning: string) => {
    await approveDoc.mutateAsync({
      id,
      data: { initials, meaning, recipeConfirmed, ...(plannedEffective ? { plannedEffectiveDate: plannedEffective } : {}) } as never,
    });
    setRecipeConfirmed(false);
    await invalidate();
    const goLive = plannedEffective || (doc as { plannedEffectiveDate?: string | null } | undefined)?.plannedEffectiveDate;
    toast({
      title: "Document approved",
      description: goLive
        ? `It goes into force on ${format(parseISO(goLive), "MMM d, yyyy")}. Training is due by then.`
        : "Approved. It becomes Effective once assigned training is complete (or mark it Effective manually).",
    });
  };

  // Seed the picker from whatever has already been agreed, so an approver sees the
  // reviewer's date rather than an empty box they might leave empty by accident.
  useEffect(() => {
    const existing = (doc as { plannedEffectiveDate?: string | null } | undefined)?.plannedEffectiveDate;
    if (existing) setPlannedEffective(existing);
  }, [doc]);

  // Releasing a document into force is a controlled status change, so it is signed
  // like every other one. Anyone still untrained keeps their assignment — the
  // document going Effective does not close their training.
  const [markEffectiveSigOpen, setMarkEffectiveSigOpen] = useState(false);
  // 2026-08-27 — administrative rescind of an approval (Quality/Admin).
  const [rescindOpen, setRescindOpen] = useState(false);
  const [rescindSigOpen, setRescindSigOpen] = useState(false);
  const [rescindTarget, setRescindTarget] = useState<"Under Review" | "Draft">("Under Review");
  const [rescindReason, setRescindReason] = useState("");
  const [rescinding, setRescinding] = useState(false);
  // Obsolete → Draft (2026-08-27). Same envelope as a rescind; different move.
  const [reinstateOpen, setReinstateOpen] = useState(false);
  const [reinstateSigOpen, setReinstateSigOpen] = useState(false);
  const [reinstateReason, setReinstateReason] = useState("");
  const [reinstateSeverity, setReinstateSeverity] = useState<"" | "Minor" | "Major">("");
  const [reinstating, setReinstating] = useState(false);
  const [markingEffective, setMarkingEffective] = useState(false);
  const handleReinstateObsolete = async (initials: string, meaning: string) => {
    setReinstating(true);
    try {
      const res = await fetch(`/api/documents/${id}/reinstate-obsolete`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reinstateReason.trim(), changeSeverity: reinstateSeverity, initials, meaning }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: "Couldn't bring the document back", description: data?.error ?? "Please try again.", variant: "destructive" });
        return;
      }
      setReinstateSigOpen(false);
      setReinstateOpen(false);
      setReinstateReason("");
      setReinstateSeverity("");
      await invalidate();
      toast({
        title: "Document returned to Draft",
        description: "It holds no approval and no effective date — it goes through review and approval again before it is back in force.",
      });
    } finally {
      setReinstating(false);
    }
  };

  const handleRescindApproval = async (initials: string, meaning: string) => {
    setRescinding(true);
    try {
      const res = await fetch(`/api/documents/${id}/rescind-approval`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: rescindTarget, reason: rescindReason.trim(), initials, meaning }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: "Couldn't rescind the approval", description: data?.error ?? "Please try again.", variant: "destructive" });
        return;
      }
      setRescindSigOpen(false);
      setRescindOpen(false);
      setRescindReason("");
      await invalidate();
      const cancelled = Number(data?.cancelledTraining ?? 0);
      toast({
        title: `Approval rescinded — back to ${rescindTarget}`,
        description: cancelled
          ? `${cancelled} incomplete training ${cancelled === 1 ? "record was" : "records were"} cancelled. Everyone is reassigned when it is approved again. Signatures were left as signed.`
          : "Signatures were left as signed; the move is recorded in revision history and the audit log.",
      });
    } finally {
      setRescinding(false);
    }
  };

  const handleMarkEffective = async (initials: string, meaning: string) => {
    setMarkingEffective(true);
    try {
      const res = await fetch(`/api/documents/${id}/mark-effective`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initials, meaning }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: "Couldn't mark Effective", description: data?.error ?? "Please try again.", variant: "destructive" });
        return;
      }
      setMarkEffectiveSigOpen(false);
      await invalidate();
      const left = Number(data?.outstandingTrainees ?? 0);
      toast({
        title: "Document marked Effective",
        description: left
          ? `It's now in force. ${left} ${left === 1 ? "person" : "people"} still have open training on it — their assignments stay open until they complete them.`
          : "It's now in force — ready to print and use.",
      });
    } finally {
      setMarkingEffective(false);
    }
  };

  const handleObsolete = async (initials: string, meaning: string) => {
    await obsoleteDoc.mutateAsync({ id, data: { initials, meaning } });
    await invalidate();
    toast({ title: "Document marked Obsolete" });
  };

  // ── Session 52.1 — Cancel / Re-open (off-spec endpoints; raw fetch) ──────────
  // Throw on failure so the dialogs surface the server message inline.
  const handleCancel = async (reason: string, initials: string, meaning: string) => {
    setCancelPending(true);
    try {
      const r = await fetch(`/api/documents/${id}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, initials, signatureMeaning: meaning }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to cancel document.");
      }
      await invalidate();
      toast({ title: "Document cancelled", description: "Retained and recoverable; removed from active use." });
    } finally {
      setCancelPending(false);
    }
  };

  const handleUncancel = async (initials: string, meaning: string) => {
    setUncancelPending(true);
    try {
      const r = await fetch(`/api/documents/${id}/uncancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initials, signatureMeaning: meaning }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to re-open document.");
      }
      await invalidate();
      toast({ title: "Document re-opened", description: "Record returned to active use." });
    } finally {
      setUncancelPending(false);
    }
  };

  // The document body (markdown) isn't in the generated update type, so PATCH it
  // directly — the /documents/:id endpoint allows bodyMarkdown while pre-Approved.
  const saveBody = async () => {
    setSavingBody(true);
    try {
      const res = await fetch(`/api/documents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ bodyMarkdown: bodyDraft }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to save");
      }
      await invalidate();
      setEditingBody(false);
      toast({ title: "Saved" });
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed to save.", variant: "destructive" });
    } finally {
      setSavingBody(false);
    }
  };

  const saveDetails = async () => {
    setSavingDetails(true);
    try {
      const res = await fetch(`/api/documents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          ownerName: ownerDraft || null,
          departments: deptsDraft,
          reviewIntervalYears: Math.max(1, parseInt(intervalDraft) || 3),
          // Purpose, Scope and Type are content-level and only change while the doc
          // is in Draft — the same rule, because all three are what the document SAYS
          // rather than how it is administered.
          ...(status === "Draft"
            ? { description: descDraft || null, scope: scopeDraft || null, documentType: typeDraft || doc?.documentType }
            : {}),
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? "Failed to save");
      }
      await invalidate();
      setEditingDetails(false);
      toast({ title: "Saved" });
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed to save.", variant: "destructive" });
    } finally {
      setSavingDetails(false);
    }
  };

  const saveNewRevision = async () => {
    if (!changeSeverity) {
      toast({ title: "Pick a change severity", description: "Required to start a new revision.", variant: "destructive" });
      return;
    }
    setSavingNewRev(true);
    try {
      const nextRev = String(Math.floor(parseFloat(String(doc?.revision ?? "1")) || 1) + 1);
      await startRevision.mutateAsync({
        id,
        data: {
          newRevision: nextRev,
          summaryOfChanges: revSummary || null,
          changeSeverity,
          // Method only matters for a Major change; the server ignores it otherwise.
          retrainingMethod: changeSeverity === "Major" ? retrainingMethod : undefined,
          // Advisory flag - puts a notice on the linked recipe. Never blocks.
          recipeUpdateNeeded: recipeUpdateNeeded === true,
        } as unknown as { newRevision: string; summaryOfChanges: string | null },
      });
      await invalidate();
      setNewRevOpen(false);
      setNewRevision("");
      setRevSummary("");
      setChangeSeverity("");
      setRetrainingMethod("Read & Understand");
      setRecipeUpdateNeeded(null);
      toast({
        title: "New revision started",
        description: `Now editing Rev ${nextRev} as Draft (${changeSeverity} change).`,
      });
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed.", variant: "destructive" });
    } finally {
      setSavingNewRev(false);
    }
  };

  // Switch the retraining method while the document is still in Draft. The server
  // only accepts this change in Draft and locks it once the doc leaves Draft.
  const setDocMethod = async (method: "Read & Understand" | "Instructor-Led") => {
    setSavingMethod(true);
    try {
      await updateDoc.mutateAsync({ id, data: { retrainingMethod: method } } as unknown as Parameters<typeof updateDoc.mutateAsync>[0]);
      await invalidate();
      toast({ title: "Retraining method updated", description: `This change will use ${method} retraining.` });
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Failed to update method.", variant: "destructive" });
    } finally {
      setSavingMethod(false);
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6 max-w-4xl mx-auto pb-12 print:max-w-none">
        {/* Formal print layout — replaces the on-screen editor view when printing. */}
        {doc && <DocumentPrintView doc={doc} />}

        {/* Screen header */}
        <div className="print:hidden">
          <Link href="/documents" className="text-sm text-primary hover:underline mb-2 block">
            ← Back to Document Control
          </Link>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold tracking-tight font-mono">
                  {isLoading ? <Skeleton className="h-8 w-40" /> : doc?.docNumber}
                </h1>
                {doc && (
                  <>
                    {/* Corporate or local (2026-08-28) — see the note in Documents.tsx.
                        Two badges side by side, so a fragment: this block renders one
                        child and adding a sibling without wrapping it is what broke the
                        page the first time I tried. */}
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-slate-50 text-slate-600 border-slate-200">
                      {(doc as { facilityId?: number | null }).facilityId ? "This facility" : "Company-wide"}
                    </span>
                    {/* The change-request MARKER (Phase 3, 2026-08-28). ⛔ NOT a status:
                        the document keeps its real one — Effective stays Effective —
                        and this sits beside it, so a supervisor about to print and
                        laminate a controlled copy can see a change is already coming. */}
                    {(doc as { changeRequestMarker?: string | null }).changeRequestMarker ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-amber-50 text-amber-700 border-amber-200">
                        {(doc as { changeRequestMarker?: string | null }).changeRequestMarker}
                      </span>
                    ) : null}
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${TYPE_BADGE[doc.documentType] ?? "bg-slate-100 text-slate-600"}`}>
                      {doc.documentType}
                    </span>
                  </>
                )}
                {doc && (doc as any).isStarterDefault && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-amber-50 text-amber-700 border-amber-200">
                    Starter
                  </span>
                )}
              </div>
              <p className="text-muted-foreground text-sm mt-0.5">
                {isLoading ? <Skeleton className="h-4 w-56" /> : doc?.title}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {doc && !CANCEL_TERMINAL_STATUSES.has(status) && !isCancelled && canCancel && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCancelOpen(true)}
                  className="gap-1.5 text-destructive hover:text-destructive"
                  data-testid="button-cancel-document"
                >
                  <Ban className="h-4 w-4" /> Cancel
                </Button>
              )}
              {doc && isCancelled && canReopen && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setUncancelOpen(true)}
                  disabled={uncancelPending}
                  className="gap-1.5"
                  data-testid="button-reopen-document"
                >
                  <RotateCcw className="h-4 w-4" /> Re-open
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-1.5">
                <Printer className="h-4 w-4" /> Print
              </Button>
              {doc && statusBadge(doc.status)}
            </div>
          </div>
        </div>

        {/* Session 52.1 — Cancelled banner (Part 11 record of who/why). */}
        {isCancelled && doc && (
          <div className="rounded-lg border-2 border-red-200 bg-red-50 px-4 py-3 print:hidden" data-testid="banner-document-cancelled">
            <p className="text-sm font-semibold text-red-900 flex items-center gap-2">
              <Ban className="h-4 w-4" /> This document has been cancelled
            </p>
            <p className="text-xs text-red-800 mt-1">
              {(doc as { cancelledByName?: string | null }).cancelledByName}
              {(doc as { cancelledByInitials?: string | null }).cancelledByInitials ? ` (${(doc as { cancelledByInitials?: string | null }).cancelledByInitials})` : ""}
              {(doc as { cancelledAt?: string | null }).cancelledAt ? ` · ${format(new Date((doc as { cancelledAt?: string | null }).cancelledAt as string), "MMM d, yyyy h:mm a")}` : ""}
            </p>
            {(doc as { cancelledReason?: string | null }).cancelledReason && (
              <p className="text-sm text-red-900 mt-1.5 whitespace-pre-wrap">
                <span className="font-medium">Reason:</span> {(doc as { cancelledReason?: string | null }).cancelledReason}
              </p>
            )}
            <p className="text-[11px] text-red-700 mt-1 italic">Retained for compliance; can be re-opened by an Admin only.</p>
          </div>
        )}

        {/* 2026-08-27 — administrative rescind notice. Clears itself when the
            document is approved again; the record of the move lives in revision
            history and the audit log. Never printed on the controlled copy. */}
        {doc && (doc as { rescindedAt?: string | null }).rescindedAt && (
          <div className="rounded-lg border-2 border-amber-200 bg-amber-50 px-4 py-3 print:hidden" data-testid="banner-approval-rescinded">
            <p className="text-sm font-semibold text-amber-900 flex items-center gap-2">
              {/* Which move this was. Rows written before the action was recorded
                  (2026-08-27) carry no value and are read as an approval rescind,
                  which is the only move that existed then. */}
              <AlertTriangle className="h-4 w-4" />
              {(doc as { rescindedAction?: string | null }).rescindedAction ?? "Approval rescinded"}
              {(doc as { rescindedToStatus?: string | null }).rescindedToStatus
                ? ` — returned to ${(doc as { rescindedToStatus?: string | null }).rescindedToStatus}`
                : ""}
            </p>
            <p className="text-xs text-amber-800 mt-1">
              {(doc as { rescindedByName?: string | null }).rescindedByName}
              {(doc as { rescindedAt?: string | null }).rescindedAt
                ? ` · ${format(new Date((doc as { rescindedAt?: string | null }).rescindedAt as string), "MMM d, yyyy h:mm a")}`
                : ""}
            </p>
            {(doc as { rescindedReason?: string | null }).rescindedReason && (
              <p className="text-sm text-amber-900 mt-1.5 whitespace-pre-wrap">
                <span className="font-medium">Reason:</span> {(doc as { rescindedReason?: string | null }).rescindedReason}
              </p>
            )}
            <p className="text-[11px] text-amber-700 mt-1 italic">Signatures already given are retained. This notice clears when the document is approved again.</p>
          </div>
        )}

        {/* Read-only banner */}
        {isReadOnly && !isCancelled && (
          <div className="flex items-start gap-3 rounded-lg border border-orange-300 bg-orange-50 px-4 py-3 text-orange-900 print:hidden">
            <Lock className="h-5 w-5 shrink-0 mt-0.5 text-orange-600" />
            <div>
              <p className="font-semibold text-sm">{status} — Historical Record</p>
              <p className="text-xs mt-0.5">
                This revision is retained for compliance and cannot be modified.
                {doc?.obsoletedByName && ` Marked obsolete by ${doc.obsoletedByName}.`}
              </p>
            </div>
          </div>
        )}

        {/* Reverse change-control: linked recipe advanced past what this WI was
            approved against — the procedure must be re-reviewed. */}
        {(recipeOutOfDate || recipeContentChanged) && !isCancelled && (
          <div className="flex items-start gap-3 rounded-lg border-2 border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 print:hidden" data-testid="banner-recipe-out-of-date">
            <GitBranch className="h-5 w-5 shrink-0 mt-0.5 text-amber-600" />
            <div>
              <p className="font-semibold text-sm">
                {recipeOutOfDate
                  ? `Linked recipe updated to v${recipeHeadVersion} — re-review needed`
                  : "Linked recipe changed — re-review needed"}
              </p>
              <p className="text-xs mt-0.5">
                {recipeOutOfDate
                  ? `This work instruction was approved against recipe v${recipeConfirmedVersion}, but the recipe has ` +
                    `since advanced to v${recipeHeadVersion}. Start a new revision and re-confirm the linked recipe so ` +
                    `the procedure and recipe stay in sync.`
                  : "The linked recipe's items or process steps were edited after this document was approved, so the " +
                    "procedure this document prints has moved. Start a new revision and re-confirm the linked recipe."}
              </p>
            </div>
          </div>
        )}

        {/* Draft change-severity banner */}
        {status === "Draft" && (doc as unknown as { changeSeverity?: "Minor" | "Major" | null })?.changeSeverity && (() => {
          const sev = (doc as unknown as { changeSeverity: "Minor" | "Major" }).changeSeverity;
          const isMajor = sev === "Major";
          return (
            <div
              className={`flex items-start gap-3 rounded-lg border-2 px-4 py-3 print:hidden ${isMajor ? "border-amber-300 bg-amber-50 text-amber-900" : "border-slate-300 bg-slate-50 text-slate-800"}`}
              data-testid="banner-change-severity"
            >
              <GraduationCap className={`h-5 w-5 shrink-0 mt-0.5 ${isMajor ? "text-amber-600" : "text-slate-500"}`} />
              <div className="text-sm">
                <p className="font-semibold">
                  {isMajor ? "Major change" : "Minor change"}
                </p>
                <p className="text-xs mt-0.5">
                  {isMajor
                    ? `Training assigned on approval — ${trainingAudiencePhrase}. Each must acknowledge the new revision, with 10 business days to do it, before they are current.`
                    : "No retraining on approval. Use Major for substantive content changes that require re-training."}
                </p>
                {isMajor && (() => {
                  const curMethod = (doc as unknown as { retrainingMethod?: string | null })?.retrainingMethod ?? "Read & Understand";
                  const canManage = !!currentUser?.role && APPROVER_ROLES.has(currentUser.role);
                  return (
                    <div className="mt-2 pt-2 border-t border-amber-200">
                      <p className="text-xs font-semibold">Retraining method: <span className="font-normal">{curMethod}</span></p>
                      <p className="text-[11px] mt-0.5">
                        {curMethod === "Instructor-Led"
                          ? "A trainer runs one session, picks the roster, and signs once — each attendee's record is completed under that session."
                          : "Self-serve: each trainee acknowledges the new revision themselves in the app."}
                      </p>
                      {canManage && (
                        <div className="flex gap-1.5 mt-1.5" data-testid="draft-method-switch">
                          {(["Read & Understand", "Instructor-Led"] as const).map((m) => (
                            <button
                              key={m}
                              type="button"
                              disabled={savingMethod || curMethod === m}
                              onClick={() => setDocMethod(m)}
                              className={`text-[11px] rounded border px-2 py-0.5 transition-colors ${curMethod === m ? "border-amber-500 bg-amber-100 font-semibold cursor-default" : "border-amber-300 bg-white hover:bg-amber-50"}`}
                              data-testid={`draft-method-${m === "Instructor-Led" ? "instructor" : "read"}`}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          );
        })()}

        {/* Periodic review banner */}
        {!isLoading && (status === "Approved" || status === "Effective") && daysUntilReview !== null && daysUntilReview <= 90 && (
          <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 print:hidden ${reviewDateColor(daysUntilReview)}`}>
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-sm">
                {daysUntilReview < 0 ? "Periodic Review Overdue" : "Periodic Review Approaching"}
              </p>
              <p className="text-xs mt-0.5">
                Next review {daysUntilReview < 0 ? "was due" : "is due"} {format(parseISO(doc!.nextReviewDate!), "MMMM d, yyyy")}
                {" "}({Math.abs(daysUntilReview)} days {daysUntilReview < 0 ? "ago" : "from now"}).
                Start a new revision or confirm continued effectiveness.
              </p>
            </div>
          </div>
        )}

        {/* Step 3 — review recommended: a referenced document was revised more recently. */}
        {!isLoading && (status === "Approved" || status === "Effective") && reviewRec.recommended && (() => {
          const canManage = !!currentUser?.role && APPROVER_ROLES.has(currentUser.role);
          const names = reviewRec.triggers
            .map((t) => `${t.docNumber} (Rev ${Math.floor(parseFloat(String(t.revision)) || 1)}.0)`)
            .join(", ");
          const one = reviewRec.triggers.length === 1;
          return (
            <div className="flex items-start gap-3 rounded-lg border-2 border-purple-300 bg-purple-50 text-purple-900 px-4 py-3 print:hidden" data-testid="banner-review-recommended">
              <Link2 className="h-5 w-5 shrink-0 mt-0.5 text-purple-600" />
              <div className="flex-1">
                <p className="font-semibold text-sm">Review recommended</p>
                <p className="text-xs mt-0.5">
                  {one ? "A document" : "Documents"} this one references — {names} — {one ? "was" : "were"} revised after this document's last approval. Start a review revision to confirm this document still aligns, and update it if needed.
                </p>
                {canManage && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 border-purple-400 text-purple-800 hover:bg-purple-100"
                    onClick={() => {
                      setRevSummary(`Review triggered by revision of ${names}. Confirm this document still aligns; update if needed.`);
                      setNewRevOpen(true);
                      setActiveTab("approvals");
                    }}
                    data-testid="button-start-review-revision"
                  >
                    Start review revision
                  </Button>
                )}
              </div>
            </div>
          );
        })()}

        {/* Tabbed document view */}
        {doc && (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="print:hidden">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="body">Document Body</TabsTrigger>
              <TabsTrigger value="approvals">Approvals</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
              <TabsTrigger value="attachments">Attachments</TabsTrigger>
            </TabsList>

            {/* OVERVIEW */}
            <TabsContent value="overview" className="space-y-6 mt-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 print:hidden">
            <div className="rounded-lg border p-3 text-center bg-muted/30">
              <div className="flex items-center justify-center gap-1 mb-1">
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Revision</span>
              </div>
              {(() => {
                const stored = Math.floor(parseFloat(String(doc.revision ?? "1")) || 1);
                const reviewRound = (doc as { reviewRound?: number }).reviewRound ?? 0;
                const inCycle = doc.status === "Draft" || doc.status === "Under Review";
                // A revision of an already-released document: the REAL (released) version
                // stays the headline; the draft/target are shown as an under-revision note.
                if (inCycle && stored >= 2) {
                  return (
                    <>
                      <p className="text-sm font-bold font-mono">{`${stored - 1}.0`}</p>
                      <p className="text-[10px] font-semibold text-amber-700 mt-0.5 leading-tight">
                        Under revision · draft {`${stored - 1}.${Math.max(reviewRound, 1)}`} → {`${stored}.0`}
                      </p>
                    </>
                  );
                }
                // Approved/released version, or a brand-new draft never released yet.
                return (
                  <>
                    <p className="text-sm font-bold font-mono">{formatRevision(doc.revision, doc.status, reviewRound)}</p>
                    {inCycle && (
                      <p className="text-[10px] font-semibold text-muted-foreground mt-0.5 leading-tight">Draft — not yet released</p>
                    )}
                  </>
                );
              })()}
            </div>
            <div className={`rounded-lg border p-3 text-center ${doc.status === "Effective" ? "bg-green-50 border-green-200" : "bg-muted/30"}`}>
              <div className="flex items-center justify-center gap-1 mb-1">
                <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Effective</span>
              </div>
              <p className="text-sm font-bold">
                {doc.effectiveDate ? format(parseISO(doc.effectiveDate), "MMM d, yyyy") : "—"}
              </p>
            </div>
            <div className={`rounded-lg border p-3 text-center ${reviewDateColor(daysUntilReview)}`}>
              <div className="flex items-center justify-center gap-1 mb-1">
                <Clock className="h-3.5 w-3.5" />
                <span className="text-xs font-semibold uppercase tracking-wide">Next Review</span>
              </div>
              <p className="text-sm font-bold">
                {doc.nextReviewDate ? format(parseISO(doc.nextReviewDate), "MMM d, yyyy") : "—"}
              </p>
            </div>
            <div className="rounded-lg border p-3 text-center bg-muted/30">
              <div className="flex items-center justify-center gap-1 mb-1">
                <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Approved By</span>
              </div>
              <p className="text-sm font-bold truncate">{doc.approvedByName ?? "—"}</p>
            </div>
          </div>
            <Card>
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Document Details</CardTitle>
                {!isReadOnly && !editingDetails && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="print:hidden"
                    onClick={() => {
                      setOwnerDraft(doc?.ownerName ?? "");
                      setDeptsDraft(
                        (doc as unknown as { departments?: string[] | null })?.departments
                        ?? (doc?.department ? [doc.department] : []),
                      );
                      setIntervalDraft(String(doc?.reviewIntervalYears ?? 3));
                      setDescDraft(doc?.description ?? "");
                      setScopeDraft(doc?.scope ?? "");
                      setTypeDraft(doc?.documentType ?? "");
                      setEditingDetails(true);
                    }}
                  >
                    Edit
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                {editingDetails ? (
                  <div className="space-y-3">
                    <div>
                      <Label htmlFor="owner-edit" className="text-xs">Document Owner</Label>
                      <Input id="owner-edit" value={ownerDraft} onChange={(e) => setOwnerDraft(e.target.value)} className="text-sm" />
                    </div>
                    <div>
                      <Label className="text-xs">Department(s)</Label>
                      <div className="mt-1"><DepartmentPicker value={deptsDraft} onChange={setDeptsDraft} /></div>
                    </div>
                    <div>
                      <Label htmlFor="interval-edit" className="text-xs">Periodic Review Timeframe</Label>
                      <Select value={intervalDraft} onValueChange={setIntervalDraft}>
                        <SelectTrigger id="interval-edit" className="text-sm w-40"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {REVIEW_INTERVALS.map((y) => (
                            <SelectItem key={y} value={String(y)}>{y} {y === 1 ? "year" : "years"}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground mt-0.5">Next review is this many years after the document is released.</p>
                    </div>
                    {status === "Draft" && (
                      <>
                        <div>
                          <Label htmlFor="type-edit" className="text-xs">Type</Label>
                          <Select value={typeDraft} onValueChange={setTypeDraft}>
                            <SelectTrigger id="type-edit" className="text-sm w-52"><SelectValue placeholder="Select type" /></SelectTrigger>
                            <SelectContent>
                              {DOC_TYPES.map((t) => (<SelectItem key={t} value={t}>{t}</SelectItem>))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label htmlFor="purpose-edit" className="text-xs">Purpose</Label>
                          <Textarea id="purpose-edit" value={descDraft} onChange={(e) => setDescDraft(e.target.value)} rows={3} className="text-sm"
                            placeholder="What this document is for." />
                        </div>
                        <div>
                          <Label htmlFor="scope-edit" className="text-xs">Scope</Label>
                          <Textarea id="scope-edit" value={scopeDraft} onChange={(e) => setScopeDraft(e.target.value)} rows={3} className="text-sm" />
                        </div>
                      </>
                    )}
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveDetails} disabled={savingDetails}>{savingDetails ? "Saving…" : "Save"}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingDetails(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : isLoading ? (
                  <div className="space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-4 w-full" />)}</div>
                ) : (
                  <dl className="space-y-3">
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Document #</dt>
                      <dd className="mt-0.5 text-sm font-mono font-semibold">{doc?.docNumber}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Type</dt>
                      <dd className="mt-0.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${TYPE_BADGE[doc?.documentType ?? ""] ?? "bg-slate-100 text-slate-600"}`}>
                          {doc?.documentType}
                        </span>
                      </dd>
                    </div>
                    {(() => {
                      const depts = (doc as unknown as { departments?: string[] | null })?.departments;
                      const list = depts && depts.length ? depts : (doc?.department ? [doc.department] : []);
                      return list.length ? (
                        <div>
                          <dt className="text-xs font-medium text-muted-foreground">Department{list.length > 1 ? "s" : ""}</dt>
                          <dd className="mt-0.5 text-sm">{list.join(", ")}</dd>
                        </div>
                      ) : null;
                    })()}
                    {doc?.ownerName && (
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Document Owner</dt>
                        <dd className="mt-0.5 text-sm">{doc.ownerName}</dd>
                      </div>
                    )}
                    {/* 2026-08-27 — Purpose was never rendered anywhere on this page.
                        The field, its edit state and its save handler all existed; no JSX
                        used them. That is how SOP-26-0022 kept "To document how to mop
                        floors" through an entire revision of a clock-hanging procedure —
                        nobody could see it to notice it was wrong. */}
                    {doc?.description && (
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Purpose</dt>
                        <dd className="mt-0.5 text-sm text-muted-foreground whitespace-pre-wrap">{doc.description}</dd>
                      </div>
                    )}
                    {doc?.scope && (
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">Scope</dt>
                        <dd className="mt-0.5 text-sm text-muted-foreground">{doc.scope}</dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Review Interval</dt>
                      <dd className="mt-0.5 text-sm">{doc?.reviewIntervalYears ?? 3} years</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Created</dt>
                      <dd className="mt-0.5 text-sm text-muted-foreground">
                        {doc?.createdAt ? format(new Date(doc.createdAt), "MMM d, yyyy") : "—"}
                      </dd>
                    </div>
                  </dl>
                )}
              </CardContent>
            </Card>
              {["Draft", "Under Review", "Approved", "Effective"].includes(status) && doc && !isCancelled && (
                <DocumentTrainingPanel
                  docId={doc.id}
                  docNumber={doc.docNumber}
                  docTitle={doc.title}
                  revision={doc.revision}
                  eligibleAssignees={(usersData ?? []).filter((u) => u.active)}
                  canAssign={!!currentUser?.role && APPROVER_ROLES.has(currentUser.role)}
                  retrainingMethod={(doc as unknown as { retrainingMethod?: string | null }).retrainingMethod ?? null}
                  docStatus={doc.status}
                />
              )}
              {doc && !isCancelled && <ReferencedByPanel docId={doc.id} />}
            </TabsContent>

            {/* DOCUMENT BODY */}
            <TabsContent value="body" className="space-y-6 mt-4">
              {doc && <AssociatedLinkSuggester docId={doc.id} isDraft={status === "Draft" && !isCancelled} />}
              {doc.documentType !== "Work Instruction" && doc.documentType !== "Specification" && (
                <SopSectionsPanel docId={doc.id} isDraft={status === "Draft" && !isCancelled} />
              )}
              {(doc.documentType === "Work Instruction" || doc.documentType === "Specification") && (
                <BackingRecipePanel
                  docId={doc.id}
                  currentRecipeId={(doc as { recipeId?: number | null }).recipeId ?? null}
                  isDraft={status === "Draft" && !isCancelled}
                />
              )}
              {(doc.documentType === "Specification" || doc.documentType === "Work Instruction") && (
                <DocumentSectionsPanel docId={doc.id} isDraft={status === "Draft" && !isCancelled} />
              )}
            </TabsContent>

            {/* APPROVALS — driven entirely by the change/review process */}
            <TabsContent value="approvals" className="space-y-6 mt-4">
              {/* Change requests live on APPROVALS, not Overview (his call, 2026-08-28):
                  "I didn't see the Change Request on the Overview tab." This is the tab he
                  actually goes to when a document needs to move — Start New Revision is
                  right below it — so a request to change the document belongs beside the
                  controls that act on that request, not on the tab people read. */}
              <div className="print:hidden">
                <ChangeRequestPanel
                  documentId={id}
                  documentStatus={doc.status}
                  userRole={currentUser?.role}
                  onChanged={invalidate}
                />
              </div>
              {!isReadOnly ? (
              <Card className="border-primary/20 bg-primary/5 print:hidden" data-testid="workflow-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4" /> Approval Workflow
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-4">

                  {/* Compliance reminder */}
                  <div className="text-xs text-muted-foreground bg-blue-50 border border-blue-200 rounded p-2">
                    Author → Reviewer → Approver. All transitions require a 21 CFR Part 11 electronic signature.
                    The author may also review, and the Reviewer may also approve. The one rule: the document’s author can never be the Approver.
                  </div>

                  {/* DRAFT */}
                  {status === "Draft" && (
                    <div className="space-y-3" data-testid="stage-draft">
                      <p className="text-sm font-semibold">Stage 1 of 3 · Draft</p>
                      <p className="text-xs text-muted-foreground">
                        Choose a Reviewer and an Approver from eligible roles (Supervisor, Manager, Quality, Admin).
                        Saving the assignment leaves the document in Draft so you can keep editing — it moves to
                        Under Review only when you submit it.
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="reviewer-select" className="text-xs">Reviewer *</Label>
                          <Select value={reviewerId} onValueChange={setReviewerId}>
                            <SelectTrigger id="reviewer-select" data-testid="select-reviewer"><SelectValue placeholder="Select reviewer" /></SelectTrigger>
                            <SelectContent>
                              {eligibleUsers
                                .map((u) => (
                                  <SelectItem key={u.id} value={String(u.id)}>
                                    {u.fullName} — {u.role}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label htmlFor="approver-select" className="text-xs">Approver *</Label>
                          <Select value={approverId} onValueChange={setApproverId}>
                            <SelectTrigger id="approver-select" data-testid="select-approver"><SelectValue placeholder="Select approver" /></SelectTrigger>
                            <SelectContent>
                              {eligibleUsers
                                .filter((u) => authorId == null || u.id !== authorId)
                                .map((u) => (
                                  <SelectItem key={u.id} value={String(u.id)}>
                                    {u.fullName} — {u.role}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      {requestErr && (
                        <div className="text-xs text-destructive bg-red-50 border border-red-200 rounded p-2" data-testid="text-request-error">
                          {requestErr}
                        </div>
                      )}
                      <div className="flex gap-2 flex-wrap items-center">
                        <Button size="sm" variant="outline" onClick={handleSaveAssignment}
                          disabled={savingAssign || !assignmentDirty}
                          data-testid="button-save-assignment">
                          {savingAssign ? "Saving…" : "Save Reviewer/Approver"}
                        </Button>
                        <Button size="sm" onClick={handleRequestReview}
                          disabled={!reviewerId || !approverId || requestReview.isPending}
                          data-testid="button-request-review">
                          {requestReview.isPending ? "Submitting…" : "Submit for Review"}
                        </Button>
                        {assignmentDirty && (reviewerId || approverId) && (
                          <span className="text-xs text-muted-foreground">Unsaved assignment change.</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* UNDER REVIEW */}
                  {status === "Under Review" && (
                    <div className="space-y-3" data-testid="stage-under-review">
                      <p className="text-sm font-semibold">
                        Stage {reviewerHasSigned ? "3 of 3 · Awaiting Approval" : "2 of 3 · Awaiting Reviewer"}
                      </p>

                      {(doc as unknown as { changeSeverity?: string | null })?.changeSeverity === "Major" && (
                        <div className="text-xs rounded border border-amber-300 bg-amber-50 text-amber-900 p-2 flex items-start gap-2" data-testid="under-review-retrain-note">
                          <GraduationCap className="h-4 w-4 shrink-0 mt-0.5" />
                          <span>
                            Major change — approving this will assign training to {trainingAudiencePhrase}, due in 10 business days.
                          </span>
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                        <div className="rounded border bg-card p-3">
                          <p className="text-xs uppercase tracking-wide text-muted-foreground">Reviewer</p>
                          <p className="font-medium">{doc.assignedReviewerName ?? "—"}</p>
                          {reviewerHasSigned ? (
                            <p className="text-xs text-green-700 mt-1 flex items-center gap-1">
                              <CheckCircle2 className="h-3 w-3" />
                              Signed {formatSignedAt(doc.reviewerSignedAt)}
                              {doc.reviewerSignedInitials && ` · ${doc.reviewerSignedInitials}`}
                            </p>
                          ) : (
                            <p className="text-xs text-yellow-700 mt-1">Pending signature</p>
                          )}
                        </div>
                        <div className="rounded border bg-card p-3">
                          <p className="text-xs uppercase tracking-wide text-muted-foreground">Approver</p>
                          <p className="font-medium">{doc.assignedApproverName ?? "—"}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {reviewerHasSigned ? "Ready to approve" : "Waiting for reviewer"}
                          </p>
                        </div>
                      </div>

                      {/* 2026-08-27 — DATE EFFECTIVE. Jonathan: "When the document is
                          waiting for the Approver to sign, there should be a calendar date
                          selection field with a Date Effective title… That field can then be
                          used to show when training is due."
                          On the card rather than inside the signature dialog, so anyone
                          looking at a document awaiting approval can see when it goes live
                          and by when people have to be trained. */}
                      {reviewerHasSigned && (
                        <div className="rounded-lg border bg-card p-3 space-y-2" data-testid="panel-date-effective">
                          <div className="flex items-baseline justify-between gap-3 flex-wrap">
                            <Label htmlFor="date-effective" className="text-xs font-semibold">Date Effective</Label>
                            {savingPlanned && <span className="text-[11px] text-muted-foreground">Saving…</span>}
                          </div>
                          {canSetPlanned ? (
                            <Input
                              id="date-effective"
                              type="date"
                              className="max-w-[13rem]"
                              value={plannedEffective}
                              min={facilityToday}
                              onChange={(e) => savePlannedEffective(e.target.value)}
                              data-testid="input-date-effective"
                            />
                          ) : (
                            <p className="text-sm font-medium">
                              {plannedEffective ? format(parseISO(plannedEffective), "MMM d, yyyy") : "Not set"}
                            </p>
                          )}
                          <p className="text-[11px] text-muted-foreground">
                            {plannedEffective ? (
                              <>
                                Goes into force on <span className="font-medium">{format(parseISO(plannedEffective), "MMM d, yyyy")}</span>.
                                {" "}Training assigned on approval is due by then.
                              </>
                            ) : (
                              <>Set the day this goes into force. Agree it with the {isAssignedApprover ? "reviewer" : "approver"} first — the approver has final say. Left unset, it becomes Effective once everyone assigned has trained.</>
                            )}
                          </p>
                        </div>
                      )}

                      {isAssignedApprover && reviewerHasSigned && docRecipeId != null && (
                        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
                          <p className="text-xs font-semibold text-amber-900">
                            Recipe check — required before release
                          </p>
                          <p className="text-xs text-amber-800">
                            This work instruction is linked to{" "}
                            <span className="font-medium">
                              {backingRecipe ? `${backingRecipe.productName} (v${backingRecipe.version})` : "the linked recipe"}
                            </span>
                            . Confirm the recipe reflects this revision before approving — no
                            recipe change is needed if this update didn&rsquo;t affect it.
                          </p>
                          <label className="flex items-start gap-2 text-xs text-amber-900 cursor-pointer">
                            <Checkbox
                              className="mt-0.5"
                              checked={recipeConfirmed}
                              onCheckedChange={(v) => setRecipeConfirmed(!!v)}
                            />
                            <span>
                              I confirm the linked recipe has been updated to match this
                              revision, or that no recipe change was required.
                            </span>
                          </label>
                        </div>
                      )}

                      <div className="flex gap-2 flex-wrap">
                        {isAssignedReviewer && !reviewerHasSigned && (
                          <Button size="sm" onClick={() => setReviewSigOpen(true)} data-testid="button-sign-review">
                            <UserCheck className="h-3.5 w-3.5 mr-1" /> Sign as Reviewer
                          </Button>
                        )}
                        {isAssignedApprover && reviewerHasSigned && (
                          <Button size="sm" disabled={docRecipeId != null && !recipeConfirmed} onClick={() => setApproveSigOpen(true)} data-testid="button-approve">
                            <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Approve & Make Active
                          </Button>
                        )}
                        {canReturnToDraft && (
                          <Button size="sm" variant="outline" onClick={() => setReturnOpen((v) => !v)}
                            data-testid="button-return-to-draft">
                            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Return to Draft
                          </Button>
                        )}
                        {!isAssignedReviewer && !isAssignedApprover && !isAdmin && (
                          <p className="text-xs text-muted-foreground italic">
                            You are not assigned to act on this document.
                          </p>
                        )}
                      </div>

                      {/* Return to Draft — hands the document back to its author to
                          edit. Clears the assignment and any signature from this
                          round; the round counter itself is kept. */}
                      {returnOpen && (
                        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2" data-testid="return-to-draft-form">
                          <p className="text-sm font-semibold text-amber-900">Return this document to Draft</p>
                          <p className="text-xs text-amber-900">
                            The author can edit it again. The Reviewer and Approver assignment and any signature from
                            this review round are cleared, and the reason below goes into the audit trail. The review
                            round is not rolled back — the next submission will read as the following round.
                          </p>
                          <div>
                            <Label htmlFor="return-reason" className="text-xs">Reason *</Label>
                            <Textarea id="return-reason" value={returnReason} rows={3} className="text-sm"
                              onChange={(e) => setReturnReason(e.target.value)}
                              placeholder="What needs to change before this can be reviewed?"
                              data-testid="input-return-reason" />
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" onClick={handleReturnToDraft}
                              disabled={returning || !returnReason.trim()}
                              data-testid="button-confirm-return">
                              {returning ? "Returning…" : "Return to Draft"}
                            </Button>
                            <Button size="sm" variant="ghost"
                              onClick={() => { setReturnOpen(false); setReturnReason(""); }}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* APPROVED / EFFECTIVE */}
                  {(status === "Approved" || status === "Effective") && (
                    <div className="space-y-3" data-testid="stage-approved">
                      <p className="text-sm font-semibold text-green-700 flex items-center gap-1">
                        <CheckCircle2 className="h-4 w-4" /> {status === "Effective" ? "Effective — in force" : "Approved — released"}
                      </p>
                      {status === "Approved" && (
                        <p className="text-xs text-muted-foreground">
                          Becomes <span className="font-medium">Effective</span> automatically once every assigned person is trained on this revision{canMarkEffective ? ", or mark it Effective now — anyone still untrained keeps their open assignment" : ""}.
                        </p>
                      )}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                        {doc.reviewerSignedName && (
                          <div className="rounded border bg-card p-2">
                            <p className="uppercase tracking-wide text-muted-foreground">Reviewed by</p>
                            <p className="font-medium">{doc.reviewerSignedName}</p>
                            <p className="text-muted-foreground">
                              {formatSignedAt(doc.reviewerSignedAt)}
                              {doc.reviewerSignedMeaning && ` · "${doc.reviewerSignedMeaning}"`}
                            </p>
                          </div>
                        )}
                        {doc.approvedByName && (
                          <div className="rounded border bg-card p-2">
                            <p className="uppercase tracking-wide text-muted-foreground">Approved by</p>
                            <p className="font-medium">{doc.approvedByName}</p>
                            <p className="text-muted-foreground">
                              {formatSignedAt(doc.approverSignedAt)}
                              {doc.approverSignedMeaning && ` · "${doc.approverSignedMeaning}"`}
                            </p>
                          </div>
                        )}
                        {(doc as { recipeConfirmedVersion?: number | null }).recipeConfirmedVersion != null && (
                          <div className="rounded border bg-card p-2">
                            <p className="uppercase tracking-wide text-muted-foreground">Recipe confirmed</p>
                            <p className="font-medium">
                              v{(doc as { recipeConfirmedVersion?: number | null }).recipeConfirmedVersion} current at approval
                            </p>
                            <p className="text-muted-foreground">
                              {(doc as { recipeConfirmedAt?: string | null }).recipeConfirmedAt &&
                                format(new Date((doc as { recipeConfirmedAt?: string | null }).recipeConfirmedAt as string), "MMM d, yyyy")}
                            </p>
                          </div>
                        )}
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        {status === "Approved" && canMarkEffective && (
                          <Button size="sm" onClick={() => setMarkEffectiveSigOpen(true)} data-testid="button-mark-effective">
                            <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Mark Effective
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => setNewRevOpen(true)} data-testid="button-new-revision">
                          Start New Revision
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setObsoleteSigOpen(true)} data-testid="button-obsolete">
                          <Archive className="h-3.5 w-3.5 mr-1" /> Mark Obsolete
                        </Button>
                        {status === "Approved" && canAdminMove && (
                          <Button size="sm" variant="outline" onClick={() => setRescindOpen((v) => !v)} data-testid="button-rescind-approval">
                            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Rescind Approval
                          </Button>
                        )}
                      </div>

                      {/* Administrative rescind (2026-08-27). Sits below the approval
                          it undoes, per the gate-card convention. Signatures are NOT
                          cleared — the panel says so, because that is the surprising
                          part for anyone used to Return to Draft. */}
                      {rescindOpen && status === "Approved" && (
                        <div className="border rounded-md p-4 bg-amber-50 border-amber-200 space-y-3" data-testid="panel-rescind-approval">
                          <p className="text-sm font-semibold text-amber-900 flex items-center gap-1">
                            <AlertTriangle className="h-4 w-4" /> Rescind this approval
                          </p>
                          <p className="text-xs text-amber-900">
                            An administrative move, recorded as its own entry in revision history and the audit log.
                            The reviewer and approver signatures stay exactly as signed — nothing is cleared or overwritten.
                            Training on this revision that is not yet complete is cancelled, and everyone is reassigned when it is approved again.
                          </p>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Send it back to</Label>
                            <Select value={rescindTarget} onValueChange={(v) => setRescindTarget(v as "Under Review" | "Draft")}>
                              <SelectTrigger className="h-9" data-testid="select-rescind-target">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="Under Review">Under Review — back to the approver, content unchanged</SelectItem>
                                <SelectItem value="Draft">Draft — reopen for editing (the only way back into the Document Body)</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Reason (required)</Label>
                            <Textarea
                              value={rescindReason}
                              onChange={(e) => setRescindReason(e.target.value)}
                              placeholder="Why is this approval being withdrawn?"
                              rows={3}
                              data-testid="input-rescind-reason"
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              disabled={!rescindReason.trim()}
                              onClick={() => setRescindSigOpen(true)}
                              data-testid="button-rescind-continue"
                            >
                              Continue to signature
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => { setRescindOpen(false); setRescindReason(""); }}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}

                      {newRevOpen && (
                        <div className="border rounded-md p-4 bg-card space-y-3">
                          <p className="text-sm font-semibold">Start New Revision</p>
                          <p className="text-xs text-muted-foreground">
                            Current rev {formatRevision(doc.revision, "Approved", 0)} stays <em>in force</em> in the version
                            history and is only marked <em>Superseded</em> once this new revision is approved.
                            The new draft must go through the full review and approval cycle again.
                          </p>
                          <div className="rounded border bg-muted/30 p-2 text-sm" data-testid="next-rev-note">
                            While in draft this reads{" "}
                            <span className="font-mono font-semibold">
                              Rev {String(Math.floor(parseFloat(String(doc.revision)) || 1))}.1
                            </span>{" "}
                            and ticks up (.2, .3, …) each review round, becoming{" "}
                            <span className="font-mono font-semibold">
                              Rev {String(Math.floor(parseFloat(String(doc.revision)) || 1) + 1)}.0
                            </span>{" "}
                            once approved.
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Change Severity *</Label>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {([
                                // Both cards sit NEUTRAL until one is picked. They used to carry
                                // their selected colour (Major in amber) while unselected, which read
                                // as already chosen — so the Start Revision button below looked broken
                                // when it was simply waiting for this required choice. Colour now means
                                // "selected", and amber still marks Major once it actually is.
                                { value: "Minor", label: "Minor", desc: "Editorial / clarification only — no retraining required.", style: "border-input bg-background", activeStyle: "border-slate-500 bg-slate-100 ring-2 ring-slate-400" },
                                { value: "Major", label: "Major", desc: "Substantive change — assigned trainees will be auto-retrained on approval.", style: "border-input bg-background", activeStyle: "border-amber-500 bg-amber-100 ring-2 ring-amber-400" },
                              ] as const).map((opt) => {
                                const selected = changeSeverity === opt.value;
                                return (
                                  <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => setChangeSeverity(opt.value)}
                                    className={`text-left rounded-md border-2 p-2.5 cursor-pointer transition-all ${selected ? opt.activeStyle : opt.style + " hover:border-foreground/40"}`}
                                    data-testid={`radio-severity-${opt.value.toLowerCase()}`}
                                  >
                                    <p className="text-sm font-semibold">{opt.label}</p>
                                    <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{opt.desc}</p>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          {changeSeverity === "Major" && (
                            <div className="text-xs rounded border border-amber-300 bg-amber-50 text-amber-900 p-2 flex items-start gap-2">
                              <GraduationCap className="h-4 w-4 shrink-0 mt-0.5" />
                              <span>
                                On approval, {trainingAudiencePhrase} will be assigned training, due in 10 business days.
                              </span>
                            </div>
                          )}
                          {changeSeverity === "Major" && (
                            <div className="space-y-1.5">
                              <Label className="text-xs">Retraining Method *</Label>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {([
                                  { value: "Read & Understand", label: "Read & Understand", desc: "Self-serve — each trainee acknowledges the new revision themselves in the app." },
                                  { value: "Instructor-Led", label: "Instructor-Led", desc: "A trainer runs one session, picks the roster, and signs once as trainer for everyone." },
                                ] as const).map((opt) => {
                                  const sel = retrainingMethod === opt.value;
                                  return (
                                    <button
                                      key={opt.value}
                                      type="button"
                                      onClick={() => setRetrainingMethod(opt.value)}
                                      className={`text-left rounded-md border-2 p-2.5 cursor-pointer transition-all ${sel ? "border-amber-500 bg-amber-100 ring-2 ring-amber-400" : "border-amber-300 bg-amber-50 hover:border-foreground/40"}`}
                                      data-testid={`radio-method-${opt.value === "Instructor-Led" ? "instructor" : "read"}`}
                                    >
                                      <p className="text-sm font-semibold">{opt.label}</p>
                                      <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{opt.desc}</p>
                                    </button>
                                  );
                                })}
                              </div>
                              <p className="text-[11px] text-muted-foreground">You can change this later while the document stays in Draft.</p>
                            </div>
                          )}
                          {/* Change impact — what else this revision may touch, put in
                              front of the author at the moment the change starts. */}
                          {(backingRecipe || (revisionImpactDocs ?? []).length > 0) && (
                            <div className="rounded-md border border-blue-200 bg-blue-50/60 p-3 space-y-2" data-testid="revision-impact">
                              <p className="text-xs font-semibold text-blue-900">What else this change may affect</p>
                              {backingRecipe && (
                                <div className="space-y-1.5">
                                  <p className="text-xs text-blue-900">
                                    Linked recipe: <span className="font-medium">{backingRecipe.productName}</span> (v{backingRecipe.version})
                                  </p>
                                  <Label className="text-xs">Does this revision also require a recipe update?</Label>
                                  <div className="flex gap-2">
                                    {([
                                      { value: true, label: "Yes" },
                                      { value: false, label: "No" },
                                    ] as const).map((opt) => {
                                      const sel = recipeUpdateNeeded === opt.value;
                                      return (
                                        <button
                                          key={opt.label}
                                          type="button"
                                          onClick={() => setRecipeUpdateNeeded(opt.value)}
                                          className={`rounded-md border-2 px-3 py-1 text-xs font-semibold transition-all ${sel ? "border-blue-500 bg-blue-100 ring-2 ring-blue-400 text-blue-900" : "border-blue-200 bg-white hover:border-foreground/40"}`}
                                          data-testid={`radio-recipe-update-${opt.label.toLowerCase()}`}
                                        >
                                          {opt.label}
                                        </button>
                                      );
                                    })}
                                  </div>
                                  {recipeUpdateNeeded === true && (
                                    <p className="text-[11px] text-blue-900">
                                      The recipe will show a notice that this revision flags it for update. Its items and
                                      process steps unlock while this document is in Draft, and the approver still has to
                                      confirm the recipe before this revision can be approved.
                                    </p>
                                  )}
                                  {recipeUpdateNeeded === false && (
                                    <p className="text-[11px] text-muted-foreground">
                                      No recipe change flagged. The approver will still confirm the recipe is current at approval.
                                    </p>
                                  )}
                                </div>
                              )}
                              {(revisionImpactDocs ?? []).length > 0 && (
                                <div>
                                  <p className="text-xs text-blue-900">Documents that reference this one:</p>
                                  <ul className="list-disc pl-5 text-[11px] text-blue-900 mt-0.5">
                                    {(revisionImpactDocs ?? []).map((d) => (
                                      <li key={d.id}>{d.docNumber} — {d.title} ({d.status})</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          )}
                          <div>
                            <Label htmlFor="new-rev-summary" className="text-xs">Summary of Changes</Label>
                            <Textarea id="new-rev-summary" value={revSummary} onChange={(e) => setRevSummary(e.target.value)}
                              placeholder="What changed?" rows={2} className="text-sm" />
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" onClick={saveNewRevision} disabled={savingNewRev || !changeSeverity} data-testid="button-confirm-revision">
                              {savingNewRev ? "Saving…" : "Start Revision"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => { setNewRevOpen(false); setChangeSeverity(""); }}>Cancel</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground italic">
                    This is a historical / read-only record. Its approval signatures are preserved in the History tab.
                  </p>
                  {/* Obsolete → Draft. ⛔ NOT to Effective: "we have to go through the
                      process" — a retired document comes back with no standing and
                      earns its way through review and approval again. A SUPERSEDED
                      revision is not offered at all; it belongs to revision history. */}
                  {status === "Obsolete" && canAdminMove && !isCancelled && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setReinstateOpen((v) => !v)} data-testid="button-reinstate-obsolete">
                        <RotateCcw className="h-3.5 w-3.5 mr-1" /> Bring Back to Draft
                      </Button>
                      {reinstateOpen && (
                        <div className="border rounded-md p-4 bg-amber-50 border-amber-200 space-y-3" data-testid="panel-reinstate-obsolete">
                          <p className="text-sm font-semibold text-amber-900 flex items-center gap-1">
                            <AlertTriangle className="h-4 w-4" /> Bring this document back
                          </p>
                          <p className="text-xs text-amber-900">
                            It returns as a <span className="font-medium">Draft</span>, not to force. Its approval, effective date and review
                            clock are cleared, and it goes through review and approval again before anyone works to it. The signature that
                            retired it stays on the record, and this move is recorded as its own entry in revision history and the audit log.
                          </p>
                          {/* Same choice Start New Revision asks for, and asked here for the
                              same reason: a document coming back from retirement carries the
                              severity it was retired with, so without this a WI nobody has
                              read since June could go back into force training nobody. */}
                          <div className="space-y-1.5">
                            <Label className="text-xs">Change Severity *</Label>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {([
                                { value: "Minor", label: "Minor", desc: "Editorial / clarification only — no retraining required.", style: "border-input bg-background", activeStyle: "border-slate-500 bg-slate-100 ring-2 ring-slate-400" },
                                { value: "Major", label: "Major", desc: "Substantive change — assigned trainees will be auto-retrained on approval.", style: "border-input bg-background", activeStyle: "border-amber-500 bg-amber-100 ring-2 ring-amber-400" },
                              ] as const).map((opt) => {
                                const selected = reinstateSeverity === opt.value;
                                return (
                                  <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => setReinstateSeverity(opt.value)}
                                    className={`text-left rounded-md border-2 p-2.5 cursor-pointer transition-all ${selected ? opt.activeStyle : opt.style + " hover:border-foreground/40"}`}
                                    data-testid={`radio-reinstate-severity-${opt.value.toLowerCase()}`}
                                  >
                                    <p className="text-sm font-semibold">{opt.label}</p>
                                    <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{opt.desc}</p>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Reason (required)</Label>
                            <Textarea
                              value={reinstateReason}
                              onChange={(e) => setReinstateReason(e.target.value)}
                              placeholder="Why is this document being brought back?"
                              rows={3}
                              data-testid="input-reinstate-reason"
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              disabled={!reinstateReason.trim() || !reinstateSeverity}
                              onClick={() => setReinstateSigOpen(true)}
                              data-testid="button-reinstate-continue"
                            >
                              Continue to signature
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => { setReinstateOpen(false); setReinstateReason(""); setReinstateSeverity(""); }}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </TabsContent>

            {/* HISTORY — read-only view of the revision records */}
            <TabsContent value="history" className="space-y-6 mt-4">
              <DocumentRevisionHistory docId={doc.id} />
            </TabsContent>

            {/* ATTACHMENTS — figures/charts/approval evidence (pending storage) */}
            <TabsContent value="attachments" className="space-y-6 mt-4">
              <AttachmentsPanel
                parentTable="documents"
                parentId={doc.id}
                showPrimarySlot={false}
                allowSupplementary={!isReadOnly}
                currentUserId={currentUser?.id}
                currentUserRole={currentUser?.role}
                title="Attachments — Figures, Charts & Approval Evidence"
              />
            </TabsContent>
          </Tabs>
        )}
      </div>

      {/* Part 11 dialogs */}
      <Part11SignatureDialog
        open={reviewSigOpen}
        onOpenChange={setReviewSigOpen}
        title="Sign as Reviewer"
        description={`I confirm I have reviewed ${doc?.docNumber ?? ""} rev ${doc?.revision ?? ""} and recommend it for approval.`}
        onSign={handleSignReview}
        isPending={signReview.isPending}
      />

      <Part11SignatureDialog
        open={approveSigOpen}
        onOpenChange={(o) => { setApproveSigOpen(o); }}
        title="Approve Document"
        description={`I approve ${doc?.docNumber ?? ""} rev ${doc?.revision ?? ""} for release, to come into force on the effective date set on the approval card. Next periodic review: ${doc?.reviewIntervalYears ?? 3} years from today.`}
        onSign={handleApprove}
        isPending={approveDoc.isPending}
      />

      <Part11SignatureDialog
        open={markEffectiveSigOpen}
        onOpenChange={setMarkEffectiveSigOpen}
        title="Mark Document Effective"
        description={`I am placing ${doc?.docNumber ?? ""} rev ${doc?.revision ?? ""} into force. Anyone with training still open on this revision keeps their assignment and must complete it when next available for work.`}
        onSign={handleMarkEffective}
        isPending={markingEffective}
      />

      <Part11SignatureDialog
        open={reinstateSigOpen}
        onOpenChange={setReinstateSigOpen}
        title="Bring Document Back to Draft"
        description={`I am bringing ${doc?.docNumber ?? ""} rev ${doc?.revision ?? ""} back from Obsolete. It returns as a Draft with no approval and no effective date, and must go through review and approval again before it is in force.`}
        onSign={handleReinstateObsolete}
        isPending={reinstating}
      />

      <Part11SignatureDialog
        open={rescindSigOpen}
        onOpenChange={setRescindSigOpen}
        title="Rescind Approval"
        description={`I am withdrawing the approval of ${doc?.docNumber ?? ""} rev ${doc?.revision ?? ""} and returning it to ${rescindTarget}. The signatures already given remain on the record; this move is recorded as an administrative override.`}
        onSign={handleRescindApproval}
        isPending={rescinding}
      />

      <Part11SignatureDialog
        open={obsoleteSigOpen}
        onOpenChange={setObsoleteSigOpen}
        title="Mark Document Obsolete"
        description={`I am retiring ${doc?.docNumber ?? ""} rev ${doc?.revision ?? ""}. The record will be retained for compliance.`}
        onSign={handleObsolete}
        isPending={obsoleteDoc.isPending}
      />

      {/* Session 52.1 — Cancel (rationale + Part 11 e-signature). */}
      <CancelRecordDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        entityLabel="Document"
        isPending={cancelPending}
        onConfirm={handleCancel}
      />

      {/* Session 52.1 — Re-open (Admin-only; Part 11 e-signature). */}
      <Part11SignatureDialog
        open={uncancelOpen}
        onOpenChange={setUncancelOpen}
        title="Re-open Document"
        description="Re-open this cancelled document and return it to active use. Restricted to Admin; requires an Admin signature."
        isPending={uncancelPending}
        onSign={handleUncancel}
      />
    </AppLayout>
  );
}

type AssigneeUser = { id: number; fullName: string; role: string; active: boolean };
type CoverageRow = {
  id: number;
  recordNumber: string;
  status: string;
  assignedToUserId: number | null;
  documentRevisionSnapshot: string | null;
  signedAt: string | null;
  signedInitials: string | null;
  dueDate: string | null;
  // Widened for the instructor-led flow (present in the coverage payload already).
  trainingType?: string | null;
  trainingSessionId?: string | null;
  employeeName?: string | null;
  completedDate?: string | null;
  trainerName?: string | null;
  signedByFullName?: string | null;
  sessionAttachmentId?: number | null;
};

const INSTRUCTOR_LED_TYPE = "Instructor-Led Process Change";
type CoverageResponse = {
  document: { id: number; revision: string };
  currentlyTrainedUserIds: number[];
  records: CoverageRow[];
};

type ReferencedByRow = { id: number; docNumber: string; title: string; status: string; note: string | null };

// Reverse link index: which other controlled documents list THIS one in their
// Associated Documents. The forward links live on the Document Body tab; this shows
// the other direction so the relationship is visible both ways.
function ReferencedByPanel({ docId }: { docId: number }) {
  const [rows, setRows] = useState<ReferencedByRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/documents/${docId}/referenced-by`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => { if (!cancelled) setRows(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [docId]);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Link2 className="h-4 w-4" /> Referenced by{rows ? ` (${rows.length})` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows === null ? (
          <Skeleton className="h-4 w-40" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No other documents reference this one.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-2">
                <Link href={`/documents/${r.id}`} className="text-primary hover:underline">
                  {r.docNumber} — {r.title}
                </Link>
                <span className="text-xs text-muted-foreground">· {r.status}</span>
                {r.note && <span className="text-xs text-muted-foreground">· {r.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

type LinkSuggestion = {
  reference: string;
  documentId: number | null;
  docNumber: string | null;
  title: string | null;
  confidence: string;
  method: string;
  reasoning: string | null;
};

// AI-assisted matching of a document's imported free-text "Associated Documents"
// references to real controlled documents. Only shows on a Draft that still has the
// importer's placeholder section. AI SUGGESTS, human confirms each match before any
// link is created (Part 11 / ISO 42001).
function AssociatedLinkSuggester({ docId, isDraft }: { docId: number; isDraft: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [placeholder, setPlaceholder] = useState<{ id: number; refs: number } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [suggestions, setSuggestions] = useState<LinkSuggestion[] | null>(null);
  const [placeholderSectionId, setPlaceholderSectionId] = useState<number | null>(null);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/documents/${docId}/sections`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((secs: { id: number; kind: string; title: string; bodyMarkdown: string | null }[]) => {
        if (cancelled) return;
        const ph = (Array.isArray(secs) ? secs : []).find(
          (s) => s.kind === "free_text" && (s.title ?? "").startsWith("Associated Documents"),
        );
        if (ph) {
          const refs = (ph.bodyMarkdown ?? "").split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean).length;
          setPlaceholder({ id: ph.id, refs });
        } else setPlaceholder(null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [docId, refreshKey]);

  if (!isDraft || !placeholder) return null;

  const runSuggest = async () => {
    setOpen(true); setLoading(true); setSuggestions(null);
    try {
      const r = await fetch(`/api/documents/${docId}/suggest-associated-links`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Failed to get suggestions");
      const sugg: LinkSuggestion[] = data.suggestions ?? [];
      setSuggestions(sugg);
      setPlaceholderSectionId(data.placeholderSectionId ?? null);
      const pre = new Set<number>();
      sugg.forEach((s, i) => { if (s.documentId != null && (s.confidence === "high" || s.confidence === "medium")) pre.add(i); });
      setAccepted(pre);
    } catch (e) {
      toast({ title: "Couldn't get suggestions", description: e instanceof Error ? e.message : "Error", variant: "destructive" });
      setOpen(false);
    } finally { setLoading(false); }
  };

  const toggle = (i: number) => setAccepted((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });

  const apply = async () => {
    if (!suggestions) return;
    const docIds = Array.from(accepted).map((i) => suggestions[i]?.documentId).filter((x): x is number => typeof x === "number");
    if (docIds.length === 0) { toast({ title: "Nothing selected", variant: "destructive" }); return; }
    const allHandled = suggestions.every((s, i) => accepted.has(i) && s.documentId != null);
    setApplying(true);
    try {
      const r = await fetch(`/api/documents/${docId}/apply-associated-links`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: docIds, removeSectionId: allHandled ? placeholderSectionId : undefined, aiAssisted: true }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Failed to add links");
      toast({ title: "Links added", description: `${data.linked} associated document link${data.linked === 1 ? "" : "s"} created${data.removedPlaceholder ? "; imported note cleared" : ""}.` });
      setOpen(false); setSuggestions(null); setAccepted(new Set());
      qc.invalidateQueries({ queryKey: [`/api/documents/${docId}/sections`] });
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast({ title: "Couldn't add links", description: e instanceof Error ? e.message : "Error", variant: "destructive" });
    } finally { setApplying(false); }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Link2 className="h-4 w-4" /> Imported references</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          This document has {placeholder.refs} imported associated-document reference{placeholder.refs === 1 ? "" : "s"} stored as text. Match them to real controlled documents.
        </p>
        {!open ? (
          <Button size="sm" variant="outline" onClick={runSuggest} data-testid="button-match-links">
            <Link2 className="h-3.5 w-3.5 mr-1" /> Match to documents (AI)
          </Button>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">Matching references…</p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {(suggestions ?? []).map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-sm border rounded p-2">
                  <input type="checkbox" className="mt-1" checked={accepted.has(i)} disabled={s.documentId == null} onChange={() => toggle(i)} data-testid={`checkbox-link-${i}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-muted-foreground">“{s.reference}”</p>
                    {s.documentId != null ? (
                      <p>
                        {s.docNumber} — {s.title}
                        <span className={`ml-2 text-[10px] uppercase rounded px-1 py-0.5 ${s.confidence === "high" ? "bg-green-100 text-green-800" : s.confidence === "medium" ? "bg-yellow-100 text-yellow-800" : "bg-slate-100 text-slate-700"}`}>
                          {s.method === "exact" ? "exact match" : `${s.confidence} · AI`}
                        </span>
                      </p>
                    ) : (
                      <p className="text-muted-foreground italic">No confident match — add it manually below.</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button size="sm" onClick={apply} disabled={applying || accepted.size === 0} data-testid="button-apply-links">
                {applying ? "Adding…" : `Add ${accepted.size} link${accepted.size === 1 ? "" : "s"}`}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setSuggestions(null); }}>Cancel</Button>
            </div>
            <p className="text-[11px] text-muted-foreground">AI suggestions — review before adding. Exact document-number matches are found without AI.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DocumentTrainingPanel(props: {
  docId: number;
  docNumber: string;
  docTitle: string;
  revision: string;
  eligibleAssignees: AssigneeUser[];
  canAssign: boolean;
  retrainingMethod: string | null;
  docStatus: string;
}) {
  const { toast } = useToast();
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dueDate, setDueDate] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  // Instructor-led session state.
  const [sessionOpen, setSessionOpen] = useState(false);
  const [sessionRoster, setSessionRoster] = useState<Set<number>>(new Set());
  const [sessionDate, setSessionDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [sessionNotes, setSessionNotes] = useState<string>("");
  const [sessionFile, setSessionFile] = useState<File | null>(null);
  const sessionFileRef = useRef<HTMLInputElement | null>(null);
  const [sigOpen, setSigOpen] = useState(false);
  const [sessionSubmitting, setSessionSubmitting] = useState(false);
  // Map attachment id → {objectPath, fileName} so a recorded session's paper
  // sign-in sheet can be linked for download in the rollup.
  const [attachMap, setAttachMap] = useState<Map<number, { objectPath: string; fileName: string }>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/training/document/${props.docId}/coverage`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(await r.json().catch(() => ({})))))
      .then((data: CoverageResponse) => { if (!cancelled) setCoverage(data); })
      .catch(() => { if (!cancelled) setCoverage(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.docId, refreshKey]);

  // Load the document's attachments so a session's paper sign-in sheet is linkable.
  useEffect(() => {
    let cancelled = false;
    const base = (import.meta.env.BASE_URL ?? "/") as string;
    fetch(`${base}api/attachments?parentTable=documents&parentId=${props.docId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Array<{ id: number; objectPath: string; fileName: string }>) => {
        if (cancelled) return;
        const m = new Map<number, { objectPath: string; fileName: string }>();
        (Array.isArray(list) ? list : []).forEach((a) => m.set(a.id, { objectPath: a.objectPath, fileName: a.fileName }));
        setAttachMap(m);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [props.docId, refreshKey]);

  const trainedSet = new Set(coverage?.currentlyTrainedUserIds ?? []);
  // Coverage is measured against the people ASSIGNED this document's current revision
  // (not the whole roster) — so "1 of 1 assigned, trained" reads 100%.
  const assignedRecords = (coverage?.records ?? []).filter(
    (r) => r.assignedToUserId != null && r.documentRevisionSnapshot === props.revision,
  );
  // user id → a record for this rev (prefer a Completed one) for per-person links.
  const recordByUser = new Map<number, CoverageRow>();
  for (const r of assignedRecords) {
    const uid = r.assignedToUserId as number;
    const cur = recordByUser.get(uid);
    // Prefer a Completed record, then any live one, and fall back to a Cancelled
    // record only when it is all this person has — otherwise a reissued assignment
    // would be hidden behind the cancelled one it replaced.
    const rank = (st: string) => (st === "Completed" ? 2 : st === "Cancelled" ? 0 : 1);
    if (!cur || rank(r.status) > rank(cur.status)) recordByUser.set(uid, r);
  }
  const assignedIds = new Set(recordByUser.keys());
  const assignedUsers = props.eligibleAssignees.filter((u) => assignedIds.has(u.id));
  const trained = assignedUsers.filter((u) => trainedSet.has(u.id));
  const untrained = assignedUsers.filter((u) => !trainedSet.has(u.id));

  const toggle = (id: number) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const submit = async () => {
    if (selected.size === 0) {
      toast({ title: "No users selected", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/training/assign-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: props.docId,
          userIds: Array.from(selected),
          dueDate: dueDate || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      toast({
        title: "Training assigned",
        description: `${data.assigned} created, ${data.skipped} already current.`,
      });
      setSelected(new Set());
      setOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast({
        title: "Assign failed",
        description: e instanceof Error ? e.message : "Unable to assign training.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const total = assignedUsers.length;
  const trainedCount = trained.length;
  const pct = total > 0 ? Math.round((trainedCount / total) * 100) : 0;

  // ── Instructor-led retraining ──────────────────────────────────────────────
  const records = coverage?.records ?? [];
  const nameFor = (uid: number | null) => props.eligibleAssignees.find((u) => u.id === uid)?.fullName ?? "";
  // Users who owe instructor-led retraining on this revision (assignment not yet completed).
  const owedInstructorLedIds = new Set(
    records
      .filter((r) => r.trainingType === INSTRUCTOR_LED_TYPE
        && r.documentRevisionSnapshot === props.revision
        && ["Assigned", "In Progress", "Overdue"].includes(r.status))
      .map((r) => r.assignedToUserId)
      .filter((x): x is number => typeof x === "number"),
  );
  // Completed records grouped by session, newest first, for a rolled-up view.
  const sessionGroups = (() => {
    const map = new Map<string, CoverageRow[]>();
    for (const r of records) {
      if (r.trainingSessionId) {
        const arr = map.get(r.trainingSessionId) ?? [];
        arr.push(r);
        map.set(r.trainingSessionId, arr);
      }
    }
    return Array.from(map.entries()).sort((a, b) =>
      (b[1][0]?.completedDate ?? "").localeCompare(a[1][0]?.completedDate ?? ""));
  })();
  const isInstructorLed = props.retrainingMethod === "Instructor-Led";
  const showSessionUI = props.canAssign && (isInstructorLed || owedInstructorLedIds.size > 0 || sessionGroups.length > 0);

  const openSession = () => {
    setSessionRoster(new Set(owedInstructorLedIds));
    setSessionOpen(true);
  };
  const toggleRoster = (uid: number) => {
    setSessionRoster((s) => { const n = new Set(s); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });
  };
  const submitSession = async (initials: string, meaning: string) => {
    setSessionSubmitting(true);
    try {
      const base = (import.meta.env.BASE_URL ?? "/") as string;
      // Optionally upload the scanned paper sign-in sheet first (2-step: bytes →
      // storage, then an attachment row on this document), and link its id to the
      // session. Reuses the same attachment pipeline as the Attachments tab.
      let attachmentId: number | undefined;
      if (sessionFile) {
        if (sessionFile.size > 50 * 1024 * 1024) throw new Error("Sign-in sheet is over the 50 MB limit.");
        const fd = new FormData();
        fd.append("file", sessionFile);
        const up = await fetch(`${base}api/storage/upload`, { method: "POST", credentials: "include", body: fd });
        const upData = await up.json().catch(() => ({}));
        if (!up.ok) throw new Error(upData.error ?? "Sign-in sheet upload failed.");
        const ar = await fetch(`${base}api/attachments`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parentTable: "documents",
            parentId: props.docId,
            kind: "supplementary",
            objectPath: upData.objectPath,
            fileName: upData.fileName ?? sessionFile.name,
            contentType: upData.contentType ?? sessionFile.type,
            sizeBytes: upData.sizeBytes ?? sessionFile.size,
          }),
        });
        const aData = await ar.json();
        if (!ar.ok) throw new Error(aData.error ?? "Failed to save the sign-in sheet.");
        attachmentId = aData.id as number;
      }
      const res = await fetch(`/api/training/document/${props.docId}/instructor-led-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          initials,
          meaning,
          completedDate: sessionDate || undefined,
          userIds: Array.from(sessionRoster),
          notes: sessionNotes || undefined,
          attachmentId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to record session");
      toast({
        title: "Instructor-led session recorded",
        description: `${(data.completed ?? 0) + (data.created ?? 0)} attendee record(s) completed${data.skipped ? `, ${data.skipped} already current` : ""}${attachmentId ? " · sign-in sheet attached" : ""}.`,
      });
      setSessionOpen(false);
      setSessionNotes("");
      setSessionFile(null);
      if (sessionFileRef.current) sessionFileRef.current.value = "";
      setSessionRoster(new Set());
      setRefreshKey((k) => k + 1);
    } finally {
      setSessionSubmitting(false);
    }
  };

  // Coverage tracks readiness for the RELEASE this document is heading toward, always
  // shown as major.0 (e.g. 2.0). The raw props.revision is still used for record
  // matching above; this is display only.
  const revLabel = `${Math.floor(parseFloat(String(props.revision)) || 1)}.0`;
  const underRevision = props.docStatus === "Draft" || props.docStatus === "Under Review";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <GraduationCap className="h-4 w-4" />
          Training Coverage — Rev {revLabel}{underRevision ? " (upcoming release)" : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full ${pct === 100 ? "bg-green-600" : pct >= 50 ? "bg-yellow-500" : "bg-red-500"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-sm font-semibold tabular-nums">
            {trainedCount}/{total} ({pct}%)
          </span>
        </div>

        {loading ? (
          <Skeleton className="h-4 w-32" />
        ) : (
          <>
            {total === 0 ? (
              <p className="text-xs text-muted-foreground italic">No training assigned for this revision yet.</p>
            ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div>
                <p className="font-semibold text-green-700 mb-1 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Trained on current rev ({trained.length})
                </p>
                <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                  {trained.length === 0 && <li className="text-muted-foreground italic">None yet</li>}
                  {trained.map((u) => {
                    const rid = recordByUser.get(u.id)?.id;
                    return (
                      <li key={u.id} className="text-foreground">
                        {rid ? <Link href={`/training/${rid}`} className="text-primary hover:underline">{u.fullName}</Link> : u.fullName}
                        <span className="text-muted-foreground"> · {u.role}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div>
                <p className="font-semibold text-red-700 mb-1 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> Not yet trained ({untrained.length})
                </p>
                <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                  {untrained.length === 0 && <li className="text-muted-foreground italic">All assigned people trained</li>}
                  {untrained.map((u) => {
                    const rec = recordByUser.get(u.id);
                    const rid = rec?.id;
                    // 2026-08-27 — someone whose assignment was CANCELLED (the approval
                    // that issued it was rescinded) is still untrained, and Jonathan kept
                    // them counted here for exactly that reason. But without saying so the
                    // line reads as an open assignment chasing them, when nothing is.
                    const isCancelled = rec?.status === "Cancelled";
                    return (
                      <li key={u.id} className="text-foreground">
                        {rid ? <Link href={`/training/${rid}`} className="text-primary hover:underline">{u.fullName}</Link> : u.fullName}
                        <span className="text-muted-foreground"> · {u.role}</span>
                        {isCancelled && (
                          <span className="ml-1 text-[11px] text-muted-foreground italic">— assignment cancelled, nothing outstanding</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
            )}
          </>
        )}

        {props.canAssign && !["Approved", "Effective"].includes(props.docStatus) && (
          <p className="text-xs text-muted-foreground border-t pt-2">
            Training can be assigned once this document is Approved.
          </p>
        )}
        {props.canAssign && ["Approved", "Effective"].includes(props.docStatus) && (
          <div>
            {!open ? (
              <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="button-assign-training">
                <Users className="h-3.5 w-3.5 mr-1" /> Assign Training
              </Button>
            ) : (
              <div className="border rounded-md p-3 bg-muted/30 space-y-3">
                <p className="text-sm font-semibold">Assign “{props.docNumber} {props.docTitle}” to:</p>
                <div className="max-h-48 overflow-y-auto border rounded bg-card p-2 space-y-1">
                  {props.eligibleAssignees.map((u) => {
                    const alreadyTrained = trainedSet.has(u.id);
                    return (
                      <label key={u.id} className="flex items-center gap-2 text-sm py-0.5">
                        <input
                          type="checkbox"
                          checked={selected.has(u.id)}
                          onChange={() => toggle(u.id)}
                          disabled={alreadyTrained}
                          data-testid={`checkbox-assign-user-${u.id}`}
                        />
                        <span className={alreadyTrained ? "text-muted-foreground line-through" : ""}>
                          {u.fullName} <span className="text-xs text-muted-foreground">· {u.role}</span>
                          {alreadyTrained && <span className="ml-1 text-xs text-green-700">(already trained)</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="ass-due" className="text-xs">Due date (optional)</Label>
                  <Input
                    id="ass-due"
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="text-sm w-44"
                    data-testid="input-assign-due-date"
                  />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={submit} disabled={submitting || selected.size === 0} data-testid="button-confirm-assign">
                    {submitting ? "Assigning…" : `Assign to ${selected.size} user${selected.size === 1 ? "" : "s"}`}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setSelected(new Set()); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {showSessionUI && (
          <div className="border-t pt-3 space-y-3" data-testid="instructor-led-section">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold flex items-center gap-1">
                <GraduationCap className="h-4 w-4" /> Instructor-led retraining
              </p>
              {!sessionOpen && (
                <Button size="sm" variant="outline" onClick={openSession} data-testid="button-instructor-session">
                  <Users className="h-3.5 w-3.5 mr-1" /> Record session
                </Button>
              )}
            </div>
            {owedInstructorLedIds.size > 0 && !sessionOpen && (
              <p className="text-xs text-amber-800">
                {owedInstructorLedIds.size} {owedInstructorLedIds.size === 1 ? "person owes" : "people owe"} instructor-led retraining on Rev {revLabel}.
              </p>
            )}

            {sessionOpen && (
              <div className="border rounded-md p-3 bg-muted/30 space-y-3">
                <p className="text-sm font-semibold">Record instructor-led session — Rev {revLabel}</p>
                <p className="text-[11px] text-muted-foreground">
                  Pick everyone who attended, then sign once as the trainer. Each attendee gets their own completed record under a single session.
                  Owed trainees are pre-selected. A scanned paper sign-in sheet can be added on the Attachments tab.
                </p>
                <div className="max-h-48 overflow-y-auto border rounded bg-card p-2 space-y-1">
                  {props.eligibleAssignees.map((u) => (
                    <label key={u.id} className="flex items-center gap-2 text-sm py-0.5">
                      <input
                        type="checkbox"
                        checked={sessionRoster.has(u.id)}
                        onChange={() => toggleRoster(u.id)}
                        data-testid={`checkbox-session-user-${u.id}`}
                      />
                      <span>
                        {u.fullName} <span className="text-xs text-muted-foreground">· {u.role}</span>
                        {owedInstructorLedIds.has(u.id) && <span className="ml-1 text-xs text-amber-700">(owed)</span>}
                      </span>
                    </label>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="sess-date" className="text-xs">Training date</Label>
                  <Input
                    id="sess-date"
                    type="date"
                    value={sessionDate}
                    onChange={(e) => setSessionDate(e.target.value)}
                    className="text-sm w-44"
                    data-testid="input-session-date"
                  />
                </div>
                <div>
                  <Label htmlFor="sess-notes" className="text-xs">Notes (optional)</Label>
                  <Textarea
                    id="sess-notes"
                    value={sessionNotes}
                    onChange={(e) => setSessionNotes(e.target.value)}
                    rows={2}
                    className="text-sm"
                    placeholder="e.g. location, make-up plan, etc."
                  />
                </div>
                <div>
                  <Label htmlFor="sess-sheet" className="text-xs">Scanned sign-in sheet (optional)</Label>
                  <Input
                    id="sess-sheet"
                    ref={sessionFileRef}
                    type="file"
                    accept="image/*,application/pdf"
                    onChange={(e) => setSessionFile(e.target.files?.[0] ?? null)}
                    className="text-sm"
                    data-testid="input-session-sheet"
                  />
                  {sessionFile && (
                    <p className="text-[11px] text-muted-foreground mt-0.5">Attaching: {sessionFile.name}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setSigOpen(true)} disabled={sessionRoster.size === 0} data-testid="button-session-sign">
                    Sign as trainer &amp; complete ({sessionRoster.size})
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setSessionOpen(false); setSessionRoster(new Set()); setSessionFile(null); if (sessionFileRef.current) sessionFileRef.current.value = ""; }}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {sessionGroups.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">Recorded sessions</p>
                <ul className="space-y-1">
                  {sessionGroups.map(([sid, rows]) => {
                    const sheetId = rows.find((r) => r.sessionAttachmentId)?.sessionAttachmentId ?? null;
                    const sheet = sheetId ? attachMap.get(sheetId) : null;
                    const base = (import.meta.env.BASE_URL ?? "/") as string;
                    return (
                      <li key={sid} className="text-xs border rounded p-2 bg-card">
                        <span className="font-mono">{sid}</span> · {rows.length} {rows.length === 1 ? "attendee" : "attendees"}
                        {rows[0]?.completedDate && <> · {rows[0].completedDate}</>}
                        {rows[0]?.signedByFullName && <> · trainer {rows[0].signedByFullName}</>}
                        {sheet && (
                          <> · <a href={`${base}api/storage${sheet.objectPath}`} target="_blank" rel="noopener noreferrer" className="text-primary underline">Sign-in sheet</a></>
                        )}
                        <div className="text-muted-foreground mt-0.5">
                          {rows.map((r) => r.employeeName ?? nameFor(r.assignedToUserId)).filter(Boolean).join(", ")}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}

        <Part11SignatureDialog
          open={sigOpen}
          onOpenChange={setSigOpen}
          title="Sign as Trainer"
          description={`I attest I trained the ${sessionRoster.size} selected ${sessionRoster.size === 1 ? "person" : "people"} on ${props.docNumber} rev ${props.revision}.`}
          onSign={submitSession}
          isPending={sessionSubmitting}
        />
      </CardContent>
    </Card>
  );
}



type RevisionRow = {
  id: number;
  revision: string;
  status: string;
  summaryOfChanges: string | null;
  changeSeverity: string | null;
  authorName: string | null;
  reviewerName: string | null;
  approvedByName: string | null;
  approvalDate: string | null;
  createdAt: string;
  /** Whether the revision's content itself was retained, not just the fact of it. */
  retained?: boolean;
  /** Set on rows written by an ADMINISTRATIVE move (2026-08-27) rather than by the
      normal change process. These are events, not version states. */
  adminAction?: string | null;
  adminReason?: string | null;
  adminByName?: string | null;
  adminByInitials?: string | null;
  adminMeaning?: string | null;
};

// History tab — reads the revision records from the change process (no manual
// entry). Each approved change writes a row on the server; we just render them.
function DocumentRevisionHistory({ docId }: { docId: number }) {
  const [rows, setRows] = useState<RevisionRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/documents/${docId}/revisions`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to load revisions"))))
      .then((data: RevisionRow[]) => { if (!cancelled) setRows(data); })
      .catch(() => { if (!cancelled) setRows([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [docId]);

  // One row per version. A version can have both an "Approved" record and a later
  // "Superseded"/"Obsolete" record — collapse them so each version shows once, in
  // its current state (most advanced status wins; newest as tie-break).
  //
  // ADMINISTRATIVE rows (2026-08-27) are exempt from that collapse. A rescind writes
  // a row whose status is where the document went BACK to, which ranks below the
  // approval it undid — so the collapse dropped it and the move was invisible on
  // screen even though it was recorded. They are events on a version, not a state
  // of it, and each one is shown on its own line above the version it acted on.
  const displayRows = (() => {
    if (!rows) return [];
    const rank = (s: string) =>
      s === "Obsolete" ? 4 : s === "Superseded" ? 3 : s === "Effective" ? 2 : s === "Approved" ? 1 : 0;
    const adminRows = rows.filter((r) => r.adminAction);
    const byMajor = new Map<number, RevisionRow>();
    for (const r of rows) {
      if (r.adminAction) continue;
      const major = Math.floor(parseFloat(String(r.revision)) || 0);
      const cur = byMajor.get(major);
      if (
        !cur ||
        rank(r.status) > rank(cur.status) ||
        (rank(r.status) === rank(cur.status) && new Date(r.createdAt) > new Date(cur.createdAt))
      ) {
        byMajor.set(major, r);
      }
    }
    const versions = Array.from(byMajor.values()).sort(
      (a, b) => (parseFloat(String(b.revision)) || 0) - (parseFloat(String(a.revision)) || 0),
    );
    // Newest first, mixing versions and administrative events on one timeline.
    // Grouping the events under the version they belong to put a reinstatement —
    // which starts a NEW revision — in a group of its own that landed at the bottom,
    // below the older row it followed. A single reverse-chronological sort is what a
    // history is, and it cannot strand a row: everything sorts, nothing is bucketed.
    // Same-instant ties put the administrative row on top, because a move is what
    // produced the version row beside it.
    const at = (r: RevisionRow) => new Date(r.createdAt).getTime();
    return [...versions, ...adminRows].sort((a, b) => {
      const d = at(b) - at(a);
      if (d !== 0) return d;
      if (!!a.adminAction !== !!b.adminAction) return a.adminAction ? -1 : 1;
      return (parseFloat(String(b.revision)) || 0) - (parseFloat(String(a.revision)) || 0);
    });
  })();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <History className="h-4 w-4" /> Revision History
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-4"><Skeleton className="h-4 w-40" /></div>
        ) : displayRows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground italic">
            No revision history yet. Each approved change adds a record here.
          </p>
        ) : (
          <div className="divide-y">
            {displayRows.map((rev) => rev.adminAction ? (
              /* An administrative move. Rendered as an event on its own line —
                 amber, no View button (nothing was revised), and it names the
                 actor, their initials and the reason, because that is the record
                 the move is required to leave. */
              <div key={rev.id} className="px-4 py-3 flex items-start gap-4 bg-amber-50/60" data-testid={`revision-admin-${rev.id}`}>
                <div className="shrink-0 mt-0.5">
                  {/* Read through the SAME formatter the Document Control list uses,
                      so the number here can never disagree with the number there —
                      which is exactly what went wrong when this rendered the version
                      the move acted on while the list showed the live one. */}
                  <span className="font-mono text-sm font-semibold text-amber-700 whitespace-nowrap">
                    Rev {formatRevision(rev.revision, rev.status, 0)}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-amber-100 text-amber-900 border-amber-300">
                      <AlertTriangle className="h-3 w-3" /> Administrative override
                    </span>
                    <span className="text-xs font-medium text-amber-900">{rev.adminAction}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {rev.adminByName}
                    {rev.adminByInitials ? ` (${rev.adminByInitials})` : ""}
                    {rev.adminMeaning ? ` · signed "${rev.adminMeaning}"` : ""}
                  </p>
                  {rev.adminReason && (
                    <p className="text-xs text-amber-900 mt-1 whitespace-pre-wrap">
                      <span className="font-medium">Reason:</span> {rev.adminReason}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {format(new Date(rev.createdAt), "MMM d, yyyy h:mm a")}
                  </div>
                </div>
              </div>
            ) : (
              <div key={rev.id} className="px-4 py-3 flex items-start gap-4">
                <div className="shrink-0 mt-0.5">
                  <span className="font-mono text-sm font-semibold text-primary">Rev {formatRevision(rev.revision, rev.status, 0)}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_STYLES[rev.status] ?? "bg-slate-100 text-slate-600"}`}>
                      {rev.status}
                    </span>
                    {rev.changeSeverity && (
                      <span className="text-xs text-muted-foreground">{rev.changeSeverity} change</span>
                    )}
                    {rev.approvedByName && (
                      <span className="text-xs text-muted-foreground">· Approved by {rev.approvedByName}</span>
                    )}
                    {rev.reviewerName && (
                      <span className="text-xs text-muted-foreground">· Reviewed by {rev.reviewerName}</span>
                    )}
                  </div>
                  {rev.summaryOfChanges && (
                    <p className="text-xs text-muted-foreground mt-1">{rev.summaryOfChanges}</p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {format(rev.approvalDate ? parseISO(rev.approvalDate) : new Date(rev.createdAt), "MMM d, yyyy")}
                  </div>
                  {/* The retained copy of this revision — readable and printable as it
                      stood. Revisions approved before retention existed say so rather
                      than offering a link to nothing. */}
                  {rev.retained ? (
                    <Link href={`/documents/${docId}/revisions/${rev.id}`}>
                      <Button size="sm" variant="outline" className="h-7" data-testid={`button-view-revision-${rev.id}`}>
                        <FileText className="h-3.5 w-3.5 mr-1" /> View
                      </Button>
                    </Link>
                  ) : (
                    <span className="text-[11px] text-muted-foreground italic whitespace-nowrap" title="This revision was approved before revision content was retained.">
                      not retained
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
