/**
 * heartbeatQuiet
 *
 * "How long since the server last heard from this student's browser."
 *
 * ExamShell pings examHeartbeat every 15s on the proctored tiers and the
 * server stamps lastHeartbeatAt on the attempt document — the same document
 * the roster is already subscribed to. So the signal is present and live, and
 * until now nothing read it: every in-progress row looked identical whether
 * the student was working, had closed the laptop, or was sitting behind a
 * blocked connection.
 *
 * Silence means one of four things:
 *   • the exam tab is closed or the machine is asleep
 *   • the network is down
 *   • Firestore is being blocked to suppress violation reports
 *   • the student walked away with the tab open and the machine slept
 *
 * This deliberately does NOT guess which. An invigilator who sees "quiet 6m"
 * goes and looks, and looking is the correct response to all four. Naming one
 * would be a guess dressed as a finding — the same mistake the old DevTools
 * width heuristic made.
 *
 * Derived, never stored: it is a function of the clock, so it cannot go stale
 * and there is nothing to keep in sync.
 */

import type { Attempt } from './submissionService';

/** ~4 missed beats at the client's 15s interval — past ordinary jitter. */
export const QUIET_NOTICE_SECONDS = 60;
/** 4m — no longer plausibly a blip. */
export const QUIET_CONCERN_SECONDS = 240;
/** 15m — treat as walked away. */
export const QUIET_ALARM_SECONDS = 900;

export type QuietTone = 'notice' | 'concern' | 'alarm';
export type QuietState = { seconds: number; tone: QuietTone };

/**
 * Null means "say nothing" — either the attempt is not expected to beat, or it
 * is beating normally. Every null branch below is a case where a badge would
 * be a false alarm, and a roster full of false alarms is worse than no badge:
 * the invigilator stops reading it, including on the row that mattered.
 */
export function deriveQuiet(attempt: Attempt | null | undefined, nowMs: number): QuietState | null {
  if (!attempt) return null;

  // Only the proctored tiers heartbeat at all — see the tier guard on the
  // heartbeat effect in ExamShell. Without this check every mock sitting would
  // show permanently silent, which is not a signal about the student, it is
  // the absence of a feature.
  const tier = attempt.securityConfig?.tier;
  if (tier !== 'normal' && tier !== 'high_stake') return null;

  // A finished attempt has stopped by design. A paused one is refused by
  // examHeartbeat server-side, so its stamp is frozen at the moment of the
  // freeze and would age indefinitely while an invigilator deliberates.
  if (attempt.status !== 'in_progress') return null;
  if (attempt.frozenAt) return null;

  // No stamp yet: the attempt exists but the first beat has not landed. That
  // is the opening seconds of a sitting, not silence.
  if (!attempt.lastHeartbeatAt) return null;
  const lastMs = Date.parse(attempt.lastHeartbeatAt);
  if (!Number.isFinite(lastMs)) return null;

  const seconds = Math.floor((nowMs - lastMs) / 1000);
  // A future stamp means the viewer's clock is behind the server's. Clock skew
  // is the roster's problem, never the student's — report nothing rather than
  // a negative age.
  if (seconds < QUIET_NOTICE_SECONDS) return null;

  return {
    seconds,
    tone: seconds >= QUIET_ALARM_SECONDS
      ? 'alarm'
      : seconds >= QUIET_CONCERN_SECONDS ? 'concern' : 'notice',
  };
}

/** Badge text. Sub-minute is only reachable at the notice threshold itself. */
export function formatQuiet(quiet: QuietState): string {
  const mins = Math.floor(quiet.seconds / 60);
  return mins < 1 ? `quiet ${quiet.seconds}s` : `quiet ${mins}m`;
}
