// Session 96 — Shared Non-Conformance severity guidance.
//
// Single source of truth for what Critical / Major / Minor mean, so operators
// classify NCs consistently. Rendered under the Severity picker in BOTH the
// full "New Non-Conformance" dialog and the in-batch "Log NC" dialog.
//
// Framing follows Michigan CRA (R 420.x) intent + FDA GMP / ISO 13485 §8.3
// (control of nonconforming product). These are decision aids, not verbatim
// regulatory definitions — the Severity Rationale field still captures the
// operator's specific justification for the chosen level.

export const NC_SEVERITY_GUIDE = [
  {
    level: "Critical",
    dot: "bg-red-500",
    text: "text-red-600",
    blurb:
      "Health or safety risk, or a reportable event. E.g. microbial, pesticide, heavy-metal or foreign-material contamination; wrong or missing THC/CBD or allergen labeling; product already released or distributed to consumers.",
  },
  {
    level: "Major",
    dot: "bg-amber-500",
    text: "text-amber-600",
    blurb:
      "Real quality or compliance failure with no immediate safety risk. E.g. out-of-spec potency caught before release; packaging or label defect found in-house; an SOP/GMP deviation affecting a batch. Requires management acknowledgement before closure.",
  },
  {
    level: "Minor",
    dot: "bg-slate-400",
    text: "text-slate-600",
    blurb:
      "Isolated, low-impact issue with no effect on product safety, potency, or compliance. E.g. a cosmetic blemish, a paperwork typo, or a small housekeeping deviation corrected on the spot.",
  },
] as const;

export function NcSeverityGuide({ className = "" }: { className?: string }) {
  return (
    <div className={`rounded-md border bg-muted/40 px-3 py-2 space-y-1.5 ${className}`}>
      <p className="text-[11px] font-medium text-foreground">How to pick a severity</p>
      <ul className="space-y-1">
        {NC_SEVERITY_GUIDE.map((s) => (
          <li
            key={s.level}
            className="flex gap-2 text-[11px] leading-snug text-muted-foreground"
          >
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
            <span>
              <span className={`font-semibold ${s.text}`}>{s.level}</span>
              {" — "}
              {s.blurb}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
