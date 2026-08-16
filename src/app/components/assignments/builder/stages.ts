/**
 * The builder's stages, and how far along each one is.
 *
 * ── WHY THIS REPLACED TWO STEPPERS ────────────────────────────────
 * The builder used to run two progress indicators at once. The top bar showed
 * three bare numbered circles with no labels; step 1 then rendered a SECOND,
 * labelled stepper of its own — Subjects → Topics → Sections. An author saw
 * two "you are here" widgets that did not agree with each other, could not
 * tell which was which, and had no way to learn what step 3 was until they got
 * to it. The outer stepper was also one-way in practice: you could go back a
 * step, but nothing told you it was safe to.
 *
 * The deeper problem was the wizard shape itself. A wizard is right when the
 * author does not know what is coming and each answer narrows the next
 * question. Building an exam is not that: the author already knows they need
 * sections, a schedule and a security tier, and they routinely want to set the
 * deadline before they have finished picking topics. Marching them through a
 * fixed order made the tool slower than the person using it — and made EDITING
 * an existing exam absurd, since a wizard insists on a beginning for something
 * that is already finished.
 *
 * So: one flat list of stages, all reachable at any time, each carrying its own
 * state. Nothing here gates navigation. Publishing is still gated — by the
 * validation in DetailsStep, which is where the rules live — and this file's
 * job is to make what publish will ask for visible BEFORE the author asks to
 * publish, rather than after.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────
 * `allocation` is a stage in the list because it has to be reachable, but this
 * file has no opinion about whether it is complete. Allocation is mid-change
 * and its rules move with delivery mode; a completeness rule written now would
 * be wrong shortly and would show authors a red dot they could do nothing
 * about. It reports 'neutral' until that work lands.
 */

import { draftIsLive, draftQuestionCount, draftTotalMarks, type SectionDraft } from './shared';

export type BuilderStage =
  | 'basics'
  | 'subjects'
  | 'topics'
  | 'sections'
  | 'questions'
  | 'schedule'
  | 'grading'
  | 'security'
  | 'allocation';

/**
 * Which component owns a stage's content.
 *
 * Both step components stay mounted for the whole session and show or hide
 * their stage, rather than mounting on demand. That is load-bearing: DetailsStep
 * holds every schedule, grading and security value in local state, so
 * unmounting it — which the old step 1 ↔ step 2 switch did — would silently
 * reset a deadline the author had already typed.
 */
export type StageOwner = 'setup' | 'details' | 'allocation';

export type StageDef = {
  id: BuilderStage;
  label: string;
  /** One line, shown under the stage heading. Says what the stage is FOR. */
  blurb: string;
  owner: StageOwner;
  /** Stages that must be satisfied before a publish will succeed. */
  required: boolean;
};

/**
 * Order matters — it is the reading order of the rail and the order Next walks.
 * Grouped loosely as: what the exam IS, what it CONTAINS, how it BEHAVES, who
 * SITS it.
 */
export const BUILDER_STAGES: readonly StageDef[] = [
  {
    id: 'basics', label: 'Basics', owner: 'setup', required: true,
    blurb: 'What this assessment is called, and what students are told about it.',
  },
  {
    id: 'subjects', label: 'Subjects', owner: 'setup', required: true,
    blurb: 'The subjects this paper may draw from. Narrowing here narrows every later choice.',
  },
  {
    id: 'topics', label: 'Topics', owner: 'setup', required: true,
    blurb: 'Which topics within those subjects are in scope.',
  },
  {
    id: 'sections', label: 'Sections', owner: 'setup', required: true,
    blurb: 'The shape of the paper — how many sections, what each is called, and how long students get.',
  },
  {
    id: 'questions', label: 'Questions', owner: 'details', required: true,
    blurb: 'What each section draws from the bank: how many questions, at which difficulty, for how many marks.',
  },
  {
    id: 'schedule', label: 'Schedule', owner: 'details', required: false,
    blurb: 'When the paper opens and closes, and how many attempts a student gets.',
  },
  {
    id: 'grading', label: 'Grading', owner: 'details', required: false,
    blurb: 'How answers are marked — partial credit, negative marking, and the pass mark.',
  },
  {
    id: 'security', label: 'Security', owner: 'details', required: false,
    blurb: 'How closely the sitting is invigilated, and what a student must have to enter.',
  },
  {
    id: 'allocation', label: 'Allocation', owner: 'allocation', required: false,
    blurb: 'Who sits this paper.',
  },
] as const;

export function stageDef(id: BuilderStage): StageDef {
  // The list is a closed literal union, so this cannot miss.
  return BUILDER_STAGES.find((s) => s.id === id)!;
}

