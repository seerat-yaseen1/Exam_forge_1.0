/**
 * studentSchedule — "what can I sit, and when", as pure functions.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────
 * Every one of these rules was written inside StudentAssessmentsPage, which
 * was the only screen that needed them. The Overview page needs the same
 * answers — what is open right now, what closes first, what is the single most
 * urgent thing — and the Progress page needs a third slice of them.
 *
 * Two screens computing "can this student still open this exam" from their own
 * copy of the rule is the failure this codebase has paid for before: the card
 * and the briefing disagreeing about whether an attempt is allowed is not a
 * cosmetic bug, it is a student clicking Begin and being refused. So the rules
 * moved here, unchanged, and the pages import them.
 *
 * PURE. No Firestore, no React, no clock of its own — `now` is always a
 * parameter, which is also what makes the tests possible.
 */

import type { Assessment } from './assessmentService';
import type { Attempt, AttemptStatus } from './submissionService';

// ══════════════════════════════════════════════════════════════════
// §1 — SHAPES
// ══════════════════════════════════════════════════════════════════

export type AvailabilityState = 'available' | 'upcoming' | 'window_closed' | 'admin_closed';

export type ScheduleEntry = {
  assessment: Assessment;
  /** The most recent attempt, if any. */
  attempt: Attempt | undefined;
  /** Every attempt on this paper — the attempt-limit maths needs all of them. */
  allAttempts: Attempt[];
  availability: AvailabilityState;
};

/**
 * The three buckets that partition the list. `results` is a VIEW across all
 * three rather than a fourth bucket — see ResultsTab.tsx for why.
 */
export type ScheduleBucket = 'available' | 'missed' | 'submitted';

export const FINISHED_STATUSES: AttemptStatus[] = ['submitted', 'auto_submitted', 'terminated'];

export function finishedCount(attempts: Attempt[]): number {
  return attempts.filter((at) => FINISHED_STATUSES.includes(at.status)).length;
}

// ══════════════════════════════════════════════════════════════════
// §2 — THE RULES
// ══════════════════════════════════════════════════════════════════

export function getAvailability(a: Assessment, now: Date): AvailabilityState {
  if (a.status === 'closed') return 'admin_closed';

  const start = a.startDate ? new Date(a.startDate) : null;
  const end   = a.endDate   ? new Date(a.endDate)   : null;

  if (start && now < start) return 'upcoming';
  if (end   && now > end)   return 'window_closed';
  return 'available';
}

/**
 * The student can still open/access the test when the window is active AND
 * they're not blocked AND either an in-progress attempt exists to resume OR
 * they have remaining attempts (respecting per-student override). Mirrors the
 * gate in ExamBriefingPage so the card and the briefing never disagree.
 */
export function canStillOpen(
  a: Assessment,
  availability: AvailabilityState,
  allAttempts: Attempt[],
  studentId: string,
): boolean {
  if (availability !== 'available') return false;
  if (a.blockedStudents?.includes(studentId)) return false;

  const effMax = a.attemptOverrides?.[studentId] ?? a.maxAttempts ?? 1;
  if (finishedCount(allAttempts) >= effMax) return false; // matches ExamBriefingPage attempt-limit gate

  // Slots remaining: either resume an in-progress attempt or start a fresh one.
  return true;
}

/**
 * Bucketing rule:
 *  - available: student can still open the test now (or window not yet open)
 *  - submitted: has at least one finished attempt and can NOT still open
 *  - missed:    everything else (window closed/blocked, never submitted)
 *
 * A card with prior submissions AND a remaining attempt stays in `available`
 * — the card itself surfaces a "Submitted N×" badge so the student knows.
 */
export function classifyForBucket(
  a: Assessment,
  availability: AvailabilityState,
  allAttempts: Attempt[],
  studentId: string,
): ScheduleBucket {
  if (canStillOpen(a, availability, allAttempts, studentId)) return 'available';
  if (availability === 'upcoming') return 'available';
  if (finishedCount(allAttempts) > 0) return 'submitted';
  return 'missed';
}

