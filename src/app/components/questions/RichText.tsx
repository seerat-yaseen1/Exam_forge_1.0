/**
 * RichText — renders plain text with embedded LaTeX math and images.
 *
 * Supported syntax:
 *   $$...$$   — block (display) math, rendered centred on its own line
 *   $...$     — inline math, rendered inline with text
 *
 * Both delimiters are parsed in a single pass using a combined regex.
 * KaTeX renders to an HTML string; we inject via dangerouslySetInnerHTML
 * on isolated <span> / <div> wrappers so surrounding text stays as React nodes.
 */

import React from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// ── Segment types ──────────────────────────────────────────────────────────────

type Segment =
  | { kind: 'text';  value: string }
  | { kind: 'math';  value: string; display: boolean };

// ── Parser ─────────────────────────────────────────────────────────────────────

const MATH_RE = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g;

function parse(raw: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;

  for (const m of raw.matchAll(MATH_RE)) {
    const start = m.index!;
    if (start > last) {
      segments.push({ kind: 'text', value: raw.slice(last, start) });
    }
    const full    = m[0];
    const display = full.startsWith('$$');
    const formula = display ? full.slice(2, -2).trim() : full.slice(1, -1).trim();
    segments.push({ kind: 'math', value: formula, display });
    last = start + full.length;
  }

  if (last < raw.length) {
    segments.push({ kind: 'text', value: raw.slice(last) });
  }

  return segments;
}

// ── KaTeX renderer ─────────────────────────────────────────────────────────────

function renderKatex(formula: string, display: boolean): string {
  try {
    return katex.renderToString(formula, {
      displayMode: display,
      throwOnError: false,
      output: 'html',
    });
  } catch {
    return `<span style="color:#9B2828;font-family:monospace">${formula}</span>`;
  }
}

// ── Main component ─────────────────────────────────────────────────────────────

interface RichTextProps {
  /** Raw text, potentially containing $...$ or $$...$$ math. */
  text: string;
  /** Optional image URL shown below the text block. */
  image?: string;
  /** Extra class name on the root wrapper. */
  className?: string;
  /** Inline style on the root wrapper. */
  style?: React.CSSProperties;
  /** Called when the image is clicked — optional lightbox hook. */
  onImageClick?: (url: string) => void;
}

export function RichText({ text, image, className, style, onImageClick }: RichTextProps) {
  const segments = parse(text || '');

  return (
    <span className={className} style={style}>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return (
            <span key={i} style={{ whiteSpace: 'pre-wrap' }}>
              {seg.value}
            </span>
          );
        }

        if (seg.display) {
          return (
            <span
              key={i}
              className="block my-2 overflow-x-auto"
              dangerouslySetInnerHTML={{ __html: renderKatex(seg.value, true) }}
            />
          );
        }

        return (
          <span
            key={i}
            dangerouslySetInnerHTML={{ __html: renderKatex(seg.value, false) }}
          />
        );
      })}

      {image && (
        <span className="block mt-3">
          <img
            src={image}
            alt="Question image"
            onClick={() => onImageClick?.(image)}
            className="rounded max-h-64 max-w-full object-contain"
            style={{
              border: '1px solid #E3E1DB',
              borderRadius: 3,
              cursor: onImageClick ? 'zoom-in' : 'default',
              display: 'block',
            }}
          />
        </span>
      )}
    </span>
  );
}

// ── Standalone math preview (used in the math input popover) ───────────────────

interface MathPreviewProps {
  formula: string;
  display?: boolean;
}

export function MathPreview({ formula, display = false }: MathPreviewProps) {
  if (!formula.trim()) return null;
  const html = renderKatex(formula, display);
  return (
    <div
      className="px-3 py-2 rounded overflow-x-auto"
      style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
