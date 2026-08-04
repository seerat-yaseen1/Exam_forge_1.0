/**
 * MathToolbar — a compact bar with buttons that insert LaTeX math
 * delimiters at the cursor position (or wrap a selection) inside a
 * textarea. Uses a controlled ref to manipulate the native textarea.
 *
 * Exports:
 *   <MathToolbar textareaRef onChange value />
 *   insertMathAt() — call programmatically from option inputs etc.
 */

import React, { useState, useRef, useEffect } from 'react';
import { MathPreview } from './RichText';

// ── Helper — insert text at cursor in a textarea ──────────────────────────────

export function insertAtCursor(
  el: HTMLTextAreaElement,
  before: string,
  after: string,
  placeholder: string,
) {
  const { selectionStart: start, selectionEnd: end, value } = el;
  const selected  = value.slice(start, end) || placeholder;
  const newValue  = value.slice(0, start) + before + selected + after + value.slice(end);
  const newCursor = start + before.length + selected.length;

  // Use execCommand so undo history works
  el.focus();
  el.setSelectionRange(start, end);
  // Modern approach: dispatch an input event after setting value
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;
  if (nativeInputValueSetter) nativeInputValueSetter.call(el, newValue);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.setSelectionRange(newCursor - selected.length + selected.length, newCursor);

  // Return the new value so the caller can sync state
  return newValue;
}

// ── Math input popover ────────────────────────────────────────────────────────

interface MathPopoverProps {
  onInsert: (formula: string, display: boolean) => void;
  onClose:  () => void;
}

