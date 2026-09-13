import { useState, useEffect, useCallback } from "react";
import { SiteBadge } from "@/components/FacilitySite";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { accentClass, toneCapaStatus } from "@/lib/status";
import { useToast } from "@/hooks/use-toast";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { CancelRecordDialog } from "@/components/dialogs/CancelRecordDialog";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
// Session 29 — Session-20/27.1 typed hooks replace the raw `fetch()` pattern
// that lived throughout this page. The local `patch` and `fetchCapa` helpers
// keep their existing call signatures so the ~100 internal call sites don't
// have to change; only the implementation under the hood is swapped.
import {
  useGetCurrentUser,
  useListAuditLog,
  useGetCapa,
  useUpdateCapa,
  useListUsers,
  useAdvanceCapaStatus,
  useAdvanceCapaStage,
  useGate0ApproveCapa,
  useGate1ApproveCapa,
  useGate1RejectCapa,
  useGate2ApproveCapa,
  useVerifyCapaEffectiveness,
  useCloseCapa,
  useCreateCapaActionItem,
  useUpdateCapaActionItem,
  useDeleteCapaActionItem,
  useVerifyCapaActionItem,
  getGetCapaQueryKey,
} from "@workspace/api-client-react";
import type { AuditLogEntry } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { format, isPast, parseISO } from "date-fns";
import {
  CheckCircle2, AlertCircle, Clock, ChevronRight, Search,
  ClipboardList, TrendingUp, ShieldCheck, Plus, Trash2,
  ExternalLink, Printer, AlertTriangle, XCircle, FlaskConical,
  History, UserCheck, PenLine, FilePlus, Ban, RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Roles permitted to Cancel (mirror server CANCEL_ROLES). Re-open is Admin-only.
const CAPA_CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);

// ── Audit trail helpers ───────────────────────────────────────────────────────

const CAPA_FIELD_LABELS: Record<string, string> = {
  status: "Status",
  type: "Type",
  title: "Title",
  description: "Description",
  openedByName: "Opened By",
  capaNumber: "CAPA Number",
  rootCauseAnalysis: "Root Cause Analysis",
  rcaMethod: "RCA Method",
  effectivenessCriteria: "Acceptance Criteria",
  effectivenessCheckDue: "Effectiveness Due Date",
  effectivenessOutcome: "Effectiveness Outcome",
  effectivenessVerifiedByName: "Verified By",
  effectivenessVerifiedByInitials: "Verifier Initials",
  effectivenessNotes: "Effectiveness Notes",
  closedByName: "Closed By",
  closedByInitials: "Closed By Initials",
  closureNotes: "Closure Notes",
};

const SKIP_FIELDS = new Set(["updatedAt", "createdAt", "id", "changedAt"]);

function entryIcon(entry: AuditLogEntry) {
  if (entry.operation === "INSERT") return <FilePlus className="h-3.5 w-3.5 text-green-600" />;
  const after = entry.afterState as Record<string, unknown> | null;
  if (after?.effectivenessOutcome) return <UserCheck className="h-3.5 w-3.5 text-indigo-600" />;
  if (after?.status === "Closed") return <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />;
  if (after?.status) return <ChevronRight className="h-3.5 w-3.5 text-blue-600" />;
  return <PenLine className="h-3.5 w-3.5 text-slate-500" />;
}

function entrySummary(entry: AuditLogEntry): string {
  if (entry.operation === "INSERT") return "CAPA created";
  const after = entry.afterState as Record<string, unknown> | null;
  if (!after) return "Record updated";
  if (after.effectivenessOutcome) {
    return `Effectiveness verified — ${after.effectivenessOutcome}`;
  }
  if (after.status === "Closed") return "CAPA closed";
  if (after.status && Object.keys(after).filter(k => !SKIP_FIELDS.has(k)).length === 1) {
    const before = entry.beforeState as Record<string, unknown> | null;
    return before?.status
      ? `Status: ${before.status} → ${after.status}`
      : `Status advanced to ${after.status}`;
  }
  const keys = Object.keys(after).filter(k => !SKIP_FIELDS.has(k));
  if (keys.length === 1) return `${CAPA_FIELD_LABELS[keys[0]] ?? keys[0]} updated`;
  return `${keys.length} fields updated`;
}

function entryDiffRows(entry: AuditLogEntry): { label: string; before: string | null; after: string }[] {
  if (entry.operation === "INSERT") return [];
  const after = entry.afterState as Record<string, unknown> | null;
  const before = entry.beforeState as Record<string, unknown> | null;
  if (!after) return [];
  return Object.keys(after)
    .filter(k => !SKIP_FIELDS.has(k))
    .map(k => ({
      label: CAPA_FIELD_LABELS[k] ?? k,
      before: before ? String(before[k] ?? "—") : null,
      after: String(after[k] ?? "—"),
    }));
}

// ── Types ─────────────────────────────────────────────────────────────────────

type ActionItem = {
  id: number;
  capaId: number;
  sequenceNumber: number;
  actionDescription: string;
  assignedToId: number | null;
  assignedToName: string | null;
  dueDate: string | null;
  status: string;
  completedAt: string | null;
  completedByName: string | null;
  verifiedAt: string | null;
  verifiedByName: string | null;
  notes: string | null;
  createdAt: string;
};

type CapaDetail = {
  id: number;
  capaNumber: string;
  type: string;
  title: string;
  description: string;
  sourceNcId: number | null;
  sourceComplaintId: number | null;
  rootCauseAnalysis: string | null;
  rcaMethod: string | null;
  rcaMethods: string[] | null;
  effectivenessCriteria: string | null;
  effectivenessCheckDue: string | null;
  effectivenessVerifiedAt: string | null;
  effectivenessVerifiedByName: string | null;
  effectivenessVerifiedByInitials: string | null;
  effectivenessOutcome: string | null;
  effectivenessNotes: string | null;
  status: string;
  stage: string;
  originatorId: number | null;
  originatorName: string | null;
  effectivenessOwnerId: number | null;
  effectivenessOwnerName: string | null;
  // Session 35 — Gate 0 (Manager/Quality acceptance, Initiation → Investigation)
  gate0ApproverId: number | null;
  gate0ApproverName: string | null;
  gate0ApproverInitials: string | null;
  gate0ApproverAt: string | null;
  gate0ApproverMeaning: string | null;
  gate0ApprovedAt: string | null;
  // Gate 1 — two distinct approvers
  gate1Approver1Id: number | null;
  gate1Approver1Name: string | null;
  gate1Approver1Initials: string | null;
  gate1Approver1At: string | null;
  gate1Approver1Meaning: string | null;
  gate1Approver2Id: number | null;
  gate1Approver2Name: string | null;
  gate1Approver2Initials: string | null;
  gate1Approver2At: string | null;
  gate1Approver2Meaning: string | null;
  gate1ApprovedAt: string | null;
  // Gate 2 — single approver Pass/Fail
  gate2ApproverId: number | null;
  gate2ApproverName: string | null;
  gate2ApproverInitials: string | null;
  gate2ApproverAt: string | null;
  gate2ApproverMeaning: string | null;
  gate2Outcome: string | null;
  // Latest rejection metadata
  lastRejectionAt: string | null;
  lastRejectionStage: string | null;
  lastRejectionById: number | null;
  lastRejectionByName: string | null;
  lastRejectionComment: string | null;
  lastRejectionTarget: string | null;
  openedByName: string | null;
  closedByName: string | null;
  closedByInitials: string | null;
  closureNotes: string | null;
  closedAt: string | null;
  // Session 34 (Tier 2 #10) — Risk classification + revision lineage. Now
  // also on the orval-generated Capa shape after Session 34.1 regen; kept
  // here in the local type so existing call sites compile without churn.
  riskLevel: string | null;
  riskRationale: string | null;
  riskReleased: boolean | null;
  riskCustomerAffected: boolean | null;
  riskLabelingImpact: boolean | null;
  riskInHouseOnly: boolean | null;
  riskPreBulk: boolean | null;
  riskRevisedAt: string | null;
  riskRevisedByName: string | null;
  riskRevisedReason: string | null;
  riskRevisedFrom: string | null;
  createdAt: string;
  updatedAt: string;
  actionItems: ActionItem[];
  sourceNc: { id: number; ncNumber: string; title: string; severity: string; status: string } | null;
  sourceComplaint: { id: number; complaintNumber: string; complaintType: string; severity: string; status: string } | null;
};

const BASE = import.meta.env.BASE_URL ?? "/";

// The two transitions that move without a Part 11 gate. ONE copy — the button
// label, the enable rule and the confirm dialog all read from here.
const AUTO_NEXT_STAGE: Partial<Record<CapaStage, CapaStage>> = {
  "Investigation": "Planning",
  "Action Execution": "EC Execution",
};

const CAPA_STATUS_ORDER = [
  "Open",
  "Root Cause Analysis",
  "Action Planning",
  "Implementation",
  "Effectiveness Check",
  "Closed",
];

// Session 35 (Tier 3 #13) — consolidated workflow: 6 stages and 3 Part 11
// gates. Gate 0 (Manager/Quality) routes the CAPA out of Initiation; Gate 1
// (×2 approvers) clears Planning into Action Execution; Gate 2 (Mgr/Quality)
// closes after EC Execution. The prior "Action Planning" and "EC Planning"
// stages were consolidated into a single "Planning" stage.
const CAPA_STAGES = [
  "Initiation",
  "Investigation",
  "Planning",
  "Action Execution",
  "EC Execution",
  "Closed",
] as const;
type CapaStage = typeof CAPA_STAGES[number];

const STAGES_AFTER_GATE1: CapaStage[] = ["Action Execution", "EC Execution", "Closed"];

const RCA_METHODS = [
  "5-Why",
  "Fishbone (Ishikawa)",
  "Fault Tree Analysis",
  "FMEA",
  "DMAIC",
  "Pareto Analysis",
  "Other",
];

const STATUS_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  "Open":                { label: "Open",                icon: <AlertCircle className="h-3.5 w-3.5" />, color: "text-slate-600" },
  "Root Cause Analysis": { label: "Root Cause Analysis", icon: <Search className="h-3.5 w-3.5" />,      color: "text-purple-600" },
  "Action Planning":     { label: "Action Planning",     icon: <ClipboardList className="h-3.5 w-3.5" />, color: "text-blue-600" },
  "Implementation":      { label: "Implementation",      icon: <TrendingUp className="h-3.5 w-3.5" />,   color: "text-amber-600" },
  "Effectiveness Check": { label: "Effectiveness Check", icon: <ShieldCheck className="h-3.5 w-3.5" />,  color: "text-indigo-600" },
  "Closed":              { label: "Closed",              icon: <CheckCircle2 className="h-3.5 w-3.5" />, color: "text-green-600" },
};

const ACTION_ITEM_STATUS_STYLES: Record<string, string> = {
  "Open":      "bg-slate-100 text-slate-700",
  "In Progress": "bg-blue-50 text-blue-700",
  "Completed": "bg-green-50 text-green-700",
  "Verified":  "bg-emerald-50 text-emerald-700",
};

// ── Status stepper ────────────────────────────────────────────────────────────

