import React, { useState, useRef, useEffect } from 'react';
import { Plus, X, Check, ChevronDown, ChevronLeft, Loader2, AlertTriangle, Eye } from 'lucide-react';
import {
  type Question,
  type QuestionEngine,
  type QuestionVariant,
  type MCQVariant,
  type TextVariant,
  type MCQOption,
  type MatchPair,
  type CorrectPair,
  type Difficulty,
  type QuestionOwnerType,
  buildEmptyMCQ,
  buildEmptyText,
  buildEmptyMatch,
  buildEmptyCode,
  getDuplicateCheckPool,
  findDuplicateCandidates,
  type CodeSpec,
  type CodeTest,
  type CodeVariant,
} from '../../../lib/questionBankService';
import { validateCodeQuestion } from '../../../lib/codeAuthoring';
import { CodeSpecEditor } from './CodeSpecEditor';
import {
  ITEM_CATEGORY_LABEL,
  isItemTypeLive,
  itemTypesInCategory,
  liveQuestionItemTypes,
  populatedCategories,
  type ItemTypeId,
} from '../../../lib/itemTypes';
import {
  scoreAgainstPool,
  verdictFor,
  pct,
  type DuplicateScore,
} from '../../../lib/duplicateDetection';
import { ImageUploader } from './ImageUploader';
import { MathToolbar, InlineMathButton } from './MathToolbar';
import { SnippetToolbar } from './SnippetToolbar';
import { SubjectTopicSelect } from './SubjectTopicSelect';
import { DuplicateCompareModal } from './DuplicateCompareModal';
import type { ParsedRow } from './bulkUploadParser';

// ── Type re-export for consumers ──────────────────────────────────────────────

export type QuestionDraft = Omit<Question, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'>;

// ── Shared styles ─────────────────────────────────────────────────────────────

const inp: React.CSSProperties = {
  background: 'var(--ef-canvas-raised)',
  border: '1px solid var(--ef-border)',
  color: 'var(--ef-ink)',
  borderRadius: 2,
  outline: 'none',
  fontSize: 14,
  padding: '9px 12px',
  width: '100%',
};

function iFocus(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  e.target.style.borderColor = 'var(--ef-ink)';
  e.target.style.background  = 'var(--ef-surface)';
}
function iBlur(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  e.target.style.borderColor = 'var(--ef-border)';
  e.target.style.background  = 'var(--ef-canvas-raised)';
}

// ── Type options ──────────────────────────────────────────────────────────────
//
// Built from the item-type registry (src/lib/itemTypes.ts) rather than typed
// out here, so this drawer offers exactly the types an engine can actually
// build — no more (a card for something half-implemented) and no fewer (a new
// variant that nobody remembered to add to this array).
//
// A few stem-level authoring notes have no place in the registry — "use ___ to
// mark the blank" is advice about this editor, not a property of the item type
// — so they are kept here and appended to the registry's summary.

interface TypeOption {
  engine: QuestionEngine;
  variant: QuestionVariant;
  id: ItemTypeId;
  label: string;
  badge: string;
  description: string;
}

const AUTHORING_HINT: Partial<Record<ItemTypeId, string>> = {
  'fill-blank': 'Use ___ in the stem to mark the blank.',
  'output-prediction': 'Put the code in the stem inside a ```python fence.',
  'code-review': 'Put the code in the stem inside a ```python fence.',
};

const TYPE_OPTIONS: TypeOption[] = liveQuestionItemTypes().map(({ def, engine, variant }) => ({
  engine,
  variant,
  id: def.id,
  label: def.label,
  badge: def.badge,
  description: [def.summary, AUTHORING_HINT[def.id]].filter(Boolean).join(' '),
}));

/**
 * Everything in the taxonomy this drawer cannot build yet.
 *
 * Shown, collapsed, rather than hidden. Faculty asking "where is Numeric
 * Answer?" currently have no way to tell the difference between a type that is
 * missing and one they cannot find, and the honest answer — not built, here is
 * what to use instead — is short enough to just say. Live grouped types are
 * excluded: those exist, they are simply authored from the Sets tab.
 */
const UPCOMING_BY_CATEGORY = populatedCategories()
  .map((category) => ({
    category,
    label: ITEM_CATEGORY_LABEL[category],
    types: itemTypesInCategory(category).filter((t) => !isItemTypeLive(t.id)),
  }))
  .filter((row) => row.types.length > 0);

const UPCOMING_COUNT = UPCOMING_BY_CATEGORY.reduce((n, row) => n + row.types.length, 0);

// ── Type Picker ───────────────────────────────────────────────────────────────

