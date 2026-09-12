import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FlaskConical, Copy, ExternalLink, Download, Printer } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { useGetCurrentUser } from "@workspace/api-client-react";

type LabelData = {
  batchId: number;
  batchNumber: string;
  productName: string;
  productType: string;
  labelNetWeight: number | null;
  labelNetWeightUnit: string | null;
  recipeNetWeight: number | null;
  recipeNetWeightUnit: string | null;
  testing: {
    sequenceNumber: number;
    testingAgency: string;
    resultDate: string | null;
    testResult: string;
    // Session 66 — potency basis: "percent" (flower/concentrate, % + mg/g) or
    // "mg_per_serving" (edibles). Drives which fields below carry values.
    potencyBasis: "percent" | "mg_per_serving";
    thcPct: number | null;
    cbdPct: number | null;
    totalCannabinoids: number | null;
    thcMgPerGram: number | null;
    cbdMgPerGram: number | null;
    thcMgPerServing: number | null;
    cbdMgPerServing: number | null;
    totalCannabinoidsMgPerServing: number | null;
    coaUrl: string | null;
    microbialsPass: boolean | null;
    pesticidesPass: boolean | null;
    heavyMetalsPass: boolean | null;
    residualSolventsPass: boolean | null;
  } | null;
  ingredients: Array<{
    id: number; ingredientName: string; quantity: number;
    unitOfMeasure: string; lotNumber: string | null;
  }>;
};

function fmt(n: number | null, suffix = "") {
  return n == null ? "—" : `${n}${suffix}`;
}

function passBadge(v: boolean | null, label: string) {
  if (v === null) return <Badge variant="outline" className="text-xs">{label}: n/a</Badge>;
  return v
    ? <Badge variant="default" className="text-xs">{label}: Pass</Badge>
    : <Badge variant="destructive" className="text-xs">{label}: Fail</Badge>;
}

type PrintRun = {
  id: number;
  printedById: number | null;
  printedByName: string | null;
  printedAt: string;
  rowCount: number | null;
  exportFormat: string | null;
  reviewStatus: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewerInitials: string | null;
};