function MathPopover({ onInsert, onClose }: MathPopoverProps) {
  const [formula,  setFormula]  = useState('');
  const [isBlock,  setIsBlock]  = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const commit = () => {
    if (!formula.trim()) return;
    onInsert(formula.trim(), isBlock);
    onClose();
  };

  return (
    <div
      className="mt-1 p-3 z-40"
      style={{
        border: '1px solid #E3E1DB', borderRadius: 3,
        background: '#FFFFFF',
        boxShadow: '0 4px 16px rgba(12,12,11,0.08)',
      }}
    >
      {/* Formula input */}
      <div className="flex items-center gap-2 mb-2.5">
        <input
          ref={inputRef}
          type="text"
          value={formula}
          onChange={(e) => setFormula(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') onClose(); }}
          placeholder="e.g. \frac{a}{b} or x^2 + y^2"
          className="flex-1 text-xs outline-none px-2.5 py-2"
          style={{
            border: '1px solid #E3E1DB', borderRadius: 2,
            background: '#FAFAF8', color: '#0C0C0B',
            fontFamily: 'monospace', fontSize: 12,
          }}
        />
      </div>

      {/* Display mode toggle */}
      <div className="flex items-center gap-2 mb-2.5">
        <button
          type="button"
          onClick={() => setIsBlock(false)}
          className="flex-1 text-xs py-1.5 transition-all"
          style={{
            borderRadius: 2,
            border: !isBlock ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
            background: !isBlock ? '#0C0C0B' : '#FAFAF8',
            color: !isBlock ? '#FFFFFF' : '#6B6B66',
          }}
        >
          Inline &nbsp;<code style={{ fontSize: 10, opacity: 0.8 }}>$...$</code>
        </button>
        <button
          type="button"
          onClick={() => setIsBlock(true)}
          className="flex-1 text-xs py-1.5 transition-all"
          style={{
            borderRadius: 2,
            border: isBlock ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
            background: isBlock ? '#0C0C0B' : '#FAFAF8',
            color: isBlock ? '#FFFFFF' : '#6B6B66',
          }}
        >
          Block &nbsp;<code style={{ fontSize: 10, opacity: 0.8 }}>$$...$$</code>
        </button>
      </div>

      {/* Live preview */}
      {formula.trim() && (
        <div className="mb-2.5">
          <MathPreview formula={formula} display={isBlock} />
        </div>
      )}

      {/* Common symbols */}
      <div className="flex flex-wrap gap-1 mb-2.5">
        {SYMBOLS.map((s) => (
          <button
            key={s.label}
            type="button"
            title={s.latex}
            onClick={() => setFormula((f) => f + s.latex)}
            className="text-xs px-1.5 py-0.5 transition-opacity hover:opacity-70 select-none"
            style={{
              border: '1px solid #E3E1DB', borderRadius: 2,
              background: '#F7F6F3', color: '#4A4A45',
              fontFamily: 'serif', fontSize: 13,
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={commit}
          disabled={!formula.trim()}
          className="text-xs px-3 py-1.5 transition-opacity"
          style={{
            background: formula.trim() ? '#0C0C0B' : '#C8C7C2',
            color: '#FFFFFF', borderRadius: 2,
            cursor: formula.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          Insert
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-xs px-3 py-1.5 transition-opacity hover:opacity-60"
          style={{ color: '#6B6B66', border: '1px solid #E3E1DB', borderRadius: 2 }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Common LaTeX symbol quick-picks ───────────────────────────────────────────

const SYMBOLS = [
  { label: '×',   latex: '\\times ' },
  { label: '÷',   latex: '\\div ' },
  { label: '±',   latex: '\\pm ' },
  { label: '≤',   latex: '\\leq ' },
  { label: '≥',   latex: '\\geq ' },
  { label: '≠',   latex: '\\neq ' },
  { label: '≈',   latex: '\\approx ' },
  { label: '∞',   latex: '\\infty ' },
  { label: '√',   latex: '\\sqrt{}' },
  { label: 'π',   latex: '\\pi ' },
  { label: 'α',   latex: '\\alpha ' },
  { label: 'β',   latex: '\\beta ' },
  { label: 'θ',   latex: '\\theta ' },
  { label: 'Σ',   latex: '\\sum_{i=1}^{n} ' },
  { label: '∫',   latex: '\\int_{a}^{b} ' },
  { label: 'ₓ²',  latex: 'x^{2}' },
  { label: 'a/b', latex: '\\frac{a}{b}' },
  { label: 'log', latex: '\\log ' },
  { label: 'sin', latex: '\\sin ' },
  { label: 'cos', latex: '\\cos ' },
];

// ── Main toolbar ──────────────────────────────────────────────────────────────

interface MathToolbarProps {
  /** Ref to the textarea whose content this toolbar edits. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Called with the full new textarea value after insertion. */
  onChange: (newValue: string) => void;
}

export function MathToolbar({ textareaRef, onChange }: MathToolbarProps) {
  const [open, setOpen] = useState(false);

  const handleInsert = (formula: string, display: boolean) => {
    const el = textareaRef.current;
    if (!el) return;
    const before  = display ? '$$' : '$';
    const after   = display ? '$$' : '$';
    const newVal  = insertAtCursor(el, before, after, formula);
    onChange(newVal);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Insert math formula (LaTeX)"
        className="flex items-center gap-1.5 text-xs px-2.5 py-1 transition-all select-none"
        style={{
          border: open ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
          borderRadius: 2,
          background: open ? '#0C0C0B' : '#FAFAF8',
          color: open ? '#FFFFFF' : '#6B6B66',
        }}
      >
        <span style={{ fontFamily: 'serif', fontSize: 14, lineHeight: 1 }}>∑</span>
        Math
      </button>

      {open && (
        <div
          className="absolute left-0 top-full w-72 z-50"
          style={{ marginTop: 4 }}
        >
          <MathPopover onInsert={handleInsert} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

// ── Inline math button (for option inputs) ────────────────────────────────────

interface InlineMathButtonProps {
  /** Called with the formula string (already wrapped in $ $) to append. */
  onInsert: (text: string) => void;
}

export function InlineMathButton({ onInsert }: InlineMathButtonProps) {
  const [open, setOpen] = useState(false);

  const handleInsert = (formula: string, display: boolean) => {
    const before = display ? '$$' : '$';
    const after  = display ? '$$' : '$';
    onInsert(`${before}${formula}${after}`);
    setOpen(false);
  };

  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Insert math"
        className="flex items-center justify-center transition-all"
        style={{
          width: 26, height: 26, borderRadius: 2,
          border: open ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
          background: open ? '#0C0C0B' : '#FAFAF8',
          color: open ? '#FFFFFF' : '#6B6B66',
          fontFamily: 'serif', fontSize: 14,
        }}
      >
        ∑
      </button>

      {open && (
        <div
          className="absolute right-0 z-50"
          style={{ top: '100%', marginTop: 4, width: 280 }}
        >
          <MathPopover onInsert={handleInsert} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
