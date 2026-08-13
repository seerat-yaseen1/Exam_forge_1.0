/**
 * The two pure helpers behind the marking UI.
 *
 * `clampAward` guards what a grader can type into a marks box, and
 * `awaitsManualMark` is the single definition of "this answer is outstanding"
 * — used by the per-answer badge, the roster's queue count and the roster
 * filter, which must not be able to disagree about what they are counting.
 *
 * The server holds the authoritative versions of both rules. These exist so
 * the UI can refuse an impossible value without a round trip, and the tests
 * exist because a client-side copy of a rule is exactly the kind of thing that
 * drifts from the original quietly.
 */

import { describe, it, expect } from 'vitest';
import { awaitsManualMark, clampAward } from './manualGradingService';

describe('clampAward', () => {
  it('returns null for a box the grader has not filled in', () => {
    // Distinct from zero, and the distinction matters: an empty box is "no
    // decision", a zero is a decision to award nothing.
    expect(clampAward('', 50)).toBeNull();
    expect(clampAward('   ', 50)).toBeNull();
  });

  it('returns null for input that is not a number', () => {
    expect(clampAward('good effort', 50)).toBeNull();
    expect(clampAward('12abc', 50)).toBeNull();
  });

  it('keeps a valid award as typed', () => {
    expect(clampAward('35', 50)).toBe(35);
    expect(clampAward('0', 50)).toBe(0);
    expect(clampAward('50', 50)).toBe(50);
  });

  it('clamps to the marks the question is worth', () => {
    expect(clampAward('9999', 50)).toBe(50);
    expect(clampAward('50.1', 50)).toBe(50);
  });

  it('floors at zero rather than inventing a penalty', () => {
    // Negative marking is a policy the scorer applies to a wrong answer it
    // recognised. "A person thought this essay was bad" is not that.
    expect(clampAward('-10', 50)).toBe(0);
  });

  it('rounds to two decimals so a total stays comparable to a passing score', () => {
    expect(clampAward('7.3333333', 50)).toBe(7.33);
    expect(clampAward('7.999', 50)).toBe(8);
  });

  it('survives a zero-mark question without going negative', () => {
    expect(clampAward('5', 0)).toBe(0);
  });
});

describe('awaitsManualMark', () => {
  const unmarked = { isCorrect: null, marksAwarded: 0 };
  const marked   = { isCorrect: false, marksAwarded: 12 };

  it('flags an unmarked text answer', () => {
    expect(awaitsManualMark('text', unmarked, false)).toBe(true);
    expect(awaitsManualMark('text', undefined, false)).toBe(true);
  });

  it('clears once a human has marked it', () => {
    expect(awaitsManualMark('text', marked, false)).toBe(false);
    // A deliberate zero is a mark, not an absence.
    expect(awaitsManualMark('text', { isCorrect: false, marksAwarded: 0 }, false)).toBe(false);
  });

  it('never flags a machine-marked engine', () => {
    expect(awaitsManualMark('mcq', unmarked, false)).toBe(false);
    expect(awaitsManualMark('match', unmarked, false)).toBe(false);
    expect(awaitsManualMark(undefined, unmarked, false)).toBe(false);
  });

  it('does not queue a coding answer the judge is still working on', () => {
    // It resolves itself. Putting it in a person's queue would have them
    // marking answers the runner is about to mark for them.
    expect(awaitsManualMark('code', unmarked, true)).toBe(false);
  });

  it('does queue a coding answer once the judge has stopped', () => {
    expect(awaitsManualMark('code', unmarked, false)).toBe(true);
  });

  it('clears a coding answer that has a verdict', () => {
    expect(awaitsManualMark('code', { isCorrect: true, marksAwarded: 50 }, false)).toBe(false);
  });
});
