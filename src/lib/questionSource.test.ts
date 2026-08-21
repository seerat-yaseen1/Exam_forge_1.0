/**
 * The question source: what a paper is allowed to draw from, and what it must
 * contain.
 *
 * Three properties are worth defending here, because each of them fails
 * SILENTLY if it regresses — the builder still looks correct, the publish still
 * succeeds, and the damage is only visible on a paper a student is already
 * sitting:
 *
 *  1. A restricted pool is really restricted. If any path back to the whole
 *     bank survives, a paper limited to one question bank quietly draws from
 *     everything and nobody finds out.
 *
 *  2. An anchor is really always included, and really never randomized. Both
 *     halves matter: an anchor left in the drawable pool can be picked at
 *     random by a DIFFERENT section's rule, which puts the author's pinned
 *     question somewhere they never asked for.
 *
 *  3. An anchor nothing can place is refused rather than dropped. Dropping it
 *     is the failure mode anchoring exists to prevent.
 *
 * The resolver shuffles, so every draw assertion here is written to hold for
 * ANY shuffle — sets and counts, never positions, except where the rule kind
 * being tested is the one that promises an order.
 */

import { describe, it, expect } from 'vitest';
import {
  anchorIdsInPool,
  manualSectionLists,
  poolMode,
  poolRandomizes,
  questionsInPool,
  resolvePoolIds,
  resolveQuestionsForSections,
  ruleCell,
  sanitizeQuestionSource,
  unassignedManualIds,
  validateSelectionRules,
  type AssessmentSection,
  type BankQuestion,
  type QuestionSource,
} from './assessmentService';

// ── Fixtures ──────────────────────────────────────────────────────

function q(
  id: string,
  over: Partial<BankQuestion> = {},
): BankQuestion {
  return {
    id,
    subject: 'Math',
    topic: 'Algebra',
    difficulty: 'easy',
    isDeleted: false,
    engine: 'mcq',
    variant: 'single',
    ...over,
  };
}

function section(
  name: string,
  rules: AssessmentSection['rules'],
  over: Partial<AssessmentSection> = {},
): AssessmentSection {
  return { id: `sec_${name}`, name, rules, questions: [], ...over };
}

const topicRule = (count: number, over: Record<string, unknown> = {}) => ({
  kind: 'topic' as const,
  subject: 'Math',
  topic: 'Algebra',
  difficulty: 'easy' as const,
  count,
  marksPerQuestion: 2,
  ...over,
});

// ══════════════════════════════════════════════════════════════════
// POOL RESOLUTION
// ══════════════════════════════════════════════════════════════════

describe('resolvePoolIds', () => {
  const banks = [
    { id: 'b1', questionIds: ['q1', 'q2'] },
    { id: 'b2', questionIds: ['q2', 'q3'] },
    { id: 'b3', questionIds: ['q9'] },
  ];

  it('treats an absent source as unrestricted', () => {
    expect(resolvePoolIds(undefined, banks)).toBeNull();
    expect(poolMode(undefined)).toBe('all');
  });

  it('returns null for mode all — not a materialised copy of the bank', () => {
    // null is the contract: "everything", resolved by whoever fetched the
    // questions. A snapshot here would go stale the moment a question is added.
    expect(resolvePoolIds({ mode: 'all' }, banks)).toBeNull();
  });

  it('unions the named banks and ignores the rest', () => {
    const ids = resolvePoolIds({ mode: 'banks', bankIds: ['b1', 'b2'] }, banks);
    expect([...ids!].sort()).toEqual(['q1', 'q2', 'q3']);
  });

  it('yields an empty pool when a bank mode names no banks', () => {
    // Empty, not unrestricted. Falling back to "everything" would turn a
    // half-finished decision into the widest possible paper.
    expect(resolvePoolIds({ mode: 'banks', bankIds: [] }, banks)?.size).toBe(0);
    expect(resolvePoolIds({ mode: 'banks' }, banks)?.size).toBe(0);
  });

  it('takes the manual list verbatim', () => {
    const ids = resolvePoolIds({ mode: 'manual', manualQuestionIds: ['q7'] }, banks);
    expect([...ids!]).toEqual(['q7']);
  });
});

