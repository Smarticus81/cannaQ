import { useEffect, useState } from "react";
import { useParams, Link } from "wouter";
import { useListUsers, useGetCurrentUser } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Plus, Trash2, Printer, PenLine } from "lucide-react";
import { ReviewCharts, type ReviewChartData } from "@/components/management-review/ReviewCharts";

type Attendee = { name: string; role: string };
type ActionItem = { id: number; description: string; ownerUserId: number | null; ownerName: string | null; dueDate: string | null; status: string; carriedFromReviewId: number | null; completedByName: string | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUser = any;

const SECTIONS: { key: string; title: string }[] = [
  { key: "quality", title: "Quality System" },
  { key: "operations", title: "Operations" },
  { key: "suppliers", title: "Suppliers" },
  { key: "inventory", title: "Inventory & Materials" },
  { key: "destruction", title: "Destruction" },
  { key: "metrcReconciliation", title: "METRC Reconciliation" },
  { key: "training", title: "Training" },
  { key: "documents", title: "Documents" },
  { key: "regulatory", title: "Regulatory" },
  { key: "compliance", title: "Compliance" },
];

function flatten(obj: unknown, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  if (obj == null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const label = prefix ? `${prefix} · ${k}` : k;
    if (v != null && typeof v === "object") out.push(...flatten(v, label));
    else out.push([label, String(v)]);
  }
  return out;
}

export default function ManagementReviewRecord() {
  const { id } = useParams<{ id: string }>();
  const reviewId = Number(id);
  const { toast } = useToast();
  const { data: currentUser } = useGetCurrentUser();
  const { data: users = [] } = useListUsers();

  const [status, setStatus] = useState("draft");
  const [meta, setMeta] = useState<{ periodStart: string | null; periodEnd: string | null; createdByName: string | null; signedByName: string | null; signedInitials: string | null; signedMeaning: string | null; signedAt: string | null }>({ periodStart: null, periodEnd: null, createdByName: null, signedByName: null, signedInitials: null, signedMeaning: null, signedAt: null });
  const [snapData, setSnapData] = useState<Record<string, unknown> | null>(null);
  const [items, setItems] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [outputs, setOutputs] = useState("");
  const [generalNotes, setGeneralNotes] = useState("");
  const [reviewDate, setReviewDate] = useState("");

  const [aiDesc, setAiDesc] = useState("");
  const [aiOwner, setAiOwner] = useState("");
  const [aiDue, setAiDue] = useState("");

  const signed = status === "signed";
  const canManage = ["Manager", "Quality", "Admin"].includes(currentUser?.role ?? "");
  const locked = signed || !canManage;

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`/api/management-review/reviews/${reviewId}`, { credentials: "include" });
      if (!r.ok) throw new Error();
      const d = await r.json();
      const rev = d.review;
      setStatus(rev.status);
      setMeta({ periodStart: rev.periodStart, periodEnd: rev.periodEnd, createdByName: rev.createdByName, signedByName: rev.signedByName, signedInitials: rev.signedInitials, signedMeaning: rev.signedMeaning, signedAt: rev.signedAt });
      setSnapData(d.snapshot?.data ?? null);
      setItems(d.actionItems ?? []);
      setAttendees(Array.isArray(rev.attendees) ? rev.attendees : []);
      setNotes(rev.sectionNotes && typeof rev.sectionNotes === "object" ? rev.sectionNotes : {});
      setOutputs(rev.outputs ?? "");
      setGeneralNotes(rev.generalNotes ?? "");
      setReviewDate(rev.reviewDate ?? "");
    } catch {
      toast({ title: "Failed to load review", variant: "destructive" });
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [reviewId]);

  async function saveDraft() {
    setSaving(true);
    try {
      const r = await fetch(`/api/management-review/reviews/${reviewId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ attendees, sectionNotes: notes, outputs, generalNotes, reviewDate }),
      });
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error ?? "Save failed"); }
      toast({ title: "Draft saved" });
      await load();
    } catch (e) { toast({ title: "Save failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
    finally { setSaving(false); }
  }

  async function addActionItem() {
    if (!aiDesc.trim()) { toast({ title: "Enter an action item", variant: "destructive" }); return; }
    const owner = (users as AnyUser[]).find((u) => String(u.id) === aiOwner);
    const r = await fetch(`/api/management-review/reviews/${reviewId}/action-items`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ description: aiDesc.trim(), ownerUserId: owner?.id ?? null, ownerName: owner?.fullName ?? null, dueDate: aiDue || null }),
    });
    if (!r.ok) { toast({ title: "Failed to add action item", variant: "destructive" }); return; }
    setAiDesc(""); setAiOwner(""); setAiDue(""); await load();
  }

  async function toggleItem(it: ActionItem) {
    const r = await fetch(`/api/management-review/reviews/${reviewId}/action-items/${it.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ status: it.status === "Done" ? "Open" : "Done" }),
    });
    if (!r.ok) { toast({ title: "Update failed", variant: "destructive" }); return; }
    await load();
  }

  if (loading) return <><div className="p-6 text-sm text-muted-foreground">Loading…</div></>;

  return (
    <>
      <div className="max-w-4xl mx-auto space-y-4 p-1">
        <div className="flex items-center justify-between print:hidden">
          <Link href="/management-review" className="text-sm text-primary hover:underline inline-flex items-center gap-1"><ArrowLeft className="h-4 w-4" /> Back to Management Review</Link>
          <div className="flex gap-2">
            {!signed && canManage && <Button variant="outline" onClick={saveDraft} disabled={saving}>{saving ? "Saving…" : "Save draft"}</Button>}
            {!signed && canManage && <SignDialog reviewId={reviewId} onSigned={load} />}
            {signed && <Button variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4 mr-2" />Print</Button>}
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">Management Review</h1>
            <Badge className={signed ? "bg-blue-700" : ""} variant={signed ? "default" : "secondary"}>{signed ? "Signed" : "Draft"}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Review date {reviewDate || "—"} · Period {meta.periodStart ?? "?"} → {meta.periodEnd ?? "?"}{meta.createdByName ? ` · Opened by ${meta.createdByName}` : ""}
          </p>
        </div>

        {signed && (
          <div className="rounded-md border border-blue-300 bg-blue-50/50 p-3 text-sm dark:bg-blue-950/20">
            Signed by <strong>{meta.signedByName}</strong> ({meta.signedInitials}){meta.signedAt ? ` on ${new Date(meta.signedAt).toLocaleString()}` : ""}. <span className="text-muted-foreground">{meta.signedMeaning}</span>
          </div>
        )}

        {!signed && (
          <div className="print:hidden">
            <Label className="text-xs">Review date</Label>
            <Input type="date" className="h-9 w-48" value={reviewDate} onChange={(e) => setReviewDate(e.target.value)} disabled={locked} />
          </div>
        )}

        {/* Attendees */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Attendees</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {attendees.length === 0 && <p className="text-sm text-muted-foreground">No attendees recorded.</p>}
            {attendees.map((a, i) => (
              <div key={i} className="flex gap-2 items-center">
                <Input placeholder="Name" value={a.name} disabled={locked} onChange={(e) => setAttendees(attendees.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <Input placeholder="Role / title" value={a.role} disabled={locked} onChange={(e) => setAttendees(attendees.map((x, j) => j === i ? { ...x, role: e.target.value } : x))} />
                {!locked && <Button size="icon" variant="ghost" onClick={() => setAttendees(attendees.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>}
              </div>
            ))}
            {!locked && <Button size="sm" variant="outline" onClick={() => setAttendees([...attendees, { name: "", role: "" }])}><Plus className="h-4 w-4 mr-1" />Add attendee</Button>}
          </CardContent>
        </Card>

        {snapData && (
          <div>
            <h2 className="text-sm font-semibold mb-2">Metrics at a glance</h2>
            <ReviewCharts data={snapData as unknown as ReviewChartData} />
          </div>
        )}

        {/* Sections with data + discussion notes */}
        {SECTIONS.filter((sec) => snapData && snapData[sec.key]).map((sec) => (
          <Card key={sec.key}>
            <CardHeader className="pb-2"><CardTitle className="text-base">{sec.title}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {flatten(snapData?.[sec.key]).map(([k, v]) => (
                  <span key={k} className="text-muted-foreground"><span className="font-medium text-foreground">{v}</span> {k}</span>
                ))}
              </div>
              <div>
                <Label className="text-xs">Discussion notes</Label>
                <Textarea rows={2} disabled={locked} value={notes[sec.key] ?? ""} onChange={(e) => setNotes({ ...notes, [sec.key]: e.target.value })} placeholder={`Notes on ${sec.title.toLowerCase()}…`} />
              </div>
            </CardContent>
          </Card>
        ))}

        {/* Outputs + general notes */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Review outputs &amp; decisions (ISO §5.6.3)</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label className="text-xs">Outputs — improvements, product/process changes, resource needs</Label>
              <Textarea rows={3} disabled={locked} value={outputs} onChange={(e) => setOutputs(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">General notes</Label>
              <Textarea rows={2} disabled={locked} value={generalNotes} onChange={(e) => setGeneralNotes(e.target.value)} />
            </div>
          </CardContent>
        </Card>

        {/* Action items */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Action items</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {items.length === 0 ? <p className="text-sm text-muted-foreground">No action items yet.</p> : (
              <Table>
                <TableHeader><TableRow><TableHead>Action</TableHead><TableHead>Owner</TableHead><TableHead>Due</TableHead><TableHead>Status</TableHead><TableHead className="print:hidden" /></TableRow></TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className="align-top">
                        {it.description}
                        {it.carriedFromReviewId != null && <Badge variant="outline" className="ml-2 text-[10px]">carried forward</Badge>}
                      </TableCell>
                      <TableCell className="align-top">{it.ownerName ?? "—"}</TableCell>
                      <TableCell className="align-top">{it.dueDate ?? "—"}</TableCell>
                      <TableCell className="align-top"><Badge variant={it.status === "Done" ? "default" : "secondary"}>{it.status}</Badge></TableCell>
                      <TableCell className="print:hidden">
                        {canManage && <Button size="sm" variant="ghost" onClick={() => toggleItem(it)}>{it.status === "Done" ? "Reopen" : "Mark done"}</Button>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {!signed && canManage && (
              <div className="flex flex-wrap gap-2 items-end print:hidden border-t pt-3">
                <div className="flex-1 min-w-[200px]"><Label className="text-xs">New action</Label><Input value={aiDesc} onChange={(e) => setAiDesc(e.target.value)} placeholder="What needs to happen?" /></div>
                <div><Label className="text-xs">Owner</Label>
                  <Select value={aiOwner} onValueChange={setAiOwner}>
                    <SelectTrigger className="w-44"><SelectValue placeholder="Assign" /></SelectTrigger>
                    <SelectContent>{(users as AnyUser[]).map((u) => <SelectItem key={u.id} value={String(u.id)}>{u.fullName}{u.role ? ` · ${u.role}` : ""}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div><Label className="text-xs">Due</Label><Input type="date" className="w-40" value={aiDue} onChange={(e) => setAiDue(e.target.value)} /></div>
                <Button onClick={addActionItem}><Plus className="h-4 w-4 mr-1" />Add</Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function SignDialog({ reviewId, onSigned }: { reviewId: number; onSigned: () => void | Promise<void> }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [initials, setInitials] = useState("");
  const [meaning, setMeaning] = useState("I have conducted and approve this management review.");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!initials.trim() || !meaning.trim()) { toast({ title: "Initials and a statement are required", variant: "destructive" }); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/management-review/reviews/${reviewId}/sign`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ initials: initials.trim(), signingMeaning: meaning.trim() }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error ?? "Sign failed");
      toast({ title: "Review signed" });
      setOpen(false);
      await onSigned();
    } catch (e) { toast({ title: "Sign failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><PenLine className="h-4 w-4 mr-2" />Sign &amp; finalize</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Sign the management review (21 CFR Part 11)</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Signing locks this review. Save your draft first if you have unsaved edits.</p>
        <div><Label className="text-xs">Your initials</Label><Input value={initials} onChange={(e) => setInitials(e.target.value)} className="w-32" /></div>
        <div><Label className="text-xs">Signing statement</Label><Textarea rows={2} value={meaning} onChange={(e) => setMeaning(e.target.value)} /></div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Signing…" : "Sign"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
