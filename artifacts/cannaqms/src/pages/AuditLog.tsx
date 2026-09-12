import { useState, useMemo, useCallback } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useListAuditLog } from "@workspace/api-client-react";
import type { AuditLogEntry } from "@workspace/api-client-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format } from "date-fns";
import {
  ShieldCheck,
  Download,
  ChevronDown,
  ChevronRight,
  X,
  Search,
  Filter,
  FileText,
} from "lucide-react";
import { Link } from "wouter";
import { AuditDiff } from "@/components/audit/AuditDiff";

// ── Constants ──────────────────────────────────────────────────────────────────

const MODULE_MAP: Record<string, string> = {
  suppliers: "Suppliers",
  incoming_inspections: "Inspections",
  inventory_items: "Inventory",
  batch_records: "Batch Records",
  test_samples: "Testing / Sampling",
  non_conformances: "Non-Conformances",
  capa_records: "CAPA",
  complaints: "Complaints",
  field_actions: "Field Actions",
  packaging_designs: "Packaging Design",
  users: "Users / Settings",
};

const OP_STYLES: Record<string, string> = {
  INSERT: "bg-green-100 text-green-800 border-green-300",
  UPDATE: "bg-blue-100 text-blue-800 border-blue-300",
  DELETE: "bg-red-100 text-red-800 border-red-300",
};

