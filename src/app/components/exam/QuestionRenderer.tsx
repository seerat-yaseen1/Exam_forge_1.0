/**
 * QuestionRenderer — Answer mode
 *
 * Renders a question for student answering. Deliberately does NOT expose:
 *   - correctIds / correctPairs (correct answer data)
 *   - modelAnswer
 *   - explanation
 *
 * Handles all three engines: MCQ, Text, Match.
 */

import { useMemo, useRef, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckSquare, Square, ChevronDown, Flag } from 'lucide-react';
import { RichText } from '../questions/RichText';
import type { Question, MCQOption, MatchPair } from '../../../lib/questionBankService';
import type { AnswerValue } from '../../../lib/submissionService';
import type { ReportReason } from '../../../lib/questionReportService';

// ── Shared styles ─────────────────────────────────────────────────

const OPTION_BASE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '12px 14px',
  borderRadius: 3,
  cursor: 'pointer',
  transition: 'all 0.12s',
  textAlign: 'left',
  width: '100%',
  border: '1px solid #E3E1DB',
  background: '#FFFFFF',
};

// ──────────────────────────────────────────────────────────────────
// MCQ Engine — single / truefalse / fillblank
// Radio-button style: only one option selectable.
// ──────────────────────────────────────────────────────────────────

function MCQSingleEngine({
  options,
  selected,
  onChange,
}: {
  options: MCQOption[];
  selected: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      {options.map((opt, idx) => {
        const isSelected = selected === opt.id;
        const letter = String.fromCharCode(65 + idx); // A, B, C, D…
        return (
          <motion.button
            key={opt.id}
            whileTap={{ scale: 0.995 }}
            onClick={() => onChange(opt.id)}
            style={{
              ...OPTION_BASE,
              border: isSelected ? '1.5px solid #0C0C0B' : '1px solid #E3E1DB',
              background: isSelected ? '#F7F6F3' : '#FFFFFF',
            }}
          >
            {/* Radio indicator */}
            <div
              className="flex items-center justify-center flex-shrink-0 mt-0.5"
              style={{
                width: 18, height: 18,
                borderRadius: '50%',
                border: `1.5px solid ${isSelected ? '#0C0C0B' : '#6B6B66'}`,
                background: isSelected ? '#0C0C0B' : 'transparent',
                transition: 'all 0.12s',
              }}
            >
              {isSelected && (
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#FFFFFF' }} />
              )}
            </div>
            {/* Letter label */}
            <span
              className="flex-shrink-0 text-xs"
              style={{
                color: isSelected ? '#0C0C0B' : '#6B6B66',
                fontWeight: isSelected ? 500 : 400,
                minWidth: 14,
              }}
            >
              {letter}.
            </span>
            {/* Option content */}
            <div className="flex-1 min-w-0">
              <RichText
                text={opt.text}
                image={opt.image}
                style={{ fontSize: 13, color: '#0C0C0B', lineHeight: '1.6' }}
              />
            </div>
          </motion.button>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// MCQ Engine — multi
// Checkbox style: multiple options selectable.
// ──────────────────────────────────────────────────────────────────

function MCQMultiEngine({
  options,
  selected,
  onChange,
}: {
  options: MCQOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) => {
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs mb-3" style={{ color: '#6B6B66' }}>
        Select all that apply.
      </p>
      {options.map((opt, idx) => {
        const isSelected = selected.includes(opt.id);
        const letter = String.fromCharCode(65 + idx);
        return (
          <motion.button
            key={opt.id}
            whileTap={{ scale: 0.995 }}
            onClick={() => toggle(opt.id)}
            style={{
              ...OPTION_BASE,
              border: isSelected ? '1.5px solid #0C0C0B' : '1px solid #E3E1DB',
              background: isSelected ? '#F7F6F3' : '#FFFFFF',
            }}
          >
            {/* Checkbox indicator */}
            <div
              className="flex items-center justify-center flex-shrink-0 mt-0.5"
              style={{
                width: 18, height: 18,
                borderRadius: 2,
                border: `1.5px solid ${isSelected ? '#0C0C0B' : '#6B6B66'}`,
                background: isSelected ? '#0C0C0B' : 'transparent',
                transition: 'all 0.12s',
              }}
            >
              {isSelected && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M1.5 5L4 7.5L8.5 2.5" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
            <span className="flex-shrink-0 text-xs" style={{ color: isSelected ? '#0C0C0B' : '#6B6B66', minWidth: 14 }}>
              {letter}.
            </span>
            <div className="flex-1 min-w-0">
              <RichText
                text={opt.text}
                image={opt.image}
                style={{ fontSize: 13, color: '#0C0C0B', lineHeight: '1.6' }}
              />
            </div>
          </motion.button>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Text Engine
// Textarea for short/long answer questions.
// ──────────────────────────────────────────────────────────────────

function TextEngine({
  variant,
  value,
  onChange,
}: {
  variant: 'short' | 'long';
  value: string;
  onChange: (v: string) => void;
}) {
  const rows = variant === 'long' ? 10 : 4;
  const placeholder =
    variant === 'long'
      ? 'Write your answer here…'
      : 'Write your short answer here…';

  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full outline-none resize-y"
        style={{
          background: '#FAFAF8',
          border: '1px solid #E3E1DB',
          borderRadius: 3,
          padding: '12px 14px',
          fontSize: 13,
          color: '#0C0C0B',
          lineHeight: 1.7,
          fontFamily: 'inherit',
          transition: 'border-color 0.12s, background 0.12s',
          minHeight: variant === 'long' ? 200 : 80,
        }}
        onFocus={(e) => {
          e.target.style.borderColor = '#0C0C0B';
          e.target.style.background = '#FFFFFF';
        }}
        onBlur={(e) => {
          e.target.style.borderColor = '#E3E1DB';
          e.target.style.background = '#FAFAF8';
        }}
      />
      <div className="flex items-center justify-between mt-2">
        <p className="text-xs" style={{ color: '#6B6B66' }}>
          {variant === 'long'
            ? 'Write a detailed response. Your answer is saved automatically.'
            : 'Provide a concise answer. Your answer is saved automatically.'}
        </p>
        {value.trim().length > 0 && (
          <p className="text-xs" style={{ color: '#6B6B66' }}>
            {value.trim().split(/\s+/).filter(Boolean).length} words
          </p>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Match Engine
// Left column: fixed labels. Right column: shuffled dropdown.
// Uses seeded Fisher-Yates for a stable shuffle per question.
// ──────────────────────────────────────────────────────────────────

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function MatchEngine({
  pairs,
  value,
  onChange,
}: {
  pairs: MatchPair[];
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  // Stable shuffle based on the sum of char codes across all rightIds
  const seed = useMemo(
    () => pairs.reduce((acc, p) => acc + p.rightId.split('').reduce((a, c) => a + c.charCodeAt(0), 0), 0),
    [pairs]
  );

  const shuffledRight = useMemo(
    () =>
      seededShuffle(
        pairs.map((p) => ({ id: p.rightId, text: p.rightText, image: p.rightImage })),
        seed
      ),
    [pairs, seed]
  );

  const handleSelect = (leftId: string, rightId: string) => {
    onChange({ ...value, [leftId]: rightId });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs mb-3" style={{ color: '#6B6B66' }}>
        Match each item in Column A with the correct item in Column B.
      </p>

      {/* Column headers */}
      <div className="grid gap-3" style={{ gridTemplateColumns: '1fr auto 1fr' }}>
        <p className="text-xs px-2" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>COLUMN A</p>
        <div style={{ width: 20 }} />
        <p className="text-xs px-2" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>COLUMN B</p>
      </div>

      {pairs.map((pair, idx) => {
        const selectedRightId = value[pair.leftId] ?? '';
        const isMatched = !!selectedRightId;

        return (
          <div
            key={pair.leftId}
            className="grid items-center gap-3"
            style={{ gridTemplateColumns: '1fr auto 1fr' }}
          >
            {/* Left item */}
            <div
              className="px-3 py-3"
              style={{
                background: '#FAFAF8',
                border: '1px solid #E3E1DB',
                borderRadius: 3,
                minHeight: 48,
              }}
            >
              <RichText
                text={pair.leftText}
                image={pair.leftImage}
                style={{ fontSize: 13, color: '#0C0C0B', lineHeight: '1.6' }}
              />
            </div>

            {/* Arrow */}
            <div style={{ color: '#6B6B66', fontSize: 16, userSelect: 'none' }}>→</div>

            {/* Right dropdown */}
            <div className="relative">
              <select
                value={selectedRightId}
                onChange={(e) => handleSelect(pair.leftId, e.target.value)}
                className="w-full outline-none appearance-none"
                style={{
                  background: isMatched ? '#F7F6F3' : '#FFFFFF',
                  border: isMatched ? '1.5px solid #0C0C0B' : '1px solid #E3E1DB',
                  borderRadius: 3,
                  padding: '10px 36px 10px 12px',
                  fontSize: 13,
                  color: selectedRightId ? '#0C0C0B' : '#6B6B66',
                  cursor: 'pointer',
                  minHeight: 48,
                  transition: 'all 0.12s',
                }}
              >
                <option value="" disabled>Select…</option>
                {shuffledRight.map((r) => (
                  <option key={r.id} value={r.id}>{r.text}</option>
                ))}
              </select>
              <ChevronDown
                size={13}
                strokeWidth={1.5}
                className="absolute pointer-events-none"
                style={{ right: 10, top: '50%', transform: 'translateY(-50%)', color: '#6B6B66' }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────────────────────────

interface QuestionRendererProps {
  question: Question;
  marks: number;              // from the assessment's question config
  questionNumber: number;     // 1-based display number
  totalQuestions: number;
  answer: AnswerValue | undefined;
  onAnswer: (value: AnswerValue) => void;
  // Optional report-this-question controls — buffered in ExamShell
  flagReason?: ReportReason | null;
  onFlagChange?: (reason: ReportReason | null) => void;
}

const REPORT_OPTIONS: Array<{ value: ReportReason; label: string }> = [
  { value: 'wrong_answer', label: 'Wrong answer / answer key' },
  { value: 'typo',         label: 'Typo or formatting issue' },
  { value: 'ambiguous',    label: 'Unclear / ambiguous wording' },
  { value: 'other',        label: 'Other issue' },
];

function FlagControl({
  reason,
  onChange,
}: {
  reason: ReportReason | null | undefined;
  onChange: (r: ReportReason | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const isFlagged = !!reason;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs px-2 py-0.5"
        style={{
          background: isFlagged ? '#FEF9EC' : '#FFFFFF',
          border: `1px solid ${isFlagged ? '#F5DFA0' : '#E3E1DB'}`,
          borderRadius: 2,
          color: isFlagged ? '#92680A' : '#6B6B66',
          cursor: 'pointer',
        }}
        title={isFlagged ? 'Reported — click to change' : 'Report an issue with this question'}
      >
        <Flag size={11} strokeWidth={1.5} />
        {isFlagged ? 'Reported' : 'Report'}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute z-20"
            style={{
              top: 'calc(100% + 6px)',
              right: 0,
              width: 240,
              background: '#FFFFFF',
              border: '1px solid #E3E1DB',
              borderRadius: 3,
              boxShadow: '0 4px 16px rgba(12,12,11,0.08)',
            }}
          >
            <div className="px-3 py-2" style={{ borderBottom: '1px solid #F0EFEB' }}>
              <p className="text-xs" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
                REPORT THIS QUESTION
              </p>
            </div>
            <div className="py-1">
              {REPORT_OPTIONS.map((opt) => {
                const selected = reason === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() => { onChange(opt.value); setOpen(false); }}
                    className="w-full text-left text-xs px-3 py-2"
                    style={{
                      background: selected ? '#F7F6F3' : 'transparent',
                      color: '#0C0C0B',
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {isFlagged && (
              <div className="px-3 py-2" style={{ borderTop: '1px solid #F0EFEB' }}>
                <button
                  onClick={() => { onChange(null); setOpen(false); }}
                  className="text-xs"
                  style={{ color: '#9B2828', cursor: 'pointer' }}
                >
                  Remove report
                </button>
              </div>
            )}
            <div className="px-3 py-2" style={{ borderTop: '1px solid #F0EFEB' }}>
              <p className="text-xs" style={{ color: '#6B6B66', lineHeight: 1.5 }}>
                Reports are submitted with your exam and reviewed by your evaluator.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function QuestionRenderer({
  question,
  marks,
  questionNumber,
  totalQuestions,
  answer,
  onAnswer,
  flagReason,
  onFlagChange,
}: QuestionRendererProps) {
  // ── Derive current answer in typed form ───────────────────────

  const mcqSingleValue = (typeof answer === 'string' ? answer : '') as string;
  const mcqMultiValue = (Array.isArray(answer) ? answer : []) as string[];
  const textValue = (typeof answer === 'string' ? answer : '') as string;
  const matchValue = (
    typeof answer === 'object' && !Array.isArray(answer) && answer !== null
      ? answer
      : {}
  ) as Record<string, string>;

  // ── Engine badge ──────────────────────────────────────────────

  const badgeText =
    question.engine === 'mcq'
      ? question.variant === 'multi' ? 'MCQ Multi' :
        question.variant === 'truefalse' ? 'True / False' :
        question.variant === 'fillblank' ? 'Fill in the Blank' : 'MCQ'
      : question.engine === 'text'
        ? question.variant === 'long' ? 'Essay' : 'Short Answer'
        : 'Match';

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-8 py-6 flex-1">

        {/* Question header */}
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="flex items-center gap-2">
            <span
              className="text-xs px-2 py-0.5 select-none"
              style={{
                background: '#0C0C0B', color: '#FFFFFF',
                borderRadius: 2, letterSpacing: '0.04em', fontSize: 10,
              }}
            >
              {badgeText}
            </span>
            <span className="text-xs" style={{ color: '#6B6B66' }}>
              Q{questionNumber} of {totalQuestions}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span
              className="text-xs px-2 py-0.5"
              style={{
                background: '#F7F6F3',
                border: '1px solid #E3E1DB',
                borderRadius: 2,
                color: '#6B6B66',
              }}
            >
              {marks} mark{marks !== 1 ? 's' : ''}
            </span>
            {onFlagChange && (
              <FlagControl reason={flagReason ?? null} onChange={onFlagChange} />
            )}
          </div>
        </div>

        {/* Stem */}
        <div className="mb-6">
          <RichText
            text={question.stem}
            image={question.stemImage}
            style={{
              fontSize: 15,
              color: '#0C0C0B',
              lineHeight: '1.75',
              display: 'block',
            }}
          />
        </div>

        {/* Engine-specific answer area */}
        <div>
          {question.engine === 'mcq' && (
            <>
              {(question.variant === 'single' ||
                question.variant === 'truefalse' ||
                question.variant === 'fillblank') && (
                <MCQSingleEngine
                  options={question.options}
                  selected={mcqSingleValue}
                  onChange={onAnswer}
                />
              )}
              {question.variant === 'multi' && (
                <MCQMultiEngine
                  options={question.options}
                  selected={mcqMultiValue}
                  onChange={onAnswer}
                />
              )}
            </>
          )}

          {question.engine === 'text' && (
            <TextEngine
              variant={question.variant as 'short' | 'long'}
              value={textValue}
              onChange={onAnswer}
            />
          )}

          {question.engine === 'match' && (
            <MatchEngine
              pairs={question.pairs}
              value={matchValue}
              onChange={onAnswer}
            />
          )}
        </div>

      </div>
    </div>
  );
}
