/**
 * IntegrityEngine
 *
 * Invisible component. Mounts all anti-cheat event listeners while
 * the exam is active and cleans them all up on unmount.
 *
 * What it intercepts:
 *   Keyboard  : Tab, F5, Ctrl+R, F12, Ctrl+Shift+I/J/C, Ctrl+C/X, Ctrl+V, Escape
 *   Clipboard : copy, cut, paste events
 *   Mouse     : contextmenu (right-click)
 *   Visibility: document.visibilitychange
 *   Focus     : window.blur
 *   Fullscreen: document.fullscreenchange, plus a state poll that catches an
 *               exit whose event never arrived (every 1.5 s)
 *   DevTools  : vertical viewport-loss heuristic (polled every 2 s)
 *   Viewport  : horizontal viewport-loss heuristic — side panel / docked pane
 *   Focus     : hasFocus() vs blur-event disagreement (polled every 2 s)
 *   Render    : requestAnimationFrame rate vs claimed foreground state
 *   Unload    : beforeunload (shows browser dialog)
 */

import { useEffect, useRef } from 'react';
import type { ViolationType } from '../../../lib/submissionService';

// ── Constants ─────────────────────────────────────────────────────

const MAX_VIOLATIONS_BEFORE_THROTTLE_MS = 3000; // don't log the same type faster than this

// ── Props ─────────────────────────────────────────────────────────

interface IntegrityEngineProps {
  /** When false, no violations are fired (e.g. during modal overlays). */
  active: boolean;
  /** Called whenever a violation is detected. */
  onViolation: (type: ViolationType, detail?: string) => void;
  /** Called separately when the user exits fullscreen (for UI handling). */
  onFullscreenChange: (isFullscreen: boolean) => void;
  /**
   * May the candidate paste INSIDE a code editor?
   *
   * Resolved by the caller from the security tier (see codeEditorPasteAllowed):
   * practice yes, proctored and high-stake no. It exists as a separate prop
   * rather than being inferred here because the exemption is narrow — it never
   * relaxes paste anywhere else on the page, and a code editor is the only
   * surface where cutting and moving a block is ordinary work rather than a
   * signal.
   *
   * Default false: a caller that forgets this gets the strict behaviour.
   */
  allowCodeEditorPaste?: boolean;
}

/**
 * Marks the element a code editor owns, so the clipboard handlers can tell
 * "inside the answer editor" from "anywhere else in the exam".
 *
 * An explicit attribute rather than a CodeMirror class: the exemption is a
 * decision this codebase makes, and hanging it on `.cm-content` would make an
 * editor upgrade silently widen or close it.
 */
export const CODE_EDITOR_ATTR = 'data-exam-code-editor';

function insideCodeEditor(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.(`[${CODE_EDITOR_ATTR}]`);
}

/**
 * The settled tier policy for pasting into a code editor.
 *
 * Practice allows it silently. Proctored and high-stake block it, and block it
 * INSIDE the editor too — which is a deliberate cost: a candidate moving a
 * function with cut-and-paste in a proctored exam will be stopped, and told
 * why rather than left thinking the editor is broken. Overridable at 'normal',
 * locked at 'high_stake', matching how applyTierDefaults treats every other
 * deterrent.
 */
export function codeEditorPasteAllowed(
  tier: 'mock' | 'normal' | 'high_stake' | undefined,
  override?: boolean,
): boolean {
  if (tier === 'high_stake') return false;   // LOCKED
  if (tier === 'mock') return override ?? true;
  return override ?? false;                  // 'normal', and unknown/legacy tiers
}

