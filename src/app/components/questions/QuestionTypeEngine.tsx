import React, { useState, useRef } from 'react';
import { Plus, X, Check, ChevronLeft, Loader2 } from 'lucide-react';
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
  buildEmptyMCQ,
  buildEmptyText,
  buildEmptyMatch,
} from '../../../lib/questionBankService';
import { ImageUploader } from './ImageUploader';
import { MathToolbar, InlineMathButton } from './MathToolbar';
import { SubjectCombobox } from './SubjectCombobox';

// ── Type re-export for consumers ──────────────────────────────────────────────

export type QuestionDraft = Omit<Question, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'>;

// ── Shared styles ─────────────────────────────────────────────────────────────

const inp: React.CSSProperties = {
  background: '#FAFAF8',
  border: '1px solid #E3E1DB',
  color: '#0C0C0B',
  borderRadius: 2,
  outline: 'none',
  fontSize: 13,
  padding: '9px 12px',
  width: '100%',
};

function iFocus(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  e.target.style.borderColor = '#0C0C0B';
  e.target.style.background  = '#FFFFFF';
}
function iBlur(e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
  e.target.style.borderColor = '#E3E1DB';
  e.target.style.background  = '#FAFAF8';
}

// ── Type options ──────────────────────────────────────────────────────────────

interface TypeOption {
  engine: QuestionEngine;
  variant: QuestionVariant;
  label: string;
  badge: string;
  description: string;
}

const TYPE_OPTIONS: TypeOption[] = [
  { engine: 'mcq',   variant: 'single',    label: 'MCQ — Single Correct',  badge: 'MCQ',   description: 'One correct answer from multiple options' },
  { engine: 'mcq',   variant: 'multi',     label: 'MCQ — Multi Correct',   badge: 'Multi', description: 'One or more answers may be correct' },
  { engine: 'mcq',   variant: 'truefalse', label: 'True / False',          badge: 'T/F',   description: 'Binary choice — True or False' },
  { engine: 'mcq',   variant: 'fillblank', label: 'Fill in the Blank',     badge: 'Fill',  description: 'Use ___ in the stem to mark the blank' },
  { engine: 'text',  variant: 'short',     label: 'Short Answer',          badge: 'Short', description: 'Brief written response expected' },
  { engine: 'text',  variant: 'long',      label: 'Long / Essay',          badge: 'Essay', description: 'Extended written or analytical response' },
  { engine: 'match', variant: null,        label: 'Match the Columns',     badge: 'Match', description: 'Pair items from two columns' },
];

// ── Type Picker ───────────────────────────────────────────────────────────────

