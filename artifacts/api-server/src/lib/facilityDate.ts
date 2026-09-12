// Calendar dates in the facility's own time zone.
//
// Every date-only column in this system — an approval date, an effective date, a
// training due date, the packagedDate reported to METRC — is a CALENDAR DATE, the
// day a person did something where they were standing. It was being produced with
// `new Date().toISOString().slice(0, 10)`, and toISOString is always UTC, so from
// 8pm Eastern onwards (7pm outside daylight saving) every one of those dates
// landed on tomorrow. An approver signing at 9pm on the 26th got a document dated
// the 27th, and a batch packaged at 9pm told the State of Michigan the 27th.
//
// METRC does not save us here: its DATETIME fields carry an offset and are
// converted to UTC on their side, but its DATE fields are bare YYYY-MM-DD with no
// zone at all, so whatever day we send is the day they record.
//
// Timestamps (`timestamptz` columns like approvedAt, signedAt, performedAt) are
// instants and were always correct. Nothing here applies to them.
//
// 2026-08-27 — the zone now comes from the company profile (it was hardcoded to
// Eastern). It is held in memory rather than read per call because every caller of
// facilityDateStr() is synchronous and there are dozens of them; the server loads
// it at boot and the profile route updates it when someone saves a new one.
//
// Eastern remains the fallback, deliberately: it is what every record written
// before this setting existed was dated against, so an unset profile keeps
// producing the dates it always did rather than silently shifting to UTC.
export const DEFAULT_FACILITY_TIME_ZONE = "America/New_York";

let facilityTimeZone = DEFAULT_FACILITY_TIME_ZONE;

// en-CA formats as YYYY-MM-DD, which is the shape every date column expects.
// Rebuilt whenever the zone changes — Intl formatters bind their zone at creation.
let dateFormatter = buildFormatter(facilityTimeZone);

function buildFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** The zone the facility's calendar dates are computed in. */
export function getFacilityTimeZone(): string {
  return facilityTimeZone;
}

/**
 * Point the facility calendar at a new zone. Called at boot and whenever the
 * company profile is saved. An unusable zone name is REFUSED rather than allowed
 * to throw on every date the system writes afterwards — a bad setting must not be
 * able to take date stamping down.
 */
export function setFacilityTimeZone(timeZone: string | null | undefined): string {
  const next = (timeZone ?? "").trim() || DEFAULT_FACILITY_TIME_ZONE;
  try {
    const candidate = buildFormatter(next);
    candidate.format(new Date());
    facilityTimeZone = next;
    dateFormatter = candidate;
  } catch {
    facilityTimeZone = DEFAULT_FACILITY_TIME_ZONE;
    dateFormatter = buildFormatter(DEFAULT_FACILITY_TIME_ZONE);
  }
  return facilityTimeZone;
}

/** The calendar date at the facility for a given instant (default: now). */
export function facilityDateStr(d: Date = new Date()): string {
  return dateFormatter.format(d);
}

/**
 * Add calendar days to a YYYY-MM-DD string. Pure calendar arithmetic through
 * Date.UTC, so a day that gains or loses an hour to daylight saving still counts
 * as exactly one day.
 */
export function addCalendarDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** Day of week for a YYYY-MM-DD string: 0 = Sunday, 6 = Saturday. */
export function calendarDayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// ---------------------------------------------------------------------------
// US FEDERAL HOLIDAYS
//
// 2026-08-27, Jonathan: "just go with federal US holidays for now". Added after a
// 10-business-day training window counted Labor Day as a working day, which made
// the real window nine days — the first time the missing calendar actually bit.
//
// Computed from the rules rather than listed year by year, so this does not expire.
// The eleven federal holidays as of 2021, when Juneteenth was added.
//
// 🔜 Company-specific holidays (a shutdown week, a floating day) belong on the
// company profile alongside the time zone. When that arrives, the configured list
// is added to what this returns; every caller keeps working.

/** The date of the `nth` given weekday in a month, e.g. the 3rd Monday of January. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + shift + (nth - 1) * 7;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The date of the LAST given weekday in a month, e.g. the last Monday of May. */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  const day = last.getUTCDate() - back;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * A fixed-date holiday as it is OBSERVED: a Saturday holiday is taken on the
 * Friday before, a Sunday holiday on the Monday after. The observed day is the one
 * the office is shut, which is the day that matters for counting working days.
 */
function observedFixedDate(year: number, month: number, day: number): string {
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const dow = calendarDayOfWeek(iso);
  if (dow === 6) return addCalendarDays(iso, -1);
  if (dow === 0) return addCalendarDays(iso, 1);
  return iso;
}

/** Every US federal holiday in a given year, as observed, as YYYY-MM-DD. */
export function federalHolidays(year: number): string[] {
  return [
    observedFixedDate(year, 1, 1),            // New Year's Day
    nthWeekdayOfMonth(year, 1, 1, 3),         // Martin Luther King Jr. Day — 3rd Monday, Jan
    nthWeekdayOfMonth(year, 2, 1, 3),         // Washington's Birthday — 3rd Monday, Feb
    lastWeekdayOfMonth(year, 5, 1),           // Memorial Day — last Monday, May
    observedFixedDate(year, 6, 19),           // Juneteenth
    observedFixedDate(year, 7, 4),            // Independence Day
    nthWeekdayOfMonth(year, 9, 1, 1),         // Labor Day — 1st Monday, Sep
    nthWeekdayOfMonth(year, 10, 1, 2),        // Columbus Day — 2nd Monday, Oct
    observedFixedDate(year, 11, 11),          // Veterans Day
    nthWeekdayOfMonth(year, 11, 4, 4),        // Thanksgiving — 4th Thursday, Nov
    observedFixedDate(year, 12, 25),          // Christmas Day
  ];
}

const holidayCache = new Map<number, Set<string>>();

/** Is this YYYY-MM-DD a US federal holiday, as observed? */
export function isHoliday(dateStr: string): boolean {
  const year = Number(dateStr.slice(0, 4));
  let set = holidayCache.get(year);
  if (!set) {
    set = new Set(federalHolidays(year));
    holidayCache.set(year, set);
  }
  return set.has(dateStr);
}

/** Is this YYYY-MM-DD a working day at the facility? Mon–Fri and not a holiday. */
export function isWorkingDay(dateStr: string): boolean {
  const dow = calendarDayOfWeek(dateStr);
  return dow !== 0 && dow !== 6 && !isHoliday(dateStr);
}

/**
 * A due date `days` WORKING days from the facility's today. Weekends and US
 * federal holidays are skipped, so ten working days is ten days someone could
 * actually have done the training.
 */
export function addBusinessDays(days: number, from: Date = new Date()): string {
  let cursor = facilityDateStr(from);
  let remaining = days;
  while (remaining > 0) {
    cursor = addCalendarDays(cursor, 1);
    if (isWorkingDay(cursor)) remaining -= 1;
  }
  return cursor;
}
