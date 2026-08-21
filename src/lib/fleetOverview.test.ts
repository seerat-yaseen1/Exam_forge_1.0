/**
 * fleetOverview — the ordering is the feature.
 *
 * The arithmetic here is trivial; what has to be right is which institute the
 * Web Owner's eye lands on first. Every failure below is silent — the page
 * still renders a tidy list, it is just the wrong list, and nobody notices
 * until an institute has been locked out for a week.
 */

import { describe, it, expect } from 'vitest';
import type { Institute } from './firebaseService';
import { expiryPhrase, healthOf, summariseFleet } from './fleetOverview';

const NOW = Date.parse('2026-08-21T12:00:00.000Z');
const inDays = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

function institute(over: Partial<Institute> = {}): Institute {
  return {
    id: 'i1',
    name: 'Northwind',
    code: 'A3B7C2',
    adminName: 'Rahul Verma',
    adminEmail: 'rahul@northwind.edu',
    status: 'active',
    validityType: 'yearly',
    activeUntil: inDays(200),
    firstLoginRequired: false,
    ...over,
  } as Institute;
}

describe('healthOf', () => {
  it('reads the clock for an active institute', () => {
    expect(healthOf(institute({ activeUntil: inDays(-3) }), NOW)).toBe('expired');
    expect(healthOf(institute({ activeUntil: inDays(9) }), NOW)).toBe('lapsing');
    expect(healthOf(institute({ activeUntil: inDays(200) }), NOW)).toBe('healthy');
  });

  it('treats a missing date as unbounded rather than as expired', () => {
    // The failure this guards: an empty string parsed as epoch zero, and every
    // institute without a date reported as having lapsed in 1970.
    expect(healthOf(institute({ activeUntil: '' }), NOW)).toBe('unbounded');
    expect(healthOf(institute({ activeUntil: undefined as unknown as string }), NOW)).toBe('unbounded');
  });

  it('lets a staff decision outrank the clock', () => {
    // A disabled institute is off. Calling it "lapsing in 12 days" describes a
    // countdown to nothing.
    expect(healthOf(institute({ status: 'disabled', activeUntil: inDays(12) }), NOW)).toBe('disabled');
    expect(healthOf(institute({ status: 'disabled', activeUntil: inDays(-12) }), NOW)).toBe('disabled');
  });

  it('puts the boundary day inside the warning window, not outside it', () => {
    expect(healthOf(institute({ activeUntil: inDays(30) }), NOW)).toBe('lapsing');
    expect(healthOf(institute({ activeUntil: inDays(31) }), NOW)).toBe('healthy');
  });
});

describe('summariseFleet', () => {
  const fleet = [
    institute({ id: 'ok', name: 'Healthy', activeUntil: inDays(300) }),
    institute({ id: 'soon', name: 'Lapsing', activeUntil: inDays(12) }),
    institute({ id: 'gone', name: 'Expired', activeUntil: inDays(-4) }),
    institute({ id: 'off', name: 'Disabled', status: 'disabled' }),
    institute({ id: 'forever', name: 'Unbounded', activeUntil: '' }),
  ];

  it('counts each state once', () => {
    const s = summariseFleet(fleet, NOW);
    expect(s).toMatchObject({ total: 5, expired: 1, lapsing: 1, disabled: 1, unbounded: 1 });
  });

  it('counts a lapsing institute as operational — it still works today', () => {
    // That is the entire point of warning early: nothing has broken yet.
    const s = summariseFleet(fleet, NOW);
    expect(s.operational).toBe(3); // healthy + lapsing + unbounded
  });

  it('leads with what is broken, then with what is about to be', () => {
    const s = summariseFleet(fleet, NOW);
    expect(s.needsAttention.map((r) => r.institute.id)).toEqual(['gone', 'soon', 'off']);
  });

  it('orders within a bucket by how soon, not by name', () => {
    const s = summariseFleet(
      [
        institute({ id: 'later', activeUntil: inDays(28) }),
        institute({ id: 'sooner', activeUntil: inDays(2) }),
        institute({ id: 'middle', activeUntil: inDays(15) }),
      ],
      NOW,
    );
    expect(s.needsAttention.map((r) => r.institute.id)).toEqual(['sooner', 'middle', 'later']);
  });

  it('leaves healthy institutes out of the attention list entirely', () => {
    const s = summariseFleet(fleet, NOW);
    expect(s.needsAttention.map((r) => r.institute.id)).not.toContain('ok');
    expect(s.needsAttention.map((r) => r.institute.id)).not.toContain('forever');
  });

  it('has an empty attention list when nothing needs attention', () => {
    // The page treats this as a state of its own rather than as an empty table.
    const s = summariseFleet([institute({ activeUntil: inDays(300) })], NOW);
    expect(s.needsAttention).toEqual([]);
    expect(s.operational).toBe(1);
  });
});

describe('expiryPhrase', () => {
  it('says how long, not what date', () => {
    expect(expiryPhrase(0)).toBe('Expires today');
    expect(expiryPhrase(1)).toBe('Expires tomorrow');
    expect(expiryPhrase(9)).toBe('Expires in 9 days');
  });

  it('rounds to months once the number stops being actionable', () => {
    expect(expiryPhrase(200)).toBe('Expires in about 7 months');
    expect(expiryPhrase(30)).toBe('Expires in 30 days');
  });

  it('is specific about the past, because that is a fault', () => {
    expect(expiryPhrase(-1)).toBe('Expired yesterday');
    expect(expiryPhrase(-6)).toBe('Expired 6 days ago');
  });

  it('names the unbounded case rather than showing a blank', () => {
    expect(expiryPhrase(null)).toBe('No expiry');
  });
});
