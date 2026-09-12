import { useState, useMemo, useCallback } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useListAuditLog } from "@workspace/api-client-react";
import type { AuditLogEntry } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import {
  Printer,
  ShieldCheck,
  FileText,
  Filter,
  RefreshCw,
  Truck,
  Download,
} from "lucide-react";
import { Link } from "wouter";

// ── Constants ──────────────────────────────────────────────────────────────────

const OP_STYLES: Record<string, string> = {
  INSERT:  "bg-green-100 text-green-800 border-green-300",
  UPDATE:  "bg-blue-100  text-blue-800  border-blue-300",
  APPROVE: "bg-purple-100 text-purple-800 border-purple-300",
  REJECT:  "bg-red-100   text-red-800   border-red-300",
  DELETE:  "bg-red-100   text-red-800   border-red-300",
};

const OP_LABELS: Record<string, string> = {
  INSERT:  "Created",
  UPDATE:  "Updated",
  APPROVE: "Approved",
  REJECT:  "Rejected",
  DELETE:  "Deleted",
};

const TABLE_LABELS: Record<string, string> = {
  suppliers: "Supplier Profile",
  supplier_qualifications: "Qualification Record",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function tableLabel(t: string) {
  return TABLE_LABELS[t] ?? t;
}

function supplierNameFromEntry(entry: AuditLogEntry): string {
  const state = (entry.afterState ?? entry.beforeState) as Record<string, unknown> | null;
  if (!state) return `#${entry.rowId}`;
  if (state.supplierName) return String(state.supplierName);
  if (state.qualNumber) return `Qual ${String(state.qualNumber)}`;
  return `#${entry.rowId}`;
}

function qualDetailFromEntry(entry: AuditLogEntry): string | null {
  const state = (entry.afterState ?? entry.beforeState) as Record<string, unknown> | null;
  if (!state) return null;
  if (entry.tableName === "supplier_qualifications") {
    const parts: string[] = [];
    if (state.qualificationStatus) parts.push(String(state.qualificationStatus));
    if (state.qualificationType)   parts.push(String(state.qualificationType));
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  if (entry.tableName === "suppliers" && state.status) {
    return `Status: ${String(state.status)}`;
  }
  return null;
}

// ── Diff helpers ───────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

const SKIP_FIELDS = new Set(["id", "createdAt", "updatedAt", "changedAt"]);

function renderVal(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function getDiffRows(entry: AuditLogEntry) {
  const b = (entry.beforeState && typeof entry.beforeState === "object" ? entry.beforeState : {}) as Obj;
  const a = (entry.afterState  && typeof entry.afterState  === "object" ? entry.afterState  : {}) as Obj;
  const allKeys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).filter(
    (k) => !SKIP_FIELDS.has(k),
  );
  const rows: { key: string; bv: string; av: string }[] = [];
  for (const key of allKeys) {
    const bv = renderVal(b[key]);
    const av = renderVal(a[key]);
    if (entry.operation === "UPDATE" && bv === av) continue;
    rows.push({ key, bv, av });
  }
  return rows;
}

// ── DiffViewer ─────────────────────────────────────────────────────────────────

function DiffViewer({ entry }: { entry: AuditLogEntry }) {
  const rows = getDiffRows(entry);
  const showBefore = entry.operation !== "INSERT";
  const showAfter  = entry.operation !== "DELETE";

  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground italic py-2">No field changes recorded.</p>;
  }

  return (
    <table className="w-full text-xs border-collapse">
      <thead>
        <tr className="border-b bg-muted/20">
          <th className="text-left px-3 py-1.5 font-semibold text-muted-foreground w-1/4">Field</th>
          {showBefore && <th className="text-left px-3 py-1.5 font-semibold text-muted-foreground">Before</th>}
          {showAfter  && <th className="text-left px-3 py-1.5 font-semibold text-muted-foreground">After</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ key, bv, av }) => (
          <tr key={key} className="border-b last:border-0">
            <td className="px-3 py-1.5 font-mono text-muted-foreground align-top">{key}</td>
            {showBefore && (
              <td className="px-3 py-1.5 align-top">
                <span className={`inline-block rounded px-1.5 py-0.5 font-mono whitespace-pre-wrap break-all max-w-xs ${entry.operation === "UPDATE" ? "bg-red-50 text-red-700 line-through" : "bg-red-50 text-red-700"}`}>
                  {bv}
                </span>
              </td>
            )}
            {showAfter && (
              <td className="px-3 py-1.5 align-top">
                <span className="inline-block rounded px-1.5 py-0.5 font-mono whitespace-pre-wrap break-all max-w-xs bg-green-50 text-green-700">
                  {av}
                </span>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Entry Card (screen) ────────────────────────────────────────────────────────

function EntryCard({ entry, index }: { entry: AuditLogEntry; index: number }) {
  const opStyle = OP_STYLES[entry.operation] ?? "bg-gray-100 text-gray-700 border-gray-300";
  const opLabel = OP_LABELS[entry.operation] ?? entry.operation;
  const detail  = qualDetailFromEntry(entry);
  const isApproval = entry.operation === "APPROVE" ||
    (entry.tableName === "supplier_qualifications" &&
      ((entry.afterState as Obj | null)?.qualificationStatus === "Approved"));

  return (
    <div className={`rounded-lg border bg-card overflow-hidden ${isApproval ? "border-green-300" : ""}`}>
      <div className={`flex items-center justify-between gap-3 px-4 py-3 border-b flex-wrap ${isApproval ? "bg-green-50/60" : "bg-muted/20"}`}>
        <div className="flex items-center gap-3 text-sm min-w-0">
          <span className="text-xs text-muted-foreground tabular-nums w-6 shrink-0">{index + 1}</span>
          <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium shrink-0 ${opStyle}`}>
            {opLabel}
          </span>
          <span className="font-semibold text-slate-900 shrink-0">{supplierNameFromEntry(entry)}</span>
          <span className={`text-xs px-1.5 py-0.5 rounded border ${
            entry.tableName === "supplier_qualifications"
              ? "bg-indigo-50 text-indigo-700 border-indigo-200"
              : "bg-slate-100 text-slate-600 border-slate-200"
          }`}>
            {tableLabel(entry.tableName)}
          </span>
          {detail && (
            <span className="text-xs text-muted-foreground hidden sm:inline">{detail}</span>
          )}
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
          <span className="tabular-nums font-medium text-foreground">
            {format(new Date(entry.changedAt), "MMM d, yyyy HH:mm:ss")} UTC
          </span>
          <span>{entry.changedByName ?? <em>System</em>}</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-0.5 px-4 py-1.5 border-b bg-muted/10 text-xs text-muted-foreground">
        <span>Entry ID: <code className="font-mono">{entry.id}</code></span>
        <span>Table: <code className="font-mono">{entry.tableName}</code></span>
        <span>Row ID: <code className="font-mono">{entry.rowId}</code></span>
        {entry.changedBy != null && <span>User ID: <code className="font-mono">{entry.changedBy}</code></span>}
        <span>ISO 8601: <code className="font-mono">{format(new Date(entry.changedAt), "yyyy-MM-dd'T'HH:mm:ss'Z'")}</code></span>
      </div>

      <div className="px-1">
        <DiffViewer entry={entry} />
      </div>
    </div>
  );
}

// ── Print Entry ────────────────────────────────────────────────────────────────

function PrintEntry({ entry, index }: { entry: AuditLogEntry; index: number }) {
  const rows = getDiffRows(entry);
  const showBefore = entry.operation !== "INSERT";
  const showAfter  = entry.operation !== "DELETE";
  const opLabel = OP_LABELS[entry.operation] ?? entry.operation;

  return (
    <div className="border border-gray-300 rounded mb-3" style={{ breakInside: "avoid" }}>
      <div className="flex items-start justify-between gap-4 border-b border-gray-200 bg-gray-50 px-3 py-2">
        <div className="flex items-center gap-3 text-xs">
          <span className="font-semibold text-gray-500">#{index + 1}</span>
          <span className="font-bold">{supplierNameFromEntry(entry)}</span>
          <span className="border rounded-full px-2 py-0.5 font-semibold" style={{ fontSize: "10px" }}>
            {opLabel}
          </span>
          <span className="text-gray-600">{tableLabel(entry.tableName)}</span>
          <span className="text-gray-500 font-mono">{format(new Date(entry.changedAt), "yyyy-MM-dd'T'HH:mm:ss'Z'")}</span>
        </div>
        <div className="text-xs text-gray-500 shrink-0">
          {entry.changedByName ?? "System"}{entry.changedBy != null ? ` (ID ${entry.changedBy})` : ""}
        </div>
      </div>
      {rows.length > 0 ? (
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left px-3 py-1 font-semibold text-gray-500 w-[30%]">Field</th>
              {showBefore && <th className="text-left px-3 py-1 font-semibold text-gray-500">Before</th>}
              {showAfter  && <th className="text-left px-3 py-1 font-semibold text-gray-500">After</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, bv, av }) => (
              <tr key={key} className="border-b border-gray-100 last:border-0">
                <td className="px-3 py-1 font-mono text-gray-500 align-top text-[10px]">{key}</td>
                {showBefore && (
                  <td className="px-3 py-1 align-top font-mono text-[10px] text-red-700 whitespace-pre-wrap break-all max-w-xs">{bv}</td>
                )}
                {showAfter && (
                  <td className="px-3 py-1 align-top font-mono text-[10px] text-green-800 whitespace-pre-wrap break-all max-w-xs">{av}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="px-3 py-2 text-xs text-gray-400 italic">No field data recorded.</p>
      )}
    </div>
  );
}

// ── CSV export ─────────────────────────────────────────────────────────────────

function exportCsv(entries: AuditLogEntry[]) {
  const header = ["ID", "Timestamp (UTC)", "User", "Operation", "Record Type", "Supplier / Record"].join(",");
  const rows = entries.map((e) => {
    const ts = format(new Date(e.changedAt), "yyyy-MM-dd'T'HH:mm:ss");
    const user = e.changedByName ?? "System";
    return [
      e.id,
      ts,
      `"${user.replace(/"/g, '""')}"`,
      OP_LABELS[e.operation] ?? e.operation,
      `"${tableLabel(e.tableName)}"`,
      `"${supplierNameFromEntry(e)}"`,
    ].join(",");
  });
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `supplier-requal-audit-${format(new Date(), "yyyyMMdd-HHmm")}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ── Signature line ─────────────────────────────────────────────────────────────

function SignatureLine({ label }: { label: string }) {
  return (
    <div className="space-y-6">
      <div className="border-b border-black pb-1" />
      <p className="text-[10px] uppercase tracking-wide text-gray-500">{label}</p>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function SupplierRequalAuditTrail() {
  const [pendingOperation, setPendingOperation] = useState("");
  const [pendingFrom, setPendingFrom] = useState("");
  const [pendingTo, setPendingTo] = useState("");

  const [generated, setGenerated] = useState(false);
  const [reportParams, setReportParams] = useState({ operation: "", from: "", to: "" });
  const [generatedAt, setGeneratedAt] = useState<Date | null>(null);

  const buildParams = useCallback(
    (table: string, params: typeof reportParams) => {
      const p: Record<string, unknown> = { tableName: table, limit: 500 };
      if (params.operation) p.operation = params.operation;
      if (params.from) p.from = new Date(params.from).toISOString();
      if (params.to) {
        const d = new Date(params.to);
        d.setHours(23, 59, 59, 999);
        p.to = d.toISOString();
      }
      return p;
    },
    [],
  );

  const suppliersParams = useMemo(
    () => (generated ? buildParams("suppliers", reportParams) : { limit: 0 }),
    [generated, reportParams, buildParams],
  );

  const qualsParams = useMemo(
    () => (generated ? buildParams("supplier_qualifications", reportParams) : { limit: 0 }),
    [generated, reportParams, buildParams],
  );

  const { data: supplierEntries = [], isLoading: suppliersLoading } = useListAuditLog(
    suppliersParams as Parameters<typeof useListAuditLog>[0],
  );

  const { data: qualEntries = [], isLoading: qualsLoading } = useListAuditLog(
    qualsParams as Parameters<typeof useListAuditLog>[0],
  );

  const isLoading = suppliersLoading || qualsLoading;

  const entries = useMemo(() => {
    const merged = [...supplierEntries, ...qualEntries];
    merged.sort((a, b) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime());
    return merged;
  }, [supplierEntries, qualEntries]);

  const handleGenerate = useCallback(() => {
    setReportParams({ operation: pendingOperation, from: pendingFrom, to: pendingTo });
    setGeneratedAt(new Date());
    setGenerated(true);
  }, [pendingOperation, pendingFrom, pendingTo]);

  const stats = useMemo(() => {
    const approvals    = entries.filter(
      (e) => e.tableName === "supplier_qualifications" &&
        ((e.afterState as Obj | null)?.qualificationStatus === "Approved" || e.operation === "APPROVE"),
    ).length;
    const intervalChanges = entries.filter(
      (e) => e.tableName === "suppliers" && e.operation === "UPDATE" &&
        (e.beforeState as Obj | null)?.requalificationIntervalYears !==
        (e.afterState  as Obj | null)?.requalificationIntervalYears,
    ).length;
    const newQuals  = entries.filter((e) => e.tableName === "supplier_qualifications" && e.operation === "INSERT").length;
    const newSupps  = entries.filter((e) => e.tableName === "suppliers" && e.operation === "INSERT").length;
    const rejections = entries.filter(
      (e) => e.tableName === "supplier_qualifications" &&
        ((e.afterState as Obj | null)?.qualificationStatus === "Rejected" || e.operation === "REJECT"),
    ).length;
    return { approvals, intervalChanges, newQuals, newSupps, rejections };
  }, [entries]);

  const filterDescription = useMemo(() => {
    const parts: string[] = ["Scope: Supplier Profiles + Qualification Records"];
    if (reportParams.operation) parts.push(`Operation: ${OP_LABELS[reportParams.operation] ?? reportParams.operation}`);
    if (reportParams.from) parts.push(`From: ${format(new Date(reportParams.from + "T00:00:00"), "MMM d, yyyy")}`);
    if (reportParams.to)   parts.push(`To: ${format(new Date(reportParams.to + "T00:00:00"), "MMM d, yyyy")}`);
    return parts.join(" · ");
  }, [reportParams]);

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto pb-16 print:max-w-none">

        {/* ── PRINT-ONLY HEADER ──────────────────────────────────────────────── */}
        <div className="hidden print:block mb-6">
          <div className="border-b-4 border-black pb-4 mb-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-gray-500 mb-1">
                  CannaQ · Michigan Licensed Cannabis Processor
                </p>
                <h1 className="text-2xl font-bold tracking-tight">
                  Supplier Re-qualification Audit Trail
                </h1>
                <p className="text-sm text-gray-600 mt-0.5">
                  ISO 13485:2016 §7.4.1 · 21 CFR Part 11 §11.10(e) · Michigan CRA R 420.683
                </p>
              </div>
              <div className="text-right text-xs text-gray-500 space-y-0.5">
                <p className="font-semibold text-sm text-black">OFFICIAL COMPLIANCE REPORT</p>
                <p>Generated: {generatedAt ? format(generatedAt, "yyyy-MM-dd'T'HH:mm:ss'Z'") : "—"}</p>
                <p>Entries: <strong>{entries.length}</strong></p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-4 text-xs">
            <div className="border border-gray-300 rounded p-3">
              <p className="font-semibold uppercase tracking-wide text-gray-500 mb-1.5 text-[10px]">Filter Criteria</p>
              <p className="font-medium">{filterDescription}</p>
            </div>
            <div className="border border-gray-300 rounded p-3">
              <p className="font-semibold uppercase tracking-wide text-gray-500 mb-1.5 text-[10px]">Qualification Summary</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                <span>Total Events: <strong>{entries.length}</strong></span>
                <span>Approvals Granted: <strong>{stats.approvals}</strong></span>
                <span>New Qual Records: <strong>{stats.newQuals}</strong></span>
                <span>Rejections: <strong>{stats.rejections}</strong></span>
                <span>Re-qual Interval Changes: <strong>{stats.intervalChanges}</strong></span>
                <span>New Suppliers Added: <strong>{stats.newSupps}</strong></span>
              </div>
            </div>
          </div>
        </div>

        {/* ── SCREEN HEADER ─────────────────────────────────────────────────── */}
        <div className="print:hidden space-y-5 mb-6">
          <div>
            <Link href="/audit-log" className="text-sm text-primary hover:underline mb-2 block">
              ← Back to Audit Log
            </Link>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                  <Truck className="h-6 w-6 text-indigo-500" />
                  Supplier Re-qualification Audit Trail
                </h1>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Complete change history for supplier profiles and qualification records — ISO 13485:2016 §7.4.1
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {generated && !isLoading && entries.length > 0 && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => exportCsv(entries)} className="gap-1.5">
                      <Download className="h-4 w-4" />
                      CSV
                    </Button>
                    <Button onClick={() => window.print()} className="gap-1.5">
                      <Printer className="h-4 w-4" />
                      Print / Save PDF
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Regulatory notice */}
          <div className="flex items-start gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" />
            <p className="text-sm leading-snug text-indigo-900">
              <span className="font-semibold">ISO 13485:2016 §7.4.1 Compliant.</span>{" "}
              This report captures the complete tamper-evident history of all supplier approvals,
              re-qualification assessments, interval changes, and qualification record updates.
              It provides documented evidence that your supplier control program is maintained per{" "}
              <strong>ISO 13485:2016 §7.4</strong>, <strong>21 CFR Part 11 §11.10(e)</strong>,
              and <strong>Michigan CRA R 420.683</strong>. Suitable for CRA inspector submission.
            </p>
          </div>

          {/* Filter panel */}
          <div className="rounded-lg border bg-card px-4 py-4 space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Filter className="h-4 w-4" />
              Report Parameters
              <span className="ml-2 text-xs font-normal bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">
                Scope locked: Supplier Profiles + Qualification Records
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground block">
                  Operation Type
                </label>
                <Select value={pendingOperation || "_all"} onValueChange={(v) => setPendingOperation(v === "_all" ? "" : v)}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="All Operations" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_all">All Operations</SelectItem>
                    <SelectItem value="INSERT">Created</SelectItem>
                    <SelectItem value="UPDATE">Updated</SelectItem>
                    <SelectItem value="APPROVE">Approved</SelectItem>
                    <SelectItem value="REJECT">Rejected</SelectItem>
                    <SelectItem value="DELETE">Deleted</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground block">
                  Date From
                </label>
                <Input
                  type="date"
                  value={pendingFrom}
                  onChange={(e) => setPendingFrom(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground block">
                  Date To
                </label>
                <Input
                  type="date"
                  value={pendingTo}
                  onChange={(e) => setPendingTo(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <Button onClick={handleGenerate} className="gap-1.5">
                <RefreshCw className="h-4 w-4" />
                Generate Report
              </Button>
              {generated && (
                <p className="text-xs text-muted-foreground">
                  Generated {generatedAt ? format(generatedAt, "MMM d, yyyy 'at' HH:mm") : ""}
                  {" · "}{isLoading ? "Loading…" : `${entries.length} entries`}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ── REPORT CONTENT ────────────────────────────────────────────────── */}
        {generated && (
          <>
            {isLoading ? (
              <div className="space-y-3 print:hidden">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-lg" />
                ))}
              </div>
            ) : entries.length === 0 ? (
              <div className="rounded-lg border bg-card p-12 text-center print:hidden">
                <FileText className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground text-sm">No supplier or qualification events match the selected criteria.</p>
                <p className="text-xs text-muted-foreground mt-1">Try broadening the date range or removing the operation filter.</p>
              </div>
            ) : (
              <div className="space-y-4">

                {/* Stats bar — screen only */}
                <div className="print:hidden grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  {[
                    { label: "Total Events",       value: entries.length,        color: "bg-slate-50 border-slate-200" },
                    { label: "Approvals Granted",  value: stats.approvals,        color: "bg-green-50 border-green-200 text-green-700" },
                    { label: "New Qual Records",   value: stats.newQuals,         color: "bg-indigo-50 border-indigo-200 text-indigo-700" },
                    { label: "Rejections",         value: stats.rejections,       color: stats.rejections > 0 ? "bg-red-50 border-red-200 text-red-700" : "bg-slate-50 border-slate-200" },
                    { label: "Interval Changes",   value: stats.intervalChanges,  color: stats.intervalChanges > 0 ? "bg-amber-50 border-amber-200 text-amber-700" : "bg-slate-50 border-slate-200" },
                    { label: "New Suppliers",      value: stats.newSupps,         color: "bg-blue-50 border-blue-200 text-blue-700" },
                  ].map(({ label, value, color }) => (
                    <div key={label} className={`rounded-lg border px-3 py-2.5 ${color}`}>
                      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
                      <p className="text-2xl font-bold tabular-nums mt-0.5">{value}</p>
                    </div>
                  ))}
                </div>

                <div className="print:hidden flex items-center justify-between text-sm text-muted-foreground">
                  <span>{filterDescription}</span>
                </div>

                {/* Screen entries */}
                <div className="space-y-3 print:hidden">
                  {entries.map((entry, idx) => (
                    <EntryCard key={entry.id} entry={entry} index={idx} />
                  ))}
                </div>

                {/* Print entries */}
                <div className="hidden print:block space-y-0">
                  {entries.map((entry, idx) => (
                    <PrintEntry key={entry.id} entry={entry} index={idx} />
                  ))}
                </div>

                {/* Certification footer */}
                <div className="border-t-2 border-black pt-4 mt-6 text-xs text-gray-700 space-y-2">
                  <div className="flex items-start gap-2">
                    <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-green-700 print:inline hidden" />
                    <p className="leading-relaxed">
                      <strong>Certification of Authenticity.</strong>{" "}
                      This supplier re-qualification audit trail was automatically generated by CannaQ.
                      Records are written by append-only database operations and cannot be modified or deleted
                      by any application user or administrator. Each entry captures the complete before and
                      after state of the record, a precise UTC timestamp, and the identity of the authenticated
                      user who initiated the change. This report constitutes documented evidence of the
                      supplier control program required under{" "}
                      <strong>ISO 13485:2016 §7.4.1</strong>,{" "}
                      <strong>21 CFR Part 11 §11.10(e)</strong>, and{" "}
                      <strong>Michigan CRA R 420.683</strong>.
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-8 mt-6 print:block print:space-y-6">
                    <SignatureLine label="Quality Manager / Reviewer" />
                    <SignatureLine label="Date of Review" />
                    <SignatureLine label="Regulatory Reference #" />
                  </div>
                </div>

              </div>
            )}
          </>
        )}

        {/* Placeholder */}
        {!generated && (
          <div className="rounded-lg border border-dashed bg-muted/20 p-12 text-center print:hidden">
            <Truck className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm font-medium text-muted-foreground">Set your date range and click Generate Report</p>
            <p className="text-xs text-muted-foreground mt-1">
              Leave filters blank to export the complete supplier qualification history
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Covers: Supplier Profiles · Qualification Records · Approval/Rejection events · Re-qualification interval changes
            </p>
          </div>
        )}

      </div>
    </AppLayout>
  );
}
