/**
 * builder/shared — types, constants and pure helpers shared across the
 * assignments list and builder (Batch F1a: extracted verbatim from
 * AssignmentsPage.tsx; no logic changes).
 */
import {
  manualSectionLists,
  type AssessmentStatus,
  type QuestionSource,
  type RuleKind,
} from '../../../../lib/assessmentService';
import { type ExecutionEngine } from '../../../../lib/itemTypes';
import { type GroupKind } from '../../../../lib/questionBankService';

export type Difficulty = 'easy' | 'medium' | 'hard';

export type RuleDraft = {
  /** Absent = 'topic' — matches QuestionSelectionRule's legacy-safe default. */
  kind?: RuleKind;
  subject: string;
  topic: string;           // specific topic within subject
  difficulty: Difficulty;
  count: string;           // string for <input> binding
  marksPerQuestion: string;

  // ── Group-rule fields (kind === 'group') ──────────────────────────
  // Strings for <input> binding, same as `count`.
  groupKind?: GroupKind;
  groupCount?: string;
  /** '' or 'all' means every child of the drawn group. */
  questionsPerGroup?: string;

  // ── Hand-picked selection (topic / group kinds) ───────────────────
  fixedQuestionIds?: string[];
  fixedGroupIds?: string[];

  /**
   * Manual-rule payload (kind === 'manual'): the questions themselves, in the
   * author's order. subject/topic/difficulty are carried but meaningless on
   * this kind — a hand-built paper spans cells — and are written as '' so the
   * draft shape stays one object rather than a union the whole builder would
   * have to narrow.
   */
  questionIds?: string[];
};

/**
 * The rules that COUNT, given how the paper is being built.
 *
 * `fixedPaper` is Manual Selection with Randomize off: the one arrangement in
 * which the author's list IS the paper and no draw happens. In every other
 * arrangement a manual rule is dormant, and in that one every topic and group
 * rule is.
 *
 * Nothing is deleted on the switch. An author who builds a topic matrix, flips
 * to a hand-picked paper and flips back ten seconds later still has their
 * matrix — which is only true because the inactive kind is filtered out here
 * rather than removed from the draft.
 */
export function effectiveRules(rules: RuleDraft[], fixedPaper: boolean): RuleDraft[] {
  return rules.filter((r) => (r.kind === 'manual') === fixedPaper);
}

/**
 * The sections as the paper will actually be built, given the question source.
 *
 * The manual rule is DERIVED here rather than stored on the section draft, and
 * that is the whole design. A stored copy of the author's picks would be a
 * second source of truth that has to be kept in step with the picker on every
 * keystroke — add a question, remove one, switch modes, add a section — and
 * every one of those is a chance for the paper to disagree with the pool the
 * author is looking at. Deriving it means the two cannot drift.
 *
 * `manualMarks` still lives on the section draft, because what a question is
 * worth in this paper is a decision the author made and nothing else can
 * reconstruct — and it is PER SECTION, because a paper split into a short-answer
 * section and an essay section is not one where every question is worth the
 * same.
 *
 * Which questions land where comes from manualSectionLists, which is also what
 * the assignment panel reads. One derivation, so the panel showing "12 in
 * Section B" and the paper that gets published cannot disagree.
 */
export function withEffectiveRules(
  sections: SectionDraft[],
  opts: { fixedPaper: boolean; source: QuestionSource },
): SectionDraft[] {
  if (!opts.fixedPaper) {
    return sections.map((s) => ({ ...s, rules: effectiveRules(s.rules, false) }));
  }
  const lists = manualSectionLists(opts.source, sections.map((s) => s.id));
  return sections.map((s) => {
    const ids = lists[s.id] ?? [];
    return {
      ...s,
      rules: ids.length > 0
        ? [{
            kind: 'manual' as const,
            subject: '',
            topic: '',
            difficulty: 'easy' as Difficulty,
            count: '',
            marksPerQuestion: s.manualMarks || '1',
            questionIds: ids,
          }]
        : [],
    };
  });
}

/**
 * How many questions a DRAFT rule contributes.
 *
 * The draft twin of ruleQuestionCount in assessmentService: same null-means-
 * unknowable contract, because a group drawing 'all' of its children cannot be
 * counted until the draw happens. Builder totals and the "at least 1 question"
 * publish check both go through this so neither has to narrow the draft shape
 * itself — and so neither silently counts a group rule as zero.
 */
