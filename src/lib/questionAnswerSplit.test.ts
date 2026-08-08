/**
 * The security boundary of the question bank.
 *
 * These assertions are the reason the split has its own module. A regression
 * here does not throw, does not fail a build, and does not look wrong on
 * screen — it just puts the answer key in the document students are allowed to
 * read, and the first sign of it is a cohort with suspiciously good marks.
 */

import { describe, it, expect } from 'vitest';
import {
  ANSWER_KEYS,
  emptyAnswerDefaults,
  pickAnswerFields,
  sanitizePublic,
  stripAnswerFields,
} from './questionAnswerSplit';
import type { CodeTest, Question } from './questionBankService';

const hiddenSuite: CodeTest[] = [
  { id: 'h1', stdin: '2', expected: 'SECRET-A', visible: false },
  { id: 'h2', stdin: '3', expected: 'SECRET-B', visible: false },
];

const draft = (over: Partial<Question> = {}) => ({
  id: 'q1',
  engine: 'code' as const,
  variant: 'challenge' as const,
  stem: 'Write a function',
  options: [],
  correctIds: ['alpha'],
  modelAnswer: 'a model answer',
  pairs: [],
  correctPairs: [{ leftId: 'l1', rightId: 'r1' }],
  tests: hiddenSuite,
  ...over,
}) as unknown as Question;

describe('ANSWER_KEYS', () => {
  it('covers every field that is an answer', () => {
    // If a new answer-bearing field is added to Question and not added here,
    // it ships to students. This list is the whole enforcement.
    expect([...ANSWER_KEYS].sort()).toEqual(
      ['correctIds', 'correctPairs', 'modelAnswer', 'tests'].sort(),
    );
  });

  it('includes tests — the coding answer key', () => {
    expect(ANSWER_KEYS).toContain('tests');
  });
});

describe('sanitizePublic', () => {
  it('strips the hidden test suite from the public document', () => {
    const publicDoc = sanitizePublic(draft());
    expect(publicDoc.tests).toEqual([]);
    expect(JSON.stringify(publicDoc)).not.toContain('SECRET');
  });

  it('strips every other answer field too', () => {
    const publicDoc = sanitizePublic(draft());
    expect(publicDoc.correctIds).toEqual([]);
    expect(publicDoc.correctPairs).toEqual([]);
    expect(publicDoc.modelAnswer).toBe('');
  });

  it('keeps everything a candidate legitimately needs', () => {
    const publicDoc = sanitizePublic(draft({
      codeSpec: { languages: ['python3'], starterCode: { python3: 'def solve(): pass' } },
    }));
    expect(publicDoc.stem).toBe('Write a function');
    // codeSpec is NOT an answer: the candidate is shown the languages, needs
    // the starter buffer, and needs to know the limits they run under.
    expect(publicDoc.codeSpec?.languages).toEqual(['python3']);
    expect(publicDoc.codeSpec?.starterCode?.python3).toBe('def solve(): pass');
  });

  it('neutralises a document that already carried answers inline', () => {
    // Pre-migration documents stored answers on the question itself. Wiping
    // rather than deleting is what makes this call safe on those too.
    const legacy = { id: 'old', stem: 'x', tests: hiddenSuite, correctIds: ['a'] } as unknown as Question;
    const publicDoc = sanitizePublic(legacy);
    expect(publicDoc.tests).toEqual([]);
    expect(publicDoc.correctIds).toEqual([]);
  });

  it('does not mutate its input — the caller still needs the answers to store them', () => {
    const original = draft();
    sanitizePublic(original);
    expect(original.tests).toHaveLength(2);
    expect(original.correctIds).toEqual(['alpha']);
  });
});

describe('pickAnswerFields', () => {
  it('extracts the suite for the sibling document', () => {
    expect(pickAnswerFields(draft()).tests).toEqual(hiddenSuite);
  });

  it('omits fields the draft did not set, rather than writing empties over them', () => {
    // An update that touches only the stem must not blank an existing answer.
    const partial = pickAnswerFields({ stem: 'edited' } as Partial<Question>);
    expect(partial).toEqual({});
    expect('tests' in partial).toBe(false);
  });

  it('carries an explicitly emptied suite through', () => {
    // Clearing every test IS a change the author made, distinct from not
    // mentioning tests at all.
    expect(pickAnswerFields({ tests: [] } as Partial<Question>)).toEqual({ tests: [] });
  });
});

describe('stripAnswerFields', () => {
  it('removes the keys entirely', () => {
    const stripped = stripAnswerFields(draft());
    for (const k of ANSWER_KEYS) expect(k in stripped).toBe(false);
    expect(stripped.stem).toBe('Write a function');
  });
});

describe('emptyAnswerDefaults', () => {
  it('returns a fresh object each call', () => {
    // Shared arrays across documents would let one question's write mutate
    // another's payload.
    const a = emptyAnswerDefaults();
    const b = emptyAnswerDefaults();
    expect(a.tests).not.toBe(b.tests);
    expect(a.correctIds).not.toBe(b.correctIds);
  });
});
