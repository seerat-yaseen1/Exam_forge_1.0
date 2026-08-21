/**
 * fleetOverview — what the Web Owner needs to know before they touch anything.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────
 * The Web Owner's landing page was an empty panel reading "Modules will appear
 * here", with a comment calling it "a system at rest". It is the first screen
 * the person responsible for every institute on the platform sees, and it told
 * them nothing — so the first thing they always did was navigate away from it
 * to go and count things by eye in a table.
 *
 * The questions that page should answer are narrow and they are all about
 * EXCEPTIONS: whose access lapses this month, who is disabled, who signed up
 * and has not been set up yet. An overview whose job is to be scanned should
 * lead with what is wrong, because what is fine needs no attention and a
 * dashboard that gives equal weight to both is a dashboard nobody reads twice.
 *
 * ── WHY THE EXPIRY BUCKETS ARE WHAT THEY ARE ──────────────────────
 * `expired` is a fault: those institutes cannot sign in right now.
 * `lapsing` is 30 days, which is the window in which a renewal conversation
 * can still be unhurried. Anything further out is `healthy` — surfacing a
 * renewal 90 days early trains people to ignore the number.
 *
 * PURE. No Firestore, no React, no clock of its own — `now` is a parameter,
 * which is also what makes the tests possible.
 */

import type { Institute } from './firebaseService';
import { daysUntilExpiry } from './instituteValidity';

/** Days before expiry at which an institute starts asking for attention. */
export const LAPSING_WINDOW_DAYS = 30;

export type InstituteHealth = 'expired' | 'lapsing' | 'healthy' | 'disabled' | 'unbounded';

/**
 * One institute's state, in the order the answers matter.
 *
 * `disabled` outranks every date: an institute somebody switched off is off,
 * and reporting it as "lapsing in 12 days" describes a countdown that means
 * nothing. The staff decision beats the clock, the same way `admin_closed`
 * beats the window on a student's assessment.
 */
export function healthOf(institute: Institute, now: number = Date.now()): InstituteHealth {
  if (institute.status === 'disabled') return 'disabled';

  const days = daysUntilExpiry(institute.activeUntil, now);
  if (days === null) return 'unbounded';
  if (days < 0) return 'expired';
  if (days <= LAPSING_WINDOW_DAYS) return 'lapsing';
  return 'healthy';
}

/**
 * The words and the colour each state gets, everywhere it appears.
 *
 * Here rather than on a page because two screens show it — the overview and
 * the institutes table — and the first version of the table said "Expired"
 * where the overview said "Access lapsed". One state with two names is two
 * states as far as the reader is concerned.
 */
export const HEALTH_LABEL: Record<InstituteHealth, string> = {
  expired: 'Access lapsed',
  lapsing: 'Renewing soon',
  disabled: 'Disabled',
  healthy: 'Active',
  unbounded: 'No expiry',
};

export const HEALTH_TONE: Record<InstituteHealth, 'danger' | 'warning' | 'muted' | 'success'> = {
  expired: 'danger',
  lapsing: 'warning',
  disabled: 'muted',
  healthy: 'success',
  unbounded: 'muted',
};

export type FleetSummary = {
  total: number;
  /** Signed-in-able right now: active status, and not past its date. */
  operational: number;
  expired: number;
  lapsing: number;
  disabled: number;
  /** Institutes with no expiry date at all — counted, never treated as a fault. */
  unbounded: number;
  /**
   * The rows the page leads with: everything that is not healthy, most urgent
   * first. Empty is a real and good answer, and the page says so rather than
   * rendering a table of nothing.
   */
  needsAttention: Array<{ institute: Institute; health: InstituteHealth; days: number | null }>;
};

const URGENCY: Record<InstituteHealth, number> = {
  expired: 0,
  lapsing: 1,
  disabled: 2,
  healthy: 3,
  unbounded: 4,
};

export function summariseFleet(institutes: Institute[], now: number = Date.now()): FleetSummary {
  const summary: FleetSummary = {
    total: institutes.length,
    operational: 0,
    expired: 0,
    lapsing: 0,
    disabled: 0,
    unbounded: 0,
    needsAttention: [],
  };

  for (const institute of institutes) {
    const health = healthOf(institute, now);
    const days = daysUntilExpiry(institute.activeUntil, now);

    if (health === 'disabled') summary.disabled += 1;
    else if (health === 'expired') summary.expired += 1;
    else if (health === 'lapsing') summary.lapsing += 1;
    else if (health === 'unbounded') summary.unbounded += 1;

    // Operational means "this institute can be used today". A lapsing one
    // still can — that is the whole point of warning early.
    if (health === 'lapsing' || health === 'healthy' || health === 'unbounded') {
      summary.operational += 1;
    }

    if (health === 'expired' || health === 'lapsing' || health === 'disabled') {
      summary.needsAttention.push({ institute, health, days });
    }
  }

  summary.needsAttention.sort((a, b) => {
    const byUrgency = URGENCY[a.health] - URGENCY[b.health];
    if (byUrgency !== 0) return byUrgency;
    // Within a bucket, soonest first. A null date sorts last — it has no
    // deadline to be close to.
    if (a.days === null) return 1;
    if (b.days === null) return -1;
    return a.days - b.days;
  });

  return summary;
}

/**
 * How long is left, said the way a person would say it.
 *
 * Deliberately not a date: "in 9 days" is a decision, "12 March" is homework.
 * The exact date is one hover away on the row itself.
 */
export function expiryPhrase(days: number | null): string {
  if (days === null) return 'No expiry';
  if (days < -1) return `Expired ${Math.abs(days)} days ago`;
  if (days === -1) return 'Expired yesterday';
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  if (days <= 45) return `Expires in ${days} days`;
  const months = Math.round(days / 30);
  return `Expires in about ${months} month${months === 1 ? '' : 's'}`;
}
