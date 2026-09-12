import { useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Paperclip,
  Upload,
  FileText,
  Image as ImageIcon,
  Trash2,
  Lock,
  History,
  Download,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type AttachmentRow = {
  id: number;
  parentTable: string;
  parentId: number;
  kind: "primary" | "supplementary" | string;
  objectPath: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  description: string | null;
  status: "Active" | "Superseded" | "Voided" | string;
  uploadedByUserId: number | null;
  uploadedByName: string;
  uploadedAt: string;
  supersededByAttachmentId: number | null;
  documentRevisionSnapshot: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  voidedReason: string | null;
};

type Props = {
  parentTable: string;
  parentId: number;
  /** When true, show a single "Primary File" slot above the supplementary list. Documents only. */
  showPrimarySlot?: boolean;
  /** When true, primary file uploads are locked (e.g. document is not in Draft). */
  primaryLocked?: boolean;
  /** Lock-reason hint shown to user. */
  primaryLockReason?: string;
  /** Default: true. When false, hides the supplementary upload section entirely. */
  allowSupplementary?: boolean;
  /** Current user's CannaQ id — needed for uploader-self-void permission. */
  currentUserId?: number;
  /** Current user's role — Supervisor/Manager/Quality/Admin can void any attachment. */
  currentUserRole?: string;
  /** Optional title override. */
  title?: string;
  /** Reports the number of Active attachments whenever it changes. */
  onActiveCountChange?: (activeCount: number) => void;
};

const APPROVER_ROLES = new Set(["Supervisor", "Manager", "Quality", "Admin"]);

const MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXACT = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
]);
function isAllowedType(ct: string): boolean {
  if (!ct) return false;
  if (ALLOWED_EXACT.has(ct)) return true;
  return ct.startsWith("image/");
}

const BASE = import.meta.env.BASE_URL ?? "/";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function iconFor(ct: string) {
  if (ct.startsWith("image/")) return <ImageIcon className="h-4 w-4 text-blue-600" />;
  return <FileText className="h-4 w-4 text-slate-600" />;
}

