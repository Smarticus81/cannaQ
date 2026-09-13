import {
  useGetSupplier, useUpdateSupplier, useReopenSupplier, useListSupplierAttachments, useGetSupplierRiskHistory,
  useGetCurrentUser, useGetCompanyProfile,
  getGetSupplierQueryKey, getListSuppliersQueryKey, getListSupplierAttachmentsQueryKey,
} from "@workspace/api-client-react";
import { CancelRecordDialog } from "@/components/dialogs/CancelRecordDialog";
import { Part11SignatureDialog } from "@/components/ui/Part11SignatureDialog";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Link } from "wouter";
import { format, parseISO } from "date-fns";
import {
  Printer, AlertTriangle, Clock, CheckCircle2, HelpCircle,
  RefreshCw, ShieldAlert, ShieldCheck, Shield, TrendingDown, TrendingUp, Minus,
  Pencil, Save, X, Lock, Unlock, Paperclip, Plus, Ban, RotateCcw,
} from "lucide-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, TooltipProps,
} from "recharts";

const SUPPLIER_TYPES = [
  "Cannabis Cultivator",
  "Cannabis Processor",
  "Packaging Supplier",
  "Testing Laboratory",
  "Equipment Supplier",
  "Raw Material Supplier",
  // Feedback 07-05 (SUP-1) — non-material vendors (pest control, HVAC repair,
  // cleaning companies, etc.) are Service Suppliers. Keeps them off Incoming
  // Inspections, which are for product-impacting materials only (see SUP-2 /
  // the inspection picker + server guard).
  "Service Supplier",
  "Other",
];

// Session 33 (Tier 2 #6) — "License Pending" is the new pre-approval state
// for Michigan cannabis cultivators/processors whose license number hasn't
// been provided yet. Server enforces: cannabis suppliers in this status
// (or in Conditional) cannot be selected on a new Incoming Inspection.
const SUPPLIER_STATUSES = [
  "Approved",
  "Pending Review",
  "License Pending",
  "Conditional",
  "Disqualified",
];

const QUALITY_RATINGS = ["A", "B", "C", "D", "F"];

type EditableSupplier = {
  supplierName: string;
  supplierType: string;
  status: string;
  contactPerson: string;
  email: string;
  phone: string;
  address: string;
  licenseNumber: string;
  qualityRating: string;
  notes: string;
};

function emptyDraft(): EditableSupplier {
  return {
    supplierName: "", supplierType: "", status: "Pending Review",
    contactPerson: "", email: "", phone: "", address: "",
    licenseNumber: "", qualityRating: "", notes: "",
  };
}

// ── Review status helpers ─────────────────────────────────────────────────────

const INTERVAL_OPTIONS = [
  { value: 1, label: "Every year" },
  { value: 2, label: "Every 2 years" },
  { value: 3, label: "Every 3 years" },
  { value: 4, label: "Every 4 years" },
  { value: 5, label: "Every 5 years" },
];

function ReviewStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status || status === "never-qualified") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-sm text-muted-foreground">
        <HelpCircle className="h-3.5 w-3.5" />
        Never Qualified
      </span>
    );
  }
  if (status === "overdue") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-red-300 bg-red-100 px-3 py-1 text-sm font-semibold text-red-700">
        <AlertTriangle className="h-3.5 w-3.5" />
        Overdue
      </span>
    );
  }
  if (status === "due-soon") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-700">
        <Clock className="h-3.5 w-3.5" />
        Due Soon
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-green-300 bg-green-50 px-3 py-1 text-sm font-semibold text-green-700">
      <CheckCircle2 className="h-3.5 w-3.5" />
      Current
    </span>
  );
}

// ── Risk score helpers ────────────────────────────────────────────────────────

const TIER_CONFIG: Record<string, { bar: string; line: string; badge: string; label: string; icon: typeof ShieldAlert }> = {
  Low:      { bar: "bg-green-500",  line: "#22c55e", badge: "bg-green-50 text-green-700 border-green-200",    label: "Low Risk",      icon: ShieldCheck },
  Medium:   { bar: "bg-amber-400",  line: "#f59e0b", badge: "bg-amber-50 text-amber-700 border-amber-200",    label: "Medium Risk",   icon: Shield },
  High:     { bar: "bg-orange-500", line: "#f97316", badge: "bg-orange-50 text-orange-700 border-orange-200", label: "High Risk",     icon: ShieldAlert },
  Critical: { bar: "bg-red-600",    line: "#dc2626", badge: "bg-red-50 text-red-700 border-red-200",          label: "Critical Risk", icon: ShieldAlert },
};

const TIER_COLORS: Record<string, string> = {
  Low: "#22c55e", Medium: "#f59e0b", High: "#f97316", Critical: "#dc2626",
};

function tierForScore(score: number): string {
  if (score >= 66) return "Critical";
  if (score >= 41) return "High";
  if (score >= 16) return "Medium";
  return "Low";
}

type HistoryPoint = { date: string; riskScore: number; riskTier: string; riskFactors?: string[] };

// SRS-1 — a month where the risk score moved, with the factor diff that explains
// it. `removed` factors were resolved (drove the score down); `added` factors are
// new risk (drove it up). Built by diffing consecutive reconstructed checkpoints.
type RiskChange = {
  date: string;
  fromScore: number; toScore: number;
  fromTier: string; toTier: string;
  added: string[]; removed: string[];
};

function buildRiskChanges(history: HistoryPoint[]): RiskChange[] {
  const changes: RiskChange[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const curr = history[i];
    if (curr.riskScore === prev.riskScore) continue;
    const prevF = prev.riskFactors ?? [];
    const currF = curr.riskFactors ?? [];
    const prevSet = new Set(prevF);
    const currSet = new Set(currF);
    changes.push({
      date: curr.date,
      fromScore: prev.riskScore, toScore: curr.riskScore,
      fromTier: prev.riskTier, toTier: curr.riskTier,
      added: currF.filter((f) => !prevSet.has(f)),
      removed: prevF.filter((f) => !currSet.has(f)),
    });
  }
  return changes.reverse(); // most recent first
}

// Deterministic, templated rationale for one change — no LLM, so it's fully
// reproducible and auditable for the Part 11 record.
function changeSentence(c: RiskChange): string {
  const dir = c.toScore > c.fromScore ? "rose" : "fell";
  const parts: string[] = [];
  if (c.removed.length) parts.push(`resolved: ${c.removed.join("; ")}`);
  if (c.added.length) parts.push(`new: ${c.added.join("; ")}`);
  const why = parts.length ? ` — ${parts.join(" · ")}` : "";
  const tierNote = c.fromTier !== c.toTier ? ` (${c.fromTier} → ${c.toTier})` : "";
  return `Risk ${dir} ${c.fromScore} → ${c.toScore}${tierNote}${why}.`;
}

function RiskTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload as HistoryPoint;
  const cfg = TIER_CONFIG[point.riskTier] ?? TIER_CONFIG.Low;
  const Icon = cfg.icon;
  return (
    <div className="rounded-lg border bg-white px-3 py-2 shadow-md text-sm">
      <p className="font-semibold mb-1">{format(parseISO(point.date), "MMMM yyyy")}</p>
      <p className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" style={{ color: TIER_COLORS[point.riskTier] }} />
        <span className="font-medium">{point.riskTier}</span>
        <span className="text-muted-foreground">· {point.riskScore}/100</span>
      </p>
    </div>
  );
}

function TrendIndicator({ history }: { history: HistoryPoint[] }) {
  if (history.length < 2) return null;
  const first = history[0].riskScore;
  const last  = history[history.length - 1].riskScore;
  const delta = last - first;
  if (Math.abs(delta) < 3) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="h-3 w-3" /> Stable over 12 months
      </span>
    );
  }
  if (delta > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600">
        <TrendingUp className="h-3 w-3" /> +{delta} pts over 12 months
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600">
      <TrendingDown className="h-3 w-3" /> {delta} pts over 12 months
    </span>
  );
}

// SRS-2 (2026-07-13) — turn the terse contributing-factor tags (e.g.
// "Inspection failure rate: 100%", "2 open Critical NCs") into one plain-language
// rationale sentence shown above the factor list, so the "why" reads at a glance.
function buildRiskRationale(name: string | null | undefined, tier: string, factors: string[]): string {
  const who = (name ?? "").trim() || "This supplier";
  const joined =
    factors.length === 1
      ? factors[0]
      : `${factors.slice(0, -1).join(", ")}${factors.length > 2 ? "," : ""} and ${factors[factors.length - 1]}`;
  return `${who} is currently rated ${tier} risk, driven by ${joined}.`;
}

