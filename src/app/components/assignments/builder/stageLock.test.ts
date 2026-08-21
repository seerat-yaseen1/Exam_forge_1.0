/**
 * Stage locking, and the one definition of "done" behind it.
 *
 * ── WHY THIS SUITE EXISTS ─────────────────────────────────────────
 * Three separate answers to "is this stage finished?" used to coexist:
 * StageDef.required (set everywhere, read nowhere), stageStatus (the rail's
 * dots) and the publish validator (a smaller set again). They disagreed, and
 * the disagreement was not cosmetic — an assessment could be published with no
 * title, because "required" and "Title needed" were both claims nothing
 * enforced.
 *
 * A lock built on that would be worse than no lock: it would shut doors on
 * rules the publish path does not share. So the properties defended here are,
 * in order:
 *
 *  1. Every stage marked `required` has a completeness rule that can fail, and
 *     every stage NOT marked required can never report 'todo'. That is the
 *     contract stageLock relies on, and it is checked against the real stage
 *     list rather than a fixture.
 *  2. Optional stages never block anything. This is what keeps the flow at
 *     three gates instead of nine.
 *  3. Unlocking is permanent. Completeness is re-derived on every keystroke,
 *     so a lock that only looked forward would re-lock stages mid-word.
 *  4. Nothing is gated while editing.
 */

import { describe, it, expect } from 'vitest';
import {
  BUILDER_STAGES,
  openStages,
  sectionIsComplete,
  stageLock,
  stageStatus,
  visibleBuilderStages,
  type BuilderStage,
  type DraftShape,
  type StageDef,
} from './stages';
import type { RuleDraft, SectionDraft } from './shared';

// ── Fixtures ──────────────────────────────────────────────────────

const liveRule: RuleDraft = {
  kind: 'topic',
  subject: 'Math',
  topic: 'Algebra',
  difficulty: 'easy',
  count: '5',
  marksPerQuestion: '2',
};

function section(over: Partial<SectionDraft> = {}): SectionDraft {
  return {
    id: 'sec_1',
    name: 'Section A',
    timeLimit: '',
    questionTimeLimit: '',
    rules: [liveRule],
    assignedTopics: [],
    breakAfterMinutes: '',
    breakMandatory: false,
    engines: [],
    manualMarks: '',
    ...over,
  };
}

function draft(over: Partial<DraftShape> = {}): DraftShape {
  return {
    title: 'Midterm',
    subjectPool: [],
    topicPool: [],
    sections: [section()],
    source: { mode: 'all', poolSize: null, anchors: 0, pending: false },
    ...over,
  };
}

const stages = [...BUILDER_STAGES];
const statusOf = (d: DraftShape) => (id: BuilderStage) => stageStatus(id, d);

function lock(id: BuilderStage, d: DraftShape, over: {
  unlocked?: BuilderStage[];
  gated?: boolean;
  stages?: StageDef[];
} = {}) {
  return stageLock(id, {
    stages: over.stages ?? stages,
    statusFor: statusOf(d),
    unlocked: new Set(over.unlocked ?? []),
    gated: over.gated ?? true,
  });
}

// ══════════════════════════════════════════════════════════════════
// THE CONTRACT BETWEEN `required` AND `stageStatus`
// ══════════════════════════════════════════════════════════════════

