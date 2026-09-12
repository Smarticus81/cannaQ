import { useState, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DepartmentPicker } from "@/components/DepartmentPicker";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Upload, Sparkles } from "lucide-react";

const REVIEW_INTERVALS = [1, 2, 3];

// Upload a Word/PDF SOP that follows the controlled-document template; the AI
// extracts each section and creates a pre-filled DRAFT. On success we navigate to
// that draft so the author reviews/edits before routing for approval.
export function ImportDocumentDialog() {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [ownerName, setOwnerName] = useState("");
  const [interval, setInterval] = useState("3");
  const [departments, setDepartments] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const reset = () => {
    setFile(null);
    setOwnerName("");
    setInterval("3");
    setDepartments([]);
    if (inputRef.current) inputRef.current.value = "";
  };

  const submit = async () => {
    if (!file) {
      toast({ title: "Choose a Word or PDF file first", variant: "destructive" });
      return;
    }
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (ownerName.trim()) fd.append("ownerName", ownerName.trim());
      fd.append("reviewIntervalYears", interval);
      fd.append("departments", JSON.stringify(departments));
      const res = await fetch("/api/documents/import", { method: "POST", credentials: "include", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: "Import failed", description: data?.error ?? "Please try again.", variant: "destructive" });
        return;
      }
      qc.invalidateQueries();
      toast({
        title: "Document imported",
        description: `${data.docNumber ?? "Draft"} created with ${data.sections ?? 0} section(s)${
          data.confidence ? ` · ${data.confidence} confidence` : ""
        }. Review and edit before routing for approval.`,
      });
      setOpen(false);
      reset();
      if (data.id) setLocation(`/documents/${data.id}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-1.5">
          <Sparkles className="h-4 w-4" /> Import from File
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import Document from File</DialogTitle>
          <DialogDescription>
            Upload a Word (.docx) or PDF procedure. The system reads each template section (Purpose, Scope,
            Definitions, Materials, Safety, Procedure) and creates a Draft you can review and edit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted"
          />
          {file && <p className="text-xs text-muted-foreground">Selected: {file.name}</p>}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="imp-owner" className="text-xs">Document Owner</Label>
              <Input id="imp-owner" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="e.g. Quality Manager" className="text-sm" />
            </div>
            <div>
              <Label htmlFor="imp-interval" className="text-xs">Periodic Review Timeframe</Label>
              <Select value={interval} onValueChange={setInterval}>
                <SelectTrigger id="imp-interval" className="text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REVIEW_INTERVALS.map((y) => (
                    <SelectItem key={y} value={String(y)}>{y} {y === 1 ? "year" : "years"}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-xs">Department(s)</Label>
            <div className="mt-1"><DepartmentPicker value={departments} onChange={setDepartments} /></div>
          </div>

          <p className="text-xs text-muted-foreground">
            Nothing is approved automatically — you land in an editable Draft to check every section first. You can also change these later.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={importing}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={importing || !file} className="gap-1.5">
            <Upload className="h-4 w-4" />
            {importing ? "Extracting…" : "Import & Extract"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
