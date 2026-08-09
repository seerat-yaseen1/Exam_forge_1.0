/**
 * The rules that decide whether a coding question is answerable and gradable.
 *
 * Each of these, broken, produces a question that looks fine in the bank and
 * fails somewhere nobody can fix it — mid-exam, or at marking, in front of a
 * candidate who did nothing wrong. That is why they are errors at authoring
 * rather than something the server discovers later.
 */

import { describe, it, expect } from 'vitest';
import {
  defaultWeight,
  hasBlockingIssue,
  newTest,
  totalWeight,
  validateCodeQuestion,
} from './codeAuthoring';
import { itemTypeIdForQuestion, itemTypeStatus } from './itemTypes';
import type { CodeTest } from './questionBankService';

const test = (o: Partial<CodeTest> = {}): CodeTest => ({
  id: `t${Math.random()}`, stdin: '', expected: '42', visible: false, ...o,
});
const errors = (issues: ReturnType<typeof validateCodeQuestion>) =>
  issues.filter((i) => i.severity === 'error');
const warnings = (issues: ReturnType<typeof validateCodeQuestion>) =>
  issues.filter((i) => i.severity === 'warning');

describe('defaultWeight', () => {
  it('makes visible tests worth nothing unless the author says otherwise', () => {
    // A candidate can read a visible test's expected output, so marks attached
    // to it are available to a program that hardcodes rather than solves.
    expect(defaultWeight(test({ visible: true }))).toBe(0);
    expect(defaultWeight(test({ visible: false }))).toBe(1);
    expect(defaultWeight(test({ visible: true, weight: 2 }))).toBe(2);
    expect(defaultWeight(test({ visible: false, weight: 0 }))).toBe(0);
  });
});