describe('questionsInPool', () => {
  const bank = [q('q1'), q('q2'), q('q3')];

  it('is a no-op for an unrestricted pool', () => {
    expect(questionsInPool(bank, null).map((x) => x.id)).toEqual(['q1', 'q2', 'q3']);
  });

  it('keeps only what the pool admits', () => {
    expect(questionsInPool(bank, new Set(['q1', 'q3'])).map((x) => x.id)).toEqual(['q1', 'q3']);
  });

  it('ignores pool ids that are not in the bank at all', () => {
    expect(questionsInPool(bank, new Set(['q1', 'gone'])).map((x) => x.id)).toEqual(['q1']);
  });
});

describe('anchorIdsInPool', () => {
  it('drops anchors the pool no longer contains', () => {
    // The author pinned q9, then narrowed the pool underneath it. Honouring
    // the pin would put a question from outside the paper's own source onto
    // the paper.
    const src: QuestionSource = { mode: 'manual', manualQuestionIds: ['q1'], anchorQuestionIds: ['q1', 'q9'] };
    const ids = anchorIdsInPool(src, resolvePoolIds(src));
    expect([...ids]).toEqual(['q1']);
  });

  it('keeps every anchor when the pool is unrestricted', () => {
    const src: QuestionSource = { mode: 'all', anchorQuestionIds: ['q1', 'q9'] };
    expect(anchorIdsInPool(src, null).size).toBe(2);
  });
});

