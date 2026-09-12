import { useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { getListBatchRecordsQueryKey } from "@workspace/api-client-react";
import {
  Upload, FileText, Loader2, CheckCircle2, AlertTriangle,
  Sparkles, ChevronDown, ChevronUp, Trash2, Plus,
} from "lucide-react";

interface ExtractedIngredient {
  ingredientName: string;
  lotNumber: string;
  plannedQuantity: string;
  actualQuantity: string;
  unitOfMeasure: string;
}

interface ExtractedData {
  batchNumber: string;
  productName: string;
  productType: string;
  batchType: string;
  strainName: string;
  productionDate: string;
  outputQuantity: string;
  unitOfMeasure: string;
  metrcPackageId: string;
  notes: string;
  testingAgency: string;
  testResult: string;
  thcPct: string;
  cbdPct: string;
  ingredients: ExtractedIngredient[];
  confidence: "high" | "medium" | "low";
  extractionNotes: string;
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function normaliseExtracted(raw: Record<string, unknown>): ExtractedData {
  const ingredients: ExtractedIngredient[] = ((raw.ingredients as unknown[]) ?? []).map(
    (ing) => {
      const i = ing as Record<string, unknown>;
      return {
        ingredientName: toStr(i.ingredientName),
        lotNumber: toStr(i.lotNumber),
        plannedQuantity: toStr(i.plannedQuantity),
        actualQuantity: toStr(i.actualQuantity),
        unitOfMeasure: toStr(i.unitOfMeasure),
      };
    }
  );

  return {
    batchNumber: toStr(raw.batchNumber),
    productName: toStr(raw.productName),
    productType: toStr(raw.productType),
    batchType: toStr(raw.batchType) || "Production",
    strainName: toStr(raw.strainName),
    productionDate: toStr(raw.productionDate),
    outputQuantity: toStr(raw.outputQuantity),
    unitOfMeasure: toStr(raw.unitOfMeasure),
    metrcPackageId: toStr(raw.metrcPackageId),
    notes: toStr(raw.notes),
    testingAgency: toStr(raw.testingAgency),
    testResult: toStr(raw.testResult),
    thcPct: toStr(raw.thcPct),
    cbdPct: toStr(raw.cbdPct),
    ingredients,
    confidence: (raw.confidence as "high" | "medium" | "low") ?? "low",
    extractionNotes: toStr(raw.extractionNotes),
  };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = "upload" | "extracting" | "review" | "saving" | "done";

export function ImportBatchDialog({ open, onOpenChange }: Props) {
  const [step, setStep] = useState<Step>("upload");
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [extracted, setExtracted] = useState<ExtractedData | null>(null);
  const [showIngredients, setShowIngredients] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleClose = () => {
    if (step === "extracting" || step === "saving") return;
    setStep("upload");
    setSelectedFile(null);
    setExtracted(null);
    setError(null);
    onOpenChange(false);
  };

  const processFile = useCallback(async (file: File) => {
    setSelectedFile(file);
    setStep("extracting");
    setError(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/batch-records/import", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Server error ${res.status}`);
      }
      const raw = await res.json() as Record<string, unknown>;
      setExtracted(normaliseExtracted(raw));
      setStep("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Extraction failed.");
      setStep("upload");
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const updateField = (field: keyof ExtractedData, value: string) => {
    setExtracted((prev) => prev ? { ...prev, [field]: value } : prev);
  };

  const updateIngredient = (idx: number, field: keyof ExtractedIngredient, value: string) => {
    setExtracted((prev) => {
      if (!prev) return prev;
      const ingredients = [...prev.ingredients];
      ingredients[idx] = { ...ingredients[idx], [field]: value };
      return { ...prev, ingredients };
    });
  };

  const addIngredient = () => {
    setExtracted((prev) =>
      prev
        ? {
            ...prev,
            ingredients: [
              ...prev.ingredients,
              { ingredientName: "", lotNumber: "", plannedQuantity: "", actualQuantity: "", unitOfMeasure: "" },
            ],
          }
        : prev
    );
  };

  const removeIngredient = (idx: number) => {
    setExtracted((prev) =>
      prev ? { ...prev, ingredients: prev.ingredients.filter((_, i) => i !== idx) } : prev
    );
  };

  const handleSave = async () => {
    if (!extracted) return;
    setStep("saving");

    try {
      const batchRes = await fetch("/api/batch-records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchNumber: extracted.batchNumber || `BTH-IMPORT-${Date.now()}`,
          productName: extracted.productName || "Imported Batch",
          productType: extracted.productType || "Unknown",
          batchType: extracted.batchType || "Production",
          strainName: extracted.strainName || null,
          productionDate: extracted.productionDate || null,
          outputQuantity: extracted.outputQuantity ? parseFloat(extracted.outputQuantity) : null,
          unitOfMeasure: extracted.unitOfMeasure || "units",
          metrcPackageId: extracted.metrcPackageId || null,
          autoMetrcPlaceholder: true,
          notes: [
            extracted.notes,
            `Imported from paper record: ${selectedFile?.name ?? "unknown file"}`,
          ].filter(Boolean).join(" | "),
          status: "in_production",
        }),
      });

      if (!batchRes.ok) {
        const body = await batchRes.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Failed to create batch record.");
      }
      const newBatch = await batchRes.json() as { id: number };
      const batchId = newBatch.id;

      const validIngredients = extracted.ingredients.filter((i) => i.ingredientName.trim());
      if (validIngredients.length > 0) {
        await Promise.all(
          validIngredients.map((ing) =>
            fetch(`/api/batch-records/${batchId}/ingredients`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ingredientName: ing.ingredientName,
                lotNumber: ing.lotNumber || null,
                plannedQuantity: ing.plannedQuantity ? parseFloat(ing.plannedQuantity) : null,
                actualQuantity: ing.actualQuantity ? parseFloat(ing.actualQuantity) : null,
                unitOfMeasure: ing.unitOfMeasure || "units",
              }),
            })
          )
        );
      }

      if (extracted.testingAgency && extracted.testResult) {
        await fetch(`/api/batch-records/${batchId}/testing`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            testingAgency: extracted.testingAgency,
            testResult: extracted.testResult || "Pending",
            thcPct: extracted.thcPct ? parseFloat(extracted.thcPct) : null,
            cbdPct: extracted.cbdPct ? parseFloat(extracted.cbdPct) : null,
          }),
        });
      }

      await queryClient.invalidateQueries({ queryKey: getListBatchRecordsQueryKey() });
      setStep("done");

      setTimeout(() => {
        handleClose();
        toast({
          title: "Batch Record Imported",
          description: `${extracted.batchNumber || "Batch"} has been created in the eQMS.`,
        });
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
      setStep("review");
    }
  };

  const confidenceColor =
    extracted?.confidence === "high"
      ? "text-emerald-700 bg-emerald-50 border-emerald-200"
      : extracted?.confidence === "medium"
      ? "text-amber-700 bg-amber-50 border-amber-200"
      : "text-red-700 bg-red-50 border-red-200";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Import Paper Batch Record
          </DialogTitle>
          <DialogDescription>
            Upload a photo or PDF of a paper batch record. AI will extract the data for your review before saving to the eQMS.
          </DialogDescription>
        </DialogHeader>

        {/* ── Upload step ── */}
        {(step === "upload" || step === "extracting") && (
          <div className="space-y-4">
            {error && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/30 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <p>{error}</p>
              </div>
            )}

            {step === "extracting" ? (
              <div className="flex flex-col items-center justify-center py-16 gap-4">
                <Loader2 className="h-10 w-10 text-primary animate-spin" />
                <div className="text-center">
                  <p className="font-semibold">Reading document with AI…</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Extracting batch fields from <span className="font-medium">{selectedFile?.name}</span>
                  </p>
                </div>
              </div>
            ) : (
              <div
                className={`border-2 border-dashed rounded-xl p-10 flex flex-col items-center justify-center gap-4 cursor-pointer transition-colors ${
                  dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:border-primary/50"
                }`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center">
                  <Upload className="h-7 w-7 text-primary" />
                </div>
                <div className="text-center">
                  <p className="font-semibold text-base">Drop your batch record here</p>
                  <p className="text-sm text-muted-foreground mt-1">or click to browse</p>
                  <p className="text-xs text-muted-foreground mt-2">Supports PDF, JPG, PNG, WEBP · Max 20 MB</p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp,.gif"
                  className="hidden"
                  onChange={handleFileInput}
                />
              </div>
            )}

            <div className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground/70">What gets extracted automatically:</p>
              <p>Batch number · Product name · Production date · Output quantity · Strain · METRC tag · Ingredients & lot numbers · Test results · Notes</p>
              <p className="mt-1">All extracted data is shown for your review before anything is saved to the eQMS.</p>
            </div>
          </div>
        )}

        {/* ── Done step ── */}
        {step === "done" && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <CheckCircle2 className="h-12 w-12 text-emerald-600" />
            <p className="font-semibold text-lg">Batch Record Created</p>
            <p className="text-sm text-muted-foreground">Redirecting you to the batch list…</p>
          </div>
        )}

        {/* ── Review step ── */}
        {(step === "review" || step === "saving") && extracted && (
          <div className="space-y-5">
            {/* Confidence banner */}
            <div className={`flex items-start gap-3 p-3 rounded-lg border text-sm ${confidenceColor}`}>
              <Sparkles className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold capitalize">AI Confidence: {extracted.confidence}</p>
                {extracted.extractionNotes && (
                  <p className="mt-0.5 opacity-80">{extracted.extractionNotes}</p>
                )}
              </div>
              <Badge variant="outline" className="ml-auto shrink-0 text-xs">
                <FileText className="h-3 w-3 mr-1" />
                {selectedFile?.name}
              </Badge>
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/30 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <p>{error}</p>
              </div>
            )}

            <p className="text-sm text-muted-foreground">
              Review and edit the extracted fields below. Everything is editable before saving.
            </p>

            {/* Core batch fields */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Batch Number</Label>
                <Input value={extracted.batchNumber} onChange={(e) => updateField("batchNumber", e.target.value)} placeholder="e.g. BTH-25-0001" />
              </div>
              <div className="space-y-1">
                <Label>Product Name</Label>
                <Input value={extracted.productName} onChange={(e) => updateField("productName", e.target.value)} placeholder="Product name" />
              </div>
              <div className="space-y-1">
                <Label>Product Type</Label>
                <Input value={extracted.productType} onChange={(e) => updateField("productType", e.target.value)} placeholder="e.g. Vape Cartridge" />
              </div>
              <div className="space-y-1">
                <Label>Batch Type</Label>
                <Select value={extracted.batchType} onValueChange={(v) => updateField("batchType", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Production">Production</SelectItem>
                    <SelectItem value="Remediation">Remediation</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Strain</Label>
                <Input value={extracted.strainName} onChange={(e) => updateField("strainName", e.target.value)} placeholder="Strain name" />
              </div>
              <div className="space-y-1">
                <Label>Production Date</Label>
                <Input type="date" value={extracted.productionDate} onChange={(e) => updateField("productionDate", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Output Quantity</Label>
                <Input type="number" value={extracted.outputQuantity} onChange={(e) => updateField("outputQuantity", e.target.value)} placeholder="0" />
              </div>
              <div className="space-y-1">
                <Label>Unit of Measure</Label>
                <Input value={extracted.unitOfMeasure} onChange={(e) => updateField("unitOfMeasure", e.target.value)} placeholder="units / g / mL" />
              </div>
              <div className="space-y-1 col-span-2">
                <Label>METRC Package ID</Label>
                <Input value={extracted.metrcPackageId} onChange={(e) => updateField("metrcPackageId", e.target.value)} placeholder="METRC package tag (optional)" className="font-mono" />
              </div>
              <div className="space-y-1 col-span-2">
                <Label>Notes</Label>
                <Textarea value={extracted.notes} onChange={(e) => updateField("notes", e.target.value)} placeholder="Batch notes" rows={2} />
              </div>
            </div>

            <Separator />

            {/* Ingredients section */}
            <div>
              <button
                type="button"
                className="flex items-center gap-2 text-sm font-semibold w-full text-left mb-3"
                onClick={() => setShowIngredients((s) => !s)}
              >
                {showIngredients ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                Ingredients / Bill of Materials ({extracted.ingredients.length} items)
              </button>

              {showIngredients && (
                <div className="space-y-2">
                  {extracted.ingredients.map((ing, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2 items-end p-3 bg-muted/30 rounded-lg">
                      <div className="col-span-4 space-y-1">
                        <Label className="text-xs">Ingredient</Label>
                        <Input
                          value={ing.ingredientName}
                          onChange={(e) => updateIngredient(idx, "ingredientName", e.target.value)}
                          placeholder="Ingredient name"
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="col-span-2 space-y-1">
                        <Label className="text-xs">METRC / Lot tag</Label>
                        <Input
                          value={ing.lotNumber}
                          onChange={(e) => updateIngredient(idx, "lotNumber", e.target.value)}
                          placeholder="1A… or lot #"
                          className="h-8 text-sm font-mono"
                        />
                      </div>
                      <div className="col-span-2 space-y-1">
                        <Label className="text-xs">Planned</Label>
                        <Input
                          type="number"
                          value={ing.plannedQuantity}
                          onChange={(e) => updateIngredient(idx, "plannedQuantity", e.target.value)}
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="col-span-2 space-y-1">
                        <Label className="text-xs">Actual</Label>
                        <Input
                          type="number"
                          value={ing.actualQuantity}
                          onChange={(e) => updateIngredient(idx, "actualQuantity", e.target.value)}
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="col-span-1 space-y-1">
                        <Label className="text-xs">UoM</Label>
                        <Input
                          value={ing.unitOfMeasure}
                          onChange={(e) => updateIngredient(idx, "unitOfMeasure", e.target.value)}
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="col-span-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => removeIngredient(idx)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={addIngredient}>
                    <Plus className="h-3.5 w-3.5" />
                    Add Ingredient
                  </Button>
                </div>
              )}
            </div>

            {/* Testing section (if extracted) */}
            {(extracted.testingAgency || extracted.testResult || extracted.thcPct) && (
              <>
                <Separator />
                <div>
                  <p className="text-sm font-semibold mb-3">Testing Information</p>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-1">
                      <Label>Testing Agency</Label>
                      <Input value={extracted.testingAgency} onChange={(e) => updateField("testingAgency", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <Label>Result</Label>
                      <Select value={extracted.testResult} onValueChange={(v) => updateField("testResult", v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Pass">Pass</SelectItem>
                          <SelectItem value="Fail">Fail</SelectItem>
                          <SelectItem value="Pending">Pending</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label>THC %</Label>
                      <Input type="number" step="0.1" value={extracted.thcPct} onChange={(e) => updateField("thcPct", e.target.value)} />
                    </div>
                  </div>
                </div>
              </>
            )}

            <Separator />

            <div className="flex justify-between items-center pt-2">
              <Button variant="outline" onClick={() => { setStep("upload"); setExtracted(null); setError(null); }}>
                ← Re-upload
              </Button>
              <Button
                onClick={handleSave}
                disabled={step === "saving"}
                className="gap-2"
              >
                {step === "saving" ? (
                  <><Loader2 className="h-4 w-4 animate-spin" />Saving…</>
                ) : (
                  <><CheckCircle2 className="h-4 w-4" />Save to eQMS</>
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