export function draftQuestionCount(r: RuleDraft): number | null {
  if (r.kind === 'manual') return r.questionIds?.length ?? 0;
  if (r.kind === 'group') {
    const groups = parseInt(r.groupCount ?? '', 10) || 0;
    const per = r.questionsPerGroup;
    if (!per || per === 'all') return null;
    const perN = parseInt(per, 10) || 0;
    return groups * perN;
  }
  if (r.fixedQuestionIds && r.fixedQuestionIds.length > 0) return r.fixedQuestionIds.length;
  return parseInt(r.count, 10) || 0;
}

/** True when the rule asks for anything at all — the "is this row live?" test. */
export function draftIsLive(r: RuleDraft): boolean {
  if (r.kind === 'manual') return (r.questionIds?.length ?? 0) > 0;
  if (r.kind === 'group') return (parseInt(r.groupCount ?? '', 10) || 0) > 0;
  if (r.fixedQuestionIds && r.fixedQuestionIds.length > 0) return true;
  return (parseInt(r.count, 10) || 0) > 0;
}

/** Marks a draft rule contributes, or null when its count is unknowable. */
export function draftTotalMarks(r: RuleDraft): number | null {
  const n = draftQuestionCount(r);
  return n === null ? null : n * (parseFloat(r.marksPerQuestion) || 0);
}

export type SectionDraft = {
  id: string;
  name: string;
  timeLimit: string;
  questionTimeLimit: string;   // seconds per question (linear/adaptive); '' = off
  rules: RuleDraft[];
  assignedTopics: string[]; // "subject::topic" keys pre-assigned in Step 1
  breakAfterMinutes: string;  // empty = no break
  breakMandatory: boolean;

  /**
   * Execution engines this section accepts — the draft twin of
   * AssessmentSection.engines. Empty = unlocked, which is both the default for
   * a new section and what every existing assessment loads as.
   */
  engines: ExecutionEngine[];

  /**
   * Marks per question for a hand-picked, non-randomized paper. '' = 1.
   *
   * The only part of a manual rule that is not derivable from the pool, so the
   * only part stored — see withEffectiveRules.
   */
  manualMarks: string;
};

