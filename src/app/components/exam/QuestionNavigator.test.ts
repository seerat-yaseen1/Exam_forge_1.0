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
  });
});
