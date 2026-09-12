// Session 101 — Shared complaint severity guidance.
//
// Single source of truth for what Critical / High / Medium / Low mean on a
// customer/patient complaint, with Michigan CRA (R 420.203) response-time
// context. Rendered under the Severity picker on the New Complaint form so
// operators classify consistently and see the notification clock each level
// implies. Decision aid only — the "Why this severity?" field still captures
// the specific justification.

export const COMPLAINT_SEVERITY_GUIDE = [
  {
    level: "Critical",
    dot: "bg-red-500",
    text: "text-red-600",
    blurb:
      "Serious adverse event or imminent health/safety risk — hospitalization, ER visit, serious injury, or confirmed contamination in released product. CRA notification may be required within 3 business days (R 420.203).",
  },
  {
    level: "High",
    dot: "bg-orange-500",
    text: "text-orange-600",
    blurb:
      "Confirmed quality or compliance failure with potential for harm; product is in the market but no serious injury reported. Target investigation/close within 30 days. E.g. mislabeled potency or allergen, mold or off-condition on a released lot.",
  },
  {
    level: "Medium",
    dot: "bg-amber-500",
    text: "text-amber-600",
    blurb:
      "Quality issue with limited exposure and no health risk. Target within 90 days. E.g. packaging defect, cartridge/hardware malfunction, off taste or aroma.",
  },
  {
    level: "Low",
    dot: "bg-slate-400",
    text: "text-slate-600",
    blurb:
      "Minor, isolated, non-safety issue or general dissatisfaction. Target within 90 days. E.g. cosmetic blemish, minor labeling typo, customer preference.",
  },
] as const;

export function ComplaintSeverityGuide({ className = "" }: { className?: string }) {
  return (
    <div className={`rounded-md border bg-muted/40 px-3 py-2 space-y-1.5 ${className}`}>
      <p className="text-[11px] font-medium text-foreground">
        How to pick a severity (drives the R 420.203 response clock)
      </p>
      <ul className="space-y-1">
        {COMPLAINT_SEVERITY_GUIDE.map((s) => (
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
