import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Flame } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { CreateDestructionRecordDialog, type CreatedDestructionRecord } from "@/components/dialogs/CreateDestructionRecordDialog";

// Session 49 — Destruction Record panel on the NC detail page.
//
// Renders only when nc.disposition === "Destroy". Two modes:
//   1. Not linked — pick a recent destruction record from the dropdown OR
//      create a new one inline.
//   2. Linked — show the record summary + Unlink.
//
// destruction_records is an off-spec route (not in OpenAPI yet), so this uses
// raw fetch + a local cast for the destructionRecordId that isn't on the
// generated NonConformance type yet (see memory: label-templates-off-spec).

type DestructionRecord = {
  id: number;
  metrcTag: string;
  destroyedAt: string;
  destroyedByName: string;
  witnessName?: string | null;
  weight?: number | null;
  weightUom?: string | null;
  method?: string | null;
  notes?: string | null;
};

type Props = {
  ncId: number;
  destructionRecordId: number | null;
  isClosed: boolean;
  onChanged: () => void;
};

export function DestructionRecordPanel({ ncId, destructionRecordId, isClosed, onChanged }: Props) {
  const { toast } = useToast();

  const [linked, setLinked] = useState<DestructionRecord | null>(null);
  const [recent, setRecent] = useState<DestructionRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // Load the linked record (when set) for the summary display.
  useEffect(() => {
    let active = true;
    if (destructionRecordId) {
      fetch(`/api/destruction-records/${destructionRecordId}`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => { if (active) setLinked(data); })
        .catch(() => { if (active) setLinked(null); });
    } else {
      setLinked(null);
    }
    return () => { active = false; };
  }, [destructionRecordId]);

  // Load recent records for the link-selector dropdown (only when not linked).
  const loadRecent = useCallback(() => {
    fetch(`/api/destruction-records?recent=true`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: DestructionRecord[]) => setRecent(Array.isArray(data) ? data : []))
      .catch(() => setRecent([]));
  }, []);

  useEffect(() => {
    if (!destructionRecordId) loadRecent();
  }, [destructionRecordId, loadRecent]);

  const patchNc = async (value: number | null) => {
    const r = await fetch(`/api/non-conformances/${ncId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destructionRecordId: value }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({} as { error?: string }));
      throw new Error(body.error ?? "Failed to update NC.");
    }
  };

  const handleLink = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      await patchNc(Number(selectedId));
      onChanged();
      toast({ title: "Linked", description: "Destruction record linked to this NC." });
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleUnlink = async () => {
    setBusy(true);
    try {
      await patchNc(null);
      setSelectedId("");
      onChanged();
      toast({ title: "Unlinked", description: "Destruction record removed from this NC." });
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleCreated = async (record: CreatedDestructionRecord) => {
    // Link the newly-created record to this NC.
    await patchNc(record.id);
    onChanged();
  };

  const fmtWeight = (rec: DestructionRecord) =>
    rec.weight != null ? `${rec.weight}${rec.weightUom ? ` ${rec.weightUom}` : ""}` : null;

  return (
    <Card className="border-red-200 bg-red-50/40 dark:bg-red-950/20">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Flame className="h-4 w-4 text-red-500" />
          Destruction Record
          <span className="text-xs font-normal text-muted-foreground ml-1">(METRC — required when product is destroyed)</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-2 space-y-3">
        {linked ? (
          // ── Linked mode ──
          <div className="space-y-3">
            <div className="rounded-md border bg-white/70 dark:bg-black/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-sm font-semibold tracking-wide">{linked.metrcTag}</span>
                <span className="text-xs text-muted-foreground">
                  {linked.destroyedAt ? format(new Date(linked.destroyedAt), "MMM d, yyyy h:mm a") : "—"}
                </span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Destroyed By</dt>
                  <dd className="mt-0.5 font-medium">{linked.destroyedByName}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Witness</dt>
                  <dd className="mt-0.5 font-medium">{linked.witnessName || <span className="text-muted-foreground italic">—</span>}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Weight</dt>
                  <dd className="mt-0.5 font-medium">{fmtWeight(linked) || <span className="text-muted-foreground italic">—</span>}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Method</dt>
                  <dd className="mt-0.5 font-medium">{linked.method || <span className="text-muted-foreground italic">—</span>}</dd>
                </div>
                {linked.notes && (
                  <div className="col-span-2">
                    <dt className="text-xs text-muted-foreground">Notes</dt>
                    <dd className="mt-0.5 text-sm whitespace-pre-wrap">{linked.notes}</dd>
                  </div>
                )}
              </dl>
            </div>
            {!isClosed && (
              <Button size="sm" variant="outline" onClick={handleUnlink} disabled={busy}>
                {busy ? "Working…" : "Unlink"}
              </Button>
            )}
          </div>
        ) : (
          // ── Not-linked mode ──
          <div className="space-y-3">
            <p className="text-xs text-red-900 dark:text-red-200">
              This NC is dispositioned <span className="font-semibold">Destroy</span>. Link the METRC destruction record so the destroyed product carries its tag. One destruction tag can cover many batches.
            </p>
            {isClosed ? (
              <p className="text-sm text-muted-foreground italic">No destruction record was linked before this NC was closed.</p>
            ) : (
              <>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Select value={selectedId} onValueChange={setSelectedId}>
                      <SelectTrigger className="text-sm">
                        <SelectValue placeholder={recent.length ? "Select a recent destruction record…" : "No recent records — create one"} />
                      </SelectTrigger>
                      <SelectContent>
                        {recent.map((rec) => (
                          <SelectItem key={rec.id} value={String(rec.id)}>
                            {rec.metrcTag} — {rec.destroyedAt ? format(new Date(rec.destroyedAt), "MMM d, yyyy") : "?"} ({rec.destroyedByName})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button size="sm" onClick={handleLink} disabled={!selectedId || busy}>
                    {busy ? "Linking…" : "Link to selected"}
                  </Button>
                </div>
                <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
                  + Create new destruction record
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>

      <CreateDestructionRecordDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />
    </Card>
  );
}
