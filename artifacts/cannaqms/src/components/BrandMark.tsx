import { Link } from "wouter";
export function RecordMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <path d="M8 6h19l7 7v21H8V6Z" stroke="currentColor" strokeWidth="2" />
      <path
        d="M26 6v9h8M14 21h13M14 27h8"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="m25 28 3 3 7-8" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}
export function BrandMark({ inverse = false, href = "/" }: { inverse?: boolean; href?: string }) {
  return (
    <Link
      href={href}
      className={`cq-brand ${inverse ? "cq-brand--inverse" : ""}`}
      aria-label="CannaQ home"
    >
      <RecordMark />
      <span>
        canna<strong>Q</strong>
        <small>CANNABIS QUALITY SYSTEMS</small>
      </span>
    </Link>
  );
}
export function QualityFlow() {
  return (
    <div className="cq-quality-flow" aria-label="Cannabis quality workflow">
      <div className="cq-flow-header">
        <span>RECORD CONTINUITY</span>
        <span>01 — 04</span>
      </div>
      {[
        {
          number: "01",
          name: "RECEIVE",
          detail: "Supplier · Inspection · Source lot",
          code: "MATERIAL CONTROL",
        },
        {
          number: "02",
          name: "PRODUCE",
          detail: "Recipe · Ingredients · Batch record",
          code: "PROCESS CONTROL",
        },
        {
          number: "03",
          name: "REVIEW",
          detail: "Testing · Deviations · Approvals",
          code: "QUALITY CONTROL",
        },
        {
          number: "04",
          name: "RELEASE",
          detail: "Disposition · Packaging · Traceability",
          code: "RECORD CONTROL",
        },
      ].map((item) => (
        <div key={item.number} className="cq-flow-row">
          <span>{item.number}</span>
          <div>
            <h2>{item.name}</h2>
            <p>{item.detail}</p>
          </div>
          <small>{item.code}</small>
        </div>
      ))}
      <p className="cq-flow-caption">
        Every stage connected to its supporting records.
      </p>
    </div>
  );
}
