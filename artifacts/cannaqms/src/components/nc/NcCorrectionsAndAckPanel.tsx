import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, ShieldAlert, Plus, CircleCheck } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
// Session 27 — typed hooks spec'd in Session 25. Replaces the raw fetch()
// pattern that lived here through Sessions 11–26.
import {
  useListNcCorrections,
  useCreateNcCorrection,
  getListNcCorrectionsQueryKey,
  useGetCurrentUser,
  useListUsers,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type NcLite = {
  id: number;
  status: string;
  severity: string;
  mgmtAcknowledgedAt: string | null;
  mgmtAcknowledgedName: string | null;
  mgmtAcknowledgedInitials: string | null;
  mgmtAcknowledgedNotes: string | null;
};

const REQUIRES_ACK_AND_CAPA = (sev: string) => {
  const s = (sev ?? "").toLowerCase();
  return s === "major" || s === "critical";
};

export function NcCorrectionsAndAckPanel({
  nc,
  onAcknowledged,
  locked = false,
}: {
  nc: NcLite;
  onAcknowledged?: () => void;
  /** Session 52.1.1 — when the NC is cancelled, the panel is fully read-only
   *  (no new corrections, no completing tasks, no management acknowledgement). */
  locked?: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ description: "", dueDate: "", taskOwnerName: "", taskOwnerUserId: "" });
  const [completingId, setCompletingId] = useState<number | null>(null);
  // Session 101 (#9) — completion detail dialog: capture what was done + when.
  const [completeTarget, setCompleteTarget] = useState<{ id: number; description: string } | null>(null);
  const [completeNotes, setCompleteNotes] = useState("");
  const [completePerformedOn, setCompletePerformedOn] = useState("");
  const [reassigningId, setReassigningId] = useState<number | null>(null);
  const [ackOpen, setAckOpen] = useState(false);
  const [ackNotes, setAckNotes] = useState("");
  const [acking, setAcking] = useState(false);

  const isClosed = nc.status === "Closed";
  const requiresAck = REQUIRES_ACK_AND_CAPA(nc.severity);
  const hasAck = !!nc.mgmtAcknowledgedAt;

  // Session 27 — list query + create/complete mutations swapped to the typed
  // hooks generated from the Session 25 OpenAPI spec. react-query handles the
  // refetch lifecycle; we invalidate the list query after each mutation rather
  // than calling a manual reload() function.
  const { data: corrections = [], isLoading: loading } = useListNcCorrections(nc.id);
  const createCorrection = useCreateNcCorrection();
  const invalidateCorrections = () =>
    queryClient.invalidateQueries({ queryKey: getListNcCorrectionsQueryKey(nc.id) });

  // NC-3 — completing a correction requires being its owner. Match the current
  // user against the task's owner (by user id if set, else by full name) so the
  // panel can offer "Complete" to the owner and "Reassign to me" to everyone else.
  const { data: currentUser } = useGetCurrentUser();
  const { data: usersData = [] } = useListUsers();
  const meId = currentUser?.id;
  const meName = (currentUser?.fullName ?? "").trim().toLowerCase();
  const ownsCorrection = (c: { taskOwnerUserId?: number | null; taskOwnerName?: string | null }) =>
    (c.taskOwnerUserId != null && c.taskOwnerUserId === meId) ||
    (!!c.taskOwnerName && c.taskOwnerName.trim().toLowerCase() === meName);

  async function reassignToMe(id: number) {
    setReassigningId(id);
    try {
      const res = await fetch(`/api/nc-corrections/${id}/reassign-to-me`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({} as { error?: string }));
        toast({ title: msg?.error ?? "Failed to reassign", variant: "destructive" });
        return;
      }
      toast({ title: "Task reassigned to you", description: "You're now the owner and can complete it." });
      void invalidateCorrections();
    } finally {
      setReassigningId(null);
    }
  }

  async function addCorrection() {
    if (!draft.description.trim()) {
      toast({ title: "Description is required", variant: "destructive" });
      return;
    }
    try {
      const owner = draft.taskOwnerUserId ? usersData.find((u) => String(u.id) === draft.taskOwnerUserId) : null;
      await createCorrection.mutateAsync({
        id: nc.id,
        data: {
          description: draft.description.trim(),
          dueDate: draft.dueDate || null,
          taskOwnerName: owner?.fullName ?? null,
          taskOwnerUserId: owner?.id ?? null,
        } as never,
      });
      toast({ title: "Correction task added" });
      setDraft({ description: "", dueDate: "", taskOwnerName: "", taskOwnerUserId: "" });
      setAdding(false);
      void invalidateCorrections();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to add task";
      toast({ title: msg, variant: "destructive" });
    }
  }

  function openCompleteDialog(c: { id: number; description: string }) {
    setCompleteTarget({ id: c.id, description: c.description });
    setCompleteNotes("");
    setCompletePerformedOn(new Date().toISOString().slice(0, 10));
  }

  async function completeCorrection() {
    if (!completeTarget) return;
    const id = completeTarget.id;
    if (!completeNotes.trim() || !completePerformedOn) {
      toast({ title: "Details required", description: "Record what was done and the date it occurred.", variant: "destructive" });
      return;
    }
    setCompletingId(id);
    try {
      const res = await fetch(`/api/nc-corrections/${id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: completeNotes.trim(), performedOn: completePerformedOn }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error ?? "Failed to mark complete");
      }
      toast({ title: "Task completed" });
      setCompleteTarget(null);
      void invalidateCorrections();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to mark complete";
      toast({ title: msg, variant: "destructive" });
    } finally {
      setCompletingId(null);
    }
  }

  async function handleAcknowledge(initials: string, meaning: string) {
    setAcking(true);
    try {
      const res = await fetch(`/api/non-conformances/${nc.id}/management-acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ initials, signatureMeaning: meaning, notes: ackNotes.trim() || undefined }),
      });
      if (!res.ok) {
        // NC-5 — surface the server's specific reason (e.g. the role gate:
        // "Management acknowledgement requires Manager / Quality / Admin role. Your
        // role is …") instead of a generic "Acknowledgement failed".
        const j = await res.json().catch(() => ({} as { error?: string }));
        toast({ title: j.error ?? "Management acknowledgement failed.", variant: "destructive" });
        throw new Error(j.error ?? "ack failed");
      }
      toast({ title: "Management acknowledgement recorded" });
      setAckNotes("");
      onAcknowledged?.();
    } finally {
      setAcking(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Corrections — immediate containment actions, distinct from CAPA */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div>
            <CardTitle className="text-base">Corrections</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Containment tasks taken in response to this NC. Distinct from CAPA (root-cause-driven). Each task tracks owner, due date, and completion for metrics + Part 11.
            </p>
          </div>
          {!isClosed && !locked && !adding && (
            <Button size="sm" variant="outline" onClick={() => { setDraft((d) => ({ ...d, taskOwnerUserId: meId != null ? String(meId) : "" })); setAdding(true); }} data-testid="button-add-correction">
              <Plus className="h-4 w-4 mr-1" />Add Task
            </Button>
          )}
        </CardHeader>
        <CardContent className="pt-2 space-y-3">
          {adding && (
            <div className="border rounded-md p-3 space-y-2 bg-muted/20">
              <div>
                <Label className="text-xs">Task *</Label>
                <Textarea
                  rows={2}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="e.g. Quarantine affected lots; pull remaining units from sales floor."
                  className="text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Task Owner</Label>
                  <Select value={draft.taskOwnerUserId} onValueChange={(v) => setDraft({ ...draft, taskOwnerUserId: v })}>
                    <SelectTrigger className="h-8 text-sm mt-0.5" data-testid="select-correction-owner">
                      <SelectValue placeholder="Select owner…" />
                    </SelectTrigger>
                    <SelectContent>
                      {usersData.filter((u) => u.active || String(u.id) === draft.taskOwnerUserId).map((u) => (
                        <SelectItem key={u.id} value={String(u.id)}>
                          {u.fullName}{u.role ? ` · ${u.role}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Date Due</Label>
                  <Input
                    type="date"
                    value={draft.dueDate}
                    onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
                    className="h-8 text-sm"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Owner / due date are editable by anyone until the task is marked complete. Only the assigned owner can complete a task — anyone else must reassign it to themselves first (recorded in the audit trail).
              </p>
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={addCorrection} disabled={createCorrection.isPending || !draft.description.trim()}>
                  {createCorrection.isPending ? "Saving…" : "Add Task"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setDraft({ description: "", dueDate: "", taskOwnerName: "", taskOwnerUserId: "" }); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {loading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : corrections.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              No correction tasks yet. Add every immediate action needed to contain the issue (quarantine, recall hold, line stop, etc.).
            </p>
          ) : (
            <div className="border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Task</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Completed</TableHead>
                    {/* NC-4 — controls column left unlabeled: it holds the
                        Complete / Reassign button while a task is open and is
                        empty once done, so a visible "Action" header read as a
                        mysteriously-blank column on completed rows. */}
                    <TableHead className="w-[110px] text-right"><span className="sr-only">Task actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {corrections.map((c) => {
                    const isDone = !!c.completed;
                    return (
                      <TableRow key={c.id} className={isDone ? "opacity-75" : ""}>
                        <TableCell className="align-top">
                          <p className={`text-sm whitespace-pre-wrap ${isDone ? "line-through" : ""}`}>{c.description}</p>
                          {c.notes && <p className="text-xs text-muted-foreground italic mt-0.5">{c.notes}</p>}
                        </TableCell>
                        <TableCell className="align-top text-sm">{c.taskOwnerName ?? c.performedByName ?? "—"}</TableCell>
                        <TableCell className="align-top text-sm">
                          {c.dueDate ? format(new Date(`${c.dueDate}T12:00:00`), "MMM d, yyyy") : "—"}
                        </TableCell>
                        <TableCell className="align-top text-sm">
                          {isDone ? (
                            <div>
                              <div className="flex items-center gap-1 text-green-700 font-medium">
                                <CircleCheck className="h-3.5 w-3.5" />
                                {c.completedAt ? format(new Date(c.completedAt), "MMM d, yyyy") : "Done"}
                              </div>
                              {c.completedByName && (
                                <div className="text-xs text-muted-foreground">by {c.completedByName}</div>
                              )}
                              {(c as { performedOn?: string | null }).performedOn && (
                                <div className="text-xs text-muted-foreground">
                                  performed {format(new Date(`${(c as { performedOn?: string | null }).performedOn}T12:00:00`), "MMM d, yyyy")}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">Pending</span>
                          )}
                        </TableCell>
                        <TableCell className="align-top text-right">
                          {!isDone && !isClosed && !locked && (
                            ownsCorrection(c as { taskOwnerUserId?: number | null; taskOwnerName?: string | null }) ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => openCompleteDialog(c as { id: number; description: string })}
                                disabled={completingId === c.id}
                                data-testid={`button-complete-correction-${c.id}`}
                              >
                                {completingId === c.id ? "…" : "Complete"}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void reassignToMe(c.id)}
                                disabled={reassigningId === c.id}
                                title="You're not the owner. Take ownership (recorded in the audit trail) to complete it."
                                data-testid={`button-reassign-correction-${c.id}`}
                              >
                                {reassigningId === c.id ? "…" : "Reassign to me"}
                              </Button>
                            )
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Session 101 (#9) — completion detail dialog (what was done + when). */}
      <Dialog open={!!completeTarget} onOpenChange={(o) => { if (!o) setCompleteTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Complete correction</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            {completeTarget && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <p className="font-medium text-foreground leading-snug whitespace-pre-wrap">{completeTarget.description}</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>What was done <span className="text-destructive">*</span></Label>
              <Textarea
                rows={4}
                value={completeNotes}
                onChange={(e) => setCompleteNotes(e.target.value)}
                placeholder="Describe the correction actually performed (containment, rework, segregation, etc.)."
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
              <p className="text-[10px] text-muted-foreground">When the correction actually occurred (may differ from today).</p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCompleteTarget(null)}>Cancel</Button>
            <Button
              type="button"
              onClick={() => void completeCorrection()}
              disabled={(completingId !== null) || !completeNotes.trim() || !completePerformedOn}
            >
              {completingId !== null ? "Saving…" : "Mark complete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Management Acknowledgement — required to close Major/Critical NCs */}
      <Card className={requiresAck && !hasAck && !isClosed ? "border-orange-300 bg-orange-50/40" : ""}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldAlert className={`h-4 w-4 ${requiresAck && !hasAck ? "text-orange-600" : "text-muted-foreground"}`} />
            Management Acknowledgement
            {requiresAck && (
              <Badge variant={hasAck ? "default" : "destructive"} className="ml-2">
                {hasAck ? "Acknowledged" : "Required to Close"}
              </Badge>
            )}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {requiresAck
              ? "Major / Critical NCs require management to acknowledge the event before close. Pairs with at least one linked CAPA."
              : "Optional for this severity. Use to record management awareness."}
          </p>
        </CardHeader>
        <CardContent className="pt-2 space-y-3">
          {hasAck ? (
            <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm">
              <div className="flex items-center gap-2 font-medium text-green-900">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                Acknowledged by {nc.mgmtAcknowledgedName ?? "—"} ({nc.mgmtAcknowledgedInitials ?? "—"})
              </div>
              <p className="text-xs text-green-800 mt-1">
                {nc.mgmtAcknowledgedAt ? format(new Date(nc.mgmtAcknowledgedAt), "MMM d, yyyy h:mm a") : ""}
              </p>
              {nc.mgmtAcknowledgedNotes && (
                <p className="text-sm text-green-900 mt-2 whitespace-pre-wrap italic">
                  "{nc.mgmtAcknowledgedNotes}"
                </p>
              )}
            </div>
          ) : (isClosed || locked) ? (
            <p className="text-sm text-muted-foreground italic">
              {locked
                ? "NC cancelled — management acknowledgement is unavailable. Re-open it first (Admin)."
                : "NC closed without management acknowledgement on file."}
            </p>
          ) : (
            <div className="space-y-2">
              <Label className="text-xs">Notes (optional)</Label>
              <Textarea
                rows={2}
                value={ackNotes}
                onChange={(e) => setAckNotes(e.target.value)}
                placeholder="Briefly note management's review, decisions, or escalations…"
                className="text-sm"
              />
              <Button
                size="sm"
                variant={requiresAck ? "default" : "outline"}
                onClick={() => setAckOpen(true)}
                data-testid="button-mgmt-acknowledge"
              >
                <ShieldAlert className="h-4 w-4 mr-1" />Acknowledge with Signature
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Part11SignatureDialog
        open={ackOpen}
        onOpenChange={setAckOpen}
        title="Management Acknowledgement"
        description="By signing, you acknowledge this non-conformance has been reviewed by management."
        onSign={handleAcknowledge}
        isPending={acking}
      />
    </div>
  );
}
