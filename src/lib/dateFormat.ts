// ══════════════════════════════════════════════════════════════════
// DATE FORMATTING — one locale, five formats, one implementation each
// (Audit F-7)
// ══════════════════════════════════════════════════════════════════
//
// ── THE PRODUCT SPEAKS en-GB ──────────────────────────────────────
//
// Decided deliberately, because it could not be decided by refactoring. The
// codebase had BOTH: en-GB on the Institute and Faculty assignment pages and
// SEB settings, en-US everywhere else. Folding them was never a tidy-up — it
// changes what a date looks like to a user — so the locale was raised as a
// question and answered, and this module is now the single answer.
//
//     15 Aug 2026          short
//     15 August 2026       long
//     15 Aug 2026, 09:30   date + time
//     15 Aug               day + month, for compact list columns
//     15 Aug, 09:30        day + month + time
//
// ONE CONSEQUENCE WORTH KNOWING: en-GB is a 24-HOUR locale, so exam times
// render `09:30` and `14:00` rather than `9:30 AM` and `2:00 PM`. On a
// platform whose whole job is telling candidates when a paper opens and
// closes, losing the AM/PM ambiguity is an improvement rather than a cost —
// but it IS visible on the briefing page, the results page and the assessment
// list, so it is stated here rather than discovered.
//
// PURE. Takes a string and a locale decision, returns a string.
//
// ── WHAT WAS THERE ────────────────────────────────────────────────
//
// `function formatDate(iso: string)` appeared ELEVEN times across src/, in
// SIX syntactically distinct forms — differing by a trailing comma, an
// explicit `: string` return annotation, or nothing at all. Behind that noise
// there are only three real formats:
//
//   short      7 copies, 4 syntactic variants
//   long       3 copies, 2 variants
//   date+time  1 copy   (ExamResultsPage)
//
// Six implementations of three formats is how a platform ends up showing the
// same field two ways on consecutive screens — the failure instituteValidity's
// header describes for a different field, in the same words. A later sweep
// found ten more under different names, which is where the locale split above
// came from.
//
// ── THE GUARD, AND WHY IT BELONGS HERE ────────────────────────────
//
// None of the eleven guarded its input. `new Date(x).toLocaleDateString(…)`
// renders the literal string "Invalid Date" for absent, empty or unparseable
// input — it does not throw, so nothing surfaces until a user reads it.
//
// That exact bug is already documented in this codebase: instituteValidity.ts
// exists because three display helpers each parsed `activeUntil` their own way
// and rendered "Invalid Date" on three screens.
//
// The fix applied then was a guard AT THE CALL SITE — `validityLabel` in
// UserManagementPage checks `daysUntilExpiry(...) === null` before it formats,
// and it is correct. But a guard at the call site has to be remembered by
// every call site, and there are eleven formatters and many more callers. So
// the guard moves INTO the formatter, where forgetting it is not possible.
//
// This is a deliberate, if small, behaviour change: a field that previously
// rendered "Invalid Date" now renders an em dash. "Invalid Date" is not a
// state any user can act on, and it reads as a crash; the dash reads as
// "not recorded", which is what it means.

/** What an unformattable date renders as. Shared, so it cannot be worded two ways. */
export const UNKNOWN_DATE_LABEL = '—';

/**
 * Parse, or report that we cannot.
 *
 * `Date.parse` rather than `new Date(...)` so the check is on a number, and
 * `Number.isFinite` rather than `isNaN` so the intent reads positively — the
 * same shape instituteValidity uses, deliberately, because these two modules
 * answer questions about the same kind of value.
 */
function parsed(iso: unknown): Date | null {
  const raw = String(iso ?? '');
  if (raw.trim() === '') return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}

/** `15 Aug 2026` — the everyday format. */
export function formatDate(iso: unknown): string {
  const d = parsed(iso);
  if (!d) return UNKNOWN_DATE_LABEL;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** `15 August 2026` — profile headers and the institute detail page. */
export function formatDateLong(iso: unknown): string {
  const d = parsed(iso);
  if (!d) return UNKNOWN_DATE_LABEL;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * `15 Aug 2026, 09:30` — wherever the CLOCK matters as much as the day.
 *
 * Its own export rather than a flag on formatDate: a submission time is a
 * different fact from a date, and the screens that show it are the ones where
 * a candidate checks when a paper opened or when theirs was handed in.
 * Collapsing it into an option is how it eventually gets rendered without the
 * time.
 */
export function formatDateTime(iso: unknown): string {
  const d = parsed(iso);
  if (!d) return UNKNOWN_DATE_LABEL;
  return d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * `15 Aug` — compact columns where the year is noise.
 *
 * The assignment lists show a start and an end side by side in a narrow cell;
 * repeating the year twice costs width and tells the reader nothing they do
 * not already know from the page they are on.
 */
export function formatDayMonth(iso: unknown): string {
  const d = parsed(iso);
  if (!d) return UNKNOWN_DATE_LABEL;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** `15 Aug, 09:30` — the student assessment list, where the year is implied. */
export function formatDayMonthTime(iso: unknown): string {
  const d = parsed(iso);
  if (!d) return UNKNOWN_DATE_LABEL;
  return d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * `09:30` — the clock alone, for "updated at" lines.
 *
 * A freshness stamp is read against the reader's own sense of now, so the day
 * is noise: a console that says "Updated 21 Aug, 09:30" makes you work out
 * that 21 Aug is today. Screens that need the date have formatDateTime.
 */
export function formatClock(iso: unknown): string {
  const d = parsed(iso);
  if (!d) return UNKNOWN_DATE_LABEL;
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Clip a long string for a table cell.
 *
 * Four copies, byte-identical, in QuestionBankCore, the two role question
 * pages and the assignment builder's shared module. Trivial, and included for
 * exactly that reason: a trivial helper is the one nobody thinks to share, so
 * it is the one that ends up with four subtly different default lengths.
 */
export function truncate(s: string, n = 100): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