export function makeSectionId() {
  return `sec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export const SECTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function defaultSectionName(idx: number) {
  return `Section ${SECTION_LETTERS[idx] ?? idx + 1}`;
}

export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

export const DIFF_LABEL: Record<Difficulty, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

export const DIFF_COLORS: Record<Difficulty, { bg: string; text: string; border: string }> = {
  easy:   { bg: 'var(--ef-success-bg)', text: 'var(--ef-success-strong)', border: 'var(--ef-success-border)' },
  medium: { bg: 'var(--ef-warning-bg)', text: 'var(--ef-warning)', border: 'var(--ef-warning-border)' },
  hard:   { bg: 'var(--ef-danger-bg)', text: 'var(--ef-danger)', border: 'var(--ef-danger-border)' },
};

// ── Date/time helpers ─────────────────────────────────────────────

export function toDateTimeLocal(iso?: string): string {
  if (!iso) return '';
  return iso.slice(0, 16);
}

export function fromDateTimeLocal(val: string): string {
  if (!val) return '';
  return new Date(val).toISOString();
}

// Local-time formatter for the datetime-local input (avoids the UTC drift
// caused by .toISOString().slice(0,16) on non-UTC timezones).
export function dateToInputLocal(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Date formatting lives in lib/dateFormat (audit F-7) ───────────
//
// These two were the last local formatters. They were closer to correct than
// the eleven folded in earlier — both already returned the em dash for an
// ABSENT value — but neither handled an UNPARSEABLE one, so a malformed
// startDate rendered "Invalid Date" on an assessment row:
//
//   undefined     -> —              (guarded)
//   ''            -> —              (guarded)
//   'not-a-date'  -> Invalid Date   ← the gap
//   '   '         -> Invalid Date   ← and whitespace, which `!iso` reads as set
//
// Re-exported under their existing names so the three consumers
// (AssessmentRow, AssessmentModals, DetailsStep) are untouched: same
// placeholder, same formats, plus the guard they were missing.
export {
  truncate,
  formatDate as formatDateShort,
  formatDateTime,
} from '../../../../lib/dateFormat';

// ── Status badge ──────────────────────────────────────────────────

export type FieldMutability = {
  targetType: boolean;
  startDate: boolean;
  endDate: boolean | 'extend-only';
  shuffleQuestions: boolean;
  sections: boolean;
};

export function mutabilityFor(status?: AssessmentStatus): FieldMutability {
  if (!status || status === 'draft') {
    return { targetType: true, startDate: true, endDate: true, shuffleQuestions: true, sections: true };
  }
  if (status === 'active') {
    return { targetType: false, startDate: false, endDate: 'extend-only', shuffleQuestions: false, sections: false };
  }
  // closed
  return { targetType: false, startDate: false, endDate: false, shuffleQuestions: false, sections: false };
}

// ── Overall time limit — Auto default ─────────────────────────────
// The "full budget" a student could legitimately consume across the whole
// sitting, in minutes:
//
//   Σ section time limits
// + Σ section grace  (one grace window per TIMED section — a section with no
//                     time limit has nothing to be graced, so it is skipped)
// + Σ break durations
// + overall grace    (the single trailing buffer on the whole-exam clock)
//
// Used to pre-fill the builder's "Overall time limit" field when Auto is on,
// and kept in sync live as sections/breaks/grace change. The teacher can turn
// Auto off and type their own value. DEFAULT_SECTION_GRACE_SECONDS /
// DEFAULT_OVERALL_GRACE_SECONDS below mirror the server defaults — keep in
// sync with functions/src/index.ts.
export const DEFAULT_SECTION_GRACE_SECONDS = 30;
export const DEFAULT_OVERALL_GRACE_SECONDS = 30;

// Rounded UP: the field is whole minutes, and the budget must never come out
// SHORTER than the real sum of parts, or the auto value would itself trip the
// "manual limit is less than sum of sections + breaks" warning.
export function computeAutoOverallLimit(
  sections: SectionDraft[],
  sectionGraceSeconds: number = DEFAULT_SECTION_GRACE_SECONDS,
  overallGraceSeconds: number = DEFAULT_OVERALL_GRACE_SECONDS,
): number {
  const timedSections = sections.filter((s) => (parseInt(s.timeLimit, 10) || 0) > 0);

  const sectionMins = timedSections.reduce((sum, s) => sum + (parseInt(s.timeLimit, 10) || 0), 0);
  // Breaks live on all sections EXCEPT the last (a break after the final
  // section is meaningless), matching buildSections / the publish warning.
  const breakMins = sections
    .slice(0, -1)
    .reduce((sum, s) => sum + (parseInt(s.breakAfterMinutes, 10) || 0), 0);

  const sectionGraceMins = (timedSections.length * sectionGraceSeconds) / 60;
  const overallGraceMins = overallGraceSeconds / 60;

  return Math.ceil(sectionMins + breakMins + sectionGraceMins + overallGraceMins);
}

// The bare sum of section time limits + break durations, in minutes — the
// floor below which a manual overall limit is impossible to finish (students
// literally cannot complete every section). Used for the save-time soft
// warning. Grace is NOT included here: grace is slack, not usable exam time,
// so a limit that omits grace is tight but not impossible.
export function sumSectionsAndBreaksMinutes(sections: SectionDraft[]): number {
  const sectionMins = sections.reduce((sum, s) => sum + (parseInt(s.timeLimit, 10) || 0), 0);
  const breakMins = sections
    .slice(0, -1)
    .reduce((sum, s) => sum + (parseInt(s.breakAfterMinutes, 10) || 0), 0);
  return sectionMins + breakMins;
}

// ── Published-section variants (for the post-publish edit panel) ──
// Same math as the two helpers above, but reading the resolved Assessment
// shape (numeric timeLimit / breakAfter.durationMinutes) instead of the
// builder's string-typed SectionDraft. Kept minimal — only the two the edit
// panel needs.
type PublishedSectionLike = {
  timeLimit?: number;
  breakAfter?: { durationMinutes?: number } | null;
};

export function computeAutoOverallLimitFromSections(
  sections: PublishedSectionLike[],
  sectionGraceSeconds: number = DEFAULT_SECTION_GRACE_SECONDS,
  overallGraceSeconds: number = DEFAULT_OVERALL_GRACE_SECONDS,
): number {
  const timed = sections.filter((s) => (s.timeLimit ?? 0) > 0);
  const sectionMins = timed.reduce((sum, s) => sum + (s.timeLimit ?? 0), 0);
  const breakMins = sections
    .slice(0, -1)
    .reduce((sum, s) => sum + (s.breakAfter?.durationMinutes ?? 0), 0);
  const sectionGraceMins = (timed.length * sectionGraceSeconds) / 60;
  const overallGraceMins = overallGraceSeconds / 60;
  return Math.ceil(sectionMins + breakMins + sectionGraceMins + overallGraceMins);
}

export function sumSectionsAndBreaksMinutesFromSections(
  sections: PublishedSectionLike[],
): number {
  const sectionMins = sections.reduce((sum, s) => sum + (s.timeLimit ?? 0), 0);
  const breakMins = sections
    .slice(0, -1)
    .reduce((sum, s) => sum + (s.breakAfter?.durationMinutes ?? 0), 0);
  return sectionMins + breakMins;
}

// ── Friendly schedule controls ────────────────────────────────────