import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Part11SignatureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onSign: (initials: string, meaning: string) => Promise<void>;
  isPending: boolean;
  /**
   * Extra fields shown above the signature. Used for the declared effective date,
   * which has to be agreed and entered as part of the same act as signing — not on
   * a separate screen someone can skip.
   */
  children?: React.ReactNode;
}

export function Part11SignatureDialog({
  open,
  onOpenChange,
  title,
  description,
  onSign,
  isPending,
  children,
}: Part11SignatureDialogProps) {
  const [initials, setInitials] = useState("");
  const [meaning, setMeaning] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (initials.length < 2 || initials.length > 4) {
      setError("Initials must be between 2 and 4 characters.");
      return;
    }
    if (!meaning) {
      setError("Signing statement is required.");
      return;
    }

    try {
      await onSign(initials, meaning);
      onOpenChange(false);
      setInitials("");
      setMeaning("");
    } catch (err: unknown) {
      // Session 48.4 — surface the actual server error message instead of
      // swallowing it as a generic "Failed to sign". Server returns
      // specific close-gate messages (corrections pending, skip-CAPA
      // missing, mgmt ack required, etc.) that operators must see to
      // take corrective action. Extract from multiple shapes since orval
      // mutators / fetch wrappers vary in how they surface response bodies.
      const e = err as { response?: { data?: { error?: string } }; data?: { error?: string }; message?: string };
      const serverMsg = e?.response?.data?.error ?? e?.data?.error;
      const fallbackMsg = typeof e?.message === "string" && e.message && !e.message.toLowerCase().startsWith("request failed")
        ? e.message
        : null;
      setError(serverMsg ?? fallbackMsg ?? "Failed to sign. Please try again.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {description}
              <div className="mt-2 text-xs font-semibold text-destructive">
                21 CFR Part 11 Electronic Signature
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            {children}
            <div className="grid gap-2">
              <Label htmlFor="initials">Initials</Label>
              <Input
                id="initials"
                value={initials}
                onChange={(e) => setInitials(e.target.value.toUpperCase())}
                placeholder="e.g. JD"
                maxLength={4}
                data-testid="input-initials"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="meaning">Meaning of Signature</Label>
              <Input
                id="meaning"
                value={meaning}
                onChange={(e) => setMeaning(e.target.value)}
                placeholder="e.g. Approved for Release"
                data-testid="input-meaning"
              />
            </div>
            {error && <div className="text-sm text-destructive">{error}</div>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending} data-testid="button-sign">
              {isPending ? "Signing..." : "Sign & Submit"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
