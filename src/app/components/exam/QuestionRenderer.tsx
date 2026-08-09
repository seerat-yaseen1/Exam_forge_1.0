/**
 * QuestionRenderer — Answer mode
 *
 * Renders a question for student answering. Deliberately does NOT expose:
 *   - correctIds / correctPairs (correct answer data)
 *   - modelAnswer
 *   - explanation
 *
 * Handles every engine: MCQ, Text, Match, and Code.
 */

import { useMemo, useRef, useEffect, useState, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckSquare, Square, ChevronDown, Flag } from 'lucide-react';
import { RichText } from '../questions/RichText';
import { GROUP_KIND_LABEL } from '../../../lib/questionBankService';
import { itemTypeForQuestion } from '../../../lib/itemTypes';
import type {
  Question, MCQOption, MatchPair, ExamQuestionGroup, MCQVariant, TextVariant,
} from '../../../lib/questionBankService';
import type { AnswerValue } from '../../../lib/submissionService';
import type { ReportReason } from '../../../lib/questionReportService';
import { useIsMobile } from '../../hooks/useIsMobile';
import { SplitPane } from './SplitPane';
import type { CodeAnswerValue, CodeSpec } from './codeAnswer';
import type { JudgeLanguage, SampleRunResponse } from './judgeTypes';

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
  border: '1px solid var(--ef-border)',
  background: 'var(--ef-surface)',
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
              border: isSelected ? '1.5px solid var(--ef-ink)' : '1px solid var(--ef-border)',
              background: isSelected ? 'var(--ef-canvas)' : 'var(--ef-surface)',
            }}
          >
            {/* Radio indicator */}
            <div
              className="flex items-center justify-center flex-shrink-0 mt-0.5"
              style={{
                width: 18, height: 18,
                borderRadius: '50%',
                border: `1.5px solid ${isSelected ? 'var(--ef-ink)' : 'var(--ef-text-muted)'}`,
                background: isSelected ? 'var(--ef-ink)' : 'transparent',
                transition: 'all 0.12s',
              }}
            >
              {isSelected && (
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ef-surface)' }} />
              )}
            </div>
            {/* Letter label */}
            <span
              className="flex-shrink-0 text-xs"
              style={{
                color: isSelected ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
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
                style={{ fontSize: 13, color: 'var(--ef-ink)', lineHeight: '1.6' }}
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
      {/* "Select all that apply" alone reads as "tick any that happen to fit",
          which a candidate can satisfy with a single box and move on. The
          checkbox shape is the only other signal, and it is easy to miss on a
          phone. So the instruction states the fact — more than one option IS
          correct — and is set in ink rather than muted grey, because it is a
          rule of the question, not a hint about the interface. */}
      <p
        className="text-xs mb-3"
        style={{ color: 'var(--ef-ink)', fontWeight: 500 }}
      >
        More than one option is correct — select all that apply.
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
              border: isSelected ? '1.5px solid var(--ef-ink)' : '1px solid var(--ef-border)',
              background: isSelected ? 'var(--ef-canvas)' : 'var(--ef-surface)',
            }}
          >
            {/* Checkbox indicator */}
            <div
              className="flex items-center justify-center flex-shrink-0 mt-0.5"
              style={{
                width: 18, height: 18,
                borderRadius: 2,
                border: `1.5px solid ${isSelected ? 'var(--ef-ink)' : 'var(--ef-text-muted)'}`,
                background: isSelected ? 'var(--ef-ink)' : 'transparent',
                transition: 'all 0.12s',
              }}
            >
              {isSelected && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M1.5 5L4 7.5L8.5 2.5" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
            <span className="flex-shrink-0 text-xs" style={{ color: isSelected ? 'var(--ef-ink)' : 'var(--ef-text-muted)', minWidth: 14 }}>
              {letter}.
            </span>
            <div className="flex-1 min-w-0">
              <RichText
                text={opt.text}
                image={opt.image}
                style={{ fontSize: 13, color: 'var(--ef-ink)', lineHeight: '1.6' }}
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
          background: 'var(--ef-canvas-raised)',
          border: '1px solid var(--ef-border)',
          borderRadius: 3,
          padding: '12px 14px',
          fontSize: 13,
          color: 'var(--ef-ink)',
          lineHeight: 1.7,
          fontFamily: 'inherit',
          transition: 'border-color 0.12s, background 0.12s',
          minHeight: variant === 'long' ? 200 : 80,
        }}
        onFocus={(e) => {
          e.target.style.borderColor = 'var(--ef-ink)';
          e.target.style.background = 'var(--ef-surface)';
        }}
        onBlur={(e) => {
          e.target.style.borderColor = 'var(--ef-border)';
          e.target.style.background = 'var(--ef-canvas-raised)';
        }}
      />
      <div className="flex items-center justify-between mt-2">
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
          {variant === 'long'
            ? 'Write a detailed response. Your answer is saved automatically.'
            : 'Provide a concise answer. Your answer is saved automatically.'}
        </p>
        {value.trim().length > 0 && (
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
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
      <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)' }}>
        Match each item in Column A with the correct item in Column B.
      </p>

      {/* Column headers */}
      <div className="grid gap-3" style={{ gridTemplateColumns: '1fr auto 1fr' }}>
        <p className="text-xs px-2" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>COLUMN A</p>
        <div style={{ width: 20 }} />
        <p className="text-xs px-2" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>COLUMN B</p>
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
                background: 'var(--ef-canvas-raised)',
                border: '1px solid var(--ef-border)',
                borderRadius: 3,
                minHeight: 48,
              }}
            >
              <RichText
                text={pair.leftText}
                image={pair.leftImage}
                style={{ fontSize: 13, color: 'var(--ef-ink)', lineHeight: '1.6' }}
              />
            </div>

            {/* Arrow */}
            <div style={{ color: 'var(--ef-text-muted)', fontSize: 16, userSelect: 'none' }}>→</div>

            {/* Right dropdown */}
            <div className="relative">
              <select
                value={selectedRightId}
                onChange={(e) => handleSelect(pair.leftId, e.target.value)}
                className="w-full outline-none appearance-none"
                style={{
                  background: isMatched ? 'var(--ef-canvas)' : 'var(--ef-surface)',
                  border: isMatched ? '1.5px solid var(--ef-ink)' : '1px solid var(--ef-border)',
                  borderRadius: 3,
                  padding: '10px 36px 10px 12px',
                  fontSize: 13,
                  color: selectedRightId ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
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
                style={{ right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ef-text-muted)' }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Variant → control mapping
//
// Both switches are EXHAUSTIVE over their variant union, enforced by the
// `never` assignment in the default arm. That is the whole point of writing
// them as functions rather than inline conditions: this file is where a
// forgotten variant becomes a blank answer area in a live exam — the candidate
// sees a question and no way to answer it — and a blank card is not something
// any test or type-check would otherwise catch. Adding a member to MCQVariant
// or TextVariant now fails the build here until it is given a control.
//
// The runtime fallbacks are the safe shapes rather than nothing, for the same
// reason the server scores an unknown mcq variant as a single selection: a
// slightly wrong control still lets a candidate answer.
// ──────────────────────────────────────────────────────────────────

function mcqMode(variant: MCQVariant): 'single' | 'multi' {
  switch (variant) {
    case 'multi':
      return 'multi';
    case 'single':
    case 'truefalse':
    case 'fillblank':
    // Output Prediction is a keyed one-of-N over candidate outputs; the snippet
    // it asks about is already rendered by RichText from the stem's fenced block.
    case 'outputpred':
      return 'single';
    default: {
      const _exhaustive: never = variant;
      return 'single';
    }
  }
}

function textMode(variant: TextVariant): 'short' | 'long' {
  switch (variant) {
    case 'short':
      return 'short';
    case 'long':
    // A code review is an extended written response; it needs the tall box.
    case 'codereview':
      return 'long';
    default: {
      const _exhaustive: never = variant;
      return 'long';
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────────────────────────

// The editor and its grammars are lazy: a candidate sitting an MCQ paper has
// no reason to download CodeMirror. React.lazy here, dynamic import inside.
const CodeAnswerEditor = lazy(() =>
  import('./CodeAnswerEditor').then((m) => ({ default: m.CodeAnswerEditor })));

interface QuestionRendererProps {
  question: Question;
  marks: number;              // from the assessment's question config
  questionNumber: number;     // 1-based display number
  totalQuestions: number;
  answer: AnswerValue | undefined;
  onAnswer: (value: AnswerValue) => void;
  /**
   * Runs a coding answer's visible tests. Supplied by ExamShell, which owns the
   * callable. Absent means the run button is not offered — which is the correct
   * rendering wherever there is no live exam behind the question (preview,
   * review), rather than a button that cannot work.
   */
  onRunCode?: (
    questionId: string,
    language: JudgeLanguage,
    source: string,
  ) => Promise<SampleRunResponse>;
  /**
   * Telemetry sink. ABSENT MEANS DO NOT RECORD — the shell supplies it only
   * when the security tier permits, so withholding it is how "practice is
   * never recorded" reaches the editor.
   */
  onCodeTelemetry?: (questionId: string, events: unknown[], seq: number) => void;
  // Optional report-this-question controls — buffered in ExamShell
  flagReason?: ReportReason | null;
  onFlagChange?: (reason: ReportReason | null) => void;

  // ── Grouped sets (Phase 1) ────────────────────────────────────────
  /** The shared stimulus, when this question belongs to a group. */
  group?: ExamQuestionGroup | null;
  /** This question's 1-based position within its set, and the set's size. */
  groupPosition?: { index: number; total: number } | null;
}

// ══════════════════════════════════════════════════════════════════
// STIMULUS PANEL (Phase 1)
// ══════════════════════════════════════════════════════════════════

/**
 * A DI table.
 *
 * Rendered from structure rather than shown as an image so it can reflow,
 * be zoomed without losing the row the candidate was on, and be read aloud.
 * Rows arrive as `{ cells: [...] }` because Firestore cannot store nested
 * arrays. Scrolls inside its own container: a wide table must never push the
 * page sideways, and on a phone it will be wider than the viewport.
 */
function StimulusTable({ table }: { table: NonNullable<ExamQuestionGroup['stimulus']['table']> }) {
  return (
    <figure className="my-3">
      {table.caption && (
        <figcaption className="text-xs mb-2" style={{ color: 'var(--ef-text-muted)' }}>
          {table.caption}
        </figcaption>
      )}
      <div style={{ overflowX: 'auto', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
          {table.headers.length > 0 && (
            <thead>
              <tr>
                {table.headers.map((h, i) => (
                  <th
                    key={i}
                    scope="col"
                    style={{
                      textAlign: 'left', padding: '7px 10px', whiteSpace: 'nowrap',
                      background: 'var(--ef-canvas)', color: 'var(--ef-ink)',
                      borderBottom: '1px solid var(--ef-border)', fontWeight: 600,
                    }}
                  >
                    <RichText text={h} style={{ fontSize: 13 }} />
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {table.rows.map((row, ri) => (
              <tr key={ri}>
                {(row.cells ?? []).map((cell, ci) => (
                  <td
                    key={ci}
                    style={{
                      padding: '7px 10px', color: 'var(--ef-ink)',
                      borderBottom: ri === table.rows.length - 1 ? 'none' : '1px solid var(--ef-border)',
                    }}
                  >
                    <RichText text={cell} style={{ fontSize: 13 }} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/** The shared stimulus itself — passage, table, figures, or a mix. */
export function StimulusBody({ group }: { group: ExamQuestionGroup }) {
  const { stimulus } = group;
  return (
    <>
      {stimulus.body && (
        <RichText
          text={stimulus.body}
          style={{ fontSize: 14.5, color: 'var(--ef-ink)', lineHeight: '1.8', display: 'block' }}
        />
      )}
      {stimulus.table && <StimulusTable table={stimulus.table} />}
      {stimulus.images.map((src, i) => (
        <img
          key={i}
          src={src}
          alt=""
          className="my-3"
          style={{ maxWidth: '100%', height: 'auto', display: 'block', borderRadius: 2 }}
        />
      ))}
    </>
  );
}

/** Header line shared by both stimulus layouts. */
export function StimulusHeading({
  group, groupPosition,
}: { group: ExamQuestionGroup; groupPosition?: { index: number; total: number } | null }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span
        className="text-xs px-2 py-0.5 select-none"
        style={{
          background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)',
          borderRadius: 2, color: 'var(--ef-text-muted)', fontSize: 10,
          letterSpacing: '0.04em',
        }}
      >
        {GROUP_KIND_LABEL[group.kind] ?? 'Grouped Set'}
      </span>
      {groupPosition && (
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
          Question {groupPosition.index} of {groupPosition.total} in this set
        </span>
      )}
    </div>
  );
}

/**
 * Phone layout: the stimulus collapses.
 *
 * Side-by-side is impossible below ~768px, and stacking a 600-word passage
 * above the options would put the answer area off-screen on every question of
 * the set. It starts OPEN, because a candidate meeting the set for the first
 * time needs to read it, and closing is one tap once they have.
 */
function CollapsibleStimulus({
  group, groupPosition,
}: { group: ExamQuestionGroup; groupPosition?: { index: number; total: number } | null }) {
  const [open, setOpen] = useState(true);
  return (
    <div
      className="mb-5"
      style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-canvas-raised)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left"
      >
        <StimulusHeading group={group} groupPosition={groupPosition} />
        <ChevronDown
          size={16}
          style={{
            color: 'var(--ef-text-muted)', flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.18s',
          }}
        />
      </button>
      {open && (
        <div
          className="px-3 pb-3"
          style={{ maxHeight: '45vh', overflowY: 'auto', borderTop: '1px solid var(--ef-border)', paddingTop: 12 }}
        >
          <StimulusBody group={group} />
        </div>
      )}
    </div>
  );
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
          background: isFlagged ? '#FEF9EC' : 'var(--ef-surface)',
          border: `1px solid ${isFlagged ? 'var(--ef-warning-border)' : 'var(--ef-border)'}`,
          borderRadius: 2,
          color: isFlagged ? 'var(--ef-warning)' : 'var(--ef-text-muted)',
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
              background: 'var(--ef-surface)',
              border: '1px solid var(--ef-border)',
              borderRadius: 3,
              boxShadow: '0 4px 16px rgba(12,12,11,0.08)',
            }}
          >
            <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
              <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
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
                      background: selected ? 'var(--ef-canvas)' : 'transparent',
                      color: 'var(--ef-ink)',
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {isFlagged && (
              <div className="px-3 py-2" style={{ borderTop: '1px solid var(--ef-border-subtle)' }}>
                <button
                  onClick={() => { onChange(null); setOpen(false); }}
                  className="text-xs"
                  style={{ color: 'var(--ef-danger)', cursor: 'pointer' }}
                >
                  Remove report
                </button>
              </div>
            )}
            <div className="px-3 py-2" style={{ borderTop: '1px solid var(--ef-border-subtle)' }}>
              <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
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
  onRunCode,
  onCodeTelemetry,
  flagReason,
  onFlagChange,
  group,
  groupPosition,
}: QuestionRendererProps) {
  const isMobile = useIsMobile();

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

  // Named from the item-type registry, so the chip a candidate reads mid-exam
  // says the same thing the author picked in the question bank. Falls back to
  // the engine name for a shape the registry doesn't know — a blank chip in a
  // live exam is worse than a rough one.
  const badgeText = itemTypeForQuestion(question.engine, question.variant)?.label
    ?? question.engine.toUpperCase();

  // ── Question column ───────────────────────────────────────────
  // Everything below the stimulus: header, stem, answer area. Extracted so
  // the two layouts (side-by-side on desktop, stacked on phones) can share it
  // verbatim rather than duplicating the answer engines.
  // ── The two halves of a question ──────────────────────────────
  //
  // Split apart so a CODING question can put the prompt in one pane and the
  // editor in the other. Every other engine renders them one after another in
  // a single column exactly as before — `questionColumn` below reassembles
  // them, so there is one definition of each half rather than two arrangements
  // that can drift.
  const promptBlock = (
    <>
        {/* Phone: the stimulus sits above the question and collapses. */}
        {group && isMobile && (
          <CollapsibleStimulus group={group} groupPosition={groupPosition} />
        )}

        {/* Question header */}
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="flex items-center gap-2">
            <span
              className="text-xs px-2 py-0.5 select-none"
              style={{
                background: 'var(--ef-ink)', color: 'var(--ef-surface)',
                borderRadius: 2, letterSpacing: '0.04em', fontSize: 10,
              }}
            >
              {badgeText}
            </span>
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
              Q{questionNumber} of {totalQuestions}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span
              className="text-xs px-2 py-0.5"
              style={{
                background: 'var(--ef-canvas)',
                border: '1px solid var(--ef-border)',
                borderRadius: 2,
                color: 'var(--ef-text-muted)',
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
              color: 'var(--ef-ink)',
              lineHeight: '1.75',
              display: 'block',
            }}
          />
        </div>
    </>
  );

  const answerBlock = (
        <div>
          {question.engine === 'mcq' && (
            mcqMode(question.variant as MCQVariant) === 'multi' ? (
              <MCQMultiEngine
                options={question.options}
                selected={mcqMultiValue}
                onChange={onAnswer}
              />
            ) : (
              <MCQSingleEngine
                options={question.options}
                selected={mcqSingleValue}
                onChange={onAnswer}
              />
            )
          )}

          {question.engine === 'text' && (
            <TextEngine
              variant={textMode(question.variant as TextVariant)}
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

          {question.engine === 'code' && (
            <Suspense fallback={<div className="p-4 text-sm opacity-60">Loading editor…</div>}>
              <CodeAnswerEditor
                questionId={question.id}
                codeSpec={(question as { codeSpec?: CodeSpec }).codeSpec}
                value={
                  answer && typeof answer === 'object' && !Array.isArray(answer)
                    ? (answer as unknown as CodeAnswerValue)
                    : null
                }
                onChange={(v) => onAnswer(v as unknown as AnswerValue)}
                onRun={onRunCode ? (lang, src) => onRunCode(question.id, lang, src) : undefined}
                onTelemetry={
                  onCodeTelemetry
                    ? (events, seq) => onCodeTelemetry(question.id, events, seq)
                    : undefined
                }
              />
            </Suspense>
          )}
        </div>
  );

  /** Both halves, stacked — every engine but coding, and coding on a phone. */
  const questionColumn = (
    <div className="px-8 py-6 flex-1">
      {promptBlock}
      {answerBlock}
    </div>
  );

  // ── Narrow screen ─────────────────────────────────────────────
  // One scrolling column for everything. A split pane needs width that is not
  // there, and a 40%-wide code editor is worse than a stacked one.
  if (isMobile) {
    return (
      <div className="flex flex-col h-full overflow-y-auto">
        {questionColumn}
      </div>
    );
  }

  // ── Coding on a wide screen: prompt left, editor right ────────
  //
  // The convention every candidate arrives with, and for the reason the
  // grouped split already gives: the spec — input format, output format, the
  // worked example — is re-read continuously WHILE the program is written, and
  // a stacked layout makes that a scroll each time.
  //
  // It also stops the editor being a letterbox. Stacked, it sat at its minimum
  // height with the right half of a widescreen empty; here it takes a whole
  // column.
  //
  // A grouped coding question puts the stimulus above the prompt in the SAME
  // pane rather than adding a third: the candidate needs the editor at full
  // height more than they need the stimulus and the stem apart, and three
  // panes on one screen is not a layout anyone can work in.
  if (question.engine === 'code') {
    return (
      <SplitPane
        storageKey="ef.split.code"
        leftLabel="Question"
        rightLabel="Code editor"
        left={
          <>
            {group && (
              <div className="mb-5">
                <StimulusHeading group={group} groupPosition={groupPosition} />
                <div className="mt-2"><StimulusBody group={group} /></div>
              </div>
            )}
            {promptBlock}
          </>
        }
        right={<div className="px-6 py-6 h-full">{answerBlock}</div>}
      />
    );
  }

  // ── Standalone, non-coding ────────────────────────────────────
  // One scrolling column, exactly as before Phase 1.
  if (!group) {
    return (
      <div className="flex flex-col h-full overflow-y-auto">
        {questionColumn}
      </div>
    );
  }

  // ── Grouped set on a wide screen: split pane ──────────────────
  //
  // The two panes scroll INDEPENDENTLY, which is the entire point. Stacking
  // them in one scroller means a candidate on question 4 of a DI set has to
  // scroll the chart back into view for every question, and loses their place
  // in the options each time they do. Side-by-side keeps the stimulus fixed
  // while the questions change under it — which is how the paper reads on
  // paper, and what the format assumes.
  //
  // Now the SAME pane the coding layout uses, and therefore draggable. It was
  // a fixed 44%, which is a reasonable guess and wrong for a wide table or a
  // long passage; more to the point, one exam with two side-by-side layouts
  // that behave differently is a difference a candidate has to discover
  // mid-paper. Its own storage key, because how much room a chart wants and
  // how much room an editor wants are not the same preference.
  return (
    <SplitPane
      storageKey="ef.split.stimulus"
      leftLabel="Stimulus"
      rightLabel="Question"
      left={
        <>
          <div className="mb-4">
            <StimulusHeading group={group} groupPosition={groupPosition} />
          </div>
          <StimulusBody group={group} />
        </>
      }
      right={questionColumn}
    />
  );
}
