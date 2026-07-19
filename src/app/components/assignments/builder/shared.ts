/**
 * builder/shared — types, constants and pure helpers shared across the
 * assignments list and builder (Batch F1a: extracted verbatim from
 * AssignmentsPage.tsx; no logic changes).
 */
import { type AssessmentStatus } from '../../../../lib/assessmentService';

export type Difficulty = 'easy' | 'medium' | 'hard';

export type RuleDraft = {
  subject: string;
  topic: string;           // specific topic within subject
  difficulty: Difficulty;
  count: string;           // string for <input> binding
  marksPerQuestion: string;
};

export type SectionDraft = {
  id: string;
  name: string;
  timeLimit: string;
  questionTimeLimit: string;   // seconds per question (linear/adaptive); '' = off
  rules: RuleDraft[];
  assignedTopics: string[]; // "subject::topic" keys pre-assigned in Step 1
  breakAfterMinutes: string;  // empty = no break
  breakMandatory: boolean;
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
  easy:   { bg: '#F0F9F4', text: '#1E7B3C', border: '#B8E6C8' },
  medium: { bg: '#FEF9EC', text: '#92680A', border: '#F5DFA0' },
  hard:   { bg: '#FDF5F5', text: '#9B2828', border: '#F2CECE' },
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

export function formatDateTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

export function formatDateShort(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export const truncate = (s: string, n = 100) => (s.length > n ? s.slice(0, n) + '…' : s);

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