import { cn } from "@/lib/utils";
import { toneDot, toneText, type StatusTone } from "@/lib/status";

// Session 97 (#6) — neutral-surface status pill: a white/card background with a
// colored tone dot + toned label. Replaces the per-module filled-pill palettes so
// badges read as one consistent traffic-light language and don't fight the
// left-edge accent lines on the rows/cards they sit in.
export function StatusBadge({
  tone,
  label,
  className,
}: {
  tone: StatusTone;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-card px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        toneText[tone],
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", toneDot[tone])} />
      {label}
    </span>
  );
}
