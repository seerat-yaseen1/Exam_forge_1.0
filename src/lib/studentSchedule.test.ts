/**
 * studentSchedule — the rules two screens now share.
 *
 * These rules were tested only by being read, when they lived inside
 * StudentAssessmentsPage. They decide whether a student may open an exam and
 * which exam a dashboard leads with, so the cost of one of them being subtly
 * wrong is a candidate who cannot sit a paper they are entitled to, or who is
 * never told about one that is running.
 */

import { describe, it, expect } from 'vitest';
import type { Assessment } from './assessmentService';
import type { Attempt, AttemptStatus } from './submissionService';
import {
  buildSchedule,
  canStillOpen,
  classifyForBucket,
  countdownTo,
  effectiveMaxAttempts,
  finishedCount,
  getAvailability,
  indexAttempts,
  pickUpNext,
  timeLeft,
  timeUntil,
} from './studentSchedule';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3600_000).toISOString();

function assessment(over: Partial<Assessment> = {}): Assessment {
  return {
    id: 'a1',
    title: 'Thermodynamics',
    subject: 'Physics',
    status: 'active',
    totalMarks: 100,
    questions: [],
    maxAttempts: 1,
    updatedAt: NOW.toISOString(),
    ...over,
  } as unknown as Assessment;
}

function attempt(over: Partial<Attempt> & { id: string; assessmentId?: string }): Attempt {
  return {
    assessmentId: 'a1',
    studentId: 's1',
    status: 'submitted' as AttemptStatus,
    createdAt: NOW.toISOString(),
    startedAt: NOW.toISOString(),
    ...over,
  } as unknown as Attempt;
}

// ══════════════════════════════════════════════════════════════════
// Availability
// ══════════════════════════════════════════════════════════════════

describe('getAvailability', () => {
  it('is open when now sits inside the window', () => {
    expect(getAvailability(assessment({ startDate: hours(-1), endDate: hours(1) }), NOW)).toBe('available');
  });

  it('is upcoming before the window opens', () => {
    expect(getAvailability(assessment({ startDate: hours(2), endDate: hours(5) }), NOW)).toBe('upcoming');
  });

  it('is window_closed after it shuts', () => {
    expect(getAvailability(assessment({ startDate: hours(-5), endDate: hours(-1) }), NOW)).toBe('window_closed');
  });

  it('lets an admin close override an open window', () => {
    // The staff decision wins over the clock — an exam pulled mid-window must
    // not stay openable because its end date has not arrived.
    const a = assessment({ status: 'closed', startDate: hours(-1), endDate: hours(1) });
    expect(getAvailability(a, NOW)).toBe('admin_closed');
  });

  it('treats a missing window as permanently open', () => {
    expect(getAvailability(assessment({ startDate: undefined, endDate: undefined }), NOW)).toBe('available');
  });
});

// ══════════════════════════════════════════════════════════════════
// May the student open it
// ══════════════════════════════════════════════════════════════════

describe('canStillOpen', () => {
  const open = assessment({ startDate: hours(-1), endDate: hours(1) });

  it('allows a first sitting', () => {
    expect(canStillOpen(open, 'available', [], 's1')).toBe(true);
  });

  it('refuses once the attempt limit is used up', () => {
    expect(canStillOpen(open, 'available', [attempt({ id: 'x' })], 's1')).toBe(false);
  });

  it('honours a per-student attempt grant', () => {
    const granted = assessment({ ...open, attemptOverrides: { s1: 3 } });
    expect(canStillOpen(granted, 'available', [attempt({ id: 'x' })], 's1')).toBe(true);
    expect(effectiveMaxAttempts(granted, 's1')).toBe(3);
    // …and only for the student it was granted to.
    expect(effectiveMaxAttempts(granted, 's2')).toBe(1);
  });

  it('refuses a blocked student even with attempts left', () => {
    const blocked = assessment({ ...open, blockedStudents: ['s1'] });
    expect(canStillOpen(blocked, 'available', [], 's1')).toBe(false);
    expect(canStillOpen(blocked, 'available', [], 's2')).toBe(true);
  });

  it('counts a terminated sitting against the limit', () => {
    // A voided sitting is still a sitting. Not counting it would hand a free
    // retake to exactly the candidate whose paper was ended for a violation.
    expect(canStillOpen(open, 'available', [attempt({ id: 'x', status: 'terminated' })], 's1')).toBe(false);
  });

  it('does not count an in-progress sitting against the limit', () => {
    // Otherwise a student who is mid-paper could not resume their own attempt.
    expect(canStillOpen(open, 'available', [attempt({ id: 'x', status: 'in_progress' })], 's1')).toBe(true);
  });

  it('refuses whenever the window is not open', () => {
    for (const state of ['upcoming', 'window_closed', 'admin_closed'] as const) {
      expect(canStillOpen(open, state, [], 's1')).toBe(false);
    }
  });
});

