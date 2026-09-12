import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { Plus, Trash2, FileText } from "lucide-react";

// SOP / Policy / Manual narrative sections. Optional per document — add only the
// ones that apply (a Pest Control SOP may skip Materials, a CAPA may skip Safety).
// Reuses the /documents/:id/sections + /document-sections/:id endpoints. Free-text
// kinds store markdown in bodyMarkdown; the two structured kinds store JSON in data:
//   associated_documents → { docs: [{ documentId, note }] }
//   materials_equipment  → { items: [{ name, note }] }
const SOP_KINDS = [
  { value: "definitions", label: "Definitions", editor: "text" },
  { value: "associated_documents", label: "Associated Documents", editor: "docs" },
  { value: "materials_equipment", label: "Materials / Equipment", editor: "list" },
  { value: "safety", label: "Safety", editor: "text" },
  // Structured rather than free text: who does what is a table in every SOP
  // template worth the name, and keeping it structured means it prints as one.
  { value: "responsibilities", label: "Roles & Responsibilities", editor: "roles" },
  { value: "procedure", label: "Procedure", editor: "text" },
  { value: "free_text", label: "Free Text", editor: "text" },
] as const;
type Kind = (typeof SOP_KINDS)[number]["value"];
const KIND_META: Record<string, { label: string; editor: string }> = Object.fromEntries(
  SOP_KINDS.map((k) => [k.value, { label: k.label, editor: k.editor }]),
);
// Canonical template order — the index of each kind in SOP_KINDS. Sections always
// render in this order no matter when they were added, so the document follows the
// strict SOP template. Unknown kinds fall to the end.
const KIND_ORDER: Record<string, number> = Object.fromEntries(SOP_KINDS.map((k, i) => [k.value, i]));

type DocLink = { documentId: number; note?: string; snapshotDocNumber?: string; snapshotTitle?: string };
type MaterialItem = { name: string; note?: string };
type RoleRow = { role: string; responsibility: string };
type SectionData = { docs?: DocLink[]; items?: MaterialItem[]; roles?: RoleRow[] } | null;
type Section = {
  id: number;
  documentId: number;
  sortOrder: number;
  kind: string;
  title: string;
  bodyMarkdown: string | null;
  data: SectionData;
};
type DocOption = { id: number; docNumber: string; title: string };