function RiskScoreCard({
  score,
  tier,
  factors,
  supplierName,
  history,
  isLoadingHistory,
}: {
  score: number | null | undefined;
  tier: string | null | undefined;
  factors: string[] | null | undefined;
  supplierName?: string | null;
  history: HistoryPoint[] | undefined;
  isLoadingHistory: boolean;
}) {
  const { data: companyProfile } = useGetCompanyProfile();
  const scoringEnabled = !!(companyProfile as { supplierScoringEnabled?: boolean } | undefined)?.supplierScoringEnabled;
  if (score == null || !tier) return null;

  // Session 97 (#15) — until the facility opts into scoring, present the score as
  // neutral information: no tier border/badge/coloring alarm. The number, trend,
  // and factors still show. Facility flips scoring on in Settings.
  const cfg = TIER_CONFIG[tier] ?? TIER_CONFIG.Low;
  const Icon = scoringEnabled ? cfg.icon : Shield;

  return (
    <Card className={scoringEnabled ? (tier === "Critical" ? "border-red-300" : tier === "High" ? "border-orange-300" : "") : ""}>
      <CardHeader>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-muted-foreground" />
              Supplier Risk Score
            </CardTitle>
            <CardDescription>
              Computed from qualification status, NCs, inspection results, and approval history
            </CardDescription>
          </div>
          {scoringEnabled ? (
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-semibold ${cfg.badge}`}>
              <Icon className="h-3.5 w-3.5" />
              {cfg.label}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-slate-50 text-slate-600 border-slate-200 px-3 py-1 text-sm font-medium">
              <Shield className="h-3.5 w-3.5 opacity-60" />
              Informational
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {!scoringEnabled && (
          <p className="text-xs rounded-md border bg-muted/40 px-3 py-2 text-muted-foreground">
            Supplier scoring alarms are off for this facility — the score below is shown for information only. Turn scoring on in <span className="font-medium">Settings → Company Profile → Supplier Risk Scoring</span> to activate risk tiers and alerts.
          </p>
        )}

        {/* Current score bar */}
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Current Score</span>
            <span className="text-2xl font-bold tabular-nums">{score}<span className="text-sm font-normal text-muted-foreground">/100</span></span>
          </div>
          <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${scoringEnabled ? cfg.bar : "bg-slate-400"}`}
              style={{ width: `${score}%` }}
            />
          </div>
          <div className="flex justify-between mt-1 text-[10px] text-muted-foreground">
            <span>0 — Low</span>
            <span>16 — Medium</span>
            <span>41 — High</span>
            <span>66 — Critical</span>
          </div>
        </div>

        {/* 12-month trend chart */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              12-Month Risk Trend
            </p>
            {history && <TrendIndicator history={history} />}
          </div>

          {isLoadingHistory ? (
            <Skeleton className="h-40 w-full" />
          ) : history && history.length > 1 ? (
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={history} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                {/* Tier threshold bands */}
                <ReferenceLine y={66} stroke="#dc2626" strokeDasharray="4 4" strokeOpacity={0.4} />
                <ReferenceLine y={41} stroke="#f97316" strokeDasharray="4 4" strokeOpacity={0.4} />
                <ReferenceLine y={16} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.4} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d: string) => format(parseISO(d), "MMM")}
                  tick={{ fontSize: 10, fill: "#94a3b8" }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 16, 41, 66, 100]}
                  tick={{ fontSize: 10, fill: "#94a3b8" }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<RiskTooltip />} />
                <Line
                  type="monotone"
                  dataKey="riskScore"
                  stroke={cfg.line}
                  strokeWidth={2.5}
                  dot={(props) => {
                    const { cx, cy, payload } = props as { cx: number; cy: number; payload: HistoryPoint };
                    const color = TIER_COLORS[payload.riskTier] ?? "#94a3b8";
                    return <circle key={`dot-${payload.date}`} cx={cx} cy={cy} r={3.5} fill={color} stroke="white" strokeWidth={1.5} />;
                  }}
                  activeDot={{ r: 5, strokeWidth: 1.5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-20 flex items-center justify-center text-sm text-muted-foreground">
              Not enough historical data to display a trend.
            </div>
          )}

          {/* Tier legend */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
            {[
              { tier: "Low",      label: "Low (0–15)",       color: "#22c55e" },
              { tier: "Medium",   label: "Medium (16–40)",   color: "#f59e0b" },
              { tier: "High",     label: "High (41–65)",     color: "#f97316" },
              { tier: "Critical", label: "Critical (66+)",   color: "#dc2626" },
            ].map(({ tier: t, label, color }) => (
              <span key={t} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* SRS-1 — "What changed": a templated, deterministic explanation for each
            month the score moved, built by diffing the contributing factors. */}
        {history && (() => {
          const changes = buildRiskChanges(history);
          if (changes.length === 0) return null;
          return (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                What Changed
              </p>
              <ul className="space-y-2">
                {changes.map((c) => {
                  const up = c.toScore > c.fromScore;
                  return (
                    <li key={c.date} className="flex items-start gap-2 text-sm">
                      {up
                        ? <TrendingUp className="h-3.5 w-3.5 shrink-0 mt-0.5 text-red-500" />
                        : <TrendingDown className="h-3.5 w-3.5 shrink-0 mt-0.5 text-green-600" />}
                      <div>
                        <span className="text-xs text-muted-foreground">{format(parseISO(c.date), "MMM yyyy")}: </span>
                        {changeSentence(c)}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })()}

        {/* Risk factors */}
        {factors && factors.length > 0 ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Contributing Factors
            </p>
            {/* SRS-2 — plain-language rationale synthesized from the tags below. */}
            <p className="text-sm mb-3 rounded-md border bg-muted/30 px-3 py-2">
              {buildRiskRationale(supplierName, tier, factors)}
            </p>
            <ul className="space-y-1.5">
              {factors.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
                  {f}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-green-700 flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4" />
            No risk factors identified — supplier is in good standing.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// SRS-1 Part 2 — pending rating-change review card. Shows the open change (if
// any) and lets Manager/Quality acknowledge an increase or approve a held
// decrease with a Part 11 signature. Renders nothing when there's no pending
// change.
type RiskChangeRecord = {
  id: number; direction: string; fromTier: string; toTier: string;
  fromScore: number; toScore: number; rationale: string; detectedAt: string; status: string;
};

function SupplierRatingReviewCard({ supplierId, canReview }: { supplierId: number; canReview: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [sigOpen, setSigOpen] = useState(false);
  const [signing, setSigning] = useState(false);
  const { data } = useQuery<RiskChangeRecord[]>({
    queryKey: ["supplier-risk-changes", supplierId],
    queryFn: async () => {
      const r = await fetch(`/api/suppliers/${supplierId}/risk-changes`);
      if (!r.ok) throw new Error("Failed to load rating changes");
      return r.json();
    },
  });
  const pending = data?.find((c) => c.status === "Pending");
  if (!pending) return null;
  const isIncrease = pending.direction === "increase";

  const onSign = async (initials: string, meaning: string) => {
    setSigning(true);
    try {
      const r = await fetch(`/api/supplier-risk-changes/${pending.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initials, signatureMeaning: meaning }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(err.error ?? "Review failed");
      }
      await queryClient.invalidateQueries({ queryKey: ["supplier-risk-changes", supplierId] });
      await queryClient.invalidateQueries({ queryKey: getGetSupplierQueryKey(supplierId) });
      toast({
        title: isIncrease ? "Rating increase acknowledged" : "Rating decrease approved",
        description: pending.rationale,
      });
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Review failed", variant: "destructive" });
      throw e; // keep the signature dialog open on failure
    } finally {
      setSigning(false);
    }
  };

  return (
    <Card className={isIncrease ? "border-amber-300 bg-amber-50/40 dark:bg-amber-950/20" : "border-blue-300 bg-blue-50/40 dark:bg-blue-950/20"}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" />
          Rating Change — Review Required
          <Badge variant={isIncrease ? "destructive" : "default"} className="ml-1">
            {isIncrease ? "Increase" : "Decrease"}
          </Badge>
        </CardTitle>
        <CardDescription className="text-xs">
          {isIncrease
            ? `Risk was raised to ${pending.toTier} and applied immediately — a Manager/Quality acknowledgement is required.`
            : `A reduction to ${pending.toTier} is proposed. The official rating is held at ${pending.fromTier} until Manager/Quality approve it.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm rounded-md border bg-background/60 px-3 py-2">{pending.rationale}</p>
        <p className="text-xs text-muted-foreground">
          {pending.fromTier} → {pending.toTier} · detected {format(parseISO(pending.detectedAt), "MMM d, yyyy")}
        </p>
        {canReview ? (
          <Button size="sm" onClick={() => setSigOpen(true)}>
            {isIncrease ? "Acknowledge" : "Approve reduction"}
          </Button>
        ) : (
          <p className="text-xs italic text-muted-foreground">Manager, Quality, or Admin review required.</p>
        )}
      </CardContent>
      <Part11SignatureDialog
        open={sigOpen}
        onOpenChange={setSigOpen}
        title={isIncrease ? "Acknowledge rating increase" : "Approve rating reduction"}
        description={isIncrease
          ? "By signing, you acknowledge this supplier's risk-rating increase (21 CFR Part 11)."
          : "By signing, you approve reducing this supplier's risk rating. The official rating will drop to the proposed tier (21 CFR Part 11)."}
        onSign={onSign}
        isPending={signing}
      />
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SupplierDetail(props: { params?: { id: string } }) {
  const id = parseInt(props.params?.id ?? "0");
  const { data: supplier, isLoading } = useGetSupplier(id);
  const { data: currentUser } = useGetCurrentUser();
  const { data: attachments, isLoading: isLoadingAttachments } = useListSupplierAttachments(id);
  const { data: riskHistory, isLoading: isLoadingHistory } = useGetSupplierRiskHistory(id);
  const updateSupplier = useUpdateSupplier();
  const reopenSupplier = useReopenSupplier();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Session 52.2 — Cancel / Re-open (Part 11). Cancel = soft, recoverable,
  // e-signed (replaces the old hard delete). Re-open is Admin-only.
  const CANCEL_ROLES = new Set(["Manager", "Quality", "Admin"]);
  const isCancelled = !!(supplier as { cancelledAt?: string | null } | undefined)?.cancelledAt;
  const canCancel = !!currentUser?.role && CANCEL_ROLES.has(currentUser.role);
  const canReopen = currentUser?.role === "Admin";
  // SRS-1 Part 2 — Manager/Quality/Admin may review supplier rating changes.
  const canReviewRating = !!currentUser?.role && CANCEL_ROLES.has(currentUser.role);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [uncancelOpen, setUncancelOpen] = useState(false);
  const [uncancelPending, setUncancelPending] = useState(false);

  const invalidateSupplier = () => {
    queryClient.invalidateQueries({ queryKey: getGetSupplierQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
  };
  const handleCancel = async (reason: string, initials: string, meaning: string) => {
    setCancelPending(true);
    try {
      const r = await fetch(`/api/suppliers/${id}/cancel`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, initials, signatureMeaning: meaning }),
      });
      if (!r.ok) { const b = await r.json().catch(() => ({} as { error?: string })); throw new Error(b.error ?? "Failed to cancel supplier."); }
      invalidateSupplier();
      toast({ title: "Supplier cancelled", description: "Retained and recoverable; removed from active use." });
    } finally { setCancelPending(false); }
  };
  const handleUncancel = async (initials: string, meaning: string) => {
    setUncancelPending(true);
    try {
      const r = await fetch(`/api/suppliers/${id}/uncancel`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initials, signatureMeaning: meaning }),
      });
      if (!r.ok) { const b = await r.json().catch(() => ({} as { error?: string })); throw new Error(b.error ?? "Failed to re-open supplier."); }
      invalidateSupplier();
      toast({ title: "Supplier re-opened", description: "Record returned to active use." });
    } finally { setUncancelPending(false); }
  };

  const [savingInterval, setSavingInterval] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditableSupplier>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Session 32 — Approved-supplier freeze + Reopen for Revision dialog state.
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);

  // Session 32 — Inline attach-file form. The server's POST /suppliers/:id/
  // attachments stub accepts metadata only (fileType / fileName / filePath /
  // notes); actual blob storage is a follow-up. The point of this UI is to
  // unblock the operator from the previous "no attach button anywhere on the
  // saved-supplier page" state — file attachments must be addable at any
  // status (per Tier 1 #5 in the priority list).
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachDraft, setAttachDraft] = useState({ fileType: "", fileName: "", filePath: "", notes: "" });
  const [attachSaving, setAttachSaving] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  // Session 33 (Tier 2 #9) — Change Risk Tier dialog. Tier changes require a
  // fresh rationale on every move; the server rejects PATCHes that change
  // riskTier without a riskTierRationale in the same body.
  const [tierOpen, setTierOpen] = useState(false);
  const [tierDraft, setTierDraft] = useState<{ riskTier: string; rationale: string }>({ riskTier: "", rationale: "" });
  const [tierSaving, setTierSaving] = useState(false);
  const [tierError, setTierError] = useState<string | null>(null);

  const isLocked = supplier?.status === "Approved";

  useEffect(() => {
    if (supplier && !editing) {
      setDraft({
        supplierName:  supplier.supplierName ?? "",
        supplierType:  supplier.supplierType ?? "",
        status:        supplier.status ?? "Pending Review",
        contactPerson: supplier.contactPerson ?? "",
        email:         supplier.email ?? "",
        phone:         supplier.phone ?? "",
        address:       supplier.address ?? "",
        licenseNumber: supplier.licenseNumber ?? "",
        qualityRating: supplier.qualityRating ?? "",
        notes:         supplier.notes ?? "",
      });
    }
  }, [supplier, editing]);

  function setField<K extends keyof EditableSupplier>(key: K, value: EditableSupplier[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function startEdit() {
    setSaveError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setSaveError(null);
    setEditing(false);
    if (supplier) {
      setDraft({
        supplierName:  supplier.supplierName ?? "",
        supplierType:  supplier.supplierType ?? "",
        status:        supplier.status ?? "Pending Review",
        contactPerson: supplier.contactPerson ?? "",
        email:         supplier.email ?? "",
        phone:         supplier.phone ?? "",
        address:       supplier.address ?? "",
        licenseNumber: supplier.licenseNumber ?? "",
        qualityRating: supplier.qualityRating ?? "",
        notes:         supplier.notes ?? "",
      });
    }
  }

  async function saveEdit() {
    setSaveError(null);
    if (!draft.supplierName.trim()) {
      setSaveError("Supplier name is required.");
      return;
    }
    if (!draft.supplierType) {
      setSaveError("Supplier type is required.");
      return;
    }
    if (draft.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email)) {
      setSaveError("Email is not valid.");
      return;
    }
    setSaving(true);
    try {
      await updateSupplier.mutateAsync({
        id,
        data: {
          supplierName:  draft.supplierName.trim(),
          supplierType:  draft.supplierType,
          status:        draft.status,
          contactPerson: draft.contactPerson || null,
          email:         draft.email || null,
          phone:         draft.phone || null,
          address:       draft.address || null,
          licenseNumber: draft.licenseNumber || null,
          qualityRating: draft.qualityRating || null,
          notes:         draft.notes || null,
        },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetSupplierQueryKey(id) }),
        queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() }),
      ]);
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save supplier.");
    } finally {
      setSaving(false);
    }
  }

  async function handleIntervalChange(years: string) {
    setSavingInterval(true);
    try {
      await updateSupplier.mutateAsync({
        id,
        data: { requalificationIntervalYears: parseInt(years) },
      });
      await queryClient.invalidateQueries({ queryKey: getGetSupplierQueryKey(id) });
    } finally {
      setSavingInterval(false);
    }
  }

  // Session 32 — Reopen an Approved supplier for revision. Session 33.1
  // swapped the raw fetch for the orval-typed useReopenSupplier mutation
  // now that the endpoint is in the spec.
  async function handleReopen() {
    setReopenError(null);
    if (!reopenReason.trim()) {
      setReopenError("A reason is required to reopen this supplier for revision.");
      return;
    }
    setReopening(true);
    try {
      await reopenSupplier.mutateAsync({ id, data: { reason: reopenReason.trim() } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetSupplierQueryKey(id) }),
        queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() }),
      ]);
      setReopenOpen(false);
      setReopenReason("");
    } catch (err) {
      setReopenError(err instanceof Error ? err.message : "Failed to reopen supplier.");
    } finally {
      setReopening(false);
    }
  }

  // Session 33 (Tier 2 #9) — Change Risk Tier with required rationale.
  async function handleChangeTier() {
    setTierError(null);
    if (!tierDraft.riskTier) { setTierError("Select a new Risk Tier."); return; }
    if (tierDraft.riskTier === supplier?.riskTier) {
      setTierError("New tier matches current tier. Pick a different tier or cancel.");
      return;
    }
    if (!tierDraft.rationale.trim()) {
      setTierError("Rationale is required when changing Risk Tier.");
      return;
    }
    setTierSaving(true);
    try {
      await updateSupplier.mutateAsync({
        id,
        data: {
          riskTier: tierDraft.riskTier,
          riskTierRationale: tierDraft.rationale.trim(),
        } as never,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetSupplierQueryKey(id) }),
        queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() }),
      ]);
      setTierOpen(false);
      setTierDraft({ riskTier: "", rationale: "" });
    } catch (err) {
      setTierError(err instanceof Error ? err.message : "Failed to change Risk Tier.");
    } finally {
      setTierSaving(false);
    }
  }

  // Session 32 — Attach a new file (metadata) to the saved supplier.
  async function handleAttach() {
    setAttachError(null);
    if (!attachDraft.fileName.trim()) { setAttachError("File name is required."); return; }
    if (!attachDraft.fileType.trim()) { setAttachError("File type is required."); return; }
    if (!attachDraft.filePath.trim()) { setAttachError("File path or URL is required."); return; }
    setAttachSaving(true);
    try {
      const r = await fetch(`/api/suppliers/${id}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fileType: attachDraft.fileType.trim(),
          fileName: attachDraft.fileName.trim(),
          filePath: attachDraft.filePath.trim(),
          notes: attachDraft.notes.trim() || null,
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setAttachError(data.error ?? "Failed to attach file.");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: getListSupplierAttachmentsQueryKey(id) });
      setAttachOpen(false);
      setAttachDraft({ fileType: "", fileName: "", filePath: "", notes: "" });
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : "Failed to attach file.");
    } finally {
      setAttachSaving(false);
    }
  }

  return (
    <>
      <div className="space-y-6 max-w-5xl mx-auto pb-12 print:max-w-none">

        {/* Print-only header */}
        <div className="hidden print:block border-b-2 border-black pb-4 mb-6">
          <div className="cq-page-heading flex items-start justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">CannaQ · Supplier Record</p>
              <h1 className="text-2xl font-bold">{supplier?.supplierName}</h1>
              <p className="text-base text-gray-600">{supplier?.supplierType}</p>
            </div>
            <div className="text-right text-xs text-gray-500 space-y-1">
              <p>Status: <strong>{supplier?.status}</strong></p>
              {supplier?.licenseNumber && <p>License: <strong>{supplier.licenseNumber}</strong></p>}
              <p>Risk: <strong>{supplier?.riskTier ?? "N/A"} ({supplier?.riskScore ?? "—"}/100)</strong></p>
              <p>Re-qual cycle: <strong>Every {supplier?.requalificationIntervalYears} year{supplier?.requalificationIntervalYears !== 1 ? "s" : ""}</strong></p>
              {supplier?.nextReviewDue && <p>Next review due: <strong>{format(new Date(supplier.nextReviewDue + "T00:00:00"), "MMMM d, yyyy")}</strong></p>}
              <p>Printed: {format(new Date(), "MMMM d, yyyy")}</p>
            </div>
          </div>
        </div>

        {/* Screen header */}
        <div className="print:hidden">
          <Link href="/suppliers" className="text-sm text-primary hover:underline mb-2 block">
            &larr; Back to Suppliers
          </Link>
          <div className="cq-page-heading flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                {supplier?.supplierName || <Skeleton className="h-8 w-[200px]" />}
              </h1>
              <p className="text-muted-foreground">Supplier Details</p>
            </div>
            <div className="flex items-center gap-2">
              {editing ? (
                <>
                  <Button variant="outline" size="sm" onClick={cancelEdit} disabled={saving} className="gap-1.5">
                    <X className="h-4 w-4" /> Cancel
                  </Button>
                  <Button size="sm" onClick={saveEdit} disabled={saving} className="gap-1.5">
                    <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save Changes"}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-1.5">
                    <Printer className="h-4 w-4" /> Print
                  </Button>
                  {/* Session 52.2 — Cancel (soft, Part 11) replaces hard delete. */}
                  {supplier && !isCancelled && canCancel && (
                    <Button variant="outline" size="sm" onClick={() => setCancelOpen(true)} className="gap-1.5 text-destructive hover:text-destructive" data-testid="button-cancel-supplier">
                      <Ban className="h-4 w-4" /> Cancel
                    </Button>
                  )}
                  {supplier && isCancelled && canReopen && (
                    <Button variant="outline" size="sm" onClick={() => setUncancelOpen(true)} disabled={uncancelPending} className="gap-1.5" data-testid="button-reopen-supplier">
                      <RotateCcw className="h-4 w-4" /> Re-open
                    </Button>
                  )}
                  {/* Session 32 — Approved suppliers are frozen. Edit is
                      disabled until a Reopen-for-Revision is logged. Hidden
                      entirely when the supplier is cancelled (read-only). */}
                  {!isCancelled && (isLocked ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setReopenOpen(true)}
                      disabled={!supplier}
                      className="gap-1.5"
                    >
                      <Unlock className="h-4 w-4" /> Reopen for Revision
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={startEdit} disabled={!supplier} className="gap-1.5">
                      <Pencil className="h-4 w-4" /> Edit
                    </Button>
                  ))}
                  {supplier && (
                    <Badge
                      variant={isCancelled ? "destructive" : supplier.status === "Approved" ? "default" : "secondary"}
                      className="text-sm py-1 px-3"
                    >
                      {isCancelled ? "Cancelled" : supplier.status}
                    </Badge>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Session 52.2 — Cancelled banner (Part 11 record of who/why). */}
        {isCancelled && supplier && (
          <div className="rounded-lg border-2 border-red-200 bg-red-50 px-4 py-3 print:hidden" data-testid="banner-supplier-cancelled">
            <p className="text-sm font-semibold text-red-900 flex items-center gap-2">
              <Ban className="h-4 w-4" /> This supplier has been cancelled
            </p>
            <p className="text-xs text-red-800 mt-1">
              {(supplier as { cancelledByName?: string | null }).cancelledByName}
              {(supplier as { cancelledByInitials?: string | null }).cancelledByInitials ? ` (${(supplier as { cancelledByInitials?: string | null }).cancelledByInitials})` : ""}
              {(supplier as { cancelledAt?: string | null }).cancelledAt ? ` · ${format(new Date((supplier as { cancelledAt?: string | null }).cancelledAt as string), "MMM d, yyyy h:mm a")}` : ""}
            </p>
            {(supplier as { cancelledReason?: string | null }).cancelledReason && (
              <p className="text-sm text-red-900 mt-1.5 whitespace-pre-wrap">
                <span className="font-medium">Reason:</span> {(supplier as { cancelledReason?: string | null }).cancelledReason}
              </p>
            )}
            <p className="text-[11px] text-red-700 mt-1 italic">Retained for compliance; can be re-opened by an Admin only.</p>
          </div>
        )}

        {/* License-record requirement (2026-08-06) — flag a license-required
            supplier (cannabis licensee, testing lab, or any supplier with a
            license number on file) that has no current license/certificate. */}
        {!isCancelled && supplier &&
          ((supplier as { licenseCompliance?: string }).licenseCompliance === "missing" ||
           (supplier as { licenseCompliance?: string }).licenseCompliance === "expired") && (
          <div className="rounded-lg border-2 border-red-200 bg-red-50 px-4 py-3 print:hidden" data-testid="banner-supplier-license">
            <p className="text-sm font-semibold text-red-900 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {(supplier as { licenseCompliance?: string }).licenseCompliance === "expired"
                ? "License / certificate on file has expired"
                : "License / certificate required — none on file"}
            </p>
            <p className="text-xs text-red-800 mt-1">
              This supplier type — or the license number on file — requires a current license or certificate with an expiry date.
              Add one under <strong>Approval &amp; Certificates</strong>. The supplier can&rsquo;t be marked <strong>Approved</strong> until a current record is on file, and you&rsquo;ll be reminded as the expiry approaches.
            </p>
          </div>
        )}

        {/* Separation of duties (2026-08-06) — the creator can't approve their
            own supplier; a second person must. Proactive hint shown to the creator. */}
        {!isCancelled && supplier && supplier.status !== "Approved" &&
          (currentUser as { id?: number } | undefined)?.id != null &&
          (currentUser as { id?: number } | undefined)?.id === (supplier as { createdById?: number | null }).createdById && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 flex items-center gap-2 print:hidden">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>You created this supplier, so you can&rsquo;t approve it yourself. A different person (Manager/Quality/Admin) must review and approve it &mdash; separation of duties.</span>
          </div>
        )}

        {editing && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-800 flex items-center gap-2 print:hidden">
            <Pencil className="h-4 w-4 shrink-0" />
            <span><strong>Edit mode.</strong> Changes are tracked per 21 CFR Part 11 §11.10(e); save to commit a new audit-trail entry.</span>
          </div>
        )}
        {/* Session 32 — visible freeze indicator. Approved suppliers are
            locked at the server (PATCH returns 409) and at the client (Edit
            button is hidden). Reopen-for-Revision unlocks with audit log. */}
        {isLocked && !editing && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900 flex items-center gap-2 print:hidden">
            <Lock className="h-4 w-4 shrink-0" />
            <span>
              <strong>Approved — record is locked.</strong> Qualification cycle and all other fields are read-only.
              Click <em>Reopen for Revision</em> to unlock with a reason (logged to the audit trail).
            </span>
          </div>
        )}
        {saveError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700 print:hidden">
            {saveError}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Information */}
          <Card>
            <CardHeader>
              <CardTitle>Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-[80%]" />
                </div>
              ) : editing ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Label htmlFor="supplierName" className="text-xs font-medium text-muted-foreground">Supplier Name *</Label>
                    <Input
                      id="supplierName"
                      value={draft.supplierName}
                      onChange={(e) => setField("supplierName", e.target.value)}
                      className="mt-1 h-9"
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-medium text-muted-foreground">Type *</Label>
                    <Select value={draft.supplierType} onValueChange={(v) => setField("supplierType", v)}>
                      <SelectTrigger className="mt-1 h-9 text-sm"><SelectValue placeholder="Select type" /></SelectTrigger>
                      <SelectContent>
                        {SUPPLIER_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs font-medium text-muted-foreground">Status</Label>
                    <Select value={draft.status} onValueChange={(v) => setField("status", v)}>
                      <SelectTrigger className="mt-1 h-9 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {SUPPLIER_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="licenseNumber" className="text-xs font-medium text-muted-foreground">License Number</Label>
                    <Input
                      id="licenseNumber"
                      value={draft.licenseNumber}
                      onChange={(e) => setField("licenseNumber", e.target.value)}
                      placeholder="MICL-000000"
                      className="mt-1 h-9"
                    />
                  </div>
                  <div>
                    <Label htmlFor="contactPerson" className="text-xs font-medium text-muted-foreground">Contact Person</Label>
                    <Input
                      id="contactPerson"
                      value={draft.contactPerson}
                      onChange={(e) => setField("contactPerson", e.target.value)}
                      className="mt-1 h-9"
                    />
                  </div>
                  <div>
                    <Label htmlFor="email" className="text-xs font-medium text-muted-foreground">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      value={draft.email}
                      onChange={(e) => setField("email", e.target.value)}
                      className="mt-1 h-9"
                    />
                  </div>
                  <div>
                    <Label htmlFor="phone" className="text-xs font-medium text-muted-foreground">Phone</Label>
                    <Input
                      id="phone"
                      value={draft.phone}
                      onChange={(e) => setField("phone", e.target.value)}
                      placeholder="(555) 000-0000"
                      className="mt-1 h-9"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor="address" className="text-xs font-medium text-muted-foreground">Address</Label>
                    <Textarea
                      id="address"
                      value={draft.address}
                      onChange={(e) => setField("address", e.target.value)}
                      rows={2}
                      className="mt-1 text-sm"
                    />
                  </div>
                </div>
              ) : (
                <dl className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Type</dt>
                    <dd className="mt-1 text-sm">{supplier?.supplierType}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">License</dt>
                    <dd className="mt-1 text-sm">{supplier?.licenseNumber || "N/A"}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Contact Person</dt>
                    <dd className="mt-1 text-sm">{supplier?.contactPerson || "N/A"}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Email</dt>
                    <dd className="mt-1 text-sm">{supplier?.email || "N/A"}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Phone</dt>
                    <dd className="mt-1 text-sm">{supplier?.phone || "N/A"}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-sm font-medium text-muted-foreground">Address</dt>
                    <dd className="mt-1 text-sm">{supplier?.address || "N/A"}</dd>
                  </div>
                </dl>
              )}
            </CardContent>
          </Card>

          {/* Quality Metrics */}
          <Card>
            <CardHeader>
              <CardTitle>Quality Metrics</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-[80%]" />
                </div>
              ) : editing ? (
                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <Label className="text-xs font-medium text-muted-foreground">Quality Rating</Label>
                    <Select
                      value={draft.qualityRating || "__none__"}
                      onValueChange={(v) => setField("qualityRating", v === "__none__" ? "" : v)}
                    >
                      <SelectTrigger className="mt-1 h-9 text-sm w-full max-w-[200px]"><SelectValue placeholder="Not rated" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Not rated</SelectItem>
                        {QUALITY_RATINGS.map((r) => <SelectItem key={r} value={r}>Grade {r}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="notes" className="text-xs font-medium text-muted-foreground">Notes</Label>
                    <Textarea
                      id="notes"
                      value={draft.notes}
                      onChange={(e) => setField("notes", e.target.value)}
                      rows={4}
                      placeholder="Add internal notes about this supplier…"
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Last Updated</p>
                    <p className="mt-1 text-sm">
                      {supplier?.updatedAt ? format(new Date(supplier.updatedAt), "MMM d, yyyy") : "N/A"}
                    </p>
                  </div>
                </div>
              ) : (
                <dl className="grid grid-cols-1 gap-y-4">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Quality Rating</dt>
                    <dd className="mt-1 text-sm">{supplier?.qualityRating || "N/A"}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Notes</dt>
                    <dd className="mt-1 text-sm text-muted-foreground">{supplier?.notes || "No notes."}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Last Updated</dt>
                    <dd className="mt-1 text-sm">
                      {supplier?.updatedAt ? format(new Date(supplier.updatedAt), "MMM d, yyyy") : "N/A"}
                    </dd>
                  </div>
                </dl>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Risk Score + Trend Card */}
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="space-y-3">
            <RiskScoreCard
              score={supplier?.riskScore}
              tier={supplier?.riskTier}
              factors={supplier?.riskFactors}
              supplierName={supplier?.supplierName}
              history={riskHistory as HistoryPoint[] | undefined}
              isLoadingHistory={isLoadingHistory}
            />
            {supplier && !isCancelled && (
              <SupplierRatingReviewCard supplierId={id} canReview={canReviewRating} />
            )}
            {/* Session 33 (Tier 2 #9) — Change Risk Tier requires fresh rationale.
                Lineage fields land via the orval-regenerated Supplier shape
                (Session 33.1). */}
            {!isLocked && supplier && (
              <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-4 py-2.5 text-sm print:hidden">
                <div className="space-y-0.5">
                  <p className="text-sm">
                    Operator-set tier: <strong>{supplier.riskTier ?? "Not set"}</strong>
                  </p>
                  {supplier.riskTierRationale && (
                    <p className="text-xs text-muted-foreground">
                      Rationale: {supplier.riskTierRationale}
                      {supplier.riskTierSetByName && <> &middot; set by {supplier.riskTierSetByName}</>}
                      {supplier.riskTierSetAt && <> on {format(new Date(supplier.riskTierSetAt), "MMM d, yyyy")}</>}
                    </p>
                  )}
                </div>
                <Button variant="outline" size="sm" onClick={() => { setTierDraft({ riskTier: supplier.riskTier ?? "Medium", rationale: "" }); setTierOpen(true); }}>
                  Change Risk Tier
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Re-qualification Review */}
        <Card className={supplier?.reviewStatus === "overdue" ? "border-red-300" : supplier?.reviewStatus === "due-soon" ? "border-amber-300" : ""}>
          <CardHeader>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <RefreshCw className="h-4 w-4 text-muted-foreground" />
                  Re-qualification Review
                </CardTitle>
                <CardDescription>
                  Periodic supplier re-qualification per ISO 13485:2016 §7.4 and Michigan CRA R 420
                </CardDescription>
              </div>
              {supplier && <ReviewStatusBadge status={supplier.reviewStatus} />}
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                {/* Last qualified */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                    Last Qualified
                  </p>
                  <p className="text-sm font-medium">
                    {supplier?.lastQualifiedDate
                      ? format(new Date(supplier.lastQualifiedDate + "T00:00:00"), "MMMM d, yyyy")
                      : <span className="text-muted-foreground italic">No approved qualification on record</span>}
                  </p>
                </div>

                {/* Next review due */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                    Next Review Due
                  </p>
                  <p className={`text-sm font-medium ${supplier?.reviewStatus === "overdue" ? "text-red-600" : supplier?.reviewStatus === "due-soon" ? "text-amber-600" : ""}`}>
                    {supplier?.nextReviewDue
                      ? format(new Date(supplier.nextReviewDue + "T00:00:00"), "MMMM d, yyyy")
                      : <span className="text-muted-foreground italic">N/A — qualify supplier first</span>}
                  </p>
                  {supplier?.reviewStatus === "overdue" && supplier.nextReviewDue && (
                    <p className="text-xs text-red-500 mt-0.5">
                      {Math.ceil((new Date().getTime() - new Date(supplier.nextReviewDue + "T00:00:00").getTime()) / 86_400_000)} days overdue
                    </p>
                  )}
                  {/* Session 97 (#14 / 5d) — say WHY the next review lands here:
                      a certificate expiry (earliest wins) or the fixed interval fallback. */}
                  {supplier && (supplier as { reviewDriver?: string | null }).reviewDriver && supplier.nextReviewDue && (
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Driven by {(supplier as { reviewDriver?: string | null }).reviewDriver}
                    </p>
                  )}
                </div>

                {/* Review interval selector */}
                <div className="print:hidden">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                    Re-qualification Cycle
                  </p>
                  <Select
                    value={String(supplier?.requalificationIntervalYears ?? 1)}
                    onValueChange={handleIntervalChange}
                    disabled={savingInterval}
                  >
                    <SelectTrigger className="h-9 text-sm w-full max-w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INTERVAL_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={String(opt.value)}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {savingInterval && (
                    <p className="text-xs text-muted-foreground mt-1">Saving…</p>
                  )}
                </div>

                {/* Print-only cycle */}
                <div className="hidden print:block">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                    Re-qualification Cycle
                  </p>
                  <p className="text-sm font-medium">
                    Every {supplier?.requalificationIntervalYears} year{supplier?.requalificationIntervalYears !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
            )}

            {/* Overdue alert */}
            {supplier?.reviewStatus === "overdue" && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-red-600" />
                <p>
                  <strong>Action required.</strong> This supplier's re-qualification is overdue.
                  Schedule a new qualification assessment and update the record to maintain
                  ISO 13485:2016 §7.4 compliance.
                </p>
              </div>
            )}
            {supplier?.reviewStatus === "due-soon" && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <Clock className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
                <p>
                  <strong>Review approaching.</strong> Schedule a re-qualification assessment
                  before the due date to avoid a lapse in supplier approval status.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Attachments */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2"><Paperclip className="h-4 w-4" /> Attachments</CardTitle>
                <CardDescription>
                  Supplier documentation and certificates.
                  {/* Session 32 — Tier 1 #5: attachments must be addable at any
                      status. Previously this card was read-only on the saved
                      supplier page (no upload UI was rendered). */}
                  {" "}Add files at any time — additions are audit-logged.
                </CardDescription>
              </div>
              <Button size="sm" variant="outline" onClick={() => setAttachOpen(true)} disabled={!supplier} className="gap-1.5 shrink-0">
                <Plus className="h-4 w-4" /> Attach file
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {isLoadingAttachments ? (
              <Skeleton className="h-10 w-full" />
            ) : attachments?.length === 0 ? (
              <p className="text-sm text-muted-foreground">No attachments yet. Use <em>Attach file</em> to add the first one.</p>
            ) : (
              <ul className="divide-y border rounded-md">
                {attachments?.map((attachment) => (
                  <li key={attachment.id} className="flex items-center justify-between py-3 px-4 text-sm">
                    <div className="flex flex-col">
                      <span className="font-medium">{attachment.fileName}</span>
                      <span className="text-muted-foreground text-xs">{attachment.fileType}</span>
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {format(new Date(attachment.createdAt), "MMM d, yyyy")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

      </div>

      {/* Session 32 — Reopen for Revision dialog. Requires a reason; server
          logs it to the audit trail and flips status Approved → Pending Review. */}
      <Dialog open={reopenOpen} onOpenChange={(v) => { setReopenOpen(v); if (!v) { setReopenReason(""); setReopenError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Unlock className="h-5 w-5" /> Reopen Supplier for Revision</DialogTitle>
            <DialogDescription>
              This supplier is currently <strong>Approved</strong> and frozen. Reopening unlocks all fields
              for editing and sets status back to <em>Pending Review</em> until the next approval cycle.
              The reason you provide here is recorded in the audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="reopen-reason">Reason for reopening *</Label>
            <Textarea
              id="reopen-reason"
              rows={4}
              placeholder="e.g. Updated license expiration date; address correction; new contact person; revised qualification interval."
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
            />
            {reopenError && <p className="text-sm text-destructive">{reopenError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenOpen(false)} disabled={reopening}>Cancel</Button>
            <Button onClick={handleReopen} disabled={reopening || !reopenReason.trim()}>
              {reopening ? "Reopening…" : "Reopen for Revision"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Session 52.2 — Cancel (rationale + Part 11 e-signature). */}
      <CancelRecordDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        entityLabel="Supplier"
        isPending={cancelPending}
        onConfirm={handleCancel}
      />

      {/* Session 52.2 — Re-open (Admin-only; Part 11 e-signature). */}
      <Part11SignatureDialog
        open={uncancelOpen}
        onOpenChange={setUncancelOpen}
        title="Re-open Supplier"
        description="Re-open this cancelled supplier and return it to active use. Restricted to Admin; requires an Admin signature."
        isPending={uncancelPending}
        onSign={handleUncancel}
      />

      {/* Session 33 (Tier 2 #9) — Change Risk Tier dialog. The server rejects
          riskTier PATCHes without a riskTierRationale; this dialog enforces
          the same client-side and writes the audit_log entry server-side. */}
      <Dialog open={tierOpen} onOpenChange={(v) => { setTierOpen(v); if (!v) { setTierDraft({ riskTier: "", rationale: "" }); setTierError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Risk Tier</DialogTitle>
            <DialogDescription>
              Document the reason for moving this supplier's Risk Tier. Each change is captured to the
              audit trail along with the rationale you provide here.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="tier-current">Current tier</Label>
              <Input id="tier-current" value={supplier?.riskTier ?? "Not set"} disabled />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tier-new">New tier *</Label>
              <Select value={tierDraft.riskTier} onValueChange={(v) => setTierDraft((d) => ({ ...d, riskTier: v }))}>
                <SelectTrigger id="tier-new"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Low">Low — established, FDA-listed / known good</SelectItem>
                  <SelectItem value="Medium">Medium — standard food/packaging vendor</SelectItem>
                  <SelectItem value="High">High — new or limited history</SelectItem>
                  <SelectItem value="Critical">Critical — direct contact with cannabis input</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tier-rationale">Rationale *</Label>
              <Textarea
                id="tier-rationale"
                rows={3}
                placeholder="e.g. 'First qualification cycle complete with no findings; moving Critical → High.'"
                value={tierDraft.rationale}
                onChange={(e) => setTierDraft((d) => ({ ...d, rationale: e.target.value }))}
              />
            </div>
            {tierError && <p className="text-sm text-destructive">{tierError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTierOpen(false)} disabled={tierSaving}>Cancel</Button>
            <Button onClick={handleChangeTier} disabled={tierSaving || !tierDraft.riskTier || !tierDraft.rationale.trim()}>
              {tierSaving ? "Saving…" : "Change tier"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Session 32 — Attach file dialog. Metadata-only for now (server
          stub stores fileType/fileName/filePath/notes); blob upload is a
          follow-up but the operator path is no longer blocked. */}
      <Dialog open={attachOpen} onOpenChange={(v) => { setAttachOpen(v); if (!v) { setAttachDraft({ fileType: "", fileName: "", filePath: "", notes: "" }); setAttachError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Paperclip className="h-5 w-5" /> Attach file to supplier</DialogTitle>
            <DialogDescription>
              Attach supporting documentation — qualification certificates, licenses, CoAs, audit reports,
              quality agreements. Available at any supplier status, including <em>Pending Review</em>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="attach-fileType">File type *</Label>
              <Input
                id="attach-fileType"
                placeholder="e.g. License, CoA, Quality Agreement, Audit Report"
                value={attachDraft.fileType}
                onChange={(e) => setAttachDraft((d) => ({ ...d, fileType: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="attach-fileName">File name *</Label>
              <Input
                id="attach-fileName"
                placeholder="e.g. AC-12345_license_2026.pdf"
                value={attachDraft.fileName}
                onChange={(e) => setAttachDraft((d) => ({ ...d, fileName: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="attach-filePath">File path or URL *</Label>
              <Input
                id="attach-filePath"
                placeholder="Drive / SharePoint URL, or local path for now"
                value={attachDraft.filePath}
                onChange={(e) => setAttachDraft((d) => ({ ...d, filePath: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="attach-notes">Notes (optional)</Label>
              <Textarea
                id="attach-notes"
                rows={2}
                placeholder="Anything an auditor would want to know about this file."
                value={attachDraft.notes}
                onChange={(e) => setAttachDraft((d) => ({ ...d, notes: e.target.value }))}
              />
            </div>
            {attachError && <p className="text-sm text-destructive">{attachError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAttachOpen(false)} disabled={attachSaving}>Cancel</Button>
            <Button onClick={handleAttach} disabled={attachSaving}>
              {attachSaving ? "Saving…" : "Attach file"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
