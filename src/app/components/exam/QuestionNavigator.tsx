/**
 * QuestionNavigator
 *
 * Left-panel sidebar listing all questions in the current section.
 * Shows answered / unanswered / current state.
 * Clicking a question number jumps to that question.
 */

import { motion } from 'motion/react';
import { CheckCircle2 } from 'lucide-react';
import type { AttemptAnswer } from '../../../lib/submissionService';
import type { GroupKind } from '../../../lib/questionBankService';

// ── Props ──────────────────────────────────────────────────────────

interface QuestionNavigatorProps {
  /** Ordered question IDs for the current section (possibly shuffled). */
  questionIds: string[];
  /** The student's current answers (keyed by questionId). */
  answers: Record<string, AttemptAnswer>;
  /** 0-based index of the currently displayed question. */
  currentQIdx: number;
  /** Called when the student clicks a question chip. */
  onSelectQ: (idx: number) => void;
  /** Section name for the header. */
  sectionName: string;
  /** Total sections in the assessment (for context). */
  totalSections: number;
  /** 1-based index of the current section. */
  currentSectionNumber: number;

  // ── Grouped sets (Phase 1) ────────────────────────────────────────
  /** questionId → the group it belongs to, when it belongs to one. */
  groupIdByQuestion?: Record<string, string | null | undefined>;
  /** groupId → its kind, for the band label. */
  groupKindById?: Record<string, GroupKind>;

  /**
   * Where this navigator is being drawn.
   *
   * 'sidebar' (default) is the desktop column: a fixed 200px, four chips to a
   * row. 'sheet' is the phone's bottom sheet, which is as wide as the screen —
   * so it fills its container and fits six chips per row, which turns a
   * 40-question section from ten rows of scrolling into seven.
   *
   * A prop rather than a `useIsMobile()` call inside this component, because
   * the answer is not "is the viewport narrow" — it is "which of the two
   * places did my caller put me", and on a tablet in landscape those differ.
   */
  layout?: 'sidebar' | 'sheet';
}

// ── Chip runs (Phase 1) ────────────────────────────────────────────
//
// The navigator's whole job is telling a candidate where they are. Without
// banding, a grouped set is eight identical chips and nothing says questions
// 4-8 share a passage — so a candidate who answers 4 and jumps to 12 has no
// way to know they abandoned a set halfway, and no way to find their way back
// to it except by clicking through.
//
// Group members are contiguous in questionIds (startExam guarantees it), so a
// single pass over the list produces the runs.

type ChipRun =
  | { kind: 'solo'; ids: string[]; startIdx: number }
  | { kind: 'group'; ids: string[]; startIdx: number; groupId: string; groupKind?: GroupKind; ordinal: number };

function buildRuns(
  questionIds: string[],
  groupIdByQuestion: Record<string, string | null | undefined> | undefined,
  groupKindById: Record<string, GroupKind> | undefined,
): ChipRun[] {
  const runs: ChipRun[] = [];
  const ordinalByGroup = new Map<string, number>();

  questionIds.forEach((qid, idx) => {
    const gid = groupIdByQuestion?.[qid] || null;
    const last = runs[runs.length - 1];

    if (!gid) {
      if (last && last.kind === 'solo') last.ids.push(qid);
      else runs.push({ kind: 'solo', ids: [qid], startIdx: idx });
      return;
    }

    if (last && last.kind === 'group' && last.groupId === gid) {
      last.ids.push(qid);
      return;
    }

    if (!ordinalByGroup.has(gid)) ordinalByGroup.set(gid, ordinalByGroup.size + 1);
    runs.push({
      kind: 'group',
      ids: [qid],
      startIdx: idx,
      groupId: gid,
      groupKind: groupKindById?.[gid],
      ordinal: ordinalByGroup.get(gid)!,
    });
  });

  return runs;
}

/** "Passage 2 · Q7–11" — short enough for a 200px rail. */
function runLabel(run: Extract<ChipRun, { kind: 'group' }>): string {
  const noun =
    run.groupKind === 'rc' ? 'Passage'
    : run.groupKind === 'di' ? 'Data set'
    : run.groupKind === 'caselet' ? 'Caselet'
    : run.groupKind === 'puzzle' ? 'Puzzle'
    : run.groupKind === 'seating' ? 'Arrangement'
    : 'Set';
  const first = run.startIdx + 1;
  const last = run.startIdx + run.ids.length;
  const span = first === last ? `Q${first}` : `Q${first}–${last}`;
  return `${noun} ${run.ordinal} · ${span}`;
}

// ── Helpers ────────────────────────────────────────────────────────

export function isAnswered(questionId: string, answers: Record<string, AttemptAnswer>): boolean {
  return answerHasContent(answers[questionId]);
}