/**
 * A stage's state, as the rail draws it.
 *
 *   done     — satisfied; nothing is being asked of the author here
 *   todo     — REQUIRED and not yet satisfied; publish will refuse
 *   neutral  — optional, or not this file's business to judge
 *
 * There is deliberately no 'error' state. Errors belong to the save path,
 * which can see the whole draft at once and knows whether the author is
 * publishing or saving a draft — a stage cannot know that, and a rail that
 * turned red while someone was halfway through typing would be lying about
 * work in progress.
 */
export type StageState = 'done' | 'todo' | 'neutral';

export type StageStatus = {
  state: StageState;
  /** Short, shown beside the label. A count, not a sentence. */
  detail?: string;
};

export type DraftShape = {
  title: string;
  subjectPool: string[];
  topicPool: string[];
  sections: SectionDraft[];
};

/**
 * Is this section answerable — does it ask for at least one question?
 *
 * Mirrors the publish check in DetailsStep rather than re-deciding it: a group
 * rule drawing 'all' of its children has no knowable count until the draw
 * happens at publish, so it counts as live rather than as zero. Counting it as
 * zero would mark a section built entirely of comprehension sets as empty.
 */
export function sectionIsAnswerable(s: SectionDraft): boolean {
  if (!s.rules.some(draftIsLive)) return false;
  const known = s.rules.reduce((sum, r) => sum + (draftQuestionCount(r) ?? 0), 0);
  return known >= 1 || s.rules.some((r) => draftQuestionCount(r) === null);
}

export function sectionIsComplete(s: SectionDraft): boolean {
  return (
    s.name.trim().length > 0
    && parseInt(s.timeLimit, 10) >= 1
    && sectionIsAnswerable(s)
  );
}

export function stageStatus(id: BuilderStage, d: DraftShape): StageStatus {
  switch (id) {
    case 'basics':
      return d.title.trim()
        ? { state: 'done' }
        : { state: 'todo', detail: 'Title needed' };

    case 'subjects':
      return d.subjectPool.length > 0
        ? { state: 'done', detail: String(d.subjectPool.length) }
        : { state: 'todo' };

    case 'topics':
      return d.topicPool.length > 0
        ? { state: 'done', detail: String(d.topicPool.length) }
        : { state: 'todo' };

    // Structure only — a section is "set up" once it has a name and a clock.
    // Whether it draws any questions is the next stage's business, and
    // reporting that shortfall here would put the same warning on two rows.
    case 'sections': {
      const n = d.sections.length;
      if (n === 0) return { state: 'todo' };
      const unnamed = d.sections.filter(
        (s) => !s.name.trim() || !(parseInt(s.timeLimit, 10) >= 1),
      ).length;
      return unnamed === 0
        ? { state: 'done', detail: String(n) }
        : { state: 'todo', detail: `${unnamed} incomplete` };
    }

    case 'questions': {
      if (d.sections.length === 0) return { state: 'todo' };
      const empty = d.sections.filter((s) => !sectionIsAnswerable(s)).length;
      return empty === 0
        ? { state: 'done' }
        : { state: 'todo', detail: `${empty} empty` };
    }

    // Schedule, grading and security all have working defaults — an author who
    // never opens them still publishes a valid exam. Reporting them as 'todo'
    // would be crying wolf on three of eight stages and would teach the author
    // to ignore the marker on the four that mean it.
    case 'schedule':
    case 'grading':
    case 'security':
      return { state: 'neutral' };

    // Not this file's business yet — see the header.
    case 'allocation':
      return { state: 'neutral' };
  }
}

/**
 * The paper as it currently stands.
 *
 * `approximate` is true when any rule's count cannot be known until the draw
 * at publish, so the UI can say "≥ 40" rather than a confidently wrong 40.
 */
export type PaperTotals = {
  sections: number;
  questions: number;
  marks: number;
  /** Sum of per-section time limits, in minutes. 0 when none are set. */
  minutes: number;
  approximate: boolean;
};

export function paperTotals(sections: SectionDraft[]): PaperTotals {
  const rules = sections.flatMap((s) => s.rules);
  return {
    sections: sections.length,
    questions: rules.reduce((n, r) => n + (draftQuestionCount(r) ?? 0), 0),
    marks: rules.reduce((n, r) => n + (draftTotalMarks(r) ?? 0), 0),
    minutes: sections.reduce((n, s) => n + (parseInt(s.timeLimit, 10) || 0), 0),
    approximate: rules.some((r) => draftQuestionCount(r) === null),
  };
}