describe('required stages and their completeness rules agree', () => {
  it('marks exactly Basics, Sections and Questions required', () => {
    // Pinned deliberately. Adding a required stage is a decision about the
    // shape of the flow — it adds a gate every author walks through — and
    // should not be possible to do by accident in a list of ten entries.
    expect(BUILDER_STAGES.filter((s) => s.required).map((s) => s.id))
      .toEqual(['basics', 'sections', 'questions']);
  });

  it('gives every required stage a rule that can actually fail', () => {
    // An empty draft: no title, no sections. If a required stage reports
    // 'done' here, its rule is not a rule.
    const empty = draft({ title: '', sections: [] });
    for (const s of BUILDER_STAGES.filter((x) => x.required)) {
      expect(stageStatus(s.id, empty).state, s.id).toBe('todo');
    }
  });

  it('gives every required stage a blocker sentence when it fails', () => {
    // The Continue button has nothing to say without it, and "Finish Basics"
    // as a fallback tells an author the name of the stage they are standing on
    // rather than what is wrong with it.
    const empty = draft({ title: '', sections: [] });
    for (const s of BUILDER_STAGES.filter((x) => x.required)) {
      expect(stageStatus(s.id, empty).blocker, s.id).toBeTruthy();
    }
  });

  it('never reports an optional stage as todo, however empty the draft', () => {
    // The property that keeps the dots meaningful: amber must mean "publish
    // will refuse this", never "you skipped something you were allowed to
    // skip". Subjects and Topics are the ones this used to get wrong.
    const empty = draft({ title: '', sections: [], subjectPool: [], topicPool: [] });
    for (const s of BUILDER_STAGES.filter((x) => !x.required)) {
      expect(stageStatus(s.id, empty).state, s.id).not.toBe('todo');
    }
  });

  it('treats an empty subject or topic pool as the widest answer, not an omission', () => {
    const d = draft({ subjectPool: [], topicPool: [] });
    expect(stageStatus('subjects', d)).toEqual({ state: 'neutral', detail: 'All' });
    expect(stageStatus('topics', d)).toEqual({ state: 'neutral', detail: 'All' });
  });
});