// ══════════════════════════════════════════════════════════════════
// VIEWPORT GEOMETRY — two conclusions from one measurement
// ══════════════════════════════════════════════════════════════════
//
// The old check was `widthDiff > 160 || heightDiff > 160 → devtools_open`, and
// the width half of that was a guess reported as a fact. Nothing docks to the
// BOTTOM of a browser window except DevTools, so vertical loss names itself.
// Horizontal loss does not: a right-docked DevTools panel, Chrome's side
// panel, a translate pane and an extension sidebar all shrink innerWidth the
// same way and are indistinguishable from in here. A typical side panel is
// 320-400px, so it comfortably cleared 160 and was written into devtoolsEvents
// — a counter an examiner reads as "this student opened DevTools" when
// deciding whether to void a paper.
//
// So: height → devtools_open (confident). Width → viewport_narrowed, which
// reports what was observed and leaves the naming to the reviewer. Neither is
// a warning type, so neither counts toward termination; the unambiguous
// DevTools signal remains the intercepted keyboard shortcut. The width
// threshold is LOWER than the old 160 precisely because it no longer has to
// carry an accusation — a 120px pane is worth recording.

/** Vertical viewport loss. DevTools is the only thing that docks below. */
export const DEVTOOLS_MIN_DELTA = 160;
/** Horizontal viewport loss. Any pane; deliberately unattributed. */
export const VIEWPORT_MIN_DELTA = 120;

export type ViewportSample   = { w: number; h: number; dpr: number };
export type ViewportBaseline = { w: number; h: number; dpr: number };

export type ViewportReading =
  | { kind: 'rebaselined'; baseline: ViewportBaseline }
  | { kind: 'measured'; devtoolsOpen: boolean; narrowed: boolean; wDelta: number; hDelta: number };

function measureViewport(): ViewportSample {
  return {
    w: window.outerWidth  - window.innerWidth,
    h: window.outerHeight - window.innerHeight,
    dpr: window.devicePixelRatio,
  };
}

/**
 * The baseline, and why it is conditional.
 *
 * outerWidth - innerWidth is never zero: scrollbars and window borders take
 * some of it, and how much varies by OS and browser. Comparing that absolute
 * figure to a fixed threshold therefore measures the MACHINE as much as the
 * student, so what gets compared is the change since the exam began.
 *
 * But a plain baseline would silently absorb a panel that was ALREADY open
 * when the exam started — the case most worth catching, since anyone intending
 * to use one opens it before they begin. So a gap that already exceeds the
 * threshold at mount is not accepted as this machine's ordinary chrome: the
 * baseline stays at zero on that axis and the first poll reports it.
 */
export function initialViewportBaseline(sample: ViewportSample): ViewportBaseline {
  return {
    w: sample.w > VIEWPORT_MIN_DELTA ? 0 : sample.w,
    h: sample.h > DEVTOOLS_MIN_DELTA ? 0 : sample.h,
    dpr: sample.dpr,
  };
}

/**
 * Classify one sample against the baseline.
 *
 * Browser zoom changes innerWidth/innerHeight in CSS pixels while the outer
 * dimensions hold, so zooming in shifts both diffs upward and would read as a
 * panel appearing out of nowhere. devicePixelRatio moves with browser zoom, so
 * a change in it identifies the zoom, and the answer is to re-baseline rather
 * than to fire: zoom is ordinary accessibility behaviour and reporting it as
 * an integrity signal would punish the students most likely to need it.
 *
 * Resizing the window is not affected either way — dragging a window smaller
 * moves outer and inner together, so the diff, and therefore the delta, holds.
 */
export function readViewportGeometry(
  sample: ViewportSample,
  baseline: ViewportBaseline,
): ViewportReading {
  if (sample.dpr !== baseline.dpr) {
    return {
      kind: 'rebaselined',
      baseline: { w: sample.w, h: sample.h, dpr: sample.dpr },
    };
  }
  const wDelta = sample.w - baseline.w;
  const hDelta = sample.h - baseline.h;
  return {
    kind: 'measured',
    devtoolsOpen: hDelta > DEVTOOLS_MIN_DELTA,
    narrowed:     wDelta > VIEWPORT_MIN_DELTA,
    wDelta,
    hDelta,
  };
}

