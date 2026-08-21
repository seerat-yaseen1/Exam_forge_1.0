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

import type { QuestionPoolMode } from '../../../../lib/assessmentService';
import {
  draftIsLive,
  draftQuestionCount,
  draftTotalMarks,
  type SectionDraft,
} from './shared';

/** Listed in flow order, so the union reads as the rail does. */
export type BuilderStage =
  | 'basics'
  | 'security'
  | 'questionSource'
  | 'subjects'
  | 'topics'
  | 'sections'
  | 'questions'
  | 'schedule'
  | 'grading'
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
export type StageOwner = 'setup' | 'source' | 'details' | 'allocation';

export type StageDef = {
  id: BuilderStage;
  label: string;
  /** One line, shown under the stage heading. Says what the stage is FOR. */
  blurb: string;
  owner: StageOwner;
  /**
   * Must be satisfied before a publish will succeed — and, while an assessment
   * is being created, before the stages after it open.
   *
   * This flag was decorative for most of its life: it was set on every stage
   * and read by nothing, while the rail's warnings came from stageStatus's own
   * switch and the publish path enforced a third, smaller set. The three
   * disagreed, and the gap was not academic — an assessment could be published
   * with no title at all, because "required" here and "Title needed" in the
   * rail were both claims nobody checked.
   *
   * It is now the ONE answer. stageStatus reports against it, the publish
   * validator enforces it, and stageLock gates on it. A stage marked required
   * must have a completeness rule in stageStatus, and that rule is what
   * publish refuses on.
   */
  required: boolean;
};

/**
 * Order matters — it is the reading order of the rail and the order Next walks.
 * Grouped loosely as: what the exam IS, what it CONTAINS, how it BEHAVES, who
 * SITS it.
 *
 * ── WHY SECURITY SITS SECOND ──────────────────────────────────────
 * It used to sit near the end, beside schedule and grading, on the theory that
 * it is a setting like any other. It is not. How closely a sitting is
 * invigilated is a decision about what KIND of assessment this is — a
 * proctored end-of-term paper and an open-book practice quiz are different
 * animals from the first question onward — and authors were making every
 * content decision before being asked it. Answering it directly after Basics
 * puts it where it actually belongs: with the paper's identity, before any of
 * the work it colours.
 *
 * It stays optional. Second in the reading order is not the same as required;
 * the defaults still publish a valid exam for an author who walks straight
 * past it.
 *
 * ── WHY QUESTION SOURCE SITS BEFORE SUBJECTS ──────────────────────
 * The spec numbered it after Subjects, and it cannot go there. Choosing a pool
 * RESTRICTS which subjects and topics are worth offering — that is the whole
 * point of the step — and a restriction cannot narrow a choice the author has
 * already made two stages ago. Asked first, the dead end (pick a subject, pick
 * its topics, build a matrix, discover at publish that the chosen bank has
 * nothing in that cell) is unreachable rather than merely reported.
 */
export const BUILDER_STAGES: readonly StageDef[] = [
  {
    id: 'basics', label: 'Basics', owner: 'setup', required: true,
    blurb: 'What this assessment is called, and what students are told about it.',
  },
  {
    id: 'security', label: 'Security', owner: 'details', required: false,
    blurb: 'How closely the sitting is invigilated, and what a student must have to enter.',
  },
  {
    id: 'questionSource', label: 'Question Source', owner: 'source', required: false,
    blurb: 'Where this paper may draw from — everything you can see, named banks, or questions you pick yourself.',
  },
  // Subjects and Topics are NARROWING TOOLS, not requirements, and marking
  // them required was a claim nothing backed. An empty pool means "no
  // narrowing" at every single consumer — the section picker, the rule
  // builder's cell list, the resolver — so an author who skips both draws
  // from their whole visible bank and publishes a perfectly valid exam. The
  // publish path never checked them either. Requiring them would make "use
  // everything I have" a five-click detour through two screens that exist to
  // subtract.
  {
    id: 'subjects', label: 'Subjects', owner: 'setup', required: false,
    blurb: 'Narrow this paper to particular subjects. Skip it to draw from every subject you can see.',
  },
  {
    id: 'topics', label: 'Topics', owner: 'setup', required: false,
    blurb: 'Narrow further to particular topics. Skip it to draw from every topic in the chosen subjects.',
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
    id: 'allocation', label: 'Allocation', owner: 'allocation', required: false,
    blurb: 'Who sits this paper.',
  },
] as const;