function TypePicker({ onSelect }: { onSelect: (e: QuestionEngine, v: QuestionVariant) => void }) {
  const [showUpcoming, setShowUpcoming] = useState(false);

  return (
    <div>
      <p className="text-xs mb-4" style={{ color: 'var(--ef-text-muted)' }}>
        Select a question type to continue.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {TYPE_OPTIONS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.engine, t.variant)}
            className="text-left p-4 transition-all"
            style={{ border: '1px solid var(--ef-border)', borderRadius: 3, background: 'var(--ef-surface)' }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-ink)';
              (e.currentTarget as HTMLElement).style.background  = 'var(--ef-canvas-raised)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-border)';
              (e.currentTarget as HTMLElement).style.background  = 'var(--ef-surface)';
            }}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className="text-xs px-1.5 py-0.5 select-none"
                style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.04em', fontSize: 12 }}
              >
                {t.badge}
              </span>
              <span className="text-xs" style={{ color: 'var(--ef-ink)' }}>{t.label}</span>
            </div>
            <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>{t.description}</p>
          </button>
        ))}
      </div>

      <p className="text-xs mt-4" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
        Grouped sets — passages, data interpretation, caselets — are authored from the
        Sets tab, not here.
      </p>

      {UPCOMING_COUNT > 0 && (
        <div className="mt-5 pt-4" style={{ borderTop: '1px solid var(--ef-border)' }}>
          <button
            type="button"
            onClick={() => setShowUpcoming((v) => !v)}
            className="flex items-center gap-1.5 text-xs transition-opacity hover:opacity-60"
            style={{ color: 'var(--ef-text-muted)' }}
          >
            <ChevronDown
              size={11}
              strokeWidth={1.5}
              style={{
                transform: showUpcoming ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 120ms ease',
              }}
            />
            Not yet available — {UPCOMING_COUNT} more item types in the taxonomy
          </button>

          {showUpcoming && (
            <div className="mt-3 flex flex-col gap-3">
              {UPCOMING_BY_CATEGORY.map((row) => (
                <div key={row.category}>
                  <div
                    className="text-xs mb-1.5 select-none"
                    style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em', fontSize: 12, textTransform: 'uppercase' }}
                  >
                    {row.label}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {row.types.map((t) => (
                      <span
                        key={t.id}
                        title={t.today ? `${t.summary} Today: ${t.today}` : t.summary}
                        className="text-xs px-2 py-1 select-none"
                        style={{
                          border: '1px dashed var(--ef-border)',
                          borderRadius: 2,
                          color: 'var(--ef-text-muted)',
                          background: 'var(--ef-canvas-raised)',
                        }}
                      >
                        {t.label}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Field wrapper ─────────────────────────────────────────────────────────────

function Field({ label, error, hint, children }: {
  label: string; error?: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <label className="block text-xs mb-1.5" style={{ color: 'var(--ef-text-subtle)' }}>{label}</label>
      {children}
      {hint  && <p className="text-xs mt-1.5" style={{ color: 'var(--ef-text-muted)' }}>{hint}</p>}
      {error && <p className="text-xs mt-1.5" style={{ color: 'var(--ef-danger)' }}>{error}</p>}
    </div>
  );
}

// ── Tag input ─────────────────────────────────────────────────────────────────

function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [input, setInput] = useState('');

  const commit = (raw: string) => {
    const t = raw.trim().toLowerCase().replace(/,/g, '');
    if (!t || tags.includes(t)) { setInput(''); return; }
    onChange([...tags, t]);
    setInput('');
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(input); }
    if (e.key === 'Backspace' && !input && tags.length > 0) onChange(tags.slice(0, -1));
  };

  return (
    <div
      className="flex flex-wrap gap-1.5 items-center p-2 min-h-10"
      style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-canvas-raised)' }}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 px-2 py-0.5 text-xs select-none"
          style={{ background: 'var(--ef-border-subtle)', borderRadius: 2, color: 'var(--ef-text-subtle)' }}
        >
          {tag}
          <button type="button" onClick={() => onChange(tags.filter((t) => t !== tag))} className="hover:opacity-60 transition-opacity">
            <X size={10} strokeWidth={2} />
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKey}
        onBlur={() => { if (input.trim()) commit(input); }}
        placeholder={tags.length === 0 ? 'Type and press Enter or comma…' : ''}
        className="flex-1 text-xs outline-none min-w-24"
        style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 14 }}
      />
    </div>
  );
}

// ── Stem field with math toolbar + image uploader ─────────────────────────────

function StemField({
  stem, stemImage, onStemChange, onStemImageChange, error,
}: {
  stem: string;
  stemImage: string | undefined;
  onStemChange: (v: string) => void;
  onStemImageChange: (url: string | undefined) => void;
  error?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="mb-5">
      {/* Label row + math toolbar */}
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs" style={{ color: 'var(--ef-text-subtle)' }}>Question stem *</label>
        <div className="flex items-center gap-1.5">
          {/* Code before math: on a coding paper the block IS the question,
              and Output Prediction and Code Review both put it in the stem. */}
          <SnippetToolbar textareaRef={textareaRef} value={stem} onChange={onStemChange} />
          <MathToolbar textareaRef={textareaRef} onChange={onStemChange} />
        </div>
      </div>

      <textarea
        ref={textareaRef}
        value={stem}
        onChange={(e) => onStemChange(e.target.value)}
        rows={3}
        placeholder="Enter question text… use $ formula $ for inline math or $$ formula $$ for block math"
        style={{ ...inp, resize: 'vertical', lineHeight: 1.6 }}
        onFocus={iFocus}
        onBlur={iBlur}
      />

      {error && <p className="text-xs mt-1.5" style={{ color: 'var(--ef-danger)' }}>{error}</p>}

      {/* Image attach */}
      <div className="mt-2">
        <ImageUploader
          value={stemImage}
          onChange={onStemImageChange}
          label="Attach image to stem"
        />
      </div>
    </div>
  );
}

// ── MCQ Engine ────────────────────────────────────────────────────────────────

function MCQEngine({
  options, correctIds, variant, onOptionsChange,
}: {
  options: MCQOption[];
  correctIds: string[];
  variant: MCQVariant;
  onOptionsChange: (opts: MCQOption[], correctIds: string[]) => void;
}) {
  const isLocked = variant === 'truefalse';
  const isMulti  = variant === 'multi';

  const addOption = () => {
    const id = `opt_${Date.now()}`;
    onOptionsChange([...options, { id, text: '' }], correctIds);
  };

  const removeOption = (id: string) => {
    if (options.length <= 2) return;
    onOptionsChange(options.filter((o) => o.id !== id), correctIds.filter((c) => c !== id));
  };

  const updateText = (id: string, text: string) =>
    onOptionsChange(options.map((o) => (o.id === id ? { ...o, text } : o)), correctIds);

  const appendMath = (id: string, mathStr: string) =>
    onOptionsChange(
      options.map((o) => (o.id === id ? { ...o, text: o.text + mathStr } : o)),
      correctIds,
    );

  const updateImage = (id: string, url: string | undefined) =>
    onOptionsChange(
      options.map((o) => (o.id === id ? { ...o, image: url } : o)),
      correctIds,
    );

  const toggleCorrect = (id: string) => {
    if (isMulti) {
      onOptionsChange(options, correctIds.includes(id)
        ? correctIds.filter((c) => c !== id)
        : [...correctIds, id]);
    } else {
      onOptionsChange(options, [id]);
    }
  };

  return (
    <div>
      {variant === 'fillblank' && (
        <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
          Use{' '}
          <code style={{ fontFamily: 'monospace', background: 'var(--ef-border-subtle)', padding: '1px 5px', borderRadius: 2 }}>___</code>
          {' '}in the stem to mark the blank. Options below are answer candidates.
        </p>
      )}
      {isMulti && (
        <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)' }}>Mark all options that are correct.</p>
      )}

      <div className="space-y-3">
        {options.map((opt, idx) => {
          const isCorrect = correctIds.includes(opt.id);
          return (
            <div key={opt.id}>
              {/* Main row */}
              <div className="flex items-center gap-2.5">
                {/* Correct indicator */}
                <button
                  type="button"
                  onClick={() => toggleCorrect(opt.id)}
                  title={isCorrect ? 'Marked correct — click to unmark' : 'Click to mark correct'}
                  className="flex-shrink-0 flex items-center justify-center transition-all"
                  style={{
                    width: 18, height: 18,
                    borderRadius: isMulti ? 2 : '50%',
                    border: `1.5px solid ${isCorrect ? 'var(--ef-ink)' : 'var(--ef-text-muted)'}`,
                    background: isCorrect ? 'var(--ef-ink)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  {isCorrect && <Check size={10} strokeWidth={2.5} style={{ color: 'var(--ef-surface)' }} />}
                </button>

                {/* Text input */}
                {isLocked ? (
                  <div
                    className="flex-1 px-3 py-2 text-xs select-none"
                    style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)' }}
                  >
                    {opt.text}
                  </div>
                ) : (
                  <input
                    type="text"
                    value={opt.text}
                    onChange={(e) => updateText(opt.id, e.target.value)}
                    placeholder={`Option ${idx + 1}`}
                    style={{ ...inp, flex: 1, width: 'auto' }}
                    onFocus={iFocus}
                    onBlur={iBlur}
                  />
                )}

                {/* Math button */}
                {!isLocked && (
                  <InlineMathButton onInsert={(math) => appendMath(opt.id, math)} />
                )}

                {/* Remove */}
                {!isLocked && options.length > 2 && (
                  <button
                    type="button"
                    onClick={() => removeOption(opt.id)}
                    className="flex-shrink-0 transition-opacity hover:opacity-60"
                    style={{ color: 'var(--ef-text-muted)' }}
                  >
                    <X size={13} strokeWidth={1.5} />
                  </button>
                )}
              </div>

              {/* Option image */}
              {!isLocked && (
                <div className="ml-7 mt-1.5">
                  <ImageUploader
                    value={opt.image}
                    onChange={(url) => updateImage(opt.id, url)}
                    label="Attach image to this option"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!isLocked && (
        <button
          type="button"
          onClick={addOption}
          className="mt-3 flex items-center gap-1.5 text-xs transition-opacity hover:opacity-60"
          style={{ color: 'var(--ef-text-muted)' }}
        >
          <Plus size={12} strokeWidth={1.5} /> Add option
        </button>
      )}
    </div>
  );
}

// ── Text Engine ───────────────────────────────────────────────────────────────

function TextEngine({
  modelAnswer, onChange, variant,
}: {
  modelAnswer: string;
  onChange: (v: string) => void;
  variant: TextVariant;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Model answer</span>
        <MathToolbar textareaRef={textareaRef} onChange={onChange} />
      </div>
      <textarea
        ref={textareaRef}
        value={modelAnswer}
        onChange={(e) => onChange(e.target.value)}
        rows={variant === 'short' ? 3 : 5}
        placeholder={
          variant === 'codereview'
            ? 'What a strong review should catch — bugs, edge cases, style, risk…'
            : variant === 'long'
              ? 'Key points, rubric hints, or model answer for faculty reference…'
              : 'Expected answer for faculty reference…'
        }
        style={{ ...inp, resize: 'vertical', lineHeight: 1.6 }}
        onFocus={iFocus}
        onBlur={iBlur}
      />
    </div>
  );
}

// ── Match Engine ──────────────────────────────────────────────────────────────

function MatchEngine({
  pairs, correctPairs, onChange,
}: {
  pairs: MatchPair[];
  correctPairs: CorrectPair[];
  onChange: (pairs: MatchPair[], correctPairs: CorrectPair[]) => void;
}) {
  const addPair = () => {
    const ts = Date.now();
    const lId = `l${ts}`; const rId = `r${ts}`;
    onChange(
      [...pairs, { leftId: lId, leftText: '', rightId: rId, rightText: '' }],
      [...correctPairs, { leftId: lId, rightId: rId }],
    );
  };

  const removePair = (idx: number) => {
    if (pairs.length <= 2) return;
    const removed = pairs[idx];
    onChange(pairs.filter((_, i) => i !== idx), correctPairs.filter((cp) => cp.leftId !== removed.leftId));
  };

  const updateLeft       = (idx: number, text: string)          => onChange(pairs.map((p, i) => i === idx ? { ...p, leftText:   text } : p), correctPairs);
  const updateRight      = (idx: number, text: string)          => onChange(pairs.map((p, i) => i === idx ? { ...p, rightText:  text } : p), correctPairs);
  const appendLeftMath   = (idx: number, math: string)          => onChange(pairs.map((p, i) => i === idx ? { ...p, leftText:   p.leftText  + math } : p), correctPairs);
  const appendRightMath  = (idx: number, math: string)          => onChange(pairs.map((p, i) => i === idx ? { ...p, rightText:  p.rightText + math } : p), correctPairs);
  const updateLeftImage  = (idx: number, url: string|undefined) => onChange(pairs.map((p, i) => i === idx ? { ...p, leftImage:  url } : p), correctPairs);
  const updateRightImage = (idx: number, url: string|undefined) => onChange(pairs.map((p, i) => i === idx ? { ...p, rightImage: url } : p), correctPairs);

  return (
    <div>
      <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
        Each left item maps to the right item in the same row. Right column is shuffled during the quiz.
      </p>

      <div className="space-y-3">
        {pairs.map((pair, idx) => (
          <div key={pair.leftId} className="p-3" style={{ border: '1px solid var(--ef-border-subtle)', borderRadius: 3 }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs select-none" style={{ color: 'var(--ef-text-muted)', minWidth: 16 }}>{idx + 1}.</span>
              {/* Left input */}
              <div className="flex items-center gap-1.5 flex-1">
                <input
                  type="text"
                  value={pair.leftText}
                  onChange={(e) => updateLeft(idx, e.target.value)}
                  placeholder={`Column A — item ${idx + 1}`}
                  style={{ ...inp, flex: 1, width: 'auto' }}
                  onFocus={iFocus} onBlur={iBlur}
                />
                <InlineMathButton onInsert={(m) => appendLeftMath(idx, m)} />
              </div>
              <span style={{ color: 'var(--ef-text-muted)', flexShrink: 0, fontSize: 13 }}>→</span>
              {/* Right input */}
              <div className="flex items-center gap-1.5 flex-1">
                <input
                  type="text"
                  value={pair.rightText}
                  onChange={(e) => updateRight(idx, e.target.value)}
                  placeholder={`Column B — item ${idx + 1}`}
                  style={{ ...inp, flex: 1, width: 'auto' }}
                  onFocus={iFocus} onBlur={iBlur}
                />
                <InlineMathButton onInsert={(m) => appendRightMath(idx, m)} />
              </div>
              {pairs.length > 2 && (
                <button
                  type="button"
                  onClick={() => removePair(idx)}
                  className="flex-shrink-0 transition-opacity hover:opacity-60"
                  style={{ color: 'var(--ef-text-muted)' }}
                >
                  <X size={13} strokeWidth={1.5} />
                </button>
              )}
            </div>
            {/* Images for left/right */}
            <div className="grid grid-cols-2 gap-2 ml-5">
              <ImageUploader value={pair.leftImage} onChange={(u) => updateLeftImage(idx, u)} label="Image for A" />
              <ImageUploader value={pair.rightImage} onChange={(u) => updateRightImage(idx, u)} label="Image for B" />
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addPair}
        className="mt-3 flex items-center gap-1.5 text-xs transition-opacity hover:opacity-60"
        style={{ color: 'var(--ef-text-muted)' }}
      >
        <Plus size={12} strokeWidth={1.5} /> Add pair
      </button>
    </div>
  );
}

// ── Metadata ──────────────────────────────────────────────────────────────────

const DIFFS: { v: Difficulty; label: string; active: string }[] = [
  { v: 'easy',   label: 'Easy',   active: 'var(--ef-success)' },
  { v: 'medium', label: 'Medium', active: 'var(--ef-warning-strong)' },
  { v: 'hard',   label: 'Hard',   active: 'var(--ef-danger)' },
];

interface MetaProps {
  subjectId: string | null;
  topicId: string | null;
  setSubjectTopic: (subjectId: string | null, subjectName: string, topicId: string | null, topicName: string) => void;
  tags: string[];      setTags:        (v: string[])  => void;
  difficulty: Difficulty; setDifficulty: (v: Difficulty) => void;
  explanation: string; setExplanation: (v: string)    => void;
  errors: Record<string, string>;
}

function MetaSection(p: MetaProps) {
  const exRef = useRef<HTMLTextAreaElement>(null);

  return (
    <>
      <div style={{ borderTop: '1px solid var(--ef-border-subtle)', margin: '0 0 20px' }} />
      <p className="text-xs mb-4" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>METADATA</p>

      <SubjectTopicSelect
        subjectId={p.subjectId}
        topicId={p.topicId}
        onChange={(v) => p.setSubjectTopic(v.subjectId, v.subjectName, v.topicId, v.topicName)}
        subjectError={p.errors.subject}
        topicError={p.errors.topic}
      />

      <Field label="Tags" hint="Press Enter or comma to add a tag.">
        <TagInput tags={p.tags} onChange={p.setTags} />
      </Field>

      <Field label="Difficulty">
        <div className="flex gap-2">
          {DIFFS.map((d) => (
            <button key={d.v} type="button" onClick={() => p.setDifficulty(d.v)}
              className="flex-1 text-xs py-2 transition-all"
              style={{
                borderRadius: 2,
                border: p.difficulty === d.v ? `1px solid ${d.active}` : '1px solid var(--ef-border)',
                background: p.difficulty === d.v ? d.active : 'var(--ef-canvas-raised)',
                color: p.difficulty === d.v ? 'var(--ef-surface)' : 'var(--ef-text-subtle)',
                letterSpacing: '0.03em',
              }}
            >{d.label}</button>
          ))}
        </div>
      </Field>

      {/* Explanation with math toolbar */}
      <div className="mb-5">
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs" style={{ color: 'var(--ef-text-subtle)' }}>Explanation / Solution hint</label>
          <MathToolbar textareaRef={exRef} onChange={p.setExplanation} />
        </div>
        <textarea
          ref={exRef}
          value={p.explanation}
          onChange={(e) => p.setExplanation(e.target.value)}
          rows={3}
          placeholder="Optional — faculty reference only, never shown to students…"
          style={{ ...inp, resize: 'vertical', lineHeight: 1.6 }}
          onFocus={iFocus} onBlur={iBlur}
        />
        <p className="text-xs mt-1.5" style={{ color: 'var(--ef-text-muted)' }}>
          Faculty reference only — never shown to students.
        </p>
      </div>
    </>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface QuestionTypeEngineProps {
  initialData?: Partial<Question>;
  ownerType?: QuestionOwnerType;
  ownerId?:   string;
  // Caller's institute (institute/faculty surfaces) — threaded to the
  // duplicate-check pool so its received-shares batch stays provable under
  // the tenant-fence read rules.
  instituteId?: string;
  onSave:   (draft: QuestionDraft) => Promise<void>;
  onCancel: () => void;
}

export function QuestionTypeEngine({ initialData, ownerType, ownerId, instituteId, onSave, onCancel }: QuestionTypeEngineProps) {
  const hasInitial = !!initialData?.engine;
  const [phase,   setPhase]   = useState<'pick' | 'form'>(hasInitial ? 'form' : 'pick');
  const [saving,  setSaving]  = useState(false);
  const [errors,  setErrors]  = useState<Record<string, string>>({});

  // ── Draft state ───────────────────────────────────────────────────
  const [engine,       setEngine]       = useState<QuestionEngine | null>(initialData?.engine ?? null);
  const [variant,      setVariant]      = useState<QuestionVariant>(initialData?.variant ?? null);
  const [stem,         setStem]         = useState(initialData?.stem ?? '');
  const [stemImage,    setStemImage]    = useState<string | undefined>(initialData?.stemImage);
  const [options,      setOptions]      = useState<MCQOption[]>(initialData?.options ?? []);
  const [correctIds,   setCorrectIds]   = useState<string[]>(initialData?.correctIds ?? []);
  const [modelAnswer,  setModelAnswer]  = useState(initialData?.modelAnswer ?? '');
  const [pairs,        setPairs]        = useState<MatchPair[]>(initialData?.pairs ?? []);
  const [correctPairs, setCorrectPairs] = useState<CorrectPair[]>(initialData?.correctPairs ?? []);
  const [codeSpec,     setCodeSpec]     = useState<CodeSpec>(initialData?.codeSpec ?? {});
  const [tests,        setTests]        = useState<CodeTest[]>(initialData?.tests ?? []);
  const [subjectId,   setSubjectId]   = useState<string | null>(initialData?.subjectId ?? null);
  const [topicId,     setTopicId]     = useState<string | null>(initialData?.topicId ?? null);
  const [subject,     setSubject]     = useState(initialData?.subject ?? '');
  const [topic,       setTopic]       = useState(initialData?.topic ?? '');
  const setSubjectTopic = (sid: string | null, sname: string, tid: string | null, tname: string) => {
    setSubjectId(sid);
    setSubject(sname);
    setTopicId(tid);
    setTopic(tname);
  };
  const [tags,         setTags]         = useState<string[]>(initialData?.tags ?? []);
  const [difficulty,   setDifficulty]   = useState<Difficulty>(initialData?.difficulty ?? 'medium');
  const [explanation,  setExplanation]  = useState(initialData?.explanation ?? '');

  // ── Duplicate detection ───────────────────────────────────────────
  const [pool, setPool] = useState<Question[]>([]);
  const [dupScore, setDupScore]       = useState<DuplicateScore | null>(null);
  const [showCompare, setShowCompare] = useState(false);
  const [confirmedDup, setConfirmedDup] = useState(false); // user said "save anyway"

  useEffect(() => {
    let alive = true;
    getDuplicateCheckPool(ownerType, ownerId, instituteId).then((qs) => { if (alive) setPool(qs); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Reset the duplicate verdict whenever the user edits scoring-relevant fields.
  useEffect(() => {
    setDupScore(null);
    setConfirmedDup(false);
  }, [stem, options, correctIds, subjectId, topicId]);

  // ── Type select ───────────────────────────────────────────────────
  // Every engine names its own factory. The dispatch used to end in a bare
  // `else` that meant "match", so picking a coding type built a MATCH draft:
  // the new question opened with three blank match pairs and saved them to
  // both documents. An exhaustive switch makes the next engine a build error
  // here instead of silently inheriting whichever branch happens to be last.
  const selectType = (eng: QuestionEngine, vari: QuestionVariant) => {
    let empty: Omit<Question, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'>;
    switch (eng) {
      case 'mcq':   empty = buildEmptyMCQ(vari as MCQVariant);   break;
      case 'text':  empty = buildEmptyText(vari as TextVariant); break;
      case 'match': empty = buildEmptyMatch();                   break;
      case 'code':  empty = buildEmptyCode(vari as CodeVariant); break;
      default: {
        const never: never = eng;
        throw new Error(`Unhandled question engine: ${String(never)}`);
      }
    }

    setEngine(eng); setVariant(vari);
    setStem(''); setStemImage(undefined);
    setOptions(empty.options);   setCorrectIds(empty.correctIds);
    setModelAnswer(empty.modelAnswer);
    setPairs(empty.pairs);       setCorrectPairs(empty.correctPairs);
    // Reset the coding halves too. Without this, picking MCQ after starting a
    // coding draft carried the old spec and suite along in state, and the
    // engine === 'code' guard in handleSave was the only thing stopping them
    // from being saved onto an MCQ.
    setCodeSpec(empty.codeSpec ?? {});
    setTests(empty.tests ?? []);
    setErrors({});
    setPhase('form');
  };

  // ── Validate ──────────────────────────────────────────────────────
  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!stem.trim()) errs.stem = 'Question stem is required.';
    if (engine === 'mcq') {
      if (options.some((o) => !o.text.trim())) errs.options = 'All options must have text.';
      if (correctIds.length === 0) errs.correct = 'Mark at least one correct answer.';
    }
    if (engine === 'match') {
      if (pairs.some((p) => !p.leftText.trim() || !p.rightText.trim()))
        errs.pairs = 'All pairs must have text in both columns.';
    }
    if (engine === 'code') {
      // Only the blocking issues stop a save. Warnings are shown inline in the
      // editor and are the author's call — a question with no runnable samples
      // is unusual, not wrong.
      const blocking = validateCodeQuestion(codeSpec, tests)
        .filter((i) => i.severity === 'error');
      if (blocking.length > 0) errs.code = blocking[0].message;
    }
    if (!subjectId) errs.subject = 'Subject is required.';
    if (!topicId)   errs.topic   = 'Topic is required.';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  // ── Save ──────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!engine || !validate()) return;

    // Run duplicate detection on save click (skipped on edit of self via id filter).
    const correctTexts = correctIds
      .map((cid) => options.find((o) => o.id === cid)?.text ?? '')
      .filter(Boolean);
    const candidates = findDuplicateCandidates(
      { subjectId: subjectId ?? undefined, topicId: topicId ?? undefined, id: initialData?.id },
      pool,
    );
    const score = scoreAgainstPool(
      {
        id: initialData?.id,
        stem,
        options: options.map((o) => o.text),
        correctAnswer: correctTexts.length === 1 ? correctTexts[0] : correctTexts,
      },
      candidates.map((q) => ({
        id: q.id,
        stem: q.stem,
        options: (q.options ?? []).map((o) => o.text),
        correctAnswer: (q.correctIds ?? [])
          .map((cid) => (q.options ?? []).find((o) => o.id === cid)?.text ?? '')
          .filter(Boolean),
      })),
    );
    const verdict = verdictFor(score);

    // Block verdict (exact_stem / reordered_options) cannot be overridden.
    // Warn/note can be overridden by clicking "Save anyway", which sets confirmedDup.
    if (verdict === 'block' || (verdict !== 'clean' && !confirmedDup)) {
      setDupScore(score);
      return;
    }

    setSaving(true);
    try {
      await onSave({
        engine, variant,
        stem: stem.trim(), stemImage,
        options, correctIds,
        modelAnswer: modelAnswer.trim(),
        pairs, correctPairs,
        // Coding halves. questionBankService routes `tests` into the
        // questionAnswers sibling (ANSWER_KEYS) and wipes it from the public
        // document, so the hidden suite never ships inside an exam payload;
        // codeSpec stays public because the candidate is shown all of it.
        // Sent only for the code engine, so no other question type acquires
        // an empty tests array it has no use for.
        ...(engine === 'code' ? { codeSpec, tests } : {}),
        subject: subject.trim(), topic: topic.trim(),
        subjectId: subjectId ?? undefined,
        topicId:   topicId   ?? undefined,
        tags, difficulty,
        explanation: explanation.trim(),
      });
    } finally {
      setSaving(false);
    }
  };

  const currentType = TYPE_OPTIONS.find((t) => t.engine === engine && t.variant === variant);

  // ── Pick phase ────────────────────────────────────────────────────
  if (phase === 'pick') {
    return (
      <div className="h-full flex flex-col">
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <TypePicker onSelect={selectType} />
        </div>
        <div className="flex-shrink-0 px-6 py-4" style={{ borderTop: '1px solid var(--ef-border)' }}>
          <button type="button" onClick={onCancel}
            className="text-xs px-4 py-2.5 transition-colors"
            style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas)')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--ef-surface)')}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Form phase ────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-6">

        {/* Type indicator */}
        {!hasInitial && currentType && (
          <div className="flex items-center gap-2 mb-5">
            <span
              className="text-xs px-1.5 py-0.5 select-none"
              style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.04em', fontSize: 12 }}
            >
              {currentType.badge}
            </span>
            <span className="text-xs" style={{ color: 'var(--ef-ink)' }}>{currentType.label}</span>
            <button type="button" onClick={() => setPhase('pick')}
              className="ml-auto flex items-center gap-1 text-xs transition-opacity hover:opacity-60"
              style={{ color: 'var(--ef-text-muted)' }}
            >
              <ChevronLeft size={11} strokeWidth={1.5} /> Change type
            </button>
          </div>
        )}

        {/* Stem + stem image */}
        <StemField
          stem={stem}
          stemImage={stemImage}
          onStemChange={setStem}
          onStemImageChange={setStemImage}
          error={errors.stem}
        />

        {/* Engine fields */}
        {engine === 'mcq' && (
          <Field
            label={
              variant === 'fillblank'  ? 'Answer candidates *'
              : variant === 'outputpred' ? 'Candidate outputs *'
              : 'Options *'
            }
            error={errors.options || errors.correct}
          >
            <MCQEngine
              options={options} correctIds={correctIds}
              variant={variant as MCQVariant}
              onOptionsChange={(opts, cIds) => { setOptions(opts); setCorrectIds(cIds); }}
            />
          </Field>
        )}

        {engine === 'text' && (
          <Field label="Model answer" hint="Stored as faculty reference. Students only see the stem.">
            <TextEngine modelAnswer={modelAnswer} onChange={setModelAnswer} variant={variant as TextVariant} />
          </Field>
        )}

        {engine === 'code' && (
          <CodeSpecEditor
            spec={codeSpec}
            tests={tests}
            onSpecChange={setCodeSpec}
            onTestsChange={setTests}
          />
        )}

        {engine === 'match' && (
          <Field label="Column pairs *" error={errors.pairs}>
            <MatchEngine
              pairs={pairs} correctPairs={correctPairs}
              onChange={(p, cp) => { setPairs(p); setCorrectPairs(cp); }}
            />
          </Field>
        )}

        {/* Metadata */}
        <MetaSection
          subjectId={subjectId}
          topicId={topicId}
          setSubjectTopic={setSubjectTopic}
          tags={tags}             setTags={setTags}
          difficulty={difficulty} setDifficulty={setDifficulty}
          explanation={explanation} setExplanation={setExplanation}
          errors={errors}
        />
      </div>

      {/* Duplicate warning banner */}
      {dupScore && (
        <DuplicateBanner
          score={dupScore}
          onReview={() => setShowCompare(true)}
          onSaveAnyway={() => { setConfirmedDup(true); setDupScore(null); handleSave(); }}
          onDismiss={() => setDupScore(null)}
        />
      )}

      {/* Compare modal */}
      {showCompare && dupScore && (
        <DuplicateCompareModal
          row={{
            sheet: engine === 'text' ? 'Text' : engine === 'match' ? 'Match' : 'MCQ',
            rowIndex: 0,
            // 'ok' is not a RowStatus — the union is valid|warning|error, and
            // the `as ParsedRow` cast below was silencing that. Inert (the
            // modal never reads .status), but an invalid literal in a synthetic
            // row is exactly what a cast should not be used to hide.
            status: 'valid',
            errors: [],
            warnings: [],
            raw: {},
            draft: {
              stem,
              options,
              correctIds,
              subject,
              topic,
            } as Partial<QuestionDraft>,
            duplicateScore: dupScore,
          } as ParsedRow}
          pool={pool}
          onClose={() => setShowCompare(false)}
        />
      )}

      {/* Fixed footer */}
      <div className="flex-shrink-0 px-6 py-4 flex items-center gap-3" style={{ borderTop: '1px solid var(--ef-border)' }}>
        <button
          type="button" onClick={handleSave} disabled={saving}
          className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
          style={{
            background: saving ? 'var(--ef-track)' : 'var(--ef-ink)', color: 'var(--ef-surface)',
            borderRadius: 2, letterSpacing: '0.03em',
            cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving
            ? <><Loader2 size={11} className="animate-spin" /> Saving…</>
            : <><Check size={11} strokeWidth={2} /> Save question</>}
        </button>
        <button
          type="button" onClick={onCancel} disabled={saving}
          className="text-xs px-4 py-2.5 transition-colors"
          style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas)')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--ef-surface)')}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Duplicate banner ──────────────────────────────────────────────────────────

const REASON_LABEL: Record<string, string> = {
  exact_stem:        'Exact duplicate — this stem already exists',
  reordered_options: 'Duplicate — same options + same correct answer',
  fuzzy_stem:        'Very similar to an existing question',
  option_overlap:    'Options overlap significantly with an existing question',
  none:              'Possible match',
};

function DuplicateBanner({
  score, onReview, onSaveAnyway, onDismiss,
}: {
  score: DuplicateScore;
  onReview:     () => void;
  onSaveAnyway: () => void;
  onDismiss:    () => void;
}) {
  const verdict = verdictFor(score);
  const isBlock = verdict === 'block';
  const palette = isBlock
    ? { bg: 'var(--ef-danger-bg)', border: 'var(--ef-danger-border)', text: 'var(--ef-danger)', sub: 'var(--ef-danger)' }
    : { bg: 'var(--ef-warning-bg)', border: 'var(--ef-warning-border)', text: 'var(--ef-warning-strong)', sub: 'var(--ef-warning)' };

  return (
    <div
      className="flex-shrink-0 px-6 py-3 flex items-start gap-3"
      style={{ background: palette.bg, borderTop: `1px solid ${palette.border}` }}
    >
      <AlertTriangle size={14} strokeWidth={1.5} style={{ color: palette.text, marginTop: 2, flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <p className="text-xs" style={{ color: palette.text }}>
          {REASON_LABEL[score.matchedReason] ?? 'Possible duplicate'}
        </p>
        <p className="text-xs mt-0.5" style={{ color: palette.sub, fontSize: 12 }}>
          Stem {pct(score.stemSim)} · Options {pct(score.optionsSim)} · Correct answer {score.answerMatch ? 'matches' : 'differs'}
        </p>
      </div>
      <button
        type="button" onClick={onReview}
        className="flex items-center gap-1 text-xs px-3 py-1.5"
        style={{ border: `1px solid ${palette.border}`, background: 'var(--ef-surface)', color: palette.text, borderRadius: 2 }}
      >
        <Eye size={11} strokeWidth={1.5} /> Review match
      </button>
      {!isBlock && (
        <button
          type="button" onClick={onSaveAnyway}
          className="text-xs px-3 py-1.5"
          style={{ background: palette.text, color: 'var(--ef-surface)', borderRadius: 2 }}
        >
          Save anyway
        </button>
      )}
      <button
        type="button" onClick={onDismiss}
        className="p-1 transition-opacity hover:opacity-60"
        style={{ color: palette.sub }}
      >
        <X size={13} strokeWidth={1.5} />
      </button>
    </div>
  );
}