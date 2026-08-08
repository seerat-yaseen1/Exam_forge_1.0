/**
 * The snippet library, and the two text transforms an author actually notices
 * when they are wrong.
 *
 * A starter template that does not compile teaches candidates to distrust the
 * starting state. A fenced block inserted mid-sentence renders as literal
 * backticks, which looks like the editor is broken rather than like a
 * formatting rule was broken.
 */

import { describe, it, expect } from 'vitest';
import {
  FENCE_TAG,
  STARTER_TEMPLATES,
  STEM_SNIPPETS,
  asFencedBlock,
  insertBlockAt,
  snippetsForLanguage,
  starterTemplate,
} from './codeSnippets';
import { AUTHORING_LANGUAGES } from './codeAuthoring';

describe('starter templates', () => {
  it('covers every language the platform runs', () => {
    // A language offered in the picker with no template gives an author an
    // empty box and no indication that is the intended state.
    for (const lang of AUTHORING_LANGUAGES) {
      expect(starterTemplate(lang).length).toBeGreaterThan(0);
    }
  });

  it('leaves the answer out', () => {
    // A stub that solves half the problem changes what is being assessed.
    for (const lang of AUTHORING_LANGUAGES) {
      expect(STARTER_TEMPLATES[lang]).toMatch(/your (code|query) here/);
    }
  });

  it('ends with a newline, so an editor does not open on a cursorless last line', () => {
    for (const lang of AUTHORING_LANGUAGES) {
      expect(STARTER_TEMPLATES[lang].endsWith('\n')).toBe(true);
    }
  });
});

describe('FENCE_TAG', () => {
  it('maps every language to a highlighter tag', () => {
    for (const lang of AUTHORING_LANGUAGES) {
      expect(FENCE_TAG[lang]).toBeTruthy();
    }
  });

  it('uses the highlighter\'s name, not the platform\'s', () => {
    // The platform calls it python3; the highlighter knows python. Assuming
    // they match is exactly the kind of thing that silently renders unstyled.
    expect(FENCE_TAG.python3).toBe('python');
  });
});

describe('asFencedBlock', () => {
  it('wraps code with the right tag', () => {
    expect(asFencedBlock('print(1)', 'python3')).toBe('```python\nprint(1)\n```');
  });

  it('normalises trailing whitespace to exactly one newline', () => {
    // Too many and the block renders with a gap that reads as a mistake; none
    // and a paste without a trailing newline swallows the closing fence.
    expect(asFencedBlock('print(1)\n\n\n', 'python3')).toBe('```python\nprint(1)\n```');
    expect(asFencedBlock('print(1)', 'python3')).toContain('print(1)\n```');
  });

  it('leaves interior blank lines alone — they are the author\'s formatting', () => {
    expect(asFencedBlock('a\n\nb', 'python3')).toBe('```python\na\n\nb\n```');
  });
});

describe('insertBlockAt', () => {
  const block = '```python\nx\n```';

  it('forces a blank line before a block inserted mid-sentence', () => {
    // Markdown will not open a fence on the same line as prose. Without this
    // the author gets literal backticks and blames the editor.
    const { text } = insertBlockAt('Consider this:', 14, block);
    expect(text).toBe('Consider this:\n\n```python\nx\n```');
  });

  it('does not pile up blank lines that are already there', () => {
    const { text } = insertBlockAt('Consider:\n\n', 11, block);
    expect(text).toBe('Consider:\n\n```python\nx\n```');
  });

  it('separates the block from text that follows it', () => {
    const { text } = insertBlockAt('before after', 6, block);
    expect(text).toBe('before\n\n```python\nx\n```\n\n after');
  });

  it('inserts cleanly into an empty stem', () => {
    const { text, cursor } = insertBlockAt('', 0, block);
    expect(text).toBe(block);
    expect(cursor).toBe(block.length);
  });

  it('leaves the caret after the block, where typing continues', () => {
    const { text, cursor } = insertBlockAt('intro', 5, block);
    expect(text.slice(0, cursor).endsWith('```')).toBe(true);
  });

  it('clamps a cursor outside the string rather than throwing', () => {
    // A stale cursor from a re-render is a real case and must not lose the stem.
    expect(insertBlockAt('abc', 999, block).text).toContain('abc');
    expect(insertBlockAt('abc', -5, block).text).toContain('abc');
  });
});

describe('stem snippets', () => {
  it('every snippet declares a language the platform runs', () => {
    for (const s of STEM_SNIPPETS) {
      expect(AUTHORING_LANGUAGES).toContain(s.language);
    }
  });

  it('every snippet says what it is for', () => {
    // An author scanning a list needs to know why a snippet is there without
    // reading the code.
    for (const s of STEM_SNIPPETS) {
      expect(s.hint.length).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it('has unique ids', () => {
    expect(new Set(STEM_SNIPPETS.map((s) => s.id)).size).toBe(STEM_SNIPPETS.length);
  });

  it('filters by language, and returns everything when unfiltered', () => {
    expect(snippetsForLanguage('java').every((s) => s.language === 'java')).toBe(true);
    expect(snippetsForLanguage()).toHaveLength(STEM_SNIPPETS.length);
  });

  it('stays small enough to read', () => {
    // A library big enough to pick from without reading is a library that puts
    // the same question in front of every cohort.
    expect(STEM_SNIPPETS.length).toBeLessThanOrEqual(20);
  });
});
