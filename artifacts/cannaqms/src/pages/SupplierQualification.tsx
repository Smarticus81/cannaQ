import { useState, useMemo } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useListSupplierQualifications } from "@workspace/api-client-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { format, parseISO, isPast } from "date-fns";
import { CreateSupplierQualDialog } from "@/components/dialogs/CreateSupplierQualDialog";
import { Search, ShieldCheck, AlertTriangle, Clock, CheckCircle2, XCircle, FileCheck2 } from "lucide-react";

// SQ-Certificates — the module now holds two kinds of record: lightweight
// "Certificate on file" entries and full "Audit" assessments. New records carry
// recordType; legacy rows are inferred from audit signals.
type QualRow = {
  recordType?: string | null;
  score?: number | null;
  findings?: string | null;
  correctiveActionsRequired?: string | null;
  status?: string | null;
  issuer?: string | null;
  assessorName?: string | null;
  [k: string]: unknown;
};

function effectiveRecordType(q: QualRow): "Certificate" | "Audit" {
  if (q.recordType === "Certificate" || q.recordType === "Audit") return q.recordType;
  if (
    q.score != null ||
    (typeof q.findings === "string" && q.findings.trim()) ||
    (typeof q.correctiveActionsRequired === "string" && q.correctiveActionsRequired.trim()) ||
    q.status === "Passed" ||
    q.status === "Failed"
  ) {
    return "Audit";
  }
  return "Certificate";
}

// Filter by record kind (plus an Expired cut that spans both kinds).
const FILTERS = ["All", "Certificates", "Audits", "Expired"] as const;
type Filter = (typeof FILTERS)[number];

// Audit status display — collapse active/legacy pre-outcome statuses to "Open";
// Passed/Failed/Expired stand on their own.
const displayStatus = (s: string | null | undefined): string =>
  s === "Passed" || s === "Failed" || s === "Expired" ? (s as string) : "Open";

const STATUS_STYLES: Record<string, string> = {
  Open: "bg-blue-50 text-blue-700 border-blue-200",
  Passed: "bg-green-50 text-green-700 border-green-200",
  Failed: "bg-red-50 text-red-700 border-red-200",
  Expired: "bg-slate-100 text-slate-600 border-slate-300",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  Open: <Clock className="h-3 w-3" />,
  Passed: <CheckCircle2 className="h-3 w-3" />,
  Failed: <XCircle className="h-3 w-3" />,
  Expired: <AlertTriangle className="h-3 w-3" />,
};

const isExpired = (q: QualRow): boolean =>
  typeof q.expiryDate === "string" && !!q.expiryDate && q.status !== "Failed" && isPast(parseISO(q.expiryDate));

