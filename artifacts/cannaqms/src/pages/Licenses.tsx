import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { formatDateOnly } from "@/lib/utils";
import { Scale, Plus } from "lucide-react";

// Facility license & certificate register. Each license = the license file
// (attachment), issuer, type, number, and effective/expiry dates. Feeds the
// Compliance widget's 4-month renewal watch. (2026-08-12)
type License = {
  id: number;
  name: string;
  licenseType: string;
  licenseNumber: string;
  issuer: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  status: string;
  notes: string | null;
};

// Issuer-first: the certifying agency drives which license types are offered.
// Michigan set for now — structured so a future state just swaps this block
// (keyed off the facility's state in regulatory config). CRA licenses cannabis
// (incl. cultivation/growers); MDARD = food establishments, pesticides, hemp.
const OTHER = "Other";
const ISSUERS = ["CRA", "FDA", "MDARD", "Bureau of Fire Services (BFS)", "Local Municipality", OTHER];
const TYPES_BY_ISSUER: Record<string, string[]> = {
  CRA: [
    "Grower – Class A",
    "Grower – Class B",
    "Grower – Class C",
    "Processor",
    "Retailer",
    "Microbusiness",
    "Class A Microbusiness",
    "Secure Transporter",
    "Safety Compliance Facility",
    "Excess Grower",
    "Designated Consumption Establishment",
    "Event Organizer",
  ],
  FDA: ["GMP Certification", "Food Facility Registration"],
  MDARD: ["Food Establishment License", "Pesticide Applicator"],
  "Bureau of Fire Services (BFS)": ["Fire Safety Permit / Inspection"],
  "Local Municipality": ["Local Operating Permit", "Zoning Approval"],
  [OTHER]: [],
};
const STATUSES = ["Active", "Pending", "Expired", "Inactive"];

type FormState = {
  issuer: string;      // a value from ISSUERS
  issuerOther: string; // agency name when issuer === Other
  type: string;        // a value from the issuer's type list, or Other
  typeOther: string;   // free-text type when type === Other
  name: string;        // optional friendly label
  licenseNumber: string;
  issueDate: string;
  expiryDate: string;
  status: string;
};

const EMPTY_FORM: FormState = {
  issuer: "CRA",
  issuerOther: "",
  type: "",
  typeOther: "",
  name: "",
  licenseNumber: "",
  issueDate: "",
  expiryDate: "",
  status: "Active",
};

