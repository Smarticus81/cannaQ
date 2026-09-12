import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle } from "lucide-react";

// Session 51 — reusable Cancel dialog for QMS records.
//
// QMS records are never hard-deleted (Part 11). Cancel retains the row, is
// recoverable, and requires BOTH a rationale AND a Part 11 e-signature
// (initials + meaning). The acting user must hold a Manager/Quality/Admin role,
// which is gated server-side AND by the caller (button is hidden otherwise).
//
// This dialog is intentionally generic so the Session 52 app-wide rollout can
// reuse it for NCs, Documents, CAPAs, Inspections, etc. — pass entityLabel and
// an onConfirm that calls the entity's /cancel endpoint.

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** e.g. "Destruction Record" — used in the title + copy. */
  entityLabel: string;
  /** Optional heads-up shown above the form (e.g. linked-NC context). */
  warning?: string | null;
  isPending: boolean;
  /** Throw to surface a server error inline. */
  onConfirm: (reason: string, initials: string, meaning: string) => Promise<void>;
};

export function CancelRecordDialog({ open, onOpenChange, entityLabel, warning, isPending, onConfirm }: Props) {
  const [reason, setReason] = useState("");
  const [initials, setInitials] = useState("");
  const [meaning, setMeaning] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) { setReason(""); setInitials(""); setMeaning(""); setError(""); }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!reason.trim()) { setError("A cancellation rationale is required."); return; }
    if (initials.trim().length < 2 || initials.trim().length > 4) {
      setError("Initials must be 2–4 characters."); return;
    }
    if (!meaning.trim()) { setError("Meaning of signature is required."); return; }
    try {
      await onConfirm(reason.trim(), initials.trim().toUpperCase(), meaning.trim());
      onOpenChange(false);
    } catch (err: unknown) {
      const x = err as { response?: { data?: { error?: string } }; data?: { error?: string }; message?: string };
      const serverMsg = x?.response?.data?.error ?? x?.data?.error;
      const fallback = typeof x?.message === "string" && x.message && !x.message.toLowerCase().startsWith("request failed")
        ? x.message : null;
      setError(serverMsg ?? fallback ?? "Failed to cancel. Please try again.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Cancel {entityLabel}
            </DialogTitle>
            <DialogDescription>
              Cancelling retains this record (it is never deleted) but removes it from active use. Only an Admin can re-open it later.
              <span className="mt-2 block text-xs font-semibold text-destructive">21 CFR Part 11 Electronic Signature</span>
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            {warning && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {warning}
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="cancel-reason">Reason for cancellation</Label>
              <Textarea
                id="cancel-reason"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this record being cancelled? (e.g. duplicate entry; process was actually followed correctly)"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="cancel-initials">Initials</Label>
                <Input
                  id="cancel-initials"
                  value={initials}
                  onChange={(e) => setInitials(e.target.value.toUpperCase())}
                  placeholder="e.g. JD"
                  maxLength={4}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cancel-meaning">Meaning of Signature</Label>
                <Input
                  id="cancel-meaning"
                  value={meaning}
                  onChange={(e) => setMeaning(e.target.value)}
                  placeholder="e.g. Approved cancellation"
                />
              </div>
            </div>
            {error && <div className="text-sm text-destructive">{error}</div>}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Back
            </Button>
            <Button type="submit" variant="destructive" disabled={isPending}>
              {isPending ? "Cancelling…" : "Sign & Cancel Record"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