// ══════════════════════════════════════════════════════════════════
// FOCUS-STATE MISMATCH
// ══════════════════════════════════════════════════════════════════
//
// The blur handler above already reports focus loss, and `focus_loss` is one
// of the three types that count toward termination. Polling document.hasFocus()
// as a SECOND source of the same signal would be a serious mistake: hasFocus()
// is a state and the violation pipeline is edge-triggered, so every tick while
// unfocused would mint another warning and a student who alt-tabbed once and
// took five seconds to come back would be terminated.
//
// What polling actually adds is not the loss — it is the DISAGREEMENT. The
// honest sequence is: focus leaves, `blur` fires, hasFocus() reads false. A
// tool that suppresses the blur event to hide a tab switch cannot also make
// hasFocus() lie, so a window with no focus and no blur behind it is evidence
// the event was intercepted.
//
// That is reported as its own non-warning type. It can never terminate anyone,
// which is correct for a signal this indirect — a reviewer looks at it
// alongside the rest of the record.

/** What the engine has witnessed about focus so far. */
export type FocusWitness = {
  /** Has the page held focus at least once? */
  everFocused: boolean;
  /** Did a `blur` event fire for the focus loss currently in effect? */
  blurAcknowledged: boolean;
};

export function isFocusStateMismatch(
  witness: FocusWitness,
  reading: { hasFocus: boolean; hidden: boolean },
): boolean {
  // A page opened in a background tab has never held focus, so there is no
  // loss to have been suppressed — only a page that never gained it.
  if (!witness.everFocused) return false;
  // A hidden document is a tab switch, which visibilitychange already reports
  // and which legitimately produces no blur on some platforms.
  if (reading.hidden) return false;
  // Focus is present. Nothing to explain.
  if (reading.hasFocus) return false;
  // Focus is gone and the event fired. Ordinary, already reported as
  // focus_loss, and it stays true for as long as the student is away — which
  // is why this tracks an acknowledgement rather than the recency of a blur.
  if (witness.blurAcknowledged) return false;
  return true;
}

// ══════════════════════════════════════════════════════════════════
// FULLSCREEN RECONCILIATION
// ══════════════════════════════════════════════════════════════════
//
// `fullscreenchange` is the only thing that used to tell this engine the
// student had left fullscreen, and an event is exactly the kind of signal a
// devtools console can take away: `document.removeEventListener` on the
// captured handler, or a `stopImmediatePropagation` listener registered
// earlier, and the exit is silent. The gate in ExamShell is driven by the same
// event, so suppressing it does not merely hide the violation — it leaves the
// exam interactive outside fullscreen, which is the whole thing the gate
// exists to prevent.
//
// `document.fullscreenElement` is a property read, not a subscription. Nothing
// short of redefining it on the Document prototype can make it lie, and a poll
// that reads it needs no cooperation from the event system at all.
//
// So the poll does not re-report fullscreen state — the event handler already
// does that when it fires. It reports DISAGREEMENT between what the engine was
// told and what is actually true, and repairs the belief. Same shape as
// isFocusStateMismatch above, and for the same reason: the second source is
// only worth having where it can contradict the first.

/** How often the real fullscreen state is re-read. */
export const FULLSCREEN_POLL_MS = 1500;

export type FullscreenReconcile =
  /** Belief matches reality. Nothing to do. */
  | { action: 'none' }
  /** Reality says fullscreen was lost and no event said so. */
  | { action: 'exit_undetected' }
  /** Reality says fullscreen was regained and no event said so. */
  | { action: 'entry_undetected' };

/**
 * Compare the engine's event-derived belief against the live property.
 *
 * Edge-triggered by construction: the caller adopts the observed value as the
 * new belief, so a student who sits outside fullscreen produces ONE finding
 * rather than one per tick. This matters more here than anywhere else in the
 * engine — fullscreen_exit is a warning type, and a state-triggered version of
 * this would terminate an honest student in four and a half seconds.
 */
export function reconcileFullscreen(
  believedFullscreen: boolean,
  actualFullscreen: boolean,
): FullscreenReconcile {
  if (believedFullscreen === actualFullscreen) return { action: 'none' };
  return actualFullscreen
    ? { action: 'entry_undetected' }
    : { action: 'exit_undetected' };
}

