/**
 * printGuard
 *
 * Stops the exam paper being printed or saved to PDF, and records the attempt.
 *
 * ── WHY THIS WAS THE GAP ──────────────────────────────────────────
 *
 * Every other exfiltration route has cost attached. Copy and paste are
 * intercepted, right-click is blocked, a screenshot with a snipping tool drops
 * focus and fires `focus_loss`, and an AI sidebar is refused at the door.
 *
 * Printing had none. `Ctrl+P` was not in IntegrityEngine's intercepted keys,
 * nothing listened for `beforeprint`, and there was no `@media print` rule
 * anywhere in the codebase — so "Save as PDF" handed a student the entire
 * visible paper as a file, in one keystroke, and the only thing that might
 * have fired was a single focus_loss when the dialog took focus.
 *
 * ── THREE LAYERS, BECAUSE THE ROUTES DIFFER ───────────────────────
 *
 * 1. The KEY. Ctrl/Cmd+P is preventable, and preventing it is the only layer
 *    that stops the print ever starting. It lives in IntegrityEngine with the
 *    other intercepted keys rather than here, because that is where a reader
 *    looks for "which keys are blocked".
 *
 * 2. The STYLESHEET. The browser menu, the OS print shortcut on some
 *    platforms, and `window.print()` from a console all reach printing without
 *    a keydown this page ever sees. None of them can be prevented — but what
 *    they PRINT is ours to decide, and a print rule that hides the paper turns
 *    the successful route into a blank sheet. This is the layer that actually
 *    protects the questions.
 *
 * 3. The EVENT. `beforeprint` fires on every route including the two above, so
 *    it is what makes the attempt visible in the record even when it could not
 *    be stopped.
 *
 * Layer 2 is deliberately first in the file and first to install: if only one
 * of these survives a future refactor, it should be the one that works against
 * routes nobody enumerated.
 */

/** Marks the document as printing-restricted. The print rule is scoped to it. */
export const PRINT_GUARD_ATTR = 'data-exam-print-guard';

/** Identifies the injected stylesheet so a re-install cannot duplicate it. */
export const PRINT_STYLE_ID = 'exam-print-guard';

/**
 * The print stylesheet.
 *
 * Scoped to the guard attribute rather than applied globally, so printing a
 * results page or a briefing keeps working — the restriction belongs to a
 * sitting in progress, not to the whole application.
 *
 * `visibility` rather than `display: none` on the root: a display change forces
 * a reflow of the live exam when the print media query is evaluated, and
 * Chrome evaluates it against the on-screen layout. Visibility keeps the
 * geometry the student is looking at untouched while printing nothing — a
 * detector must not make the page it protects jump.
 *
 * The message is not decoration. A blank sheet reads as a bug and a student
 * will try again, possibly several times, each one another violation on their
 * record for a thing they did not understand was refused.
 */
export function buildPrintBlockCss(): string {
  return `
@media print {
  [${PRINT_GUARD_ATTR}] body > * { visibility: hidden !important; }
  [${PRINT_GUARD_ATTR}] body::after {
    visibility: visible !important;
    content: "Printing is disabled during an exam. This attempt has been recorded.";
    display: block;
    position: fixed;
    top: 0; left: 0; right: 0;
    padding: 24px;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 14px;
    color: #000;
    background: #fff;
  }
}`.trim();
}

export type PrintGuardOptions = {
  /** Called once per print attempt, whichever route reached it. */
  onPrintAttempt: (detail: string) => void;
};

/**
 * Install the stylesheet and the listeners. Returns a cleanup function.
 *
 * Idempotent on the stylesheet: a re-install reuses the existing node rather
 * than stacking a second copy, so a remount during a live sitting cannot leave
 * duplicates behind.
 */
export function installPrintGuard({ onPrintAttempt }: PrintGuardOptions): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return () => {};
  }

  const root = document.documentElement;
  root.setAttribute(PRINT_GUARD_ATTR, '');

  let style = document.getElementById(PRINT_STYLE_ID) as HTMLStyleElement | null;
  const ownsStyle = style === null;
  if (!style) {
    style = document.createElement('style');
    style.id = PRINT_STYLE_ID;
    style.textContent = buildPrintBlockCss();
    document.head.appendChild(style);
  }

  // One attempt can deliver both `beforeprint` AND a matchMedia change, and on
  // some browsers more than one of each. The record should say a student tried
  // to print, once, not carry four rows describing one keystroke.
  let lastFiredAt = 0;
  const fire = (detail: string) => {
    const now = Date.now();
    if (now - lastFiredAt < 1500) return;
    lastFiredAt = now;
    onPrintAttempt(detail);
  };

  const handleBeforePrint = () => fire('Print dialog opened');

  // Safari has historically not fired `beforeprint`, and the print media query
  // is the long-standing way to see a print there. Both are registered because
  // neither covers every browser this exam runs in, and the throttle above is
  // what makes running both safe rather than noisy.
  const printQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('print')
    : null;
  const handleMediaChange = (e: MediaQueryListEvent) => {
    if (e.matches) fire('Print media query matched');
  };
  printQuery?.addEventListener?.('change', handleMediaChange);

  window.addEventListener('beforeprint', handleBeforePrint);

  return () => {
    window.removeEventListener('beforeprint', handleBeforePrint);
    printQuery?.removeEventListener?.('change', handleMediaChange);
    root.removeAttribute(PRINT_GUARD_ATTR);
    // Only remove what this call created. Two overlapping guards would
    // otherwise have the first cleanup strip the stylesheet out from under the
    // second, leaving a live exam printable.
    if (ownsStyle) style?.remove();
  };
}
