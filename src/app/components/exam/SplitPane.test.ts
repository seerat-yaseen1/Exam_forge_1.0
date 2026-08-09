/**
 * The divider's clamp, and the storage it degrades through.
 *
 * Both matter more than they look. An unclamped divider can be dragged to zero
 * DURING AN EXAM, leaving a candidate who can no longer see the question or no
 * longer reach the editor, with a clock running. And a preference read that
 * throws would take the render of a question down with it, on browsers that
 * restrict storage — which a kiosk browser is entitled to do.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_LEFT_PCT,
  MAX_PCT,
  MIN_PCT,
  clampSplit,
  readStoredPct,
} from './SplitPane';

afterEach(() => {
  vi.unstubAllGlobals();
  try { window.localStorage.clear(); } catch { /* nothing to clear */ }
});

describe('clampSplit', () => {
  it('leaves a sensible split alone', () => {
    expect(clampSplit(50)).toBe(50);
    expect(clampSplit(MIN_PCT)).toBe(MIN_PCT);
    expect(clampSplit(MAX_PCT)).toBe(MAX_PCT);
  });

  it('never lets either pane collapse', () => {
    // A drag past the edge of the window, or a fast flick, both land here.
    expect(clampSplit(0)).toBe(MIN_PCT);
    expect(clampSplit(-40)).toBe(MIN_PCT);
    expect(clampSplit(100)).toBe(MAX_PCT);
    expect(clampSplit(9999)).toBe(MAX_PCT);
  });

  it('falls back rather than propagating a bad number', () => {
    // getBoundingClientRect on a detached node gives width 0, and the division
    // that follows produces these.
    expect(clampSplit(NaN)).toBe(DEFAULT_LEFT_PCT);
    expect(clampSplit(Infinity)).toBe(DEFAULT_LEFT_PCT);
  });
});

describe('readStoredPct', () => {
  it('returns the fallback when nothing is remembered', () => {
    expect(readStoredPct(undefined)).toBe(DEFAULT_LEFT_PCT);
    expect(readStoredPct('ef.split.absent', 40)).toBe(40);
  });

  it('reads a remembered split back', () => {
    window.localStorage.setItem('ef.split.code', '61');
    expect(readStoredPct('ef.split.code')).toBe(61);
  });

  it('clamps what it reads', () => {
    // Storage is editable by anyone with devtools, and a stored 0 would
    // reproduce the collapsed-pane failure on every subsequent question.
    window.localStorage.setItem('ef.split.code', '0');
    expect(readStoredPct('ef.split.code')).toBe(MIN_PCT);
    window.localStorage.setItem('ef.split.code', '100');
    expect(readStoredPct('ef.split.code')).toBe(MAX_PCT);
  });

  it('ignores a value that is not a number', () => {
    window.localStorage.setItem('ef.split.code', 'half');
    expect(readStoredPct('ef.split.code')).toBe(DEFAULT_LEFT_PCT);
  });

  it('survives storage that throws', () => {
    // Safari private mode, and any kiosk browser that has switched it off. A
    // layout preference must never be able to fail a question's render.
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('SecurityError'); },
    });
    expect(() => readStoredPct('ef.split.code')).not.toThrow();
    expect(readStoredPct('ef.split.code')).toBe(DEFAULT_LEFT_PCT);
  });
});