// ══════════════════════════════════════════════════════════════════
// RENDER THROTTLE
// ══════════════════════════════════════════════════════════════════
//
// Browsers throttle requestAnimationFrame almost to a stop in background tabs.
// A page that claims to be visible AND focused while its frames have stopped
// arriving is describing a state the browser does not put pages in — the
// visibility and focus APIs are being answered by something other than the
// browser's real state.
//
// The thresholds are deliberately far past ordinary jank. A loaded machine
// running a code editor and face detection still renders well above this; what
// is being looked for is frames having essentially stopped. Two consecutive
// windows are required so a single long pause — a garbage collection, a heavy
// paint, a model loading — cannot produce a finding on its own.

/** Length of one measurement window. Measured, not assumed — see below. */
export const RENDER_WINDOW_MS = 5000;
/** Below this, frames have effectively stopped rather than merely slowed. */
export const RENDER_MIN_FPS = 3;
/** Consecutive stalled windows before reporting. */
export const RENDER_STALL_WINDOWS = 2;

/**
 * Fold one window into the stall streak.
 *
 * `elapsedMs` is measured rather than assumed because the interval driving
 * these windows is itself throttled in a background tab — trusting the nominal
 * 5s there would compute a frame rate against a window that actually ran much
 * longer, and invent a stall out of the arithmetic.
 *
 * Fires on the window that REACHES the threshold, not on every window past it,
 * so one sustained episode produces one finding rather than a stream.
 */
export function nextThrottleStreak(
  streak: number,
  frames: number,
  elapsedMs: number,
  claimsForeground: boolean,
): { streak: number; fire: boolean; fps: number } {
  // A page that admits to being hidden or unfocused is throttled by the
  // browser exactly as designed. There is nothing inconsistent to report, and
  // this is the branch that keeps an honest tab switch quiet.
  if (!claimsForeground) return { streak: 0, fire: false, fps: 0 };
  if (elapsedMs <= 0) return { streak, fire: false, fps: 0 };

  const fps = frames / (elapsedMs / 1000);
  if (fps >= RENDER_MIN_FPS) return { streak: 0, fire: false, fps };

  const next = streak + 1;
  return { streak: next, fire: next === RENDER_STALL_WINDOWS, fps };
}

// ── Component ─────────────────────────────────────────────────────

