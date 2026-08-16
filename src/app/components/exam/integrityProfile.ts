/**
 * Which detectors run, resolved from the tier and the device.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────
 * IntegrityEngine ran the identical twelve detectors on every sitting, on
 * every device. That was correct while every sitting was on a desktop. It
 * stops being correct the moment a practice exam is opened on a phone, and it
 * fails in the direction nobody checks for: not by missing something, but by
 * reporting things that did not happen.
 *
 * Three detectors measure DESKTOP BROWSER CHROME and read a phone as an
 * incident:
 *
 *   devtools_open      `outerHeight - innerHeight` over 160px. On Android
 *                      Chrome that gap exceeds 160 at rest, so
 *                      initialViewportBaseline refuses to accept it as
 *                      ordinary chrome, zeroes the axis, and the FIRST poll
 *                      fires. Every phone. Before the student answers
 *                      anything. Then the on-screen keyboard fires it again.
 *
 *   viewport_narrowed  Horizontal loss over 120px — i.e. rotating the phone.
 *
 *   render_throttled   rAF below 3fps while claiming foreground. iOS throttles
 *                      rAF during scroll momentum, which is how a student
 *                      reading a long passage generates one.
 *
 * And one measures a mouse:
 *
 *   right_click        `contextmenu`, which on a touchscreen is a long press —
 *                      what a student does to read a word, not to cheat.
 *
 * An integrity log full of events the device manufactured is worse than no log
 * at all: it is a record an examiner will read as evidence, and the student
 * cannot argue with it because it is technically true that the event fired.
 *
 * ── THE OTHER HALF ────────────────────────────────────────────────
 * 'mock' is practice. It already skips the heartbeat (ExamShell) and code
 * telemetry (codeTelemetry.ts) on the grounds that rehearsal is not assessed.
 * The termination threshold is the same argument and was the one place it had
 * not been applied — a student practising on a phone, whose keyboard blurs the
 * window three times, had their practice paper auto-submitted and terminated.
 * Mock now RECORDS every warning and terminates on none of them. The counters
 * still fill, so a student who wants to see how they did against the rules
 * can, and so can the faculty member who set the practice paper.
 *
 * ── WHAT DOES NOT CHANGE ──────────────────────────────────────────
 * A 'normal' or 'high_stake' sitting on a desktop resolves to exactly what
 * shipped before this file existed. That is asserted directly in
 * integrityProfile.test.ts rather than left to inspection, because it is the
 * property that makes this change safe and the only one a reviewer really has
 * to believe.
 */

import type { DeviceClass } from '../../../lib/deviceClass';

export type SecurityTier = 'mock' | 'normal' | 'high_stake';

export type IntegrityProfile = {
  /**
   * Poll `outerHeight - innerHeight` and report vertical loss as a docked
   * DevTools panel. Desktop only — see the header.
   */
  viewportGeometry: boolean;
  /**
   * Report a `contextmenu` event as `right_click`. Suppressing the VIOLATION
   * is not the same as allowing the menu: IntegrityEngine still calls
   * preventDefault either way, because the copy deterrent is wanted on every
   * device and only the accusation is wrong on a touchscreen.
   */
  contextMenuViolation: boolean;
  /** Compare rAF cadence against the claimed foreground state. */
  renderThrottle: boolean;
  /**
   * Do accumulated warnings end the sitting?
   *
   * False does NOT mean "do not count". Violations are still fired, still
   * logged, still counted by the server. It means the third one does not
   * auto-submit the paper.
   */
  warningsTerminate: boolean;
  /**
   * Shown to the student on the briefing page, so the rules they are told
   * match the rules that will actually run. Without this the briefing said
   * "after 3 violations your exam will be terminated" to a practice candidate
   * for whom it was never true.
   */
  summary: {
    monitored: boolean;
    terminates: boolean;
  };
};

/**
 * A touchscreen device cannot carry the geometry detectors, whatever the tier
 * asks for. This is not leniency — those three detectors produce no true
 * positives on a phone, only noise — and it applies at high_stake too, where
 * the device would have been refused at the door anyway unless an authority
 * deliberately admitted tablets.
 */
export function resolveIntegrityProfile(
  tier: SecurityTier | undefined,
  device: DeviceClass,
): IntegrityProfile {
  const isDesktop = device === 'desktop';
  // A missing tier is a legacy attempt and resolves to the strict side, the
  // same rule codeEditorPasteAllowed applies to the same input.
  const isMock = tier === 'mock';

  return {
    viewportGeometry: isDesktop,
    contextMenuViolation: isDesktop,
    renderThrottle: isDesktop,
    warningsTerminate: !isMock,
    summary: {
      monitored: !isMock,
      terminates: !isMock,
    },
  };
}