describe('poolRandomizes', () => {
  it('is true for every mode except manual-with-randomize-off', () => {
    expect(poolRandomizes(undefined)).toBe(true);
    expect(poolRandomizes({ mode: 'all' })).toBe(true);
    expect(poolRandomizes({ mode: 'banks', bankIds: ['b1'] })).toBe(true);
    expect(poolRandomizes({ mode: 'manual', randomize: true })).toBe(true);
    expect(poolRandomizes({ mode: 'manual' })).toBe(true);
    expect(poolRandomizes({ mode: 'manual', randomize: false })).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// STORAGE SHAPE
// ══════════════════════════════════════════════════════════════════

describe('sanitizeQuestionSource', () => {
  it('writes nothing for a plain all-pool', () => {
    // So an assessment nobody restricted is byte-identical to one written
    // before the field existed.
    expect(sanitizeQuestionSource({ mode: 'all' })).toBeUndefined();
    expect(sanitizeQuestionSource(undefined)).toBeUndefined();
  });

  it('keeps an all-pool that carries anchors', () => {
    expect(sanitizeQuestionSource({ mode: 'all', anchorQuestionIds: ['q1'] }))
      .toEqual({ mode: 'all', anchorQuestionIds: ['q1'] });
  });

  it('drops the keys the chosen mode does not use', () => {
    // A stale manualQuestionIds under mode 'banks' would resurrect a pool the
    // author had already moved off.
    const out = sanitizeQuestionSource({
      mode: 'banks',
      bankIds: ['b1'],
      manualQuestionIds: ['q1', 'q2'],
      randomize: false,
    });
    expect(out).toEqual({ mode: 'banks', bankIds: ['b1'] });
  });

  it('never emits an undefined value — removeUndefined is shallow', () => {
    const out = sanitizeQuestionSource({ mode: 'banks' })!;
    for (const v of Object.values(out)) expect(v).not.toBeUndefined();
    expect(out).toEqual({ mode: 'banks', bankIds: [] });
  });

  it('defaults a manual pool to randomizing, and records the choice either way', () => {
    expect(sanitizeQuestionSource({ mode: 'manual', manualQuestionIds: ['q1'] }))
      .toEqual({ mode: 'manual', manualQuestionIds: ['q1'], randomize: true });
    expect(sanitizeQuestionSource({ mode: 'manual', manualQuestionIds: ['q1'], randomize: false }))
      .toEqual({ mode: 'manual', manualQuestionIds: ['q1'], randomize: false });
  });

  it('de-duplicates ids', () => {
    expect(sanitizeQuestionSource({ mode: 'manual', manualQuestionIds: ['q1', 'q1'] }))
      .toMatchObject({ manualQuestionIds: ['q1'] });
  });
});

// ══════════════════════════════════════════════════════════════════
// THE DRAW — POOL RESTRICTION
// ══════════════════════════════════════════════════════════════════

describe('resolveQuestionsForSections — the pool is the bank it is given', () => {
  it('cannot draw a question outside the pool, however many times it runs', () => {
    const bank = [q('in1'), q('in2'), q('out1'), q('out2')];
    const pooled = questionsInPool(bank, new Set(['in1', 'in2']));

    for (let i = 0; i < 25; i++) {
      const { flatQuestions } = resolveQuestionsForSections(
        [section('A', [topicRule(2)])],
        pooled,
      );
      expect(flatQuestions.map((x) => x.questionId).sort()).toEqual(['in1', 'in2']);
    }
  });

  it('draws short rather than reaching outside the pool', () => {
    const pooled = questionsInPool([q('in1'), q('out1')], new Set(['in1']));
    const { flatQuestions } = resolveQuestionsForSections(
      [section('A', [topicRule(3)])],
      pooled,
    );
    expect(flatQuestions).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// THE DRAW — ANCHORS
// ══════════════════════════════════════════════════════════════════

describe('resolveQuestionsForSections — anchors', () => {
  const bank = [q('a'), q('b'), q('c'), q('d'), q('e')];

  it('always seats an anchor, whatever the shuffle does', () => {
    for (let i = 0; i < 25; i++) {
      const { flatQuestions } = resolveQuestionsForSections(
        [section('A', [topicRule(2)])],
        bank,
        undefined,
        [],
        new Set(['d']),
      );
      expect(flatQuestions.map((x) => x.questionId)).toContain('d');
      expect(flatQuestions).toHaveLength(2);
    }
  });

  it('seats an anchor in the FIRST matching rule, every single time', () => {
    // Two sections draw from the same cell, so both could host the pin. The
    // resolver is deterministic about it — first rule in reading order wins —
    // and that determinism is the property worth defending: an anchor whose
    // section varied with the shuffle would be a question the author pinned
    // and then found somewhere different on every republish.
    for (let i = 0; i < 40; i++) {
      const { sections } = resolveQuestionsForSections(
        [section('A', [topicRule(2)]), section('B', [topicRule(1)])],
        bank,
        undefined,
        [],
        new Set(['e']),
      );
      const [a, b] = sections;
      expect(a.questions.map((x) => x.questionId)).toContain('e');
      expect(b.questions.map((x) => x.questionId)).not.toContain('e');
    }
  });

  it('never lets a random draw pick up an anchor destined elsewhere', () => {
    // Section A's cell does not match the anchor, so A must never surface it —
    // otherwise the pin lands in a section the author never chose, and B is
    // seated with someone else's question.
    const mixed = [
      q('a1'), q('a2'), q('a3'),
      q('h1', { difficulty: 'hard' }), q('h2', { difficulty: 'hard' }),
    ];
    for (let i = 0; i < 40; i++) {
      const { sections } = resolveQuestionsForSections(
        [
          section('A', [topicRule(2)]),
          section('B', [topicRule(1, { difficulty: 'hard' })]),
        ],
        mixed,
        undefined,
        [],
        new Set(['h2']),
      );
      const [a, b] = sections;
      expect(a.questions.map((x) => x.questionId)).not.toContain('h2');
      expect(b.questions.map((x) => x.questionId)).toEqual(['h2']);
    }
  });

  it('does not let anchors inflate a rule past the count it asks for', () => {
    // Three pins, a rule with room for two. The blueprint wins; the surplus is
    // the validator's business, not the resolver's.
    const { flatQuestions } = resolveQuestionsForSections(
      [section('A', [topicRule(2)])],
      bank,
      undefined,
      [],
      new Set(['a', 'b', 'c']),
    );
    expect(flatQuestions).toHaveLength(2);
    expect(flatQuestions.every((x) => ['a', 'b', 'c'].includes(x.questionId))).toBe(true);
  });

  it('leaves an unanchored draw alone', () => {
    const { flatQuestions } = resolveQuestionsForSections(
      [section('A', [topicRule(3)])],
      bank,
    );
    expect(flatQuestions).toHaveLength(3);
  });

  it('ignores an anchor whose cell no rule asks for', () => {
    // Nothing crashes and nothing sneaks in — the paper is just short of the
    // author's intent, which is exactly what the validator refuses to publish.
    const withOther = [...bank, q('z', { topic: 'Geometry' })];
    const { flatQuestions } = resolveQuestionsForSections(
      [section('A', [topicRule(1)])],
      withOther,
      undefined,
      [],
      new Set(['z']),
    );
    expect(flatQuestions.map((x) => x.questionId)).not.toContain('z');
  });
});

// ══════════════════════════════════════════════════════════════════
// THE DRAW — MANUAL RULES
// ══════════════════════════════════════════════════════════════════

describe('resolveQuestionsForSections — manual rules', () => {
  const manual = (questionIds: string[], marks = 3) =>
    ({ kind: 'manual' as const, questionIds, marksPerQuestion: marks });

  it('keeps the author\'s order exactly — no shuffle', () => {
    const bank = [q('a'), q('b'), q('c')];
    const { flatQuestions } = resolveQuestionsForSections(
      [section('A', [manual(['c', 'a', 'b'])])],
      bank,
    );
    expect(flatQuestions.map((x) => x.questionId)).toEqual(['c', 'a', 'b']);
    expect(flatQuestions.every((x) => x.marks === 3)).toBe(true);
  });

  it('spans taxonomy cells, which is the whole point of the kind', () => {
    const bank = [
      q('a', { subject: 'Math', topic: 'Algebra', difficulty: 'easy' }),
      q('b', { subject: 'Physics', topic: 'Optics', difficulty: 'hard' }),
    ];
    const { flatQuestions } = resolveQuestionsForSections(
      [section('A', [manual(['a', 'b'])])],
      bank,
    );
    expect(flatQuestions).toHaveLength(2);
  });

  it('drops ids that have rotted, and never repeats one', () => {
    const bank = [q('a'), q('gone', { isDeleted: true })];
    const { flatQuestions } = resolveQuestionsForSections(
      [section('A', [manual(['a', 'gone', 'missing', 'a'])])],
      bank,
    );
    expect(flatQuestions.map((x) => x.questionId)).toEqual(['a']);
  });

  it('refuses a question the section\'s engine lock cannot run', () => {
    const bank = [q('mc'), q('essay', { engine: 'text', variant: 'long' })];
    const { flatQuestions } = resolveQuestionsForSections(
      [section('A', [manual(['mc', 'essay'])], { engines: ['objective'] })],
      bank,
    );
    expect(flatQuestions.map((x) => x.questionId)).toEqual(['mc']);
  });

  it('re-indexes hand-picked group children over the ones actually taken', () => {
    // Picking children 2 and 5 of an eight-part set must produce positions 0
    // and 1, not 2 and 5 — the paper's ordering has to describe the paper.
    const bank = [
      q('c2', { groupId: 'g1', groupOrder: 2 }),
      q('c5', { groupId: 'g1', groupOrder: 5 }),
      q('loose'),
    ];
    const { flatQuestions } = resolveQuestionsForSections(
      [section('A', [manual(['c2', 'c5', 'loose'])])],
      bank,
    );
    expect(flatQuestions.map((x) => [x.questionId, x.groupId, x.groupOrder])).toEqual([
      ['c2', 'g1', 0],
      ['c5', 'g1', 1],
      ['loose', undefined, undefined],
    ]);
  });

  it('has no taxonomy cell to report', () => {
    expect(ruleCell(manual(['a']))).toBeNull();
    expect(ruleCell(topicRule(1))).toEqual({ subject: 'Math', topic: 'Algebra', difficulty: 'easy' });
  });
});

// ══════════════════════════════════════════════════════════════════
// VALIDATION
// ══════════════════════════════════════════════════════════════════

describe('validateSelectionRules — anchors', () => {
  const bank = [q('a'), q('b'), q('c')];

  it('passes when a rule can seat every anchor', () => {
    const { valid } = validateSelectionRules(
      [section('A', [topicRule(2)])],
      bank, undefined, [], undefined, new Set(['a']),
    );
    expect(valid).toBe(true);
  });

  it('refuses a publish when an anchor matches no rule', () => {
    const withOther = [...bank, q('z', { topic: 'Geometry' })];
    const { valid, results } = validateSelectionRules(
      [section('A', [topicRule(2)])],
      withOther, undefined, [], undefined, new Set(['z']),
    );
    expect(valid).toBe(false);
    const anchorResult = results.find((r) => r.sectionName === '');
    expect(anchorResult?.blocked).toMatch(/anchored question/i);
    // Names the cell, so the author knows which rule to add.
    expect(anchorResult?.blocked).toMatch(/Geometry/);
  });

  it('refuses when a cell holds more anchors than its rules have room for', () => {
    const { valid } = validateSelectionRules(
      [section('A', [topicRule(1)])],
      bank, undefined, [], undefined, new Set(['a', 'b']),
    );
    expect(valid).toBe(false);
  });

  it('counts anchors across sections, not per section', () => {
    // Two rules of one, two anchors: both are placeable, one each.
    const { valid } = validateSelectionRules(
      [section('A', [topicRule(1)]), section('B', [topicRule(1)])],
      bank, undefined, [], undefined, new Set(['a', 'b']),
    );
    expect(valid).toBe(true);
  });

  it('treats a manually placed question as already seated', () => {
    // Pinning something you also hand-placed is redundant, not an error — and
    // must not be reported as an anchor nobody placed.
    const { valid } = validateSelectionRules(
      [section('A', [{ kind: 'manual', questionIds: ['a'], marksPerQuestion: 1 }])],
      bank, undefined, [], undefined, new Set(['a']),
    );
    expect(valid).toBe(true);
  });

  it('ignores an anchor whose question no longer exists', () => {
    // A deleted question cannot be placed by anything, and blocking the
    // publish over it would leave the author no way to proceed but to find a
    // pin they can no longer see.
    const { valid } = validateSelectionRules(
      [section('A', [topicRule(1)])],
      bank, undefined, [], undefined, new Set(['deleted-long-ago']),
    );
    expect(valid).toBe(true);
  });
});

describe('validateSelectionRules — manual rules', () => {
  it('passes when every hand-picked id still resolves', () => {
    const { valid } = validateSelectionRules(
      [section('A', [{ kind: 'manual', questionIds: ['a', 'b'], marksPerQuestion: 1 }])],
      [q('a'), q('b')],
    );
    expect(valid).toBe(true);
  });

  it('refuses a publish when a hand-picked question has rotted', () => {
    const { valid, results } = validateSelectionRules(
      [section('A', [{ kind: 'manual', questionIds: ['a', 'gone'], marksPerQuestion: 1 }])],
      [q('a'), q('gone', { isDeleted: true })],
    );
    expect(valid).toBe(false);
    expect(results[0].blocked).toMatch(/1 of 2 hand-picked/);
  });

  it('reports the shortfall when the section lock refuses a pick', () => {
    const { valid, results } = validateSelectionRules(
      [section('A', [{ kind: 'manual', questionIds: ['mc', 'essay'], marksPerQuestion: 1 }],
        { engines: ['objective'] })],
      [q('mc'), q('essay', { engine: 'text', variant: 'long' })],
    );
    expect(valid).toBe(false);
    expect(results[0].available).toBe(1);
  });

  it('agrees with the resolver about what will actually be drawn', () => {
    // The trap this suite exists for: a blueprint the validator calls valid
    // and the resolver then draws short. Both sides read the same bank, so
    // both sides must reach the same number.
    const bank = [q('a'), q('b'), q('gone', { isDeleted: true })];
    const rules = [{ kind: 'manual' as const, questionIds: ['a', 'b', 'gone'], marksPerQuestion: 1 }];
    const { results } = validateSelectionRules([section('A', rules)], bank);
    const { flatQuestions } = resolveQuestionsForSections([section('A', rules)], bank);
    expect(results[0].available).toBe(flatQuestions.length);
  });
});

// ══════════════════════════════════════════════════════════════════
// SECTION ASSIGNMENT (hand-picked papers, several sections)
// ══════════════════════════════════════════════════════════════════
//
// The invariant under test throughout: a fixed question is ONE INSTANCE and
// therefore lives in exactly one section. The storage shape — a
// questionId → sectionId map — makes the double-assignment unrepresentable
// rather than merely guarded, so what is left to defend is the edges: order,
// deleted sections, and the transitions between one section and several.

describe('manualSectionLists', () => {
  const src = (over: Partial<QuestionSource> = {}): QuestionSource => ({
    mode: 'manual',
    randomize: false,
    manualQuestionIds: ['q1', 'q2', 'q3', 'q4'],
    ...over,
  });

  it('gives a single-section paper everything, ignoring the map entirely', () => {
    // The spec skips the assignment step for one section, and this is where
    // "entirely" is enforced: even a stale map from a time when the paper had
    // three sections cannot strand a question.
    const lists = manualSectionLists(
      src({ manualAssignments: { q1: 'gone', q2: 'alsoGone' } }),
      ['only'],
    );
    expect(lists.only).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(unassignedManualIds(src({ manualAssignments: {} }), ['only'])).toEqual([]);
  });

  it('routes each question to its section, and leaves the rest unassigned', () => {
    const source = src({ manualAssignments: { q1: 'A', q3: 'A', q2: 'B' } });
    const lists = manualSectionLists(source, ['A', 'B']);
    expect(lists).toEqual({ A: ['q1', 'q3'], B: ['q2'] });
    expect(unassignedManualIds(source, ['A', 'B'])).toEqual(['q4']);
  });

  it('orders each section by the PICK order, not the map key order', () => {
    // Object key order survives neither a Firestore round-trip nor a rewrite,
    // and a fixed paper is delivered in the order it was assembled.
    const source = src({ manualAssignments: { q4: 'A', q1: 'A', q3: 'A' } });
    expect(manualSectionLists(source, ['A', 'B']).A).toEqual(['q1', 'q3', 'q4']);
  });

  it('returns a question whose section was deleted to the unassigned pool', () => {
    // Visible and recoverable, rather than vanishing into a section that no
    // longer exists.
    const source = src({ manualAssignments: { q1: 'A', q2: 'deletedSection' } });
    const lists = manualSectionLists(source, ['A', 'B']);
    expect(lists.A).toEqual(['q1']);
    expect(lists.B).toEqual([]);
    expect(unassignedManualIds(source, ['A', 'B'])).toEqual(['q2', 'q3', 'q4']);
  });

  it('never places one question in two sections', () => {
    // Unrepresentable by construction — the second write to a key replaces the
    // first — so this asserts the shape is doing its job.
    const source = src({ manualAssignments: { q1: 'A' } });
    const after: QuestionSource = {
      ...source,
      manualAssignments: { ...source.manualAssignments, q1: 'B' },
    };
    const lists = manualSectionLists(after, ['A', 'B']);
    expect(lists.A).toEqual([]);
    expect(lists.B).toEqual(['q1']);
    expect(Object.values(lists).flat().filter((id) => id === 'q1')).toHaveLength(1);
  });

  it('gives every section an entry, including the empty ones', () => {
    // A section missing from the result would read as "no rules yet" rather
    // than "empty", and the publish check needs to tell those apart.
    const lists = manualSectionLists(src({ manualAssignments: { q1: 'A' } }), ['A', 'B', 'C']);
    expect(Object.keys(lists).sort()).toEqual(['A', 'B', 'C']);
    expect(lists.C).toEqual([]);
  });
});

describe('sanitizeQuestionSource — assignments', () => {
  it('keeps assignments for a fixed multi-section paper', () => {
    expect(sanitizeQuestionSource({
      mode: 'manual',
      randomize: false,
      manualQuestionIds: ['q1', 'q2'],
      manualAssignments: { q1: 'A' },
    })).toEqual({
      mode: 'manual',
      manualQuestionIds: ['q1', 'q2'],
      randomize: false,
      manualAssignments: { q1: 'A' },
    });
  });

  it('drops assignments once the paper randomizes again', () => {
    // They mean nothing to a randomized draw, and would come back as ghosts
    // the next time randomization was turned off.
    const out = sanitizeQuestionSource({
      mode: 'manual',
      randomize: true,
      manualQuestionIds: ['q1'],
      manualAssignments: { q1: 'A' },
    })!;
    expect(out.manualAssignments).toBeUndefined();
  });

  it('drops an assignment for a question no longer in the pool', () => {
    // The author un-picked it; the pointer is to nothing.
    const out = sanitizeQuestionSource({
      mode: 'manual',
      randomize: false,
      manualQuestionIds: ['q1'],
      manualAssignments: { q1: 'A', unpicked: 'B' },
    })!;
    expect(out.manualAssignments).toEqual({ q1: 'A' });
  });

  it('writes no assignments key at all when there are none', () => {
    const out = sanitizeQuestionSource({
      mode: 'manual', randomize: false, manualQuestionIds: ['q1'],
    })!;
    expect('manualAssignments' in out).toBe(false);
  });
});

describe('resolveQuestionsForSections — an assigned hand-picked paper', () => {
  it('delivers each section its own questions, in pick order, at its own marks', () => {
    const bank = [q('q1'), q('q2'), q('q3')];
    const source: QuestionSource = {
      mode: 'manual',
      randomize: false,
      manualQuestionIds: ['q1', 'q2', 'q3'],
      manualAssignments: { q1: 'B', q2: 'A', q3: 'B' },
    };
    const lists = manualSectionLists(source, ['A', 'B']);
    const { sections } = resolveQuestionsForSections(
      [
        { id: 'A', name: 'A', questions: [], rules: [{ kind: 'manual', questionIds: lists.A, marksPerQuestion: 2 }] },
        { id: 'B', name: 'B', questions: [], rules: [{ kind: 'manual', questionIds: lists.B, marksPerQuestion: 5 }] },
      ],
      bank,
    );
    expect(sections[0].questions.map((x) => x.questionId)).toEqual(['q2']);
    expect(sections[0].questions.every((x) => x.marks === 2)).toBe(true);
    expect(sections[1].questions.map((x) => x.questionId)).toEqual(['q1', 'q3']);
    expect(sections[1].questions.every((x) => x.marks === 5)).toBe(true);
  });

  it('leaves unassigned picks off the paper entirely', () => {
    // The publish path warns about this; the resolver simply must not invent a
    // home for them.
    const bank = [q('q1'), q('q2')];
    const source: QuestionSource = {
      mode: 'manual',
      randomize: false,
      manualQuestionIds: ['q1', 'q2'],
      manualAssignments: { q1: 'A' },
    };
    const lists = manualSectionLists(source, ['A', 'B']);
    const { flatQuestions } = resolveQuestionsForSections(
      [
        { id: 'A', name: 'A', questions: [], rules: [{ kind: 'manual', questionIds: lists.A, marksPerQuestion: 1 }] },
        { id: 'B', name: 'B', questions: [], rules: [] },
      ],
      bank,
    );
    expect(flatQuestions.map((x) => x.questionId)).toEqual(['q1']);
    expect(unassignedManualIds(source, ['A', 'B'])).toEqual(['q2']);
  });
});
