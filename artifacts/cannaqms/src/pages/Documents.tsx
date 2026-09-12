import { useState, useMemo } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useListDocuments, getListDocumentsQueryKey } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { formatRevision } from "@/lib/status";
import { format, parseISO, isPast } from "date-fns";
import { CreateDocumentDialog } from "@/components/dialogs/CreateDocumentDialog";
import { ImportDocumentDialog } from "@/components/dialogs/ImportDocumentDialog";
import {
  Search, FileText, CheckCircle2, Clock, AlertTriangle, Archive, Star,
} from "lucide-react";

const STATUSES = ["All", "Draft", "Under Review", "Approved", "Effective", "Obsolete"] as const;
type StatusFilter = (typeof STATUSES)[number];

const STATUS_STYLES: Record<string, string> = {
  Draft: "bg-slate-100 text-slate-700 border-slate-300",
  "Under Review": "bg-yellow-50 text-yellow-700 border-yellow-200",
  Approved: "bg-green-50 text-green-700 border-green-200",
  Effective: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Obsolete: "bg-red-50 text-red-600 border-red-200",
  Superseded: "bg-orange-50 text-orange-700 border-orange-200",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  Draft: <FileText className="h-3 w-3" />,
  "Under Review": <Clock className="h-3 w-3" />,
  Approved: <CheckCircle2 className="h-3 w-3" />,
  Effective: <CheckCircle2 className="h-3 w-3" />,
  Obsolete: <Archive className="h-3 w-3" />,
};

const TYPE_BADGE: Record<string, string> = {
  SOP: "bg-blue-50 text-blue-700 border-blue-200",
  "Work Instruction": "bg-teal-50 text-teal-700 border-teal-200",
  Form: "bg-purple-50 text-purple-700 border-purple-200",
  Policy: "bg-indigo-50 text-indigo-700 border-indigo-200",
  Specification: "bg-cyan-50 text-cyan-700 border-cyan-200",
  Protocol: "bg-violet-50 text-violet-700 border-violet-200",
  Report: "bg-slate-50 text-slate-700 border-slate-200",
  Other: "bg-gray-50 text-gray-600 border-gray-200",
};

