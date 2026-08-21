/**
 * The guard that three screens were missing.
 *
 * Every case below is a shape `activeUntil` genuinely takes in this codebase,
 * and each of the first three used to render "Invalid Date" to a user. The
 * point of the tests is less the arithmetic than the CLASSIFICATION: does this
 * value mean "no expiry", or does it mean a date?
 */

import { describe, it, expect } from 'vitest';
import { daysUntilExpiry, hasExpired, NO_EXPIRY_LABEL } from './instituteValidity';

const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const inDays = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

describe('daysUntilExpiry — the "no expiry" shapes', () => {
  it('treats an empty string as no expiry', () => {
    // The shape the institute drawer writes when validity is unbounded, and
    // the one the server's own gate explicitly reads as unbounded.
    expect(daysUntilExpiry('', NOW)).toBeNull();
    expect(daysUntilExpiry('   ', NOW)).toBeNull();
  });

  it('treats absent as no expiry', () => {
    expect(daysUntilExpiry(undefined, NOW)).toBeNull();
    expect(daysUntilExpiry(null, NOW)).toBeNull();
  });

  it('treats an unparseable value as no expiry, NOT as expired', () => {
    // Matches assertInstituteActiveS: "An absent or unparseable value means NO
    // expiry rather than an expired one". Reading it as expired would lock a
    // tenant out on a malformed field.
    expect(daysUntilExpiry('not-a-date', NOW)).toBeNull();
    expect(daysUntilExpiry('0000-00-00', NOW)).toBeNull();
  });

  it('is not fooled by a non-string', () => {
    expect(daysUntilExpiry(12345 as unknown as string, NOW)).toBeNull();
  });
});

describe('daysUntilExpiry — real dates', () => {
  it('counts days remaining', () => {
    expect(daysUntilExpiry(inDays(30), NOW)).toBe(30);
    expect(daysUntilExpiry(inDays(7), NOW)).toBe(7);
    expect(daysUntilExpiry(inDays(1), NOW)).toBe(1);
  });

  it('returns 0 on the last day', () => {
    expect(daysUntilExpiry(new Date(NOW).toISOString(), NOW)).toBe(0);
  });

  it('goes negative once past', () => {
    expect(daysUntilExpiry(inDays(-1), NOW)).toBe(-1);
    expect(daysUntilExpiry(inDays(-40), NOW)).toBe(-40);
  });

  it('accepts a plain date string, which is what the picker produces', () => {
    // The custom-validity input is <input type="date">, so the stored value
    // can be 'YYYY-MM-DD' with no time component.
    //
    // 31, not 30, and the change is the point. A date-only bound now means the
    // END of the named day (see expiryInstant), so from noon on 13 August the
    // institute has the rest of today plus every day through 12 September. The
    // old 30 came from reading '2026-09-12' as midnight at the START of the
    // 12th — the same off-by-one that made hasExpired lock tenants out on the
    // very date the Web Owner had picked.
    expect(daysUntilExpiry('2026-09-12', NOW)).toBe(31);
  });

  it('never confuses a real date with no expiry', () => {
    // The regression that matters in the other direction: if a genuine expiry
    // classified as null, an expired tenant would read as "No expiry".
    expect(daysUntilExpiry(inDays(-1), NOW)).not.toBeNull();
    expect(daysUntilExpiry(inDays(365), NOW)).not.toBeNull();
  });
});

describe('hasExpired — the date-only bound is inclusive of its day', () => {
  // The shape that matters: computeActiveUntil ends with
  // `.toISOString().split('T')[0]`, so 'YYYY-MM-DD' is what this platform
  // actually stores — and it was the one shape no test covered. Every case in
  // accessGate.test.ts used a full ISO timestamp, which is precisely why the
  // off-by-one survived.
  const DAY = '2026-09-21';
  const at = (iso: string) => Date.parse(iso);

  it('admits the whole of the named day', () => {
    // 00:00:00 UTC — the instant the old parse locked the tenant out.
    expect(hasExpired(DAY, at('2026-09-21T00:00:00.000Z'))).toBe(false);
    // Midday, and the last millisecond of the day.
    expect(hasExpired(DAY, at('2026-09-21T12:00:00.000Z'))).toBe(false);
    expect(hasExpired(DAY, at('2026-09-21T23:59:59.999Z'))).toBe(false);
  });

  it('refuses once the named day is over', () => {
    expect(hasExpired(DAY, at('2026-09-22T00:00:00.000Z'))).toBe(true);
    expect(hasExpired(DAY, at('2026-09-22T06:00:00.000Z'))).toBe(true);
  });

  it('still admits the morning of the named day in IST', () => {
    // The platform's own timezone is UTC+5:30, and 05:30 IST on the named day
    // was the exact moment institutes used to lose the day they had paid for.
    expect(hasExpired(DAY, at('2026-09-21T05:30:00.000Z'))).toBe(false);
  });

  it('leaves a value carrying an explicit time alone', () => {
    // Not date-only, so it means the instant it says and nothing is added.
    expect(hasExpired('2026-09-21T09:00:00.000Z', at('2026-09-21T09:00:00.001Z'))).toBe(true);
    expect(hasExpired('2026-09-21T09:00:00.000Z', at('2026-09-21T08:59:59.999Z'))).toBe(false);
  });

  it('reads an impossible date as no expiry, not as expired', () => {
    // '2026-13-45' matches the date-only pattern but parses to NaN. Reading
    // that as expired would lock a tenant out on a malformed field.
    expect(hasExpired('2026-13-45', at('2030-01-01T00:00:00.000Z'))).toBe(false);
    expect(hasExpired('0000-00-00', at('2030-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('keeps the three "forever" shapes unbounded', () => {
    for (const value of [undefined, null, '', '   ', 'not-a-date']) {
      expect(hasExpired(value, at('2030-01-01T00:00:00.000Z')), String(value)).toBe(false);
    }
  });

  it('agrees with the countdown on the last day', () => {
    // The two halves parse one field, so a countdown that says "expired" while
    // the gate still admits you is the bug this module exists to prevent.
    const noon = at('2026-09-21T12:00:00.000Z');
    expect(hasExpired(DAY, noon)).toBe(false);
    expect(daysUntilExpiry(DAY, noon)).toBeGreaterThan(0);
  });
});

describe('the shared label', () => {
  it('exists so three screens cannot word one state three ways', () => {
    expect(NO_EXPIRY_LABEL).toBe('No expiry');
  });
});