/** How many attempts this student is allowed on this paper. */
export function effectiveMaxAttempts(a: Assessment, studentId: string): number {
  return a.attemptOverrides?.[studentId] ?? a.maxAttempts ?? 1;
}

// ══════════════════════════════════════════════════════════════════
// §3 — CLOCK FORMATTING
// ══════════════════════════════════════════════════════════════════

export function timeLeft(endIso: string, now: Date): { label: string; urgent: boolean } {
  const diff = new Date(endIso).getTime() - now.getTime();
  if (diff <= 0) return { label: 'ended', urgent: true };
  const totalMin = Math.floor(diff / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const days = Math.floor(h / 24);
  if (days >= 2)  return { label: `${days}d left`,          urgent: false };
  if (days === 1) return { label: `1d ${h % 24}h left`,     urgent: false };
  if (h > 0)      return { label: `${h}h ${m}m left`,       urgent: h < 2  };
  return              { label: `${m}m left`,                 urgent: m < 30 };
}

export function timeUntil(startIso: string, now: Date): string {
  const diff = new Date(startIso).getTime() - now.getTime();
  if (diff <= 0) return 'starting soon';
  const totalMin = Math.floor(diff / 60000);
  const h = Math.floor(totalMin / 60);
  const days = Math.floor(h / 24);
  if (days >= 1) return `in ${days}d ${h % 24}h`;
  if (h > 0)     return `in ${h}h ${totalMin % 60}m`;
  return `in ${totalMin}m`;
}

/**
 * A countdown broken into parts, for the Overview page's headline card.
 *
 * Separate from `timeLeft` rather than a formatting option on it, because the
 * two are answering different questions. `timeLeft` produces a phrase to sit
 * quietly in a row of metadata; this produces the digits of a clock that ticks
 * every second, and rounding rules that suit the first ("1d 4h left") make the
 * second wrong ("4h left" for forty minutes).
 */
export type Countdown = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  totalMs: number;
  expired: boolean;
};

export function countdownTo(iso: string, now: Date): Countdown {
  const totalMs = Math.max(0, new Date(iso).getTime() - now.getTime());
  const totalSec = Math.floor(totalMs / 1000);
  return {
    days: Math.floor(totalSec / 86400),
    hours: Math.floor((totalSec % 86400) / 3600),
    minutes: Math.floor((totalSec % 3600) / 60),
    seconds: totalSec % 60,
    totalMs,
    expired: totalMs <= 0,
  };
}

// ══════════════════════════════════════════════════════════════════
// §4 — BUILDING THE LIST
// ══════════════════════════════════════════════════════════════════

/**
 * Index a flat attempt list by assessment.
 *
 * `latest` is the most recently CREATED attempt, which is what the sort makes
 * true: the list is walked oldest-first, so each write overwrites the previous
 * one and the last write wins.
 */
export function indexAttempts(attempts: Attempt[]): {
  latest: Record<string, Attempt>;
  all: Record<string, Attempt[]>;
} {
  const latest: Record<string, Attempt> = {};
  const all: Record<string, Attempt[]> = {};
  const sorted = [...attempts].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  for (const at of sorted) {
    latest[at.assessmentId] = at;
    (all[at.assessmentId] ??= []).push(at);
  }
  return { latest, all };
}

export type ScheduleBuckets = Record<ScheduleBucket, ScheduleEntry[]>;

/**
 * Every assessment, bucketed and sorted the way each bucket wants to be read.
 *
 *   available — open now before upcoming; within each, the one that runs out
 *               first is the one at the top. Deadline order, not title order:
 *               the list is a queue, and the student's next decision is at the
 *               front of it.
 *   submitted — most recently handed in first.
 *   missed    — most recently closed first, so the one still worth an email to
 *               an examiner is not at the bottom of a year of history.
 */
