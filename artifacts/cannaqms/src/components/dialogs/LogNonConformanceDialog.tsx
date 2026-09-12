import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle } from "lucide-react";
import { useCreateNonConformance, getListNonConformancesQueryKey, useGetCurrentUser, useListUsers } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { NcSeverityGuide } from "@/components/nc/NcSeverityGuide";

// Session 47 — In-batch nonconformance capture.
//
// "Nonconformance" (NC) is the canonical CannaQ term — there is no separate
// "Deviation" concept (see memory: project-nc-canonical-term). Per ISO 13485
// §8.3 (Control of nonconforming product) and FDA GMP, every off-spec event
// during production must be recorded with: identification, description,
// evaluation, disposition. The existing non_conformances table covers all
// of this. This dialog gives operators a mid-batch capture path so they
// don't have to navigate to a separate NC page and re-enter batch context:
// batchId / productType / productName / lotNumber are pre-filled from the
// parent batch; the operator only types title + description + severity;
// the new NC appears immediately in the batch's Related NCs list.

const SEVERITIES = ["Minor", "Major", "Critical"] as const;

export type LogNonConformanceDialogBatch = {
  id: number;
  productType?: string | null;
  productName?: string | null;
  batchNumber?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batch: LogNonConformanceDialogBatch | null | undefined;
};

