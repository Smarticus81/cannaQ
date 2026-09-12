import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { FileText, Link2, Link2Off, BookOpen, Check, ChevronsUpDown } from "lucide-react";
import { Link } from "wouter";

type SpecDoc = {
  id: number;
  docNumber: string;
  title: string;
  documentType: string;
  status: string;
  revision: string;
};

type Batch = {
  id: number;
  status: string;
  specDocId: number | null;
  specRevisionAtLink: string | null;
  specLinkedAt: string | null;
};

export function LinkedSpecPanel({ batch, onChanged }: { batch: Batch; onChanged?: () => void }) {
  const qc = useQueryClient();
  const locked = batch.status === "released_to_inventory";

  const { data: spec } = useQuery<SpecDoc | null>({
    queryKey: [`/api/documents/${batch.specDocId}`],
    queryFn: async () => batch.specDocId ? (await fetch(`/api/documents/${batch.specDocId}`)).json() : null,
    enabled: !!batch.specDocId,
  });

  const unlink = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/batch-records/${batch.id}/link-spec`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to unlink");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/batch-records/${batch.id}`] });
      qc.invalidateQueries({ queryKey: [`/api/batch-records/${batch.id}/spec-snapshot`] });
      onChanged?.();
    },
  });

  return (
    <Card className="print:hidden">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <BookOpen className="h-4 w-4" /> Linked Procedure
          <span
            className="text-xs font-normal text-muted-foreground cursor-help"
            title="Optional. When you link an Approved Specification document here, the Print Batch Record will render that spec's structured sections (header / ingredients / in-process checks / tests / yield / signoffs) populated with this batch's live data. The spec's content is snapshotted at link time so reprints stay reproducible (FDA 21 CFR Part 11) even if the spec is later revised. Linking is locked once the batch is released to inventory."
          >
            (what's this?)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {batch.specDocId && spec ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Link href={`/documents/${spec.id}`} className="font-medium text-primary hover:underline">
                {spec.docNumber} — {spec.title}
              </Link>
              <div className="flex gap-2 mt-1 items-center text-xs text-muted-foreground">
                <Badge variant="outline">Rev {batch.specRevisionAtLink ?? spec.revision} (snapshot)</Badge>
                <span>Linked {batch.specLinkedAt ? new Date(batch.specLinkedAt).toLocaleDateString() : ""}</span>
              </div>
            </div>
            {!locked && (
              <Button variant="outline" size="sm" onClick={() => unlink.mutate()} disabled={unlink.isPending}>
                <Link2Off className="h-4 w-4 mr-1" /> Unlink
              </Button>
            )}
            {locked && <Badge variant="outline" className="text-muted-foreground">Locked (released)</Badge>}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              Link an Approved Specification or Work Instruction to drive the Print Batch Record and
              capture which approved revision this batch ran against.
            </div>
            {!locked && <LinkSpecDialog batchId={batch.id} onLinked={onChanged} />}
            {locked && <Badge variant="outline" className="text-muted-foreground">Locked (released)</Badge>}
          </div>
        )}
        {unlink.error && (
          <p className="text-sm text-destructive mt-2">{(unlink.error as Error).message}</p>
        )}
      </CardContent>
    </Card>
  );
}

function LinkSpecDialog({ batchId, onLinked }: { batchId: number; onLinked?: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pickedId, setPickedId] = useState<string>("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: docs } = useQuery<SpecDoc[]>({
    queryKey: ["/api/documents", "linkable-approved"],
    queryFn: async () => {
      // Session 61 — Specification AND Work Instruction docs are linkable now.
      const all: SpecDoc[] = await (await fetch("/api/documents")).json();
      return all.filter(
        (d) =>
          (d.status === "Approved" || d.status === "Effective") &&
          (d.documentType === "Specification" || d.documentType === "Work Instruction"),
      );
    },
    enabled: open,
  });

  const link = useMutation({
    mutationFn: async () => {
      setError(null);
      const res = await fetch(`/api/batch-records/${batchId}/link-spec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specDocId: parseInt(pickedId) }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to link");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/batch-records/${batchId}`] });
      qc.invalidateQueries({ queryKey: [`/api/batch-records/${batchId}/spec-snapshot`] });
      // Session 100 (option a) — linking a recipe-backed procedure can seed the
      // batch's Process Steps server-side, so refresh that tab too.
      qc.invalidateQueries({ queryKey: [`/api/batch-records/${batchId}/process-steps`] });
      setOpen(false);
      setPickedId("");
      onLinked?.();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Link2 className="h-4 w-4 mr-1" /> Link Procedure</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Link Procedure (Spec or WI)</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Only Approved or Effective Specification or Work Instruction documents are listed.
          </p>
          {(() => {
            const selected = (docs ?? []).find((d) => String(d.id) === pickedId);
            return (
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
                    <span className="truncate min-w-0">{selected ? `${selected.docNumber} — ${selected.title}` : "Select a spec or WI…"}</span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search specs / WIs…" />
                    <CommandList>
                      <CommandEmpty>No approved specs or WIs found.</CommandEmpty>
                      {(docs ?? []).map((d) => (
                        <CommandItem
                          key={d.id}
                          value={`${d.docNumber} ${d.title} ${d.documentType} ${d.revision}`}
                          onSelect={() => { setPickedId(String(d.id)); setPickerOpen(false); }}
                        >
                          <Check className={cn("mr-2 h-4 w-4", pickedId === String(d.id) ? "opacity-100" : "opacity-0")} />
                          <span className="truncate min-w-0">{d.docNumber} — {d.title} ({d.documentType} · Rev {d.revision})</span>
                        </CommandItem>
                      ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            );
          })()}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!pickedId || link.isPending} onClick={() => link.mutate()}>
              {link.isPending ? "Linking..." : "Link"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground flex items-start gap-1.5 pt-2 border-t">
            <FileText className="h-3 w-3 mt-0.5 shrink-0" />
            The spec's current revision is snapshotted at link time so reprints stay reproducible.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
