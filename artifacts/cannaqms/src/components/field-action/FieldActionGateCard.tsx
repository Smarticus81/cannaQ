import { useState } from "react";
import { format } from "date-fns";
import { CheckCircle2, Lock, ShieldCheck, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { useToast } from "@/hooks/use-toast";

// Session 63.4 — a gate review on a Field Action.
//
// Placed BELOW the section it approves, never above it. A gate rendered above
// its section reads as "you are at this review now" — the exact misread that had
// to be corrected twice on CAPA (Gates 0/1, then Gate 2). Below the section, it
// reads as "you have finished this; sign it off", which is what it means.
//
// Three visual states, and each one has to be unambiguous on its own:
//   signed      — who signed, with what meaning, when
//   open        — this gate is the current control point; sign or reject it
//   not yet     — the record has not reached this gate (or has passed it)
export function FieldActionGateCard({
  fieldActionId,
  gate,
  title,
  whatItApproves,
  requiresStatus,
  currentStatus,
  sectionFilled,
  sectionLabel,
  approvedAt,
  approverName,
  approverInitials,
  approverMeaning,
  canSign,
  rejection,
  onDone,
}: {
  fieldActionId: number;
  gate: 0 | 1 | 2;
  title: string;
  whatItApproves: string;
  requiresStatus: string;
  currentStatus: string;
  sectionFilled: boolean;
  sectionLabel: string;
  approvedAt?: string | null;
  approverName?: string | null;
  approverInitials?: string | null;
  approverMeaning?: string | null;
  canSign: boolean;
  rejection?: {
    stage?: string | null;
    comment?: string | null;
    byName?: string | null;
    at?: string | null;
  } | null;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [signOpen, setSignOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const isSigned = !!approvedAt;
  const isOpenNow = !isSigned && currentStatus === requiresStatus;
  // A rejection only counts while it is still unresolved — once the gate is
  // signed the banner would be reporting history the audit trail already holds.
  const activeRejection =
    !isSigned && rejection?.stage === title && rejection.comment ? rejection : null;

  async function sign(initials: string, meaning: string) {
    const res = await fetch(`/api/field-actions/${fieldActionId}/gate${gate}-approve`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initials, signatureMeaning: meaning }),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(j.error ?? `${title} could not be signed (HTTP ${res.status}).`);
    setSignOpen(false);
    toast({ title: `${title} signed`, description: whatItApproves });
    onDone();
  }

  async function reject() {
    if (!comment.trim()) {
      toast({ title: "A reason is required", description: "It is what tells the owner what to fix.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/field-actions/${fieldActionId}/gate${gate}-reject`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `${title} could not be rejected (HTTP ${res.status}).`);
      setRejectOpen(false);
      setComment("");
      toast({ title: `${title} rejected`, description: "The reason is recorded and the record stays where it is." });
      onDone();
    } catch (e) {
      toast({ title: "Rejection failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  if (isSigned) {
    return (
      <Card className="border-green-200 bg-green-50/40">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2 text-green-900">
            <CheckCircle2 className="h-4 w-4" />
            {title} — signed
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-green-900 space-y-1">
          <p>
            <strong>{approverName ?? "—"}</strong>
            {approverInitials ? ` (${approverInitials})` : ""}
            {approvedAt ? ` · ${format(new Date(approvedAt), "MMM d, yyyy HH:mm")}` : ""}
          </p>
          {approverMeaning && (
            <p className="text-xs italic">“{approverMeaning}”</p>
          )}
        </CardContent>
      </Card>
    );
  }

  if (!isOpenNow) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          <span>
            {title} — opens when this field action is at “{requiresStatus}”. {whatItApproves}
          </span>
        </CardContent>
      </Card>
    );
  }

  const blocked = !sectionFilled;

  return (
    <>
      <Card className="border-primary/40 ring-1 ring-primary/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">{whatItApproves}</p>

          {activeRejection && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs">
              <p className="font-medium text-destructive flex items-center gap-1.5">
                <XCircle className="h-3.5 w-3.5" />
                Rejected by {activeRejection.byName ?? "a reviewer"}
                {activeRejection.at ? ` on ${format(new Date(activeRejection.at), "MMM d, yyyy")}` : ""}
              </p>
              <p className="mt-1 whitespace-pre-wrap">{activeRejection.comment}</p>
            </div>
          )}

          {blocked && (
            <p className="text-xs text-destructive">
              {sectionLabel} is empty. Record it above before signing.
            </p>
          )}
          {!canSign && (
            <p className="text-xs text-muted-foreground">
              Gate reviews are signed by Manager, Quality or Admin.
            </p>
          )}

          <div className="flex gap-2">
            <Button size="sm" disabled={blocked || !canSign} onClick={() => setSignOpen(true)}>
              Sign {title}
            </Button>
            <Button size="sm" variant="outline" disabled={!canSign} onClick={() => setRejectOpen(true)}>
              Reject
            </Button>
          </div>
        </CardContent>
      </Card>

      <Part11SignatureDialog
        open={signOpen}
        onOpenChange={setSignOpen}
        title={`Sign ${title}`}
        description={`${whatItApproves} Signing records your name, initials and meaning against this field action and moves it forward (21 CFR Part 11).`}
        onSign={sign}
        isPending={busy}
      />

      <Dialog open={rejectOpen} onOpenChange={(v) => { setRejectOpen(v); if (!v) setComment(""); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {title}</DialogTitle>
            <DialogDescription>
              The field action stays exactly where it is so the section can be corrected and
              re-submitted. Your reason is recorded on the record and in the audit trail.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={4}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What has to change before this can be signed?"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="destructive" onClick={() => void reject()} disabled={busy || !comment.trim()}>
              {busy ? "Working…" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
