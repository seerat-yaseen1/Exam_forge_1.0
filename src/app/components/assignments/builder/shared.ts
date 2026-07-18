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

// ── Friendly schedule controls ────────────────────────────────────