export default function SupplierQualification() {
  const { data: qualsRaw = [], isLoading } = useListSupplierQualifications();
  const quals = qualsRaw as unknown as (QualRow & {
    id: number; qualNumber: string; supplierName: string; supplierType: string;
    qualificationType: string; expiryDate: string | null;
  })[];
  const [filter, setFilter] = useState<Filter>("All");
  const [search, setSearch] = useState("");

  const counts = useMemo(() => {
    const map: Record<string, number> = { All: quals.length, Certificates: 0, Audits: 0, Expired: 0 };
    for (const q of quals) {
      map[effectiveRecordType(q) === "Certificate" ? "Certificates" : "Audits"] += 1;
      if (isExpired(q)) map.Expired += 1;
    }
    return map;
  }, [quals]);

  const filtered = useMemo(() => {
    let list = quals;
    if (filter === "Certificates") list = list.filter((q) => effectiveRecordType(q) === "Certificate");
    else if (filter === "Audits") list = list.filter((q) => effectiveRecordType(q) === "Audit");
    else if (filter === "Expired") list = list.filter((q) => isExpired(q));
    if (search.trim()) {
      const s = search.toLowerCase();
      list = list.filter(
        (q) =>
          q.supplierName.toLowerCase().includes(s) ||
          q.qualNumber.toLowerCase().includes(s) ||
          q.qualificationType.toLowerCase().includes(s) ||
          (q.issuer ?? "").toLowerCase().includes(s) ||
          (q.assessorName ?? "").toLowerCase().includes(s),
      );
    }
    return list;
  }, [quals, filter, search]);

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Supplier Approval &amp; Certificates</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Certificates on file (licenses, GMP/FDA certificates, CoAs) and audit records for each supplier
            </p>
          </div>
          <CreateSupplierQualDialog />
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex gap-1 flex-wrap">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                  filter === f
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {f}
                {counts[f] !== undefined && (
                  <span className="ml-1.5 text-xs opacity-75">({counts[f]})</span>
                )}
              </button>
            ))}
          </div>
          <div className="relative sm:ml-auto">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search supplier, number, issuer…"
              className="pl-8 w-full sm:w-64"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Table */}
        <div className="rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Record #</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Issuer / Assessor</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: 6 }).map((_, j) => (
                        <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                      ))}
                    </TableRow>
                  ))
                : filtered.length === 0
                  ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-12 text-center">
                        <div className="flex flex-col items-center gap-2 text-muted-foreground">
                          <ShieldCheck className="h-8 w-8" />
                          <p className="text-sm font-medium">No records found</p>
                          {search || filter !== "All"
                            ? <p className="text-xs">Try adjusting your filters</p>
                            : <p className="text-xs">Add a certificate or audit record to get started</p>}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                  : filtered.map((q) => {
                      const isCert = effectiveRecordType(q) === "Certificate";
                      const expired = isExpired(q);
                      return (
                        <TableRow key={q.id} className="cursor-pointer hover:bg-muted/40">
                          <TableCell>
                            <Link href={`/supplier-qualification/${q.id}`}>
                              <span className="font-mono text-sm font-semibold text-primary hover:underline">
                                {q.qualNumber}
                              </span>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Link href={`/supplier-qualification/${q.id}`}>
                              <div>
                                <p className="text-sm font-medium">{q.supplierName}</p>
                                <p className="text-xs text-muted-foreground">{q.supplierType}</p>
                              </div>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-1">
                              <span className="text-sm text-muted-foreground">{q.qualificationType}</span>
                              <span className={`inline-flex w-fit items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                                isCert ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-purple-50 text-purple-700 border-purple-200"
                              }`}>
                                {isCert ? <FileCheck2 className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
                                {isCert ? "Certificate" : "Audit"}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm text-muted-foreground">
                              {(isCert ? q.issuer : q.assessorName) ?? "—"}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className={`text-sm ${expired ? "text-red-700 font-semibold" : "text-muted-foreground"}`}>
                              {q.expiryDate ? format(parseISO(q.expiryDate), "MMM d, yyyy") : "—"}
                              {expired && <AlertTriangle className="inline h-3 w-3 ml-1 text-red-600" />}
                            </span>
                          </TableCell>
                          <TableCell>
                            {isCert ? (
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
                                expired ? "bg-red-50 text-red-700 border-red-200" : "bg-green-50 text-green-700 border-green-200"
                              }`}>
                                {expired ? <AlertTriangle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                                {expired ? "Expired" : "Active"}
                              </span>
                            ) : (
                              <div className="flex flex-col items-start gap-1">
                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_STYLES[displayStatus(q.status)] ?? "bg-slate-100 text-slate-600"}`}>
                                  {STATUS_ICONS[displayStatus(q.status)]}
                                  {displayStatus(q.status)}
                                </span>
                                {typeof q.correctiveActionsRequired === "string" && q.correctiveActionsRequired.trim()
                                  && q.status !== "Passed" && q.status !== "Failed" && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-orange-50 text-orange-700 border-orange-200">
                                    <AlertTriangle className="h-3 w-3" />
                                    CA Required
                                  </span>
                                )}
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
            </TableBody>
          </Table>
        </div>
      </div>
    </AppLayout>
  );
}
