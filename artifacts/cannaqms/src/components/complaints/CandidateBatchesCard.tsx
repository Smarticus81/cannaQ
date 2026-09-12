import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

// Session 74 — METRC Tag Lineage Phase 2: source-batch traceability for a
// complaint. A complaint links to zero/one/several CANDIDATE batches (tag torn
// or tossed; two lots of the same strain). The investigation resolves them:
// confirm THE source (sets the complaint's linked batch) or rule candidates out.
// A complaint can still close with nothing confirmed. All endpoints are off-spec
// raw-fetch (consistent with the other tag routes) — no generated client.

type Candidate = {
  id: number; batchId: number; status: string; matchBasis: string;
  enteredValue: string | null; note: string | null;
  recordedByName: string | null; resolvedByName: string | null; resolvedAt: string | null;
  batchNumber: string; productName: string | null; strainName: string | null;
  batchStatus: string | null; productionDate: string | null;
};
type LookupHit = {
  batchId: number; batchNumber: string; productName: string | null;
  strainName: string | null; status: string | null; productionDate: string | null;
  matchKind: string; matchedOn: string[];
};

const basisLabel: Record<string, string> = {
  tag_exact: "exact tag", tag_partial: "partial tag", product: "product match", manual: "added manually",
};
const matchLabel = (k: string) => (k === "exact" ? "exact tag" : k === "partial" ? "partial tag" : "product match");
const basisFor = (k: string) => (k === "exact" ? "tag_exact" : k === "partial" ? "tag_partial" : "product");

