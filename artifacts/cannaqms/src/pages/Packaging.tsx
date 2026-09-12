import { useState, useMemo } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useListPackagingDesigns } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { CreatePackagingDesignDialog } from "@/components/dialogs/CreatePackagingDesignDialog";
import {
  CheckCircle2,
  Clock,
  AlertCircle,
  XCircle,
  Search,
  Package,
} from "lucide-react";
import { Input } from "@/components/ui/input";

// ── Helpers ──────────────────────────────────────────────────────────────────

function statusChip(status: string) {
  const map: Record<string, { cls: string; icon: React.ReactNode }> = {
    Approved: {
      cls: "bg-green-50 text-green-700 border-green-200",
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    "Under Review": {
      cls: "bg-blue-50 text-blue-700 border-blue-200",
      icon: <Clock className="h-3 w-3" />,
    },
    "In Review": {
      cls: "bg-blue-50 text-blue-700 border-blue-200",
      icon: <Clock className="h-3 w-3" />,
    },
    Draft: {
      cls: "bg-slate-100 text-slate-600 border-slate-200",
      icon: <AlertCircle className="h-3 w-3" />,
    },
    Rejected: {
      cls: "bg-red-50 text-red-700 border-red-200",
      icon: <XCircle className="h-3 w-3" />,
    },
    Superseded: {
      cls: "bg-amber-50 text-amber-700 border-amber-200",
      icon: <AlertCircle className="h-3 w-3" />,
    },
  };
  const s = map[status] ?? {
    cls: "bg-gray-100 text-gray-600 border-gray-200",
    icon: null,
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${s.cls}`}
    >
      {s.icon}
      {status}
    </span>
  );
}

function ChecklistBar({ pct }: { pct: number }) {
  const color =
    pct === 100
      ? "bg-green-500"
      : pct >= 75
        ? "bg-yellow-500"
        : pct > 0
          ? "bg-red-400"
          : "bg-muted";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden min-w-[60px]">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={`text-xs font-medium w-8 text-right ${
          pct === 100
            ? "text-green-700"
            : pct >= 75
              ? "text-yellow-700"
              : pct > 0
                ? "text-red-600"
                : "text-muted-foreground"
        }`}
      >
        {pct}%
      </span>
    </div>
  );
}

type TabKey = "All" | "Draft" | "Review" | "Approved" | "Other";

function isReview(status: string) {
  return status === "Under Review" || status === "In Review";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Packaging() {
  const { data: designs = [], isLoading } = useListPackagingDesigns();
  const [tab, setTab] = useState<TabKey>("All");
  const [search, setSearch] = useState("");

  const counts = useMemo(
    () => ({
      all: designs.length,
      draft: designs.filter((d) => d.status === "Draft").length,
      review: designs.filter((d) => isReview(d.status)).length,
      approved: designs.filter((d) => d.status === "Approved").length,
      other: designs.filter(
        (d) =>
          d.status !== "Draft" &&
          !isReview(d.status) &&
          d.status !== "Approved",
      ).length,
    }),
    [designs],
  );

  const pendingApproval = useMemo(
    () =>
      designs.filter(
        (d) => d.status !== "Approved" && d.status !== "Superseded",
      ).length,
    [designs],
  );

  const filtered = useMemo(() => {
    let rows = designs;
    if (tab === "Draft") rows = rows.filter((d) => d.status === "Draft");
    if (tab === "Review") rows = rows.filter((d) => isReview(d.status));
    if (tab === "Approved") rows = rows.filter((d) => d.status === "Approved");
    if (tab === "Other")
      rows = rows.filter(
        (d) =>
          d.status !== "Draft" &&
          !isReview(d.status) &&
          d.status !== "Approved",
      );
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (d) =>
          d.designName.toLowerCase().includes(q) ||
          d.productType.toLowerCase().includes(q) ||
          d.version.toLowerCase().includes(q),
      );
    }
    return rows;
  }, [designs, tab, search]);

  const tabs: { label: string; key: TabKey; count: number }[] = [
    { label: "All", key: "All", count: counts.all },
    { label: "Draft", key: "Draft", count: counts.draft },
    { label: "Under Review", key: "Review", count: counts.review },
    { label: "Approved", key: "Approved", count: counts.approved },
    { label: "Other", key: "Other", count: counts.other },
  ];

  return (
    <AppLayout>
      <div className="space-y-6 max-w-5xl mx-auto">

        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Packaging Designs
            </h1>
            <p className="text-muted-foreground text-sm">
              Artwork and label approvals — Michigan R 420.401 / 420.402
              compliance.
            </p>
          </div>
          <CreatePackagingDesignDialog />
        </div>

        {/* ── Summary cards ── */}
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border bg-card p-4 text-center">
            <p className="text-xs font-semibold tracking-widest text-muted-foreground">
              APPROVED
            </p>
            <p className="text-3xl font-bold mt-1 text-green-600">
              {counts.approved}
            </p>
          </div>
          <div className="rounded-lg border bg-card p-4 text-center">
            <p className="text-xs font-semibold tracking-widest text-muted-foreground">
              PENDING APPROVAL
            </p>
            <p
              className={`text-3xl font-bold mt-1 ${pendingApproval > 0 ? "text-orange-500" : ""}`}
            >
              {pendingApproval}
            </p>
          </div>
          <div className="rounded-lg border bg-card p-4 text-center">
            <p className="text-xs font-semibold tracking-widest text-muted-foreground">
              UNDER REVIEW
            </p>
            <p
              className={`text-3xl font-bold mt-1 ${counts.review > 0 ? "text-blue-600" : ""}`}
            >
              {counts.review}
            </p>
          </div>
        </div>

        {/* ── Filters + search ── */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1 border rounded-lg p-1 bg-muted/30">
            {tabs.map(({ label, key, count }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                  tab === key
                    ? "bg-background shadow text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
                <span
                  className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs ${
                    tab === key
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {count}
                </span>
              </button>
            ))}
          </div>
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search name, product type..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm"
            />
          </div>
        </div>

        {/* ── Table ── */}
        <div className="border rounded-lg overflow-hidden bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Design Name
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Product Type
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Ver.
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Status
                </th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide min-w-[140px]">
                  Label Compliance
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 5 }).map((_, j) => (
                        <td key={j} className="px-4 py-3">
                          <Skeleton className="h-4 w-full" />
                        </td>
                      ))}
                    </tr>
                  ))
                : filtered.length === 0
                  ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="text-center py-16 text-muted-foreground"
                        >
                          {search
                            ? "No designs match your search."
                            : "No packaging designs found."}
                        </td>
                      </tr>
                    )
                  : filtered.map((design) => {
                      const pct = Math.round(
                        design.checklistCompletePct ?? 0,
                      );
                      return (
                        <tr
                          key={design.id}
                          className="hover:bg-muted/20 transition-colors"
                        >
                          <td className="px-4 py-3">
                            <Link
                              href={`/packaging/${design.id}`}
                              className="font-medium hover:underline text-foreground leading-snug"
                            >
                              {design.designName}
                            </Link>
                          </td>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                              <Package className="h-3.5 w-3.5 shrink-0" />
                              {design.productType}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-mono text-muted-foreground">
                            v{design.version}
                          </td>
                          <td className="px-4 py-3">
                            {statusChip(design.status)}
                          </td>
                          <td className="px-4 py-3">
                            <ChecklistBar pct={pct} />
                          </td>
                        </tr>
                      );
                    })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground">
          Label compliance checklist covers Michigan Administrative Code R
          420.401–420.402. Approval requires Part 11 electronic signature.
        </p>
      </div>
    </AppLayout>
  );
}