export function stageDef(id: BuilderStage): StageDef {
  // The list is a closed literal union, so this cannot miss.
  return BUILDER_STAGES.find((s) => s.id === id)!;
}

/**
 * The stages this particular draft actually has.
 *
 * All of them, except under Manual Selection with randomization OFF, where the
 * author has already named every question on the paper:
 *
 *  • TOPICS always goes. Nothing there decides anything any more — topic and
 *    difficulty come back off each question's own bank metadata for reporting,
 *    and no re-tagging is asked for. The spec is explicit that the step is
 *    "skipped entirely (not just disabled/greyed out)", and it is right: a
 *    greyed-out stage still reads as work outstanding.
 *
 *  • QUESTIONS goes only when there is ONE section. Then there is genuinely
 *    nothing to decide — every picked question can only go in the one place.
 *    With several sections the stage stays, because the question it asks
 *    ("what does each section contain?") is still live; only the SHAPE of the
 *    answer changes, from a per-cell matrix to an assignment. Inventing a
 *    separate stage for that would have split one question across two rail
 *    rows depending on a toggle three stages earlier.
 *
 * Subjects stays throughout. It is still how the paper is labelled and still
 * narrows the pool the manual picker offers.
 */
export function visibleBuilderStages(opts: {
  fixedPaper: boolean;
  sectionCount: number;
}): StageDef[] {
  if (!opts.fixedPaper) return [...BUILDER_STAGES];
  const drop = new Set<BuilderStage>(['topics']);
  if (opts.sectionCount <= 1) drop.add('questions');
  return BUILDER_STAGES.filter((s) => !drop.has(s.id));
}

// ══════════════════════════════════════════════════════════════════
// STAGE LOCKING
// ══════════════════════════════════════════════════════════════════
//
// While an assessment is being CREATED, a stage opens once every required
// stage before it is done. Three gates fall out of the required set — Basics
// unlocks the middle of the flow, Sections unlocks Questions, Questions
// unlocks the settings and allocation at the end — and the optional stages
// never block anything, which is the whole reason there are three gates and
// not nine.
//
// ── WHY THIS IS NOT THE WIZARD COMING BACK ────────────────────────
// The header of this file argues at length against the three-step wizard the
// rail replaced, and that argument still holds. Two things keep this from
// being the same mistake:
//
//   It applies to CREATION ONLY. The wizard's worst failure was editing — it
//   insists on a beginning for something already finished, so changing a
//   deadline on a live exam meant walking six screens. A saved assessment is
//   freely navigable, always.
//
//   Unlocking is PERMANENT for the session. Completeness is re-derived from
//   the draft on every keystroke, so a rule that only looked forward would
//   re-lock eight stages the moment an author cleared the title to retype it.
//   The caller holds the set of stages that have ever opened and never
//   removes from it; see AssessmentPanel.
//
// Backwards navigation is never gated, and neither is saving a draft. An
// author must always be able to leave with their work.

export type StageLock =
  | { open: true }
  /** Shut, the required stage holding it shut, and what would open it. */
  | { open: false; blockedBy: StageDef; reason: string };

const OPEN: StageLock = { open: true };

