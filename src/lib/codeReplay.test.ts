/**
 * Reconstruction, and the honesty of it.
 *
 * A replay is watched by someone forming a judgement about a person, and every
 * failure mode here is silent: an edit applied to the wrong base produces
 * text, not an error, and that text looks exactly as authoritative as a correct
 * reconstruction. Most of these tests are about the module knowing when it has
 * stopped knowing.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFrames,
  buildMarks,
  duration,
  frameAt,
  mergeChunks,
} from './codeReplay';
import type { TelemetryEvent } from './codeTelemetry';

const seed = (t: number, doc: string, to = 'python3'): TelemetryEvent =>
  ({ k: 'lang', t, to, doc });
const ins = (t: number, from: number, text: string, dur?: number): TelemetryEvent =>
  ({ k: 'edit', t, from, to: from, text, ...(dur === undefined ? {} : { dur }) });
const del = (t: number, from: number, to: number): TelemetryEvent =>
  ({ k: 'edit', t, from, to, text: '' });

const MARK_OPTS = { pasteMinChars: 120, pasteMaxCharsPerSec: 40, idleGapMs: 30_000 };

describe('buildFrames', () => {
  it('reconstructs each intermediate document', () => {
    const frames = buildFrames([
      seed(0, ''),
      ins(100, 0, 'def '),
      ins(200, 4, 'solve():'),
    ]);
    expect(frames.map((f) => f.doc)).toEqual(['', 'def ', 'def solve():']);
    expect(frames.every((f) => f.reliability.ok)).toBe(true);
  });

  it('starts from the seeded starter code, not from empty', () => {
    // The editor already contains starter code that no edit event produced.
    // Without the keyframe every reconstruction would begin from the wrong text.
    const frames = buildFrames([
      seed(0, 'def solve():\n    pass\n'),
      ins(100, 12, ' # note'),
    ]);
    expect(frames[1].doc).toBe('def solve(): # note\n    pass\n');
  });

  it('applies deletions', () => {
    const frames = buildFrames([seed(0, 'abcdef'), del(100, 1, 4)]);
    expect(frames[1].doc).toBe('aef');
  });

  it('re-anchors on a language switch', () => {
    // A switch replaces the whole buffer at once. Without the snapshot the next
    // edit lands on the previous language's text.
    const frames = buildFrames([
      seed(0, 'print(1)'),
      { k: 'lang', t: 500, to: 'java', doc: 'class Main {}' },
      ins(600, 13, '\n'),
    ]);
    expect(frames[2].doc).toBe('class Main {}\n');
    expect(frames[2].reliability.ok).toBe(true);
  });
});

describe('reliability', () => {
  it('reports that it has no starting document, rather than assuming empty', () => {
    // A legacy record with no keyframe. Reconstructing from '' would produce a
    // document that looks plausible and is wrong.
    const frames = buildFrames([ins(0, 0, 'hello')]);
    expect(frames[0].reliability).toEqual({ ok: false, reason: 'no-keyframe', fromIndex: 0 });
  });

  it('detects an edit that cannot apply, and stops trusting itself', () => {
    // An edit beyond the end of the document means events are missing between
    // here and the last keyframe.
    const frames = buildFrames([
      seed(0, 'abc'),
      ins(100, 99, 'x'),
      ins(200, 1, 'y'),
    ]);
    expect(frames[0].reliability.ok).toBe(true);
    expect(frames[1].reliability).toMatchObject({ ok: false, reason: 'out-of-range' });
    expect(frames[2].reliability.ok).toBe(false);   // stays broken
  });

  it('does not guess at an unapplicable edit', () => {
    // Skipping leaves the previous document; guessing would produce a
    // plausible one, which is worse because a reviewer cannot tell them apart.
    const frames = buildFrames([seed(0, 'abc'), ins(100, 99, 'x')]);
    expect(frames[1].doc).toBe('abc');
  });

  it('a later keyframe repairs it', () => {
    const frames = buildFrames([
      seed(0, 'abc'),
      ins(100, 99, 'x'),                                   // breaks
      { k: 'lang', t: 200, to: 'java', doc: 'fixed' },     // ground truth
      ins(300, 5, '!'),
    ]);
    expect(frames[1].reliability.ok).toBe(false);
    expect(frames[2].reliability.ok).toBe(true);
    expect(frames[3].doc).toBe('fixed!');
  });
});

describe('frameAt', () => {
  const frames = buildFrames([seed(0, ''), ins(1000, 0, 'a'), ins(5000, 1, 'b')]);

  it('returns the state as it stood, not an interpolation', () => {
    expect(frameAt(frames, 1000)?.doc).toBe('a');
    expect(frameAt(frames, 4999)?.doc).toBe('a');
    expect(frameAt(frames, 5000)?.doc).toBe('ab');
    expect(frameAt(frames, 99_999)?.doc).toBe('ab');
  });

  it('returns nothing before the recording starts', () => {
    // Showing the first frame here would show work that had not been done yet.
    const later = buildFrames([seed(5000, 'x')]);
    expect(frameAt(later, 0)).toBeNull();
  });

  it('handles an empty recording', () => {
    expect(frameAt([], 0)).toBeNull();
    expect(duration([])).toBe(0);
  });
});

describe('duration', () => {
  it('includes the last event\'s own duration', () => {
    // A compacted typing run ends when the typing ended, not when it started.
    expect(duration(buildFrames([seed(0, ''), ins(1000, 0, 'abc', 2000)]))).toBe(3000);
  });
});

describe('buildMarks', () => {
  it('marks a block that appeared at a rate nobody types at', () => {
    const marks = buildMarks([seed(0, ''), ins(100, 0, 'x'.repeat(400))], MARK_OPTS);
    expect(marks.filter((m) => m.kind === 'paste')).toHaveLength(1);
  });

  it('does not mark the same text typed over two minutes', () => {
    const marks = buildMarks([seed(0, ''), ins(100, 0, 'x'.repeat(400), 120_000)], MARK_OPTS);
    expect(marks.some((m) => m.kind === 'paste')).toBe(false);
  });

  it('describes rather than concludes', () => {
    // A reviewer reading a label quickly must not be handed a verdict.
    const marks = buildMarks([seed(0, ''), ins(100, 0, 'x'.repeat(400))], MARK_OPTS);
    const label = marks.find((m) => m.kind === 'paste')!.label;
    expect(label).toBe('400 characters appeared at once');
    expect(label.toLowerCase()).not.toMatch(/cheat|plagiar|suspic|violat/);
  });

  it('marks runs, focus loss and language switches', () => {
    const marks = buildMarks([
      seed(0, ''), { k: 'run', t: 10 }, { k: 'blur', t: 20 },
      { k: 'lang', t: 30, to: 'java', doc: '' },
    ], MARK_OPTS);
    expect(marks.map((m) => m.kind).sort()).toEqual(['blur', 'lang', 'lang', 'run']);
  });

  it('marks long gaps, so a reviewer can skip them', () => {
    const marks = buildMarks([seed(0, ''), ins(60_000, 0, 'a')], MARK_OPTS);
    const idle = marks.find((m) => m.kind === 'idle');
    expect(idle?.label).toBe('No activity for 60s');
  });
});

describe('mergeChunks', () => {
  it('orders by sequence, not by arrival', () => {
    // Chunks are written by separate calls and a query gives no ordering this
    // can rely on. Getting it wrong applies later edits before earlier ones.
    const merged = mergeChunks([
      { seq: 2, events: [ins(200, 1, 'c')] },
      { seq: 0, events: [seed(0, '')] },
      { seq: 1, events: [ins(100, 0, 'ab')] },
    ]);
    expect(buildFrames(merged).at(-1)?.doc).toBe('acb');
  });

  it('survives a chunk with no events', () => {
    const merged = mergeChunks([
      { seq: 0, events: [seed(0, 'x')] },
      { seq: 1, events: undefined as never },
    ]);
    expect(merged).toHaveLength(1);
  });
});