export function LabelDataPanel({ batchId }: { batchId: number }) {
  const { toast } = useToast();
  const [data, setData] = useState<LabelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [runs, setRuns] = useState<PrintRun[]>([]);
  const [reviewing, setReviewing] = useState<PrintRun | null>(null);
  const currentUser = useGetCurrentUser().data;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/batch-records/${batchId}/label-data`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [batchId]);

  // #3 - every data-file download is logged as a print run needing a
  // second-person review; list them here newest-first.
  const loadRuns = useCallback(() => {
    fetch(`/api/batch-records/${batchId}/label-print-runs`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setRuns(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  }, [batchId]);
  useEffect(() => { loadRuns(); }, [loadRuns]);

  if (loading) return <Card><CardContent className="py-6"><Skeleton className="h-32 w-full" /></CardContent></Card>;
  if (!data) return null;

  const ingredientsLine = data.ingredients
    .map((i) => i.ingredientName)
    .filter(Boolean)
    .join(", ");

  function copyLabelText() {
    const lines: string[] = [];
    lines.push(data!.productName);
    if (data!.testing) {
      const t = data!.testing;
      if (t.potencyBasis === "mg_per_serving") {
        if (t.thcMgPerServing != null) lines.push(`THC: ${t.thcMgPerServing} mg/serving`);
        if (t.cbdMgPerServing != null) lines.push(`CBD: ${t.cbdMgPerServing} mg/serving`);
        if (t.totalCannabinoidsMgPerServing != null) lines.push(`Total Cannabinoids: ${t.totalCannabinoidsMgPerServing} mg/serving`);
      } else {
        if (t.thcPct != null) lines.push(`THC: ${t.thcPct}% (${t.thcMgPerGram} mg/g)`);
        if (t.cbdPct != null) lines.push(`CBD: ${t.cbdPct}% (${t.cbdMgPerGram} mg/g)`);
        if (t.totalCannabinoids != null) lines.push(`Total Cannabinoids: ${t.totalCannabinoids}%`);
      }
    }
    if (ingredientsLine) lines.push(`Ingredients: ${ingredientsLine}`);
    void navigator.clipboard.writeText(lines.join("\n"));
    toast({ title: "Label text copied" });
  }

  // Download the per-package data file (CSV) for this batch. This is the file
  // the facility's own label software merges into its approved template — one
  // row per METRC package tag, keyed to the tag. Fetched as a blob so the
  // browser saves it with the filename the server sets.
  async function downloadDataFile() {
    try {
      const res = await fetch(`/api/batch-records/${batchId}/label-export?format=csv`, { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `label-data_${data!.batchNumber}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "Label data file downloaded" });
      loadRuns();
    } catch {
      toast({ title: "Could not download label data file", variant: "destructive" });
    }
  }

  // Second person signs off that a print run was verified (21 CFR Part 11).
  async function submitReview(initials: string, meaning: string) {
    if (!reviewing) return;
    const res = await fetch(`/api/batch-label-prints/${reviewing.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ initials, signatureMeaning: meaning }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({} as { error?: string }));
      toast({ title: "Review failed", description: e?.error ?? "Unknown error", variant: "destructive" });
      throw new Error(e?.error ?? "review failed");
    }
    toast({ title: "Print run reviewed" });
    setReviewing(null);
    loadRuns();
  }

  // Open the batch's label PDF. Production (draft=false) renders the real,
  // non-DRAFT label through the approved product-type template and is gated on
  // the R 420.504 checklist + an approved template/blocks; a 409 explains what's
  // missing. draft=true is a QA preview (DRAFT watermark, gates bypassed).
  async function openLabelPdf(draft: boolean) {
    try {
      const res = await fetch(`/api/batch-records/${batchId}/label.pdf${draft ? "?draft=1" : ""}`, { credentials: "include" });
      if (!res.ok) {
        const msg = ((await res.json().catch(() => ({}))) as { error?: string })?.error || "Could not generate the label PDF.";
        toast({ title: draft ? "Draft preview unavailable" : "Label not ready to print", description: msg, variant: "destructive" });
        return;
      }
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), "_blank");
      if (!draft) loadRuns();
    } catch {
      toast({ title: "Could not generate the label PDF", variant: "destructive" });
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <FlaskConical className="h-4 w-4" />
          Label Data (auto-populated)
        </CardTitle>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={copyLabelText}>
            <Copy className="h-4 w-4 mr-1" />Copy label text
          </Button>
          <Button variant="outline" size="sm" onClick={downloadDataFile}>
            <Download className="h-4 w-4 mr-1" />Download data file
          </Button>
          <Button variant="outline" size="sm" onClick={() => openLabelPdf(true)}>
            <ExternalLink className="h-4 w-4 mr-1" />Draft preview
          </Button>
          <Button size="sm" onClick={() => openLabelPdf(false)}>
            <Printer className="h-4 w-4 mr-1" />Print label
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!data.testing ? (
          <div className="text-sm text-muted-foreground">
            No test results available. Add a passing test result to populate cannabinoid potency on the label.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              {data.testing.potencyBasis === "mg_per_serving" ? (
                <>
                  <div>
                    <div className="text-xs text-muted-foreground">THC</div>
                    <div className="font-semibold">{fmt(data.testing.thcMgPerServing, " mg/serving")}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">CBD</div>
                    <div className="font-semibold">{fmt(data.testing.cbdMgPerServing, " mg/serving")}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Total Cannabinoids</div>
                    <div className="font-semibold">{fmt(data.testing.totalCannabinoidsMgPerServing, " mg/serving")}</div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <div className="text-xs text-muted-foreground">THC</div>
                    <div className="font-semibold">{fmt(data.testing.thcPct, "%")}</div>
                    <div className="text-xs text-muted-foreground">{fmt(data.testing.thcMgPerGram, " mg/g")}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">CBD</div>
                    <div className="font-semibold">{fmt(data.testing.cbdPct, "%")}</div>
                    <div className="text-xs text-muted-foreground">{fmt(data.testing.cbdMgPerGram, " mg/g")}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Total Cannabinoids</div>
                    <div className="font-semibold">{fmt(data.testing.totalCannabinoids, "%")}</div>
                  </div>
                </>
              )}
              <div>
                <div className="text-xs text-muted-foreground">Test Result</div>
                <Badge variant={data.testing.testResult === "Pass" ? "default" : data.testing.testResult === "Fail" ? "destructive" : "secondary"}>
                  {data.testing.testResult}
                </Badge>
                <div className="text-xs text-muted-foreground mt-1">
                  {data.testing.testingAgency}
                  {data.testing.resultDate ? ` · ${data.testing.resultDate}` : ""}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {passBadge(data.testing.microbialsPass, "Microbials")}
              {passBadge(data.testing.pesticidesPass, "Pesticides")}
              {passBadge(data.testing.heavyMetalsPass, "Heavy Metals")}
              {passBadge(data.testing.residualSolventsPass, "Solvents")}
              {data.testing.coaUrl && (
                <a href={data.testing.coaUrl} target="_blank" rel="noreferrer" className="text-xs text-primary inline-flex items-center hover:underline">
                  COA <ExternalLink className="h-3 w-3 ml-0.5" />
                </a>
              )}
            </div>
          </div>
        )}

        <div>
          <div className="text-sm font-medium mb-2">Ingredients (descending order by weight)</div>
          {data.ingredients.length === 0 ? (
            <div className="text-sm text-muted-foreground">No ingredients recorded for this batch.</div>
          ) : (
            <ol className="text-sm space-y-1 list-decimal list-inside">
              {data.ingredients.map((ing) => (
                <li key={ing.id}>
                  <span className="font-medium">{ing.ingredientName}</span>
                  <span className="text-muted-foreground"> — {ing.quantity} {ing.unitOfMeasure}</span>
                  {ing.lotNumber && <span className="text-xs text-muted-foreground font-mono"> (lot {ing.lotNumber})</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
        <div>
          <div className="text-sm font-medium mb-2">Print runs (each data-file download needs a second-person review)</div>
          {runs.length === 0 ? (
            <div className="text-sm text-muted-foreground">No print runs yet. Downloading the data file records a run for review.</div>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => {
                const reviewed = run.reviewStatus === "reviewed";
                const isOwnPrint = currentUser?.id != null && run.printedById === currentUser.id;
                const canReview = !!currentUser && ["Quality", "Supervisor", "Admin"].includes(currentUser.role) && !isOwnPrint;
                return (
                  <div key={run.id} className="flex items-center justify-between gap-2 rounded border p-2 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium">
                        {(run.exportFormat ?? "csv").toUpperCase()} · {run.rowCount ?? "?"} labels
                        <span className="text-muted-foreground font-normal"> · {run.printedByName ?? "\u2014"} · {new Date(run.printedAt).toLocaleString()}</span>
                      </div>
                      {reviewed ? (
                        <div className="text-xs text-green-700">Reviewed by {run.reviewedByName} ({run.reviewerInitials}){run.reviewedAt ? ` \u00b7 ${new Date(run.reviewedAt).toLocaleString()}` : ""}</div>
                      ) : (
                        <div className="text-xs text-amber-700">Pending second-person review</div>
                      )}
                    </div>
                    <div className="shrink-0">
                      {reviewed ? (
                        <Badge className="bg-green-50 text-green-700 border-green-200">Reviewed</Badge>
                      ) : canReview ? (
                        <Button size="sm" variant="outline" onClick={() => setReviewing(run)}>Review</Button>
                      ) : (
                        <Badge variant="secondary" title={isOwnPrint ? "The reviewer must be someone other than who ran the print." : "Requires Quality, Supervisor, or Admin."}>Pending</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <Part11SignatureDialog
          open={reviewing !== null}
          onOpenChange={(o) => { if (!o) setReviewing(null); }}
          title="Label Print Review"
          description="By signing, you confirm you verified this print run's labels against the approved template and the batch data - correct content, potency, and package tags. Second-person review of every print run (21 CFR Part 11)."
          onSign={submitReview}
          isPending={false}
        />
      </CardContent>
    </Card>
  );
}
