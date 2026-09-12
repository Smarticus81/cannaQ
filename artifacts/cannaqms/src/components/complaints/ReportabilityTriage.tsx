// Session 101 — Reportability triage for complaints.
//
// Operators shouldn't have to know the reporting rules. These yes/no questions
// map the complaint onto the actual obligations. For a Michigan MARIHUANA
// product the primary authority is the CRA: an adverse reaction must be
// reported to the CRA AND entered into METRC within 1 BUSINESS DAY (R 420.214b).
// FDA is a secondary flag for serious adverse events (FDA serious-AE criteria:
// death, life-threatening, hospitalization, lasting disability). MDARD is not
// the cannabis adverse-event authority (its cannabis role is pesticides), so it
// is no longer offered here.
import { ShieldAlert, CheckCircle2 } from "lucide-react";

export type TriageAnswers = Record<string, boolean | undefined>;

export const REPORTABILITY_QUESTIONS: { key: string; label: string }[] = [
  { key: "adverseReaction", label: "Adverse reaction, illness, injury, or negative health effect reported?" },
  { key: "medicalAttention", label: "Did anyone require medical attention (ER, hospitalization, poison control, doctor)?" },
  { key: "seriousOutcome", label: "Death, life-threatening event, or lasting disability / permanent damage?" },
  { key: "contamination", label: "Contamination suspected — microbial, mold, pesticide, heavy metal, residual solvent, or foreign material?" },
  { key: "mislabel", label: "Mislabeled or incorrect THC / CBD, allergens, or ingredients?" },
  { key: "multiLocation", label: "Product distributed beyond a single location (e.g. multiple dispensaries)?" },
];

export type Reportability = { cra: boolean; fda: boolean; reasons: string[]; answeredCount: number };

export function deriveReportability(a: TriageAnswers): Reportability {
  const reasons: string[] = [];
  const cra = !!(a.adverseReaction || a.medicalAttention || a.seriousOutcome || a.contamination);
  const fda = !!(a.seriousOutcome || a.medicalAttention);
  if (cra) reasons.push("Adverse reaction / safety issue on a marihuana product — notify the CRA within 1 business day and log it in METRC (R 420.214b).");
  if (fda) reasons.push("Serious adverse event (hospitalization, life-threatening, death, or lasting harm) — consider the FDA Safety Reporting Portal.");
  if (a.multiLocation) reasons.push("Distributed beyond a single location — widen the recall / notification scope accordingly.");
  const answeredCount = REPORTABILITY_QUESTIONS.filter((q) => a[q.key] !== undefined).length;
  return { cra, fda, reasons, answeredCount };
}

const OPTS: [string, boolean][] = [["Yes", true], ["No", false]];

export function ReportabilityTriage({ value, onChange }: { value: TriageAnswers; onChange: (v: TriageAnswers) => void }) {
  const set = (k: string, v: boolean) => onChange({ ...value, [k]: v });
  const rep = deriveReportability(value);
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {REPORTABILITY_QUESTIONS.map((q) => (
          <div key={q.key} className="flex items-start justify-between gap-3">
            <p className="text-[11px] leading-snug text-foreground">{q.label}</p>
            <div className="flex shrink-0 gap-1">
              {OPTS.map(([lbl, val]) => {
                const active = value[q.key] === val;
                return (
                  <button
                    key={lbl}
                    type="button"
                    onClick={() => set(q.key, val)}
                    className={`rounded border px-2 py-0.5 text-[11px] ${
                      active
                        ? val
                          ? "border-red-400 bg-red-50 text-red-700 font-semibold"
                          : "border-slate-300 bg-slate-100 text-slate-700 font-semibold"
                        : "border-muted text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    {lbl}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {rep.answeredCount === 0 ? (
        <p className="text-[10px] text-muted-foreground">Answer the questions to get a reporting recommendation.</p>
      ) : rep.cra || rep.fda ? (
        <div className="rounded-md border border-orange-300 bg-orange-50 px-3 py-2 space-y-1">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-orange-900">
            <ShieldAlert className="h-3.5 w-3.5" /> Reporting recommended
          </p>
          <ul className="space-y-1">
            {rep.reasons.map((r, i) => (
              <li key={i} className="text-[11px] leading-snug text-orange-900">• {r}</li>
            ))}
          </ul>
          <p className="text-[10px] text-orange-800/80">
            Flags set: {[rep.cra ? "CRA-reportable" : null, rep.fda ? "FDA-reportable" : null].filter(Boolean).join(" · ")}. Quality confirms at review.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-green-300 bg-green-50 px-3 py-2">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-green-900">
            <CheckCircle2 className="h-3.5 w-3.5" /> No mandatory external report indicated from these answers — document and handle internally.
          </p>
        </div>
      )}
    </div>
  );
}
