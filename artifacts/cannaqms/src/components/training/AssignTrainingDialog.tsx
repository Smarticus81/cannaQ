import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { DepartmentPicker } from "@/components/DepartmentPicker";
import { RolePicker } from "@/components/training/RolePicker";
import { TrainingTypePicker } from "@/components/training/TrainingTypePicker";
import { SUPERVISION_TYPE } from "@/lib/trainingTypes";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { GraduationCap, Users, ChevronsUpDown } from "lucide-react";

// Assign one or more approved documents as read-and-acknowledge training. Target
// either a set of specific people (onboarding a new hire) or by role(s)/department(s)
// (a procedure update for a whole team). Every selected document is assigned to
// every targeted person. Uses raw fetch against /training/assign-preview and
// /training/assign-document (endpoints added 2026-07-21, extended 2026-07-29 to
// accept documentIds[] + userIds/roles) which aren't in the typed client.

type DocOption = { id: number; docNumber: string; title: string; revision: string; status: string };
type UserOption = { id: number; fullName: string; role: string; active: boolean; departments: string[] };
type PreviewUser = { id: number; fullName: string; role: string; departments: string[] };

export function AssignTrainingDialog({ onAssigned }: { onAssigned?: () => void }) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<DocOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [documentIds, setDocumentIds] = useState<number[]>([]);
  const [mode, setMode] = useState<"person" | "group">("group");
  const [userIds, setUserIds] = useState<number[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [trainingTypes, setTrainingTypes] = useState<string[]>(["Read and Understand"]);
  const [supervisedTaskQty, setSupervisedTaskQty] = useState<string>("");
  const [dueDate, setDueDate] = useState("");
  const [preview, setPreview] = useState<{ count: number; users: PreviewUser[] } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();

  const groupHasTarget = roles.length > 0 || departments.length > 0;
  const hasTarget = mode === "person" ? userIds.length > 0 : groupHasTarget;
  const docPicked = documentIds.length > 0;
  const showQty = trainingTypes.includes(SUPERVISION_TYPE);

  // Load approved documents + active users when the dialog opens.
  useEffect(() => {
    if (!open) return;
    fetch("/api/documents", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: DocOption[]) => setDocs((rows ?? []).filter((d) => d.status === "Approved" || d.status === "Effective")))
      .catch(() => setDocs([]));
    fetch("/api/users", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: UserOption[]) => setUsers((rows ?? []).filter((u) => u.active)))
      .catch(() => setUsers([]));
  }, [open]);

  // Live recipient preview for GROUP mode. Person mode is exact (the picked users).
  useEffect(() => {
    if (!open || mode !== "group" || !groupHasTarget) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    fetch("/api/training/assign-preview", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roles: roles.length ? roles : undefined,
        departments: departments.length ? departments : undefined,
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, roles, departments, groupHasTarget]);

  const reset = () => {
    setDocumentIds([]);
    setMode("group");
    setUserIds([]);
    setRoles([]);
    setDepartments([]);
    setTrainingTypes(["Read and Understand"]);
    setSupervisedTaskQty("");
    setDueDate("");
    setPreview(null);
  };

  // How many people (and their names) will be targeted, for the summary line.
  const targetCount = mode === "person" ? userIds.length : preview?.count ?? 0;
  const targetNames =
    mode === "person"
      ? users.filter((u) => userIds.includes(u.id)).map((u) => u.fullName)
      : preview?.users.map((u) => u.fullName) ?? [];

  const submit = async () => {
    if (!docPicked) {
      toast({ title: "Pick at least one document", variant: "destructive" });
      return;
    }
    if (!hasTarget) {
      toast({
        title: mode === "person" ? "Pick at least one person" : "Choose role(s) and/or departments",
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch("/api/training/assign-document", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentIds,
          userIds: mode === "person" ? userIds : undefined,
          roles: mode === "group" && roles.length ? roles : undefined,
          departments: mode === "group" && departments.length ? departments : undefined,
          trainingType: trainingTypes.length ? trainingTypes.join(", ") : undefined,
          supervisedTaskQty: showQty && supervisedTaskQty !== "" ? Number(supervisedTaskQty) : undefined,
          dueDate: dueDate || undefined,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast({ title: "Assign failed", description: data?.error ?? "Please try again.", variant: "destructive" });
        return;
      }
      toast({
        title: "Training assigned",
        description: `${data.assigned ?? 0} assigned across ${data.documents ?? documentIds.length} document(s)${
          data.updated ? `, ${data.updated} existing due date${data.updated === 1 ? "" : "s"} updated` : ""
        }${data.skipped ? `, ${data.skipped} already had it` : ""}.`,
      });
      qc.invalidateQueries();
      onAssigned?.();
      setOpen(false);
      reset();
    } finally {
      setSubmitting(false);
    }
  };

  const toggleDoc = (id: number) =>
    setDocumentIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleUser = (id: number) =>
    setUserIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const docLabel =
    documentIds.length === 0
      ? docs.length
        ? "Select approved documents"
        : "No approved documents"
      : documentIds.length === 1
        ? docs.find((d) => d.id === documentIds[0])?.docNumber ?? "1 document"
        : `${documentIds.length} documents`;
  const personLabel =
    userIds.length === 0
      ? users.length
        ? "Select people"
        : "No active users"
      : userIds.length === 1
        ? users.find((u) => u.id === userIds[0])?.fullName ?? "1 person"
        : `${userIds.length} people`;

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Users className="h-4 w-4 mr-1.5" />
          Assign Training
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Assign Document Training</DialogTitle>
          <DialogDescription>
            Assign one or more approved documents as read-and-acknowledge training to specific people or to
            role(s)/departments.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {/* Documents (multi-select) */}
          <div className="space-y-1.5">
            <Label>Documents *</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" className="w-full justify-between font-normal">
                  <span className={documentIds.length === 0 ? "text-muted-foreground" : ""}>{docLabel}</span>
                  <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1 max-h-64 overflow-y-auto" align="start">
                {docs.length === 0 ? (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">No approved documents.</p>
                ) : (
                  docs.map((d) => (
                    <label
                      key={d.id}
                      className="flex items-start gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer hover:bg-muted"
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={documentIds.includes(d.id)}
                        onCheckedChange={() => toggleDoc(d.id)}
                      />
                      <span>
                        {d.docNumber} — {d.title}{" "}
                        <span className="text-xs text-muted-foreground">(Rev {d.revision})</span>
                      </span>
                    </label>
                  ))
                )}
              </PopoverContent>
            </Popover>
          </div>

          {/* Target-mode toggle */}
          <div className="space-y-1.5">
            <Label>Assign to</Label>
            <div className="inline-flex rounded-md border p-0.5 text-sm">
              <button
                type="button"
                onClick={() => setMode("person")}
                className={`px-3 py-1 rounded transition-colors ${
                  mode === "person" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                Specific people
              </button>
              <button
                type="button"
                onClick={() => setMode("group")}
                className={`px-3 py-1 rounded transition-colors ${
                  mode === "group" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                Roles / departments
              </button>
            </div>
          </div>

          {mode === "person" ? (
            <div className="space-y-1.5">
              <Label>People *</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" className="w-full justify-between font-normal">
                    <span className={userIds.length === 0 ? "text-muted-foreground" : ""}>{personLabel}</span>
                    <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1 max-h-64 overflow-y-auto" align="start">
                  {users.length === 0 ? (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">No active users.</p>
                  ) : (
                    users.map((u) => (
                      <label
                        key={u.id}
                        className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer hover:bg-muted"
                      >
                        <Checkbox checked={userIds.includes(u.id)} onCheckedChange={() => toggleUser(u.id)} />
                        <span>{u.fullName}</span>
                        <span className="text-xs text-muted-foreground">{u.role}</span>
                      </label>
                    ))
                  )}
                </PopoverContent>
              </Popover>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Role(s)</Label>
                <RolePicker value={roles} onChange={setRoles} />
              </div>
              <div className="space-y-1.5">
                <Label>Departments</Label>
                <DepartmentPicker value={departments} onChange={setDepartments} />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Training type(s)</Label>
            <TrainingTypePicker value={trainingTypes} onChange={setTrainingTypes} />
            <p className="text-xs text-muted-foreground">
              Pick one or more delivery methods that apply to this training.
            </p>
          </div>
          {showQty && (
            <div className="space-y-1.5">
              <Label>Tasks observed (quantity)</Label>
              <Input
                type="number"
                min={0}
                value={supervisedTaskQty}
                onChange={(e) => setSupervisedTaskQty(e.target.value)}
                placeholder="e.g. 3"
              />
              <p className="text-xs text-muted-foreground">
                Number of tasks the supervisor observes under Direct / Indirect Supervision. Optional — set per your facility's requirement.
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Due date</Label>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            {/* Left blank this is no longer open-ended — the server gives it the same
                window it gives itself at approval. Said here so the field reads as a
                choice rather than a requirement. */}
            <p className="text-[11px] text-muted-foreground">
              Leave blank for the standard 10 working days from today.
            </p>
          </div>

          {/* Summary */}
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
            {!docPicked || !hasTarget ? (
              <span className="text-muted-foreground">
                Pick document(s) and {mode === "person" ? "people" : "role(s)/departments"} to see what will be assigned.
              </span>
            ) : mode === "group" && !preview ? (
              <span className="text-muted-foreground">Checking…</span>
            ) : (
              <div>
                <span className="font-medium">{documentIds.length}</span>{" "}
                {documentIds.length === 1 ? "document" : "documents"} →{" "}
                <span className="font-medium">{targetCount}</span> {targetCount === 1 ? "person" : "people"}
                {targetCount > 0 && (
                  <span className="text-muted-foreground">
                    {" — "}
                    {targetNames.slice(0, 6).join(", ")}
                    {targetCount > 6 ? "…" : ""}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={submitting || !docPicked || !hasTarget || (mode === "group" && (preview?.count ?? 0) === 0)}
          >
            <GraduationCap className="h-4 w-4 mr-1.5" />
            {submitting ? "Assigning…" : "Assign training"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
