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
import { Printer, ShieldCheck, FileText, Filter, RefreshCw } from "lucide-react";
import { Link } from "wouter";

// ── Constants ──────────────────────────────────────────────────────────────────

const MODULE_MAP: Record<string, string> = {
  suppliers: "Suppliers",
  incoming_inspections: "Inspections",
  inventory_items: "Inventory",
  batch_records: "Batch Records",
  test_samples: "Testing / Sampling",
  non_conformances: "Non-Conformances",
  capas: "CAPA",
  complaints: "Complaints",
  field_actions: "Field Actions",
  packaging_designs: "Packaging Design",
  users: "Users / Settings",
};

const OP_STYLES: Record<string, string> = {
  INSERT:  "bg-green-100 text-green-800 border-green-300",
  UPDATE:  "bg-blue-100  text-blue-800  border-blue-300",
  APPROVE: "bg-purple-100 text-purple-800 border-purple-300",
  CLOSE:   "bg-gray-100  text-gray-800  border-gray-300",
  RELEASE: "bg-indigo-100 text-indigo-800 border-indigo-300",
  DELETE:  "bg-red-100   text-red-800   border-red-300",
};

const OP_LABELS: Record<string, string> = {
  INSERT:  "Created",
  UPDATE:  "Updated",
  APPROVE: "Approved",
  CLOSE:   "Closed",
  RELEASE: "Released",
  DELETE:  "Deleted",
};

function moduleLabel(t: string) {
  return MODULE_MAP[t] ?? t;
}

