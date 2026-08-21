import { describe, it, expect } from 'vitest';
import {
  summariseRoster,
  attentionItems,
  EMPTY_ROSTER,
  type RosterMember,
  type RosterSummary,
} from './rosterSummary';

let seq = 0;
const member = (over: Partial<RosterMember> = {}): RosterMember => ({
  id: `m${seq++}`,
  status: 'active',
  ...over,
});

describe('summariseRoster', () => {
  it('splits active from disabled', () => {
    const s = summariseRoster([
      member(),
      member(),
      member({ status: 'disabled' }),
    ], new Set());
    expect(s).toEqual({ total: 3, active: 2, disabled: 1, dormant: 0 });
  });

  it('counts an account that has never been signed into, whatever its status', () => {
    // A disabled account that was never used is still an unclaimed credential.
    // Reading "dormant" as "active and unused" would hide exactly the accounts
    // an admin is most likely to want to clean up.
    const never = member();
    const neverAndDisabled = member({ status: 'disabled' });
    const s = summariseRoster(
      [never, neverAndDisabled, member()],
      new Set([never.id, neverAndDisabled.id]),
    );
    expect(s.dormant).toBe(2);
    expect(s.active).toBe(2);
    expect(s.disabled).toBe(1);
  });

  // ── The distinction the old flag could not make ──────────────────
  // `dormant` used to come from `firstLoginRequired` on the profile, which no
  // provisioning path ever set to true — so it was 0 for every institute,
  // forever, under a tile reading "everyone has". The sign-in answer now
  // arrives separately and can be absent, and absent must not read as zero.
  it('reports dormant as NULL when the sign-in answer is unavailable', () => {
    const s = summariseRoster([member(), member({ status: 'disabled' })]);
    expect(s.dormant).toBeNull();
    // The rest of the census does not depend on it and must still be right.
    expect(s.total).toBe(2);
    expect(s.active).toBe(1);
    expect(s.disabled).toBe(1);
  });

  it('distinguishes "nobody has signed in" from "we do not know"', () => {
    const roster = [member(), member()];
    expect(summariseRoster(roster, new Set()).dormant).toBe(0);
    expect(summariseRoster(roster, null).dormant).toBeNull();
  });

  it('ignores uids in the set that are not on this roster', () => {
    // The two fetches are independent, so the set can name someone the roster
    // no longer lists — a member deleted between the two calls. Counting them
    // would inflate the tile above the roster's own total.
    const m = member();
    const s = summariseRoster([m], new Set([m.id, 'someone-else-entirely']));
    expect(s.dormant).toBe(1);
  });

  it('summarises nothing as zeroes rather than throwing', () => {
    expect(summariseRoster([])).toEqual(EMPTY_ROSTER);
  });
});

describe('attentionItems', () => {
  const quiet = {
    faculty: EMPTY_ROSTER,
    students: EMPTY_ROSTER,
    pendingQuestions: 0,
    pendingDeletions: 0,
    daysUntilExpiry: null,
  };
  const roster = (over: Partial<RosterSummary>): RosterSummary => ({ ...EMPTY_ROSTER, ...over });

  it('says nothing when nothing needs anyone', () => {
    expect(attentionItems(quiet)).toEqual([]);
  });

  it('puts a closed access window above everything else', () => {
    const items = attentionItems({
      ...quiet,
      daysUntilExpiry: -3,
      pendingQuestions: 9,
      students: roster({ total: 5, dormant: 5 }),
    });
    expect(items[0].key).toBe('expired');
    expect(items[0].tone).toBe('danger');
  });

  it('warns inside the renewal window but not outside it', () => {
    const [twelve] = attentionItems({ ...quiet, daysUntilExpiry: 12 });
    expect(twelve.key).toBe('lapsing');
    expect(twelve.count).toBe(12);
    // The figure is rendered large beside the label, so the label never
    // repeats it — "12  12 days of access left" is what happens otherwise.
    expect(twelve.label).toBe('days of access left');
    expect(attentionItems({ ...quiet, daysUntilExpiry: 1 })[0].label).toBe('day of access left');
    expect(attentionItems({ ...quiet, daysUntilExpiry: 90 })).toEqual([]);
  });

  it('has no expiry item at all when the institute has no expiry', () => {
    expect(attentionItems({ ...quiet, daysUntilExpiry: null })).toEqual([]);
  });

  it('ranks a person waiting above an unused credential', () => {
    const items = attentionItems({
      ...quiet,
      pendingDeletions: 2,
      faculty: roster({ total: 4, active: 4, dormant: 4 }),
    });
    expect(items.map((i) => i.key)).toEqual(['requests', 'faculty-dormant']);
  });

  it('adds the two request kinds into one item and names both', () => {
    const [item] = attentionItems({ ...quiet, pendingQuestions: 3, pendingDeletions: 1 });
    expect(item.count).toBe(4);
    expect(item.label).toBe('requests waiting');
    expect(item.hint).toContain('3 question');
    expect(item.hint).toContain('1 deletion');
  });

  it('names only the request kind that is actually pending', () => {
    const [item] = attentionItems({ ...quiet, pendingQuestions: 0, pendingDeletions: 2 });
    expect(item.hint).toContain('2 deletion');
    expect(item.hint).not.toContain('question');
  });

  it('singularises', () => {
    const [one] = attentionItems({ ...quiet, faculty: roster({ total: 1, active: 1, dormant: 1 }) });
    expect(one.label).toBe('faculty member never signed in');
    const [two] = attentionItems({ ...quiet, faculty: roster({ total: 2, active: 2, dormant: 2 }) });
    expect(two.label).toBe('faculty members never signed in');
  });

  it('pools disabled accounts across both rosters and points at the bigger side', () => {
    const items = attentionItems({
      ...quiet,
      faculty: roster({ total: 3, active: 2, disabled: 1 }),
      students: roster({ total: 9, active: 5, disabled: 4 }),
    });
    const disabled = items.find((i) => i.key === 'disabled')!;
    expect(disabled.count).toBe(5);
    expect(disabled.tab).toBe('students');
  });

  it('gives every item a tab to open, except the ones the admin cannot fix here', () => {
    const items = attentionItems({
      ...quiet,
      daysUntilExpiry: 4,
      pendingQuestions: 1,
      students: roster({ total: 2, active: 2, dormant: 2 }),
    });
    expect(items.find((i) => i.key === 'lapsing')!.tab).toBeNull();
    expect(items.filter((i) => i.key !== 'lapsing').every((i) => i.tab !== null)).toBe(true);
  });
});
