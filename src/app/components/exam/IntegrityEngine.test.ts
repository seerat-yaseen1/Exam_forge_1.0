/**
 * The tier policy for pasting into a code answer editor.
 *
 * This is the first client-side suite in the repository, and it starts here
 * deliberately: `codeEditorPasteAllowed` is the one function standing between
 * an honest candidate editing their own code and a violation counting toward
 * termination. It is pure, it is three lines, and until now nothing checked it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import {
  CODE_EDITOR_ATTR,
  codeEditorPasteAllowed,
  initialViewportBaseline,
  readViewportGeometry,
  DEVTOOLS_MIN_DELTA,
  VIEWPORT_MIN_DELTA,
  type ViewportSample,
} from './IntegrityEngine';

describe('codeEditorPasteAllowed', () => {
  it('allows paste in practice, silently', () => {
    expect(codeEditorPasteAllowed('mock')).toBe(true);
  });

  it('blocks paste in a proctored exam', () => {
    expect(codeEditorPasteAllowed('normal')).toBe(false);
  });

  it('blocks paste at high stake, and LOCKS it', () => {
    expect(codeEditorPasteAllowed('high_stake')).toBe(false);
    // The lock is the point. Camera, mobile and extension-check are all locked
    // at this tier; an override that could switch paste back on would make it
    // the one deterrent an authority could quietly disable.
    expect(codeEditorPasteAllowed('high_stake', true)).toBe(false);
  });

  it('honours an override at the tiers where the setting is not locked', () => {
    expect(codeEditorPasteAllowed('normal', true)).toBe(true);
    expect(codeEditorPasteAllowed('mock', false)).toBe(false);
  });

  it('treats an unknown or missing tier as proctored, not as practice', () => {
    // A legacy attempt predating securityTier, or a value from a newer writer.
    // The safe default is the strict one: a paper that cannot state its tier
    // must not be handed the permissive branch.
    expect(codeEditorPasteAllowed(undefined)).toBe(false);
    expect(codeEditorPasteAllowed('something_new' as never)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// THE EXEMPTION'S BLAST RADIUS
// ══════════════════════════════════════════════════════════════════
//
// `insideCodeEditor` resolves the exemption with `closest()`, so it applies to
// everything inside ANY element carrying data-exam-code-editor. That is
// correct for one element and dangerous for two: put the attribute on a
// container and every future control inside it inherits a paste exemption
// nobody decided to grant. Lose it and the opposite happens — an ordinary
// keystroke in the editor fires a violation that counts toward termination.
//
// Neither failure is visible in a diff, and the attribute survived a layout
// change (the two-column coding split) that moved everything around it. So it
// is asserted rather than trusted: exactly one element, in the editor.

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the code-editor paste exemption is applied exactly once', () => {
  const srcRoot = path.resolve(__dirname, '..', '..', '..');
  const files = tsxFiles(srcRoot).filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));

  it('only CodeAnswerEditor applies the attribute', () => {
    // The spread form `{...{ [CODE_EDITOR_ATTR]: 'true' }}` is how it is put on
    // an element. Anything else importing the constant is reading, not marking.
    const appliers = files.filter((f) => readFileSync(f, 'utf8').includes(`[${'CODE_EDITOR_ATTR'}]:`));
    expect(appliers.map((f) => path.basename(f))).toEqual(['CodeAnswerEditor.tsx']);
  });

  it('and applies it to exactly one element', () => {
    const src = readFileSync(path.join(__dirname, 'CodeAnswerEditor.tsx'), 'utf8');
    const applications = src.match(/\[CODE_EDITOR_ATTR\]:/g) ?? [];
    expect(applications).toHaveLength(1);
  });

  it('nobody hardcodes the attribute name past the constant', () => {
    // A literal would not show up in the two checks above and would widen the
    // exemption just as effectively.
    const offenders = files.filter((f) => {
      if (path.basename(f) === 'IntegrityEngine.tsx') return false;  // defines it
      return readFileSync(f, 'utf8').includes(`"${CODE_EDITOR_ATTR}"`)
          || readFileSync(f, 'utf8').includes(`'${CODE_EDITOR_ATTR}'`);
    });
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// VIEWPORT GEOMETRY
// ══════════════════════════════════════════════════════════════════
//
// This heuristic writes into a counter an examiner reads when deciding whether
// to void a paper, so the thing under test is not only "does it notice" but
// "does it say the right thing about what it noticed". Every case below is one
// the old single-threshold check got wrong.

const NORMAL: ViewportSample = { w: 16, h: 74, dpr: 1 };  // scrollbar + title bar

describe('readViewportGeometry', () => {
  it('says nothing about an ordinary window', () => {
    const reading = readViewportGeometry(NORMAL, initialViewportBaseline(NORMAL));
    expect(reading).toMatchObject({ kind: 'measured', devtoolsOpen: false, narrowed: false });
  });

  it('names DevTools when the loss is vertical', () => {
    // Bottom-docked DevTools. Nothing else docks there, so the accusation is safe.
    const base = initialViewportBaseline(NORMAL);
    const reading = readViewportGeometry({ ...NORMAL, h: NORMAL.h + 300 }, base);
    expect(reading).toMatchObject({ kind: 'measured', devtoolsOpen: true, narrowed: false });
  });

  it('does NOT name DevTools when the loss is horizontal', () => {
    // A 360px side panel. The old check reported this as devtools_open, which
    // is the misattribution this split exists to stop: a student who opened
    // Chrome's side panel and a student who opened DevTools produced the same
    // counter, and only one of them was doing something a reviewer can act on.
    const base = initialViewportBaseline(NORMAL);
    const reading = readViewportGeometry({ ...NORMAL, w: NORMAL.w + 360 }, base);
    expect(reading).toMatchObject({ kind: 'measured', devtoolsOpen: false, narrowed: true });
  });

  it('reports a right-docked DevTools as narrowed, not as DevTools', () => {
    // Deliberate: from in here it is indistinguishable from a side panel, and
    // reporting the honest observation beats reporting a confident guess.
    const base = initialViewportBaseline(NORMAL);
    const reading = readViewportGeometry({ ...NORMAL, w: NORMAL.w + 500 }, base);
    expect(reading).toMatchObject({ devtoolsOpen: false, narrowed: true });
  });

  it('catches a narrow pane the old 160px threshold missed entirely', () => {
    const base = initialViewportBaseline(NORMAL);
    const pane = 130;                       // under 160, over VIEWPORT_MIN_DELTA
    expect(pane).toBeLessThan(DEVTOOLS_MIN_DELTA);
    expect(pane).toBeGreaterThan(VIEWPORT_MIN_DELTA);
    const reading = readViewportGeometry({ ...NORMAL, w: NORMAL.w + pane }, base);
    expect(reading).toMatchObject({ narrowed: true });
  });

  it('measures the CHANGE, so a machine with fat chrome is not accused at rest', () => {
    // A window with unusually large borders. Absolute thresholds measured the
    // machine; deltas measure the student.
    const chunky: ViewportSample = { w: 100, h: 140, dpr: 1 };
    const reading = readViewportGeometry(chunky, initialViewportBaseline(chunky));
    expect(reading).toMatchObject({ devtoolsOpen: false, narrowed: false });
  });

  it('still reports a panel that was already open when the exam started', () => {
    // The case a plain baseline would silently absorb — and the likeliest one,
    // since anyone intending to use a panel opens it before they begin.
    const preOpened: ViewportSample = { w: 16 + 400, h: 74 + 300, dpr: 1 };
    const base = initialViewportBaseline(preOpened);
    expect(base).toMatchObject({ w: 0, h: 0 });
    const reading = readViewportGeometry(preOpened, base);
    expect(reading).toMatchObject({ devtoolsOpen: true, narrowed: true });
  });

  it('re-baselines on browser zoom instead of firing', () => {
    // Zooming in shrinks innerWidth/innerHeight in CSS pixels while the outer
    // dimensions hold, so both diffs jump. Reporting that would make an
    // integrity signal out of an accessibility setting.
    const base = initialViewportBaseline(NORMAL);
    const zoomed: ViewportSample = { w: NORMAL.w + 220, h: NORMAL.h + 200, dpr: 1.5 };
    const reading = readViewportGeometry(zoomed, base);
    expect(reading.kind).toBe('rebaselined');
    if (reading.kind !== 'rebaselined') throw new Error('unreachable');
    // And the new baseline is the zoomed geometry, so the next poll is quiet…
    expect(readViewportGeometry(zoomed, reading.baseline))
      .toMatchObject({ devtoolsOpen: false, narrowed: false });
    // …while a panel opened AFTER the zoom is still caught.
    expect(readViewportGeometry({ ...zoomed, w: zoomed.w + 300 }, reading.baseline))
      .toMatchObject({ narrowed: true });
  });

  it('is unmoved by the student resizing the window', () => {
    // Dragging a window smaller moves outer and inner together, so the diff
    // holds. This is why the diff is the measured quantity and not innerWidth.
    const base = initialViewportBaseline(NORMAL);
    expect(readViewportGeometry(NORMAL, base))
      .toMatchObject({ devtoolsOpen: false, narrowed: false });
  });

  it('treats each axis independently', () => {
    const base = initialViewportBaseline(NORMAL);
    const both = readViewportGeometry(
      { ...NORMAL, w: NORMAL.w + 300, h: NORMAL.h + 300 }, base,
    );
    expect(both).toMatchObject({ devtoolsOpen: true, narrowed: true });
  });

  it('is exclusive at the threshold, so a value exactly on it does not fire', () => {
    const base = initialViewportBaseline(NORMAL);
    expect(readViewportGeometry({ ...NORMAL, w: NORMAL.w + VIEWPORT_MIN_DELTA }, base))
      .toMatchObject({ narrowed: false });
    expect(readViewportGeometry({ ...NORMAL, h: NORMAL.h + DEVTOOLS_MIN_DELTA }, base))
      .toMatchObject({ devtoolsOpen: false });
  });
});