function StatusStepper({ current }: { current: string }) {
  const steps = CAPA_STATUS_ORDER;
  const currentIdx = steps.indexOf(current);
  return (
    <div className="flex items-center gap-0 overflow-x-auto pb-1">
      {steps.map((step, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        const meta = STATUS_META[step];
        return (
          <div key={step} className="flex items-center">
            <div className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border",
              done  ? "bg-green-50 text-green-700 border-green-200" :
              active ? "bg-primary/10 text-primary border-primary/30 shadow-sm" :
                       "bg-muted text-muted-foreground border-transparent"
            )}>
              {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : meta?.icon}
              {step}
            </div>
            {i < steps.length - 1 && (
              <ChevronRight className={cn("h-4 w-4 mx-0.5 shrink-0", i < currentIdx ? "text-green-400" : "text-muted-foreground/40")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Stage stepper (Session 35 — 6-stage flow with Gate 0 / 1 / 2 callouts) ──

function StageStepper({
  current,
  gate0ApprovedAt,
  gate1ApprovedAt,
  gate2Outcome,
  hasGate1Sig1,
}: {
  current: string;
  gate0ApprovedAt: string | null;
  gate1ApprovedAt: string | null;
  gate2Outcome: string | null;
  hasGate1Sig1: boolean;
}) {
  const steps = CAPA_STAGES;
  const currentIdx = steps.indexOf(current as CapaStage);
  // Session 35 — three gate markers: Gate 0 between Initiation (idx 0) and
  // Investigation (idx 1); Gate 1 between Planning (idx 2) and Action
  // Execution (idx 3); Gate 2 between EC Execution (idx 4) and Closed (idx 5).
  return (
    <div className="flex items-center gap-0 overflow-x-auto pb-1">
      {steps.map((step, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        const renderGateAfter =
          i === 0 ? { label: "Gate 0", done: !!gate0ApprovedAt, active: current === "Initiation", subtext: null }
          : i === 2 ? { label: "Gate 1", done: !!gate1ApprovedAt, active: current === "Planning", subtext: hasGate1Sig1 && !gate1ApprovedAt ? "1 / 2 signed" : null }
          : i === 4 ? { label: "Gate 2", done: gate2Outcome === "Pass" || current === "Closed", active: current === "EC Execution", subtext: gate2Outcome === "Fail" ? "Failed — rolled back" : null }
          : null;
        return (
          <div key={step} className="flex items-center">
            <div className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border",
              done   ? "bg-green-50 text-green-700 border-green-200" :
              // Session 61 — the current stage carries a heavier, darker outline so
              // it is findable at a glance in a strip of nine chips. Drawn with a
              // ring rather than a thicker border: a ring renders outside the box
              // and so cannot nudge the chip's size and misalign the row.
              active ? "bg-primary/10 text-primary border-primary shadow-sm ring-2 ring-primary/50" :
                       "bg-muted text-muted-foreground border-transparent"
            )}>
              {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {step}
            </div>
            {renderGateAfter && (
              <>
                <div className={cn("h-px w-2", renderGateAfter.done ? "bg-green-300" : "bg-muted-foreground/30")} />
                <div className={cn(
                  "flex flex-col items-center gap-0 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide border",
                  renderGateAfter.done   ? "bg-green-100 text-green-800 border-green-300" :
                  renderGateAfter.active ? "bg-amber-50 text-amber-800 border-amber-300 animate-pulse" :
                                           "bg-muted text-muted-foreground border-transparent"
                )}>
                  <div className="flex items-center gap-1">
                    <ShieldCheck className="h-3 w-3" />
                    {renderGateAfter.label}
                  </div>
                  {renderGateAfter.subtext && (
                    <span className="text-[9px] font-normal normal-case tracking-normal">{renderGateAfter.subtext}</span>
                  )}
                </div>
              </>
            )}
            {i < steps.length - 1 && (
              <ChevronRight className={cn("h-4 w-4 mx-0.5 shrink-0", i < currentIdx ? "text-green-400" : "text-muted-foreground/40")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Section card ──────────────────────────────────────────────────────────────

function SectionCard({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between px-5 py-3 border-b">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {action}
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

// ── Per-phase due-date row (Session 14, item 15) ─────────────────────────────
// Inline date editor for a single CAPA phase. Lock is governed by the parent
// SectionCard via the isLocked prop so the row UI never has to know the
// Gate 1 rule directly.

function PhaseDueDateRow({
  label,
  hint,
  value,
  isLocked,
  onSave,
}: {
  label: string;
  hint: string;
  value: string | null;
  isLocked: boolean;
  onSave: (nextIso: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // Display the stored date as YYYY-MM-DD; <input type="date"> expects that
  // shape and falls back gracefully on empty.
  const displayDate = value ? value.slice(0, 10) : null;

  const startEdit = () => {
    setDraft(displayDate ?? "");
    setEditing(true);
  };
  const handleSave = async () => {
    setSaving(true);
    const ok = await onSave(draft);
    setSaving(false);
    if (ok) setEditing(false);
  };

  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {editing ? (
          <>
            <input
              type="date"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-sm"
            />
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <span className={`text-sm font-mono ${displayDate ? "" : "text-muted-foreground italic"}`}>
              {displayDate ? format(new Date(displayDate + "T00:00:00"), "MMM d, yyyy") : "Not set"}
            </span>
            {!isLocked && (
              <Button size="sm" variant="ghost" onClick={startEdit}>
                {displayDate ? "Edit" : "Set"}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Add action item dialog ────────────────────────────────────────────────────

function AddActionItemDialog({ capaId, excludeUserIds = [], onCreated }: { capaId: number; excludeUserIds?: number[]; onCreated: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ actionDescription: "", assignedToId: "", dueDate: "" });

  // Session 53 — "Assigned To" is now a user picker that saves the user id
  // (assignedToId) plus the matching name. Gate 1 segregation reads the id
  // (an action owner can't sign their own plan); a free-text name alone left
  // assignedToId null and the action-owner check silently no-opped. The EC
  // Owner is excluded here (server enforces the same separation).
  const { data: usersData = [] } = useListUsers();
  const excluded = new Set(excludeUserIds);
  const eligible = usersData.filter((u) => u.active && !excluded.has(u.id));

  // Session 29 — typed mutation. `isPending` replaces the local `saving` state.
  const createActionItem = useCreateCapaActionItem();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.actionDescription.trim()) return;
    const picked = form.assignedToId ? usersData.find((u) => String(u.id) === form.assignedToId) : null;
    try {
      await createActionItem.mutateAsync({
        id: capaId,
        data: {
          actionDescription: form.actionDescription,
          assignedToId: form.assignedToId ? Number(form.assignedToId) : null,
          assignedToName: picked?.fullName ?? null,
          dueDate: form.dueDate || null,
        } as never,
      });
      toast({ title: "Action item added" });
      setOpen(false);
      setForm({ actionDescription: "", assignedToId: "", dueDate: "" });
      onCreated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to add action item";
      toast({ title: msg, variant: "destructive" });
    }
  };
  const saving = createActionItem.isPending;

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="gap-1.5">
        <Plus className="h-3.5 w-3.5" /> Add Item
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleSubmit}>
            <DialogHeader><DialogTitle>Add Corrective / Preventive Action</DialogTitle></DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label>Action Description *</Label>
                <Textarea rows={3} placeholder="Describe the action to take…" value={form.actionDescription} onChange={(e) => setForm((f) => ({ ...f, actionDescription: e.target.value }))} required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Assigned To</Label>
                  <Select value={form.assignedToId} onValueChange={(v) => setForm((f) => ({ ...f, assignedToId: v }))}>
                    <SelectTrigger data-testid="select-add-action-assignee"><SelectValue placeholder="Select user…" /></SelectTrigger>
                    <SelectContent>
                      {eligible.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">No eligible users.</div>
                      ) : (
                        eligible.map((u) => (
                          <SelectItem key={u.id} value={String(u.id)}>{u.fullName}{u.role ? ` · ${u.role}` : ""}</SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Due Date</Label>
                  <Input type="date" value={form.dueDate} onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Adding…" : "Add Item"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Edit action item dialog — editable until plan approval (Gate 1) ─────────
// Mirrors AddActionItemDialog but PATCHes an existing row. Surfaced per-row
// (explicit Edit button) only before gate1ApprovedAt; the server enforces the
// same lock so content can't be changed after the plan is signed.
function EditActionItemDialog({
  capaId,
  item,
  excludeUserIds = [],
  onUpdated,
}: {
  capaId: number;
  item: { id: number; actionDescription: string; assignedToId?: number | null; assignedToName?: string | null; dueDate?: string | null };
  excludeUserIds?: number[];
  onUpdated: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    actionDescription: item.actionDescription ?? "",
    assignedToId: item.assignedToId != null ? String(item.assignedToId) : "",
    dueDate: item.dueDate ?? "",
  });

  // Session 53 — Assigned To picker (saves assignedToId + name). See
  // AddActionItemDialog for rationale. Keep the currently-assigned user in the
  // list even if they'd otherwise be excluded, so an existing assignment still
  // shows; new picks are filtered by `eligible`.
  const { data: usersData = [] } = useListUsers();
  const excluded = new Set(excludeUserIds);
  const eligible = usersData.filter(
    (u) => (u.active && !excluded.has(u.id)) || u.id === item.assignedToId,
  );

  const updateActionItem = useUpdateCapaActionItem();

  const handleOpen = () => {
    // Re-seed from the latest values each time the dialog opens.
    setForm({
      actionDescription: item.actionDescription ?? "",
      assignedToId: item.assignedToId != null ? String(item.assignedToId) : "",
      dueDate: item.dueDate ?? "",
    });
    setOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.actionDescription.trim()) return;
    const picked = form.assignedToId ? usersData.find((u) => String(u.id) === form.assignedToId) : null;
    try {
      await updateActionItem.mutateAsync({
        id: capaId,
        itemId: item.id,
        data: {
          actionDescription: form.actionDescription,
          assignedToId: form.assignedToId ? Number(form.assignedToId) : null,
          assignedToName: picked?.fullName ?? null,
          dueDate: form.dueDate || null,
        } as never,
      });
      toast({ title: "Action item updated" });
      setOpen(false);
      onUpdated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update action item";
      toast({ title: msg, variant: "destructive" });
    }
  };
  const saving = updateActionItem.isPending;

  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={handleOpen}
        title="Edit action item"
        data-testid={`button-edit-item-${item.id}`}
      >
        <PenLine className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleSubmit}>
            <DialogHeader><DialogTitle>Edit Corrective / Preventive Action</DialogTitle></DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label>Action Description *</Label>
                <Textarea rows={3} placeholder="Describe the action to take…" value={form.actionDescription} onChange={(e) => setForm((f) => ({ ...f, actionDescription: e.target.value }))} required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Assigned To</Label>
                  <Select value={form.assignedToId} onValueChange={(v) => setForm((f) => ({ ...f, assignedToId: v }))}>
                    <SelectTrigger data-testid="select-edit-action-assignee"><SelectValue placeholder="Select user…" /></SelectTrigger>
                    <SelectContent>
                      {eligible.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">No eligible users.</div>
                      ) : (
                        eligible.map((u) => (
                          <SelectItem key={u.id} value={String(u.id)}>{u.fullName}{u.role ? ` · ${u.role}` : ""}</SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Due Date</Label>
                  <Input type="date" value={form.dueDate} onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save Changes"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Completion details editor — execution-phase record on each action item ───
// Available after Gate 1 (while the plan content itself is locked): the owner
// records what was done / evidence / references to supporting documents. Writes
// the action item's `notes` field, which the server allows post-Gate-1.
// Supporting files attach in the CAPA Attachments panel (allow-listed for
// action-item proof); the note references them.
function CompletionDetailsDialog({
  capaId,
  item,
  onUpdated,
}: {
  capaId: number;
  item: ActionItem;
  onUpdated: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(item.notes ?? "");
  const updateActionItem = useUpdateCapaActionItem();

  const handleOpen = () => {
    setNotes(item.notes ?? "");
    setOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await updateActionItem.mutateAsync({
        id: capaId,
        itemId: item.id,
        data: { notes: notes.trim() || null } as never,
      });
      toast({ title: "Completion details saved" });
      setOpen(false);
      onUpdated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save completion details";
      toast({ title: msg, variant: "destructive" });
    }
  };
  const saving = updateActionItem.isPending;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
        onClick={handleOpen}
        title="Record completion details"
        data-testid={`button-completion-${item.id}`}
      >
        <ClipboardList className="h-3.5 w-3.5" /> Details
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleSubmit}>
            <DialogHeader><DialogTitle>Completion Details</DialogTitle></DialogHeader>
            <div className="space-y-4 py-4">
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <p className="font-medium text-foreground leading-snug">{item.actionDescription}</p>
                <p className="mt-1">
                  Status: <span className="font-medium">{item.status}</span>
                  {item.completedByName && item.completedAt && (
                    <> · Completed by {item.completedByName} on {format(new Date(item.completedAt), "MMM d, yyyy")}</>
                  )}
                  {(item as { performedOn?: string | null }).performedOn && (
                    <> · Performed {format(new Date(`${(item as { performedOn?: string | null }).performedOn}T12:00:00`), "MMM d, yyyy")}</>
                  )}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Completion notes / reference documents</Label>
                <Textarea
                  rows={4}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="What was done, evidence collected, and references to supporting documents. Attach the files themselves in the CAPA Attachments section below…"
                  data-testid={`textarea-completion-${item.id}`}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Rejection banner — shows most recent rejection if CAPA was rolled back ───

function RejectionBanner({ capa }: { capa: CapaDetail }) {
  if (!capa.lastRejectionAt) return null;
  // Only surface if we're actually back at the rollback target (not after
  // someone re-advanced past it).
  const showStillRolledBack =
    capa.lastRejectionTarget === capa.stage ||
    (capa.lastRejectionStage === "Gate 1" && !capa.gate1ApprovedAt) ||
    (capa.lastRejectionStage === "Gate 2");
  if (!showStillRolledBack) return null;
  return (
    <div className="rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm">
      <div className="flex items-start gap-2">
        <XCircle className="h-4 w-4 text-orange-700 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-orange-900">
            {capa.lastRejectionStage} rejected by {capa.lastRejectionByName ?? "—"} on {format(new Date(capa.lastRejectionAt), "MMM d, yyyy")}
          </div>
          {capa.lastRejectionComment && (
            <div className="mt-1 text-orange-900/80 whitespace-pre-wrap">
              {capa.lastRejectionComment}
            </div>
          )}
          {capa.lastRejectionTarget && (
            <div className="mt-1 text-xs text-orange-800/70">
              Returned to <span className="font-medium">{capa.lastRejectionTarget}</span> for revision.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Gate 0 acceptance card (Session 35 — Manager/Quality acceptance) ─────────
//
// Single signer. Manager / Quality / Admin only (no Supervisors). Originator
// cannot accept their own. No rejection endpoint — if the reviewer doesn't
// want to accept, they simply don't sign. The originator can keep editing in
// Initiation and request review again.
//
// Session 35.1 — swapped raw fetch for the orval-typed useGate0ApproveCapa
// mutation now that the endpoint is in the spec. Same UX, typed payload +
// response.

function Gate0Card({
  capa,
  currentUserId,
  currentUserRole,
  onChanged,
}: {
  capa: CapaDetail;
  currentUserId: number | null;
  currentUserRole: string | null | undefined;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [signOpen, setSignOpen] = useState(false);
  const [signing, setSigning] = useState(false);
  const gate0ApproveMutation = useGate0ApproveCapa();
  // Session 61 — the gate reviewer also decides where the accepted CAPA lands.
  // Defaults to "yes, investigate" so the safe path is the one you get by not
  // touching it; skipping Investigation has to be a deliberate answer.
  const [needsInvestigation, setNeedsInvestigation] = useState(true);

  const ACCEPTANCE_ROLES = new Set(["Manager", "Quality", "Admin"]);
  const isOriginator = currentUserId != null && currentUserId === capa.originatorId;
  const hasAcceptanceRole = !!currentUserRole && ACCEPTANCE_ROLES.has(currentUserRole);
  const cannotSign = isOriginator || !hasAcceptanceRole;
  const cannotSignReason = isOriginator
    ? "You opened this CAPA — a second pair of eyes is required (Part 11 segregation)."
    : !hasAcceptanceRole
    ? `Gate 0 acceptance is restricted to Manager, Quality, or Admin. Your role is "${currentUserRole ?? "(unknown)"}".`
    : null;

  const sign = async (initials: string, meaning: string) => {
    setSigning(true);
    try {
      await gate0ApproveMutation.mutateAsync({
        id: capa.id,
        data: { initials, signatureMeaning: meaning, needsInvestigation } as never,
      });
      toast({
        title: needsInvestigation
          ? "CAPA accepted — advanced to Investigation"
          : "CAPA accepted — advanced to Planning",
      });
      setSignOpen(false);
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : undefined;
      toast({ title: "Acceptance failed", description: msg, variant: "destructive" });
      throw err;
    } finally {
      setSigning(false);
    }
  };

  return (
    <div className="rounded-lg border-2 border-amber-200 bg-amber-50/40 p-4 print:hidden">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-amber-700" />
            <h3 className="text-sm font-semibold text-amber-900">Gate 0 — Manager / Quality Acceptance</h3>
          </div>
          <p className="text-xs text-amber-900/80 leading-relaxed">
            This CAPA is awaiting acceptance by a Manager, Quality reviewer, or Admin before it can move
            forward. The originator cannot sign their own. Acceptance is recorded as a Part 11
            electronic signature.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setSignOpen(true)}
          disabled={cannotSign}
          className="gap-1.5 shrink-0"
          data-testid="button-gate0-accept"
        >
          <UserCheck className="h-4 w-4" /> Accept CAPA
        </Button>
      </div>
      {/* Session 61 — asked before signing, because the answer decides which
          stage the signature sends the CAPA to. A CAPA promoted from an NC
          often arrives with the root cause already established on the NC and
          copied into the RCA field, and sending it to Investigation anyway
          asks someone to redo recorded work. */}
      {!cannotSign && (
        <div className="mt-3 rounded-md border border-amber-200 bg-white/60 p-3 space-y-2">
          <p className="text-xs font-medium text-amber-900">
            Does more investigation need to be done to reach root cause?
          </p>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-start gap-2 text-xs text-amber-900/90">
              <input
                type="radio"
                className="mt-0.5"
                checked={needsInvestigation}
                onChange={() => setNeedsInvestigation(true)}
                data-testid="radio-gate0-investigate"
              />
              <span>Yes — accept and send to <strong>Investigation</strong>.</span>
            </label>
            <label className="flex items-start gap-2 text-xs text-amber-900/90">
              <input
                type="radio"
                className="mt-0.5"
                checked={!needsInvestigation}
                onChange={() => setNeedsInvestigation(false)}
                data-testid="radio-gate0-planning"
              />
              <span>
                No — the investigation was completed on the source record and its results
                carried over. Accept and send straight to <strong>Planning</strong>.
              </span>
            </label>
          </div>
        </div>
      )}
      {cannotSignReason && (
        <p className="mt-2 text-[11px] text-amber-900/70 italic">{cannotSignReason}</p>
      )}
      <Part11SignatureDialog
        open={signOpen}
        onOpenChange={setSignOpen}
        title="Accept CAPA — Gate 0"
        description={`Accepting ${capa.capaNumber} advances it from Initiation to ${needsInvestigation ? "Investigation" : "Planning"}. This action is recorded per 21 CFR Part 11.`}
        onSign={sign}
        isPending={signing}
      />
    </div>
  );
}

// ── Gate 1 approval card (2 signatures, sign + reject flow) ──────────────────

function Gate1Card({
  capa,
  currentUserId,
  onChanged,
}: {
  capa: CapaDetail;
  currentUserId: number | null;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [signOpen, setSignOpen] = useState(false);
  const [signing, setSigning] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState("");
  const [rejectTarget, setRejectTarget] = useState<"Investigation" | "Planning">("Investigation");
  const [rejecting, setRejecting] = useState(false);

  const isOriginator = currentUserId != null && currentUserId === capa.originatorId;
  const isFirstApprover = currentUserId != null && currentUserId === capa.gate1Approver1Id;
  const slot1Signed = !!capa.gate1Approver1At;
  const slot2Signed = !!capa.gate1Approver2At;
  // Session 24 — Gate 1 now segregates EC Owner and action owners alongside
  // the originator, matching the server-side check at gate1-approve and
  // mirroring Gate 2's segregation rules. The rationale: an action owner has
  // a vested interest in seeing the plan that contains their own action move
  // forward; the EC Owner is part of the plan being approved.
  const isEcOwner = currentUserId != null && currentUserId === capa.effectivenessOwnerId;
  const isActionOwner = capa.actionItems.some((a) => currentUserId != null && currentUserId === (a as unknown as { assignedToId?: number }).assignedToId);
  const cannotSign = isOriginator || isEcOwner || isActionOwner || (slot1Signed && isFirstApprover) || slot2Signed;
  const cannotSignReason = isOriginator
    ? "You created this CAPA — Part 11 segregation prevents you from signing your own."
    : isEcOwner
    ? "Effectiveness Check Owner cannot sign Gate 1 (Part 11 segregation)."
    : isActionOwner
    ? "An action item owner cannot sign Gate 1 (Part 11 segregation)."
    : (slot1Signed && isFirstApprover)
    ? "You already signed slot 1. A second, distinct approver is required."
    : null;

  // Session 29 — typed gate1 hooks. Same UX (Signature dialog feeds initials
  // + meaning; rejection takes comment + rollback target). Errors thrown by
  // the mutation surface as the toast description.
  const gate1ApproveMutation = useGate1ApproveCapa();
  const gate1RejectMutation = useGate1RejectCapa();

  const sign = async (initials: string, meaning: string) => {
    setSigning(true);
    try {
      await gate1ApproveMutation.mutateAsync({
        id: capa.id,
        data: { initials, signatureMeaning: meaning } as never,
      });
      toast({ title: "Gate 1 signature recorded" });
      setSignOpen(false);
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : undefined;
      toast({ title: "Signature rejected", description: msg, variant: "destructive" });
    } finally {
      setSigning(false);
    }
  };

  const reject = async () => {
    if (!rejectComment.trim()) {
      toast({ title: "Comment required", variant: "destructive" });
      return;
    }
    setRejecting(true);
    try {
      await gate1RejectMutation.mutateAsync({
        id: capa.id,
        data: { comment: rejectComment.trim(), rollbackTarget: rejectTarget } as never,
      });
      toast({ title: "Gate 1 rejected", description: `CAPA returned to ${rejectTarget}.` });
      setRejectOpen(false);
      setRejectComment("");
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : undefined;
      toast({ title: "Rejection failed", description: msg, variant: "destructive" });
    } finally {
      setRejecting(false);
    }
  };

  return (
    <div className="rounded-lg border-2 border-amber-300 bg-amber-50/50 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-amber-700" />
        <h3 className="font-semibold text-amber-900">Gate 1 — Pre-Implementation Approval</h3>
      </div>
      <p className="text-xs text-amber-900/80">
        Two distinct approvers must review and sign the problem description, root cause, action plan, and EC plan
        before action execution begins. Per 21 CFR Part 11, neither approver may be the CAPA originator.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div className={cn("rounded-md border p-3 bg-white", slot1Signed ? "border-green-300" : "border-dashed border-amber-300")}>
          <div className="text-xs font-semibold text-muted-foreground mb-1">Approver 1</div>
          {slot1Signed ? (
            <>
              <div className="text-sm font-medium">{capa.gate1Approver1Name}</div>
              <div className="text-xs text-muted-foreground">
                {capa.gate1Approver1Initials} · {capa.gate1Approver1At ? format(new Date(capa.gate1Approver1At), "MMM d, yyyy h:mm a") : ""}
              </div>
              {capa.gate1Approver1Meaning && (
                <div className="text-xs italic text-muted-foreground mt-1">"{capa.gate1Approver1Meaning}"</div>
              )}
            </>
          ) : (
            <div className="text-sm italic text-muted-foreground">Awaiting first signature…</div>
          )}
        </div>
        <div className={cn("rounded-md border p-3 bg-white", slot2Signed ? "border-green-300" : "border-dashed border-amber-300")}>
          <div className="text-xs font-semibold text-muted-foreground mb-1">Approver 2</div>
          {slot2Signed ? (
            <>
              <div className="text-sm font-medium">{capa.gate1Approver2Name}</div>
              <div className="text-xs text-muted-foreground">
                {capa.gate1Approver2Initials} · {capa.gate1Approver2At ? format(new Date(capa.gate1Approver2At), "MMM d, yyyy h:mm a") : ""}
              </div>
              {capa.gate1Approver2Meaning && (
                <div className="text-xs italic text-muted-foreground mt-1">"{capa.gate1Approver2Meaning}"</div>
              )}
            </>
          ) : (
            <div className="text-sm italic text-muted-foreground">Awaiting second signature…</div>
          )}
        </div>
      </div>

      {capa.gate1ApprovedAt ? (
        <div className="rounded-md border border-green-300 bg-green-50 p-2.5 text-sm flex items-center gap-2 text-green-900">
          <CheckCircle2 className="h-4 w-4 text-green-700" />
          Gate 1 approved on {format(new Date(capa.gate1ApprovedAt), "MMM d, yyyy h:mm a")} — CAPA advanced to Action Execution.
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {cannotSign ? (
            <Button size="sm" disabled title={cannotSignReason ?? undefined}>
              Sign Gate 1
            </Button>
          ) : (
            <Button size="sm" onClick={() => setSignOpen(true)}>
              <PenLine className="h-3.5 w-3.5 mr-1.5" />
              Sign Gate 1 ({slot1Signed ? "Slot 2" : "Slot 1"})
            </Button>
          )}
          {!isOriginator && (
            <Button size="sm" variant="outline" onClick={() => setRejectOpen(true)}>
              <XCircle className="h-3.5 w-3.5 mr-1.5" />
              Reject & Return
            </Button>
          )}
          {cannotSignReason && (
            <span className="text-xs text-muted-foreground self-center">{cannotSignReason}</span>
          )}
        </div>
      )}

      <Part11SignatureDialog
        open={signOpen}
        onOpenChange={setSignOpen}
        title="Sign Gate 1 Approval"
        description="By signing, you confirm that you have reviewed the problem description, root cause analysis, action plan, and effectiveness check plan, and approve this CAPA to proceed to Action Execution (21 CFR Part 11)."
        onSign={sign}
        isPending={signing}
      />

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Gate 1</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-sm">Return to which stage? *</Label>
              <Select value={rejectTarget} onValueChange={(v) => setRejectTarget(v as "Investigation" | "Planning")}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Investigation">Investigation (RCA needs more work)</SelectItem>
                  <SelectItem value="Planning">Planning (actions/EC plan need revision)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-sm">Reason for rejection *</Label>
              <Textarea
                rows={4}
                value={rejectComment}
                onChange={(e) => setRejectComment(e.target.value)}
                placeholder="Document what needs to be revised before re-approval…"
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>Cancel</Button>
            <Button onClick={reject} disabled={rejecting || !rejectComment.trim()}>
              {rejecting ? "Rejecting…" : "Reject & Return CAPA"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Gate 2 closure card (Pass/Fail with rollback target) ─────────────────────

function Gate2Card({
  capa,
  currentUserId,
  onChanged,
}: {
  capa: CapaDetail;
  currentUserId: number | null;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<"Pass" | "Fail">("Pass");
  const [comment, setComment] = useState("");
  const [rollbackTarget, setRollbackTarget] = useState<"Investigation" | "Planning">("Planning");
  const [initials, setInitials] = useState("");
  const [meaning, setMeaning] = useState("Closure Approval");
  const [submitting, setSubmitting] = useState(false);

  const isOriginator = currentUserId != null && currentUserId === capa.originatorId;
  const isEcOwner = currentUserId != null && currentUserId === capa.effectivenessOwnerId;
  const isActionOwner = capa.actionItems.some((a) => currentUserId != null && currentUserId === (a as unknown as { assignedToId?: number }).assignedToId);
  const cannotSign = isOriginator || isEcOwner || isActionOwner;
  const cannotSignReason = isOriginator
    ? "Originator cannot sign closure (Part 11 segregation)."
    : isEcOwner
    ? "Effectiveness Check Owner cannot sign closure (Part 11 segregation)."
    : isActionOwner
    ? "An action item owner cannot sign closure (Part 11 segregation)."
    : null;

  // Session 29 — gate2 typed hook.
  const gate2ApproveMutation = useGate2ApproveCapa();

  const submit = async () => {
    if (!initials.trim() || !meaning.trim()) {
      toast({ title: "Initials and signing meaning required", variant: "destructive" });
      return;
    }
    if (outcome === "Fail" && !comment.trim()) {
      toast({ title: "Comment required for Fail outcome", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      await gate2ApproveMutation.mutateAsync({
        id: capa.id,
        data: {
          initials,
          signatureMeaning: meaning,
          outcome,
          ...(outcome === "Fail" ? { comment: comment.trim(), rollbackTarget } : {}),
        } as never,
      });
      toast({
        title: outcome === "Pass" ? "CAPA Closed" : "CAPA returned for revision",
        description: outcome === "Pass" ? "Closure signature recorded." : `Returned to ${rollbackTarget}.`,
      });
      setOpen(false);
      setComment("");
      setInitials("");
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : undefined;
      toast({ title: "Gate 2 failed", description: msg, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border-2 border-indigo-300 bg-indigo-50/50 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-indigo-700" />
        <h3 className="font-semibold text-indigo-900">Gate 2 — Closure</h3>
      </div>
      <p className="text-xs text-indigo-900/80">
        Single approver reviews effectiveness check results and signs to close — or marks Fail and returns
        the CAPA for revision. Approver cannot be the originator, EC Owner, or any action item owner.
      </p>

      {cannotSign ? (
        <div className="text-sm text-indigo-900/80 italic">{cannotSignReason}</div>
      ) : (
        <Button size="sm" onClick={() => setOpen(true)}>
          <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
          Sign Gate 2
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Gate 2 — Closure</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-sm">Outcome *</Label>
              <Select value={outcome} onValueChange={(v) => setOutcome(v as "Pass" | "Fail")}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Pass">Pass — close the CAPA</SelectItem>
                  <SelectItem value="Fail">Fail — return for revision</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {outcome === "Fail" && (
              <>
                <div>
                  <Label className="text-sm">Return to *</Label>
                  <Select value={rollbackTarget} onValueChange={(v) => setRollbackTarget(v as "Investigation" | "Planning")}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Investigation">Investigation</SelectItem>
                      <SelectItem value="Planning">Planning</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-sm">Reason *</Label>
                  <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} className="mt-1" placeholder="Document why the CAPA failed effectiveness…" />
                </div>
              </>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm">Your initials *</Label>
                <Input value={initials} onChange={(e) => setInitials(e.target.value.toUpperCase())} className="mt-1" placeholder="e.g. JS" />
              </div>
              <div>
                <Label className="text-sm">Signing meaning *</Label>
                <Input value={meaning} onChange={(e) => setMeaning(e.target.value)} className="mt-1" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground italic">
              By signing you confirm 21 CFR Part 11 compliance: your initials and signing meaning are
              recorded against this action with a timestamp.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting ? "Signing…" : outcome === "Pass" ? "Sign & Close CAPA" : "Sign & Return for Revision"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CAPADetail(props: { params?: { id: string } }) {
  const id = parseInt(props.params?.id ?? "0");
  const { toast } = useToast();
  const { data: currentUser } = useGetCurrentUser();
  const queryClient = useQueryClient();

  // Session 29 — useGetCapa replaces the previous useState<CapaDetail | null>
  // + fetchCapa useCallback + useEffect plumbing. The orval-generated `Capa`
  // shape doesn't carry the joined `actionItems` / `sourceNc` / `sourceComplaint`
  // sub-rows that the server returns on the detail endpoint, so we cast to
  // the locally-declared `CapaDetail` shape that does. Spec/server mismatch
  // tracked as a known wart (same as CAPAs.tsx list response).
  const { data: capaData, isLoading: loading } = useGetCapa(id);
  const capa = (capaData as unknown as CapaDetail | undefined) ?? null;

  // Session 29 — mutation hooks for CAPA workflow operations owned by this
  // top-level component. Gate1Card / Gate2Card own their own gate-approve /
  // gate-reject hooks because they're standalone components.
  const updateCapaMutation = useUpdateCapa();
  const advanceCapaStatusMutation = useAdvanceCapaStatus();
  const advanceCapaStageMutation = useAdvanceCapaStage();
  const verifyEffectivenessMutation = useVerifyCapaEffectiveness();
  const closeCapaMutation = useCloseCapa();
  const createActionItemMutation = useCreateCapaActionItem();
  const updateActionItemMutation = useUpdateCapaActionItem();
  const deleteActionItemMutation = useDeleteCapaActionItem();
  const verifyActionItemMutation = useVerifyCapaActionItem();

  // Session 52.3 — user list for the Effectiveness Check Owner picker. The EC
  // Owner must resolve to a real user id (effectivenessOwnerId) so Gate 1
  // readiness + Part 11 segregation can operate on it; a free-text name alone
  // left effectivenessOwnerId null and Gate 1 could never be satisfied.
  const { data: usersData = [] } = useListUsers();

  const { data: auditLog = [], refetch: refetchAuditLog } = useListAuditLog({
    tableName: "capas",
    rowId: id || undefined,
    limit: 50,
  });

  // Session 34 (Tier 2 #10) — Risk re-assessment dialog state. Soft prompt
  // visible while stage = Investigation. New tier + reason are both required
  // to submit; server stamps lineage and writes the RISK_REVISED audit row.
  const [riskOpen, setRiskOpen] = useState(false);
  const [riskDraft, setRiskDraft] = useState({ riskLevel: "", reason: "" });
  const [riskSaving, setRiskSaving] = useState(false);
  const [riskError, setRiskError] = useState<string | null>(null);

  // Edit states
  const [editingRca, setEditingRca] = useState(false);
  const [rcaDraft, setRcaDraft] = useState("");
  const [rcaMethodDraft, setRcaMethodDraft] = useState("");
  // New multi-select RCA methodologies (Session 4 design). Stored alongside
  // the legacy single-value rcaMethod field for back-compat.
  const [rcaMethodsDraft, setRcaMethodsDraft] = useState<string[]>([]);
  const [rcaInvestigatorDraft, setRcaInvestigatorDraft] = useState("");
  // Effectiveness Check Owner assignment (Part 11 segregation enforced server-side)
  const [editingEcOwner, setEditingEcOwner] = useState(false);
  const [ecOwnerDraft, setEcOwnerDraft] = useState("");
  const [ecOverrideReason, setEcOverrideReason] = useState("");
  const [savingEcOwner, setSavingEcOwner] = useState(false);
  const [savingRca, setSavingRca] = useState(false);

  const [editingEffectiveness, setEditingEffectiveness] = useState(false);
  const [effectivenessCriteriaDraft, setEffectivenessCriteriaDraft] = useState("");
  const [effectivenessCheckDueDraft, setEffectivenessCheckDueDraft] = useState("");
  const [savingEffectiveness, setSavingEffectiveness] = useState(false);

  // Dialogs
  const [advanceDialogOpen, setAdvanceDialogOpen] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [verifyEffectivenessOpen, setVerifyEffectivenessOpen] = useState(false);
  const [verifyEffectivenessOutcome, setVerifyEffectivenessOutcome] = useState("Effective");
  const [verifyEffectivenessNotes, setVerifyEffectivenessNotes] = useState("");
  const [verifyingEffectiveness, setVerifyingEffectiveness] = useState(false);
  const [closeSignatureOpen, setCloseSignatureOpen] = useState(false);
  const [closureNotesDraft, setClosureNotesDraft] = useState("");
  const [closing, setClosing] = useState(false);

  // Per-item verify dialog
  const [verifyItemId, setVerifyItemId] = useState<number | null>(null);
  const [verifyItemOpen, setVerifyItemOpen] = useState(false);
  // Session 101 (#16) — completion gate: marking an action item Completed now
  // requires what-was-done (notes) + date-performed.
  const [completeItem, setCompleteItem] = useState<ActionItem | null>(null);
  const [completeNotes, setCompleteNotes] = useState("");
  const [completePerformedOn, setCompletePerformedOn] = useState("");
  const [completingItem, setCompletingItem] = useState(false);
  const [verifyingItem, setVerifyingItem] = useState(false);

  // Session 52.1 — Cancel / Re-open (Part 11). Cancel = soft, recoverable,
  // e-signed (no hard delete). Re-open is Admin-only.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [uncancelOpen, setUncancelOpen] = useState(false);
  const [uncancelPending, setUncancelPending] = useState(false);

  // Effectiveness AI suggestions
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  // Session 29 — `fetchCapa` is now a thin invalidate wrapper. The underlying
  // GET is owned by `useGetCapa(id)` above. The existing ~20 call sites that
  // do `await fetchCapa()` keep their behavior unchanged: react-query refetches
  // the capa query and the page re-renders with fresh data.
  const fetchCapa = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: getGetCapaQueryKey(id) });
  }, [id, queryClient]);

  // Session 29 — when the capa data arrives (initial load or post-mutation
  // Seed the editable drafts from server state.
  //
  // ⚠️ 2026-08-27/28 — this used to reseed EVERY draft on every refetch, and carried a
  // comment claiming it "doesn't trample mid-edit changes because the user must
  // explicitly toggle into edit mode after each load". That was WRONG. patch()
  // refetches, this effect re-runs, and anything typed but not yet saved was silently
  // thrown away: clicking a Root Cause Category while the RCA section was open lost the
  // methodologies, and then lost "Investigated by" too.
  //
  // A section that is OPEN FOR EDITING now keeps its drafts. Server state is only
  // copied into a draft the user is not currently looking at, which is the only time
  // copying it can't destroy work. Closing or cancelling a section reseeds it
  // explicitly, so nothing goes stale.
  useEffect(() => {
    if (!capa) return;
    if (!editingRca) {
      setRcaDraft(capa.rootCauseAnalysis ?? "");
      setRcaMethodDraft(capa.rcaMethod ?? "");
      setRcaInvestigatorDraft((capa as unknown as { rcaInvestigatorName?: string | null }).rcaInvestigatorName ?? "");
    }
    // Methodologies save on click, so the server is always the truth for them and a
    // reseed cannot lose anything.
    setRcaMethodsDraft(Array.isArray(capa.rcaMethods) ? capa.rcaMethods : (capa.rcaMethod ? [capa.rcaMethod] : []));
    if (!editingEcOwner) {
      setEcOwnerDraft(capa.effectivenessOwnerId != null ? String(capa.effectivenessOwnerId) : "");
    }
    if (!editingEffectiveness) {
      setEffectivenessCriteriaDraft(capa.effectivenessCriteria ?? "");
      setEffectivenessCheckDueDraft(capa.effectivenessCheckDue ?? "");
    }
    setClosureNotesDraft(capa.closureNotes ?? "");
  }, [capa, editingRca, editingEcOwner, editingEffectiveness]);

  // Session 29 — `patch` now goes through useUpdateCapa.mutateAsync. The
  // promise semantics (resolves on success, rejects with the server error)
  // are preserved so the existing call sites' try/catch blocks keep working.
  const patch = async (body: Record<string, unknown>) => {
    await updateCapaMutation.mutateAsync({ id, data: body as never });
    await Promise.all([fetchCapa(), refetchAuditLog()]);
  };

  // ── Session 52.1 — Cancel / Re-open (off-spec endpoints; raw fetch) ──────────
  // Throw on failure so the dialogs surface the server message inline.
  const handleCancel = async (reason: string, initials: string, meaning: string) => {
    setCancelPending(true);
    try {
      const r = await fetch(`/api/capas/${id}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, initials, signatureMeaning: meaning }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to cancel CAPA.");
      }
      await Promise.all([fetchCapa(), refetchAuditLog()]);
      toast({ title: "CAPA cancelled", description: "Retained and recoverable; removed from active use." });
    } finally {
      setCancelPending(false);
    }
  };

  const handleUncancel = async (initials: string, meaning: string) => {
    setUncancelPending(true);
    try {
      const r = await fetch(`/api/capas/${id}/uncancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initials, signatureMeaning: meaning }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to re-open CAPA.");
      }
      await Promise.all([fetchCapa(), refetchAuditLog()]);
      toast({ title: "CAPA re-opened", description: "Record returned to active use." });
    } finally {
      setUncancelPending(false);
    }
  };

  // Save EC Owner — server validates segregation (≠ originator, ≠ action owners).
  // Session 29 — routed through patch() so error handling and audit-log refresh
  // share the same path. Server's 409/400 error body is exposed via the
  // mutation's thrown error.
  const saveEcOwner = async () => {
    setSavingEcOwner(true);
    try {
      // Session 52.3 — send the real user id (and the matching name) so Gate 1
      // readiness + Part 11 segregation operate on effectivenessOwnerId. An
      // empty selection clears both fields.
      if (!ecOwnerDraft) {
        await patch({ effectivenessOwnerId: null, effectivenessOwnerName: null });
      } else {
        const picked = usersData.find((u) => String(u.id) === ecOwnerDraft);
        await patch({
          effectivenessOwnerId: Number(ecOwnerDraft),
          effectivenessOwnerName: picked?.fullName ?? null,
          // Only meaningful when the pick breaks segregation; the server ignores it
          // otherwise and clears any exception a compliant assignment supersedes.
          ...(ecOverrideReason.trim() ? { ecOwnerSegregationOverrideReason: ecOverrideReason.trim() } : {}),
        });
      }
      toast({ title: "Effectiveness Check Owner saved" });
      setEditingEcOwner(false);
      setEcOverrideReason("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to set EC Owner";
      toast({ title: "Failed to set EC Owner", description: msg, variant: "destructive" });
    } finally {
      setSavingEcOwner(false);
    }
  };

  // A methodology chip saves the moment it is clicked. Optimistic so the chip
  // responds immediately, then reconciled by the refetch patch() triggers — which is
  // also what used to trample these when they were draft state.
  const [savingRcaMethods, setSavingRcaMethods] = useState(false);
  const toggleRcaMethod = async (m: string) => {
    const next = rcaMethodsDraft.includes(m)
      ? rcaMethodsDraft.filter((x) => x !== m)
      : [...rcaMethodsDraft, m];
    const previous = rcaMethodsDraft;
    setRcaMethodsDraft(next);
    setSavingRcaMethods(true);
    try {
      await patch({ rcaMethods: next.length > 0 ? next : null });
    } catch (err) {
      setRcaMethodsDraft(previous);
      const msg = err instanceof Error ? err.message : "Failed to save RCA methodology";
      toast({ title: msg, variant: "destructive" });
    } finally {
      setSavingRcaMethods(false);
    }
  };

  const saveRca = async () => {
    setSavingRca(true);
    try {
      // Methodologies are NOT sent here — they save on click. Sending them again
      // would let a stale draft overwrite what the chips already stored.
      await patch({
        rootCauseAnalysis: rcaDraft,
        rcaMethod: rcaMethodDraft || null,
        rcaInvestigatorName: rcaInvestigatorDraft.trim() || null,
      });
      setEditingRca(false);
      toast({ title: "RCA saved" });
    } catch { toast({ title: "Failed to save RCA", variant: "destructive" }); }
    finally { setSavingRca(false); }
  };

  // Session 34 (Tier 2 #10) — Re-assess Risk during Investigation. Sends a
  // PATCH with riskLevel + riskRevisedReason; server stamps the lineage.
  const handleRiskRevise = async () => {
    setRiskError(null);
    if (!riskDraft.riskLevel) { setRiskError("Pick a new Risk Level."); return; }
    if (!riskDraft.reason.trim()) { setRiskError("A reason is required to revise Risk."); return; }
    if (riskDraft.riskLevel === capa?.riskLevel) {
      setRiskError("New tier matches current tier. Pick a different tier or cancel.");
      return;
    }
    setRiskSaving(true);
    try {
      await patch({ riskLevel: riskDraft.riskLevel, riskRevisedReason: riskDraft.reason.trim() });
      await Promise.all([fetchCapa(), refetchAuditLog()]);
      toast({ title: "Risk revised" });
      setRiskOpen(false);
      setRiskDraft({ riskLevel: "", reason: "" });
    } catch (err) {
      setRiskError(err instanceof Error ? err.message : "Failed to revise Risk.");
    } finally {
      setRiskSaving(false);
    }
  };

  const saveEffectiveness = async () => {
    setSavingEffectiveness(true);
    try {
      await patch({ effectivenessCriteria: effectivenessCriteriaDraft, effectivenessCheckDue: effectivenessCheckDueDraft || null });
      setEditingEffectiveness(false);
      toast({ title: "Effectiveness criteria saved" });
    } catch { toast({ title: "Failed to save", variant: "destructive" }); }
    finally { setSavingEffectiveness(false); }
  };

  const handleAdvance = async () => {
    setAdvancing(true);
    try {
      // Prefer the new stage-based endpoint when a stage is set; fall back to
      // the legacy linear /advance for older CAPAs without a stage.
      // Session 29 — both endpoints now flow through their typed mutation hooks.
      const useStage = !!capa?.stage && CAPA_STAGES.includes(capa.stage as CapaStage);
      try {
        if (useStage) {
          await advanceCapaStageMutation.mutateAsync({ id });
        } else {
          await advanceCapaStatusMutation.mutateAsync({ id });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Could not advance the CAPA";
        toast({ title: "Cannot advance", description: msg, variant: "destructive" });
        return;
      }
      await Promise.all([fetchCapa(), refetchAuditLog()]);
      toast({ title: useStage ? "Stage advanced" : "Status advanced" });
      setAdvanceDialogOpen(false);
    } catch { toast({ title: "Failed to advance", variant: "destructive" }); }
    finally { setAdvancing(false); }
  };

  // Session 29 — verify-effectiveness, close, and action-item mutations now
  // go through their typed hooks. Cache invalidation + audit-log refresh are
  // consistent across them.
  const handleVerifyEffectiveness = async (initials: string, meaning: string) => {
    setVerifyingEffectiveness(true);
    try {
      await verifyEffectivenessMutation.mutateAsync({
        id,
        data: {
          initials,
          signatureMeaning: meaning,
          userId: currentUser?.id,
          effectivenessOutcome: verifyEffectivenessOutcome,
          notes: verifyEffectivenessNotes || null,
        } as never,
      });
      await Promise.all([fetchCapa(), refetchAuditLog()]);
      toast({ title: "Effectiveness verified" });
    } catch (err) {
      throw err instanceof Error ? err : new Error("Failed");
    } finally { setVerifyingEffectiveness(false); }
  };

  const handleClose = async (initials: string, meaning: string) => {
    setClosing(true);
    try {
      await closeCapaMutation.mutateAsync({
        id,
        data: {
          initials,
          signatureMeaning: meaning,
          userId: currentUser?.id,
          closureNotes: closureNotesDraft,
        } as never,
      });
      await Promise.all([fetchCapa(), refetchAuditLog()]);
      toast({ title: "CAPA closed" });
    } catch (err) {
      throw err instanceof Error ? err : new Error("Failed");
    } finally { setClosing(false); }
  };

  const handleUpdateActionItem = async (itemId: number, updates: Record<string, unknown>) => {
    try {
      await updateActionItemMutation.mutateAsync({ id, itemId, data: updates as never });
      await fetchCapa();
      toast({ title: "Action item updated" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update action item";
      toast({ title: msg, variant: "destructive" });
    }
  };

  const handleVerifyActionItem = async (initials: string, meaning: string) => {
    if (!verifyItemId) throw new Error("No item selected");
    setVerifyingItem(true);
    try {
      await verifyActionItemMutation.mutateAsync({
        id,
        itemId: verifyItemId,
        data: { initials, signatureMeaning: meaning, userId: currentUser?.id } as never,
      });
      await Promise.all([fetchCapa(), refetchAuditLog()]);
      toast({ title: "Action item verified" });
    } catch (e) {
      toast({ title: "Verify failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      throw e;
    } finally { setVerifyingItem(false); }
  };

  // Session 29 — fetchAiSuggestions is intentionally left as raw fetch().
  // The /effectiveness-suggestions endpoint isn't in the openapi.yaml spec
  // block (verified during Session 29 inventory); it lives outside the
  // typed-hooks story. TODO: either spec it and regen (Session 29.1 candidate)
  // or move the suggestion logic into the spec'd flow somehow.
  const fetchAiSuggestions = async () => {
    if (!capa) return;
    setLoadingSuggestions(true);
    try {
      const r = await fetch(`${BASE}api/capas/${id}/effectiveness-suggestions`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionItems: capa.actionItems.map((i) => i.actionDescription) }),
      });
      if (!r.ok) throw new Error();
      const data = await r.json() as { suggestions: string[] };
      setAiSuggestions(data.suggestions ?? []);
      if (!data.suggestions?.length) {
        toast({ title: "No suggestions returned", description: "AI did not return any suggestions. Try again later." });
      }
    } catch {
      toast({ title: "Could not fetch suggestions", variant: "destructive" });
    } finally { setLoadingSuggestions(false); }
  };

  // Session 29 — typed delete mutation.
  const handleDeleteActionItem = async (itemId: number) => {
    try {
      await deleteActionItemMutation.mutateAsync({ id, itemId });
      await fetchCapa();
      toast({ title: "Action item removed" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to remove action item";
      toast({ title: msg, variant: "destructive" });
    }
  };

  const currentStatusIdx = capa ? CAPA_STATUS_ORDER.indexOf(capa.status) : -1;
  // canAdvance: gates do their own approval flow. Investigation auto-advances
  // when RCA fills (Session 32 + 35), and the operator can also push the
  // Action Execution → EC Execution transition manually. Session 35 added
  // Gate 0 (Initiation → Investigation) so Initiation is gated, not
  // manually advanceable; Gate 1 still fronts Planning → Action Execution;
  // Gate 2 still fronts EC Execution → Closed.
  const GATE_STAGES: CapaStage[] = ["Initiation", "Planning", "EC Execution", "Closed"];
  // Session 63.6 — this used to also require
  // `currentStatusIdx < CAPA_STATUS_ORDER.length - 2`, i.e. it was computed from
  // the LEGACY status while the workflow runs on `stage`. Verifying effectiveness
  // wrote status "Effectiveness Check" without moving the stage, which pushed the
  // index to second-from-last and hid this button for good — CAPA-26-0016 sat at
  // Action Execution with no way forward and Gate 2 unreachable. The stage is the
  // only source of truth; the status is a mirror and must never gate a control.
  const canAdvance = !!capa
    && capa.status !== "Closed"
    && capa.status !== "Cancelled"
    && !(capa as { cancelledAt?: string | null }).cancelledAt
    && !!AUTO_NEXT_STAGE[(capa.stage ?? "") as CapaStage]
    && !GATE_STAGES.includes((capa.stage ?? "") as CapaStage);
  // Session 52.1 — soft Cancel via the cancelledAt columns (distinct from any
  // legacy status === "Cancelled"). A cancelled CAPA is read-only/non-advanceable.
  const isCancelled = !!(capa as { cancelledAt?: string | null } | null)?.cancelledAt;
  // Session 99 (#6) — header accent line = CAPA urgency (cancelled = urgent;
  // closed reads calm/neutral), matching the list-row traffic-light language.
  const headerTone = isCancelled ? "urgent" : capa?.status === "Closed" ? "neutral" : toneCapaStatus(capa?.status);
  const headerAccent = accentClass(headerTone);
  // Terminal stage blocks Cancel (mirrors server 409 on stage === "Closed").
  const isTerminalStage = capa?.stage === "Closed" || capa?.status === "Closed";
  const canCancelRecord = !!currentUser?.role && CAPA_CANCEL_ROLES.has(currentUser.role);
  const canReopenRecord = currentUser?.role === "Admin";
  const canVerifyEffectiveness = !isCancelled && (capa?.status === "Implementation" || capa?.status === "Effectiveness Check");
  // Session 52.3 — the Close card (with its "Cannot close yet" checklist) only
  // makes sense once the CAPA has reached the closeable stage (EC Execution →
  // Gate 2). Previously it rendered from the start, so a CAPA still in Planning
  // showed a "Cannot close yet" panel that read like an error.
  const canClose = capa && capa.stage === "EC Execution" && capa.status !== "Closed" && capa.status !== "Cancelled" && !isCancelled;
  const nextStatus = capa ? CAPA_STATUS_ORDER[currentStatusIdx + 1] : null;

  const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);
  const isApprover = !!currentUser?.role && APPROVER_ROLES.has(currentUser.role);
  const allItemsVerified = !!capa && capa.actionItems.length > 0 && capa.actionItems.every((i) => i.status === "Verified");
  // Session 63.6 — verification IS the close-out of an action item, so Action
  // Execution does not end until there is nothing left to verify. Mirrors the
  // server check on /advance-stage; the button being disabled is the courtesy,
  // the 409 is the control.
  const unverifiedItems = capa ? capa.actionItems.filter((i) => i.status !== "Verified") : [];
  const advanceBlockedReason: string | null =
    capa?.stage !== "Action Execution"
      ? null
      : capa.actionItems.length === 0
        ? "Add the corrective actions and have them verified before moving to the Effectiveness Check."
        : unverifiedItems.length > 0
          ? `${unverifiedItems.length} action item${unverifiedItems.length === 1 ? "" : "s"} still to verify. Verifying an action is what closes it out.`
          : null;
  const effectivenessSigned = !!capa?.effectivenessVerifiedAt;
  const canCloseNow = !!capa && allItemsVerified && effectivenessSigned;
  const closeBlockedReasons: string[] = [];
  if (capa) {
    if (capa.actionItems.length === 0) closeBlockedReasons.push("Add and verify at least one action item.");
    else if (!allItemsVerified) closeBlockedReasons.push("All action items must be Verified by a separate user.");
    if (!effectivenessSigned) closeBlockedReasons.push("Effectiveness verification signature required.");
  }

  if (loading) {
    return (
      <>
        <div className="max-w-5xl mx-auto pb-12 space-y-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-96" />
          <div className="grid gap-4">{[1,2,3].map(i => <Skeleton key={i} className="h-32 w-full" />)}</div>
        </div>
      </>
    );
  }

  if (!capa) {
    return (
      <>
        <div className="max-w-5xl mx-auto pb-12">
          <Link href="/capas" className="text-sm text-primary hover:underline mb-2 block">← Back to CAPAs</Link>
          <p className="text-muted-foreground">CAPA not found.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="space-y-6 max-w-5xl mx-auto pb-12 print:max-w-none">
        {/* Header */}
        <div className={headerAccent ? `pl-3 ${headerAccent}` : undefined}>
          <Link href="/capas" className="text-sm text-primary hover:underline mb-2 block print:hidden">
            ← Back to CAPAs
          </Link>
          <div className="cq-page-heading flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-2xl font-bold tracking-tight font-mono">{capa.capaNumber}</h1>
                {/* Which plant raised this (2026-08-28). Hidden with a single site. */}
                <SiteBadge facilityId={(capa as { facilityId?: number | null }).facilityId} />
                <span className={cn(
                  "px-2.5 py-0.5 rounded-full text-xs font-semibold border",
                  capa.type === "Corrective"
                    ? "bg-orange-50 text-orange-700 border-orange-200"
                    : "bg-teal-50 text-teal-700 border-teal-200"
                )}>
                  {capa.type}
                </span>
              </div>
              <p className="text-muted-foreground text-sm">{capa.title}</p>
            </div>
            <div className="flex items-center gap-2 print:hidden">
              {!isCancelled && !isTerminalStage && canCancelRecord && (
                <Button variant="outline" size="sm" onClick={() => setCancelOpen(true)} className="gap-1.5 text-destructive hover:text-destructive" data-testid="button-cancel-capa">
                  <Ban className="h-4 w-4" /> Cancel
                </Button>
              )}
              {isCancelled && canReopenRecord && (
                <Button variant="outline" size="sm" onClick={() => setUncancelOpen(true)} disabled={uncancelPending} className="gap-1.5" data-testid="button-reopen-capa">
                  <RotateCcw className="h-4 w-4" /> Re-open
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => window.print()}>
                <Printer className="h-4 w-4 mr-1" /> Print
              </Button>
              <StatusBadge tone={toneCapaStatus(capa.status)} label={capa.status} />
              {canAdvance && (
                <Button
                  size="sm"
                  onClick={() => setAdvanceDialogOpen(true)}
                  className="gap-1.5"
                  disabled={advanceBlockedReason !== null}
                  title={advanceBlockedReason ?? undefined}
                >
                  Advance to {AUTO_NEXT_STAGE[(capa?.stage ?? "") as CapaStage] ?? nextStatus}
                  <ChevronRight className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Session 52.1 — Cancelled banner (Part 11 record of who/why). */}
        {isCancelled && (
          <div className="rounded-lg border-2 border-red-200 bg-red-50 px-4 py-3 print:hidden" data-testid="banner-capa-cancelled">
            <p className="text-sm font-semibold text-red-900 flex items-center gap-2">
              <Ban className="h-4 w-4" /> This CAPA has been cancelled
            </p>
            <p className="text-xs text-red-800 mt-1">
              {(capa as { cancelledByName?: string | null }).cancelledByName}
              {(capa as { cancelledByInitials?: string | null }).cancelledByInitials ? ` (${(capa as { cancelledByInitials?: string | null }).cancelledByInitials})` : ""}
              {(capa as { cancelledAt?: string | null }).cancelledAt ? ` · ${format(new Date((capa as { cancelledAt?: string | null }).cancelledAt as string), "MMM d, yyyy h:mm a")}` : ""}
            </p>
            {(capa as { cancelledReason?: string | null }).cancelledReason && (
              <p className="text-sm text-red-900 mt-1.5 whitespace-pre-wrap">
                <span className="font-medium">Reason:</span> {(capa as { cancelledReason?: string | null }).cancelledReason}
              </p>
            )}
            <p className="text-[11px] text-red-700 mt-1 italic">Retained for compliance; can be re-opened by an Admin only.</p>
          </div>
        )}

        {/* Prominent source NC banner */}
        {capa.sourceNc && (
          <div className="rounded-lg border-2 border-orange-200 bg-orange-50 px-4 py-3 flex items-center justify-between gap-3 print:hidden" data-testid="banner-source-nc">
            <div className="flex items-center gap-3 min-w-0">
              <AlertTriangle className="h-5 w-5 text-orange-600 shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-orange-900 uppercase tracking-wide">Source Non-Conformance</p>
                <p className="text-sm font-medium truncate">
                  <span className="font-mono">{capa.sourceNc.ncNumber}</span> — {capa.sourceNc.title}
                  <span className="text-xs text-orange-700 ml-2">({capa.sourceNc.severity} · {capa.sourceNc.status})</span>
                </p>
              </div>
            </div>
            <Link href={`/non-conformances/${capa.sourceNc.id}`}>
              <Button size="sm" variant="outline" className="gap-1 shrink-0" data-testid="link-source-nc">
                <ExternalLink className="h-3.5 w-3.5" /> Open NC
              </Button>
            </Link>
          </div>
        )}

        {/* Stage stepper — new gated workflow (Session 4 design) */}
        <div className="rounded-lg border bg-card px-5 py-4 print:hidden">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">CAPA Workflow</p>
          <StageStepper
            current={capa.stage ?? "Initiation"}
            gate0ApprovedAt={capa.gate0ApprovedAt}
            gate1ApprovedAt={capa.gate1ApprovedAt}
            gate2Outcome={capa.gate2Outcome}
            hasGate1Sig1={!!capa.gate1Approver1Id}
          />
        </div>

        {/* Rejection banner — appears when this CAPA was rolled back at a gate */}
        <RejectionBanner capa={capa} />

        {/* Session 34 (Tier 2 #10) — Risk Classification card. Always visible.
            Re-assess action is enabled while stage = Investigation; everywhere
            else the card is read-only. Risk fields land via the orval-
            regenerated Capa shape (Session 34.1). */}
        {(() => {
          const PROMPT_ROWS: Array<{ key: "riskReleased" | "riskCustomerAffected" | "riskLabelingImpact" | "riskInHouseOnly" | "riskPreBulk"; label: string }> = [
            { key: "riskReleased",         label: "Released to customer" },
            { key: "riskCustomerAffected", label: "Customer affected" },
            { key: "riskLabelingImpact",   label: "Labeling impact" },
            { key: "riskInHouseOnly",      label: "In-house only" },
            { key: "riskPreBulk",          label: "Caught pre-bulk" },
          ];
          const RISK_TIER_STYLES: Record<string, string> = {
            Critical: "bg-red-50 text-red-800 border-red-300",
            High:     "bg-orange-50 text-orange-800 border-orange-300",
            Medium:   "bg-yellow-50 text-yellow-800 border-yellow-300",
            Low:      "bg-emerald-50 text-emerald-800 border-emerald-300",
          };
          const canReassess = capa.stage === "Investigation" && capa.status !== "Closed" && !isCancelled;
          return (
            <div className="rounded-lg border bg-card p-4 space-y-3 print:hidden">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Risk Classification</p>
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${RISK_TIER_STYLES[capa.riskLevel ?? ""] ?? "bg-gray-100 text-gray-700 border-gray-300"}`}>
                      {capa.riskLevel ?? "Not set"}
                    </span>
                    {capa.riskRevisedAt && capa.riskRevisedFrom && (
                      <span className="text-[11px] text-muted-foreground">
                        Revised from <strong>{capa.riskRevisedFrom}</strong>
                        {capa.riskRevisedByName && <> by {capa.riskRevisedByName}</>}
                        {" "}on {format(parseISO(capa.riskRevisedAt), "MMM d, yyyy")}
                      </span>
                    )}
                  </div>
                </div>
                {canReassess && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => { setRiskDraft({ riskLevel: capa.riskLevel ?? "", reason: "" }); setRiskOpen(true); }}
                  >
                    Re-assess Risk
                  </Button>
                )}
              </div>
              {capa.riskRationale && (
                <div>
                  <p className="text-xs text-muted-foreground font-medium mb-0.5">Rationale</p>
                  <p className="text-sm leading-relaxed">{capa.riskRationale}</p>
                </div>
              )}
              {capa.riskRevisedReason && (
                <div className="rounded-md bg-muted/50 px-3 py-2">
                  <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">Latest revision reason</p>
                  <p className="text-sm leading-relaxed mt-0.5">{capa.riskRevisedReason}</p>
                </div>
              )}
              <div className="pt-1 border-t">
                <p className="text-xs text-muted-foreground font-medium mb-1.5">Guiding prompts</p>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                  {PROMPT_ROWS.map((p) => {
                    const v = capa[p.key];
                    const yes = v === true;
                    const no = v === false;
                    return (
                      <div key={p.key} className="flex items-center gap-1.5">
                        <span className={`h-2 w-2 rounded-full ${yes ? "bg-amber-500" : no ? "bg-slate-300" : "bg-slate-200"}`} />
                        <span className={yes ? "font-medium" : "text-muted-foreground"}>{p.label}: {yes ? "Yes" : no ? "No" : "—"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              {canReassess && (
                <p className="text-[11px] text-muted-foreground border-t pt-2">
                  This CAPA is in <strong>Investigation</strong>. Re-assess Risk now if new evidence has changed the picture (e.g. you discovered the lot was released after all, or labeling claims are within spec on review). The change writes a RISK_REVISED audit entry with your reason.
                </p>
              )}
            </div>
          );
        })()}

        {/* Legacy status stepper kept temporarily for back-compat reference.
            Once all open CAPAs have migrated to the new stage flow this can
            be removed. Visible in a collapsed muted card. */}
        <details className="rounded-lg border bg-muted/30 px-4 py-2 text-xs text-muted-foreground print:hidden">
          <summary className="cursor-pointer select-none">Legacy linear status</summary>
          <div className="mt-2">
            <StatusStepper current={capa.status} />
          </div>
        </details>

        {/* Overview */}
        <SectionCard title="Overview">
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground font-medium mb-0.5">Description</dt>
              <dd className="text-foreground leading-relaxed">{capa.description}</dd>
            </div>
            <div className="space-y-3">
              <div>
                <dt className="text-xs text-muted-foreground font-medium mb-0.5">Opened By</dt>
                <dd>{capa.openedByName ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground font-medium mb-0.5">Opened</dt>
                <dd>{format(new Date(capa.createdAt), "MMM d, yyyy")}</dd>
              </div>
              {capa.closedAt && (
                <div>
                  <dt className="text-xs text-muted-foreground font-medium mb-0.5">Closed</dt>
                  <dd>{format(new Date(capa.closedAt), "MMM d, yyyy")} — {capa.closedByInitials} · {capa.closedByName}</dd>
                </div>
              )}
            </div>
          </div>
          {(capa.sourceNc || capa.sourceComplaint) && (
            <div className="mt-4 pt-4 border-t space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Source Record</p>
              {capa.sourceNc && (
                <Link href={`/non-conformances/${capa.sourceNc.id}`}>
                  <div className="flex items-center gap-2 text-sm text-primary hover:underline">
                    <ExternalLink className="h-3.5 w-3.5" />
                    {capa.sourceNc.ncNumber} — {capa.sourceNc.title}
                    <span className="text-xs text-muted-foreground">({capa.sourceNc.severity} · {capa.sourceNc.status})</span>
                  </div>
                </Link>
              )}
              {capa.sourceComplaint && (
                <Link href={`/complaints/${capa.sourceComplaint.id}`}>
                  <div className="flex items-center gap-2 text-sm text-primary hover:underline">
                    <ExternalLink className="h-3.5 w-3.5" />
                    {capa.sourceComplaint.complaintNumber} — {capa.sourceComplaint.complaintType}
                    <span className="text-xs text-muted-foreground">({capa.sourceComplaint.severity} · {capa.sourceComplaint.status})</span>
                  </div>
                </Link>
              )}
            </div>
          )}
        </SectionCard>

        {/* Per-Phase Due Dates (Session 14, item 15) — locked after Gate 1 */}
        {(() => {
          const isLocked = capa.status === "Closed" || !!capa.gate1ApprovedAt;
          const PHASES: Array<{ key: "investigationDueDate" | "actionPlanningDueDate" | "correctionPaClosureDueDate" | "ecCheckClosureDueDate"; label: string; hint: string }> = [
            { key: "investigationDueDate", label: "Investigation", hint: "Target completion for RCA" },
            { key: "actionPlanningDueDate", label: "Action / EC Planning", hint: "Target completion for the action & effectiveness-check plan" },
            { key: "correctionPaClosureDueDate", label: "Correction / Preventive Action Closure", hint: "Target completion for corrective/preventive action closure" },
            { key: "ecCheckClosureDueDate", label: "Effectiveness Check Closure", hint: "Target completion for the effectiveness check" },
          ];
          // Cast through unknown — the orval-generated Capa type does not
          // include these columns; same fallback used elsewhere in the file.
          const capaExt = capa as unknown as Record<string, string | null | undefined>;
          return (
            <SectionCard
              title="Per-Phase Due Dates"
              action={
                isLocked ? (
                  <span className="text-xs text-muted-foreground italic flex items-center gap-1">
                    <ShieldCheck className="h-3 w-3" /> Locked after Gate 1
                  </span>
                ) : undefined
              }
            >
              {/* 2026-08-27, his words: "Default dates are added from CannaQMS. Update
                  them based on the situation." Said once at the top of the card rather
                  than on each row — a person needs to know the dates are a starting
                  point, not four times that the same thing is true. */}
              <p className="text-xs text-muted-foreground mb-3">
                Default dates are added from CannaQMS. Update them based on the situation.
              </p>
              <div className="space-y-2">
                {PHASES.map((p) => (
                  <PhaseDueDateRow
                    key={p.key}
                    label={p.label}
                    hint={p.hint}
                    value={capaExt[p.key] ?? null}
                    isLocked={isLocked}
                    onSave={async (next) => {
                      try {
                        // Session 29 — patch() now wraps useUpdateCapa.mutateAsync.
                        await patch({ [p.key]: next || null });
                        toast({ title: `${p.label} due date updated` });
                        return true;
                      } catch (err) {
                        const msg = err instanceof Error ? err.message : `Failed to save ${p.label} due date`;
                        toast({ title: msg, variant: "destructive" });
                        return false;
                      }
                    }}
                  />
                ))}
              </div>
            </SectionCard>
          );
        })()}

        {/* Session 61 — Gate 0 sits AFTER the per-phase due dates, not above them.
            A gate rendered at the top of the page reads as "you are at this review
            now", when the point of a gate is to come at the END of what it covers.
            Accepting a CAPA is also the natural moment for a manager to set the
            phase due dates, so the dates are in front of them before they sign. */}
        {capa.stage === "Initiation" && !isCancelled && (
          <Gate0Card
            capa={capa}
            currentUserId={currentUser?.id ?? null}
            currentUserRole={currentUser?.role ?? null}
            onChanged={() => { void fetchCapa(); refetchAuditLog(); }}
          />
        )}

        {/* Root Cause Analysis — locked after Gate 1 (Session 4 design) */}
        <SectionCard
          title="Root Cause Analysis"
          action={
            !editingRca && !STAGES_AFTER_GATE1.includes(capa.stage as CapaStage) && capa.status !== "Closed" ? (
              <Button size="sm" variant="ghost" onClick={() => setEditingRca(true)}>Edit</Button>
            ) : STAGES_AFTER_GATE1.includes(capa.stage as CapaStage) ? (
              <span className="text-xs text-muted-foreground italic flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" /> Locked after Gate 1
              </span>
            ) : undefined
          }
        >
          {editingRca ? (
            <div className="space-y-3">
              {/* 2026-08-27 — these chips SAVE ON CLICK, like the Root Cause Categories
                  below. They used to be draft state saved with the analysis text, and
                  clicking a Root Cause Category patched + refetched, which reseeded this
                  draft from the server and threw away whatever had just been picked. The
                  effect that reseeds it carried a comment claiming it did not trample
                  mid-edit changes; it did.
                  His words: "the rest of the system kinda saves information when I choose
                  it" — so Save is left for the analysis text alone. */}
              <div className="space-y-1.5">
                <Label>RCA Methodology (select all that apply)</Label>
                <div className="flex flex-wrap gap-1.5">
                  {RCA_METHODS.map((m) => {
                    const checked = rcaMethodsDraft.includes(m);
                    return (
                      <button
                        type="button"
                        key={m}
                        disabled={savingRcaMethods}
                        onClick={() => void toggleRcaMethod(m)}
                        className={cn(
                          "inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors",
                          checked
                            ? "bg-purple-100 text-purple-800 border-purple-300"
                            : "bg-muted text-muted-foreground border-transparent hover:bg-muted/70"
                        )}
                      >
                        {checked && <CheckCircle2 className="h-3 w-3" />}
                        {m}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground italic">
                  Pick every methodology that contributed to identifying the root cause. Saved as you choose them.
                </p>
              </div>
              {/* 2026-08-27 — who actually ran the investigation. Free text, not a user
                  picker: an investigation is often run by a contract lab, a supplier's
                  engineer or a consultant who has no login here. */}
              <div className="space-y-1.5">
                <Label htmlFor="rca-investigator">Investigated by</Label>
                <Input
                  id="rca-investigator"
                  value={rcaInvestigatorDraft}
                  onChange={(e) => setRcaInvestigatorDraft(e.target.value)}
                  placeholder="Who performed the investigation"
                  data-testid="input-rca-investigator"
                />
                <p className="text-[11px] text-muted-foreground italic">
                  Often not the CAPA owner. A contract lab or supplier engineer can be named here.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Root Cause Analysis</Label>
                <Textarea rows={8} value={rcaDraft} onChange={(e) => setRcaDraft(e.target.value)} placeholder="Document the root cause analysis…" className="font-mono text-sm" />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={saveRca} disabled={savingRca}>{savingRca ? "Saving…" : "Save"}</Button>
                <Button size="sm" variant="outline" onClick={() => { setEditingRca(false); setRcaDraft(capa.rootCauseAnalysis ?? ""); setRcaMethodDraft(capa.rcaMethod ?? ""); setRcaInvestigatorDraft((capa as unknown as { rcaInvestigatorName?: string | null }).rcaInvestigatorName ?? ""); }}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {(capa.rcaMethods && capa.rcaMethods.length > 0) ? (
                <div>
                  <p className="text-xs text-muted-foreground font-medium mb-1">Methodologies</p>
                  <div className="flex flex-wrap gap-1">
                    {capa.rcaMethods.map((m) => (
                      <span key={m} className="inline-block bg-purple-50 text-purple-700 border border-purple-200 text-xs px-2 py-0.5 rounded font-medium">{m}</span>
                    ))}
                  </div>
                </div>
              ) : capa.rcaMethod && (
                <div>
                  <p className="text-xs text-muted-foreground font-medium mb-0.5">Methodology</p>
                  <span className="inline-block bg-purple-50 text-purple-700 border border-purple-200 text-xs px-2 py-0.5 rounded font-medium">{capa.rcaMethod}</span>
                </div>
              )}
              {(capa as unknown as { rcaInvestigatorName?: string | null }).rcaInvestigatorName && (
                <div>
                  <p className="text-xs text-muted-foreground font-medium mb-0.5">Investigated by</p>
                  <p className="text-sm">{(capa as unknown as { rcaInvestigatorName?: string | null }).rcaInvestigatorName}</p>
                </div>
              )}
              {capa.rootCauseAnalysis ? (
                <div>
                  <p className="text-xs text-muted-foreground font-medium mb-1">Analysis</p>
                  <p className="text-sm whitespace-pre-wrap leading-relaxed text-foreground">{capa.rootCauseAnalysis}</p>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground italic space-y-1.5">
                  <p>No root cause analysis documented yet.</p>
                  <p className="not-italic text-xs leading-relaxed text-muted-foreground/80">
                    Example: On [date], the CAPA team ([participants]) used a 5-Whys analysis and
                    determined the root cause of the nonconformance was [root cause]. Contributing
                    factors included [factors].
                  </p>
                </div>
              )}
            </div>
          )}
        </SectionCard>

        {/* 2026-08-28 — its OWN card, not the tail of Root Cause Analysis.
            Jonathan: "If I don't hit that Save button before selecting a Root Cause
            Category, then the information is not saved. There needs to be some
            separation to show the user those two before and after the save button are
            not related."
            These chips sat below the RCA card's Save button while saving themselves on
            click, so the layout promised that Save covered them and it never did. A
            separate card says what is true: different thing, different saving rule. */}
        {(() => {
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
          const current = ((capa as unknown as { rootCauses?: string[] | null }).rootCauses ?? []) as string[];
          const isLocked = capa.status === "Closed" || !!capa.gate1ApprovedAt;
          const toggle = async (label: string) => {
            const next = current.includes(label)
              ? current.filter((x) => x !== label)
              : [...current, label];
            try {
              // Session 29 — patch() now wraps useUpdateCapa.mutateAsync.
              await patch({ rootCauses: next });
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Failed to save root causes";
              toast({ title: msg, variant: "destructive" });
            }
          };
          return (
            <SectionCard title="Root Cause Categories">
              <p className="text-xs text-muted-foreground mb-2">
                For dashboards and trending. Saved as you choose them — this card has no Save button.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {ROOT_CAUSE_OPTIONS.map((opt) => {
                  const active = current.includes(opt);
                  return (
                    <button
                      key={opt}
                      type="button"
                      disabled={isLocked}
                      onClick={() => void toggle(opt)}
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
                  Pick one or more categories to support dashboards + trending.
                </p>
              )}
              {isLocked && (
                <p className="text-[10px] text-muted-foreground italic mt-1">
                  Locked after Gate 1 / closure.
                </p>
              )}
            </SectionCard>
          );
        })()}

        {/* Action Items */}
        <SectionCard
          title={`Corrective / Preventive Actions (${capa.actionItems.length})`}
          action={
            capa.status !== "Closed" && !isCancelled && !capa.gate1ApprovedAt ? (
              <AddActionItemDialog capaId={id} excludeUserIds={capa.effectivenessOwnerId != null ? [capa.effectivenessOwnerId] : []} onCreated={fetchCapa} />
            ) : capa.gate1ApprovedAt && capa.status !== "Closed" && !isCancelled ? (
              <span className="text-xs text-muted-foreground italic flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" /> Plan approved — actions locked
              </span>
            ) : undefined
          }
        >
          {capa.stage === "Action Execution" && !isCancelled && (
            <div className={`mb-3 rounded-md border px-3 py-2 text-xs ${allItemsVerified ? "border-green-200 bg-green-50 text-green-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
              <p className="font-medium">
                {capa.actionItems.filter((i) => i.status === "Verified").length} of {capa.actionItems.length} action{capa.actionItems.length === 1 ? "" : "s"} verified
              </p>
              <p className="mt-0.5">
                Verifying an action is how it is closed out — a second person confirms the
                work was actually done and had the intended effect, which is the evidence an
                inspector looks for. {allItemsVerified
                  ? "All actions are verified, so this CAPA can move to the Effectiveness Check."
                  : "This CAPA cannot move to the Effectiveness Check until every action is verified."}
              </p>
            </div>
          )}
          {capa.actionItems.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No action items yet. Add items to track corrective steps.</p>
          ) : (
            <div className="space-y-3">
              {capa.actionItems.map((item) => {
                const overdue = item.dueDate && item.status !== "Completed" && item.status !== "Verified" && isPast(parseISO(item.dueDate));
                return (
                  <div key={item.id} className={cn(
                    "rounded-lg border p-4",
                    overdue ? "border-red-200 bg-red-50/30" : "border-border bg-muted/20"
                  )}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2 flex-1 min-w-0">
                        <span className="shrink-0 text-xs font-bold text-muted-foreground mt-0.5 w-5">{item.sequenceNumber}.</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground leading-snug">{item.actionDescription}</p>
                          <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-muted-foreground">
                            {item.assignedToName && <span>👤 {item.assignedToName}</span>}
                            {item.dueDate && (
                              <span className={overdue ? "text-red-600 font-semibold" : ""}>
                                📅 {overdue && "⚠ "}{format(parseISO(item.dueDate), "MMM d, yyyy")}
                              </span>
                            )}
                            {item.completedAt && <span>✓ Completed {format(new Date(item.completedAt), "MMM d, yyyy")}</span>}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {/* Session 12 — completion/verify controls are hidden until
                            Gate 1 (planning approval) has been signed. Pre-approval the
                            row only shows the Task / Owner / Due fields. */}
                        {capa.gate1ApprovedAt ? (
                          <>
                            {item.status === "Verified" ? (
                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200" data-testid={`item-verified-${item.id}`}>
                                <ShieldCheck className="h-3 w-3" /> Verified
                              </span>
                            ) : (
                              <Select
                                value={item.status}
                                onValueChange={(v) => {
                                  if (v === "Completed") {
                                    setCompleteItem(item);
                                    setCompleteNotes(item.notes ?? "");
                                    setCompletePerformedOn(new Date().toISOString().slice(0, 10));
                                  } else {
                                    void handleUpdateActionItem(item.id, { status: v });
                                  }
                                }}
                                disabled={capa.status === "Closed"}
                              >
                                <SelectTrigger className="h-7 text-xs w-32" data-testid={`select-item-status-${item.id}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {["Open", "In Progress", "Completed"].map((s) => (
                                    <SelectItem key={s} value={s}>{s}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                            {capa.status !== "Closed" && item.status === "Completed" && isApprover && currentUser?.fullName !== item.completedByName && (
                              <Button
                                size="sm"
                                className="h-7 text-xs gap-1"
                                onClick={() => { setVerifyItemId(item.id); setVerifyItemOpen(true); }}
                                data-testid={`button-verify-item-${item.id}`}
                              >
                                <ShieldCheck className="h-3 w-3" /> Verify
                              </Button>
                            )}
                            {capa.status !== "Closed" && item.status === "Completed" && currentUser?.fullName === item.completedByName && (
                              <span className="text-[10px] text-muted-foreground italic max-w-[120px] leading-tight" title="Separate-verifier rule (21 CFR Part 11): the person who completed an action cannot also verify it.">
                                Awaiting separate verifier
                              </span>
                            )}
                            {/* Completion details — record what was done / evidence /
                                references while executing (plan content stays locked). */}
                            {capa.status !== "Closed" && !isCancelled && item.status !== "Verified" && (
                              <CompletionDetailsDialog capaId={id} item={item} onUpdated={fetchCapa} />
                            )}
                          </>
                        ) : (
                          <span className="text-[10px] text-muted-foreground italic max-w-[160px] leading-tight">
                            Completion fields unlock after Gate 1 (planning approval).
                          </span>
                        )}
                        {/* Edit — explicit per-row control; editable until the
                            plan is approved (Gate 1). Server enforces the same lock. */}
                        {!capa.gate1ApprovedAt && capa.status !== "Closed" && !isCancelled && (
                          <EditActionItemDialog capaId={id} item={item} excludeUserIds={capa.effectivenessOwnerId != null ? [capa.effectivenessOwnerId] : []} onUpdated={fetchCapa} />
                        )}
                        {/* Session 53 — Delete is an authoring action, allowed only
                            while the plan is still being drafted. Once Gate 1 is
                            approved the action set is frozen (no hard delete of an
                            approved record); the server enforces the same 409. */}
                        {!capa.gate1ApprovedAt && capa.status !== "Closed" && !isCancelled && item.status !== "Verified" && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-muted-foreground hover:text-red-600"
                            onClick={() => void handleDeleteActionItem(item.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                      <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-xs font-medium", ACTION_ITEM_STATUS_STYLES[item.status] ?? "bg-gray-100 text-gray-700")}>
                        {item.status}
                      </span>
                      {item.verifiedByName && item.verifiedAt && (
                        <span className="text-[11px] text-emerald-700">
                          ✓ Verified by {item.verifiedByName} on {format(new Date(item.verifiedAt), "MMM d, yyyy")}
                        </span>
                      )}
                    </div>
                    {item.notes && (
                      <p className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap border-l-2 border-border pl-2">
                        <span className="font-medium text-foreground">Completion notes: </span>{item.notes}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {/* Progress bar */}
          {capa.actionItems.length > 0 && (
            <div className="mt-4 pt-4 border-t">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-medium">
                  {capa.actionItems.filter((i) => i.status === "Completed" || i.status === "Verified").length} / {capa.actionItems.length} complete
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${(capa.actionItems.filter((i) => i.status === "Completed" || i.status === "Verified").length / capa.actionItems.length) * 100}%` }}
                />
              </div>
            </div>
          )}
        </SectionCard>

        {/* Effectiveness Check */}
        {(() => {
          const isOverdue = !capa.effectivenessVerifiedAt &&
            capa.effectivenessCheckDue &&
            capa.status !== "Closed" &&
            isPast(parseISO(capa.effectivenessCheckDue));

          const outcomeConfig = {
            "Effective": { icon: <CheckCircle2 className="h-4 w-4" />, border: "border-green-300", bg: "bg-green-50", text: "text-green-700", activeBg: "bg-green-100", activeRing: "ring-2 ring-green-400" },
            "Partially Effective": { icon: <AlertTriangle className="h-4 w-4" />, border: "border-amber-300", bg: "bg-amber-50", text: "text-amber-700", activeBg: "bg-amber-100", activeRing: "ring-2 ring-amber-400" },
            "Ineffective": { icon: <XCircle className="h-4 w-4" />, border: "border-red-300", bg: "bg-red-50", text: "text-red-700", activeBg: "bg-red-100", activeRing: "ring-2 ring-red-400" },
          } as const;

          return (
            <SectionCard
              title="Effectiveness Check"
              action={
                !editingEffectiveness && capa.status !== "Closed" && !capa.effectivenessVerifiedAt ? (
                  capa.gate1ApprovedAt ? (
                    // Criteria are part of the plan Gate 1 approved — locked. After
                    // approval the user records the *result* via the verification
                    // flow below, not by editing the acceptance criteria.
                    <span className="text-xs text-muted-foreground italic flex items-center gap-1">
                      <ShieldCheck className="h-3 w-3" /> Criteria locked after Gate 1
                    </span>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setEditingEffectiveness(true)}>Edit Criteria</Button>
                  )
                ) : undefined
              }
            >
              {/* EC Owner — Part 11 segregation enforced by server */}
              <div className="rounded-md border bg-card px-4 py-3 mb-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                      <UserCheck className="h-3.5 w-3.5" />
                      Effectiveness Check Owner
                    </p>
                    <p className="text-[11px] text-muted-foreground italic mt-0.5">
                      Must not be the originator or any action item owner (Part 11 segregation of duties).
                    </p>
                  </div>
                  {!editingEcOwner && !STAGES_AFTER_GATE1.includes(capa.stage as CapaStage) && capa.status !== "Closed" && (
                    <Button size="sm" variant="ghost" onClick={() => setEditingEcOwner(true)}>
                      {capa.effectivenessOwnerName ? "Change" : "Assign"}
                    </Button>
                  )}
                </div>
                {editingEcOwner ? (
                  (() => {
                    // Active users, minus the originator and anyone already
                    // assigned to an action item (server enforces the same
                    // segregation; filtering here avoids a confusing 409).
                    const actionOwnerIds = new Set(
                      capa.actionItems
                        .map((a) => (a as unknown as { assignedToId?: number }).assignedToId)
                        .filter((v): v is number => v != null),
                    );
                    const eligible = usersData.filter(
                      (u) => u.active && u.id !== capa.originatorId && !actionOwnerIds.has(u.id),
                    );
                    // 2026-08-28 — at a small site the segregation rule can leave NOBODY
                    // eligible, and a dead-end dropdown just means the CAPA gets finished
                    // outside the system. Everyone else is offered too, marked with the
                    // conflict, and choosing one requires a written reason.
                    const conflicted = usersData.filter(
                      (u) => u.active && (u.id === capa.originatorId || actionOwnerIds.has(u.id)),
                    );
                    const conflictLabel = (u: { id: number }) =>
                      u.id === capa.originatorId ? "originator" : "action owner";
                    const pickedIsConflicted = conflicted.some((u) => String(u.id) === ecOwnerDraft);
                    return (
                      <div className="space-y-2">
                      <div className="flex gap-2">
                        <Select value={ecOwnerDraft} onValueChange={setEcOwnerDraft}>
                          <SelectTrigger className="text-sm flex-1" data-testid="select-ec-owner">
                            <SelectValue placeholder="Select EC Owner…" />
                          </SelectTrigger>
                          <SelectContent>
                            {eligible.length === 0 && conflicted.length === 0 ? (
                              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                                No active users to assign.
                              </div>
                            ) : (
                              <>
                                {eligible.map((u) => (
                                  <SelectItem key={u.id} value={String(u.id)}>
                                    {u.fullName}{u.role ? ` · ${u.role}` : ""}
                                  </SelectItem>
                                ))}
                                {conflicted.length > 0 && (
                                  <div className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground border-t mt-1">
                                    Requires a written reason
                                  </div>
                                )}
                                {conflicted.map((u) => (
                                  <SelectItem key={u.id} value={String(u.id)}>
                                    {u.fullName}{u.role ? ` · ${u.role}` : ""} — {conflictLabel(u)}
                                  </SelectItem>
                                ))}
                              </>
                            )}
                          </SelectContent>
                        </Select>
                        <Button size="sm" onClick={saveEcOwner} disabled={savingEcOwner || !ecOwnerDraft || (pickedIsConflicted && !ecOverrideReason.trim())}>
                          {savingEcOwner ? "Saving…" : "Save"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => { setEditingEcOwner(false); setEcOwnerDraft(capa.effectivenessOwnerId != null ? String(capa.effectivenessOwnerId) : ""); setEcOverrideReason(""); }}>Cancel</Button>
                      </div>
                      {pickedIsConflicted && (
                        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
                          <p className="text-xs font-semibold text-amber-900 flex items-center gap-1">
                            <AlertTriangle className="h-3.5 w-3.5" /> Segregation of duties exception
                          </p>
                          <p className="text-[11px] text-amber-900">
                            This person raised the CAPA or did the work being checked. Assigning them anyway is
                            allowed where nobody else is available, and the reason is kept on the record.
                          </p>
                          <Textarea
                            rows={2}
                            value={ecOverrideReason}
                            onChange={(e) => setEcOverrideReason(e.target.value)}
                            placeholder="Why is nobody else available?"
                            data-testid="input-ec-override-reason"
                          />
                        </div>
                      )}
                      </div>
                    );
                  })()
                ) : (
                  <div className="space-y-1.5">
                    <div className="text-sm font-medium">
                      {capa.effectivenessOwnerName ?? <span className="text-muted-foreground italic font-normal">Not yet assigned</span>}
                    </div>
                    {/* An exception to segregation of duties is exactly what an auditor
                        looks for, so it is stated on the record rather than left in the
                        audit log for someone to go digging. */}
                    {(capa as unknown as { ecOwnerSegregationOverrideReason?: string | null }).ecOwnerSegregationOverrideReason && (
                      <div className="rounded-md border border-amber-300 bg-amber-50 p-2">
                        <p className="text-[11px] font-semibold text-amber-900 flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" /> Segregation of duties exception
                        </p>
                        <p className="text-[11px] text-amber-900 mt-0.5 whitespace-pre-wrap">
                          {(capa as unknown as { ecOwnerSegregationOverrideReason?: string | null }).ecOwnerSegregationOverrideReason}
                        </p>
                        <p className="text-[10px] text-amber-700 mt-0.5 italic">
                          Recorded by {(capa as unknown as { ecOwnerSegregationOverrideBy?: string | null }).ecOwnerSegregationOverrideBy ?? "—"}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {editingEffectiveness ? (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label>Effectiveness Criteria</Label>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1"
                        onClick={fetchAiSuggestions}
                        disabled={loadingSuggestions || capa.actionItems.length === 0}
                        data-testid="button-suggest-effectiveness"
                      >
                        <FlaskConical className="h-3 w-3" />
                        {loadingSuggestions ? "Thinking…" : "Suggest with AI"}
                      </Button>
                    </div>
                    <Textarea rows={4} value={effectivenessCriteriaDraft} onChange={(e) => setEffectivenessCriteriaDraft(e.target.value)} placeholder="Define measurable criteria to confirm the CAPA was effective…" data-testid="textarea-effectiveness-criteria" />
                    {aiSuggestions.length > 0 && (
                      <div className="rounded border border-indigo-200 bg-indigo-50/40 p-2 space-y-1.5">
                        <p className="text-[11px] font-semibold text-indigo-800 uppercase tracking-wide">AI suggestions — click to add</p>
                        <div className="flex flex-wrap gap-1.5">
                          {aiSuggestions.map((s, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => setEffectivenessCriteriaDraft((d) => (d ? d.trimEnd() + "\n• " + s : "• " + s))}
                              className="text-left text-xs bg-white border border-indigo-200 hover:border-indigo-400 rounded px-2 py-1 cursor-pointer"
                              data-testid={`chip-suggestion-${i}`}
                            >
                              + {s}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label>Check Due Date</Label>
                    <Input type="date" value={effectivenessCheckDueDraft} onChange={(e) => setEffectivenessCheckDueDraft(e.target.value)} className="w-48" />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveEffectiveness} disabled={savingEffectiveness}>{savingEffectiveness ? "Saving…" : "Save"}</Button>
                    <Button size="sm" variant="outline" onClick={() => { setEditingEffectiveness(false); setEffectivenessCriteriaDraft(capa.effectivenessCriteria ?? ""); setEffectivenessCheckDueDraft(capa.effectivenessCheckDue ?? ""); setAiSuggestions([]); }}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">

                  {/* ── Overdue alert ── */}
                  {isOverdue && (
                    <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                      <AlertTriangle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
                      <div className="text-sm">
                        <p className="font-semibold text-red-800">Effectiveness check overdue</p>
                        <p className="text-red-700 text-xs mt-0.5">
                          Due {format(parseISO(capa.effectivenessCheckDue!), "MMMM d, yyyy")} — ISO 13485 §8.5.2 requires documented verification that corrective actions do not adversely affect product conformity.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* ── Criteria + due date ── */}
                  <div className={cn(
                    "rounded-lg border px-4 py-3 text-sm space-y-2",
                    isOverdue ? "border-red-200 bg-red-50/40" : "border-border bg-muted/30"
                  )}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                        <FlaskConical className="h-3.5 w-3.5" />
                        Defined Acceptance Criteria
                      </p>
                      {capa.effectivenessCheckDue && (
                        <span className={cn(
                          "text-xs font-medium px-2 py-0.5 rounded border",
                          isOverdue
                            ? "bg-red-100 text-red-700 border-red-200"
                            : "bg-slate-100 text-slate-600 border-slate-200"
                        )}>
                          Due {format(parseISO(capa.effectivenessCheckDue), "MMM d, yyyy")}
                        </span>
                      )}
                    </div>
                    <p className={capa.effectivenessCriteria ? "leading-relaxed text-foreground" : "text-muted-foreground italic text-xs"}>
                      {capa.effectivenessCriteria ?? 'No criteria defined. Use \u201cEdit Criteria\u201d to document measurable acceptance conditions.'}
                    </p>
                  </div>

                  {/* ── Already verified: audit stamp ── */}
                  {capa.effectivenessVerifiedAt && capa.effectivenessOutcome && (() => {
                    const cfg = outcomeConfig[capa.effectivenessOutcome as keyof typeof outcomeConfig];
                    return (
                      <div className={cn("rounded-lg border px-5 py-4 space-y-3", cfg?.border, cfg?.bg)}>
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div className="flex items-center gap-2">
                            <span className={cn("flex items-center gap-1.5 text-sm font-bold", cfg?.text)}>
                              {cfg?.icon}
                              {capa.effectivenessOutcome}
                            </span>
                            <span className="text-xs text-muted-foreground">— ISO 13485 §8.5.2 verified</span>
                          </div>
                          <span className="text-xs text-muted-foreground font-mono">
                            {format(new Date(capa.effectivenessVerifiedAt), "MMM d, yyyy 'at' h:mm a")}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground border-t pt-2.5 mt-1">
                          <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                          <span>Electronic signature by <strong className="text-foreground">{capa.effectivenessVerifiedByInitials}</strong> — {capa.effectivenessVerifiedByName} (21 CFR Part 11)</span>
                        </div>
                        {capa.effectivenessNotes && (
                          <div className="pt-1">
                            <p className="text-xs text-muted-foreground font-medium mb-1">Verification Findings</p>
                            <p className="text-sm leading-relaxed whitespace-pre-wrap">{capa.effectivenessNotes}</p>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* ── Sign-off panel ── */}
                  {canVerifyEffectiveness && !capa.effectivenessVerifiedAt && (
                    <div className="rounded-lg border-2 border-dashed border-indigo-200 bg-indigo-50/40 px-5 py-4 space-y-4">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-indigo-600" />
                        <p className="text-sm font-semibold text-indigo-800">Record Effectiveness Verification</p>
                        <span className="text-xs text-indigo-600 bg-indigo-100 border border-indigo-200 px-1.5 py-0.5 rounded font-mono">§8.5.2</span>
                      </div>

                      {/* Outcome radio cards */}
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-2">Outcome *</p>
                        <div className="grid grid-cols-3 gap-2">
                          {(["Effective", "Partially Effective", "Ineffective"] as const).map((outcome) => {
                            const cfg = outcomeConfig[outcome];
                            const selected = verifyEffectivenessOutcome === outcome;
                            return (
                              <button
                                key={outcome}
                                type="button"
                                onClick={() => setVerifyEffectivenessOutcome(outcome)}
                                className={cn(
                                  "flex flex-col items-center gap-1.5 rounded-lg border-2 px-3 py-3 text-xs font-semibold transition-all cursor-pointer",
                                  selected
                                    ? cn(cfg.border, cfg.activeBg, cfg.text, cfg.activeRing)
                                    : "border-border bg-card text-muted-foreground hover:border-muted-foreground/40"
                                )}
                              >
                                <span className={selected ? cfg.text : ""}>{cfg.icon}</span>
                                {outcome}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Findings notes */}
                      <div className="space-y-1.5">
                        <Label className="text-xs">Verification Findings / Evidence</Label>
                        <Textarea
                          rows={3}
                          placeholder="Document observations, data reviewed, and evidence confirming the CAPA outcome…"
                          value={verifyEffectivenessNotes}
                          onChange={(e) => setVerifyEffectivenessNotes(e.target.value)}
                          className="text-sm"
                        />
                      </div>

                      {/* Part 11 sign button */}
                      <div className="flex items-start gap-3 pt-1">
                        <Button
                          className="gap-1.5"
                          onClick={() => setVerifyEffectivenessOpen(true)}
                        >
                          <ShieldCheck className="h-4 w-4" />
                          Sign &amp; Record Verification
                        </Button>
                        <p className="text-xs text-muted-foreground mt-2.5">
                          Records your electronic signature per 21 CFR Part 11.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </SectionCard>
          );
        })()}

        {/* Session 61 — Gate 1 sits AFTER the Effectiveness Check section, at the
            end of everything it approves. Gate 1 signs off the Investigation and
            Planning bundle — RCA, corrective actions, EC criteria and owner — so
            the reviewer should have scrolled through all of it before signing
            rather than meeting the signature button first. */}
        {capa.stage === "Planning" && !isCancelled && (
          <Gate1Card
            capa={capa}
            currentUserId={currentUser?.id ?? null}
            onChanged={() => { void fetchCapa(); refetchAuditLog(); }}
          />
        )}

        {/* Session 63 — Gate 2 sits AFTER the Effectiveness Check section, for the
            same reason Gate 0 and Gate 1 were moved in Session 61. Gate 2 closes
            the CAPA on the strength of the effectiveness-check RESULT, so the
            approver should have read the EC outcome and findings immediately
            above before signing. Rendered near the top it read as "you are at
            closure review now" the moment a CAPA reached EC Execution, which is
            exactly the misread Jonathan reported for Gate 1. Only shows at the
            EC Execution stage, unchanged. */}
        {capa.stage === "EC Execution" && !isCancelled && (
          <Gate2Card
            capa={capa}
            currentUserId={currentUser?.id ?? null}
            onChanged={() => { void fetchCapa(); refetchAuditLog(); }}
          />
        )}

        {/* Closure */}
        {canClose && (
          <SectionCard title="Close CAPA (21 CFR Part 11)">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Closure Notes</Label>
                <Textarea rows={3} value={closureNotesDraft} onChange={(e) => setClosureNotesDraft(e.target.value)} placeholder="Summarise the CAPA outcome and confirm all action items are complete…" />
              </div>
              {closeBlockedReasons.length > 0 ? (
                <div className="flex items-start gap-3 p-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900" data-testid="text-close-blocked">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
                  <div className="space-y-1">
                    <p className="font-semibold">Cannot close yet:</p>
                    <ul className="list-disc list-inside space-y-0.5">
                      {closeBlockedReasons.map((r) => <li key={r}>{r}</li>)}
                    </ul>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 text-xs text-muted-foreground">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  Closure requires an electronic signature per 21 CFR Part 11.
                </div>
              )}
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={() => setCloseSignatureOpen(true)}
                disabled={!canCloseNow}
                title={canCloseNow ? undefined : closeBlockedReasons.join(" ")}
                data-testid="button-close-capa"
              >
                <CheckCircle2 className="h-4 w-4" /> Sign &amp; Close CAPA
              </Button>
            </div>
          </SectionCard>
        )}

        {/* ── Attachments — investigation evidence, action-item proof,
            effectiveness data. capas is allow-listed server-side. ── */}
        <AttachmentsPanel
          parentTable="capas"
          parentId={capa.id}
          allowSupplementary={!isCancelled && !isTerminalStage}
          currentUserId={currentUser?.id}
          currentUserRole={currentUser?.role}
          title="Attachments (evidence, supporting docs)"
        />

        {/* ── Audit Trail ── */}
        <SectionCard
          title="Audit Trail (21 CFR Part 11)"
          action={
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <History className="h-3.5 w-3.5" />
              {auditLog.length} event{auditLog.length !== 1 ? "s" : ""}
            </div>
          }
        >
          {auditLog.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6 italic">
              No audit events recorded yet. Changes made going forward will appear here.
            </p>
          ) : (
            <div className="relative">
              {/* vertical timeline line */}
              <div className="absolute left-[18px] top-2 bottom-2 w-px bg-border" />
              <ul className="space-y-0 divide-y divide-border/50">
                {auditLog.map((entry) => {
                  const diffRows = entryDiffRows(entry);
                  return (
                    <li key={entry.id} className="flex gap-3 py-3.5">
                      {/* icon bubble */}
                      <div className="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border bg-background shadow-sm">
                        {entryIcon(entry)}
                      </div>
                      <div className="flex-1 min-w-0 space-y-1 pt-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge
                            variant={entry.operation === "INSERT" ? "default" : "secondary"}
                            className="text-[10px] px-1.5 py-0"
                          >
                            {entry.operation === "INSERT" ? "Created" : "Updated"}
                          </Badge>
                          <span className="text-sm font-medium">
                            {entrySummary(entry)}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="font-mono">
                            {entry.changedAt
                              ? format(new Date(entry.changedAt), "MMM d, yyyy 'at' HH:mm")
                              : "—"}
                          </span>
                          {entry.changedByName && (
                            <>
                              <span>·</span>
                              <span>{entry.changedByName}</span>
                            </>
                          )}
                        </div>
                        {diffRows.length > 0 && (
                          <div className="mt-1.5 rounded-md border bg-muted/30 divide-y text-xs overflow-hidden">
                            {diffRows.map((row) => (
                              <div key={row.label} className="flex gap-2 px-2.5 py-1.5 items-start">
                                <span className="w-36 shrink-0 font-medium text-muted-foreground truncate">{row.label}</span>
                                {row.before !== null ? (
                                  <span className="flex items-center gap-1.5 flex-1 min-w-0">
                                    <span className="line-through text-muted-foreground/60 truncate max-w-[120px]">{row.before}</span>
                                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40" />
                                    <span className="text-foreground truncate">{row.after}</span>
                                  </span>
                                ) : (
                                  <span className="flex-1 text-foreground break-words line-clamp-3">{row.after}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </SectionCard>

        {/* Closed stamp */}
        {capa.status === "Closed" && capa.closedAt && (
          <div className="rounded-lg border border-green-200 bg-green-50 p-4 flex items-start gap-3">
            <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-green-800">CAPA Closed</p>
              <p className="text-green-700 mt-0.5">
                Closed {format(new Date(capa.closedAt), "MMMM d, yyyy 'at' h:mm a")} by <strong>{capa.closedByInitials}</strong> — {capa.closedByName}
              </p>
              {capa.closureNotes && <p className="mt-1 text-green-700 italic">&ldquo;{capa.closureNotes}&rdquo;</p>}
            </div>
          </div>
        )}

        {/* Session 34 (Tier 2 #10) — Re-assess Risk dialog. Soft prompt while
            stage = Investigation. New tier + reason required; server stamps
            the lineage + RISK_REVISED audit row. */}
        <Dialog open={riskOpen} onOpenChange={(v) => { setRiskOpen(v); if (!v) { setRiskDraft({ riskLevel: "", reason: "" }); setRiskError(null); } }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Re-assess Risk</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <p className="text-sm text-muted-foreground">
                Risk can be revised during Investigation as new information surfaces. The change is
                audit-logged with the reason you provide here.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="risk-current">Current</Label>
                <Input id="risk-current" value={capa.riskLevel ?? "Not set"} disabled />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="risk-new">New Risk Level *</Label>
                <Select value={riskDraft.riskLevel} onValueChange={(v) => setRiskDraft((d) => ({ ...d, riskLevel: v }))}>
                  <SelectTrigger id="risk-new"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Critical">Critical — safety-of-life / regulatory exposure</SelectItem>
                    <SelectItem value="High">High — released material or customer-facing impact</SelectItem>
                    <SelectItem value="Medium">Medium — contained internal issue</SelectItem>
                    <SelectItem value="Low">Low — pre-bulk, easily corrected</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="risk-reason">Reason *</Label>
                <Textarea
                  id="risk-reason"
                  rows={3}
                  placeholder="e.g. 'CoA review confirmed the lot was actually inside spec — downgrading to Medium.'"
                  value={riskDraft.reason}
                  onChange={(e) => setRiskDraft((d) => ({ ...d, reason: e.target.value }))}
                />
              </div>
              {riskError && <p className="text-sm text-destructive">{riskError}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRiskOpen(false)} disabled={riskSaving}>Cancel</Button>
              <Button onClick={handleRiskRevise} disabled={riskSaving || !riskDraft.riskLevel || !riskDraft.reason.trim()}>
                {riskSaving ? "Saving…" : "Revise Risk"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Advance dialog */}
        <Dialog open={advanceDialogOpen} onOpenChange={setAdvanceDialogOpen}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader><DialogTitle>Advance CAPA Status</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground py-2">
              Move <strong>{capa.capaNumber}</strong> from <strong>{capa.status}</strong> to <strong>{nextStatus}</strong>?
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAdvanceDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleAdvance} disabled={advancing}>{advancing ? "Advancing…" : "Advance"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Effectiveness verification signature */}
        <Part11SignatureDialog
          open={verifyEffectivenessOpen}
          onOpenChange={setVerifyEffectivenessOpen}
          title="Verify Effectiveness"
          description={`Confirm the CAPA is "${verifyEffectivenessOutcome}". This records your electronic signature per 21 CFR Part 11.`}
          onSign={handleVerifyEffectiveness}
          isPending={verifyingEffectiveness}
        />

        {/* Session 101 (#16) — required completion detail before an action item
            can be marked Completed (who=signer, what=notes, when=performedOn). */}
        <Dialog open={!!completeItem} onOpenChange={(o) => { if (!o) setCompleteItem(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader><DialogTitle>Complete corrective action</DialogTitle></DialogHeader>
            <div className="space-y-4 py-2">
              {completeItem && (
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground leading-snug whitespace-pre-wrap">{completeItem.actionDescription}</p>
                </div>
              )}
              <div className="space-y-1.5">
                <Label>What was done <span className="text-destructive">*</span></Label>
                <Textarea
                  rows={4}
                  value={completeNotes}
                  onChange={(e) => setCompleteNotes(e.target.value)}
                  placeholder="Describe the action performed and evidence collected (reference supporting documents / attachments)."
                />
              </div>
              <div className="space-y-1.5">
                <Label>Date performed <span className="text-destructive">*</span></Label>
                <Input
                  type="date"
                  value={completePerformedOn}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setCompletePerformedOn(e.target.value)}
                />
                <p className="text-[10px] text-muted-foreground">When the action was actually carried out. A separate person must Verify it afterward (Part 11).</p>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCompleteItem(null)}>Cancel</Button>
              <Button
                type="button"
                disabled={completingItem || !completeNotes.trim() || !completePerformedOn}
                onClick={async () => {
                  if (!completeItem) return;
                  setCompletingItem(true);
                  try {
                    await handleUpdateActionItem(completeItem.id, { status: "Completed", notes: completeNotes.trim(), performedOn: completePerformedOn });
                    setCompleteItem(null);
                  } finally {
                    setCompletingItem(false);
                  }
                }}
              >
                {completingItem ? "Saving…" : "Mark complete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Per-action-item verify signature */}
        <Part11SignatureDialog
          open={verifyItemOpen}
          onOpenChange={(o) => { setVerifyItemOpen(o); if (!o) setVerifyItemId(null); }}
          title="Verify Corrective / Preventive Action"
          description="By signing, you confirm this action was completed effectively. The verifier must be a different person from the one who marked it complete (21 CFR Part 11 separation of duties)."
          onSign={handleVerifyActionItem}
          isPending={verifyingItem}
        />

        {/* Closure signature */}
        <Part11SignatureDialog
          open={closeSignatureOpen}
          onOpenChange={setCloseSignatureOpen}
          title="Close CAPA"
          description={`Electronically sign to close ${capa.capaNumber}. This action is recorded per 21 CFR Part 11.`}
          onSign={handleClose}
          isPending={closing}
        />

        {/* Session 52.1 — Cancel (rationale + Part 11 e-signature). */}
        <CancelRecordDialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          entityLabel="CAPA"
          isPending={cancelPending}
          onConfirm={handleCancel}
        />

        {/* Session 52.1 — Re-open (Admin-only; Part 11 e-signature). */}
        <Part11SignatureDialog
          open={uncancelOpen}
          onOpenChange={setUncancelOpen}
          title="Re-open CAPA"
          description="Re-open this cancelled CAPA and return it to active use. Restricted to Admin; requires an Admin signature."
          isPending={uncancelPending}
          onSign={handleUncancel}
        />
      </div>
    </>
  );
}
