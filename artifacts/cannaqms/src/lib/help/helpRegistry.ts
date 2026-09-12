// Context-aware help content (Session 71, PR 1 — static, zero AI).
//
// One plain-data registry keyed by top-level route. The "?" help popover looks
// up the current route here (prefix match, same approach as AppLayout's
// getPageTitle) and renders the topic. Detail routes like /batches/:id inherit
// their parent topic for now (PR 1 = top-level pages only, per the 06-16
// decision). Deeper per-detail content and setupHints come in later PRs.
//
// Keep every field short — the help surface is an inline popover, not a page.
// whatItIs is seeded from the sidebar NAV_SECTIONS descriptions so the two stay
// consistent. regulatoryBasis is shown only behind the "Why?" toggle.

export type HelpTask = { label: string; how: string };
export type HelpLink = { label: string; route: string };

export type HelpTopic = {
  route: string;
  title: string;
  whatItIs: string;
  commonTasks: HelpTask[];
  relatedProcesses: HelpLink[];
  regulatoryBasis?: string;
  // Reserved for PR 2 (empty-state / first-run hints). Unused in PR 1.
  setupHints?: string[];
};

// Order matters only for the search list; lookup is by exact/prefix match below.
export const HELP_TOPICS: HelpTopic[] = [
  {
    route: "/dashboard",
    title: "Dashboard",
    whatItIs:
      "Your facility at a glance — live operational and compliance metrics, plus anything currently demanding attention.",
    commonTasks: [
      { label: "Spot what needs action", how: "Open alerts surface here and in the bell; click any to jump to the record." },
      { label: "Check facility health", how: "Scan the metric cards for batches in progress, open quality events, and overdue items." },
    ],
    relatedProcesses: [
      { label: "Batches", route: "/batches" },
      { label: "Non-Conformances", route: "/non-conformances" },
    ],
  },
  {
    route: "/suppliers",
    title: "Suppliers",
    whatItIs:
      "Your approved vendors for cannabis material, packaging, supplies, testing labs, and services. The source of every COA and license on file.",
    commonTasks: [
      { label: "Add a supplier", how: "Use “Add Supplier,” then attach their license and certificate of analysis." },
      { label: "Open a supplier", how: "Click a row to see its qualification status, documents, and history." },
    ],
    relatedProcesses: [
      { label: "Supplier Qualification", route: "/supplier-qualification" },
      { label: "Incoming Inspections", route: "/inspections" },
    ],
    regulatoryBasis:
      "FDA cGMP 21 CFR 117 Subpart G (supply-chain program); approved-supplier control is a prerequisite for material release.",
  },
  {
    route: "/inspections",
    title: "Incoming Inspections",
    whatItIs:
      "Receipt-side inspection of materials as they enter your facility. The pass/fail decision determines whether material can be released to inventory.",
    commonTasks: [
      { label: "Record an inspection", how: "Create one against the received material; record weight/condition and a pass or fail." },
      { label: "Release or reject", how: "A pass releases material to Inventory; a fail routes it to a Non-Conformance." },
    ],
    relatedProcesses: [
      { label: "Inventory", route: "/inventory" },
      { label: "Suppliers", route: "/suppliers" },
      { label: "Non-Conformances", route: "/non-conformances" },
    ],
    regulatoryBasis:
      "FDA cGMP 21 CFR 117.80 (process controls) and incoming-material verification; MI CRA intake/traceability expectations.",
  },
  {
    route: "/inventory",
    title: "Inventory",
    whatItIs:
      "On-hand quantities of ingredients and consumables, with reorder points. Finished goods are handed to METRC and are not tracked here.",
    commonTasks: [
      { label: "Add an item", how: "Create an inventory item; set its reorder point so low-stock surfaces automatically." },
      { label: "See what's low", how: "Items at or below their reorder point are flagged for restock." },
    ],
    relatedProcesses: [
      { label: "Lots", route: "/lots" },
      { label: "Batches", route: "/batches" },
    ],
  },
  {
    route: "/lots",
    title: "Lot Traceability",
    whatItIs:
      "Lot-level traceability of ingredients and materials consumed in batches — the backward lookup from finished product to its source.",
    commonTasks: [
      { label: "Trace a lot", how: "Open a lot to see which batches consumed it and where it came from." },
      { label: "Follow a recall", how: "From an affected lot, find every batch and downstream product it touched." },
    ],
    relatedProcesses: [
      { label: "Batches", route: "/batches" },
      { label: "Field Actions", route: "/field-actions" },
    ],
    regulatoryBasis:
      "FDA cGMP 21 CFR 117 traceability; MI CRA seed-to-sale lot tracking. Lot links are the backbone of any recall.",
  },
  {
    route: "/batches",
    title: "Batch Records",
    whatItIs:
      "Production records covering the full batch lifecycle — ingredients in, process steps, testing, packaging, labeling, and release.",
    commonTasks: [
      { label: "Create a batch", how: "“Create Batch,” pick a recipe and product type; the recipe seeds ingredients and steps." },
      { label: "Record test results", how: "On the Testing tab, add results; use the per-row Edit button to correct one." },
      { label: "Label & release", how: "Complete the labeling checklist; approval is blocked until the checklist is satisfied." },
    ],
    relatedProcesses: [
      { label: "Recipes", route: "/recipes" },
      { label: "Lots", route: "/lots" },
      { label: "Label Studio", route: "/labels" },
    ],
    regulatoryBasis:
      "FDA cGMP 21 CFR 117 (production & process controls), 21 CFR Part 11 e-signatures on each gated step; MI CRA R 420.504 label requirements (R 420.502 general labeling; R 420.403(7) for infused products).",
  },
  {
    route: "/recipes",
    title: "Recipes",
    whatItIs:
      "Master formulations that seed new batches — they lock in ingredients, ratios, and process steps for repeatable production.",
    commonTasks: [
      { label: "Add a recipe", how: "Create one with its ingredients and steps; new batches copy it as a starting point." },
      { label: "Edit a recipe", how: "Open a recipe to adjust its formulation; existing batches keep the version they were built from." },
    ],
    relatedProcesses: [
      { label: "Batches", route: "/batches" },
      { label: "Documents", route: "/documents" },
    ],
  },
  {
    route: "/non-conformances",
    title: "Non-Conformances",
    whatItIs:
      "Any deviation from spec — a failed test, out-of-tolerance result, supplier issue, or inspection finding. The triage point for corrections and CAPAs.",
    commonTasks: [
      { label: "Log an NC", how: "Capture what deviated, record the correction taken, and disposition the affected product." },
      { label: "Escalate to CAPA", how: "When a root-cause fix is needed beyond containment, link a CAPA from the NC." },
    ],
    relatedProcesses: [
      { label: "CAPA", route: "/capas" },
      { label: "Destruction Records", route: "/destruction-records" },
    ],
    regulatoryBasis:
      "FDA cGMP 21 CFR 117.150 (corrective actions); 21 CFR Part 11 approvals. “Non-Conformance” covers all deviations, complaints, and findings.",
  },
  {
    route: "/complaints",
    title: "Complaints",
    whatItIs:
      "Customer complaints captured, triaged, and dispositioned. A complaint can escalate into a Field Action when product is already in the market.",
    commonTasks: [
      { label: "Log a complaint", how: "Record the complaint and triage it; link an NC if a quality deviation is involved." },
      { label: "Escalate", how: "If shipped product is affected, open a Field Action to manage notification and closure." },
    ],
    relatedProcesses: [
      { label: "Field Actions", route: "/field-actions" },
      { label: "Non-Conformances", route: "/non-conformances" },
    ],
    regulatoryBasis:
      "FDA cGMP 21 CFR 117 complaint handling; complaints feed the quality-event family (NC → CAPA → Field Action).",
  },
  {
    route: "/field-actions",
    title: "Field Actions",
    whatItIs:
      "Recalls, stop-sales, market withdrawals, and safety alerts for product already shipped. Generates customer notification letters and tracks closure.",
    commonTasks: [
      { label: "Open a field action", how: "Identify affected lots, set the action type, and generate notification letters." },
      { label: "Track to closure", how: "Record response actions and effectiveness; the record closes only when complete." },
    ],
    relatedProcesses: [
      { label: "Lots", route: "/lots" },
      { label: "Complaints", route: "/complaints" },
    ],
    regulatoryBasis:
      "FDA recall guidance / 21 CFR Part 7; MI CRA recall reporting. Affected-lot links drive the scope of the action.",
  },
  {
    route: "/capas",
    title: "CAPA",
    whatItIs:
      "Corrective and Preventive Actions — root-cause-driven fixes that go beyond immediate containment. Approval-gated under Part 11.",
    commonTasks: [
      { label: "Open a CAPA", how: "Define the root cause, action items with owners, and the effectiveness checks." },
      { label: "Verify effectiveness", how: "After implementation, record the effectiveness check before closing." },
    ],
    relatedProcesses: [
      { label: "Non-Conformances", route: "/non-conformances" },
      { label: "Training", route: "/training" },
    ],
    regulatoryBasis:
      "FDA cGMP 21 CFR 117.150 (corrective actions); 21 CFR Part 11 signed approvals on owner and effectiveness criteria.",
  },
  {
    route: "/destruction-records",
    title: "Destruction Records",
    whatItIs:
      "METRC destruction events for destroyed product. One tag can cover many batches; records link back to the NCs that dispositioned product as Destroy.",
    commonTasks: [
      { label: "Record a destruction", how: "Create the record, link the destroyed material, and reference the METRC tag." },
      { label: "Tie it to an NC", how: "Link the NC that dispositioned the product so the audit trail is complete." },
    ],
    relatedProcesses: [
      { label: "Non-Conformances", route: "/non-conformances" },
      { label: "Lots", route: "/lots" },
    ],
    regulatoryBasis:
      "MI CRA / METRC destruction reporting; the NC link preserves the disposition rationale for audit.",
  },
  {
    route: "/training",
    title: "Training Records",
    whatItIs:
      "Personnel training records — who is qualified to do what, when, and against which SOP version. Competency gates who can run a batch solo.",
    commonTasks: [
      { label: "Record training", how: "Log a training event against a person and the SOP/recipe it qualifies them for." },
      { label: "Check qualification", how: "Operators qualify per recipe after supervised batches; solo work is blocked until then." },
    ],
    relatedProcesses: [
      { label: "Documents", route: "/documents" },
      { label: "Batches", route: "/batches" },
    ],
    regulatoryBasis:
      "FDA cGMP 21 CFR 117.4 (qualified individuals); ISO 13485 competency (used as guidance). Training ties to SOP versions.",
  },
  {
    route: "/documents",
    title: "Document Control",
    whatItIs:
      "Controlled SOPs, work instructions, forms, and specifications — authored in CannaQ with effective dates, versioning, and signed approvals.",
    commonTasks: [
      { label: "Create a document", how: "Author it in place with sections and e-signature; don't upload a finished PDF." },
      { label: "Revise & approve", how: "Edit a controlled doc; approval is signature-gated and versioned." },
    ],
    relatedProcesses: [
      { label: "Training", route: "/training" },
      { label: "Recipes", route: "/recipes" },
    ],
    regulatoryBasis:
      "21 CFR Part 11 (controlled records, e-signatures); FDA cGMP documentation; ISO 13485 document control as guidance.",
  },
  {
    route: "/regulatory-intel",
    title: "Regulatory Intelligence",
    whatItIs:
      "The AI Regulatory Intelligence Agent. It ingests CRA/MDARD/FDA bulletins, summarizes them, and flags which of your SOPs and label templates may be impacted. You review and act.",
    commonTasks: [
      { label: "Review a bulletin", how: "Open an ingested bulletin to see its summary, severity, and impacted documents." },
      { label: "Disposition impact", how: "The agent proposes; you decide which documents or labels to revise." },
    ],
    relatedProcesses: [
      { label: "Documents", route: "/documents" },
      { label: "Label Studio", route: "/labels" },
    ],
    regulatoryBasis:
      "ISO 42001 governs the AI agent (proposes only; a human always disposes). Sources: MI CRA bulletins, MDARD, FDA.",
  },
  {
    route: "/labels",
    title: "Label Studio",
    whatItIs:
      "Label template design and approval — the source of every printed batch label, with regulation references baked in.",
    commonTasks: [
      { label: "Design a template", how: "Build a label template per product type; required fields and warnings are enforced." },
      { label: "Approve a template", how: "Approval gates which templates can be printed onto a released batch." },
    ],
    relatedProcesses: [
      { label: "Batches", route: "/batches" },
      { label: "Packaging", route: "/packaging" },
    ],
    regulatoryBasis:
      "MI CRA R 420.504 labeling requirements (R 420.502 general; R 420.403(7) infused); required warnings, potency, and universal symbol.",
  },
  {
    route: "/supplier-qualification",
    title: "Supplier Qualification",
    whatItIs:
      "Initial and renewal qualification records for each supplier — certifications, audits, and scoring that keep a vendor approved.",
    commonTasks: [
      { label: "Qualify a supplier", how: "Record certifications, audit results, and a score; this drives approved status." },
      { label: "Renew qualification", how: "Re-qualify on schedule; the audit trail tracks every requalification." },
    ],
    relatedProcesses: [
      { label: "Suppliers", route: "/suppliers" },
      { label: "Incoming Inspections", route: "/inspections" },
    ],
    regulatoryBasis:
      "FDA cGMP 21 CFR 117 Subpart G supply-chain program; supplier approval underpins material release.",
  },
  {
    route: "/packaging",
    title: "Packaging Designs",
    whatItIs:
      "Per-design packaging approval records with compliance checklists and artwork attachments.",
    commonTasks: [
      { label: "Add a design", how: "Create a packaging design, attach artwork, and complete its compliance checklist." },
      { label: "Approve a design", how: "Approval confirms the design meets packaging rules before use." },
    ],
    relatedProcesses: [
      { label: "Label Studio", route: "/labels" },
      { label: "Batches", route: "/batches" },
    ],
    regulatoryBasis:
      "MI CRA packaging rules (child-resistance, opacity, marketing limits); checklist evidences each requirement.",
  },
  {
    route: "/audit-log",
    title: "Audit Log",
    whatItIs:
      "The immutable record of every change to a regulated table — who, what, when, before, and after. Your Part 11 evidence.",
    commonTasks: [
      { label: "Trace a change", how: "Search the log for a record to see every edit, with the acting user and timestamp." },
      { label: "Pull a report", how: "Use the report view to export an audit trail for an inspector." },
    ],
    relatedProcesses: [
      { label: "Settings", route: "/settings" },
      { label: "Documents", route: "/documents" },
    ],
    regulatoryBasis:
      "21 CFR Part 11.10(e) — secure, computer-generated, time-stamped audit trails. Records are never hard-deleted.",
  },
  {
    route: "/settings",
    title: "Settings",
    whatItIs:
      "Company profile, user management, and state-specific regulatory configuration.",
    commonTasks: [
      { label: "Add a user", how: "Create a user with their role; roles gate who can approve and sign under Part 11." },
      { label: "Set company profile", how: "Fill in facility details and state configuration so records reference the right rules." },
    ],
    relatedProcesses: [
      { label: "Audit Log", route: "/audit-log" },
      { label: "Training", route: "/training" },
    ],
    regulatoryBasis:
      "21 CFR Part 11 role-based access; correct user identities are required for valid e-signature attribution.",
  },
];

// Prefix match, mirroring AppLayout.getPageTitle so /batches/123 resolves to the
// /batches topic. Longest-route-first guards nested paths (e.g. /audit-log/report
// would match /audit-log; fine for PR 1 since detail routes inherit the parent).
const TOPICS_BY_LENGTH = [...HELP_TOPICS].sort((a, b) => b.route.length - a.route.length);

export function helpTopicForRoute(location: string): HelpTopic | undefined {
  return TOPICS_BY_LENGTH.find(
    (t) => location === t.route || location.startsWith(`${t.route}/`),
  );
}
