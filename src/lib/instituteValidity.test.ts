/**
 * The guard that three screens were missing.
 *
 * Every case below is a shape `activeUntil` genuinely takes in this codebase,
 * and each of the first three used to render "Invalid Date" to a user. The
 * point of the tests is less the arithmetic than the CLASSIFICATION: does this
 * value mean "no expiry", or does it mean a date?
 */

import { describe, it, expect } from 'vitest';
import { daysUntilExpiry, NO_EXPIRY_LABEL } from './instituteValidity';

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
    expect(daysUntilExpiry('2026-09-12', NOW)).toBe(30);
  });

  it('never confuses a real date with no expiry', () => {
    // The regression that matters in the other direction: if a genuine expiry
    // classified as null, an expired tenant would read as "No expiry".
    expect(daysUntilExpiry(inDays(-1), NOW)).not.toBeNull();
    expect(daysUntilExpiry(inDays(365), NOW)).not.toBeNull();
  });
});

describe('the shared label', () => {
  it('exists so three screens cannot word one state three ways', () => {
    expect(NO_EXPIRY_LABEL).toBe('No expiry');
  });
});
