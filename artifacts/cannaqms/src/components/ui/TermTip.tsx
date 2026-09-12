import { HelpCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Inline contextual term helper. Wrap a noun the user might not know to give
// them a hover-after-three-seconds definition (delay is inherited from the
// app-level TooltipProvider in AppLayout, HOVER_DELAY_MS = 3000).
//
// Two usage patterns:
//
//   // 1. Wrap arbitrary children with an inline help marker
//   <TermTip definition="A lot is a discrete production unit, often tagged in METRC.">
//     Lot
//   </TermTip>
//
//   // 2. Use a pre-canned term (centralised vocabulary)
//   <TermTip term="lot" />
//
// Built-in terms live in TERM_DEFINITIONS below. Add new ones there rather
// than re-typing definitions across pages — keeps the vocabulary consistent.

export const TERM_DEFINITIONS: Record<string, { label: string; definition: string }> = {
  lot: {
    label: "Lot",
    definition: "A discrete production unit — for cannabis ops, typically tied to a METRC package tag. Lots are what you sell, transfer, and reconcile in inventory. A single batch may be split into multiple lots.",
  },
  batch: {
    label: "Batch",
    definition: "A production run that yields one or more lots. Batches track ingredients, in-process checks, and lab testing. Once tested and released, a batch is broken down into lots for distribution.",
  },
  capa: {
    label: "CAPA",
    definition: "Corrective and Preventive Action. A formal record of root-cause investigation and the actions taken to prevent recurrence. Gated by two approvals (Gate 1 pre-implementation, Gate 2 closure).",
  },
  nc: {
    label: "Non-Conformance",
    definition: "A documented deviation from a specification, procedure, or requirement. NCs may lead to dispositions (Use As Is, Rework, Destroy, etc.) and often spawn a CAPA for root cause work.",
  },
  fieldAction: {
    label: "Field Action",
    definition: "A response to product already in distribution — recalls, withdrawals, stop sales, safety alerts. Tracks CRA notifications, per-store responses, and product reconciliation.",
  },
  metrc: {
    label: "METRC",
    definition: "Marijuana Enforcement Tracking Reporting & Compliance — the seed-to-sale tracking system Michigan requires. Every package, lot, and transfer is tagged in METRC.",
  },
  gate1: {
    label: "Gate 1",
    definition: "CAPA pre-implementation approval. Two distinct approvers (neither the originator) sign off on the problem statement, root cause analysis, action plan, and effectiveness-check plan before any action can be executed.",
  },
  gate2: {
    label: "Gate 2",
    definition: "CAPA closure approval. A single approver (not the originator, not the EC owner, not any action owner) reviews effectiveness-check results and signs Pass or Fail with rollback target.",
  },
  part11: {
    label: "21 CFR Part 11",
    definition: "FDA rule for electronic records and signatures. Compliance Compass enforces it by capturing initials, signing meaning, and a timestamp on every gated decision, with full audit-log retention.",
  },
  released: {
    label: "Released",
    definition: "Released to Inventory — the batch passed lab testing and Quality signed the release e-signature, so it's approved and moved into inventory. It is NOT yet reconciled against METRC. The next and final step is 'Group / Ship Units.'",
  },
  finishedGoods: {
    label: "Production Batch Closed — In Fulfillment",
    definition: "The final stage. The production batch is closed and its units are packaged, confirmed in METRC (tags assigned/verified) and labeled — sitting in the warehouse ready for orders to be picked against. No more units can be packaged from the batch. In short: Bulk — Released = QA-approved bulk with nothing packaged; In Fulfillment = packaged, labeled and sellable.",
  },
};

type TermKey = keyof typeof TERM_DEFINITIONS;

interface TermTipProps {
  /** Pre-canned term key — use a registered key from TERM_DEFINITIONS. */
  term?: TermKey;
  /** Custom definition; required if `term` is not supplied. */
  definition?: string;
  /** Custom label. Defaults to the registered label or to `children`. */
  children?: React.ReactNode;
  /** Show a small (?) glyph after the label. Defaults to true when there is no `children`. */
  showGlyph?: boolean;
  className?: string;
}

export function TermTip({ term, definition, children, showGlyph, className }: TermTipProps) {
  const preset = term ? TERM_DEFINITIONS[term] : undefined;
  const text = definition ?? preset?.definition ?? "";
  const visual = children ?? preset?.label ?? term ?? "";
  const showHelp = showGlyph ?? !children;

  if (!text) return <>{visual}</>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex items-baseline gap-0.5 cursor-help underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 ${className ?? ""}`}
        >
          {visual}
          {showHelp && <HelpCircle className="h-3 w-3 text-muted-foreground/70 self-center" aria-hidden />}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs leading-snug">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