export function AttachmentsPanel({
  parentTable,
  parentId,
  showPrimarySlot = false,
  primaryLocked = false,
  primaryLockReason,
  allowSupplementary = true,
  currentUserId,
  currentUserRole,
  title,
  onActiveCountChange,
}: Props) {
  const canVoidAttachment = (a: AttachmentRow): boolean => {
    if (currentUserRole && APPROVER_ROLES.has(currentUserRole)) return true;
    return typeof currentUserId === "number" && a.uploadedByUserId === currentUserId;
  };
  const { toast } = useToast();
  const [rows, setRows] = useState<AttachmentRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [uploading, setUploading] = useState<"primary" | "supplementary" | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const primaryInputRef = useRef<HTMLInputElement>(null);
  const supplementaryInputRef = useRef<HTMLInputElement>(null);
  const [voidTarget, setVoidTarget] = useState<AttachmentRow | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidInitials, setVoidInitials] = useState("");
  const [voidMeaning, setVoidMeaning] = useState("");
  const [voidErr, setVoidErr] = useState("");
  const [voidPending, setVoidPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${BASE}api/attachments?parentTable=${encodeURIComponent(parentTable)}&parentId=${parentId}&includeInactive=1`, {
      credentials: "include",
    })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(await r.json().catch(() => ({})))))
      .then((data: AttachmentRow[]) => { if (!cancelled) setRows(data); })
      .catch((err) => {
        if (cancelled) return;
        setRows([]);
        toast({ title: "Failed to load attachments", description: err?.error ?? "Unknown error", variant: "destructive" });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [parentTable, parentId, refreshKey, toast]);

  const active = (rows ?? []).filter((r) => r.status === "Active");
  const inactive = (rows ?? []).filter((r) => r.status !== "Active");
  const activePrimary = active.find((r) => r.kind === "primary");
  const activeSupplementary = active.filter((r) => r.kind === "supplementary");

  const activeCount = active.length;
  useEffect(() => {
    onActiveCountChange?.(activeCount);
  }, [activeCount, onActiveCountChange]);

  const handleUpload = async (file: File, kind: "primary" | "supplementary") => {
    if (file.size > MAX_BYTES) {
      toast({ title: "File too large", description: `Max 50 MB. This file is ${fmtBytes(file.size)}.`, variant: "destructive" });
      return;
    }
    if (!isAllowedType(file.type)) {
      toast({ title: "File type not allowed", description: `"${file.type || "unknown"}" is not in the safelist.`, variant: "destructive" });
      return;
    }
    setUploading(kind);
    setUploadProgress(0);
    try {
      // 1. Upload the file to our server; the bytes are stored in the Postgres DB.
      const fd = new FormData();
      fd.append("file", file);
      const up = await fetch(`${BASE}api/storage/upload`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      const upData = await up.json().catch(() => ({}));
      if (!up.ok) throw new Error(upData.error ?? "Upload failed");

      // 2. Record the attachment metadata row.
      const r3 = await fetch(`${BASE}api/attachments`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentTable,
          parentId,
          kind,
          objectPath: upData.objectPath,
          fileName: upData.fileName ?? file.name,
          contentType: upData.contentType ?? file.type,
          sizeBytes: upData.sizeBytes ?? file.size,
        }),
      });
      const d3 = await r3.json();
      if (!r3.ok) throw new Error(d3.error ?? "Failed to record attachment");

      toast({
        title: kind === "primary" ? "Primary file uploaded" : "File attached",
        description: file.name,
      });
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setUploading(null);
      setUploadProgress(0);
      if (primaryInputRef.current) primaryInputRef.current.value = "";
      if (supplementaryInputRef.current) supplementaryInputRef.current.value = "";
    }
  };

  const closeVoidDialog = () => {
    setVoidTarget(null);
    setVoidReason("");
    setVoidInitials("");
    setVoidMeaning("");
    setVoidErr("");
    setVoidPending(false);
  };

  const handleVoidSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setVoidErr("");
    if (!voidTarget) return;
    if (!voidReason.trim()) { setVoidErr("Reason is required."); return; }
    if (voidInitials.trim().length < 2 || voidInitials.trim().length > 4) {
      setVoidErr("Initials must be 2–4 characters."); return;
    }
    if (!voidMeaning.trim()) { setVoidErr("Signing statement is required."); return; }
    setVoidPending(true);
    try {
      const r = await fetch(`${BASE}api/attachments/${voidTarget.id}/void`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: voidReason.trim(),
          initials: voidInitials.trim().toUpperCase(),
          meaning: voidMeaning.trim(),
        }),
      });
      const data = await r.json();
      if (!r.ok) { setVoidErr(data.error ?? "Void failed"); return; }
      toast({ title: "Attachment voided", description: voidTarget.fileName });
      closeVoidDialog();
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setVoidErr(err instanceof Error ? err.message : "Void failed");
    } finally {
      setVoidPending(false);
    }
  };

  const downloadHref = (objectPath: string) => `${BASE}api/storage${objectPath}`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Paperclip className="h-4 w-4" />
            {title ?? "Attachments"}
          </span>
          {inactive.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowHistory((s) => !s)}
              data-testid="button-toggle-attachment-history"
            >
              <History className="h-3.5 w-3.5 mr-1" />
              {showHistory ? "Hide history" : `Show history (${inactive.length})`}
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Skeleton className="h-12 w-full" />
        ) : (
          <>
            {showPrimarySlot && (
              <div className="border rounded-md p-3 bg-muted/30">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1">
                  Primary File
                  {primaryLocked && <Lock className="h-3 w-3 text-amber-600" />}
                </p>
                {activePrimary ? (
                  <div className="flex items-center gap-2">
                    {iconFor(activePrimary.contentType)}
                    <a
                      href={downloadHref(activePrimary.objectPath)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-blue-700 hover:underline truncate flex-1"
                      data-testid="link-primary-attachment"
                    >
                      {activePrimary.fileName}
                    </a>
                    <span className="text-xs text-muted-foreground">{fmtBytes(activePrimary.sizeBytes)}</span>
                    {activePrimary.documentRevisionSnapshot && (
                      <Badge variant="secondary" className="text-xs">
                        Locked to Rev {activePrimary.documentRevisionSnapshot}
                      </Badge>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">No primary file uploaded yet.</p>
                )}
                {!primaryLocked ? (
                  <div className="mt-2">
                    <input
                      ref={primaryInputRef}
                      type="file"
                      className="hidden"
                      accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,image/*"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleUpload(f, "primary");
                      }}
                      data-testid="input-primary-file"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => primaryInputRef.current?.click()}
                      disabled={uploading !== null}
                      data-testid="button-upload-primary"
                    >
                      <Upload className="h-3.5 w-3.5 mr-1" />
                      {activePrimary ? "Replace primary file" : "Upload primary file"}
                    </Button>
                    {uploading === "primary" && (
                      <span className="ml-2 text-xs text-muted-foreground">Uploading…</span>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-amber-700 italic">
                    {primaryLockReason ?? "Primary file is locked."}
                  </p>
                )}
              </div>
            )}

            {allowSupplementary && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  {showPrimarySlot ? "Supplementary Files" : "Files"} ({activeSupplementary.length})
                </p>
                <div className="space-y-1">
                  {activeSupplementary.length === 0 && (
                    <p className="text-sm text-muted-foreground italic">No files attached.</p>
                  )}
                  {activeSupplementary.map((a) => (
                    <div key={a.id} className="flex items-center gap-2 border rounded p-2 bg-card">
                      {iconFor(a.contentType)}
                      <a
                        href={downloadHref(a.objectPath)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-blue-700 hover:underline flex-1 truncate"
                        data-testid={`link-attachment-${a.id}`}
                      >
                        {a.fileName}
                      </a>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtBytes(a.sizeBytes)}</span>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        by {a.uploadedByName}
                      </span>
                      <a href={downloadHref(a.objectPath)} target="_blank" rel="noopener noreferrer">
                        <Button size="icon" variant="ghost" className="h-7 w-7">
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                      </a>
                      {canVoidAttachment(a) && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-red-600 hover:text-red-700"
                          onClick={() => setVoidTarget(a)}
                          data-testid={`button-void-attachment-${a.id}`}
                          title="Void this attachment (Part 11 e-sig)"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-2">
                  <input
                    ref={supplementaryInputRef}
                    type="file"
                    className="hidden"
                    accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,image/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUpload(f, "supplementary");
                    }}
                    data-testid="input-supplementary-file"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => supplementaryInputRef.current?.click()}
                    disabled={uploading !== null}
                    data-testid="button-upload-supplementary"
                  >
                    <Upload className="h-3.5 w-3.5 mr-1" />
                    Attach file
                  </Button>
                  {uploading === "supplementary" && (
                    <span className="ml-2 text-xs text-muted-foreground">Uploading…</span>
                  )}
                  <span className="ml-3 text-xs text-muted-foreground">
                    Max 50 MB · PDF, Word, Excel, CSV, images
                  </span>
                </div>
              </div>
            )}

            {showHistory && inactive.length > 0 && (
              <div className="border-t pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  History ({inactive.length})
                </p>
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {inactive.map((a) => (
                    <div key={a.id} className="text-xs border rounded p-2 bg-muted/40">
                      <div className="flex items-center gap-2">
                        {iconFor(a.contentType)}
                        <a
                          href={downloadHref(a.objectPath)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-700 hover:underline truncate flex-1"
                        >
                          {a.fileName}
                        </a>
                        <Badge variant={a.status === "Voided" ? "destructive" : "secondary"} className="text-[10px]">
                          {a.status}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground mt-1">
                        Uploaded by {a.uploadedByName} on {fmtDate(a.uploadedAt)}
                        {a.kind === "primary" && a.documentRevisionSnapshot && (
                          <> · Rev {a.documentRevisionSnapshot}</>
                        )}
                      </p>
                      {a.status === "Voided" && (
                        <p className="text-red-700 mt-0.5">
                          Voided by {a.voidedByName} on {a.voidedAt && fmtDate(a.voidedAt)} — {a.voidedReason}
                        </p>
                      )}
                      {a.status === "Superseded" && a.supersededByAttachmentId && (
                        <p className="text-amber-700 mt-0.5">
                          Superseded by attachment #{a.supersededByAttachmentId}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={voidTarget !== null} onOpenChange={(o) => { if (!o) closeVoidDialog(); }}>
        <DialogContent className="sm:max-w-[460px]">
          <form onSubmit={handleVoidSubmit}>
            <DialogHeader>
              <DialogTitle>Void Attachment</DialogTitle>
              <DialogDescription>
                Voiding <span className="font-medium">{voidTarget?.fileName}</span> marks it as
                Voided. The file remains in storage permanently for record retention.
                <div className="mt-2 text-xs font-semibold text-destructive">
                  21 CFR Part 11 Electronic Signature
                </div>
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-4">
              <div className="grid gap-1.5">
                <Label htmlFor="void-reason">Reason for voiding *</Label>
                <Input
                  id="void-reason"
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="e.g. Wrong file uploaded; replaced with corrected version"
                  data-testid="input-void-reason"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="void-initials">Initials *</Label>
                <Input
                  id="void-initials"
                  value={voidInitials}
                  onChange={(e) => setVoidInitials(e.target.value.toUpperCase())}
                  placeholder="e.g. JD"
                  maxLength={4}
                  data-testid="input-void-initials"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="void-meaning">Meaning of Signature *</Label>
                <Input
                  id="void-meaning"
                  value={voidMeaning}
                  onChange={(e) => setVoidMeaning(e.target.value)}
                  placeholder="e.g. Voided in error"
                  data-testid="input-void-meaning"
                />
              </div>
              {voidErr && <div className="text-sm text-destructive">{voidErr}</div>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeVoidDialog} disabled={voidPending}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={voidPending} data-testid="button-confirm-void">
                {voidPending ? "Voiding…" : "Sign & Void"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