export function IntegrityEngine({
  active,
  onViolation,
  onFullscreenChange,
  allowCodeEditorPaste = false,
}: IntegrityEngineProps) {
  const activeRef = useRef(active);
  const allowCodePasteRef = useRef(allowCodeEditorPaste);
  allowCodePasteRef.current = allowCodeEditorPaste;
  const onViolationRef = useRef(onViolation);
  const onFullscreenChangeRef = useRef(onFullscreenChange);

  // Last-fired timestamps per type (client-side throttle to prevent spam)
  const lastFiredRef = useRef<Partial<Record<ViolationType, number>>>({});

  // Track if visibilitychange fires so we don't double-count blur
  const lastVisChangeRef = useRef<number>(0);

  // Keep refs current
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { onViolationRef.current = onViolation; }, [onViolation]);
  useEffect(() => { onFullscreenChangeRef.current = onFullscreenChange; }, [onFullscreenChange]);

  // ── Throttled violation helper ────────────────────────────────

  const fire = (type: ViolationType, detail?: string, throttleMs = 2000) => {
    if (!activeRef.current) return;
    const now = Date.now();
    const last = lastFiredRef.current[type] ?? 0;
    if (now - last < throttleMs) return;
    lastFiredRef.current[type] = now;
    onViolationRef.current(type, detail);
  };

  // ── Mount all listeners ───────────────────────────────────────

  useEffect(() => {
    // Witnessed focus history, shared by the blur/focus handlers and the
    // mismatch poll below. A plain object rather than a ref because it never
    // outlives this effect.
    const focusWitness: FocusWitness = {
      everFocused: document.hasFocus(),
      blurAcknowledged: false,
    };

    // ── 1. Keydown ──────────────────────────────────────────────
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!activeRef.current) return;

      const key = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const alt = e.altKey;

      // Tab — prevent browser focus escape
      if (key === 'tab') {
        e.preventDefault();
        fire('keyboard_block', 'Tab key blocked');
        return;
      }

      // F5 / Ctrl+R — reload attempt
      if (key === 'f5' || (ctrl && key === 'r')) {
        e.preventDefault();
        fire('reload_attempt', 'Reload attempt blocked');
        return;
      }

      // DevTools shortcuts
      if (
        key === 'f12' ||
        (ctrl && shift && (key === 'i' || key === 'j' || key === 'c'))
      ) {
        e.preventDefault();
        fire('devtools_open', 'DevTools shortcut intercepted', 5000);
        return;
      }

      // Copy / Cut
      if (ctrl && (key === 'c' || key === 'x')) {
        // Where paste is permitted, cut and copy must be too, or cut-and-move
        // is broken in half: the candidate can lift a block and then cannot
        // put it back. The two travel together by construction.
        if (insideCodeEditor(e.target) && allowCodePasteRef.current) return;
        // Allow if nothing is selected in a textarea (natural use)
        const selection = window.getSelection()?.toString();
        if (selection && selection.length > 0) {
          e.preventDefault();
          fire('copy_attempt', `${key === 'x' ? 'Cut' : 'Copy'} attempt blocked`);
        }
        return;
      }

      // Paste
      if (ctrl && key === 'v') {
        if (insideCodeEditor(e.target) && allowCodePasteRef.current) return;
        e.preventDefault();
        fire('paste_attempt', 'Paste attempt blocked');
        return;
      }

      // Ctrl+A — allow selection inside textarea, block otherwise
      if (ctrl && key === 'a') {
        const target = e.target as HTMLElement;
        if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return;
        // Select-all in a code editor is ordinary editing and reveals nothing
        // the candidate cannot already see. Allowed at every tier — unlike
        // paste, it moves no data INTO the exam.
        if (insideCodeEditor(target)) return;
        e.preventDefault();
        return;
      }

      // Ctrl+W — attempt to close tab
      if (ctrl && key === 'w') {
        e.preventDefault();
        fire('keyboard_block', 'Ctrl+W blocked');
        return;
      }

      // Alt+F4 — windows close
      if (alt && key === 'f4') {
        e.preventDefault();
        fire('keyboard_block', 'Alt+F4 blocked');
        return;
      }

      // Escape — note: cannot prevent fullscreen exit, handled via fullscreenchange
      if (key === 'escape') {
        // Don't prevent default so fullscreen can exit (handled separately)
        return;
      }
    };

    // ── 2. Clipboard events ─────────────────────────────────────
    const handleCopy = (e: ClipboardEvent) => {
      if (!activeRef.current) return;
      e.preventDefault();
      fire('copy_attempt', 'Copy event blocked', 1000);
    };

    const handleCut = (e: ClipboardEvent) => {
      if (!activeRef.current) return;
      if (insideCodeEditor(e.target) && allowCodePasteRef.current) return;
      e.preventDefault();
      fire('copy_attempt', 'Cut event blocked', 1000);
    };

    const handlePaste = (e: ClipboardEvent) => {
      if (!activeRef.current) return;
      // Allow paste inside textareas (needed for text answer questions)
      const target = e.target as HTMLElement;
      if (target.tagName === 'TEXTAREA') return;

      // A code editor is a contenteditable div, not a TEXTAREA, so the check
      // above never covered it — every paste inside the answer editor used to
      // fire a violation, including a candidate moving their own code.
      const inEditor = insideCodeEditor(target);
      if (inEditor && allowCodePasteRef.current) return;

      e.preventDefault();
      fire(
        'paste_attempt',
        inEditor ? 'Paste is disabled in this exam' : 'Paste event blocked',
        1000,
      );
    };

    // ── 3. Right-click ──────────────────────────────────────────
    const handleContextMenu = (e: MouseEvent) => {
      if (!activeRef.current) return;
      e.preventDefault();
      fire('right_click', 'Right-click blocked', 3000);
    };

    // ── 4. Tab switch (visibility) ──────────────────────────────
    const handleVisibilityChange = () => {
      if (!activeRef.current) return;
      if (document.hidden) {
        lastVisChangeRef.current = Date.now();
        fire('tab_switch', 'Document became hidden', 1500);
      }
    };

    // ── 5. Focus loss (window blur) ─────────────────────────────
    const handleBlur = () => {
      // Recorded synchronously, before the delay below: the mismatch poll must
      // see the acknowledgement as soon as the event lands, or a poll landing
      // inside the 250ms window would read an unacknowledged focus loss and
      // report the engine's own debounce as evidence of tampering.
      focusWitness.blurAcknowledged = true;
      // Delay slightly so we don't double-fire alongside visibilitychange
      setTimeout(() => {
        if (!activeRef.current) return;
        if (document.hidden) return; // visibilitychange already handled
        const sinceVisChange = Date.now() - lastVisChangeRef.current;
        if (sinceVisChange < 500) return; // same event pair — skip
        fire('focus_loss', 'Window lost focus', 1500);
      }, 250);
    };

    // Focus regained: the loss is over, so the next one needs its own
    // acknowledgement. Also the only place everFocused becomes true for a page
    // that started in a background tab.
    const handleFocus = () => {
      focusWitness.everFocused = true;
      focusWitness.blurAcknowledged = false;
    };

    // ── 6. Fullscreen change ────────────────────────────────────
    // `believedFullscreen` is what the ENGINE has been told, and it is written
    // here and read by the poll below. It starts from the live property rather
    // than from `false` so a student already in fullscreen at mount — the
    // ordinary case, since the briefing page enters it before navigating — is
    // not reported as an undetected entry on the first tick.
    let believedFullscreen = !!document.fullscreenElement;

    const handleFullscreenChange = () => {
      const isNow = !!document.fullscreenElement;
      believedFullscreen = isNow;
      onFullscreenChangeRef.current(isNow);
      if (!isNow && activeRef.current) {
        fire('fullscreen_exit', 'Student exited fullscreen', 1000);
      }
    };

    // ── 7. Beforeunload ─────────────────────────────────────────
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!activeRef.current) return;
      e.preventDefault();
      // Modern browsers require returnValue to show the dialog
      e.returnValue = 'You have an active exam in progress. Are you sure you want to leave?';
    };

    // ── 8. Chrome-geometry heuristics (polled) ─────────────────
    // Measurement and cleanup live here; the rules are in
    // readViewportGeometry above, where they can be tested.
    let baseline = initialViewportBaseline(measureViewport());
    let lastDevtoolsState = false;
    let lastNarrowedState = false;

    const geometryInterval = setInterval(() => {
      if (!activeRef.current) return;

      const reading = readViewportGeometry(measureViewport(), baseline);
      if (reading.kind === 'rebaselined') {
        baseline = reading.baseline;
        return;
      }

      if (reading.devtoolsOpen && !lastDevtoolsState) {
        fire(
          'devtools_open',
          `DevTools docked (viewport lost ${reading.hDelta}px vertically)`,
          8000,
        );
      }
      lastDevtoolsState = reading.devtoolsOpen;

      if (reading.narrowed && !lastNarrowedState) {
        fire(
          'viewport_narrowed',
          `Exam window narrowed by ${reading.wDelta}px — side panel or docked DevTools`,
          8000,
        );
      }
      lastNarrowedState = reading.narrowed;
    }, 2000);

    // ── 9. Focus-state mismatch (polled) ───────────────────────
    // Reports disagreement between the focus EVENTS and the focus STATE, not
    // focus loss itself — see the note on isFocusStateMismatch. Long throttle:
    // a sustained mismatch is one finding, not one every two seconds.
    const focusPollInterval = setInterval(() => {
      if (!activeRef.current) return;
      if (document.hasFocus()) focusWitness.everFocused = true;
      const mismatch = isFocusStateMismatch(focusWitness, {
        hasFocus: document.hasFocus(),
        hidden: document.hidden,
      });
      if (mismatch) {
        fire(
          'focus_state_mismatch',
          'Window reports no focus but no blur event was received',
          30000,
        );
      }
    }, 2000);

    // ── 10. Fullscreen reconciliation (polled) ─────────────────
    // The rules are in reconcileFullscreen above, where they are tested. This
    // runs regardless of `active`: an exam paused behind a modal is still an
    // exam that must not be sitting outside fullscreen, and the UI gate needs
    // to be told either way. Only the VIOLATION is gated on `active` — via
    // `fire`, which already refuses when inactive.
    const fullscreenInterval = setInterval(() => {
      const actual = !!document.fullscreenElement;
      const verdict = reconcileFullscreen(believedFullscreen, actual);
      if (verdict.action === 'none') return;

      // Adopt reality BEFORE reporting, so this is a one-shot edge even if a
      // handler below throws. Without it a suppressed-event exit would fire on
      // every tick and terminate the student in three.
      believedFullscreen = actual;
      onFullscreenChangeRef.current(actual);

      if (verdict.action === 'exit_undetected') {
        // Reported as fullscreen_exit, not as a separate tamper type: the exam
        // IS outside fullscreen, which is the fact that matters, and the
        // student who simply hit Escape on a browser that dropped the event
        // deserves the same treatment as one who hit it on a browser that did
        // not. The detail line carries the distinction for the reviewer.
        fire(
          'fullscreen_exit',
          'Not in fullscreen — detected by state poll, no fullscreenchange event was received',
          1000,
        );
      }
    }, FULLSCREEN_POLL_MS);

    // ── 11. Render throttle (rAF rate) ─────────────────────────
    let frames = 0;
    let windowStart = Date.now();
    let stallStreak = 0;
    let rafId = requestAnimationFrame(function count() {
      frames += 1;
      rafId = requestAnimationFrame(count);
    });

    const renderInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - windowStart;
      const observed = frames;
      frames = 0;
      windowStart = now;
      if (!activeRef.current) { stallStreak = 0; return; }

      const verdict = nextThrottleStreak(
        stallStreak,
        observed,
        elapsed,
        !document.hidden && document.hasFocus(),
      );
      stallStreak = verdict.streak;
      if (verdict.fire) {
        fire(
          'render_throttled',
          `Frames stopped (${verdict.fps.toFixed(1)}/s) while the page reported being focused`,
          60000,
        );
      }
    }, RENDER_WINDOW_MS);

    // ── Register all ────────────────────────────────────────────
    document.addEventListener('keydown',           handleKeyDown,        { capture: true });
    document.addEventListener('copy',              handleCopy,           { capture: true });
    document.addEventListener('cut',               handleCut,            { capture: true });
    document.addEventListener('paste',             handlePaste,          { capture: true });
    document.addEventListener('contextmenu',       handleContextMenu,    { capture: true });
    document.addEventListener('visibilitychange',  handleVisibilityChange);
    document.addEventListener('fullscreenchange',  handleFullscreenChange);
    window.addEventListener(  'blur',              handleBlur);
    window.addEventListener(  'focus',             handleFocus);
    window.addEventListener(  'beforeunload',      handleBeforeUnload);

    // ── Cleanup ─────────────────────────────────────────────────
    return () => {
      document.removeEventListener('keydown',          handleKeyDown,        { capture: true });
      document.removeEventListener('copy',             handleCopy,           { capture: true });
      document.removeEventListener('cut',              handleCut,            { capture: true });
      document.removeEventListener('paste',            handlePaste,          { capture: true });
      document.removeEventListener('contextmenu',      handleContextMenu,    { capture: true });
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      window.removeEventListener(  'blur',             handleBlur);
      window.removeEventListener(  'focus',            handleFocus);
      window.removeEventListener(  'beforeunload',     handleBeforeUnload);
      clearInterval(geometryInterval);
      clearInterval(focusPollInterval);
      clearInterval(fullscreenInterval);
      clearInterval(renderInterval);
      cancelAnimationFrame(rafId);
    };
  }, []); // mount-once; all mutable state accessed via refs

  // This component renders nothing
  return null;
}