export function SopSectionsPanel({ docId, isDraft }: { docId: number; isDraft: boolean }) {
  const qc = useQueryClient();
  const { data: sections } = useQuery<Section[]>({
    queryKey: [`/api/documents/${docId}/sections`],
    queryFn: async () => (await fetch(`/api/documents/${docId}/sections`)).json(),
  });
  const { data: allDocs } = useQuery<DocOption[]>({
    queryKey: ["/api/documents"],
    queryFn: async () => (await fetch("/api/documents")).json(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: [`/api/documents/${docId}/sections`] });

  const addSection = useMutation({
    mutationFn: async (body: Partial<Section>) => {
      const res = await fetch(`/api/documents/${docId}/sections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to add section");
      return res.json();
    },
    onSuccess: invalidate,
  });
  const updateSection = useMutation({
    mutationFn: async (vars: { id: number; patch: Partial<Section> }) => {
      const res = await fetch(`/api/document-sections/${vars.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars.patch),
      });
      if (!res.ok) throw new Error("Failed to update section");
      return res.json();
    },
    onSuccess: invalidate,
  });
  const removeSection = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/document-sections/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove section");
    },
    onSuccess: invalidate,
  });

  // Strict template order — never insertion order. free_text sections fall to the
  // end, kept in add order (by id) among themselves.
  const orderOf = (s: Section) => KIND_ORDER[s.kind] ?? 99;
  const sorted = (sections ?? []).slice().sort((a, b) => orderOf(a) - orderOf(b) || a.id - b.id);
  const presentKinds = new Set((sections ?? []).map((s) => s.kind));
  const docOptions = (allDocs ?? []).filter((d) => d.id !== docId);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4" /> Sections
        </CardTitle>
        {isDraft && (
          <AddSection presentKinds={presentKinds} onAdd={(body) => addSection.mutate(body)} disabled={addSection.isPending} />
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Optional procedure sections — add the ones that apply and leave out the rest. Editable only while the document is in Draft.
        </p>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No sections yet.</p>
        ) : (
          <div className="space-y-2">
            {sorted.map((s) => (
              <SopSectionRow
                key={s.id}
                section={s}
                isDraft={isDraft}
                docOptions={docOptions}
                onUpdate={(patch) => updateSection.mutate({ id: s.id, patch })}
                onRemove={() => removeSection.mutate(s.id)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AddSection({
  presentKinds,
  onAdd,
  disabled,
}: {
  presentKinds: Set<string>;
  onAdd: (body: Partial<Section>) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Only offer template sections not already on the document; Free Text may repeat.
  const available = SOP_KINDS.filter((k) => k.value === "free_text" || !presentKinds.has(k.value));
  const [kind, setKind] = useState<Kind>(available[0]?.value ?? "free_text");
  if (!open)
    return (
      <Button
        size="sm"
        onClick={() => {
          setKind(available[0]?.value ?? "free_text");
          setOpen(true);
        }}
      >
        <Plus className="h-4 w-4 mr-1" /> Add Section
      </Button>
    );
  return (
    <div className="flex gap-2 items-center">
      <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
        <SelectTrigger className="w-48 h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {available.map((k) => (
            <SelectItem key={k.value} value={k.value}>
              {k.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        disabled={disabled}
        onClick={() => {
          // sortOrder mirrors the template position so the DB order matches the
          // on-screen order too (display always re-sorts by template regardless).
          onAdd({ kind, title: KIND_META[kind].label, sortOrder: (KIND_ORDER[kind] ?? 99) * 10 });
          setOpen(false);
        }}
      >
        Add
      </Button>
      <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  );
}

function SopSectionRow({
  section,
  isDraft,
  docOptions,
  onUpdate,
  onRemove,
}: {
  section: Section;
  isDraft: boolean;
  docOptions: DocOption[];
  onUpdate: (patch: Partial<Section>) => void;
  onRemove: () => void;
}) {
  const editor = KIND_META[section.kind]?.editor ?? "text";
  return (
    <div className="border rounded-md p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="shrink-0">
          {KIND_META[section.kind]?.label ?? section.kind}
        </Badge>
        <span className="text-sm font-medium flex-1">{section.title}</span>
        {isDraft && (
          <Button variant="ghost" size="icon" onClick={onRemove}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        )}
      </div>
      {editor === "roles" ? (
        <ResponsibilitiesEditor section={section} isDraft={isDraft} onUpdate={onUpdate} />
      ) : editor === "list" ? (
        <MaterialsEditor section={section} isDraft={isDraft} onUpdate={onUpdate} />
      ) : editor === "docs" ? (
        <AssociatedDocsEditor section={section} isDraft={isDraft} docOptions={docOptions} onUpdate={onUpdate} />
      ) : (
        <TextEditor section={section} isDraft={isDraft} onUpdate={onUpdate} />
      )}
    </div>
  );
}

function TextEditor({
  section,
  isDraft,
  onUpdate,
}: {
  section: Section;
  isDraft: boolean;
  onUpdate: (p: Partial<Section>) => void;
}) {
  const [body, setBody] = useState(section.bodyMarkdown ?? "");
  if (!isDraft)
    return section.bodyMarkdown ? (
      <p className="text-sm bg-muted/30 p-3 rounded-md whitespace-pre-wrap">{section.bodyMarkdown}</p>
    ) : (
      <p className="text-sm text-muted-foreground italic">—</p>
    );
  return (
    <Textarea
      className="text-sm"
      rows={4}
      value={body}
      onChange={(e) => setBody(e.target.value)}
      onBlur={() => (body || "") !== (section.bodyMarkdown ?? "") && onUpdate({ bodyMarkdown: body || null })}
      placeholder="Write this section's content. Saved when you click away."
    />
  );
}

// Roles & Responsibilities — a two-column table (Role | Responsibility). Always
// renders at least two rows so it reads as a table from the moment the section is
// added, rather than as one lonely input. Blank rows are harmless: the print view
// drops them, so an author can leave the spare row empty.
const MIN_ROLE_ROWS = 2;

function padRoles(rows: RoleRow[]): RoleRow[] {
  const out = rows.slice();
  while (out.length < MIN_ROLE_ROWS) out.push({ role: "", responsibility: "" });
  return out;
}

function ResponsibilitiesEditor({
  section,
  isDraft,
  onUpdate,
}: {
  section: Section;
  isDraft: boolean;
  onUpdate: (p: Partial<Section>) => void;
}) {
  const stored: RoleRow[] = section.data?.roles ?? [];
  const save = (next: RoleRow[]) => onUpdate({ data: { roles: next } });

  if (!isDraft) {
    const filled = stored.filter((r) => r.role.trim() || r.responsibility.trim());
    return filled.length ? (
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b">
            <th className="text-left py-1 pr-3 w-1/3 font-medium">Role</th>
            <th className="text-left py-1 font-medium">Responsibility</th>
          </tr>
        </thead>
        <tbody>
          {filled.map((r, i) => (
            <tr key={i} className="border-b last:border-0">
              <td className="py-1 pr-3 align-top">{r.role || "—"}</td>
              <td className="py-1 align-top whitespace-pre-wrap">{r.responsibility || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <p className="text-sm text-muted-foreground italic">—</p>
    );
  }

  const rows = padRoles(stored);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-12 gap-2 text-xs text-muted-foreground px-0.5">
        <span className="col-span-4">Role</span>
        <span className="col-span-7">Responsibility</span>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 items-start">
          <Input
            className="h-8 col-span-4"
            value={r.role}
            placeholder="e.g. Department Supervisor"
            onChange={(e) => save(rows.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
          />
          <Input
            className="h-8 col-span-7"
            value={r.responsibility}
            placeholder="What they are responsible for"
            onChange={(e) => save(rows.map((x, j) => (j === i ? { ...x, responsibility: e.target.value } : x)))}
          />
          <div className="col-span-1 flex justify-end">
            {rows.length > MIN_ROLE_ROWS && (
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => save(rows.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            )}
          </div>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => save([...rows, { role: "", responsibility: "" }])}>
        <Plus className="h-4 w-4 mr-1" /> Add role
      </Button>
    </div>
  );
}

function MaterialsEditor({
  section,
  isDraft,
  onUpdate,
}: {
  section: Section;
  isDraft: boolean;
  onUpdate: (p: Partial<Section>) => void;
}) {
  const items: MaterialItem[] = section.data?.items ?? [];
  const save = (next: MaterialItem[]) => onUpdate({ data: { items: next } });
  if (!isDraft)
    return items.length ? (
      <ul className="list-disc pl-5 text-sm space-y-0.5">
        {items.map((it, i) => (
          <li key={i}>
            {it.name}
            {it.note ? <span className="text-muted-foreground"> — {it.note}</span> : null}
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-sm text-muted-foreground italic">—</p>
    );
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="flex gap-2 items-center">
          <Input
            className="h-8 flex-1"
            value={it.name}
            placeholder="Item (e.g. Scale, Spatula)"
            onChange={(e) => save(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
          />
          <Input
            className="h-8 w-40"
            value={it.note ?? ""}
            placeholder="Note (optional)"
            onChange={(e) => save(items.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
          />
          <Button variant="ghost" size="icon" onClick={() => save(items.filter((_, j) => j !== i))}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => save([...items, { name: "" }])}>
        <Plus className="h-4 w-4 mr-1" /> Add item
      </Button>
    </div>
  );
}

function AssociatedDocsEditor({
  section,
  isDraft,
  docOptions,
  onUpdate,
}: {
  section: Section;
  isDraft: boolean;
  docOptions: DocOption[];
  onUpdate: (p: Partial<Section>) => void;
}) {
  const docs: DocLink[] = section.data?.docs ?? [];
  const selectedIds = new Set(docs.map((d) => d.documentId));
  const byId = (docIdent: number) => docOptions.find((d) => d.id === docIdent);
  const save = (next: DocLink[]) => onUpdate({ data: { docs: next } });
  if (!isDraft)
    return docs.length ? (
      <ul className="space-y-1 text-sm">
        {docs.map((d) => {
          const o = byId(d.documentId);
          // Step 4 — flag when the referenced doc's number/title has changed since this
          // document was approved (the snapshot was frozen at approval time).
          const changed =
            !!d.snapshotTitle &&
            !!o &&
            (o.title !== d.snapshotTitle || (d.snapshotDocNumber != null && o.docNumber !== d.snapshotDocNumber));
          return (
            <li key={d.documentId}>
              <Link href={`/documents/${d.documentId}`} className="text-primary hover:underline">
                {o ? `${o.docNumber} — ${o.title}` : `Document #${d.documentId}`}
              </Link>
              {d.note ? <span className="text-muted-foreground"> — {d.note}</span> : null}
              {changed && (
                <span className="ml-2 text-xs text-amber-700" title={`At approval: ${d.snapshotDocNumber ?? ""} — ${d.snapshotTitle}`}>
                  ⚠ changed since approval (was: {d.snapshotDocNumber ? `${d.snapshotDocNumber} — ` : ""}{d.snapshotTitle})
                </span>
              )}
            </li>
          );
        })}
      </ul>
    ) : (
      <p className="text-sm text-muted-foreground italic">—</p>
    );
  const toggle = (docIdent: number) => {
    if (selectedIds.has(docIdent)) save(docs.filter((d) => d.documentId !== docIdent));
    else save([...docs, { documentId: docIdent }]);
  };
  return (
    <div className="space-y-2">
      <div className="max-h-40 overflow-y-auto rounded-md border divide-y">
        {docOptions.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">No other documents.</p>
        ) : (
          docOptions.map((o) => (
            <label key={o.id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-muted">
              <Checkbox checked={selectedIds.has(o.id)} onCheckedChange={() => toggle(o.id)} />
              <span>
                {o.docNumber} — {o.title}
              </span>
            </label>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground">Tick the controlled documents this procedure references.</p>
    </div>
  );
}
