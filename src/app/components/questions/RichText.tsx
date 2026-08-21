/**
 * RichText — renders plain text with embedded LaTeX math, code and images.
 *
 * Supported syntax:
 *   ```lang    — fenced code block; the info string after ``` is the language
 *   ...
 *   ```
 *   `code`     — inline code
 *   $$...$$    — block (display) math, rendered centred on its own line
 *   $...$      — inline math, rendered inline with text
 *
 * All four are parsed in a single pass using one combined regex.
 * KaTeX renders to an HTML string; we inject via dangerouslySetInnerHTML
 * on isolated <span> / <div> wrappers so surrounding text stays as React nodes.
 * Code never goes through dangerouslySetInnerHTML — it is rendered as a React
 * text child, so a snippet containing markup is displayed, never executed.
 */

import React from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// ── Segment types ──────────────────────────────────────────────────────────────

type Segment =
  | { kind: 'text';  value: string }
  | { kind: 'math';  value: string; display: boolean }
  | { kind: 'code';  value: string; language: string; block: boolean };

// ── Parser ─────────────────────────────────────────────────────────────────────

/**
 * One pass, ordered alternation. CODE COMES FIRST AND THAT IS LOAD-BEARING:
 * `$` is ordinary in shell, PHP, JS templates and regexes, so a snippet like
 *
 *     echo "$USER owes $5"
 *
 * would otherwise have everything between the dollars swallowed by the math
 * branch and handed to KaTeX. Matching the fence first means the whole block is
 * consumed as code before the math alternatives are ever considered.
 *
 * Triple backticks precede single for the same reason, in the other direction.
 */
const SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g;

/** Split a fenced block into its info string (language) and its source. */
function splitFence(full: string): { language: string; source: string } {
  const inner = full.slice(3, -3);
  const nl = inner.indexOf('\n');
  // No newline at all → a one-liner like ```x```; treat it as source, not a
  // language, because a bare word on the fence line is far more often the code
  // the author meant than a language they forgot to write a body for.
  if (nl === -1) return { language: '', source: inner.trim() };
  const info = inner.slice(0, nl).trim();
  // An info string with spaces is not a language tag.
  const language = /^[A-Za-z0-9+#._-]{1,20}$/.test(info) ? info : '';
  // Drop the fence line when it held a language OR nothing at all — a bare
  // ``` opens the block and its newline is punctuation, not a blank first line
  // of code. Keep it only when the author wrote something there that is not a
  // language tag, because that text is theirs and silently eating a line of a
  // snippet is worse than showing an odd first line.
  const body = language || info === '' ? inner.slice(nl + 1) : inner;
  // Strip only the trailing newline the closing fence sits on — never leading
  // whitespace, which is the code's own indentation.
  return { language, source: body.replace(/\n[ \t]*$/, '') };
}

function parse(raw: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;

  for (const m of raw.matchAll(SEGMENT_RE)) {
    const start = m.index!;
    if (start > last) {
      segments.push({ kind: 'text', value: raw.slice(last, start) });
    }
    const full = m[0];

    if (full.startsWith('```')) {
      const { language, source } = splitFence(full);
      segments.push({ kind: 'code', value: source, language, block: true });
    } else if (full.startsWith('`')) {
      segments.push({ kind: 'code', value: full.slice(1, -1), language: '', block: false });
    } else {
      const display = full.startsWith('$$');
      const formula = display ? full.slice(2, -2).trim() : full.slice(1, -1).trim();
      segments.push({ kind: 'math', value: formula, display });
    }
    last = start + full.length;
  }

  if (last < raw.length) {
    segments.push({ kind: 'text', value: raw.slice(last) });
  }

  return segments;
}

// ── Code styling ───────────────────────────────────────────────────────────────
//
// No syntax highlighting, deliberately. Highlighting needs either a grammar per
// language (a dependency, and the exam bundle is already carrying KaTeX and a
// lazy xlsx) or a hand-rolled tokeniser, which is a correctness liability in a
// paper a candidate is being marked on — mis-tokenised code that LOOKS
// authoritative is worse than plain code. Monospace and honest indentation are
// what make a snippet readable; colour is a nice-to-have that can come with the
// editor work in Stage B.

const MONO = 'var(--font-mono)';

// ── KaTeX renderer ─────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderKatex(formula: string, display: boolean): string {
  try {
    return katex.renderToString(formula, {
      displayMode: display,
      throwOnError: false,
      output: 'html',
      trust: false,
      strict: 'ignore',
    });
  } catch {
    return `<span style="color:var(--ef-danger);font-family:var(--font-mono)">${escapeHtml(formula)}</span>`;
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

        if (seg.kind === 'code') {
          if (!seg.block) {
            return (
              <code
                key={i}
                style={{
                  fontFamily: MONO,
                  fontSize: '0.92em',
                  background: 'var(--ef-canvas)',
                  border: '1px solid var(--ef-border)',
                  borderRadius: 2,
                  padding: '1px 4px',
                  whiteSpace: 'pre',
                }}
              >
                {seg.value}
              </code>
            );
          }

          return (
            <span key={i} className="block my-2">
              {seg.language && (
                <span
                  className="block select-none"
                  style={{
                    fontFamily: MONO,
                    fontSize: 12,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: 'var(--ef-text-muted)',
                    marginBottom: 2,
                  }}
                >
                  {seg.language}
                </span>
              )}
              {/*
                white-space: pre, NOT pre-wrap. Wrapping code re-flows its
                indentation, and indentation is meaning in Python and readability
                everywhere else — a candidate should never have to guess whether
                a line was indented or merely wrapped. The cost is horizontal
                scrolling on a narrow screen, which this platform already accepts
                for DI tables, and which is contained to this block rather than
                the page.
              */}
              <code
                className="block overflow-x-auto"
                style={{
                  fontFamily: MONO,
                  fontSize: '0.92em',
                  lineHeight: 1.55,
                  whiteSpace: 'pre',
                  background: 'var(--ef-canvas)',
                  border: '1px solid var(--ef-border)',
                  borderRadius: 3,
                  padding: '10px 12px',
                  color: 'var(--ef-ink)',
                  tabSize: 4,
                }}
              >
                {seg.value}
              </code>
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
              border: '1px solid var(--ef-border)',
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
      style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2 }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