/**
 * Does this answer carry anything the student would call an answer?
 *
 * Split out of `isAnswered` so the one rule has one implementation. ExamShell
 * needed the same question ("is there anything at risk here?") and had grown
 * its own `isAnswerEmpty`, which dispatched on the VALUE's shape rather than
 * on the type and therefore had no coding arm at all — a cleared editor read
 * as content. Two predicates for one fact is how they drift; this is the fact.
 */
export function answerHasContent(answer: AttemptAnswer | undefined): boolean {
  if (!answer) return false;

  const { type, value } = answer;

  // CODE IS DETECTED BY SHAPE, NOT ONLY BY TYPE, and that is deliberate.
  //
  // Until answerTypeForEngine landed, every coding answer was stored with
  // type 'match'. Those answers exist — on finished papers, and on attempts
  // that were in flight when the fix deployed — and reading one as a match
  // answer counts `{ language, source: '' }` as answered on the strength of
  // its two keys. Keying on the shape rather than the label means this reads
  // an old answer and a new one identically, with no migration.
  //
  // Both keys are required. A match value is Record<leftId, rightId>, so
  // demanding `language` AND `source` puts a false positive out of reach.
  if (isCodeAnswerValue(type, value)) {
    // A CODING QUESTION IS NOT ANSWERED BECAUSE AN EDITOR HAS TEXT IN IT.
    //
    // Coding questions ship starter code, so the naive "value is non-empty"
    // test every other engine uses would mark every coding question answered
    // the moment it was rendered — the navigator would show a full grid and
    // "all questions answered" on a paper nobody had touched.
    //
    // The comparison against the starter lives at the WRITE side: the editor
    // does not save an answer until the source differs from what it was given,
    // so an untouched question has no answer document at all and is caught by
    // the `!answer` check above. This branch is the second half of that — a
    // candidate who selects all and deletes has emptied their answer, and an
    // empty editor is not an attempt.
    const source = (value as Record<string, string>).source;
    return typeof source === 'string' && source.trim().length > 0;
  }

  if (type === 'mcq') {
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === 'string' && value.length > 0;
  }

  if (type === 'text') {
    return typeof value === 'string' && value.trim().length > 0;
  }

  if (type === 'match') {
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.keys(value as Record<string, string>).length > 0;
  }

  return false;
}

/**
 * Is this stored answer a coding answer?
 *
 * `type === 'code'` is the answer written by a current client. The shape test
 * beside it is what reads answers written before `answerTypeForEngine`, which
 * carry `type: 'match'` over a code value — see the note in `answerHasContent`.
 * A code value that is not an object (a corrupt document, or a client that
 * sent a bare string) is NOT treated as code: it falls through to the engine
 * branches, which all refuse it, and an unreadable answer is not an answer.
 */
function isCodeAnswerValue(type: AttemptAnswer['type'], value: AttemptAnswer['value']): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (type === 'code') return true;
  return typeof v.language === 'string' && typeof v.source === 'string';
}

// ── Component ──────────────────────────────────────────────────────