export function stageLock(
  id: BuilderStage,
  opts: {
    /** The visible stages, in order — locks are computed over what the rail shows. */
    stages: readonly StageDef[];
    statusFor: (id: BuilderStage) => StageStatus;
    /** Stages that have already opened this session. Never shrinks. */
    unlocked: ReadonlySet<BuilderStage>;
    /** False for an edit, or once the draft has been saved: nothing is gated. */
    gated: boolean;
  },
): StageLock {
  if (!opts.gated) return OPEN;
  if (opts.unlocked.has(id)) return OPEN;

  const i = opts.stages.findIndex((s) => s.id === id);
  // A stage the rail is not showing cannot be reasoned about; treating it as
  // open is the harmless direction, since nothing can navigate to it either.
  if (i === -1) return OPEN;

  for (const before of opts.stages.slice(0, i)) {
    if (!before.required) continue;
    const status = opts.statusFor(before.id);
    if (status.state !== 'done') {
      return {
        open: false,
        blockedBy: before,
        reason: status.blocker ?? `Finish ${before.label} to continue`,
      };
    }
  }
  return OPEN;
}

/** Every stage that is open right now — what the caller folds into its set. */
export function openStages(opts: {
  stages: readonly StageDef[];
  statusFor: (id: BuilderStage) => StageStatus;
  unlocked: ReadonlySet<BuilderStage>;
  gated: boolean;
}): BuilderStage[] {
  return opts.stages.filter((s) => stageLock(s.id, opts).open).map((s) => s.id);
}

/**
 * The stage before / after this one, or null at either end.
 *
 * Every forward and back affordance in the builder reads the order from here
 * rather than naming a destination inline. That is not tidiness: the "Continue
 * to Grading → Security → Allocation" chain in DetailsStep was written as a
 * hardcoded ladder, so moving Security in this list would have left three
 * buttons pointing at stages that no longer follow each other, in a part of
 * the UI that still looked entirely correct until an author clicked it.
 *
 * Pass the VISIBLE stages when a draft hides some, or Continue will walk into
 * a stage the rail does not show.
 */
export function nextStageOf(
  id: BuilderStage,
  stages: readonly StageDef[] = BUILDER_STAGES,
): StageDef | null {
  const i = stages.findIndex((s) => s.id === id);
  return i === -1 ? null : stages[i + 1] ?? null;
}

export function prevStageOf(
  id: BuilderStage,
  stages: readonly StageDef[] = BUILDER_STAGES,
): StageDef | null {
  const i = stages.findIndex((s) => s.id === id);
  return i > 0 ? stages[i - 1] : null;
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
  /**
   * What to DO about it, as an imperative — shown on the Continue button of
   * whichever stage this one is blocking.
   *
   * Lives here rather than in the lock because it is the other half of the
   * completeness rule: whoever decides a stage is unfinished is the only one
   * who knows what would finish it. Required stages set it when 'todo'.
   */
  blocker?: string;
};

/**
 * What the rail needs to know about the draft.
 *
 * `sections` are the EFFECTIVE sections — run them through withEffectiveRules
 * first. A dormant topic matrix left in place would make an empty hand-picked
 * section look full, and a dormant manual list would do the same in reverse.
 */