export function LogNonConformanceDialog({ open, onOpenChange, batch }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createNc = useCreateNonConformance();
  // Session 48 — auto-fill reportedByName from the signed-in user so the
  // NC carries a real owner without operators having to type their own name.
  const { data: currentUser } = useGetCurrentUser();
  // Session 54 — Reported By is a strict user picker (decision B). Defaults to
  // the signed-in user; a supervisor can pick another user when logging on
  // their behalf. Saves reportedByUserId + the matching name.
  const { data: usersData = [] } = useListUsers();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<typeof SEVERITIES[number]>("Minor");
  const [severityRationale, setSeverityRationale] = useState("");
  const [department, setDepartment] = useState("");
  // Session 48 — Date NC Identified. Defaults to today on dialog open;
  // operator can backdate if the issue was spotted earlier and logged later.
  const [identifiedAt, setIdentifiedAt] = useState("");
  // Session 48.5 — Reported By is editable. Auto-fills from currentUser
  // but the QMS owner can record an NC on behalf of another employee.
  const [reportedByName, setReportedByName] = useState("");
  const [reportedByUserId, setReportedByUserId] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset operator-typed fields every time the dialog opens so a previous
  // NC's text doesn't bleed into the next one. Batch context is pre-filled
  // via props rather than state, so it doesn't need resetting here.
  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setSeverity("Minor");
      setSeverityRationale("");
      setDepartment("");
      // YYYY-MM-DD for HTML date input.
      setIdentifiedAt(new Date().toISOString().slice(0, 10));
      setReportedByName(currentUser?.fullName ?? "");
      setReportedByUserId(currentUser?.id != null ? String(currentUser.id) : "");
      setError(null);
    }
  }, [open, currentUser?.fullName, currentUser?.id]);

  const handleSubmit = async () => {
    setError(null);
    if (!title.trim()) { setError("Title is required."); return; }
    if (!description.trim()) { setError("Description is required."); return; }
    if (!batch) { setError("Batch context unavailable."); return; }

    try {
      // lotNumber maps to batchNumber because the batch number IS the
      // internal lot identifier in CannaQ.
      await createNc.mutateAsync({
        data: {
          title: title.trim(),
          description: description.trim(),
          severity,
          severityRationale: severityRationale.trim() || undefined,
          source: "Production",
          status: "Open",
          batchId: batch.id,
          productType: batch.productType ?? undefined,
          productName: batch.productName ?? undefined,
          lotNumber: batch.batchNumber ?? undefined,
          department: department.trim() || undefined,
          identifiedAt: identifiedAt || undefined,
          reportedByName: reportedByName.trim() || undefined,
          reportedByUserId: reportedByUserId ? Number(reportedByUserId) : undefined,
        } as never,
      });
      queryClient.invalidateQueries({ queryKey: getListNonConformancesQueryKey() });
      toast({
        title: "Nonconformance Logged",
        description: `Recorded against batch ${batch.batchNumber ?? `#${batch.id}`}. View on Compliance Trail.`,
      });
      onOpenChange(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to log nonconformance.";
      setError(msg);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Log Nonconformance
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {error && <p className="text-sm text-destructive">{error}</p>}

          {/* Batch context preview — read-only so the operator can confirm
              the NC is being filed against the correct batch before they
              save. Pre-filled from the parent batch. */}
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs space-y-0.5">
            <p className="font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">Batch Context (auto-filled)</p>
            <p><span className="text-muted-foreground">Batch:</span> <span className="font-mono">{batch?.batchNumber ?? "—"}</span></p>
            <p><span className="text-muted-foreground">Product:</span> {batch?.productName ?? "—"} <span className="text-muted-foreground">·</span> {batch?.productType ?? "—"}</p>
            <p><span className="text-muted-foreground">Source:</span> Production</p>
          </div>

          <div>
            <Label className="text-xs">Title <span className="text-destructive">*</span></Label>
            <Input
              className="mt-1"
              placeholder="e.g. Mixing temperature exceeded SOP limit"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
            />
          </div>

          <div>
            <Label className="text-xs">Description <span className="text-destructive">*</span></Label>
            <Textarea
              className="mt-1 text-sm"
              rows={4}
              placeholder="What happened? Include the specification, the observed value, and any immediate action taken."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground mt-0.5">Root cause and disposition are recorded later on the NC detail page (Part 11 approval required to close).</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Severity <span className="text-destructive">*</span></Label>
              <Select value={severity} onValueChange={(v) => setSeverity(v as typeof SEVERITIES[number])}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground mt-0.5">Major/Critical require management acknowledgement before closure.</p>
            </div>
            {/* Session 48 — Date NC Identified. Different from the system
                createdAt — operator may have spotted the issue days before
                logging it. Defaults to today; backdate is allowed. */}
            <div>
              <Label className="text-xs">Date NC Identified</Label>
              <Input
                type="date"
                className="mt-1"
                value={identifiedAt}
                onChange={(e) => setIdentifiedAt(e.target.value)}
                max={new Date().toISOString().slice(0, 10)}
              />
            </div>
          </div>

          <NcSeverityGuide />

          {/* Session 48 — Severity Rationale. Free text explaining WHY the
              chosen severity is correct. Optional at creation; can be edited
              on the detail page later. */}
          <div>
            <Label className="text-xs">Severity Rationale</Label>
            <Textarea
              className="mt-1 text-sm"
              rows={2}
              placeholder="Why is this severity correct? (e.g. customer-facing impact, regulatory citation, batch loss size)"
              value={severityRationale}
              onChange={(e) => setSeverityRationale(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Department</Label>
              <Input
                className="mt-1"
                placeholder="e.g. Production"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
              />
            </div>
            {/* Session 54 — Reported By is a strict user picker (decision B):
                an NC is always reported by an internal user. Defaults to the
                signed-in user; a supervisor can pick another user when logging
                on their behalf. */}
            <div>
              <Label className="text-xs">Reported By</Label>
              <Select
                value={reportedByUserId}
                onValueChange={(v) => {
                  setReportedByUserId(v);
                  setReportedByName(usersData.find((u) => String(u.id) === v)?.fullName ?? "");
                }}
              >
                <SelectTrigger className="mt-1" data-testid="select-log-nc-reported-by">
                  <SelectValue placeholder="Select user…" />
                </SelectTrigger>
                <SelectContent>
                  {usersData.filter((u) => u.active || String(u.id) === reportedByUserId).length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">No users.</div>
                  ) : (
                    usersData
                      .filter((u) => u.active || String(u.id) === reportedByUserId)
                      .map((u) => (
                        <SelectItem key={u.id} value={String(u.id)}>
                          {u.fullName}{u.role ? ` · ${u.role}` : ""}
                        </SelectItem>
                      ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={createNc.isPending}>
            {createNc.isPending ? "Logging…" : "Log Nonconformance"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