export function QuestionNavigator({
  questionIds,
  answers,
  currentQIdx,
  onSelectQ,
  sectionName,
  totalSections,
  currentSectionNumber,
  groupIdByQuestion,
  groupKindById,
  layout = 'sidebar',
}: QuestionNavigatorProps) {
  const isSheet = layout === 'sheet';
  // Six across in the sheet, four in the 200px rail. The chip is also taller
  // there: 32px is comfortable for a mouse and below the ~44px that a finger
  // hits reliably, and in the sheet these chips ARE the navigation.
  const chipColumns = isSheet ? 6 : 4;
  const chipHeight = isSheet ? 44 : 32;
  const answered = questionIds.filter((id) => isAnswered(id, answers)).length;
  const total = questionIds.length;

  const runs = buildRuns(questionIds, groupIdByQuestion, groupKindById);
  const hasGroups = runs.some((r) => r.kind === 'group');

  // One chip. Identical in both layouts — banding changes the surroundings,
  // never the chip itself, so a candidate reads position the same way.
  const renderChip = (qId: string, idx: number) => {
    const isAns = isAnswered(qId, answers);
    const isCurrent = idx === currentQIdx;
    return (
      <motion.button
        key={qId}
        onClick={() => onSelectQ(idx)}
        whileTap={{ scale: 0.92 }}
        title={`Question ${idx + 1}${isAns ? ' (answered)' : ' (unanswered)'}`}
        className="relative flex items-center justify-center text-xs transition-all"
        style={{
          height: chipHeight,
          borderRadius: 2,
          cursor: 'pointer',
          // Kills the mobile double-tap-zoom delay. In the sheet these chips
          // are the primary way to move between questions, and a tap that
          // appears not to have registered gets tapped again.
          touchAction: 'manipulation',
          border: isCurrent
            ? '2px solid var(--ef-ink)'
            : isAns
              ? '1px solid var(--ef-success-border)'
              : '1px solid var(--ef-border)',
          background: isCurrent
            ? 'var(--ef-ink)'
            : isAns
              ? 'var(--ef-success-bg)'
              : 'var(--ef-surface)',
          color: isCurrent
            ? 'var(--ef-surface)'
            : isAns
              ? 'var(--ef-success-strong)'
              : 'var(--ef-text-muted)',
        }}
      >
        {idx + 1}
        {isAns && !isCurrent && (
          <span
            className="absolute"
            style={{
              top: 2, right: 2,
              width: 4, height: 4,
              borderRadius: '50%',
              background: 'var(--ef-success-strong)',
            }}
          />
        )}
      </motion.button>
    );
  };

  const progressPct = total > 0 ? (answered / total) * 100 : 0;

  return (
    <div
      className="flex flex-col h-full"
      style={{
        // The sidebar's 200px was hard-coded here, which meant the component
        // could only ever BE a sidebar. In the sheet it fills the screen width
        // instead, and drops the right-hand rule that separated it from the
        // question — in a sheet there is nothing to its right to separate from.
        width: isSheet ? '100%' : 200,
        flexShrink: 0,
        background: 'var(--ef-canvas-raised)',
        borderRight: isSheet ? 'none' : '1px solid var(--ef-border)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        className="px-4 py-4 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--ef-border)' }}
      >
        {totalSections > 1 && (
          <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
            SECTION {currentSectionNumber} OF {totalSections}
          </p>
        )}
        <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>{sectionName}</p>

        {/* Progress bar */}
        <div
          className="mt-3"
          style={{ height: 3, background: 'var(--ef-border)', borderRadius: 2 }}
        >
          <div
            style={{
              height: '100%',
              width: `${progressPct}%`,
              background: 'var(--ef-success-strong)',
              borderRadius: 2,
              transition: 'width 0.4s ease',
            }}
          />
        </div>
        <p className="text-xs mt-1.5" style={{ color: 'var(--ef-text-muted)' }}>
          {answered}/{total} answered
        </p>
      </div>

      {/* Question chips — scrollable */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {/* Runs: standalone questions in a plain grid, grouped sets banded so
            a candidate can see at a glance which questions share a stimulus. */}
        <div className="space-y-2">
          {runs.map((run, ri) =>
            run.kind === 'solo' ? (
              <div
                key={`solo-${ri}`}
                className="grid gap-1.5"
                style={{ gridTemplateColumns: `repeat(${chipColumns}, 1fr)` }}
              >
                {run.ids.map((qId, i) => renderChip(qId, run.startIdx + i))}
              </div>
            ) : (
              <div
                key={`grp-${run.groupId}-${ri}`}
                style={{
                  border: '1px solid var(--ef-border)',
                  borderRadius: 2,
                  background: 'var(--ef-canvas)',
                  padding: 6,
                }}
              >
                <p
                  className="text-xs mb-1.5 px-0.5"
                  style={{ color: 'var(--ef-text-muted)', fontSize: 12, letterSpacing: '0.04em' }}
                >
                  {runLabel(run)}
                </p>
                <div
                  className="grid gap-1.5"
                  style={{ gridTemplateColumns: `repeat(${chipColumns}, 1fr)` }}
                >
                  {run.ids.map((qId, i) => renderChip(qId, run.startIdx + i))}
                </div>
              </div>
            ),
          )}
        </div>

        {/* Legend */}
        <div className="mt-4 space-y-1.5">
          <div className="flex items-center gap-2">
            <div style={{ width: 12, height: 12, borderRadius: 2, background: 'var(--ef-ink)', flexShrink: 0 }} />
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Current</span>
          </div>
          <div className="flex items-center gap-2">
            <div style={{ width: 12, height: 12, borderRadius: 2, background: 'var(--ef-success-bg)', border: '1px solid var(--ef-success-border)', flexShrink: 0 }} />
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Answered</span>
          </div>
          <div className="flex items-center gap-2">
            <div style={{ width: 12, height: 12, borderRadius: 2, background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', flexShrink: 0 }} />
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Unanswered</span>
          </div>
          {hasGroups && (
            <div className="flex items-center gap-2">
              <div style={{ width: 12, height: 12, borderRadius: 2, background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', flexShrink: 0 }} />
              <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Shared passage / data</span>
            </div>
          )}
        </div>
      </div>

      {/* Summary footer */}
      {answered === total && total > 0 && (
        <div
          className="flex items-center gap-2 px-4 py-3 flex-shrink-0"
          style={{ borderTop: '1px solid var(--ef-border)', background: 'var(--ef-success-bg)' }}
        >
          <CheckCircle2 size={13} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)' }} />
          <p className="text-xs" style={{ color: 'var(--ef-success-strong)' }}>All answered</p>
        </div>
      )}
    </div>
  );
}
