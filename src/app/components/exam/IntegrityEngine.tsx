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
 *   Fullscreen: document.fullscreenchange
 *   DevTools  : window resize heuristic (polled every 2 s)
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
      // Delay slightly so we don't double-fire alongside visibilitychange
      setTimeout(() => {
        if (!activeRef.current) return;
        if (document.hidden) return; // visibilitychange already handled
        const sinceVisChange = Date.now() - lastVisChangeRef.current;
        if (sinceVisChange < 500) return; // same event pair — skip
        fire('focus_loss', 'Window lost focus', 1500);
      }, 250);
    };

    // ── 6. Fullscreen change ────────────────────────────────────
    const handleFullscreenChange = () => {
      const isNow = !!document.fullscreenElement;
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

    // ── 8. DevTools width heuristic (polled) ───────────────────
    let lastDevtoolsState = false;
    const devtoolsInterval = setInterval(() => {
      if (!activeRef.current) return;
      const widthDiff  = window.outerWidth  - window.innerWidth;
      const heightDiff = window.outerHeight - window.innerHeight;
      const isOpen = widthDiff > 160 || heightDiff > 160;
      if (isOpen && !lastDevtoolsState) {
        fire('devtools_open', `DevTools detected (diff: ${widthDiff}×${heightDiff})`, 8000);
      }
      lastDevtoolsState = isOpen;
    }, 2000);

    // ── Register all ────────────────────────────────────────────
    document.addEventListener('keydown',           handleKeyDown,        { capture: true });
    document.addEventListener('copy',              handleCopy,           { capture: true });
    document.addEventListener('cut',               handleCut,            { capture: true });
    document.addEventListener('paste',             handlePaste,          { capture: true });
    document.addEventListener('contextmenu',       handleContextMenu,    { capture: true });
    document.addEventListener('visibilitychange',  handleVisibilityChange);
    document.addEventListener('fullscreenchange',  handleFullscreenChange);
    window.addEventListener(  'blur',              handleBlur);
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
      window.removeEventListener(  'beforeunload',     handleBeforeUnload);
      clearInterval(devtoolsInterval);
    };
  }, []); // mount-once; all mutable state accessed via refs

  // This component renders nothing
  return null;
}
