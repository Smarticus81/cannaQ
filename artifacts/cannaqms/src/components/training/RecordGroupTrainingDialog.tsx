import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DepartmentPicker } from "@/components/DepartmentPicker";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck } from "lucide-react";
import { TrainingTypePicker } from "@/components/training/TrainingTypePicker";
import { SUPERVISION_TYPE } from "@/lib/trainingTypes";

// Record a COMPLETED instructor-led training for a GROUP in one entry. Resolves
// attendees like assignment (role and/or departments), previews them, lets you
// untick anyone who was not there, then writes a Completed record per attendee.
const ROLES = ["Operator", "Supervisor", "Manager", "Quality", "Admin"] as const;
const ANY = "__any";

type PreviewUser = { id: number; fullName: string; role: string; departments: string[] };

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function RecordGroupTrainingDialog({ onRecorded }: { onRecorded?: () => void }) {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [trainingTypes, setTrainingTypes] = useState<string[]>(["Instructor-Led"]);
  const [supervisedTaskQty, setSupervisedTaskQty] = useState<string>("");
  const [trainerName, setTrainerName] = useState("");
  const [completedDate, setCompletedDate] = useState(todayIso());
  const [notes, setNotes] = useState("");
  const [role, setRole] = useState("");
  const [departments, setDepartments] = useState<string[]>([]);
  const [preview, setPreview] = useState<PreviewUser[]>([]);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();

  const hasTarget = role !== "" || departments.length > 0;

  useEffect(() => {
    if (!open || !hasTarget) { setPreview([]); setExcluded(new Set()); return; }
    let cancelled = false;
    fetch("/api/training/assign-preview", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: role || undefined, departments: departments.length ? departments : undefined }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled) { setPreview(data?.users ?? []); setExcluded(new Set()); } })
      .catch(() => { if (!cancelled) setPreview([]); });
    return () => { cancelled = true; };
  }, [open, role, departments, hasTarget]);

  const attendees = preview.filter((u) => !excluded.has(u.id));
  const showQty = trainingTypes.includes(SUPERVISION_TYPE);

  const reset = () => {
    setTopic(""); setTrainingTypes(["Instructor-Led"]); setSupervisedTaskQty(""); setTrainerName("");
    setCompletedDate(todayIso()); setNotes(""); setRole(""); setDepartments([]);
    setPreview([]); setExcluded(new Set());
  };

  const toggle = (id: number) => setExcluded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submit = async () => {
    if (!topic.trim()) { toast({ title: "Enter a training topic", variant: "destructive" }); return; }
    if (!completedDate) { toast({ title: "Pick the date completed", variant: "destructive" }); return; }
    if (trainingTypes.length === 0) { toast({ title: "Pick at least one training type", variant: "destructive" }); return; }
    if (attendees.length === 0) { toast({ title: "No attendees selected", variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      const r = await fetch("/api/training/record-group", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          trainingType: trainingTypes.join(", "),
          supervisedTaskQty: showQty && supervisedTaskQty !== "" ? Number(supervisedTaskQty) : undefined,
          trainerName: trainerName.trim() || undefined,
          completedDate,
          notes: notes.trim() || undefined,
          userIds: attendees.map((u) => u.id),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { toast({ title: "Could not record training", description: data?.error ?? "Please try again.", variant: "destructive" }); return; }
      toast({ title: "Group training recorded", description: `${data.created ?? 0} record(s) created${data.skipped ? `, ${data.skipped} already on file` : ""}.` });
      qc.invalidateQueries();
      onRecorded?.();
      setOpen(false); reset();
    } finally { setSubmitting(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ClipboardCheck className="h-4 w-4 mr-1.5" />
          Record Group Training
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record Group Training</DialogTitle>
          <DialogDescription>
            Log a completed instructor-led training for a whole group at once - one record per attendee.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Training topic *</Label>
            <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. CAPA Training" />
          </div>
          <div className="space-y-1.5">
            <Label>Training type(s)</Label>
            <TrainingTypePicker value={trainingTypes} onChange={setTrainingTypes} />
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
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Date completed *</Label>
            <Input type="date" value={completedDate} onChange={(e) => setCompletedDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Trainer / instructor</Label>
            <Input value={trainerName} onChange={(e) => setTrainerName(e.target.value)} placeholder="Who delivered the training" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={role || ANY} onValueChange={(v) => setRole(v === ANY ? "" : v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any role</SelectItem>
                  {ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Departments</Label>
              <DepartmentPicker value={departments} onChange={setDepartments} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Attendees {attendees.length > 0 ? `(${attendees.length})` : ""}</Label>
            {!hasTarget ? (
              <p className="text-xs text-muted-foreground">Pick a role and/or departments to list attendees. Untick anyone who was not there.</p>
            ) : preview.length === 0 ? (
              <p className="text-xs text-muted-foreground">No matching people.</p>
            ) : (
              <div className="max-h-48 overflow-y-auto rounded-md border divide-y">
                {preview.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer">
                    <Checkbox checked={!excluded.has(u.id)} onCheckedChange={() => toggle(u.id)} />
                    <span>{u.fullName}</span>
                    <span className="text-xs text-muted-foreground">{u.role}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional - anything to note about this session" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || attendees.length === 0 || !topic.trim()}>
            {submitting ? "Recording..." : `Record for ${attendees.length || 0}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