describe('sectionIsComplete', () => {
  it('asks for a name and nothing else', () => {
    expect(sectionIsComplete(section({ name: 'Part One' }))).toBe(true);
    expect(sectionIsComplete(section({ name: '  ' }))).toBe(false);
  });

  it('does not demand a time limit', () => {
    // An untimed section is supported by the data model and documented as
    // such. Demanding one to pass a gate would make every author invent a
    // number to get past it.
    expect(sectionIsComplete(section({ timeLimit: '' }))).toBe(true);
  });

  it('does not care whether the section draws any questions', () => {
    // That is the Questions stage's business. Reporting the same shortfall on
    // two rail rows teaches authors to read neither.
    expect(sectionIsComplete(section({ rules: [] }))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// THE GATES
// ══════════════════════════════════════════════════════════════════

describe('stageLock — the three gates', () => {
  const noTitle = draft({ title: '' });

  it('leaves the first stage open with nothing filled in', () => {
    expect(lock('basics', noTitle).open).toBe(true);
  });

  it('shuts everything after Basics until there is a title', () => {
    for (const id of ['security', 'questionSource', 'subjects', 'topics', 'sections', 'questions'] as const) {
      const l = lock(id, noTitle);
      expect(l.open, id).toBe(false);
      if (!l.open) expect(l.blockedBy.id).toBe('basics');
    }
  });

  it('carries the blocking stage and its imperative', () => {
    const l = lock('sections', noTitle);
    expect(l.open).toBe(false);
    if (!l.open) {
      expect(l.blockedBy.id).toBe('basics');
      expect(l.reason).toBe('Add a title to continue');
    }
  });

  it('opens five stages at once on the title, because the rest are optional', () => {
    // The honest arithmetic of "only required stages gate": Security,
    // Question Source, Subjects and Topics have no gate of their own, so
    // Basics unlocks the whole middle of the flow in one go.
    const titled = draft({ sections: [] });
    for (const id of ['security', 'questionSource', 'subjects', 'topics', 'sections'] as const) {
      expect(lock(id, titled).open, id).toBe(true);
    }
  });

  it('shuts Questions until every section has a name', () => {
    const unnamed = draft({ sections: [section({ name: '' })] });
    const l = lock('questions', unnamed);
    expect(l.open).toBe(false);
    if (!l.open) expect(l.blockedBy.id).toBe('sections');
  });

  it('shuts the settings stages until every section draws something', () => {
    const noRules = draft({ sections: [section({ rules: [] })] });
    for (const id of ['schedule', 'grading', 'allocation'] as const) {
      const l = lock(id, noRules);
      expect(l.open, id).toBe(false);
      if (!l.open) expect(l.blockedBy.id).toBe('questions');
    }
  });

  it('opens everything once the three required stages are done', () => {
    const complete = draft();
    for (const s of BUILDER_STAGES) {
      expect(lock(s.id, complete).open, s.id).toBe(true);
    }
  });

  it('names the FIRST unfinished required stage, not the nearest', () => {
    // Both Basics and Sections are unfinished; the author should be sent to
    // the one at the top of the flow, not the one closest to where they
    // clicked, or they will be bounced twice.
    const nothing = draft({ title: '', sections: [] });
    const l = lock('grading', nothing);
    expect(l.open).toBe(false);
    if (!l.open) expect(l.blockedBy.id).toBe('basics');
  });
});

// ══════════════════════════════════════════════════════════════════
// UNLOCKING IS PERMANENT
// ══════════════════════════════════════════════════════════════════

describe('stageLock — the unlocked set', () => {
  it('keeps a stage open after the draft stops satisfying its gate', () => {
    // The retype case: an author clears the title to fix a typo. Without the
    // set, eight stages slam shut mid-word.
    const noTitle = draft({ title: '' });
    expect(lock('sections', noTitle, { unlocked: ['sections'] }).open).toBe(true);
  });

  it('openStages reports what to fold in, and grows monotonically', () => {
    const empty = draft({ title: '', sections: [] });
    const first = openStages({ stages, statusFor: statusOf(empty), unlocked: new Set(), gated: true });
    expect(first).toEqual(['basics']);

    const titled = draft({ sections: [] });
    const second = openStages({
      stages, statusFor: statusOf(titled), unlocked: new Set(first), gated: true,
    });
    // Everything previously open is still open, plus the newly earned ones.
    expect(first.every((id) => second.includes(id))).toBe(true);
    expect(second).toContain('sections');
    expect(second).not.toContain('questions');
  });
});

// ══════════════════════════════════════════════════════════════════
// WHEN NOTHING IS GATED
// ══════════════════════════════════════════════════════════════════

describe('stageLock — gating off', () => {
  it('opens every stage when the draft is not gated', () => {
    // Edit mode, and any draft that has been saved once. The wizard's worst
    // failure was insisting on a beginning for something already finished.
    const nothing = draft({ title: '', sections: [] });
    for (const s of BUILDER_STAGES) {
      expect(lock(s.id, nothing, { gated: false }).open, s.id).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// COMPOSING WITH HIDDEN STAGES
// ══════════════════════════════════════════════════════════════════

describe('stageLock — hand-picked papers', () => {
  it('computes gates over the VISIBLE stages only', () => {
    // A single-section hand-picked paper hides Topics and Questions. Questions
    // is required, so a lock computed over the full list would leave Schedule
    // shut behind a stage the author cannot even see.
    const visible = visibleBuilderStages({ fixedPaper: true, sectionCount: 1 });
    expect(visible.map((s) => s.id)).not.toContain('questions');

    const d = draft({ sections: [section({ rules: [] })] });
    expect(lock('schedule', d, { stages: visible }).open).toBe(true);
  });

  it('keeps the Questions gate when several sections need routing', () => {
    const visible = visibleBuilderStages({ fixedPaper: true, sectionCount: 2 });
    expect(visible.map((s) => s.id)).toContain('questions');

    const d = draft({
      sections: [section({ id: 'a' }), section({ id: 'b', name: 'B', rules: [] })],
    });
    const l = lock('schedule', d, { stages: visible });
    expect(l.open).toBe(false);
    if (!l.open) expect(l.blockedBy.id).toBe('questions');
  });

  it('treats a stage the rail is not showing as open', () => {
    // Nothing can navigate to it, so refusing would only be a way to break the
    // callers that ask about it in passing.
    const visible = visibleBuilderStages({ fixedPaper: true, sectionCount: 1 });
    expect(lock('topics', draft({ title: '' }), { stages: visible }).open).toBe(true);
  });
});
