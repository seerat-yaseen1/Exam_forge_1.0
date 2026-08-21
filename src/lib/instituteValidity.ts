/**
 * How long an institute's access has left — and the one shape that means
 * "forever".
 *
 * `activeUntil` says "no expiry" in THREE different shapes: absent, empty
 * string, and unparseable. The server states this outright in
 * assertInstituteActiveS — *"An absent or unparseable value means NO expiry
 * rather than an expired one"* — and the three client auth gates already
 * honour it, via `activeUntil && new Date(activeUntil) < new Date()`: the
 * leading truthiness check catches absent and empty, and NaN's always-false
 * comparison catches unparseable. Both land on "not expired", which is right.
 *
 * THE DISPLAY HELPERS DID NOT. Each of the three went straight to
 * `new Date(activeUntil).getTime()`, got NaN, fell past every branch — because
 * every comparison against NaN is false — and formatted the invalid date. So
 * an institute with no expiry was labelled:
 *
 *   • "Invalid Date"        in the Web Owner's institutes table
 *   • "Until Invalid Date"  on its detail header
 *   • "Invalid Date"        on the institute's own profile page
 *
 * Three copies of one missing guard, which is why the guard now lives here
 * instead of being pasted a fourth time.
 *
 * WHY null AND NOT Infinity. Infinity survives arithmetic and comparison, so a
 * caller that forgot to handle "no expiry" would get a plausible-looking
 * answer and render something confident and wrong — which is the failure this
 * module exists to end. null forces the branch.
 */

/**
 * The instant an `activeUntil` value actually runs out — or null for the three
 * shapes that mean "forever" (absent, empty, unparseable).
 *
 * ── WHY A DATE-ONLY VALUE IS NOT MIDNIGHT ─────────────────────────
 *
 * `computeActiveUntil` ends with `.toISOString().split('T')[0]`, so the value
 * this platform actually stores is a bare `YYYY-MM-DD`. Date.parse reads that
 * as UTC midnight at the START of the named day, which meant the institute was
 * already out of time for the whole of that day: one set to run until
 * 21 September lost access at 00:00 UTC on 21 September, and the date the Web
 * Owner picked — the one rendered back to them as "active until 21 Sep", the
 * one on the invoice — was never a day it could sign in.
 *
 * A date-only bound therefore means the END of that day, which is what "until
 * the 21st" means everywhere outside a parser. Values carrying an explicit
 * time are left alone: those are a precise instant and were always meant
 * literally.
 *
 * UTC, matching every other date in this codebase and the `Etc/UTC` schedule
 * of the sweep that enforces it. For the platform's own timezone (IST,
 * UTC+5:30) that lands the cutoff at 05:29 the following morning — a few
 * hours' grace past the named day, which is the right direction to err for a
 * commercial access window. Erring the other way is what this fixes.
 *
 * ONE PARSE, used by both halves. The module header is about three display
 * helpers that each parsed this field their own way; a countdown that says
 * "expired today" while the gate still admits you would be that same bug
 * wearing a different hat.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function expiryInstant(activeUntil: unknown): number | null {
  const trimmed = String(activeUntil ?? '').trim();
  if (trimmed === '') return null;
  // An impossible date ('2026-13-45') still matches the pattern and still
  // parses to NaN, so it lands on the same "forever" answer as any other
  // unparseable value rather than on a wrong instant.
  const t = DATE_ONLY.test(trimmed) ? Date.parse(`${trimmed}T23:59:59.999Z`) : Date.parse(trimmed);
  return Number.isFinite(t) ? t : null;
}

/**
 * Whole days until expiry; null when the institute has no expiry at all.
 *
 * The `typeof` guard stays in front of the shared parse and is not redundant
 * with it. This helper's contract is narrower than hasExpired's: it takes a
 * declared string, so a number arriving here is a caller bug, and coercing it
 * would hide one — `Date.parse('12345')` is a perfectly finite instant in the
 * year 12345, so the number 12345 would render as a confident countdown of
 * about three and a half million days. hasExpired coerces on purpose, because
 * its input is `unknown` straight off a Firestore document.
 */
export function daysUntilExpiry(
  activeUntil: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (typeof activeUntil !== 'string') return null;
  const t = expiryInstant(activeUntil);
  if (t === null) return null;
  return Math.ceil((t - now) / 86_400_000);
}

/**
 * The words for the unbounded case.
 *
 * Shared so three screens cannot word the same state three ways — which is how
 * the platform ends up with "No expiry", "Unlimited" and "—" all meaning the
 * same thing to the same person on consecutive screens.
 */
export const NO_EXPIRY_LABEL = 'No expiry';

/**
 * Has this institute's access window closed?
 *
 * THE SAME FIELD AND THE SAME THREE-SHAPED "FOREVER" as daysUntilExpiry above,
 * which is exactly why it belongs here rather than beside the gates that use
 * it. The module header describes a bug caused by three DISPLAY helpers each
 * parsing `activeUntil` their own way; the three AUTH gates were the other
 * copy of that same parse, written as:
 *
 *     activeUntil && new Date(activeUntil) < new Date()
 *
 * That expression is correct — the truthiness check catches absent and empty,
 * and NaN's always-false comparison catches unparseable, so all three land on
 * "not expired". It was correct three times, in three files, with nothing
 * holding them together. The display half already lives here; this is the
 * enforcement half joining it.
 *
 * BEHAVIOUR IS PRESERVED EXACTLY for values that carry a time, including the
 * `String(x ?? '')` coercion the gates applied before comparing. The one shape
 * that changed is the date-only one — which is the shape this platform
 * actually stores. See expiryInstant above for why the named day now counts.
 */
export function hasExpired(
  activeUntil: unknown,
  now: number = Date.now(),
): boolean {
  const t = expiryInstant(activeUntil);
  if (t === null) return false;             // absent, empty or unparseable → no expiry
  return t < now;
}
