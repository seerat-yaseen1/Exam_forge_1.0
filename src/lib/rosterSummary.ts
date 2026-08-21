/**
 * What an institute admin needs to know before they know what they want.
 *
 * ── THE PROBLEM THIS SOLVES ───────────────────────────────────────
 * The institute console used to open on a tab bar. Four tabs, no state: the
 * admin had to click into Faculty, count, click into Students, count, click
 * into Approvals, and only then know whether anything needed them. Every
 * visit paid that cost, and the answer was usually "nothing".
 *
 * A console should answer "does anything need me?" before it answers
 * "what would you like to look at?". That is the exception-first reading
 * order the Web Owner overview already uses (see fleetOverview.ts), and this
 * is its counterpart one level down.
 *
 * ── WHY THE COUNTING LIVES HERE ───────────────────────────────────
 * "Never signed in" is the interesting one, and it is the one a component
 * would get subtly wrong. A provisioned account that has never been used is
 * not disabled and not active-in-any-useful-sense: it is a credential sitting
 * in someone's inbox, and a term's worth of them is a real operational
 * problem the admin currently cannot see at all. Counting it is one line —
 * agreeing on what it MEANS, across two rosters and three surfaces, is the
 * part worth pinning down in one tested place.
 */

// ── Rosters ───────────────────────────────────────────────────────

/** The only two fields either roster is summarised on. */
export type RosterMember = {
  status: 'active' | 'disabled';
  firstLoginRequired: boolean;
};

export type RosterSummary = {
  total: number;
  active: number;
  disabled: number;
  /**
   * Provisioned, never used.
   *
   * Counted regardless of status, because a disabled account that was never
   * signed into is still an unclaimed credential — disabling it is what the
   * admin might want to do, not evidence that they already did.
   */
  dormant: number;
};

export const EMPTY_ROSTER: RosterSummary = { total: 0, active: 0, disabled: 0, dormant: 0 };

export function summariseRoster(members: RosterMember[]): RosterSummary {
  let active = 0;
  let disabled = 0;
  let dormant = 0;
  for (const m of members) {
    if (m.status === 'disabled') disabled += 1;
    else active += 1;
    if (m.firstLoginRequired) dormant += 1;
  }
  return { total: members.length, active, disabled, dormant };
}

// ── The band across the top ───────────────────────────────────────

export type AttentionTone = 'danger' | 'warning' | 'accent';

export type AttentionItem = {
  key: string;
  tone: AttentionTone;
  /**
   * The figure, shown large beside the label — so the label never repeats it.
   * Omitted when the item is a state rather than a quantity ("access expired"
   * is not a count of anything, and "0" beside it would be a lie).
   */
  count?: number;
  /** What the figure is. Reads under the number, so it starts lower-case. */
  label: string;
  /** One line on what to do about it. */
  hint: string;
  /** Which tab answers it — every item on this band is clickable. */
  tab: 'faculties' | 'students' | 'approvals' | null;
};

function plural(n: number, one: string, many = `${one}s`) {
  return n === 1 ? one : many;
}

/**
 * The things waiting on this admin, in the order they should be dealt with.
 *
 * ── THE ORDER IS THE DESIGN ───────────────────────────────────────
 * Access expiry first: when the window closes, nothing else on this page can
 * be acted on anyway. Then requests, because a request is a person waiting
 * on a human decision — the only item here with someone on the other end of
 * it. Then dormant credentials, then disabled accounts, which are usually
 * deliberate and are here to be confirmed rather than fixed.
 *
 * Returning an empty array is a real answer, and the caller renders it as
 * one: "nothing needs you" is worth saying out loud, because an admin who is
 * shown nothing cannot tell it apart from a page that failed to load.
 */
export function attentionItems({
  faculty,
  students,
  pendingQuestions,
  pendingDeletions,
  daysUntilExpiry,
}: {
  faculty: RosterSummary;
  students: RosterSummary;
  pendingQuestions: number;
  pendingDeletions: number;
  /** From `daysUntilExpiry()`; null means this institute has no expiry. */
  daysUntilExpiry: number | null;
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (daysUntilExpiry !== null && daysUntilExpiry <= 0) {
    items.push({
      key: 'expired',
      tone: 'danger',
      label: 'Access expired',
      hint: 'Sign-in is closed for everyone at this institute. Contact the platform administrator to renew.',
      tab: null,
    });
  } else if (daysUntilExpiry !== null && daysUntilExpiry <= 30) {
    items.push({
      key: 'lapsing',
      tone: 'warning',
      count: daysUntilExpiry,
      label: `${plural(daysUntilExpiry, 'day')} of access left`,
      hint: 'Renew before it lapses — sign-in closes for every account here on that date.',
      tab: null,
    });
  }

  const requests = pendingQuestions + pendingDeletions;
  if (requests > 0) {
    const parts: string[] = [];
    if (pendingQuestions > 0) parts.push(`${pendingQuestions} question`);
    if (pendingDeletions > 0) parts.push(`${pendingDeletions} deletion`);
    items.push({
      key: 'requests',
      tone: 'warning',
      count: requests,
      label: `${plural(requests, 'request')} waiting`,
      hint: `${parts.join(' and ')} — someone is blocked until you decide.`,
      tab: 'approvals',
    });
  }

  if (faculty.dormant > 0) {
    items.push({
      key: 'faculty-dormant',
      tone: 'accent',
      count: faculty.dormant,
      label: `${plural(faculty.dormant, 'faculty member', 'faculty members')} never signed in`,
      hint: 'Their first-login password is still unused. Check the invitation reached them.',
      tab: 'faculties',
    });
  }

  if (students.dormant > 0) {
    items.push({
      key: 'student-dormant',
      tone: 'accent',
      count: students.dormant,
      label: `${plural(students.dormant, 'student')} never signed in`,
      hint: 'They cannot sit an exam until they have. Worth chasing before the next one.',
      tab: 'students',
    });
  }

  const disabled = faculty.disabled + students.disabled;
  if (disabled > 0) {
    items.push({
      key: 'disabled',
      tone: 'accent',
      count: disabled,
      label: `${plural(disabled, 'account')} disabled`,
      hint: 'Disabled accounts cannot sign in. Usually deliberate — here so it stays visible.',
      tab: faculty.disabled >= students.disabled ? 'faculties' : 'students',
    });
  }

  return items;
}
