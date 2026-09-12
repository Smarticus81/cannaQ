import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Sparkles, Radar, ExternalLink, Loader2, Plus, X, FilePlus2 } from "lucide-react";
import { format } from "date-fns";
import { Link } from "wouter";

// E5 Regulatory Intelligence Agent (Session 66). The agent PROPOSES (summary,
// severity, impacted docs/labels, suggested actions) and the user DISPOSES
// (Review / Dismiss). AI-authored content is visually distinct (Sparkles badge)
// and always overridable — the Tier 6 "visible AI, human actor-of-record" rule.

type Impacted = { docId?: number; docNumber?: string; templateId?: number; name?: string; title?: string; reason?: string };
type LinkedAction = { type: "capa" | "document"; id: number; label: string };
type RegUpdate = {
  id: number;
  source: string;
  title: string;
  sourceUrl: string | null;
  publishedDate: string | null;
  aiSummary: string | null;
  severity: string;
  impactedDocuments: Impacted[] | null;
  impactedLabelTemplates: Impacted[] | null;
  suggestedActions: string[] | null;
  linkedActions: LinkedAction[] | null;
  aiModel: string | null;
  status: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

const SOURCES = [
  "MI CRA Bulletin",
  "MI CRA Regulation",
  "MI MDARD Bulletin",
  "FDA Food cGMP (21 CFR 117)",
  "FDA QSR/QMSR (21 CFR 820)",
  "FDA Cannabis Announcement",
  "Other",
];

function severityClass(sev: string) {
  if (sev === "Action Required") return "bg-destructive/10 text-destructive border-destructive/30";
  if (sev === "Advisory") return "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/20 dark:text-amber-400";
  return "bg-muted text-muted-foreground border-border";
}
function statusClass(s: string) {
  if (s === "Actioned") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (s === "Dismissed") return "bg-muted text-muted-foreground border-border";
  if (s === "Reviewed") return "bg-blue-50 text-blue-700 border-blue-200";
  return "bg-violet-50 text-violet-700 border-violet-200";
}

export default function RegulatoryIntelligence() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [source, setSource] = useState(SOURCES[0]);
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [text, setText] = useState("");

  const { data: updates = [], isLoading } = useQuery<RegUpdate[]>({
    queryKey: ["/api/regulatory-updates"],
    queryFn: async () => (await fetch("/api/regulatory-updates", { credentials: "include" })).json(),
  });

  const analyze = useMutation({
    mutationFn: async () => {
      const resp = await fetch("/api/regulatory-updates/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ source, title, sourceUrl: sourceUrl || undefined, text: text || undefined }),
      });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({})))?.error ?? "Analysis failed");
      return resp.json();
    },
    onSuccess: (row: { aiUnavailable?: boolean }) => {
      qc.invalidateQueries({ queryKey: ["/api/regulatory-updates"] });
      setTitle(""); setSourceUrl(""); setText("");
      if (row?.aiUnavailable) {
        toast({
          title: "Saved — but AI analysis was unavailable",
          description: "The bulletin was recorded without a summary or impact mapping. Check that the Anthropic API key is configured on this environment, then re-analyze.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Bulletin analyzed", description: "The agent's impact assessment is ready for your review." });
      }
    },
    onError: (e: unknown) => {
      toast({ title: "Could not analyze", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    },
  });

  const dispose = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const resp = await fetch(`/api/regulatory-updates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status }),
      });
      if (!resp.ok) throw new Error("Update failed");
      return resp.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/regulatory-updates"] }),
  });

  // Follow-up linking: pull CAPAs + documents so a bulletin can point to the
  // CAPA / document revision it triggered (the "rule change → change made" thread).
  const { data: capas = [] } = useQuery<{ id: number; capaNumber: string; title: string }[]>({
    queryKey: ["/api/capas"],
    queryFn: async () => (await fetch("/api/capas", { credentials: "include" })).json(),
  });
  const { data: documents = [] } = useQuery<{ id: number; docNumber: string; title: string }[]>({
    queryKey: ["/api/documents"],
    queryFn: async () => (await fetch("/api/documents", { credentials: "include" })).json(),
  });
  const setLinksMut = useMutation({
    mutationFn: async ({ id, linkedActions }: { id: number; linkedActions: LinkedAction[] }) => {
      const resp = await fetch(`/api/regulatory-updates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ linkedActions }),
      });
      if (!resp.ok) throw new Error("Update failed");
      return resp.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/regulatory-updates"] }),
  });
  const setLinks = (id: number, linkedActions: LinkedAction[]) => setLinksMut.mutate({ id, linkedActions });

  const canAnalyze = title.trim() && (text.trim() || sourceUrl.trim()) && !analyze.isPending;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Radar className="h-6 w-6" /> Regulatory Intelligence
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Ingest a regulatory bulletin; the AI agent summarizes it and flags which of your controlled
            documents and label templates may be impacted. You review and decide — the agent never acts on its own.
          </p>
        </div>

        {/* Ingest form */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-500" /> Analyze a bulletin
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Source</Label>
                <Select value={source} onValueChange={setSource}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SOURCES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Title</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Bulletin 2026-04 — Testing requirements update" />
              </div>
            </div>
            <div>
              <Label className="text-xs">Source URL (optional — fetched once if no text is pasted)</Label>
              <Input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://www.michigan.gov/cra/bulletins/..." />
            </div>
            <div>
              <Label className="text-xs">Bulletin text (paste here, or leave blank to fetch the URL)</Label>
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder="Paste the bulletin text..." />
            </div>
            <div className="flex justify-end">
              <Button onClick={() => analyze.mutate()} disabled={!canAnalyze}>
                {analyze.isPending ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Analyzing…</> : <><Sparkles className="h-4 w-4 mr-1" /> Analyze with AI</>}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Signals */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : updates.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
            No regulatory signals yet. Analyze a bulletin above to get started.
          </CardContent></Card>
        ) : (
          <div className="space-y-3">
            {updates.map((u) => (
              <Card key={u.id}>
                <CardContent className="py-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-xs">{u.source}</Badge>
                        <Badge variant="outline" className={`text-xs ${severityClass(u.severity)}`}>{u.severity}</Badge>
                        <Badge variant="outline" className={`text-xs ${statusClass(u.status)}`}>{u.status}</Badge>
                      </div>
                      <h3 className="font-semibold mt-1.5">{u.title}</h3>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(u.createdAt), "PPP")}
                        {u.sourceUrl && (
                          <a href={u.sourceUrl} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center ml-2 hover:underline">
                            source <ExternalLink className="h-3 w-3 ml-0.5" />
                          </a>
                        )}
                      </p>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {u.status !== "Actioned" && (
                        <Button size="sm" variant="outline" className="h-7" onClick={() => dispose.mutate({ id: u.id, status: "Actioned" })}>Mark actioned</Button>
                      )}
                      {u.status !== "Dismissed" && (
                        <Button size="sm" variant="ghost" className="h-7" onClick={() => dispose.mutate({ id: u.id, status: "Dismissed" })}>Dismiss</Button>
                      )}
                    </div>
                  </div>

                  {/* AI summary — visually distinct */}
                  {u.aiSummary && (
                    <div className="rounded-md border border-violet-200 bg-violet-50/40 dark:bg-violet-950/10 p-3">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-violet-700 dark:text-violet-400 mb-1">
                        <Sparkles className="h-3.5 w-3.5" /> AI summary {u.aiModel ? <span className="text-muted-foreground font-normal">· {u.aiModel}</span> : null}
                      </div>
                      <p className="text-sm">{u.aiSummary}</p>
                    </div>
                  )}

                  {/* Impacted documents */}
                  {u.impactedDocuments && u.impactedDocuments.length > 0 && (
                    <div>
                      <p className="text-xs font-medium mb-1">Impacted documents</p>
                      <ul className="text-sm space-y-1">
                        {u.impactedDocuments.map((d, i) => (
                          <li key={i} className="text-muted-foreground">
                            <span className="font-medium text-foreground">{d.docNumber}</span> {d.title}
                            {d.reason ? <> — <span className="italic">{d.reason}</span></> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Impacted label templates */}
                  {u.impactedLabelTemplates && u.impactedLabelTemplates.length > 0 && (
                    <div>
                      <p className="text-xs font-medium mb-1">Impacted label templates</p>
                      <ul className="text-sm space-y-1">
                        {u.impactedLabelTemplates.map((t, i) => (
                          <li key={i} className="text-muted-foreground">
                            <span className="font-medium text-foreground">{t.name}</span>
                            {t.reason ? <> — <span className="italic">{t.reason}</span></> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Suggested actions */}
                  {u.suggestedActions && u.suggestedActions.length > 0 && (
                    <div>
                      <p className="text-xs font-medium mb-1">Suggested actions <span className="text-muted-foreground font-normal">(advisory)</span></p>
                      <ul className="text-sm list-disc list-inside space-y-0.5">
                        {u.suggestedActions.map((a, i) => <li key={i}>{a}</li>)}
                      </ul>
                    </div>
                  )}

                  {/* Follow-up actions — the CAPA / document revision this bulletin triggered */}
                  <div>
                    <p className="text-xs font-medium mb-1">Follow-up actions</p>
                    {u.linkedActions && u.linkedActions.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 mb-1.5">
                        {u.linkedActions.map((l, i) => (
                          <span key={i} className="inline-flex items-center gap-1 rounded border bg-muted/40 px-2 py-0.5 text-xs">
                            <Link
                              href={l.type === "capa" ? `/capas/${l.id}` : `/documents/${l.id}`}
                              className="text-primary hover:underline"
                            >
                              {l.type === "capa" ? "CAPA" : "Doc"}: {l.label}
                            </Link>
                            <button
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => setLinks(u.id, (u.linkedActions ?? []).filter((_, j) => j !== i))}
                              aria-label="Remove link"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground mb-1.5">
                        None linked yet — connect the CAPA or document revision this triggered.
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <LinkPicker
                        capas={capas}
                        documents={documents}
                        existing={u.linkedActions ?? []}
                        onAdd={(link) => setLinks(u.id, [...(u.linkedActions ?? []), link])}
                      />
                      <CreateCapaFromBulletin
                        update={u}
                        onCreated={(capa) =>
                          setLinks(u.id, [
                            ...(u.linkedActions ?? []),
                            { type: "capa", id: capa.id, label: `${capa.capaNumber} — ${capa.title}` },
                          ])
                        }
                      />
                    </div>
                  </div>

                  {u.reviewedByName && (
                    <p className="text-xs text-muted-foreground">
                      {u.status} by {u.reviewedByName}{u.reviewedAt ? ` · ${format(new Date(u.reviewedAt), "PPP")}` : ""}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}

function LinkPicker({
  capas,
  documents,
  existing,
  onAdd,
}: {
  capas: { id: number; capaNumber: string; title: string }[];
  documents: { id: number; docNumber: string; title: string }[];
  existing: LinkedAction[];
  onAdd: (link: LinkedAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"capa" | "document">("capa");
  const [sel, setSel] = useState("");

  if (!open) {
    return (
      <Button size="sm" variant="outline" className="h-7" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5 mr-1" /> Link CAPA / document
      </Button>
    );
  }

  const isLinked = (t: "capa" | "document", id: number) =>
    existing.some((l) => l.type === t && l.id === id);
  const options =
    type === "capa"
      ? capas.filter((c) => !isLinked("capa", c.id)).map((c) => ({ id: c.id, label: `${c.capaNumber} — ${c.title}` }))
      : documents.filter((d) => !isLinked("document", d.id)).map((d) => ({ id: d.id, label: `${d.docNumber} — ${d.title}` }));

  const add = () => {
    if (!sel) return;
    const idNum = Number(sel);
    const opt = options.find((o) => o.id === idNum);
    onAdd({ type, id: idNum, label: opt?.label ?? `#${idNum}` });
    setSel("");
    setOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={type} onValueChange={(v) => { setType(v as "capa" | "document"); setSel(""); }}>
        <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="capa">CAPA</SelectItem>
          <SelectItem value="document">Document</SelectItem>
        </SelectContent>
      </Select>
      <Select value={sel} onValueChange={setSel}>
        <SelectTrigger className="h-8 w-72"><SelectValue placeholder={`Select a ${type === "capa" ? "CAPA" : "document"}…`} /></SelectTrigger>
        <SelectContent>
          {options.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">Nothing available to link.</div>
          ) : (
            options.map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.label}</SelectItem>)
          )}
        </SelectContent>
      </Select>
      <Button size="sm" className="h-8" onClick={add} disabled={!sel}>Add</Button>
      <Button size="sm" variant="ghost" className="h-8" onClick={() => { setOpen(false); setSel(""); }}>Cancel</Button>
    </div>
  );
}

function CreateCapaFromBulletin({
  update,
  onCreated,
}: {
  update: RegUpdate;
  onCreated: (capa: { id: number; capaNumber: string; title: string }) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [riskLevel, setRiskLevel] = useState("");
  const [riskRationale, setRiskRationale] = useState("");

  const seed = () => {
    setTitle(`Reg update: ${update.title}`.slice(0, 200));
    const acts = (update.suggestedActions ?? []).map((a) => `\u2022 ${a}`).join("\n");
    setDescription(
      ([update.aiSummary ?? "", acts ? `\n\nSuggested actions:\n${acts}` : ""].join("").trim()) ||
        `Triggered by regulatory bulletin: ${update.title} (${update.source}).`
    );
    // Action Required bulletins default to High; the user still confirms/overrides.
    setRiskLevel(update.severity === "Action Required" ? "High" : "");
    setRiskRationale("");
  };

  const create = useMutation({
    mutationFn: async () => {
      const resp = await fetch("/api/capas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ title, description, riskLevel, riskRationale }),
      });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({})))?.error ?? "Failed to create CAPA");
      return resp.json();
    },
    onSuccess: (capa: { id: number; capaNumber: string; title: string }) => {
      qc.invalidateQueries({ queryKey: ["/api/capas"] });
      onCreated(capa);
      setOpen(false);
      toast({ title: "CAPA created", description: `${capa.capaNumber} created and linked to this bulletin.` });
    },
    onError: (e: unknown) =>
      toast({ title: "Could not create CAPA", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" }),
  });

  const canCreate = !!(title.trim() && description.trim() && riskLevel && riskRationale.trim()) && !create.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (v) seed(); setOpen(v); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7">
          <FilePlus2 className="h-3.5 w-3.5 mr-1" /> Create CAPA
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a CAPA from this bulletin</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Pre-filled from the bulletin. Classify the risk to open it — the new CAPA is linked back here automatically.
          </p>
          <div>
            <Label className="text-xs">Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Description</Label>
            <Textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Risk level *</Label>
              <Select value={riskLevel} onValueChange={setRiskLevel}>
                <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {["Critical", "High", "Medium", "Low"].map((r) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-xs">Risk rationale *</Label>
            <Textarea rows={2} value={riskRationale} onChange={(e) => setRiskRationale(e.target.value)} placeholder="Why this risk level?" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!canCreate}>
            {create.isPending ? "Creating\u2026" : "Create & link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
