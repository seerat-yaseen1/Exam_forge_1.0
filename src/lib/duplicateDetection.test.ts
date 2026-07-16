import { describe, it, expect } from 'vitest';
import {
  normalize,
  shingles,
  jaccard,
  levenshteinSim,
  optionsSignature,
  optionsJaccard,
  answersMatch,
  scorePair,
  scoreAgainstPool,
  verdictFor,
  pct,
  WARN_THRESHOLD,
  NOTE_THRESHOLD,
  EXACT_THRESHOLD,
  type ScoreableQuestion,
} from './duplicateDetection';

describe('normalize', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalize('  Hello   World  ')).toBe('hello world');
  });

  it('strips punctuation', () => {
    expect(normalize('What is 2+2?!')).toBe('what is 2 2');
  });

  it('converts smart quotes to straight quotes', () => {
    expect(normalize('It’s a “test”')).toBe('it s a test');
  });
});

describe('shingles', () => {
  it('produces 3-word shingles by default', () => {
    const s = shingles('the quick brown fox jumps');
    expect(s.has('the quick brown')).toBe(true);
    expect(s.has('quick brown fox')).toBe(true);
    expect(s.has('brown fox jumps')).toBe(true);
    expect(s.size).toBe(3);
  });

  it('falls back to the whole (short) string when fewer than k words', () => {
    const s = shingles('hello world');
    expect(s.size).toBe(1);
    expect(s.has('hello world')).toBe(true);
  });
});

describe('jaccard', () => {
  it('returns 1 for two empty sets', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('returns 1 for identical sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  it('computes partial overlap correctly', () => {
    // intersection={b} size 1, union={a,b,c} size 3
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
  });
});

describe('levenshteinSim', () => {
  it('returns 1 for identical strings', () => {
    expect(levenshteinSim('abc', 'abc')).toBe(1);
  });

  it('returns 0 when either string is empty', () => {
    expect(levenshteinSim('', 'abc')).toBe(0);
    expect(levenshteinSim('abc', '')).toBe(0);
  });

  it('normalizes distance by the longer string length', () => {
    // 'abc' vs 'abd' -> 1 substitution, maxLen 3
    expect(levenshteinSim('abc', 'abd')).toBeCloseTo(2 / 3);
  });
});

describe('optionsSignature', () => {
  it('is order-insensitive', () => {
    expect(optionsSignature(['A', 'B', 'C'])).toBe(optionsSignature(['C', 'A', 'B']));
  });

  it('normalizes each option', () => {
    expect(optionsSignature(['Hello!'])).toBe(optionsSignature(['hello']));
  });

  it('handles undefined options', () => {
    expect(optionsSignature(undefined)).toBe('');
  });
});

describe('optionsJaccard', () => {
  it('returns 1 for identical option sets regardless of order', () => {
    expect(optionsJaccard(['A', 'B'], ['B', 'A'])).toBe(1);
  });

  it('returns 0 for disjoint option sets', () => {
    expect(optionsJaccard(['A', 'B'], ['C', 'D'])).toBe(0);
  });
});

describe('answersMatch', () => {
  it('matches identical string answers', () => {
    const a: ScoreableQuestion = { stem: 'q', correctAnswer: 'Paris' };
    const b: ScoreableQuestion = { stem: 'q', correctAnswer: 'paris' };
    expect(answersMatch(a, b)).toBe(true);
  });

  it('does not match different answers', () => {
    const a: ScoreableQuestion = { stem: 'q', correctAnswer: 'Paris' };
    const b: ScoreableQuestion = { stem: 'q', correctAnswer: 'London' };
    expect(answersMatch(a, b)).toBe(false);
  });

  it('matches array answers regardless of order', () => {
    const a: ScoreableQuestion = { stem: 'q', correctAnswer: ['A', 'B'] };
    const b: ScoreableQuestion = { stem: 'q', correctAnswer: ['B', 'A'] };
    expect(answersMatch(a, b)).toBe(true);
  });

  it('treats null/undefined answers as never matching', () => {
    const a: ScoreableQuestion = { stem: 'q', correctAnswer: null };
    const b: ScoreableQuestion = { stem: 'q', correctAnswer: null };
    expect(answersMatch(a, b)).toBe(false);
  });
});

