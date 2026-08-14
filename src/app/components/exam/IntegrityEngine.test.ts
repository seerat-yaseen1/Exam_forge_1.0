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
  isFocusStateMismatch,
  reconcileFullscreen,
  nextThrottleStreak,
  RENDER_MIN_FPS,
  type ViewportSample,
  type FocusWitness,
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

// ══════════════════════════════════════════════════════════════════
// FOCUS-STATE MISMATCH
// ══════════════════════════════════════════════════════════════════
//
// The danger here is not missing a signal, it is producing one. focus_loss is
// a warning type and three warnings end an exam, so the reason this reports a
// DISAGREEMENT rather than the focus loss itself is that polling the loss
// would terminate a student who alt-tabbed once and took a few seconds to come
// back. Every case below is a state that must stay quiet.

const witnessed = (over: Partial<FocusWitness> = {}): FocusWitness =>
  ({ everFocused: true, blurAcknowledged: false, ...over });

describe('isFocusStateMismatch', () => {
  it('is quiet while the page holds focus', () => {
    expect(isFocusStateMismatch(witnessed(), { hasFocus: true, hidden: false })).toBe(false);
  });

  it('is quiet for an ordinary focus loss the blur event announced', () => {
    expect(isFocusStateMismatch(
      witnessed({ blurAcknowledged: true }), { hasFocus: false, hidden: false },
    )).toBe(false);
  });

  it('stays quiet however long that ordinary loss lasts', () => {
    // The acknowledgement is a fact about the current loss, not a recent
    // event, so it does not decay. A student away for ten minutes is reported
    // once by the blur handler and never by this one.
    const w = witnessed({ blurAcknowledged: true });
    for (let poll = 0; poll < 300; poll++) {
      expect(isFocusStateMismatch(w, { hasFocus: false, hidden: false })).toBe(false);
    }
  });

  it('is quiet for a tab switch, which visibilitychange owns', () => {
    expect(isFocusStateMismatch(witnessed(), { hasFocus: false, hidden: true })).toBe(false);
  });

  it('is quiet on a page that has never held focus', () => {
    // Opened in a background tab: there is no loss to have been suppressed,
    // only focus never gained.
    expect(isFocusStateMismatch(
      witnessed({ everFocused: false }), { hasFocus: false, hidden: false },
    )).toBe(false);
  });

  it('reports focus gone with no blur behind it', () => {
    // The one state the browser does not produce on its own: something
    // intercepted the event. hasFocus() cannot be made to lie the same way.
    expect(isFocusStateMismatch(witnessed(), { hasFocus: false, hidden: false })).toBe(true);
  });

  it('goes quiet again once focus returns and comes back on the next suppression', () => {
    const w = witnessed();
    expect(isFocusStateMismatch(w, { hasFocus: false, hidden: false })).toBe(true);
    // handleFocus resets the acknowledgement for the next loss.
    w.blurAcknowledged = false;
    expect(isFocusStateMismatch(w, { hasFocus: true, hidden: false })).toBe(false);
    expect(isFocusStateMismatch(w, { hasFocus: false, hidden: false })).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// RENDER THROTTLE
// ══════════════════════════════════════════════════════════════════
//
// A page claiming to be visible and focused while its frames have stopped is
// describing a state the browser does not put pages in. The risk is jank: this
// tab runs a code editor and, on the proctored tiers, face detection, so the
// thresholds have to sit far below anything a merely busy machine produces.

const FULL_WINDOW = 5000;

describe('nextThrottleStreak', () => {
  it('is quiet at an ordinary frame rate', () => {
    expect(nextThrottleStreak(0, 300, FULL_WINDOW, true))
      .toMatchObject({ streak: 0, fire: false });
  });

  it('is quiet on a janky but living machine', () => {
    // 10fps is a bad time; it is not a stopped tab.
    expect(nextThrottleStreak(0, 50, FULL_WINDOW, true))
      .toMatchObject({ streak: 0, fire: false });
  });

  it('needs two consecutive stalled windows, not one', () => {
    // A single long pause — garbage collection, a heavy paint, a model
    // loading — must not be enough on its own.
    const first = nextThrottleStreak(0, 2, FULL_WINDOW, true);
    expect(first).toMatchObject({ streak: 1, fire: false });
    expect(nextThrottleStreak(first.streak, 2, FULL_WINDOW, true))
      .toMatchObject({ streak: 2, fire: true });
  });

  it('resets the streak when frames recover', () => {
    const stalled = nextThrottleStreak(0, 1, FULL_WINDOW, true);
    expect(stalled.streak).toBe(1);
    expect(nextThrottleStreak(stalled.streak, 300, FULL_WINDOW, true))
      .toMatchObject({ streak: 0, fire: false });
  });

  it('reports a sustained stall once, not once per window', () => {
    let streak = 0;
    const fires: number[] = [];
    for (let w = 0; w < 20; w++) {
      const v = nextThrottleStreak(streak, 0, FULL_WINDOW, true);
      streak = v.streak;
      if (v.fire) fires.push(w);
    }
    expect(fires).toEqual([1]);   // the window that reached the threshold
  });

  it('is quiet when the page admits to being hidden or unfocused', () => {
    // The browser throttles background tabs by design. This branch is what
    // keeps an honest tab switch from also being reported as a render stall.
    expect(nextThrottleStreak(0, 0, FULL_WINDOW, false))
      .toMatchObject({ streak: 0, fire: false });
    // …and it clears any streak built up before the tab went away.
    expect(nextThrottleStreak(1, 0, FULL_WINDOW, false))
      .toMatchObject({ streak: 0, fire: false });
  });

  it('measures against the real elapsed time, not the nominal window', () => {
    // setInterval is itself throttled in a background tab, so a "5s" window
    // can actually run far longer. Trusting the nominal length would invent a
    // stall out of the arithmetic: 40 frames is 8fps over 5s but 1.3fps over
    // 30s, and only one of those readings is true.
    expect(nextThrottleStreak(0, 40, 5000, true)).toMatchObject({ fire: false, streak: 0 });
    const long = nextThrottleStreak(0, 40, 30000, true);
    expect(long.fps).toBeLessThan(RENDER_MIN_FPS);
    expect(long.streak).toBe(1);
  });

  it('refuses to divide by a zero-length window', () => {
    expect(nextThrottleStreak(1, 0, 0, true)).toMatchObject({ streak: 1, fire: false });
  });
});

// ══════════════════════════════════════════════════════════════════
// FULLSCREEN RECONCILIATION
// ══════════════════════════════════════════════════════════════════
//
// The poll behind these exists because `fullscreenchange` is a subscription
// and `document.fullscreenElement` is not. What is tested here is the part
// that decides, and the property that matters most is the third case: this
// signal feeds a WARNING type, and a version of it that fired per tick rather
// than per transition would terminate an honest student inside five seconds.

describe('reconcileFullscreen', () => {
  it('is silent while belief and reality agree', () => {
    expect(reconcileFullscreen(true, true)).toEqual({ action: 'none' });
    expect(reconcileFullscreen(false, false)).toEqual({ action: 'none' });
  });

  it('reports an exit that produced no event', () => {
    // Belief says fullscreen, the property says otherwise: either the event
    // was suppressed or it was never delivered. Either way the exam is not in
    // fullscreen, which is the fact the gate needs.
    expect(reconcileFullscreen(true, false)).toEqual({ action: 'exit_undetected' });
  });

  it('reports an unannounced RE-ENTRY without calling it a violation', () => {
    // The caller must still be told, or the UI gate stays up over an exam that
    // is legitimately back in fullscreen and the student cannot continue.
    expect(reconcileFullscreen(false, true)).toEqual({ action: 'entry_undetected' });
  });

  it('is edge-triggered: a sustained exit is one finding, not one per tick', () => {
    // The engine adopts the observed value as the new belief, so the second
    // and later ticks of the same episode have nothing to report. Simulated
    // here exactly as the interval does it.
    let believed = true;
    const actions: string[] = [];
    for (let tick = 0; tick < 20; tick++) {
      const v = reconcileFullscreen(believed, /* still outside */ false);
      actions.push(v.action);
      if (v.action !== 'none') believed = false;
    }
    expect(actions.filter((a) => a !== 'none')).toEqual(['exit_undetected']);
  });

  it('re-arms after the student returns, so a second exit is caught', () => {
    let believed = true;
    const fired: string[] = [];
    const tick = (actual: boolean) => {
      const v = reconcileFullscreen(believed, actual);
      if (v.action !== 'none') { believed = actual; fired.push(v.action); }
    };
    tick(false);  // leaves
    tick(false);  // still out — quiet
    tick(true);   // returns
    tick(false);  // leaves again — must be caught
    expect(fired).toEqual(['exit_undetected', 'entry_undetected', 'exit_undetected']);
  });
});