describe('finishedCount', () => {
  it('counts submitted, auto-submitted and terminated, but not in-progress', () => {
    const all = [
      attempt({ id: '1', status: 'submitted' }),
      attempt({ id: '2', status: 'auto_submitted' }),
      attempt({ id: '3', status: 'terminated' }),
      attempt({ id: '4', status: 'in_progress' }),
    ];
    expect(finishedCount(all)).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════
// Bucketing
// ══════════════════════════════════════════════════════════════════

describe('classifyForBucket', () => {
  const open = assessment({ startDate: hours(-1), endDate: hours(1) });

  it('keeps a submitted paper with a retake left in Available', () => {
    // The case the bucketing rule exists for: a student with a reattempt must
    // not have to choose between seeing their mark and seeing the button.
    const a = assessment({ ...open, maxAttempts: 2 });
    expect(classifyForBucket(a, 'available', [attempt({ id: 'x' })], 's1')).toBe('available');
  });

  it('moves it to Submitted once no attempts remain', () => {
    expect(classifyForBucket(open, 'available', [attempt({ id: 'x' })], 's1')).toBe('submitted');
  });

  it('files a closed paper that was never handed in under Missed', () => {
    const closed = assessment({ startDate: hours(-5), endDate: hours(-1) });
    expect(classifyForBucket(closed, 'window_closed', [], 's1')).toBe('missed');
  });

  it('keeps an upcoming paper in Available so it can be planned for', () => {
    const later = assessment({ startDate: hours(4), endDate: hours(8) });
    expect(classifyForBucket(later, 'upcoming', [], 's1')).toBe('available');
  });

  it('files a blocked student under Missed rather than Available', () => {
    const blocked = assessment({ ...open, blockedStudents: ['s1'] });
    expect(classifyForBucket(blocked, 'available', [], 's1')).toBe('missed');
  });
});

// ══════════════════════════════════════════════════════════════════
// Indexing and ordering
// ══════════════════════════════════════════════════════════════════

describe('indexAttempts', () => {
  it('picks the most recently created attempt as latest, whatever order they arrive in', () => {
    const { latest, all } = indexAttempts([
      attempt({ id: 'new', createdAt: '2026-08-19T00:00:00.000Z' }),
      attempt({ id: 'old', createdAt: '2026-08-01T00:00:00.000Z' }),
    ]);
    expect(latest.a1.id).toBe('new');
    expect(all.a1.map((a) => a.id)).toEqual(['old', 'new']);
  });
});

describe('buildSchedule', () => {
  it('puts the soonest deadline at the top of Available', () => {
    const soon = assessment({ id: 'soon', startDate: hours(-1), endDate: hours(2) });
    const later = assessment({ id: 'later', startDate: hours(-1), endDate: hours(20) });
    const buckets = buildSchedule([later, soon], [], 's1', NOW);
    expect(buckets.available.map((e) => e.assessment.id)).toEqual(['soon', 'later']);
  });

  it('puts everything open ahead of everything merely scheduled', () => {
    const upcoming = assessment({ id: 'up', startDate: hours(1), endDate: hours(3) });
    const openLate = assessment({ id: 'open', startDate: hours(-1), endDate: hours(99) });
    const buckets = buildSchedule([upcoming, openLate], [], 's1', NOW);
    expect(buckets.available.map((e) => e.assessment.id)).toEqual(['open', 'up']);
  });

  it('separates the three buckets without losing or duplicating anything', () => {
    const openA   = assessment({ id: 'open', startDate: hours(-1), endDate: hours(2) });
    const doneA   = assessment({ id: 'done', startDate: hours(-9), endDate: hours(-2) });
    const missedA = assessment({ id: 'missed', startDate: hours(-9), endDate: hours(-2) });
    const buckets = buildSchedule(
      [openA, doneA, missedA],
      [attempt({ id: 'x', assessmentId: 'done' })],
      's1',
      NOW,
    );
    expect(buckets.available.map((e) => e.assessment.id)).toEqual(['open']);
    expect(buckets.submitted.map((e) => e.assessment.id)).toEqual(['done']);
    expect(buckets.missed.map((e) => e.assessment.id)).toEqual(['missed']);
  });
});

// ══════════════════════════════════════════════════════════════════
// What the dashboard leads with
// ══════════════════════════════════════════════════════════════════

describe('pickUpNext', () => {
  it('leads with an unfinished sitting over an exam that closes sooner', () => {
    // The ordering rule that is not by date: an in-progress paper the student
    // may not realise is still running costs them the whole paper.
    const closingSoon = assessment({ id: 'soon', startDate: hours(-1), endDate: hours(1) });
    const inProgress  = assessment({ id: 'mid', startDate: hours(-1), endDate: hours(9), maxAttempts: 2 });
    const buckets = buildSchedule(
      [closingSoon, inProgress],
      [attempt({ id: 'live', assessmentId: 'mid', status: 'in_progress' })],
      's1',
      NOW,
    );
    const up = pickUpNext(buckets)!;
    expect(up.kind).toBe('resume');
    expect(up.entry.assessment.id).toBe('mid');
  });

  it('otherwise leads with the open exam that closes first', () => {
    const buckets = buildSchedule(
      [
        assessment({ id: 'later', startDate: hours(-1), endDate: hours(30) }),
        assessment({ id: 'soon', startDate: hours(-1), endDate: hours(3) }),
      ],
      [],
      's1',
      NOW,
    );
    const up = pickUpNext(buckets)!;
    expect(up.kind).toBe('open');
    expect(up.entry.assessment.id).toBe('soon');
    expect(up.deadline).toBe(hours(3));
  });

  it('falls back to the next scheduled exam, counting down to its OPENING', () => {
    const buckets = buildSchedule(
      [assessment({ id: 'future', startDate: hours(6), endDate: hours(8) })],
      [],
      's1',
      NOW,
    );
    const up = pickUpNext(buckets)!;
    expect(up.kind).toBe('upcoming');
    expect(up.deadline).toBe(hours(6));
  });

  it('returns null when there is genuinely nothing to lead with', () => {
    const buckets = buildSchedule(
      [assessment({ id: 'over', startDate: hours(-9), endDate: hours(-2) })],
      [],
      's1',
      NOW,
    );
    expect(pickUpNext(buckets)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Clocks
// ══════════════════════════════════════════════════════════════════

describe('timeLeft', () => {
  it('flags the last two hours as urgent and longer windows as not', () => {
    expect(timeLeft(hours(1), NOW)).toEqual({ label: '1h 0m left', urgent: true });
    expect(timeLeft(hours(5), NOW)).toEqual({ label: '5h 0m left', urgent: false });
    expect(timeLeft(hours(50), NOW)).toEqual({ label: '2d left', urgent: false });
  });

  it('treats a past deadline as ended, never as negative time', () => {
    expect(timeLeft(hours(-1), NOW)).toEqual({ label: 'ended', urgent: true });
  });
});

describe('timeUntil', () => {
  it('reads as a wait, not a deadline', () => {
    expect(timeUntil(hours(3), NOW)).toBe('in 3h 0m');
    expect(timeUntil(hours(30), NOW)).toBe('in 1d 6h');
    expect(timeUntil(hours(-1), NOW)).toBe('starting soon');
  });
});

describe('countdownTo', () => {
  it('splits the remaining time into parts', () => {
    const c = countdownTo(new Date(NOW.getTime() + (26 * 3600 + 5 * 60 + 9) * 1000).toISOString(), NOW);
    expect(c).toMatchObject({ days: 1, hours: 2, minutes: 5, seconds: 9, expired: false });
  });

  it('bottoms out at zero rather than counting up past the deadline', () => {
    const c = countdownTo(hours(-3), NOW);
    expect(c).toMatchObject({ days: 0, hours: 0, minutes: 0, seconds: 0, totalMs: 0, expired: true });
  });
});