describe('scorePair', () => {
  it('flags a confirmed duplicate for identical stem, options and answer', () => {
    const neu: ScoreableQuestion = {
      id: 'new', stem: 'What is the capital of France?',
      options: ['Paris', 'London', 'Berlin'], correctAnswer: 'Paris',
    };
    const existing: ScoreableQuestion = {
      id: 'old', stem: 'What is the capital of France?',
      options: ['Paris', 'London', 'Berlin'], correctAnswer: 'Paris',
    };
    const score = scorePair(neu, existing);
    expect(score.stemSim).toBe(1);
    expect(score.optionsSim).toBe(1);
    expect(score.answerMatch).toBe(true);
    expect(score.matchedReason).toBe('confirmed_duplicate');
    expect(score.matchedQuestionId).toBe('old');
  });

  it('flags same_stem_answer when options differ but stem+answer match', () => {
    const neu: ScoreableQuestion = {
      stem: 'What is the capital of France?', options: ['Paris', 'Rome'], correctAnswer: 'Paris',
    };
    const existing: ScoreableQuestion = {
      stem: 'What is the capital of France?', options: ['Paris', 'Madrid', 'Oslo'], correctAnswer: 'Paris',
    };
    expect(scorePair(neu, existing).matchedReason).toBe('same_stem_answer');
  });

  it('flags exact_stem when stem matches but answer differs', () => {
    const neu: ScoreableQuestion = { stem: 'Pick one', options: ['A'], correctAnswer: 'A' };
    const existing: ScoreableQuestion = { stem: 'Pick one', options: ['A'], correctAnswer: 'B' };
    expect(scorePair(neu, existing).matchedReason).toBe('exact_stem');
  });

  it('flags reordered_options for same option set + answer with a different stem', () => {
    const neu: ScoreableQuestion = {
      stem: 'Question A entirely different wording here',
      options: ['Alpha', 'Beta', 'Gamma'], correctAnswer: 'Alpha',
    };
    const existing: ScoreableQuestion = {
      stem: 'A totally unrelated prompt about something else',
      options: ['Gamma', 'Alpha', 'Beta'], correctAnswer: 'Alpha',
    };
    expect(scorePair(neu, existing).matchedReason).toBe('reordered_options');
  });

  it('returns none for unrelated questions', () => {
    const neu: ScoreableQuestion = { stem: 'How does photosynthesis work?', options: ['A'], correctAnswer: 'A' };
    const existing: ScoreableQuestion = { stem: 'What is the boiling point of water?', options: ['B'], correctAnswer: 'B' };
    expect(scorePair(neu, existing).matchedReason).toBe('none');
  });
});

describe('scoreAgainstPool', () => {
  const draft: ScoreableQuestion = {
    id: 'draft', stem: 'What is the capital of France?',
    options: ['Paris', 'London'], correctAnswer: 'Paris',
  };

  it('skips scoring against itself (same id)', () => {
    const pool: ScoreableQuestion[] = [
      { id: 'draft', stem: 'What is the capital of France?', options: ['Paris', 'London'], correctAnswer: 'Paris' },
    ];
    expect(scoreAgainstPool(draft, pool).matchedReason).toBe('none');
  });

  it('picks the highest-priority match across the pool', () => {
    const pool: ScoreableQuestion[] = [
      { id: '1', stem: 'Totally unrelated question', options: ['X'], correctAnswer: 'X' },
      { id: '2', stem: 'What is the capital of France?', options: ['Paris', 'London'], correctAnswer: 'Paris' },
    ];
    const best = scoreAgainstPool(draft, pool);
    expect(best.matchedQuestionId).toBe('2');
    expect(best.matchedReason).toBe('confirmed_duplicate');
  });

  it('returns a clean "none" result for an empty pool', () => {
    const best = scoreAgainstPool(draft, []);
    expect(best.matchedReason).toBe('none');
    expect(best.matchedQuestionId).toBeNull();
  });
});

describe('verdictFor', () => {
  it('blocks confirmed duplicates', () => {
    expect(verdictFor({
      stemSim: 1, optionsSim: 1, answerMatch: true,
      matchedQuestionId: 'x', matchedReason: 'confirmed_duplicate',
    })).toBe('block');
  });

  it('warns on same_stem_answer, exact_stem, and reordered_options', () => {
    const base = { stemSim: 1, optionsSim: 0, answerMatch: true, matchedQuestionId: 'x' as string | null };
    expect(verdictFor({ ...base, matchedReason: 'same_stem_answer' })).toBe('warn');
    expect(verdictFor({ ...base, matchedReason: 'exact_stem' })).toBe('warn');
    expect(verdictFor({ ...base, matchedReason: 'reordered_options' })).toBe('warn');
  });

  it('warns when top similarity is >= WARN_THRESHOLD', () => {
    expect(verdictFor({
      stemSim: WARN_THRESHOLD, optionsSim: 0, answerMatch: false,
      matchedQuestionId: null, matchedReason: 'fuzzy_stem',
    })).toBe('warn');
  });

  it('notes when top similarity is >= NOTE_THRESHOLD but below WARN_THRESHOLD', () => {
    expect(verdictFor({
      stemSim: NOTE_THRESHOLD, optionsSim: 0, answerMatch: false,
      matchedQuestionId: null, matchedReason: 'none',
    })).toBe('note');
  });

  it('is clean when similarity is below NOTE_THRESHOLD', () => {
    expect(verdictFor({
      stemSim: 0.1, optionsSim: 0.1, answerMatch: false,
      matchedQuestionId: null, matchedReason: 'none',
    })).toBe('clean');
  });
});

describe('pct', () => {
  it('formats a 0..1 ratio as a rounded percentage string', () => {
    expect(pct(0.856)).toBe('86%');
    expect(pct(1)).toBe('100%');
    expect(pct(0)).toBe('0%');
  });
});

describe('threshold constants', () => {
  it('are ordered NOTE < WARN <= EXACT', () => {
    expect(NOTE_THRESHOLD).toBeLessThan(WARN_THRESHOLD);
    expect(WARN_THRESHOLD).toBeLessThanOrEqual(EXACT_THRESHOLD);
  });
});
