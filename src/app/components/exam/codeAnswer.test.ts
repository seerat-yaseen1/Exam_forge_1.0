/**
 * The decisions a coding answer turns on.
 *
 * The starter-code case is the one this file exists for: it is a bug that
 * reports success — a full navigator grid and "all questions answered" on a
 * paper nobody has touched — so it produces no error anywhere to notice.
 */

import { describe, it, expect } from 'vitest';
import {
  answerFrom,
  bufferForLanguage,
  initialLanguage,
  isUnmodifiedStarter,
  resolveLanguages,
  runSummary,
  starterFor,
} from './codeAnswer';
import { JUDGE_LANGUAGES } from './judgeTypes';

const spec = {
  languages: ['python3', 'java'],
  starterCode: {
    python3: 'def solve():\n    pass\n',
    java: 'class Main {}\n',
  },
};

describe('isUnmodifiedStarter', () => {
  it('treats the untouched starter as no answer', () => {
    expect(isUnmodifiedStarter(spec.starterCode.python3, spec.starterCode.python3)).toBe(true);
  });

  it('ignores whitespace and line endings, which are not work', () => {
    expect(isUnmodifiedStarter('def solve():\r\n    pass\r\n', spec.starterCode.python3)).toBe(true);
    expect(isUnmodifiedStarter(`\n\n${spec.starterCode.python3}\n  `, spec.starterCode.python3)).toBe(true);
  });

  it('treats an empty editor as no answer, whatever the starter was', () => {
    expect(isUnmodifiedStarter('', spec.starterCode.python3)).toBe(true);
    expect(isUnmodifiedStarter('   \n\t', '')).toBe(true);
  });

  it('recognises actual work', () => {
    expect(isUnmodifiedStarter('def solve():\n    return 42\n', spec.starterCode.python3)).toBe(false);
  });
});

describe('answerFrom', () => {
  it('returns null for an untouched question, so it stores no answer at all', () => {
    expect(answerFrom('python3', spec.starterCode.python3, spec)).toBeNull();
    expect(answerFrom('python3', '', spec)).toBeNull();
  });

  it('stores the RAW buffer once there is work, not the normalised one', () => {
    // Normalisation decides whether this counts as an answer. It must never
    // edit the submission — these exact bytes are what the judge is given, and
    // trailing whitespace can be the difference between passing and failing.
    const source = 'def solve():\n    return 42   \n\n';
    expect(answerFrom('python3', source, spec)).toEqual({ language: 'python3', source });
  });

  it('is an answer when a question ships no starter and the candidate types', () => {
    expect(answerFrom('python3', 'print(1)', undefined)).toEqual({
      language: 'python3', source: 'print(1)',
    });
    expect(answerFrom('python3', '   ', undefined)).toBeNull();
  });
});

describe('resolveLanguages', () => {
  it('honours the author\'s restriction', () => {
    expect(resolveLanguages(spec, JUDGE_LANGUAGES)).toEqual(['python3', 'java']);
  });

  it('reads "none listed" as "any", not as "no languages"', () => {
    expect(resolveLanguages({}, JUDGE_LANGUAGES)).toEqual([...JUDGE_LANGUAGES]);
    expect(resolveLanguages(undefined, JUDGE_LANGUAGES)).toEqual([...JUDGE_LANGUAGES]);
    expect(resolveLanguages({ languages: [] }, JUDGE_LANGUAGES)).toEqual([...JUDGE_LANGUAGES]);
  });

  it('drops languages the platform cannot run', () => {
    expect(resolveLanguages({ languages: ['python3', 'cobol'] }, JUDGE_LANGUAGES)).toEqual(['python3']);
  });

  it('keeps the question answerable when an author restricts it to nothing runnable', () => {
    // An empty selector is a dead question, and discovering that mid-exam is
    // not the candidate's problem to have.
    expect(resolveLanguages({ languages: ['cobol'] }, JUDGE_LANGUAGES)).toEqual([...JUDGE_LANGUAGES]);
  });
});

describe('initialLanguage', () => {
  it('opens in the first allowed language', () => {
    expect(initialLanguage(spec, null, JUDGE_LANGUAGES)).toBe('python3');
  });

  it('honours a choice the candidate already made', () => {
    expect(initialLanguage(spec, { language: 'java', source: 'x' }, JUDGE_LANGUAGES)).toBe('java');
  });

  it('keeps a stale choice rather than silently moving their code', () => {
    // The author narrowed the list after this candidate started. The paper they
    // sat is the paper they sat; reopening their Go answer as Python would be
    // worse than honouring a choice that is no longer offered.
    expect(initialLanguage(spec, { language: 'go', source: 'package main' }, JUDGE_LANGUAGES)).toBe('go');
  });
});

describe('bufferForLanguage', () => {
  it('restores a draft rather than destroying it', () => {
    // Switching language is exploratory. An editor that answers "what would
    // this look like in Java?" by deleting your Python teaches you not to ask.
    const drafts = { python3: 'def solve():\n    return 1\n' };
    expect(bufferForLanguage('python3', drafts, spec)).toBe(drafts.python3);
  });

  it('falls back to the starter for a language not yet touched', () => {
    expect(bufferForLanguage('java', {}, spec)).toBe(spec.starterCode.java);
  });

  it('is empty when there is neither a draft nor a starter', () => {
    expect(bufferForLanguage('rust', {}, spec)).toBe('');
  });
});

describe('starterFor', () => {
  it('is empty when the question ships none', () => {
    expect(starterFor(undefined, 'python3')).toBe('');
    expect(starterFor({ starterCode: {} }, 'python3')).toBe('');
  });
});

describe('runSummary', () => {
  it('says what passed, and what is still waiting', () => {
    expect(runSummary([{ status: 'passed' }, { status: 'wrong_answer' }], 8))
      .toBe('1 of 2 sample tests passed · 8 hidden tests will run at marking');
  });

  it('mentions hidden tests even when every sample passed', () => {
    // This is the sentence that stops a green run from reading as a finished
    // answer, so it is most needed exactly when everything looks fine.
    expect(runSummary([{ status: 'passed' }], 3))
      .toBe('1 of 1 sample test passed · 3 hidden tests will run at marking');
  });

  it('says nothing about hidden tests when there are none', () => {
    expect(runSummary([{ status: 'passed' }], 0)).toBe('1 of 1 sample test passed');
  });
});