function TypePicker({ onSelect }: { onSelect: (e: QuestionEngine, v: QuestionVariant) => void }) {
  return (
    <div>
      <p className="text-xs mb-4" style={{ color: '#9A9891' }}>
        Select a question type to continue.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {TYPE_OPTIONS.map((t) => (
          <button
            key={`${t.engine}-${t.variant}`}
            type="button"
            onClick={() => onSelect(t.engine, t.variant)}
            className="text-left p-4 transition-all"
            style={{ border: '1px solid #E3E1DB', borderRadius: 3, background: '#FFFFFF' }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B';
              (e.currentTarget as HTMLElement).style.background  = '#FAFAF8';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB';
              (e.currentTarget as HTMLElement).style.background  = '#FFFFFF';
            }}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className="text-xs px-1.5 py-0.5 select-none"
                style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.04em', fontSize: 10 }}
              >
                {t.badge}
              </span>
              <span className="text-xs" style={{ color: '#0C0C0B' }}>{t.label}</span>
            </div>
            <p className="text-xs" style={{ color: '#9A9891', lineHeight: 1.5 }}>{t.description}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Field wrapper ─────────────────────────────────────────────────────────────

function Field({ label, error, hint, children }: {
  label: string; error?: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <label className="block text-xs mb-1.5" style={{ color: '#4A4A45' }}>{label}</label>
      {children}
      {hint  && <p className="text-xs mt-1.5" style={{ color: '#B0AEA8' }}>{hint}</p>}
      {error && <p className="text-xs mt-1.5" style={{ color: '#9B2828' }}>{error}</p>}
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
      style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FAFAF8' }}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 px-2 py-0.5 text-xs select-none"
          style={{ background: '#F0EFEB', borderRadius: 2, color: '#4A4A45' }}
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
        style={{ background: 'transparent', color: '#0C0C0B', fontSize: 13 }}
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
        <label className="text-xs" style={{ color: '#4A4A45' }}>Question stem *</label>
        <MathToolbar textareaRef={textareaRef} onChange={onStemChange} />
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

      {error && <p className="text-xs mt-1.5" style={{ color: '#9B2828' }}>{error}</p>}

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
        <p className="text-xs mb-3" style={{ color: '#9A9891', lineHeight: 1.6 }}>
          Use{' '}
          <code style={{ fontFamily: 'monospace', background: '#F0EFEB', padding: '1px 5px', borderRadius: 2 }}>___</code>
          {' '}in the stem to mark the blank. Options below are answer candidates.
        </p>
      )}
      {isMulti && (
        <p className="text-xs mb-3" style={{ color: '#9A9891' }}>Mark all options that are correct.</p>
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
                    border: `1.5px solid ${isCorrect ? '#0C0C0B' : '#C4C3BD'}`,
                    background: isCorrect ? '#0C0C0B' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  {isCorrect && <Check size={10} strokeWidth={2.5} style={{ color: '#FFFFFF' }} />}
                </button>

                {/* Text input */}
                {isLocked ? (
                  <div
                    className="flex-1 px-3 py-2 text-xs select-none"
                    style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2, color: '#6B6B66' }}
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
                    style={{ color: '#C4C3BD' }}
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
          style={{ color: '#9A9891' }}
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
        <span className="text-xs" style={{ color: '#B0AEA8' }}>Model answer</span>
        <MathToolbar textareaRef={textareaRef} onChange={onChange} />
      </div>
      <textarea
        ref={textareaRef}
        value={modelAnswer}
        onChange={(e) => onChange(e.target.value)}
        rows={variant === 'long' ? 5 : 3}
        placeholder={
          variant === 'long'
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
      <p className="text-xs mb-3" style={{ color: '#9A9891', lineHeight: 1.6 }}>
        Each left item maps to the right item in the same row. Right column is shuffled during the quiz.
      </p>

      <div className="space-y-3">
        {pairs.map((pair, idx) => (
          <div key={pair.leftId} className="p-3" style={{ border: '1px solid #F0EFEB', borderRadius: 3 }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs select-none" style={{ color: '#C4C3BD', minWidth: 16 }}>{idx + 1}.</span>
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
              <span style={{ color: '#C4C3BD', flexShrink: 0, fontSize: 12 }}>→</span>
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
                  style={{ color: '#C4C3BD' }}
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
        style={{ color: '#9A9891' }}
      >
        <Plus size={12} strokeWidth={1.5} /> Add pair
      </button>
    </div>
  );
}

// ── Metadata ──────────────────────────────────────────────────────────────────

const DIFFS: { v: Difficulty; label: string; active: string }[] = [
  { v: 'easy',   label: 'Easy',   active: '#2A6B3A' },
  { v: 'medium', label: 'Medium', active: '#8B5E1A' },
  { v: 'hard',   label: 'Hard',   active: '#9B2828' },
];

interface MetaProps {
  subject: string;     setSubject:     (v: string)    => void;
  topic: string;       setTopic:       (v: string)    => void;
  tags: string[];      setTags:        (v: string[])  => void;
  difficulty: Difficulty; setDifficulty: (v: Difficulty) => void;
  explanation: string; setExplanation: (v: string)    => void;
  errors: Record<string, string>;
}

function MetaSection(p: MetaProps) {
  const exRef = useRef<HTMLTextAreaElement>(null);

  return (
    <>
      <div style={{ borderTop: '1px solid #F0EFEB', margin: '0 0 20px' }} />
      <p className="text-xs mb-4" style={{ color: '#C4C3BD', letterSpacing: '0.1em' }}>METADATA</p>

      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Subject *" error={p.errors.subject}>
          <SubjectCombobox
            value={p.subject}
            onChange={p.setSubject}
            error={p.errors.subject ? ' ' : undefined}
            placeholder="e.g. Mathematics"
          />
        </Field>
        <Field label="Topic">
          <input type="text" value={p.topic} onChange={(e) => p.setTopic(e.target.value)}
            placeholder="e.g. Algebra, Limits" style={inp} onFocus={iFocus} onBlur={iBlur} />
        </Field>
      </div>

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
                border: p.difficulty === d.v ? `1px solid ${d.active}` : '1px solid #E3E1DB',
                background: p.difficulty === d.v ? d.active : '#FAFAF8',
                color: p.difficulty === d.v ? '#FFFFFF' : '#4A4A45',
                letterSpacing: '0.03em',
              }}
            >{d.label}</button>
          ))}
        </div>
      </Field>

      {/* Explanation with math toolbar */}
      <div className="mb-5">
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs" style={{ color: '#4A4A45' }}>Explanation / Solution hint</label>
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
        <p className="text-xs mt-1.5" style={{ color: '#B0AEA8' }}>
          Faculty reference only — never shown to students.
        </p>
      </div>
    </>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface QuestionTypeEngineProps {
  initialData?: Partial<Question>;
  onSave:   (draft: QuestionDraft) => Promise<void>;
  onCancel: () => void;
}

export function QuestionTypeEngine({ initialData, onSave, onCancel }: QuestionTypeEngineProps) {
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
  const [subject,      setSubject]      = useState(initialData?.subject ?? '');
  const [topic,        setTopic]        = useState(initialData?.topic ?? '');
  const [tags,         setTags]         = useState<string[]>(initialData?.tags ?? []);
  const [difficulty,   setDifficulty]   = useState<Difficulty>(initialData?.difficulty ?? 'medium');
  const [explanation,  setExplanation]  = useState(initialData?.explanation ?? '');

  // ── Type select ───────────────────────────────────────────────────
  const selectType = (eng: QuestionEngine, vari: QuestionVariant) => {
    let empty: Omit<Question, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'>;
    if (eng === 'mcq')       empty = buildEmptyMCQ(vari as MCQVariant);
    else if (eng === 'text') empty = buildEmptyText(vari as TextVariant);
    else                     empty = buildEmptyMatch();

    setEngine(eng); setVariant(vari);
    setStem(''); setStemImage(undefined);
    setOptions(empty.options);   setCorrectIds(empty.correctIds);
    setModelAnswer(empty.modelAnswer);
    setPairs(empty.pairs);       setCorrectPairs(empty.correctPairs);
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
    if (!subject.trim()) errs.subject = 'Subject is required.';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  // ── Save ──────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!engine || !validate()) return;
    setSaving(true);
    try {
      await onSave({
        engine, variant,
        stem: stem.trim(), stemImage,
        options, correctIds,
        modelAnswer: modelAnswer.trim(),
        pairs, correctPairs,
        subject: subject.trim(), topic: topic.trim(),
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
        <div className="flex-shrink-0 px-6 py-4" style={{ borderTop: '1px solid #E3E1DB' }}>
          <button type="button" onClick={onCancel}
            className="text-xs px-4 py-2.5 transition-colors"
            style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = '#F7F6F3')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = '#FFFFFF')}
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
              style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.04em', fontSize: 10 }}
            >
              {currentType.badge}
            </span>
            <span className="text-xs" style={{ color: '#0C0C0B' }}>{currentType.label}</span>
            <button type="button" onClick={() => setPhase('pick')}
              className="ml-auto flex items-center gap-1 text-xs transition-opacity hover:opacity-60"
              style={{ color: '#9A9891' }}
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
            label={variant === 'fillblank' ? 'Answer candidates *' : 'Options *'}
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
          subject={subject}       setSubject={setSubject}
          topic={topic}           setTopic={setTopic}
          tags={tags}             setTags={setTags}
          difficulty={difficulty} setDifficulty={setDifficulty}
          explanation={explanation} setExplanation={setExplanation}
          errors={errors}
        />
      </div>

      {/* Fixed footer */}
      <div className="flex-shrink-0 px-6 py-4 flex items-center gap-3" style={{ borderTop: '1px solid #E3E1DB' }}>
        <button
          type="button" onClick={handleSave} disabled={saving}
          className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
          style={{
            background: saving ? '#C8C7C2' : '#0C0C0B', color: '#FFFFFF',
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
          style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = '#F7F6F3')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = '#FFFFFF')}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}