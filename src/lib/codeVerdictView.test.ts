/**
 * How a coding answer reads after the exam.
 *
 * The two defects this covers were both a MISSING BRANCH rather than a wrong
 * one, which is why neither surface complained: the roster read an unjudged
 * coding answer as "unattempted", and the student's page ran out of engine
 * cases and returned false, painting a red ✗ on an answer no judge had seen.
 *
 * So the cases that matter most here are the ones with NO MARK YET. They are
 * the normal state of a coding answer for the first few minutes after
 * submission, not an edge case.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_JUDGE_ATTEMPTS,
  codeAnswerState,
  codeStateIsPending,
  codeSubmissionOf,
  judgeExhausted,
  summariseVerdict,
  type JudgeVerdict,
} from './codeVerdictView';
import type { AttemptAnswer, GradedAnswer } from './submissionService';

const answer = (a: Partial<AttemptAnswer>): AttemptAnswer => ({
  type: 'code',
  value: { language: 'python3', source: 'print(1)' },
  answeredAt: '2026-08-09T00:00:00.000Z',
  sectionId: 'SA',
  ...a,
} as AttemptAnswer);

const graded = (g: Partial<GradedAnswer>): GradedAnswer => ({
  isCorrect: null, marksAwarded: 0, ...g,
});

describe('codeSubmissionOf', () => {
  it('returns the program the candidate wrote', () => {
    expect(codeSubmissionOf(answer({}))).toEqual({ language: 'python3', source: 'print(1)' });
  });

  it('is null when there is no answer document', () => {
    expect(codeSubmissionOf(undefined)).toBeNull();
  });

  it('treats an emptied editor as no submission', () => {
    // The editor writes { language, source: '' } for an untouched starter or
    // a cleared buffer, and the server reads that as a blank. A reviewer has
    // to see the same thing or the two disagree about whether it was answered.
    expect(codeSubmissionOf(answer({ value: { language: 'python3', source: '' } }))).toBeNull();
    expect(codeSubmissionOf(answer({ value: { language: 'python3', source: '  \n\t ' } }))).toBeNull();
  });

  it('does not throw on a malformed value', () => {
    expect(codeSubmissionOf(answer({ value: 'not an object' }))).toBeNull();
    expect(codeSubmissionOf(answer({ value: ['nope'] }))).toBeNull();
    expect(codeSubmissionOf(answer({ value: {} }))).toBeNull();
  });

  it('reads a legacy answer stored before answerTypeForEngine', () => {
    // Those carry type 'match' over a code value, and they are on finished
    // papers staff review today. Detection is by shape so they render the same.
    const legacy = answer({ type: 'match', value: { language: 'java', source: 'class A {}' } });
    expect(codeSubmissionOf(legacy)).toEqual({ language: 'java', source: 'class A {}' });
  });

  it('does not mistake a real match answer for a program', () => {
    // A match value is Record<leftId, rightId>. Without a `language` it is not
    // a submission, whatever else it happens to contain.
    expect(codeSubmissionOf(answer({ type: 'match', value: { source: 'x' } }))).toBeNull();
    expect(codeSubmissionOf(answer({ type: 'match', value: { left1: 'right1' } }))).toBeNull();
  });
});

describe('codeAnswerState', () => {
  it('is not_attempted when no program was submitted', () => {
    expect(codeAnswerState({ answer: undefined, graded: undefined, judgePending: true }))
      .toBe('not_attempted');
    expect(codeAnswerState({
      answer: answer({ value: { language: 'python3', source: '' } }),
      graded: undefined, judgePending: true,
    })).toBe('not_attempted');
  });

  it('is judged once the server wrote a boolean — either way', () => {
    expect(codeAnswerState({ answer: answer({}), graded: graded({ isCorrect: true, marksAwarded: 5 }), judgePending: false }))
      .toBe('judged');
    // A judged FAILURE is a real verdict about the code, not a pending state.
    expect(codeAnswerState({ answer: answer({}), graded: graded({ isCorrect: false, marksAwarded: 0 }), judgePending: false }))
      .toBe('judged');
  });

  it('is awaiting_judge while the paper still owes the runner', () => {
    // THE CASE BOTH SURFACES GOT WRONG. No mark, but the sweep has not run.
    expect(codeAnswerState({ answer: answer({}), graded: graded({}), judgePending: true }))
      .toBe('awaiting_judge');
  });

  it('is needs_review once judging finished without a mark', () => {
    // codeJudgePending is deleted by the sweep when the paper settles, so its
    // absence beside an unscored answer means judging gave up.
    expect(codeAnswerState({ answer: answer({}), graded: graded({}), judgePending: false }))
      .toBe('needs_review');
  });

  it('treats a missing pending flag as needs_review, not as pending', () => {
    // Attempts predating the field. "A human should look" is the honest
    // answer for a paper nobody can prove is still queued.
    expect(codeAnswerState({ answer: answer({}), graded: graded({}), judgePending: undefined }))
      .toBe('needs_review');
  });

  it('is invalidated when the question was withdrawn', () => {
    // isCorrect null WITH marks is the invalidation path — full marks to the
    // cohort, no judge consulted. It must not read as pending forever.
    expect(codeAnswerState({
      answer: answer({}), graded: graded({ isCorrect: null, marksAwarded: 5 }), judgePending: true,
    })).toBe('invalidated');
  });

  it('only awaiting_judge is provisional', () => {
    expect(codeStateIsPending('awaiting_judge')).toBe(true);
    expect(codeStateIsPending('needs_review')).toBe(false);
    expect(codeStateIsPending('judged')).toBe(false);
    expect(codeStateIsPending('not_attempted')).toBe(false);
    expect(codeStateIsPending('invalidated')).toBe(false);
  });
});

describe('judgeExhausted', () => {
  it('is false before the budget runs out', () => {
    expect(judgeExhausted(undefined)).toBe(false);
    expect(judgeExhausted({ attempts: 4, lastStatus: 'judge_unavailable' })).toBe(false);
  });

  it('is true once the platform has given up', () => {
    expect(judgeExhausted({ attempts: MAX_JUDGE_ATTEMPTS, lastStatus: 'judge_unavailable' })).toBe(true);
  });

  it('is never true for a submission that was actually judged', () => {
    // A real verdict is final, however many attempts it took to get one — and
    // a compile error IS a real verdict.
    expect(judgeExhausted({ attempts: 9, lastStatus: 'completed' })).toBe(false);
    expect(judgeExhausted({ attempts: 9, lastStatus: 'compile_error' })).toBe(false);
  });
});

describe('summariseVerdict', () => {
  const verdict = (results: JudgeVerdict['results']): JudgeVerdict => ({
    status: 'completed', results, adapter: 'judge0', judgedAt: '2026-08-09T00:00:00.000Z',
  });

  it('counts what the runner reported', () => {
    expect(summariseVerdict(verdict([
      { testId: 't1', status: 'passed' },
      { testId: 't2', status: 'wrong_answer' },
      { testId: 't3', status: 'passed' },
    ]))).toEqual({ passed: 2, total: 3 });
  });

  it('is zeroed when there is no verdict', () => {
    expect(summariseVerdict(undefined)).toEqual({ passed: 0, total: 0 });
  });
});
