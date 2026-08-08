/**
 * The telemetry decisions that matter.
 *
 * Two of these are about a person rather than a program. `isPasteShaped`
 * produces a signal a human may act on, and `telemetryEnabled` decides whether
 * anyone is recorded at all — so both are tested for what they REFUSE to say,
 * not only for what they detect.
 */

import { describe, it, expect } from 'vitest';
import {
  IDLE_GAP_MS,
  MAX_EVENTS,
  TYPING_GAP_MS,
  bound,
  compact,
  isPasteShaped,
  summarise,
  telemetryEnabled,
  type TelemetryEvent,
} from './codeTelemetry';

const ins = (t: number, from: number, text: string, dur?: number): TelemetryEvent =>
  ({ k: 'edit', t, from, to: from, text, ...(dur === undefined ? {} : { dur }) });
const del = (t: number, from: number, to: number): TelemetryEvent =>
  ({ k: 'edit', t, from, to, text: '' });

describe('compact', () => {
  it('merges a run of typing into one event carrying its duration', () => {
    // Without this an hour of work is unstorable. With it the record is
    // strictly more informative, because the duration is what distinguishes
    // typing from pasting.
    const typed = 'def solve():'.split('').map((c, i) => ins(i * 100, i, c));
    const out = compact(typed);
    expect(out).toHaveLength(1);
    expect((out[0] as { text: string }).text).toBe('def solve():');
    expect((out[0] as { dur: number }).dur).toBe(1100);
  });

  it('breaks the run on a pause, because that is a thing a reviewer watches happen', () => {
    const out = compact([
      ins(0, 0, 'a'),
      ins(100, 1, 'b'),
      ins(100 + TYPING_GAP_MS + 1, 2, 'c'),
    ]);
    expect(out).toHaveLength(2);
    expect((out[0] as { text: string }).text).toBe('ab');
  });

  it('breaks on a deletion', () => {
    const out = compact([ins(0, 0, 'ab'), del(100, 1, 2), ins(200, 1, 'c')]);
    expect(out).toHaveLength(3);
  });

  it('breaks when the cursor jumps elsewhere', () => {
    // Editing line 1 then line 40 is two acts, not one.
    const out = compact([ins(0, 0, 'abc'), ins(100, 400, 'xyz')]);
    expect(out).toHaveLength(2);
  });

  it('leaves non-edit events alone and in order', () => {
    const out = compact([ins(0, 0, 'a'), { k: 'run', t: 50 }, ins(100, 1, 'b')]);
    expect(out.map((e) => e.k)).toEqual(['edit', 'run', 'edit']);
  });

  it('is a no-op on an empty stream', () => {
    expect(compact([])).toEqual([]);
  });
});

describe('bound', () => {
  it('keeps the beginning and the end, dropping the middle', () => {
    // The opening shows how a candidate started — blank page, or a block
    // appearing at once — and the end shows what they submitted.
    const many = Array.from({ length: MAX_EVENTS + 500 }, (_, i) => ins(i * 10, i, 'x'));
    const { events, truncated } = bound(many);
    expect(events.length).toBeLessThanOrEqual(MAX_EVENTS);
    expect(truncated).toBeGreaterThan(0);
    expect(events[0].t).toBe(0);                                  // first survives
    expect(events[events.length - 1].t).toBe((MAX_EVENTS + 499) * 10);  // last survives
  });

  it('leaves a normal session untouched and reports nothing truncated', () => {
    const normal = Array.from({ length: 50 }, (_, i) => ins(i * 100, i, 'x'));
    const { events, truncated } = bound(normal);
    expect(events).toHaveLength(50);
    expect(truncated).toBe(0);
  });

  it('terminates on a stream it cannot shrink', () => {
    // A single enormous insertion cannot be reduced by dropping events. The
    // loop must not spin trying.
    const huge = [ins(0, 0, 'x'.repeat(2_000_000))];
    const { events } = bound(huge);
    expect(events).toHaveLength(1);
  });
});

describe('isPasteShaped', () => {
  it('flags a large block that appeared instantly', () => {
    expect(isPasteShaped(ins(0, 0, 'x'.repeat(600)))).toBe(true);
  });

  it('does NOT flag the same text typed over two minutes', () => {
    // Size alone would flag anyone who writes quickly. This signal gets shown
    // to a human deciding something about a person, so it has to be defensible.
    expect(isPasteShaped(ins(0, 0, 'x'.repeat(600), 120_000))).toBe(false);
  });

  it('does not flag short insertions however fast', () => {
    // Autocomplete, bracket matching and an editor inserting a closing quote
    // all produce instant multi-character insertions.
    expect(isPasteShaped(ins(0, 0, 'x'.repeat(20)))).toBe(false);
  });

  it('ignores non-edit events', () => {
    expect(isPasteShaped({ k: 'run', t: 0 })).toBe(false);
  });
});

describe('summarise', () => {
  it('separates active work from idle time', () => {
    const s = summarise([
      ins(0, 0, 'abc', 500),
      ins(1000, 3, 'def', 500),
      ins(1000 + IDLE_GAP_MS + 5000, 6, 'ghi', 500),
    ]);
    expect(s.idleCount).toBe(1);
    expect(s.idleMs).toBeGreaterThanOrEqual(IDLE_GAP_MS);
    expect(s.activeMs).toBeLessThan(s.spanMs);
  });

  it('counts the discrete acts', () => {
    const s = summarise([
      ins(0, 0, 'a'), { k: 'run', t: 10 }, { k: 'blur', t: 20 },
      { k: 'lang', t: 30, to: 'java' }, { k: 'run', t: 40 },
    ]);
    expect(s.runs).toBe(2);
    expect(s.blurs).toBe(1);
    expect(s.languageSwitches).toBe(1);
    expect(s.edits).toBe(1);
  });

  it('excludes pasted text from the typed-character count', () => {
    const s = summarise([ins(0, 0, 'x'.repeat(600)), ins(1000, 600, 'hello', 400)]);
    expect(s.pasteShaped).toBe(1);
    expect(s.typedChars).toBe(5);
    expect(s.largestInsert).toBe(600);
  });

  it('returns zeroes for an empty stream rather than throwing', () => {
    // A candidate who opened a question and wrote nothing is a real case, and
    // the analytics view must render it.
    const s = summarise([]);
    expect(s.spanMs).toBe(0);
    expect(s.edits).toBe(0);
  });
});

describe('telemetryEnabled', () => {
  it('NEVER records a practice attempt, and that is not overridable', () => {
    // Practice is rehearsal, not assessment. Keeping a keystroke record of it
    // serves no analysis anyone would run.
    expect(telemetryEnabled('mock')).toBe(false);
    expect(telemetryEnabled('mock', true)).toBe(false);
  });

  it('records the proctored tiers by default', () => {
    expect(telemetryEnabled('normal')).toBe(true);
    expect(telemetryEnabled('high_stake')).toBe(true);
  });

  it('lets an institution decline to collect it', () => {
    // The reverse of paste, which is locked at high stake. A recording is
    // evidence about a person rather than a restriction on them, and choosing
    // not to gather it is a decision an institution is entitled to make.
    expect(telemetryEnabled('high_stake', false)).toBe(false);
    expect(telemetryEnabled('normal', false)).toBe(false);
  });

  it('does not start recording an attempt that cannot state its tier', () => {
    expect(telemetryEnabled(undefined)).toBe(false);
    expect(telemetryEnabled(undefined, true)).toBe(false);
  });
});