export default function Documents() {
  const { data: docs = [], isLoading } = useListDocuments();
  // Batch 5 — honor a ?status= deep link (dashboard tiles pass e.g.
  // ?status=Overdue / ?status=Under%20Review) so the tile lands here
  // pre-filtered. Unknown/absent param falls back to the "All" view.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    if (typeof window === "undefined") return "All";
    const q = new URLSearchParams(window.location.search).get("status");
    return q && (STATUSES as readonly string[]).includes(q) ? (q as StatusFilter) : "All";
  });
  const [search, setSearch] = useState("");
  // Session 52.1 — Active / Cancelled view. The active list already excludes
  // cancelled server-side; the Cancelled view fetches ?cancelled=true (off-spec
  // param, so raw fetch rather than an orval hook).
  const [view, setView] = useState<"active" | "cancelled">("active");
  const { data: cancelledDocs = [], isLoading: cancelledLoading } = useQuery({
    queryKey: ["documents", "cancelled"],
    queryFn: async () => {
      const r = await fetch("/api/documents?cancelled=true", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load cancelled documents");
      return r.json() as Promise<typeof docs>;
    },
    enabled: view === "cancelled",
  });

  const queryClient = useQueryClient();
  const [pendingFav, setPendingFav] = useState<number | null>(null);
  const toggleFavorite = async (e: React.MouseEvent, doc: (typeof docs)[number]) => {
    e.preventDefault();
    e.stopPropagation();
    const isFav = (doc as { isFavorite?: boolean }).isFavorite ?? false;
    setPendingFav(doc.id);
    try {
      await fetch(`/api/documents/${doc.id}/favorite`, {
        method: isFav ? "DELETE" : "POST",
        credentials: "include",
      });
      await queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
      await queryClient.invalidateQueries({ queryKey: ["documents", "cancelled"] });
    } finally {
      setPendingFav(null);
    }
  };

  const counts = useMemo(() => {
    const map: Record<string, number> = { All: docs.length };
    for (const d of docs) {
      map[d.status] = (map[d.status] ?? 0) + 1;
    }
    return map;
  }, [docs]);

  const filtered = useMemo(() => {
    let list = view === "cancelled" ? cancelledDocs : docs;
    if (view === "active" && statusFilter !== "All") list = list.filter((d) => d.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.docNumber.toLowerCase().includes(q) ||
          (d.ownerName ?? "").toLowerCase().includes(q) ||
          (d.department ?? "").toLowerCase().includes(q),
      );
    }
    // Favorites float to the top; stable sort keeps the server's updated-at
    // ordering within the starred and un-starred groups.
    return [...list].sort(
      (a, b) =>
        Number((b as { isFavorite?: boolean }).isFavorite ?? false) -
        Number((a as { isFavorite?: boolean }).isFavorite ?? false),
    );
  }, [view, cancelledDocs, docs, statusFilter, search]);

  const tableLoading = view === "cancelled" ? cancelledLoading : isLoading;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Document Control</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Controlled documents — SOPs, work instructions, forms and policies
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ImportDocumentDialog />
            <CreateDocumentDialog />
          </div>
        </div>

        {/* Session 52.1 — Active / Cancelled view toggle */}
        <div className="flex gap-1">
          <Button variant={view === "active" ? "default" : "outline"} size="sm" className="h-8" onClick={() => setView("active")}>
            Active
          </Button>
          <Button variant={view === "cancelled" ? "default" : "outline"} size="sm" className="h-8" onClick={() => setView("cancelled")}>
            Cancelled
          </Button>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          {view === "active" ? (
            <div className="flex gap-1 flex-wrap">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                    statusFilter === s
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {s}
                  {counts[s] !== undefined && (
                    <span className="ml-1.5 text-xs opacity-75">({counts[s]})</span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground self-center">
              Cancelled documents are retained for compliance (never deleted) and can be re-opened by an Admin.
            </p>
          )}
          <div className="relative sm:ml-auto">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search title, number, owner…"
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
                <TableHead className="w-10"></TableHead>
                <TableHead className="w-36">Doc #</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="w-16">Rev</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Review Date</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tableLoading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: 8 }).map((_, j) => (
                        <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                      ))}
                    </TableRow>
                  ))
                : filtered.length === 0
                  ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-12 text-center">
                        <div className="flex flex-col items-center gap-2 text-muted-foreground">
                          <FileText className="h-8 w-8" />
                          <p className="text-sm font-medium">
                            {view === "cancelled" ? "No cancelled documents" : "No documents found"}
                          </p>
                          {view === "cancelled"
                            ? <p className="text-xs">Cancelled documents are retained here for compliance.</p>
                            : search || statusFilter !== "All"
                              ? <p className="text-xs">Try adjusting your filters</p>
                              : <p className="text-xs">Create your first controlled document to get started</p>}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                  : filtered.map((doc) => {
                      const fav = (doc as { isFavorite?: boolean }).isFavorite ?? false;
                      const reviewOverdue =
                        doc.reviewDate &&
                        (doc.status === "Approved" || doc.status === "Effective") &&
                        isPast(parseISO(doc.reviewDate));
                      return (
                        <TableRow key={doc.id} className="cursor-pointer hover:bg-muted/40">
                          <TableCell className="pr-0 text-center">
                            <button
                              type="button"
                              onClick={(e) => toggleFavorite(e, doc)}
                              disabled={pendingFav === doc.id}
                              className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-50"
                              title={fav ? "Starred — pinned to the top. Click to remove." : "Star to pin to the top of your list"}
                              aria-label={fav ? "Remove star" : "Add star"}
                            >
                              <Star className={`h-4 w-4 ${fav ? "fill-amber-400 text-amber-400" : "text-muted-foreground/50"}`} />
                            </button>
                          </TableCell>
                          <TableCell>
                            <Link href={`/documents/${doc.id}`}>
                              <span className="font-mono text-sm font-semibold text-primary hover:underline">
                                {doc.docNumber}
                              </span>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Link href={`/documents/${doc.id}`}>
                              <p className="text-sm font-medium line-clamp-1">{doc.title}</p>
                              {doc.department && (
                                <p className="text-xs text-muted-foreground">{doc.department}</p>
                              )}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${TYPE_BADGE[doc.documentType] ?? "bg-slate-100 text-slate-600"}`}
                            >
                              {doc.documentType}
                            </span>
                            {/* Corporate or local (2026-08-28). A company-wide document is
                                written once and every site works to it; a facility document
                                belongs to this plant. Only ever says "This facility" because
                                another site's documents are not returned to this one at all. */}
                            <span className="ml-1.5 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-slate-50 text-slate-600 border-slate-200">
                              {(doc as { facilityId?: number | null }).facilityId ? "This facility" : "Company-wide"}
                            </span>
                            {/* The change-request marker (Phase 3). Not a status — the
                                document's real status is in its own column. */}
                            {(doc as { changeRequestMarker?: string | null }).changeRequestMarker ? (
                              <span className="ml-1.5 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-amber-50 text-amber-700 border-amber-200">
                                {(doc as { changeRequestMarker?: string | null }).changeRequestMarker}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <span className="text-sm font-mono text-muted-foreground">
                              {formatRevision(doc.revision, doc.status, (doc as { reviewRound?: number }).reviewRound ?? 0)}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm text-muted-foreground">
                              {doc.ownerName ?? "—"}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span
                              className={`text-sm ${reviewOverdue ? "text-orange-700 font-semibold" : "text-muted-foreground"}`}
                            >
                              {doc.reviewDate
                                ? format(parseISO(doc.reviewDate), "MMM d, yyyy")
                                : "—"}
                              {reviewOverdue && (
                                <AlertTriangle className="inline h-3 w-3 ml-1 text-orange-600" />
                              )}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_STYLES[doc.status] ?? "bg-slate-100 text-slate-600"}`}
                            >
                              {STATUS_ICONS[doc.status]}
                              {doc.status}
                            </span>
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
