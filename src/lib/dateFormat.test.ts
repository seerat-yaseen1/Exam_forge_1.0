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
  formatDayMonth,
  formatDayMonthTime,
  truncate,
} from './dateFormat';

const ISO = '2026-08-15T09:30:00.000Z';

describe('the guard — what the eleven copies rendered as "Invalid Date"', () => {
  // Every one of these produced the literal string "Invalid Date" before, on
  // whichever screen happened to receive an absent or malformed field. It does
  // not throw, so nothing surfaced until a user read it.
  const bad: unknown[] = [undefined, null, '', '   ', 'n/a', 'not-a-date', {}, [], NaN];

  for (const fn of [formatDate, formatDateLong, formatDateTime, formatDayMonth, formatDayMonthTime]) {
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

  it('the product speaks en-GB — day before month', () => {
    // The locale decision, pinned. en-US would render "Aug 15"; a silent
    // revert to it is exactly the drift this module was built to prevent.
    expect(formatDate(ISO)).toMatch(/^15 Aug/);
    expect(formatDateLong(ISO)).toMatch(/^15 August/);
    expect(formatDayMonth(ISO)).toBe('15 Aug');
  });

  it('all three carry the day and year', () => {
    for (const out of [formatDate(ISO), formatDateLong(ISO), formatDateTime(ISO)]) {
      expect(out).toMatch(/15/);
      expect(out).toMatch(/2026/);
    }
    // The two compact formats carry the day but deliberately omit the year.
    for (const out of [formatDayMonth(ISO), formatDayMonthTime(ISO)]) {
      expect(out).toMatch(/15/);
      expect(out).not.toMatch(/2026/);
    }
  });

  it('only the date+time formats carry a time, and it is 24-hour', () => {
    // The distinction the results page depends on: a candidate checking WHEN
    // their paper was handed in needs the clock, not just the day.
    //
    // 24-hour is the en-GB consequence, and it is asserted rather than merely
    // accepted — on a platform that exists to tell people when a paper opens
    // and closes, "9:30" without a meridiem would be genuinely ambiguous, so a
    // drift back to a 12-hour format must fail here.
    expect(formatDateTime(ISO)).toMatch(/\d{2}:\d{2}/);
    expect(formatDateTime(ISO)).not.toMatch(/AM|PM/i);
    expect(formatDayMonthTime(ISO)).toMatch(/\d{2}:\d{2}/);
    expect(formatDate(ISO)).not.toMatch(/\d{2}:\d{2}/);
    expect(formatDateLong(ISO)).not.toMatch(/\d{2}:\d{2}/);
    expect(formatDayMonth(ISO)).not.toMatch(/\d{2}:\d{2}/);
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