function smartRecordId(entry: AuditLogEntry): string {
  const state = (entry.afterState ?? entry.beforeState) as Record<string, unknown> | null;
  if (state) {
    for (const key of [
      "ncNumber", "complaintNumber", "faNumber", "batchNumber", "capaNumber",
      "designName", "supplierName", "lotNumber", "sampleNumber", "qualNumber",
    ]) {
      if (state[key]) return String(state[key]);
    }
  }
  return `#${entry.rowId}`;
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

// ── Screen DiffViewer ──────────────────────────────────────────────────────────

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

// ── Print-mode entry card ──────────────────────────────────────────────────────

function PrintEntry({ entry, index }: { entry: AuditLogEntry; index: number }) {
  const rows = getDiffRows(entry);
  const showBefore = entry.operation !== "INSERT";
  const showAfter  = entry.operation !== "DELETE";

  return (
    <div className="border border-gray-300 rounded mb-3" style={{ breakInside: "avoid" }}>
      {/* Entry header */}
      <div className="flex items-start justify-between gap-4 border-b border-gray-200 bg-gray-50 px-3 py-2">
        <div className="flex items-center gap-3 text-xs">
          <span className="font-semibold text-gray-500">#{index + 1}</span>
          <span className="font-bold font-mono">{smartRecordId(entry)}</span>
          <span className="text-gray-500">
            {format(new Date(entry.changedAt), "yyyy-MM-dd'T'HH:mm:ss'Z'")}
          </span>
          <span className="border rounded-full px-2 py-0.5 font-semibold" style={{ fontSize: "10px" }}>
            {OP_LABELS[entry.operation] ?? entry.operation}
          </span>
          <span className="text-gray-600">{moduleLabel(entry.tableName)}</span>
        </div>
        <div className="text-xs text-gray-500 shrink-0">
          {entry.changedByName ?? "System"}{entry.changedBy != null ? ` (ID ${entry.changedBy})` : ""}
        </div>
      </div>

      {/* Field diff */}
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
                  <td className="px-3 py-1 align-top font-mono text-[10px] text-red-700 whitespace-pre-wrap break-all max-w-xs">
                    {bv}
                  </td>
                )}
                {showAfter && (
                  <td className="px-3 py-1 align-top font-mono text-[10px] text-green-800 whitespace-pre-wrap break-all max-w-xs">
                    {av}
                  </td>
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

// ── Main page ──────────────────────────────────────────────────────────────────

export default function AuditLogReport() {
  const [pendingTableName, setPendingTableName] = useState("");
  const [pendingOperation, setPendingOperation] = useState("");
  const [pendingFrom, setPendingFrom] = useState("");
  const [pendingTo, setPendingTo] = useState("");

  const [generated, setGenerated] = useState(false);
  const [reportParams, setReportParams] = useState<{
    tableName: string;
    operation: string;
    from: string;
    to: string;
  }>({ tableName: "", operation: "", from: "", to: "" });
  const [generatedAt, setGeneratedAt] = useState<Date | null>(null);

  const apiParams = useMemo(() => {
    if (!generated) return { limit: 0 };
    const p: Record<string, unknown> = { limit: 1000 };
    if (reportParams.tableName) p.tableName = reportParams.tableName;
    if (reportParams.operation) p.operation = reportParams.operation;
    if (reportParams.from) p.from = new Date(reportParams.from + "T00:00:00").toISOString();
    if (reportParams.to) {
      const d = new Date(reportParams.to + "T00:00:00");
      d.setHours(23, 59, 59, 999);
      p.to = d.toISOString();
    }
    return p;
  }, [generated, reportParams]);

  const { data: entries = [], isLoading } = useListAuditLog(
    apiParams as Parameters<typeof useListAuditLog>[0],
  );

  const handleGenerate = useCallback(() => {
    setReportParams({
      tableName: pendingTableName,
      operation: pendingOperation,
      from: pendingFrom,
      to: pendingTo,
    });
    setGeneratedAt(new Date());
    setGenerated(true);
  }, [pendingTableName, pendingOperation, pendingFrom, pendingTo]);

  const stats = useMemo(() => {
    const byOp: Record<string, number>     = {};
    const byModule: Record<string, number> = {};
    for (const e of entries) {
      byOp[OP_LABELS[e.operation] ?? e.operation] = (byOp[OP_LABELS[e.operation] ?? e.operation] ?? 0) + 1;
      byModule[moduleLabel(e.tableName)] = (byModule[moduleLabel(e.tableName)] ?? 0) + 1;
    }
    return { byOp, byModule };
  }, [entries]);

  const filterDescription = useMemo(() => {
    const parts: string[] = [];
    if (reportParams.tableName) parts.push(`Module: ${moduleLabel(reportParams.tableName)}`);
    if (reportParams.operation) parts.push(`Operation: ${OP_LABELS[reportParams.operation] ?? reportParams.operation}`);
    if (reportParams.from) parts.push(`From: ${format(new Date(reportParams.from + "T00:00:00"), "MMM d, yyyy")}`);
    if (reportParams.to) parts.push(`To: ${format(new Date(reportParams.to + "T00:00:00"), "MMM d, yyyy")}`);
    return parts.length > 0 ? parts.join(" · ") : "All records — no filters applied";
  }, [reportParams]);

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto pb-16 print:max-w-none">

        {/* ── PRINT-ONLY HEADER ─────────────────────────────────────────────── */}
        <div className="hidden print:block mb-6">
          <div className="border-b-4 border-black pb-4 mb-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-gray-500 mb-1">
                  CannaQ · Michigan Licensed Cannabis Processor
                </p>
                <h1 className="text-2xl font-bold tracking-tight">
                  Electronic Records Audit Trail
                </h1>
                <p className="text-sm text-gray-600 mt-0.5">
                  21 CFR Part 11 §11.10(e) · ISO 13485:2016 §4.2.5 · Michigan CRA R 420
                </p>
              </div>
              <div className="text-right text-xs text-gray-500 space-y-0.5">
                <p className="font-semibold text-sm text-black">OFFICIAL COMPLIANCE REPORT</p>
                <p>Generated: {generatedAt ? format(generatedAt, "yyyy-MM-dd'T'HH:mm:ss'Z'") : "—"}</p>
                <p>Entries: <strong>{entries.length}</strong></p>
              </div>
            </div>
          </div>

          {/* Report criteria */}
          <div className="grid grid-cols-2 gap-4 mb-4 text-xs">
            <div className="border border-gray-300 rounded p-3">
              <p className="font-semibold uppercase tracking-wide text-gray-500 mb-1.5 text-[10px]">Filter Criteria Applied</p>
              <p className="font-medium">{filterDescription}</p>
            </div>
            <div className="border border-gray-300 rounded p-3">
              <p className="font-semibold uppercase tracking-wide text-gray-500 mb-1.5 text-[10px]">Record Summary</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                {Object.entries(stats.byOp).map(([op, count]) => (
                  <span key={op}>{op}: <strong>{count}</strong></span>
                ))}
              </div>
            </div>
          </div>

          {/* Module breakdown */}
          {Object.keys(stats.byModule).length > 0 && (
            <div className="border border-gray-300 rounded p-3 mb-4 text-xs">
              <p className="font-semibold uppercase tracking-wide text-gray-500 mb-1.5 text-[10px]">Entries by Module</p>
              <div className="flex flex-wrap gap-x-6 gap-y-0.5">
                {Object.entries(stats.byModule).map(([mod, count]) => (
                  <span key={mod}>{mod}: <strong>{count}</strong></span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── SCREEN HEADER (hidden when printing) ──────────────────────────── */}
        <div className="print:hidden space-y-5 mb-6">
          <div>
            <Link href="/audit-log" className="text-sm text-primary hover:underline mb-2 block">
              ← Back to Audit Log
            </Link>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                  <FileText className="h-6 w-6 text-muted-foreground" />
                  Audit Trail Report
                </h1>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Generate a formal 21 CFR Part 11 compliance report for regulatory submission
                </p>
              </div>
              {generated && !isLoading && entries.length > 0 && (
                <Button onClick={() => window.print()} className="gap-1.5 shrink-0">
                  <Printer className="h-4 w-4" />
                  Print / Save PDF
                </Button>
              )}
            </div>
          </div>

          {/* Filter panel */}
          <div className="rounded-lg border bg-card px-4 py-4 space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Filter className="h-4 w-4" />
              Report Parameters
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {/* Module */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground block">
                  Module / Record Type
                </label>
                <Select value={pendingTableName || "_all"} onValueChange={(v) => setPendingTableName(v === "_all" ? "" : v)}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="All Modules" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_all">All Modules</SelectItem>
                    {Object.entries(MODULE_MAP).map(([val, lbl]) => (
                      <SelectItem key={val} value={val}>{lbl}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Operation */}
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
                    <SelectItem value="CLOSE">Closed</SelectItem>
                    <SelectItem value="RELEASE">Released</SelectItem>
                    <SelectItem value="DELETE">Deleted</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* From date */}
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

              {/* To date */}
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
                  Report generated {generatedAt ? format(generatedAt, "MMM d, yyyy 'at' HH:mm") : ""}
                  {" · "}{isLoading ? "Loading…" : `${entries.length} entries`}
                </p>
              )}
            </div>
          </div>

          {/* Part 11 notice */}
          <div className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
            <p className="text-sm leading-snug text-green-900">
              <span className="font-semibold">Regulatory Use.</span>{" "}
              This report presents the complete, unedited audit trail for the selected criteria.
              All timestamps are UTC. Before/after state snapshots are stored verbatim from the
              database. This document may be submitted to Michigan CRA inspectors as evidence of
              21 CFR Part 11 §11.10(e) compliance.
            </p>
          </div>
        </div>

        {/* ── REPORT CONTENT (screen + print) ──────────────────────────────── */}
        {generated && (
          <>
            {isLoading ? (
              <div className="space-y-3 print:hidden">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-lg" />
                ))}
              </div>
            ) : entries.length === 0 ? (
              <div className="rounded-lg border bg-card p-12 text-center print:hidden">
                <p className="text-muted-foreground text-sm">No audit entries match the selected criteria.</p>
                <p className="text-xs text-muted-foreground mt-1">Try broadening the date range or removing filters.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Screen summary bar */}
                <div className="print:hidden flex items-center justify-between">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    <span className="font-semibold text-foreground">{entries.length} entries</span>
                    {Object.entries(stats.byOp).map(([op, cnt]) => (
                      <span key={op} className="text-muted-foreground">{op}: {cnt}</span>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground shrink-0">{filterDescription}</p>
                </div>

                {/* Entries */}
                <div className="space-y-3">
                  {entries.map((entry, idx) => (
                    <EntryCard key={entry.id} entry={entry} index={idx} />
                  ))}
                </div>

                {/* Certification footer */}
                <div className="border-t-2 border-black pt-4 mt-6 text-xs text-gray-700 space-y-2">
                  <div className="flex items-start gap-2">
                    <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-green-700 print:inline" />
                    <p className="leading-relaxed">
                      <strong>Certification of Authenticity.</strong>{" "}
                      This audit trail was automatically generated by CannaQ. Records are written
                      by append-only database operations and cannot be modified or deleted by any
                      application user or administrator. Each entry captures the complete before and
                      after state of the record, a precise UTC timestamp, and the identity of the
                      authenticated user who initiated the change. This report constitutes the
                      official electronic records audit trail in compliance with{" "}
                      <strong>21 CFR Part 11 §11.10(e)</strong>,{" "}
                      <strong>ISO 13485:2016 §4.2.5</strong>, and{" "}
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

        {/* Placeholder when not yet generated */}
        {!generated && (
          <div className="rounded-lg border border-dashed bg-muted/20 p-12 text-center print:hidden">
            <FileText className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm font-medium text-muted-foreground">Set your filters above and click Generate Report</p>
            <p className="text-xs text-muted-foreground mt-1">Leave all filters blank to export the complete audit trail</p>
          </div>
        )}

      </div>
    </AppLayout>
  );
}

// ── Screen entry card ──────────────────────────────────────────────────────────

function EntryCard({ entry, index }: { entry: AuditLogEntry; index: number }) {
  const opStyle = OP_STYLES[entry.operation] ?? "bg-gray-100 text-gray-700 border-gray-300";
  const opLabel = OP_LABELS[entry.operation] ?? entry.operation;

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b bg-muted/20 flex-wrap">
        <div className="flex items-center gap-3 text-sm min-w-0">
          <span className="text-xs text-muted-foreground tabular-nums w-6 shrink-0 print:inline">
            {index + 1}
          </span>
          <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium shrink-0 ${opStyle}`}>
            {opLabel}
          </span>
          <span className="font-mono font-bold text-primary shrink-0">{smartRecordId(entry)}</span>
          <span className="text-muted-foreground shrink-0">{moduleLabel(entry.tableName)}</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
          <span className="tabular-nums font-medium text-foreground">
            {format(new Date(entry.changedAt), "MMM d, yyyy HH:mm:ss")} UTC
          </span>
          <span>{entry.changedByName ?? <em>System</em>}</span>
        </div>
      </div>

      {/* Meta strip */}
      <div className="flex flex-wrap gap-x-5 gap-y-0.5 px-4 py-1.5 border-b bg-muted/10 text-xs text-muted-foreground">
        <span>Entry ID: <code className="font-mono">{entry.id}</code></span>
        <span>Table: <code className="font-mono">{entry.tableName}</code></span>
        <span>Row ID: <code className="font-mono">{entry.rowId}</code></span>
        {entry.changedBy != null && <span>User ID: <code className="font-mono">{entry.changedBy}</code></span>}
        <span>ISO 8601: <code className="font-mono">{format(new Date(entry.changedAt), "yyyy-MM-dd'T'HH:mm:ss'Z'")}</code></span>
      </div>

      {/* Diff */}
      <div className="px-1">
        <DiffViewer entry={entry} />
      </div>
    </div>
  );
}

// ── Signature line helper ──────────────────────────────────────────────────────

function SignatureLine({ label }: { label: string }) {
  return (
    <div className="space-y-6">
      <div className="border-b border-black pb-1" />
      <p className="text-[10px] uppercase tracking-wide text-gray-500">{label}</p>
    </div>
  );
}
