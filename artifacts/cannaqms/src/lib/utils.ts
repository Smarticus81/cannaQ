import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { format } from "date-fns"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Format a DATE-ONLY value (e.g. "2026-07-02") without a timezone shift.
// `new Date("2026-07-02")` parses as UTC midnight, which renders as the PREVIOUS
// day in any negative-offset (US) timezone. For date-only strings we parse as
// LOCAL midnight so the calendar day is preserved. Full timestamps pass through
// unchanged (they are real moments in time and should localize normally).
export function formatDateOnly(
  value: string | null | undefined,
  pattern = "MMM d, yyyy",
): string {
  if (!value) return "—"
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const d = isDateOnly ? new Date(`${value}T00:00:00`) : new Date(value)
  return format(d, pattern)
}
