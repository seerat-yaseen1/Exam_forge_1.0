// ══════════════════════════════════════════════════════════════════
// DATE FORMATTING — three formats, one implementation each
// (Audit F-7, stage 1)
// ══════════════════════════════════════════════════════════════════
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
//   short      Aug 15, 2026            7 copies, 4 syntactic variants
//   long       August 15, 2026         3 copies, 2 variants
//   date+time  Aug 15, 2026, 9:30 AM   1 copy   (ExamResultsPage)
//
// Six implementations of three formats is how a platform ends up showing the
// same field two ways on consecutive screens — the failure instituteValidity's
// header describes for a different field, in the same words.
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

/** `Aug 15, 2026` — the majority format (7 of the 11 copies). */
export function formatDate(iso: unknown): string {
  const d = parsed(iso);
  if (!d) return UNKNOWN_DATE_LABEL;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** `August 15, 2026` — profile headers and the institute detail page. */
export function formatDateLong(iso: unknown): string {
  const d = parsed(iso);
  if (!d) return UNKNOWN_DATE_LABEL;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * `Aug 15, 2026, 9:30 AM` — the results page.
 *
 * Kept as its own export rather than an option on formatDate. A submission
 * time is a different fact from a date, and the one screen that shows it is
 * the one where a candidate checks when their paper was handed in; collapsing
 * it into a flag is how it eventually gets rendered without the time.
 */
export function formatDateTime(iso: unknown): string {
  const d = parsed(iso);
  if (!d) return UNKNOWN_DATE_LABEL;
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
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
