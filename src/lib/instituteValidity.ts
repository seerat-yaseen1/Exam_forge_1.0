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

/** Whole days until expiry; null when the institute has no expiry at all. */
export function daysUntilExpiry(
  activeUntil: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (typeof activeUntil !== 'string' || activeUntil.trim() === '') return null;
  const t = Date.parse(activeUntil);
  if (!Number.isFinite(t)) return null;
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
