import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

// CHANGE REQUESTS on a controlled document — multi-facility Phase 3 (2026-08-28).
//
// "This document is wrong, and here is why." Anyone at any site can raise one.
//
// ⛔ RAISING ONE DOES NOTHING TO THE DOCUMENT. His ruling 08-27: "The current
// document remains and the change request remains until an approver approves the
// request. Then it can go to draft for revision." No draft appears, the status does
// not move, nobody is assigned anything — a document in force is never left sitting
// in Draft because somebody asked a question about it.
//
// Quality approves or declines WITH A REASON, and a decline is kept: "We cannot
// really get rid of records."

type ChangeRequest = {
  id: number;
  documentId: number;
  revisionAtRequest: string | null;
  whatIsWrong: string;
  whyItMatters: string | null;
  status: string;
  raisedByName: string | null;
  raisedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  resolvedAt: string | null;
  resolvedByRevision: string | null;
};

const LIVE = new Set(["Open", "Approved"]);

export function ChangeRequestPanel({
  documentId,
  documentStatus,
  userRole,
  onChanged,
}: {
  documentId: number;
  documentStatus: string | undefined;
  userRole: string | undefined;
  onChanged?: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [whatIsWrong, setWhatIsWrong] = useState("");
  const [whyItMatters, setWhyItMatters] = useState("");
  const [reason, setReason] = useState("");
  const [showForm, setShowForm] = useState(false);

  const key = ["document", documentId, "change-requests"] as const;
  const { data: requests = [] } = useQuery<ChangeRequest[]>({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/documents/${documentId}/change-requests`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load change requests");
      return r.json();
    },
  });

  const live = requests.find((r) => LIVE.has(r.status)) ?? null;
  const history = requests.filter((r) => r !== live);
  const canDecide = userRole === "Quality" || userRole === "Admin";
  // Only against a document that is in force. A draft is already being edited and a
  // document under review is mid-decision.
  const canRaise = documentStatus === "Approved" || documentStatus === "Effective";

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: key });
    onChanged?.();
  };

  const raise = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/documents/${documentId}/change-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ whatIsWrong, whyItMatters }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || "Failed to raise the request");
      return r.json();
    },
    onSuccess: () => {
      setWhatIsWrong("");
      setWhyItMatters("");
      setShowForm(false);
      refresh();
      toast({ title: "Change request raised", description: "Quality will review it. The document is unchanged." });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const decide = useMutation({
    mutationFn: async (decision: "approve" | "decline") => {
      const r = await fetch(`/api/change-requests/${live!.id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ decision, reason }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || "Failed to record the decision");
      return r.json();
    },
    onSuccess: (_data, decision) => {
      setReason("");
      refresh();
      toast({
        title: decision === "approve" ? "Change request approved" : "Change request declined",
        description:
          decision === "approve"
            ? "The document can now be revised. It stays in force until the new revision takes effect."
            : "Recorded. The document is unchanged.",
      });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change Requests</CardTitle>
        <CardDescription>
          Report that this document is wrong. Raising a request does not change the document — it stays
          in force exactly as it is until Quality approves the request and a new revision takes effect.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {live ? (
          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">
                {live.status === "Open" ? "Change Requested" : "Change Request Approved"}
              </span>
              <span className="text-xs text-muted-foreground">
                Raised by {live.raisedByName ?? "someone"} on {format(new Date(live.raisedAt), "MMM d, yyyy")}
                {live.revisionAtRequest ? ` · against rev ${live.revisionAtRequest}` : ""}
              </span>
            </div>
            <p className="text-sm whitespace-pre-wrap">{live.whatIsWrong}</p>
            {live.whyItMatters ? (
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{live.whyItMatters}</p>
            ) : null}

            {live.status === "Approved" ? (
              <p className="text-xs text-muted-foreground">
                Approved by {live.decidedByName ?? "Quality"}
                {live.decidedAt ? ` on ${format(new Date(live.decidedAt), "MMM d, yyyy")}` : ""}
                {live.decisionReason ? ` — ${live.decisionReason}` : ""}. Start a revision when you are ready;
                this document stays in force until that revision takes effect.
              </p>
            ) : canDecide ? (
              <div className="space-y-2 pt-1">
                <Label htmlFor="cr-reason">Reason for the decision *</Label>
                <Textarea
                  id="cr-reason"
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why this is being approved, or why it is not"
                />
                <div className="flex gap-2">
                  <Button size="sm" disabled={decide.isPending || !reason.trim()} onClick={() => decide.mutate("approve")}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={decide.isPending || !reason.trim()}
                    onClick={() => decide.mutate("decline")}
                  >
                    Decline
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Waiting on Quality to approve or decline.</p>
            )}
          </div>
        ) : canRaise ? (
          showForm ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="cr-what">What is wrong? *</Label>
                <Textarea
                  id="cr-what"
                  rows={3}
                  value={whatIsWrong}
                  onChange={(e) => setWhatIsWrong(e.target.value)}
                  placeholder="Step 6 says 60 seconds; the equipment cannot run below 90."
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cr-why">Why it matters</Label>
                <Textarea
                  id="cr-why"
                  rows={2}
                  value={whyItMatters}
                  onChange={(e) => setWhyItMatters(e.target.value)}
                  placeholder="Operators are signing a step they cannot actually follow."
                />
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={raise.isPending || !whatIsWrong.trim()} onClick={() => raise.mutate()}>
                  {raise.isPending ? "Sending…" : "Send to Quality"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
              Request a change
            </Button>
          )
        ) : (
          <p className="text-sm text-muted-foreground">
            A change request can only be raised against a document that is in force. This one is{" "}
            {documentStatus ?? "not in force"} — it is already being worked on.
          </p>
        )}

        {history.length > 0 ? (
          <div className="space-y-2 pt-1">
            <p className="text-xs font-medium text-muted-foreground">Earlier requests</p>
            {history.map((r) => (
              <div key={r.id} className="rounded-md border p-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium">{r.status}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {r.raisedByName ?? "someone"} · {format(new Date(r.raisedAt), "MMM d, yyyy")}
                    {r.resolvedByRevision ? ` · answered by rev ${r.resolvedByRevision}` : ""}
                  </span>
                </div>
                <p className="text-sm mt-1 whitespace-pre-wrap">{r.whatIsWrong}</p>
                {r.decisionReason ? (
                  <p className="text-xs text-muted-foreground mt-1">
                    {r.status} by {r.decidedByName ?? "Quality"} — {r.decisionReason}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
