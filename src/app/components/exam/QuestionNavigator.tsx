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
}

// ── Helpers ────────────────────────────────────────────────────────

function isAnswered(questionId: string, answers: Record<string, AttemptAnswer>): boolean {
  const answer = answers[questionId];
  if (!answer) return false;

  const { type, value } = answer;

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

// ── Component ──────────────────────────────────────────────────────

export function QuestionNavigator({
  questionIds,
  answers,
  currentQIdx,
  onSelectQ,
  sectionName,
  totalSections,
  currentSectionNumber,
}: QuestionNavigatorProps) {
  const answered = questionIds.filter((id) => isAnswered(id, answers)).length;
  const total = questionIds.length;

  const progressPct = total > 0 ? (answered / total) * 100 : 0;

  return (
    <div
      className="flex flex-col h-full"
      style={{
        width: 200,
        flexShrink: 0,
        background: '#FAFAF8',
        borderRight: '1px solid #E3E1DB',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        className="px-4 py-4 flex-shrink-0"
        style={{ borderBottom: '1px solid #E3E1DB' }}
      >
        {totalSections > 1 && (
          <p className="text-xs mb-1" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
            SECTION {currentSectionNumber} OF {totalSections}
          </p>
        )}
        <p className="text-xs" style={{ color: '#0C0C0B' }}>{sectionName}</p>

        {/* Progress bar */}
        <div
          className="mt-3"
          style={{ height: 3, background: '#E3E1DB', borderRadius: 2 }}
        >
          <div
            style={{
              height: '100%',
              width: `${progressPct}%`,
              background: '#1E7B3C',
              borderRadius: 2,
              transition: 'width 0.4s ease',
            }}
          />
        </div>
        <p className="text-xs mt-1.5" style={{ color: '#6B6B66' }}>
          {answered}/{total} answered
        </p>
      </div>

      {/* Question chips — scrollable */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div
          className="grid gap-1.5"
          style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}
        >
          {questionIds.map((qId, idx) => {
            const answered = isAnswered(qId, answers);
            const isCurrent = idx === currentQIdx;

            return (
              <motion.button
                key={qId}
                onClick={() => onSelectQ(idx)}
                whileTap={{ scale: 0.92 }}
                title={`Question ${idx + 1}${answered ? ' (answered)' : ' (unanswered)'}`}
                className="relative flex items-center justify-center text-xs transition-all"
                style={{
                  height: 32,
                  borderRadius: 2,
                  cursor: 'pointer',
                  border: isCurrent
                    ? '2px solid #0C0C0B'
                    : answered
                      ? '1px solid #B8E6C8'
                      : '1px solid #E3E1DB',
                  background: isCurrent
                    ? '#0C0C0B'
                    : answered
                      ? '#F0F9F4'
                      : '#FFFFFF',
                  color: isCurrent
                    ? '#FFFFFF'
                    : answered
                      ? '#1E7B3C'
                      : '#6B6B66',
                }}
              >
                {idx + 1}
                {/* Answered dot */}
                {answered && !isCurrent && (
                  <span
                    className="absolute"
                    style={{
                      top: 2, right: 2,
                      width: 4, height: 4,
                      borderRadius: '50%',
                      background: '#1E7B3C',
                    }}
                  />
                )}
              </motion.button>
            );
          })}
        </div>

        {/* Legend */}
        <div className="mt-4 space-y-1.5">
          <div className="flex items-center gap-2">
            <div style={{ width: 12, height: 12, borderRadius: 2, background: '#0C0C0B', flexShrink: 0 }} />
            <span className="text-xs" style={{ color: '#6B6B66' }}>Current</span>
          </div>
          <div className="flex items-center gap-2">
            <div style={{ width: 12, height: 12, borderRadius: 2, background: '#F0F9F4', border: '1px solid #B8E6C8', flexShrink: 0 }} />
            <span className="text-xs" style={{ color: '#6B6B66' }}>Answered</span>
          </div>
          <div className="flex items-center gap-2">
            <div style={{ width: 12, height: 12, borderRadius: 2, background: '#FFFFFF', border: '1px solid #E3E1DB', flexShrink: 0 }} />
            <span className="text-xs" style={{ color: '#6B6B66' }}>Unanswered</span>
          </div>
        </div>
      </div>

      {/* Summary footer */}
      {answered === total && total > 0 && (
        <div
          className="flex items-center gap-2 px-4 py-3 flex-shrink-0"
          style={{ borderTop: '1px solid #E3E1DB', background: '#F0F9F4' }}
        >
          <CheckCircle2 size={13} strokeWidth={1.5} style={{ color: '#1E7B3C' }} />
          <p className="text-xs" style={{ color: '#1E7B3C' }}>All answered</p>
        </div>
      )}
    </div>
  );
}