function statusPill(status: string) {
  const map: Record<string, string> = {
    suspected: "bg-yellow-50 text-yellow-700 border-yellow-200",
    confirmed: "bg-green-50 text-green-700 border-green-200",
    ruled_out: "bg-slate-100 text-slate-500 border-slate-300",
  };
  const label = status === "ruled_out" ? "ruled out" : status;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border capitalize ${map[status] ?? "bg-gray-100 text-gray-600"}`}>
      {label}
    </span>
  );
}

export function CandidateBatchesCard({
  complaintId, readOnly, onChanged,
}: { complaintId: number; readOnly: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<LookupHit[]>([]);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/complaints/${complaintId}/candidate-batches`);
      const data = r.ok ? await r.json() : [];
      setCandidates(Array.isArray(data) ? data : []);
    } catch {
      setCandidates([]);
    }
  }, [complaintId]);

  useEffect(() => { void load(); }, [load]);

  // Debounced lookup as the user types into the "add a candidate" search.
  useEffect(() => {
    const q = term.trim();
    if (q.length < 3) { setHits([]); setLookupLoading(false); return; }
    setLookupLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/metrc-tags/lookup?q=${encodeURIComponent(q)}`);
        const data = r.ok ? await r.json() : [];
        setHits(Array.isArray(data) ? data : []);
      } catch {
        setHits([]);
      } finally {
        setLookupLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [term]);

  const addCandidate = async (hit: LookupHit) => {
    setAdding(true);
    try {
      const r = await fetch(`/api/complaints/${complaintId}/candidate-batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: hit.batchId, matchBasis: basisFor(hit.matchKind), enteredValue: term.trim() }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to add candidate.");
      }
      setTerm(""); setHits([]);
      await load();
    } catch (e) {
      toast({ title: "Could not add candidate", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setAdding(false);
    }
  };

  const resolve = async (cand: Candidate, status: string) => {
    setBusyId(cand.id);
    try {
      const r = await fetch(`/api/complaint-candidate-batches/${cand.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to update candidate.");
      }
      await load();
      onChanged(); // confirm/un-confirm changes the complaint's linked batch
    } catch (e) {
      toast({ title: "Could not update candidate", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (cand: Candidate) => {
    setBusyId(cand.id);
    try {
      const r = await fetch(`/api/complaint-candidate-batches/${cand.id}`, { method: "DELETE" });
      if (!r.ok) {
        const b = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(b.error ?? "Failed to remove candidate.");
      }
      await load();
    } catch (e) {
      toast({ title: "Could not remove candidate", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const confirmed = candidates.find((c) => c.status === "confirmed");
  const alreadyLinked = new Set(candidates.map((c) => c.batchId));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Source Batch Traceability</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Link every plausible source batch (a torn METRC tag, batch number, or just the strain). The investigation confirms the one true source — or this can be closed with none identified if the customer info isn't enough.
        </p>

        {confirmed && (
          <div className="rounded border border-green-200 bg-green-50 px-2 py-1.5 text-xs text-green-800">
            Confirmed source: <Link href={`/batches/${confirmed.batchId}`} className="font-mono font-medium hover:underline">{confirmed.batchNumber}</Link>
            {confirmed.productName ? ` · ${confirmed.productName}` : ""}
          </div>
        )}

        {/* Candidate list */}
        {candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No candidate batches linked yet.</p>
        ) : (
          <div className="space-y-2">
            {candidates.map((c) => (
              <div key={c.id} className={`rounded border px-2 py-2 text-xs ${c.status === "ruled_out" ? "opacity-60" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={`/batches/${c.batchId}`} className="font-mono font-medium text-primary hover:underline">{c.batchNumber}</Link>
                    {c.productName ? <span className="text-muted-foreground"> · {c.productName}</span> : null}
                    {c.strainName ? <span className="text-muted-foreground"> · {c.strainName}</span> : null}
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                      {statusPill(c.status)}
                      <span>· {basisLabel[c.matchBasis] ?? c.matchBasis}</span>
                      {c.enteredValue ? <span>· matched on “{c.enteredValue}”</span> : null}
                      {c.batchStatus ? <span>· batch {c.batchStatus}</span> : null}
                    </div>
                    {c.resolvedByName && c.status !== "suspected" && (
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {c.status === "confirmed" ? "Confirmed" : "Ruled out"} by {c.resolvedByName}
                      </p>
                    )}
                  </div>
                </div>
                {!readOnly && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {c.status === "suspected" && (
                      <>
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={busyId === c.id} onClick={() => resolve(c, "confirmed")}>Confirm source</Button>
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busyId === c.id} onClick={() => resolve(c, "ruled_out")}>Rule out</Button>
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-destructive" disabled={busyId === c.id} onClick={() => remove(c)}>Remove</Button>
                      </>
                    )}
                    {c.status === "confirmed" && (
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busyId === c.id} onClick={() => resolve(c, "suspected")}>Un-confirm</Button>
                    )}
                    {c.status === "ruled_out" && (
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busyId === c.id} onClick={() => resolve(c, "suspected")}>Restore</Button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add a candidate */}
        {!readOnly && (
          <div className="border-t pt-3 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Add a candidate batch</p>
            <Input
              className="font-mono h-8 text-xs"
              placeholder="Full or partial METRC tag, batch number, or strain"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
            {lookupLoading && <p className="text-[10px] text-muted-foreground">Searching…</p>}
            {hits.filter((h) => !alreadyLinked.has(h.batchId)).length > 0 && (
              <div className="rounded border divide-y">
                {hits.filter((h) => !alreadyLinked.has(h.batchId)).map((h) => (
                  <div key={h.batchId} className="flex items-center justify-between px-2 py-1.5 text-xs">
                    <div className="min-w-0">
                      <span className="font-mono">{h.batchNumber}</span>
                      {h.productName ? <span className="text-muted-foreground"> · {h.productName}</span> : null}
                      {h.strainName ? <span className="text-muted-foreground"> · {h.strainName}</span> : null}
                      <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[9px] uppercase text-muted-foreground">{matchLabel(h.matchKind)}</span>
                    </div>
                    <button type="button" className="text-primary hover:underline shrink-0 ml-2 disabled:opacity-50" disabled={adding} onClick={() => addCandidate(h)}>Link</button>
                  </div>
                ))}
              </div>
            )}
            {!lookupLoading && term.trim().length >= 3 && hits.filter((h) => !alreadyLinked.has(h.batchId)).length === 0 && (
              <p className="text-[10px] text-muted-foreground">No (new) matching batches.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
