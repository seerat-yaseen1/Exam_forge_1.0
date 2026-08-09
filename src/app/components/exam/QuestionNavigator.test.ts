/**
 * What counts as an answered question in the navigator.
 *
 * The coding branch is the reason this file exists. Coding questions ship
 * starter code, so the "value is non-empty" rule every other engine uses would
 * mark a coding question answered the instant it rendered — a full grid and
 * "all questions answered" on a paper nobody had touched.
 */

import { describe, it, expect } from 'vitest';
import { isAnswered } from './QuestionNavigator';
import { answerTypeForEngine } from '../../../lib/itemTypes';
import type { QuestionEngine } from '../../../lib/questionBankService';
import type { AttemptAnswer } from '../../../lib/submissionService';

const ans = (a: Partial<AttemptAnswer>): Record<string, AttemptAnswer> => ({
  q1: { type: 'mcq', value: '', answeredAt: '2026-08-08T00:00:00.000Z', sectionId: 'SA', ...a } as AttemptAnswer,
});

describe('isAnswered', () => {
  it('is false when there is no answer at all', () => {
    expect(isAnswered('q1', {})).toBe(false);
  });

  describe('mcq', () => {
    it('counts a selection, single or multi', () => {
      expect(isAnswered('q1', ans({ type: 'mcq', value: 'alpha' }))).toBe(true);
      expect(isAnswered('q1', ans({ type: 'mcq', value: ['alpha'] }))).toBe(true);
    });
    it('does not count an empty selection', () => {
      expect(isAnswered('q1', ans({ type: 'mcq', value: '' }))).toBe(false);
      expect(isAnswered('q1', ans({ type: 'mcq', value: [] }))).toBe(false);
    });
  });

  describe('text', () => {
    it('does not count whitespace as an essay', () => {
      expect(isAnswered('q1', ans({ type: 'text', value: '   \n\t ' }))).toBe(false);
      expect(isAnswered('q1', ans({ type: 'text', value: 'An answer.' }))).toBe(true);
    });
  });

  describe('match', () => {
    it('counts any pairing', () => {
      expect(isAnswered('q1', ans({ type: 'match', value: {} }))).toBe(false);
      expect(isAnswered('q1', ans({ type: 'match', value: { a: 'b' } }))).toBe(true);
    });
  });

  describe('code', () => {
    it('counts source the candidate actually wrote', () => {
      expect(isAnswered('q1', ans({ type: 'code', value: { language: 'python3', source: 'print(1)' } }))).toBe(true);
    });

    it('does NOT count an emptied editor', () => {
      // A candidate who selects all and deletes has emptied their answer.
      // Whitespace is not an attempt either.
      expect(isAnswered('q1', ans({ type: 'code', value: { language: 'python3', source: '' } }))).toBe(false);
      expect(isAnswered('q1', ans({ type: 'code', value: { language: 'python3', source: '  \n ' } }))).toBe(false);
    });

    it('does not crash on a malformed value', () => {
      // The stored shape is Record<string,string>, but the navigator renders
      // whatever is on the attempt and must not throw on a legacy or partial
      // write — a navigator that crashes takes the whole exam UI with it.
      expect(isAnswered('q1', ans({ type: 'code', value: 'not an object' }))).toBe(false);
      expect(isAnswered('q1', ans({ type: 'code', value: ['nope'] }))).toBe(false);
      expect(isAnswered('q1', ans({ type: 'code', value: {} }))).toBe(false);
    });

    // ── The regression ────────────────────────────────────────────
    //
    // Everything above passed while the bug was live, because every case
    // builds `type: 'code'` by hand and the writer never produced one.
    // ExamShell derived the discriminant from a ternary with no coding arm,
    // so real coding answers arrived typed 'match', took the match branch,
    // and counted two object keys as an answer. Both halves were correct and
    // the wire between them was not.
    //
    // These two cases are the wire.

    it('is reached at all — the writer types a coding answer as code', () => {
      // If this ever fails, every assertion above is testing a branch that
      // production does not enter.
      expect(answerTypeForEngine('code')).toBe('code');
    });

    it('every engine round-trips to its own discriminant', () => {
      const engines: QuestionEngine[] = ['mcq', 'text', 'match', 'code'];
      for (const e of engines) expect(answerTypeForEngine(e)).toBe(e);
    });

    it('reads a legacy answer stored before the fix, typed as match', () => {
      // Attempts sat before answerTypeForEngine — and any that were in flight
      // when it deployed — carry a code value under type 'match'. Detection is
      // by shape so those read identically, with no migration.
      const legacyEmpty = ans({ type: 'match', value: { language: 'python3', source: '' } });
      const legacyWritten = ans({ type: 'match', value: { language: 'python3', source: 'print(1)' } });
      expect(isAnswered('q1', legacyEmpty)).toBe(false);
      expect(isAnswered('q1', legacyWritten)).toBe(true);
    });

    it('does not mistake a genuine match answer for code', () => {
      // The shape test demands BOTH language and source as strings. A match
      // value is Record<leftId, rightId>, so it cannot satisfy that by
      // accident — and one that half-matched must still read as match.
      expect(isAnswered('q1', ans({ type: 'match', value: { language: 'x' } }))).toBe(true);
      expect(isAnswered('q1', ans({ type: 'match', value: { source: 'x' } }))).toBe(true);
      expect(isAnswered('q1', ans({ type: 'match', value: { left1: 'right1' } }))).toBe(true);
    });
  });
});
