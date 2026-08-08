/**
 * SNIPPET TOOLBAR — put a fenced code block into a question stem
 *
 * Sits beside MathToolbar and works the same way: it reads the caret out of the
 * stem textarea, produces new text, and hands it back through onChange. The
 * stem stays a controlled value owned by the form.
 *
 * Two things it offers, and they are different needs:
 *
 *   AN EMPTY BLOCK in a chosen language, for an author who has code to paste
 *   and only wants the fence and the tag right. This is the common case —
 *   getting ```python wrong renders the whole block unstyled and looks like a
 *   platform fault rather than a typo.
 *
 *   A WORKED SNIPPET, for an author starting from nothing. These are starting
 *   points to edit, not a question bank; the library is deliberately small.
 */

import { useEffect, useRef, useState } from 'react';
import { Code2, ChevronDown } from 'lucide-react';
import {
  STEM_SNIPPETS,
  asFencedBlock,
  insertBlockAt,
} from '../../../lib/codeSnippets';
import { AUTHORING_LANGUAGES, LANGUAGE_LABEL, type AuthoringLanguage } from '../../../lib/codeAuthoring';

interface SnippetToolbarProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
}

export function SnippetToolbar({ textareaRef, value, onChange }: SnippetToolbarProps) {
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<AuthoringLanguage>('python3');
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on an outside click. Without this the panel sits over the stem the
  // author is trying to read.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const insert = (code: string, language: AuthoringLanguage) => {
    const el = textareaRef.current;
    // selectionStart is null on a textarea that has never been focused, and
    // appending at the end is the right guess there — an author who has not put
    // a caret anywhere is adding to what they have written.
    const caret = el?.selectionStart ?? value.length;
    const { text, cursor } = insertBlockAt(value, caret, asFencedBlock(code, language));
    onChange(text);
    setOpen(false);

    // Restore the caret after React has re-rendered with the new value, so the
    // author carries on typing where the block ended rather than at the top.
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Insert a code block"
        className="flex items-center gap-1.5 text-xs px-2.5 py-1 transition-all select-none"
        style={{
          border: open ? '1px solid var(--ef-ink)' : '1px solid var(--ef-border)',
          borderRadius: 2,
          background: open ? 'var(--ef-ink)' : 'var(--ef-canvas-raised)',
          color: open ? 'var(--ef-surface)' : 'var(--ef-ink)',
        }}
      >
        <Code2 size={12} />
        Code
        <ChevronDown size={11} />
      </button>

      {open && (
        <div
          className="absolute right-0 z-20 mt-1 rounded border shadow-lg"
          style={{ width: 340, background: 'var(--ef-surface)', maxHeight: 420, overflowY: 'auto' }}
        >
          {/* ── Empty block ── */}
          <div className="p-2.5 border-b space-y-2">
            <div className="text-xs font-medium">Empty block</div>
            <div className="flex items-center gap-2">
              <select
                className="text-xs rounded border px-2 py-1 flex-1"
                value={lang}
                onChange={(e) => setLang(e.target.value as AuthoringLanguage)}
              >
                {AUTHORING_LANGUAGES.map((l) => (
                  <option key={l} value={l}>{LANGUAGE_LABEL[l]}</option>
                ))}
              </select>
              <button
                type="button"
                className="text-xs rounded border px-2 py-1"
                onClick={() => insert('', lang)}
              >
                Insert
              </button>
            </div>
            <p className="text-xs opacity-60">
              Adds the fence and the right language tag. Paste your code inside it.
            </p>
          </div>

          {/* ── Worked snippets ── */}
          <div className="p-2.5 space-y-1">
            <div className="text-xs font-medium mb-1">Starting points</div>
            {STEM_SNIPPETS.map((s) => (
              <button
                key={s.id}
                type="button"
                className="w-full text-left rounded px-2 py-1.5 hover:opacity-80"
                style={{ border: '1px solid var(--ef-border)' }}
                onClick={() => insert(s.code, s.language)}
              >
                <div className="text-xs font-medium">{s.label}</div>
                <div className="text-xs opacity-60">{s.hint}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default SnippetToolbar;