const OP_LABELS: Record<string, string> = {
  INSERT: "Created",
  UPDATE: "Updated",
  DELETE: "Deleted",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function moduleLabel(t: string) {
  return MODULE_MAP[t] ?? t;
}

function smartRecordId(entry: AuditLogEntry): string {
  const state = (entry.afterState ?? entry.beforeState) as Record<string, unknown> | null;
  if (state) {
    for (const key of [
      "ncNumber", "complaintNumber", "faNumber", "batchNumber",
      "designName", "supplierName", "lotNumber", "sampleNumber",
    ]) {
      if (state[key]) return String(state[key]);
    }
  }
  return `#${entry.rowId}`;
}

// ── CSV Export ─────────────────────────────────────────────────────────────────

function exportCsv(entries: AuditLogEntry[]) {
  const header = ["ID", "Timestamp (UTC)", "User", "Operation", "Module", "Record"].join(",");
  const rows = entries.map((e) => {
    const ts = format(new Date(e.changedAt), "yyyy-MM-dd'T'HH:mm:ss");
    const user = e.changedByName ?? "System";
    return [
      e.id,
      ts,
      `"${user.replace(/"/g, '""')}"`,
      e.operation,
      `"${moduleLabel(e.tableName)}"`,
      `"${smartRecordId(e)}"`,
    ].join(",");
  });
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `audit-log-${format(new Date(), "yyyyMMdd-HHmm")}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function AuditLog() {
  // Server-side filters
  const [tableName, setTableName] = useState("");
  const [operation, setOperation] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo]     = useState("");
  // Client-side text search
  const [search, setSearch] = useState("");
  // Expanded diff rows
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggleRow = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const apiParams = useMemo(() => {
    const p: Record<string, unknown> = { limit: 200 };
    if (tableName) p.tableName = tableName;
    if (operation)  p.operation  = operation;
    if (from) p.from = new Date(from).toISOString();
    if (to) {
      const d = new Date(to);
      d.setHours(23, 59, 59, 999);
      p.to = d.toISOString();
    }
    return p;
  }, [tableName, operation, from, to]);

  const { data: rawLogs = [], isLoading } = useListAuditLog(
    apiParams as Parameters<typeof useListAuditLog>[0],
  );

  const logs = useMemo(() => {
    if (!search.trim()) return rawLogs;
    const q = search.toLowerCase();
    return rawLogs.filter(
      (e) =>
        moduleLabel(e.tableName).toLowerCase().includes(q) ||
        e.tableName.toLowerCase().includes(q) ||
        (e.changedByName ?? "").toLowerCase().includes(q) ||
        smartRecordId(e).toLowerCase().includes(q) ||
        e.operation.toLowerCase().includes(q),
    );
  }, [rawLogs, search]);

  const hasFilters = tableName || operation || from || to || search;

  const clearFilters = () => {
    setTableName(""); setOperation(""); setFrom(""); setTo(""); setSearch("");
  };

  return (
    <AppLayout>
      <div className="space-y-5">

        {/* Page header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
            <p className="text-sm text-muted-foreground">
              Tamper-evident record of every system change — 21 CFR Part 11 §11.10(e)
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Link href="/audit-log/supplier-requal">
              <Button variant="outline" size="sm" className="gap-1.5">
                <ShieldCheck className="h-4 w-4" />
                Supplier Re-qual Trail
              </Button>
            </Link>
            <Link href="/audit-log/report">
              <Button variant="default" size="sm" className="gap-1.5">
                <FileText className="h-4 w-4" />
                Generate Report
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              disabled={logs.length === 0}
              onClick={() => exportCsv(logs)}
            >
              <Download className="h-4 w-4 mr-1.5" />
              Export CSV
            </Button>
          </div>
        </div>

        {/* Part 11 compliance banner */}
        <div className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
          <p className="text-sm leading-snug text-green-900">
            <span className="font-semibold">21 CFR Part 11 Compliant.</span>{" "}
            Records are written by a database trigger and are append-only — no application code
            can modify or delete them. Every entry captures the full before/after state, a
            precise UTC timestamp, and the authenticated user. This log is the official audit
            trail under <code className="font-mono text-xs">§11.10(e)</code> and Michigan CRA R 420.
          </p>
        </div>

        {/* Filter bar */}
        <div className="rounded-lg border bg-card px-4 py-3 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Filter className="h-4 w-4" />
            Filter Records
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_180px_180px_auto] gap-3 items-end">

            {/* Search */}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search user, module, record…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9 text-sm"
              />
            </div>

            {/* Module */}
            <Select
              value={tableName || "_all"}
              onValueChange={(v) => setTableName(v === "_all" ? "" : v)}
            >
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

            {/* Operation */}
            <Select
              value={operation || "_all"}
              onValueChange={(v) => setOperation(v === "_all" ? "" : v)}
            >
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="All Operations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">All Operations</SelectItem>
                <SelectItem value="INSERT">Created</SelectItem>
                <SelectItem value="UPDATE">Updated</SelectItem>
                <SelectItem value="DELETE">Deleted</SelectItem>
              </SelectContent>
            </Select>

            {/* Date range */}
            <div className="flex gap-2">
              <div className="flex-1 space-y-1">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  From
                </label>
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div className="flex-1 space-y-1">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  To
                </label>
                <Input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
            </div>

            {/* Clear */}
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="h-9 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4 mr-1" />
                Clear
              </Button>
            )}
          </div>

          {/* Result hint */}
          {hasFilters && !isLoading && (
            <p className="text-xs text-muted-foreground">
              {logs.length === rawLogs.length
                ? `${logs.length} records match`
                : `${logs.length} of ${rawLogs.length} records match`}
            </p>
          )}
        </div>

        {/* Row count hint when no filters */}
        {!hasFilters && !isLoading && rawLogs.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Showing latest {rawLogs.length} records. Use filters to narrow results.
          </p>
        )}

        {/* Table */}
        <div className="rounded-lg border bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead className="w-8" />
                <TableHead className="whitespace-nowrap">Timestamp</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Operation</TableHead>
                <TableHead>Module</TableHead>
                <TableHead>Record</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 12 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell />
                    <TableCell><Skeleton className="h-4 w-36" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-16 rounded-full" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  </TableRow>
                ))
              ) : logs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-28 text-center text-muted-foreground">
                    {hasFilters
                      ? "No audit log entries match the current filters."
                      : "No audit log entries found."}
                  </TableCell>
                </TableRow>
              ) : (
                logs.flatMap((entry) => {
                  const isOpen = expanded.has(entry.id);
                  const opStyle = OP_STYLES[entry.operation] ?? "bg-gray-100 text-gray-700 border-gray-300";
                  const opLabel = OP_LABELS[entry.operation] ?? entry.operation;

                  const mainRow = (
                    <TableRow
                      key={`r-${entry.id}`}
                      className="cursor-pointer hover:bg-muted/30 transition-colors"
                      onClick={() => toggleRow(entry.id)}
                    >
                      <TableCell className="pr-0 pl-3">
                        {isOpen
                          ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                      </TableCell>

                      <TableCell className="whitespace-nowrap text-sm tabular-nums">
                        <div className="font-medium">
                          {format(new Date(entry.changedAt), "MMM d, yyyy")}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {format(new Date(entry.changedAt), "HH:mm:ss")} UTC
                        </div>
                      </TableCell>

                      <TableCell className="text-sm">
                        {entry.changedByName
                          ? entry.changedByName
                          : <span className="italic text-muted-foreground text-xs">System</span>}
                      </TableCell>

                      <TableCell>
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${opStyle}`}>
                          {opLabel}
                        </span>
                      </TableCell>

                      <TableCell className="text-sm">
                        {moduleLabel(entry.tableName)}
                      </TableCell>

                      <TableCell className="font-mono text-sm text-primary font-semibold">
                        {smartRecordId(entry)}
                      </TableCell>
                    </TableRow>
                  );

                  const diffRow = isOpen ? (
                    <TableRow key={`d-${entry.id}`} className="bg-muted/10 hover:bg-muted/10">
                      <TableCell colSpan={6} className="p-0">
                        <div className="border-t border-dashed">
                          {/* Meta strip */}
                          <div className="flex flex-wrap gap-x-6 gap-y-1 border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
                            <span>
                              <span className="font-semibold text-foreground">Entry:</span> {entry.id}
                            </span>
                            <span>
                              <span className="font-semibold text-foreground">Table:</span>{" "}
                              <code className="font-mono">{entry.tableName}</code>
                            </span>
                            <span>
                              <span className="font-semibold text-foreground">Row ID:</span> {entry.rowId}
                            </span>
                            {entry.changedBy != null && (
                              <span>
                                <span className="font-semibold text-foreground">User ID:</span>{" "}
                                {entry.changedBy}
                              </span>
                            )}
                            <span>
                              <span className="font-semibold text-foreground">ISO 8601:</span>{" "}
                              {format(new Date(entry.changedAt), "yyyy-MM-dd'T'HH:mm:ss'Z'")}
                            </span>
                          </div>
                          {/* Diff */}
                          <AuditDiff
                            before={entry.beforeState}
                            after={entry.afterState}
                            operation={entry.operation}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null;

                  return diffRow ? [mainRow, diffRow] : [mainRow];
                })
              )}
            </TableBody>
          </Table>
        </div>

        {/* Footer */}
        {!isLoading && logs.length > 0 && (
          <p className="pb-2 text-center text-xs text-muted-foreground">
            Records are read-only and immutable. All timestamps are UTC. This constitutes the
            official audit trail under 21 CFR Part 11 §11.10(e) and Michigan CRA R 420.
          </p>
        )}

      </div>
    </AppLayout>
  );
}
