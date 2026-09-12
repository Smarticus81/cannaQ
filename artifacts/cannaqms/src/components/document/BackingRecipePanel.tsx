import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Workflow } from "lucide-react";

// Session 60 — hybrid doc<->process bridge. Lets a controlled document be
// OPTIONALLY backed by a recipe/process. When linked, a "Process Steps (from
// recipe)" section renders the same recipe_process_steps the operator executes
// on a batch — single source of truth, no duplicated procedure text.
type Recipe = { id: number; productName: string; productType: string; version: number };

export function BackingRecipePanel({
  docId,
  currentRecipeId,
  isDraft,
}: {
  docId: number;
  currentRecipeId: number | null;
  isDraft: boolean;
}) {
  const qc = useQueryClient();
  const { data: recipes } = useQuery<Recipe[]>({
    queryKey: ["/api/recipes"],
    queryFn: async () => (await fetch("/api/recipes")).json(),
  });
  const [sel, setSel] = useState<string>(currentRecipeId ? String(currentRecipeId) : "");

  const save = useMutation({
    mutationFn: async (recipeId: number | null) => {
      const res = await fetch(`/api/documents/${docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipeId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to set backing recipe");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/documents/${docId}/process-steps`] });
      qc.invalidateQueries(); // refresh the document detail (incl. generated query)
    },
  });

  const current = (recipes ?? []).find((r) => r.id === currentRecipeId) ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <Workflow className="h-4 w-4" /> Linked Process (Recipe)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Optionally link this document to a recipe/process. A &ldquo;Process Steps (from recipe)&rdquo;
          section then renders the same steps the operator executes on a batch &mdash; single source of truth.
        </p>
        {current ? (
          <p className="text-sm">
            Linked to <span className="font-medium">{current.productName}</span>
            {current.version ? ` (v${current.version})` : ""}.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No recipe linked.</p>
        )}
        {isDraft && (
          <div className="flex gap-2 items-center">
            <Select value={sel} onValueChange={setSel}>
              <SelectTrigger className="w-72 h-9">
                <SelectValue placeholder="Select a recipe…" />
              </SelectTrigger>
              <SelectContent>
                {(recipes ?? []).map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>
                    {r.productName} ({r.productType})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={save.isPending || !sel || Number(sel) === currentRecipeId}
              onClick={() => save.mutate(Number(sel))}
            >
              Link
            </Button>
            {currentRecipeId != null && (
              <Button
                variant="outline"
                size="sm"
                disabled={save.isPending}
                onClick={() => {
                  setSel("");
                  save.mutate(null);
                }}
              >
                Clear
              </Button>
            )}
          </div>
        )}
        {save.isError && <p className="text-xs text-destructive">{(save.error as Error).message}</p>}
      </CardContent>
    </Card>
  );
}