export type DraftShape = {
  title: string;
  subjectPool: string[];
  topicPool: string[];
  sections: SectionDraft[];
  /** What the Question Source row itself has to report. `pending` covers the
   *  moment before the bank list has loaded, when a bank-restricted pool looks
   *  empty and is not. */
  source: { mode: QuestionPoolMode; poolSize: number | null; anchors: number; pending: boolean };
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

/**
 * Is this section SET UP — does it have an identity?
 *
 * A name, and nothing else. Not a time limit: an untimed section is a real
 * thing the data model supports and documents (`timeLimit: undefined` = no
 * per-section limit), and demanding one to call the stage finished would make
 * every author invent a number to get past a gate. It stays on the stage as a
 * field worth filling, not as a condition of progress.
 *
 * Not whether it draws any questions either — that is the Questions stage's
 * business, and reporting the same shortfall on two rows teaches authors to
 * read neither.
 *
 * This used to demand all three and was called by nothing, which is how the
 * rail came to show "1 incomplete" on a section the publish path was perfectly
 * happy to ship. It is now the shared predicate: the rail, the lock and the
 * publish validator all ask this one question.
 */
export function sectionIsComplete(s: SectionDraft): boolean {
  return s.name.trim().length > 0;
}

export function stageStatus(id: BuilderStage, d: DraftShape): StageStatus {
  switch (id) {
    case 'basics':
      return d.title.trim()
        ? { state: 'done' }
        : { state: 'todo', detail: 'Title needed', blocker: 'Add a title to continue' };

    // Optional, so never 'todo'. An empty pool is not an unfinished decision,
    // it is the widest possible answer — "every subject I can see" — and an
    // amber dot on a stage the author has correctly skipped is the fastest way
    // to teach them that the dots mean nothing.
    case 'subjects':
      return d.subjectPool.length > 0
        ? { state: 'done', detail: String(d.subjectPool.length) }
        : { state: 'neutral', detail: 'All' };

    case 'topics':
      return d.topicPool.length > 0
        ? { state: 'done', detail: String(d.topicPool.length) }
        : { state: 'neutral', detail: 'All' };

    // Structure only — a section is "set up" once it has a name. Whether it
    // draws any questions is the next stage's business, and reporting that
    // shortfall here would put the same warning on two rows.
    case 'sections': {
      const n = d.sections.length;
      if (n === 0) return { state: 'todo', blocker: 'Add a section to continue' };
      const unnamed = d.sections.filter((s) => !sectionIsComplete(s)).length;
      return unnamed === 0
        ? { state: 'done', detail: String(n) }
        : {
            state: 'todo',
            detail: `${unnamed} unnamed`,
            blocker: `Name ${unnamed === 1 ? 'the unnamed section' : 'every section'} to continue`,
          };
    }

    case 'questions': {
      if (d.sections.length === 0) {
        return { state: 'todo', blocker: 'Add a section to continue' };
      }
      const empty = d.sections.filter((s) => !sectionIsAnswerable(s)).length;
      return empty === 0
        ? { state: 'done' }
        : {
            state: 'todo',
            detail: `${empty} empty`,
            blocker: empty === 1
              ? 'Give the empty section at least one question to continue'
              : 'Give every section at least one question to continue',
          };
    }

    // ── Question Source ──────────────────────────────────────────
    //
    // Optional, because 'all' is a real answer and the commonest one — an
    // author who never opens this stage draws from their whole bank, which is
    // what the builder did before the stage existed.
    //
    // The exception is a pool the author DID narrow and then emptied: a bank
    // mode with no banks ticked, or a manual mode with nothing picked, is a
    // paper with nothing to draw from. That is not a default, it is a
    // half-finished decision, and every later stage will be empty because of
    // it — so it is worth the amber dot here rather than four mystifying ones
    // downstream.
    case 'questionSource': {
      const { mode, poolSize, anchors, pending } = d.source;
      const anchorDetail = anchors > 0 ? ` · ${anchors} pinned` : '';
      if (mode === 'all') {
        return anchors > 0
          ? { state: 'neutral', detail: `All${anchorDetail}` }
          : { state: 'neutral', detail: 'All' };
      }
      // Say nothing rather than something wrong: a bank pool reads as empty
      // until the bank list arrives, and an amber "No banks" on a correctly
      // configured assessment is a false alarm the author cannot act on.
      if (pending) return { state: 'neutral' };
      if (poolSize === 0) {
        return {
          state: 'todo',
          detail: mode === 'banks' ? 'No banks' : 'Nothing picked',
        };
      }
      return {
        state: 'done',
        detail: `${poolSize ?? 0} Q${anchorDetail}`,
      };
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

/** Pass the EFFECTIVE sections — see DraftShape. */
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