export function buildSchedule(
  assessments: Assessment[],
  attempts: Attempt[],
  studentId: string,
  now: Date,
): ScheduleBuckets {
  const { latest, all } = indexAttempts(attempts);
  const buckets: ScheduleBuckets = { available: [], missed: [], submitted: [] };

  for (const assessment of assessments) {
    const availability = getAvailability(assessment, now);
    const allAttempts = all[assessment.id] ?? [];
    const entry: ScheduleEntry = {
      assessment,
      attempt: latest[assessment.id],
      allAttempts,
      availability,
    };
    buckets[classifyForBucket(assessment, availability, allAttempts, studentId)].push(entry);
  }

  buckets.available.sort((x, y) => {
    const xOpen = x.availability === 'available';
    const yOpen = y.availability === 'available';
    if (xOpen !== yOpen) return xOpen ? -1 : 1;
    if (xOpen) {
      if (x.assessment.endDate && y.assessment.endDate)
        return new Date(x.assessment.endDate).getTime() - new Date(y.assessment.endDate).getTime();
      if (x.assessment.endDate) return -1;
      if (y.assessment.endDate) return 1;
      return 0;
    }
    if (x.assessment.startDate && y.assessment.startDate)
      return new Date(x.assessment.startDate).getTime() - new Date(y.assessment.startDate).getTime();
    return 0;
  });

  buckets.submitted.sort((x, y) => {
    const xd = x.attempt?.submittedAt ?? x.assessment.endDate ?? x.assessment.updatedAt;
    const yd = y.attempt?.submittedAt ?? y.assessment.endDate ?? y.assessment.updatedAt;
    return new Date(yd).getTime() - new Date(xd).getTime();
  });

  buckets.missed.sort((x, y) => {
    const xd = x.assessment.endDate || x.assessment.updatedAt;
    const yd = y.assessment.endDate || y.assessment.updatedAt;
    return new Date(yd).getTime() - new Date(xd).getTime();
  });

  return buckets;
}

// ══════════════════════════════════════════════════════════════════
// §5 — THE ONE THING THAT MATTERS MOST
// ══════════════════════════════════════════════════════════════════

export type UpNext = {
  entry: ScheduleEntry;
  /**
   *   resume   — a sitting is open and unfinished. Beats everything: leaving
   *              it is how a paper gets auto-submitted half-answered.
   *   open     — sittable now.
   *   upcoming — scheduled, not yet open.
   */
  kind: 'resume' | 'open' | 'upcoming';
  /** The moment the card counts down to: the close for open work, the open for upcoming. */
  deadline: string | null;
};

/**
 * The single assessment the Overview page leads with.
 *
 * The order is by consequence, not by date. An in-progress sitting outranks an
 * exam that closes sooner, because the cost of missing it is a paper submitted
 * with whatever happened to be typed when the clock ran out — and unlike a
 * deadline, the student may not know it is still running.
 *
 * Returns null when there is genuinely nothing to lead with, which the page
 * treats as a state of its own rather than as an empty card.
 */
export function pickUpNext(buckets: ScheduleBuckets): UpNext | null {
  const open = buckets.available.filter((e) => e.availability === 'available');

  const resuming = open.find((e) => e.allAttempts.some((at) => at.status === 'in_progress'));
  if (resuming) {
    return { entry: resuming, kind: 'resume', deadline: resuming.assessment.endDate ?? null };
  }

  // `buildSchedule` has already sorted these by closing time, so the first
  // open one IS the most urgent. Re-sorting here would be a second place for
  // that rule to live.
  if (open.length > 0) {
    return { entry: open[0], kind: 'open', deadline: open[0].assessment.endDate ?? null };
  }

  const upcoming = buckets.available.find((e) => e.availability === 'upcoming');
  if (upcoming) {
    return { entry: upcoming, kind: 'upcoming', deadline: upcoming.assessment.startDate ?? null };
  }

  return null;
}