describe('validateCodeQuestion', () => {
  it('accepts an ordinary question with no complaints', () => {
    const issues = validateCodeQuestion(
      { languages: ['python3'], starterCode: { python3: 'def solve():\n    pass\n' } },
      [test({ visible: true }), test({ visible: false })],
    );
    expect(errors(issues)).toEqual([]);
    expect(warnings(issues)).toEqual([]);
  });

  describe('gradability — the rule that matters most', () => {
    it('blocks a suite that carries no weight', () => {
      // Visible tests default to 0, so an author who adds only samples has
      // built a question the server cannot mark. It would reach the judge,
      // settle, and land in manual review after the exam.
      const issues = validateCodeQuestion(undefined, [
        test({ visible: true }), test({ visible: true }),
      ]);
      expect(hasBlockingIssue(issues)).toBe(true);
      expect(errors(issues).some((i) => i.message.includes('cannot be marked'))).toBe(true);
    });

    it('is satisfied by one hidden test, or by a weighted visible one', () => {
      expect(hasBlockingIssue(validateCodeQuestion(undefined, [test({ visible: false })]))).toBe(false);
      expect(hasBlockingIssue(validateCodeQuestion(undefined, [test({ visible: true, weight: 1 })]))).toBe(false);
    });

    it('blocks a question with no tests at all', () => {
      const issues = validateCodeQuestion(undefined, []);
      expect(hasBlockingIssue(issues)).toBe(true);
      expect(issues).toHaveLength(1);   // no point piling on once there is nothing to check
    });
  });

  describe('test integrity', () => {
    it('blocks duplicate ids', () => {
      // Verdicts are keyed by test id. Two tests sharing one means a result
      // silently overwrites another and the mark comes from fewer tests than ran.
      const issues = validateCodeQuestion(undefined, [
        test({ id: 'same' }), test({ id: 'same' }),
      ]);
      expect(errors(issues).some((i) => i.message.includes('share an id'))).toBe(true);
    });

    it('rejects a negative or non-numeric weight and tolerance', () => {
      expect(errors(validateCodeQuestion(undefined, [test({ weight: -1 })])).length).toBeGreaterThan(0);
      expect(errors(validateCodeQuestion(undefined, [
        test({ comparison: 'numeric', tolerance: -0.1 }),
      ])).length).toBeGreaterThan(0);
      expect(errors(validateCodeQuestion(undefined, [
        test({ comparison: 'numeric', tolerance: NaN }),
      ])).length).toBeGreaterThan(0);
    });

    it('warns, but does not block, on empty expected output', () => {
      const issues = validateCodeQuestion(undefined, [test({ expected: '   ' })]);
      expect(warnings(issues).some((i) => i.message.includes('prints nothing'))).toBe(true);
      // A question whose correct answer really is "print nothing" is legitimate.
      expect(errors(issues).some((i) => i.testIndex === 0)).toBe(false);
    });

    it('points at the offending row', () => {
      const issues = validateCodeQuestion(undefined, [
        test(), test({ weight: -5 }),
      ]);
      expect(errors(issues)[0].testIndex).toBe(1);
    });
  });

  describe('visibility warnings', () => {
    it('warns when candidates cannot run anything', () => {
      const issues = validateCodeQuestion(undefined, [test({ visible: false })]);
      expect(warnings(issues).some((i) => i.message.includes('cannot run their code'))).toBe(true);
      expect(hasBlockingIssue(issues)).toBe(false);   // their call to make
    });

    it('warns when every test is readable, because hardcoding then scores full marks', () => {
      const issues = validateCodeQuestion(undefined, [test({ visible: true, weight: 1 })]);
      expect(warnings(issues).some((i) => i.message.includes('hardcodes'))).toBe(true);
    });
  });

  describe('languages', () => {
    it('blocks a language the judge cannot run', () => {
      const issues = validateCodeQuestion({ languages: ['python3', 'cobol'] }, [test()]);
      expect(errors(issues).some((i) => i.message.includes('cobol'))).toBe(true);
    });

    it('blocks a selection where NOTHING is runnable, naming the consequence', () => {
      // The delivery side falls back to offering every language, which is not
      // what this author asked for and would otherwise be discovered in an exam.
      const issues = validateCodeQuestion({ languages: ['cobol'] }, [test()]);
      expect(errors(issues).some((i) => i.message.includes('every language'))).toBe(true);
    });

    it('treats no restriction as "any language", not as an error', () => {
      expect(errors(validateCodeQuestion({}, [test()]))).toEqual([]);
      expect(errors(validateCodeQuestion(undefined, [test()]))).toEqual([]);
    });
  });

  describe('starter code', () => {
    it('warns about starter code for a language that is not offered', () => {
      const issues = validateCodeQuestion(
        { languages: ['python3'], starterCode: { java: 'class Main {}' } },
        [test()],
      );
      expect(warnings(issues).some((i) => i.message.includes('never be shown'))).toBe(true);
    });

    it('says nothing when a language has no starter — it gets the platform template', () => {
      // This used to warn "candidates get an empty editor for those", which is
      // no longer true: starterFor falls back to the template library. Warning
      // about it would send an author off to write boilerplate the platform
      // already ships.
      const issues = validateCodeQuestion(
        { languages: ['python3', 'java'], starterCode: { python3: 'pass' } },
        [test()],
      );
      expect(warnings(issues).some((i) => i.field === 'starterCode')).toBe(false);
    });

    it('warns about a starter the author deliberately blanked', () => {
      // Absent and empty are different. An author who cleared the field gets a
      // blank editor and should know that is what they asked for, because it
      // is one keystroke away from the case above.
      const issues = validateCodeQuestion(
        { languages: ['python3'], starterCode: { python3: '   ' } },
        [test()],
      );
      expect(warnings(issues).some((i) => i.message.includes('blank'))).toBe(true);
    });

    it('says nothing when no language has starter code — that is a valid choice', () => {
      const issues = validateCodeQuestion({ languages: ['python3', 'java'] }, [test()]);
      expect(warnings(issues).some((i) => i.field === 'starterCode')).toBe(false);
    });
  });
});

describe('newTest', () => {
  it('produces distinct ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTest(false).id));
    expect(ids.size).toBe(50);
  });

  it('defaults to the forgiving comparison', () => {
    // Exact matching fails a correct program over a trailing newline, which
    // teaches candidates to distrust the judge rather than fix their logic.
    expect(newTest(true).comparison).toBe('trimmed');
  });
});

describe('totalWeight', () => {
  it('sums the effective weights, not the stated ones', () => {
    expect(totalWeight([
      test({ visible: true }),              // 0
      test({ visible: false }),             // 1
      test({ visible: false, weight: 3 }),  // 3
    ])).toBe(4);
  });
});

// ══════════════════════════════════════════════════════════════════
// The registry binding — authoring is what makes these types real
// ══════════════════════════════════════════════════════════════════

describe('coding item types are live', () => {
  it('resolves each code variant to its taxonomy entry', () => {
    expect(itemTypeIdForQuestion('code', 'challenge')).toBe('coding-challenge');
    expect(itemTypeIdForQuestion('code', 'sql')).toBe('sql-challenge');
    expect(itemTypeIdForQuestion('code', 'debug')).toBe('debugging');
  });

  it('reports them as live, which is derived from the binding and not settable', () => {
    expect(itemTypeStatus('coding-challenge')).toBe('live');
    expect(itemTypeStatus('sql-challenge')).toBe('live');
    expect(itemTypeStatus('debugging')).toBe('live');
  });

  it('still refuses an unknown code variant rather than guessing', () => {
    expect(itemTypeIdForQuestion('code', null)).toBeNull();
    expect(itemTypeIdForQuestion('code', 'nonsense' as never)).toBeNull();
  });
});
