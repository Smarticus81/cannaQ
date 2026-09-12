import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, GripVertical, FileCog } from "lucide-react";

const KINDS = [
  { value: "header",             label: "Header (auto)" },
  { value: "ingredients",        label: "Ingredients & Materials (auto)" },
  // Session 112 — packaging lots and the compliance label print as their own
  // section, matching the batch screen's Packaging tab. Without this section in
  // a template those lines don't print at all, since the Ingredients section
  // now covers only what's weighed out during manufacturing.
  { value: "packaging",          label: "Packaging & Labels (auto)" },
  { value: "in_process_checks",  label: "In-Process Checks (auto)" },
  { value: "tests",              label: "Tests (auto)" },
  { value: "yield",              label: "Yield (auto)" },
  { value: "signoffs",           label: "Sign-offs (auto)" },
  { value: "room_environmental", label: "Room / Environmental" },
  { value: "equipment",          label: "Equipment" },
  { value: "free_text",          label: "Free Text" },
  { value: "process_steps",      label: "Process Steps (from recipe)" },
] as const;
type Kind = typeof KINDS[number]["value"];

const KIND_LABEL: Record<string, string> = Object.fromEntries(KINDS.map(k => [k.value, k.label]));

type Section = {
  id: number;
  documentId: number;
  sortOrder: number;
  kind: Kind;
  title: string;
  bodyMarkdown: string | null;
};

export function DocumentSectionsPanel({ docId, isDraft }: { docId: number; isDraft: boolean }) {
  const qc = useQueryClient();
  const { data: sections } = useQuery<Section[]>({
    queryKey: [`/api/documents/${docId}/sections`],
    queryFn: async () => (await fetch(`/api/documents/${docId}/sections`)).json(),
  });

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
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/documents/${docId}/sections`] }),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/documents/${docId}/sections`] }),
  });

  const removeSection = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/document-sections/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove section");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/documents/${docId}/sections`] }),
  });

  const sorted = (sections ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <FileCog className="h-4 w-4" /> Spec Sections
        </CardTitle>
        {isDraft && (
          <NewSectionInline
            existingCount={sorted.length}
            onAdd={(body) => addSection.mutate(body)}
            disabled={addSection.isPending}
          />
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          These sections render in the Print Batch Record when a batch links to this Spec.
          Auto sections (Header, Ingredients, etc.) pull data from the batch; free-text sections
          render verbatim. Sections are editable only while the document is in Draft.
        </p>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No sections yet.</p>
        ) : (
          <div className="space-y-2">
            {sorted.map(s => (
              <SectionRow
                key={s.id}
                section={s}
                docId={docId}
                isDraft={isDraft}
                onUpdate={(patch) => updateSection.mutate({ id: s.id, patch })}
                onRemove={() => removeSection.mutate(s.id)}
                onMoveUp={() => {
                  const idx = sorted.findIndex(x => x.id === s.id);
                  if (idx > 0) updateSection.mutate({ id: s.id, patch: { sortOrder: sorted[idx-1].sortOrder - 1 } });
                }}
                onMoveDown={() => {
                  const idx = sorted.findIndex(x => x.id === s.id);
                  if (idx < sorted.length - 1) updateSection.mutate({ id: s.id, patch: { sortOrder: sorted[idx+1].sortOrder + 1 } });
                }}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NewSectionInline({
  existingCount, onAdd, disabled,
}: {
  existingCount: number;
  onAdd: (body: Partial<Section>) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("free_text");
  const [title, setTitle] = useState("");
  if (!open) return (
    <Button size="sm" onClick={() => setOpen(true)}>
      <Plus className="h-4 w-4 mr-1" /> Add Section
    </Button>
  );
  return (
    <div className="flex gap-2 items-center">
      <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
        <SelectTrigger className="w-44 h-9"><SelectValue /></SelectTrigger>
        <SelectContent>{KINDS.map(k => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}</SelectContent>
      </Select>
      <Input className="h-9 w-48" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Section title" />
      <Button size="sm" disabled={disabled || !title.trim()} onClick={() => {
        onAdd({ kind, title: title.trim(), sortOrder: existingCount * 10 });
        setTitle(""); setOpen(false);
      }}>Add</Button>
      <Button variant="outline" size="sm" onClick={() => { setOpen(false); setTitle(""); }}>Cancel</Button>
    </div>
  );
}

function SectionRow({
  section, docId, isDraft, onUpdate, onRemove, onMoveUp, onMoveDown,
}: {
  section: Section;
  docId: number;
  isDraft: boolean;
  onUpdate: (patch: Partial<Section>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [title, setTitle] = useState(section.title);
  const [body, setBody] = useState(section.bodyMarkdown ?? "");
  const isAuto = section.kind !== "free_text" && section.kind !== "room_environmental" && section.kind !== "equipment";

  return (
    <div className="border rounded-md p-3 space-y-2">
      <div className="flex items-start gap-2">
        {isDraft && (
          <div className="flex flex-col gap-1 mt-1">
            <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onMoveUp}><GripVertical className="h-3 w-3 rotate-180" /></Button>
            <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onMoveDown}><GripVertical className="h-3 w-3" /></Button>
          </div>
        )}
        <Badge variant="outline" className="shrink-0">{KIND_LABEL[section.kind] ?? section.kind}</Badge>
        <Input
          className="h-8 flex-1"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title !== section.title && onUpdate({ title })}
          disabled={!isDraft}
        />
        {isDraft && (
          <Button variant="ghost" size="icon" onClick={onRemove}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        )}
      </div>
      {section.kind === "process_steps" && <ProcessStepsPreview docId={docId} />}
      <Textarea
        className="text-sm"
        rows={isAuto ? 2 : 4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onBlur={() => (body || "") !== (section.bodyMarkdown ?? "") && onUpdate({ bodyMarkdown: body || null })}
        placeholder={
          isAuto
            ? "Optional supplementary notes (rendered after the auto-generated content)"
            : "Section body — rendered verbatim in the Print Batch Record"
        }
        disabled={!isDraft}
      />
    </div>
  );
}

// Session 60 — renders the backing recipe's process steps for a "process_steps"
// section. The steps are fetched live from the linked recipe, so the procedure
// shown in the controlled document is the SAME source the operator executes on a
// batch (single source of truth). Read-only here; edits happen on the recipe.
function ProcessStepsPreview({ docId }: { docId: number }) {
  const { data } = useQuery<{
    recipeId: number | null;
    recipe: { productName: string; version: number } | null;
    steps: Array<{ id: number; stepNumber: number; description: string; template: string | null }>;
  }>({
    queryKey: [`/api/documents/${docId}/process-steps`],
    queryFn: async () => (await fetch(`/api/documents/${docId}/process-steps`)).json(),
  });
  if (!data) return <p className="text-xs text-muted-foreground">Loading process steps…</p>;
  if (!data.recipeId)
    return (
      <p className="text-xs text-amber-600">
        No backing recipe linked. Set this document's backing recipe to render its process steps here.
      </p>
    );
  if (!data.steps?.length)
    return <p className="text-xs text-muted-foreground">The linked recipe has no process steps.</p>;
  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2">
      <p className="text-xs text-muted-foreground">
        Rendered from recipe <span className="font-medium">{data.recipe?.productName}</span>
        {data.recipe?.version ? ` (v${data.recipe.version})` : ""} — the same steps the operator executes on a batch.
      </p>
      <ol className="list-decimal pl-5 space-y-1 text-sm">
        {data.steps.map((s) => (
          <li key={s.id}>
            <span className="font-medium">{s.description}</span>
            {s.template ? <span className="text-muted-foreground"> — {s.template}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
