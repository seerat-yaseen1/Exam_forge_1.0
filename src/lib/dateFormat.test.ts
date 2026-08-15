/**
 * DATE FORMATTING — the guard the eleven copies did not have
 *
 * The formatting assertions are deliberately thin: `toLocaleDateString` is the
 * platform's, not ours, and pinning its exact output would be testing V8.
 * What is worth pinning is the part every one of the eleven copies got wrong —
 * what happens when the input is not a date — and that the three formats stay
 * distinguishable from one another.
 */

import { describe, it, expect } from 'vitest';
import {
  UNKNOWN_DATE_LABEL,
  formatDate,
  formatDateLong,
  formatDateTime,
  truncate,
} from './dateFormat';

const ISO = '2026-08-15T09:30:00.000Z';

describe('the guard — what the eleven copies rendered as "Invalid Date"', () => {
  // Every one of these produced the literal string "Invalid Date" before, on
  // whichever screen happened to receive an absent or malformed field. It does
  // not throw, so nothing surfaced until a user read it.
  const bad: unknown[] = [undefined, null, '', '   ', 'n/a', 'not-a-date', {}, [], NaN];

  for (const fn of [formatDate, formatDateLong, formatDateTime]) {
    it(`${fn.name} returns the placeholder, never "Invalid Date"`, () => {
      for (const v of bad) {
        const out = fn(v);
        expect(out, `${fn.name}(${JSON.stringify(v)})`).toBe(UNKNOWN_DATE_LABEL);
        expect(out).not.toMatch(/Invalid/);
      }
    });
  }

  it('the placeholder is one shared string, not worded per screen', () => {
    expect(formatDate('')).toBe(formatDateLong(''));
    expect(formatDate('')).toBe(formatDateTime(''));
  });
});

describe('the three formats stay distinguishable', () => {
  it('short abbreviates the month, long spells it', () => {
    expect(formatDate(ISO)).toMatch(/Aug/);
    expect(formatDate(ISO)).not.toMatch(/August/);
    expect(formatDateLong(ISO)).toMatch(/August/);
  });

  it('all three carry the day and year', () => {
    for (const out of [formatDate(ISO), formatDateLong(ISO), formatDateTime(ISO)]) {
      expect(out).toMatch(/15/);
      expect(out).toMatch(/2026/);
    }
  });

  it('only the date+time format carries a time', () => {
    // The distinction the results page depends on: a candidate checking WHEN
    // their paper was handed in needs the clock, not just the day.
    expect(formatDateTime(ISO)).toMatch(/\d:\d{2}\s?(AM|PM)/i);
    expect(formatDate(ISO)).not.toMatch(/AM|PM/i);
    expect(formatDateLong(ISO)).not.toMatch(/AM|PM/i);
  });
});

describe('accepts what the callers actually pass', () => {
  it('a plain ISO string', () => {
    expect(formatDate(ISO)).not.toBe(UNKNOWN_DATE_LABEL);
  });

  it('a date-only string, which several Firestore fields carry', () => {
    expect(formatDate('2026-08-15')).not.toBe(UNKNOWN_DATE_LABEL);
  });

  it('an epoch number, because a document field is not always the declared type', () => {
    // The old copies took `iso: string` and would have been handed this by any
    // legacy document; `String(1e12)` is not parseable as a date, so the
    // placeholder is the honest answer rather than a plausible wrong one.
    expect(formatDate(Date.parse(ISO))).toBe(UNKNOWN_DATE_LABEL);
  });
});

describe('truncate — four byte-identical copies, one implementation', () => {
  it('leaves short strings alone', () => {
    expect(truncate('short')).toBe('short');
  });

  it('clips at the default and appends an ellipsis', () => {
    const long = 'x'.repeat(150);
    expect(truncate(long)).toBe('x'.repeat(100) + '…');
  });

  it('respects an explicit length', () => {
    expect(truncate('abcdef', 3)).toBe('abc…');
  });

  it('does not clip at exactly the boundary', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });
});
