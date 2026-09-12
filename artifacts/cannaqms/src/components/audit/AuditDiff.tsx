/**
 * The audit diff — one renderer for "what actually changed", shared by the
 * global Audit Log page and by every per-record Audit Trail tab.
 *
 * It exists because those tabs used to print `Object.keys(afterState)`: the
 * field NAMES only. Since the update routes store the WHOLE row as beforeState
 * and afterState, that listed every column on every save, so a one-word edit to
 * a notes field read as "UPDATE - Jonathan - [25 field names]" and the actual
 * change was invisible. The server had recorded it correctly the whole time.
 *
 * Keep ONE copy. This was lifted out of pages/AuditLog.tsx, which had the only
 * working version.
 */

// ── Audit diff ────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

const SKIP_FIELDS = new Set([
  "id", "createdAt", "updatedAt", "changedAt",
]);

function renderVal(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/**
 * The names of the fields whose values actually changed. For places that cannot
 * host the full table — a narrow cell in a log TABLE, where the alternative is
 * every column listed on every save.
 */
export function changedFieldNames(before: unknown, after: unknown, operation: string): string[] {
  const b = (before && typeof before === "object" ? before : {}) as Obj;
  const a = (after && typeof after === "object" ? after : {}) as Obj;
  return Array.from(new Set([...Object.keys(b), ...Object.keys(a)]))
    .filter((k) => !SKIP_FIELDS.has(k))
    .filter((k) => operation !== "UPDATE" || renderVal(b[k]) !== renderVal(a[k]));
}

export function AuditDiff({
  before,
  after,
  operation,
}: {
  before: unknown;
  after: unknown;
  operation: string;
}) {
  const b = (before && typeof before === "object" ? before : {}) as Obj;
  const a = (after && typeof after === "object" ? after : {}) as Obj;

  const allKeys = Array.from(
    new Set([...Object.keys(b), ...Object.keys(a)])
  ).filter((k) => !SKIP_FIELDS.has(k));

  if (allKeys.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic px-4 py-3">
        No field data recorded for this event.
      </p>
    );
  }

  type DiffRow = { key: string; bv: string; av: string };
  const rows: DiffRow[] = [];

  for (const key of allKeys) {
    const bv = renderVal(b[key]);
    const av = renderVal(a[key]);
    if (operation === "UPDATE" && bv === av) continue;
    rows.push({ key, bv, av });
  }

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic px-4 py-3">
        No field values changed.
      </p>
    );
  }

  const showBefore = operation !== "INSERT";
  const showAfter = operation !== "DELETE";

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/30">
            <th className="text-left px-4 py-1.5 font-medium text-muted-foreground w-1/5">
              Field
            </th>
            {showBefore && (
              <th className="text-left px-4 py-1.5 font-medium text-muted-foreground">
                {operation === "DELETE" ? "Value" : "Before"}
              </th>
            )}
            {showAfter && (
              <th className="text-left px-4 py-1.5 font-medium text-muted-foreground">
                {operation === "INSERT" ? "Value" : "After"}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, bv, av }) => (
            <tr key={key} className="border-b last:border-0 hover:bg-muted/20">
              <td className="px-4 py-1.5 font-mono text-muted-foreground align-top">
                {key}
              </td>
              {showBefore && (
                <td className="px-4 py-1.5 align-top">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 font-mono whitespace-pre-wrap break-all max-w-xs ${
                      operation === "UPDATE"
                        ? "bg-red-50 text-red-700 line-through"
                        : "bg-red-50 text-red-700"
                    }`}
                  >
                    {bv}
                  </span>
                </td>
              )}
              {showAfter && (
                <td className="px-4 py-1.5 align-top">
                  <span className="inline-block rounded px-1.5 py-0.5 font-mono whitespace-pre-wrap break-all max-w-xs bg-green-50 text-green-700">
                    {av}
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