function expiryBadge(expiryDate: string | null) {
  if (!expiryDate) return null;
  const today = new Date().toLocaleDateString("en-CA");
  const exp = expiryDate.slice(0, 10);
  const days = Math.round((new Date(exp + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 86400000);
  if (days < 0) return <Badge className="bg-red-100 text-red-800 border-red-200">Expired</Badge>;
  if (days <= 120) return <Badge className="bg-amber-100 text-amber-800 border-amber-200">{days}d left</Badge>;
  return <Badge variant="outline">{days}d left</Badge>;
}

// Reverse a saved license into form fields — map its issuer/type back onto the
// known lists, falling back to the free-text "Other" slots for custom values.
function formFromLicense(l: License): FormState {
  const savedIssuer = l.issuer ?? "";
  const issuerKnown = ISSUERS.includes(savedIssuer);
  const issuer = issuerKnown ? savedIssuer : OTHER;
  const typeList = TYPES_BY_ISSUER[issuer] ?? [];
  const typeKnown = typeList.includes(l.licenseType);
  return {
    issuer,
    issuerOther: issuerKnown ? "" : savedIssuer,
    type: typeKnown ? l.licenseType : OTHER,
    typeOther: typeKnown ? "" : l.licenseType,
    name: l.name ?? "",
    licenseNumber: l.licenseNumber ?? "",
    issueDate: l.issueDate ? l.issueDate.slice(0, 10) : "",
    expiryDate: l.expiryDate ? l.expiryDate.slice(0, 10) : "",
    status: l.status ?? "Active",
  };
}

export default function Licenses() {
  const qc = useQueryClient();
  const { data: currentUser } = useGetCurrentUser();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<License | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const { data: licenses = [], isLoading } = useQuery<License[]>({
    queryKey: ["licenses", "all"],
    queryFn: async () => {
      const r = await fetch("/api/licenses?all=true", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load licenses");
      return r.json();
    },
  });

  const sorted = useMemo(
    () => [...licenses].sort((a, b) => (a.expiryDate ?? "9999").localeCompare(b.expiryDate ?? "9999")),
    [licenses],
  );

  const typeOptions = TYPES_BY_ISSUER[form.issuer] ?? [];
  const resolvedIssuer = form.issuer === OTHER ? form.issuerOther.trim() : form.issuer;
  const resolvedType = form.type === OTHER ? form.typeOther.trim() : form.type;
  const canSave = !!(resolvedIssuer && resolvedType && form.licenseNumber.trim());

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim() || `${resolvedIssuer} ${resolvedType}`.trim(),
        licenseType: resolvedType,
        licenseNumber: form.licenseNumber.trim(),
        issuer: resolvedIssuer || null,
        issueDate: form.issueDate || null,
        expiryDate: form.expiryDate || null,
        status: form.status,
      };
      const url = editing ? `/api/licenses/${editing.id}` : "/api/licenses";
      const r = await fetch(url, {
        method: editing ? "PUT" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("Failed to save license");
      return r.json();
    },
    onSuccess: (saved: License) => {
      qc.invalidateQueries({ queryKey: ["licenses"] });
      qc.invalidateQueries({ queryKey: ["license-renewals"] });
      if (!editing && saved?.id) setEditing(saved); // keep open so they can attach the file
    },
  });

  const remove = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/licenses/${id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error("Failed to delete license");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["licenses"] });
      qc.invalidateQueries({ queryKey: ["license-renewals"] });
      closeDialog();
    },
  });

  function openNew() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }
  function openEdit(l: License) {
    setEditing(l);
    setForm(formFromLicense(l));
    setDialogOpen(true);
  }
  function closeDialog() {
    setDialogOpen(false);
    setEditing(null);
    setForm(EMPTY_FORM);
  }

  return (
    <>
      <div className="mx-auto max-w-5xl p-4 sm:p-6 space-y-4">
        <div className="cq-page-heading flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Scale className="h-5 w-5 text-primary" /> Licenses &amp; Certificates
            </h1>
            <p className="text-sm text-muted-foreground">Your facility&apos;s operating licenses and certificates — issuer, type, file, and renewal dates.</p>
          </div>
          <Button onClick={openNew} className="gap-1.5 shrink-0"><Plus className="h-4 w-4" /> New License</Button>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Register</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : sorted.length === 0 ? (
              <p className="text-sm text-muted-foreground">No licenses yet. Add one with “New License.”</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Issuer</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Number</TableHead>
                    <TableHead>Effective</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((l) => (
                    <TableRow key={l.id} className="cursor-pointer hover:bg-muted/40" onClick={() => openEdit(l)}>
                      <TableCell className="font-medium">{l.issuer || "—"}</TableCell>
                      <TableCell>{l.licenseType}</TableCell>
                      <TableCell className="font-mono text-xs">{l.licenseNumber}</TableCell>
                      <TableCell className="text-muted-foreground">{l.issueDate ? formatDateOnly(l.issueDate) : "—"}</TableCell>
                      <TableCell className="flex items-center gap-2">
                        <span>{l.expiryDate ? formatDateOnly(l.expiryDate) : "—"}</span>
                        {expiryBadge(l.expiryDate)}
                      </TableCell>
                      <TableCell><Badge variant="outline">{l.status}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(o) => (o ? setDialogOpen(true) : closeDialog())}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit License" : "New License"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-1.5">
              <Label>Issuer</Label>
              <Select value={form.issuer} onValueChange={(v) => setForm((f) => ({ ...f, issuer: v, type: "", typeOther: "" }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{ISSUERS.map((i) => <SelectItem key={i} value={i}>{i}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {form.issuer === OTHER && (
              <div className="grid gap-1.5">
                <Label htmlFor="lic-agency">Certifying agency name</Label>
                <Input id="lic-agency" value={form.issuerOther} onChange={(e) => setForm((f) => ({ ...f, issuerOther: e.target.value }))} placeholder="Name of the certifying agency" />
              </div>
            )}

            <div className="grid gap-1.5">
              <Label>Type</Label>
              <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}>
                <SelectTrigger><SelectValue placeholder={form.issuer === OTHER ? "Choose “Other” and specify" : "Select a type"} /></SelectTrigger>
                <SelectContent>
                  {typeOptions.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  <SelectItem value={OTHER}>Other…</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.type === OTHER && (
              <div className="grid gap-1.5">
                <Label htmlFor="lic-type-other">Type name</Label>
                <Input id="lic-type-other" value={form.typeOther} onChange={(e) => setForm((f) => ({ ...f, typeOther: e.target.value }))} placeholder="Describe the license / certification" />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="lic-number">Number</Label>
                <Input id="lic-number" value={form.licenseNumber} onChange={(e) => setForm((f) => ({ ...f, licenseNumber: e.target.value }))} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lic-name">Name / label (optional)</Label>
                <Input id="lic-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Auto-fills from issuer + type" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="lic-issue">Effective date</Label>
                <Input id="lic-issue" type="date" value={form.issueDate} onChange={(e) => setForm((f) => ({ ...f, issueDate: e.target.value }))} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lic-expiry">Expiration date</Label>
                <Input id="lic-expiry" type="date" value={form.expiryDate} onChange={(e) => setForm((f) => ({ ...f, expiryDate: e.target.value }))} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>

            {editing ? (
              <div className="border-t pt-3">
                <AttachmentsPanel
                  parentTable="licenses"
                  parentId={editing.id}
                  title="License file"
                  currentUserId={currentUser?.id}
                  currentUserRole={currentUser?.role}
                />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground border-t pt-3">Save the license first, then attach the license file.</p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            {editing ? (
              <Button variant="outline" className="text-red-700 hover:text-red-800" onClick={() => remove.mutate(editing.id)} disabled={remove.isPending}>Delete</Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button variant="outline" onClick={closeDialog}>Close</Button>
              <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>{save.isPending ? "Saving…" : editing ? "Save" : "Create"}</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
